import { describe, it, expect, vi } from 'vitest'
import { PassThrough } from 'node:stream'
import {
  ClaudeAdapter,
  CLAUDE_ARGS,
  EDIT_TIER_ALLOW,
  EDIT_PAYLOAD_CAP,
  type SpawnFn,
  type SpawnedChild,
} from '../../../src/server/session/claude'
import type { SessionEvent } from '../../../src/server/session/adapter'
import {
  INIT_NO_MCP,
  INIT_WITH_MCP,
  INIT_MCP_ERROR,
  ASSISTANT_TEXT,
  ASSISTANT_TOOL_USE,
  ASSISTANT_MULTI_BLOCK,
  USER_TOOL_RESULT,
  RESULT_SUCCESS,
  RESULT_RATE_LIMIT,
  RESULT_AUTH_FAILURE,
  UNKNOWN_TYPE,
  UNPARSEABLE_LINE,
} from './fixtures/claude-ndjson'
import {
  STREAM_EVENT_MESSAGE_START,
  STREAM_EVENT_CONTENT_BLOCK_START_THINKING,
  STREAM_EVENT_CONTENT_BLOCK_DELTA_SIGNATURE,
  STREAM_EVENT_CONTENT_BLOCK_STOP_THINKING,
  STREAM_EVENT_CONTENT_BLOCK_START_TEXT,
  STREAM_EVENT_CONTENT_BLOCK_DELTA_TEXT,
  STREAM_EVENT_CONTENT_BLOCK_STOP_TEXT,
  STREAM_EVENT_MESSAGE_DELTA,
  STREAM_EVENT_MESSAGE_STOP,
  CONTROL_REQUEST_SET_MODEL,
  CONTROL_REQUEST_SET_PERMISSION_MODE,
} from './fixtures/claude-chat-ndjson'

// ---------------------------------------------------------------------------
// Fake SpawnFn — in-memory PassThrough streams; never spawns a real process.
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
  const killed: string[] = []

  return {
    stdin,
    stdout,
    stderr,
    _exitHandlers,
    _errorHandlers,
    kill(signal = 'SIGTERM') {
      killed.push(signal)
    },
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

function makeFakeSpawn(): { spawnFn: SpawnFn; lastChild: () => FakeChild; lastArgs: () => { cmd: string; args: string[]; cwd: string } } {
  let child!: FakeChild
  let lastCall!: { cmd: string; args: string[]; cwd: string }
  const spawnFn: SpawnFn = (cmd, args, opts) => {
    lastCall = { cmd, args, cwd: opts.cwd }
    child = makeChild()
    return child
  }
  return {
    spawnFn,
    lastChild: () => child,
    lastArgs: () => lastCall,
  }
}

// Collect all events synchronously after writing NDJSON lines to stdout.
function collectEvents(adapter: ClaudeAdapter): SessionEvent[] {
  const events: SessionEvent[] = []
  adapter.onEvent = (e) => events.push(e)
  return events
}

// Push a line to the child's stdout as NDJSON.
function pushLine(child: FakeChild, line: string) {
  child.stdout.write(line + '\n')
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('ClaudeAdapter', () => {
  describe('spawn contract', () => {
    it('spawns claude with the exact contract args and cwd', () => {
      const { spawnFn, lastArgs } = makeFakeSpawn()
      const adapter = new ClaudeAdapter(spawnFn)
      const events = collectEvents(adapter)
      adapter.start({ cwd: '/my/project' })

      const { cmd, args, cwd } = lastArgs()
      expect(cmd).toBe('claude')
      expect(cwd).toBe('/my/project')

      // Required flags
      expect(args).toContain('-p')
      expect(args).toContain('--input-format')
      expect(args[args.indexOf('--input-format') + 1]).toBe('stream-json')
      expect(args).toContain('--output-format')
      expect(args[args.indexOf('--output-format') + 1]).toBe('stream-json')
      expect(args).toContain('--verbose')
      expect(args).toContain('--permission-prompt-tool')
      expect(args[args.indexOf('--permission-prompt-tool') + 1]).toBe('mcp__the-forge__approve')
      expect(args).toContain('--allowedTools')

      // --bare must NEVER appear (it skips auth AND the harness, verified live 2026-07-09)
      expect(args).not.toContain('--bare')

      // --model must never be pinned — the user's own default model is used
      expect(args).not.toContain('--model')

      // No --resume when not given
      expect(args).not.toContain('--resume')

      void events
    })

    it('appends --resume <id> when resumeId is given', () => {
      const { spawnFn, lastArgs } = makeFakeSpawn()
      const adapter = new ClaudeAdapter(spawnFn)
      adapter.onEvent = () => {}
      adapter.start({ cwd: '/my/project', resumeId: 'abc-123' })

      const { args } = lastArgs()
      expect(args).toContain('--resume')
      expect(args[args.indexOf('--resume') + 1]).toBe('abc-123')
    })

    it('CLAUDE_ARGS includes all required flags and EDIT_TIER_ALLOW is the ratified set', () => {
      expect(CLAUDE_ARGS).toContain('-p')
      expect(CLAUDE_ARGS).toContain('--input-format')
      expect(CLAUDE_ARGS).toContain('--output-format')
      expect(CLAUDE_ARGS).toContain('--verbose')
      expect(CLAUDE_ARGS).toContain('--permission-prompt-tool')
      expect(CLAUDE_ARGS).not.toContain('--bare')
      // Required for stream_event text deltas (chat surface milestone B) — without this flag
      // the CLI never emits partial-message stream_event lines at all.
      expect(CLAUDE_ARGS).toContain('--include-partial-messages')
      // Pins the ratified overlay-gating posture against the user's global defaultMode:
      // without this, a user-level 'auto'/'bypassPermissions' mode auto-clears Bash
      // before the permission-prompt-tool is ever consulted (observed live, 2.1.201).
      const modeIdx = CLAUDE_ARGS.indexOf('--permission-mode')
      expect(modeIdx).toBeGreaterThan(-1)
      expect(CLAUDE_ARGS[modeIdx + 1]).toBe('default')

      expect(EDIT_TIER_ALLOW).toEqual([
        'Read',
        'Grep',
        'Glob',
        'Edit',
        'Write',
        'MultiEdit',
        'NotebookEdit',
        'TodoWrite',
        'mcp__the-forge__pull_design_edits',
        'mcp__the-forge__mark_applied',
      ])
    })
  })

  describe('event mapping', () => {
    it('maps non-init system lines (hook chatter) and unknown types to activity heartbeats', () => {
      // Verified live (CLI 2.1.201): boot emits ONLY system/hook_started lines for tens
      // of seconds. Without a liveness signal the watchdog would read a slow boot as a
      // stall and kill the child mid-boot.
      const { spawnFn, lastChild } = makeFakeSpawn()
      const adapter = new ClaudeAdapter(spawnFn)
      const events = collectEvents(adapter)
      adapter.start({ cwd: '/p' })

      pushLine(lastChild(), JSON.stringify({ type: 'system', subtype: 'hook_started', hook_id: 'h1' }))
      pushLine(lastChild(), JSON.stringify({ type: 'stream_event', event: {} }))

      expect(events).toEqual([{ kind: 'activity' }, { kind: 'activity' }])
    })

    it('maps init → started with mcpLoaded false when mcp_servers is empty', () => {
      const { spawnFn, lastChild } = makeFakeSpawn()
      const adapter = new ClaudeAdapter(spawnFn)
      const events = collectEvents(adapter)
      adapter.start({ cwd: '/p' })

      pushLine(lastChild(), INIT_NO_MCP)

      expect(events).toHaveLength(1)
      expect(events[0]).toEqual({
        kind: 'started',
        sessionId: '84e31d6e-e76c-42f8-afdc-c92a91baa3dc',
        model: 'claude-haiku-4-5-20251001',
        mcpLoaded: false,
      })
    })

    it('maps init → started with mcpLoaded true when mcp_servers contains the-forge', () => {
      const { spawnFn, lastChild } = makeFakeSpawn()
      const adapter = new ClaudeAdapter(spawnFn)
      const events = collectEvents(adapter)
      adapter.start({ cwd: '/p' })

      pushLine(lastChild(), INIT_WITH_MCP)

      expect(events).toHaveLength(1)
      expect(events[0]).toMatchObject({ kind: 'started', mcpLoaded: true })
    })

    it('maps init → started with mcpLoaded false when the-forge entry has an error status', () => {
      const { spawnFn, lastChild } = makeFakeSpawn()
      const adapter = new ClaudeAdapter(spawnFn)
      const events = collectEvents(adapter)
      adapter.start({ cwd: '/p' })

      pushLine(lastChild(), INIT_MCP_ERROR)

      expect(events).toHaveLength(1)
      expect(events[0]).toMatchObject({ kind: 'started', mcpLoaded: false })
    })

    it('maps assistant text block → assistant-text event', () => {
      const { spawnFn, lastChild } = makeFakeSpawn()
      const adapter = new ClaudeAdapter(spawnFn)
      const events = collectEvents(adapter)
      adapter.start({ cwd: '/p' })

      pushLine(lastChild(), ASSISTANT_TEXT)

      expect(events).toHaveLength(1)
      expect(events[0]).toEqual({ kind: 'assistant-text', text: 'I will update the file for you.' })
    })

    it('maps assistant tool_use block → tool-started with file_path detail', () => {
      const { spawnFn, lastChild } = makeFakeSpawn()
      const adapter = new ClaudeAdapter(spawnFn)
      const events = collectEvents(adapter)
      adapter.start({ cwd: '/p' })

      pushLine(lastChild(), ASSISTANT_TOOL_USE)

      expect(events).toHaveLength(1)
      expect(events[0]).toEqual({
        kind: 'tool-started',
        toolId: 'toolu_1',
        name: 'Edit',
        detail: 'src/App.tsx',
      })
    })

    it('emits multiple events in order for multi-block assistant messages', () => {
      const { spawnFn, lastChild } = makeFakeSpawn()
      const adapter = new ClaudeAdapter(spawnFn)
      const events = collectEvents(adapter)
      adapter.start({ cwd: '/p' })

      pushLine(lastChild(), ASSISTANT_MULTI_BLOCK)

      expect(events).toHaveLength(3)
      expect(events[0]).toEqual({ kind: 'assistant-text', text: 'First block.' })
      expect(events[1]).toMatchObject({ kind: 'tool-started', toolId: 'toolu_2' })
      expect(events[2]).toEqual({ kind: 'assistant-text', text: 'Second block.' })
    })

    it('pairs user tool_result → tool-finished by tool_use_id', () => {
      const { spawnFn, lastChild } = makeFakeSpawn()
      const adapter = new ClaudeAdapter(spawnFn)
      const events = collectEvents(adapter)
      adapter.start({ cwd: '/p' })

      pushLine(lastChild(), USER_TOOL_RESULT)

      expect(events).toHaveLength(1)
      expect(events[0]).toEqual({ kind: 'tool-finished', toolId: 'toolu_1' })
    })

    it('maps result success → turn-complete {isError:false, costUsd}', () => {
      const { spawnFn, lastChild } = makeFakeSpawn()
      const adapter = new ClaudeAdapter(spawnFn)
      const events = collectEvents(adapter)
      adapter.start({ cwd: '/p' })

      pushLine(lastChild(), RESULT_SUCCESS)

      expect(events).toHaveLength(1)
      expect(events[0]).toEqual({
        kind: 'turn-complete',
        isError: false,
        costUsd: 0.0034,
      })
    })

    it('maps in-band rate-limit result → turn-complete {isError:true, errorText contains "weekly limit"} (NOT session-error)', () => {
      const { spawnFn, lastChild } = makeFakeSpawn()
      const adapter = new ClaudeAdapter(spawnFn)
      const events = collectEvents(adapter)
      adapter.start({ cwd: '/p' })

      pushLine(lastChild(), RESULT_RATE_LIMIT)

      expect(events).toHaveLength(1)
      const ev = events[0]
      expect(ev.kind).toBe('turn-complete')
      if (ev.kind === 'turn-complete') {
        expect(ev.isError).toBe(true)
        expect(ev.errorText).toContain('weekly limit')
        // Must NOT be a session-error — in-band errors arrive with exit 0 via the result event
      }
    })

    it('maps auth-failure result → turn-complete {isError:true, errorText contains "Not logged in"}', () => {
      const { spawnFn, lastChild } = makeFakeSpawn()
      const adapter = new ClaudeAdapter(spawnFn)
      const events = collectEvents(adapter)
      adapter.start({ cwd: '/p' })

      pushLine(lastChild(), RESULT_AUTH_FAILURE)

      expect(events).toHaveLength(1)
      const ev = events[0]
      expect(ev.kind).toBe('turn-complete')
      if (ev.kind === 'turn-complete') {
        expect(ev.isError).toBe(true)
        expect(ev.errorText).toContain('Not logged in')
      }
    })
  })

  describe('stream_event deltas (--include-partial-messages)', () => {
    it('maps stream_event text delta → assistant-delta (fixture)', () => {
      const { spawnFn, lastChild } = makeFakeSpawn()
      const adapter = new ClaudeAdapter(spawnFn)
      const events = collectEvents(adapter)
      adapter.start({ cwd: '/p' })

      pushLine(lastChild(), STREAM_EVENT_CONTENT_BLOCK_DELTA_TEXT)

      expect(events).toEqual([{ kind: 'assistant-delta', text: 'Octopuses have three h' }])
    })

    it('maps every other stream_event in a full turn envelope to activity (fixture)', () => {
      // Full observed envelope (fixtures/claude-chat-ndjson.ts) minus the one text_delta
      // line — message_start, thinking block open/delta/close, text block open/close,
      // message_delta, message_stop. None of these carry chat text; all must fall to the
      // same liveness heartbeat as an unrecognized top-level type.
      const { spawnFn, lastChild } = makeFakeSpawn()
      const adapter = new ClaudeAdapter(spawnFn)
      const events = collectEvents(adapter)
      adapter.start({ cwd: '/p' })

      const lines = [
        STREAM_EVENT_MESSAGE_START,
        STREAM_EVENT_CONTENT_BLOCK_START_THINKING,
        STREAM_EVENT_CONTENT_BLOCK_DELTA_SIGNATURE,
        STREAM_EVENT_CONTENT_BLOCK_STOP_THINKING,
        STREAM_EVENT_CONTENT_BLOCK_START_TEXT,
        STREAM_EVENT_CONTENT_BLOCK_STOP_TEXT,
        STREAM_EVENT_MESSAGE_DELTA,
        STREAM_EVENT_MESSAGE_STOP,
      ]
      for (const line of lines) pushLine(lastChild(), line)

      expect(events).toEqual(lines.map(() => ({ kind: 'activity' })))
    })
  })

  describe('tool_use edit payloads', () => {
    it('Edit tool_use → edit payload, each side truncated at EDIT_PAYLOAD_CAP', () => {
      const before = 'b'.repeat(EDIT_PAYLOAD_CAP + 50)
      const after = 'a'.repeat(EDIT_PAYLOAD_CAP + 50)
      const line = JSON.stringify({
        type: 'assistant',
        message: {
          role: 'assistant',
          content: [
            {
              type: 'tool_use',
              id: 'toolu_e1',
              name: 'Edit',
              input: { file_path: 'src/App.tsx', old_string: before, new_string: after },
            },
          ],
        },
      })

      const { spawnFn, lastChild } = makeFakeSpawn()
      const adapter = new ClaudeAdapter(spawnFn)
      const events = collectEvents(adapter)
      adapter.start({ cwd: '/p' })
      pushLine(lastChild(), line)

      expect(events).toHaveLength(1)
      const ev = events[0]
      expect(ev.kind).toBe('tool-started')
      if (ev.kind === 'tool-started') {
        expect(ev.edit).toBeDefined()
        expect(ev.edit?.file).toBe('src/App.tsx')
        expect(ev.edit?.before.length).toBe(EDIT_PAYLOAD_CAP + 1)
        expect(ev.edit?.before.endsWith('…')).toBe(true)
        expect(ev.edit?.after.length).toBe(EDIT_PAYLOAD_CAP + 1)
        expect(ev.edit?.after.endsWith('…')).toBe(true)
      }
    })

    it('MultiEdit tool_use → edit payload (same old_string/new_string mapping as Edit)', () => {
      const line = JSON.stringify({
        type: 'assistant',
        message: {
          role: 'assistant',
          content: [
            {
              type: 'tool_use',
              id: 'toolu_m1',
              name: 'MultiEdit',
              input: { file_path: 'src/App.tsx', old_string: 'old', new_string: 'new' },
            },
          ],
        },
      })

      const { spawnFn, lastChild } = makeFakeSpawn()
      const adapter = new ClaudeAdapter(spawnFn)
      const events = collectEvents(adapter)
      adapter.start({ cwd: '/p' })
      pushLine(lastChild(), line)

      expect(events).toHaveLength(1)
      const ev = events[0]
      expect(ev.kind).toBe('tool-started')
      if (ev.kind === 'tool-started') {
        expect(ev.edit).toEqual({ file: 'src/App.tsx', before: 'old', after: 'new' })
      }
    })

    it('Write tool_use → edit payload with before empty, after from content', () => {
      const line = JSON.stringify({
        type: 'assistant',
        message: {
          role: 'assistant',
          content: [
            {
              type: 'tool_use',
              id: 'toolu_w1',
              name: 'Write',
              input: { file_path: 'src/new.ts', content: 'export const x = 1\n' },
            },
          ],
        },
      })

      const { spawnFn, lastChild } = makeFakeSpawn()
      const adapter = new ClaudeAdapter(spawnFn)
      const events = collectEvents(adapter)
      adapter.start({ cwd: '/p' })
      pushLine(lastChild(), line)

      expect(events).toHaveLength(1)
      const ev = events[0]
      expect(ev.kind).toBe('tool-started')
      if (ev.kind === 'tool-started') {
        expect(ev.edit).toEqual({ file: 'src/new.ts', before: '', after: 'export const x = 1\n' })
      }
    })

    it('Edit tool_use missing old_string/new_string → no edit field (never throws)', () => {
      const line = JSON.stringify({
        type: 'assistant',
        message: {
          role: 'assistant',
          content: [
            { type: 'tool_use', id: 'toolu_e2', name: 'Edit', input: { file_path: 'src/App.tsx' } },
          ],
        },
      })

      const { spawnFn, lastChild } = makeFakeSpawn()
      const adapter = new ClaudeAdapter(spawnFn)
      const events = collectEvents(adapter)
      adapter.start({ cwd: '/p' })
      expect(() => pushLine(lastChild(), line)).not.toThrow()

      expect(events).toHaveLength(1)
      const ev = events[0]
      expect(ev.kind).toBe('tool-started')
      if (ev.kind === 'tool-started') {
        expect(ev.edit).toBeUndefined()
      }
    })

    it('Write tool_use missing content → no edit field (never throws)', () => {
      const line = JSON.stringify({
        type: 'assistant',
        message: {
          role: 'assistant',
          content: [
            { type: 'tool_use', id: 'toolu_w2', name: 'Write', input: { file_path: 'src/new.ts' } },
          ],
        },
      })

      const { spawnFn, lastChild } = makeFakeSpawn()
      const adapter = new ClaudeAdapter(spawnFn)
      const events = collectEvents(adapter)
      adapter.start({ cwd: '/p' })
      pushLine(lastChild(), line)

      expect(events).toHaveLength(1)
      const ev = events[0]
      expect(ev.kind).toBe('tool-started')
      if (ev.kind === 'tool-started') {
        expect(ev.edit).toBeUndefined()
      }
    })
  })

  describe('config control requests (setModel / setPermissionMode / setEffort)', () => {
    it('setModel writes the CLI control-request shape (fixture) with a fresh request_id', () => {
      const { spawnFn, lastChild } = makeFakeSpawn()
      const adapter = new ClaudeAdapter(spawnFn)
      adapter.onEvent = () => {}
      adapter.start({ cwd: '/p' })

      const written: string[] = []
      lastChild().stdin.on('data', (chunk: Buffer) => written.push(chunk.toString()))

      adapter.setModel('claude-haiku-4-5-20251001')

      const parsed = JSON.parse(written.join('').trim())
      const fixture = JSON.parse(CONTROL_REQUEST_SET_MODEL)
      expect(parsed.type).toBe(fixture.type)
      expect(parsed.request).toEqual(fixture.request)
      // request_id is generated per-call (uuid), not the fixture's recorded value.
      expect(typeof parsed.request_id).toBe('string')
      expect(parsed.request_id.length).toBeGreaterThan(0)
    })

    it('setPermissionMode writes the CLI control-request shape (fixture) with a fresh request_id', () => {
      const { spawnFn, lastChild } = makeFakeSpawn()
      const adapter = new ClaudeAdapter(spawnFn)
      adapter.onEvent = () => {}
      adapter.start({ cwd: '/p' })

      const written: string[] = []
      lastChild().stdin.on('data', (chunk: Buffer) => written.push(chunk.toString()))

      adapter.setPermissionMode('acceptEdits')

      const parsed = JSON.parse(written.join('').trim())
      const fixture = JSON.parse(CONTROL_REQUEST_SET_PERMISSION_MODE)
      expect(parsed.type).toBe(fixture.type)
      expect(parsed.request).toEqual(fixture.request)
      expect(typeof parsed.request_id).toBe('string')
      expect(parsed.request_id.length).toBeGreaterThan(0)
    })

    it('after stop(), setModel and setPermissionMode write nothing to stdin', () => {
      const { spawnFn, lastChild } = makeFakeSpawn()
      const adapter = new ClaudeAdapter(spawnFn)
      adapter.onEvent = () => {}
      adapter.start({ cwd: '/p' })

      const written: string[] = []
      lastChild().stdin.on('data', (chunk: Buffer) => written.push(chunk.toString()))

      adapter.stop()
      adapter.setModel('claude-haiku-4-5-20251001')
      adapter.setPermissionMode('acceptEdits')

      expect(written).toHaveLength(0)
    })

    it('setEffort is a no-op — no control request exists (spike-confirmed); respawn is manager-owned', () => {
      const { spawnFn, lastChild } = makeFakeSpawn()
      const adapter = new ClaudeAdapter(spawnFn)
      adapter.onEvent = () => {}
      adapter.start({ cwd: '/p' })

      const written: string[] = []
      lastChild().stdin.on('data', (chunk: Buffer) => written.push(chunk.toString()))

      expect(() => adapter.setEffort('high')).not.toThrow()
      expect(written).toHaveLength(0)
    })
  })

  describe('NDJSON splitter', () => {
    it('handles a fixture line split across two chunk writes', () => {
      const { spawnFn, lastChild } = makeFakeSpawn()
      const adapter = new ClaudeAdapter(spawnFn)
      const events = collectEvents(adapter)
      adapter.start({ cwd: '/p' })

      // Split INIT_NO_MCP at the midpoint — no newline in first chunk
      const mid = Math.floor(INIT_NO_MCP.length / 2)
      lastChild().stdout.write(INIT_NO_MCP.slice(0, mid))
      // Nothing emitted yet — line is incomplete
      expect(events).toHaveLength(0)
      // Complete the line
      lastChild().stdout.write(INIT_NO_MCP.slice(mid) + '\n')
      expect(events).toHaveLength(1)
      expect(events[0]).toMatchObject({ kind: 'started' })
    })

    it('handles multiple lines in one chunk', () => {
      const { spawnFn, lastChild } = makeFakeSpawn()
      const adapter = new ClaudeAdapter(spawnFn)
      const events = collectEvents(adapter)
      adapter.start({ cwd: '/p' })

      lastChild().stdout.write(INIT_NO_MCP + '\n' + ASSISTANT_TEXT + '\n')
      expect(events).toHaveLength(2)
      expect(events[0]).toMatchObject({ kind: 'started' })
      expect(events[1]).toMatchObject({ kind: 'assistant-text' })
    })
  })

  describe('unknown / unparseable lines', () => {
    it('maps unknown event types to activity, never rendered kinds (forward-compat)', () => {
      const { spawnFn, lastChild } = makeFakeSpawn()
      const adapter = new ClaudeAdapter(spawnFn)
      const events = collectEvents(adapter)
      adapter.start({ cwd: '/p' })

      pushLine(lastChild(), UNKNOWN_TYPE)
      // A parsed-but-unknown protocol line proves the child is alive (watchdog liveness)
      // without leaking unknown shapes into the feed.
      expect(events).toEqual([{ kind: 'activity' }])
    })

    it('ignores unparseable lines silently', () => {
      const { spawnFn, lastChild } = makeFakeSpawn()
      const adapter = new ClaudeAdapter(spawnFn)
      const events = collectEvents(adapter)
      adapter.start({ cwd: '/p' })

      pushLine(lastChild(), UNPARSEABLE_LINE)
      expect(events).toHaveLength(0)
    })
  })

  describe('sendTurn / interrupt', () => {
    it('sendTurn writes the exact stdin JSON line', () => {
      const { spawnFn, lastChild } = makeFakeSpawn()
      const adapter = new ClaudeAdapter(spawnFn)
      adapter.onEvent = () => {}
      adapter.start({ cwd: '/p' })

      const written: string[] = []
      lastChild().stdin.on('data', (chunk: Buffer) => written.push(chunk.toString()))

      adapter.sendTurn('hello world')

      const line = written.join('')
      const parsed = JSON.parse(line.trim())
      expect(parsed).toEqual({
        type: 'user',
        message: { role: 'user', content: [{ type: 'text', text: 'hello world' }] },
      })
    })

    it('interrupt writes the exact stdin JSON line with a uuid request_id', () => {
      const { spawnFn, lastChild } = makeFakeSpawn()
      const adapter = new ClaudeAdapter(spawnFn)
      adapter.onEvent = () => {}
      adapter.start({ cwd: '/p' })

      const written: string[] = []
      lastChild().stdin.on('data', (chunk: Buffer) => written.push(chunk.toString()))

      adapter.interrupt()

      const line = written.join('')
      const parsed = JSON.parse(line.trim())
      expect(parsed.type).toBe('control_request')
      expect(parsed.request).toEqual({ subtype: 'interrupt' })
      // request_id must be a non-empty string (uuid)
      expect(typeof parsed.request_id).toBe('string')
      expect(parsed.request_id.length).toBeGreaterThan(0)
    })

    it('after stop(), sendTurn and interrupt write nothing to stdin', () => {
      const { spawnFn, lastChild } = makeFakeSpawn()
      const adapter = new ClaudeAdapter(spawnFn)
      adapter.onEvent = () => {}
      adapter.start({ cwd: '/p' })

      const written: string[] = []
      lastChild().stdin.on('data', (chunk: Buffer) => written.push(chunk.toString()))

      adapter.stop()
      adapter.sendTurn('too late')
      adapter.interrupt()

      expect(written).toHaveLength(0)
    })
  })

  describe('child process lifecycle', () => {
    it('child exit → ended event', () => {
      const { spawnFn, lastChild } = makeFakeSpawn()
      const adapter = new ClaudeAdapter(spawnFn)
      const events = collectEvents(adapter)
      adapter.start({ cwd: '/p' })

      lastChild().simulateExit(0)

      expect(events).toHaveLength(1)
      expect(events[0]).toEqual({ kind: 'ended' })
    })

    it('spawn error → session-error then ended', () => {
      const { spawnFn, lastChild } = makeFakeSpawn()
      const adapter = new ClaudeAdapter(spawnFn)
      const events = collectEvents(adapter)
      adapter.start({ cwd: '/p' })

      lastChild().simulateError(new Error('ENOENT spawn failed'))

      expect(events).toHaveLength(2)
      expect(events[0]).toMatchObject({ kind: 'session-error' })
      if (events[0].kind === 'session-error') {
        expect(events[0].text).toContain('ENOENT')
      }
      expect(events[1]).toEqual({ kind: 'ended' })
    })

    it('stop() is idempotent — calling twice does not emit duplicate ended events', () => {
      const { spawnFn, lastChild } = makeFakeSpawn()
      const adapter = new ClaudeAdapter(spawnFn)
      const events = collectEvents(adapter)
      adapter.start({ cwd: '/p' })

      adapter.stop()
      adapter.stop()

      // stop() kills the child; simulate exit to flush lifecycle
      lastChild().simulateExit(null)

      // At most one ended event (the exit handler runs once)
      const ended = events.filter((e) => e.kind === 'ended')
      expect(ended).toHaveLength(1)
    })

    it('after stop(), late stdout events are ignored', () => {
      const { spawnFn, lastChild } = makeFakeSpawn()
      const adapter = new ClaudeAdapter(spawnFn)
      const events = collectEvents(adapter)
      adapter.start({ cwd: '/p' })

      adapter.stop()
      lastChild().simulateExit(0)

      // Now push a line — must be ignored because the adapter is closed
      pushLine(lastChild(), INIT_NO_MCP)

      const sessionEvents = events.filter((e) => e.kind === 'started')
      expect(sessionEvents).toHaveLength(0)
    })
  })
})
