import { spawn } from 'node:child_process'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import type { SessionAdapter, SessionEvent } from './adapter'
import { type SpawnFn, type SpawnedChild, truncateEditSide } from './claude'

// cursor-agent speaks ACP (Agent Client Protocol): JSON-RPC 2.0, newline-delimited, over
// stdio. `acp` is the only arg — everything else (model, permission mode) is negotiated
// in-band, not via flags (spike, Task 1, CLI 2026.07.09). This mirrors ClaudeAdapter's
// CLAUDE_ARGS in shape but the wire protocol underneath is entirely different.
export const CURSOR_ARGS: string[] = ['acp']

// The constant surfaced to the overlay when session/new (or session/load) fails with the
// in-band auth error (-32000). The CLI stays alive and only exits on our SIGTERM (spike,
// Scenario 10), so there is no stderr/exit-code signal to lean on — this text IS the signal.
export const CURSOR_AUTH_MESSAGE = 'cursor-agent is not logged in — run: agent login'

// The minimal accepted `initialize` params (fixture INIT_REQUEST, byte-pinned to the live
// spike). protocolVersion 1; we advertise fs read/write client capability.
const INIT_PARAMS = {
  protocolVersion: 1,
  clientCapabilities: { fs: { readTextFile: true, writeTextFile: true } },
}

function defaultSpawnFn(cmd: string, args: string[], opts: { cwd: string }): SpawnedChild {
  const child = spawn(cmd, args, { cwd: opts.cwd, stdio: ['pipe', 'pipe', 'pipe'] })
  return child as unknown as SpawnedChild
}

interface PermissionOption {
  optionId: string
  kind: string
}

/** Scan a session/update (or permission toolCall) content array for the diff block Cursor
 * attaches to edits — {type:'diff', path, oldText, newText} — and shape it into the SessionEvent
 * edit payload, reusing ClaudeAdapter's shared truncation cap. Absent/malformed content never
 * throws (same forward-compat posture as the rest of processLine's manual field checks); a
 * tool_call with no diff just produces no edit payload. */
function buildEditFromContent(
  content: unknown,
): { file: string; before: string; after: string } | undefined {
  if (!Array.isArray(content)) return undefined
  for (const block of content) {
    if (typeof block !== 'object' || block === null) continue
    const b = block as Record<string, unknown>
    if (b['type'] === 'diff' && typeof b['path'] === 'string') {
      const before = typeof b['oldText'] === 'string' ? b['oldText'] : ''
      const after = typeof b['newText'] === 'string' ? b['newText'] : ''
      return { file: b['path'], before: truncateEditSide(before), after: truncateEditSide(after) }
    }
  }
  return undefined
}

// Non-edit, non-forge-MCP permission requests are bridged through this hook; runtime.ts's
// composition root injects the ApprovalRegistry bridge at construction.
export type CursorApprovalFn = (
  toolName: string,
  detail: string,
) => Promise<{ behavior: 'allow' } | { behavior: 'deny' }>

export class CursorAdapter implements SessionAdapter {
  onEvent: (e: SessionEvent) => void = () => {}

  private readonly spawnFn: SpawnFn
  private readonly mcpBinPath: string
  // Constructor-injected (PR #32 review: no post-construction bolt-on field outside the
  // SessionAdapter contract — the factory stays a pure constructor call). Absent → auto-deny:
  // fail closed, never hang the child on a request nobody will answer.
  private readonly onApproval: CursorApprovalFn

  private child: SpawnedChild | null = null
  // closed: set on stop() — prevents processing late stdout events after stop()
  private closed = false
  // didEnd: ensures the 'ended' event is emitted exactly once
  private didEnd = false
  // stderrBuf: last ~500 chars of stderr, included in spawn-error/exit text if nonempty
  private stderrBuf = ''

  // Outgoing JSON-RPC request id counter (initialize=1, session/new|load=2, prompts=3…),
  // matched back to a handler via `pending` when the response arrives. Matches the fixture ids.
  private reqId = 0
  private pending = new Map<number, (obj: Record<string, unknown>) => void>()

  // Boot/turn state. sessionId is set once the session/new|load response resolves; sessionReady
  // gates the turn queue (turns may arrive before boot finishes — the manager sends at spawn).
  private sessionId: string | undefined
  private sessionReady = false
  private resumeId: string | undefined
  private cwd = ''
  // FIFO of turns pushed before sessionReady; flushed in order once the session resolves.
  private turnQueue: string[] = []

  // Replay suppression: true only between writing session/load and its response resolving.
  // session/load REPLAYS the whole prior transcript as session/update notifications (spike,
  // Scenario 8); while this is set they must NOT be ringed as new activity — resume must not
  // duplicate history — so they collapse to a liveness heartbeat only.
  private loadingReplay = false

  // Assistant segment buffer. ACP streams assistant text as agent_message_chunk fragments and
  // has NO separate authoritative "final text" event, so the adapter owns segmenting: chunks
  // accumulate here and flush as one assistant-text at the next tool_call boundary or when the
  // prompt response resolves. An empty buffer flushes nothing (a thought-only turn).
  private segmentBuf = ''

  constructor(
    spawnFn: SpawnFn = defaultSpawnFn,
    opts?: { effort?: string; mcpBinPath?: string; onApproval?: CursorApprovalFn },
  ) {
    this.spawnFn = spawnFn
    // Default: dist/mcp.js beside this bundled module (cursor.ts compiles into dist/vite.js and
    // dist/next.js next to dist/mcp.js — same derivation vite.ts/sidecar.ts use). Injectable for
    // tests. opts.effort is accepted-and-ignored: the manager threads it into every makeAdapter
    // call unconditionally, but Cursor has no effort control surface (documented no-op below).
    this.mcpBinPath =
      opts?.mcpBinPath ?? path.join(path.dirname(fileURLToPath(import.meta.url)), 'mcp.js')
    this.onApproval = opts?.onApproval ?? (async () => ({ behavior: 'deny' }))
    void opts?.effort
  }

  start(opts: { cwd: string; resumeId?: string }): void {
    this.cwd = opts.cwd
    this.resumeId = opts.resumeId

    const child = this.spawnFn('cursor-agent', [...CURSOR_ARGS], { cwd: opts.cwd })
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

    // Boot step 1: initialize. Its response drives session/new|load (onInitResponse).
    this.writeRequest('initialize', INIT_PARAMS, (obj) => this.onInitResponse(obj))
  }

  sendTurn(text: string): void {
    // closed guard: stop() has SIGTERM'd the child. Also queue if boot hasn't resolved yet —
    // the manager sends the pull/chat turn at spawn, before `started`.
    if (!this.child || this.closed) return
    if (!this.sessionReady) {
      this.turnQueue.push(text)
      return
    }
    this.writePrompt(text)
  }

  interrupt(): void {
    // session/cancel is a NOTIFICATION (no id); the in-flight session/prompt then resolves with
    // stopReason:'cancelled' (spike, Scenario 7). No-op before session-ready — there is no
    // sessionId to cancel yet, and no turn can be in flight.
    if (!this.child || this.closed || !this.sessionId) return
    this.writeNotification('session/cancel', { sessionId: this.sessionId })
  }

  // ---------------------------------------------------------------------------
  // Config controls — all three are deliberate no-ops.
  //
  // ACP (CLI 2026.07.09) exposes NO verified control surface to change model / permission mode /
  // effort mid-session: model lives read-only on the session/new response, permission is
  // per-request (session/request_permission), and there is no effort concept at all. The overlay
  // hides these pickers for the cursor harness via the per-harness vocab tables (Task 2), so
  // these are never called through the UI — they exist only to satisfy SessionAdapter and to
  // absorb the manager's unconditional threading. Revisit at C2 / an ACP version that adds a
  // configOptions write path.
  // ---------------------------------------------------------------------------
  setModel(_model: string): void {
    // Intentionally empty — see the block comment above.
  }

  setPermissionMode(_mode: string): void {
    // Intentionally empty — see the block comment above.
  }

  setEffort(_level: string): void {
    // Intentionally empty — see the block comment above.
  }

  stop(): void {
    if (this.closed) return
    this.closed = true
    if (this.child) {
      this.child.kill('SIGTERM')
    }
  }

  // ---------------------------------------------------------------------------
  // Wire helpers
  // ---------------------------------------------------------------------------

  private write(msg: Record<string, unknown>): void {
    if (!this.child || this.closed) return
    this.child.stdin.write(JSON.stringify(msg) + '\n')
  }

  private writeRequest(
    method: string,
    params: Record<string, unknown>,
    handler: (obj: Record<string, unknown>) => void,
  ): void {
    const id = ++this.reqId
    this.pending.set(id, handler)
    this.write({ jsonrpc: '2.0', id, method, params })
  }

  private writeNotification(method: string, params: Record<string, unknown>): void {
    this.write({ jsonrpc: '2.0', method, params })
  }

  private mcpServersEntry() {
    // The ACCEPTED stdio mcpServers shape (spike finding 3): `env` is REQUIRED and must be an
    // ARRAY — {name,command,args} alone is rejected with an invalid_union error. This is what
    // makes the bundled dist/mcp.js load so the agent can pull_design_edits / mark_applied.
    return [{ name: 'the-forge', command: 'node', args: [this.mcpBinPath], env: [] }]
  }

  private writePrompt(text: string): void {
    this.writeRequest(
      'session/prompt',
      { sessionId: this.sessionId, prompt: [{ type: 'text', text }] },
      (obj) => this.onPromptResponse(obj),
    )
  }

  // ---------------------------------------------------------------------------
  // Boot response handlers
  // ---------------------------------------------------------------------------

  private onInitResponse(obj: Record<string, unknown>): void {
    if (obj['error']) {
      this.failBoot(obj['error'], 'init')
      return
    }
    // Boot step 2: session/new (fresh) or session/load (resume). Both carry the mcpServers entry.
    if (this.resumeId) {
      this.loadingReplay = true
      this.writeRequest(
        'session/load',
        { sessionId: this.resumeId, cwd: this.cwd, mcpServers: this.mcpServersEntry() },
        (o) => this.onSessionResponse(o),
      )
    } else {
      this.writeRequest(
        'session/new',
        { cwd: this.cwd, mcpServers: this.mcpServersEntry() },
        (o) => this.onSessionResponse(o),
      )
    }
  }

  private onSessionResponse(obj: Record<string, unknown>): void {
    // The load response arrives AFTER all replay notifications — stop swallowing them now.
    this.loadingReplay = false

    if (obj['error']) {
      this.failBoot(obj['error'], 'session')
      return
    }

    const result =
      typeof obj['result'] === 'object' && obj['result'] !== null
        ? (obj['result'] as Record<string, unknown>)
        : {}
    // session/new returns a fresh sessionId; session/load has none (we supplied it). Model lives
    // on result.models.currentModelId on BOTH — there is no model field on initialize or updates.
    const sessionId =
      this.resumeId ?? (typeof result['sessionId'] === 'string' ? result['sessionId'] : '')
    const models = result['models']
    const model =
      typeof models === 'object' &&
      models !== null &&
      typeof (models as Record<string, unknown>)['currentModelId'] === 'string'
        ? ((models as Record<string, unknown>)['currentModelId'] as string)
        : ''

    this.sessionId = sessionId
    this.sessionReady = true
    this.onEvent({ kind: 'started', sessionId, model, mcpLoaded: true })
    this.flushTurnQueue()
  }

  private failBoot(error: unknown, step: 'init' | 'session'): void {
    const err =
      typeof error === 'object' && error !== null ? (error as Record<string, unknown>) : {}
    const code = err['code']
    const message = typeof err['message'] === 'string' ? err['message'] : 'boot failed'

    // Auth is enforced at session/new|load, in-band as code -32000 (spike, Scenario 10). Check it
    // FIRST at any boot step: a logged-out resume would otherwise fall through to the stale-resume
    // branch and loop. The manager's session-error handler drives us to `failed` when !sawStarted
    // (its pre-started failure path) — nothing else to do here.
    if (code === -32000) {
      this.onEvent({ kind: 'session-error', text: CURSOR_AUTH_MESSAGE })
      return
    }

    // A stale/expired resume id fails session/load with -32602 (spike, Scenario 8). Surface it as
    // turn-complete{isError:true} BEFORE any `started` — the manager's stale-resume retry branch
    // keys on EXACTLY this shape (clears the slot, retries fresh once).
    if (step === 'session' && this.resumeId) {
      this.onEvent({ kind: 'turn-complete', isError: true, errorText: message })
      return
    }

    // Any other boot error (e.g. a malformed mcpServers entry) → session-error / pre-started path.
    this.onEvent({ kind: 'session-error', text: message })
  }

  private flushTurnQueue(): void {
    const queued = this.turnQueue
    this.turnQueue = []
    for (const text of queued) {
      this.writePrompt(text)
    }
  }

  private onPromptResponse(obj: Record<string, unknown>): void {
    // Flush any pending assistant text as the segment's final assistant-text before the turn ends.
    this.flushSegment()
    if (obj['error']) {
      const err =
        typeof obj['error'] === 'object' && obj['error'] !== null
          ? (obj['error'] as Record<string, unknown>)
          : {}
      const errorText = typeof err['message'] === 'string' ? err['message'] : undefined
      this.onEvent({ kind: 'turn-complete', isError: true, errorText })
      return
    }
    // Both stopReason 'end_turn' AND 'cancelled' are successful completions (mirrors Claude
    // interrupts — a cancel is not an error turn). A permission-REJECTED turn also resolves
    // end_turn (spike, Scenario 6), so rejection never maps to an error turn either.
    this.onEvent({ kind: 'turn-complete', isError: false })
  }

  private flushSegment(): void {
    if (this.segmentBuf.length === 0) return
    const text = this.segmentBuf
    this.segmentBuf = ''
    this.onEvent({ kind: 'assistant-text', text })
  }

  // ---------------------------------------------------------------------------
  // Stdout line processing
  // ---------------------------------------------------------------------------

  private processLine(line: string): void {
    if (this.closed) return
    const trimmed = line.trim()
    if (!trimmed) return

    let parsed: unknown
    try {
      parsed = JSON.parse(trimmed)
    } catch {
      return // unparseable lines are ignored (forward-compat, same as ClaudeAdapter)
    }
    if (typeof parsed !== 'object' || parsed === null) return
    const obj = parsed as Record<string, unknown>

    const method = obj['method']
    if (typeof method === 'string') {
      // A server→client request (session/request_permission, carries an id we must answer) or a
      // notification (session/update, no id).
      if (method === 'session/update') {
        this.handleSessionUpdate(obj)
        return
      }
      if (method === 'session/request_permission') {
        void this.handlePermissionRequest(obj)
        return
      }
      // Unrecognized method (cursor/* extension notifications, future methods) → liveness only.
      this.onEvent({ kind: 'activity' })
      return
    }

    // Otherwise it's a response to one of OUR requests — match by id. (id:0 is reserved by the
    // server for its permission requests, which always carry a `method`; ours start at 1.)
    const id = obj['id']
    if (typeof id === 'number') {
      const handler = this.pending.get(id)
      if (handler) {
        this.pending.delete(id)
        handler(obj)
        return
      }
    }
    // A response we don't have a handler for still proves the child is alive.
    this.onEvent({ kind: 'activity' })
  }

  private handleSessionUpdate(obj: Record<string, unknown>): void {
    // During session/load replay, every session/update is prior history — swallow to a heartbeat
    // so resume doesn't re-render the whole transcript as fresh activity.
    if (this.loadingReplay) {
      this.onEvent({ kind: 'activity' })
      return
    }

    const params =
      typeof obj['params'] === 'object' && obj['params'] !== null
        ? (obj['params'] as Record<string, unknown>)
        : {}
    const update =
      typeof params['update'] === 'object' && params['update'] !== null
        ? (params['update'] as Record<string, unknown>)
        : {}
    const type = update['sessionUpdate']

    switch (type) {
      case 'agent_message_chunk': {
        const content =
          typeof update['content'] === 'object' && update['content'] !== null
            ? (update['content'] as Record<string, unknown>)
            : {}
        const text = typeof content['text'] === 'string' ? content['text'] : ''
        // Fan a preview delta AND accumulate for the eventual flushed assistant-text.
        this.onEvent({ kind: 'assistant-delta', text })
        this.segmentBuf += text
        return
      }

      case 'tool_call': {
        // A tool_call closes the current assistant text segment (spike: interleaved text/tools).
        this.flushSegment()
        const toolId = typeof update['toolCallId'] === 'string' ? update['toolCallId'] : ''
        const name = typeof update['kind'] === 'string' ? update['kind'] : ''
        const title = typeof update['title'] === 'string' ? update['title'] : ''
        const edit = buildEditFromContent(update['content'])
        this.onEvent({
          kind: 'tool-started',
          toolId,
          name,
          detail: title.slice(0, 120),
          ...(edit ? { edit } : {}),
        })
        return
      }

      case 'tool_call_update': {
        const status = update['status']
        // Terminal statuses close the tool row. A permission-REJECTED tool still reports
        // 'completed' (spike, Scenario 6 gotcha) — rejection is only visible to the agent in-band,
        // never in the tool status, so 'completed' is a normal finish here, not a failure signal.
        if (status === 'completed' || status === 'failed') {
          const toolId = typeof update['toolCallId'] === 'string' ? update['toolCallId'] : ''
          // Live edits carry their {type:'diff'} block HERE, on the terminal update (fixture
          // TOOL_CALL_COMPLETED_EDIT) — not on the opening tool_call. Attach it so the overlay
          // can upgrade the already-open tool row with the before/after preview.
          const edit = buildEditFromContent(update['content'])
          this.onEvent({ kind: 'tool-finished', toolId, ...(edit ? { edit } : {}) })
          return
        }
        // Non-terminal (in_progress, pending) → liveness only.
        this.onEvent({ kind: 'activity' })
        return
      }

      default:
        // agent_thought_chunk (reasoning), session_info_update (chat title), available_commands_
        // update (slash-command list), user_message_chunk (replay-only) and anything unrecognized:
        // liveness only, never rendered.
        this.onEvent({ kind: 'activity' })
        return
    }
  }

  private async handlePermissionRequest(obj: Record<string, unknown>): Promise<void> {
    const id = obj['id']
    const params =
      typeof obj['params'] === 'object' && obj['params'] !== null
        ? (obj['params'] as Record<string, unknown>)
        : {}
    const toolCall =
      typeof params['toolCall'] === 'object' && params['toolCall'] !== null
        ? (params['toolCall'] as Record<string, unknown>)
        : {}
    const options = Array.isArray(params['options'])
      ? (params['options'] as unknown[]).filter(
          (o): o is PermissionOption =>
            typeof o === 'object' &&
            o !== null &&
            typeof (o as Record<string, unknown>).optionId === 'string' &&
            typeof (o as Record<string, unknown>).kind === 'string',
        )
      : []

    const kind = typeof toolCall['kind'] === 'string' ? toolCall['kind'] : ''
    const title = typeof toolCall['title'] === 'string' ? toolCall['title'] : ''

    // Auto-allow split (spike §3.2, corrected): the live CLI auto-runs built-in read/edit tools
    // with NO permission request — only shell/execute and MCP tool calls prompt. We therefore
    // auto-allow (a) edit-kind requests — defensive; none observed live, but the ratified posture
    // is "edits auto" so a future CLI that DOES prompt for edits must not park the designer — and
    // (b) the-forge's OWN MCP tools, mirroring ClaudeAdapter's static mcp__the-forge__* allows:
    // without this, every pull turn would park an approval on a tool WE drive. Everything else
    // (shell/execute, other MCP tools) → this.onApproval.
    const isEditKind = kind === 'edit'
    // The forge-MCP arm is anchored to BOTH signals, never a bare substring of the title:
    // - kind === 'other' (the MCP-tool kind, fixture-pinned) excludes shell commands — an
    //   execute title is attacker-influenceable content (`echo pull_design_edits` would
    //   otherwise auto-allow, a prompt-injection-reachable bypass of this exact gate);
    // - a ^the-forge[:-] title prefix scopes to OUR server, mirroring EDIT_TIER_ALLOW's
    //   mcp__the-forge__* trust level. Both recorded fixture titles carry it: live
    //   "the-forge-pull_design_edits: pull_design_edits" and replay "the-forge: pull_design_edits".
    // A CLI title-wording change breaks toward SAFE (the tool merely prompts).
    const isForgeMcpTool = kind === 'other' && /^the-forge[:-]/.test(title)

    let allow: boolean
    if (isEditKind || isForgeMcpTool) {
      allow = true
    } else {
      // detail: the command/title, sliced to 120 (same cap as tool-started detail). A handler
      // that throws (registry teardown, wiring bug) must still fail closed — never leave the
      // child blocked on an unanswered request.
      try {
        const decision = await this.onApproval(kind, title.slice(0, 120))
        allow = decision.behavior === 'allow'
      } catch {
        allow = false
      }
    }

    this.answerPermission(id, options, allow)
  }

  private answerPermission(id: unknown, options: PermissionOption[], allow: boolean): void {
    // Choose the option by its `kind` field, never a hardcoded optionId (they're stable in the
    // spike but account/version-specific in principle). NEVER the allow_always option — an
    // allow-once grant must not silently become a standing allowlist entry. Fail closed if the
    // desired option is missing: fall back to reject_once so an unexpected options array can
    // never accidentally grant.
    const wantKind = allow ? 'allow_once' : 'reject_once'
    const opt =
      options.find((o) => o.kind === wantKind) ?? options.find((o) => o.kind === 'reject_once')
    if (!opt) return // no answerable option — leave it; the registry's own timeout is the backstop
    this.write({ jsonrpc: '2.0', id, result: { outcome: { outcome: 'selected', optionId: opt.optionId } } })
  }
}
