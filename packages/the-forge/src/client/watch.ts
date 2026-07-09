import { AGENT_DISPLAY_NAME, type AgentName } from './agent'

/** Watcher lifecycle as reported by GET /__the-forge/status (server/watchers.ts):
 * 'live' — a session is parked on (or freshly cycling) the /wait long-poll;
 * 'asleep' — a session watched at some point but has stopped (idle auto-stop, replaced,
 * or disconnected) and needs the user to type /forge-watch again;
 * 'none' — nothing ever watched this dev server; terminal-only users live here, and (since
 * the 2026-07-05 watcher-unlink spec's decision reversal, see watchIndicatorFor) they see
 * the upfront "not linked" hint rather than zero UI change. */
export type WatcherState = 'live' | 'asleep' | 'none'

/** Dispatch rungs as they arrive over the network from /dispatch (untyped JSON — see the
 * allowlist note in sentLabelFor). Mirrors server/dispatch.ts. */
export type Rung = 'watcher' | 'channels' | 'tmux' | 'applescript' | 'deeplink' | 'manual' | 'embedded'

/** Embedded-session lifecycle as reported by GET /__the-forge/status (server/session.ts):
 * 'idle' — session manager exists but no session is running;
 * 'starting' — session is being spawned;
 * 'ready' — session is alive and idle (waiting for work);
 * 'busy' — session is currently applying a change;
 * 'failed' — session crashed or could not start;
 * 'unavailable' — no session manager wired (older server, or server omits the field). */
export type SessionState = 'idle' | 'starting' | 'ready' | 'busy' | 'failed' | 'unavailable'

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
//
// Embedded-session layer (2026-07-09): an active embedded session
// (isSessionActive) is the HIGHEST-PRECEDENCE state in the indicator and
// queued-line branches — it beats watcher state, mirroring the dispatch rung
// order where 'embedded' is tried first. sentLabelFor('embedded') is its own
// explicit allowlist entry; it does NOT depend on watcher/session state because
// the server already told the client which rung delivered the request.
// ---------------------------------------------------------------------------

/** Returns true for session states that mean "the embedded session is alive and
 * will service queued items" — used by watchIndicatorFor and queuedLineFor to
 * short-circuit watcher copy with the embedded indicator. */
export function isSessionActive(s: SessionState): boolean {
  return s === 'starting' || s === 'ready' || s === 'busy'
}

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
  if (rung === 'embedded') return 'Sent — applying in the embedded session'
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
 * is on.
 *
 * Precedence: an active embedded session (isSessionActive) beats all watcher states — the
 * embedded indicator is shown regardless of whether a watcher is also live. The Stop control
 * for the embedded session lives in the feed (Task 7), not the strip, so unlinkable is false. */
export function watchIndicatorFor(state: WatcherState, agent: AgentName, session: SessionState = 'unavailable'): WatchIndicator {
  if (isSessionActive(session)) return { text: '● Embedded session active', live: true, unlinkable: false }
  if (state === 'live') return { text: `● Linked to ${AGENT_DISPLAY_NAME[agent]}`, live: true, unlinkable: true }
  if (state === 'asleep')
    return {
      text: `Watcher asleep — type /forge-watch in ${AGENT_DISPLAY_NAME[agent]} to wake it`,
      live: false,
      unlinkable: true,
    }
  return { text: `○ Not linked — type /forge-watch in ${AGENT_DISPLAY_NAME[agent]} to link`, live: false, unlinkable: false }
}

/** The verifier's sent-status prefix for still-pending (unclaimed) items.
 *
 * Active embedded session wins over all watcher states (same precedence as watchIndicatorFor). */
export function queuedLineFor(count: number, agentDisplayName: string, state: WatcherState, session: SessionState = 'unavailable'): string {
  if (isSessionActive(session)) return `${count} queued — applying in the embedded session…`
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
 *
 * Also parses the `session` field from the same poll body (present in servers with Task 5+;
 * absent in older servers → 'unavailable'). An optional second constructor param
 * `onSessionChange` fires on session-state transitions so callers that care (e.g. the
 * feed, Task 7) stay informed without extra polling.
 */
export class WatchStatus {
  private timer: ReturnType<typeof setTimeout> | null = null
  private state: WatcherState = 'none'
  private _sessionState: SessionState = 'unavailable'
  /** Bumped by every start()/stop(): a fetch resolving under an older generation must not
   * touch state or reschedule (same stale-chain guard as the Verifier's poll loop). */
  private generation = 0

  constructor(
    private onChange: (state: WatcherState) => void,
    private onSessionChange?: (s: SessionState) => void
  ) {}

  current(): WatcherState {
    return this.state
  }

  sessionState(): SessionState {
    return this._sessionState
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
    // Reset session state silently — same rationale as watcher state: no stale
    // "active session" claim should survive a design-mode cycle.
    this._sessionState = 'unavailable'
  }

  /** Applies a state a mutating endpoint already told us authoritatively in its response
   * body (currently only POST /__the-forge/unwatch), instead of waiting out the next
   * scheduled poll. Bundles stop()+start() (so the poll loop re-arms exactly as a fresh
   * start() would) with an explicit onChange fire — stop() alone clears state silently —
   * so the caller stays a thin one-liner instead of reaching into start()/stop() itself. */
  applyServerState(state: WatcherState): void {
    this.stop()
    this.state = state
    this.onChange(state)
    this.start()
  }

  private poll(gen: number): void {
    if (gen !== this.generation) return
    fetch('/__the-forge/status?ids=')
      .then((res) => (res.ok ? (res.json() as Promise<{ watcher?: unknown; session?: unknown }>) : null))
      .then((body) => {
        if (gen !== this.generation) return
        if (body === null) return this.degrade()
        // 'none' is a legitimate, AUTHORITATIVE server answer (e.g. a fresh hub after a
        // Vite restart) — it must clear a cached 'asleep', not fall into the degrade
        // path with failures. Only truly unrecognized values (a future server) degrade.
        const raw = body.watcher
        if (raw === 'live' || raw === 'asleep' || raw === 'none') this.update(raw)
        else this.degrade()
        // Session field: only the five known states are accepted; absent/unknown → 'unavailable'.
        const rawSession = body.session
        if (
          rawSession === 'idle' ||
          rawSession === 'starting' ||
          rawSession === 'ready' ||
          rawSession === 'busy' ||
          rawSession === 'failed'
        ) {
          this.updateSession(rawSession)
        } else {
          this.updateSession('unavailable')
        }
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
   * must not become a second alarm for the same outage.
   *
   * Same asymmetry for session state: active states ('starting'/'ready'/'busy') that
   * we can no longer confirm must drop to 'unavailable' (never claim the session is
   * applying when we can't prove it); 'failed' survives blips since it claims nothing
   * positive about delivery; 'idle'/'unavailable' survive as conservative defaults. */
  private degrade(): void {
    if (this.state === 'live') this.update('none')
    if (isSessionActive(this._sessionState)) this.updateSession('unavailable')
  }

  private update(next: WatcherState): void {
    if (next === this.state) return
    this.state = next
    this.onChange(next)
  }

  private updateSession(next: SessionState): void {
    if (next === this._sessionState) return
    this._sessionState = next
    this.onSessionChange?.(next)
  }
}
