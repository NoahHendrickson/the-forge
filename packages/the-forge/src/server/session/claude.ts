import { spawn } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import type { SessionAdapter, SessionEvent } from './adapter'

export interface SpawnedChild {
  stdin: { write(s: string): void; end(): void }
  stdout: NodeJS.ReadableStream
  stderr: NodeJS.ReadableStream
  kill(signal?: string): void
  on(ev: 'exit' | 'error', fn: (...a: unknown[]) => void): void
}

export type SpawnFn = (cmd: string, args: string[], opts: { cwd: string }) => SpawnedChild

// The ratified "edits auto, Bash prompts" posture: static allow rules short-circuit the
// permission-prompt-tool; everything else (Bash, etc.) reaches mcp__the-forge__approve.
export const EDIT_TIER_ALLOW: string[] = [
  'Read',
  'Grep',
  'Glob',
  'Edit',
  'Write',
  'MultiEdit',
  // NotebookEdit is the same tier as Edit/Write. TODO(scoping, surfaced for Noah in the PR
  // body): these bare rule names are PATH-UNSCOPED — Claude Code's allow rules only support
  // path scoping via a glob suffix (e.g. 'Edit(src/**)'), which none of these use, so this
  // list auto-approves an edit/write ANYWHERE the CLI process can reach, not just inside the
  // project the design-mode session was started against — including files outside the repo
  // entirely, e.g. ~/.claude/settings.json. That's the ratified "edits auto, Bash prompts"
  // posture as actually implemented today, not a project-scoped guarantee; narrowing these to
  // project-relative globs is an open decision, not yet made. TodoWrite is the CLI's own
  // scratchpad, used habitually in headless turns — prompting a designer with Allow/Deny for
  // it would be pure noise (and each prompt parks up to 110s in the overlay).
  'NotebookEdit',
  'TodoWrite',
  'mcp__the-forge__pull_design_edits',
  'mcp__the-forge__mark_applied',
]

// Validated live 2026-07-09 against CLI 2.1.201.
// --bare must NEVER be added: it skips auth AND the stream-json harness, confirmed broken in
// the live smoke test. --resume is not included here; start() appends it when needed.
// --model is omitted intentionally: the user's own default model is used, not a pinned one.
// --permission-mode default pins the ratified overlay-gating posture against the user's own
// global defaultMode: observed live (2.1.201), a user-level 'auto' mode auto-clears Bash
// before the permission-prompt-tool is ever consulted — the overlay Allow/Deny would simply
// never appear. Sandboxed safe commands (echo, ls) still run without prompting in EVERY
// mode; that's the CLI's own sandbox tier, not a gap in the gate.
// --include-partial-messages (milestone B, chat surface): without it the CLI never emits
// stream_event lines at all, so text deltas would only ever arrive as whole finished
// `assistant` messages — this flag is what turns on token-by-token streaming.
export const CLAUDE_ARGS: string[] = [
  '-p',
  '--input-format',
  'stream-json',
  '--output-format',
  'stream-json',
  '--verbose',
  '--include-partial-messages',
  '--permission-mode',
  'default',
  '--permission-prompt-tool',
  'mcp__the-forge__approve',
  '--allowedTools',
  EDIT_TIER_ALLOW.join(','),
]

// Edit/MultiEdit/Write tool_use payloads can carry arbitrarily large before/after strings
// (a full file rewrite via Write, e.g.) — cap each side so a single tool call can't blow up
// the ring buffer or the wire payload to the browser. Truncation is a display concern only;
// the CLI still has the real file on disk regardless of what the panel shows.
export const EDIT_PAYLOAD_CAP = 1_500

// Exported so CursorAdapter (and any future harness adapter) reuses the ONE truncation
// policy instead of copying it — the cap is a shared wire/ring-buffer budget, not a
// Claude-specific detail.
export function truncateEditSide(s: string): string {
  return s.length > EDIT_PAYLOAD_CAP ? s.slice(0, EDIT_PAYLOAD_CAP) + '…' : s
}

// Edit/MultiEdit → {file, before: old_string, after: new_string}; Write → {file, before: '',
// after: content}. Absent/malformed `input` fields (a future CLI version renaming a field, a
// tool_use block from an unrelated tool) must never throw — they just produce no edit payload,
// same forward-compat posture as the rest of processLine's manual field checks.
function buildEditPayload(
  name: string,
  input: Record<string, unknown>,
): { file: string; before: string; after: string } | undefined {
  const file = input['file_path']
  if (typeof file !== 'string') return undefined

  if (name === 'Edit' || name === 'MultiEdit') {
    const before = input['old_string']
    const after = input['new_string']
    if (typeof before !== 'string' || typeof after !== 'string') return undefined
    return { file, before: truncateEditSide(before), after: truncateEditSide(after) }
  }

  if (name === 'Write') {
    const content = input['content']
    if (typeof content !== 'string') return undefined
    return { file, before: '', after: truncateEditSide(content) }
  }

  return undefined
}

function defaultSpawnFn(cmd: string, args: string[], opts: { cwd: string }): SpawnedChild {
  // spawn with pipe stdio so stdin/stdout/stderr are always present (never null)
  const child = spawn(cmd, args, { cwd: opts.cwd, stdio: ['pipe', 'pipe', 'pipe'] })
  return child as unknown as SpawnedChild
}

export class ClaudeAdapter implements SessionAdapter {
  onEvent: (e: SessionEvent) => void = () => {}

  private readonly spawnFn: SpawnFn
  // Spike verdict (Task 1, confirmed live CLI 2.1.201): effort has no set_effort control
  // request — it's a spawn-flag-only knob (`--effort <level>`). A manager-owned effort
  // change therefore kills this adapter and constructs a FRESH one via makeAdapter(opts)
  // (manager.ts's per-spawn factory pattern) rather than mutating a live instance, so the
  // flag is captured once here at construction time and applied in start()'s args.
  private readonly effort: string | undefined
  private child: SpawnedChild | null = null
  // closed: set on stop() — prevents processing late stdout events after stop()
  private closed = false
  // didEnd: ensures the 'ended' event is emitted exactly once
  private didEnd = false
  // stderrBuf: last ~500 chars of stderr, included in spawn-error/exit text if nonempty
  private stderrBuf = ''

  constructor(spawnFn: SpawnFn = defaultSpawnFn, opts?: { effort?: string }) {
    this.spawnFn = spawnFn
    this.effort = opts?.effort
  }

  start(opts: { cwd: string; resumeId?: string }): void {
    const args = [...CLAUDE_ARGS]
    if (opts.resumeId) {
      args.push('--resume', opts.resumeId)
    }
    if (this.effort) {
      args.push('--effort', this.effort)
    }

    const child = this.spawnFn('claude', args, { cwd: opts.cwd })
    this.child = child

    let lineBuf = ''
    child.stdout.on('data', (chunk: Buffer | string) => {
      if (this.closed) return
      lineBuf += typeof chunk === 'string' ? chunk : chunk.toString('utf8')
      let nl: number
      while ((nl = lineBuf.indexOf('\n')) !== -1) {
        const line = lineBuf.slice(0, nl)
        lineBuf = lineBuf.slice(nl + 1)
        this.processLine(line)
      }
    })

    child.stderr.on('data', (chunk: Buffer | string) => {
      this.stderrBuf += typeof chunk === 'string' ? chunk : chunk.toString('utf8')
      if (this.stderrBuf.length > 500) {
        this.stderrBuf = this.stderrBuf.slice(-500)
      }
    })

    child.on('exit', () => {
      if (this.didEnd) return
      this.didEnd = true
      this.onEvent({ kind: 'ended' })
    })

    child.on('error', (err: unknown) => {
      const base = err instanceof Error ? err.message : String(err)
      const text = this.stderrBuf ? `${base} [stderr: ${this.stderrBuf}]` : base
      this.onEvent({ kind: 'session-error', text })
      if (this.didEnd) return
      this.didEnd = true
      this.onEvent({ kind: 'ended' })
    })
  }

  sendTurn(text: string): void {
    // closed guard: stop() has SIGTERM'd the child — writing to its stdin would be a no-op
    // at best and an EPIPE at worst.
    if (!this.child || this.closed) return
    const msg = {
      type: 'user',
      message: { role: 'user', content: [{ type: 'text', text }] },
    }
    this.child.stdin.write(JSON.stringify(msg) + '\n')
  }

  interrupt(): void {
    if (!this.child || this.closed) return
    const msg = {
      type: 'control_request',
      request_id: randomUUID(),
      request: { subtype: 'interrupt' },
    }
    this.child.stdin.write(JSON.stringify(msg) + '\n')
  }

  setModel(model: string): void {
    if (!this.child || this.closed) return
    // Ack carries NO echo of the applied model (confirmed live, CLI 2.1.201) — confirmation
    // that the change landed has to come from the model field of a later assistant/result
    // event, not from this control_response.
    const msg = {
      type: 'control_request',
      request_id: randomUUID(),
      request: { subtype: 'set_model', model },
    }
    this.child.stdin.write(JSON.stringify(msg) + '\n')
  }

  setPermissionMode(mode: string): void {
    if (!this.child || this.closed) return
    const msg = {
      type: 'control_request',
      request_id: randomUUID(),
      request: { subtype: 'set_permission_mode', mode },
    }
    this.child.stdin.write(JSON.stringify(msg) + '\n')
  }

  // No-op by design: CONFIRMED live (CLI 2.1.201) there is no set_effort control_request
  // subtype — the CLI answers any unknown subtype with a generic "Unsupported control
  // request subtype" error, tried with both 'set_effort' and a nonsense subtype (see
  // CONTROL_RESPONSE_SET_EFFORT_UNSUPPORTED in tests/server/session/fixtures/claude-chat-
  // ndjson.ts). Effort is spawn-flag-only (`--effort <level>`), so changing it mid-session
  // means the manager killing this child and respawning with `--resume <session_id>
  // --effort <level>` — that's Task 3's respawn branch, not a stdin write here.
  setEffort(_level: string): void {
    // Intentionally empty.
  }

  stop(): void {
    if (this.closed) return
    this.closed = true
    if (this.child) {
      this.child.kill('SIGTERM')
    }
  }

  private processLine(line: string): void {
    if (this.closed) return
    const trimmed = line.trim()
    if (!trimmed) return

    let parsed: unknown
    try {
      parsed = JSON.parse(trimmed)
    } catch {
      return // unparseable lines are ignored (forward-compat)
    }

    if (typeof parsed !== 'object' || parsed === null) return
    const obj = parsed as Record<string, unknown>
    const type = obj['type']

    switch (type) {
      case 'system': {
        if (obj['subtype'] !== 'init') {
          // hook_started/hook_response/etc. — boot emits ONLY these for tens of seconds
          // (verified live); surface as liveness so the watchdog doesn't read a slow
          // boot as a stall. Never rendered.
          this.onEvent({ kind: 'activity' })
          return
        }
        const sessionId = typeof obj['session_id'] === 'string' ? obj['session_id'] : ''
        const model = typeof obj['model'] === 'string' ? obj['model'] : ''
        const servers = Array.isArray(obj['mcp_servers']) ? obj['mcp_servers'] : []
        // Health check by unhealthy-exclusion rather than a healthy allowlist: the CLI's
        // status vocabulary isn't pinned in docs, so an allowlist ('connected') would wrongly
        // report false on a new-but-healthy value; 'error'/'disconnected' are the known
        // definitively-broken states.
        const mcpLoaded = servers.some((s: unknown) => {
          if (typeof s !== 'object' || s === null) return false
          const entry = s as Record<string, unknown>
          if (entry['name'] !== 'the-forge') return false
          return entry['status'] !== 'error' && entry['status'] !== 'disconnected'
        })
        this.onEvent({ kind: 'started', sessionId, model, mcpLoaded })
        return
      }

      case 'assistant': {
        const msg = obj['message']
        if (typeof msg !== 'object' || msg === null) return
        const content = (msg as Record<string, unknown>)['content']
        if (!Array.isArray(content)) return
        for (const block of content) {
          if (typeof block !== 'object' || block === null) continue
          const b = block as Record<string, unknown>
          if (b['type'] === 'text') {
            this.onEvent({
              kind: 'assistant-text',
              text: typeof b['text'] === 'string' ? b['text'] : '',
            })
          } else if (b['type'] === 'tool_use') {
            const toolId = typeof b['id'] === 'string' ? b['id'] : ''
            const name = typeof b['name'] === 'string' ? b['name'] : ''
            const input =
              typeof b['input'] === 'object' && b['input'] !== null
                ? (b['input'] as Record<string, unknown>)
                : {}
            const rawDetail =
              typeof input['file_path'] === 'string'
                ? input['file_path']
                : typeof input['command'] === 'string'
                  ? input['command']
                  : ''
            const edit = buildEditPayload(name, input)
            this.onEvent({
              kind: 'tool-started',
              toolId,
              name,
              detail: rawDetail.slice(0, 120),
              ...(edit ? { edit } : {}),
            })
          }
        }
        return
      }

      case 'user': {
        const msg = obj['message']
        if (typeof msg !== 'object' || msg === null) return
        const content = (msg as Record<string, unknown>)['content']
        if (!Array.isArray(content)) return
        for (const block of content) {
          if (typeof block !== 'object' || block === null) continue
          const b = block as Record<string, unknown>
          if (b['type'] === 'tool_result') {
            const toolId = typeof b['tool_use_id'] === 'string' ? b['tool_use_id'] : ''
            this.onEvent({ kind: 'tool-finished', toolId })
          }
        }
        return
      }

      case 'result': {
        const isError = obj['is_error'] === true
        const costUsd =
          typeof obj['total_cost_usd'] === 'number' ? obj['total_cost_usd'] : undefined
        // In-band errors (rate-limit 429, auth failures) arrive here as result events with
        // is_error:true and exit code 0 — they must NOT emit session-error; the turn-complete
        // event is the correct completion signal so the overlay can display the error text.
        if (isError) {
          const errorText = typeof obj['result'] === 'string' ? obj['result'] : undefined
          this.onEvent({ kind: 'turn-complete', isError, errorText, costUsd })
        } else {
          this.onEvent({ kind: 'turn-complete', isError, costUsd })
        }
        return
      }

      case 'stream_event': {
        // --include-partial-messages turns these on. Only a text_delta carries chat text
        // (thinking-block signature_delta, message_start/stop, content_block_start/stop,
        // message_delta are all structural — see fixtures/claude-chat-ndjson.ts §Step 1 for
        // the full observed envelope); everything else here falls through to the same
        // liveness heartbeat as an unrecognized top-level type, same as before this case
        // existed. The final complete `assistant` text block still arrives separately
        // (assistant-text, above) — deltas are a preview only, never the source of truth.
        const event = obj['event']
        if (typeof event === 'object' && event !== null) {
          const ev = event as Record<string, unknown>
          if (ev['type'] === 'content_block_delta') {
            const delta = ev['delta']
            if (typeof delta === 'object' && delta !== null) {
              const d = delta as Record<string, unknown>
              if (d['type'] === 'text_delta') {
                this.onEvent({
                  kind: 'assistant-delta',
                  text: typeof d['text'] === 'string' ? d['text'] : '',
                })
                return
              }
            }
          }
        }
        this.onEvent({ kind: 'activity' })
        return
      }

      default:
        // Unknown types (control_response, etc.) — not rendered, but any parsed protocol
        // line proves the child is alive: emit liveness for the watchdog. Same forward-compat
        // posture as the client's untyped-JSON guards.
        this.onEvent({ kind: 'activity' })
        return
    }
  }
}
