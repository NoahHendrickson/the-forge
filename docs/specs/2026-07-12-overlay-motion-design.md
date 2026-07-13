# Overlay motion design — 2026-07-12

A motion pass over the whole overlay: a small token-driven motion system (durations +
spring easing baked as CSS `linear()`), then subtle, springy animation on every state
change that deserves it — popovers, the draft disclosure, the send button, the changes
list, chat bubbles, panel/dock, the selection outline, canvas enter/exit, and toasts.
Zero new dependencies, zero idle overhead, `prefers-reduced-motion` respected everywhere.

User-ratified choices (2026-07-12 brainstorm):

- **Full pass** — foundation plus all nine animation clusters in one milestone, including
  the two spatial ones (selection-outline tween, canvas enter/exit).
- **Subtle spring house style** — ~2% overshoot, fast settle (the Apple/Linear feel);
  explicitly not a visible playful bounce.
- **Direct manipulation stays instant** — number scrubbing, feed-divider drag, hover
  outline tracking, and canvas wheel pan/zoom get no motion, ever. High-frequency actions
  earn less animation, not more.
- **Exits are faster and plainer than entrances** (~20% shorter, plain ease-out, no
  spring) per the research pass (Apple HIG Motion, WWDC23 springs talk, Emil Kowalski's
  duration/easing guidance).

## Current state (what changes)

The overlay today has exactly three transitions (ripple fade `overlay.ts`, align-toggle
knob, draft-pill chevron), one keyframe (`forge-chip-pulse`), and no easing curves beyond
keywords. Everything else is a hard cut via `hidden` toggles, `classList.toggle`, or
inline-style snaps. There are no motion tokens, no `prefers-reduced-motion` handling
anywhere, and one fragile hand-synced JS/CSS duration pair (`RIPPLE_FADE_MS` vs `0.3s`).

## Design

### 1. Motion tokens + reduced-motion guard (foundation)

New entries in the `TOKENS` map (`overlay.ts`) so the whole system rides `var()`:

- `dur-fast: 120ms` — micro-interactions (chip color shifts, press feedback, chevrons).
- `dur-pop: 180ms` — popovers, disclosure, bubbles, toasts.
- `dur-panel: 240ms` — panel show, dock↔float, canvas enter/exit.
- `ease-spring` — a baked `linear(…)` spring curve, ≤2% overshoot, generated once at
  authoring time (spring params tuned in-browser during implementation; the stop list
  stays under ~200 bytes — one shared curve, no per-element curves).
- `ease-out: cubic-bezier(0.22, 1, 0.36, 1)` — the standard exit/enter-content curve.

A single `@media (prefers-reduced-motion: reduce)` block in the CSS string sets all three
durations to `1ms` (not `0s`, so `transitionend` still fires for JS that waits on it).
JS-coordinated motion (selection tween, canvas enter/exit, row collapse) additionally
checks a shared `prefersReducedMotion()` helper and skips arming entirely.

New module `ui/motion.ts`: `prefersReducedMotion()` plus `popOnce(el)` — the
re-triggerable keyframe helper (remove class, force reflow, re-add) used by the send
morph and done-chip pop. That's the whole JS surface of the foundation.

Shared keyframes added to the CSS string: `forge-pop` (scale 0.8 → spring to 1),
`forge-rise-in` (opacity 0 + translateY(8px) → settled), `forge-shake` (one subtle
±2px x oscillation, ~250ms). CSS comments stay out of the string (bundle bytes — known
gotcha); why-comments live in TS around it.

### 2. Popovers spring in (color picker, token picker, menus)

All three surfaces show/hide via the `hidden` attribute, so this is CSS-only using
`transition-behavior: allow-discrete` + `@starting-style`:

- Enter: `opacity 0 → 1`, `scale 0.96 → 1` over `dur-pop ease-spring`,
  `transform-origin` at the anchored edge (top for below-anchor popovers).
- Exit: `opacity → 0` over ~100ms `ease-out`, `display` transitioned discretely so the
  fade completes before `display:none` lands.

Browsers without `@starting-style` simply snap (today's behavior) — graceful degradation,
no JS fallback. Applies to `.cp-root`/token-picker root/`ui/menu` popovers and the
zoom-pill wrap; class names untouched (test hooks).

### 3. Draft disclosure expands

`.draft-disclosure` moves from `display:none → block` to the grid-rows technique:
`display:grid; grid-template-rows: 0fr ⇄ 1fr` (inner wrapper gets `min-height: 0;
overflow: hidden`), transitioned over `dur-pop ease-spring`, content opacity riding
along. The `.open` class toggle and `.draft-disclosure` hook are unchanged; the existing
chevron rotation now has a partner.

### 4. Send button press + morph

- Press feedback: `.composer-send:active { scale: 0.95 }` with a `dur-fast` transition —
  spring return on release.
- The ↑/■ morph (`updateSendMorph`) arms `popOnce` so the new glyph scale-pops in
  (`forge-pop`, `dur-fast`). No two-layer cross-fade — the pop reads as the morph.

### 5. Changes-list lifecycle

- `.chip-*` chips get `transition: background-color, border-color, color dur-fast` so
  draft→sent→applying→done reads as a smooth shift; the existing applying pulse stays.
- Done: `forge-pop` on the `.chip-done::before` dot — a small springy arrival.
- Failed: `forge-shake` on the chip, once — the one place a stronger gesture is earned.
- Dismiss/removal: rows currently vanish on DOM removal. `changelist.ts` gets a
  `collapseRow(el, onDone)` step — grid-rows `1fr → 0fr` + fade over `dur-fast`, removal
  on `transitionend` (with a timeout fallback and a `prefersReducedMotion()` bypass).

### 6. Chat bubbles + approval card

- `.chat-msg` enters with `forge-rise-in` (`dur-pop ease-out` — content enter is
  fade+rise, deliberately not springy).
- `.session-approval` enters with the same rise but `ease-spring` and `dur-panel` — it's
  requesting attention, so it gets the one slightly-more-present entrance. Streaming
  delta updates don't re-trigger anything (animation on element creation only).

### 7. Panel + dock

- Panel show (design-mode on): `forge-rise-in` variant over `dur-panel ease-out`.
- Dock↔float: `dock.ts` sets `document.documentElement.style.marginRight` — on the
  toggle path only, it also sets an inline `transition: margin-right 240ms` (literal
  value; page context can't see shadow-root tokens), cleared on `transitionend`. The
  panel's own `.docked` geometry change rides a matching transition so page push and
  panel move read as one gesture. Width-drag resizing stays instant (direct
  manipulation); `setCanvasActive`'s margin suspension stays instant (canvas owns its own
  motion, below).

### 8. Selection outline tween

`#select-outline` gains `left/top/width/height` transitions (`dur-fast ease-out`, snappy
Figma feel — deliberately not spring; a springy rect reads as wobble) gated behind a
`.tween` class. `showSelectOutline` arms `.tween` only when the selection *changes to a
different element*, and drops it on `transitionend`/timeout — so scroll/resize/reflow
tracking (`onMove`/`onReflow` rAF paths) keeps snapping instantly, and the first
appearance from nothing fades in rather than flying in from a stale rect. Multi-select
outlines are pooled and reused across arbitrary sets — they keep snapping (out of scope
for tweening).

### 9. Canvas enter/exit + fit zooms

`canvas.ts` owns page-context motion with literal constants (no shadow tokens):

- Enter/exit: set `body.style.transition = 'transform 240ms <spring literal>'`, apply the
  artboard/restore transform, clear the transition on `transitionend` (belt-and-braces
  timeout) so wheel pan/zoom is never damped. Background/box-shadow snap with a short
  opacity-friendly transition where cheap.
- Keyboard fit-zooms (Shift+0/1/2 and the zoom-ladder steps) ride the same brief
  transition; wheel and drag stay instant.
- `prefersReducedMotion()` bypasses all of it (transforms apply instantly, as today).

### 10. Toasts + status

`#status` show/hide gets the same `@starting-style` fade+rise treatment as popovers
(`dur-pop`). The zoom pill is covered in §2.

## Out of scope

- Number-scrub, feed-divider drag, hover-outline tracking, canvas wheel input — never
  animated (ratified).
- Multi-select outline tweening.
- Ripple system changes — it already animates; it only gains the reduced-motion guard.
- The `flashButton` text swap (works fine; not a visual animation).
- No WAAPI, no animation library, no new runtime deps.

## Testing

- `tests/client/overlay.test.ts`: TOKENS gains the motion entries (token-count/shape
  assertions updated); CSS string contains the reduced-motion block, `@starting-style`
  rules, and the three keyframes.
- New `tests/client/motion.test.ts`: `prefersReducedMotion()` (matchMedia mocked),
  `popOnce` re-trigger semantics (class removed→re-added, reflow forced).
- `tests/client/changelist.test.ts`: `collapseRow` removes the row on transitionend, on
  timeout fallback, and immediately under reduced motion.
- `tests/client/overlay.test.ts` (outline): `.tween` armed only on selection change, not
  on reflow re-place; dropped after transitionend.
- `tests/client/canvas.test.ts`: transition set on enter/exit and cleared on
  transitionend/timeout; never present during wheel handling; reduced-motion bypass.
- `tests/client/dock.test.ts`: margin transition present on toggle path, absent during
  width drag.
- Storybook: motion states for popovers, chips (done pop, failed shake), and the send
  morph in the existing stories.
- jsdom cannot see transitions running — assertions are about classes, inline styles, and
  CSS-string contents. Real-browser E2E in the demo app before merge is mandatory (known
  gotcha), including a `prefers-reduced-motion` emulation pass in DevTools.

## Budget

`dist/client.js` is ~197KB against the 250KB client budget. This adds ~1.5–2KB of CSS
(the `linear()` spring stop list is the single biggest line item — one shared curve,
~200 bytes) and ~1KB of JS across `ui/motion.ts`, changelist collapse, outline/canvas
arming. Verify with the existing budget check (`check-prod-clean.sh` + client-budget
test) before merge.
