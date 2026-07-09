// Harness-agnostic session contract. Codex/Cursor adapters implement this alongside ClaudeAdapter.

export type SessionEvent =
  | { kind: 'started'; sessionId: string; model: string; mcpLoaded: boolean }
  | { kind: 'assistant-text'; text: string }
  | { kind: 'tool-started'; toolId: string; name: string; detail: string }
  | { kind: 'tool-finished'; toolId: string }
  | { kind: 'turn-complete'; isError: boolean; errorText?: string; costUsd?: number }
  | { kind: 'session-error'; text: string } // spawn failure, stderr chatter, unparseable protocol state
  | { kind: 'ended' } // child exited (any reason)

export interface SessionAdapter {
  start(opts: { cwd: string; resumeId?: string }): void
  sendTurn(text: string): void
  interrupt(): void
  stop(): void
  onEvent: (e: SessionEvent) => void
}
