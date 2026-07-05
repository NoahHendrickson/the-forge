# npm publish + `npx the-forge init` — design

**Date:** 2026-07-05
**Status:** approved (brainstormed with user; scope user-ratified)
**Milestone:** publish `the-forge` to npm and make per-project setup a single command
**Context:** chosen over a Chrome-extension pivot — evidence in [docs/research/2026-07-05-chrome-extension-pivot.md](../research/2026-07-05-chrome-extension-pivot.md)

## Goal

Remove the felt install friction without changing the architecture: the package goes on npm (name confirmed free 2026-07-05), and `npx the-forge init` turns "follow SETUP.md" into one command run once per repo. The config lands in the repo, so every teammate after the first pays zero setup cost — the structural advantage over any per-developer install.

## Scope (user-ratified)

- **In:** publish readiness (manifest metadata, root `main`/`types` fallback, `bin`), the `init` CLI for Vite and Next (both routers), docs flip to npm install, packaging test. Stretch, cuttable: serve `com.chrome.devtools.json`.
- **Out:** the actual `npm publish` (user runs it — their account and 2FA; we verify with `npm pack`), any daemon/extension work (Approach B), CI release automation, framework detection beyond Vite/Next.
- **Constraints unchanged:** zero new runtime dependencies (`@babel/parser` + `magic-string` only — the CLI's config edits use exactly these), dist-only tarball, 250KB budget, zero production footprint.

## 1. Publish readiness

`packages/the-forge/package.json` gains:

- `main: "./dist/index.js"`, `types: "./dist/index.d.ts"` — fallback for tooling that ignores `exports`; the root stub already throws with a helpful "import a subpath" message, which is the correct fallback behavior.
- `bin: { "the-forge": "./dist/cli.js" }` — new tsup entry, ESM with `#!/usr/bin/env node` shebang.
- `license` (MIT), `description`, `repository`, `homepage`, `keywords`, `engines.node >= 20`.
- Version bumped to `0.1.0` for first publish; unscoped, `--access public`.

A packaging test runs `npm pack --dry-run --json` and asserts: tarball contains `dist/` + manifest/README only, `cli.js` is present and executable, and total size stays under the existing 250KB budget (shared with `check-prod-clean.sh`).

## 2. `init` CLI (`src/cli/` → `dist/cli.js`)

Bare `npx the-forge` prints help; `init` is the only subcommand. No flags in v1 (YAGNI) — conservatism plus reviewing the diff replaces `--dry-run`. `init` never touches git; the user reviews its edits like any other diff.

Steps, each independently idempotent (already done → skip with a note):

1. **Detect framework** by config file at cwd: `vite.config.{ts,js,mjs,mts}` vs `next.config.{ts,js,mjs}`. Neither → error pointing at SETUP.md. Both → error asking the user to run in the app directory (no guessing).
2. **Add the devDependency** with the package manager the lockfile implies (`package-lock.json` → npm, `pnpm-lock.yaml` → pnpm, `yarn.lock` → yarn, `bun.lock`/`bun.lockb` → bun; none → npm): spawn `<pm> add/install -D the-forge`. Skip if already a dependency of any kind.
3. **Edit the config** using `@babel/parser` + `magic-string` (no new deps):
   - Vite: add `import { theForge } from 'the-forge/vite'` and insert `theForge()` **first** in the plugins array (must tag JSX before React's plugin compiles it — same rule as the README).
   - Next: add `import { withForge } from 'the-forge/next'` and wrap the default export — both `export default <expr>` and named-then-exported config shapes.
4. **Mount `<ForgeDesignMode />` (Next only):** locate `app/layout.tsx` (App Router: insert as first child of the root layout's `<body>`) or `pages/_app.tsx` (Pages Router: insert as a sibling of `<Component {...pageProps} />`, wrapping in a fragment if the return isn't already a multi-child element), plus the `the-forge/design-mode` import.
5. **Print next steps:** run dev, Design toggle bottom-right, `/forge-watch` in the agent session. The existing auto side-effects (`.mcp.json`, slash commands) fire on first dev-server start, so `init` doesn't duplicate them.

**Conservative-fallback rule (load-bearing):** every edit targets a small set of recognized AST shapes. Anything else — computed plugins array, re-exported config, config factory it can't confidently rewrap, layout without a literal `<body>` — means *no edit*: print the exact manual snippet for that step and continue with the remaining steps. A wrong automated edit to a build config is strictly worse than a fallback message. The recognized-shape set is pinned by the test fixtures, not prose.

## 3. Stretch (cuttable): `com.chrome.devtools.json`

One route in the shared runtime (so Vite middleware and the Next sidecar both get it): `GET /.well-known/appspecific/com.chrome.devtools.json` → `{ workspace: { root: <resolveProjectRoot()>, uuid } }`, enabling Chrome DevTools Automatic Workspace Folders. The uuid must be stable across restarts: persist it in `.the-forge/devtools-uuid` (gitignored runtime state, same lifecycle as the queue). The route sits behind the same `isAllowedHost` DNS-rebinding gate as everything else — it leaks an absolute filesystem path, so it must never answer a non-local host. No secret required (read-only, Chrome DevTools can't send custom headers here).

Routing wrinkle this stretch pays for: the path lives outside the `/__the-forge/*` prefix, which is all the Vite middleware currently matches and all the Next `rewrites()` proxy forwards — both integrations need one extra path match/rewrite rule. If that spreads complexity further than one rule per framework, cut the stretch rather than widen the surface.

## 4. Docs + tests

- README + SETUP.md: `file:` install replaced by `npm install -D the-forge` / `npx the-forge init` (agent-paste flow updated to prefer `init` and fall back to manual steps). CLAUDE.md: Commands + MCP-contract sections updated; note that `init` exists.
- Tests mirror `src/`: `tests/cli/` unit tests drive the config-edit transforms against fixture configs — the recognized shapes (Vite default, Next `export default`, Next named-config, App/Pages layouts) *and* the exotic shapes that must fall back untouched. An E2E scaffolds bare temp copies of a minimal Vite and Next project (templates without The Forge), runs the built CLI, and asserts the projects boot with the plugin active and re-running `init` is a no-op.
- Root `npm test` remains the gate; `check-prod-clean.sh` unchanged except the shared size budget check.

## Decisions on record

- Bare `npx the-forge` prints help, never acts.
- `init` never runs git commands and never auto-commits.
- Publish is manual by the user; version `0.1.0`.
- Fallback-over-guess for all config edits (see load-bearing rule above).
