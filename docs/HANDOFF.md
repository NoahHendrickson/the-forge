# The Forge — Handoff (updated 2026-07-22)

**Read [/CLAUDE.md](../CLAUDE.md) first** — it owns the what/why, commands, architecture map, MCP contract, hard product constraints, conventions, and gotchas. This file holds process conventions and a coarse state pointer: how work gets executed and reviewed with this user, and what's next. Fine-grained session state lives in auto-memory (see Working agreements), not here — this file only needs updating at milestone boundaries.

State: **v1 + watch mode + Next.js adapter + panel redesign + embedded sessions all COMPLETE and on `main`.** Shipped since the v1 line (M1–M5): watch mode (`/forge-watch` long-poll), the Next 15/16 adapter (both routers, both dev bundlers), the designer panel redesign + layout/fill/stroke/sizing/input-polish milestones, prompt mode → embedded sessions (milestones A+B: the dev server spawns `claude -p` as the dispatch ladder's top rung, with in-overlay approvals and a streamed session feed) → composer consolidation (the chat composer's ↑ is the only send surface; the old "Send to agent" button is retired), and the npm publish: the package was renamed `the-forge` → **`forge-mode`** (npm typosquat block, 2026-07-10) and v0.2.0 is live on npm (2026-07-22; v0.1.0 was the initial 2026-07-10 publish). Gate: `npm test` at root (typecheck + full suite), `./scripts/check-prod-clean.sh` (prod purity + package-size budget). Owner: Noey (product designer; the product's target user).

The full loop is user-verified live: panel edit → ↑ in the composer → embedded session (or linked watcher / dispatch ladder) pulls via MCP, applies to source → browser verifies computed styles → Implemented ✓.

**In flight (2026-07-22): the Figma pivot** — design mode becomes a Figma-shaped tool (frames,
insert/delete/move/text; margins invisible; a translation layer converts design ops to code
intent at send time). Spec: docs/specs/2026-07-22-figma-pivot-design.md; ratified decisions in
docs/research/2026-07-22-figma-pivot-exploration.md (amendment). **P1 is COMPLETE on branch
`claude/design-mode-figma-pivot-5d5133`** (unmerged): the DesignOp union at the three choke
points (drafts/wire/verifier), inline text editing (double-click → contenteditable), Del-to-
delete (display:none preview, inverted-polarity verify), Margin section removed, read-only X/Y
header. E2E-proved live against a real embedded session (text + delete + css regression all
Implemented ✓). E2E-caught fix worth knowing: Vite's 'vite:afterUpdate' is NOT a DOM event —
HmrSignal (client/verifier.ts) imports /@vite/client and mints its own hot context to hear it.
Known P1 limitation: structural drafts don't persist across reloads (css drafts do). Next:
P2 layers tree (own LEFT panel) → P3 move/resize + Absolute toggle → P4 insert → P5 reparent.

## Process conventions (these built the whole repo — keep them)

1. Brainstorm/design decisions with the user → write a dated plan in `docs/plans/` (contract + test-sketch style, complete interface signatures) → commit the plan to main → feature branch per milestone.
2. Execute with `superpowers:subagent-driven-development`: fresh implementer subagent per task (cheap model for transcription, mid-tier for integration), task-scoped review gate after each (spec compliance + quality, diff-file handoff), fix → re-review loops, ledger at `.superpowers/sdd/progress.md` (untracked, not gitignored — no rule in the tracked repo covers it, so don't `git add` it by accident).
3. Final whole-branch review on the most capable model with the accumulated-minors list; ONE fix subagent for all findings; re-review the wave (long implementer paths — 100+ tool uses — have produced collateral twice; always scrutinize those).
4. **Controller runs a real-browser E2E before every merge** (Playwright MCP; kill stale dev servers first). Live runs have caught bugs the unit suite missed (IPv6 bind, endpoint clobber, verifier self-confirmation, collapsed-prop commit no-op, Hug→px).
5. Merge decision belongs to the user (present options), then merge --no-ff to main, re-verify, push.
6. Nested `claude -p` cannot auth inside the sandbox — use a cold-context subagent (prompt = raw change-request markdown only) as the faithful equivalent for agent-apply proofs.

## Completed 2026-07-04 (overnight run) — do NOT re-execute

Track A (panel visual cleanup), Track B (M2b-2: typography/fill/stroke/color picker/token pills/multi-select), and Track C (M5: dispatch ladder + queue hardening) all shipped through the full gauntlet. Per-milestone plans live in docs/plans/; the SDD ledger (.superpowers/sdd/progress.md, untracked — not gitignored) holds the review forensics. Post-ship fixes from first real use: `/design` → `/forge-design` (collided with the Figma plugin's command), and ALL plugin-written artifacts (.mcp.json, command file, .the-forge runtime dir) now install at `resolveProjectRoot()` — the git root — never Vite's root. Any NEW on-disk artifact must do the same.

## Open backlog (rough value order)

1. Effects section (box-shadow, blur/backdrop-filter) — biggest remaining Figma-parity gap (spec §6 v2 tier).
2. Gradients / background-image in Fill; Position section (spec v2, partial).
3. Quick-apply mode (spec §7, optional, deliberately not primary).
4. Codex embedded-session adapter (milestone C2 of embedded sessions) — `SessionAdapter` (src/server/session/adapter.ts) is the seam; `ClaudeAdapter` and `CursorAdapter` (merged 2026-07-11, PR #32) are both implemented, Codex remains outstanding.
5. Real Channels adapter — blocked on the Claude Code preview flag; the rung is an inert stub behind `experimentalChannels`. Superseded twice over: watch mode (2026-07-04) and now the embedded rung both deliver zero-keystroke sends. Revisit only if Channels ships something these can't do.
6. ~~panel.ts Stage-2 split~~ — DONE across the panel milestones (panel-token-ui, panel-layout, panel-fillstroke extractions all landed by 2026-07-07).
7. Deferred nits (review-ledger minors): multi-select Compare keyed to first element; `auto`/`normal` displays as 0 in multi fields; `double`/`groove` border styles read as "None"; Cursor deeplink untested against real Cursor (6000-char cap is a chosen constant); tmux rung assumes `pane_current_command` reports `claude`/`codex` (wrapper-launched agents may report `node`); client runs two /status pollers (verifier @2s while sends pending, watch probe @5s while design mode on) — PR #1 review suggested unifying into one StatusPoller; deferred as a behavioral refactor of proven verifier timing, do it when next touching the verifier.

## Working agreements with this user

- They're a designer: show, don't tell (screenshots, before/after); ask real design decisions via options, decide the technical ones yourself.
- Verify claims live before reporting done; report review findings honestly (they respond well to "the review caught X").
- Update auto-memory at milestone boundaries: the index is `~/.claude/projects/-Users-noey-Developer-the-forge/memory/MEMORY.md`, one file per fact beside it.
