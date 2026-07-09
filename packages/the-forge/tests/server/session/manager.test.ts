import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import {
  SessionManager,
  SessionState,
  FeedEvent,
  WATCHDOG_MS,
  RING_CAPACITY,
  PULL_TURN_TEXT,
  type SessionManagerOpts,
} from '../../../src/server/session/manager'
import type { SessionAdapter, SessionEvent } from '../../../src/server/session/adapter'

// ---------------------------------------------------------------------------
// Fake adapter — records calls, exposes emit(e) to simulate adapter events.
// ---------------------------------------------------------------------------

interface FakeAdapter extends SessionAdapter {
  startCalls: Array<{ cwd: string; resumeId?: string }>
  sendTurnCalls: string[]
  interruptCalls: number
  stopCalls: number
  emit(e: SessionEvent): void
}

function makeFakeAdapter(): FakeAdapter {
  const fa: FakeAdapter = {
    startCalls: [],
    sendTurnCalls: [],
    interruptCalls: 0,
    stopCalls: 0,
    onEvent: () => {},
    start(opts) {
      fa.startCalls.push({ cwd: opts.cwd, resumeId: opts.resumeId })
    },
    sendTurn(text) {
      fa.sendTurnCalls.push(text)
    },
    interrupt() {
      fa.interruptCalls++
    },
    stop() {
      fa.stopCalls++
    },
    emit(e) {
      fa.onEvent(e)
    },
  }
  return fa
}

// ---------------------------------------------------------------------------
// Build opts factory — injects fake adapter, temp forgeDir, fake clock.
// ---------------------------------------------------------------------------

function makeOpts(
  dir: string,
  adapter: FakeAdapter,
  overrides?: Partial<SessionManagerOpts>,
): SessionManagerOpts {
  let t = 0
  return {
    makeAdapter: () => adapter,
    forgeDir: dir,
    cwd: '/fake/cwd',
    now: () => t++,
    watchdogMs: 30,
    ...overrides,
  }
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

let dir: string

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-mgr-'))
  vi.useFakeTimers()
})

afterEach(() => {
  vi.useRealTimers()
})

describe('SessionManager', () => {
  describe('initial state', () => {
    it('starts idle', () => {
      const adapter = makeFakeAdapter()
      const mgr = new SessionManager(makeOpts(dir, adapter))
      expect(mgr.state()).toBe<SessionState>('idle')
    })

    it('does not spawn adapter until notifyDesignEdits()', () => {
      const adapter = makeFakeAdapter()
      new SessionManager(makeOpts(dir, adapter))
      expect(adapter.startCalls).toHaveLength(0)
    })
  })

  describe('notifyDesignEdits() — idle → starting → ready → busy', () => {
    it('transitions to starting and calls adapter.start with cwd', () => {
      const adapter = makeFakeAdapter()
      const mgr = new SessionManager(makeOpts(dir, adapter))

      mgr.notifyDesignEdits()

      expect(mgr.state()).toBe<SessionState>('starting')
      expect(adapter.startCalls).toHaveLength(1)
      expect(adapter.startCalls[0]!.cwd).toBe('/fake/cwd')
    })

    it('on started event → state ready, writes session.json, flushes nudge → busy', () => {
      const adapter = makeFakeAdapter()
      const mgr = new SessionManager(makeOpts(dir, adapter))

      mgr.notifyDesignEdits()
      adapter.emit({ kind: 'started', sessionId: 'sess-1', model: 'claude', mcpLoaded: true })

      expect(mgr.state()).toBe<SessionState>('busy')
      // nudge flushed: sendTurn called once with PULL_TURN_TEXT
      expect(adapter.sendTurnCalls).toHaveLength(1)
      expect(adapter.sendTurnCalls[0]).toBe(PULL_TURN_TEXT)
      // session.json written
      const json = JSON.parse(fs.readFileSync(path.join(dir, 'session.json'), 'utf8')) as unknown
      expect(json).toMatchObject({ sessionId: 'sess-1' })
      expect(typeof (json as Record<string, unknown>).updatedAt).toBe('string')
    })

    it('on turn-complete (no error) → state ready', () => {
      const adapter = makeFakeAdapter()
      const mgr = new SessionManager(makeOpts(dir, adapter))

      mgr.notifyDesignEdits()
      adapter.emit({ kind: 'started', sessionId: 'sess-1', model: 'claude', mcpLoaded: true })
      adapter.emit({ kind: 'turn-complete', isError: false, costUsd: 0.001 })

      expect(mgr.state()).toBe<SessionState>('ready')
    })
  })

  describe('session.json resume', () => {
    it('resumes with persisted sessionId on second start', () => {
      const adapter = makeFakeAdapter()
      const mgr = new SessionManager(makeOpts(dir, adapter))

      mgr.notifyDesignEdits()
      adapter.emit({ kind: 'started', sessionId: 'sess-abc', model: 'claude', mcpLoaded: true })
      adapter.emit({ kind: 'turn-complete', isError: false })
      adapter.emit({ kind: 'ended' }) // clean exit → idle

      // Second start should resume
      const adapter2 = makeFakeAdapter()
      const mgr2 = new SessionManager({ ...makeOpts(dir, adapter2), makeAdapter: () => adapter2 })
      mgr2.notifyDesignEdits()

      expect(adapter2.startCalls[0]!.resumeId).toBe('sess-abc')
    })

    it('starts fresh if session.json is corrupt (unknown/missing)', () => {
      fs.writeFileSync(path.join(dir, 'session.json'), 'NOT JSON {{{')
      const adapter = makeFakeAdapter()
      const mgr = new SessionManager(makeOpts(dir, adapter))

      mgr.notifyDesignEdits()

      expect(adapter.startCalls).toHaveLength(1)
      expect(adapter.startCalls[0]!.resumeId).toBeUndefined()
    })

    it('starts fresh if session.json is missing', () => {
      const adapter = makeFakeAdapter()
      const mgr = new SessionManager(makeOpts(dir, adapter))

      mgr.notifyDesignEdits()

      expect(adapter.startCalls[0]!.resumeId).toBeUndefined()
    })
  })

  describe('busy: single-slot pending nudge', () => {
    it('parks exactly one nudge when busy, flushed once on turn-complete', () => {
      const adapter = makeFakeAdapter()
      const mgr = new SessionManager(makeOpts(dir, adapter))

      mgr.notifyDesignEdits()
      adapter.emit({ kind: 'started', sessionId: 's1', model: 'claude', mcpLoaded: true })
      // state is now busy, sendTurnCalls has 1 (the flush)

      // Multiple notifyDesignEdits while busy → only one nudge parked
      mgr.notifyDesignEdits()
      mgr.notifyDesignEdits()
      mgr.notifyDesignEdits()

      // No additional sendTurn yet
      expect(adapter.sendTurnCalls).toHaveLength(1)

      // turn-complete → flush the single parked nudge
      adapter.emit({ kind: 'turn-complete', isError: false })

      expect(adapter.sendTurnCalls).toHaveLength(2)
      expect(adapter.sendTurnCalls[1]).toBe(PULL_TURN_TEXT)
      expect(mgr.state()).toBe<SessionState>('busy')
    })

    it('no nudge parked → ready on turn-complete', () => {
      const adapter = makeFakeAdapter()
      const mgr = new SessionManager(makeOpts(dir, adapter))

      mgr.notifyDesignEdits()
      adapter.emit({ kind: 'started', sessionId: 's1', model: 'claude', mcpLoaded: true })
      adapter.emit({ kind: 'turn-complete', isError: false })

      expect(mgr.state()).toBe<SessionState>('ready')
    })

    it('notifyDesignEdits while starting also parks nudge, flushed on started', () => {
      const adapter = makeFakeAdapter()
      const mgr = new SessionManager(makeOpts(dir, adapter))

      mgr.notifyDesignEdits() // first notify → starting
      // second notify while still starting
      mgr.notifyDesignEdits()
      // state: starting, nudge parked

      adapter.emit({ kind: 'started', sessionId: 's1', model: 'claude', mcpLoaded: true })
      // started event: flushes nudge, calls sendTurn ONCE (the first notify set the nudge, the second was deduplicated)
      expect(adapter.sendTurnCalls).toHaveLength(1)
      expect(mgr.state()).toBe<SessionState>('busy')
    })

    it('notifyDesignEdits while ready → sendTurn immediately', () => {
      const adapter = makeFakeAdapter()
      const mgr = new SessionManager(makeOpts(dir, adapter))

      mgr.notifyDesignEdits()
      adapter.emit({ kind: 'started', sessionId: 's1', model: 'claude', mcpLoaded: true })
      adapter.emit({ kind: 'turn-complete', isError: false })

      // now ready, call again
      mgr.notifyDesignEdits()

      expect(adapter.sendTurnCalls).toHaveLength(2)
      expect(mgr.state()).toBe<SessionState>('busy')
    })
  })

  describe('failed state', () => {
    it('turn-complete isError → failed', () => {
      const adapter = makeFakeAdapter()
      const mgr = new SessionManager(makeOpts(dir, adapter))

      mgr.notifyDesignEdits()
      adapter.emit({ kind: 'started', sessionId: 's1', model: 'claude', mcpLoaded: true })
      adapter.emit({ kind: 'turn-complete', isError: true, errorText: 'rate limit' })

      expect(mgr.state()).toBe<SessionState>('failed')
    })

    it('next notifyDesignEdits after failed → restarts (auto-start)', () => {
      const adapter = makeFakeAdapter()
      const mgr = new SessionManager(makeOpts(dir, adapter))

      mgr.notifyDesignEdits()
      adapter.emit({ kind: 'started', sessionId: 's1', model: 'claude', mcpLoaded: true })
      adapter.emit({ kind: 'turn-complete', isError: true, errorText: 'rate limit' })

      expect(mgr.state()).toBe<SessionState>('failed')
      mgr.notifyDesignEdits()

      // should restart
      expect(adapter.startCalls).toHaveLength(2)
      expect(mgr.state()).toBe<SessionState>('starting')
    })

    it('session-error while starting → failed, then notifyDesignEdits restarts', () => {
      const adapter = makeFakeAdapter()
      const mgr = new SessionManager(makeOpts(dir, adapter))

      mgr.notifyDesignEdits()
      // simulate spawn failure path: session-error then ended
      adapter.emit({ kind: 'session-error', text: 'ENOENT spawn failed' })
      adapter.emit({ kind: 'ended' })

      expect(mgr.state()).toBe<SessionState>('failed')
      mgr.notifyDesignEdits()
      expect(mgr.state()).toBe<SessionState>('starting')
    })
  })

  describe('clean ended while ready → idle', () => {
    it('ended while ready → idle without respawn', () => {
      const adapter = makeFakeAdapter()
      const mgr = new SessionManager(makeOpts(dir, adapter))

      mgr.notifyDesignEdits()
      adapter.emit({ kind: 'started', sessionId: 's1', model: 'claude', mcpLoaded: true })
      adapter.emit({ kind: 'turn-complete', isError: false })
      adapter.emit({ kind: 'ended' })

      expect(mgr.state()).toBe<SessionState>('idle')
      expect(adapter.startCalls).toHaveLength(1)
    })
  })

  describe('watchdog', () => {
    it('fires while busy and respawns with resumeId, re-sends PULL_TURN_TEXT', () => {
      const adapter = makeFakeAdapter()
      const mgr = new SessionManager(makeOpts(dir, adapter))

      mgr.notifyDesignEdits()
      adapter.emit({ kind: 'started', sessionId: 'sess-wdog', model: 'claude', mcpLoaded: true })
      // state: busy

      // Advance timer past watchdog (30ms in test opts)
      vi.advanceTimersByTime(35)

      // Should have killed and respawned
      expect(adapter.stopCalls).toBeGreaterThanOrEqual(1)
      expect(adapter.startCalls).toHaveLength(2)
      expect(adapter.startCalls[1]!.resumeId).toBe('sess-wdog')
      expect(mgr.state()).toBe<SessionState>('starting')

      // Complete the respawn
      adapter.emit({ kind: 'started', sessionId: 'sess-wdog-2', model: 'claude', mcpLoaded: true })
      expect(adapter.sendTurnCalls).toHaveLength(2) // initial + recovery
      expect(adapter.sendTurnCalls[1]).toBe(PULL_TURN_TEXT)
    })

    it('emits recovery session-error feed row on watchdog fire', () => {
      const adapter = makeFakeAdapter()
      const mgr = new SessionManager(makeOpts(dir, adapter))
      const events: FeedEvent[] = []
      mgr.subscribe((e) => events.push(e))

      mgr.notifyDesignEdits()
      adapter.emit({ kind: 'started', sessionId: 'sess-wdog', model: 'claude', mcpLoaded: true })

      vi.advanceTimersByTime(35)

      const errorRow = events.find(
        (fe) => fe.event.kind === 'session-error' && fe.event.text === 'session recovered after stall',
      )
      expect(errorRow).toBeDefined()
    })

    it('adapter events re-arm the watchdog (no expiry if events keep arriving)', () => {
      const adapter = makeFakeAdapter()
      const mgr = new SessionManager(makeOpts(dir, adapter))

      mgr.notifyDesignEdits()
      adapter.emit({ kind: 'started', sessionId: 's1', model: 'claude', mcpLoaded: true })

      // Advance 25ms (just under 30ms watchdog), emit an event, advance another 25ms
      vi.advanceTimersByTime(25)
      adapter.emit({ kind: 'assistant-text', text: 'working...' })
      vi.advanceTimersByTime(25)

      // Should NOT have respawned — event re-armed the watchdog
      expect(adapter.startCalls).toHaveLength(1)

      // Now advance past watchdog without events
      vi.advanceTimersByTime(35)
      expect(adapter.startCalls).toHaveLength(2) // now respawned
    })

    it('watchdog does not fire when not busy (ready state)', () => {
      const adapter = makeFakeAdapter()
      const mgr = new SessionManager(makeOpts(dir, adapter))

      mgr.notifyDesignEdits()
      adapter.emit({ kind: 'started', sessionId: 's1', model: 'claude', mcpLoaded: true })
      adapter.emit({ kind: 'turn-complete', isError: false }) // → ready
      vi.advanceTimersByTime(100)

      expect(adapter.startCalls).toHaveLength(1)
    })

    it('ended while busy → same respawn path as watchdog', () => {
      const adapter = makeFakeAdapter()
      const mgr = new SessionManager(makeOpts(dir, adapter))

      mgr.notifyDesignEdits()
      adapter.emit({ kind: 'started', sessionId: 'sess-ended', model: 'claude', mcpLoaded: true })
      // busy now, simulate unexpected exit
      adapter.emit({ kind: 'ended' })

      expect(adapter.startCalls).toHaveLength(2)
      expect(adapter.startCalls[1]!.resumeId).toBe('sess-ended')
    })

    it('ended while starting → same respawn path as busy (brief: "Same path for ended while busy/starting")', () => {
      const adapter = makeFakeAdapter()
      const mgr = new SessionManager(makeOpts(dir, adapter))

      mgr.notifyDesignEdits()
      adapter.emit({ kind: 'ended' }) // ended before started

      // Brief: same respawn path as ended-while-busy → respawns immediately
      expect(adapter.startCalls).toHaveLength(2)
      expect(mgr.state()).toBe<SessionState>('starting')
    })
  })

  describe('ring buffer and event streaming', () => {
    it('seq starts at 1 and increments monotonically', () => {
      const adapter = makeFakeAdapter()
      const mgr = new SessionManager(makeOpts(dir, adapter))
      const events: FeedEvent[] = []
      mgr.subscribe((e) => events.push(e))

      mgr.notifyDesignEdits()
      adapter.emit({ kind: 'started', sessionId: 's1', model: 'claude', mcpLoaded: true })
      adapter.emit({ kind: 'assistant-text', text: 'hello' })
      adapter.emit({ kind: 'turn-complete', isError: false })

      expect(events[0]!.seq).toBe(1)
      expect(events[1]!.seq).toBe(2)
      expect(events[2]!.seq).toBe(3)
    })

    it('eventsSince(seq) returns events strictly after that seq', () => {
      const adapter = makeFakeAdapter()
      const mgr = new SessionManager(makeOpts(dir, adapter))

      mgr.notifyDesignEdits()
      adapter.emit({ kind: 'started', sessionId: 's1', model: 'claude', mcpLoaded: true })
      adapter.emit({ kind: 'assistant-text', text: 'a' })
      adapter.emit({ kind: 'turn-complete', isError: false })

      const all = mgr.eventsSince(0)
      expect(all).toHaveLength(3)

      const tail = mgr.eventsSince(2)
      expect(tail).toHaveLength(1)
      expect(tail[0]!.seq).toBe(3)
    })

    it('eventsSince returns [] when seq is at or beyond last event', () => {
      const adapter = makeFakeAdapter()
      const mgr = new SessionManager(makeOpts(dir, adapter))

      mgr.notifyDesignEdits()
      adapter.emit({ kind: 'started', sessionId: 's1', model: 'claude', mcpLoaded: true })

      const none = mgr.eventsSince(1)
      expect(none).toHaveLength(0)
    })

    it('ring buffer caps at RING_CAPACITY, tail is preserved', () => {
      const adapter = makeFakeAdapter()
      const mgr = new SessionManager(makeOpts(dir, adapter))

      mgr.notifyDesignEdits()
      adapter.emit({ kind: 'started', sessionId: 's1', model: 'claude', mcpLoaded: true })

      // Emit RING_CAPACITY + 10 additional events beyond started
      for (let i = 0; i < RING_CAPACITY + 10; i++) {
        adapter.emit({ kind: 'assistant-text', text: `msg-${i}` })
      }

      const all = mgr.eventsSince(0)
      expect(all).toHaveLength(RING_CAPACITY)
      // The oldest event has been evicted; the tail is the last RING_CAPACITY events
      const lastSeq = all[all.length - 1]!.seq
      const firstSeq = all[0]!.seq
      expect(lastSeq - firstSeq).toBe(RING_CAPACITY - 1)
    })

    it('subscribe fans out to multiple subscribers', () => {
      const adapter = makeFakeAdapter()
      const mgr = new SessionManager(makeOpts(dir, adapter))
      const a: FeedEvent[] = []
      const b: FeedEvent[] = []

      mgr.subscribe((e) => a.push(e))
      mgr.subscribe((e) => b.push(e))

      mgr.notifyDesignEdits()
      adapter.emit({ kind: 'started', sessionId: 's1', model: 'claude', mcpLoaded: true })

      expect(a).toHaveLength(1)
      expect(b).toHaveLength(1)
    })

    it('unsubscribe removes subscriber', () => {
      const adapter = makeFakeAdapter()
      const mgr = new SessionManager(makeOpts(dir, adapter))
      const events: FeedEvent[] = []
      const unsub = mgr.subscribe((e) => events.push(e))

      mgr.notifyDesignEdits()
      adapter.emit({ kind: 'started', sessionId: 's1', model: 'claude', mcpLoaded: true })
      expect(events).toHaveLength(1)

      unsub()
      adapter.emit({ kind: 'assistant-text', text: 'after unsub' })
      expect(events).toHaveLength(1) // no new events after unsub
    })

    it('subscribe receives only events emitted after subscription (no replay)', () => {
      const adapter = makeFakeAdapter()
      const mgr = new SessionManager(makeOpts(dir, adapter))

      mgr.notifyDesignEdits()
      adapter.emit({ kind: 'started', sessionId: 's1', model: 'claude', mcpLoaded: true })
      // subscribe AFTER the started event
      const events: FeedEvent[] = []
      mgr.subscribe((e) => events.push(e))

      adapter.emit({ kind: 'assistant-text', text: 'post-sub' })
      expect(events).toHaveLength(1)
      expect(events[0]!.event).toMatchObject({ kind: 'assistant-text', text: 'post-sub' })
    })

    it('at includes an ISO timestamp string', () => {
      const adapter = makeFakeAdapter()
      const mgr = new SessionManager(makeOpts(dir, adapter))
      const events: FeedEvent[] = []
      mgr.subscribe((e) => events.push(e))

      mgr.notifyDesignEdits()
      adapter.emit({ kind: 'started', sessionId: 's1', model: 'claude', mcpLoaded: true })

      expect(events[0]!.at).toMatch(/^\d{4}-\d{2}-\d{2}T/)
    })
  })

  describe('stop()', () => {
    it('kills adapter and transitions to idle', () => {
      const adapter = makeFakeAdapter()
      const mgr = new SessionManager(makeOpts(dir, adapter))

      mgr.notifyDesignEdits()
      adapter.emit({ kind: 'started', sessionId: 's1', model: 'claude', mcpLoaded: true })

      mgr.stop()

      expect(adapter.stopCalls).toBeGreaterThanOrEqual(1)
      expect(mgr.state()).toBe<SessionState>('idle')
    })

    it('clears parked nudge on stop()', () => {
      const adapter = makeFakeAdapter()
      const mgr = new SessionManager(makeOpts(dir, adapter))

      mgr.notifyDesignEdits()
      adapter.emit({ kind: 'started', sessionId: 's1', model: 'claude', mcpLoaded: true })
      // park a nudge
      mgr.notifyDesignEdits()

      mgr.stop()

      // After stop, a started event (from a stale adapter) should not flush the nudge
      adapter.emit({ kind: 'started', sessionId: 's2', model: 'claude', mcpLoaded: true })
      // Only the initial sendTurn (1), no second flush
      expect(adapter.sendTurnCalls).toHaveLength(1)
    })

    it('stop() is safe when idle (no-op)', () => {
      const adapter = makeFakeAdapter()
      const mgr = new SessionManager(makeOpts(dir, adapter))

      expect(() => mgr.stop()).not.toThrow()
    })

    it('stop() does not delete session.json', () => {
      const adapter = makeFakeAdapter()
      const mgr = new SessionManager(makeOpts(dir, adapter))

      mgr.notifyDesignEdits()
      adapter.emit({ kind: 'started', sessionId: 's1', model: 'claude', mcpLoaded: true })

      mgr.stop()

      expect(fs.existsSync(path.join(dir, 'session.json'))).toBe(true)
    })
  })

  describe('interrupt()', () => {
    it('delegates to adapter.interrupt when busy', () => {
      const adapter = makeFakeAdapter()
      const mgr = new SessionManager(makeOpts(dir, adapter))

      mgr.notifyDesignEdits()
      adapter.emit({ kind: 'started', sessionId: 's1', model: 'claude', mcpLoaded: true })

      mgr.interrupt()

      expect(adapter.interruptCalls).toBe(1)
    })

    it('interrupt is no-op when idle', () => {
      const adapter = makeFakeAdapter()
      const mgr = new SessionManager(makeOpts(dir, adapter))

      expect(() => mgr.interrupt()).not.toThrow()
      expect(adapter.interruptCalls).toBe(0)
    })
  })

  describe('constants', () => {
    it('WATCHDOG_MS is 120_000', () => {
      expect(WATCHDOG_MS).toBe(120_000)
    })

    it('RING_CAPACITY is 200', () => {
      expect(RING_CAPACITY).toBe(200)
    })

    it('PULL_TURN_TEXT contains required keywords and is a constant (no interpolation)', () => {
      // Verify the text contains the key instruction phrases
      expect(PULL_TURN_TEXT).toContain('pull_design_edits')
      expect(PULL_TURN_TEXT).toContain('mark_applied')
      expect(PULL_TURN_TEXT).toContain('the-forge')
      // It must not contain any template literal markers
      expect(PULL_TURN_TEXT).not.toContain('${')
    })
  })

  describe('forgeDir creation', () => {
    it('creates forgeDir if it does not exist before writing session.json', () => {
      const nonExistentDir = path.join(dir, 'nested', 'forge')
      const adapter = makeFakeAdapter()
      const mgr = new SessionManager(makeOpts(nonExistentDir, adapter))

      mgr.notifyDesignEdits()
      adapter.emit({ kind: 'started', sessionId: 's1', model: 'claude', mcpLoaded: true })

      expect(fs.existsSync(path.join(nonExistentDir, 'session.json'))).toBe(true)
    })
  })
})
