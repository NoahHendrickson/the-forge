# The Forge

A Figma-style design mode for your own app, in your own browser — that hands its edits to whatever AI coding agent you already use.

Run your dev server, flip on design mode, and click any element to get a real properties panel: scrub padding, drag corner radius, tweak opacity, compare before/after. Every edit previews instantly on the live DOM. When it looks right, The Forge packages your changes into a deterministic, token-aware change request — exact file and line, `py-2.5 → py-6` in your project's own Tailwind vocabulary — ready for Claude Code, Cursor, or Codex to apply to your actual source code.

**Complementary, not a replacement.** The Forge never owns your workflow: it feeds the agent session you already have open, on your existing subscription. Uninstall it and nothing breaks.

## Status

Early development — building in the open. Current milestones on `main`:

- **M1 — See:** dev-only Vite plugin tags every element with its source location (`data-dc-source="src/App.tsx:7:9"`); shadow-DOM overlay with hover outlines and a click-to-inspect panel.
- **M2a — Edit:** draft engine (edits preview as inline styles, framework untouched), scrubbing numeric controls, editable Size / Padding / Margin / Radius / Opacity sections with linked rows and per-corner expansion, before/after compare, reset.
- **M3 — Package:** Tailwind v4 token mapper, change-request builder with exact before→after deltas, and a "Copy for agent" button — the full loop (draft → request → agent edits source → verified) is proven.
- **M4 — Deliver:** a **Send to agent** button queues change requests in the dev server; a zero-dependency MCP server + auto-installed `/forge-design` command let your running Claude Code session pull and apply them; the browser verifies computed styles post-HMR and flips drafts to **Implemented**.

- **M2b — Panel depth:** Figma-style Layout section (9-dot align matrix, gap, size modes), Typography, Fill/Stroke with a popover color picker, `=` token picker with bound-value pills, and multi-select with relative deltas.
- **M5 — Dispatch:** the Send button reaches your open agent session with zero keystrokes where the environment allows (tmux → AppleScript → deeplink ladder, manual `/forge-design` fallback), plus queue hardening (claim timeouts, atomic writes, pruning, shared-secret endpoints).
- **Watch mode:** type `/forge-watch` once in any Claude Code session — including the Claude Code **desktop app**, where terminal injection can't reach — and that session becomes the linked watcher: every Send is delivered into it instantly over MCP long-poll, zero keystrokes per Send. The panel shows "● Linked" while it's live and tells you how to wake it (`/forge-watch`) if it goes idle; watchers auto-stop after 20 idle minutes so a forgotten session never ticks overnight. No watcher → the M5 ladder runs exactly as before.
- **M-Next — the same loop on Next.js 15/16:** one package, `the-forge`, now works on Next (App Router and Pages Router, Turbopack and webpack dev) alongside Vite — same overlay, same panel, same MCP loop, same `/forge-design` and `/forge-watch` commands, no separate install path.
- **M-Publish — on npm, one command to set up:** `the-forge` ships as a real npm package with a `the-forge` bin; `npx the-forge init` detects Vite or Next, adds the dependency, wires the config, mounts `<ForgeDesignMode />`, and prints next steps — no manual config editing required.

Next: Effects (shadow, blur), gradients, and the rest of the open backlog in [docs/HANDOFF.md](docs/HANDOFF.md).

## Set it up in your own project

The fastest way: in the project you want to use The Forge in, run

```bash
npx the-forge init
```

It detects Vite or Next, adds `the-forge` as a dev dependency, wires it into your config, and mounts `<ForgeDesignMode />` if it can — printing `[done]` / `[skip]` / `[manual]` for each step. Anything it can't do automatically (an unrecognized config shape, say) it prints the exact snippet for instead; it never touches git.

Full setup and usage guide (for humans too, and for the manual/fallback steps): [SETUP.md](SETUP.md).

**Vite + React:**

```ts
// vite.config.ts
import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import { theForge } from 'the-forge/vite'

export default defineConfig({
  plugins: [theForge(), react()], // theForge() first — it tags JSX before React compiles it
})
```

**Next.js 15/16 (App Router or Pages Router):**

```ts
// next.config.ts
import { withForge } from 'the-forge/next'

export default withForge()
```

```tsx
// app/layout.tsx (App Router) — or pages/_app.tsx (Pages Router)
import { ForgeDesignMode } from 'the-forge/design-mode'
// mount it once; it renders null outside development
```

Either framework: `npx the-forge init` does the above for you; the manual path is
`npm install -D the-forge` plus the snippets above.

## Try the demo

```bash
npm install
npm run build
npm run dev -w demo-app     # Vite demo — fixtures/demo-app
npm run dev -w next-demo    # Next demo, App Router + Turbopack — fixtures/next-demo, port 5175
npm run dev -w next-pages   # Next demo, Pages Router — fixtures/next-pages, port 5176
```

Open the printed URL, hit the **Design** toggle (bottom-right), click an element, and start scrubbing. When you have drafts, hit **Copy for agent** and paste into your agent of choice. Or hit **Send to agent**, then type /forge-design in a Claude Code session opened in the same project — it pulls the queued edits over MCP, applies them, and the browser marks your drafts Implemented once computed styles match.

To use it on your own Vite + React or Next.js project: `npx the-forge init` — see [SETUP.md](SETUP.md) for the full guide and manual fallback steps.

## Guarantees

- **Zero production impact** — the plugin only runs under `vite dev` (or Next's `phase-development-server`); a CI-style check asserts production builds contain no trace of it, on both frameworks.
- **Zero idle overhead** — no document listeners, observers, or timers until you toggle design mode on.
- **Framework-bypass previews** — edits are inline styles; React never re-renders while you scrub.

## Design docs

The spec and per-milestone implementation plans live in [`docs/`](docs/). The project is built milestone-by-milestone with per-task review gates and real-browser verification.
