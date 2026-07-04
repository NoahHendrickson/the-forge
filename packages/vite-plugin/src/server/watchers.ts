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
  | { stop: true; reason: 'idle' | 'replaced' }
  | { stop: false; items: QueueItem[] }

export interface WatcherHubOpts {
  /** Claims all currently-claimable queue items — `() => queue.pull()` in production.
   * Injected so hub tests never touch a real Queue/disk. */
  claim: () => QueueItem[]
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
}

/**
 * Single-slot registry for the linked-session watch loop (`/forge-watch` →
 * `wait_for_design_edits` → `POST /__the-forge/wait`). The long-poll doubles as the
 * liveness signal dispatch uses to pick the `watcher` rung: a parked waiter (or one seen
 * within WATCHER_FRESH_MS) means a session is actively watching and Sends are delivered
 * through it instead of the keystroke ladder.
 *
 * Single slot on purpose: if two sessions watch the same project, deliveries would
 * alternate between them unpredictably. Instead a second wait() preempts the first with
 * an explicit `{stop, 'replaced'}` — the replaced agent is told to stop looping, so the
 * two can't ping-pong the slot back and forth.
 */
export class WatcherHub {
  private claim: () => QueueItem[]
  private now: () => number
  private holdMs: number
  private idleStopMs: number
  private freshMs: number

  private parked: ParkedWaiter | null = null
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
  wait(): { promise: Promise<WaitResponse>; cancel: () => void } {
    const nowMs = this.now()

    // A wait arriving from a non-live watcher — after an idle-stop, or after the previous
    // loop died silently (disconnect/kill, detected as heartbeat staleness) — is the user
    // re-arming with /forge-watch: reset the idle clock rather than instantly re-stopping
    // them for inactivity that happened before they woke the watcher. A wait within the
    // freshness window is just the running loop's next cycle and must NOT reset the clock,
    // or the loop's own ticking would defeat the idle auto-stop.
    const isRearm = !this.watching || nowMs - this.lastSeen >= this.freshMs
    if (isRearm) {
      this.watching = true
      this.everWatched = true
      this.lastActivity = nowMs
    }
    this.lastSeen = nowMs

    // Preempt an existing waiter BEFORE the idle check — the preempted session must be
    // told to stop regardless of what this new wait resolves to.
    if (this.parked) {
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
        timer: setTimeout(() => {
          if (this.parked === waiter) this.parked = null
          this.settle(waiter, { stop: false, items: [] })
        }, this.holdMs),
      }
    })
    this.parked = waiter!
    const cancel = (): void => {
      if (waiter.settled) return
      clearTimeout(waiter.timer)
      waiter.settled = true // never resolves — the response socket is gone
      if (this.parked === waiter) this.parked = null
      // The bin vanished mid-hold (agent killed, session closed). Don't flip `watching`
      // here — a re-arm may already be in flight; freshness decay handles a real death.
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

  state(): WatcherState {
    if (this.parked) return 'live'
    if (this.watching && this.now() - this.lastSeen < this.freshMs) return 'live'
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
