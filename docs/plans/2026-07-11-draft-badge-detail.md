# Draft Badge + Detail Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** The composer's drafts pill counts individual property changes (not elements) and carries a chevron; the open disclosure lists every drafted change per element instead of "first +N more" behind a hover-only tooltip.

**Architecture:** Three thin view changes over existing state — a `changeCount()` reader on `DraftStore`, a label/chevron split inside the existing `.draft-pill` button, and a per-property render loop in `ChangeList.renderDraftRow`. No changes to the request builder, queue, send lifecycle, or agent-facing markdown. Spec: `docs/specs/2026-07-11-draft-badge-detail-design.md`.

**Tech Stack:** TypeScript, vitest + jsdom, the overlay's CSS-string design system in `src/client/overlay.ts`.

## Global Constraints

- Zero new runtime dependencies.
- Panel/overlay CSS class names are test hooks — **extend, don't rename** (`.draft-pill`, `.draft-disclosure`, `.change-row`, `.change-summary` all keep their names and roles; new classes: `.draft-pill-label`, `.draft-pill-chevron`, `.change-detail`).
- Why-comments are load-bearing — preserve verbatim when moving code.
- New DOM in the overlay: buttons/selects go through `src/client/ui/` factories; plain spans/divs use `document.createElement` (the factory rule covers buttons/selects only).
- Client bundle budget: 250KB (currently ~236KB) — enforced by the existing budget test; comments inside the overlay CSS *string* cost bundle bytes, so annotate in JS comments outside the string.
- All commands run from `packages/the-forge/` unless noted; the root gate is `npm test` from the repo root.
- jsdom cannot prove visuals — Task 4 does a real-browser pass in the demo app.

---

### Task 1: `DraftStore.changeCount()`

**Files:**
- Modify: `packages/the-forge/src/client/drafts.ts` (after `elementCount()`, ~line 48)
- Test: `packages/the-forge/tests/client/drafts.test.ts`

**Interfaces:**
- Consumes: nothing new.
- Produces: `changeCount(): number` on `DraftStore` — total drafted properties summed across all elements. Task 2 calls it from `index.ts`.

- [ ] **Step 1: Write the failing test**

Add to `tests/client/drafts.test.ts` (match the file's existing element-creation idiom — a `document.createElement('div') as unknown as TaggedElement` cast or its local helper):

```ts
it('changeCount() sums drafted properties across elements', () => {
  const store = new DraftStore()
  const a = document.createElement('div') as unknown as TaggedElement
  const b = document.createElement('div') as unknown as TaggedElement
  expect(store.changeCount()).toBe(0)
  store.apply(a, 'padding-top', '24px')
  store.apply(a, 'gap', '16px')
  store.apply(a, 'padding-top', '32px') // re-editing the same prop is still ONE change
  store.apply(b, 'background-color', 'rgb(255, 0, 0)')
  expect(store.changeCount()).toBe(3)
  store.discard(a, ['gap'])
  expect(store.changeCount()).toBe(2)
  store.commit(a)
  expect(store.changeCount()).toBe(1)
  store.discardAll()
  expect(store.changeCount()).toBe(0)
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/client/drafts.test.ts`
Expected: FAIL — `store.changeCount is not a function`

- [ ] **Step 3: Write minimal implementation**

In `src/client/drafts.ts`, directly below `elementCount()`:

```ts
  /** Total drafted properties across all elements — the composer pill's "N changes" count.
   * Same cheap Map-size read as elementCount(); a draft scrubbed back to its exact original
   * still counts (no-ops are only detectable at send time via computed styles — see
   * buildChangeRequestWithElements), matching elementCount()'s identical blind spot. */
  changeCount(): number {
    let n = 0
    for (const props of this.drafts.values()) n += props.size
    return n
  }
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/client/drafts.test.ts`
Expected: PASS (all tests in file)

- [ ] **Step 5: Commit**

```bash
git add packages/the-forge/src/client/drafts.ts packages/the-forge/tests/client/drafts.test.ts
git commit -m "feat(client): DraftStore.changeCount() — drafted-property total for the pill"
```

---

### Task 2: Pill counts changes + chevron mirrors open state

**Files:**
- Modify: `packages/the-forge/src/client/session-feed.ts` (pill construction ~line 250, `setDraftState` ~line 358)
- Modify: `packages/the-forge/src/client/index.ts` (`updateDraftPill` ~line 305, and the `elementCount` mention in the comment at ~line 293)
- Modify: `packages/the-forge/src/client/overlay.ts` (`.draft-pill` CSS block ~line 649)
- Test: `packages/the-forge/tests/client/session-feed.test.ts` (~lines 217–270), `packages/the-forge/tests/client/design-mode.test.ts` (~line 1302)

**Interfaces:**
- Consumes: `DraftStore.changeCount(): number` from Task 1.
- Produces: pill DOM shape `button.draft-pill > span.draft-pill-label + span.draft-pill-chevron`; `.open` class mirrored on BOTH `.draft-pill` and `.draft-disclosure`. `setDraftState({ count, applying })` signature unchanged — `count` now means changes, not elements.

- [ ] **Step 1: Update existing assertions + write new failing tests**

In `tests/client/session-feed.test.ts`, the label now lives in a child span (the pill also contains the chevron glyph, so `pill.textContent` assertions would see `…▾`). Update the four label assertions:

- `'2 edits drafted'` test (~line 224): rename it `'setDraftState(2, false) unhides the pill with the plural count copy'` body to:

```ts
    feed.setDraftState({ count: 2, applying: false })
    const pill = feed.root.querySelector('.draft-pill') as HTMLElement
    expect(pill.hidden).toBe(false)
    expect(pill.querySelector('.draft-pill-label')!.textContent).toBe('2 changes drafted')
```

- `'1 edit drafted'` test (~line 233): assert `pill.querySelector('.draft-pill-label')!.textContent` is `'1 change drafted'`.
- Both `'applying…'` tests (~lines 241, 250): assert `pill.querySelector('.draft-pill-label')!.textContent` is `'applying…'`.
- The force-close test (~line 259) gains a pill-class assertion — after `pill.click()` add `expect(pill.classList.contains('open')).toBe(true)`, and after the closing `setDraftState({ count: 0, ... })` add `expect(pill.classList.contains('open')).toBe(false)`.

Add two new tests alongside them:

```ts
  it('pill carries a chevron span that never pollutes the label', () => {
    const feed = new SessionFeed()
    document.body.appendChild(feed.root)
    feed.setDraftState({ count: 2, applying: false })
    const pill = feed.root.querySelector('.draft-pill') as HTMLElement
    expect(pill.querySelector('.draft-pill-chevron')!.textContent).toBe('▾')
    expect(pill.querySelector('.draft-pill-label')!.textContent).toBe('2 changes drafted')
  })

  it('clicking the pill mirrors .open onto pill and disclosure together', () => {
    const feed = new SessionFeed()
    document.body.appendChild(feed.root)
    feed.setDraftState({ count: 1, applying: false })
    const pill = feed.root.querySelector('.draft-pill') as HTMLElement
    const disclosure = feed.root.querySelector('.draft-disclosure') as HTMLElement
    pill.click()
    expect(pill.classList.contains('open')).toBe(true)
    expect(disclosure.classList.contains('open')).toBe(true)
    pill.click()
    expect(pill.classList.contains('open')).toBe(false)
    expect(disclosure.classList.contains('open')).toBe(false)
  })
```

In `tests/client/design-mode.test.ts` (~line 1302), replace:

```ts
    expect(pill.textContent).toBe('1 edit drafted')
```

with:

```ts
    expect(pill.querySelector('.draft-pill-label')!.textContent).toBe('1 change drafted')
```

(the `pill` variable there is typed `HTMLElement` — `querySelector` is available; one drafted property = "1 change drafted", so the count value itself doesn't move in this test).

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run tests/client/session-feed.test.ts tests/client/design-mode.test.ts`
Expected: FAIL — `.draft-pill-label` queries return null; `.open` never lands on the pill.

- [ ] **Step 3: Implement**

`src/client/session-feed.ts` — pill construction (~line 250). Keep the existing why-comment block above it verbatim, extend it with the chevron note:

```ts
    // Drafts pill + disclosure (composer consolidation Task 2): the pill is a plain
    // createButton (CLAUDE.md's ui/ factory rule), hidden until setDraftState says otherwise.
    // Its click toggles the sibling draftDisclosure's .open class — draftSlot is exposed
    // publicly so index.ts can append the (unmodified) ChangeList's root into it.
    // Label + chevron are child spans (2026-07-11 draft-badge spec): setDraftState rewrites
    // only the label span, and .open is mirrored onto the pill itself so the chevron can
    // rotate with a same-element CSS hook (the disclosure is a sibling, not a parent).
    this.draftPill = createButton({ className: 'draft-pill' })
    this.draftPill.type = 'button'
    this.draftPill.hidden = true
    this.draftPillLabel = document.createElement('span')
    this.draftPillLabel.className = 'draft-pill-label'
    const draftChevron = document.createElement('span')
    draftChevron.className = 'draft-pill-chevron'
    draftChevron.textContent = '▾'
    this.draftPill.append(this.draftPillLabel, draftChevron)
    this.draftPill.addEventListener('click', () => this.setDisclosureOpen(!this.draftDisclosure.classList.contains('open')))
```

Add the field declaration next to `draftPill` (~line 114):

```ts
  private readonly draftPillLabel: HTMLSpanElement
```

`setDraftState` (~line 358) — label writes go to the span; the force-close path goes through the new helper; copy becomes change-count wording. Keep the method's doc comment, amending "edit(s) drafted" wording if it appears:

```ts
  setDraftState(s: { count: number; applying: boolean }): void {
    this.draftCount = s.count
    const visible = s.count > 0 || s.applying
    this.draftPill.hidden = !visible
    if (!visible) {
      this.setDisclosureOpen(false)
    } else {
      this.draftPillLabel.textContent = s.applying ? 'applying…' : s.count === 1 ? '1 change drafted' : `${s.count} changes drafted`
    }
    // Draft count is one of the two independent signals that can license the send button —
    // see syncSendEnabled (final-review fix C1).
    this.syncSendEnabled()
  }

  /** Single owner of the disclosure's open state — mirrored onto the pill so the chevron
   * rotation has a same-element CSS hook. Every open/close path (pill click, setDraftState's
   * force-close) must come through here or pill and disclosure drift apart. */
  private setDisclosureOpen(open: boolean): void {
    this.draftDisclosure.classList.toggle('open', open)
    this.draftPill.classList.toggle('open', open)
  }
```

`src/client/index.ts` — `updateDraftPill` (~line 305): swap the read and update both comments that name `elementCount` in this pathway:

```ts
      // updateDraftPill() stays immediate (not debounced) alongside refreshStatus() — it only
      // reads drafts.changeCount() (summed Map sizes), nothing scan/stringify-shaped.
```

```ts
  /** Pushes {count, applying} to the SessionFeed's drafts pill (composer consolidation Task 2)
   * — called from drafts.onChange (constructor) and session.onChange (constructor). count is
   * the DraftStore's live change count (drafted properties summed across elements — the
   * 2026-07-11 draft-badge spec: "7 changes", not "2 elements"); applying mirrors ChangeList's
   * own inFlightProps stage predicate ('sent' | 'applying' rows are still in flight). */
  private updateDraftPill(): void {
    const count = this.drafts.changeCount()
    const applying = this.session.records().some((r) => r.stage === 'sent' || r.stage === 'applying')
    this.feed.setDraftState({ count, applying })
  }
```

`src/client/overlay.ts` — extend the `.draft-pill` CSS block (~line 649; the JS comment above the string is where any annotation goes, not inside the string):

```
`.draft-pill {
  flex: none; display: inline-flex; align-items: center; gap: 4px;
  padding: 4px 8px; border-radius: 6px; background: var(--control); border: none;
  font: 500 var(--text-xs) var(--font-ui); color: var(--text-secondary);
}
.draft-pill:hover { background: var(--control-hover); }
.draft-pill-chevron { transition: transform 120ms ease; }
.draft-pill.open .draft-pill-chevron { transform: rotate(180deg); }
.draft-disclosure { display: none; }
.draft-disclosure.open { display: block; }
` +
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run tests/client/session-feed.test.ts tests/client/design-mode.test.ts tests/client/composer-send.test.ts`
Expected: PASS. (`composer-send.test.ts` rides along because it exercises `setDraftState` via the send paths — catch any `textContent` coupling early.)

- [ ] **Step 5: Grep for stragglers**

Run: `grep -rn "edits drafted\|edit drafted" packages/the-forge/src packages/the-forge/tests`
Expected: only comments remain (e.g. `design-mode.test.ts` ~line 1028's prose comment) — update those comment mentions to "changes drafted" while there; no assertion or code hits.

- [ ] **Step 6: Commit**

```bash
git add packages/the-forge/src/client/session-feed.ts packages/the-forge/src/client/index.ts packages/the-forge/src/client/overlay.ts packages/the-forge/tests/client/session-feed.test.ts packages/the-forge/tests/client/design-mode.test.ts
git commit -m "feat(client): drafts pill counts changes and carries an open-state chevron"
```

---

### Task 3: Draft rows list every change as `.change-detail` sub-lines

**Files:**
- Modify: `packages/the-forge/src/client/changelist.ts` (`renderDraftRow` ~line 167)
- Modify: `packages/the-forge/src/client/overlay.ts` (after the `.change-summary` rule, ~line 544)
- Test: `packages/the-forge/tests/client/changelist.test.ts` (draft-row describe block, ~lines 47–106)

**Interfaces:**
- Consumes: `DraftStore.entries()` shape already passed to `renderDraftRow` (`Array<[string, { original: string; value: string }]>`) — unchanged.
- Produces: draft-row DOM `div.change-row[data-stage=draft] > span.chip + span.change-el + div.change-detail×N` (no `.change-summary`, no `title` on draft rows). Sent/applying/done/failed rows unchanged (`summarize`/`collapseWithMore` stay).

- [ ] **Step 1: Update the draft-row tests**

In `tests/client/changelist.test.ts`:

Replace the `'summarizes a multi-prop draft row with +N more, same shape as sent rows'` test (~line 96) — and its preceding R2-minor comment — with:

```ts
  // 2026-07-11 draft-badge spec: draft rows list EVERY drafted property as its own visible
  // .change-detail line — the pill click was the user's opt-in to detail, so nothing hides
  // behind "+N more"/title tooltips here. Sent rows keep the compact collapseWithMore shape
  // (history stays terse) — pinned by 'summarizes multi-change elements with +N more' below.
  it('lists every drafted property as its own .change-detail line, no title tooltip', () => {
    const drafts = new DraftStore()
    const el = tagged()
    const list = new ChangeList(drafts, new LifecycleSession(), noop)
    drafts.apply(el as never, 'padding-top', '24px')
    drafts.apply(el as never, 'margin-top', '8px')
    list.syncDrafts()
    const lines = [...list.root.querySelectorAll('.change-detail')].map((l) => l.textContent)
    expect(lines).toEqual(['padding-top → 24px', 'margin-top → 8px'])
    expect(list.root.querySelector('.change-row [title]')).toBeNull()
    expect(list.root.querySelector('.change-row .change-summary')).toBeNull()
  })
```

Update the in-flight dedup test (~line 85–90): its assertions query `.change-summary` on the draft row — change them to:

```ts
    const draftRow = [...list.root.querySelectorAll('.change-row')].find((r) => r.querySelector('.chip-draft'))
    const details = [...draftRow!.querySelectorAll('.change-detail')].map((l) => l.textContent)
    expect(details.join()).toContain('margin-top')
    expect(details.join()).not.toContain('padding-top')
```

Leave every sent-row test untouched — `'summarizes multi-change elements with +N more'` is now the pin that history rows keep the collapse.

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run tests/client/changelist.test.ts`
Expected: FAIL — `.change-detail` queries return empty; draft row still renders `.change-summary` with `+1 more`.

- [ ] **Step 3: Implement**

`src/client/changelist.ts` — replace `renderDraftRow` (~line 167):

```ts
  private renderDraftRow(el: TaggedElement, props: Array<[string, { original: string; value: string }]>): HTMLElement {
    const row = this.baseRow('draft', el)
    const dcSource = el.dataset?.dcSource ?? null
    const [elLabel] = this.label(el.tagName.toLowerCase(), dcSource)
    row.appendChild(elLabel)
    // Draft rows list EVERY drafted property (2026-07-11 draft-badge spec) — the disclosure
    // is already the user's opt-in to detail, so nothing hides behind "+N more"/title here.
    // The value shown is the inline draft (`prop → value`, no "before"): the DraftStore's
    // recorded original is the prior INLINE style (usually empty) — the real before/after
    // pair only exists at send time via computed styles. Sent rows keep collapseWithMore.
    for (const [prop, d] of props) {
      const line = document.createElement('div')
      line.className = 'change-detail'
      line.textContent = `${prop} → ${d.value}`
      row.appendChild(line)
    }
    return row
  }
```

Note `collapseWithMore` keeps its other caller (`summarize` for sent rows) — trim its doc comment's "both sent-row … and draft-row (renderDraftRow)" claim to sent-rows-only rather than deleting it.

`src/client/overlay.ts` — add after the `.change-summary` rule (~line 544). Annotation goes in a JS comment (CSS-string comments cost bundle bytes); `flex-basis: 100%` wraps each line full-width inside the flex row, same trick `.change-note` uses; the 22px left pad aligns under `.change-el` past the chip:

```
.change-detail {
  flex-basis: 100%; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
  color: var(--text-muted); font: 400 var(--text-xs) var(--font-ui); padding: 0 6px 0 22px;
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run tests/client/changelist.test.ts tests/client/design-mode.test.ts`
Expected: PASS (design-mode rides along — it renders ChangeList through the full client).

- [ ] **Step 5: Commit**

```bash
git add packages/the-forge/src/client/changelist.ts packages/the-forge/src/client/overlay.ts packages/the-forge/tests/client/changelist.test.ts
git commit -m "feat(client): draft rows list every change — no +N more behind a tooltip"
```

---

### Task 4: Full gate, budget, real-browser verification

**Files:**
- No new source changes expected — fixes only if the gate or browser pass surfaces them.

**Interfaces:**
- Consumes: everything above.
- Produces: green root gate + visual proof.

- [ ] **Step 1: Root gate**

Run from the repo root: `npm test`
Expected: typecheck clean, full vitest suite green (~1830+ tests). The client-budget test proves the bundle stays under 250KB.

- [ ] **Step 2: Build + demo app**

```bash
npm run build
npm run dev -w demo-app
```

First check `lsof -iTCP:5173` and kill any stale server (phantom-bug gotcha; it often binds `[::1]:5173`).

- [ ] **Step 3: Real-browser pass** (jsdom can't see layout/visuals)

In the running demo (Design toggle bottom-right):
1. Select one element; draft 3+ properties (e.g. padding, gap, background via Fill).
2. Pill reads "3 changes drafted" (not "1 edit drafted") with a downward chevron.
3. Click the pill — disclosure opens, chevron flips; the element's draft row lists each change as its own line, no "+N more", no reliance on hover.
4. Draft one property on a second element — pill says "4 changes drafted"; two rows, each fully itemized.
5. Send (↑) — pill flips to "applying…"; sent rows show the compact summary ("`pt-2 → pt-6` +N more") as before.
6. Screenshot the open disclosure as proof.

- [ ] **Step 4: Commit any fixes and stop**

If the browser pass surfaced fixes, commit them individually with `fix(client): …` messages. Merge decision belongs to the user (CLAUDE.md) — do not merge; report back with the screenshot.
