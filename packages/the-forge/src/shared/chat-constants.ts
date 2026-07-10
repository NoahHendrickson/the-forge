// This module is bundled into BOTH the server (dist/vite.js, dist/next.js, via
// src/server/endpoints.ts) and the browser client (dist/client.js, via
// src/client/session-feed.ts) — it must stay pure data with NO imports, forever. A single
// `node:*` import here would leak into the browser bundle; a single browser-only import
// would break the node bundles. Keep this file free of imports and side effects.

// /session/say + /session/config validation constants (Task 4). The effort allowlist is
// spike-pinned (spec §2.4) — verbatim, not derived.
export const EFFORT_LEVELS = ['low', 'medium', 'high', 'xhigh', 'max'] as const

// bypassPermissions is deliberately absent — it would disable the overlay approve gate.
export const PERMISSION_MODES = ['default', 'acceptEdits', 'plan'] as const

export const CHAT_TEXT_MAX = 4000
