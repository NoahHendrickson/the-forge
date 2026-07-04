import { AGENT_DISPLAY_NAME, type AgentName } from './agent'

/** Watcher lifecycle as reported by GET /__the-forge/status (server/watchers.ts):
 * 'live' — a session is parked on (or freshly cycling) the /wait long-poll;
 * 'asleep' — a session watched at some point but has stopped (idle auto-stop, replaced,
 * or disconnected) and needs the user to type /forge-watch again;
 * 'none' — nothing ever watched this dev server; terminal-only users live here and must
 * see zero UI change. */
export type WatcherState = 'live' | 'asleep' | 'none'

/** Dispatch rungs as they arrive over the network from /dispatch (untyped JSON — see the
 * allowlist note in sentLabelFor). Mirrors server/dispatch.ts. */
export type Rung = 'watcher' | 'channels' | 'tmux' | 'applescript' | 'deeplink' | 'manual'

export const WATCH_POLL_MS = 5_000

// ---------------------------------------------------------------------------
// Watcher copy — the ONE home for the live/asleep/none message matrix. The Send
// flash (sentLabelFor), the strip indicator (watchIndicatorFor), and the
// verifier's queued prefix (queuedLineFor) all encode the same rules: a live
// watcher means delivery (never an instruction to type), an asleep watcher
// means wake it with /forge-watch (the queued items deliver on wake — nothing
// is lost), and no watcher means the pre-watch-mode /forge-design copy
// verbatim. Keep all three here so the matrix can't drift across modules.
// ---------------------------------------------------------------------------

/** Maps a dispatch rung to the Send button's flash label. Request content never appears
 * here — only the fixed per-rung copy and (for manual-family rungs) the configured
 * agent's display name. */
export function sentLabelFor(rung: Rung, agent: AgentName, watcherState: WatcherState = 'none'): string {
  if (rung === 'deeplink') return 'Sent — opened in Cursor'
  // Explicit allowlist for the "typed into your session" / "delivered" copy — the rung
  // value actually arrives over the network as untyped JSON (see the /dispatch fetch
  // handler in index.ts), so any value that isn't recognizably watcher/tmux/applescript
  // (a typo, a future rung, a server bug) must default to the manual label rather than
  // falsely claiming delivery.
  if (rung === 'watcher') return `Sent — delivered to your ${AGENT_DISPLAY_NAME[agent]} session`
  if (rung === 'tmux' || rung === 'applescript') return 'Sent — typed /forge-design into your session'
  if (watcherState === 'asleep') return `Sent — watcher asleep, type /forge-watch in ${AGENT_DISPLAY_NAME[agent]} to apply`
  return `Sent — type /forge-design in ${AGENT_DISPLAY_NAME[agent]}`
}

/** The persistent watch indicator's strip content per watcher state — 'none' renders
 * nothing (terminal-only users must see zero change from watch mode existing). */
export function watchIndicatorFor(state: WatcherState, agent: AgentName): { text: string; live: boolean } | undefined {
  if (state === 'live') return { text: `● Linked to ${AGENT_DISPLAY_NAME[agent]}`, live: true }
  if (state === 'asleep')
    return { text: `Watcher asleep — type /forge-watch in ${AGENT_DISPLAY_NAME[agent]} to wake it`, live: false }
  return undefined
}

/** The verifier's sent-status prefix for still-pending (unclaimed) items. */
export function queuedLineFor(count: number, agentDisplayName: string, state: WatcherState): string {
  if (state === 'live') return `${count} queued — delivering to your ${agentDisplayName} session…`
  if (state === 'asleep') return `${count} queued — watcher asleep, type /forge-watch in ${agentDisplayName} to wake it`
  return `${count} queued — type /forge-design in ${agentDisplayName}`
}

/**
 * Polls watcher state while design mode is ON — and only then: start() is called from
 * DesignMode.setActive(true) and stop() from setActive(false), so no timer or request
 * survives design mode being off (the zero-idle-overhead constraint governs the off
 * state). Uses `?ids=` (present-but-empty) so the server returns watcher state with zero
 * queue items — this poll is a heartbeat probe, not the verifier.
 */
export class WatchStatus {
  private timer: ReturnType<typeof setTimeout> | null = null
  private state: WatcherState = 'none'
  /** Bumped by every start()/stop(): a fetch resolving under an older generation must not
   * touch state or reschedule (same stale-chain guard as the Verifier's poll loop). */
  private generation = 0

  constructor(private onChange: (state: WatcherState) => void) {}

  current(): WatcherState {
    return this.state
  }

  start(): void {
    if (this.timer) return
    this.generation++
    const gen = this.generation
    // Near-immediate first poll (the linked indicator should appear when design mode
    // turns on, not up to WATCH_POLL_MS later) — but still via the timer so the
    // "chain alive ⇔ this.timer non-null" invariant holds from the very first tick,
    // exactly like the Verifier's chained-setTimeout loop.
    this.timer = setTimeout(() => this.poll(gen), 0)
  }

  stop(): void {
    this.generation++
    if (this.timer) clearTimeout(this.timer)
    this.timer = null
    // Forget the last observed state: a design-mode re-entry must never flash a cached
    // "● Linked" from the previous session before the first probe answers — 'none'
    // renders nothing until the server says otherwise. No onChange fire: design mode is
    // off, so there is no indicator to update (refreshStatus no-ops while inactive).
    this.state = 'none'
  }

  private poll(gen: number): void {
    if (gen !== this.generation) return
    fetch('/__the-forge/status?ids=')
      .then((res) => (res.ok ? (res.json() as Promise<{ watcher?: unknown }>) : null))
      .then((body) => {
        if (gen !== this.generation) return
        // Poll failures and unrecognized values degrade to 'none' SILENTLY — a dead dev
        // server already gets the verifier's louder "unreachable" messaging; the watch
        // indicator must not become a second alarm for the same outage.
        const raw = body?.watcher
        this.update(raw === 'live' || raw === 'asleep' ? raw : 'none')
      })
      .catch(() => {
        if (gen !== this.generation) return
        this.update('none')
      })
      .finally(() => {
        // A stop() (or stop()+start()) while the fetch was in flight bumps the generation —
        // this chain is dead and must not reschedule (same guard as Verifier.poll).
        if (this.timer !== null && gen === this.generation) {
          this.timer = setTimeout(() => this.poll(gen), WATCH_POLL_MS)
        }
      })
  }

  private update(next: WatcherState): void {
    if (next === this.state) return
    this.state = next
    this.onChange(next)
  }
}
