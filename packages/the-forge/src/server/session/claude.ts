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
  // NotebookEdit is the same tier as Edit/Write (a project-scoped file edit). TodoWrite is
  // the CLI's own scratchpad, used habitually in headless turns — prompting a designer with
  // Allow/Deny for it would be pure noise (and each prompt parks up to 110s in the overlay).
  'NotebookEdit',
  'TodoWrite',
  'mcp__the-forge__pull_design_edits',
  'mcp__the-forge__mark_applied',
]

// Validated live 2026-07-09 against CLI 2.1.201.
// --bare must NEVER be added: it skips auth AND the stream-json harness, confirmed broken in
// the live smoke test. --resume is not included here; start() appends it when needed.
// --model is omitted intentionally: the user's own default model is used, not a pinned one.
export const CLAUDE_ARGS: string[] = [
  '-p',
  '--input-format',
  'stream-json',
  '--output-format',
  'stream-json',
  '--verbose',
  '--permission-prompt-tool',
  'mcp__the-forge__approve',
  '--allowedTools',
  EDIT_TIER_ALLOW.join(','),
]

function defaultSpawnFn(cmd: string, args: string[], opts: { cwd: string }): SpawnedChild {
  // spawn with pipe stdio so stdin/stdout/stderr are always present (never null)
  const child = spawn(cmd, args, { cwd: opts.cwd, stdio: ['pipe', 'pipe', 'pipe'] })
  return child as unknown as SpawnedChild
}

export class ClaudeAdapter implements SessionAdapter {
  onEvent: (e: SessionEvent) => void = () => {}

  private readonly spawnFn: SpawnFn
  private child: SpawnedChild | null = null
  // closed: set on stop() — prevents processing late stdout events after stop()
  private closed = false
  // didEnd: ensures the 'ended' event is emitted exactly once
  private didEnd = false
  // stderrBuf: last ~500 chars of stderr, included in spawn-error/exit text if nonempty
  private stderrBuf = ''

  constructor(spawnFn: SpawnFn = defaultSpawnFn) {
    this.spawnFn = spawnFn
  }

  start(opts: { cwd: string; resumeId?: string }): void {
    const args = [...CLAUDE_ARGS]
    if (opts.resumeId) {
      args.push('--resume', opts.resumeId)
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
        if (obj['subtype'] !== 'init') return
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
            this.onEvent({ kind: 'tool-started', toolId, name, detail: rawDetail.slice(0, 120) })
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

      default:
        // Unknown types (stream_event, etc.) are ignored for forward-compatibility,
        // same posture as the client's untyped-JSON guards.
        return
    }
  }
}
