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
export type HarnessId = 'claude-code' | 'codex'

export const EMBEDDED_HARNESSES = ['claude-code', 'codex'] as const

export interface HarnessVocab {
  efforts: readonly string[] // [] would mean unsupported → picker hidden (C2/Cursor)
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
  codex: {
    // Task 1 fixture-pinned.
    efforts: ['minimal', 'low', 'medium', 'high', 'xhigh'],
    // Codex threads effort as a per-turn param on turn/start — no respawn needed.
    liveEffort: true,
    // Our own mode ids; danger tiers (full-auto/yolo-equivalents) are deliberately absent —
    // same overlay-gating posture as claude-code's missing bypassPermissions.
    permissionModes: ['untrusted', 'on-request'],
  },
}

// Temporary re-export aliases so endpoints.ts / session-feed.ts (not yet migrated to
// HARNESS_VOCAB lookups) keep compiling — both move to `HARNESS_VOCAB['claude-code']`
// lookups in Tasks 4/5, at which point these aliases are deleted.
export const EFFORT_LEVELS = HARNESS_VOCAB['claude-code'].efforts
export const PERMISSION_MODES = HARNESS_VOCAB['claude-code'].permissionModes

export const CHAT_TEXT_MAX = 4000
