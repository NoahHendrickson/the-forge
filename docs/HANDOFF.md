# The Forge — Handoff (updated 2026-07-04, post-overnight)

**Read [/CLAUDE.md](../CLAUDE.md) first** — it owns the what/why, commands, architecture map, MCP contract, hard product constraints, conventions, and gotchas. This file holds process and session state: how work gets executed and reviewed with this user, and what's next.

State: **v1 COMPLETE.** M1, M2a, M2b-1, M2b-2, M3, M4, M5 + the panel visual overhaul all merged to `main` and pushed. Gate: `npm test` at root (typecheck + full suite), `./scripts/check-prod-clean.sh` (prod purity + package-size budget). Owner: Noey (product designer; the product's target user).

The full loop is user-verified live: panel edit → Send → dispatch ladder types `/forge-design` into the running Claude Code session (zero keystrokes) → agent pulls via MCP, applies to source → browser verifies computed styles → Implemented ✓.

## Process conventions (these built the whole repo — keep them)

1. Brainstorm/design decisions with the user → write a dated plan in `docs/plans/` (contract + test-sketch style, complete interface signatures) → commit the plan to main → feature branch per milestone.
2. Execute with `superpowers:subagent-driven-development`: fresh implementer subagent per task (cheap model for transcription, mid-tier for integration), task-scoped review gate after each (spec compliance + quality, diff-file handoff), fix → re-review loops, ledger at `.superpowers/sdd/progress.md` (gitignored).
3. Final whole-branch review on the most capable model with the accumulated-minors list; ONE fix subagent for all findings; re-review the wave (long implementer paths — 100+ tool uses — have produced collateral twice; always scrutinize those).
4. **Controller runs a real-browser E2E before every merge** (Playwright MCP; kill stale dev servers first). Live runs have caught bugs the unit suite missed (IPv6 bind, endpoint clobber, verifier self-confirmation, collapsed-prop commit no-op, Hug→px).
5. Merge decision belongs to the user (present options), then merge --no-ff to main, re-verify, push.
6. Nested `claude -p` cannot auth inside the sandbox — use a cold-context subagent (prompt = raw change-request markdown only) as the faithful equivalent for agent-apply proofs.

## Completed 2026-07-04 (overnight run) — do NOT re-execute

Track A (panel visual cleanup), Track B (M2b-2: typography/fill/stroke/color picker/token pills/multi-select), and Track C (M5: dispatch ladder + queue hardening) all shipped through the full gauntlet. Per-milestone plans live in docs/plans/; the SDD ledger (.superpowers/sdd/progress.md, gitignored) holds the review forensics. Post-ship fixes from first real use: `/design` → `/forge-design` (collided with the Figma plugin's command), and ALL plugin-written artifacts (.mcp.json, command file, .the-forge runtime dir) now install at `resolveProjectRoot()` — the git root — never Vite's root. Any NEW on-disk artifact must do the same.

## Open backlog (rough value order)

1. Effects section (box-shadow, blur/backdrop-filter) — biggest remaining Figma-parity gap (spec §6 v2 tier).
2. Gradients / background-image in Fill; Position section (spec v2, partial).
3. Quick-apply mode (spec §7, optional, deliberately not primary).
4. Real Channels adapter — blocked on the Claude Code preview flag; the rung is an inert stub behind `experimentalChannels`. Superseded in practice by watch mode (`/forge-watch` + `wait_for_design_edits` long-poll, 2026-07-04): a linked session already gets zero-keystroke delivery without the preview. Revisit only if Channels ships something the long-poll can't do.
5. panel.ts Stage-2 split (section modules behind a PanelContext interface) — do BEFORE the next panel-feature milestone; Stage 1 (panel-specs/panel-readers) landed 2026-07-04.
6. Deferred nits (review-ledger minors): multi-select Compare keyed to first element; `auto`/`normal` displays as 0 in multi fields; `double`/`groove` border styles read as "None"; Cursor deeplink untested against real Cursor (6000-char cap is a chosen constant); tmux rung assumes `pane_current_command` reports `claude`/`codex` (wrapper-launched agents may report `node`).

## Working agreements with this user

- They're a designer: show, don't tell (screenshots, before/after); ask real design decisions via options, decide the technical ones yourself.
- Verify claims live before reporting done; report review findings honestly (they respond well to "the review caught X").
- Update `~/.claude/projects/-Users-noey/memory/the-forge-project.md` (auto-memory) at milestone boundaries.
