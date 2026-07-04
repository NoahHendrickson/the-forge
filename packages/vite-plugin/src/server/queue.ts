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

  mark(ids: string[], status: 'applied' | 'failed', note?: string): QueueItem[] {
    const marked: QueueItem[] = []
    for (const id of ids) {
      const item = this.items.find((i) => i.id === id)
      if (!item) continue
      item.status = status
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

  /** Drops terminal items older than PRUNE_AFTER_MS, then caps total stored items at
   * MAX_STORED_ITEMS by dropping the oldest terminal-status items first. Pending/claimed
   * items are never pruned. */
  private prune(): void {
    const nowMs = this.now()
    this.items = this.items.filter((i) => {
      if (i.status !== 'applied' && i.status !== 'failed') return true
      return nowMs - new Date(i.createdAt).getTime() <= PRUNE_AFTER_MS
    })

    const overflow = this.items.length - MAX_STORED_ITEMS
    if (overflow <= 0) return

    const terminalOldestFirst = this.items
      .map((item, index) => ({ item, index }))
      .filter(({ item }) => item.status === 'applied' || item.status === 'failed')
      .sort((a, b) => new Date(a.item.createdAt).getTime() - new Date(b.item.createdAt).getTime())

    const toDrop = new Set(terminalOldestFirst.slice(0, overflow).map(({ index }) => index))
    if (toDrop.size > 0) {
      this.items = this.items.filter((_, index) => !toDrop.has(index))
    }
  }

  private persist(): void {
    this.prune()
    fs.mkdirSync(this.dir, { recursive: true })
    const tmpFile = `${this.file}.tmp`
    fs.writeFileSync(tmpFile, JSON.stringify(this.items, null, 2))
    fs.renameSync(tmpFile, this.file)
  }
}
