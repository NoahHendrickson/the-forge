# The Forge — agent guide

A dev-only Vite plugin (`@the-forge/vite`) that gives any Vite + React app a Figma-style design mode: click an element in the running app, edit properties live in a floating panel, and send deterministic, token-aware change requests to the AI coding agent you already use (Claude Code / Cursor / Codex) via a bundled stdio MCP server. Product pitch: [README.md](README.md). Spec: [docs/specs/2026-07-03-the-forge-design.md](docs/specs/2026-07-03-the-forge-design.md). Process conventions and working agreements: [docs/HANDOFF.md](docs/HANDOFF.md). One dated plan per milestone in [docs/plans/](docs/plans/).

## Commands

```bash
npm install && npm run build          # build the plugin (tsup)
npm test                              # root gate: typecheck + full vitest suite
npm run test:watch -w @the-forge/vite # vitest watch mode
npm run typecheck -w @the-forge/vite  # tsc --noEmit only
npm run dev -w demo-app               # demo app (fixtures/demo-app); Design toggle bottom-right
./scripts/check-prod-clean.sh         # prod build has zero plugin traces + 250KB package budget
```

Single test file: `npx vitest run tests/client/panel.test.ts` from `packages/vite-plugin/`.

The build produces three bundles in `packages/vite-plugin/dist/`: `index.js` (the node-side Vite plugin), `client.js` (the browser overlay, served only under `vite dev`), and `mcp.js` (the stdio MCP bin agents launch). The npm package ships `dist/` only.

## Architecture — the loop

1. `src/transform.ts` — Babel tags every JSX element with `data-dc-source="file:line:col"` (serve mode only; `apply: 'serve'` keeps production untouched).
2. `src/client/` — shadow-DOM overlay + properties panel. Edits preview as inline-style drafts (`drafts.ts`); React never re-renders while scrubbing.
3. `src/client/request.ts` — packages drafts into a deterministic change request in the project's own Tailwind vocabulary (`py-2.5 → py-6`), exact file:line targets.
4. Send → `POST /__the-forge/queue` (`src/server/endpoints.ts` → `queue.ts` → `.the-forge/queue.json` at the resolved project root), then `POST /__the-forge/dispatch` tries the zero-keystroke ladder (`src/server/dispatch.ts`: tmux → AppleScript → deeplink → manual instruction).
5. Agent side: `dist/mcp.js` (`src/mcp/`) discovers the dev server, pulls change requests, the agent applies them to source, then calls `mark_applied`.
6. `src/client/verifier.ts` polls `GET /__the-forge/status`, verifies computed styles post-HMR, and flips matching drafts to **Implemented**.

### src/client modules

| Module | Responsibility |
| --- | --- |
| `index.ts` | client entry: design-mode toggle, selection wiring, Send button |
| `source.ts` | parse `data-dc-source` attrs; `TaggedElement` type |
| `overlay.ts` | shadow-DOM host, hover/selection outlines, the whole CSS design system (string const) |
| `inspector.ts` | reads an element's computed-style snapshot for the panel |
| `panel.ts` | the properties panel orchestrator (Panel class) |
| `panel-specs.ts` | RowSpec/SectionSpec types, SECTIONS definition, token-scale helpers (`tokenEntriesFor`) |
| `panel-readers.ts` | pure computed-style readers/normalizers (`isFlex`, `normalizeJustify`, font helpers) |
| `controls.ts` | `NumberField` — scrubbing numeric input with math expressions and `auto` |
| `layout-controls.ts` | `SegmentField` + 9-dot `AlignMatrix` |
| `colorpicker.ts` | popover color picker (SV area, hex, contrast ratio) |
| `tokenpicker.ts` | `=`-triggered searchable Tailwind token picker; bound values render as pills |
| `tokens.ts` | Tailwind v4 theme reader: spacing base, radius/text scales, palette, nearest-token |
| `drafts.ts` | inline-style draft store: apply/current/commit, before-after compare |
| `agent.ts` | which agent is targeted (`claude-code`/`cursor`/`codex`) + display names |
| `ripple.ts` | measures which elements move when a draft lands; flashes ripple outlines |
| `sent.ts` | registry of sent-but-unverified change requests |
| `request.ts` | change-request builder: before/after CSS + utility deltas, markdown |
| `verifier.ts` | post-send polling, computed-style verification, backoff when server is gone |

## MCP contract

- **Two tools** (server name `the-forge`, bin `dist/mcp.js`):
  - `pull_design_edits` — no args; claims all pending items (and re-claims stale ones) and returns their change-request markdown.
  - `mark_applied` — `{ ids: string[], status: 'applied' | 'failed', note? }`.
- **Endpoint discovery:** the plugin resolves the project root by walking up from Vite's root to the nearest `.git` (`resolveProjectRoot` in `src/server/setup.ts`, monorepo-safe) and writes `.the-forge/endpoint-<pid>.json` (`{port, host, pid, secret}`, written by `writeEndpointFile` in `src/server/endpoints.ts`). The bin (`src/mcp/discover.ts`) reads `<cwd>/.the-forge/`, filters entries to live pids, newest mtime wins; legacy `endpoint.json` is only used when no per-pid file exists.
- **Auth:** mutating endpoints (`POST /__the-forge/pull`, `/mark`, `/queue`, `/dispatch`) require the `X-Forge-Secret` header from the endpoint file.
- **Install side-effects (auto, idempotent):** the plugin writes a `the-forge` entry into `.mcp.json` and a `/forge-design` command at `.claude/commands/forge-design.md`, both at the git root. `.the-forge/` is gitignored runtime state.
- **Queue lifecycle:** `pending` → `claimed` (stale claims re-queue after 5 min) → `applied`/`failed`; terminal items pruned after 24h, 200-item cap; corrupt `queue.json` is quarantined to `queue.json.corrupt-<ts>`, never silently discarded.
- The MCP server is a hand-rolled zero-dependency JSON-RPC subset (`src/mcp/protocol.ts`). **Do not replace it with `@modelcontextprotocol/sdk`** — zero runtime dependencies is a deliberate, headline footprint feature.

## Hard product constraints (user-set, non-negotiable)

- Complementary to Claude Code/Cursor/Codex — never a replacement, never a new chat surface.
- Subscription-only: the user's running agent session or official CLI binaries; never the Agent SDK / API keys.
- Deterministic, token-first change requests; previews are inline styles (framework-bypass).
- Zero production footprint (`apply: 'serve'` + `check-prod-clean.sh`) and zero idle overhead (no listeners/observers/timers until design mode is on).
- Zero new runtime dependencies (`@babel/parser` + `magic-string` only).

## Conventions

- One dated plan per milestone in `docs/plans/` (contract + test-sketch style); brainstorm with the user first, then plan, then a feature branch per milestone. Merge decision always belongs to the user.
- Tests mirror `src/` (`tests/client/panel.test.ts` covers `src/client/panel.ts`); the root `npm test` is the gate.
- Panel/overlay CSS class names are test hooks — extend, don't rename.
- Why-comments are load-bearing project memory. Preserve them verbatim when moving code; never trim them as "verbose".
- `unknown` + manual checks at I/O boundaries is deliberate — no schema libraries.
- Any plugin-written on-disk artifact (`.mcp.json`, command files, `.the-forge/`) installs at `resolveProjectRoot()` — the git root — never Vite's root (monorepo lesson from first real use).
- Panel design decisions (spacing rows, stable section order, Mixed-not-blank, …) are user-ratified in [docs/research/2026-07-04-panel-patterns.md](docs/research/2026-07-04-panel-patterns.md) — don't relitigate them silently.

## Gotchas

- **jsdom cannot see flex layout, cascade, or real computed styles.** Unit tests alone never prove layout/visual behavior — run a real-browser E2E against the demo app before merging UI work.
- Stale dev servers cause phantom bugs — check `lsof -iTCP:5173` and kill before E2E. The dev server often binds IPv6 (`[::1]:5173`).
- The MCP bin resolves `.the-forge/` from `process.cwd()` — the agent session must run at the git root (the plugin writes the endpoint file there for exactly this reason).
- Items stay queued until `mark_applied` — but an immediate re-pull returns nothing (pull flips them to `claimed`; a dropped claim only re-queues after 5 min). The `/forge-design` flow is pull → apply → mark in one pass.
