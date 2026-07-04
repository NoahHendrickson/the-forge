// @vitest-environment jsdom
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { WatchStatus, WATCH_POLL_MS, sentLabelFor, watchIndicatorFor, queuedLineFor } from '../../src/client/watch'

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

  it('manual rung with no watcher keeps the pre-watch-mode copy verbatim', () => {
    expect(sentLabelFor('manual', 'claude-code')).toBe('Sent — type /forge-design in Claude Code')
    expect(sentLabelFor('manual', 'claude-code', 'none')).toBe('Sent — type /forge-design in Claude Code')
  })

  it('unrecognized rungs still default to the manual family (allowlist regression)', () => {
    expect(sentLabelFor('totally-new-rung' as never, 'claude-code')).toBe('Sent — type /forge-design in Claude Code')
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
    expect(queuedLineFor(1, 'Claude Code', 'none')).toBe('1 queued — type /forge-design in Claude Code')
  })
})

describe('watchIndicatorFor', () => {
  it('live: linked pill with the live accent', () => {
    expect(watchIndicatorFor('live', 'claude-code')).toEqual({ text: '● Linked to Claude Code', live: true })
  })

  it('asleep: the wake instruction, not live-accented', () => {
    expect(watchIndicatorFor('asleep', 'claude-code')).toEqual({
      text: 'Watcher asleep — type /forge-watch in Claude Code to wake it',
      live: false,
    })
  })

  it('none: renders nothing — terminal-only users see zero change', () => {
    expect(watchIndicatorFor('none', 'claude-code')).toBeUndefined()
  })
})
