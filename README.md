# The Forge

A Figma-style design mode for your own app, in your own browser — that hands its edits to whatever AI coding agent you already use.

Run your dev server, flip on design mode, and click any element to get a real properties panel: scrub padding, drag corner radius, tweak opacity, compare before/after. Every edit previews instantly on the live DOM. When it looks right, The Forge packages your changes into a deterministic, token-aware change request — exact file and line, `py-2.5 → py-6` in your project's own Tailwind vocabulary — ready for Claude Code, Cursor, or Codex to apply to your actual source code.

**Complementary, not a replacement.** The Forge never owns your workflow: it feeds the agent session you already have open, on your existing subscription. Uninstall it and nothing breaks.

## Status

Early development — building in the open. Current milestones on `main`:

- **M1 — See:** dev-only Vite plugin tags every element with its source location (`data-dc-source="src/App.tsx:7:9"`); shadow-DOM overlay with hover outlines and a click-to-inspect panel.
- **M2a — Edit:** draft engine (edits preview as inline styles, framework untouched), scrubbing numeric controls, editable Size / Padding / Margin / Radius / Opacity sections with linked rows and per-corner expansion, before/after compare, reset.
- **M3 — Package:** Tailwind v4 token mapper, change-request builder with exact before→after deltas, and a "Copy for agent" button — the full loop (draft → request → agent edits source → verified) is proven.

Next: **M4** — companion CLI with an MCP server and `/design` command so your running agent session pulls edits automatically. Then broader panel sections (typography, fill, stroke, layout) and multi-select.

## Try it

```bash
npm install
npm run build
npm run dev -w demo-app
```

Open the printed URL, hit the **Design** toggle (bottom-right), click an element, and start scrubbing. When you have drafts, hit **Copy for agent** and paste into your agent of choice.

To use it on your own Vite + React project:

```ts
// vite.config.ts
import { theForge } from '@the-forge/vite'

export default defineConfig({
  plugins: [theForge(), react(), tailwindcss()],
})
```

(Local install for now: `npm install -D file:../the-forge/packages/vite-plugin`.)

## Guarantees

- **Zero production impact** — the plugin only runs under `vite dev`; a CI-style check asserts production builds contain no trace of it.
- **Zero idle overhead** — no document listeners, observers, or timers until you toggle design mode on.
- **Framework-bypass previews** — edits are inline styles; React never re-renders while you scrub.

## Design docs

The spec and per-milestone implementation plans live in [`docs/`](docs/). The project is built milestone-by-milestone with per-task review gates and real-browser verification.
