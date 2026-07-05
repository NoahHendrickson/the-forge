# Setting up The Forge

The Forge is a dev-only plugin that adds a Figma-style design mode to any Vite + React app or Next.js 15/16 app: click an element in your running app, edit it live in a floating panel, and hand the change to the AI coding agent you already use (Claude Code, Cursor, Codex). It has **zero production footprint** — it only runs under `vite dev` (or Next's development phase).

This guide has three parts:

1. [The 30-second version](#the-30-second-version) — run one command.
2. [Agent setup instructions](#agent-setup-instructions) — what `npx the-forge init` does, and the manual/fallback steps for anything it can't handle automatically.
3. [How to use it](#how-to-use-it) — what to do once it's installed.

---

## The 30-second version

In the project you want to use The Forge in:

```bash
npx the-forge init
```

It detects Vite or Next.js, adds `the-forge` as a dev dependency with whichever package manager your lockfile implies, wires it into your config, and mounts `<ForgeDesignMode />` — printing `[done]`, `[skip]`, or `[manual]` for each step. It's conservative: anything it doesn't recognize (an unusual config shape, say) it leaves untouched and prints the exact manual snippet for instead. It never runs git commands, and running it again is safe (steps it already did print `[skip]`).

If a step prints `[manual]`, follow the [agent setup instructions](#agent-setup-instructions) below for that step — or hand this whole file to your AI coding agent and ask it to finish the job.

---

## Agent setup instructions

These are the manual/fallback steps behind `npx the-forge init` — what to do if a step printed `[manual]`, or if you're setting up by hand. If you're an AI agent asked to set up The Forge in a repo: run `npx the-forge init` first, then follow whichever steps below its output flagged `[manual]`. Follow these steps in order. If a prerequisite check fails, stop and report it instead of improvising.

### 0. Check prerequisites

The host project must be **one of**:

- A **Vite** project (`vite` ≥ 5 in its dependencies) with a config file (`vite.config.ts` / `vite.config.js`), using **React**, or
- A **Next.js 15+** project (either the App Router or the Pages Router), using **React**.

Either way, it must also be a **git repository** (the plugin anchors its config files at the git root).

Nice to have, not required: **Tailwind CSS v4**. With it, change requests are written in the project's own token vocabulary (`py-2.5 → py-6`); without it, they fall back to plain CSS values. Either way works.

If the project is neither Vite nor Next.js, stop here and tell your human The Forge doesn't apply to this project.

### 1. Install The Forge

From the host project root:

```bash
npm install -D the-forge
```

(or the equivalent for your package manager: `pnpm add -D the-forge`, `yarn add -D the-forge`, `bun add -D the-forge`.) `npx the-forge init` does this step for you, using whichever package manager your lockfile implies.

Not on npm yet in your environment? Install from a local checkout instead: clone `https://github.com/NoahHendrickson/the-forge.git` next to the host project, `npm install && npm run build` in it, then `npm install -D file:../the-forge/packages/the-forge --install-links` in the host project (the `--install-links` flag copies the package instead of symlinking it — required for Turbopack to resolve `exports` subpaths like `the-forge/design-mode` from a directory outside the project tree). This is a fallback path; prefer the npm install above once the package is published.

### 2. Wire it into the framework config

Do whichever of these matches the host project.

#### Vite + React

In `vite.config.ts`, import `theForge` and add it to `plugins` — **before** the React plugin, so it can tag JSX before React compiles it:

```ts
import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import { theForge } from 'the-forge/vite'

export default defineConfig({
  plugins: [theForge(), react()],
})
```

Keep any other existing plugins exactly as they are; only add `theForge()` at the front.

#### Next.js — either router

Wrap the config in `next.config.ts` (or `.js`/`.mjs`) with `withForge`. It only activates in
`next dev`; production builds pass through untouched:

```ts
import { withForge } from 'the-forge/next'

export default withForge()
```

If the project already has a config object or function, pass it through instead of replacing it:

```ts
import { withForge } from 'the-forge/next'

export default withForge({
  // ...the project's existing next.config fields
})
```

Make sure `withForge(...)` wraps the **final exported config** — if something else wraps or
re-exports the config after this, The Forge's `rewrites()` can get overwritten instead of merged.

Then mount `<ForgeDesignMode />` once, in whichever of these two the project uses:

**App Router** — in the root layout:

```tsx
// app/layout.tsx
import type { ReactNode } from 'react'
import { ForgeDesignMode } from 'the-forge/design-mode'

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <body>
        {children}
        <ForgeDesignMode />
      </body>
    </html>
  )
}
```

**Pages Router** — in `_app.tsx`:

```tsx
// pages/_app.tsx
import type { AppProps } from 'next/app'
import { ForgeDesignMode } from 'the-forge/design-mode'

export default function App({ Component, pageProps }: AppProps) {
  return (
    <>
      <Component {...pageProps} />
      <ForgeDesignMode />
    </>
  )
}
```

`<ForgeDesignMode />` renders nothing outside development, so it's safe to leave mounted.

### 3. Gitignore the runtime state

Add this line to the host project's `.gitignore` (create the file if needed):

```gitignore
.the-forge/
```

`.the-forge/` is per-machine runtime state (queue + endpoint files) written at the git root — it should never be committed.

Also note: on first dev-server start the plugin writes a `the-forge` entry into `.mcp.json` and two command files into `.claude/commands/` (see step 4). The `.mcp.json` entry contains an **absolute path** to `dist/mcp.js` on this machine. If the project doesn't already commit `.mcp.json`, gitignore it too; if the team does commit it, that's fine — the plugin rewrites the entry with the correct local path on each machine's next dev-server start.

### 4. Start the dev server once and verify

Start the dev server the way the project normally does (`npm run dev`, `npx vite`, or `npx next dev`). On startup the plugin auto-installs, at the **git root**:

- `.mcp.json` — registers the `the-forge` MCP server (how the agent pulls edits).
- `.claude/commands/forge-design.md` — the `/forge-design` command (pull + apply once).
- `.claude/commands/forge-watch.md` — the `/forge-watch` command (stay linked, apply as edits arrive).
- `.the-forge/` — runtime queue + endpoint state.

Verify all of the above exist, then open the app in a browser and confirm a **Design** toggle appears in the bottom-right corner. You can leave the dev server running or stop it — setup is done either way.

### 5. Tell your human what to do

Report back with something like this (adapt paths/commands to the project):

> The Forge is set up. To use it:
>
> 1. Run the dev server (`npm run dev`) and open the app.
> 2. Click the **Design** toggle in the bottom-right corner, then click any element to edit it — drag values, pick colors, press `=` in a field for the Tailwind token picker.
> 3. When it looks right, hit **Send to agent**.
> 4. In a Claude Code session opened **at this project's root**, type `/forge-watch` once — that session stays linked and applies every edit you send, automatically. (First time, Claude Code will ask to approve the `the-forge` MCP server — say yes. If Claude Code was already open during setup, restart it so it picks up the new `.mcp.json`.)
> 5. Watch your edits flip to **Implemented** in the panel once the code change lands and hot-reloads.
>
> Not using Claude Code? Hit **Copy for agent** instead and paste the change request into Cursor, Codex, or any agent.

---

## How to use it

The daily loop, once installed:

1. **Run your dev server** and open the app in the browser.
2. **Toggle Design mode** (bottom-right). Hovering now outlines elements; click one to open the properties panel.
3. **Edit live.** Scrub padding/margin/radius/size, set typography, fills and strokes with a real color picker, align with the 9-dot matrix. Press `=` in any field to search your Tailwind tokens. Everything previews instantly as inline styles — your React code is untouched while you experiment. Use the before/after compare to sanity-check, and reset anything you don't like.
4. **Send it.** Two ways to get changes into your source code:
   - **Send to agent** — queues a deterministic change request (exact `file:line`, `py-2.5 → py-6` style deltas). In Claude Code, `/forge-watch` links your session so every Send is applied automatically (the panel shows **● Linked**); or type `/forge-design` to pull and apply the queued batch once. Watchers auto-stop after 20 idle minutes — just type `/forge-watch` again.
   - **Copy for agent** — copies the same change request as markdown to paste into any agent (Cursor, Codex, a chat window, anything).
5. **Verify.** After the agent edits your source and the dev server hot-reloads (Vite HMR, or Next Fast Refresh), The Forge checks the computed styles and flips matching drafts to **Implemented**. If something doesn't match, the draft stays visible so nothing is silently lost.

### Troubleshooting

- **`/forge-design` / `/forge-watch` don't exist in Claude Code** — the commands are installed on dev-server start; restart Claude Code after the first setup, and make sure the session is opened at the project's **git root** (the MCP server looks for `.the-forge/` in the directory Claude Code was launched from).
- **Sends aren't arriving** — check the dev server is actually running, and that you don't have a stale second dev server on another port (kill old ones; on macOS: `lsof -iTCP:5173` for Vite's default port, or whatever port the project's dev server uses). With two dev servers on one project, the watcher may be linked to the wrong one.
- **Panel shows the watcher went idle** — type `/forge-watch` again in Claude Code; watchers deliberately stop after 20 idle minutes so a forgotten session never runs overnight.
- **No Design toggle** — it only exists under `vite dev` (or Next's dev phase). Production builds contain zero trace of The Forge by design.
- **On Next.js, `/__the-forge/*` requests 404** — something in the project is overwriting `rewrites()` instead of composing with it, so The Forge's proxy rule never reaches Next. Check that `withForge(...)` wraps the config that actually gets exported from `next.config.ts` (not an earlier, unwrapped version of it), and that nothing downstream re-defines `rewrites` after `withForge` has already set it.
- **On Next.js (Turbopack), every route 500s with `Module not found: Can't resolve 'the-forge/design-mode'`** — this only happens with the local-checkout fallback install (step 1): the package was linked as a symlink (a plain `file:` install without `--install-links`), and Turbopack can't resolve `exports` subpaths through an out-of-tree symlink. Reinstall with the flag: `npm install -D file:../the-forge/packages/the-forge --install-links`, then restart the dev server. (`next dev --webpack` also works as a stopgap, but fix the install.) A normal `npm install -D the-forge` from npm doesn't hit this.
- **Updating The Forge** — from npm: `npm update the-forge` (or your package manager's equivalent), then restart the dev server. From a local-checkout fallback install: `git pull && npm install && npm run build` in the `the-forge` checkout, then **re-run the install command (with `--install-links`) in the host project** — the copy in `node_modules` doesn't track the checkout — and restart the dev server.
