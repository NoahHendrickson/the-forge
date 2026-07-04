/** The configured coding-agent CLI/IDE the dispatch ladder targets. Shared between index.ts
 * (Send button flash copy) and verifier.ts (manual-rung poller instruction) — kept in its own
 * module so neither has to import the other (index.ts already imports verifier.ts). */
export type AgentName = 'claude-code' | 'cursor' | 'codex'

export const AGENT_DISPLAY_NAME: Record<AgentName, string> = {
  'claude-code': 'Claude Code',
  cursor: 'Cursor',
  codex: 'Codex',
}

/** Reads the agent configured by the server-injected bootstrap (globalThis.__THE_FORGE__.agent),
 * defaulting to 'claude-code' when unset (e.g. older bootstrap, or module loaded outside a page). */
export function currentAgent(): AgentName {
  return (globalThis as { __THE_FORGE__?: { agent?: AgentName } }).__THE_FORGE__?.agent ?? 'claude-code'
}
