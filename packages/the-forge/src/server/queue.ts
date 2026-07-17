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

/** Lifecycle ordering used by mergeWithDisk to decide, per id, which of the in-memory vs.
 * on-disk copy is "further along" and should win. applied/failed rank equal — both are
 * terminal, and which one occurred is not something a later stage can second-guess. */
const STATUS_RANK: Record<QueueItem['status'], number> = {
  pending: 0,
  claimed: 1,
  applied: 2,
  failed: 2,
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

  /** `request` is the structured ChangeRequest JSON, persisted for debugging/inspection only —
   * deliberately write-only. No consumer reads it back: agents get `markdown`, and /status
   * returns just id/status/note. Kept because queue.json is the only durable record of what a
   * Send actually contained once the browser tab is gone. */
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
    // The persist above runs mergeWithDisk, which can adopt another server's terminal copy
    // OVER an item claimed two lines up (Object.assign onto the same object this array
    // holds). Deliver only what survived the merge still claimed — returning the pre-merge
    // array would hand the agent an item the disk already knows is applied/failed.
    return claimable.filter((i) => i.status === 'claimed')
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
      // Agent-facing text renders ids as 8-char prefixes (renderItems in mcp/protocol.ts —
      // token cost), so accept a unique prefix as well as the full id. An ambiguous prefix
      // matches nothing rather than guessing — the unresolved item re-queues via the
      // stale-claim timeout instead of the wrong item going terminal.
      let item = this.items.find((i) => i.id === id)
      if (!item && id.length >= 8) {
        const prefixed = this.items.filter((i) => i.id.startsWith(id))
        if (prefixed.length === 1) item = prefixed[0]
      }
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
   * Items with unknown ids are appended as-is; items with ids already known to this instance
   * keep the in-memory copy untouched — the incoming side is a one-shot legacy import, not a
   * live peer, so it can never be fresher than this instance's current state (unlike
   * mergeWithDisk's two-live-servers case, there's no scenario where the incoming copy has
   * progressed further along the lifecycle than what's already here).
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
   * added/persisted by another concurrently-running server on the same queue dir), turning
   * persist() from a last-writer-wins full overwrite into an additive merge so two dev servers
   * sharing a queue dir don't clobber each other's items.
   *
   * For ids known to BOTH sides, "in-memory always reflects the more recent view" is only true
   * in the direction memory usually moves — forward. It's false in the terminal direction: if
   * another server pulled and mark()ed an item applied/failed after this instance last loaded
   * it, this instance's in-memory copy is a STALE pending/claimed snapshot, not a fresher one.
   * Blindly keeping in-memory would re-persist that stale status and resurrect an
   * already-applied item back to pending, re-delivering it to be applied a second time. So ids
   * known to both sides are resolved by lifecycle stage (STATUS_RANK): whichever copy is
   * further along wins; equal rank keeps the in-memory copy (it may carry a fresher note, e.g.
   * a just-run mark()). When disk wins, the disk copy is also adopted into this.items — not
   * just the merged return value — so the next persist can't re-resurrect it again. */
  private mergeWithDisk(): QueueItem[] {
    const onDisk = this.readDiskItems()
    const onDiskById = new Map(onDisk.map((i) => [i.id, i]))
    const knownIds = new Set(this.items.map((i) => i.id))

    for (const item of this.items) {
      const diskCopy = onDiskById.get(item.id)
      if (diskCopy && STATUS_RANK[diskCopy.status] > STATUS_RANK[item.status]) {
        Object.assign(item, diskCopy)
      }
    }

    const unknownFromDisk = onDisk.filter((i) => !knownIds.has(i.id))
    return [...this.items, ...unknownFromDisk]
  }

  private persist(): void {
    // Owner-only like writeEndpointFile (src/server/endpoints.ts): queue.json holds
    // change-request markdown (project source excerpts) and lives beside the secret-bearing
    // endpoint file. The rename below carries the tmp file's 0600 onto queue.json.
    fs.mkdirSync(this.dir, { recursive: true, mode: 0o700 })
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
    fs.writeFileSync(tmpFile, JSON.stringify(finalMerged, null, 2), { mode: 0o600 })
    fs.renameSync(tmpFile, this.file)
  }
}
