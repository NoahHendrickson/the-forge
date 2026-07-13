# Chat Composer Chip Consolidation + Message Rendering Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** One unified chip inside the input box, a primed accent glow when there's something to send, full-width user bubbles, plain assistant text, and the sent message anchored to the top of the feed while the reply streams below.

**Architecture:** All work is in the browser overlay client: `src/client/session-feed.ts` (DOM/behavior) and `src/client/overlay.ts` (the CSS string). The element chip (`.chat-chip`) retires; `.draft-pill` absorbs it, rendered by a single `updateChip()` owner. `.composer-chips` moves inside `.chat-input`, which becomes the bordered box. A `.feed-tail-spacer` (never a session row) makes anchor-at-top scrolling possible.

**Tech Stack:** TypeScript, vanilla DOM in a shadow root, vitest + jsdom. No new dependencies (hard constraint).

**Spec:** `docs/specs/2026-07-12-chat-composer-chip-design.md`. One recorded deviation: the spec sketched the × as a child span of the pill button — a button cannot nest an interactive child (invalid HTML, broken click routing), so the × is a **sibling button** inside a `.composer-chip` container div styled as one chip. Both buttons go through `createButton` (ui/ factory rule).

## Global Constraints

- Zero new runtime dependencies; no schema libraries; `unknown` + manual checks at I/O boundaries.
- CSS class names are test hooks — extend, don't rename. This milestone's user-approved exceptions: `.chat-chip` / `.chat-chip-clear` retire; `.composer-chips:empty` rule is replaced by `hidden`-attr management.
- New buttons go through `src/client/ui/button.ts`'s `createButton` — never raw `document.createElement('button')`.
- Why-comments are load-bearing — preserve them verbatim when moving code; adjust only the parts the change falsifies.
- Comments inside the CSS template string cost bundle bytes — keep commentary as JS comments between the concatenated string segments (existing idiom in overlay.ts).
- jsdom cannot see layout/computed styles — visual claims are verified by the Task 5 browser E2E, not unit tests.
- Run all tests from `packages/the-forge/`: `npx vitest run tests/client/<file>.test.ts`. Root gate: `npm test` from repo root.
- Branch: `feat/chat-composer-chip` (already created; spec committed).

---

### Task 1: Unified chip — markup, `updateChip()`, behavior, test migration

**Files:**
- Modify: `packages/the-forge/src/client/session-feed.ts` (fields ~130–150, constructor ~221–261, `setChip` ~339, `setDraftState` ~358)
- Test: `packages/the-forge/tests/client/session-feed.test.ts`
- Test (migrate): `packages/the-forge/tests/client/design-mode.test.ts`, `packages/the-forge/tests/client/composer-send.test.ts`

**Interfaces:**
- Consumes: existing `createButton` (`../client/ui/button.ts` — already imported), existing `setDisclosureOpen(open: boolean)`, `syncSendEnabled()`.
- Produces (later tasks and hosts rely on):
  - `setChip(el: { source: string; tag: string; label: string } | null): void` — signature unchanged.
  - `setDraftState(s: { count: number; applying: boolean }): void` — signature unchanged.
  - `getChip(): { source: string; tag: string } | null` — unchanged.
  - DOM contract: `.composer-chips` (wrapper, `hidden` when nothing to show) > `.composer-chip` (visual chip) > `button.draft-pill` (> `.draft-pill-label`, `.draft-pill-el`, `.draft-pill-chevron`) + `button.draft-pill-clear`.
  - `.chat-input` carries class `has-items` whenever the chip is visible (Task 2 styles it).
  - Labels: `applying…` | `1 change` | `N changes`; element-only shows the element label; both shows `N changes` + `· <label>`.

- [ ] **Step 1: Write the failing tests**

In `packages/the-forge/tests/client/session-feed.test.ts`, add after the existing `composer shell` describe (reuse the file's existing helpers; no stream needed — these are direct-setter tests):

```ts
// ---------------------------------------------------------------------------
// Unified chip (chat-composer-chip spec): one chip carries drafts count AND the
// attached element — .chat-chip retired, .draft-pill absorbed its job.
// ---------------------------------------------------------------------------

describe('unified chip', () => {
  function parts(feed: SessionFeed) {
    return {
      chips: feed.root.querySelector('.composer-chips') as HTMLElement,
      pill: feed.root.querySelector('.draft-pill') as HTMLButtonElement,
      label: feed.root.querySelector('.draft-pill-label') as HTMLElement,
      el: feed.root.querySelector('.draft-pill-el') as HTMLElement,
      chevron: feed.root.querySelector('.draft-pill-chevron') as HTMLElement,
      clear: feed.root.querySelector('.draft-pill-clear') as HTMLButtonElement,
      input: feed.root.querySelector('.chat-input') as HTMLElement,
    }
  }

  it('is hidden with no drafts and no element, and .chat-chip is gone', () => {
    const feed = new SessionFeed()
    const p = parts(feed)
    expect(p.chips.hidden).toBe(true)
    expect(feed.root.querySelector('.chat-chip')).toBeNull()
    expect(p.input.classList.contains('has-items')).toBe(false)
  })

  it('drafts only: count label + chevron, no element span, no ×', () => {
    const feed = new SessionFeed()
    feed.setDraftState({ count: 3, applying: false })
    const p = parts(feed)
    expect(p.chips.hidden).toBe(false)
    expect(p.label.textContent).toBe('3 changes')
    expect(p.label.hidden).toBe(false)
    expect(p.chevron.hidden).toBe(false)
    expect(p.el.hidden).toBe(true)
    expect(p.clear.hidden).toBe(true)
  })

  it('singular count reads "1 change"', () => {
    const feed = new SessionFeed()
    feed.setDraftState({ count: 1, applying: false })
    expect(parts(feed).label.textContent).toBe('1 change')
  })

  it('applying wins the label over a nonzero count', () => {
    const feed = new SessionFeed()
    feed.setDraftState({ count: 2, applying: true })
    expect(parts(feed).label.textContent).toBe('applying…')
  })

  it('element only: element label + ×, no count label, no chevron', () => {
    const feed = new SessionFeed()
    feed.setChip({ source: 'src/App.tsx:12:3', tag: 'div', label: 'div · App.tsx:12' })
    const p = parts(feed)
    expect(p.chips.hidden).toBe(false)
    expect(p.el.textContent).toBe('div · App.tsx:12')
    expect(p.el.hidden).toBe(false)
    expect(p.label.hidden).toBe(true)
    expect(p.chevron.hidden).toBe(true)
    expect(p.clear.hidden).toBe(false)
  })

  it('both: count label plus ·-prefixed element label, chevron and ×', () => {
    const feed = new SessionFeed()
    feed.setDraftState({ count: 2, applying: false })
    feed.setChip({ source: 'src/App.tsx:12:3', tag: 'div', label: 'div · App.tsx:12' })
    const p = parts(feed)
    expect(p.label.textContent).toBe('2 changes')
    expect(p.el.textContent).toBe('· div · App.tsx:12')
    expect(p.chevron.hidden).toBe(false)
    expect(p.clear.hidden).toBe(false)
  })

  it('× detaches the element only — drafts stay', () => {
    const feed = new SessionFeed()
    feed.setDraftState({ count: 2, applying: false })
    feed.setChip({ source: 'x:1:1', tag: 'div', label: 'div' })
    parts(feed).clear.click()
    const p = parts(feed)
    expect(feed.getChip()).toBeNull()
    expect(p.el.hidden).toBe(true)
    expect(p.chips.hidden).toBe(false)
    expect(p.label.textContent).toBe('2 changes')
  })

  it('pill click toggles the disclosure only when drafts exist', () => {
    const feed = new SessionFeed()
    const disclosure = feed.root.querySelector('.draft-disclosure') as HTMLElement
    feed.setChip({ source: 'x:1:1', tag: 'div', label: 'div' })
    parts(feed).pill.click()
    expect(disclosure.classList.contains('open')).toBe(false)
    feed.setDraftState({ count: 1, applying: false })
    parts(feed).pill.click()
    expect(disclosure.classList.contains('open')).toBe(true)
  })

  it('disclosure force-closes when drafts vanish even with an element attached', () => {
    const feed = new SessionFeed()
    feed.setDraftState({ count: 1, applying: false })
    parts(feed).pill.click()
    feed.setChip({ source: 'x:1:1', tag: 'div', label: 'div' })
    feed.setDraftState({ count: 0, applying: false })
    const disclosure = feed.root.querySelector('.draft-disclosure') as HTMLElement
    expect(disclosure.classList.contains('open')).toBe(false)
    expect(parts(feed).chips.hidden).toBe(false) // element keeps the chip visible
  })

  it('has-items on .chat-input tracks chip visibility', () => {
    const feed = new SessionFeed()
    const input = feed.root.querySelector('.chat-input') as HTMLElement
    feed.setChip({ source: 'x:1:1', tag: 'div', label: 'div' })
    expect(input.classList.contains('has-items')).toBe(true)
    feed.setChip(null)
    expect(input.classList.contains('has-items')).toBe(false)
    feed.setDraftState({ count: 1, applying: false })
    expect(input.classList.contains('has-items')).toBe(true)
    feed.setDraftState({ count: 0, applying: false })
    expect(input.classList.contains('has-items')).toBe(false)
  })
})
```

- [ ] **Step 2: Run the new tests to verify they fail**

Run (from `packages/the-forge/`): `npx vitest run tests/client/session-feed.test.ts -t 'unified chip'`
Expected: FAIL — `.draft-pill-el` / `.draft-pill-clear` queries return null; `.chat-chip` still present.

- [ ] **Step 3: Implement the unified chip in session-feed.ts**

3a. Fields (~lines 135–149): replace the pill/chip field block with:

```ts
  private readonly draftPill: HTMLButtonElement
  private readonly draftPillLabel: HTMLSpanElement
  private readonly draftPillEl: HTMLSpanElement
  private readonly draftChevron: HTMLSpanElement
  private readonly pillClear: HTMLButtonElement
  private readonly draftDisclosure: HTMLElement
```

Delete the `chip`/`chipLabel` fields (keep `inputCluster`, `textarea`, `sendBtn`, `disabledReason`). Keep the `currentChip` field and its why-comment verbatim. Next to `draftCount`, add:

```ts
  /** Mirrors setDraftState's `applying` — updateChip needs both halves of the drafts signal,
   * and setDraftState must not be the only place that can recompute the pill text. */
  private draftApplying = false
```

3b. Constructor: delete the `.chat-chip` construction block (lines ~221–231) and replace the drafts-pill block (~233–261) with (preserve the original block's why-comment, extended):

```ts
    // Unified chip (2026-07-12 chat-composer-chip spec): ONE chip carries both the pending-
    // drafts state and the attached element — .chat-chip retired, .draft-pill absorbed its
    // job. The visual chip (.composer-chip) holds TWO sibling buttons, because a button
    // cannot nest an interactive child: .draft-pill (count label + element label + chevron;
    // click toggles the sibling draftDisclosure's .open class, drafts permitting) and
    // .draft-pill-clear (× — detaches the element, the old .chat-chip-clear contract: no
    // host callback, hosts read the element via getChip()). Both are createButton (CLAUDE.md
    // ui/ factory rule). All label/visibility rendering flows through updateChip() — the
    // single owner — so setChip and setDraftState can each fire without knowing the other's
    // state. .open is mirrored onto the pill itself so the chevron can rotate with a
    // same-element CSS hook (the disclosure is a sibling, not a parent).
    this.draftPill = createButton({ className: 'draft-pill' })
    this.draftPill.type = 'button'
    this.draftPillLabel = document.createElement('span')
    this.draftPillLabel.className = 'draft-pill-label'
    this.draftPillEl = document.createElement('span')
    this.draftPillEl.className = 'draft-pill-el'
    this.draftPillEl.hidden = true
    this.draftChevron = document.createElement('span')
    this.draftChevron.className = 'draft-pill-chevron'
    this.draftChevron.textContent = '▾'
    this.draftChevron.setAttribute('aria-hidden', 'true')
    this.draftPill.append(this.draftPillLabel, this.draftPillEl, this.draftChevron)
    this.draftPill.addEventListener('click', () => {
      if (this.draftCount > 0 || this.draftApplying) {
        this.setDisclosureOpen(!this.draftDisclosure.classList.contains('open'))
      }
    })
    this.pillClear = createButton({ label: '×', className: 'draft-pill-clear' })
    this.pillClear.type = 'button'
    this.pillClear.setAttribute('aria-label', 'Detach element')
    this.pillClear.hidden = true
    this.pillClear.addEventListener('click', () => this.setChip(null))
    const composerChip = document.createElement('div')
    composerChip.className = 'composer-chip'
    composerChip.append(this.draftPill, this.pillClear)

    this.draftSlot = document.createElement('div')
    this.draftSlot.className = 'draft-slot'
    this.draftDisclosure = document.createElement('div')
    this.draftDisclosure.className = 'draft-disclosure'
    this.draftDisclosure.append(this.draftSlot)

    // Composer chip row — hidden-attr managed by updateChip (the old `.composer-chips:empty`
    // CSS can't work anymore: the unified chip is always a child, just sometimes blank).
    this.composerChips = document.createElement('div')
    this.composerChips.className = 'composer-chips'
    this.composerChips.hidden = true
    this.composerChips.append(composerChip)
```

Note: `this.draftPill.hidden = true` and the old label-only append disappear — wrapper visibility replaces per-pill visibility.

3c. Replace `setChip` (~line 339, keep its why-comment verbatim, body becomes):

```ts
  setChip(el: { source: string; tag: string; label: string } | null): void {
    this.currentChip = el
    this.updateChip()
  }
```

3d. Replace `setDraftState` (~line 358). Keep the existing why-comment, trimming the sentence about hidden-only-when-nothing (that logic moves to updateChip — say so):

```ts
  setDraftState(s: { count: number; applying: boolean }): void {
    this.draftCount = s.count
    this.draftApplying = s.applying
    this.updateChip()
    // Draft count is one of the two independent signals that can license the send button —
    // see syncSendEnabled (final-review fix C1).
    this.syncSendEnabled()
  }
```

3e. Add `updateChip()` right after `setDraftState`:

```ts
  /** Single renderer for the unified chip (chat-composer-chip spec) — setChip and
   * setDraftState both route here so either signal can flip visibility/labels without
   * knowing the other's derivation. States: drafts only → "N changes" + chevron; element
   * only → element label + ×; both → "N changes · <label>" + chevron + ×; neither → the
   * whole .composer-chips row hidden. `applying` wins the drafts text over a nonzero count —
   * an in-flight send stays "applying…" even while further drafts pile up behind it. The
   * disclosure force-close ALSO lives here (not on wrapper-hidden): the chip can stay
   * visible element-only while the drafts disclosure must still close, or an empty
   * disclosure would show a blank block once the last draft resolves. has-items on
   * .chat-input is the primed-state CSS hook (accent glow — see overlay.ts). */
  private updateChip(): void {
    const draftsVisible = this.draftCount > 0 || this.draftApplying
    const el = this.currentChip
    const visible = draftsVisible || el !== null
    this.composerChips.hidden = !visible
    this.draftPillLabel.hidden = !draftsVisible
    this.draftPillLabel.textContent = !draftsVisible
      ? ''
      : this.draftApplying
        ? 'applying…'
        : this.draftCount === 1
          ? '1 change'
          : `${this.draftCount} changes`
    this.draftPillEl.hidden = el === null
    this.draftPillEl.textContent = el === null ? '' : draftsVisible ? `· ${el.label}` : el.label
    this.draftChevron.hidden = !draftsVisible
    this.pillClear.hidden = el === null
    if (!draftsVisible) this.setDisclosureOpen(false)
    this.inputCluster.classList.toggle('has-items', visible)
  }
```

Ordering note: the constructor builds `inputCluster` AFTER the chip cluster, and `updateChip` is only called from setters (never the constructor), so there is no use-before-init hazard.

- [ ] **Step 4: Run the new tests to verify they pass**

Run: `npx vitest run tests/client/session-feed.test.ts -t 'unified chip'`
Expected: PASS.

- [ ] **Step 5: Migrate the existing assertions in all three suites**

Run: `npx vitest run tests/client/session-feed.test.ts tests/client/design-mode.test.ts tests/client/composer-send.test.ts`
Expected failures, and the exact migrations (mapping: element presence → `.draft-pill-el`; whole-chip visibility → `.composer-chips`; pill visibility → `.composer-chips`; label text drops the word "drafted"):

- `session-feed.test.ts:117-122` ("the element chip lives inside .composer-chips"): assert `chips?.querySelector('.composer-chip')` is not null instead of `.chat-chip`.
- `session-feed.test.ts:192-193`: replace the `.chat-chip` expectation with `.composer-chip`; `.draft-pill` expectation stands.
- `session-feed.test.ts` drafts-pill describe (~lines 218–300): every `pill.hidden` read becomes `chips.hidden` where `const chips = feed.root.querySelector('.composer-chips') as HTMLElement`; label expectations `'2 changes drafted'` → `'2 changes'`, `'1 change drafted'` → `'1 change'`; `'applying…'` unchanged; the chevron assertion (~292) stands.
- `session-feed.test.ts` ~1141–1231 (chip attach/clear tests): `.chat-chip` hidden checks become `.draft-pill-el` hidden checks; the `.chat-chip-clear` click becomes `.draft-pill-clear`.
- `design-mode.test.ts:1410-1414`: `pill.hidden` → query `.composer-chips` and check its `hidden`; label `'1 change drafted'` → `'1 change'`.
- `design-mode.test.ts:1535-1537`: `.chat-chip` → `.draft-pill-el` (its `textContent` still `toContain('button · Button.tsx:42')` — element-only state has no `·` prefix beyond the label's own).
- `design-mode.test.ts:1550, 1581`: `(querySelector('.chat-chip')).hidden).toBe(true)` → `(querySelector('.draft-pill-el') as HTMLElement).hidden).toBe(true)`.
- `composer-send.test.ts:17-19`: `chipOf` returns `feed.root.querySelector('.draft-pill-el') as HTMLElement`; any `hidden` assertions on it keep working.

Search-and-verify no straggler: `grep -rn 'chat-chip' packages/the-forge/tests packages/the-forge/src/client/session-feed.ts` — only `overlay.ts` CSS + `overlay.test.ts` may still match (Task 2 handles those).

- [ ] **Step 6: Run the three suites to verify they pass**

Run: `npx vitest run tests/client/session-feed.test.ts tests/client/design-mode.test.ts tests/client/composer-send.test.ts`
Expected: PASS.

- [ ] **Step 7: Typecheck + commit**

```bash
npm run typecheck -w forge-mode
git add packages/the-forge/src/client/session-feed.ts packages/the-forge/tests/client/session-feed.test.ts packages/the-forge/tests/client/design-mode.test.ts packages/the-forge/tests/client/composer-send.test.ts
git commit -m "feat(client): unified composer chip — draft-pill absorbs the element chip"
```

---

### Task 2: Chips row inside the input box + primed-state CSS

**Files:**
- Modify: `packages/the-forge/src/client/session-feed.ts` (constructor append order, ~lines 266–294 and ~325–327)
- Modify: `packages/the-forge/src/client/overlay.ts` (composer CSS block ~lines 655–734)
- Test: `packages/the-forge/tests/client/session-feed.test.ts`, `packages/the-forge/tests/client/overlay.test.ts`

**Interfaces:**
- Consumes: Task 1's `.composer-chip` DOM and `has-items` class.
- Produces: `.composer-chips` is a child of `.chat-input` (before the textarea); `.chat-input` is the bordered box with `:focus-within` accent and `.has-items` glow; `.chat-textarea` is borderless. `.chat-composer` child order becomes `[.draft-disclosure, .chat-input, .composer-controls]`.

- [ ] **Step 1: Write the failing test**

In `session-feed.test.ts`, add to the `unified chip` describe:

```ts
  it('the chips row renders inside .chat-input, above the textarea', () => {
    const feed = new SessionFeed()
    const input = feed.root.querySelector('.chat-input') as HTMLElement
    const chips = input.querySelector('.composer-chips')
    expect(chips).not.toBeNull()
    const children = Array.from(input.children)
    expect(children.indexOf(chips as Element)).toBeLessThan(children.indexOf(input.querySelector('.chat-textarea')!))
  })
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npx vitest run tests/client/session-feed.test.ts -t 'chips row renders inside'`
Expected: FAIL — `.composer-chips` is a sibling of `.chat-input`, not a child.

- [ ] **Step 3: Move the chips row in session-feed.ts**

In the constructor, change the input-cluster append (~line 294) to:

```ts
    this.inputCluster.append(this.composerChips, this.disabledReason, this.textarea)
```

and the composer assembly (~line 327) to drop `composerChips` (adjust the block's why-comment: the chips row now lives inside the input box — chat-composer-chip spec):

```ts
    this.chatComposer.append(this.draftDisclosure, this.inputCluster, this.composerControls)
```

- [ ] **Step 4: Run the client suites**

Run: `npx vitest run tests/client/session-feed.test.ts tests/client/design-mode.test.ts tests/client/composer-send.test.ts`
Expected: PASS (queries in migrated tests are subtree-agnostic).

- [ ] **Step 5: Restyle in overlay.ts**

5a. Replace the `.chat-chip`/`.chat-chip-clear` rules (inside the composer CSS segment, ~lines 681–690) with the unified-chip rules, and drop the `.composer-chips:empty` line (hidden-attr managed since Task 1):

```
.composer-chips { display: flex; align-items: center; gap: 6px; flex-wrap: wrap; }
.composer-chip {
  display: inline-flex; align-items: center;
  border-radius: 6px; background: var(--surface);
}
.composer-chip .draft-pill { background: none; }
.composer-chip .draft-pill:hover { background: var(--control-hover); }
.draft-pill-el { font: 400 var(--text-xs) var(--font-mono); color: var(--text-secondary); }
.draft-pill-clear {
  background: none; border: none; color: var(--text-faint); padding: 0 6px 0 2px;
  font: 500 var(--text-sm) var(--font-ui); border-radius: 4px;
}
.draft-pill-clear:hover { color: var(--text-primary); }
```

Update the JS comment above the segment: `.chat-chip` retired → `.composer-chip` (unified chip, 2026-07-12 chat-composer-chip spec); note the chip sits INSIDE `.chat-input` now. In the `.draft-pill` base rule (~line 714), the pill keeps its padding/font but its `background: var(--control)` moves to `.composer-chip` (delete the `background:` declaration from `.draft-pill`; `.composer-chip` carries the chip surface — `var(--surface)` so it reads against the input box's `var(--control)` fill).

5b. Replace the `.chat-input`/`.chat-textarea` segment (~lines 727–734) with (JS comment above it: the input box is now the bordered surface — chip row + textarea inside; focus moved to :focus-within; has-items = primed glow, the rgba is --accent (#0D99FF) at 15%, same hardcoded-tint idiom as .tp-pill):

```
.chat-input {
  display: flex; flex-direction: column; gap: 6px;
  border: 1px solid var(--border-panel); border-radius: 8px; background: var(--control);
  padding: 6px; transition: border-color 120ms, box-shadow 120ms;
}
.chat-input:focus-within { border-color: var(--accent); }
.chat-input.has-items { border-color: var(--accent); box-shadow: 0 0 0 2px rgba(13,153,255,0.15); }
.chat-textarea {
  box-sizing: border-box; width: 100%; resize: vertical; min-height: 40px;
  background: none; color: var(--text-primary); border: none;
  padding: 0; font: 400 var(--text-sm)/1.4 var(--font-ui); outline: none;
}
.chat-textarea:disabled { opacity: 0.5; }
```

(The old `.chat-textarea:focus { border-color: var(--accent); }` rule is deleted — the wrapper owns focus now.)

- [ ] **Step 6: Update overlay.test.ts CSS assertions**

At `overlay.test.ts:619` (and its surrounding expectations), replace `expect(CSS).toContain('.chat-chip')` with:

```ts
    expect(CSS).toContain('.composer-chip')
    expect(CSS).toContain('.chat-input:focus-within')
    expect(CSS).toContain('.chat-input.has-items')
    expect(CSS).not.toContain('.chat-chip')
```

- [ ] **Step 7: Run the suites**

Run: `npx vitest run tests/client/overlay.test.ts tests/client/session-feed.test.ts`
Expected: PASS.

- [ ] **Step 8: Typecheck + commit**

```bash
npm run typecheck -w forge-mode
git add packages/the-forge/src/client/session-feed.ts packages/the-forge/src/client/overlay.ts packages/the-forge/tests/client/session-feed.test.ts packages/the-forge/tests/client/overlay.test.ts
git commit -m "feat(client): chip row inside the input box + primed has-items glow"
```

---

### Task 3: Message rendering — full-width user bubbles, plain assistant text, streaming caret

**Files:**
- Modify: `packages/the-forge/src/client/overlay.ts` (chat rendering segment ~lines 635–653; keyframes live near the motion block)
- Test: `packages/the-forge/tests/client/overlay.test.ts`

**Interfaces:**
- Consumes: existing `.chat-user` / `.chat-assistant` / `.chat-streaming` class output from session-feed.ts (unchanged in this task).
- Produces: CSS only — no DOM/behavior contract changes.

- [ ] **Step 1: Write the failing test**

In `overlay.test.ts`, alongside the existing chat CSS expectations (~line 619 area):

```ts
    expect(CSS).toContain('.chat-streaming::after')
    expect(CSS).toContain('@keyframes forge-blink')
    expect(CSS).toContain('.chat-assistant { background: none;')
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npx vitest run tests/client/overlay.test.ts`
Expected: FAIL on all three new assertions.

- [ ] **Step 3: Restyle the chat segment in overlay.ts**

Replace the three rules inside the chat-rendering segment (~lines 641–644) — keep every other rule in the segment; update the segment's JS comment (user bubbles full-width; assistant plain; streaming caret replaces the dashed border — 2026-07-12 chat-composer-chip spec):

```
.chat-msg { flex-direction: column; align-items: flex-start; gap: 2px; white-space: pre-wrap; }
.chat-user { background: var(--control); border-radius: 8px; padding: 8px 10px; }
.chat-assistant { background: none; padding: 3px 0; }
.chat-streaming::after {
  content: '▍'; margin-left: 2px; color: var(--text-faint);
  animation: forge-blink 1s steps(1, end) infinite;
}
```

and add the keyframes next to the existing overlay keyframes (JS comment: streaming caret blink — steps(1, end) = hard on/off, no fade):

```
@keyframes forge-blink { 50% { opacity: 0; } }
```

The old `.chat-streaming { border: 1px dashed var(--border-strong); }` rule is deleted outright.

- [ ] **Step 4: Run the suites**

Run: `npx vitest run tests/client/overlay.test.ts tests/client/session-feed.test.ts`
Expected: PASS (no session-feed behavior changed; `.chat-streaming` class management is untouched).

- [ ] **Step 5: Commit**

```bash
git add packages/the-forge/src/client/overlay.ts packages/the-forge/tests/client/overlay.test.ts
git commit -m "feat(client): full-width user bubbles, plain assistant text, blink caret while streaming"
```

---

### Task 4: Tail spacer + anchor sent message at top

**Files:**
- Modify: `packages/the-forge/src/client/session-feed.ts` (constructor list setup ~210, `user-text` handler ~675, `appendDelta` ~793, `addRow` ~908)
- Modify: `packages/the-forge/src/client/overlay.ts` (one rule in the session-list segment)
- Test: `packages/the-forge/tests/client/session-feed.test.ts`

**Interfaces:**
- Consumes: `this.list` (`.session-list`), `makeUserBubble`, `addRow`, `rowList`/MAX_ROWS eviction.
- Produces: `.feed-tail-spacer` — always the last child of `.session-list`, never in `rowList`; private `anchorToTop(row)` / `updateTailSpacer()`; `addRow` inserts before the spacer.

- [ ] **Step 1: Write the failing tests**

Add to `session-feed.test.ts` (uses the file's existing `makeFetchFn`/`feedLine`/`flush` helpers):

```ts
// ---------------------------------------------------------------------------
// Anchor-at-top (chat-composer-chip spec): the tail spacer makes room so a sent
// user bubble can scroll to the top of the list while the reply streams below.
// ---------------------------------------------------------------------------

describe('feed tail spacer + anchor', () => {
  it('the spacer is the last child of .session-list and rows insert before it', async () => {
    const feed = new SessionFeed({
      fetchFn: makeFetchFn([
        feedLine(1, { kind: 'user-text', text: 'hello' }),
        feedLine(2, { kind: 'assistant-text', text: 'hi' }),
      ]),
    })
    feed.start()
    await flush()
    const list = feed.root.querySelector('.session-list') as HTMLElement
    expect(list.lastElementChild?.className).toBe('feed-tail-spacer')
    expect(list.querySelectorAll('.feed-tail-spacer')).toHaveLength(1)
    expect(list.querySelector('.chat-user')).not.toBeNull()
    feed.stop()
  })

  it('a user-text event anchors its bubble to the top of the list', async () => {
    const scrolls: ScrollIntoViewOptions[] = []
    ;(HTMLElement.prototype as { scrollIntoView?: (o?: ScrollIntoViewOptions) => void }).scrollIntoView =
      function (o?: ScrollIntoViewOptions) { scrolls.push(o ?? {}) }
    try {
      const feed = new SessionFeed({ fetchFn: makeFetchFn([feedLine(1, { kind: 'user-text', text: 'hello' })]) })
      feed.start()
      await flush()
      expect(scrolls).toEqual([{ block: 'start' }])
      feed.stop()
    } finally {
      delete (HTMLElement.prototype as { scrollIntoView?: unknown }).scrollIntoView
    }
  })

  it('the spacer survives MAX_ROWS eviction and never enters the row cap', async () => {
    const lines = Array.from({ length: 205 }, (_, i) => feedLine(i + 1, { kind: 'user-text', text: `m${i}` }))
    const feed = new SessionFeed({ fetchFn: makeFetchFn(lines) })
    feed.start()
    await flush(500)
    const list = feed.root.querySelector('.session-list') as HTMLElement
    expect(list.lastElementChild?.className).toBe('feed-tail-spacer')
    expect(list.querySelectorAll('.chat-user')).toHaveLength(200)
    feed.stop()
  })
})
```

(jsdom has no `scrollIntoView` — the test installs and removes its own; in the implementation the call is optional-chained so the un-stubbed case never throws.)

- [ ] **Step 2: Run them to verify they fail**

Run: `npx vitest run tests/client/session-feed.test.ts -t 'feed tail spacer'`
Expected: FAIL — no `.feed-tail-spacer` element exists.

- [ ] **Step 3: Implement spacer + anchor in session-feed.ts**

3a. Fields (near `rowList`):

```ts
  /** Non-row last child of .session-list — sized on send so the just-sent user bubble can
   * scroll to the TOP of the list viewport while the reply streams in below (claude.ai
   * anchoring). Never enters rowList/MAX_ROWS; addRow inserts BEFORE it. */
  private readonly tailSpacer: HTMLElement
  /** The user bubble currently anchored at the viewport top, if any — updateTailSpacer
   * shrinks the spacer as content accumulates below it; nulled when eviction removes it. */
  private anchorRow: HTMLElement | null = null
```

3b. Constructor, right after `this.list.className = 'session-list'`:

```ts
    this.tailSpacer = document.createElement('div')
    this.tailSpacer.className = 'feed-tail-spacer'
    this.list.append(this.tailSpacer)
```

3c. `user-text` handler (~675) becomes:

```ts
      case 'user-text': {
        const text = typeof e.text === 'string' ? e.text : ''
        const element = typeof e.element === 'object' && e.element !== null ? (e.element as Record<string, unknown>) : undefined
        const bubble = this.makeUserBubble(text, element)
        this.addRow(bubble)
        this.anchorToTop(bubble)
        break
      }
```

3d. `addRow` — insert before the spacer, guard the anchor on eviction, keep the spacer sized:

```ts
  private addRow(row: HTMLElement): void {
    this.rowList.push(row)
    this.list.insertBefore(row, this.tailSpacer)
    this.root.hidden = false
    // Cap at MAX_ROWS — drop oldest rows beyond the limit (mirrors the server's ring-buffer cap)
    if (this.rowList.length > MAX_ROWS) {
      const excess = this.rowList.splice(0, this.rowList.length - MAX_ROWS)
      for (const el of excess) el.remove()
      // A still-streaming bubble old enough to be evicted here is now detached from the DOM —
      // if left referenced, the eventual finalizeAssistantText would write the final text into
      // that invisible node instead of a fresh, visible one (final-review fix 5).
      if (this.streamingBubble && excess.includes(this.streamingBubble)) {
        this.clearStreamingBubble()
      }
      // Same staleness hazard for the anchor bubble — a detached anchor would freeze the
      // spacer at its last size forever.
      if (this.anchorRow && excess.includes(this.anchorRow)) this.anchorRow = null
    }
    this.updateTailSpacer()
  }
```

3e. New methods, next to `addRow`:

```ts
  /** Sizes the spacer so `row` CAN reach the viewport top, then anchors it there — without
   * the spacer, scrollIntoView on a short feed is a no-op (nothing below to scroll into the
   * gap) and the streaming reply would render out of view under a bottom-pinned bubble.
   * scrollIntoView is optional-chained: jsdom doesn't implement it (layout-free), and the
   * anchor is purely a visual nicety there. */
  private anchorToTop(row: HTMLElement): void {
    this.anchorRow = row
    this.tailSpacer.style.height = `${Math.max(0, this.list.clientHeight - row.offsetHeight)}px`
    row.scrollIntoView?.({ block: 'start' })
  }

  /** Shrinks the spacer as real content accumulates below the anchor — it only ever holds
   * the space the streaming reply hasn't filled yet, so the feed never scrolls into stale
   * blank tail. All-zero in jsdom (no layout), harmlessly setting height 0. */
  private updateTailSpacer(): void {
    if (this.anchorRow === null || !this.anchorRow.isConnected) return
    const contentBelow = this.tailSpacer.offsetTop - this.anchorRow.offsetTop
    this.tailSpacer.style.height = `${Math.max(0, this.list.clientHeight - contentBelow)}px`
  }
```

3f. End of `appendDelta` (deltas grow a bubble without an addRow): add `this.updateTailSpacer()` after `this.streamingBubble.textContent = this.streamingText`.

3g. overlay.ts, in the session-list CSS segment (~line 607), add (JS comment: anchor-at-top spacer — see session-feed.ts anchorToTop):

```
.feed-tail-spacer { flex: none; }
```

- [ ] **Step 4: Run the suite**

Run: `npx vitest run tests/client/session-feed.test.ts`
Expected: PASS — new describe green, and every pre-existing test that asserted row order/children of `.session-list` still passes (rows now precede the spacer; if any asserts `lastElementChild` is a row, update it to `:scope > .session-row:last-of-type` style queries — check failures individually).

- [ ] **Step 5: Full client sweep + typecheck + commit**

```bash
npx vitest run tests/client
npm run typecheck -w forge-mode
git add packages/the-forge/src/client/session-feed.ts packages/the-forge/src/client/overlay.ts packages/the-forge/tests/client/session-feed.test.ts
git commit -m "feat(client): anchor sent message at feed top via tail spacer"
```

---

### Task 5: Full gate, build, browser E2E

**Files:**
- No planned source changes — fixes only if the gate or E2E finds problems.

**Interfaces:**
- Consumes: everything above.
- Produces: a verified branch ready for PR.

- [ ] **Step 1: Root gate**

Run from repo root: `npm test`
Expected: typecheck + full vitest suite green (~2030 tests).

- [ ] **Step 2: Build + bundle budget**

```bash
npm run build
ls -l packages/the-forge/dist/client.js
```
Expected: build clean; client.js in the same ~236KB neighborhood as before (well under the 250KB client budget from the panel-redesign milestone — CSS-only growth here is small).

- [ ] **Step 3: Browser E2E against the demo app**

Kill stale servers first (`lsof -iTCP:5173`, kill), then `npm run dev -w demo-app`. In Chrome at `http://localhost:5173/` with design mode on, verify:

1. Select an element, edit a property → ONE chip appears inside the input box reading `1 change`; the input box shows the accent border + soft glow.
2. Click Prompt on a selection → the chip gains `· <element label>` and an ×; × removes only the element part; glow persists while drafts remain.
3. Click the chip → the changes disclosure opens (chevron rotates); with an element-only chip, clicking does nothing.
4. Focus the empty textarea → accent border (no glow) via :focus-within.
5. Send with text → your message renders as a full-width bubble and the feed scrolls it to the TOP of the list; the assistant reply streams below it as plain left-aligned text with a blinking ▍ caret while streaming; no stale blank space left at the feed bottom after the reply completes.
6. Send drafts-only → chip flips to `applying…`, then clears when applied; glow drops when nothing is pending.

- [ ] **Step 4: Fix anything the E2E surfaced, re-run `npm test`, commit fixes**

```bash
git add -A packages/the-forge && git commit -m "fix(client): browser E2E fixes for composer chip + anchor pass"
```
(Skip if nothing surfaced.)
