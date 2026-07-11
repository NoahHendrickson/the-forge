// This module is bundled into BOTH the server (dist/vite.js, dist/next.js, via
// src/server/endpoints.ts) and the browser client (dist/client.js, via
// src/client/session-feed.ts) — it must stay pure data with NO imports, forever. A single
// `node:*` import here would leak into the browser bundle; a single browser-only import
// would break the node bundles. Keep this file free of imports and side effects.

// /session/say + /session/config validation constants (Task 4). The effort allowlist is
// spike-pinned (spec §2.4) — verbatim, not derived. Split per-harness (Task 2, C1): each
// embedded harness gets its own effort/permission-mode vocabulary — the manager (and the
// endpoints/UI code that validate against it) never invents a wire spelling an adapter
// doesn't actually support.
export type HarnessId = 'claude-code' | 'cursor'

export const EMBEDDED_HARNESSES = ['claude-code', 'cursor'] as const

export interface HarnessVocab {
  efforts: readonly string[] // [] means unsupported → picker hidden (cursor today; a knob-less future harness)
  liveEffort: boolean // true: effort applies to the live session, no respawn
  permissionModes: readonly string[] // OUR mode ids; adapters own the wire spelling
}

export const HARNESS_VOCAB: Record<HarnessId, HarnessVocab> = {
  'claude-code': {
    // spike-pinned (spec §2.4) — verbatim, not derived.
    efforts: ['low', 'medium', 'high', 'xhigh', 'max'],
    // No set_effort control request exists (spike, Task 1, confirmed live CLI 2.1.201) —
    // effort is spawn-flag-only, so a change is a manager-owned respawn, not a live write.
    liveEffort: false,
    // bypassPermissions is deliberately absent — it would disable the overlay approve gate.
    permissionModes: ['default', 'acceptEdits', 'plan'],
  },
  cursor: {
    // Cursor has NO effort knob and no verified ACP permission-mode control — empty tables
    // hide both pickers (client) and reject every value (endpoint validation). The ratified
    // permission posture is enforced adapter-side instead (edit-kind auto-allow; see cursor.ts).
    efforts: [],
    liveEffort: true, // moot with an empty list; true = never trigger the Claude respawn dance
    permissionModes: [],
  },
}

// Temporary re-export aliases so endpoints.ts / session-feed.ts (not yet migrated to
// HARNESS_VOCAB lookups) keep compiling — both move to `HARNESS_VOCAB['claude-code']`
// lookups in Tasks 4/5, at which point these aliases are deleted.
export const EFFORT_LEVELS = HARNESS_VOCAB['claude-code'].efforts
export const PERMISSION_MODES = HARNESS_VOCAB['claude-code'].permissionModes

export const CHAT_TEXT_MAX = 4000
