# Setting up The Forge

The Forge is a dev-only Vite plugin that adds a Figma-style design mode to any Vite + React app: click an element in your running app, edit it live in a floating panel, and hand the change to the AI coding agent you already use (Claude Code, Cursor, Codex). It has **zero production footprint** — it only runs under `vite dev`.

This guide has three parts:

1. [The 30-second version](#the-30-second-version) — hand the setup to your agent.
2. [Agent setup instructions](#agent-setup-instructions) — the exact steps an AI agent (or a human) follows to install it.
3. [How to use it](#how-to-use-it) — what to do once it's installed.

---

## The 30-second version

Open your AI coding agent **in the project you want to use The Forge in** and paste this:

> Set up The Forge in this repo. Follow the "Agent setup instructions" in https://raw.githubusercontent.com/NoahHendrickson/the-forge/main/SETUP.md exactly, then tell me what to do next.

That's it. The rest of this document is what the agent (or you, manually) will do.

---

## Agent setup instructions

You are setting up The Forge in the repository you are currently working in (the "host project"). Follow these steps in order. If a prerequisite check fails, stop and report it instead of improvising.

### 0. Check prerequisites

The host project must:

- Be a **Vite** project (`vite` ≥ 5 in its dependencies) with a config file (`vite.config.ts` / `vite.config.js`).
- Use **React** (the plugin tags JSX elements with their source locations).
- Be a **git repository** (the plugin anchors its config files at the git root).

Nice to have, not required: **Tailwind CSS v4**. With it, change requests are written in the project's own token vocabulary (`py-2.5 → py-6`); without it, they fall back to plain CSS values. Either way works.

If the project is not Vite + React, stop here and tell your human The Forge doesn't apply to this project.

### 1. Clone and build The Forge

The package is not on npm yet — you install it from a local checkout. Clone it **next to** the host project (not inside it):

```bash
git clone https://github.com/NoahHendrickson/the-forge.git ../the-forge
cd ../the-forge
npm install
npm run build
cd -
```

If `../the-forge` already exists, `git pull && npm install && npm run build` in it instead.

The build must produce `packages/vite-plugin/dist/` containing `index.js`, `client.js`, and `mcp.js`. Verify those three files exist before continuing.

### 2. Install it in the host project

From the host project root:

```bash
npm install -D file:../the-forge/packages/vite-plugin
```

Adjust the relative path if you cloned somewhere else. npm links folder dependencies, so rebuilding the checkout later updates the host project automatically.

### 3. Add the plugin to the Vite config

In `vite.config.ts`, import `theForge` and add it to `plugins` — **before** the React plugin, so it can tag JSX before React compiles it:

```ts
import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import { theForge } from '@the-forge/vite'

export default defineConfig({
  plugins: [theForge(), react()],
})
```

Keep any other existing plugins exactly as they are; only add `theForge()` at the front.

### 4. Gitignore the runtime state

Add this line to the host project's `.gitignore` (create the file if needed):

```gitignore
.the-forge/
```

`.the-forge/` is per-machine runtime state (queue + endpoint files) written at the git root — it should never be committed.

Also note: on first dev-server start the plugin writes a `the-forge` entry into `.mcp.json` and two command files into `.claude/commands/` (see step 5). The `.mcp.json` entry contains an **absolute path** to `dist/mcp.js` on this machine. If the project doesn't already commit `.mcp.json`, gitignore it too; if the team does commit it, that's fine — the plugin rewrites the entry with the correct local path on each machine's next dev-server start.

### 5. Start the dev server once and verify

Start the dev server the way the project normally does (`npm run dev` or `npx vite`). On startup the plugin auto-installs, at the **git root**:

- `.mcp.json` — registers the `the-forge` MCP server (how the agent pulls edits).
- `.claude/commands/forge-design.md` — the `/forge-design` command (pull + apply once).
- `.claude/commands/forge-watch.md` — the `/forge-watch` command (stay linked, apply as edits arrive).
- `.the-forge/` — runtime queue + endpoint state.

Verify all of the above exist, then open the app in a browser and confirm a **Design** toggle appears in the bottom-right corner. You can leave the dev server running or stop it — setup is done either way.

### 6. Tell your human what to do

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
5. **Verify.** After the agent edits your source and Vite hot-reloads, The Forge checks the computed styles and flips matching drafts to **Implemented**. If something doesn't match, the draft stays visible so nothing is silently lost.

### Troubleshooting

- **`/forge-design` / `/forge-watch` don't exist in Claude Code** — the commands are installed on dev-server start; restart Claude Code after the first setup, and make sure the session is opened at the project's **git root** (the MCP server looks for `.the-forge/` in the directory Claude Code was launched from).
- **Sends aren't arriving** — check the dev server is actually running, and that you don't have a stale second dev server on another port (kill old ones; on macOS: `lsof -iTCP:5173`). With two dev servers on one project, the watcher may be linked to the wrong one.
- **Panel shows the watcher went idle** — type `/forge-watch` again in Claude Code; watchers deliberately stop after 20 idle minutes so a forgotten session never runs overnight.
- **No Design toggle** — it only exists under `vite dev`. Production builds contain zero trace of The Forge by design.
- **Updating The Forge** — `git pull && npm install && npm run build` in the `the-forge` checkout; the host project picks it up on the next dev-server restart.
