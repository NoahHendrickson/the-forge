import { randomUUID } from 'node:crypto'

/** How long a pending approval is held before auto-denying. Deliberately under the bin's
 * APPROVAL_REQUEST_TIMEOUT_MS (120s) with margin — the same style as WAIT_HOLD_MS /
 * WAIT_REQUEST_TIMEOUT_MS in watchers.ts / mcp/index.ts. */
export const APPROVAL_HOLD_MS = 110_000

export interface PendingApproval {
  id: string
  toolName: string
  detail: string
}

export type ApprovalDecision = { behavior: 'allow' } | { behavior: 'deny'; message: string }

export type ApprovalFeedItem =
  | { kind: 'approval-request'; id: string; toolName: string; detail: string }
  | { kind: 'approval-resolved'; id: string; allow: boolean }

/** Canned denial messages — constants so agent-visible text is never dynamic. */
const TIMEOUT_MESSAGE =
  'Denied — approval timed out in The Forge overlay. Re-send the change when ready.'
const BROWSER_DENY_MESSAGE = 'Denied from The Forge overlay.'

interface RegistryEntry {
  approval: PendingApproval
  resolve: (d: ApprovalDecision) => void
  timer: ReturnType<typeof setTimeout>
}

/**
 * Single-project pending-approval registry. Parks approval requests until the user clicks
 * Allow/Deny in the overlay, or the hold expires (auto-deny). Modelled on WatcherHub:
 * injectable clock + holdMs for tests, onChange hook so callers (Task 4's HTTP feed) get
 * events without this module importing SessionManager.
 *
 * Idle-zero guarantee: an empty registry holds zero timers (each timer is cleared on
 * decide or expiry).
 */
export class ApprovalRegistry {
  private entries = new Map<string, RegistryEntry>()
  private holdMs: number
  private now: () => number
  private onChange?: (e: ApprovalFeedItem) => void

  constructor(opts?: { holdMs?: number; now?: () => number; onChange?: (e: ApprovalFeedItem) => void }) {
    this.holdMs = opts?.holdMs ?? APPROVAL_HOLD_MS
    this.now = opts?.now ?? (() => Date.now())
    this.onChange = opts?.onChange
  }

  /**
   * Register a pending approval and park until decide() or the hold expires.
   * Fans an `approval-request` FeedEvent immediately; fans `approval-resolved` on settle.
   */
  request(toolName: string, detail: string): { id: string; promise: Promise<ApprovalDecision> } {
    const id = randomUUID()
    let resolve!: (d: ApprovalDecision) => void
    const promise = new Promise<ApprovalDecision>((res) => {
      resolve = res
    })

    const timer = setTimeout(() => {
      if (!this.entries.has(id)) return
      this.entries.delete(id)
      this.onChange?.({ kind: 'approval-resolved', id, allow: false })
      resolve({ behavior: 'deny', message: TIMEOUT_MESSAGE })
    }, this.holdMs)

    this.entries.set(id, { approval: { id, toolName, detail }, resolve, timer })
    this.onChange?.({ kind: 'approval-request', id, toolName, detail })
    return { id, promise }
  }

  /** Apply a user decision. Returns false for unknown or already-expired ids. */
  decide(id: string, allow: boolean): boolean {
    const entry = this.entries.get(id)
    if (!entry) return false
    clearTimeout(entry.timer)
    this.entries.delete(id)
    this.onChange?.({ kind: 'approval-resolved', id, allow })
    if (allow) {
      entry.resolve({ behavior: 'allow' })
    } else {
      entry.resolve({ behavior: 'deny', message: BROWSER_DENY_MESSAGE })
    }
    return true
  }

  /** All currently-pending approvals — for replaying to a late-connecting feed. */
  pending(): PendingApproval[] {
    return Array.from(this.entries.values()).map((e) => e.approval)
  }
}
