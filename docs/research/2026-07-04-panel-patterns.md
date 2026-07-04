# Panel Patterns Research — Synthesis & Decisions (2026-07-04)

Two research passes: Figma's Design panel (post-UI3) and dev-world panels (Cursor design mode, Codex annotations, VisBug, Chrome DevTools, Webflow, Onlook, tweakcn). Full dossiers live in the session record; this file captures what The Forge adopts.

## Architecture validation (no change needed)

- **Tweak-as-spec is the converged industry model** (Codex's annotation style controls, Cursor's Apply flow) — The Forge already does this, with two advantages both competitors lack: deterministic source mapping (`data-dc-source`; Builder.io names its absence Cursor's #1 failure) and zero-cost deterministic previews (Cursor burns agent credits per nudge).
- **Token-first output** guards against the most-cited real-world failure: agents emitting raw px/hex and "quietly decoupling components from the token hierarchy."

## Decisions (user-ratified)

1. **Spacing: emulate Figma** — paired H/V fields with expand-to-four (current M2a architecture), NOT the Webflow/DevTools box-model widget. Add Figma refinements: `Mixed` display, math expressions, ⌘-click CSS shorthand entry.
2. **Token picker ships in M2b-2** with Typography/Fill (where tokens matter most): `=` opens a searchable Tailwind token picker; bound values render as pills; Backspace detaches.

## Adopted principles

- **Stable section order; contextual content, never contextual position** (the #1 UI3 complaint: sections that move destroy muscle memory). Sections hide when inapplicable but never reorder: Layout → Size → Padding → Margin → Typography → Fill → Stroke → Appearance.
- **`Mixed` (never blank) for divergent linked/multi values**; math ops apply per-element relative (`Mixed+8`).
- **Math expressions in every numeric field**: `+ - * / ( )`.
- **Fields are tokenized, not bare-numeric**: `auto` and keywords are first-class; unit-aware scrubbing later.
- **Alignment as one spatial widget**: 9-dot matrix fusing `justify-content` × `align-items`, icons/dots orientation follows flex-direction; gap field accepts `Auto` (= space-between), collapsing the matrix's main axis.
- **Sizing modes embedded in W/H inputs**: Fixed / Hug (`auto`/`fit-content`) / Fill (`flex-1`/stretch), always-visible affordance (Figma's sometimes-hidden mode badge is a documented annoyance).
- **Typography = type scales and named weights, not sliders** (Chrome's slider font editor never left the experiments flag).
- **Relative deltas for multi-select** (VisBug: nudge N elements by +4 each), never absolute overwrite.
- **Changed-from-default disclosure** for advanced options (blend mode etc. appear inline only when non-default).
- **Popover mini-editors anchored to values** (DevTools shadow/color pattern); color picker should show contrast ratio.
- **Scrub polish**: Shift = ×10 (shipped), Alt-drag on input itself, speed modulated by vertical drag distance, pointer lock at screen edges.

## Anti-patterns we explicitly avoid

- Apply-then-pray (agent round-trip per nudge) · no real undo (drafts are individually revertible) · raw-value drift off the token scale · raw DOM tree as a layers panel · class-edit surprise without "affects N instances" (our instance-vs-component scope question, spec §10) · absolute-overwrite multi-select · slider-maximalist typography.

## The Forge-specific additions (no competitor has these)

- **Layout-ripple indicator**: when a draft reflows non-selected elements (flex stretch etc.), show fading secondary outlines on affected elements — distinguishes layout ripple from mis-targeting (born from the first real user session).
- **Verified-implemented state**: computed-style verification with inline-neutralized measurement (shipped in M4).
