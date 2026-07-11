// @vitest-environment jsdom
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import {
  WatchStatus,
  WATCH_POLL_MS,
  watchIndicatorFor,
  queuedLineFor,
  isSessionActive,
  parseHarness,
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

describe('WatchStatus — sessionEnabled parsing (Task 6)', () => {
  function stubStatusWithEnabled(sessionEnabled: unknown) {
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, json: async () => ({ items: [], watcher: 'none', sessionEnabled }) })
    vi.stubGlobal('fetch', fetchMock)
    return fetchMock
  }

  it('sessionEnabled undefined before the first poll answers', () => {
    const watch = new WatchStatus(() => {})
    expect(watch.sessionEnabled()).toBeUndefined()
  })

  it('a true sessionEnabled is parsed verbatim', async () => {
    stubStatusWithEnabled(true)
    const watch = new WatchStatus(() => {})
    watch.start()
    await vi.advanceTimersByTimeAsync(0)
    expect(watch.sessionEnabled()).toBe(true)
    watch.stop()
  })

  it('a false sessionEnabled is parsed verbatim', async () => {
    stubStatusWithEnabled(false)
    const watch = new WatchStatus(() => {})
    watch.start()
    await vi.advanceTimersByTimeAsync(0)
    expect(watch.sessionEnabled()).toBe(false)
    watch.stop()
  })

  it('unknown-shape sessionEnabled (absent field, older server) is tolerated without crash — stays undefined', async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, json: async () => ({ items: [], watcher: 'none' }) })
    vi.stubGlobal('fetch', fetchMock)
    const watch = new WatchStatus(() => {})
    expect(() => watch.start()).not.toThrow()
    await vi.advanceTimersByTimeAsync(0)
    expect(watch.sessionEnabled()).toBeUndefined()
    watch.stop()
  })

  it('unknown-shape sessionEnabled (non-boolean value) is tolerated without crash — stays undefined', async () => {
    stubStatusWithEnabled('not-a-bool')
    const watch = new WatchStatus(() => {})
    expect(() => watch.start()).not.toThrow()
    await vi.advanceTimersByTimeAsync(0)
    expect(watch.sessionEnabled()).toBeUndefined()
    watch.stop()
  })

  it('a malformed value on a later poll does not clobber a previously known-good flag', async () => {
    const fetchMock = stubStatusWithEnabled(false)
    const watch = new WatchStatus(() => {})
    watch.start()
    await vi.advanceTimersByTimeAsync(0)
    expect(watch.sessionEnabled()).toBe(false)

    fetchMock.mockResolvedValue({ ok: true, json: async () => ({ items: [], watcher: 'none', sessionEnabled: 123 }) })
    await vi.advanceTimersByTimeAsync(WATCH_POLL_MS)
    expect(watch.sessionEnabled()).toBe(false)
    watch.stop()
  })

  it('stop() resets sessionEnabled to undefined', async () => {
    stubStatusWithEnabled(true)
    const watch = new WatchStatus(() => {})
    watch.start()
    await vi.advanceTimersByTimeAsync(0)
    expect(watch.sessionEnabled()).toBe(true)
    watch.stop()
    expect(watch.sessionEnabled()).toBeUndefined()
  })

  it('sessionEnabled is updated BEFORE onChange/onSessionChange fire, so a callback reading it sees the fresh value', async () => {
    // Regression guard: this ordering bug shipped once already (index.ts's refreshStatus,
    // wired to onChange/onSessionChange, read a stale sessionEnabled on the very poll that
    // changed it) — see the why-comment in watch.ts's poll().
    stubStatusWithSession('none', 'idle') // 'unavailable' -> 'idle' is a transition, fires onSessionChange
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ items: [], watcher: 'none', session: 'idle', sessionEnabled: false }),
    })
    vi.stubGlobal('fetch', fetchMock)
    const seenAtCallback: Array<boolean | undefined> = []
    const watch = new WatchStatus(
      () => {},
      () => seenAtCallback.push(watch.sessionEnabled())
    )
    watch.start()
    await vi.advanceTimersByTimeAsync(0)
    expect(seenAtCallback).toEqual([false])
    watch.stop()
  })

  it('onTick fires every poll, even when neither watcher nor session transitions', async () => {
    stubStatusWithEnabled(false) // watcher 'none' (already default), no session field (stays 'unavailable')
    const ticks: Array<boolean | undefined> = []
    const watch = new WatchStatus(
      () => {},
      () => {},
      () => ticks.push(watch.sessionEnabled())
    )
    watch.start()
    await vi.advanceTimersByTimeAsync(0)
    await vi.advanceTimersByTimeAsync(WATCH_POLL_MS)
    expect(ticks).toEqual([false, false])
    watch.stop()
  })

  it('onTick is optional — callers that omit it still work', async () => {
    stubStatus('none')
    const watch = new WatchStatus(() => {})
    expect(() => watch.start()).not.toThrow()
    await vi.advanceTimersByTimeAsync(0)
    watch.stop()
  })

  it('onTick does not fire for a stale generation (stop() during an in-flight poll)', async () => {
    let resolveFetch: (v: unknown) => void = () => {}
    const fetchMock = vi.fn(() => new Promise((r) => (resolveFetch = r)))
    vi.stubGlobal('fetch', fetchMock)
    const ticks: number[] = []
    const watch = new WatchStatus(
      () => {},
      undefined,
      () => ticks.push(1)
    )
    watch.start()
    await vi.advanceTimersByTimeAsync(0) // fetch is now in flight
    watch.stop() // bumps generation while the fetch is still pending
    resolveFetch({ ok: true, json: async () => ({ items: [], watcher: 'none' }) })
    await vi.advanceTimersByTimeAsync(0)
    expect(ticks).toEqual([])
  })
})

describe('parseHarness', () => {
  it('accepts known harness ids (EMBEDDED_HARNESSES)', () => {
    expect(parseHarness('claude-code')).toBe('claude-code')
    expect(parseHarness('cursor')).toBe('cursor')
  })

  it('missing/garbage input -> undefined', () => {
    expect(parseHarness(undefined)).toBeUndefined()
    expect(parseHarness(null)).toBeUndefined()
    expect(parseHarness(123)).toBeUndefined()
    expect(parseHarness('')).toBeUndefined()
    expect(parseHarness('codex')).toBeUndefined() // AgentName, but not an EMBEDDED_HARNESSES member
    expect(parseHarness('nonsense')).toBeUndefined()
  })
})

describe('WatchStatus — harness field parsing (Task 5, C1)', () => {
  function stubStatusWithHarness(harness: unknown) {
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, json: async () => ({ items: [], watcher: 'none', harness }) })
    vi.stubGlobal('fetch', fetchMock)
    return fetchMock
  }

  it('harness undefined before the first poll answers', () => {
    const watch = new WatchStatus(() => {})
    expect(watch.harness()).toBeUndefined()
  })

  it('a recognized harness is parsed verbatim', async () => {
    stubStatusWithHarness('cursor')
    const watch = new WatchStatus(() => {})
    watch.start()
    await vi.advanceTimersByTimeAsync(0)
    expect(watch.harness()).toBe('cursor')
    watch.stop()
  })

  it('unknown-shape harness (absent field / garbage) is tolerated without crash — stays at the last known-good value', async () => {
    const fetchMock = stubStatusWithHarness('cursor')
    const watch = new WatchStatus(() => {})
    watch.start()
    await vi.advanceTimersByTimeAsync(0)
    expect(watch.harness()).toBe('cursor')

    fetchMock.mockResolvedValue({ ok: true, json: async () => ({ items: [], watcher: 'none', harness: 'nonsense' }) })
    await vi.advanceTimersByTimeAsync(WATCH_POLL_MS)
    expect(watch.harness()).toBe('cursor')
    watch.stop()
  })

  it('stop() resets harness to undefined', async () => {
    stubStatusWithHarness('cursor')
    const watch = new WatchStatus(() => {})
    watch.start()
    await vi.advanceTimersByTimeAsync(0)
    expect(watch.harness()).toBe('cursor')
    watch.stop()
    expect(watch.harness()).toBeUndefined()
  })
})
