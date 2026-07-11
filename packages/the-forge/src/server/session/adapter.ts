// Harness-agnostic session contract. The Cursor adapter (C1) and later Codex (C2) implement this alongside ClaudeAdapter.

import type { HarnessId } from '../../shared/chat-constants'

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
  | { kind: 'tool-finished'; toolId: string }
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
