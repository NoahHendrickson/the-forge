# Overlay Motion Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Token-driven, subtle-springy motion across the overlay — popovers, disclosure, send button, changes list, chat rows, selection outline, panel/dock, canvas zooms — with `prefers-reduced-motion` respected everywhere. Spec: `docs/specs/2026-07-12-overlay-motion-design.md`.

**Architecture:** One new module `src/client/motion.ts` owns every duration/easing constant (the baked `linear()` spring included) plus the three JS helpers (`prefersReducedMotion`, `popOnce`, `collapseRow`); `overlay.ts`'s TOKENS map re-exports the durations/easings as CSS custom properties so all shadow-DOM motion rides `var()`, while page-context motion (dock margin, canvas body transform) imports the same constants directly — no hand-synced JS/CSS pairs (the RIPPLE_FADE_MS lesson). Everything else is CSS retrofits onto existing class/`hidden` toggles, plus four small JS touch-points.

**Tech Stack:** TypeScript, vitest + jsdom, the overlay's CSS-string design system, CSS `linear()` easing / `@starting-style` / `transition-behavior: allow-discrete` (evergreen-browser features; non-supporting browsers snap, i.e. today's behavior).

## Global Constraints

- Zero new runtime dependencies; no WAAPI library, no animation framework.
- Client bundle budget: 250KB (`dist/client.js` currently ~197KB) — enforced by the existing budget test. Comments inside the overlay CSS *string* cost bundle bytes — annotate in JS comments outside the string.
- CSS class names are test hooks — **extend, don't rename**. New classes introduced by this plan: `.forge-anim`, `.pop` (scoped `.composer-send.pop`), `.stage-flip`, `.tween`.
- Direct manipulation stays instant (ratified): number scrubbing, feed-divider drag, hover-outline tracking, canvas wheel/pinch/drag, panel width drag. Any in-flight tween must be cancelled when one of these begins.
- Exits ~20% faster and plainer than entrances (100ms ease-out vs 180ms spring for popovers).
- Why-comments are load-bearing — preserve verbatim when moving code.
- All commands run from `packages/the-forge/` unless noted; the root gate is `npm test` from the repo root.
- jsdom cannot see transitions/layout — unit tests assert classes, inline styles, and CSS-string contents; Task 10 does the mandatory real-browser pass.

**Spec deviations locked in by code reality (surface in the final report):**
1. Changes-list chips can't CSS-transition colors — `ChangeList.render()` rebuilds every row via `replaceChildren()`, so transitions never fire and naive entry animations would replay on every re-render. Replaced by a stage-changed tracker (`.stage-flip`) that plays the done-pop/failed-shake exactly once per real stage change (Task 5).
2. Canvas enter/exit are already visually seamless by design (the seed transform matches live scroll; unapply restores scroll to match) — the animated moments are the **discrete zooms** (fit/ladder/50-100-200%/Shift+0-1-2), not enter/exit (Task 9).
3. Dock↔float does NOT transition the panel's own geometry — float↔dock interpolates against `bottom/max-height: auto` (non-interpolable) and reparents `#status` mid-switch, so a partial tween reads as jank. The page's margin push animates (the dominant motion); the panel snaps (Task 8).

---

### Task 1: Motion foundation — `motion.ts`, tokens, keyframes, reduced-motion

**Files:**
- Create: `packages/the-forge/src/client/motion.ts`
- Modify: `packages/the-forge/src/client/overlay.ts` (TOKENS map ~line 10; CSS string end ~line 708)
- Test: `packages/the-forge/tests/client/motion.test.ts` (new), `packages/the-forge/tests/client/overlay.test.ts`

**Interfaces:**
- Consumes: nothing new.
- Produces (everything later tasks import from `./motion`):
  - `DUR_FAST_MS = 120`, `DUR_POP_MS = 180`, `DUR_PANEL_MS = 240` (numbers)
  - `EASE_SPRING: string` (the baked `linear()` curve), `EASE_OUT: string`
  - `prefersReducedMotion(): boolean`
  - `popOnce(el: HTMLElement, className?: string): void` (default `'pop'`)
  - `collapseRow(row: HTMLElement, onDone: () => void): void`
  - CSS vars `--dur-fast/--dur-pop/--dur-panel/--ease-spring/--ease-out` and keyframes `forge-pop`, `forge-rise-in`, `forge-shake` available to all later CSS.

- [ ] **Step 1: Write the failing tests**

Create `tests/client/motion.test.ts`:

```ts
import { describe, it, expect, vi, afterEach } from 'vitest'
import {
  DUR_FAST_MS, DUR_POP_MS, DUR_PANEL_MS, EASE_SPRING, EASE_OUT,
  prefersReducedMotion, popOnce, collapseRow,
} from '../../src/client/motion'

afterEach(() => vi.restoreAllMocks())

function stubReducedMotion(matches: boolean): void {
  vi.spyOn(window, 'matchMedia').mockReturnValue({ matches } as MediaQueryList)
}

describe('motion constants', () => {
  it('durations are ordered fast < pop < panel and all under 300ms', () => {
    expect(DUR_FAST_MS).toBeLessThan(DUR_POP_MS)
    expect(DUR_POP_MS).toBeLessThan(DUR_PANEL_MS)
    expect(DUR_PANEL_MS).toBeLessThanOrEqual(300)
  })
  it('spring is a linear() curve that starts at 0, ends settled at 1, peaks ≤ 1.02', () => {
    expect(EASE_SPRING.startsWith('linear(0,')).toBe(true)
    expect(EASE_SPRING.trimEnd().endsWith('1)')).toBe(true)
    const stops = [...EASE_SPRING.matchAll(/([\d.]+)(?: \d+%)?/g)].map((m) => Number(m[1]))
    expect(Math.max(...stops)).toBeLessThanOrEqual(1.02)
    expect(EASE_OUT.startsWith('cubic-bezier(')).toBe(true)
  })
})

describe('prefersReducedMotion', () => {
  it('mirrors the media query', () => {
    stubReducedMotion(true)
    expect(prefersReducedMotion()).toBe(true)
    stubReducedMotion(false)
    expect(prefersReducedMotion()).toBe(false)
  })
})

describe('popOnce', () => {
  it('re-arms the class so a repeat call can replay the animation', () => {
    stubReducedMotion(false)
    const el = document.createElement('button')
    popOnce(el)
    expect(el.classList.contains('pop')).toBe(true)
    popOnce(el) // must not throw and must leave the class re-applied
    expect(el.classList.contains('pop')).toBe(true)
  })
  it('does nothing under reduced motion', () => {
    stubReducedMotion(true)
    const el = document.createElement('button')
    popOnce(el)
    expect(el.classList.contains('pop')).toBe(false)
  })
})

describe('collapseRow', () => {
  it('fires onDone via the timeout fallback (jsdom never fires transitionend)', () => {
    stubReducedMotion(false)
    vi.useFakeTimers()
    const row = document.createElement('div')
    document.body.appendChild(row)
    const done = vi.fn()
    collapseRow(row, done)
    expect(row.style.height).toBe('0px')
    expect(row.style.opacity).toBe('0')
    expect(done).not.toHaveBeenCalled()
    vi.advanceTimersByTime(DUR_FAST_MS + 100)
    expect(done).toHaveBeenCalledTimes(1)
    vi.advanceTimersByTime(1000) // transitionend after timeout must not double-fire
    row.dispatchEvent(new Event('transitionend'))
    expect(done).toHaveBeenCalledTimes(1)
    vi.useRealTimers()
  })
  it('fires onDone synchronously under reduced motion', () => {
    stubReducedMotion(true)
    const row = document.createElement('div')
    const done = vi.fn()
    collapseRow(row, done)
    expect(done).toHaveBeenCalledTimes(1)
  })
})
```

Add to `tests/client/overlay.test.ts` (alongside its existing CSS/TOKENS assertions):

```ts
it('exposes the motion tokens and keyframes', () => {
  expect(TOKENS['dur-fast']).toBe('120ms')
  expect(TOKENS['dur-pop']).toBe('180ms')
  expect(TOKENS['dur-panel']).toBe('240ms')
  expect(TOKENS['ease-spring'].startsWith('linear(')).toBe(true)
  expect(TOKENS['ease-out'].startsWith('cubic-bezier(')).toBe(true)
  expect(CSS).toContain('@keyframes forge-pop')
  expect(CSS).toContain('@keyframes forge-rise-in')
  expect(CSS).toContain('@keyframes forge-shake')
  expect(CSS).toContain('@media (prefers-reduced-motion: reduce)')
})
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run tests/client/motion.test.ts tests/client/overlay.test.ts`
Expected: FAIL — module `../../src/client/motion` not found; TOKENS lacks `dur-fast`.

- [ ] **Step 3: Implement**

Create `src/client/motion.ts`:

```ts
/**
 * The overlay's motion system — the single source for durations and easing curves
 * (2026-07-12 overlay-motion spec). overlay.ts's TOKENS map serializes these into
 * CSS custom properties for shadow-DOM rules; page-context motion (dock margin push,
 * canvas body transform) imports the same constants directly, so a JS timeout and its
 * CSS transition can never drift apart (the RIPPLE_FADE_MS hand-sync lesson).
 */

/** Micro-interactions: press feedback, chip pops, the selection-outline tween. */
export const DUR_FAST_MS = 120
/** Popovers, disclosure expand, chat-row entrances, toasts. */
export const DUR_POP_MS = 180
/** Panel appearance, dock margin push, canvas discrete zooms. */
export const DUR_PANEL_MS = 240

/**
 * Damped-spring easing baked as a CSS linear() curve (authoring-time generated:
 * ζ=0.78, ~2% peak overshoot at ~52% of the duration, fully settled at 100% —
 * user-ratified "subtle, not bouncy"). linear() is the only way to overshoot in
 * pure CSS; cubic-bezier cannot cross 1 and come back.
 */
export const EASE_SPRING =
  'linear(0, 0.123 6%, 0.36 12%, 0.593 18%, 0.775 24%, 0.897 30%, 0.968 36%, 1.004 42%, 1.019 50%, 1.018 58%, 1.011 66%, 1.005 76%, 1.001 88%, 1)'

/** The standard exit / content-enter curve (fast start, gentle settle, no overshoot). */
export const EASE_OUT = 'cubic-bezier(0.22, 1, 0.36, 1)'

/** JS-coordinated motion must check this and skip arming entirely — the CSS-side guard
 * (the reduced-motion block in overlay.ts) only covers shadow-DOM rules. */
export function prefersReducedMotion(): boolean {
  return typeof window.matchMedia === 'function' &&
    window.matchMedia('(prefers-reduced-motion: reduce)').matches
}

/** Re-triggerable one-shot animation: remove the class, force a style flush so the
 * browser sees the removal, re-add it — the standard restart idiom. The class's CSS
 * carries the actual @keyframes animation. */
export function popOnce(el: HTMLElement, className = 'pop'): void {
  if (prefersReducedMotion()) return
  el.classList.remove(className)
  void el.offsetWidth
  el.classList.add(className)
}

/** Fade-and-collapse a row, then hand control back (the caller does the actual state
 * mutation — e.g. session.removeSeed — in onDone, which triggers the re-render that
 * discards this element). transitionend AND a timeout race to onDone (jsdom and
 * display:none ancestors never fire transitionend); whichever fires first wins. */
export function collapseRow(row: HTMLElement, onDone: () => void): void {
  if (prefersReducedMotion()) {
    onDone()
    return
  }
  row.style.height = `${row.offsetHeight}px`
  row.style.overflow = 'hidden'
  void row.offsetWidth
  row.style.transition =
    `height ${DUR_FAST_MS}ms ${EASE_OUT}, opacity ${DUR_FAST_MS}ms ${EASE_OUT}, ` +
    `padding-top ${DUR_FAST_MS}ms ${EASE_OUT}, padding-bottom ${DUR_FAST_MS}ms ${EASE_OUT}`
  row.style.height = '0px'
  row.style.opacity = '0'
  row.style.paddingTop = '0'
  row.style.paddingBottom = '0'
  let fired = false
  const finish = (): void => {
    if (fired) return
    fired = true
    onDone()
  }
  row.addEventListener('transitionend', finish, { once: true })
  setTimeout(finish, DUR_FAST_MS + 80)
}
```

In `src/client/overlay.ts`, extend the TOKENS map (after `'text-md': '12px',`) — add the import at the top of the file first:

```ts
import { DUR_FAST_MS, DUR_POP_MS, DUR_PANEL_MS, EASE_SPRING, EASE_OUT } from './motion'
```

```ts
  'dur-fast': `${DUR_FAST_MS}ms`,
  'dur-pop': `${DUR_POP_MS}ms`,
  'dur-panel': `${DUR_PANEL_MS}ms`,
  'ease-spring': EASE_SPRING,
  'ease-out': EASE_OUT,
} as const
```

Extend the token-block doc comment (the JS comment above `export const CSS`, ~line 41) with one line:

```
// --dur-fast/--dur-pop/--dur-panel + --ease-spring/--ease-out: the motion system
//   (motion.ts is the source; see the 2026-07-12 overlay-motion spec).
```

Append to the END of the CSS string (after the `.zoom-pill:hover` rule) — annotation as a JS comment, per the bundle-bytes rule:

```ts
` +
// Motion primitives (2026-07-12 overlay-motion spec). forge-pop/rise-in are from-only —
// the destination is the element's natural state, so one keyframe serves every use site.
// The reduced-motion block is a blanket: 1ms (never 0s — transitionend must still fire
// for JS that waits on it) across every shadow-DOM transition/animation, including the
// pre-existing ripple fade and chip pulse. Page-context motion (dock margin, canvas
// transform) is guarded separately via prefersReducedMotion() in motion.ts.
`@keyframes forge-pop { from { transform: scale(0.8); } }
@keyframes forge-rise-in { from { opacity: 0; transform: translateY(8px); } }
@keyframes forge-shake { 25% { transform: translateX(-2px); } 50% { transform: translateX(2px); } 75% { transform: translateX(-1px); } }
@media (prefers-reduced-motion: reduce) {
  *, *::before, *::after {
    transition-duration: 1ms !important;
    animation-duration: 1ms !important;
    animation-iteration-count: 1 !important;
  }
}
`
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run tests/client/motion.test.ts tests/client/overlay.test.ts tests/client/tokens.test.ts`
Expected: PASS. If `tokens.stories.ts`/`overlay.test.ts` carry a token-count or exhaustive-key assertion, update it to include the five new keys (grep: `grep -n "TOKENS" packages/the-forge/tests/client/overlay.test.ts packages/the-forge/stories/tokens.stories.ts`).

- [ ] **Step 5: Commit**

```bash
git add packages/the-forge/src/client/motion.ts packages/the-forge/src/client/overlay.ts packages/the-forge/tests/client/motion.test.ts packages/the-forge/tests/client/overlay.test.ts
git commit -m "feat(client): motion foundation — tokens, linear() spring, keyframes, reduced-motion guard"
```

---

### Task 2: Popovers + status spring in, fade out

**Files:**
- Modify: `packages/the-forge/src/client/overlay.ts` (the `[hidden]` rule at the top of CSS ~line 55; new rules at the end; `#status` construction unchanged — class added in constructor ~line 747)
- Modify: `packages/the-forge/src/client/colorpicker.ts` (~line 133), `packages/the-forge/src/client/tokenpicker.ts` (root construction), `packages/the-forge/src/client/canvas-chrome.ts` (~line 19)
- Test: `packages/the-forge/tests/client/overlay.test.ts`, `packages/the-forge/tests/client/colorpicker.test.ts`, `packages/the-forge/tests/client/tokenpicker.test.ts`

**Interfaces:**
- Consumes: `--dur-pop/--ease-spring/--ease-out` vars from Task 1.
- Produces: the `.forge-anim` marker class contract — any `hidden`-toggled overlay element carrying `.forge-anim` gets spring-in/fade-out for free. Task 8 does NOT use it for `#panel` (entry-only there).

- [ ] **Step 1: Write the failing tests**

`tests/client/overlay.test.ts`:

```ts
it('exempts .forge-anim from the !important display:none so exits can transition', () => {
  expect(CSS).toContain('[hidden]:not(.forge-anim) { display: none !important; }')
  expect(CSS).toContain('.forge-anim[hidden]')
  expect(CSS).toContain('@starting-style')
  expect(CSS).toContain('allow-discrete')
})
it('marks #status as forge-anim', () => {
  const o = new Overlay()
  expect(o.status.classList.contains('forge-anim')).toBe(true)
})
```

`tests/client/colorpicker.test.ts` / `tests/client/tokenpicker.test.ts` (one each, matching each file's construction idiom):

```ts
it('root carries forge-anim for animated show/hide', () => {
  expect(picker.root.classList.contains('forge-anim')).toBe(true)
})
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run tests/client/overlay.test.ts tests/client/colorpicker.test.ts tests/client/tokenpicker.test.ts`
Expected: FAIL — CSS lacks the `:not(.forge-anim)` exemption; roots lack the class.

- [ ] **Step 3: Implement**

`src/client/overlay.ts` — change the FIRST line of the CSS string. Why this shape (JS comment above the string): the generic `[hidden] { display: none !important }` wins over any non-important rule regardless of specificity, and a transition's intermediate values also lose to `!important` — so an element that wants an exit transition must be EXEMPTED from the important rule and given its own non-important `display: none`:

```
[hidden]:not(.forge-anim) { display: none !important; }
```

Append to the end of the CSS string (after Task 1's motion block, before the reduced-motion block is fine too — order among these is not load-bearing):

```ts
` +
// Animated show/hide for hidden-toggled popovers/chrome (.forge-anim opt-in — see the
// [hidden] exemption at the top of this string). Entry: spring scale-in via
// @starting-style (fires on unhide AND on fresh insertion, which is how .menu-popover —
// created per open, removed on close — gets entry-only motion without the class).
// Exit: ~100ms plain fade; `display` rides the transition discretely (allow-discrete)
// so none lands only after the fade. Non-supporting browsers snap (today's behavior).
// The [hidden] rule carries the exit transition (destination-state timing wins).
`.forge-anim, .menu-popover {
  transition: opacity var(--dur-pop) var(--ease-spring), transform var(--dur-pop) var(--ease-spring), display var(--dur-pop) allow-discrete;
  transform-origin: top center;
}
.forge-anim[hidden] {
  display: none; opacity: 0; transform: scale(0.98);
  transition: opacity 100ms var(--ease-out), transform 100ms var(--ease-out), display 100ms allow-discrete;
}
@starting-style {
  .forge-anim, .menu-popover { opacity: 0; transform: scale(0.96); }
}
`
```

Add the marker class at each construction site:

- `src/client/overlay.ts` constructor (~line 747, after `this.status.id = 'status'`): `this.status.classList.add('forge-anim')`
- `src/client/colorpicker.ts` (~line 133): `this.root.className = 'color-popover forge-anim'`
- `src/client/tokenpicker.ts`: extend its root's className the same way (`'token-popover forge-anim'`)
- `src/client/canvas-chrome.ts` (~line 19): `wrap.className = 'zoom-pill-wrap forge-anim'`

Note: `.zoom-pill-wrap`'s `transform-origin: top center` is harmless (it's opacity+scale around its own box); the pill sits bottom-left so `bottom center` would be marginally truer — set `transform-origin: bottom left` via an extra rule ONLY if the real-browser pass (Task 10) finds the scale direction reads wrong. YAGNI until seen.

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run tests/client/overlay.test.ts tests/client/colorpicker.test.ts tests/client/tokenpicker.test.ts tests/client/design-mode.test.ts`
Expected: PASS (design-mode rides along — it exercises show/hide paths against the `[hidden]` behavior; jsdom ignores the CSS so `hidden` semantics in tests are unchanged).

- [ ] **Step 5: Commit**

```bash
git add packages/the-forge/src/client/overlay.ts packages/the-forge/src/client/colorpicker.ts packages/the-forge/src/client/tokenpicker.ts packages/the-forge/src/client/canvas-chrome.ts packages/the-forge/tests/client/overlay.test.ts packages/the-forge/tests/client/colorpicker.test.ts packages/the-forge/tests/client/tokenpicker.test.ts
git commit -m "feat(client): popovers and status spring in via @starting-style, fade out via allow-discrete"
```

---

### Task 3: Draft disclosure expands (grid-rows)

**Files:**
- Modify: `packages/the-forge/src/client/overlay.ts` (`.draft-disclosure` rules ~line 670)
- Test: `packages/the-forge/tests/client/overlay.test.ts`

**Interfaces:**
- Consumes: `--dur-pop/--ease-spring` vars. The `.open` class toggle (`session-feed.ts` `setDisclosureOpen`) is unchanged — this is CSS-only.
- Produces: nothing later tasks use.

- [ ] **Step 1: Write the failing test**

`tests/client/overlay.test.ts`:

```ts
it('draft disclosure animates open via grid-template-rows, not display:none', () => {
  expect(CSS).toContain('.draft-disclosure { display: grid; grid-template-rows: 0fr;')
  expect(CSS).toContain('.draft-disclosure.open { grid-template-rows: 1fr;')
  expect(CSS).not.toContain('.draft-disclosure { display: none; }')
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/client/overlay.test.ts`
Expected: FAIL — the old `display: none` rules still present.

- [ ] **Step 3: Implement**

In `src/client/overlay.ts`, replace:

```
.draft-disclosure { display: none; }
.draft-disclosure.open { display: block; }
```

with (extend the existing draft-pill JS comment block above the string with the why):

```
.draft-disclosure { display: grid; grid-template-rows: 0fr; visibility: hidden; transition: grid-template-rows var(--dur-pop) var(--ease-spring), visibility var(--dur-pop); }
.draft-disclosure > .draft-slot { min-height: 0; overflow: hidden; }
.draft-disclosure.open { grid-template-rows: 1fr; visibility: visible; }
```

JS-comment annotation to add: the grid-rows 0fr⇄1fr trick is the only way to transition an auto-height reveal in pure CSS; `.draft-slot` (already the disclosure's single child) is the required `min-height: 0; overflow: hidden` inner wrapper; `visibility` rides the transition so the collapsed ChangeList (which holds focusable buttons) is untabbable when closed but stays visible during the collapse itself; the fr interpolation may overshoot past 1fr under the spring — that's the springy expand, and 2% over is invisible slack, not a layout break.

First grep for hidden couplings: `grep -rn "draft-disclosure" packages/the-forge/tests packages/the-forge/src` — expected: class toggles and `.open` assertions only; no test asserts computed `display`. If one does, update it to assert the class instead.

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run tests/client/overlay.test.ts tests/client/session-feed.test.ts tests/client/design-mode.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/the-forge/src/client/overlay.ts packages/the-forge/tests/client/overlay.test.ts
git commit -m "feat(client): draft disclosure springs open via grid-template-rows"
```

---

### Task 4: Send button press feedback + morph pop

**Files:**
- Modify: `packages/the-forge/src/client/session-feed.ts` (`updateSendMorph` ~line 480; import)
- Modify: `packages/the-forge/src/client/overlay.ts` (`.composer-send` block ~line 686)
- Test: `packages/the-forge/tests/client/session-feed.test.ts`

**Interfaces:**
- Consumes: `popOnce(el, className?)` from Task 1; `--dur-fast/--ease-spring` vars.
- Produces: nothing later tasks use.

- [ ] **Step 1: Write the failing tests**

`tests/client/session-feed.test.ts` (match the file's existing SessionFeed construction idiom; `setBusyish` is the public busy toggle — if the suite drives busy state differently, e.g. via stream events, use that suite's existing idiom):

```ts
it('send↔stop morph pops the glyph exactly on flips, not on every keystroke', () => {
  const feed = new SessionFeed()
  document.body.appendChild(feed.root)
  const btn = feed.root.querySelector('.composer-send') as HTMLElement
  expect(btn.classList.contains('pop')).toBe(false) // initial render: no flip, no pop
  feed.setBusyish(true) // ↑ → ■
  expect(btn.classList.contains('pop')).toBe(true)
  btn.classList.remove('pop') // simulate the animation having finished
  const ta = feed.root.querySelector('.chat-textarea') as HTMLTextAreaElement
  ta.value = 'x'
  ta.dispatchEvent(new Event('input')) // ■ → ↑ (typing mid-turn)
  expect(btn.classList.contains('pop')).toBe(true)
  btn.classList.remove('pop')
  ta.value = 'xy'
  ta.dispatchEvent(new Event('input')) // still ↑ — no flip, no pop
  expect(btn.classList.contains('pop')).toBe(false)
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/client/session-feed.test.ts`
Expected: FAIL — `.pop` never appears.

- [ ] **Step 3: Implement**

`src/client/session-feed.ts` — add to the imports: `import { popOnce } from './motion'`. Replace `updateSendMorph` (keep its doc comment, append the pop note):

```ts
  /** Recomputes composer-send's morph — ■ (interrupt) while a turn is in flight (busyish) AND
   * the textarea is empty; otherwise ↑ (send). Called on every busyish transition (setBusyish)
   * and on every textarea keystroke (typing mid-turn flips it back to ↑ immediately).
   * The glyph pop (popOnce) fires only when the morph actually FLIPS — this method runs per
   * keystroke, so popping unconditionally would pulse the button while typing. */
  private updateSendMorph(): void {
    const wasStop = this.sendIsStop
    this.sendIsStop = this.busyish && this.textarea.value.trim() === ''
    this.sendBtn.textContent = this.sendIsStop ? '■' : '↑'
    this.sendBtn.setAttribute('aria-label', this.sendIsStop ? 'Stop' : 'Send')
    if (wasStop !== this.sendIsStop) popOnce(this.sendBtn)
  }
```

Note: the constructor's initial `updateSendMorph()` call computes `false !== false` — no pop on mount, which the test pins.

`src/client/overlay.ts` — extend the `.composer-send` block (JS comment: press-down + spring return is the highest-touch button's micro-feedback; `.pop` is popOnce's re-triggerable one-shot for the glyph morph):

```
.composer-send { transition: transform var(--dur-fast) var(--ease-spring), background 120ms; }
.composer-send:active { transform: scale(0.92); }
.composer-send.pop { animation: forge-pop var(--dur-fast) var(--ease-spring); }
```

(Add these as three new lines inside/after the existing `.composer-send` rules — the existing declarations are untouched.)

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run tests/client/session-feed.test.ts tests/client/composer-send.test.ts tests/client/design-mode.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/the-forge/src/client/session-feed.ts packages/the-forge/src/client/overlay.ts packages/the-forge/tests/client/session-feed.test.ts
git commit -m "feat(client): send button press feedback and morph glyph pop"
```

---

### Task 5: Changes-list stage-change pop/shake + dismiss collapse

**Files:**
- Modify: `packages/the-forge/src/client/changelist.ts` (render ~line 108, renderSeedRecord ~line 182, failedActions ~line 213)
- Modify: `packages/the-forge/src/client/overlay.ts` (after the `.chip-*` rules ~line 539)
- Test: `packages/the-forge/tests/client/changelist.test.ts`

**Interfaces:**
- Consumes: `collapseRow(row, onDone)` from Task 1; keyframes `forge-pop`/`forge-shake`.
- Produces: nothing later tasks use.

- [ ] **Step 1: Write the failing tests**

`tests/client/changelist.test.ts` (reuse the suite's existing helpers for building a ChangeList with registered sent seeds and driving `applyStage`; the shapes below show intent — adapt construction to the file's idiom):

```ts
it('marks a row .stage-flip only on a real stage change, not on unrelated re-renders', () => {
  // register a seed → first render: no .stage-flip (arrival isn't a change)
  list.addSent('id-1', [seed])
  expect(list.root.querySelector('.stage-flip')).toBeNull()
  // applying → done: THIS render carries .stage-flip on that row
  list.applyStage({ id: 'id-1', stage: 'done' } as StageEvent)
  expect(list.root.querySelector('.change-row.stage-flip')).not.toBeNull()
  // an unrelated re-render (a draft sync) must NOT replay the flip
  list.syncDrafts()
  expect(list.root.querySelector('.stage-flip')).toBeNull()
})

it('dismiss collapses the row before removing the seed (timeout path)', () => {
  vi.useFakeTimers()
  // drive a seed to failed so the Dismiss button renders
  const dismiss = list.root.querySelector('.change-dismiss') as HTMLElement
  dismiss.click()
  // removal is deferred behind the collapse — seed still present immediately
  expect(session.records().length).toBe(1)
  vi.advanceTimersByTime(300)
  expect(session.records().length).toBe(0)
  vi.useRealTimers()
})

it('dismiss removes immediately under reduced motion', () => {
  vi.spyOn(window, 'matchMedia').mockReturnValue({ matches: true } as MediaQueryList)
  const dismiss = list.root.querySelector('.change-dismiss') as HTMLElement
  dismiss.click()
  expect(session.records().length).toBe(0)
})
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run tests/client/changelist.test.ts`
Expected: FAIL — no `.stage-flip`; dismiss removes synchronously in the timeout test.

- [ ] **Step 3: Implement**

`src/client/changelist.ts` — imports: `import { collapseRow } from './motion'`. Add a field next to `suppressSeedRecords`:

```ts
  /** Stage seen at the previous render, keyed by seed identity — render() rebuilds every
   * row via replaceChildren(), so CSS transitions can never fire across a stage change and
   * a bare entry animation would replay on EVERY re-render (each scrub tick rebuilds the
   * list). .stage-flip therefore lands only on the one render where a row's stage actually
   * differs from what this map last saw — the pop/shake plays once, then the next render
   * (whatever triggers it) rebuilds the row without the class. */
  private lastStages = new WeakMap<object, LifecycleStage>()
```

In `renderSeedRecord` (~line 182), after `const dom = this.baseRow(row.stage, row.seed.el)`:

```ts
    const prev = this.lastStages.get(row.seed)
    if (prev !== undefined && prev !== row.stage) dom.classList.add('stage-flip')
    this.lastStages.set(row.seed, row.stage)
```

In `failedActions` (~line 229), replace the dismiss click handler body:

```ts
    dismiss.addEventListener('click', (e) => {
      e.stopPropagation()
      // Collapse first, mutate after — the removeSeed() re-render discards this element,
      // so animating post-removal is impossible. A re-render landing mid-collapse discards
      // the animating row early; collapseRow's timeout still fires onDone, so the seed is
      // removed either way (removal is the invariant, the collapse is garnish).
      const rowEl = (e.currentTarget as HTMLElement).closest('.change-row') as HTMLElement | null
      if (rowEl) collapseRow(rowEl, () => this.session.removeSeed(row.seed))
      else this.session.removeSeed(row.seed)
    })
```

`src/client/overlay.ts` — add after the `.chip-failed` rule (JS comment: the pop marks arrival at done — a small springy dot scale-in; the shake is the ONE stronger gesture in the system, semantically earned by failure; both keyed to `.stage-flip` so they play once per real transition, see changelist.ts lastStages):

```
.stage-flip .chip-done::before { animation: forge-pop var(--dur-pop) var(--ease-spring); }
.stage-flip .chip-failed { animation: forge-shake 250ms var(--ease-out); }
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run tests/client/changelist.test.ts tests/client/design-mode.test.ts tests/client/overlay.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/the-forge/src/client/changelist.ts packages/the-forge/src/client/overlay.ts packages/the-forge/tests/client/changelist.test.ts
git commit -m "feat(client): changes-list done pop, failed shake, dismiss collapse — gated on real stage flips"
```

---

### Task 6: Chat rows + approval card entrances (CSS-only)

**Files:**
- Modify: `packages/the-forge/src/client/overlay.ts` (`.session-row` block ~line 582, `.session-approval` ~line 590)
- Test: `packages/the-forge/tests/client/overlay.test.ts`

**Interfaces:**
- Consumes: keyframes `forge-rise-in`; `--dur-pop/--dur-panel/--ease-out/--ease-spring` vars.
- Produces: nothing later tasks use.

- [ ] **Step 1: Write the failing test**

`tests/client/overlay.test.ts`:

```ts
it('session rows rise in; the approval card gets the springier entrance', () => {
  expect(CSS).toContain('.session-row { animation: forge-rise-in var(--dur-pop) var(--ease-out); }')
  expect(CSS).toContain('.session-approval') // existing rule intact
  expect(CSS).toContain('animation: forge-rise-in var(--dur-panel) var(--ease-spring);')
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/client/overlay.test.ts`
Expected: FAIL.

- [ ] **Step 3: Implement**

`src/client/overlay.ts` — add one declaration line after the existing `.session-row` rule and one inside a new `.session-approval`-scoped rule (JS comment: content enters as fade+rise, deliberately NOT springy — the research line "springs for interactive elements, plain rise for content"; the approval card is the exception because it's requesting a decision; animation-on-insertion means streaming delta mutations on an existing bubble never re-trigger, and a reconnect replay burst animates once in unison — acceptable):

```
.session-row { animation: forge-rise-in var(--dur-pop) var(--ease-out); }
.session-approval:not(.session-approval-resolved) { animation: forge-rise-in var(--dur-panel) var(--ease-spring); }
```

Caveat encoded in the second selector: resolving an approval adds `.session-approval-resolved` to the SAME element (`session-feed.ts` ~line 900) — without the `:not()`, the class change would restart the rise animation on resolve (changing which animation rules apply re-triggers them). The `:not()` swap on resolve changes the applying animation to none, which merely stops it.

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/client/overlay.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/the-forge/src/client/overlay.ts packages/the-forge/tests/client/overlay.test.ts
git commit -m "feat(client): chat rows rise in; approval card gets the spring entrance"
```

---

### Task 7: Selection-outline tween

**Files:**
- Modify: `packages/the-forge/src/client/overlay.ts` (`showSelectOutline` ~line 817, `#select-outline` CSS ~line 92)
- Modify: `packages/the-forge/src/client/index.ts` (`setSelection` ~line 831)
- Test: `packages/the-forge/tests/client/overlay.test.ts`, `packages/the-forge/tests/client/design-mode.test.ts`

**Interfaces:**
- Consumes: `DUR_FAST_MS`, `prefersReducedMotion` from Task 1.
- Produces: `Overlay.showSelectOutline(rect: DOMRect, tween?: boolean)` — second param defaults `false`; every existing caller stays valid. `index.ts`'s `remeasure()` deliberately keeps the default (reflow tracking snaps).

- [ ] **Step 1: Write the failing tests**

`tests/client/overlay.test.ts`:

```ts
it('tween arms only on a visible→visible move, never on first show, and self-disarms', () => {
  vi.useFakeTimers()
  const o = new Overlay()
  const rect = (x: number) => ({ left: x, top: 10, width: 50, height: 20 }) as DOMRect
  o.showSelectOutline(rect(0), true) // first show: outline was hidden — no tween
  const outline = o.host.shadowRoot!.querySelector('#select-outline') as HTMLElement
  expect(outline.classList.contains('tween')).toBe(false)
  o.showSelectOutline(rect(100), true) // move while visible: tween
  expect(outline.classList.contains('tween')).toBe(true)
  vi.advanceTimersByTime(DUR_FAST_MS + 100) // self-disarm
  expect(outline.classList.contains('tween')).toBe(false)
  o.showSelectOutline(rect(100), true)
  expect(outline.classList.contains('tween')).toBe(true)
  o.showSelectOutline(rect(120)) // reflow-tracking call (default): snaps, kills the tween
  expect(outline.classList.contains('tween')).toBe(false)
  vi.useRealTimers()
})

it('tween never arms under reduced motion', () => {
  vi.spyOn(window, 'matchMedia').mockReturnValue({ matches: true } as MediaQueryList)
  const o = new Overlay()
  const rect = { left: 0, top: 0, width: 10, height: 10 } as DOMRect
  o.showSelectOutline(rect, true)
  o.showSelectOutline(rect, true)
  const outline = o.host.shadowRoot!.querySelector('#select-outline') as HTMLElement
  expect(outline.classList.contains('tween')).toBe(false)
})
```

`tests/client/design-mode.test.ts` — one integration pin (adapt to the suite's select-an-element idiom): select element A, then element B; assert the `#select-outline` inside the overlay shadow root has (or had) `.tween` after the second selection. If timing makes the class hard to observe, spy on `overlay.showSelectOutline` and assert the second call passed `true` and the first passed a falsy tween.

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run tests/client/overlay.test.ts tests/client/design-mode.test.ts`
Expected: FAIL — `showSelectOutline` takes one argument; no `.tween` ever.

- [ ] **Step 3: Implement**

`src/client/overlay.ts` — import `DUR_FAST_MS, prefersReducedMotion` from `./motion`. Add a field near `rippleClearTimer`:

```ts
  private outlineTweenTimer: ReturnType<typeof setTimeout> | null = null
```

Replace `showSelectOutline`:

```ts
  /** tween=true animates the outline from its current rect to the new one (Figma-style
   * selection hop — deliberately ease-out, not spring: a springy rect reads as wobble).
   * Callers that TRACK an element (remeasure on scroll/resize/edit-reflow) keep the
   * default snap — the tween is only for the selection CHANGING, and any tracking call
   * landing mid-tween disarms it (direct manipulation wins). First show from hidden
   * never tweens (it would fly in from a stale rect); it fades in via @starting-style. */
  showSelectOutline(rect: DOMRect, tween = false): void {
    const el = this.selectOutline
    if (this.outlineTweenTimer) clearTimeout(this.outlineTweenTimer)
    this.outlineTweenTimer = null
    if (tween && !el.hidden && !prefersReducedMotion()) {
      el.classList.add('tween')
      this.outlineTweenTimer = setTimeout(() => {
        this.outlineTweenTimer = null
        el.classList.remove('tween')
      }, DUR_FAST_MS + 50)
    } else {
      el.classList.remove('tween')
    }
    this.place(el, rect)
  }
```

`#select-outline` CSS (~line 92) — add after the existing rule (JS comment: left/top/width/height on ONE fixed-position element is cheap paint, no layout cascade):

```
#select-outline { transition: opacity 80ms var(--ease-out); }
#select-outline.tween { transition: left var(--dur-fast) var(--ease-out), top var(--dur-fast) var(--ease-out), width var(--dur-fast) var(--ease-out), height var(--dur-fast) var(--ease-out); }
@starting-style { #select-outline { opacity: 0; } }
```

(Wide-selector note: `#select-outline` is NOT `.forge-anim` — entry fade only, exit snap; the `@starting-style` block here is separate from Task 2's.)

`src/client/index.ts` — in `setSelection` (~line 831), capture the prior shape before the assignment and pass it in the single-selection branch:

```ts
  private setSelection(next: TaggedElement[]): void {
    // Unlike the old floating prompt popup, the chat chip is deliberately NOT cleared on selection
    // change (task-6 contract: only Send and the chip's own × clear it) — a chip stays
    // attached to whatever element the user chose it for even as they browse other elements.
    // wasSingle: read BEFORE the assignment — a single→single hop is the one case the
    // outline tweens (multi-select and first-selection always snap; overlay.ts also
    // refuses a tween from hidden, so single-after-deselect stays a fade-in).
    const wasSingle = this.selection.length === 1
    this.selection = next
    this.clearRippleState()
    if (next.length === 0) {
      this.overlay.hideSelectOutline()
      this.overlay.hideSelectOutlines()
      this.panel.hide()
    } else if (next.length === 1) {
      this.overlay.hideSelectOutlines()
      this.overlay.showSelectOutline(next[0].getBoundingClientRect(), wasSingle)
      this.panel.show(next[0], buildInspectorData(next[0]))
    } else {
      this.overlay.hideSelectOutline()
      this.overlay.showSelectOutlines(next.map((el) => el.getBoundingClientRect()))
      this.panel.show(next, buildInspectorData(next[0]))
    }
    this.persist()
  }
```

`remeasure()` (~line 861) is deliberately untouched — its default-`false` calls both snap and disarm.

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run tests/client/overlay.test.ts tests/client/design-mode.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/the-forge/src/client/overlay.ts packages/the-forge/src/client/index.ts packages/the-forge/tests/client/overlay.test.ts packages/the-forge/tests/client/design-mode.test.ts
git commit -m "feat(client): selection outline tweens between elements, snaps while tracking"
```

---

### Task 8: Panel entrance + dock margin push

**Files:**
- Modify: `packages/the-forge/src/client/overlay.ts` (`#panel` CSS ~line 105)
- Modify: `packages/the-forge/src/client/dock.ts` (applyDocked ~line 160, removeDocked ~line 174, onResizeStart ~line 197)
- Test: `packages/the-forge/tests/client/dock.test.ts`, `packages/the-forge/tests/client/overlay.test.ts`

**Interfaces:**
- Consumes: `DUR_PANEL_MS`, `EASE_OUT`, `prefersReducedMotion` from Task 1.
- Produces: nothing later tasks use.

- [ ] **Step 1: Write the failing tests**

`tests/client/overlay.test.ts`:

```ts
it('panel rises in on show', () => {
  expect(CSS).toContain('@starting-style { #panel { opacity: 0; transform: translateY(6px); } }')
})
```

`tests/client/dock.test.ts` (reuse the suite's existing Dock construction helper):

```ts
it('dock/undock animates the html margin push and cleans the transition up', () => {
  vi.useFakeTimers()
  dock.enter() // docked mode → applyDocked
  expect(document.documentElement.style.transition).toContain('margin-right')
  vi.advanceTimersByTime(DUR_PANEL_MS + 100)
  expect(document.documentElement.style.transition).toBe('')
  vi.useRealTimers()
})

it('margin push transition restores a pre-existing inline transition verbatim', () => {
  vi.useFakeTimers()
  document.documentElement.style.transition = 'color 1s'
  dock.enter()
  vi.advanceTimersByTime(DUR_PANEL_MS + 100)
  expect(document.documentElement.style.transition).toBe('color 1s')
  document.documentElement.style.transition = ''
  vi.useRealTimers()
})

it('width drag kills an in-flight margin transition immediately', () => {
  vi.useFakeTimers()
  dock.enter()
  expect(document.documentElement.style.transition).toContain('margin-right')
  // jsdom has no PointerEvent constructor — dispatch the way the suite's existing
  // resize-drag tests already do (MouseEvent with type 'pointerdown' carries button/clientX
  // fine, since onResizeStart only reads those two fields).
  panel.resizeHandle.dispatchEvent(new MouseEvent('pointerdown', { button: 0, clientX: 100 }))
  expect(document.documentElement.style.transition).toBe('')
  vi.useRealTimers()
})

it('no margin transition under reduced motion', () => {
  vi.spyOn(window, 'matchMedia').mockReturnValue({ matches: true } as MediaQueryList)
  dock.enter()
  expect(document.documentElement.style.transition).toBe('')
})
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run tests/client/dock.test.ts tests/client/overlay.test.ts`
Expected: FAIL — no transition ever set; no `@starting-style { #panel …`.

- [ ] **Step 3: Implement**

`src/client/overlay.ts` — after the `#panel` rule (~line 113), add (JS comment: entry-only — panel.hide() stays a snap; #panel is NOT .forge-anim because dock↔float toggles must not fade the panel, only genuine hidden→shown fires @starting-style):

```
#panel { transition: opacity var(--dur-panel) var(--ease-out), transform var(--dur-panel) var(--ease-out); }
@starting-style { #panel { opacity: 0; transform: translateY(6px); } }
```

`src/client/dock.ts` — import at top: `import { DUR_PANEL_MS, EASE_OUT, prefersReducedMotion } from './motion'`. Add a field + two methods:

```ts
  /** Undoes an in-flight margin-push transition (restoring any pre-existing inline
   * transition verbatim — same restore discipline as savedHtmlMarginRight). Set only
   * between armMarginTransition() and its transitionend/timeout. */
  private marginTransitionCleanup: (() => void) | null = null

  /** Animates the NEXT html margin-right write (dock/undock/design-mode-enter — the
   * discrete toggles only; width-drag syncWidth writes stay instant and onResizeStart
   * force-clears any in-flight arm, so a drag never fights a tween). Page context can't
   * see the shadow root's --dur/--ease tokens, hence the imported literals. */
  private armMarginTransition(): void {
    if (prefersReducedMotion()) return
    this.marginTransitionCleanup?.()
    const html = document.documentElement
    const prev = html.style.transition
    let timer: ReturnType<typeof setTimeout> | null = null
    const cleanup = (): void => {
      html.style.transition = prev
      html.removeEventListener('transitionend', onEnd)
      if (timer) clearTimeout(timer)
      this.marginTransitionCleanup = null
    }
    const onEnd = (e: TransitionEvent): void => {
      if (e.propertyName === 'margin-right') cleanup()
    }
    html.style.transition = prev
      ? `${prev}, margin-right ${DUR_PANEL_MS}ms ${EASE_OUT}`
      : `margin-right ${DUR_PANEL_MS}ms ${EASE_OUT}`
    html.addEventListener('transitionend', onEnd)
    timer = setTimeout(cleanup, DUR_PANEL_MS + 80)
    this.marginTransitionCleanup = cleanup
  }
```

Call `this.armMarginTransition()` as the FIRST line of `applyDocked()` and of `removeDocked()` (before `if (!this.dockedApplied) return` in removeDocked? No — after the guard, so a floating-mode exit doesn't arm a pointless transition):

```ts
  private applyDocked(): void {
    this.armMarginTransition()
    this.dockedApplied = true
    ...
```

```ts
  private removeDocked(): void {
    if (!this.dockedApplied) return
    this.armMarginTransition()
    this.dockedApplied = false
    ...
```

In `onResizeStart` (~line 197), after the `e.button !== 0` guard: `this.marginTransitionCleanup?.()` (a width drag must write margins instantly from its very first move).

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run tests/client/dock.test.ts tests/client/overlay.test.ts tests/client/design-mode.test.ts`
Expected: PASS. (jsdom fires no transitionend — the tests exercise the timeout path; the `transitionend` listener is exercised in Task 10's real browser.)

- [ ] **Step 5: Commit**

```bash
git add packages/the-forge/src/client/dock.ts packages/the-forge/src/client/overlay.ts packages/the-forge/tests/client/dock.test.ts packages/the-forge/tests/client/overlay.test.ts
git commit -m "feat(client): panel rises in; dock margin push animates on discrete toggles only"
```

---

### Task 9: Canvas discrete-zoom tween

**Files:**
- Modify: `packages/the-forge/src/client/canvas.ts` (setZoomCentered ~line 210, zoomToFit ~line 224, zoomToSelection ~line 235, onWheel ~line 366, onGestureChange ~line 401, onPointerDown's onMove ~line 468, unapply ~line 286)
- Test: `packages/the-forge/tests/client/canvas.test.ts`

**Interfaces:**
- Consumes: `DUR_PANEL_MS`, `EASE_OUT`, `prefersReducedMotion` from Task 1.
- Produces: nothing later tasks use.

- [ ] **Step 1: Write the failing tests**

`tests/client/canvas.test.ts` (reuse the suite's existing CanvasMode construction + `setOn(true)` idiom):

```ts
it('discrete zooms tween the body transform; continuous gestures never do', () => {
  vi.useFakeTimers()
  canvas.setOn(true)
  expect(document.body.style.transition).toBe('') // enter is seamless — no tween
  canvas.zoomToFit()
  expect(document.body.style.transition).toContain('transform')
  vi.advanceTimersByTime(DUR_PANEL_MS + 100)
  expect(document.body.style.transition).toBe('')
  canvas.setZoomCentered(2)
  expect(document.body.style.transition).toContain('transform')
  // a wheel tick mid-tween must clear it — direct manipulation wins
  window.dispatchEvent(new WheelEvent('wheel', { deltaY: 10, cancelable: true }))
  expect(document.body.style.transition).toBe('')
  vi.useRealTimers()
})

it('unapply never leaves a transition behind', () => {
  vi.useFakeTimers()
  canvas.setOn(true)
  canvas.zoomToFit()
  canvas.setOn(false)
  expect(document.body.style.transition).toBe('')
  vi.useRealTimers()
})

it('no zoom tween under reduced motion', () => {
  vi.spyOn(window, 'matchMedia').mockReturnValue({ matches: true } as MediaQueryList)
  canvas.setOn(true)
  canvas.zoomToFit()
  expect(document.body.style.transition).toBe('')
  canvas.setOn(false)
})
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run tests/client/canvas.test.ts`
Expected: FAIL — transition never set.

- [ ] **Step 3: Implement**

`src/client/canvas.ts` — import at top: `import { DUR_PANEL_MS, EASE_OUT, prefersReducedMotion } from './motion'`. Add near `wheelPersistTimer`:

```ts
  /** Undoes an in-flight discrete-zoom tween (restores body's prior inline transition
   * verbatim). Non-null only while a tween is live — the continuous-gesture paths call it
   * unconditionally per tick, so the null-check must stay the cheap common case. */
  private zoomTweenCleanup: (() => void) | null = null

  /** Arms a transform tween for the NEXT setState write — the discrete zooms only
   * (fit/ladder/percent-menu/Shift+0-1-2). Enter/exit stay seamless by construction (the
   * seed transform matches the live scroll), and wheel/pinch/drag must never be damped:
   * every continuous path clears this before writing. Page context can't read the shadow
   * root's tokens — hence imported literals (motion.ts is the shared source). EASE_OUT,
   * not the spring: an overshooting zoom re-rasterizes the artboard past its target and
   * reads as focus hunting, not springiness. */
  private armZoomTween(): void {
    if (prefersReducedMotion() || this.saved === null) return
    this.zoomTweenCleanup?.()
    const body = document.body
    const prev = body.style.transition
    let timer: ReturnType<typeof setTimeout> | null = null
    const cleanup = (): void => {
      body.style.transition = prev
      body.removeEventListener('transitionend', onEnd)
      if (timer) clearTimeout(timer)
      this.zoomTweenCleanup = null
    }
    const onEnd = (e: TransitionEvent): void => {
      if (e.propertyName === 'transform') cleanup()
    }
    body.style.transition = prev
      ? `${prev}, transform ${DUR_PANEL_MS}ms ${EASE_OUT}`
      : `transform ${DUR_PANEL_MS}ms ${EASE_OUT}`
    body.addEventListener('transitionend', onEnd)
    timer = setTimeout(cleanup, DUR_PANEL_MS + 80)
    this.zoomTweenCleanup = cleanup
  }
```

Arm it as the first line of the three discrete zooms (`zoomStep` rides `setZoomCentered`):

- `setZoomCentered(scale)`: `this.armZoomTween()` before `this.setState(...)`
- `zoomToFit()`: same
- `zoomToSelection()`: after the `if (!r || …) return` guard, before the mapping math

Clear it in every continuous path and on teardown:

- `onWheel`: after `e.preventDefault()`: `this.zoomTweenCleanup?.()`
- `onGestureChange`: after `e.preventDefault()`: `this.zoomTweenCleanup?.()`
- `onPointerDown`'s inner `onMove`: first line: `this.zoomTweenCleanup?.()`
- `removeListeners()`: alongside the wheelPersistTimer flush: `this.zoomTweenCleanup?.()` (unapply() calls removeListeners() first, so the body's transition is restored BEFORE the saved styles go back — no ordering hazard).

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run tests/client/canvas.test.ts tests/client/design-mode.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/the-forge/src/client/canvas.ts packages/the-forge/tests/client/canvas.test.ts
git commit -m "feat(client): canvas discrete zooms tween the artboard; continuous gestures stay raw"
```

---

### Task 10: Full gate, budget, real-browser verification

**Files:**
- No new source changes expected — fixes only if the gate or browser pass surfaces them.

**Interfaces:**
- Consumes: everything above.
- Produces: green root gate + visual proof.

- [ ] **Step 1: Root gate**

Run from the repo root: `npm test`
Expected: typecheck clean, full vitest suite green (~1990+ tests including the new ones). Then `./scripts/check-prod-clean.sh` — prod stays clean, package under 320KB, client budget test under 250KB.

- [ ] **Step 2: Build + demo app**

```bash
npm run build
lsof -iTCP:5173   # kill any stale server first (phantom-bug gotcha; often binds [::1]:5173)
npm run dev -w demo-app
```

- [ ] **Step 3: Real-browser pass** (Chrome; jsdom can't see any of this)

In the running demo (Design toggle bottom-right), verify each cluster and that NOTHING feels laggy — every animation ≤300ms, overshoot barely perceptible:

1. **Popovers**: open the color picker, token picker, a sizing menu, the zoom-pill menu — each springs in (slight scale-up); color/token pickers fade out quickly on close; menus close instantly (created-per-open, by design).
2. **Disclosure**: draft 2+ changes, click the drafts pill — the ChangeList expands springily; chevron still rotates; closing collapses then hides.
3. **Send button**: press-and-hold shows the scale-down; send with empty-textarea busy state — the ■ pops in; typing mid-turn pops ↑ back.
4. **Changes list**: send a draft, watch sent→applying→done — the done dot pops once and does NOT replay when you scrub a new draft afterward; force a failure (`mark_applied` with failed, or kill the dev server mid-send) — the row shakes once; Dismiss collapses the row.
5. **Chat**: each message/tool row rises in; the approval card's entrance is visibly springier; streaming deltas do NOT re-trigger.
6. **Selection outline**: click element A then element B — the outline glides between them (~120ms); scroll the page — the outline tracks instantly with zero lag; first selection after deselect fades in without flying.
7. **Panel + dock**: turn design mode on — page content slides left as the margin animates; select an element — panel rises in; toggle float↔dock — page slide animates, panel snap is acceptable (ratified deviation); drag the panel width — tracking is instant.
8. **Canvas**: toggle canvas mode — seamless (no jump); Shift+1 / Shift+0 / +/− / zoom menu — the artboard glides; wheel-pan and pinch-zoom mid-glide — raw and instant from the first tick.
9. **Ripple/status**: unchanged behavior (fade still works).
10. **Reduced motion**: DevTools → Rendering → emulate `prefers-reduced-motion: reduce` → repeat 1–8 spot-checks: everything snaps (≤1ms), dismiss removes instantly, no margin/zoom transitions arm.
11. Screenshot or screen-record the disclosure expand + outline glide as proof.

- [ ] **Step 4: Judgment checkpoints** (fix-or-drop decisions the browser pass owns)

- Storybook (spec's testing note): no new stories are REQUIRED — this plan adds no new ui/ factory controls, and the existing stories render the real components, which now inherit the motion CSS automatically. Open Storybook (`npm run storybook -w forge-mode`) during this pass and confirm the chip/send/popover stories still render; extend a story only if a motion state proves worth cataloguing.

- Zoom-pill scale-in direction (Task 2 note): if scaling from `top center` reads wrong for bottom-anchored chrome, add `.zoom-pill-wrap { transform-origin: bottom left; }`.
- Chat-row rise during reconnect replay bursts: if a full-history replay animating in unison reads as noise, scope the animation to `.session-list .session-row` created after first paint is NOT worth JS — instead drop to opacity-only (`forge-rise-in` → fade) for `.session-row` and keep the rise for `.chat-msg` only.
- `#panel` entrance vs dock: if the panel's `@starting-style` rise fights the docked layout (it shouldn't — transform doesn't affect the margin push), drop the translateY and keep the fade.

- [ ] **Step 5: Commit any fixes and stop**

Commit browser-pass fixes individually with `fix(client): …` messages. Merge decision belongs to the user (CLAUDE.md) — do not merge; report back with proof media, the three locked-in spec deviations, and the bundle delta.
