import type { AgentId } from '../shared/chat-constants'

/** The configured coding-agent CLI/IDE the dispatch ladder targets. Shared between index.ts
 * (Send button flash copy) and verifier.ts (manual-rung poller instruction) — kept in its own
 * module so neither has to import the other (index.ts already imports verifier.ts).
 * Aliases shared/chat-constants.ts's AgentId (type-only import — zero runtime cost, keeps the
 * union spelling in one place) rather than a rename, to avoid churning every call site that
 * already imports AgentName from here. */
export type AgentName = AgentId

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
