# Chrome-extension pivot — research findings (2026-07-05)

**Question:** should The Forge drop the per-project Vite/Next install and become a Chrome extension, so one install covers every project?

**Verdict (user-ratified):** No full pivot. The per-project package stays the core. The friction is attacked directly instead — npm publish + `npx the-forge init` (see [2026-07-05-npm-init-design.md](../specs/2026-07-05-npm-init-design.md)). An extension remains a possible *additive* funnel later ("Approach B" below), never a replacement.

## Why extension-only fails (three independent grounds)

### 1. Source-mapping precision collapses without build-time tagging

- The classic trick (LocatorJS et al.) read `fiber._debugSource`, injected by a Babel dev transform frameworks enabled by default. **React 19 removed `_debugSource`** ([react#28265](https://github.com/facebook/react/pull/28265)); LocatorJS is broken on React 19 with no fix, along with the whole tool family ([react#32574](https://github.com/facebook/react/issues/32574)).
- The replacement, owner stacks / `fiber._debugStack` (React **19.1+ only** — 19.0 has neither field), yields compiled-coordinate stack traces requiring client-side sourcemap symbolication; React's own DevTools hedges it's the JSX call site only "unless there's any intermediate utility functions"; a 10,000-element rate limit silently swaps in a fake stack on big pages ([ReactFeatureFlags `ownerStackLimit`](https://github.com/facebook/react/blob/main/packages/shared/ReactFeatureFlags.js)); RSC frames arrive as `rsc://` fake-eval URLs needing name-matching heuristics.
- Strongest signal: **bippy**, the state-of-the-art fiber-inspection library, tells React 19 users to install a build-time JSX-runtime shim for accurate locations ([bippy](https://github.com/aidenybai/bippy)). Runtime-only is a fallback even for its specialists.
- All debug fields are `__DEV__`-only, so the extension buys no production reach either.
- Consequence for us: deterministic `file:line:col` — the backbone of the deterministic-change-request hard constraint — survives only with the build-time tagger.

### 2. An extension can't run the agent loop alone

It cannot write `queue.json`, host the MCP endpoint, or run the tmux/AppleScript dispatch ladder. It needs a local companion:

- **Native messaging** (Claude-for-Chrome's route): per-browser/per-fork host-manifest registration, fixed extension ID in `allowed_origins`, 1 MB message cap, real support burden (see Claude Code's own registration issues). Immune to Chrome's network-policy churn, but a poor fit for an npx-style tool.
- **Localhost daemon** (what Stagewise, Vercel Toolbar, React DevTools standalone all ship): our `runtime.ts` hoisted per-machine; MV3 needs `host_permissions` for `http://localhost/*` and all fetches from the service worker; Chrome 142's Local Network Access prompt exempts extensions with host permissions (bugs fixed by Chrome 144).
- Port→project mapping has a standardized answer: Chrome's `/.well-known/appspecific/com.chrome.devtools.json` (Automatic Workspace Folders), with `lsof port→pid→cwd` as universal fallback.
- Net accounting: extension (per developer × per browser) + daemon (per machine) + still the plugin for precision = **more installs than today for a team**. The npm package arrives with the repo; the second developer pays zero.

### 3. The market vacated our slot for business reasons, not product ones

- **Stagewise** held exactly our shape (toolbar → your own Cursor/Claude Code via MCP), killed its per-project npm packages for an `npx` proxy (validating the friction instinct), then dropped bring-your-own-agent entirely to sell its own agent — the move our "complementary, never a replacement" constraint forbids. That's the moat, not a weakness.
- **Onlook** fled desktop-install friction into their cloud (your app runs in their container). **v0 design mode** re-prompts a model with serialized edits — credit-metered regeneration, not deterministic edits. Nobody ships `py-2.5 → py-6` at exact `file:line` in the project's own token vocabulary.
- **react-scan** is the distribution model to steal when/if wanted: npm for teams, npx/extension as the zero-touch funnel.
- Watch list: Next 16 ships a default MCP endpoint (`/_next/mcp`, debugging-oriented today); Chrome DevTools' Gemini "Apply to workspace" writes CSS to disk via the devtools.json handshake — both validate our patterns and both could encroach.

## Approach B, shelved for the record

If growth-among-strangers ever becomes the goal: keep the plugin as the precision tier; add a per-machine `npx the-forge` daemon (runtime.ts out-of-band — the Next sidecar already proved the shape) + a Chrome extension injecting the same overlay on any localhost React dev server, with owner-stack+sourcemap **component-level** targeting and an "install the plugin for exact-element edits" upsell in the panel. Costs: three React-version code paths, sourcemap symbolication, extension review/maintenance, daemon lifecycle. B assumes the `init` on-ramp from Approach A exists.
