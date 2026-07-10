# The Forge

A Figma-style design mode for your own app, in your own browser — that hands its edits to whatever AI coding agent you already use.

Run your dev server, flip on design mode, and click any element to get a real properties panel: scrub padding, drag corner radius, pick colors, bind Tailwind tokens, compare before/after. Every edit previews instantly on the live DOM. When it looks right, The Forge packages your changes into a deterministic, token-aware change request — exact file and line, `py-2.5 → py-6` in your project's own Tailwind vocabulary — ready for Claude Code, Cursor, or Codex to apply to your actual source code.

**Complementary, not a replacement.** The Forge never owns your workflow: it feeds the agent session you already have open, on your existing subscription. Uninstall it and nothing breaks.

Works on **Vite + React** and **Next.js 15/16** (App Router and Pages Router, Turbopack and webpack dev) — same package, same panel, same loop.

## Setup

In the project you want to use The Forge in:

```bash
npx forge-mode init
```

It detects Vite or Next.js, adds `forge-mode` as a dev dependency with your package manager, wires it into your config, and mounts `<ForgeDesignMode />` — printing `[done]` / `[skip]` / `[manual]` for each step. Anything it can't do safely it prints the exact snippet for instead; it never touches git, and re-running it is safe.

**Setting this up with an AI coding agent?** Hand it the full setup guide — it's written to be followed by agents step by step, including every manual fallback and a troubleshooting section:
**https://github.com/NoahHendrickson/the-forge/blob/main/SETUP.md**

### Manual setup

`npm install -D forge-mode`, then wire in whichever framework you're on.

**Vite + React** — add `theForge()` before the React plugin, so it can tag JSX before React compiles it:

```ts
import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import { theForge } from 'forge-mode/vite'

export default defineConfig({
  plugins: [theForge(), react()],
})
```

**Next.js (either router)** — wrap your config, then mount the component once:

```ts
// next.config.ts
import { withForge } from 'forge-mode/next'

export default withForge({
  // ...the project's existing next.config fields
})
```

```tsx
// app/layout.tsx (App Router) — or pages/_app.tsx (Pages Router)
import { ForgeDesignMode } from 'forge-mode/design-mode'
// mount <ForgeDesignMode /> once; it renders null outside development
```

## Using it

1. **Run your dev server** and open the app in the browser.
2. **Toggle Design mode** (bottom-right corner). Click any element to open the properties panel; edits preview instantly as inline styles — your React code is untouched while you experiment. Press `=` in any field to search your Tailwind tokens.
3. **Send it.** Hit **Send to agent**, then in a Claude Code session opened at the project root type `/forge-watch` once — that session stays linked and applies every edit you send automatically. Not using Claude Code? Hit **Copy for agent** and paste the change request into Cursor, Codex, or any agent.
4. **Verify.** After the agent edits your source and the app hot-reloads, The Forge checks the computed styles and flips matching drafts to **Implemented**.

## Guarantees

- **Zero production impact** — the plugin only runs under `vite dev` (or Next's development phase); a CI gate asserts production builds contain no trace of it, on both frameworks.
- **Zero idle overhead** — no document listeners, observers, or timers until you toggle design mode on.
- **Framework-bypass previews** — edits are inline styles; React never re-renders while you scrub.
- **Tiny by design** — two runtime dependencies (`@babel/parser`, `magic-string`); the bundled MCP server is hand-rolled and dependency-free.

## Requirements

- Vite ≥ 5 with React, or Next.js ≥ 15 — and the project is a git repository
- Node ≥ 20
- Tailwind CSS v4 is optional: with it, change requests speak your token vocabulary; without it, they fall back to plain CSS values

## Docs

Setup guide (agent-ready): https://github.com/NoahHendrickson/the-forge/blob/main/SETUP.md
Source, design docs, and demo fixtures: https://github.com/NoahHendrickson/the-forge

MIT
