/** Watcher lifecycle as reported by GET /__the-forge/status (server/watchers.ts):
 * 'live' — a session is parked on (or freshly cycling) the /wait long-poll;
 * 'asleep' — a session watched at some point but has stopped (idle auto-stop, replaced,
 * or disconnected) and needs the user to type /forge-watch again;
 * 'none' — nothing ever watched this dev server; terminal-only users live here and must
 * see zero UI change. */
export type WatcherState = 'live' | 'asleep' | 'none'

export const WATCH_POLL_MS = 5_000

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
