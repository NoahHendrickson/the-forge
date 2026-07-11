// Same rule as chat-constants.ts: this module is bundled into BOTH the browser client
// (src/client/request.ts — Copy-for-agent's standalone markdown) and the node server
// (src/server/dispatch.ts — the Cursor deeplink augmentation). It must stay pure data with
// NO imports, forever.
//
// Placement (2026-07-10 cost review): these guardrails deliberately do NOT ride every queued
// change-request item — that duplicated them against the delivery wrapper on every path and
// cost ~85 tokens per Send. Each delivery path carries them exactly once instead:
//   - /forge-design command text (DESIGN_COMMAND, src/server/setup.ts)
//   - /forge-watch command text (WATCH_COMMAND, src/server/setup.ts)
//   - the embedded session's pull nudge (PULL_TURN_TEXT, src/server/session/manager.ts)
//   - the Cursor deeplink (augmentDispatchMarkdown, src/server/dispatch.ts) — imports these
//   - Copy for agent (renderStandaloneMarkdown, src/client/request.ts) — imports these
// If you add a NEW way for queue markdown to reach an agent, it must carry these (or an
// equivalent instruction wrapper) too.

// "skip and report", never "pause": an unresolved (claimed-but-unmarked) item goes stale
// after CLAIM_TIMEOUT_MS and gets re-delivered on a later watch cycle — a paused agent would
// be re-asked the same question every few minutes. The command texts (server/setup.ts) spell
// out the MCP mechanics: mark_applied status "failed", note "needs confirmation: <why>".
export const SCOPE_GUARDRAIL =
  'Scope: apply to this call site only. If a change would modify a shared component rendered elsewhere, skip it and report it back as needing confirmation — do not pause waiting for an answer.'

// No verification ask on purpose: the browser-side verifier (client/verifier.ts) checks
// computed styles post-HMR itself. Telling the agent to "verify" makes it spin up dev
// servers/screenshots to preview the result the user is already watching live.
export const NO_PREVIEW_GUARDRAIL =
  'Do not run the app, take screenshots, or preview the result — the user is watching the live app, and The Forge verifies the changes automatically.'
