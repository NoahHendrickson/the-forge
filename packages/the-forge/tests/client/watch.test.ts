// @vitest-environment jsdom
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import {
  WatchStatus,
  WATCH_POLL_MS,
  sentLabelFor,
  watchIndicatorFor,
  queuedLineFor,
  isSessionActive,
  type SessionState,
} from '../../src/client/watch'

beforeEach(() => {
  vi.useFakeTimers()
})

afterEach(() => {
  vi.useRealTimers()
  vi.unstubAllGlobals()
})

function stubStatus(watcher: unknown) {
  const fetchMock = vi.fn().mockResolvedValue({ ok: true, json: async () => ({ items: [], watcher }) })
  vi.stubGlobal('fetch', fetchMock)
  return fetchMock
}

function stubStatusWithSession(watcher: unknown, session: unknown) {
  const fetchMock = vi.fn().mockResolvedValue({ ok: true, json: async () => ({ items: [], watcher, session }) })
  vi.stubGlobal('fetch', fetchMock)
  return fetchMock
}

describe('WatchStatus poller', () => {
  it('polls the empty-ids probe immediately on start and reports a live watcher', async () => {
    const fetchMock = stubStatus('live')
    const onChange = vi.fn()
    const watch = new WatchStatus(onChange)
    watch.start()
    await vi.advanceTimersByTimeAsync(0)
    expect(fetchMock).toHaveBeenCalledWith('/__the-forge/status?ids=')
    expect(onChange).toHaveBeenCalledWith('live')
    expect(watch.current()).toBe('live')
    watch.stop()
  })

  it('fires onChange once per transition, not once per poll', async () => {
    const fetchMock = stubStatus('live')
    const onChange = vi.fn()
    const watch = new WatchStatus(onChange)
    watch.start()
    await vi.advanceTimersByTimeAsync(0)
    await vi.advanceTimersByTimeAsync(WATCH_POLL_MS)
    await vi.advanceTimersByTimeAsync(WATCH_POLL_MS)
    expect(fetchMock).toHaveBeenCalledTimes(3)
    expect(onChange).toHaveBeenCalledTimes(1) // live, then no further transitions

    fetchMock.mockResolvedValue({ ok: true, json: async () => ({ items: [], watcher: 'asleep' }) })
    await vi.advanceTimersByTimeAsync(WATCH_POLL_MS)
    expect(onChange).toHaveBeenCalledTimes(2)
    expect(onChange).toHaveBeenLastCalledWith('asleep')
    watch.stop()
  })

  it('stop() kills the chain — no fetches after (zero-idle-overhead when design mode is off)', async () => {
    const fetchMock = stubStatus('live')
    const watch = new WatchStatus(() => {})
    watch.start()
    await vi.advanceTimersByTimeAsync(0)
    const callsAtStop = fetchMock.mock.calls.length
    watch.stop()
    await vi.advanceTimersByTimeAsync(WATCH_POLL_MS * 5)
    expect(fetchMock).toHaveBeenCalledTimes(callsAtStop)
  })

  it('a poll failure drops a claimed live silently (never keep a false delivery claim)', async () => {
    const fetchMock = stubStatus('live')
    const onChange = vi.fn()
    const watch = new WatchStatus(onChange)
    watch.start()
    await vi.advanceTimersByTimeAsync(0)
    expect(watch.current()).toBe('live')

    fetchMock.mockRejectedValue(new Error('dev server gone'))
    await vi.advanceTimersByTimeAsync(WATCH_POLL_MS)
    expect(watch.current()).toBe('none')
    expect(onChange).toHaveBeenLastCalledWith('none')
    watch.stop()
  })

  it("a successful 'none' response CLEARS a cached asleep — the server is authoritative (fresh hub after a restart)", async () => {
    const fetchMock = stubStatus('asleep')
    const watch = new WatchStatus(() => {})
    watch.start()
    await vi.advanceTimersByTimeAsync(0)
    expect(watch.current()).toBe('asleep')

    fetchMock.mockResolvedValue({ ok: true, json: async () => ({ items: [], watcher: 'none' }) })
    await vi.advanceTimersByTimeAsync(WATCH_POLL_MS)
    expect(watch.current()).toBe('none') // unlike a FAILED poll, which keeps asleep (below)
    watch.stop()
  })

  it('asleep SURVIVES a failed poll — the wake instruction must not flicker away on a blip', async () => {
    const fetchMock = stubStatus('asleep')
    const watch = new WatchStatus(() => {})
    watch.start()
    await vi.advanceTimersByTimeAsync(0)
    expect(watch.current()).toBe('asleep')

    fetchMock.mockRejectedValue(new Error('transient'))
    await vi.advanceTimersByTimeAsync(WATCH_POLL_MS)
    expect(watch.current()).toBe('asleep') // claims nothing about the server; keep the ratified message
    watch.stop()
  })

  it('unrecognized watcher values (future server) read as none, never crash the indicator', async () => {
    stubStatus('some-future-state')
    const watch = new WatchStatus(() => {})
    watch.start()
    await vi.advanceTimersByTimeAsync(0)
    expect(watch.current()).toBe('none')
    watch.stop()
  })

  it('stop() forgets the last state — no cached "Linked" flash on the next design-mode entry', async () => {
    stubStatus('live')
    const watch = new WatchStatus(() => {})
    watch.start()
    await vi.advanceTimersByTimeAsync(0)
    expect(watch.current()).toBe('live')
    watch.stop()
    expect(watch.current()).toBe('none') // re-activation renders nothing until the first probe answers
  })

  it('start() while already running is a no-op (no double chains)', async () => {
    const fetchMock = stubStatus('none')
    const watch = new WatchStatus(() => {})
    watch.start()
    watch.start()
    await vi.advanceTimersByTimeAsync(0)
    await vi.advanceTimersByTimeAsync(WATCH_POLL_MS)
    // one immediate poll + one scheduled poll — a doubled chain would have produced 4
    expect(fetchMock).toHaveBeenCalledTimes(2)
    watch.stop()
  })
})

describe('sentLabelFor watcher copy', () => {
  it('watcher rung reads as delivered to the agent session', () => {
    expect(sentLabelFor('watcher', 'claude-code')).toBe('Sent — delivered to your Claude Code session')
  })

  it('manual rung with an asleep watcher reads as the wake instruction', () => {
    expect(sentLabelFor('manual', 'claude-code', 'asleep')).toBe(
      'Sent — watcher asleep, type /forge-watch in Claude Code to apply'
    )
  })

  it('manual rung with a STALE client-side live also reads as the wake instruction (server is authoritative)', () => {
    // The 5s poller can lag the server: dispatch said manual, so the watcher did NOT
    // take this Send regardless of what the client last observed.
    expect(sentLabelFor('manual', 'claude-code', 'live')).toBe(
      'Sent — watcher asleep, type /forge-watch in Claude Code to apply'
    )
  })

  it('manual rung with no watcher steers to /forge-watch (link CTA)', () => {
    expect(sentLabelFor('manual', 'claude-code')).toBe('Sent — queued. Type /forge-watch in Claude Code to link & apply')
    expect(sentLabelFor('manual', 'claude-code', 'none')).toBe(
      'Sent — queued. Type /forge-watch in Claude Code to link & apply'
    )
  })

  it('unrecognized rungs still default to the manual family (allowlist regression)', () => {
    expect(sentLabelFor('totally-new-rung' as never, 'claude-code')).toBe(
      'Sent — queued. Type /forge-watch in Claude Code to link & apply'
    )
    expect(sentLabelFor('totally-new-rung' as never, 'claude-code', 'asleep')).toBe(
      'Sent — watcher asleep, type /forge-watch in Claude Code to apply'
    )
  })

  it('tmux/applescript/deeplink copy is untouched by watcher state', () => {
    expect(sentLabelFor('tmux', 'claude-code', 'asleep')).toBe('Sent — typed /forge-design into your session')
    expect(sentLabelFor('deeplink', 'cursor', 'asleep')).toBe('Sent — opened in Cursor')
  })
})

describe('queuedLineFor (verifier pending prefix — same matrix, same module)', () => {
  it('live → delivering; asleep → wake; none → pre-watch-mode copy', () => {
    expect(queuedLineFor(2, 'Claude Code', 'live')).toBe('2 queued — delivering to your Claude Code session…')
    expect(queuedLineFor(1, 'Claude Code', 'asleep')).toBe(
      '1 queued — watcher asleep, type /forge-watch in Claude Code to wake it'
    )
    expect(queuedLineFor(1, 'Claude Code', 'none')).toBe('1 queued — type /forge-watch in Claude Code to link & apply')
  })
})

describe('watchIndicatorFor', () => {
  it('live: linked pill with the live accent, unlinkable', () => {
    expect(watchIndicatorFor('live', 'claude-code')).toEqual({
      text: '● Linked to Claude Code',
      live: true,
      unlinkable: true,
    })
  })

  it('asleep: the wake instruction, not live-accented, dismissable', () => {
    expect(watchIndicatorFor('asleep', 'claude-code')).toEqual({
      text: 'Watcher asleep — type /forge-watch in Claude Code to wake it',
      live: false,
      unlinkable: true,
    })
  })

  it('none: the upfront not-linked hint (decision reversal — see 2026-07-05 spec), nothing to unlink', () => {
    expect(watchIndicatorFor('none', 'claude-code')).toEqual({
      text: '○ Not linked — type /forge-watch in Claude Code to link',
      live: false,
      unlinkable: false,
    })
  })

  it('active session beats a live watcher — embedded indicator wins', () => {
    expect(watchIndicatorFor('live', 'claude-code', 'ready')).toEqual({
      text: '● Embedded session active',
      live: true,
      unlinkable: false,
    })
  })

  it('active session beats an asleep watcher', () => {
    expect(watchIndicatorFor('asleep', 'claude-code', 'starting')).toEqual({
      text: '● Embedded session active',
      live: true,
      unlinkable: false,
    })
  })

  it('active session beats a none watcher', () => {
    expect(watchIndicatorFor('none', 'claude-code', 'busy')).toEqual({
      text: '● Embedded session active',
      live: true,
      unlinkable: false,
    })
  })

  it('inactive session states fall through to existing watcher behavior', () => {
    for (const inactive of ['idle', 'failed', 'unavailable'] as SessionState[]) {
      expect(watchIndicatorFor('live', 'claude-code', inactive)).toEqual({
        text: '● Linked to Claude Code',
        live: true,
        unlinkable: true,
      })
    }
  })

  it('absent session param (default) falls through to existing watcher behavior', () => {
    expect(watchIndicatorFor('live', 'claude-code')).toEqual({
      text: '● Linked to Claude Code',
      live: true,
      unlinkable: true,
    })
  })
})

describe('sentLabelFor — embedded rung', () => {
  it('embedded rung → applying in the embedded session (allowlisted explicitly)', () => {
    expect(sentLabelFor('embedded', 'claude-code')).toBe('Sent — applying in the embedded session')
  })

  it('embedded rung ignores watcher state — server already told us the rung', () => {
    expect(sentLabelFor('embedded', 'claude-code', 'none')).toBe('Sent — applying in the embedded session')
    expect(sentLabelFor('embedded', 'claude-code', 'asleep')).toBe('Sent — applying in the embedded session')
    expect(sentLabelFor('embedded', 'claude-code', 'live')).toBe('Sent — applying in the embedded session')
  })

  it('unrecognized rungs still default to the manual family (allowlist regression — embedded is explicit, not "any new rung")', () => {
    expect(sentLabelFor('totally-new-rung' as never, 'claude-code')).toBe(
      'Sent — queued. Type /forge-watch in Claude Code to link & apply'
    )
  })
})

describe('queuedLineFor — active session branch', () => {
  it('active session → applying in the embedded session (wins over all watcher states)', () => {
    expect(queuedLineFor(3, 'Claude Code', 'none', 'ready')).toBe('3 queued — applying in the embedded session…')
    expect(queuedLineFor(1, 'Claude Code', 'live', 'busy')).toBe('1 queued — applying in the embedded session…')
    expect(queuedLineFor(2, 'Claude Code', 'asleep', 'starting')).toBe('2 queued — applying in the embedded session…')
  })

  it('inactive session falls through to existing watcher behavior', () => {
    expect(queuedLineFor(2, 'Claude Code', 'live', 'unavailable')).toBe(
      '2 queued — delivering to your Claude Code session…'
    )
    expect(queuedLineFor(1, 'Claude Code', 'none', 'idle')).toBe(
      '1 queued — type /forge-watch in Claude Code to link & apply'
    )
    expect(queuedLineFor(1, 'Claude Code', 'asleep', 'failed')).toBe(
      '1 queued — watcher asleep, type /forge-watch in Claude Code to wake it'
    )
  })

  it('absent session param (default) falls through to existing watcher behavior', () => {
    expect(queuedLineFor(2, 'Claude Code', 'live')).toBe('2 queued — delivering to your Claude Code session…')
  })
})

describe('isSessionActive', () => {
  it('active states: starting, ready, busy', () => {
    expect(isSessionActive('starting')).toBe(true)
    expect(isSessionActive('ready')).toBe(true)
    expect(isSessionActive('busy')).toBe(true)
  })

  it('inactive states: idle, failed, unavailable', () => {
    expect(isSessionActive('idle')).toBe(false)
    expect(isSessionActive('failed')).toBe(false)
    expect(isSessionActive('unavailable')).toBe(false)
  })
})

describe('WatchStatus — session field parsing', () => {
  it('session field present → sessionState() reflects it', async () => {
    stubStatusWithSession('none', 'ready')
    const watch = new WatchStatus(() => {})
    watch.start()
    await vi.advanceTimersByTimeAsync(0)
    expect(watch.sessionState()).toBe('ready')
    watch.stop()
  })

  it('session field absent → unavailable', async () => {
    stubStatus('none')
    const watch = new WatchStatus(() => {})
    watch.start()
    await vi.advanceTimersByTimeAsync(0)
    expect(watch.sessionState()).toBe('unavailable')
    watch.stop()
  })

  it('session field unknown value → unavailable', async () => {
    stubStatusWithSession('none', 'future-state')
    const watch = new WatchStatus(() => {})
    watch.start()
    await vi.advanceTimersByTimeAsync(0)
    expect(watch.sessionState()).toBe('unavailable')
    watch.stop()
  })

  it('all five known session states are accepted verbatim', async () => {
    for (const state of ['idle', 'starting', 'ready', 'busy', 'failed'] as SessionState[]) {
      stubStatusWithSession('none', state)
      const watch = new WatchStatus(() => {})
      watch.start()
      await vi.advanceTimersByTimeAsync(0)
      expect(watch.sessionState()).toBe(state)
      watch.stop()
    }
  })

  it('degrade drops active session states to unavailable', async () => {
    const fetchMock = stubStatusWithSession('none', 'ready')
    const watch = new WatchStatus(() => {})
    watch.start()
    await vi.advanceTimersByTimeAsync(0)
    expect(watch.sessionState()).toBe('ready')

    fetchMock.mockRejectedValue(new Error('gone'))
    await vi.advanceTimersByTimeAsync(WATCH_POLL_MS)
    expect(watch.sessionState()).toBe('unavailable')
    watch.stop()
  })

  it('degrade keeps failed session state across blips', async () => {
    const fetchMock = stubStatusWithSession('none', 'failed')
    const watch = new WatchStatus(() => {})
    watch.start()
    await vi.advanceTimersByTimeAsync(0)
    expect(watch.sessionState()).toBe('failed')

    fetchMock.mockRejectedValue(new Error('blip'))
    await vi.advanceTimersByTimeAsync(WATCH_POLL_MS)
    expect(watch.sessionState()).toBe('failed')
    watch.stop()
  })

  it('stop() resets sessionState to unavailable', async () => {
    stubStatusWithSession('none', 'busy')
    const watch = new WatchStatus(() => {})
    watch.start()
    await vi.advanceTimersByTimeAsync(0)
    expect(watch.sessionState()).toBe('busy')
    watch.stop()
    expect(watch.sessionState()).toBe('unavailable')
  })

  it('onSessionChange fires on session transitions, not on repeats', async () => {
    const fetchMock = stubStatusWithSession('none', 'ready')
    const onSessionChange = vi.fn()
    const watch = new WatchStatus(() => {}, onSessionChange)
    watch.start()
    await vi.advanceTimersByTimeAsync(0)
    expect(onSessionChange).toHaveBeenCalledTimes(1)
    expect(onSessionChange).toHaveBeenCalledWith('ready')

    // Same state again → no extra fire
    await vi.advanceTimersByTimeAsync(WATCH_POLL_MS)
    expect(onSessionChange).toHaveBeenCalledTimes(1)

    // Transition to busy → fires
    fetchMock.mockResolvedValue({ ok: true, json: async () => ({ items: [], watcher: 'none', session: 'busy' }) })
    await vi.advanceTimersByTimeAsync(WATCH_POLL_MS)
    expect(onSessionChange).toHaveBeenCalledTimes(2)
    expect(onSessionChange).toHaveBeenLastCalledWith('busy')
    watch.stop()
  })

  it('onSessionChange is optional — callers that omit it still work', async () => {
    stubStatusWithSession('none', 'ready')
    const watch = new WatchStatus(() => {})
    watch.start()
    await vi.advanceTimersByTimeAsync(0)
    expect(watch.sessionState()).toBe('ready')
    watch.stop()
  })
})
