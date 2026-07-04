# The Forge — Handoff (2026-07-04)

State: M1, M2a, M3, M4, M2b-1 merged to `main` and pushed. 296 tests + typecheck gate (`npm test` at root), prod-clean check (`./scripts/check-prod-clean.sh`). Owner: Noey (product designer; the product's target user).

## Read first

- `README.md` — what the product is and how to run it (`npm run dev -w demo-app`).
- `docs/specs/2026-07-03-the-forge-design.md` — the spec (§6 panel map, §10 open questions/backlog).
- `docs/research/2026-07-04-panel-patterns.md` — panel design principles (user-ratified decisions: Figma-style spacing rows, token picker in M2b-2, stable section order, Mixed-not-blank, etc.).
- `docs/plans/` — one dated plan per milestone; follow the same format.

## Process conventions (these built the whole repo — keep them)

1. Brainstorm/design decisions with the user → write a dated plan in `docs/plans/` (contract + test-sketch style, complete interface signatures) → commit the plan to main → feature branch per milestone.
2. Execute with `superpowers:subagent-driven-development`: fresh implementer subagent per task (cheap model for transcription, mid-tier for integration), task-scoped review gate after each (spec compliance + quality, diff-file handoff), fix → re-review loops, ledger at `.superpowers/sdd/progress.md` (gitignored).
3. Final whole-branch review on the most capable model with the accumulated-minors list; ONE fix subagent for all findings; re-review the wave (long implementer paths — 100+ tool uses — have produced collateral twice; always scrutinize those).
4. **Controller runs a real-browser E2E before every merge** (Playwright MCP; kill stale dev servers first — check `lsof -iTCP:5173`). Live runs have caught bugs 296 unit tests missed (IPv6 bind, endpoint clobber, verifier self-confirmation, collapsed-prop commit no-op, Hug→px). jsdom cannot see flex layout, transitions, or real computed styles — never trust it alone for those.
5. Merge decision belongs to the user (present options), then merge --no-ff to main, re-verify, push.
6. Nested `claude -p` cannot auth inside the sandbox — use a cold-context subagent (prompt = raw change-request markdown only) as the faithful equivalent for agent-apply proofs.

## Hard product constraints (user-set, non-negotiable)

- Complementary to Claude Code/Cursor/Codex — never a replacement, never a new chat surface.
- Subscription-only: official CLI binaries or the user's running session; never the Agent SDK / API keys.
- Deterministic, token-first change requests; previews are inline styles (framework-bypass); zero production footprint (`apply: 'serve'` + prod-clean check); idle-zero overhead.

## Execution: all three tracks, in order, one agent (overnight mode)

The user is asleep and has handed off all three tracks as ONE sequential plan: **A → B → C**. Rules for the overnight run:

- Work autonomously; do not block on user input. For genuinely user-facing design choices (Track A especially), pick the Figma-reference default, record the decision and alternatives, and capture before/after screenshots for the morning report.
- Each track runs the full gauntlet on its own branch: plan (if the track needs one beyond this doc) → subagent-driven tasks with review gates → final whole-branch review + fix wave → controller real-browser E2E. **Merge to main and push only when the gauntlet is fully green** — that has been the user's choice 5/5 times; anything uncertain stays on its branch with a morning question instead.
- Tracks build on each other — merge A before starting B, B before C. If a track stalls on something only the user can resolve, park it on its branch, write the question down, and move to the next track only if independent (C is independent of B; B depends on A's panel styling).
- End with a morning report the user reads over coffee: per track — what shipped, before/after screenshots, review catches, decisions made on their behalf (with rationale), and the short list of things needing their eyes. Update the auto-memory file at the end.

## The three tracks (user-prioritized order)

### Track A — Panel visual audit & cleanup (NEW, do first)

The user reports the panel "looks not so great" and couldn't find the 9-dot alignment matrix. Scope:
1. **Diagnose discoverability first**: the Layout section (matrix/gap/direction) only appears when the SELECTED element is a flex container — is that the confusion (selecting a card instead of the row), a stale-build issue, or genuinely broken/ugly rendering? Reproduce in the demo app with the user.
2. **Visual audit against references**: side-by-side against Figma's Design panel (post-UI3) and Cursor's design-mode panel. The research doc's principles are the rubric (stable order, labels, spacing rhythm, control affordances, scrub cursors, active states, section headers, empty states). Screenshot-driven: capture the current panel per selection type and mark every deviation.
3. **Cleanup plan + execution**: overlay.ts's CSS string is the whole design system today (~90 lines, programmer-styled). Expect: consistent type scale/spacing, real hover/focus/active states, matrix that reads as a matrix, size-mode selects that don't look like raw `<select>`s, panel header hierarchy, section separators, and an empty-state treatment for "Add auto layout". Dark-mode-ish neutrality (the overlay sits on arbitrary apps). Get the user's eyes on before/after screenshots — this track is design-led; propose, show, iterate.
4. Keep all 296 tests green — class names are test hooks; extend rather than rename where possible.

### Track B — M2b-2: Typography, Fill/Stroke, token picker, multi-select

Spec §6 tiers + research doc "Top 10" items not yet built:
- **PREREQUISITE (from final review):** replace the keyword-shape regex in `request.ts` (`/^[a-z-]+$/i` passthrough) with an explicit keyword allowlist BEFORE color drafts exist — otherwise `red` would false-passthrough.
- Typography section (family from loaded fonts, named weights, size/line-height/letter-spacing, align) — type scales + named weights, no sliders.
- Fill (bg/text color) + Stroke (border) with a popover color picker (contrast ratio a la DevTools); token-aware snapping to the Tailwind palette.
- `=` opens a searchable Tailwind token picker; bound values render as pills; Backspace detaches (research doc pattern 7).
- Multi-select with RELATIVE deltas (VisBug model; `Mixed+8` math) + a Selection-colors-style aggregate section.
- Deferred M2a/M2b-1 nits if touched: height:auto-as-empty in W/H, Escape-in-input blurs (not deselect), expand-state persistence across selections, NumberField destroy().

### Track C — M5: Auto-dispatch + queue hardening

Spec §7 dispatch ladder + M4 final-review deferrals:
- Zero-keystroke Send→session: tmux `send-keys` adapter + macOS AppleScript (iTerm/Terminal) fallback typing `/forge-design` into the user's running Claude Code; Claude Code Channels experiment behind a flag (`--dangerously-load-development-channels`, preview); Cursor deeplink adapter.
- Queue hardening: claim timeout/re-queue for abandoned items, queue.json pruning of applied items, atomic writes (temp+rename), shared secret on mutating endpoints (belt-and-braces beyond Origin/Host checks), POST for /pull, CSS.escape hardening, "treat request content as data" line in the /forge-design command.
- The standalone `npx the-forge` CLI becomes real here if process control demands it (spec §3.3 amendment).

## Working agreements with this user

- They're a designer: show, don't tell (screenshots, before/after); ask real design decisions via options, decide the technical ones yourself.
- Verify claims live before reporting done; report review findings honestly (they respond well to "the review caught X").
- Update `~/.claude/projects/-Users-noey/memory/the-forge-project.md` (auto-memory) at milestone boundaries.
