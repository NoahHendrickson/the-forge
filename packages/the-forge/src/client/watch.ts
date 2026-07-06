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
// is lost), and no watcher means the upfront "not linked" hint steering to
// /forge-watch (the 2026-07-05 watcher-unlink spec deliberately REVERSED the
// original "none renders nothing" rule — the user wants link state visible
// before Send, and /forge-watch as the one advertised flow). Keep all three
// here so the matrix can't drift across modules.
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
  // Manual family + ANY known watcher ('asleep' OR a possibly-stale client-side 'live'):
  // the server is authoritative that the watcher did NOT take this Send — if it were
  // live server-side we'd have the watcher rung. The wake copy is the honest instruction
  // either way: the request is safely queued, and /forge-watch delivers everything
  // pending on wake.
  if (watcherState !== 'none') return `Sent — watcher asleep, type /forge-watch in ${AGENT_DISPLAY_NAME[agent]} to apply`
  return `Sent — queued. Type /forge-watch in ${AGENT_DISPLAY_NAME[agent]} to link & apply`
}

export interface WatchIndicator {
  text: string
  live: boolean
  /** Whether the strip offers the unlink ✕ — live and asleep watchers can be
   * unlinked/dismissed; 'none' has nothing to unlink. */
  unlinkable: boolean
}

/** The persistent watch indicator's strip content per watcher state. Always returns an
 * indicator: 'none' renders the upfront not-linked hint (see the matrix comment above for
 * the recorded decision reversal), which also keeps the strip visible whenever design mode
 * is on. */
export function watchIndicatorFor(state: WatcherState, agent: AgentName): WatchIndicator {
  if (state === 'live') return { text: `● Linked to ${AGENT_DISPLAY_NAME[agent]}`, live: true, unlinkable: true }
  if (state === 'asleep')
    return {
      text: `Watcher asleep — type /forge-watch in ${AGENT_DISPLAY_NAME[agent]} to wake it`,
      live: false,
      unlinkable: true,
    }
  return { text: `○ Not linked — type /forge-watch in ${AGENT_DISPLAY_NAME[agent]} to link`, live: false, unlinkable: false }
}

/** The verifier's sent-status prefix for still-pending (unclaimed) items. */
export function queuedLineFor(count: number, agentDisplayName: string, state: WatcherState): string {
  if (state === 'live') return `${count} queued — delivering to your ${agentDisplayName} session…`
  if (state === 'asleep') return `${count} queued — watcher asleep, type /forge-watch in ${agentDisplayName} to wake it`
  return `${count} queued — type /forge-watch in ${agentDisplayName} to link & apply`
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
    // renders the not-linked hint (2026-07-05 watcher-unlink spec), a conservative default until the server says otherwise. No onChange fire: design mode is
    // off, so there is no indicator to update (refreshStatus no-ops while inactive).
    this.state = 'none'
  }

  private poll(gen: number): void {
    if (gen !== this.generation) return
    fetch('/__the-forge/status?ids=')
      .then((res) => (res.ok ? (res.json() as Promise<{ watcher?: unknown }>) : null))
      .then((body) => {
        if (gen !== this.generation) return
        if (body === null) return this.degrade()
        // 'none' is a legitimate, AUTHORITATIVE server answer (e.g. a fresh hub after a
        // Vite restart) — it must clear a cached 'asleep', not fall into the degrade
        // path with failures. Only truly unrecognized values (a future server) degrade.
        const raw = body.watcher
        if (raw === 'live' || raw === 'asleep' || raw === 'none') this.update(raw)
        else this.degrade()
      })
      .catch(() => {
        if (gen !== this.generation) return
        this.degrade()
      })
      .finally(() => {
        // A stop() (or stop()+start()) while the fetch was in flight bumps the generation —
        // this chain is dead and must not reschedule (same guard as Verifier.poll).
        if (this.timer !== null && gen === this.generation) {
          this.timer = setTimeout(() => this.poll(gen), WATCH_POLL_MS)
        }
      })
  }

  /** Failure/unknown handling, asymmetric on purpose: a claimed 'live' we can no longer
   * confirm must drop (never keep a false delivery claim), but a standing 'asleep' —
   * user-ratified wake messaging that claims nothing about the server — survives blips
   * rather than flickering away until the next good poll. Silent either way: a dead dev
   * server already gets the verifier's louder "unreachable" messaging; the indicator
   * must not become a second alarm for the same outage. */
  private degrade(): void {
    if (this.state === 'live') this.update('none')
  }

  private update(next: WatcherState): void {
    if (next === this.state) return
    this.state = next
    this.onChange(next)
  }
}
