import fs from 'node:fs'
import path from 'node:path'
import type { SessionAdapter, SessionEvent } from './adapter'

// ---------------------------------------------------------------------------
// Exported types and constants
// ---------------------------------------------------------------------------

export type SessionState = 'idle' | 'starting' | 'ready' | 'busy' | 'failed'

export interface FeedEvent {
  seq: number
  at: string
  event: SessionEvent
}

/** No stdout event for this long while busy → kill + respawn + re-pull. */
export const WATCHDOG_MS = 120_000

/** Watchdog leash used right after the user ALLOWS a gated tool. An approved Bash command
 * (build, test suite) emits nothing on stdout until its tool_result, so the normal leash
 * would kill the session mid-command and the recovery pull would re-run the same command —
 * an approval → kill → re-approve loop. Ten minutes covers realistic builds while still
 * catching a genuinely hung CLI (#53584). */
export const POST_APPROVAL_WATCHDOG_MS = 600_000

/** Max events retained in the ring buffer. */
export const RING_CAPACITY = 200

/** The one constant turn ever sent in milestone A. Per-tick token-cost rule: terse, zero
 * interpolation — request content never travels through the turn text (same rule as the
 * canned watch texts in src/mcp/protocol.ts). */
export const PULL_TURN_TEXT: string =
  'New design edits are queued. Call the the-forge MCP tool pull_design_edits, apply each request exactly as written, then call mark_applied. Do not run the app, take screenshots, or preview the result.'

export interface SessionManagerOpts {
  /** Injectable factory — tests pass a fake, production passes () => new ClaudeAdapter(). */
  makeAdapter: () => SessionAdapter
  /** .the-forge/ dir — session.json home. Created lazily (mkdirSync recursive). */
  forgeDir: string
  /** resolveProjectRoot() — child process cwd. */
  cwd: string
  /** Injectable clock for deterministic tests; defaults to Date.now. */
  now?: () => number
  /** Watchdog timeout override for tests (real default: WATCHDOG_MS). */
  watchdogMs?: number
  /** Post-approval leash override for tests (real default: POST_APPROVAL_WATCHDOG_MS). */
  postApprovalWatchdogMs?: number
}

// ---------------------------------------------------------------------------
// session.json shape
// ---------------------------------------------------------------------------

interface SessionFile {
  sessionId: string
  updatedAt: string
}

function readSessionFile(forgeDir: string): SessionFile | undefined {
  try {
    const raw = fs.readFileSync(path.join(forgeDir, 'session.json'), 'utf8')
    const parsed: unknown = JSON.parse(raw)
    if (
      typeof parsed === 'object' &&
      parsed !== null &&
      typeof (parsed as Record<string, unknown>).sessionId === 'string'
    ) {
      return parsed as SessionFile
    }
    return undefined
  } catch {
    // Missing or corrupt → start fresh, never throw.
    return undefined
  }
}

function writeSessionFile(forgeDir: string, sessionId: string, updatedAt: string): void {
  try {
    // forgeDir may not exist yet (mirrors writeEndpointFile in src/server/endpoints.ts).
    fs.mkdirSync(forgeDir, { recursive: true })
    const data: SessionFile = { sessionId, updatedAt }
    fs.writeFileSync(path.join(forgeDir, 'session.json'), JSON.stringify(data), 'utf8')
  } catch {
    // I/O failure is non-fatal — resume just won't work next time.
  }
}

// ---------------------------------------------------------------------------
// SessionManager
// ---------------------------------------------------------------------------

export class SessionManager {
  private _state: SessionState = 'idle'
  private _opts: SessionManagerOpts
  private _clock: () => number
  private _watchdogMs: number
  private _postApprovalWatchdogMs: number

  // Count of approvals parked in the overlay. While > 0 the watchdog is fully suspended —
  // a human deciding is not a hung CLI. The ApprovalRegistry's own hold timer guarantees
  // every request eventually resolves (allow/deny/timeout), so the count always converges.
  private _pendingApprovals = 0

  // The live adapter (non-null while starting/ready/busy).
  private _adapter: SessionAdapter | null = null
  // Last sessionId seen from the adapter (persisted to session.json).
  private _lastSessionId: string | undefined = undefined

  // Single-slot pending nudge. True = one PULL_TURN_TEXT is queued to be
  // sent on the next turn-complete or on started. A single slot is sufficient
  // because pull_design_edits claims ALL pending queue items — N Sends need
  // at most one follow-up pull turn.
  private _nudgePending = false

  // Ring buffer: fixed-capacity circular store.
  private _ring: FeedEvent[] = []
  private _seq = 0

  // Subscribers for live event fan-out.
  private _subscribers: Set<(e: FeedEvent) => void> = new Set()

  // Watchdog timer handle (armed only while busy).
  private _watchdog: ReturnType<typeof setTimeout> | null = null

  constructor(opts: SessionManagerOpts) {
    this._opts = opts
    this._clock = opts.now ?? (() => Date.now())
    this._watchdogMs = opts.watchdogMs ?? WATCHDOG_MS
    this._postApprovalWatchdogMs = opts.postApprovalWatchdogMs ?? POST_APPROVAL_WATCHDOG_MS
  }

  // ---------------------------------------------------------------------------
  // Public API
  // ---------------------------------------------------------------------------

  state(): SessionState {
    return this._state
  }

  /** Auto-start + deliver: the /dispatch 'embedded' rung.
   * - idle/failed → start adapter (with resumeId from session.json) and park nudge.
   * - starting → park nudge (single slot; already starting).
   * - ready → sendTurn immediately.
   * - busy → park nudge (single slot; pull claims everything, so N Sends need ≤1 follow-up). */
  notifyDesignEdits(): void {
    switch (this._state) {
      case 'idle':
      case 'failed':
        // Park the nudge BEFORE starting — an adapter that emits `started`
        // synchronously inside start() would otherwise flush an empty slot and
        // the nudge parked afterwards would sit forever.
        this._nudgePending = true
        this._start()
        break
      case 'starting':
        // Already starting — park the nudge; it will flush on started.
        this._nudgePending = true
        break
      case 'ready':
        this._sendTurn()
        break
      case 'busy':
        // Park exactly one nudge; extra calls are deduplicated.
        this._nudgePending = true
        break
      default: {
        const _: never = this._state
        void _
      }
    }
  }

  interrupt(): void {
    this._adapter?.interrupt()
  }

  /** An approval is parked in the overlay — suspend the watchdog entirely. A human
   * deciding is not a hung CLI; the registry's hold timer bounds how long this lasts.
   * Wired from the ApprovalRegistry's onChange in src/server/runtime.ts (the registry
   * must not import this module). */
  onApprovalPending(): void {
    this._pendingApprovals++
    this._cancelWatchdog()
  }

  /** The parked approval resolved. Once none remain, re-arm: an ALLOWED tool gets the
   * long post-approval leash (builds/tests emit nothing until tool_result); a denied
   * one resumes the normal leash — the turn continues without a long-running tool. */
  onApprovalResolved(allow: boolean): void {
    this._pendingApprovals = Math.max(0, this._pendingApprovals - 1)
    if (this._pendingApprovals === 0 && this._state === 'busy') {
      this._armWatchdog(allow ? this._postApprovalWatchdogMs : this._watchdogMs)
    }
  }

  stop(): void {
    this._cancelWatchdog()
    this._nudgePending = false
    // Outstanding approvals belong to the child we just killed; their eventual registry
    // resolutions must not leave a fresh session's watchdog permanently suspended.
    this._pendingApprovals = 0
    this._discardAdapter()?.stop()
    this._state = 'idle'
  }

  eventsSince(seq: number): FeedEvent[] {
    return this._ring.filter((e) => e.seq > seq)
  }

  subscribe(fn: (e: FeedEvent) => void): () => void {
    this._subscribers.add(fn)
    return () => this._subscribers.delete(fn)
  }

  // ---------------------------------------------------------------------------
  // Private helpers
  // ---------------------------------------------------------------------------

  /** Detach the current adapter's onEvent and drop the reference, so a discarded
   * adapter can never re-enter the state machine (stale started/ended events from
   * a killed child are the double-respawn race). Returns the old adapter so callers
   * that also need to kill the process can chain `.stop()`. */
  private _discardAdapter(): SessionAdapter | null {
    const old = this._adapter
    if (old) {
      old.onEvent = () => {}
      this._adapter = null
    }
    return old
  }

  private _start(): void {
    // A restart from `failed` reaches here with the previous adapter still attached AND
    // its child possibly alive — in-band error turns (rate limit, auth) end with exit
    // code 0 *later*, if ever. Detach + kill it first, or every failed→restart cycle
    // leaks a live child whose stray `ended` would discard the new adapter (the same
    // stale-event race _onWatchdogFired defends against).
    this._discardAdapter()?.stop()
    const resumeId = readSessionFile(this._opts.forgeDir)?.sessionId
    const adapter = this._opts.makeAdapter()
    this._adapter = adapter
    adapter.onEvent = (e) => this._onAdapterEvent(e)
    // State before start(): an adapter emitting `started` synchronously inside
    // start() must not have its ready/busy transition clobbered afterwards.
    this._state = 'starting'
    adapter.start({ cwd: this._opts.cwd, resumeId })
  }

  private _sendTurn(): void {
    this._adapter?.sendTurn(PULL_TURN_TEXT)
    this._state = 'busy'
    this._armWatchdog()
  }

  private _onAdapterEvent(event: SessionEvent): void {
    // Re-arm the watchdog on any event while busy — prevents spurious expiry
    // when the session is actively producing output.
    if (this._state === 'busy') {
      this._armWatchdog()
    }

    this._push(event)

    switch (event.kind) {
      case 'started':
        this._lastSessionId = event.sessionId
        writeSessionFile(this._opts.forgeDir, event.sessionId, new Date(this._clock()).toISOString())
        this._state = 'ready'
        if (this._nudgePending) {
          this._nudgePending = false
          this._sendTurn()
        }
        break

      case 'turn-complete':
        this._cancelWatchdog()
        if (event.isError) {
          // Error turn → failed. A later Send retries via auto-start — no retry loop here
          // (retrying automatically on error could thrash under rate limits or auth failure).
          this._state = 'failed'
        } else {
          this._state = 'ready'
          if (this._nudgePending) {
            this._nudgePending = false
            this._sendTurn()
          }
        }
        break

      case 'session-error':
        if (this._state === 'starting') {
          // Spawn failure path: session-error while starting → failed.
          this._state = 'failed'
        }
        // While busy: the watchdog or ended handler manages recovery; let this
        // event through to the ring (already pushed above) without state change here.
        break

      case 'ended':
        this._cancelWatchdog()
        // The adapter that just ended is dead either way — detach it so any
        // further stray events from it can't reach the manager.
        this._discardAdapter()
        if (this._state === 'busy' || this._state === 'starting') {
          // Unexpected exit during a live turn or during spawn → recover.
          this._respawn()
        } else if (this._state === 'failed') {
          // session-error already drove us to failed; ended is just the adapter
          // signalling the process is gone — don't overwrite the failed state.
        } else {
          // Clean exit between turns (ready) → idle, no respawn.
          this._state = 'idle'
        }
        break

      case 'assistant-text':
      case 'tool-started':
      case 'tool-finished':
        // Events already pushed to ring; no state transition needed.
        break

      default: {
        const _: never = event
        void _
      }
    }
  }

  /** Watchdog expiry: kill the stalled adapter, synthesize a recovery row, and respawn.
   * Re-pulling is safe: unclaimed items and stale-claim items re-deliver, so no edits
   * are lost. The parked-nudge slot is not checked here — we always re-send PULL_TURN_TEXT
   * on respawn (the turn that died was itself a pull turn). */
  private _onWatchdogFired(): void {
    this._watchdog = null
    // Detach BEFORE stop(): a real process adapter emits `ended` asynchronously
    // after kill; with the closure still attached that late `ended` would land
    // while state is 'starting' and trigger a second respawn, orphaning the
    // child we're about to spawn.
    this._discardAdapter()?.stop()
    this._push({ kind: 'session-error', text: 'session recovered after stall' })
    this._respawn()
  }

  /** Spawn a fresh adapter (re-using the last sessionId for --resume) and re-send
   * PULL_TURN_TEXT once it emits started.  Used by both the watchdog and the ended-
   * while-busy path. The parked nudge is cleared — the recovery pull supersedes it. */
  private _respawn(): void {
    const resumeId = this._lastSessionId ?? readSessionFile(this._opts.forgeDir)?.sessionId
    const adapter = this._opts.makeAdapter()
    this._adapter = adapter
    // Park the recovery pull; it will flush when the new adapter emits started.
    this._nudgePending = true
    adapter.onEvent = (e) => this._onAdapterEvent(e)
    // State before start() — same synchronous-started ordering rule as _start().
    this._state = 'starting'
    adapter.start({ cwd: this._opts.cwd, resumeId })
  }

  private _push(event: SessionEvent): void {
    const seq = ++this._seq
    const fe: FeedEvent = { seq, at: new Date(this._clock()).toISOString(), event }
    if (this._ring.length >= RING_CAPACITY) {
      // Drop oldest entry to maintain the capacity cap.
      this._ring.shift()
    }
    this._ring.push(fe)
    for (const fn of this._subscribers) {
      fn(fe)
    }
  }

  private _armWatchdog(ms: number = this._watchdogMs): void {
    // Suspended while any approval is parked — a stray adapter event mid-approval must
    // not sneak a normal-leash timer past onApprovalPending's cancellation.
    if (this._pendingApprovals > 0) return
    this._cancelWatchdog()
    this._watchdog = setTimeout(() => this._onWatchdogFired(), ms)
  }

  private _cancelWatchdog(): void {
    if (this._watchdog !== null) {
      clearTimeout(this._watchdog)
      this._watchdog = null
    }
  }
}
