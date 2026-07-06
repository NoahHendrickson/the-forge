# Designer-Forward Panel — Milestone D Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Milestone M-D — the final milestone of [docs/specs/2026-07-05-designer-forward-panel-design.md](../specs/2026-07-05-designer-forward-panel-design.md): min/max sizing on the W/H rows (Figma UI3 keeps min/max in the same dropdown as Fixed/Hug/Fill), shown via changed-from-default disclosure, emitting `min-w-*` / `max-w-*` / `min-h-*` / `max-h-*` utilities.

**Architecture:** Three layers, three tasks. (1) Token layer: four new `UTILITY_PREFIXES` entries flow automatically through `tokenEntriesFor` (numeric spacing scale), `nearestToken`, and `cssHintFor`; boundary pins prove `min-w-4` and `w-4` never cross-match. (2) UI: four `MIN_MAX_ROWS` specs render (hidden) under their W/H rows inside the unified Layout body; the size-mode select gains `Add min…`/`Add max…` action items; `LayoutSection` — which owns the whole size-mode story since M-C — owns disclosure (opened-set + draft latch + non-default computed). Clearing = typing `auto` (existing `allowAuto`/`autoCss` machinery: drafts `auto` for min, `none` for max — both already in `KEYWORD_PASSTHROUGH`, so requests carry the keyword, not a measured px). (3) E2E + the explicit package-budget gate (246/250KB headroom — a hard stop, not a note).

**Tech Stack:** TypeScript, vitest + jsdom (unit), real-browser E2E on the demo app (jsdom cannot see computed layout — repo gotcha).

## Global Constraints

- Branch: `designer-panel-m-d` off `main` @ `f5300ca` (already created and checked out in this worktree).
- Zero new runtime dependencies; CSS class names are test hooks — extend, don't rename (new hooks this milestone: `data-minmax-row` only; min/max rows reuse `.size-row`-adjacent plain field markup and `data-props` identities).
- **Package budget is a HARD gate:** unpacked size must stay ≤ 250KB (`check-prod-clean.sh` enforces). Current: 246KB. Task 3 measures before merge; if exceeded, STOP and escalate to the user (budget bump is a user decision — never silently trim shipped behavior).
- `SIZE_MODES` in `panel-specs.ts` stays a pure mode table (stories import it as the canonical dropdown catalog) — the `Add min…`/`Add max…` action items are appended at the `buildRow` call site only.
- Fields are born ONLY in panel.ts's `buildField`/`buildRow` (ratified single-birth-site rule — data-props/hint wiring); `LayoutSection` receives registrations, never constructs fields.
- Why-comments are load-bearing; buttons via `createButton`; all commands from `packages/the-forge/`; milestone gate = root `npm test` (baseline: 47 files / 1282 tests) + `./scripts/check-prod-clean.sh`.
- Line numbers approximate — trust anchors. Current landmarks: size-mode select in `buildRow` (panel.ts ~960-980, anchor `SIZE_MODES.map`); `LayoutSection` in `src/client/panel-layout.ts` owns `registerSizeMode`/`onSizeModeChange`/`updateSizeMode`/`withEdit`; unified-body composition in panel.ts's buildBody layout branch (anchor `buildBodyInto`).
- Multi-select: min/max rows are hidden in multi (single-select affordance — disclosure state is per-element and B6 relative-deltas on constraints designers rarely batch-edit is YAGNI; Task 3 records this in the spec sync).

---

### Task 1: Token layer — min/max utilities

**Files:**
- Modify: `packages/the-forge/src/client/tokens.ts` (UTILITY_PREFIXES, anchor `export const UTILITY_PREFIXES`)
- Test: `packages/the-forge/tests/client/tokens.test.ts`, `packages/the-forge/tests/client/request.test.ts`, `packages/the-forge/tests/client/panel-specs.test.ts`

**Interfaces:**
- Produces: `UTILITY_PREFIXES` gains `'min-width': 'min-w'`, `'max-width': 'max-w'`, `'min-height': 'min-h'`, `'max-height': 'max-h'`. Everything downstream (`utilityPrefixFor`, `tokenEntriesFor` spacing-scale path, `nearestToken`, `cssHintFor`) picks these up with zero further code — the tests in this task PIN that inheritance.

- [ ] **Step 1: Write the failing tests.** In `tests/client/tokens.test.ts` (mirror the file's existing nearestToken/findExistingUtility test setup — it builds a theme fixture; reuse it):

```ts
describe('min/max sizing utilities (M-D)', () => {
  it('nearestToken emits min-w-*/max-h-* from the spacing scale', () => {
    // spacingBasePx 4 in the existing fixture: 16px -> step 4
    expect(nearestToken('min-width', '16px', theme).utility).toBe('min-w-4')
    expect(nearestToken('max-height', '16px', theme).utility).toBe('max-h-4')
  })
  it('does not cross-match w-* and min-w-* class prefixes', () => {
    // guards the substring hazard both directions: an existing `min-w-4` class must not be
    // read as a width utility, and `w-4` must not be read as a min-width utility.
    expect(findExistingUtility('width', 'min-w-4 p-2')).toBeNull()
    expect(findExistingUtility('min-width', 'w-4 p-2')).toBeNull()
    expect(findExistingUtility('min-width', 'min-w-4 p-2')).toBe('min-w-4')
  })
})
```

(Adapt `nearestToken`/`findExistingUtility` call signatures to the file's real ones — copy a neighboring test's invocation shape; the assertions are the contract. If `findExistingUtility` is not exported, pin the same behavior through whichever public path the existing tests use for prefix-matching.)

In `tests/client/panel-specs.test.ts`, the cssHintFor inheritance pin:

```ts
it('min/max props inherit utility hints (M-D)', () => {
  expect(cssHintFor({ props: ['min-width'] })).toBe('min-width → min-w-*')
  expect(cssHintFor({ props: ['max-height'] })).toBe('max-height → max-h-*')
})
```

In `tests/client/request.test.ts`, the emission + clearing-keyword pins (mirror the file's builder-test setup):

```ts
it('min-width drafts emit min-w-* utilities (M-D)', () => {
  // element with inline min-width: 4px original; store.apply(el, 'min-width', '16px')
  // renderMarkdown output must contain 'min-w-4' as the after-utility
})
it('clearing keywords pass through verbatim: max-* none, min-* auto (M-D)', () => {
  // store.apply(el, 'max-width', 'none') → markdown contains 'none', NOT a measured px value
  // store.apply(el, 'min-width', 'auto') → markdown contains 'auto'
  // (both already in KEYWORD_PASSTHROUGH — this test pins that M-D depends on it)
})
```

Fill bodies from the neighboring builder tests' exact setup (PLAIN theme, DraftStore, renderMarkdown).

- [ ] **Step 2: Run** — `npx vitest run tests/client/tokens.test.ts tests/client/panel-specs.test.ts tests/client/request.test.ts`. Expected: FAIL (no prefixes).

- [ ] **Step 3: Implement.** In `tokens.ts` `UTILITY_PREFIXES`, after the `height: 'h'` entry:

```ts
  // M-D min/max sizing — Tailwind v4 sizes these off the same numeric spacing scale as w/h.
  // Named container widths (max-w-md …) are deliberately out of the picker's first pass
  // (spec M-D); nearest-token resolves numerically.
  'min-width': 'min-w',
  'max-width': 'max-w',
  'min-height': 'min-h',
  'max-height': 'max-h',
```

If the cross-match pin (Step 1) fails because `findExistingUtility`'s prefix matching is substring-based, tighten the match to a token boundary (preceded by start-of-string or whitespace — mirror however the existing `text-`/`font-` shape guards in the same file handle their collisions) — smallest change that makes both directions pass.

- [ ] **Step 4: Run** — same command. Expected: PASS. Then `npx tsc --noEmit`.

- [ ] **Step 5: Commit**

```bash
git add -A && git commit -m "feat(client): min/max sizing utilities in the token layer"
```

---

### Task 2: Min/max rows + Add min…/Add max… + LayoutSection disclosure

**Files:**
- Modify: `packages/the-forge/src/client/panel-specs.ts` (new `MIN_MAX_ROWS` export near `SIZE_ROWS`)
- Modify: `packages/the-forge/src/client/panel.ts` (buildBody layout branch composition; `buildRow`'s size-mode select options + onChange, anchor `SIZE_MODES.map`)
- Modify: `packages/the-forge/src/client/panel-layout.ts` (`registerMinMaxRow`, `openMinMax`, disclosure logic in `refresh`, opened-set reset in `teardown`)
- Test: `packages/the-forge/tests/client/panel.test.ts` (new disclosure describe; the M-C composition test needs its expected array updated — that is the ONLY allowed edit to an existing test)

**Interfaces:**
- Consumes: Task 1's prefixes (rows get token pickers + hints automatically via `buildField`); `LayoutSection.withEdit`, `registerSizeMode` patterns; `RowSpec.allowAuto`/`autoCss` (existing — buildField's onKeyword drafts `spec.autoCss ?? 'normal'`).
- Produces:
  - `panel-specs.ts`: `export const MIN_MAX_ROWS: RowSpec[]` —

```ts
// M-D min/max sizing (spec M-D): disclosure rows under W/H. Typing `auto` clears the
// constraint — autoCss carries each property's CSS initial value (min-*: auto, max-*: none),
// so the request says "remove the constraint" in keywords, never a measured px.
export const MIN_MAX_ROWS: RowSpec[] = [
  { label: 'Min', props: ['min-width'], min: 0, allowAuto: true, autoCss: 'auto' },
  { label: 'Max', props: ['max-width'], min: 0, allowAuto: true, autoCss: 'none' },
  { label: 'Min', props: ['min-height'], min: 0, allowAuto: true, autoCss: 'auto' },
  { label: 'Max', props: ['max-height'], min: 0, allowAuto: true, autoCss: 'none' },
]
```

  - `panel-layout.ts`: `registerMinMaxRow(reg: { rowEl: HTMLElement; spec: RowSpec; field: NumberField }): void` and `openMinMax(sizeSpec: RowSpec, kind: 'min' | 'max'): void` (derives the prop from `sizeSpec.props[0]` — `'width'` → `'min-width'`/`'max-width'`, `'height'` likewise — adds it to a private `openedMinMax: Set<string>`, calls `deps.refresh()`, then focuses that row's input). Disclosure predicate applied to each registered row inside `refresh` (single-select): visible iff `openedMinMax.has(prop) || deps.drafts.current(el, prop) !== null || computedNonDefault(el, prop)` where non-default means: min-*: computed not `''`/`'0px'`/`'auto'`; max-*: computed not `''`/`'none'`. In multi: all min/max rows hidden. `teardown()` clears `openedMinMax` and the registrations (selection-scoped, same lifecycle as `sizeModes`).

- [ ] **Step 1: Write the failing tests** in `panel.test.ts` (extend the local `P` map with `MIN_W: 'min-width'`, `MAX_W: 'max-width'`, `MIN_H: 'min-height'`, `MAX_H: 'max-height'`; use the file's existing single-element and multi setups):

```ts
describe('min/max sizing disclosure (M-D)', () => {
  const minMaxRow = (panel: Panel, props: string) =>
    (panel.root.querySelector(`[data-minmax-row][data-props-row="${props}"]`) ??
      fieldInput(panel, props).closest('[data-minmax-row]')) as HTMLElement

  it('rows exist in the Layout body but are hidden for default-valued elements', () => {
    // plain element, no min/max styles
    expect(fieldInput(panel, P.MIN_W)).toBeTruthy() // row markup exists
    expect(minMaxRow(panel, P.MIN_W).hidden).toBe(true)
  })

  it('a non-default computed min-width discloses its row on selection', () => {
    // element with inline style 'min-width: 120px'
    expect(minMaxRow(panel, P.MIN_W).hidden).toBe(false)
    expect(minMaxRow(panel, P.MAX_W).hidden).toBe(true) // independent per row
  })

  it('Add min… on the W select opens the min-width row and resets the select to the real mode', () => {
    // plain flex-child element; find W row's select; set value 'add-min' + dispatch change
    // expect minMaxRow(panel, P.MIN_W).hidden === false (opened-set latch, no draft yet)
    // expect select.value to be back to one of 'fixed'|'hug'|'fill' (not 'add-min')
  })

  it('typing auto clears: drafts the initial keyword and the row stays while the draft lives', () => {
    // element with inline 'max-width: 200px'; commit(fieldInput(panel, P.MAX_W), 'auto') — or
    // mirror how existing allowAuto tests enter the keyword
    // expect el.style.getPropertyValue('max-width') === 'none'
    // expect row still visible (draft latch)
  })

  it('multi-select hides all min/max rows', () => {
    // multiSetup(...); all four rows hidden
  })
})
```

(`data-minmax-row` is the new hook; give each row also its `spec.props` join as a `data-props-row` attr OR just locate via the field's `data-props` + `.closest` — pick one, use it consistently, and note it in the test helper. Fill setup lines from neighboring tests; assertions are the contract.)

- [ ] **Step 2: Run** — `npx vitest run tests/client/panel.test.ts -t 'min/max'`. Expected: FAIL.

- [ ] **Step 3: Implement panel-specs.ts** — the `MIN_MAX_ROWS` const above, exported alongside `SIZE_ROWS`.

- [ ] **Step 4: Implement the composition** in panel.ts's buildBody layout branch: after each size row append its two min/max rows —

```ts
for (const [i, row] of SIZE_ROWS.entries()) {
  rowWrap.append(this.buildRow(row))
  // W gets min/max-width (indices 0,1), H gets min/max-height (2,3) — disclosure rows,
  // hidden until LayoutSection.refresh discloses them (opened / drafted / non-default).
  for (const mm of MIN_MAX_ROWS.slice(i * 2, i * 2 + 2)) {
    const mmBound = this.buildField(mm)
    const mmRow = document.createElement('div')
    mmRow.className = 'panel-rows'
    mmRow.setAttribute('data-minmax-row', '')
    mmRow.hidden = true
    mmRow.append(mmBound.field.root)
    rowWrap.append(mmRow)
    this.layoutSection.registerMinMaxRow({ rowEl: mmRow, spec: mm, field: mmBound.field })
  }
}
```

(Adapt the wrapper element to match how sibling rows are structured — if plain `bound.field.root` siblings are the norm, put `data-minmax-row` + `hidden` on the field root itself instead of a wrapper; keep the hook name. `while`-composition order after this: H's min/max rows precede the flex-child strip.)

In `buildRow`'s select: append the action items and route them —

```ts
const select = createSelect({
  options: [
    ...SIZE_MODES.map(([value, label]) => ({ value, label })),
    // Figma UI3 keeps min/max in the sizing dropdown — action items, not modes. SIZE_MODES
    // itself stays a pure mode table (stories import it as the canonical catalog).
    { value: 'add-min', label: 'Add min…' },
    { value: 'add-max', label: 'Add max…' },
  ],
  onChange: (value) => {
    if (value === 'add-min' || value === 'add-max') {
      this.layoutSection.openMinMax(spec, value === 'add-min' ? 'min' : 'max')
      return // refresh() inside openMinMax re-syncs the select to the real mode
    }
    this.layoutSection.onSizeModeChange(spec, value)
  },
})
```

- [ ] **Step 5: Implement LayoutSection disclosure** in panel-layout.ts: private `minMaxRows: Array<{ rowEl; spec; field }> = []` + `openedMinMax = new Set<string>()`; `registerMinMaxRow` pushes; `openMinMax(sizeSpec, kind)` derives `` `${kind}-${sizeSpec.props[0]}` `` , adds to the set, `this.deps.refresh()`, focuses the row's input (`field.root.querySelector('input')?.focus()`). In `refresh`: multi → hide all registered rows; single → apply the predicate (computed defaults per the Produces block; jsdom `''` counts as default, same convention as `marginSectionVisible`) and ALSO re-sync each row's field value the way sibling fields get set (min/max fields display: numeric px via the normal path; when the drafts-aware current value is the keyword (`auto`/`none`), call `field.setAuto()` — mirror how W/H handle the Hug keyword display). `teardown()`: clear both collections.

- [ ] **Step 6: Update the M-C composition test** — its expected `kinds` array gains the four (hidden) min/max entries in order (W, minW, maxW, H, minH, maxH, flex-child, cluster…, padding…). This is the only permitted edit to an existing test; keep its order-contract character.

- [ ] **Step 7: Run** — `npx vitest run tests/client/panel.test.ts` then the full `npx vitest run tests/client/` + `npx tsc --noEmit`. Expected: PASS.

- [ ] **Step 8: Commit**

```bash
git add -A && git commit -m "feat(client): min/max sizing — Add min/max in the size dropdown, disclosure rows under W/H"
```

---

### Task 3: Real-browser E2E + budget gate + spec sync

**Files:**
- Modify: `docs/specs/2026-07-05-designer-forward-panel-design.md` (M-D section sync)
- No fixture changes expected (any demo element works — min/max is added live)

- [ ] **Step 1: Build + fresh dev server** (gotchas: `npm run build` FIRST; kill stale `lsof -iTCP:5173 -sTCP:LISTEN -n -P` pids; `npm run dev -w demo-app`; stale-bundle fallback `npm install` + restart).

- [ ] **Step 2: Browser E2E** (playwright MCP; REAL clicks — synthetic dispatch doesn't select; `#toggle` pierces the shadow root; page elements by full `[data-dc-source="src/App.tsx:5:9"]`-style selectors):
  a. Select a card → W/H rows show; no min/max rows visible (defaults).
  b. W select → `Add min…` → Min row appears focused; select shows the real mode again; type `120` → computed `min-width: 120px`; the field's `{ }`/`=` token affordance works (spacing scale).
  c. Send → queue markdown carries a `min-w-*` utility (`min-w-[120px]` or scale token — record which).
  d. Type `auto` in the Min field → computed min-width back to default; row stays visible while the draft lives; markdown for a subsequent send says `auto`, not a px.
  e. `Add max…` → Max row; type a value; reload-free verify computed `max-width`.
  f. Select an element that ALREADY has a min/max (add one inline via devtools-style `el.style` before selection, or give a demo element a `max-w-*` class temporarily WITHOUT committing it) → row discloses on selection.
  g. Multi-select (real shift-click) → all min/max rows hidden; W/H still editable.
  h. Regression: unified section order intact; Margin disclosure intact.
  Record concrete evidence per item; kill the dev server after.

- [ ] **Step 3: THE BUDGET GATE.** Run `./scripts/check-prod-clean.sh` and record the reported unpacked size. Also run `npm pack --dry-run --workspace the-forge 2>&1 | tail -5` (or the script's own measurement) and write the before (246KB) vs after numbers into the report. **If the size exceeds 250KB: STOP — do not trim, do not adjust the budget; report BLOCKED to the controller** (the budget decision belongs to the user).

- [ ] **Step 4: Spec sync** — update the spec's M-D section to shipped reality: Add min…/Add max… action items (SIZE_MODES purity note), disclosure predicate (opened / drafted / non-default), `auto`-keyword clearing (min→`auto`, max→`none`, keywords pass through the request), min/max hidden in multi-select (single-select affordance, YAGNI-documented), named container tokens still out of scope. Mark the milestone table/list complete if the spec tracks it.

- [ ] **Step 5: Full gate** — root `npm test`. Expected: all pass.

- [ ] **Step 6: Commit**

```bash
git add -A && git commit -m "docs: M-D spec sync; E2E-verified min/max sizing within package budget"
```

---

## Self-review notes (run after drafting — resolved)

- **Spec coverage:** M-D spec items — min/max in the size-mode dropdown (Task 2), changed-from-default disclosure (Task 2), clearing semantics max→`none` / min→`auto` (Task 2 + Task 1 passthrough pin), `UTILITY_PREFIXES` + spacing-scale picker (Task 1), named container widths out of scope (Task 1 comment + Task 3 spec sync), verifier untouched (no task — nothing to do, computed styles verify normally). Mandatory inputs honored: all disclosure/dropdown policy lands in `LayoutSection` (size-mode story stays whole); budget is Task 3's hard gate.
- **Type consistency:** `registerMinMaxRow`/`openMinMax` defined in Task 2's Produces and consumed only within Task 2; `MIN_MAX_ROWS` (panel-specs) consumed by panel.ts composition; `P.MIN_W`-style test keys defined and used in the same file.
- **Known judgment calls for the executor:** the min/max row wrapper (dedicated div vs attrs on the field root) — the hook contract (`data-minmax-row` + hidden toggling) is fixed, the markup shape mirrors siblings; keyword display via `setAuto` mirrors the W/H Hug path; the composition-test update is the single sanctioned existing-test edit.
- **Deliberate scope cuts (YAGNI):** no multi-select min/max editing; no named container-width tokens in the picker; no `size-mode.ts` sub-module (LayoutSection is 400 lines and cohesive — revisit only if it grows past the panel.ts lesson).
