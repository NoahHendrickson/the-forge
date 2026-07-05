# panel-token-ui extraction (2026-07-05)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

Executes the extraction both PR #6 reviews requested and the PR deferred: move the
token-picker/pill cluster out of `panel.ts` (1498 lines) into a focused
`src/client/panel-token-ui.ts`. **Behavior-preserving refactor** — no user-visible change,
no new features. Branch `claude/panel-token-ui`, stacked on `claude/great-solomon-0c4e9f`
(PR #6, still open; main has not moved), merges after it.

**Goal:** one module owns everything token-affordance: the TokenPicker instance, the
scale-field open path, the pill `boundTokens` bookkeeping (with its B5/Compare rules), the
color-row token button, and the pure display helpers.

**Architecture:** a `PanelTokenUi` class holding the picker + bound-pill map, constructed
with the popover parent and a `getEl` accessor; the apply dances (onBeforeEdit → draft →
refresh → onEdited) STAY in Panel's closures (`commitPx` / `applyColor`), so the interface
back to Panel is one function, not a host object. `pillLabelFor` and `colorDisplay` become
exported free functions.

**Tech stack:** vanilla DOM + vitest/jsdom, unchanged.

## Global constraints (inherited, non-negotiable)

- Behavior-preserving: every existing test passes with only mechanical access-path updates
  (`(panel as …).tokenPicker` → `(panel as …).tokenUi.picker`); no assertion changes.
- Why-comments are load-bearing — the B5/Compare re-bind block, the alpha-guard comments in
  `colorDisplay`, the beforeOpen rationale, and the "local invariant" multi-gate comment move
  VERBATIM with their code (a shortened pointer comment may remain at a call site).
- Panel/overlay CSS class names are test hooks — untouched (this refactor moves TS only).
- Zero new runtime dependencies; zero idle overhead unchanged.
- Tests mirror `src/` — new `tests/client/panel-token-ui.test.ts` for the module's own units;
  `tests/client/panel.test.ts` remains the integration suite.

## File structure

| File | Responsibility after this plan |
| --- | --- |
| `src/client/panel-token-ui.ts` (new, ~170 lines) | `PanelTokenUi` class (picker instance, bound-pill map, scale-open path, color token button) + exported pure helpers `pillLabelFor`, `colorDisplay` |
| `src/client/panel.ts` (~1350 lines after) | orchestrator keeps selection/refresh/sections; token concerns delegated to `this.tokenUi` |
| `tests/client/panel-token-ui.test.ts` (new) | direct unit tests for the exported helpers + pill bookkeeping methods |
| `tests/client/panel.test.ts` | unchanged assertions; ~21 mechanical cast updates |
| `CLAUDE.md` | new module row in the src/client table |

---

### Task 1: Move the cluster into `panel-token-ui.ts`, rewire Panel

**Files:**
- Create: `packages/the-forge/src/client/panel-token-ui.ts`
- Modify: `packages/the-forge/src/client/panel.ts` (imports; constructor ~130-208; hide/show
  ~217-255; refresh loop ~336-390; gap block ~420-445, ~755-770; buildColorRow ~955-1010;
  selection-colors ~1173; delete `colorDisplay` ~909, `pillLabelFor` ~1326,
  `openScaleTokenPicker` ~1339; buildField onDetach/onTokenOpen ~1470-1476)
- Test: `packages/the-forge/tests/client/panel.test.ts` (mechanical cast updates only)

**Interfaces (Produces — Task 2 and Panel rely on these exact signatures):**

```ts
// panel-token-ui.ts
import type { TaggedElement } from './source'
import { NumberField, createTokenButton } from './controls'
import { TokenPicker, type ScaleEntry } from './tokenpicker'
import type { RowSpec } from './panel-specs'

/** Tailwind utility label for a picker entry applied to `spec` (e.g. `px-4`, `rounded-md`, `text-sm`). */
export function pillLabelFor(spec: RowSpec, entry: ScaleEntry): string

/** One-parse, one-palette-scan reader for a color value's display state. */
export function colorDisplay(css: string): { text: string; token: boolean }

export class PanelTokenUi {
  /** The shared popover. Exposed so Panel can wire cross-popover exclusion
   * (picker.beforeOpen) and lifecycle (close/destroy) without this module knowing
   * ColorPicker exists. */
  readonly picker: TokenPicker

  constructor(popoverParent: HTMLElement, getEl: () => TaggedElement | null)

  /** Scale fields (gap + buildField): entries lookup, open, pill bind, bookkeeping — once. */
  openScalePicker(spec: RowSpec, field: NumberField, commitPx: (px: number) => void): void

  /** Color rows: the `{ }` button wired to the color-token dropdown. `applyColor` is
   * Panel's own apply dance (onBeforeEdit → onPick → refresh → onEdited). */
  colorTokenButton(row: HTMLElement, applyColor: (css: string) => void): HTMLButtonElement

  /** Drop one field's pill bookkeeping (Backspace detach, auto-display supersedes pill). */
  drop(spec: { props: string[] }): void
  /** Drop everything (selection change, drafts reset). */
  clear(): void
  /** B5 re-bind after field.set(): bind the pill back when the just-read value still equals
   * the bound px; a real divergence drops the entry; Compare mode does neither. */
  rebind(spec: { props: string[] }, field: NumberField, value: number | null, mixed: boolean, comparing: boolean): void
}
```

**Move rules (verbatim-move checklist):**

- `pillLabelFor` — body + its radius-rows doc comment move unchanged; becomes a free function
  (it reads only `spec`/`entry`).
- `colorDisplay` — body + BOTH alpha-guard why-comments + the one-parse-per-tick doc comment
  move unchanged; free function.
- `openScaleTokenPicker` → `openScalePicker` method: same body (`getEl()` replaces `this.el`
  check; `this.bound` replaces `this.boundTokens`; `pillLabelFor(...)` loses `this.`). Its
  gap/buildField-dedupe doc comment moves with it.
- The color-row token-button block in `buildColorRow` (createTokenButton + entries lookup +
  `tokenPicker.open` + typed `entry.color` apply) becomes `colorTokenButton`; the
  onBeforeEdit/refresh/onEdited dance stays in Panel's `applyColor` closure. The
  "exact token value ⇒ request.ts emits bg-neutral-900" comment moves with the open call.
  The `!this.isMulti() && colorTokenEntries(readTokens()) !== null` GATE and its
  "local invariant" why-comment STAY in Panel (Panel owns multi-ness).
- `rebind` absorbs the B5/Compare comment block from the refresh loop verbatim as its doc
  comment; the call site keeps one line: `// B5 re-bind contract — see PanelTokenUi.rebind`.
  Generic loop call: `this.tokenUi.rebind(spec, field, values[0], mixed, this.drafts.isComparing(el))`
  (guard `if (multi) continue` above it is untouched). Gap call:
  `this.tokenUi.rebind(GAP_SPEC, this.gapField, value, false, this.drafts.isComparing(el))` —
  replaces the hand-rolled gap variant (same semantics, mixed always false for the single
  gap value; its "Same B5 re-bind contract" comment collapses into the pointer line).
- `boundTokens.delete(...)` sites → `this.tokenUi.drop(spec)` (sizeMode-auto ×2,
  allowAuto ×1, gap-auto ×1 — keep the setAuto-supersedes-pill comments in place) and in the
  two onDetach handlers (their comments stay).
- `boundTokens.clear()` sites (drafts-reset callback, `show()`) → `this.tokenUi.clear()` —
  the reset why-comment stays at the call site (it explains PANEL's reset semantics).
  [Correction from the final review: this line originally said `hide()`, and the constructor
  rule below mentioned a `destroy()` lifecycle site — at base, the clears were in the reset
  callback and `show()`, and no picker-destroy existed; the implementation followed the code.]
- Constructor: `this.tokenUi = new PanelTokenUi(this.body, () => this.el)` replaces
  `new TokenPicker(this.body)`; exclusion wiring becomes
  `this.tokenUi.picker.beforeOpen = () => this.colorPicker.close()` and the colorPicker
  patch calls `this.tokenUi.picker.close()`. Lifecycle sites (`hide()`, `destroy()`, show-path
  close) become `this.tokenUi.picker.close()` / `.destroy()`.
- `rebind` implementation (exact semantics being moved):

```ts
rebind(spec: { props: string[] }, field: NumberField, value: number | null, mixed: boolean, comparing: boolean): void {
  const key = spec.props.join(',')
  const bound = this.bound.get(key)
  if (!bound || comparing) return
  if (!mixed && value === bound.px) field.bindToken(bound.label)
  else this.bound.delete(key)
}
```

- Panel deletes: `tokenPicker` field, `boundTokens` field, the three moved members. Imports
  of `ScaleEntry`, `createTokenButton` leave panel.ts if now unused (check: `createTokenButton`
  is only used by the moved block → import moves; `ScaleEntry` only by moved members → moves;
  `colorTokenEntries` stays in panel.ts for the gate).

- [ ] **Step 1: create the module** exactly per the interface above, all bodies moved verbatim per the move rules
- [ ] **Step 2: rewire panel.ts** per the move rules; `private tokenUi: PanelTokenUi`
- [ ] **Step 3: mechanical test updates** — in `tests/client/panel.test.ts` replace every
      `(panel as unknown as { tokenPicker: { root: HTMLElement } }).tokenPicker` with
      `(panel as unknown as { tokenUi: { picker: { root: HTMLElement } } }).tokenUi.picker`
      (~20 sites; introduce a single local helper `const pickerOf = (panel: Panel) => …` at
      the top of the affected describe blocks instead of 20 casts if the file already has a
      helpers section — prefer the helper). The mutual-exclusion test's
      `inner.tokenPicker.open(...)` likewise goes through `tokenUi.picker`.
- [ ] **Step 4: run the integration suite** — `npx vitest run tests/client/panel.test.ts`
      (from `packages/the-forge/`). Expected: 188 passed, zero assertion changes.
- [ ] **Step 5: full client suite + typecheck** — `npx vitest run tests/client/` and
      `npm run typecheck -w the-forge` (repo root). Expected: all green.
- [ ] **Step 6: commit** — `refactor: extract token-picker/pill cluster to panel-token-ui.ts`

### Task 2: Direct unit tests for the module + docs + gate

**Files:**
- Create: `packages/the-forge/tests/client/panel-token-ui.test.ts`
- Modify: `CLAUDE.md` (src/client modules table)
- Test: the new file; then the full root gate

**Interfaces (Consumes):** Task 1's exports exactly as declared above.

Test sketch (unit-level; panel.test.ts already covers integration — do NOT duplicate its
end-to-end flows):

- [ ] `pillLabelFor`: linked radius row (`RADIUS` props) → `rounded-md`; single-corner row
      (`['border-top-left-radius']`) → `rounded-tl-md`; font-size row → `text-sm`;
      `['padding-left','padding-right']` → `px-4`
- [ ] `colorDisplay`: exact opaque token match → `{ text: 'red-500', token: true }`;
      `rgba(0,0,0,0)` → `{ text: 'transparent', token: false }`; semi-transparent value whose
      rgb equals a token → hex-with-alpha text, `token: false` (alpha-guard pinned);
      unparseable css → `{ text: css, token: false }` (use `resetTokensCache()` + injected
      style fixtures — copy the setup pattern from panel.test.ts's colorTokenEntries block)
- [ ] `PanelTokenUi` bookkeeping: after a simulated `openScalePicker` apply (drive the real
      picker DOM: open with a fixture spec/field, click a row), `rebind` with the same px
      re-binds the pill; `rebind` with a diverged px drops the entry (subsequent equal-px
      rebind does NOT resurrect it); `rebind` with `comparing: true` neither binds nor drops
      (a later non-comparing rebind still binds); `drop`/`clear` empty the map (equal-px
      rebind after → no pill)
- [ ] `colorTokenButton`: returns a `.token-btn` button; click with color tokens present
      opens the picker with `tp-row-swatch` rows; clicking a row invokes `applyColor` with
      the token's exact css value
- [ ] run `npx vitest run tests/client/panel-token-ui.test.ts` (fails before writing? —
      no: this task is test-after by design, the code moved in Task 1; the RED discipline
      here is asserting against the REAL module, no mocks)
- [ ] CLAUDE.md: add row to the src/client modules table after `panel-readers.ts`:
      `| panel-token-ui.ts | PanelTokenUi — the token affordance cluster: shared TokenPicker instance, scale-field open path, pill boundTokens bookkeeping (B5/Compare rules), color-row token button; plus pillLabelFor/colorDisplay helpers |`
- [ ] full gate from repo root: `npm test` and `npm run build` — expected: typecheck clean,
      957+ tests green, build clean
- [ ] commit — `test: direct unit coverage for panel-token-ui; document the module`

## Explicitly out of scope

- Any behavior change, however small (that includes the Minor items the final review triaged
  as "ride": keyboard-vs-hover activeIndex interplay, compare-mode color pill asymmetry).
- Moving the ColorPicker, sizing modes, or any non-token panel concern.
- Renaming CSS classes or changing the popover DOM.
