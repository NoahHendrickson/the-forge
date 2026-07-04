import fs from 'node:fs'
import path from 'node:path'
import { randomUUID } from 'node:crypto'

/** Claimed items older than this are treated as pending again by pull() (stale-claim recovery). */
export const CLAIM_TIMEOUT_MS = 300_000

/** Terminal (applied/failed) items older than this are dropped on every persist. */
export const PRUNE_AFTER_MS = 24 * 60 * 60 * 1000

/** Hard cap on total stored items — oldest terminal-status items are dropped first. */
export const MAX_STORED_ITEMS = 200

export interface QueueItem {
  id: string
  createdAt: string
  status: 'pending' | 'claimed' | 'applied' | 'failed'
  markdown: string
  request: unknown
  note?: string
  claimedAt?: string
  finishedAt?: string
}

export class Queue {
  private items: QueueItem[] = []
  private file: string
  private now: () => number

  constructor(
    private dir: string,
    now: () => number = () => Date.now()
  ) {
    this.now = now
    this.file = path.join(dir, 'queue.json')
    try {
      const raw = JSON.parse(fs.readFileSync(this.file, 'utf8'))
      if (Array.isArray(raw)) this.items = raw as QueueItem[]
    } catch {
      this.items = []
    }
  }

  add(request: unknown, markdown: string): QueueItem {
    const item: QueueItem = {
      id: randomUUID(),
      createdAt: new Date(this.now()).toISOString(),
      status: 'pending',
      markdown,
      request,
    }
    this.items.push(item)
    this.persist()
    return item
  }

  pull(): QueueItem[] {
    const nowMs = this.now()
    const claimable = this.items.filter((i) => {
      if (i.status === 'pending') return true
      if (i.status === 'claimed' && i.claimedAt) {
        return nowMs - new Date(i.claimedAt).getTime() > CLAIM_TIMEOUT_MS
      }
      return false
    })
    const stamp = new Date(nowMs).toISOString()
    for (const item of claimable) {
      item.status = 'claimed'
      item.claimedAt = stamp
    }
    if (claimable.length > 0) this.persist()
    return claimable
  }

  /**
   * Finalizes items to a terminal status (applied/failed). Items already in a terminal state
   * (applied/failed) are left untouched and are NOT included in the returned array — this
   * guards against a stale/duplicate claimer overwriting another claimer's outcome after the
   * fact (e.g. two "apply" processes racing on the same pulled item).
   *
   * Known limitation (accepted trade-off): this is a single-user, single-machine tool with no
   * distributed locking. If two claimers pull the SAME item (e.g. after a stale-claim timeout
   * false-positive) and both attempt to mark it, only the FIRST mark() call wins; the second is
   * silently dropped rather than erroring. This is intentional given the tool's scope — it is
   * not safe against genuinely concurrent/adversarial multi-user claiming.
   */
  mark(ids: string[], status: 'applied' | 'failed', note?: string): QueueItem[] {
    const marked: QueueItem[] = []
    for (const id of ids) {
      const item = this.items.find((i) => i.id === id)
      if (!item) continue
      if (item.status === 'applied' || item.status === 'failed') continue // already terminal — do not clobber
      item.status = status
      item.finishedAt = new Date(this.now()).toISOString()
      if (note !== undefined) item.note = note
      marked.push(item)
    }
    if (marked.length > 0) this.persist()
    return marked
  }

  list(): QueueItem[] {
    return [...this.items]
  }

  get(id: string): QueueItem | undefined {
    return this.items.find((i) => i.id === id)
  }

  /** The timestamp a terminal item's age is measured from: when it actually finished
   * (finishedAt), falling back to createdAt for legacy items marked before finishedAt existed. */
  private static finishedBasis(item: QueueItem): number {
    return new Date(item.finishedAt ?? item.createdAt).getTime()
  }

  /** Drops terminal items whose finishedAt (or createdAt, if unset) is older than
   * PRUNE_AFTER_MS, then caps total stored items at MAX_STORED_ITEMS by dropping the
   * oldest-finished terminal-status items first. Pending/claimed items are never pruned. */
  private prune(): void {
    const nowMs = this.now()
    this.items = this.items.filter((i) => {
      if (i.status !== 'applied' && i.status !== 'failed') return true
      return nowMs - Queue.finishedBasis(i) <= PRUNE_AFTER_MS
    })

    const overflow = this.items.length - MAX_STORED_ITEMS
    if (overflow <= 0) return

    const terminalOldestFirst = this.items
      .map((item, index) => ({ item, index }))
      .filter(({ item }) => item.status === 'applied' || item.status === 'failed')
      .sort((a, b) => Queue.finishedBasis(a.item) - Queue.finishedBasis(b.item))

    const toDrop = new Set(terminalOldestFirst.slice(0, overflow).map(({ index }) => index))
    if (toDrop.size > 0) {
      this.items = this.items.filter((_, index) => !toDrop.has(index))
    }
  }

  /** Re-reads the on-disk file and merges in any items this instance doesn't know about (i.e.
   * added/persisted by another concurrently-running server on the same queue dir). In-memory
   * items always win for ids this instance does know, since they reflect this instance's more
   * recent view (e.g. a just-applied mark()). This turns persist() from a last-writer-wins full
   * overwrite into an additive merge, so two dev servers sharing a queue dir don't clobber each
   * other's items. */
  private mergeWithDisk(): QueueItem[] {
    let onDisk: QueueItem[] = []
    try {
      const raw = JSON.parse(fs.readFileSync(this.file, 'utf8'))
      if (Array.isArray(raw)) onDisk = raw as QueueItem[]
    } catch {
      onDisk = []
    }
    const knownIds = new Set(this.items.map((i) => i.id))
    const unknownFromDisk = onDisk.filter((i) => !knownIds.has(i.id))
    return [...this.items, ...unknownFromDisk]
  }

  private persist(): void {
    this.prune()
    fs.mkdirSync(this.dir, { recursive: true })
    const merged = this.mergeWithDisk()
    // Scoped by pid: two server processes writing concurrently must not share a tmp path, or one
    // process's partial write/rename could race with the other's.
    const tmpFile = `${this.file}.tmp.${process.pid}`
    fs.writeFileSync(tmpFile, JSON.stringify(merged, null, 2))
    fs.renameSync(tmpFile, this.file)
  }
}
