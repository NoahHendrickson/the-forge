# Figma Pivot — P1: Op Union + Text + Delete + De-code the Panel

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Milestone P1 of [docs/specs/2026-07-22-figma-pivot-design.md](../specs/2026-07-22-figma-pivot-design.md) —
introduce the design-op union at the pipeline's three choke points (draft store, wire
format, verifier) and ship the two easiest structural ops end-to-end: **inline text
editing** (double-click → contenteditable → send → textContent verify) and **delete**
(Del key → display:none preview → send → inverted-polarity verify). Plus the first
de-code-the-panel moves: the Margin section is removed and an X/Y/W/H header cluster
appears. Smallest slice that proves the whole pivot.

**Architecture:** Style edits keep their exact current path — `StructuralDraft` is a
parallel map inside `DraftStore`, `StructuralOp` a parallel array on `ElementChange`.
No server/queue/MCP changes: ops ride the same `{request, markdown}` POST and the same
markdown delivery wrappers (guardrails untouched). Verifier gains two outcome branches.

**Tech Stack:** TypeScript, vitest + jsdom (unit), real-browser E2E on the demo app
(repo gotcha: jsdom cannot see computed layout — and cannot fire real HMR events).

## Global constraints

- Zero new runtime dependencies; zero prod footprint (all work is client bundle + types).
- Panel/overlay CSS class names are test hooks — extend, don't rename. (Removing the
  Margin *section* is a ratified product change; its test updates are in-scope for Task 6.)
- Why-comments are load-bearing — preserve verbatim when moving code.
- All work from `packages/the-forge/`; single-file runs `npx vitest run tests/client/<f>.test.ts`;
  milestone gate is root `npm test` + real-browser E2E (HANDOFF #4).
- Working branch: `figma-pivot-p1`, branched from the commit carrying this plan + spec.
  Merge decision belongs to the user.

---

### Task 1: `StructuralDraft` in `DraftStore`

**Files:** `src/client/drafts.ts`; `tests/client/drafts.test.ts`

**Contract:**

```ts
export type StructuralDraft =
  | { kind: 'text'; original: string; value: string }
  | { kind: 'delete'; priorInlineDisplay: string }

export class DraftStore {
  // NEW — beside the untouched css map
  applyText(el: TaggedElement, value: string): void
  applyDelete(el: TaggedElement): void
  structuralOf(el: TaggedElement): StructuralDraft | null
  // EXTENDED semantics (signatures unchanged):
  // hasDrafts/elementCount/changeCount — structural drafts count (one each)
  // discard(el)        — restores textContent / inline display (and priorInlineDisplay), drops structural
  // discard(el, props) — targeted css discard NEVER touches structural drafts
  // commit(el)         — forgets structural draft; for text leaves DOM as-is (code owns it now);
  //                      for delete leaves display:none in place until commit (the element IS gone in code)
  // commit(el, props)  — targeted css commit never touches structural
  // compare(el/all)    — text: swaps textContent original↔value; delete: toggles display:none off/on
  // discardAll         — includes structural
  // structuralEntries(): ReadonlyMap<TaggedElement, StructuralDraft>  // for the request builder
}
```

Rules: `applyText` records `original` from `el.textContent` **once** (first call), later
calls only update `value` — mirrors the css `DraftProp` capture rule. `applyDelete` stores
`priorInlineDisplay = el.style.getPropertyValue('display')`, sets inline `display:none`,
and **discards the element's existing css drafts** (user deleted it) — the delete must NOT
create a css `display` draft (it would leak into the request as a property delta).
`applyText` on a delete-drafted element is a no-op; `applyDelete` replaces a text draft.

**Test sketch** (`drafts.test.ts`): text original captured once across two applyText calls;
delete sets display:none and discards css drafts without creating a `display` css entry;
`changeCount` includes structural; targeted css discard/commit leaves structural intact;
`compare(el, true)` shows original text / un-hides deleted element, `compare(el, false)`
restores; `discard` after delete restores `priorInlineDisplay` exactly (including empty).

### Task 2: `StructuralOp` on the wire + markdown rendering

**Files:** `src/client/request.ts`; `tests/client/request.test.ts`

**Contract:**

```ts
export type StructuralOp =
  | { kind: 'text'; before: string; after: string }
  | { kind: 'delete' }
  // move/absolute/insert arrive in P3/P4 — declare only these two now (YAGNI)

export interface ElementChange {
  /* existing fields unchanged */
  changes: ChangeItem[]
  ops?: StructuralOp[]          // omitted (not []) when none — keeps existing JSON stable
}
```

`buildChangeRequestWithElements` iterates `drafts.structuralEntries()` in addition to css
entries. A delete-drafted element produces `{changes: [], ops: [{kind:'delete'}]}` — its
css measurement loop is skipped entirely (nothing to measure through display:none, and its
css drafts were discarded in Task 1). A text draft produces
`{kind:'text', before: draft.original, after: draft.value}` alongside any css changes.
Elements with structural ops must be included even when their css `changes` collapse to
zero no-op deltas (today zero-change elements are dropped — gate that drop on
`ops === undefined`).

`renderMarkdown` bullets (under the existing per-element heading, which already carries
the file:line:col target):

```
- Delete this element: remove its JSX (and children) from the source.
- Text: "Sign up" → "Get started"
```

Text values are JSON-escaped and sliced to 120 chars per side via the shared truncation
spirit — long copy edits state both sides but never flood the queue. Compare/`measureComputed`
paths must not run for delete elements (display:none would measure garbage anyway).

**Test sketch:** delete-only element appears with the delete bullet and no property
bullets; text op renders before→after with quotes escaped; element with text op + padding
draft renders both the property bullet and the text bullet; zero-css-change element WITH
ops survives the no-op drop; JSON round-trip of `ChangeRequest` preserves `ops`; elements
without ops serialize with no `ops` key (existing snapshot tests unchanged).

### Task 3: lifecycle threading (`SentEntry.ops`, dedupe, seeds)

**Files:** `src/client/lifecycle.ts`; `src/client/index.ts` (`pairsToSeeds`,
`prepareSend`, `sendDrafts`); `tests/client/lifecycle.test.ts`

**Contract:**

```ts
export interface SentEntry {
  id: string
  elements: Array<{
    el: TaggedElement
    dcSource: string | null
    index?: number
    draftProps: string[]
    changes: SentChange[]
    ops?: StructuralOp[]        // NEW — mirrors ElementChange.ops
  }>
}
// SentSeed unchanged — it already carries the full ElementChange (seed.change.ops).
// isDuplicate(el, changes) grows an ops param: isDuplicate(el, changes, ops?) —
// a pending delete on el makes ANY new send for el a duplicate; text dedupe keys on
// (kind, after).
```

`prepareSend`/`pairsToSeeds` thread `ops` from `ElementChange` into the `SentEntry`
elements. After a successful queue POST, structural drafts stay applied (same as css
drafts — the preview holds while the agent works).

**Test sketch:** seeds built from a delete-op element carry `ops` into the registered
entry; `isDuplicate` blocks a second identical text send and anything after a pending
delete; existing css-only paths byte-identical (no `ops` key).

### Task 4: verifier branches — delete (inverted polarity) + text (HMR-seen gate)

**Files:** `src/client/verifier.ts`; `tests/client/verifier.test.ts`

**Contract:**

```ts
/** Tracks whether a dev-server code update reached this page since a given moment.
 * Vite fires 'vite:afterUpdate' on window; full reloads trivially count (fresh page).
 * On Next (no equivalent event) hmrSeenSince() returns true always — documented
 * residual false-done risk for surviving-node text verifies (spec §4). */
export class HmrSignal {
  start(): void                       // installs the window listener (design-mode on)
  stop(): void
  mark(): number                      // returns a cursor (monotonic count at send time)
  seenSince(cursor: number): boolean
}
```

`verifyElements` per-element, before the css loop:

- **delete op present:** neutralize our own preview first (stash+strip inline `display`,
  same stash/finally discipline as the existing neutralize block), then re-`locate` from
  the document by dcSource: **no match → the element counts fully verified**; a match →
  one mismatch `{property: 'element', expected: 'deleted', actual: 'still present'}` and
  the preview is restored. Skip the css loop either way. Known edge (accepted, from the
  spec): a following sibling can shift onto the deleted element's file:line:col — a false
  "still present" that resolves as `unverified` at window end, never a false success.
- **text op present:** read `target.textContent`; equality with `after` counts verified
  ONLY IF the located node is not the original drafted node (replacement ⇒ re-mounted
  from code) OR `hmr.seenSince(sendCursor)`. Equality without either signal keeps
  polling (normal window → `unverified`). Inequality after HMR-seen → mismatch
  `{property: 'text', expected, actual}`.
- `handleApplied`'s commit call is per-element as today; a fully-verified delete element
  calls `drafts.commit(el)` (which per Task 1 forgets the structural draft).

`VerifyResult`/`StageEvent` shapes are unchanged — delete/text outcomes ride the existing
`verified`/`mismatched` counters with the sentinel `property` names above (changelist
renders them via Task 5's labels; the counters' per-property unit comment gains the two
sentinels).

**Test sketch (jsdom):** delete op + element removed from doc → verified, commit called;
delete op + element still present → mismatch, preview restored (inline display:none back);
text equality with a replaced node → verified; text equality, surviving node, no HMR
signal → NOT verified (stays pending); same + `HmrSignal` fired → verified; text
inequality after HMR → mismatch with expected/actual. `HmrSignal` unit: mark/seenSince
cursor semantics; `stop()` removes the listener.

### Task 5: canvas verbs — double-click text edit + Del delete + changelist labels

**Files:** `src/client/index.ts`; `src/client/changelist.ts`;
`tests/client/design-mode.test.ts`, `tests/client/changelist.test.ts`

**Contract:**

- `dblclick` (capture, registered/removed in `setActive` beside the existing four): on a
  selected element with direct text (`hasDirectText`, panel-readers), enter text-edit —
  `el.contentEditable = 'plaintext-only'` (fallback `'true'`), focus, select-all. Exit on
  blur or Esc/Enter: `contentEditable` removed, then `drafts.applyText(el, el.textContent ?? '')`
  — a no-change exit applies nothing. While editing: the design-mode `click`/`mousemove`
  capture handlers must let events through to the editable (guard at the top of `onMove`/
  `onClick`), and Esc must not also deselect (consume it).
- `onKey` gains Del/Backspace → `drafts.applyDelete()` for every element in `selection`,
  then deselect (the Figma behavior — selection outline on a hidden element is a lie).
  Guarded by the same editable-target rule CanvasMode uses (`isEditable`, canvas.ts) so
  typing in the composer/panel/text-edit never deletes elements.
- ChangeList rows: a delete-op element labels `Delete <tag>`; a text op labels
  `Text: "<after, truncated 24>"` — both reuse the existing row chrome/classes
  (`.changes-section` hooks unchanged; new modifier class `.change-structural` is an
  addition, satisfying extend-don't-rename).

**Test sketch:** dblclick on text element sets contenteditable and Esc commits via
applyText (spy) without deselecting mid-edit; dblclick on non-text element does nothing;
Del with selection drafts deletes + deselects; Del while focus is in an input/editable
does not; changelist renders the two new labels from seeds with ops.

### Task 6: de-code the panel — Margin section removed, X/Y/W/H header

**Files:** `src/client/panel-specs.ts`, `src/client/panel.ts`, `src/client/panel-readers.ts`,
`src/client/inspector.ts`; `tests/client/panel.test.ts`, `tests/client/panel-specs.test.ts`

**Contract:**

- `SECTIONS` loses the Margin entry; `MARGIN_ROWS`/`marginSectionVisible` and their
  panel.ts wiring are deleted (dead exports removed, tests updated — this is the ratified
  product change, not a rename). Section order: Layout → Typography → Fill → Stroke →
  Appearance. The panel-patterns doc gets a one-line dated amendment recording the
  supersession (margins invisible, 2026-07-22 pivot ratification).
- `InspectorData` gains `x: number; y: number` — `Math.round(el.offsetLeft/offsetTop)`
  relative to `offsetParent` (0 for non-HTMLElement/SVG edge cases). `buildInspectorData`
  is the only producer.
- Panel header: an X/Y row above W/H using the existing `.nf` field chrome,
  `data-props="x"`/`data-props="y"`, **disabled** (read-only) in P1 — they light up with
  P3's Absolute toggle. Values refresh on `onEdited`/reflow like W/H do.

**Test sketch:** no `.section-margin` root renders for an element with margins (the old
visibility test inverts); section order assertion updated; `data-props="x"` field exists,
is disabled, and shows the offsetLeft-derived value; `InspectorData.x/y` present for a
plain div (jsdom offsets are 0 — assert presence/type, real values are E2E's job).

### Task 7: milestone gate

- [ ] Root `npm test` green (typecheck + full suite).
- [ ] `npm run build` then real-browser E2E on the demo app (kill stale 5173 first):
  double-click headline → edit text → ↑ send → cold-context subagent applies the markdown
  (HANDOFF #6) → verifier flips the row to Implemented via the HMR-seen path; Del a card →
  send → subagent deletes the JSX → row Implemented via the inverted-polarity path; Margin
  section absent on a margined element; X/Y header shows real offsets; a plain css edit
  (padding) still round-trips Implemented (regression).
- [ ] `./scripts/check-prod-clean.sh` (client bundle grew — budget check).
- [ ] Update HANDOFF state line + auto-memory at the milestone boundary.
