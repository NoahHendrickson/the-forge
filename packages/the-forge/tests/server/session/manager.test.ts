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
  CHAT_QUEUE_CAP,
  type SessionManagerOpts,
  type ElementRef,
} from '../../../src/server/session/manager'
import type { SessionAdapter, SessionEvent } from '../../../src/server/session/adapter'
import type { HarnessId } from '../../../src/shared/chat-constants'

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
  setModelCalls: string[]
  setPermissionModeCalls: string[]
  setEffortCalls: string[]
  // Recorded from the makeAdapter(opts) factory call that created THIS instance —
  // lets tests assert which --effort value a given spawn was created with.
  effortReceived?: string
  // Recorded from the makeAdapter(opts) factory call that created THIS instance (Task 2:
  // harness is now a REQUIRED field on the opts) — lets tests assert which harness a given
  // spawn was created for.
  harnessReceived?: HarnessId
  emit(e: SessionEvent): void
}

function makeFakeAdapter(): FakeAdapter {
  const fa: FakeAdapter = {
    startCalls: [],
    sendTurnCalls: [],
    interruptCalls: 0,
    stopCalls: 0,
    setModelCalls: [],
    setPermissionModeCalls: [],
    setEffortCalls: [],
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
    // setModel/setPermissionMode: manager calls these directly from setConfig() (Task 3).
    // setEffort stays a no-op call-recorder only — Task 3's effort path never calls the
    // adapter's setEffort() (that's the ClaudeAdapter-confirmed-no-op instance method);
    // effort is threaded through the makeAdapter(opts) factory instead.
    setModel(model) {
      fa.setModelCalls.push(model)
    },
    setPermissionMode(mode) {
      fa.setPermissionModeCalls.push(mode)
    },
    setEffort(level) {
      fa.setEffortCalls.push(level)
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
    makeAdapter: (adapterOpts) => {
      const a = makeFakeAdapter()
      a.effortReceived = adapterOpts.effort
      a.harnessReceived = adapterOpts.harness
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

function elem(source: string, tag: string): ElementRef {
  return { source, tag }
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
      // session.json written to the claude-code slot (Task 2 per-harness shape)
      const json = JSON.parse(fs.readFileSync(path.join(dir, 'session.json'), 'utf8')) as {
        sessions: Record<string, { sessionId: string; updatedAt: string }>
      }
      expect(json.sessions['claude-code']).toMatchObject({ sessionId: 'sess-1' })
      expect(typeof json.sessions['claude-code']!.updatedAt).toBe('string')
    })

    it('session.json updatedAt comes from the injectable clock', () => {
      // Harness clock starts at 0 and ticks by 1 per call — real Date.now would
      // produce a 2026 timestamp, the injected clock the 1970 epoch.
      const { adapters, opts } = makeHarness(dir)
      const mgr = new SessionManager(opts)

      mgr.notifyDesignEdits()
      adapters[0]!.emit({ kind: 'started', sessionId: 'sess-1', model: 'claude', mcpLoaded: true })

      const json = JSON.parse(fs.readFileSync(path.join(dir, 'session.json'), 'utf8')) as {
        sessions: Record<string, { updatedAt: string }>
      }
      expect(json.sessions['claude-code']!.updatedAt).toMatch(/^1970-01-01T/)
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
      // clearSessionSlot is per-slot (Task 2) — the file itself survives (it's rewritten
      // sans the claude-code slot), only that harness's persisted resume id is gone.
      const json = JSON.parse(fs.readFileSync(path.join(dir, 'session.json'), 'utf8')) as {
        sessions: Record<string, unknown>
      }
      expect(json.sessions['claude-code']).toBeUndefined()

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
        sessions: Record<string, { sessionId: string }>
      }
      expect(json.sessions['claude-code']!.sessionId).toBe('sess-race-2')
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
      // Carries the scope/needs-confirmation guardrail since 2026-07-10: the queued markdown
      // no longer repeats it per item, and this turn text is the embedded path's only
      // instruction wrapper.
      expect(PULL_TURN_TEXT).toBe(
        'New design edits are queued. Call the the-forge MCP tool pull_design_edits, apply each request exactly as written, then call mark_applied. An edit needing the user\'s confirmation (e.g. a shared component rendered elsewhere) is "failed" with note "needs confirmation: <reason>". Do not run the app, take screenshots, or preview the result.',
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

  // ---------------------------------------------------------------------------
  // Task 3: say(), chat FIFO, in-flight recovery, config
  // ---------------------------------------------------------------------------

  describe('CHAT_QUEUE_CAP constant', () => {
    it('is 20', () => {
      expect(CHAT_QUEUE_CAP).toBe(20)
    })
  })

  describe('say() — ready', () => {
    it('sends the composed turn (text + element line) immediately and rings user-text', () => {
      const { adapters, opts } = makeHarness(dir)
      const mgr = new SessionManager(opts)
      const events: FeedEvent[] = []
      mgr.subscribe((e) => events.push(e))

      mgr.notifyDesignEdits()
      adapters[0]!.emit({ kind: 'started', sessionId: 's1', model: 'claude', mcpLoaded: true })
      adapters[0]!.emit({ kind: 'turn-complete', isError: false }) // → ready

      const result = mgr.say('make it bigger', elem('src/App.tsx:10:2', 'div'))

      expect(result).toEqual({ ok: true })
      expect(mgr.state()).toBe<SessionState>('busy')
      expect(adapters[0]!.sendTurnCalls).toEqual([
        PULL_TURN_TEXT,
        'make it bigger\n\n[Selected element: src/App.tsx:10:2 <div>]',
      ])
      const userTextRow = events.find((fe) => fe.event.kind === 'user-text')
      expect(userTextRow?.event).toEqual({
        kind: 'user-text',
        text: 'make it bigger',
        element: { source: 'src/App.tsx:10:2', tag: 'div' },
      })
    })

    it('composes with no element suffix when no element is given', () => {
      const { adapters, opts } = makeHarness(dir)
      const mgr = new SessionManager(opts)

      mgr.notifyDesignEdits()
      adapters[0]!.emit({ kind: 'started', sessionId: 's1', model: 'claude', mcpLoaded: true })
      adapters[0]!.emit({ kind: 'turn-complete', isError: false })

      mgr.say('hello')

      expect(adapters[0]!.sendTurnCalls[1]).toBe('hello')
    })
  })

  describe('say() — idle/failed auto-start', () => {
    it('idle: auto-starts and sends the composed turn immediately (lazy-boot send-at-spawn)', () => {
      const { adapters, opts } = makeHarness(dir)
      const mgr = new SessionManager(opts)

      const result = mgr.say('add padding')

      expect(result).toEqual({ ok: true })
      expect(mgr.state()).toBe<SessionState>('busy')
      expect(adapters).toHaveLength(1)
      expect(adapters[0]!.startCalls).toHaveLength(1)
      expect(adapters[0]!.sendTurnCalls).toEqual(['add padding'])
    })

    it('failed: auto-starts and sends immediately', () => {
      const { adapters, opts } = makeHarness(dir)
      const mgr = new SessionManager(opts)

      mgr.notifyDesignEdits()
      adapters[0]!.emit({ kind: 'started', sessionId: 's1', model: 'claude', mcpLoaded: true })
      adapters[0]!.emit({ kind: 'turn-complete', isError: true, errorText: 'rate limit' })
      expect(mgr.state()).toBe<SessionState>('failed')

      const result = mgr.say('try again')

      expect(result).toEqual({ ok: true })
      expect(adapters).toHaveLength(2)
      expect(adapters[1]!.sendTurnCalls).toEqual(['try again'])
      expect(mgr.state()).toBe<SessionState>('busy')
    })
  })

  describe('say() — busy: chat FIFO queue', () => {
    it('queues the composed text (no immediate sendTurn) and still rings user-text', () => {
      const { adapters, opts } = makeHarness(dir)
      const mgr = new SessionManager(opts)
      const events: FeedEvent[] = []
      mgr.subscribe((e) => events.push(e))

      mgr.notifyDesignEdits()
      adapters[0]!.emit({ kind: 'started', sessionId: 's1', model: 'claude', mcpLoaded: true })
      // busy, one sendTurn so far (the pull turn)

      const result = mgr.say('make it red')

      expect(result).toEqual({ ok: true })
      expect(adapters[0]!.sendTurnCalls).toHaveLength(1) // not sent yet — queued
      expect(events.some((fe) => fe.event.kind === 'user-text')).toBe(true)
      expect(mgr.state()).toBe<SessionState>('busy')
    })

    it('queue-full at CHAT_QUEUE_CAP returns {ok:false, reason:"queue-full"} and rings nothing for that call', () => {
      const { adapters, opts } = makeHarness(dir)
      const mgr = new SessionManager(opts)
      const events: FeedEvent[] = []
      mgr.subscribe((e) => events.push(e))

      mgr.notifyDesignEdits()
      adapters[0]!.emit({ kind: 'started', sessionId: 's1', model: 'claude', mcpLoaded: true })

      for (let i = 0; i < CHAT_QUEUE_CAP; i++) {
        const r = mgr.say(`msg-${i}`)
        expect(r).toEqual({ ok: true })
      }
      const countBeforeOverflow = events.filter((fe) => fe.event.kind === 'user-text').length
      expect(countBeforeOverflow).toBe(CHAT_QUEUE_CAP)

      const overflow = mgr.say('one too many')

      expect(overflow).toEqual({ ok: false, reason: 'queue-full' })
      // Rejected BEFORE ringing — no extra user-text row for the rejected call.
      const countAfterOverflow = events.filter((fe) => fe.event.kind === 'user-text').length
      expect(countAfterOverflow).toBe(CHAT_QUEUE_CAP)
      expect(adapters[0]!.sendTurnCalls).toHaveLength(1) // still just the pull turn
    })

    it('two queued says flush in FIFO order across successive turn-completes', () => {
      const { adapters, opts } = makeHarness(dir)
      const mgr = new SessionManager(opts)

      mgr.notifyDesignEdits()
      adapters[0]!.emit({ kind: 'started', sessionId: 's1', model: 'claude', mcpLoaded: true })

      mgr.say('first')
      mgr.say('second')

      adapters[0]!.emit({ kind: 'turn-complete', isError: false }) // flush 'first'
      expect(adapters[0]!.sendTurnCalls).toEqual([PULL_TURN_TEXT, 'first'])
      expect(mgr.state()).toBe<SessionState>('busy')

      adapters[0]!.emit({ kind: 'turn-complete', isError: false }) // flush 'second'
      expect(adapters[0]!.sendTurnCalls).toEqual([PULL_TURN_TEXT, 'first', 'second'])
      expect(mgr.state()).toBe<SessionState>('busy')

      adapters[0]!.emit({ kind: 'turn-complete', isError: false }) // queue empty → ready
      expect(adapters[0]!.sendTurnCalls).toHaveLength(3)
      expect(mgr.state()).toBe<SessionState>('ready')
    })

    it('a parked pull nudge flushes before the chat queue on turn-complete', () => {
      const { adapters, opts } = makeHarness(dir)
      const mgr = new SessionManager(opts)

      mgr.notifyDesignEdits()
      adapters[0]!.emit({ kind: 'started', sessionId: 's1', model: 'claude', mcpLoaded: true })
      // busy — pull turn already sent

      mgr.say('chat turn')
      mgr.notifyDesignEdits() // parks a nudge

      adapters[0]!.emit({ kind: 'turn-complete', isError: false })
      // nudge flushes first, not the queued chat turn
      expect(adapters[0]!.sendTurnCalls).toEqual([PULL_TURN_TEXT, PULL_TURN_TEXT])

      adapters[0]!.emit({ kind: 'turn-complete', isError: false })
      // now the chat queue flushes
      expect(adapters[0]!.sendTurnCalls).toEqual([PULL_TURN_TEXT, PULL_TURN_TEXT, 'chat turn'])
    })
  })

  describe('assistant-delta: subscriber-only fan-out, never ringed', () => {
    it('fans to subscribers as {seq: 0, at, event} and never lands in the ring', () => {
      const { adapters, opts } = makeHarness(dir)
      const mgr = new SessionManager(opts)
      const events: FeedEvent[] = []
      mgr.subscribe((e) => events.push(e))

      mgr.notifyDesignEdits()
      adapters[0]!.emit({ kind: 'started', sessionId: 's1', model: 'claude', mcpLoaded: true })
      adapters[0]!.emit({ kind: 'assistant-delta', text: 'partial tok' })

      const deltaEvents = events.filter((fe) => fe.event.kind === 'assistant-delta')
      expect(deltaEvents).toHaveLength(1)
      expect(deltaEvents[0]!.seq).toBe(0)
      expect(deltaEvents[0]!.at).toMatch(/^\d{4}-\d{2}-\d{2}T/)
      expect(deltaEvents[0]!.event).toEqual({ kind: 'assistant-delta', text: 'partial tok' })

      // Not in the ring — eventsSince(0) (all real seq'd events) excludes it.
      expect(mgr.eventsSince(0).some((fe) => fe.event.kind === 'assistant-delta')).toBe(false)
    })

    it('does not advance the ring seq counter (a following real event keeps the prior seq)', () => {
      const { adapters, opts } = makeHarness(dir)
      const mgr = new SessionManager(opts)
      const events: FeedEvent[] = []
      mgr.subscribe((e) => events.push(e))

      mgr.notifyDesignEdits()
      adapters[0]!.emit({ kind: 'started', sessionId: 's1', model: 'claude', mcpLoaded: true }) // seq 1
      adapters[0]!.emit({ kind: 'assistant-delta', text: 'x' }) // seq 0, ephemeral
      adapters[0]!.emit({ kind: 'assistant-text', text: 'done' }) // seq 2

      const realSeqs = mgr.eventsSince(0).map((fe) => fe.seq)
      expect(realSeqs).toEqual([1, 2])
    })
  })

  describe('user-text: manager-produced, lands in ring/replay', () => {
    it('a user-text event from say() is present in eventsSince() replay', () => {
      const { adapters, opts } = makeHarness(dir)
      const mgr = new SessionManager(opts)

      mgr.say('hi there')

      const rows = mgr.eventsSince(0).filter((fe) => fe.event.kind === 'user-text')
      expect(rows).toHaveLength(1)
      expect(rows[0]!.event).toEqual({ kind: 'user-text', text: 'hi there', element: undefined })
      void adapters
    })
  })

  describe('in-flight-turn recovery', () => {
    it('watchdog respawn re-sends the in-flight CHAT turn, not PULL_TURN_TEXT', () => {
      const { adapters, opts } = makeHarness(dir)
      const mgr = new SessionManager(opts)

      mgr.notifyDesignEdits()
      adapters[0]!.emit({ kind: 'started', sessionId: 's1', model: 'claude', mcpLoaded: true })
      adapters[0]!.emit({ kind: 'turn-complete', isError: false }) // → ready

      mgr.say('a chat turn') // ready → sends immediately, _inflightTurn = composed chat text
      expect(adapters[0]!.sendTurnCalls).toEqual([PULL_TURN_TEXT, 'a chat turn'])

      vi.advanceTimersByTime(35) // past the 30ms test watchdog

      expect(adapters).toHaveLength(2)
      expect(adapters[1]!.startCalls[0]!.resumeId).toBe('s1')
      expect(adapters[1]!.sendTurnCalls).toEqual(['a chat turn'])
    })

    it('ended-while-busy respawn also re-sends the in-flight chat turn', () => {
      const { adapters, opts } = makeHarness(dir)
      const mgr = new SessionManager(opts)

      mgr.notifyDesignEdits()
      adapters[0]!.emit({ kind: 'started', sessionId: 's1', model: 'claude', mcpLoaded: true })
      adapters[0]!.emit({ kind: 'turn-complete', isError: false })

      mgr.say('another chat turn')
      adapters[0]!.emit({ kind: 'ended' }) // unexpected exit mid-turn

      expect(adapters).toHaveLength(2)
      expect(adapters[1]!.sendTurnCalls).toEqual(['another chat turn'])
    })

    it('stale-resume retry (_start(true)) re-sends the in-flight turn', () => {
      fs.writeFileSync(
        path.join(dir, 'session.json'),
        JSON.stringify({ sessionId: 'stale-id', updatedAt: 'x' }),
      )
      const { adapters, opts } = makeHarness(dir)
      const mgr = new SessionManager(opts)

      mgr.say('chat while starting from resume')
      expect(adapters[0]!.startCalls[0]!.resumeId).toBe('stale-id')
      // CLI rejects the resume id in-band, before ever emitting init/started.
      adapters[0]!.emit({ kind: 'turn-complete', isError: true, errorText: 'not a UUID' })

      expect(adapters).toHaveLength(2)
      expect(adapters[1]!.startCalls[0]!.resumeId).toBeUndefined()
      expect(adapters[1]!.sendTurnCalls).toEqual(['chat while starting from resume'])
    })

    it('watchdog respawn of a CHAT turn preserves a separately parked nudge (flushes as a pull afterward)', () => {
      // The pre-Task-3 respawn unconditionally cleared the parked nudge — correct only
      // because the resent turn was always PULL_TURN_TEXT (a fresh pull covers everything
      // a nudge asks for). With chat turns in flight, that unconditional clear would
      // silently drop a legitimately queued design-edit pull parked behind a dying chat
      // turn. Pins the conditional: clear only when the resent turn IS the pull turn.
      const { adapters, opts } = makeHarness(dir)
      const mgr = new SessionManager(opts)

      mgr.notifyDesignEdits()
      adapters[0]!.emit({ kind: 'started', sessionId: 's1', model: 'claude', mcpLoaded: true })
      adapters[0]!.emit({ kind: 'turn-complete', isError: false }) // → ready

      mgr.say('a chat turn') // busy — the in-flight turn is now a CHAT turn
      mgr.notifyDesignEdits() // parks a pull nudge behind it

      vi.advanceTimersByTime(35) // watchdog fires — kill + respawn

      // Recovery re-sends the chat turn itself, never PULL_TURN_TEXT...
      expect(adapters).toHaveLength(2)
      expect(adapters[1]!.sendTurnCalls).toEqual(['a chat turn'])

      // ...and the parked nudge SURVIVED the respawn: it flushes a pull turn on the
      // resent chat turn's own completion (normal nudge-before-chat-queue flush order).
      adapters[1]!.emit({ kind: 'started', sessionId: 's2', model: 'claude', mcpLoaded: true })
      adapters[1]!.emit({ kind: 'turn-complete', isError: false })
      expect(adapters[1]!.sendTurnCalls).toEqual(['a chat turn', PULL_TURN_TEXT])
      expect(mgr.state()).toBe<SessionState>('busy')
    })

    it('stale-resume retry of a CHAT turn preserves a nudge parked during boot (flushes as a pull afterward)', () => {
      // Same nudge-preservation rule on the stale-resume branch: an in-band error before
      // started while a CHAT turn (not a pull) is in flight must retry the chat turn fresh
      // WITHOUT dropping a pull nudge that arrived while the doomed resume child booted.
      fs.writeFileSync(
        path.join(dir, 'session.json'),
        JSON.stringify({ sessionId: 'stale-id', updatedAt: 'x' }),
      )
      const { adapters, opts } = makeHarness(dir)
      const mgr = new SessionManager(opts)

      mgr.say('chat from idle') // auto-start with --resume stale-id, chat turn sent at spawn
      expect(adapters[0]!.startCalls[0]!.resumeId).toBe('stale-id')
      mgr.notifyDesignEdits() // design edit lands while the resume child boots — parks a nudge

      // CLI rejects the resume id in-band, before ever emitting init/started.
      adapters[0]!.emit({ kind: 'turn-complete', isError: true, errorText: 'not a UUID' })

      // Fresh retry re-sends the chat turn itself...
      expect(adapters).toHaveLength(2)
      expect(adapters[1]!.startCalls[0]!.resumeId).toBeUndefined()
      expect(adapters[1]!.sendTurnCalls).toEqual(['chat from idle'])

      // ...and the nudge survived: it still flushes a pull turn once the retried chat
      // turn completes.
      adapters[1]!.emit({ kind: 'started', sessionId: 'fresh-1', model: 'claude', mcpLoaded: true })
      adapters[1]!.emit({ kind: 'turn-complete', isError: false })
      expect(adapters[1]!.sendTurnCalls).toEqual(['chat from idle', PULL_TURN_TEXT])
      expect(mgr.state()).toBe<SessionState>('busy')
    })

    it('chat queue survives a watchdog respawn — the still-queued item flushes after recovery', () => {
      const { adapters, opts } = makeHarness(dir)
      const mgr = new SessionManager(opts)

      mgr.notifyDesignEdits()
      adapters[0]!.emit({ kind: 'started', sessionId: 's1', model: 'claude', mcpLoaded: true })
      // busy — pull turn in flight

      mgr.say('queued while busy') // parks in _chatQueue (pull turn is the in-flight one)

      vi.advanceTimersByTime(35) // watchdog fires — respawns, re-sends PULL_TURN_TEXT (the in-flight turn)
      expect(adapters).toHaveLength(2)
      expect(adapters[1]!.sendTurnCalls).toEqual([PULL_TURN_TEXT])

      adapters[1]!.emit({ kind: 'started', sessionId: 's2', model: 'claude', mcpLoaded: true })
      adapters[1]!.emit({ kind: 'turn-complete', isError: false }) // flush the surviving chat queue item

      expect(adapters[1]!.sendTurnCalls).toEqual([PULL_TURN_TEXT, 'queued while busy'])
    })
  })

  describe('setConfig()', () => {
    it('calls adapter.setModel/setPermissionMode for provided keys and rings config-changed', () => {
      const { adapters, opts } = makeHarness(dir)
      const mgr = new SessionManager(opts)
      const events: FeedEvent[] = []
      mgr.subscribe((e) => events.push(e))

      mgr.notifyDesignEdits()
      adapters[0]!.emit({ kind: 'started', sessionId: 's1', model: 'claude', mcpLoaded: true })

      const result = mgr.setConfig({ model: 'claude-haiku-4-5', permissionMode: 'acceptEdits' })

      expect(result).toEqual({ ok: true })
      expect(adapters[0]!.setModelCalls).toEqual(['claude-haiku-4-5'])
      expect(adapters[0]!.setPermissionModeCalls).toEqual(['acceptEdits'])
      const row = events.find((fe) => fe.event.kind === 'config-changed')
      expect(row?.event).toEqual({
        kind: 'config-changed',
        model: 'claude-haiku-4-5',
        permissionMode: 'acceptEdits',
      })
    })

    it('model/permissionMode changes are allowed while busy (no respawn)', () => {
      const { adapters, opts } = makeHarness(dir)
      const mgr = new SessionManager(opts)

      mgr.notifyDesignEdits()
      adapters[0]!.emit({ kind: 'started', sessionId: 's1', model: 'claude', mcpLoaded: true })
      expect(mgr.state()).toBe<SessionState>('busy')

      const result = mgr.setConfig({ model: 'claude-haiku-4-5' })

      expect(result).toEqual({ ok: true })
      expect(adapters).toHaveLength(1) // no respawn
      expect(mgr.state()).toBe<SessionState>('busy')
    })

    it('effort change while NOT busy stops the live adapter (state -> idle) instead of eagerly respawning', () => {
      const { adapters, opts } = makeHarness(dir)
      const mgr = new SessionManager(opts)

      mgr.notifyDesignEdits()
      adapters[0]!.emit({ kind: 'started', sessionId: 's1', model: 'claude', mcpLoaded: true })
      adapters[0]!.emit({ kind: 'turn-complete', isError: false }) // → ready

      const result = mgr.setConfig({ effort: 'high' })

      expect(result).toEqual({ ok: true })
      expect(adapters[0]!.stopCalls).toBe(1)
      expect(mgr.state()).toBe<SessionState>('idle')
      expect(adapters).toHaveLength(1) // no eager respawn — no boot-parked silent child
    })

    it('the NEXT send after an effort change auto-starts with the new effort flag threaded to makeAdapter', () => {
      const { adapters, opts } = makeHarness(dir)
      const mgr = new SessionManager(opts)

      mgr.notifyDesignEdits()
      adapters[0]!.emit({ kind: 'started', sessionId: 's1', model: 'claude', mcpLoaded: true })
      adapters[0]!.emit({ kind: 'turn-complete', isError: false })
      expect(adapters[0]!.effortReceived).toBeUndefined()

      mgr.setConfig({ effort: 'xhigh' })
      expect(mgr.state()).toBe<SessionState>('idle')

      mgr.say('go')

      expect(adapters).toHaveLength(2)
      expect(adapters[1]!.effortReceived).toBe('xhigh')
      expect(adapters[1]!.startCalls[0]!.resumeId).toBe('s1') // conversation survives via --resume
      expect(adapters[1]!.sendTurnCalls).toEqual(['go'])
    })

    it('effort change while idle (no live adapter) just records it — next spawn uses it', () => {
      const { adapters, opts } = makeHarness(dir)
      const mgr = new SessionManager(opts)

      mgr.setConfig({ effort: 'low' })
      expect(mgr.state()).toBe<SessionState>('idle')
      expect(adapters).toHaveLength(0)

      mgr.notifyDesignEdits()

      expect(adapters[0]!.effortReceived).toBe('low')
    })

    it('effort change while busy is rejected with {ok:false, reason:"busy"} — no kill of a live turn', () => {
      const { adapters, opts } = makeHarness(dir)
      const mgr = new SessionManager(opts)
      const events: FeedEvent[] = []
      mgr.subscribe((e) => events.push(e))

      mgr.notifyDesignEdits()
      adapters[0]!.emit({ kind: 'started', sessionId: 's1', model: 'claude', mcpLoaded: true })
      expect(mgr.state()).toBe<SessionState>('busy')

      const result = mgr.setConfig({ effort: 'max' })

      expect(result).toEqual({ ok: false, reason: 'busy' })
      expect(adapters[0]!.stopCalls).toBe(0)
      expect(mgr.state()).toBe<SessionState>('busy')
      expect(events.some((fe) => fe.event.kind === 'config-changed')).toBe(false)
    })

    // Final-review fix 2: config must survive respawn. A respawned child pins
    // --permission-mode default in its spawn args (and boots with whatever default model),
    // regardless of what the user last picked — without re-applying, the picker would keep
    // showing the old choice while the live adapter silently reverted.
    it('setConfig then watchdog respawn re-applies model+permissionMode on started', () => {
      const { adapters, opts } = makeHarness(dir)
      const mgr = new SessionManager(opts)

      mgr.notifyDesignEdits()
      adapters[0]!.emit({ kind: 'started', sessionId: 'sess-1', model: 'claude', mcpLoaded: true })
      // state: busy

      mgr.setConfig({ model: 'claude-haiku-4-5', permissionMode: 'acceptEdits' })
      expect(adapters[0]!.setModelCalls).toEqual(['claude-haiku-4-5'])
      expect(adapters[0]!.setPermissionModeCalls).toEqual(['acceptEdits'])

      vi.advanceTimersByTime(35) // past the 30ms test watchdog — kills + respawns
      expect(adapters).toHaveLength(2)

      adapters[1]!.emit({ kind: 'started', sessionId: 'sess-2', model: 'claude', mcpLoaded: true })

      expect(adapters[1]!.setModelCalls).toEqual(['claude-haiku-4-5'])
      expect(adapters[1]!.setPermissionModeCalls).toEqual(['acceptEdits'])
    })

    it('setConfig while idle records and applies on next started', () => {
      const { adapters, opts } = makeHarness(dir)
      const mgr = new SessionManager(opts)

      const result = mgr.setConfig({ model: 'claude-haiku-4-5', permissionMode: 'plan' })
      expect(result).toEqual({ ok: true })
      expect(adapters).toHaveLength(0) // no live adapter to call — must still be recorded

      mgr.notifyDesignEdits()
      expect(adapters).toHaveLength(1)
      adapters[0]!.emit({ kind: 'started', sessionId: 's1', model: 'claude', mcpLoaded: true })

      expect(adapters[0]!.setModelCalls).toEqual(['claude-haiku-4-5'])
      expect(adapters[0]!.setPermissionModeCalls).toEqual(['plan'])
    })
  })

  describe('stop() — Task 3 additions', () => {
    it('clears the chat queue — a fresh session after stop() does not replay stale queued turns', () => {
      const { adapters, opts } = makeHarness(dir)
      const mgr = new SessionManager(opts)

      mgr.notifyDesignEdits()
      adapters[0]!.emit({ kind: 'started', sessionId: 's1', model: 'claude', mcpLoaded: true })
      mgr.say('queued but abandoned') // sits in _chatQueue (busy)

      mgr.stop()
      expect(mgr.state()).toBe<SessionState>('idle')

      // Fresh session: reach ready, then confirm no leftover queued turn auto-fires.
      mgr.notifyDesignEdits()
      adapters[1]!.emit({ kind: 'started', sessionId: 's2', model: 'claude', mcpLoaded: true })
      adapters[1]!.emit({ kind: 'turn-complete', isError: false })

      expect(mgr.state()).toBe<SessionState>('ready')
      expect(adapters[1]!.sendTurnCalls).toEqual([PULL_TURN_TEXT]) // no stray flush
    })

    // Final-review fix 2: dev-server close is a fresh posture — a NEW session must not
    // silently inherit a stranger's remembered model/permissionMode (mirrors the existing
    // chat-queue-clear rule above).
    it('stop() clears remembered config', () => {
      const { adapters, opts } = makeHarness(dir)
      const mgr = new SessionManager(opts)

      mgr.setConfig({ model: 'claude-haiku-4-5', permissionMode: 'acceptEdits' })
      mgr.stop()

      mgr.notifyDesignEdits()
      adapters[0]!.emit({ kind: 'started', sessionId: 's1', model: 'claude', mcpLoaded: true })

      expect(adapters[0]!.setModelCalls).toEqual([])
      expect(adapters[0]!.setPermissionModeCalls).toEqual([])
    })
  })

  // ---------------------------------------------------------------------------
  // Task 2 (C1): per-harness vocab, per-harness session.json slots, harness selection
  // ---------------------------------------------------------------------------

  describe('harness() resolution', () => {
    it('defaults to claude-code when nothing else is configured', () => {
      const { opts } = makeHarness(dir)
      const mgr = new SessionManager(opts)
      expect(mgr.harness()).toBe<HarnessId>('claude-code')
    })

    it('respects opts.defaultHarness when no selection is persisted', () => {
      const { opts } = makeHarness(dir, { defaultHarness: 'cursor' })
      const mgr = new SessionManager(opts)
      expect(mgr.harness()).toBe<HarnessId>('cursor')
    })

    it('respects a persisted session.json selected over defaultHarness', () => {
      fs.writeFileSync(
        path.join(dir, 'session.json'),
        JSON.stringify({ selected: 'cursor', sessions: {} }),
      )
      const { opts } = makeHarness(dir, { defaultHarness: 'claude-code' })
      const mgr = new SessionManager(opts)
      expect(mgr.harness()).toBe<HarnessId>('cursor')
    })

    it('an unknown persisted selected value falls back to defaultHarness, never throws', () => {
      fs.writeFileSync(
        path.join(dir, 'session.json'),
        JSON.stringify({ selected: 'some-future-harness', sessions: {} }),
      )
      const { opts } = makeHarness(dir, { defaultHarness: 'cursor' })
      expect(() => new SessionManager(opts)).not.toThrow()
      const mgr = new SessionManager(opts)
      expect(mgr.harness()).toBe<HarnessId>('cursor')
    })
  })

  describe('session.json legacy read-compat', () => {
    it('a legacy flat {sessionId, updatedAt} file reads as the claude-code slot', () => {
      fs.writeFileSync(
        path.join(dir, 'session.json'),
        JSON.stringify({ sessionId: 'legacy-id', updatedAt: 'x' }),
      )
      const { adapters, opts } = makeHarness(dir)
      const mgr = new SessionManager(opts)

      mgr.notifyDesignEdits()

      expect(adapters[0]!.startCalls[0]!.resumeId).toBe('legacy-id')
      void mgr
    })
  })

  describe('per-harness session.json slots', () => {
    it('started under cursor writes the cursor slot without touching an existing claude-code slot', () => {
      // No `selected` key — defaultHarness alone drives this session to cursor; a pre-existing
      // claude-code slot (from an earlier claude-code session) must survive untouched.
      fs.writeFileSync(
        path.join(dir, 'session.json'),
        JSON.stringify({
          sessions: { 'claude-code': { sessionId: 'claude-existing', updatedAt: 'x' } },
        }),
      )
      const { adapters, opts } = makeHarness(dir, { defaultHarness: 'cursor' })
      const mgr = new SessionManager(opts)

      mgr.notifyDesignEdits()
      adapters[0]!.emit({ kind: 'started', sessionId: 'cursor-sess-1', model: 'cursor', mcpLoaded: true })

      const json = JSON.parse(fs.readFileSync(path.join(dir, 'session.json'), 'utf8')) as {
        sessions: Record<string, { sessionId: string }>
      }
      expect(json.sessions['cursor']!.sessionId).toBe('cursor-sess-1')
      expect(json.sessions['claude-code']!.sessionId).toBe('claude-existing')
    })

    it('stale-resume retry clears only the current harness slot, leaving the other harness untouched', () => {
      fs.writeFileSync(
        path.join(dir, 'session.json'),
        JSON.stringify({
          selected: 'cursor',
          sessions: {
            cursor: { sessionId: 'stale-cursor-id', updatedAt: 'x' },
            'claude-code': { sessionId: 'claude-untouched', updatedAt: 'y' },
          },
        }),
      )
      const { adapters, opts } = makeHarness(dir)
      const mgr = new SessionManager(opts)

      mgr.notifyDesignEdits()
      expect(adapters[0]!.startCalls[0]!.resumeId).toBe('stale-cursor-id')
      // CLI rejects the resume id in-band, before ever emitting init/started.
      adapters[0]!.emit({ kind: 'turn-complete', isError: true, errorText: 'not a UUID' })

      expect(adapters).toHaveLength(2)
      expect(adapters[1]!.startCalls[0]!.resumeId).toBeUndefined()

      const json = JSON.parse(fs.readFileSync(path.join(dir, 'session.json'), 'utf8')) as {
        sessions: Record<string, { sessionId: string } | undefined>
      }
      expect(json.sessions['cursor']).toBeUndefined()
      expect(json.sessions['claude-code']!.sessionId).toBe('claude-untouched')
    })
  })

  describe('setConfig({harness})', () => {
    it('busy → {ok:false, reason:"busy"} — a switch must not kill a live turn', () => {
      const { adapters, opts } = makeHarness(dir)
      const mgr = new SessionManager(opts)
      const events: FeedEvent[] = []
      mgr.subscribe((e) => events.push(e))

      mgr.notifyDesignEdits()
      adapters[0]!.emit({ kind: 'started', sessionId: 's1', model: 'claude', mcpLoaded: true })
      expect(mgr.state()).toBe<SessionState>('busy')

      const result = mgr.setConfig({ harness: 'cursor' })

      expect(result).toEqual({ ok: false, reason: 'busy' })
      expect(mgr.harness()).toBe<HarnessId>('claude-code')
      expect(adapters[0]!.stopCalls).toBe(0)
      expect(events.some((fe) => fe.event.kind === 'config-changed')).toBe(false)
    })

    it('while ready: stops the live adapter (state -> idle), persists selected, pushes config-changed {harness}', () => {
      const { adapters, opts } = makeHarness(dir)
      const mgr = new SessionManager(opts)
      const events: FeedEvent[] = []
      mgr.subscribe((e) => events.push(e))

      mgr.notifyDesignEdits()
      adapters[0]!.emit({ kind: 'started', sessionId: 's1', model: 'claude', mcpLoaded: true })
      adapters[0]!.emit({ kind: 'turn-complete', isError: false }) // -> ready

      const result = mgr.setConfig({ harness: 'cursor' })

      expect(result).toEqual({ ok: true })
      expect(mgr.harness()).toBe<HarnessId>('cursor')
      expect(adapters[0]!.stopCalls).toBe(1)
      expect(mgr.state()).toBe<SessionState>('idle')

      const row = events.find((fe) => fe.event.kind === 'config-changed')
      expect(row?.event).toEqual({ kind: 'config-changed', harness: 'cursor' })

      const json = JSON.parse(fs.readFileSync(path.join(dir, 'session.json'), 'utf8')) as {
        selected: string
      }
      expect(json.selected).toBe('cursor')
    })

    it("after a harness switch, the next say() spawns via makeAdapter with the new harness and that harness's own resumeId", () => {
      fs.writeFileSync(
        path.join(dir, 'session.json'),
        JSON.stringify({
          selected: 'claude-code',
          sessions: {
            cursor: { sessionId: 'cursor-own-id', updatedAt: 'x' },
            'claude-code': { sessionId: 'claude-own-id', updatedAt: 'y' },
          },
        }),
      )
      const { adapters, opts } = makeHarness(dir)
      const mgr = new SessionManager(opts)

      mgr.notifyDesignEdits()
      expect(adapters[0]!.startCalls[0]!.resumeId).toBe('claude-own-id')
      adapters[0]!.emit({ kind: 'started', sessionId: 'claude-own-id', model: 'claude', mcpLoaded: true })
      adapters[0]!.emit({ kind: 'turn-complete', isError: false }) // -> ready

      mgr.setConfig({ harness: 'cursor' })
      expect(mgr.state()).toBe<SessionState>('idle')

      mgr.say('go')

      expect(adapters).toHaveLength(2)
      expect(adapters[1]!.harnessReceived).toBe<HarnessId>('cursor')
      expect(adapters[1]!.startCalls[0]!.resumeId).toBe('cursor-own-id')
      expect(adapters[1]!.sendTurnCalls).toEqual(['go'])
    })

    it("a pre-started death after a harness switch respawns with the NEW harness's own slot id, never the old harness's live session id", () => {
      // Cross-harness resume leak (whole-branch review): setConfig({harness}) must clear
      // _lastSessionId (recorded at `started` under the PREVIOUS harness) — _respawn()
      // prefers `_lastSessionId ?? readSlot(..., _harness)`, so after a switch, a send that
      // goes busy-before-started and then dies pre-`started` would otherwise respawn the NEW
      // harness's CLI with the OLD harness's session id. Compounding: that resume fails
      // in-band pre-`started`, so the stale-resume branch would then clear the NEW harness's
      // slot — deleting a legitimate resume id that was never even tried.
      fs.writeFileSync(
        path.join(dir, 'session.json'),
        JSON.stringify({
          selected: 'claude-code',
          sessions: { cursor: { sessionId: 'cursor-own-id', updatedAt: 'x' } },
        }),
      )
      const { adapters, opts } = makeHarness(dir)
      const mgr = new SessionManager(opts)

      mgr.notifyDesignEdits()
      adapters[0]!.emit({ kind: 'started', sessionId: 'claude-1', model: 'claude', mcpLoaded: true })
      adapters[0]!.emit({ kind: 'turn-complete', isError: false }) // -> ready

      mgr.setConfig({ harness: 'cursor' }) // -> idle, selection switched

      mgr.say('go') // auto-start: busy-before-started (send-at-spawn)
      expect(adapters).toHaveLength(2)
      expect(adapters[1]!.startCalls[0]!.resumeId).toBe('cursor-own-id')

      // The first cursor spawn dies before ever emitting `started` → _respawn().
      adapters[1]!.emit({ kind: 'ended' })

      expect(adapters).toHaveLength(3)
      // The recovery spawn resumes from the CURSOR slot — NEVER the old harness's 'claude-1'.
      expect(adapters[2]!.startCalls[0]!.resumeId).toBe('cursor-own-id')
      expect(adapters[2]!.harnessReceived).toBe<HarnessId>('cursor')

      // And the cursor slot survives — no stale-resume clear of an id that was never tried.
      const json = JSON.parse(fs.readFileSync(path.join(dir, 'session.json'), 'utf8')) as {
        sessions: Record<string, { sessionId: string } | undefined>
      }
      expect(json.sessions['cursor']!.sessionId).toBe('cursor-own-id')
    })

    it("stop() does not clear the persisted selection — a restart keeps the user's harness", () => {
      const { adapters, opts } = makeHarness(dir)
      const mgr = new SessionManager(opts)

      mgr.notifyDesignEdits()
      adapters[0]!.emit({ kind: 'started', sessionId: 's1', model: 'claude', mcpLoaded: true })
      adapters[0]!.emit({ kind: 'turn-complete', isError: false })
      mgr.setConfig({ harness: 'cursor' })

      mgr.stop()

      const second = makeHarness(dir)
      const mgr2 = new SessionManager(second.opts)
      expect(mgr2.harness()).toBe<HarnessId>('cursor')
      void mgr
    })
  })

  describe('setConfig({effort}) — capability-aware via HARNESS_VOCAB[harness].liveEffort', () => {
    it('a liveEffort harness (cursor): no stop, allowed while busy, calls adapter.setEffort, respawn still passes effort', () => {
      // The manager consults ONLY the vocab's liveEffort flag — never `efforts` membership
      // (that allowlist lives in the endpoint's validation, Task 4). Cursor's efforts list is
      // EMPTY, so in production every effort value is rejected upstream and setEffort never
      // fires for cursor — this test drives the liveEffort:true manager path directly because
      // it's real, load-bearing manager code that C2's Codex harness (non-empty efforts,
      // liveEffort: true) will exercise for real.
      const { adapters, opts } = makeHarness(dir, { defaultHarness: 'cursor' })
      const mgr = new SessionManager(opts)

      mgr.notifyDesignEdits()
      adapters[0]!.emit({ kind: 'started', sessionId: 's1', model: 'cursor', mcpLoaded: true })
      expect(mgr.state()).toBe<SessionState>('busy')

      const result = mgr.setConfig({ effort: 'high' })

      expect(result).toEqual({ ok: true })
      expect(adapters[0]!.stopCalls).toBe(0) // no stop — safe mid-turn
      expect(adapters[0]!.setEffortCalls).toEqual(['high'])
      expect(mgr.state()).toBe<SessionState>('busy') // no respawn, no state change

      // A later respawn (watchdog fire) still threads the chosen effort to makeAdapter.
      vi.advanceTimersByTime(35)
      expect(adapters).toHaveLength(2)
      expect(adapters[1]!.effortReceived).toBe('high')
      expect(adapters[1]!.harnessReceived).toBe<HarnessId>('cursor')
    })

    it('claude-code (liveEffort: false) keeps the existing stop/reject-while-busy behavior', () => {
      const { adapters, opts } = makeHarness(dir)
      const mgr = new SessionManager(opts)

      mgr.notifyDesignEdits()
      adapters[0]!.emit({ kind: 'started', sessionId: 's1', model: 'claude', mcpLoaded: true })
      expect(mgr.state()).toBe<SessionState>('busy')

      const busyResult = mgr.setConfig({ effort: 'max' })
      expect(busyResult).toEqual({ ok: false, reason: 'busy' })
      expect(adapters[0]!.setEffortCalls).toEqual([])

      adapters[0]!.emit({ kind: 'turn-complete', isError: false }) // -> ready
      const readyResult = mgr.setConfig({ effort: 'max' })
      expect(readyResult).toEqual({ ok: true })
      expect(adapters[0]!.stopCalls).toBe(1)
      expect(mgr.state()).toBe<SessionState>('idle')
      expect(adapters[0]!.setEffortCalls).toEqual([]) // never called on the non-live path
    })
  })
})
