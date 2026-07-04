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

/** The timestamp a terminal item's age is measured from: when it actually finished (finishedAt),
 * falling back to createdAt for legacy items marked before finishedAt existed. */
function finishedBasis(item: QueueItem): number {
  return new Date(item.finishedAt ?? item.createdAt).getTime()
}

/**
 * Pure pruning rule shared by both Queue.prune() (the in-memory instance state) and
 * persist()'s merged-array path (which must apply the identical rule to items merged in from
 * disk, including ones this instance never even held in memory). Given exactly the same
 * `items`/`nowMs` inputs, always produces exactly the same output — no reliance on `this`.
 *
 * Rule: drops terminal (applied/failed) items whose finishedBasis is older than PRUNE_AFTER_MS,
 * then caps total stored items at MAX_STORED_ITEMS by dropping the oldest-finished terminal-status
 * items first. Pending/claimed items are never dropped by either rule.
 */
export function pruneItems(items: QueueItem[], nowMs: number): QueueItem[] {
  const ageFiltered = items.filter((i) => {
    if (i.status !== 'applied' && i.status !== 'failed') return true
    return nowMs - finishedBasis(i) <= PRUNE_AFTER_MS
  })

  const overflow = ageFiltered.length - MAX_STORED_ITEMS
  if (overflow <= 0) return ageFiltered

  const terminalOldestFirst = ageFiltered
    .map((item, index) => ({ item, index }))
    .filter(({ item }) => item.status === 'applied' || item.status === 'failed')
    .sort((a, b) => finishedBasis(a.item) - finishedBasis(b.item))

  const toDrop = new Set(terminalOldestFirst.slice(0, overflow).map(({ index }) => index))
  if (toDrop.size === 0) return ageFiltered
  return ageFiltered.filter((_, index) => !toDrop.has(index))
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
    this.items = this.readDiskItems()
  }

  /**
   * Reads queue.json, returning [] when the file doesn't exist (normal first run). A file that
   * exists but doesn't parse to an array is QUARANTINED — renamed to queue.json.corrupt-<ms> —
   * rather than silently discarded: it may hold pending user edits worth hand-recovering, and
   * leaving it in place would let the next persist() clobber the evidence.
   */
  private readDiskItems(): QueueItem[] {
    let raw: string
    try {
      raw = fs.readFileSync(this.file, 'utf8')
    } catch {
      return []
    }
    try {
      const parsed = JSON.parse(raw)
      if (Array.isArray(parsed)) return parsed as QueueItem[]
    } catch {
      // fall through to quarantine
    }
    const corruptPath = `${this.file}.corrupt-${this.now()}`
    try {
      fs.renameSync(this.file, corruptPath)
      console.warn(`[the-forge] queue.json was unreadable — moved to ${corruptPath}; starting with an empty queue`)
    } catch {
      // rename failed (permissions?) — leave the file for inspection; nothing else we can do
    }
    return []
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
      if (i.status === 'claimed') {
        // Legacy M4 queue.json shape (or any other corruption): a `claimed` item with a missing
        // or unparseable claimedAt gives us no way to know how long it's actually been claimed —
        // treat it as immediately stale rather than letting it get stuck claimed forever.
        if (!i.claimedAt) return true
        const claimedAtMs = new Date(i.claimedAt).getTime()
        if (Number.isNaN(claimedAtMs)) return true
        return nowMs - claimedAtMs > CLAIM_TIMEOUT_MS
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

  /**
   * True while any claim is still FRESH (within CLAIM_TIMEOUT_MS) — the queue-side signal
   * that an agent is presumably mid-apply, used by WatcherHub's `applying` liveness hold.
   * The age check lives here, next to pull()'s staleness rules, and is essential: stale
   * claims are only re-queued lazily INSIDE pull(), and a watcher that died mid-apply
   * never pulls again — so "status === 'claimed'" alone would read as applying forever
   * and hold the hub live indefinitely (PR #1 review). Same edge rules as pull(): a
   * claimed item with a missing/unparseable claimedAt gives no way to know its age and
   * counts as stale, not fresh.
   */
  hasFreshClaims(): boolean {
    const nowMs = this.now()
    return this.items.some((i) => {
      if (i.status !== 'claimed') return false
      if (!i.claimedAt) return false
      const claimedAtMs = new Date(i.claimedAt).getTime()
      if (Number.isNaN(claimedAtMs)) return false
      return nowMs - claimedAtMs <= CLAIM_TIMEOUT_MS
    })
  }

  /**
   * Merges externally-sourced items (e.g. a legacy queue.json from a since-relocated queue
   * directory — see the forge-dir-root migration) into this instance and persists the result.
   * Dedupes by id using the same rule as mergeWithDisk: items already known to this instance
   * (in-memory) always win over an incoming item with the same id, since they reflect this
   * instance's more current view. Items with unknown ids are appended as-is.
   */
  mergeItems(items: QueueItem[]): void {
    const knownIds = new Set(this.items.map((i) => i.id))
    const toAdd = items.filter((i) => !knownIds.has(i.id))
    if (toAdd.length === 0) return
    this.items.push(...toAdd)
    this.persist()
  }

  get(id: string): QueueItem | undefined {
    return this.items.find((i) => i.id === id)
  }

  /** Applies the shared pruneItems rule (age + overflow cap) to this instance's in-memory items. */
  private prune(): void {
    this.items = pruneItems(this.items, this.now())
  }

  /** Re-reads the on-disk file and merges in any items this instance doesn't know about (i.e.
   * added/persisted by another concurrently-running server on the same queue dir). In-memory
   * items always win for ids this instance does know, since they reflect this instance's more
   * recent view (e.g. a just-applied mark()). This turns persist() from a last-writer-wins full
   * overwrite into an additive merge, so two dev servers sharing a queue dir don't clobber each
   * other's items. */
  private mergeWithDisk(): QueueItem[] {
    const onDisk = this.readDiskItems()
    const knownIds = new Set(this.items.map((i) => i.id))
    const unknownFromDisk = onDisk.filter((i) => !knownIds.has(i.id))
    return [...this.items, ...unknownFromDisk]
  }

  private persist(): void {
    fs.mkdirSync(this.dir, { recursive: true })
    const merged = this.mergeWithDisk()

    // Apply the shared pruning rule to the merged array (stale disk items must also be pruned) —
    // same age-cutoff + overflow-cap logic as the in-memory prune() below, applied via the one
    // pure pruneItems() function so the two paths can never drift apart.
    const finalMerged = pruneItems(merged, this.now())

    // Sort by createdAt ascending so queue.json preserves creation order
    finalMerged.sort((a, b) => new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime())

    // Also prune this.items in-memory to keep instance state consistent
    this.prune()

    // Scoped by pid: two server processes writing concurrently must not share a tmp path, or one
    // process's partial write/rename could race with the other's.
    const tmpFile = `${this.file}.tmp.${process.pid}`
    fs.writeFileSync(tmpFile, JSON.stringify(finalMerged, null, 2))
    fs.renameSync(tmpFile, this.file)
  }
}
