# npm publish + `npx the-forge init` (2026-07-05)

Implements [docs/specs/2026-07-05-npm-init-design.md](../specs/2026-07-05-npm-init-design.md):
publish readiness for the `the-forge` package (name confirmed free 2026-07-05) and a
one-command per-repo setup CLI. Chosen over a Chrome-extension pivot —
[docs/research/2026-07-05-chrome-extension-pivot.md](../research/2026-07-05-chrome-extension-pivot.md).

> **For agentic workers:** execute task-by-task with the repo's usual review gates
> (superpowers:subagent-driven-development or superpowers:executing-plans). Gate after every
> task: `npm run build && npm test` from the repo root, then commit.

## Global constraints (inherited, non-negotiable)

- Zero new runtime dependencies — the CLI's config edits use `@babel/parser` + `magic-string`
  only (already shipped). No commander/prompts/chalk/etc.
- **Conservative-fallback rule (load-bearing):** every automated edit targets a small set of
  recognized AST shapes, pinned by test fixtures. Anything else → NO edit; print the exact
  manual snippet for that step and continue with remaining steps. A wrong automated edit to a
  build config is strictly worse than a fallback message.
- `init` never runs git commands, never auto-commits. Bare `npx the-forge` prints help, never acts.
- Publish itself is manual by the user (`npm publish --access public`, version `0.1.0`); we
  verify with `npm pack` in the existing prod-clean gate.
- Dist-only tarball; 250KB unpacked budget (existing gate in `check-prod-clean.sh`).
- `unknown` + manual checks at I/O boundaries; no schema libraries.
- Docs/CLI copy: token-terse, no marketing voice in terminal output.

## A1 — Publish readiness (`package.json`, `tsup.config.ts`, prod-clean gate)

`packages/the-forge/package.json` changes:

```jsonc
{
  "version": "0.1.0",
  "description": "Figma-style design mode for your running Vite or Next.js app — sends deterministic, token-aware change requests to the AI coding agent you already use.",
  "license": "MIT",
  "repository": { "type": "git", "url": "git+https://github.com/NoahHendrickson/the-forge.git" },
  "homepage": "https://github.com/NoahHendrickson/the-forge#readme",
  "keywords": ["design-mode", "vite-plugin", "nextjs", "mcp", "claude-code", "cursor", "tailwind", "devtools"],
  "engines": { "node": ">=20" },
  // exports stays first-class; main/types are the fallback for exports-unaware tooling.
  // The root stub throws with the "import a subpath" message — that IS the correct fallback.
  "main": "./dist/index.js",
  "types": "./dist/index.d.ts",
  "bin": { "the-forge": "./dist/cli.js" }
}
```

`tsup.config.ts` gains one entry (cli must never import `vite`, `next`, or anything under
`src/client/`):

```ts
{
  entry: { cli: 'src/cli/index.ts' },
  format: ['esm'],
  platform: 'node',
  banner: { js: '#!/usr/bin/env node' },
},
```

`scripts/check-prod-clean.sh` already runs `npm pack --dry-run --json`; extend that section to
also assert, from the same `$PACK_JSON`: every tarball file path is `dist/*`, `package.json`,
or `README.md` (npm auto-includes README/LICENSE); `dist/cli.js` is present. Add `LICENSE`
(MIT, root) — npm auto-includes it once it exists.

Tests (`tests/packaging.test.ts`, new): read `packages/the-forge/package.json` and assert the
manifest invariants that protect consumers — `bin['the-forge'] === './dist/cli.js'`,
`main`/`types` point at the root stub's dist files, `files` is exactly `["dist"]`, every
`exports` subpath maps into `dist/`, version is a valid semver ≥ 0.1.0. (Tarball-content
assertions live in the shell gate above because they need a built `dist/`; vitest must pass
on a clean checkout.)

Gate: `npm run build && npm test && ./scripts/check-prod-clean.sh` — then verify the shebang
landed: `head -1 packages/the-forge/dist/cli.js` → `#!/usr/bin/env node`. Commit.

## A2 — Pure edit transforms (`src/cli/edits.ts`)

The heart of `init`, and the only genuinely risky code — so it's pure `string → result`, no fs,
exhaustively fixture-tested. Parse with `@babel/parser` (`sourceType: 'module'`,
plugins `['typescript', 'jsx']` — same recipe as `transform.ts`), splice with `magic-string`.

```ts
export type EditResult =
  | { kind: 'edited'; code: string }
  | { kind: 'already' }                    // forge import/call already present — idempotent no-op
  | { kind: 'fallback'; reason: string }   // unrecognized shape — caller prints the manual snippet

/** Vite: add `import { theForge } from 'the-forge/vite'` (after the last import) and insert
 * `theForge(), ` as the FIRST element of the plugins array (must tag JSX before the React
 * plugin compiles it). */
export function addViteForgePlugin(source: string): EditResult

/** Next: add the withForge import (ESM import or CJS require, matching the file's own style)
 * and wrap the exported config expression: `export default X` → `export default withForge(X)`. */
export function wrapNextConfigExport(source: string): EditResult

/** Next only: add `import { ForgeDesignMode } from 'the-forge/design-mode'` and mount
 * `<ForgeDesignMode />`. */
export function mountDesignMode(source: string, router: 'app' | 'pages'): EditResult
```

Recognized shapes (the fixture set IS the contract; everything else falls back):

- `addViteForgePlugin` — `already` when source contains `the-forge/vite`. Edits when the
  default export is `defineConfig(<ObjectExpression>)` or a bare `<ObjectExpression>`, with a
  literal `plugins: [<ArrayExpression>]` property (spreads/calls *inside* the array are fine —
  insertion at index 0 is still exact). Fallbacks: no default export; `defineConfig(() => …)`
  factory; `plugins` computed/missing; re-export (`export { default } from …`).
- `wrapNextConfigExport` — `already` when source contains `the-forge/next`. Edits
  `export default <expr>` (object literal, identifier, or call — wraps any expression) and CJS
  `module.exports = <expr>` (import becomes `const { withForge } = require('the-forge/next')`
  at top of file). Fallbacks: no recognizable export; `export default` of a function
  *declaration* (config-function rewrap is out — YAGNI, the manual snippet covers it);
  `withForge` already wrapping (that's `already`, matched by the import check).
- `mountDesignMode` — `already` when source contains `the-forge/design-mode`.
  `router: 'app'`: find the JSXElement named `body`; insert `<ForgeDesignMode />` as its first
  child (right after the opening tag), indented to match. Fallback: no literal `<body>` in the
  file. `router: 'pages'`: find the JSXElement named `Component`; if its parent is a
  JSXElement/JSXFragment, insert `<ForgeDesignMode />` as the following sibling; if
  `<Component …/>` is the entire return expression, wrap it:
  `<><Component {...pageProps} /><ForgeDesignMode /></>` (parenthesized, matching source
  indentation). Fallback: no `<Component>` element found.

Tests (`tests/cli/edits.test.ts`): one case per recognized shape asserting the exact output
(snapshot-free — assert the inserted lines and that the rest of the source is byte-identical),
one per fallback shape asserting `{ kind: 'fallback' }` and that no code was produced, plus
`already` cases (re-run each `edited` output through the same function → `already`). Include
the three real fixture files' current content (demo-app `vite.config.ts`, next-demo
`next.config.ts` + `layout.tsx` with the forge lines stripped) as fixtures — those exact
shapes must edit cleanly, and pages `_app.tsx` both with and without an existing fragment.

Gate + commit.

## A3 — CLI entry, detection, orchestration (`src/cli/index.ts`, `detect.ts`, `pm.ts`, `init.ts`)

Four small files, responsibilities split so everything below the entry point is testable
without spawning processes:

```ts
// detect.ts — filesystem sniffing, all pure given a dir listing
export type Detected =
  | { kind: 'vite'; configPath: string }
  | { kind: 'next'; configPath: string; layout: { router: 'app' | 'pages'; path: string } | null }
  | { kind: 'none' }
  | { kind: 'both' }
export function detectFramework(cwd: string): Detected
// vite.config.{ts,mts,js,mjs} vs next.config.{ts,mjs,js}; first match per framework in that
// order. Layout search: {app,src/app}/layout.{tsx,jsx} then {pages,src/pages}/_app.{tsx,jsx};
// layout: null → the mount step falls back to the manual snippet.

// pm.ts — lockfile sniff + command construction, pure
export type PM = 'npm' | 'pnpm' | 'yarn' | 'bun'
export function detectPM(cwd: string): PM        // package-lock.json → npm, pnpm-lock.yaml →
                                                 // pnpm, yarn.lock → yarn, bun.lock/bun.lockb
                                                 // → bun; none → npm
export function installCommand(pm: PM): { cmd: PM; args: string[] }
// npm → install -D the-forge · pnpm → add -D · yarn → add -D · bun → add -d

// init.ts — the orchestrator; all effects behind an injectable IO seam
export interface InitIO {
  cwd: string
  log: (line: string) => void
  /** spawn wrapper; resolves with the exit code. Tests stub it; index.ts passes a real
   * child_process.spawn(stdio: 'inherit') wrapper. */
  run: (cmd: string, args: string[]) => Promise<number>
}
export async function init(io: InitIO): Promise<number>   // process exit code
```

`init` sequence — each step independently idempotent, each prints exactly one line,
`[done]` / `[skip]` (with why) / `[manual]` (followed by the snippet block):

1. No `package.json` at cwd → error pointing at SETUP.md, exit 1. `detectFramework`:
   `none` → same; `both` → error asking to run in the app directory (no guessing), exit 1.
2. Dependency: skip if `the-forge` appears in any dep table of `package.json`; else
   `const { cmd, args } = installCommand(detectPM(cwd)); await io.run(cmd, args)` — nonzero
   exit → print the manual install line and
   continue (the config edits are still worth doing).
3. Config edit via A2 (`addViteForgePlugin` or `wrapNextConfigExport`), read/write with plain
   `fs`. `fallback` → `[manual]` + the exact snippet from SETUP.md for that framework.
4. Next only: `mountDesignMode` on the detected layout (or `[manual]` when `layout: null`).
5. Next-steps footer (constant string): dev command, Design toggle bottom-right,
   `/forge-watch`. Auto side-effects (`.mcp.json`, slash commands) fire on first dev-server
   start — `init` does not duplicate them.

`index.ts` (the bin): `argv[2] === 'init'` → `process.exit(await init(realIO))`; anything else
(including nothing) prints the help text — name line, `usage: npx the-forge init`, two-line
description, docs URL — and exits 0 (2 for unknown subcommands).

Tests: `tests/cli/detect.test.ts` and `tests/cli/pm.test.ts` against temp-dir scaffolds
(mkdtemp + touch the marker files, including both-frameworks and src/-prefixed layouts);
`tests/cli/init.test.ts` drives `init()` with a stubbed `run` (records calls, returns 0)
against scaffolded minimal projects: Vite happy path (config edited, install invoked with the
lockfile-matched pm, footer printed), Next happy path (config wrapped + layout mounted),
exotic-config project (config untouched on disk, `[manual]` printed, exit 0), failed-install
path (run → 1: continues to config edit, exits 0 with the manual install line), and the
idempotency contract: run `init` twice, second run all `[skip]`, files byte-identical.

Gate + commit.

## A4 — Real-world smoke gate (`scripts/check-init.sh`)

The vitest suite never runs a real package manager or dev server, so — same pattern as the
fixture smoke gates — a script proves the whole loop on the built artifact. Not part of
`npm test`; run before merging, like `check-prod-clean.sh`.

Sequence (bash, `set -euo pipefail`, temp dir under `$(mktemp -d)`, cleaned on exit):

1. `npm run build`, then `npm pack -w the-forge` into the temp dir.
2. Scaffold a bare Vite app (no Forge): minimal `package.json`, `vite.config.ts` with
   `defineConfig({ plugins: [react()] })`, `index.html`, `src/main.tsx`, `src/App.tsx`;
   `npm install` + `npm install -D <tarball>`.
3. `node node_modules/the-forge/dist/cli.js init` (the tarball's real bin) → assert exit 0,
   `vite.config.ts` now imports `the-forge/vite` with `theForge()` first in plugins.
4. Boot `npx vite --port 5199` in the background; poll until up; assert the transform is live:
   `curl -s http://localhost:5199/src/App.tsx | grep -q 'data-dc-source'`; kill it.
5. Re-run `init` → assert output contains no `[done]` (all `[skip]`), config byte-identical.
6. Repeat 2–5 for a bare Next App Router app (`next.config.ts` with `export default {}`,
   minimal `app/layout.tsx` + `app/page.tsx`; boot `next dev --port 5198`; assert
   `curl -s http://localhost:5198/ | grep -q 'data-dc-source'` and that `layout.tsx` gained
   the mount). Next boot is the slow half — keep its poll timeout generous (90s).

Ports 5198/5199 are outside every fixture's range — the stale-dev-server gotcha applies; the
script asserts the port is free first (`lsof -iTCP:5199` empty) rather than killing anything.

Gate: `./scripts/check-init.sh` passes end-to-end + `npm test`. Commit.

## A5 — Stretch, cuttable: `com.chrome.devtools.json`

One well-known route so Chrome DevTools' Automatic Workspace Folders maps the served page to
the project directory. **Cut rule (from the spec): if this spreads further than one extra
path rule per framework, drop the task.**

- `src/server/setup.ts`: `export function ensureDevtoolsUuid(forgeDir: string): string` —
  read `<forgeDir>/devtools-uuid` if present, else `randomUUID()` + write (mode 644 like the
  endpoint file). Stable across restarts — DevTools keys the folder association on it.
- `src/server/endpoints.ts`: `const DEVTOOLS_JSON_PATH =
  '/.well-known/appspecific/com.chrome.devtools.json'`. In `createForgeMiddleware`, BEFORE the
  `/__the-forge/` prefix early-return: if `url === DEVTOOLS_JSON_PATH` and
  `dispatchConfig.cwd` is set, apply `isAllowedHost` (the response leaks an absolute path —
  never answer a non-local host), then serve
  `{ workspace: { root: dispatchConfig.cwd, uuid: ensureDevtoolsUuid(<cwd>/.the-forge) } }`.
  No secret gate (read-only; DevTools can't send custom headers). When `cwd` is absent
  (legacy tests/callers) → fall through to `next()` unchanged.
- `src/next/index.ts`: `mergeRewritesWithSidecar` emits a second rule alongside the existing
  one: `{ source: DEVTOOLS_JSON_PATH, destination: 'http://127.0.0.1:<port><DEVTOOLS_JSON_PATH>' }`.
  (Sidecar already routes through the same middleware — no sidecar change.)

Tests (`tests/server/endpoints.test.ts` additions + `tests/server/setup.test.ts`):
uuid persists across two `ensureDevtoolsUuid` calls and survives re-read from disk; GET on the
well-known path with `cwd` configured returns root+uuid; without `cwd` falls through to
`next()`; disallowed Host → 403; `tests/next/` rewrites test asserts both rules present with
the sidecar port. Manual verify note: `chrome://devtools` → open the Vite demo → Sources →
Workspace shows the repo folder.

Gate + commit.

## A6 — Docs flip (README, SETUP.md, CLAUDE.md)

- README: "Set it up in your own project" leads with `npx the-forge init`; the `file:` install
  paragraph is replaced by `npm install -D the-forge` as the manual path; keep the config
  snippets (they're now also the CLI's fallback snippets — SETUP.md is their single source).
- SETUP.md: agent-paste flow becomes "run `npx the-forge init`, then verify"; manual steps
  stay as the fallback section the CLI's `[manual]` output points at. Snippets in SETUP.md and
  the constants in `src/cli/` must match verbatim — add a test note in `tests/cli/init.test.ts`
  asserting the CLI's fallback snippets appear in SETUP.md (reads the repo file; skip when the
  file is absent in a packaged context).
- CLAUDE.md: Commands section gains the CLI (`npx the-forge init` + `scripts/check-init.sh`);
  the architecture section gains one line for `src/cli/`; Gotchas gains the A5 well-known
  path note (outside the `/__the-forge/` prefix — Vite middleware handles it before the
  prefix check; Next needs its own rewrite rule) if A5 shipped.
- Root README "Status" gains this milestone's line once merged.

Gate: full `npm test` + `./scripts/check-prod-clean.sh` + `./scripts/check-init.sh`. Commit.

## Execution order & review gates

A1 → A2 → A3 → A4 → (A5) → A6. A2/A3 are the review-heavy tasks (the conservative-fallback
rule lives there); A4 is the merge blocker (real-artifact proof); A5 is cuttable without
touching anything else; A6 last so docs describe what actually shipped. After A6: user runs
`npm publish --access public` from `packages/the-forge/` when ready — nothing in this
milestone depends on the publish having happened.
