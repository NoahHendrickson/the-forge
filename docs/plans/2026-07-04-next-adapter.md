# Next.js adapter — `the-forge` on Next 15/16 (2026-07-04)

> **For agentic workers:** execute with superpowers:subagent-driven-development (or
> superpowers:executing-plans), one task per section, root `npm test` +
> `./scripts/check-prod-clean.sh` as the gate after every task.

Implements [docs/specs/2026-07-04-next-adapter-design.md](../specs/2026-07-04-next-adapter-design.md):
The Forge working on Next.js apps (15/16, both routers, both dev bundlers) via a single
renamed package `the-forge` with subpath exports, an in-process sidecar hosting the
existing (Vite-free) server code, and an async-`rewrites()` same-origin proxy. The Vite
plugin's behavior is byte-for-byte unchanged; everything downstream of the endpoint file
(MCP bin, `/forge-design`, `/forge-watch`, dispatch ladder, queue) ships untouched.

**Tech stack:** existing only — TypeScript, tsup, vitest, `@babel/parser` + `magic-string`.
Next.js appears solely as a fixture devDependency and an optional peer.

## Global constraints (inherited, non-negotiable)

- Zero new runtime dependencies: `@babel/parser` + `magic-string` remain the only two.
  `vite`, `next`, `react` are peers; `next`/`react` marked optional in `peerDependenciesMeta`.
- Zero production footprint — structural, not guarded: `withForge` activates only under
  `PHASE_DEVELOPMENT_SERVER`; `ForgeDesignMode` renders `null` outside development;
  `check-prod-clean.sh` gains a Next gate (N7).
- Zero idle overhead in the page: the client bundle is reused unmodified, so this holds by
  construction. The sidecar may hold ONE one-shot 60s timer (N4 hint) — dev-server-side,
  explicitly allowed.
- `the-forge/design-mode` must contain zero `node:*` imports (Pages Router `_app.tsx`
  compiles into the browser bundle). Enforced by test (N5).
- Subscription-only, deterministic token-first change requests, complementary-not-
  replacement: untouched by this milestone.
- Package-size budget stays 250KB unpacked (gate updated for the rename in N1).
- Panel/overlay CSS class names are test hooks — this milestone must not touch `client/`.
- `unknown` + manual checks at I/O boundaries; no schema libraries.

## N0 — Spike: prove the three risky assumptions (throwaway)

A disposable fixture (`/tmp` or `fixtures/next-spike`, deleted before merge) with a
hand-written `next.config.ts` — no library code yet. Answers, recorded in
`docs/research/2026-07-04-next-spike-findings.md`:

1. **Turbopack runs our JS loader.** A minimal webpack-style loader that appends a
   comment; registered under `turbopack.rules` (Next 16) with glob `'*.{jsx,tsx}'` and
   `as: '*.tsx'` semantics as needed. Record the exact `rules` syntax that works on
   Next 16 and whether `experimental.turbo.rules` differs on Next 15.x. Also record the
   loader module format Turbopack requires (CJS vs ESM, default export shape) — this
   decides the loader's tsup output format in N2.
2. **Async `rewrites()` can await a just-started in-process http server** and proxy
   `/__the-forge/:path*` to it, on `next dev` (Turbopack AND `--webpack`) and with
   `--experimental-https`. Record: how many times `next.config` is evaluated per dev
   session and in which processes (decides the N3 singleton guard's strength); what
   `Host`/`Origin` headers the proxied request carries (decides whether the N3 wrapper
   must normalize headers before delegating to `createForgeMiddleware`, whose
   loopback/allowed-hosts check must NOT be weakened).
3. **Tagged JSX survives both compilations without hydration mismatch.** Loader tags a
   server component and a client component; browser console shows no mismatch warnings;
   `data-dc-source` visible in the served DOM for both.

Failure of (1) or (2) is a design-level stop: report findings to the user and reassess —
do not improvise a workaround. No gate for this task beyond the findings doc (spike code
is not merged).

## N1 — Package rename: `@the-forge/vite` → `the-forge`, subpath exports

Safe only because nothing is published (bare name `the-forge` confirmed free 2026-07-04).

- `git mv packages/vite-plugin packages/the-forge`. Package name → `"the-forge"`.
- Exports map (replaces `main`/`types`; `files: ["dist"]` stays):

```jsonc
"exports": {
  ".":             { "types": "./dist/index.d.ts",       "default": "./dist/index.js" },
  "./vite":        { "types": "./dist/vite.d.ts",        "default": "./dist/vite.js" },
  "./next":        { "types": "./dist/next.d.ts",        "default": "./dist/next.js" },
  "./design-mode": { "types": "./dist/design-mode.d.ts", "default": "./dist/design-mode.js" }
}
```

- `src/index.ts` (the old Vite entry) → `src/vite.ts`, re-exported names unchanged
  (`theForge`, `TheForgeOptions`, `CLIENT_ID`, default export). New `src/index.ts` root
  stub whose module body throws:
  `new Error("the-forge has no root export — import 'the-forge/vite' or 'the-forge/next'")`.
- tsup: `index`, `vite` entries added alongside existing `client`/`mcp`; `next`,
  `design-mode`, `next-loader` entries land in N2–N5 (each task extends the config).
- Peers: `vite: ">=5"` stays; add `next: ">=15"`, `react: ">=18"`; `peerDependenciesMeta`
  marks all three `optional: true` (a Vite user must not see a `next` warning and vice
  versa — the entry you import validates its own peer at runtime by failing to resolve).
- Update every `@the-forge/vite` reference: root `package.json` scripts (`-w` flags),
  `scripts/check-prod-clean.sh` (build + `npm pack` lines), `fixtures/demo-app/package.json`
  (`"the-forge": "*"`) and its `vite.config.ts` import (`from 'the-forge/vite'`),
  CLAUDE.md, README.md, SETUP.md, `src/vite.ts`'s client-bundle-missing error message.
- Tests: existing suite imports from `src/` relatives — expected churn is only the moved
  `src/index.ts` → `src/vite.ts` import in `tests/` (plugin-shell tests, if any import it).

Gate: root `npm test` green, `./scripts/check-prod-clean.sh` green, and
`npm run dev -w demo-app` boots with the Design toggle present (manual smoke — the rename
must be invisible at runtime).

## N2 — Tagging loader (`src/next/loader.ts`)

```ts
export interface ForgeLoaderOptions { root: string } // resolveProjectRoot()d git root
/** webpack-loader-API-compatible (the subset Turbopack supports): sync, uses
 * this.resourcePath + this.getOptions(); returns via this.callback(null, code, map). */
export default function forgeLoader(this: LoaderContext, source: string): void
```

- Delegates to the existing `tagJsxSource(code, relPath): { code, map } | null` —
  `null` (parse failure / no JSX) ⇒ pass `source` through unchanged.
- Filtering mirrors the Vite `transform` hook byte-for-byte in intent:
  `/\.[jt]sx$/` on the path (query-stripped), skip `/node_modules/`, `relPath` =
  `path.relative(options.root, resourcePath)` POSIX-normalized; relative paths escaping
  root (`..` prefix) or still-absolute (Windows cross-drive) pass through untagged.
- Emitted as its own tsup entry in the format N0 recorded Turbopack requires
  (`next-loader` entry; CJS `dist/next-loader.cjs` expected — Turbopack `loaders: [...]`
  entries are resolved paths/strings, and `withForge` (N4) passes
  `require.resolve`-style absolute paths so user projects never resolve it themselves).
- `LoaderContext` is a ~5-line local interface (`resourcePath`, `getOptions()`,
  `callback`) — no `@types/webpack` dependency.

Tests (`tests/next/loader.test.ts`): tags a `.tsx` source (attribute present, correct
`file:line:col` from a known snippet); passes through `.ts` (no `x`) untouched;
node_modules path untouched; parse-failure source returned verbatim; path relativized
against `options.root` with POSIX separators; escape-root path untagged. Loader invoked
with a stub `this` ({ resourcePath, getOptions, callback }) — no bundler in unit tests.

## N3 — Sidecar (`src/next/sidecar.ts`)

```ts
export interface SidecarHandle { port: number; close(): Promise<void> }
export interface SidecarOpts {
  agent: DispatchOpts['agent']
  channelsFlag: boolean
  root: string                    // resolveProjectRoot()d
  clientBundle: () => string      // injectable for tests; prod impl reads dist/client.js
  listenHost?: string             // default '127.0.0.1'
}
/** Module-level singleton: second call resolves the SAME handle (double config-load
 * guard, per N0 finding). Never double-binds, never writes two endpoint files. */
export function ensureSidecar(opts: SidecarOpts): Promise<SidecarHandle>
```

Semantics:

- `http.createServer` on `listen(0, '127.0.0.1')` — ephemeral port, loopback only.
- Request handling: `GET /__the-forge/client.js` → `Content-Type: text/javascript`,
  body = `globalThis.__THE_FORGE__ = ${JSON.stringify({ secret, agent })};\n` +
  `clientBundle()` (same bootstrap line as the Vite `load()` hook — the ONLY place the
  secret reaches the page). Everything else delegates to
  `createForgeMiddleware(queue, allowedHosts, secret, { agent, channelsFlag, cwd: root }, hub)`
  with a 404 fallthrough `next`. Header normalization before delegation only if N0 found
  the proxied `Host` fails `isAllowedHost` — normalize in the sidecar wrapper, never
  loosen the middleware.
- Runtime construction is EXTRACTED, not copied (pre-flight amendment — the review rubric
  treats a duplicated logic block as a defect): new `src/server/runtime.ts` —

```ts
export interface ForgeRuntime { queue: Queue; hub: WatcherHub; secret: string; forgeDir: string }
/** Hoists the queue/hub/secret construction that src/vite.ts configureServer builds today:
 * Queue at <resolvedRoot>/.the-forge, migrateLegacyForgeDir(resolvedRoot, viteRoot, queue),
 * WatcherHub({ claim: () => queue.pull(), applying: () => queue.hasFreshClaims() }),
 * per-start randomUUID() secret. Endpoint-file lifecycle stays with each caller —
 * listen/close hooks differ per server. */
export function createForgeRuntime(resolvedRoot: string, viteRoot?: string): ForgeRuntime
```

  `src/vite.ts` switches to the helper — behavior identical, the existing suite is the
  proof. The sidecar consumes the same helper, then adds its own lifecycle:
  `writeEndpointFile(forgeDir, port, '127.0.0.1', secret)` on listen, `removeEndpointFile`
  on close + `process.once('exit')`,
  `setupProjectConfig(root, <abs path to this package's dist/mcp.js>, root)`.
- Missing-`ForgeDesignMode` hint (spec requirement: not silent, one line, no nagging):
  one-shot 60s timer from listen; cleared by the first `GET /__the-forge/client.js`;
  on fire, `console.warn` once:
  `[the-forge] design mode never loaded — add <ForgeDesignMode /> from 'the-forge/design-mode' to your root layout (or _app.tsx)`.
  Timer is `unref()`d so it never holds the process open.

Tests (`tests/next/sidecar.test.ts`, real http over loopback like existing endpoint
tests): two `ensureSidecar` calls → same port, one endpoint file; `GET /client.js` body
starts with the bootstrap line and embeds the endpoint file's secret; `POST /queue`
without `X-Forge-Secret` → 403 (middleware wiring intact); `close()` removes the endpoint
file; hint timer (injected short delay via vi.useFakeTimers) warns once iff client.js was
never fetched.

## N4 — `withForge` (`src/next/index.ts`)

```ts
export interface WithForgeOptions {
  agent?: DispatchOpts['agent']          // default 'claude-code'
  experimentalChannels?: boolean         // default false
}
export function withForge(nextConfig?: NextConfig | NextConfigFn, options?: WithForgeOptions): NextConfigFn
```

`NextConfig`/`NextConfigFn` are minimal local structural types (phase-taking function or
plain object — no `next` import at module scope; the plugin must load without `next`
installed when only the types are touched).

Semantics (all inside the returned `(phase, ctx) => config` function):

- Resolve the user's config first (call it if it's a function). If
  `phase !== 'phase-development-server'` (the literal `PHASE_DEVELOPMENT_SERVER` value —
  copied as a constant, not imported from `next`): return the user's config **unmodified**.
- Loader registration, three shapes, one loader file (absolute path via
  `fileURLToPath(import.meta.url)` + `../next-loader.cjs`), options `{ root:
  resolveProjectRoot(process.cwd()) }`:
  - `turbopack.rules['*.{jsx,tsx}'] = { loaders: [{ loader, options }], as: '*.$1' }` —
    exact key/`as` syntax per N0 findings (Next 16 / 15.3+).
  - `experimental.turbo.rules` — same rule object (Next 15 < 15.3). Both keys are set
    unconditionally; Next ignores the one it doesn't read and warns at most about the
    legacy key — recorded behavior from N0 decides if we gate on the installed version
    instead (read `next/package.json` version lazily inside the phase function).
  - `webpack(config, ctx)`: chain the user's `webpack` first, then unshift
    `{ test: /\.[jt]sx$/, exclude: /node_modules/, use: [{ loader, options }] }` onto
    `config.module.rules`.
- Rewrites: prepend ours, preserving the user's shape:

```ts
const forgeRewrite = async () => {
  const { port } = await ensureSidecar({ agent, channelsFlag, root, clientBundle })
  return { source: '/__the-forge/:path*', destination: `http://127.0.0.1:${port}/__the-forge/:path*` }
}
// user returned array → [forge, ...user]
// user returned {beforeFiles, afterFiles, fallback} → beforeFiles: [forge, ...user.beforeFiles]
// user had no rewrites → [forge]
```

- **Sidecar failure is never load-bearing** (spec: Next dev continues unaffected):
  `ensureSidecar` rejection inside the rewrites function is caught — `console.warn` once
  with the underlying error (`[the-forge] could not start — <message>`), and the user's
  rewrites are returned without ours. Design mode is absent that session; the app is not.

- `withForge(withForge(cfg))` (double-wrap) must be idempotent-enough: the sidecar
  singleton already guarantees one server; duplicate rewrite/loader entries are harmless
  duplicates, not errors — documented, not specially handled (YAGNI).

Tests (`tests/next/with-forge.test.ts`, `ensureSidecar` mocked): non-dev phase returns
user config identically (`toBe` where possible — untouched, not cloned); dev phase sets
both turbopack rule keys + webpack chain (user's webpack still called, order preserved);
rewrites: all three user shapes produce forge-first ordering with user entries intact;
function-form user config receives `(phase, ctx)` passthrough; options default to
`claude-code`/`false` and thread into `ensureSidecar` args; `ensureSidecar` rejection →
one warn, user rewrites returned intact, no throw.

## N5 — `ForgeDesignMode` (`src/design-mode/index.ts`)

```ts
import { createElement } from 'react'   // react: optional peer; never bundled
/** Renders the design-mode client under `next dev`; null in production builds.
 * Server-component-safe AND client-bundle-safe: zero node imports in this module's
 * entire graph. */
export function ForgeDesignMode(): ReturnType<typeof createElement> | null
```

- `process.env.NODE_ENV !== 'development'` → `null`. (Next inlines `NODE_ENV` in client
  bundles; on the server it's set by `next dev`/`next start` — same check works in both.)
- Dev → `createElement('script', { type: 'module', src: '/__the-forge/client.js' })`.
- Own tsup entry `design-mode` (esm, `platform: 'neutral'`, `external: ['react']`).

Tests (`tests/next/design-mode.test.ts`): dev renders a script element with exact
`type`/`src` props; production (`vi.stubEnv('NODE_ENV', 'production')`) renders null.
**Boundary test:** read `dist/design-mode.js` after build and assert it contains no
`node:` specifier and no `require(` of a builtin — plus `import 'the-forge/design-mode'`
resolves and evaluates in a bare `node --input-type=module` child with `--conditions`
default (proves no side-effectful node graph). This is the spec's load-bearing guarantee.

## N6 — Fixtures: `fixtures/next-demo` + `fixtures/next-pages`

- `fixtures/next-demo`: Next 16 App Router, Turbopack, same demo content as
  `fixtures/demo-app` (the discipline/recovery cards) rebuilt as
  `app/layout.tsx` (imports `ForgeDesignMode`) + `app/page.tsx`, Tailwind v4 via
  `@tailwindcss/postcss`. `next.config.ts` = `export default withForge()`. Scripts:
  `dev` (`next dev -p 5175`), `dev:webpack` (`next dev --webpack -p 5175`), `build`.
- `fixtures/next-pages`: minimal Pages Router (one page, `_app.tsx` mounting
  `ForgeDesignMode`) — proves the component in a client-compiled context; unit/manual
  smoke only, no E2E (per spec's deferred question — ratified here: manual).
- Both use `"the-forge": "*"` workspace devDependency. Root `workspaces` already covers
  `fixtures/*`.

Gate: `npm run dev -w next-demo` → Design toggle renders, elements tagged, panel edits
preview (manual smoke; E2E is N8).

## N7 — Prod-clean gate (`scripts/check-prod-clean.sh`)

- After the existing demo-app section: `npm run build -w next-demo`, assert
  `fixtures/next-demo/.next` exists, then
  `grep -riq "data-dc-source\|__the-forge\|__THE_FORGE__" fixtures/next-demo/.next/` must
  find nothing. Pattern deliberately drops the bare `the-forge` used for the Vite dist
  grep: `.next/` build metadata legitimately contains the devDependency's package name;
  the three markers above are the actual runtime traces. (Vite section keeps its stricter
  pattern unchanged.)
- Package-size line already renamed in N1; budget stays 250KB — record the new unpacked
  size in the PASS output as today.

Gate: script passes end-to-end; deliberately breaking it (add `<ForgeDesignMode />`
rendering unconditionally) makes the Next grep FAIL — mutation-verify the gate before
trusting it, then revert.

## N8 — E2E + docs + stat-builder validation

- **E2E (real browser, house rule):** against `next-demo` under Turbopack — full loop:
  toggle design mode → select element → scrub a padding draft → Send → run the MCP flow
  (`pull_design_edits` → apply → `mark_applied`, driving the real bin against the real
  sidecar) → verifier flips the draft to **Implemented** post-Fast-Refresh. Then the same
  through `dev:webpack` as a smoke (design mode loads, element tagged, draft previews).
  Kill stale dev servers first (`lsof -iTCP:5175`).
- **Docs:** CLAUDE.md (package name, new `src/next/` + `src/design-mode/` modules in the
  architecture map, Next command lines, gotchas: config double-load singleton, `.next/`
  grep pattern rationale); README (Next quick-start beside the Vite one); SETUP.md agent
  instructions go framework-agnostic (detect Vite vs Next, same install, per-framework
  wiring snippet — both routers shown for Next).
- **stat-builder validation (exit criterion, user's machine):** install per the updated
  SETUP.md into `/Users/noey/Developer/stat-builder` (Next 16, App Router, Turbopack,
  `--experimental-https`), run the full Send → `/forge-watch` → Implemented loop on a
  real component. Explicitly a user-visible checkpoint before merge — merge decision is
  the user's, per HANDOFF.

## Tests summary (mirror `src/`)

New: `tests/next/loader.test.ts`, `tests/next/sidecar.test.ts`,
`tests/next/with-forge.test.ts`, `tests/next/design-mode.test.ts` (sketches in N2–N5).
Changed: only rename-driven import updates (N1). The entire existing suite must stay
green untouched otherwise — any needed change to an existing test is a red flag to raise,
not absorb.

## Out of scope (parked)

Publishing to npm (name reserved by this rename, actual publish is its own decision);
Pages Router E2E; Next <15; `output: 'export'` and custom-server setups; a
`@the-forge/core` published package (revisit at framework #3); Turbopack production
builds appearing in check-prod-clean (dev-only tool — `next build` output is checked, the
bundler that made it is irrelevant); removing the channels stub.
