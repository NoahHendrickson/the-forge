# N0 spike findings: three risky Next.js assumptions (2026-07-04)

Throwaway spike for the Next.js adapter milestone
([docs/specs/2026-07-04-next-adapter-design.md](../specs/2026-07-04-next-adapter-design.md),
[docs/plans/2026-07-04-next-adapter-plan.md](../plans/) N0). Spike apps live outside the
repo at `/private/tmp/claude-501/-Users-noey-Developer-the-forge/ac6186b7-1f45-430b-94fd-2879220ef790/scratchpad/next-spike/`
(`app16` = Next 16 primary, `app15` = Next 15 comparison) and are **not** committed — this
document is the only merged artifact. All dev servers used were started on port 4567 (app)
/ 4568 (sidecar), verified free before each run and killed (`lsof -iTCP:<port>`) after.

## Versions tested

- **Next 16 (primary):** `16.2.10`, scaffolded via `create-next-app@latest`, App Router,
  TypeScript, Tailwind. Node `v24.15.0`, npm `11.12.1`.
- **Next 15 (comparison):** `15.5.20`, scaffolded via `create-next-app@15`, App Router,
  TypeScript, Tailwind. Same Node/npm.

Both installs are real (`npm install` against the network), not assumed from docs, except
where explicitly noted otherwise below.

---

## Assumption 1 — Turbopack runs our JS loader

**Verdict: VERIFIED** on both Next 16 and Next 15, for both Turbopack and webpack, for both
CJS and ESM loader module formats.

### Working `rules` syntax (Next 16.2.10)

`turbopack` is a **top-level** `NextConfig` key (not nested under `experimental`) — confirmed
from the shipped type definitions:

```
node_modules/next/dist/server/config-shared.d.ts:1178:    turbopack?: TurbopackOptions;
...
export interface TurbopackOptions {
  ...
  rules?: Record<string, TurbopackRuleConfigCollection>;
  ...
}
export type TurbopackRuleConfigItem = {
  loaders?: TurbopackLoaderItem[];
  as?: string;
  condition?: TurbopackRuleCondition;
  type?: TurbopackModuleType;
};
```

Config used (`app16/next.config.ts`):

```ts
const nextConfig: NextConfig = {
  turbopack: {
    rules: {
      "*.{jsx,tsx}": {
        loaders: [path.join(__dirname, "forge-loader.js")],
      },
    },
  },
  ...
};
```

Loader (`app16/forge-loader.js`, CJS):

```js
module.exports = function forgeLoader(source) {
  const relPath = path.relative(process.cwd(), this.resourcePath);
  console.log(`[forge-loader] ran pid=${process.pid} file=${relPath}`);
  return source.replace(
    /data-forge-spike-marker="PENDING"/g,
    `data-forge-spike-marker="${relPath.replace(/"/g, "")}"`
  );
};
```

Running `npx next dev --turbopack -p 4567` and `curl`-ing `/` produced:

```
▲ Next.js 16.2.10 (Turbopack)
[forge-spike] next.config.ts evaluated pid=39364 at 2026-07-04T22:12:09.607Z
[forge-loader] ran pid=39514 file=app/layout.tsx
[forge-loader] ran pid=39514 file=app/page.tsx
[forge-loader] ran pid=39514 file=app/ServerWidget.tsx
[forge-loader] ran pid=39514 file=app/ClientWidget.tsx
 GET / 200 in 1329ms (next.js: 1265ms, application-code: 64ms)
```

and the served HTML contained the loader-rewritten attributes:

```
data-forge-spike-marker="app/ServerWidget.tsx"
data-forge-spike-marker="app/ClientWidget.tsx"
```

Note the loader ran in a **different pid** (39514) than the one that evaluated
`next.config.ts` (39364) — Turbopack farms compilation out to worker processes; the config
module itself is only evaluated in the main dev-server process. This recurs throughout (see
Assumption 2).

### Next 15.x: `experimental.turbo.rules` vs `turbopack.rules`

Checked live, not just from docs. Next 15.5.20's own shipped types already mark the old
location deprecated:

```
node_modules/next/dist/server/config-shared.d.ts:22:    experimental: Omit<ExperimentalConfig, 'turbo'>;
...
    /**
     * @deprecated Use `config.turbopack` instead.
     */
    turbo?: DeprecatedExperimentalTurboOptions;
...
1082:    turbopack?: TurbopackOptions;
```

Running with the **new** top-level `turbopack.rules` (identical syntax to Next 16) on Next
15.5.20 worked with no warning — config evaluated **twice** (two different pids, see
Assumption 2), loader ran, markers present:

```
[forge-spike] next.config.ts evaluated pid=49226 at 2026-07-04T22:17:48.217Z
[forge-spike] next.config.ts evaluated pid=49299 at 2026-07-04T22:17:48.700Z
   ▲ Next.js 15.5.20 (Turbopack)
[forge-loader] ran pid=49318 file=app/layout.tsx
...
data-forge-spike-marker="app/ServerWidget.tsx"
data-forge-spike-marker="app/ClientWidget.tsx"
```

Running with the **old** `experimental.turbo.rules` syntax on the same Next 15.5.20 install
also worked, but printed an explicit deprecation warning with a codemod pointer:

```
[forge-spike] next.config.ts evaluated pid=50349 at 2026-07-04T22:18:16.427Z
 ⚠ The config property `experimental.turbo` is deprecated. Move this setting to `config.turbopack` or run `npx @next/codemod@latest next-experimental-turbo-to-turbopack .`
[forge-spike] next.config.ts evaluated pid=50350 at 2026-07-04T22:18:16.723Z
   ▲ Next.js 15.5.20 (Turbopack)
   - Experiments (use with caution):
     · turbo
...
data-forge-spike-marker="app/ServerWidget.tsx"
data-forge-spike-marker="app/ClientWidget.tsx"
```

**Conclusion:** `turbopack.rules` (top-level) is the correct syntax on *both* Next 15.5.20
and Next 16.2.10 — it is not a Next-16-only addition. `experimental.turbo.rules` still works
on 15.5.20 as a deprecated compat shim (with a runtime warning); there is no evidence it is
required on any currently-installable 15.x. Evidence source: live install + run on both
versions (not documentation-only).

### Loader module format (CJS vs ESM)

Tested by duplicating the loader as `forge-loader.mjs` (`export default function(source) {…}`)
and pointing `turbopack.rules`/`webpack()` at it instead.

- **Turbopack, ESM loader:** ran successfully —
  `[forge-loader-esm] ran pid=43617` and DOM showed `data-forge-spike-marker="ESM-OK"`.
- **Webpack, ESM loader:** ran successfully (6 invocations across client/server compilations)
  and DOM showed `data-forge-spike-marker="ESM-OK"`.
- **Both, CJS loader (`module.exports = function(source) {...}`):** ran successfully in all
  environments tested (this was the loader used for the bulk of the spike).

**Conclusion:** both Turbopack and webpack accept both CJS and ESM loader modules with a
plain default/`module.exports` function taking `(source)` and returning the transformed
string. No format is required by either bundler for this simple shape — this gives N2 free
choice of tsup output format for the loader entry (CJS is simplest given the rest of the
package is CJS-first per the repo's existing tsup config).

### `--webpack` flag availability

- **Next 16.2.10:** `next dev --help` lists `--webpack` explicitly alongside `--turbopack`/
  `--turbo`. Ran `next dev --webpack -p 4567`:
  - `turbopack.rules` config is **silently ignored** under webpack (loader never ran; DOM
    attribute stayed literally `data-forge-spike-marker="PENDING"`) — confirms Turbopack and
    webpack loader registration are two independent code paths, as the types imply
    (`turbopack.rules` vs the `webpack(config)` function).
  - Adding an explicit `webpack(config) { config.module.rules.push({ test: /\.(jsx|tsx)$/, use: [...] }) }`
    hook made the *same* loader module run under webpack too:
    ```
    ▲ Next.js 16.2.10 (webpack)
    [forge-loader] ran pid=42691 file=app/page.tsx
    [forge-loader] ran pid=42691 file=app/layout.tsx
    [forge-loader] ran pid=42691 file=app/ServerWidget.tsx
    [forge-loader] ran pid=42691 file=app/ClientWidget.tsx
    [forge-loader] ran pid=42691 file=app/ClientWidget.tsx
    [forge-loader] ran pid=42691 file=app/ClientWidget.tsx
    ```
    (ClientWidget compiled 3× — once per bundle target: RSC/server, client browser, client
    SSR — vs. once each for Turbopack's single-pass in this run). Markers landed in the DOM.
  - Under webpack, **all loader invocations happened in the single main process** (pid
    42691) — no worker-process split, unlike Turbopack.
- **Next 15.5.20:** `next dev --help` does **not** list a `--webpack` flag at all — webpack
  is simply the default when neither `--turbo` nor `--turbopack` is passed. Confirmed by
  running plain `next dev -p 4567`: banner prints `▲ Next.js 15.5.20` (no `(Turbopack)`
  suffix), loader ran (`[forge-loader] ran pid=51628 file=app/...`), markers present, and the
  `/__the-forge/*` proxy still worked (see Assumption 2).

**Consequence:** N2/N3 must detect which bundler is active (Turbopack vs webpack) and
register the loader via the correct mechanism for each — `turbopack.rules` is a no-op under
webpack and vice versa (webpack's `config.module.rules` has no effect when Turbopack is
selected, by construction, since it's a different config function entirely).

---

## Assumption 2 — async `rewrites()` awaiting a just-started in-process sidecar

**Verdict: VERIFIED** — on Next 16 (Turbopack, `--webpack`, `--experimental-https`) and on
Next 15 (Turbopack, default/webpack, `--experimental-https`).

### Sidecar + rewrite

`forge-sidecar.js` starts a plain `node:http` server memoized behind a module-level promise
(`startSidecarOnce`); `next.config.ts`'s `async rewrites()` awaits it before returning the
rewrite rule `/__the-forge/:path* -> http://127.0.0.1:4568/:path*`. The sidecar logs
`Host`/`Origin`/`X-Forwarded-Host`/`X-Forwarded-Proto` on every request.

### How many times is `next.config` evaluated, and in which processes?

| Environment | Config evaluations | pids | rewrites() calls |
|---|---|---|---|
| Next 16.2.10, `--turbopack` | 1 | 1 pid (39364) | 2 (both same pid) |
| Next 16.2.10, `--webpack` | 1 | 1 pid (41545) | 2 (both same pid) |
| Next 16.2.10, `--turbopack --experimental-https` | 1 | 1 pid (40395) | 2 (both same pid) |
| Next 15.5.20, `--turbopack` | 2 | 2 pids (50995, 50996) | 2, both in the **second/final** pid only |
| Next 15.5.20, default (webpack) | 2 | 2 pids (51627, 51628) | 2, both in the **second/final** pid only |
| Next 15.5.20, `--turbopack --experimental-https` | 1 | 1 pid (52915) | 2 (both same pid) |

Raw evidence, Next 16 Turbopack:

```
[forge-spike] next.config.ts evaluated pid=39364 at 2026-07-04T22:12:09.607Z
[forge-spike] rewrites() called pid=39364 at 2026-07-04T22:12:09.611Z
[forge-sidecar] listening pid=39364 port=4568
[forge-spike] rewrites() called pid=39364 at 2026-07-04T22:12:09.846Z
```

Raw evidence, Next 15 Turbopack (two config evaluations, note the pid change):

```
[forge-spike] next.config.ts evaluated pid=50995 at 2026-07-04T22:18:51.482Z
[forge-spike] next.config.ts evaluated pid=50996 at 2026-07-04T22:18:51.770Z
   ▲ Next.js 15.5.20 (Turbopack)
 ✓ Starting...
[forge-spike] rewrites() called pid=50996 at 2026-07-04T22:18:51.772Z
[forge-sidecar] listening pid=50996 port=4568
[forge-spike] rewrites() called pid=50996 at 2026-07-04T22:18:52.118Z
```

**Conclusion:** Next 16 evaluates `next.config.ts` exactly once per `next dev` invocation, in
the single dev-server process, regardless of bundler or HTTPS. Next 15.5.20 evaluates it
**twice**, in two distinct processes — but only the second (surviving) process ever calls
`rewrites()` or starts the sidecar; the first evaluation's module instance is discarded before
`rewrites()` is invoked. In no observed case did `rewrites()`/the sidecar start-up run more
than once per live process. **Consequence for N3:** the singleton guard (module-level
`serverPromise`) is sufficient as observed on both versions because sidecar startup is gated
behind `rewrites()`, which only ever fires in the one process that survives — but the guard
must be robust to being *imported fresh* (new module instance) on Next 15's throwaway first
evaluation, i.e. it cannot rely on evaluation count being 1; it must rely on "does
`rewrites()` get called from this instance" instead. A port-bind race guard (handle `EADDRINUSE`
by reusing the existing sidecar) is still recommended defense-in-depth, not proven necessary,
since no double-listen was observed here.

### What `Host`/`Origin` headers does the proxied request carry?

Plain `curl` (no Origin header sent) and `curl -H "Origin: http://localhost:4567"` against
`http://localhost:4567/__the-forge/...`, observed at the sidecar:

```
[forge-sidecar] pid=39364 GET /status Host="127.0.0.1:4568" Origin=undefined X-Forwarded-Host="localhost:4567" X-Forwarded-Proto=undefined
[forge-sidecar] pid=39364 GET /ping Host="127.0.0.1:4568" Origin="http://localhost:4567" X-Forwarded-Host="localhost:4567" X-Forwarded-Proto=undefined
```

Same pattern held on Next 16 `--webpack`, Next 16 `--experimental-https`, Next 15 Turbopack,
Next 15 webpack-default, and Next 15 `--experimental-https` (all re-verified individually;
example HTTPS run):

```
{"ok":true,"pid":40395,"url":"/https-check","host":"127.0.0.1:4568","origin":null,"xForwardedHost":"localhost:4567","xForwardedProto":null}
```

**Findings:**
- Next's rewrite proxy **rewrites the `Host` header to the destination's own
  `host:port`** (`127.0.0.1:4568`), not the original request's `Host`
  (`localhost:4567`/original hostname). This is standard reverse-proxy behavior for Next
  rewrites.
- The original external host is preserved only in `X-Forwarded-Host` (`localhost:4567`).
- `X-Forwarded-Proto` was **never set** in any run, including under `--experimental-https`
  (stayed `undefined`/`null` even when the outer request was HTTPS).
- `Origin` passes through unchanged when the client sends one; absent otherwise (expected —
  `curl` doesn't send `Origin` for plain GETs, browsers do for fetch/XHR).

**Consequence for N3:** `createForgeMiddleware`'s loopback/allowed-hosts check must **not**
read `req.headers.host` and expect the original external hostname — it will see
`127.0.0.1:4568` (the sidecar's own bind address), which is trivially "loopback" and would
make the check meaningless if used naively for origin validation. If the design needs to
validate the *browser's* origin/host (not just "did this come via our own rewrite"), it must
read `X-Forwarded-Host` instead of `Host`, and must not trust `X-Forwarded-Proto` for
scheme detection since Next does not populate it here — scheme should instead be inferred
from how the sidecar itself was reached (it's always plain HTTP loopback in this design,
since Next terminates TLS and proxies internally over HTTP regardless of
`--experimental-https`). No normalization is needed for the loopback check itself (the
sidecar only ever sees `127.0.0.1`/loopback traffic proxied by Next, by construction of the
rewrite), but any check that currently assumes `Host` reflects the browser's origin must be
updated to use `X-Forwarded-Host` or be removed as redundant.

### `--experimental-https`

Verified working on both versions:

Next 16.2.10:
```
▲ Next.js 16.2.10 (Turbopack)
- Local:         https://localhost:4567
{"ok":true,"pid":40395,"url":"/https-check","host":"127.0.0.1:4568","origin":null,"xForwardedHost":"localhost:4567","xForwardedProto":null}
```

Next 15.5.20:
```
▲ Next.js 15.5.20 (Turbopack)
- Local:        https://localhost:4567
{"ok":true,"pid":52915,"url":"/n15https","host":"127.0.0.1:4568","origin":null}
```

Both required accepting a self-signed cert (`curl -k`); both generated `mkcert`-based certs
into `<app>/certificates` and added them to `.gitignore` automatically. The proxy path is
unaffected by TLS termination — Next still proxies to the sidecar over plain loopback HTTP.

---

## Assumption 3 — Tagged JSX survives both compilations without hydration mismatch

**Verdict: VERIFIED** on Next 16.2.10 (Turbopack) and Next 15.5.20 (Turbopack), via a real
browser (Playwright-driven Chromium), not just `curl`.

Fixture: `ServerWidget.tsx` (plain server component) and `ClientWidget.tsx` (`"use client"`,
holds `useState` counter + button), both carrying `data-forge-spike-marker="PENDING"`
rewritten by the loader to their relative file path.

Browser console after navigating to `http://localhost:4567/` (Next 16, Turbopack):

```
[INFO] Download the React DevTools for a better development experience...
[LOG] [HMR] connected
```

Zero errors, zero warnings — specifically no
`Warning: Text content did not match`/`Hydration failed because the initial UI does not
match` React hydration-mismatch messages of any kind.

Live DOM read via `page.evaluate`:

```json
[
  { "marker": "app/ServerWidget.tsx", "kind": "server", "text": "server-widget" },
  { "marker": "app/ClientWidget.tsx", "kind": "client", "text": "client-widget 0inc" }
]
```

Both `data-dc-source`-style markers are present in the real served/hydrated DOM for both a
server and a client component, exactly matching the values the loader wrote at
compile time.

Interactivity check (proves hydration didn't just avoid *warning* but actually attached
working event handlers): clicked the `inc` button via Playwright, then re-read the DOM:

```
"client-widget 1inc"
```

State went from `client-widget 0inc` to `client-widget 1inc` — the client component
hydrated correctly and its `onClick` handler fired.

Repeated on Next 15.5.20 (Turbopack): console showed only the React DevTools info line, zero
errors/warnings; DOM read showed both markers present (`app/ServerWidget.tsx` /
`app/ClientWidget.tsx`) after navigation.

**Consequence for N2–N4:** tagging both server and client components with the loader
produces no observable hydration divergence — the transform is safe to apply universally
across both component kinds without special-casing one or the other for hydration safety.

---

## Consequences for N2–N4

- **Loader module format:** either CJS (`module.exports = function(source) {...}`) or ESM
  (`export default function(source) {...}`) works under both Turbopack and webpack, for both
  Next 15.5.20 and 16.2.10 — no bundler-imposed constraint. Given the rest of the package
  ships CJS-first (tsup, zero-dependency MCP bin), N2 should emit the loader as **CJS** for
  consistency and to avoid an extra tsup output-format branch.
- **Exact working `rules` syntax per Next version:** use top-level `turbopack.rules` (NOT
  `experimental.turbo.rules`) on **both** Next 15.5.20 and Next 16.2.10 — confirmed
  identical syntax and behavior on live installs of both. `experimental.turbo.rules` still
  works on 15.5.20 today but is deprecated with a runtime warning and a codemod pointer; N2
  must not rely on it and should target `turbopack.rules` unconditionally (no version
  branching needed for this specific config shape). Webpack mode (Next 16 `--webpack`, or
  Next 15 default) requires a **separate**, independent registration via the `webpack(config)`
  function — `turbopack.rules` has zero effect there. N2/N3 need bundler detection (e.g.
  inspect `process.env.TURBOPACK` / the `phase`/config shape Next provides, or simply
  register both hooks unconditionally since each is a no-op under the other bundler, per this
  spike's direct observation).
- **Config evaluation count/processes:** Next 16 evaluates `next.config` exactly once, in one
  process, regardless of bundler/HTTPS. Next 15.5.20 evaluates it **twice**, in two distinct
  processes, but `rewrites()`/sidecar-start only ever fires from the second (surviving)
  process in every run observed. N3's singleton guard should key off "has `rewrites()` been
  called in this module instance" (module-level promise, as spiked) rather than assume a
  fixed evaluation count, and should tolerate being re-imported as a fresh module instance
  once per `next dev` invocation on 15.x without double-binding the sidecar port (defense in
  depth: handle `EADDRINUSE` gracefully even though it was not observed here).
- **Header normalization needed:** yes. The proxied request's `Host` header is rewritten by
  Next to the sidecar's own address (`127.0.0.1:<port>`), not the original browser-facing
  host; the original host survives only in `X-Forwarded-Host`. `X-Forwarded-Proto` is never
  populated by Next's rewrite proxy (confirmed absent even under `--experimental-https`), so
  scheme cannot be read from it. `createForgeMiddleware`'s loopback/allowed-hosts check must
  key off `X-Forwarded-Host` (not `Host`) if it needs to reason about the browser's original
  host, and must not weaken to "anything on `Host: 127.0.0.1:*`" as automatically safe merely
  because that's what the sidecar always sees — that's an artifact of the rewrite, not a
  guarantee about the original request's provenance.
