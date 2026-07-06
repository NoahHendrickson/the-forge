# Designer-Forward Panel — Milestone C Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Milestone M-C of [docs/specs/2026-07-05-designer-forward-panel-design.md](../specs/2026-07-05-designer-forward-panel-design.md) — the unified Figma-UI3-style Layout section (Layout + Size + Padding merged, section order re-ratified) — preceded by the three refactors publicly promised in PR #16's description as this milestone's first work: extract the layout cluster from `panel.ts` into a dedicated module, give `SegmentField` a first-class track-addon API, and centralize remove-auto-layout intent at request construction.

**Architecture:** Tasks 1–3 are behavior-neutral refactors (the full existing suite must stay green through each): `SegmentField` grows a `trailing` option that builds the `.seg-cluster` itself (killing the panel's `replaceWith` surgery); the layout cluster + its policy (`FLEX_CONTAINER_PROPS`, remove semantics, flex-child controls) move to a new `src/client/panel-layout.ts` behind a `LayoutSection` class; the remove-intent moves from a `renderMarkdown` special case to a `ChangeItem.intent` field set by the builder. Task 4 is the structural change: one Layout section composed of W/H rows → flex-child controls → auto-layout cluster → padding rows, visible in multi-select with only the cluster hidden (rows keep B6 relative-delta behavior). Task 5 fixes the Baseline clip, verifies in a real browser, and syncs docs.

**Tech Stack:** TypeScript, vitest + jsdom (unit), Storybook story for the composite row, real-browser E2E on the demo app (jsdom cannot see layout — repo gotcha).

## Global Constraints

- Branch: `designer-panel-m-c` off `main` @ `81b6193` (already created and checked out in this worktree).
- Zero new runtime dependencies (CLAUDE.md hard constraint).
- CSS class names are test hooks — extend, don't rename. Existing hooks that MUST keep working: `.seg-field`, `.seg-track`, `.seg-cluster`, `[data-wrap-toggle]`, `[data-remove-layout]`, `[data-align-baseline]`, `[data-add-layout]`, `.layout-section`, `.layout-controls`, `.layout-side`, `.matrix-tile`, `.flex-child-controls`, `.size-row`, `.panel-rows`, `data-props` field identities. New in this milestone: `.baseline-toggle` class only.
- Why-comments are load-bearing — when Tasks 1–3 move code, the comments move verbatim with it (the PR-#16 promise explicitly includes not losing the decision record).
- Tasks 1–3 are refactors: NO behavior change; the pre-existing suite passes unmodified except where a test reaches into a structure the refactor replaces (each task lists the only allowed test edits).
- Buttons via `createButton` (`src/client/ui/button.ts`); never raw `document.createElement('button')`.
- All commands from `packages/the-forge/` unless stated; milestone gate is root `npm test` (baseline today: 47 files / 1277 tests).
- Line numbers are approximate — trust the paired search anchors.
- Prompt mode (PR #14) now owns the panel header (`.panel-head-actions`) — this milestone must not touch `panel-head` markup or CSS.

---

### Task 1: SegmentField `trailing` addon API + composite Direction-row story

Kills the `replaceWith` DOM surgery (PR #16 promise #2). `SegmentField` becomes the owner of the `.seg-cluster` wrapper.

**Files:**
- Modify: `packages/the-forge/src/client/layout-controls.ts` (SegmentFieldOpts + constructor, anchor: `const track = document.createElement('div')`)
- Modify: `packages/the-forge/src/client/panel.ts` (`buildLayoutSection` wrap-toggle block, anchor: `track.replaceWith(cluster)` ~line 762)
- Modify: `packages/the-forge/stories/segment-field.stories.ts` (new composite story; file pattern: `StoryObj` + `render:` + `mountInShadow(field.root, 'panel')`)
- Test: `packages/the-forge/tests/client/layout-controls.test.ts`, `packages/the-forge/tests/client/panel.test.ts`

**Interfaces:**
- Produces: `SegmentFieldOpts.trailing?: HTMLElement[]` — when present, the constructor wraps the track and every trailing element in a `<div class="seg-cluster">` appended where the bare track used to go: root children become `[label, cluster(track, ...trailing)]`. When absent, DOM is byte-identical to today (`[label, track]`).
- Consumes: nothing new. Task 2 moves the calling code; the call shape it will move is defined here.

- [ ] **Step 1: Write the failing SegmentField test** in `tests/client/layout-controls.test.ts`:

```ts
it('wraps track + trailing elements in a seg-cluster when trailing is provided', () => {
  const addon = document.createElement('button')
  addon.setAttribute('data-wrap-toggle', '')
  const f = new SegmentField({
    label: 'Direction',
    options: [
      { value: 'row', label: '→', ariaLabel: 'Horizontal' },
      { value: 'column', label: '↓', ariaLabel: 'Vertical' },
    ],
    trailing: [addon],
    onInput: () => {},
  })
  const cluster = f.root.querySelector('.seg-cluster') as HTMLElement
  expect(cluster).toBeTruthy()
  expect(cluster.querySelector('.seg-track')).toBeTruthy()
  expect(cluster.contains(addon)).toBe(true)
  expect([...f.root.children].map((c) => c.className)).toEqual(['seg-field-label', 'seg-cluster'])
})

it('renders no seg-cluster when trailing is absent (existing DOM untouched)', () => {
  const f = new SegmentField({ label: 'X', options: [{ value: 'a', label: 'A' }], onInput: () => {} })
  expect(f.root.querySelector('.seg-cluster')).toBeNull()
  expect([...f.root.children].map((c) => c.className)).toEqual(['seg-field-label', 'seg-track'])
})
```

- [ ] **Step 2: Run** — `npx vitest run tests/client/layout-controls.test.ts`. Expected: FAIL (`trailing` not in opts type / no cluster).

- [ ] **Step 3: Implement.** In `layout-controls.ts`: add to `SegmentFieldOpts` —

```ts
  /** Extra controls that belong on the segment row but NOT in the exclusive track (e.g. the
   * wrap toggle riding the Direction row). When present, SegmentField wraps track + trailing
   * in a .seg-cluster so a column-stacked field ([data-flex-direction]) keeps them on one
   * visual row — the field owns this structure; callers must not rewire its children. */
  trailing?: HTMLElement[]
```

In the constructor, replace the unconditional `this.root.append(track)` (anchor: after the label append) with:

```ts
    if (opts.trailing && opts.trailing.length > 0) {
      const cluster = document.createElement('div')
      cluster.className = 'seg-cluster'
      cluster.append(track)
      for (const t of opts.trailing) cluster.append(t)
      this.root.append(cluster)
    } else {
      this.root.append(track)
    }
```

(The options loop keeps appending buttons to `track` — build `track` and its buttons before this block, matching the existing order.)

- [ ] **Step 4: Migrate panel.ts.** In `buildLayoutSection`: build `wrapBtn` (unchanged construction + click handler + why-comment) BEFORE the `new SegmentField` direction call; pass `trailing: [wrapBtn]` in the direction field's opts; DELETE the post-hoc cluster block (anchor: `const cluster = document.createElement('div')` … `track.replaceWith(cluster)` and its "A .seg-cluster row wrapper holds" comment — move that comment's text onto the `trailing:` line or drop it only if its content is now fully covered by the `trailing` doc comment in layout-controls.ts; the E2E-found-bug provenance sentence must survive somewhere — keep it in overlay.ts's `.seg-cluster` CSS comment where it already also lives, and verify that copy is intact).

- [ ] **Step 5: Run the pinned cluster tests** — `npx vitest run tests/client/panel.test.ts -t 'seg-cluster'` then the two touched files in full. Expected: PASS with zero edits to the pin test (`direction row nests track + wrap toggle in a .seg-cluster`) — that's the proof the API reproduces the shape.

- [ ] **Step 6: Add the composite story** in `stories/segment-field.stories.ts`, following the file's exact `Story`/`render`/`mountInShadow` pattern:

```ts
export const DirectionRowComposite: Story = {
  render: () => {
    const wrapBtn = document.createElement('button')
    wrapBtn.type = 'button'
    wrapBtn.className = 'seg wrap-toggle'
    wrapBtn.textContent = '↩'
    wrapBtn.title = 'flex-wrap: wrap → flex-wrap'
    const field = new SegmentField({
      label: 'Direction',
      options: [
        { value: 'row', label: '→', ariaLabel: 'Horizontal', title: 'flex-direction: row → flex-row' },
        { value: 'column', label: '↓', ariaLabel: 'Vertical', title: 'flex-direction: column → flex-col' },
      ],
      trailing: [wrapBtn],
      onInput: () => {},
    })
    field.root.setAttribute('data-flex-direction', '')
    field.set('row')
    return mountInShadow(field.root, 'panel')
  },
}
```

(The raw `createElement('button')` here is story-local scaffolding rendering the real control — same as existing stories' sample data; the shipped wrap button still comes from `createButton`.)

- [ ] **Step 7: Full client run** — `npx vitest run tests/client/`. Expected: all pass, no test file edited except layout-controls.test.ts additions.

- [ ] **Step 8: Commit**

```bash
git add -A && git commit -m "refactor(client): SegmentField owns the seg-cluster via a trailing addon API"
```

---

### Task 2: Extract `panel-layout.ts` — the layout cluster leaves panel.ts

PR #16 promise #1. Behavior-neutral move: the auto-layout cluster (direction/wrap/gap/matrix/baseline), the add/remove buttons + removal policy, `FLEX_CONTAINER_PROPS`, the flex-child controls, and their refresh logic move into a `LayoutSection` class. `panel.ts` (1452 lines today) sheds ~350 lines and keeps thin delegation.

**Files:**
- Create: `packages/the-forge/src/client/panel-layout.ts`
- Modify: `packages/the-forge/src/client/panel.ts` (delete moved code, delegate; anchors: `const FLEX_CONTAINER_PROPS` ~49, the `custom === 'layout'` branch in buildBody ~616-645, `buildLayoutSection` ~715, `buildFlexChildControls` ~1200, `refreshLayoutSection` + `refreshFlexChild` + the layout-widget member fields ~94-110 and their teardown null-outs)
- Modify: `CLAUDE.md` (src/client modules table — add the `panel-layout.ts` row)
- Test: existing suites only — `tests/client/panel.test.ts` and `tests/client/design-mode.test.ts` must pass UNMODIFIED (all layout behavior is asserted via DOM hooks, which the move preserves). New file gets no own test file: its coverage IS the existing panel suites (note this in the module doc comment).

**Interfaces:**
- Produces: `src/client/panel-layout.ts` exporting:

```ts
export const FLEX_CONTAINER_PROPS: string[]  // moved verbatim with its why-comment

export interface LayoutSectionDeps {
  drafts: DraftStore
  /** The panel's live selection accessor — LayoutSection never caches the element. */
  getEl: () => TaggedElement | null
  /** Drafts-aware computed reader — the panel's existing private currentValue, passed through. */
  currentValue: (el: TaggedElement, prop: string, computed: CSSStyleDeclaration) => string
  onBeforeEdit: (el: TaggedElement) => void
  onEdited: () => void
  refresh: () => void
  /** Gap-field token affordance — the panel's tokenUi cluster, passed through. */
  tokenUi: PanelTokenUi
  /** NumberField factory for Gap so panel-layout doesn't duplicate hint/data-props wiring —
   * the panel's buildField machinery stays the single place fields are born. */
  buildGapField: () => { root: HTMLElement }
}

export class LayoutSection {
  constructor(deps: LayoutSectionDeps)
  /** The add-button + cluster body (today's buildLayoutSection return value, same DOM). */
  buildBody(): HTMLElement
  /** The − remove button for the section title (today's buildBody layout-branch block). */
  buildRemoveButton(): HTMLButtonElement
  /** The flex-child Align/size-mode strip (today's buildFlexChildControls). */
  buildFlexChildControls(): HTMLElement
  /** Today's refreshLayoutSection + refreshFlexChild, fused: add/remove visibility, direction/
   * wrap/baseline state, matrix set, flex-child visibility. */
  refresh(el: TaggedElement, computed: CSSStyleDeclaration, multi: boolean): void
  /** Null out widget refs (today's teardown lines). */
  teardown(): void
}
```

- Consumes: Task 1's `trailing` API (moves already-clean construction). Task 4 consumes `buildBody`/`buildRemoveButton`/`refresh(multi)` — the `multi` param is introduced here but passed `false`-equivalent behavior in this task (see Step 3).

- [ ] **Step 1: Snapshot the green baseline** — `npx vitest run tests/client/panel.test.ts tests/client/design-mode.test.ts` (expect current pass counts; record them).

- [ ] **Step 2: Create `panel-layout.ts`** with the class shell above and MOVE (not rewrite) the bodies: `FLEX_CONTAINER_PROPS` + comment; `buildLayoutSection` → `buildBody` (member fields `addLayoutBtn`, `directionField`, `wrapToggle`, `gapField`→ via `deps.buildGapField()`, `alignMatrix`, `baselineToggle`, `layoutControlsWrap` become private fields of LayoutSection); the remove-button block from panel.ts's buildBody layout branch → `buildRemoveButton` (its click handler reads `deps.getEl()`, `deps.drafts`); `buildFlexChildControls` → same name; `refreshLayoutSection`+`refreshFlexChild` → `refresh(el, computed, multi)` where the `multi` param replaces the panel-side callers' current pattern (in multi the panel today hides the whole section and never calls refreshLayoutSection — keep `refresh` early-returning the cluster-state work when `multi` is true so Task 4 can flip the section visible without state bugs). Every moved why-comment lands verbatim.
  Note on the gap field: today it's a bespoke NumberField built inline in buildLayoutSection with `hint: cssHintFor(GAP_SPEC)`, `dataset.props`, tokenUi wiring. To keep ONE field-birth site, panel.ts passes `buildGapField` as a closure that builds exactly today's gap NumberField (move the inline construction into that closure in panel.ts, not into panel-layout.ts).

- [ ] **Step 3: Delegate from panel.ts.** Construct `this.layoutSection = new LayoutSection({...})` in the Panel constructor (or per-show if today's widgets rebuild per show() — mirror today's lifecycle exactly: widgets are rebuilt in buildBody per show(), so construct the LayoutSection instance once and let buildBody/refresh recreate its internal widgets the same way the panel did). The buildBody layout branch becomes: `title.append(this.layoutSection.buildRemoveButton()); const layoutBody = this.layoutSection.buildBody(); ...` — identical append order. The refresh section calls `this.layoutSection.refresh(el, computed, multi)` where the old `refreshLayoutSection(el, computed)` + `refreshFlexChild(el, computed)` calls were (single-select path only, as today). Delete the moved private members + teardown lines from panel.ts; `LayoutSection.teardown()` is called where the null-outs were.

- [ ] **Step 4: Run the baseline suites** — `npx vitest run tests/client/panel.test.ts tests/client/design-mode.test.ts`. Expected: SAME pass counts as Step 1, zero test edits. Any failure means the move changed behavior — fix the move, never the test.

- [ ] **Step 5: Full client + typecheck** — `npx vitest run tests/client/ && npx tsc --noEmit`. Expected: green.

- [ ] **Step 6: CLAUDE.md module table** — add under the `panel-token-ui.ts` row, matching table format:

```
| `panel-layout.ts` | `LayoutSection` — the auto-layout cluster (add/remove policy + `FLEX_CONTAINER_PROPS`, direction+wrap, gap, matrix, baseline, flex-child controls); covered by the panel suites, no own test file |
```

- [ ] **Step 7: Commit**

```bash
git add -A && git commit -m "refactor(client): extract LayoutSection into panel-layout.ts (PR #16 promise)"
```

---

### Task 3: Remove-auto-layout intent moves to request construction

PR #16 promise #3. The renderer stops owning policy; `ChangeItem` carries `intent`.

**Files:**
- Modify: `packages/the-forge/src/client/request.ts` (ChangeItem interface ~5-12; builder `buildChangeRequestWithElements` per-change construction; renderer intent block ~293-297, anchor: `Spell the intent out`)
- Test: `packages/the-forge/tests/client/request.test.ts`

**Interfaces:**
- Produces: `ChangeItem.intent?: string`; exported const `REMOVE_AUTO_LAYOUT_INTENT` (exact current sentence: `` remove auto layout (flexbox) from this element; remove flex/inline-flex/flex-row/flex-col/flex-wrap/gap-*/justify-*/items-* classes rather than adding `display: block` ``). Renderer appends `` ` — intent: ${c.intent}` `` for ANY change carrying intent — generic, policy-free.

- [ ] **Step 1: Write the failing builder test** in `request.test.ts` (mirror the existing intent test's setup — element with original `display: flex`, `store.apply(el, 'display', 'block')`):

```ts
it('builder stamps REMOVE_AUTO_LAYOUT_INTENT on the display change (renderer stays policy-free)', () => {
  // same setup as the existing remove-intent test
  const req = buildChangeRequest(store, PLAIN)
  const displayChange = req.elements[0].changes.find((c) => c.property === 'display')!
  expect(displayChange.intent).toBe(REMOVE_AUTO_LAYOUT_INTENT)
})
```

- [ ] **Step 2: Run** — `npx vitest run tests/client/request.test.ts -t 'stamps'`. Expected: FAIL (no `intent` field / const not exported).

- [ ] **Step 3: Implement.** Add `intent?: string` to `ChangeItem` with doc comment `/** Optional plain-language instruction overriding the literal before→after reading — set by the BUILDER (policy lives at construction), rendered generically. */`. Export the const. In `buildChangeRequestWithElements`, where each ChangeItem is pushed, add after construction (moving the existing why-comment from the renderer verbatim, reworded only where it referenced rendering):

```ts
// 'display: flex → block' is never the literal ask — it is the panel's deterministic
// preview of REMOVING auto layout. Stamp the intent here at construction so the agent
// edits classes (removes the flex family); the renderer prints it without owning policy.
if (item.property === 'display' && (item.beforeCss === 'flex' || item.beforeCss === 'inline-flex') && item.afterCss === 'block') {
  item.intent = REMOVE_AUTO_LAYOUT_INTENT
}
```

In `renderMarkdown`, replace the display-special-case block with:

```ts
if (c.intent) line += ` — intent: ${c.intent}`
```

- [ ] **Step 4: Run the whole request suite** — `npx vitest run tests/client/request.test.ts`. Expected: PASS including the two pre-existing verbatim markdown assertions (byte-identical output proves the move was neutral). Also check no other test constructs `ChangeItem` literals that now fail typecheck: `npx tsc --noEmit`.

- [ ] **Step 5: Commit**

```bash
git add -A && git commit -m "refactor(client): remove-auto-layout intent stamped at request construction"
```

---

### Task 4: The unified Layout section

The structural move (spec M-C): one Layout section = W/H rows → flex-child controls → auto-layout cluster → padding rows. Section order re-ratified: **Layout → Margin (conditional) → Typography → Fill → Stroke → Appearance**.

**Files:**
- Modify: `packages/the-forge/src/client/panel-specs.ts` (SECTIONS: delete Size + Padding entries; Layout gains `expandKey: 'padding'` + Padding's expandRows; export the W/H and padding-H/V row specs as named consts so panel.ts composes them — anchors: `title: 'Layout'` ~190, `title: 'Size'` ~198, `title: 'Padding'` ~205)
- Modify: `packages/the-forge/src/client/panel.ts` (buildBody layout branch composes the unified body; refresh's Layout multi special-case at ~336-341 changes; the `section.title === 'Size'` flex-child append at ~682 moves into the layout branch)
- Modify: `docs/research/2026-07-04-panel-patterns.md` (dated amendment)
- Test: `packages/the-forge/tests/client/panel.test.ts` (section-order test, B6 Layout-hidden-in-multi tests, any Size/Padding-title queries), `packages/the-forge/tests/client/design-mode.test.ts` (any Size/Padding-title queries — grep)

**Interfaces:**
- Consumes: `LayoutSection.buildBody/buildRemoveButton/refresh(el, computed, multi)` (Task 2).
- Produces: `panel-specs.ts` exports `SIZE_ROWS: RowSpec[]` (the W/H specs verbatim from today's Size section) and `PADDING_ROWS: RowSpec[]` (today's Padding H/V rows); SECTIONS Layout entry:

```ts
{
  title: 'Layout',
  rows: [],
  custom: 'layout',
  expandKey: 'padding',
  expandRows: [
    { label: 'T', props: ['padding-top'], min: 0 },
    { label: 'R', props: ['padding-right'], min: 0 },
    { label: 'B', props: ['padding-bottom'], min: 0 },
    { label: 'L', props: ['padding-left'], min: 0 },
  ],
  // Unified UI3 section (spec M-C, re-ratified 2026-07-06): W/H rows -> flex-child strip ->
  // auto-layout cluster -> padding rows, one fixed order, flex or not. The cluster alone is
  // single-select-only (B6); rows keep multi relative-delta behavior.
},
```

- [ ] **Step 1: Write the failing structure tests** in `panel.test.ts` (adapt the existing section-order test and add the composition test; the order test's expected list changes):

```ts
it('section order is Layout, Margin, Typography, Fill, Stroke, Appearance', () => {
  // same setup as today's order test; strip '⋯' and '−' glyphs as the current test does
  expect(titles).toEqual(['Layout', 'Margin', 'Typography', 'Fill', 'Stroke', 'Appearance'])
})

it('unified Layout body composes W/H, flex-child strip, cluster, padding in order', () => {
  const { panel } = flexSetup()
  const body = panel.root.querySelector('.layout-section') as HTMLElement
  const kinds = [...body.children].map((c) =>
    c.classList.contains('size-row') ? 'size'
    : c.classList.contains('flex-child-controls') ? 'flex-child'
    : c.classList.contains('layout-controls') || c.hasAttribute('data-add-layout') ? 'cluster'
    : (c as HTMLElement).dataset.props?.startsWith('padding') ? 'padding' : c.className
  )
  expect(kinds).toEqual(['size', 'size', 'flex-child', 'cluster', 'cluster', 'padding', 'padding'])
})

it('multi-select: Layout section stays visible with rows; cluster and remove hidden', () => {
  // two-element setup as in the existing B6 tests
  const title = /* Layout title el, existing lookup pattern */
  expect(title.hidden).toBe(false)
  expect((panel.root.querySelector('.layout-controls') as HTMLElement).hidden).toBe(true)
  expect((panel.root.querySelector('[data-add-layout]') as HTMLElement).hidden).toBe(true)
  expect((panel.root.querySelector('[data-remove-layout]') as HTMLElement).hidden).toBe(true)
  expect(fieldInput(panel, P.W)).toBeTruthy()  // W row alive in multi
  expect(fieldInput(panel, P.PX)).toBeTruthy() // padding row alive in multi
})
```

(The `kinds` expectation assumes the add-button and controls-wrap are the cluster's two body children as today — adjust the mapping, not the ORDER contract, if buildBody nests differently; the order contract is the spec.)

- [ ] **Step 2: Run** — expected FAIL (old order; separate sections).

- [ ] **Step 3: Restructure panel-specs.ts.** Export `SIZE_ROWS`/`PADDING_ROWS` (specs moved verbatim — labels `W`/`H` with `sizeMode: true`, padding `H`/`V`); delete the Size and Padding section entries; give Layout the entry above (padding expandRows moved verbatim). Margin/Typography/Fill/Stroke/Appearance untouched.

- [ ] **Step 4: Compose in panel.ts buildBody's layout branch** (order is the contract):

```ts
const rowWrap = document.createElement('div')
rowWrap.className = 'panel-rows layout-section'
for (const row of SIZE_ROWS) rowWrap.append(this.buildRow(row))
rowWrap.append(this.layoutSection.buildFlexChildControls())
const clusterBody = this.layoutSection.buildBody()
// buildBody returns the add-button + controls wrap inside one element today — append its
// children in place so the section body stays a single flat .panel-rows (CSS contract).
while (clusterBody.firstChild) rowWrap.append(clusterBody.firstChild)
for (const row of PADDING_ROWS) rowWrap.append(this.buildRow(row))
```

Delete the old `section.title === 'Size'` flex-child append; the generic expandKey logic already appends the `⋯` to the Layout title (now alongside `−` — button order in title: remove `−` first, then `⋯`, matching however the existing title-glyph-strip helpers expect; check the `'Layout−'` assertions from M-B and update them to `'Layout−⋯'`-style stripping).

- [ ] **Step 5: Fix the multi gating.** In refresh (~336-341), the Layout branch stops hiding the section: replace `this.setSectionHidden(spec, sectionEls, multi)` + `continue` with falling through to the generic visibility path (Layout has no `visible` predicate → always shown), and pass `multi` into `this.layoutSection.refresh(el, computed, multi)` — inside, when `multi` is true: `addLayoutBtn.hidden = true; removeBtn.hidden = true; layoutControlsWrap.hidden = true` and skip the state sync (Task 2 already shaped `refresh` for this).

- [ ] **Step 6: Repair displaced tests.** Grep both test files for `'Size'`/`'Padding'` section-title queries and B6 assertions that Layout is hidden in multi — update each to the new contract (section present; cluster hidden). The Margin disclosure, data-props lookups, and all field-level tests must pass untouched (their hooks didn't move).

- [ ] **Step 7: Run** — `npx vitest run tests/client/`. Expected: PASS.

- [ ] **Step 8: Amend the research doc.** Append to `docs/research/2026-07-04-panel-patterns.md`:

```md
## Amendment (2026-07-06) — unified Layout section

M-C (spec 2026-07-05, user-ratified) merges Layout + Size + Padding into one Figma-UI3-style
"Layout" section: W/H rows → flex-child strip → auto-layout cluster → padding rows, one fixed
order, flex or not. Section order re-ratified, fixed forever: Layout → Margin (conditional) →
Typography → Fill → Stroke → Appearance. The stable-order principle (contextual content, never
contextual position) is unchanged — this is a one-time re-ratification, not a relaxation.
```

- [ ] **Step 9: Commit**

```bash
git add -A && git commit -m "feat(client): unified UI3-style Layout section — W/H + cluster + padding, re-ratified order"
```

---

### Task 5: Baseline clip fix + real-browser E2E + spec sync + gate

**Files:**
- Modify: `packages/the-forge/src/client/panel-layout.ts` (baseline button gains the class, anchor: `data-align-baseline`)
- Modify: `packages/the-forge/src/client/overlay.ts` (new `.baseline-toggle` rule near `.wrap-toggle`)
- Modify: `docs/specs/2026-07-05-designer-forward-panel-design.md` (M-C section sync)
- Test: `packages/the-forge/tests/client/panel.test.ts` (one class assertion)

- [ ] **Step 1: Baseline clip.** Add `baselineBtn.classList.add('baseline-toggle')` at construction; in overlay.ts near the `.wrap-toggle` rule:

```css
/* .seg hard-clips overflow by design (title = escape hatch), but Baseline is a word, not a
   glyph — let this one toggle size to its label so it doesn't clip to "Ba…" at the 280px
   panel width (M-B review finding). */
.baseline-toggle { width: auto; flex: none; overflow: visible; padding: 0 8px; }
```

Add to the existing baseline panel test: `expect(btn.classList.contains('baseline-toggle')).toBe(true)`. Run `npx vitest run tests/client/panel.test.ts -t 'baseline'` — PASS.

- [ ] **Step 2: Build + fresh dev server** (gotchas: build first; `lsof -iTCP:5173 -sTCP:LISTEN -n -P` and kill stale pids; `npm run dev -w demo-app`; if the served bundle looks stale, `npm install` in the worktree and restart).

- [ ] **Step 3: Browser E2E** (playwright MCP; shadow root via the host element; REAL clicks — synthetic dispatch does not trigger selection; toggle `#toggle`, then click page elements by `[data-dc-source="…"]` selectors):
  a. Select a flex card → ONE Layout section shows W/H (with size modes), Align strip hidden/shown per parent, direction `→`/`↓` + wrap, gap, matrix + Baseline, padding H/V; `⋯` expands T/R/B/L; `−` present. No separate Size/Padding sections anywhere.
  b. Section order reads Layout → (Margin if margins) → Typography → Fill → Stroke → Appearance.
  c. Multi-select two cards (shift-click or the app's multi path per existing E2E notes) → Layout section still visible with W/H/padding editable; cluster/add/remove hidden.
  d. Narrow the panel to its minimum width → Baseline label fully visible (no "Ba…" clipping) — measure `scrollWidth <= clientWidth` on the button.
  e. Remove auto layout on the stylesheet-flex card → Send → queue markdown carries the intent line (now builder-stamped — same text as before, byte-identical).
  f. Regression spot-checks: prompt button + mode button still in the header cluster (PR #14 territory untouched); margin disclosure still conditional.
  Record concrete evidence per item; kill the dev server after.

- [ ] **Step 4: Spec sync** — update the spec's M-C section to the shipped composition (W/H → flex-child → cluster → padding; cluster-only hidden in multi; `⋯`+`−` share the title row) and tick off the refactor promises (reference PR #16). One paragraph, same format as the M-A/M-B syncs.

- [ ] **Step 5: Full gate** — root `npm test` (expect ≥1277 passing) and `./scripts/check-prod-clean.sh`. Expected: green.

- [ ] **Step 6: Commit**

```bash
git add -A && git commit -m "feat(client): baseline clip fix; docs: M-C spec sync — E2E-verified unified Layout"
```

---

## Self-review notes (run after drafting — resolved)

- **Spec coverage:** M-C spec = unified section + re-ratified order + research amendment (Task 4) ✓; PR #16 promises = Tasks 1-3 ✓; queued minors = Baseline clip + composite story (Tasks 5/1) ✓. Min/max stays M-D — not touched here.
- **Type consistency:** `LayoutSectionDeps`/`LayoutSection` methods defined in Task 2 match Task 4's calls (`buildBody`, `buildRemoveButton`, `buildFlexChildControls`, `refresh(el, computed, multi)`); `SIZE_ROWS`/`PADDING_ROWS` defined Task 4 Step 3, consumed Step 4; `trailing` defined Task 1, consumed Task 2's moved code.
- **Known judgment calls for the executor:** LayoutSection's internal widget-rebuild lifecycle must mirror today's per-show() rebuild exactly (Task 2 Step 3 states the rule; the executor confirms against the real constructor/show flow); the Task 4 `kinds` mapping may need adjusting to the real child nesting — the ORDER is the contract, the mapping is scaffolding; title-glyph stripping updates where `'Layout−'` assertions exist.
- **Deliberate scope cuts:** no SegmentField story for the bare `trailing` edge beyond the composite; no attempt to move W/H/padding field construction into panel-layout.ts (fields stay born in panel.ts's buildField — single birth site, per the M-A data-props/hint wiring).
