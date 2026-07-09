# The Forge — agent guide

A dev-only plugin (single package `the-forge`, subpaths `the-forge/vite`, `the-forge/next`, `the-forge/design-mode`) that gives any Vite + React app **or** Next.js 15/16 app (both routers, both dev bundlers) a Figma-style design mode: click an element in the running app, edit properties live in a floating panel, and send deterministic, token-aware change requests to the AI coding agent you already use (Claude Code / Cursor / Codex) via a bundled stdio MCP server. Product pitch: [README.md](README.md). Specs: [docs/specs/2026-07-03-the-forge-design.md](docs/specs/2026-07-03-the-forge-design.md) (original Vite design), [docs/specs/2026-07-04-next-adapter-design.md](docs/specs/2026-07-04-next-adapter-design.md) (Next adapter). Process conventions and working agreements: [docs/HANDOFF.md](docs/HANDOFF.md). One dated plan per milestone in [docs/plans/](docs/plans/).

## Commands

```bash
npm install && npm run build          # build the plugin (tsup)
npm test                              # root gate: typecheck + full vitest suite
npm run test:watch -w the-forge       # vitest watch mode
npm run typecheck -w the-forge        # tsc --noEmit only
npm run dev -w demo-app               # Vite demo (fixtures/demo-app); Design toggle bottom-right
npm run storybook -w the-forge        # component catalog (overlay atoms), port 6006
npm run dev -w next-demo              # Next demo, App Router + Turbopack (fixtures/next-demo, port 5175)
npm run dev:webpack -w next-demo      # same fixture, forced webpack dev bundler
npm run dev -w next-pages             # Next demo, Pages Router (fixtures/next-pages, port 5176)
./scripts/check-prod-clean.sh         # prod build has zero plugin traces (Vite + Next) + 250KB package budget
npx the-forge init                    # (in a host project) detect Vite/Next, install, wire config, mount ForgeDesignMode
./scripts/check-init.sh               # real-tarball smoke test of `the-forge init` against bare Vite + Next scaffolds
```

Single test file: `npx vitest run tests/client/panel.test.ts` from `packages/the-forge/`.

The build produces bundles in `packages/the-forge/dist/`: `index.js` (root stub that throws — import a subpath instead), `vite.js` (the node-side Vite plugin), `next.js` (the node-side Next config wrapper + sidecar starter), `design-mode.js` (the `<ForgeDesignMode />` component; zero `node:*` imports so it's safe inside a browser bundle), `client.js` (the browser overlay, served only in dev), `next-loader.cjs` (the JSX-tagging loader Turbopack/webpack `require()` directly — built CJS regardless of the package's own ESM), `mcp.js` (the stdio MCP bin agents launch), and `cli.js` (the `the-forge` bin — `npx the-forge init`, from `src/cli/`). The npm package ships `dist/` only.

## Architecture — the loop

1. `src/transform.ts` — Babel tags every JSX element with `data-dc-source="file:line:col"` (serve mode only; `apply: 'serve'` / dev-phase-only keeps production untouched on both frameworks). On Next this same tagger runs through a loader `src/next/index.ts` registers: Turbopack `turbopack.rules` (no ordering key needed — it's the only transform registered) or a webpack rule with `enforce: 'pre'` (needed — SWC's own loader strips JSX in the normal stage, so ours must run ahead of it).
2. `src/client/` — shadow-DOM overlay + properties panel. Edits preview as inline-style drafts (`drafts.ts`); React never re-renders while scrubbing. Same client bundle on both frameworks, unmodified.
3. `src/client/request.ts` — packages drafts into a deterministic change request in the project's own Tailwind vocabulary (`py-2.5 → py-6`), exact file:line targets.
4. Send → `POST /__the-forge/queue` (`src/server/endpoints.ts` → `queue.ts` → `.the-forge/queue.json` at the resolved project root), then `POST /__the-forge/dispatch` tries the dispatch ladder top-first: **'embedded' rung** — `SessionManager` (`src/server/session/`) spawns `claude -p --input-format stream-json …` at the project root; the agent pulls change requests via MCP as always; `SessionFeed` (`src/client/session-feed.ts`) streams its activity back to the overlay. Watcher and keystroke rungs are fallbacks (`src/server/dispatch.ts`: watcher → tmux → AppleScript → deeplink → manual instruction). On Vite this server code runs inside the Vite dev server process; on Next, `withForge()` starts an in-process loopback sidecar (`src/next/sidecar.ts`) hosting the identical `src/server/runtime.ts`, and an async `rewrites()` proxies `/__the-forge/*` to it so the browser talks same-origin either way.
5. Agent side: `dist/mcp.js` (`src/mcp/`) discovers the dev server, pulls change requests, the agent applies them to source, then calls `mark_applied` — unchanged by which framework is in front; it only ever reads the endpoint file.
6. `src/client/verifier.ts` polls `GET /__the-forge/status`, verifies computed styles post-HMR (Vite) or post-Fast-Refresh (Next), and flips matching drafts to **Implemented**.

### src/next modules

| Module | Responsibility |
| --- | --- |
| `index.ts` | `withForge()` — the Next config wrapper, active only under `phase-development-server`; registers the tagging loader and merges an async `rewrites()` proxy in front of the sidecar |
| `sidecar.ts` | `ensureSidecar()` — process-singleton loopback HTTP server wrapping `src/server/runtime.ts`; writes the per-pid endpoint file; owns the one-shot 60s "ForgeDesignMode never mounted" hint timer |
| `loader.ts` | the actual Turbopack/webpack loader body, built separately to `dist/next-loader.cjs` so bundlers can `require()` it by path |

`the-forge/design-mode` (`src/design-mode/index.ts`) is the one-component subpath mounted in the app: renders a `<script type="module" src="/__the-forge/client.js">` under `next dev`, `null` otherwise. It and everything it imports must stay free of `node:*` imports — the Pages Router compiles `_app.tsx` straight into the browser bundle — enforced by a boundary test.

### src/server/session modules

| Module | Responsibility |
| --- | --- |
| `adapter.ts` | `SessionAdapter` interface + `SessionEvent` union — harness-agnostic; Codex/Cursor implement this later |
| `claude.ts` | `ClaudeAdapter` — stream-json spawn contract, NDJSON parse, `SessionEvent` mapping; `CLAUDE_ARGS` + `EDIT_TIER_ALLOW` constants |
| `manager.ts` | `SessionManager` — process lifecycle (spawn, interrupt, resume); notifies `ForgeRuntime` on state transitions |
| `approvals.ts` | `ApprovalsRegistry` — pending tool-approval futures, times out to deny; wired to the `approve` MCP tool |

### src/cli modules

| Module | Responsibility |
| --- | --- |
| `index.ts` | the `the-forge` bin entry — the only file allowed to touch `process.argv`/`exit` or spawn a child process; bare `npx the-forge` prints help |
| `init.ts` | `init()` orchestrator for `npx the-forge init` — precondition checks, dependency-declared check, per-step `[done]`/`[skip]`/`[manual]` output, and the manual-fallback snippet constants (byte-identical to SETUP.md's code blocks, sync-tested) |
| `detect.ts` | Vite vs Next detection (error on none/both) |
| `pm.ts` | lockfile-based package-manager sniff (npm/pnpm/yarn/bun) + install command |
| `edits.ts` | pure, fixture-pinned AST edits (add `theForge()` to Vite config, wrap Next config with `withForge()`, mount `<ForgeDesignMode />`) — conservative-fallback: unrecognized shapes are never touched |

### src/client modules

| Module | Responsibility |
| --- | --- |
| `index.ts` | client entry: design-mode toggle, selection wiring, Send button |
| `source.ts` | parse `data-dc-source` attrs; `TaggedElement` type |
| `overlay.ts` | shadow-DOM host, hover/selection outlines, the whole CSS design system (string const) |
| `inspector.ts` | reads an element's computed-style snapshot for the panel |
| `panel.ts` | the properties panel orchestrator (Panel class) |
| `panel-specs.ts` | RowSpec/SectionSpec types, SECTIONS definition, token-scale helpers (`tokenEntriesFor`); also hosts `defeatFillIfGrowing`, the shared app-CSS-fill defeat policy |
| `panel-readers.ts` | pure computed-style readers/normalizers (`isFlex`, `normalizeJustify`, font helpers) |
| `panel-token-ui.ts` | PanelTokenUi — the token affordance cluster: shared TokenPicker instance, scale-field open path, pill boundTokens bookkeeping (B5/Compare rules), color-row token button; plus pillLabelFor/colorDisplay helpers |
| `panel-layout.ts` | `LayoutSection` — the auto-layout cluster (add/remove policy + `FLEX_CONTAINER_PROPS`, direction+wrap, gap, matrix, baseline, flex-child controls); covered by the panel suites, no own test file |
| `controls.ts` | `NumberField` — scrubbing numeric input with math expressions and `auto` |
| `layout-controls.ts` | `SegmentField` + 9-dot `AlignMatrix` |
| `colorpicker.ts` | popover color picker (SV area, hex, contrast ratio) |
| `tokenpicker.ts` | `=` / `{ }`-icon-triggered searchable Tailwind token picker (numeric scales + named colors); bound values render as pills |
| `tokens.ts` | Tailwind v4 theme reader: spacing base, radius/text scales, palette, nearest-token |
| `drafts.ts` | inline-style draft store: apply/current/commit, before-after compare |
| `agent.ts` | which agent is targeted (`claude-code`/`cursor`/`codex`) + display names |
| `ripple.ts` | measures which elements move when a draft lands; flashes ripple outlines |
| `sent.ts` | `SentChange`/`SentEntry` types only (the registry class was absorbed into `lifecycle.ts`) |
| `lifecycle.ts` | `LifecycleSession` — the single owner of in-flight send state: verifier store (`SentStore`), UI row state, persistence projection; `take()` resolves in place so terminal stage events still land |
| `changelist.ts` | Changes lifecycle list (view over `LifecycleSession` + drafts): per-change rows `draft` → `sent` → `applying` → `done`/`failed`, re-send/dismiss |
| `lifecycle-store.ts` | sessionStorage persistence + the canonical element resolver (`resolveElement`/`locateBySource`) used by verifier, healing, and restore |
| `request.ts` | change-request builder: before/after CSS + utility deltas, markdown |
| `prompt.ts` | `PromptBox` — element-anchored free-form prompt box (panel-header Prompt button); sends ride the same queue/dispatch path with `kind: 'prompt'`, lifecycle rows flip on mark_applied alone |
| `session-feed.ts` | `SessionFeed` — authenticated NDJSON stream consumer for the embedded session (EventSource replacement); approval rows with Allow/Deny; Stop button; reconnects with capped backoff |
| `verifier.ts` | post-send polling, computed-style verification, backoff when server is gone |
| `watch.ts` | watcher-state poller (design-mode-on only) for the linked-session indicator |
| `ui/button.ts` | `createButton` — the single place overlay buttons are born |
| `ui/select.ts` | `createSelect` — the `.size-mode` dropdown factory |
| `ui/menu.ts` | `createMenuButton` — chevron + popover menu factory (sizing menu) |
| `ui/swatch.ts` | `createColorRow` — the `.color-row` swatch/value markup (shared by panel + story) |

## MCP contract

- **Four tools** (server name `the-forge`, bin `dist/mcp.js`):
  - `pull_design_edits` — no args; claims all pending items (and re-claims stale ones) and returns their change-request markdown.
  - `mark_applied` — `{ ids: string[], status: 'applied' | 'failed', note? }`.
  - `wait_for_design_edits` — no args; the `/forge-watch` loop (long-poll `POST /__the-forge/wait`, ~20s hold). Lifecycle: wait → apply → mark → re-wait; the server tells the loop to stop after 20 idle minutes (idle auto-stop), on preemption by another watch session, when the user unlinks it from the overlay's watch indicator (`POST /__the-forge/unwatch`), or when no dev server is found. A live watcher makes `/dispatch` return the `watcher` rung and skip the keystroke ladder entirely (`WatcherHub` in `src/server/watchers.ts`).
  - `approve` — `{ tool_use_id: string, tool_name: string, input: unknown }`; the decision is made in the overlay's approval UI (Allow/Deny buttons); deny-on-timeout/unreachable. The CLI is launched with `--permission-prompt-tool mcp__the-forge__approve`; edit-tier tools are statically allowed and never reach `approve`.
- **Endpoint discovery:** the plugin resolves the project root by walking up from Vite's (or Next's) root to the nearest `.git` (`resolveProjectRoot` in `src/server/setup.ts`, monorepo-safe) and writes `.the-forge/endpoint-<pid>.json` (`{port, host, pid, secret}`, written by `writeEndpointFile` in `src/server/endpoints.ts`). The bin (`src/mcp/discover.ts`) walks up from `process.cwd()` (max 10 levels) to the nearest `.the-forge/` with a live endpoint; within a directory it filters entries to live pids, newest mtime wins; legacy `endpoint.json` is only used when no per-pid file exists. Identical on Next — the sidecar writes the same file shape, just from a loopback server instead of Vite's own.
- **Auth:** mutating endpoints (`POST /__the-forge/pull`, `/mark`, `/queue`, `/dispatch`, `/wait`, `/unwatch`, `/session/interrupt`, `/approval`, `/approval/decide`) require the `X-Forge-Secret` header from the endpoint file. `GET /__the-forge/session/events` is also secret-gated (it streams file paths and commands).
- **Install side-effects (auto, idempotent):** the plugin writes a `the-forge` entry into `.mcp.json` and the `/forge-design` + `/forge-watch` commands at `.claude/commands/`, all at the git root; with `agent: 'cursor'` it also writes the entry into `.cursor/mcp.json` so Cursor can `mark_applied` and close the verification loop; it also writes a `.gitignore` entry for `.the-forge/` at the git root. `.the-forge/` is gitignored runtime state.
- **Queue lifecycle:** `pending` → `claimed` (stale claims re-queue after 5 min) → `applied`/`failed`; terminal items pruned after 24h, 200-item cap; corrupt `queue.json` is quarantined to `queue.json.corrupt-<ts>`, never silently discarded. An edit needing user confirmation is marked `failed` with note `needs confirmation: <why>` — never left claimed-but-unmarked, or the stale-claim timeout re-delivers it every 5 min.
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
- New buttons/selects anywhere in the overlay go through `src/client/ui/` factories — never raw `document.createElement`; stories live in `packages/the-forge/stories/` and render the real controls.
- Why-comments are load-bearing project memory. Preserve them verbatim when moving code; never trim them as "verbose".
- `unknown` + manual checks at I/O boundaries is deliberate — no schema libraries.
- Any plugin-written on-disk artifact (`.mcp.json`, command files, `.the-forge/`) installs at `resolveProjectRoot()` — the git root — never Vite's (or Next's) root (monorepo lesson from first real use).
- Panel design decisions (spacing rows, stable section order, Mixed-not-blank, …) are user-ratified in [docs/research/2026-07-04-panel-patterns.md](docs/research/2026-07-04-panel-patterns.md) — don't relitigate them silently.

## Gotchas

- **jsdom cannot see flex layout, cascade, or real computed styles.** Unit tests alone never prove layout/visual behavior — run a real-browser E2E against the demo app before merging UI work.
- Stale dev servers cause phantom bugs — check `lsof -iTCP:5173` and kill before E2E. The dev server often binds IPv6 (`[::1]:5173`).
- The MCP bin discovers `.the-forge/` by walking up from `process.cwd()` (max 10 levels, nearest live endpoint wins) — sessions in project subdirectories work; a session outside the project tree still finds nothing.
- Items stay queued until `mark_applied` — but an immediate re-pull returns nothing (pull flips them to `claimed`; a dropped claim only re-queues after 5 min). The `/forge-design` flow is pull → apply → mark in one pass.
- Watcher liveness (`/forge-watch`) is per-dev-server-process in-memory state — with two dev servers on one project, the watcher belongs to whichever server the MCP bin discovered (newest live endpoint file), while the browser may be talking to the other. Kill stale servers (same rule as E2E).
- The watch loop's per-cycle texts (WATCH_COMMAND in `setup.ts`, canned wait texts in `mcp/protocol.ts`) are a per-tick token cost — keep them terse, and never interpolate server data into them.
- Next calls a `next.config` function (and therefore `withForge`) more than once per dev session — this is normal Next behavior, not a bug to fix. `ensureSidecar`'s module-level singleton and the per-pid endpoint file are what make repeated calls resolve to the same running sidecar instead of racing a second loopback server.
- Next's rewrites proxy rewrites the request's `Host` header to the sidecar's own loopback address — the real page origin survives only in `X-Forwarded-Host`. `isAllowedHost` (`src/server/endpoints.ts`) reads `X-Forwarded-Host` in preference to `Host` when present, so a legitimately proxied same-origin browser request isn't rejected as cross-origin — that's the Origin-vs-Host cross-origin check (below the DNS-rebinding defense gate). `X-Forge-Secret` is the actual load-bearing auth gate regardless of which host header is in play.
- `check-prod-clean.sh`'s Next grep excludes `*.map` — Turbopack embeds pre-DCE `sourcesContent` in sourcemaps for stack traces, which legitimately still contains the dev-only markers; the gate cares about executed/served output, not debug metadata — and it drops the bare `the-forge` token that the Vite-side grep uses, since `.next/` build metadata legitimately names the devDependency.
- Next <15.3's `turbopack.rules` path is accepted-untested (YAGNI, no version sniffing); the webpack rule covers older/non-Turbopack setups. `turbopack.rules` needs no `enforce`/ordering key (our loader is the only transform registered there); the webpack rule DOES need `enforce: 'pre'`.
- The React 18/19 workspace split is deliberate: root and `packages/the-forge` pin React 19, while `fixtures/demo-app` deliberately nests React 18 — two React copies in one page break rendering, so don't "unify" the versions without re-testing both fixture families.
- After `npm run build`, a running demo dev server keeps serving the OLD client bundle — Vite caches the virtual client module; restart the dev server, a browser reload isn't enough.
- Fresh git worktrees need their own `npm install` — otherwise Vite silently resolves `the-forge` to the main checkout's stale build.
- An unignored `.the-forge/` full-reloads Tailwind v4 apps on every Send — the queue markdown is made of class names, so Tailwind's scanner tracks `queue.json`. The plugin now writes the `.gitignore` entry and watcher excludes itself; if a consumer still sees reload-on-send, check that the `.gitignore` write didn't fail.
- The Chrome DevTools Automatic Workspace Folders well-known path (`/.well-known/appspecific/com.chrome.devtools.json`, `DEVTOOLS_JSON_PATH` in `src/server/endpoints.ts`) lives outside the `/__the-forge/` prefix, so it needs its own routing on each framework: Vite's middleware in `createForgeMiddleware` checks for it before the `/__the-forge/` prefix gate; Next has no equivalent middleware hook, so `src/next/index.ts`'s rewrites merge adds a dedicated rewrite rule alongside the `/__the-forge/*` proxy rule, both pointing at the same sidecar.
- **In-band CLI errors (rate limit, auth) arrive as `result` events with exit code 0** — the CLI exits cleanly and returns the error text in the `result` message body. Read the event text, not the exit code; mapping these to `session-error` instead of `turn-complete {isError:true}` is wrong.

## Cursor Cloud specific instructions

Startup dependency refresh (`npm install`) is handled automatically; the notes below are the non-obvious run/verify caveats — standard commands live in the `## Commands` section above.

- **Build the plugin before running the demo app.** `fixtures/demo-app/vite.config.ts` imports `theForge` from `the-forge/vite`, which resolves to `packages/the-forge/dist/vite.js`. A fresh checkout has no `dist/`, so `npm run dev -w demo-app` will fail to resolve the plugin until you run `npm run build` first (`dist/` is gitignored, so it never arrives with the repo).
- **Reaching the dev server:** it prints `http://localhost:5173/` but binds IPv6 (`[::1]:5173`); `localhost:5173` works from the browser and `curl` in this VM. Verify the transform is live with `curl -s http://localhost:5173/src/App.tsx` — served JSX carries `"data-dc-source": "file:line:col"` attributes (JSON-quoted in the compiled output, not raw `data-dc-source="..."`).
- **The demo dev server is the E2E harness** for the design-mode loop (toggle bottom-right → select element → edit in panel → "Send to agent"). A successful send writes a pending item to `.the-forge/queue.json` at the git root; that plus the plugin-written `.mcp.json` and `.claude/commands/` are gitignored runtime state — never commit them.
