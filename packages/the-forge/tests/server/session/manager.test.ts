import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import {
  SessionManager,
  SessionState,
  FeedEvent,
  WATCHDOG_MS,
  POST_APPROVAL_WATCHDOG_MS,
  MAX_START_FAILURES,
  RING_CAPACITY,
  PULL_TURN_TEXT,
  type SessionManagerOpts,
} from '../../../src/server/session/manager'
import type { SessionAdapter, SessionEvent } from '../../../src/server/session/adapter'

// ---------------------------------------------------------------------------
// Fake adapter — records calls, exposes emit(e) to simulate adapter events.
// makeAdapter() returns a FRESH instance per call (mirroring production, where
// every respawn spawns a new child) — a shared instance would let a stale
// onEvent closure on the "old" adapter silently alias the new one and mask
// double-respawn bugs.
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
// Harness — fresh adapter per makeAdapter() call; `adapters` addresses
// instance #1 vs #2 across respawns.
// ---------------------------------------------------------------------------

function makeHarness(
  dirArg: string,
  overrides?: Partial<SessionManagerOpts>,
): { adapters: FakeAdapter[]; opts: SessionManagerOpts } {
  const adapters: FakeAdapter[] = []
  let t = 0
  const opts: SessionManagerOpts = {
    makeAdapter: () => {
      const a = makeFakeAdapter()
      adapters.push(a)
      return a
    },
    forgeDir: dirArg,
    cwd: '/fake/cwd',
    now: () => t++,
    watchdogMs: 30,
    ...overrides,
  }
  return { adapters, opts }
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
      const { opts } = makeHarness(dir)
      const mgr = new SessionManager(opts)
      expect(mgr.state()).toBe<SessionState>('idle')
    })

    it('does not spawn adapter until notifyDesignEdits()', () => {
      const { adapters, opts } = makeHarness(dir)
      new SessionManager(opts)
      expect(adapters).toHaveLength(0)
    })
  })

  describe('notifyDesignEdits() — spawn + send-immediately (CLI boots lazily)', () => {
    it('spawns the adapter AND writes the pull turn immediately — never waits for started', () => {
      // Verified live (CLI 2.1.201): `claude -p --input-format stream-json` emits NOTHING —
      // not even init — until the first stdin line arrives. Waiting for `started` before
      // sendTurn deadlocks: the manager waits for init, the CLI waits for input. The CLI
      // buffers stdin during boot, so writing the turn first is safe and breaks the cycle.
      const { adapters, opts } = makeHarness(dir)
      const mgr = new SessionManager(opts)

      mgr.notifyDesignEdits()

      expect(mgr.state()).toBe<SessionState>('busy')
      expect(adapters).toHaveLength(1)
      expect(adapters[0]!.startCalls).toHaveLength(1)
      expect(adapters[0]!.startCalls[0]!.cwd).toBe('/fake/cwd')
      expect(adapters[0]!.sendTurnCalls).toEqual([PULL_TURN_TEXT])
    })

    it('started mid-turn is bookkeeping only: writes session.json, no state change, no second send', () => {
      const { adapters, opts } = makeHarness(dir)
      const mgr = new SessionManager(opts)

      mgr.notifyDesignEdits()
      adapters[0]!.emit({ kind: 'started', sessionId: 'sess-1', model: 'claude', mcpLoaded: true })

      expect(mgr.state()).toBe<SessionState>('busy')
      // the pull turn was already written at spawn; started must not re-send or flush anything
      expect(adapters[0]!.sendTurnCalls).toHaveLength(1)
      expect(adapters[0]!.sendTurnCalls[0]).toBe(PULL_TURN_TEXT)
      // session.json written
      const json = JSON.parse(fs.readFileSync(path.join(dir, 'session.json'), 'utf8')) as unknown
      expect(json).toMatchObject({ sessionId: 'sess-1' })
      expect(typeof (json as Record<string, unknown>).updatedAt).toBe('string')
    })

    it('session.json updatedAt comes from the injectable clock', () => {
      // Harness clock starts at 0 and ticks by 1 per call — real Date.now would
      // produce a 2026 timestamp, the injected clock the 1970 epoch.
      const { adapters, opts } = makeHarness(dir)
      const mgr = new SessionManager(opts)

      mgr.notifyDesignEdits()
      adapters[0]!.emit({ kind: 'started', sessionId: 'sess-1', model: 'claude', mcpLoaded: true })

      const json = JSON.parse(fs.readFileSync(path.join(dir, 'session.json'), 'utf8')) as {
        updatedAt: string
      }
      expect(json.updatedAt).toMatch(/^1970-01-01T/)
    })

    it('on turn-complete (no error) → state ready', () => {
      const { adapters, opts } = makeHarness(dir)
      const mgr = new SessionManager(opts)

      mgr.notifyDesignEdits()
      adapters[0]!.emit({ kind: 'started', sessionId: 'sess-1', model: 'claude', mcpLoaded: true })
      adapters[0]!.emit({ kind: 'turn-complete', isError: false, costUsd: 0.001 })

      expect(mgr.state()).toBe<SessionState>('ready')
    })
  })

  describe('session.json resume', () => {
    it('resumes with the persisted session id on later starts', () => {
      const { adapters, opts } = makeHarness(dir)
      const mgr = new SessionManager(opts)

      mgr.notifyDesignEdits()
      adapters[0]!.emit({ kind: 'started', sessionId: 'sess-abc', model: 'claude', mcpLoaded: true })
      adapters[0]!.emit({ kind: 'turn-complete', isError: false })
      adapters[0]!.emit({ kind: 'ended' }) // clean exit → idle

      // Second start (fresh manager, same forgeDir) should resume
      const second = makeHarness(dir)
      const mgr2 = new SessionManager(second.opts)
      mgr2.notifyDesignEdits()

      expect(second.adapters[0]!.startCalls[0]!.resumeId).toBe('sess-abc')
      void mgr
    })

    it('starts fresh if session.json is corrupt (unknown/missing)', () => {
      fs.writeFileSync(path.join(dir, 'session.json'), 'NOT JSON {{{')
      const { adapters, opts } = makeHarness(dir)
      const mgr = new SessionManager(opts)

      mgr.notifyDesignEdits()

      expect(adapters[0]!.startCalls).toHaveLength(1)
      expect(adapters[0]!.startCalls[0]!.resumeId).toBeUndefined()
    })

    it('starts fresh if session.json is missing', () => {
      const { adapters, opts } = makeHarness(dir)
      const mgr = new SessionManager(opts)

      mgr.notifyDesignEdits()

      expect(adapters[0]!.startCalls[0]!.resumeId).toBeUndefined()
    })
  })

  describe('busy: single-slot pending nudge', () => {
    it('parks exactly one nudge when busy, flushed once on turn-complete', () => {
      const { adapters, opts } = makeHarness(dir)
      const mgr = new SessionManager(opts)

      mgr.notifyDesignEdits()
      adapters[0]!.emit({ kind: 'started', sessionId: 's1', model: 'claude', mcpLoaded: true })
      // state is now busy, sendTurnCalls has 1 (the flush)

      // Multiple notifyDesignEdits while busy → only one nudge parked
      mgr.notifyDesignEdits()
      mgr.notifyDesignEdits()
      mgr.notifyDesignEdits()

      // No additional sendTurn yet
      expect(adapters[0]!.sendTurnCalls).toHaveLength(1)

      // turn-complete → flush the single parked nudge
      adapters[0]!.emit({ kind: 'turn-complete', isError: false })

      expect(adapters[0]!.sendTurnCalls).toHaveLength(2)
      expect(adapters[0]!.sendTurnCalls[1]).toBe(PULL_TURN_TEXT)
      expect(mgr.state()).toBe<SessionState>('busy')
    })

    it('no nudge parked → ready on turn-complete', () => {
      const { adapters, opts } = makeHarness(dir)
      const mgr = new SessionManager(opts)

      mgr.notifyDesignEdits()
      adapters[0]!.emit({ kind: 'started', sessionId: 's1', model: 'claude', mcpLoaded: true })
      adapters[0]!.emit({ kind: 'turn-complete', isError: false })

      expect(mgr.state()).toBe<SessionState>('ready')
    })

    it('notifyDesignEdits during boot (busy, pre-started) parks one nudge, flushed on turn-complete', () => {
      const { adapters, opts } = makeHarness(dir)
      const mgr = new SessionManager(opts)

      mgr.notifyDesignEdits() // spawn + immediate pull turn → busy
      // second notify while the child is still booting (no started yet)
      mgr.notifyDesignEdits()

      adapters[0]!.emit({ kind: 'started', sessionId: 's1', model: 'claude', mcpLoaded: true })
      // started must not flush the parked nudge mid-turn
      expect(adapters[0]!.sendTurnCalls).toHaveLength(1)

      adapters[0]!.emit({ kind: 'turn-complete', isError: false })
      expect(adapters[0]!.sendTurnCalls).toHaveLength(2)
      expect(mgr.state()).toBe<SessionState>('busy')
    })

    it('nudge survives an adapter that emits started synchronously inside start()', () => {
      // The nudge must be parked BEFORE _start() runs — an adapter that resolves
      // synchronously (started emitted inside start()) would otherwise flush nothing
      // and the parked-after nudge would sit forever.
      const adapters: FakeAdapter[] = []
      const { opts } = makeHarness(dir, {
        makeAdapter: () => {
          const a = makeFakeAdapter()
          const origStart = a.start.bind(a)
          a.start = (o) => {
            origStart(o)
            a.emit({ kind: 'started', sessionId: 'sync-1', model: 'claude', mcpLoaded: true })
          }
          adapters.push(a)
          return a
        },
      })
      const mgr = new SessionManager(opts)

      mgr.notifyDesignEdits()

      expect(adapters[0]!.sendTurnCalls).toHaveLength(1)
      expect(adapters[0]!.sendTurnCalls[0]).toBe(PULL_TURN_TEXT)
      expect(mgr.state()).toBe<SessionState>('busy')
    })

    it('notifyDesignEdits while ready → sendTurn immediately', () => {
      const { adapters, opts } = makeHarness(dir)
      const mgr = new SessionManager(opts)

      mgr.notifyDesignEdits()
      adapters[0]!.emit({ kind: 'started', sessionId: 's1', model: 'claude', mcpLoaded: true })
      adapters[0]!.emit({ kind: 'turn-complete', isError: false })

      // now ready, call again
      mgr.notifyDesignEdits()

      expect(adapters[0]!.sendTurnCalls).toHaveLength(2)
      expect(mgr.state()).toBe<SessionState>('busy')
    })
  })

  describe('failed state', () => {
    it('turn-complete isError → failed', () => {
      const { adapters, opts } = makeHarness(dir)
      const mgr = new SessionManager(opts)

      mgr.notifyDesignEdits()
      adapters[0]!.emit({ kind: 'started', sessionId: 's1', model: 'claude', mcpLoaded: true })
      adapters[0]!.emit({ kind: 'turn-complete', isError: true, errorText: 'rate limit' })

      expect(mgr.state()).toBe<SessionState>('failed')
    })

    it('next notifyDesignEdits after failed → restarts (auto-start)', () => {
      const { adapters, opts } = makeHarness(dir)
      const mgr = new SessionManager(opts)

      mgr.notifyDesignEdits()
      adapters[0]!.emit({ kind: 'started', sessionId: 's1', model: 'claude', mcpLoaded: true })
      adapters[0]!.emit({ kind: 'turn-complete', isError: true, errorText: 'rate limit' })

      expect(mgr.state()).toBe<SessionState>('failed')
      mgr.notifyDesignEdits()

      // should restart with a fresh adapter
      expect(adapters).toHaveLength(2)
      expect(adapters[1]!.startCalls).toHaveLength(1)
      expect(mgr.state()).toBe<SessionState>('busy')
    })

    it('session-error while starting → failed, then notifyDesignEdits restarts', () => {
      const { adapters, opts } = makeHarness(dir)
      const mgr = new SessionManager(opts)

      mgr.notifyDesignEdits()
      // simulate spawn failure path: session-error then ended
      adapters[0]!.emit({ kind: 'session-error', text: 'ENOENT spawn failed' })
      adapters[0]!.emit({ kind: 'ended' })

      expect(mgr.state()).toBe<SessionState>('failed')
      mgr.notifyDesignEdits()
      expect(mgr.state()).toBe<SessionState>('busy')
      expect(adapters).toHaveLength(2)
    })

    it('restart after failed stops the previous adapter (no orphaned child)', () => {
      // An in-band error turn (rate limit, auth) leaves the child ALIVE — exit code 0
      // only comes if/when it exits on its own. The restart must kill it, or every
      // failed→restart cycle leaks a live `claude` process.
      const { adapters, opts } = makeHarness(dir)
      const mgr = new SessionManager(opts)

      mgr.notifyDesignEdits()
      adapters[0]!.emit({ kind: 'started', sessionId: 's1', model: 'claude', mcpLoaded: true })
      adapters[0]!.emit({ kind: 'turn-complete', isError: true, errorText: 'rate limit' })

      mgr.notifyDesignEdits()
      expect(adapters[0]!.stopCalls).toBe(1)
    })

    it('late ended from the pre-failure adapter cannot disturb the restarted session', () => {
      // Without detaching on restart, the abandoned child's eventual `ended` would reach
      // the manager, discard the NEW adapter, and (state=starting) trigger a second
      // respawn — the same stale-event race the watchdog path already defends against.
      const { adapters, opts } = makeHarness(dir)
      const mgr = new SessionManager(opts)

      mgr.notifyDesignEdits()
      adapters[0]!.emit({ kind: 'started', sessionId: 's1', model: 'claude', mcpLoaded: true })
      adapters[0]!.emit({ kind: 'turn-complete', isError: true, errorText: 'rate limit' })
      mgr.notifyDesignEdits()
      expect(adapters).toHaveLength(2)

      // The abandoned child exits later — must be a no-op for the new session.
      adapters[0]!.emit({ kind: 'ended' })
      expect(adapters).toHaveLength(2)
      expect(mgr.state()).toBe<SessionState>('busy')

      // The new adapter is still wired: started flushes the parked nudge.
      adapters[1]!.emit({ kind: 'started', sessionId: 's2', model: 'claude', mcpLoaded: true })
      expect(adapters[1]!.sendTurnCalls).toEqual([PULL_TURN_TEXT])
      expect(mgr.state()).toBe<SessionState>('busy')
    })
  })

  describe('stale resume id recovery', () => {
    // Observed live (CLI 2.1.201): `--resume <unknown-id>` emits `result` with
    // subtype error_during_execution / is_error:true BEFORE any init event, exit 0.
    // session.json goes stale legitimately — CLI session store pruned, project moved.

    it('resume failure (error turn before started) clears session.json and retries fresh once', () => {
      fs.writeFileSync(
        path.join(dir, 'session.json'),
        JSON.stringify({ sessionId: 'stale-id', updatedAt: 'x' }),
      )
      const { adapters, opts } = makeHarness(dir)
      const mgr = new SessionManager(opts)

      mgr.notifyDesignEdits()
      expect(adapters[0]!.startCalls[0]!.resumeId).toBe('stale-id')
      // CLI rejects the resume id in-band, before ever emitting init/started.
      adapters[0]!.emit({ kind: 'turn-complete', isError: true, errorText: 'not a UUID' })

      // Dead resume child is stopped; a fresh (no-resume) start is underway.
      expect(adapters[0]!.stopCalls).toBe(1)
      expect(adapters).toHaveLength(2)
      expect(adapters[1]!.startCalls[0]!.resumeId).toBeUndefined()
      expect(mgr.state()).toBe<SessionState>('busy')
      expect(fs.existsSync(path.join(dir, 'session.json'))).toBe(false)

      // The parked pull still flushes on the fresh session's started.
      adapters[1]!.emit({ kind: 'started', sessionId: 'fresh-1', model: 'claude', mcpLoaded: true })
      expect(adapters[1]!.sendTurnCalls).toEqual([PULL_TURN_TEXT])
      expect(mgr.state()).toBe<SessionState>('busy')
    })

    it('fresh-start error turn before started → failed, no retry loop', () => {
      const { adapters, opts } = makeHarness(dir) // no session.json → fresh start
      const mgr = new SessionManager(opts)

      mgr.notifyDesignEdits()
      expect(adapters[0]!.startCalls[0]!.resumeId).toBeUndefined()
      adapters[0]!.emit({ kind: 'turn-complete', isError: true, errorText: 'not logged in' })

      expect(mgr.state()).toBe<SessionState>('failed')
      expect(adapters).toHaveLength(1) // fresh start failing again would loop — never retry
    })
  })

  describe('start-crash respawn cap', () => {
    it('repeated ended-before-started gives up after MAX_START_FAILURES with a feed row', () => {
      // A child that keeps dying pre-init (broken install, corrupted state) must not
      // respawn forever — ended-while-starting is otherwise an unbounded recovery loop.
      const { adapters, opts } = makeHarness(dir)
      const mgr = new SessionManager(opts)
      const events: FeedEvent[] = []
      mgr.subscribe((e) => events.push(e))

      mgr.notifyDesignEdits()
      for (let i = 0; i < MAX_START_FAILURES; i++) {
        adapters[adapters.length - 1]!.emit({ kind: 'ended' })
      }

      expect(adapters).toHaveLength(MAX_START_FAILURES) // no further respawn after the cap
      expect(mgr.state()).toBe<SessionState>('failed')
      const gaveUp = events.find(
        (fe) => fe.event.kind === 'session-error' && fe.event.text.includes('failed to start'),
      )
      expect(gaveUp).toBeDefined()
    })

    it('a successful started resets the failure count', () => {
      const { adapters, opts } = makeHarness(dir)
      const mgr = new SessionManager(opts)

      mgr.notifyDesignEdits()
      adapters[0]!.emit({ kind: 'ended' }) // one start crash → respawn
      expect(adapters).toHaveLength(2)
      adapters[1]!.emit({ kind: 'started', sessionId: 's1', model: 'claude', mcpLoaded: true })
      adapters[1]!.emit({ kind: 'turn-complete', isError: false })

      // Later crash-recovery cycles get the full budget again.
      adapters[1]!.emit({ kind: 'ended' }) // clean ended while ready → idle, no respawn
      mgr.notifyDesignEdits()
      for (let i = 0; i < MAX_START_FAILURES - 1; i++) {
        adapters[adapters.length - 1]!.emit({ kind: 'ended' })
      }
      // budget not exhausted (count reset earlier) → still respawning, not failed
      expect(mgr.state()).toBe<SessionState>('busy')
    })
  })

  describe('clean ended while ready → idle', () => {
    it('ended while ready → idle without respawn', () => {
      const { adapters, opts } = makeHarness(dir)
      const mgr = new SessionManager(opts)

      mgr.notifyDesignEdits()
      adapters[0]!.emit({ kind: 'started', sessionId: 's1', model: 'claude', mcpLoaded: true })
      adapters[0]!.emit({ kind: 'turn-complete', isError: false })
      adapters[0]!.emit({ kind: 'ended' })

      expect(mgr.state()).toBe<SessionState>('idle')
      expect(adapters).toHaveLength(1)
    })
  })

  describe('watchdog', () => {
    it('fires while busy and respawns with resumeId, re-sends PULL_TURN_TEXT', () => {
      const { adapters, opts } = makeHarness(dir)
      const mgr = new SessionManager(opts)

      mgr.notifyDesignEdits()
      adapters[0]!.emit({ kind: 'started', sessionId: 'sess-wdog', model: 'claude', mcpLoaded: true })
      // state: busy

      // Advance timer past watchdog (30ms in test opts)
      vi.advanceTimersByTime(35)

      // Should have killed adapter #1 and respawned adapter #2
      expect(adapters[0]!.stopCalls).toBeGreaterThanOrEqual(1)
      expect(adapters).toHaveLength(2)
      expect(adapters[1]!.startCalls[0]!.resumeId).toBe('sess-wdog')
      expect(mgr.state()).toBe<SessionState>('busy')

      // Complete the respawn
      adapters[1]!.emit({ kind: 'started', sessionId: 'sess-wdog-2', model: 'claude', mcpLoaded: true })
      expect(adapters[0]!.sendTurnCalls).toHaveLength(1) // the original pull
      expect(adapters[1]!.sendTurnCalls).toHaveLength(1) // the recovery pull
      expect(adapters[1]!.sendTurnCalls[0]).toBe(PULL_TURN_TEXT)
    })

    it('emits recovery session-error feed row on watchdog fire', () => {
      const { adapters, opts } = makeHarness(dir)
      const mgr = new SessionManager(opts)
      const events: FeedEvent[] = []
      mgr.subscribe((e) => events.push(e))

      mgr.notifyDesignEdits()
      adapters[0]!.emit({ kind: 'started', sessionId: 'sess-wdog', model: 'claude', mcpLoaded: true })

      vi.advanceTimersByTime(35)

      const errorRow = events.find(
        (fe) => fe.event.kind === 'session-error' && fe.event.text === 'session recovered after stall',
      )
      expect(errorRow).toBeDefined()
    })

    it('adapter events re-arm the watchdog (no expiry if events keep arriving)', () => {
      const { adapters, opts } = makeHarness(dir)
      const mgr = new SessionManager(opts)

      mgr.notifyDesignEdits()
      adapters[0]!.emit({ kind: 'started', sessionId: 's1', model: 'claude', mcpLoaded: true })

      // Advance 25ms (just under 30ms watchdog), emit an event, advance another 25ms
      vi.advanceTimersByTime(25)
      adapters[0]!.emit({ kind: 'assistant-text', text: 'working...' })
      vi.advanceTimersByTime(25)

      // Should NOT have respawned — event re-armed the watchdog
      expect(adapters).toHaveLength(1)

      // Now advance past watchdog without events (32ms: enough for exactly ONE expiry —
      // the respawn re-arms immediately since it also re-sends immediately, so a longer
      // advance would count a second, unrelated expiry)
      vi.advanceTimersByTime(32)
      expect(adapters).toHaveLength(2) // now respawned
    })

    it('watchdog does not fire when not busy (ready state)', () => {
      const { adapters, opts } = makeHarness(dir)
      const mgr = new SessionManager(opts)

      mgr.notifyDesignEdits()
      adapters[0]!.emit({ kind: 'started', sessionId: 's1', model: 'claude', mcpLoaded: true })
      adapters[0]!.emit({ kind: 'turn-complete', isError: false }) // → ready
      vi.advanceTimersByTime(100)

      expect(adapters).toHaveLength(1)
    })

    it('ended while busy → same respawn path as watchdog', () => {
      const { adapters, opts } = makeHarness(dir)
      const mgr = new SessionManager(opts)

      mgr.notifyDesignEdits()
      adapters[0]!.emit({ kind: 'started', sessionId: 'sess-ended', model: 'claude', mcpLoaded: true })
      // busy now, simulate unexpected exit
      adapters[0]!.emit({ kind: 'ended' })

      expect(adapters).toHaveLength(2)
      expect(adapters[1]!.startCalls[0]!.resumeId).toBe('sess-ended')
    })

    it('ended while starting → same respawn path as busy (brief: "Same path for ended while busy/starting")', () => {
      const { adapters, opts } = makeHarness(dir)
      const mgr = new SessionManager(opts)

      mgr.notifyDesignEdits()
      adapters[0]!.emit({ kind: 'ended' }) // ended before started

      // Brief: same respawn path as ended-while-busy → respawns immediately
      expect(adapters).toHaveLength(2)
      expect(mgr.state()).toBe<SessionState>('busy')
    })

    it('late ended from the discarded adapter after watchdog fire does NOT trigger a second respawn', () => {
      // A real process adapter emits `ended` asynchronously after kill(). If the old
      // adapter's onEvent closure were still attached, that late `ended` would land
      // while state is 'starting' and trigger a SECOND _respawn(), orphaning the
      // first respawned child. The manager must detach the old adapter before stop().
      const { adapters, opts } = makeHarness(dir)
      const mgr = new SessionManager(opts)

      mgr.notifyDesignEdits()
      adapters[0]!.emit({ kind: 'started', sessionId: 'sess-race', model: 'claude', mcpLoaded: true })
      // state: busy — let the watchdog fire
      vi.advanceTimersByTime(35)
      expect(adapters).toHaveLength(2) // one respawn so far

      // The killed child's exit arrives late, from the OLD adapter
      adapters[0]!.emit({ kind: 'ended' })

      // Exactly ONE respawn total — makeAdapter called exactly twice
      expect(adapters).toHaveLength(2)
      expect(mgr.state()).toBe<SessionState>('busy')

      // The respawned adapter completes startup and gets the recovery pull;
      // no stale-closure effects (single sendTurn on the new adapter, none extra)
      adapters[1]!.emit({ kind: 'started', sessionId: 'sess-race-2', model: 'claude', mcpLoaded: true })
      expect(mgr.state()).toBe<SessionState>('busy')
      expect(adapters[1]!.sendTurnCalls).toHaveLength(1)
      // A further stale event from the old adapter must not overwrite the live session id
      adapters[0]!.emit({ kind: 'started', sessionId: 'STALE', model: 'claude', mcpLoaded: true })
      const json = JSON.parse(fs.readFileSync(path.join(dir, 'session.json'), 'utf8')) as {
        sessionId: string
      }
      expect(json.sessionId).toBe('sess-race-2')
    })
  })

  describe('approval-aware watchdog', () => {
    /** idle → notify (parks nudge) → started (flushes nudge) → busy with watchdog armed. */
    function toBusy(adapters: FakeAdapter[], mgr: SessionManager): void {
      mgr.notifyDesignEdits()
      adapters[0]!.emit({ kind: 'started', sessionId: 's1', model: 'claude', mcpLoaded: true })
      expect(mgr.state()).toBe<SessionState>('busy')
    }

    it('a pending approval suspends the watchdog (a human is deciding)', () => {
      const { adapters, opts } = makeHarness(dir)
      const mgr = new SessionManager(opts)
      toBusy(adapters, mgr)

      mgr.onApprovalPending()
      vi.advanceTimersByTime(1_000) // far past the 30ms test watchdog

      expect(adapters).toHaveLength(1) // no kill/respawn
      expect(mgr.state()).toBe<SessionState>('busy')
    })

    it('adapter events during a pending approval do not re-arm the watchdog', () => {
      const { adapters, opts } = makeHarness(dir)
      const mgr = new SessionManager(opts)
      toBusy(adapters, mgr)

      mgr.onApprovalPending()
      // A stray event mid-approval must not sneak a fresh 30ms timer past the suspension.
      adapters[0]!.emit({ kind: 'assistant-text', text: 'requesting permission…' })
      vi.advanceTimersByTime(1_000)

      expect(adapters).toHaveLength(1)
    })

    it('allow re-arms with the post-approval leash (approved tools emit nothing until tool_result)', () => {
      const { adapters, opts } = makeHarness(dir, { postApprovalWatchdogMs: 100 })
      const mgr = new SessionManager(opts)
      toBusy(adapters, mgr)

      mgr.onApprovalPending()
      mgr.onApprovalResolved(true)

      vi.advanceTimersByTime(60) // past the normal 30ms watchdog — leash must hold
      expect(adapters).toHaveLength(1)

      vi.advanceTimersByTime(50) // past the 100ms leash — genuine stall, recover
      expect(adapters).toHaveLength(2)
    })

    it('deny re-arms the normal watchdog', () => {
      const { adapters, opts } = makeHarness(dir, { postApprovalWatchdogMs: 100 })
      const mgr = new SessionManager(opts)
      toBusy(adapters, mgr)

      mgr.onApprovalPending()
      mgr.onApprovalResolved(false)

      vi.advanceTimersByTime(40) // past the normal watchdog — denied tool never runs long
      expect(adapters).toHaveLength(2)
    })

    it('stays suspended until the last overlapping approval resolves', () => {
      const { adapters, opts } = makeHarness(dir)
      const mgr = new SessionManager(opts)
      toBusy(adapters, mgr)

      mgr.onApprovalPending()
      mgr.onApprovalPending()
      mgr.onApprovalResolved(false)
      vi.advanceTimersByTime(1_000) // one still pending — suspension holds
      expect(adapters).toHaveLength(1)

      mgr.onApprovalResolved(false)
      vi.advanceTimersByTime(40)
      expect(adapters).toHaveLength(2)
    })

    it('stop() clears the suspension — a fresh session gets a live watchdog', () => {
      const { adapters, opts } = makeHarness(dir)
      const mgr = new SessionManager(opts)
      toBusy(adapters, mgr)

      mgr.onApprovalPending()
      mgr.stop()

      mgr.notifyDesignEdits()
      adapters[1]!.emit({ kind: 'started', sessionId: 's2', model: 'claude', mcpLoaded: true })
      expect(mgr.state()).toBe<SessionState>('busy')
      vi.advanceTimersByTime(40)
      expect(adapters).toHaveLength(3) // watchdog fired on the second session
    })
  })

  describe('activity heartbeat', () => {
    it('activity re-arms the watchdog while busy but is NOT pushed to the ring', () => {
      // Boot emits only system/hook lines for tens of seconds (verified live) — the
      // adapter maps them to `activity` so a slow boot doesn't read as a stall, without
      // spamming the feed ring.
      const { adapters, opts } = makeHarness(dir)
      const mgr = new SessionManager(opts)

      mgr.notifyDesignEdits() // busy, watchdog armed (30ms)
      vi.advanceTimersByTime(25)
      adapters[0]!.emit({ kind: 'activity' })
      vi.advanceTimersByTime(25)
      expect(adapters).toHaveLength(1) // re-armed — no watchdog fire

      expect(mgr.eventsSince(0).some((fe) => fe.event.kind === 'activity')).toBe(false)
    })
  })

  describe('ring buffer and event streaming', () => {
    it('seq starts at 1 and increments monotonically', () => {
      const { adapters, opts } = makeHarness(dir)
      const mgr = new SessionManager(opts)
      const events: FeedEvent[] = []
      mgr.subscribe((e) => events.push(e))

      mgr.notifyDesignEdits()
      adapters[0]!.emit({ kind: 'started', sessionId: 's1', model: 'claude', mcpLoaded: true })
      adapters[0]!.emit({ kind: 'assistant-text', text: 'hello' })
      adapters[0]!.emit({ kind: 'turn-complete', isError: false })

      expect(events[0]!.seq).toBe(1)
      expect(events[1]!.seq).toBe(2)
      expect(events[2]!.seq).toBe(3)
    })

    it('eventsSince(seq) returns events strictly after that seq', () => {
      const { adapters, opts } = makeHarness(dir)
      const mgr = new SessionManager(opts)

      mgr.notifyDesignEdits()
      adapters[0]!.emit({ kind: 'started', sessionId: 's1', model: 'claude', mcpLoaded: true })
      adapters[0]!.emit({ kind: 'assistant-text', text: 'a' })
      adapters[0]!.emit({ kind: 'turn-complete', isError: false })

      const all = mgr.eventsSince(0)
      expect(all).toHaveLength(3)

      const tail = mgr.eventsSince(2)
      expect(tail).toHaveLength(1)
      expect(tail[0]!.seq).toBe(3)
    })

    it('eventsSince returns [] when seq is at or beyond last event', () => {
      const { adapters, opts } = makeHarness(dir)
      const mgr = new SessionManager(opts)

      mgr.notifyDesignEdits()
      adapters[0]!.emit({ kind: 'started', sessionId: 's1', model: 'claude', mcpLoaded: true })

      const none = mgr.eventsSince(1)
      expect(none).toHaveLength(0)
    })

    it('ring buffer caps at RING_CAPACITY, tail is preserved', () => {
      const { adapters, opts } = makeHarness(dir)
      const mgr = new SessionManager(opts)

      mgr.notifyDesignEdits()
      adapters[0]!.emit({ kind: 'started', sessionId: 's1', model: 'claude', mcpLoaded: true })

      // Emit RING_CAPACITY + 10 additional events beyond started
      for (let i = 0; i < RING_CAPACITY + 10; i++) {
        adapters[0]!.emit({ kind: 'assistant-text', text: `msg-${i}` })
      }

      const all = mgr.eventsSince(0)
      expect(all).toHaveLength(RING_CAPACITY)
      // The oldest event has been evicted; the tail is the last RING_CAPACITY events
      const lastSeq = all[all.length - 1]!.seq
      const firstSeq = all[0]!.seq
      expect(lastSeq - firstSeq).toBe(RING_CAPACITY - 1)
    })

    it('subscribe fans out to multiple subscribers', () => {
      const { adapters, opts } = makeHarness(dir)
      const mgr = new SessionManager(opts)
      const a: FeedEvent[] = []
      const b: FeedEvent[] = []

      mgr.subscribe((e) => a.push(e))
      mgr.subscribe((e) => b.push(e))

      mgr.notifyDesignEdits()
      adapters[0]!.emit({ kind: 'started', sessionId: 's1', model: 'claude', mcpLoaded: true })

      expect(a).toHaveLength(1)
      expect(b).toHaveLength(1)
    })

    it('unsubscribe removes subscriber', () => {
      const { adapters, opts } = makeHarness(dir)
      const mgr = new SessionManager(opts)
      const events: FeedEvent[] = []
      const unsub = mgr.subscribe((e) => events.push(e))

      mgr.notifyDesignEdits()
      adapters[0]!.emit({ kind: 'started', sessionId: 's1', model: 'claude', mcpLoaded: true })
      expect(events).toHaveLength(1)

      unsub()
      adapters[0]!.emit({ kind: 'assistant-text', text: 'after unsub' })
      expect(events).toHaveLength(1) // no new events after unsub
    })

    it('subscribe receives only events emitted after subscription (no replay)', () => {
      const { adapters, opts } = makeHarness(dir)
      const mgr = new SessionManager(opts)

      mgr.notifyDesignEdits()
      adapters[0]!.emit({ kind: 'started', sessionId: 's1', model: 'claude', mcpLoaded: true })
      // subscribe AFTER the started event
      const events: FeedEvent[] = []
      mgr.subscribe((e) => events.push(e))

      adapters[0]!.emit({ kind: 'assistant-text', text: 'post-sub' })
      expect(events).toHaveLength(1)
      expect(events[0]!.event).toMatchObject({ kind: 'assistant-text', text: 'post-sub' })
    })

    it('at includes an ISO timestamp string', () => {
      const { adapters, opts } = makeHarness(dir)
      const mgr = new SessionManager(opts)
      const events: FeedEvent[] = []
      mgr.subscribe((e) => events.push(e))

      mgr.notifyDesignEdits()
      adapters[0]!.emit({ kind: 'started', sessionId: 's1', model: 'claude', mcpLoaded: true })

      expect(events[0]!.at).toMatch(/^\d{4}-\d{2}-\d{2}T/)
    })
  })

  describe('stop()', () => {
    it('kills adapter and transitions to idle', () => {
      const { adapters, opts } = makeHarness(dir)
      const mgr = new SessionManager(opts)

      mgr.notifyDesignEdits()
      adapters[0]!.emit({ kind: 'started', sessionId: 's1', model: 'claude', mcpLoaded: true })

      mgr.stop()

      expect(adapters[0]!.stopCalls).toBeGreaterThanOrEqual(1)
      expect(mgr.state()).toBe<SessionState>('idle')
    })

    it('clears parked nudge on stop(); stale events from the old adapter mutate nothing', () => {
      const { adapters, opts } = makeHarness(dir)
      const mgr = new SessionManager(opts)

      mgr.notifyDesignEdits()
      adapters[0]!.emit({ kind: 'started', sessionId: 's1', model: 'claude', mcpLoaded: true })
      // park a nudge
      mgr.notifyDesignEdits()

      mgr.stop()

      // After stop, a started event (from a stale adapter) should not flush the nudge
      adapters[0]!.emit({ kind: 'started', sessionId: 's2', model: 'claude', mcpLoaded: true })
      // Only the initial sendTurn (1), no second flush — and state stays idle
      expect(adapters[0]!.sendTurnCalls).toHaveLength(1)
      expect(mgr.state()).toBe<SessionState>('idle')
    })

    it('stop() is safe when idle (no-op)', () => {
      const { opts } = makeHarness(dir)
      const mgr = new SessionManager(opts)

      expect(() => mgr.stop()).not.toThrow()
    })

    it('stop() does not delete session.json', () => {
      const { adapters, opts } = makeHarness(dir)
      const mgr = new SessionManager(opts)

      mgr.notifyDesignEdits()
      adapters[0]!.emit({ kind: 'started', sessionId: 's1', model: 'claude', mcpLoaded: true })

      mgr.stop()

      expect(fs.existsSync(path.join(dir, 'session.json'))).toBe(true)
    })
  })

  describe('interrupt()', () => {
    it('delegates to adapter.interrupt when busy', () => {
      const { adapters, opts } = makeHarness(dir)
      const mgr = new SessionManager(opts)

      mgr.notifyDesignEdits()
      adapters[0]!.emit({ kind: 'started', sessionId: 's1', model: 'claude', mcpLoaded: true })

      mgr.interrupt()

      expect(adapters[0]!.interruptCalls).toBe(1)
    })

    it('interrupt is no-op when idle', () => {
      const { adapters, opts } = makeHarness(dir)
      const mgr = new SessionManager(opts)

      expect(() => mgr.interrupt()).not.toThrow()
      expect(adapters).toHaveLength(0)
    })
  })

  describe('constants', () => {
    it('WATCHDOG_MS is 120_000', () => {
      expect(WATCHDOG_MS).toBe(120_000)
    })

    it('POST_APPROVAL_WATCHDOG_MS is 600_000 (long enough for builds/tests)', () => {
      expect(POST_APPROVAL_WATCHDOG_MS).toBe(600_000)
    })

    it('RING_CAPACITY is 200', () => {
      expect(RING_CAPACITY).toBe(200)
    })

    it('PULL_TURN_TEXT is the exact ratified constant', () => {
      expect(PULL_TURN_TEXT).toBe(
        'New design edits are queued. Call the the-forge MCP tool pull_design_edits, apply each request exactly as written, then call mark_applied. Do not run the app, take screenshots, or preview the result.',
      )
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
      const { adapters, opts } = makeHarness(nonExistentDir)
      const mgr = new SessionManager(opts)

      mgr.notifyDesignEdits()
      adapters[0]!.emit({ kind: 'started', sessionId: 's1', model: 'claude', mcpLoaded: true })

      expect(fs.existsSync(path.join(nonExistentDir, 'session.json'))).toBe(true)
    })
  })
})
