import type { QueueItem } from './queue'

/** How long a /wait request is held open before resolving empty so the agent re-arms.
 * Deliberately under common MCP client tool-call timeouts (30s-ish defaults) with margin —
 * if the client times the tool call out, the agent surfaces an error instead of looping. */
export const WAIT_HOLD_MS = 20_000

/** Heartbeat window: a watcher whose last wait call was within this is still "live" even
 * between cycles (hold expiry → agent re-invokes the tool takes a few seconds). */
export const WATCHER_FRESH_MS = 35_000

/** No deliveries for this long → the next wait is told to stop. This is the token-cost
 * bound for a forgotten watch session (see the watch-mode plan): the loop costs at most
 * this much idle ticking, ever. Also subsumes "end the watch when design mode goes off" —
 * design mode off means no Sends, which means this fires. */
export const IDLE_STOP_MS = 20 * 60_000

export type WatcherState = 'live' | 'asleep' | 'none'

export type WaitResponse =
  | { stop: true; reason: 'idle' | 'replaced' | 'unlinked' }
  | { stop: false; items: QueueItem[] }

export interface WatcherHubOpts {
  /** Claims all currently-claimable queue items — `() => queue.pull()` in production.
   * Injected so hub tests never touch a real Queue/disk. */
  claim: () => QueueItem[]
  /** True while claimed items are FRESH (`queue.hasFreshClaims()` in production — the
   * age check matters, see that method's doc). Keeps a watcher live through its APPLY
   * window: while the agent is editing files it is not parked on /wait and its heartbeat
   * goes stale, but treating it as asleep there would send a mid-apply Send down the
   * keystroke ladder AND deliver it on the next wait — a double nudge (PR #1 review).
   * Freshness is bounded by CLAIM_TIMEOUT_MS, so a died-mid-apply watcher holds liveness
   * at most that long — the bound must come from the callback's own age check, because
   * stale-claim re-queueing is lazy (inside pull()) and a dead watcher never pulls. */
  applying?: () => boolean
  /** Injectable clock for idle/freshness math. Defaults to Date.now. */
  now?: () => number
  /** Injectable hold window — tests never sit through a real 20s wait. */
  holdMs?: number
  idleStopMs?: number
  freshMs?: number
}

interface ParkedWaiter {
  resolve: (r: WaitResponse) => void
  timer: ReturnType<typeof setTimeout>
  settled: boolean
  /** Per-bin-process identity (X-Forge-Watcher header) — see the ping-pong note below. */
  token?: string
}

/** A one-shot (or winner-conditional) stop owed to a specific token's NEXT wait() call —
 * set when that token can't be told to stop directly (preempted while parked, or unlinked
 * while merely watching with nothing parked). Single slot: only one token can be owed a
 * denial at a time, mirroring the hub's single-`parked`-slot design. */
interface PendingStop {
  token: string
  reason: 'replaced' | 'unlinked'
}

/**
 * Single-slot registry for the linked-session watch loop (`/forge-watch` →
 * `wait_for_design_edits` → `POST /__the-forge/wait`). The long-poll doubles as the
 * liveness signal dispatch uses to pick the `watcher` rung: a parked waiter (or one seen
 * within WATCHER_FRESH_MS) means a session is actively watching and Sends are delivered
 * through it instead of the keystroke ladder.
 *
 * Single slot on purpose: if two sessions watch the same project, deliveries would
 * alternate between them unpredictably. A second wait() preempts the first with an
 * explicit `{stop, 'replaced'}`, and — mechanically, not just via the canned stop text —
 * a session that was told 'replaced' cannot bump the winner back: its retries are
 * absorbed with another `{stop, 'replaced'}` for as long as the winner is live (tracked
 * by per-bin-process token; a replaced token may re-arm normally once the winner is
 * gone). Tokenless clients (an older bin) fall back to the advisory-only behavior.
 */
export class WatcherHub {
  private claim: () => QueueItem[]
  private applying: () => boolean
  private now: () => number
  private holdMs: number
  private idleStopMs: number
  private freshMs: number

  private parked: ParkedWaiter | null = null
  /** The stop owed to a token's next wait() — 'replaced' (absorbed while the winner stays
   * live, so a disobedient replaced loop can't ping-pong the slot) or 'unlinked' (true
   * one-shot, consumed the instant it's delivered). See PendingStop. */
  private pendingStop: PendingStop | null = null
  /** Last token seen at wait entry — who to deny when unlink() finds nothing parked. */
  private lastToken: string | null = null
  /** True between a wait cycle's start and a stop/disconnect — distinct from "parked"
   * because between cycles (hold expired, agent re-invoking the tool) nothing is parked
   * but the watcher is still very much live. */
  private watching = false
  private everWatched = false
  private lastSeen = 0
  /** Watch start or last non-empty delivery. Empty holds deliberately do NOT reset this —
   * they're the idle ticking the auto-stop exists to bound. */
  private lastActivity = 0

  constructor(opts: WatcherHubOpts) {
    this.claim = opts.claim
    this.applying = opts.applying ?? (() => false)
    this.now = opts.now ?? (() => Date.now())
    this.holdMs = opts.holdMs ?? WAIT_HOLD_MS
    this.idleStopMs = opts.idleStopMs ?? IDLE_STOP_MS
    this.freshMs = opts.freshMs ?? WATCHER_FRESH_MS
  }

  /**
   * Park a waiter. Resolution paths: items claimed at entry (queued between cycles),
   * notify() delivering items, hold expiry (`{stop:false, items:[]}` — the re-arm tick),
   * idle auto-stop, or preemption by a newer wait. `cancel` (wired to the HTTP response's
   * 'close' event) frees the slot without resolving — the socket is already gone, so
   * there is nobody to answer; it is a no-op once settled.
   */
  wait(token?: string): { promise: Promise<WaitResponse>; cancel: () => void } {
    const nowMs = this.now()

    // A pending stop owed to THIS token, checked BEFORE any state mutation so a
    // disobedient loop can't even refresh the heartbeat by retrying.
    if (token !== undefined && this.pendingStop !== null && this.pendingStop.token === token) {
      const { reason } = this.pendingStop
      if (reason === 'unlinked') {
        // True one-shot: the browser unlinked while this loop was between cycles or
        // mid-apply, so no response could carry the stop — this wait IS that response.
        // Consumed immediately: the wait after this one is by definition the user
        // deliberately re-running /forge-watch, which must re-arm normally.
        this.pendingStop = null
        return { promise: Promise.resolve({ stop: true, reason: 'unlinked' }), cancel: () => {} }
      }
      // 'replaced': absorbed with the same stop for as long as the winner is live. Once
      // the winner is gone (asleep/none), the denial is lifted: the user going back to
      // that session and re-running /forge-watch is a legitimate re-arm.
      if (this.state() === 'live') {
        return { promise: Promise.resolve({ stop: true, reason: 'replaced' }), cancel: () => {} }
      }
      this.pendingStop = null
    }

    // A wait arriving while NOT watching — after an idle-stop, a 'replaced', or a dropped
    // connection (cancel() flips `watching` off) — is the user re-arming with
    // /forge-watch: reset the idle clock rather than instantly re-stopping them for
    // inactivity that happened before they woke the watcher. `!watching` is the ONLY
    // re-arm signal on purpose: a heartbeat-staleness heuristic here would let a
    // slow-but-alive loop (gaps beyond freshMs — long apply cycles, a slow model) reset
    // its own idle clock forever and never auto-stop, defeating the hard token-cost
    // bound (PR #1 review, high severity). Known corner accepted in trade: a loop killed
    // BETWEEN cycles (no socket to close, so `watching` stays true) that the user
    // re-arms after idleStopMs gets one spurious {stop,'idle'} before the second
    // /forge-watch re-arms cleanly — rare, self-healing, and cheap next to an unbounded
    // idle loop.
    if (!this.watching) {
      this.watching = true
      this.everWatched = true
      this.lastActivity = nowMs
    }
    this.lastSeen = nowMs
    if (token !== undefined) this.lastToken = token

    // Preempt an existing waiter BEFORE the idle check — the preempted session must be
    // told to stop regardless of what this new wait resolves to. Remember the loser's
    // token (when it's a genuinely different session) so its retries get absorbed above;
    // preempting one's OWN parked wait (same token — e.g. a client-side abort + retry)
    // is not a takeover and must not deny that session its own slot.
    if (this.parked) {
      if (this.parked.token !== undefined && this.parked.token !== token) {
        this.pendingStop = { token: this.parked.token, reason: 'replaced' }
      }
      this.settle(this.parked, { stop: true, reason: 'replaced' })
      this.parked = null
    }

    if (nowMs - this.lastActivity > this.idleStopMs) {
      this.watching = false // asleep immediately — state() must not read live for freshMs
      return { promise: Promise.resolve({ stop: true, reason: 'idle' }), cancel: () => {} }
    }

    // Items queued while nothing was parked (between cycles, or before the watch started)
    // are claimed right at entry — worst-case delivery lag is one hold window, not forever.
    const immediate = this.claim()
    if (immediate.length > 0) {
      this.lastActivity = nowMs
      return { promise: Promise.resolve({ stop: false, items: immediate }), cancel: () => {} }
    }

    let waiter: ParkedWaiter
    const promise = new Promise<WaitResponse>((resolve) => {
      waiter = {
        resolve,
        settled: false,
        token,
        timer: setTimeout(() => {
          if (this.parked === waiter) {
            this.parked = null
            // Stamp the heartbeat at hold END, not just at wait entry: the watcher was
            // verifiably connected for this whole hold (a dropped socket cancels this timer
            // via cancel(); preemption clears it via settle()), so the agent gets the full
            // freshMs to process the empty result and re-arm — not freshMs minus the hold.
            // Before this stamp the real re-arm margin was WATCHER_FRESH_MS - WAIT_HOLD_MS
            // (~15s), which a slow turn (big context, thinking) blows routinely; a Send in
            // that gap took the keystroke ladder and typed /forge-design into the very
            // session that was watching. lastActivity is deliberately NOT touched — empty
            // holds are the idle ticking the auto-stop exists to bound.
            this.lastSeen = this.now()
          }
          this.settle(waiter, { stop: false, items: [] })
        }, this.holdMs),
      }
    })
    this.parked = waiter!
    const cancel = (): void => {
      if (waiter.settled) return
      clearTimeout(waiter.timer)
      waiter.settled = true // never resolves — the response socket is gone
      // The bin vanished mid-hold (agent killed, session closed, fetch aborted). If this
      // waiter still owns the slot, the watcher is GONE — flip `watching` off so state()
      // reads asleep immediately rather than a ghost 'live' for another WATCHER_FRESH_MS
      // (during which /dispatch would claim delivery while notify() had nobody to wake).
      // A STALE cancel — a newer wait already took the slot before this close event
      // landed — must touch nothing: the slot and the `watching` flag belong to the new
      // watcher now.
      if (this.parked === waiter) {
        this.parked = null
        this.watching = false
      }
    }
    return { promise, cancel }
  }

  /** Called by the /queue handler after an item lands — delivers to a parked waiter. */
  notify(): void {
    if (!this.parked) return
    const items = this.claim()
    if (items.length === 0) return // raced with another consumer — leave the waiter parked
    const waiter = this.parked
    this.parked = null
    this.lastActivity = this.now()
    this.settle(waiter, { stop: false, items })
  }

  /** Browser-initiated stop (POST /__the-forge/unwatch — the strip's ✕). Ends a live loop,
   * dismisses an asleep one, and resets the hub to 'none' so every polling browser converges
   * on the not-linked indicator. Never touches the queue: claimed items finish applying and
   * mark normally; pending items deliver to whoever links next. */
  unlink(): void {
    // Clear any stale pending stop from an earlier cycle before possibly setting a fresh
    // one below — otherwise an unrelated token's later legitimate re-arm could eat a
    // leftover one-shot denial that was never delivered (e.g. a between-cycles unlink's
    // 'unlinked' stop, still unconsumed when a different watcher is unlinked next).
    this.pendingStop = null
    if (this.parked) {
      // Parked: the loop hears this stop directly through its in-flight /wait — same trust
      // model as the idle stop, so no token denial (one would bounce a legitimate later
      // /forge-watch re-run from this same session exactly once — worse than trusting it).
      const waiter = this.parked
      this.parked = null
      this.settle(waiter, { stop: true, reason: 'unlinked' })
    } else if (this.watching && this.lastToken !== null) {
      // Live but not parked (between cycles / mid-apply): nothing can carry the stop, so
      // deny that token's NEXT wait instead — without this, flipping `watching` off would
      // make its next /wait read as a legitimate /forge-watch re-arm and silently re-link.
      // A tokenless legacy bin can't be denied and re-arms on its next wait (accepted —
      // same advisory-only degradation as the 'replaced' tokenless fallback). Accepted
      // micro-edge: lastToken may name an OLDER tokened session when the current watcher
      // is a tokenless legacy bin, so that older session's next deliberate re-arm eats one
      // spurious one-shot 'unlinked' stop — self-healing (the wait after re-arms cleanly).
      this.pendingStop = { token: this.lastToken, reason: 'unlinked' }
    }
    this.watching = false
    this.everWatched = false
  }

  state(): WatcherState {
    if (this.parked) return 'live'
    if (this.watching && this.now() - this.lastSeen < this.freshMs) return 'live'
    // Mid-apply: not parked, heartbeat possibly stale (applying can take minutes), but
    // the watcher IS working — it re-waits after mark_applied. See WatcherHubOpts.applying.
    if (this.watching && this.applying()) return 'live'
    return this.everWatched ? 'asleep' : 'none'
  }

  isLive(): boolean {
    return this.state() === 'live'
  }

  /** Resolves a waiter exactly once. Deliberately does NOT touch `watching`: a 'replaced'
   * stop ends the OLD session's loop while the NEW one watches on (the flag describes the
   * hub, not any one waiter), and the idle path flips the flag itself before settling. */
  private settle(waiter: ParkedWaiter, response: WaitResponse): void {
    if (waiter.settled) return
    waiter.settled = true
    clearTimeout(waiter.timer)
    waiter.resolve(response)
  }
}
