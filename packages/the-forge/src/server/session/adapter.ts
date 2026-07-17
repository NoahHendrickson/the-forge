// Harness-agnostic session contract. The Cursor adapter (C1) and later Codex (C2) implement this alongside ClaudeAdapter.

import type { HarnessId } from '../../shared/chat-constants'

export interface SpawnedChild {
  // stdin carries its own 'error' listener (distinct from the child-level 'error' below): a
  // write racing the child's death reports EPIPE/ERR_STREAM_DESTROYED asynchronously as an
  // 'error' event on THIS stream, not on the child. Both adapters attach a listener at spawn
  // time — see the why-comment at each call site.
  stdin: { write(s: string): void; end(): void; on(ev: 'error', fn: (err: unknown) => void): void }
  stdout: NodeJS.ReadableStream
  stderr: NodeJS.ReadableStream
  kill(signal?: string): void
  on(ev: 'exit' | 'error', fn: (...a: unknown[]) => void): void
}

export type SpawnFn = (cmd: string, args: string[], opts: { cwd: string }) => SpawnedChild

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

export type SessionEvent =
  | { kind: 'started'; sessionId: string; model: string; mcpLoaded: boolean }
  | { kind: 'assistant-text'; text: string }
  | { kind: 'user-text'; text: string; element?: { source: string; tag: string } } // manager-produced
  | { kind: 'assistant-delta'; text: string } // subscriber-only, never ringed
  | {
      kind: 'tool-started'
      toolId: string
      name: string
      detail: string
      edit?: { file: string; before: string; after: string }
    }
  // `edit` here is for late-arriving diffs: Cursor (ACP) delivers an edit's before/after on the
  // TERMINAL tool_call_update, after the tool row already opened — same payload shape and
  // EDIT_PAYLOAD_CAP truncation as tool-started's. Claude never sets this (its diff rides the
  // tool_use block, i.e. tool-started).
  | { kind: 'tool-finished'; toolId: string; edit?: { file: string; before: string; after: string } }
  | { kind: 'turn-complete'; isError: boolean; errorText?: string; costUsd?: number }
  | { kind: 'config-changed'; model?: string; permissionMode?: string; effort?: string; harness?: HarnessId }
  | { kind: 'session-error'; text: string } // spawn failure, stderr chatter, unparseable protocol state
  | { kind: 'ended' } // child exited (any reason)
  | { kind: 'activity' } // liveness heartbeat (hook/system chatter) — re-arms the watchdog, never rendered

export interface SessionAdapter {
  start(opts: { cwd: string; resumeId?: string }): void
  sendTurn(text: string): void
  interrupt(): void
  stop(): void
  setModel(model: string): void
  setPermissionMode(mode: string): void
  // Levels: low | medium | high | xhigh | max. On ClaudeAdapter this is a no-op — the CLI has
  // no set_effort control request (confirmed live, CLI 2.1.201); effort is a spawn-flag-only
  // knob, so an effort change is a manager-owned respawn with `--resume <id> --effort <level>`,
  // not a stdin write. See ClaudeAdapter.setEffort for the full why-comment.
  setEffort(level: string): void
  onEvent: (e: SessionEvent) => void
}
