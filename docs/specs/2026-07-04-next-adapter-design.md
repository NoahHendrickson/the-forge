# Next.js adapter — design

**Date:** 2026-07-04
**Status:** approved (brainstormed with user; scope and architecture user-ratified)
**Milestone:** `the-forge/next` — The Forge on Next.js apps

## Goal

Make The Forge work on Next.js apps the way it already works on Vite apps: design mode in the browser, deterministic change requests, the same MCP loop (`/forge-design`, `/forge-watch`), the same guarantees. First validation target is a real app (`stat-builder`: Next 16, App Router, Turbopack, `--experimental-https`), but the milestone targets modern Next broadly.

## Scope (user-ratified)

- **Next 15 and 16.** Older versions untested, not blocked.
- **Both routers** — App Router and Pages Router. The loader tags all JSX regardless of router; router only affects where `<ForgeDesignMode />` goes (root layout vs `_app.tsx`).
- **Both dev bundlers** — Turbopack and webpack. Turbopack is the primary path (Next 16 default); webpack covers the Next 15 installed base.
- **Setup friction: two touches.** `withForge()` around `next.config` + one `<ForgeDesignMode />` in the root layout / `_app.tsx`. No zero-touch layout-rewriting magic.
- **Out of scope:** Pages Router on Next <15, `output: 'export'` special-casing, custom-server (`server.js`) setups, production anything.

## Decision: one package, not two

The published package becomes **`the-forge`** (bare name confirmed available on npm, 2026-07-04) with subpath exports; `@the-forge/vite` is retired before it was ever published:

| Import | Contents | Runs in |
| --- | --- | --- |
| `the-forge/vite` | `theForge()` — the existing Vite plugin, unchanged API | node (Vite config) |
| `the-forge/next` | `withForge()` + the tagging loader | node (Next config) |
| `the-forge/design-mode` | `ForgeDesignMode` React component | server AND client bundles |
| `the-forge` (root) | throws with a clear "import `the-forge/vite` or `the-forge/next`" error | — |

Rationale: users (and the SETUP.md agent-install flow) never pick between packages — one install, framework chosen by import path. This is the `unplugin`-ecosystem pattern. Accepted trade-offs: coupled release cadence across frameworks (cosmetic for a dev tool) and both adapters in every tarball (negligible — `client.js` + `mcp.js` dominate and are shared; 250KB budget holds, currently ~174KB).

**Client-safety boundary (load-bearing):** `the-forge/design-mode` must contain **zero node imports** — in the Pages Router, `_app.tsx` compiles into the browser bundle, so anything reachable from that subpath ships to the client. `withForge`'s node machinery lives only under `the-forge/next`. A test enforces the boundary (build/resolve the `design-mode` entry and assert no `node:*` in its module graph).

`vite` and `next` are both **optional** peer dependencies (`peerDependenciesMeta`) so neither framework's users see warnings about the other.

**Monorepo rename:** `packages/vite-plugin` → `packages/the-forge`, package name `@the-forge/vite` → `the-forge`; update workspace `-w` flags in root scripts, CLAUDE.md, README, SETUP.md, check-prod-clean.sh. Mechanical, one-time, safe only because nothing is published yet.

## Architecture — sidecar + rewrites proxy

Chosen over (B) a generated route handler inside the user's app — rejected because it plants generated code in the user's source tree and demotes zero-prod-footprint from a structural guarantee to a runtime guard — and (C) direct cross-origin browser→sidecar — rejected because it forces base-URL threading through every client fetch and a rework of the Origin/Host security model.

Everything below activates **only** under `PHASE_DEVELOPMENT_SERVER` (Next passes the phase to config functions). Production builds get the user's config back untouched — Forge code is structurally absent, not guarded off.

### The sidecar

A bare `http.createServer` wrapping the existing `createForgeMiddleware` — which already speaks plain node `IncomingMessage`/`ServerResponse` and imports nothing from Vite. **In-process**, not a child process: it lives inside Next's dev-server process and dies with it, no orphan management. Binds an ephemeral port (`listen(0)`) on `127.0.0.1` — no fixed port to collide on.

The sidecar reuses verbatim: `Queue`, `WatcherHub`, `dispatch`, `resolveProjectRoot`, `setupProjectConfig` (writes `.mcp.json`, `/forge-design` + `/forge-watch` commands at the git root), `writeEndpointFile`/`removeEndpointFile` (per-pid endpoint files with the shared secret). The MCP bin, both slash commands, the dispatch ladder, and the queue lifecycle work identically — a Claude Code session cannot tell whether the endpoint file points at a Vite server or a Forge sidecar.

One addition relative to Vite: the sidecar serves `GET /__the-forge/client.js` — the built client bundle with the same one-line secret bootstrap (`globalThis.__THE_FORGE__ = {secret, agent}`) the Vite `load()` hook prepends today. (In Vite this route doesn't exist because the bundle is served as a virtual module.)

### `withForge(nextConfig, options?)`

Options: `agent`, `experimentalChannels` — same as the Vite plugin. Responsibilities:

1. **Loader registration, three config paths, one loader file.** The loader is webpack-API-compatible and calls the existing `tagJsxSource(code, relPath)`:
   - Next 16 / 15.3+: `turbopack.rules`
   - Next 15 < 15.3: `experimental.turbo.rules`
   - webpack: chain onto the user's `config.webpack`
   Filtering matches the Vite `transform` hook: `.jsx`/`.tsx` only, skip `node_modules`, path relativized to the project root, cross-drive/absolute-escape excluded. Server and client compilations run the same loader, so `data-dc-source` attributes match across SSR and hydration — no mismatch warnings.
2. **Sidecar start + proxy.** `withForge` prepends an **async `rewrites()`** entry: start (or reuse) the sidecar, await its bound port, return `/__the-forge/:path*` → `http://127.0.0.1:<port>/__the-forge/:path*`, then chain the user's own rewrites in whatever form they took (array or `{beforeFiles,…}` object).
3. **Double-load guard.** Next loads `next.config` more than once per dev session. A module-level singleton plus the existing live-pid endpoint-file check means the second load reuses the running sidecar; never a double bind, never two endpoint files from one dev server.

### `ForgeDesignMode`

Dev: renders `<script type="module" src="/__the-forge/client.js" />`. Production (`NODE_ENV !== 'development'`): renders `null`. Works as a server component (App Router root layout) and in client bundles (`_app.tsx`) — hence the node-free subpath. Same-origin script + same-origin fetches mean HTTPS dev servers (stat-builder's `--experimental-https`) need nothing special: the browser only ever talks to Next.

## Error handling

- **Missing `<ForgeDesignMode />`** — the most likely user mistake. If design mode never loads (no client hit on the sidecar within a grace period after first page compile), `withForge` logs a one-line hint: `The Forge: add <ForgeDesignMode /> from 'the-forge/design-mode' to your root layout`. Exact trigger heuristic is a plan-level detail; requirement is: silent-failure is not acceptable, one line, no nagging repeat.
- **User rewrites clobber the proxy** — client's first status poll fails; the panel's existing "dev server unreachable" copy covers it. Degraded, not broken; no new UI.
- **Sidecar bind failure** — warn once with the underlying error; Next dev continues unaffected (The Forge is never load-bearing for the user's app).
- **Host/Origin checks** — `createForgeMiddleware`'s existing checks stay; the allowed-hosts list for the sidecar accounts for proxied-request headers as observed in the spike (plan-level detail; requirement: mutating endpoints keep requiring `X-Forge-Secret`, non-loopback callers keep being rejected).

## Guarantees (carried over, Next-flavored)

- **Zero production footprint** — structural (phase-gated config, `null`-rendering component) **plus** a new gate: `check-prod-clean.sh` grows a Next fixture step that runs `next build` and asserts zero Forge traces (`data-dc-source`, `__the-forge`, `THE_FORGE`) in `.next/` output.
- **Zero idle overhead** — client bundle unchanged (no listeners/observers/timers until design mode toggles on); sidecar idles as cheaply as the Vite middleware.
- **Zero new runtime dependencies** — loader, sidecar, and component add none; `@babel/parser` + `magic-string` remain the only two.
- **Token-first, deterministic change requests; complementary-not-replacement; subscription-only** — untouched by this milestone.

## Testing

- **Unit (mirror `src/`):** loader (filtering, relativization, delegation to `tagJsxSource`), `withForge` config merging across the three bundler paths and both user-rewrites shapes, `ForgeDesignMode` dev/prod rendering, sidecar singleton/double-load guard, client-safety boundary of `the-forge/design-mode` (no `node:*` in its graph).
- **Fixtures:** `fixtures/next-demo` (App Router, Next 16, Turbopack — primary E2E target, same demo content as the Vite demo app) and a minimal Pages Router fixture.
- **E2E (real browser, house rule — jsdom proves nothing about layout):** full loop against `next-demo`: toggle design mode → edit → Send → MCP pull/apply → verifier flips draft to Implemented. Webpack-mode smoke on the same fixture.
- **Spike first (plan task 0):** prove loader + async-rewrites + in-process sidecar on both bundlers in a throwaway fixture **before** building the real thing. Turbopack's JS-loader compatibility and proxied-header behavior are the two assumptions this repo can't verify offline. Spike findings feed the plan; if Turbopack rules can't run our loader, that's a design-level stop-and-reassess, not a workaround.

## Exit criteria

1. Root `npm test` green (existing suite + new unit tests); `check-prod-clean.sh` green including the new Next gate.
2. Full E2E loop passes on `fixtures/next-demo` (Turbopack) in a real browser; webpack smoke passes.
3. The Forge installed and the full loop exercised on **stat-builder** end-to-end.
4. SETUP.md and README updated: one package, framework-specific wiring, agent-install instructions framework-agnostic.

## Open questions deferred to the plan

- Exact Turbopack `rules` syntax per Next version (spike output).
- The missing-`ForgeDesignMode` hint's trigger heuristic.
- Whether the Pages Router fixture is E2E'd or unit/manual-only (lean: manual smoke + unit; it shares every code path with App Router except the component's mount point).
