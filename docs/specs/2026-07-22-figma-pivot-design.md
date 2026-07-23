# Figma Pivot — Design Doc (2026-07-22)

Design contract for pivoting design mode into a Figma-shaped tool. Brainstorm + ratified
decisions: [docs/research/2026-07-22-figma-pivot-exploration.md](../research/2026-07-22-figma-pivot-exploration.md).
This doc owns the cross-milestone contracts; each milestone gets its own dated plan in
docs/plans/.

## 1. Product statement

The user touches only Figma concepts: **frames** (divs presented as frames), auto layout,
absolute position (explicit toggle), fill/stroke/appearance/typography, insert / delete /
move / resize, inline text editing, a left-side **layers tree**. CSS/code concepts — margins,
`justify-content`, property names — are never shown. At send time a **translation layer**
converts design ops into deterministic, token-aware, file:line-targeted code intent for the
agent. Nothing changes about delivery: queue → dispatch ladder / embedded session → MCP →
verify, all op-agnostic.

Ratified UI decisions (2026-07-22): layers tree is a NEW left panel (Figma-style), margins
fully invisible, absolute positioning only via explicit toggle (drag inside auto-layout =
reorder), reparenting last, determinism = exact targets always + exact JSX snippet for
inserts only.

## 2. The op model

The pipeline's atomic unit today is `(element, cssProperty, cssValueString)` end to end.
The pivot introduces a discriminated union of design ops at exactly three choke points —
the draft store, the wire format, the verifier — and nowhere else.

```ts
// request.ts — wire shape (rides inside the existing ElementChange)
export type StructuralOp =
  | { kind: 'text'; before: string; after: string }
  | { kind: 'delete' }
  | { kind: 'move'; toIndex: number }                                  // P3: reorder within parent
  | { kind: 'absolute'; on: boolean }                                  // P3: explicit toggle
  | { kind: 'insert'; tag: string; classes: string; text: string
    ; position: 'child-end' | 'before' | 'after' }                     // P4: anchor = the ElementChange element

export interface ElementChange {
  // ...existing fields (tag, source, className, text, selector) unchanged
  changes: ChangeItem[]        // style deltas — untouched, still the workhorse
  ops?: StructuralOp[]         // structural design ops on/anchored-at this element
}
```

Style edits keep their exact current path (`ChangeItem`, computed measurement, token
mapping, `intent` where needed). Structural ops are a parallel track on the same
`ElementChange`, so element addressing, markdown headings, queueing, persistence and the
changelist all reuse existing plumbing.

### Draft store

The CSS draft map is untouched (its consumer surface is huge and proven). Structural drafts
live beside it:

```ts
// drafts.ts
export type StructuralDraft =
  | { kind: 'text'; original: string; value: string }
  | { kind: 'delete'; priorInlineDisplay: string }

class DraftStore {
  applyText(el: TaggedElement, value: string): void   // records original once; DOM already shows it
  applyDelete(el: TaggedElement): void                // preview = inline display:none; discards el's css drafts
  structuralOf(el: TaggedElement): StructuralDraft | null
  // discard/commit/compare/changeCount/entries all extended to cover structural drafts
}
```

Preview mechanisms (all resting on the same "React doesn't re-render while designing" bet
the inline-style drafts already make):

| Op | Preview | Notes |
| --- | --- | --- |
| text | `contenteditable` on the element; committed to `applyText` on exit | double-click enters, Esc/blur exits (Figma behavior) |
| delete | inline `display: none` | held in the structural draft, NOT a css draft — must never render as a `display` property delta |
| move (reorder) | inline CSS `order` | P3 |
| absolute | inline `position`/inset | P3 |
| insert | real "ghost" DOM node | P4; ghost is measurable → token mapping works on it |
| reparent | actual DOM move | P5 only |

`applyDelete` discards the element's existing css drafts (the user deleted it); text and
style drafts coexist freely.

## 3. Translation (send-time markdown)

Structural ops render as op-specific bullets under the existing per-element heading (which
already carries the deterministic file:line:col target):

- delete — `- Delete this element: remove its JSX (and children) from the source.`
- text — `- Text: "Sign up" → "Get started"`
- move — `- Move this element to be child #N of its parent (reorder the JSX siblings).`
  (the CSS `order` preview is explicitly not the ask — same "the delta is a lie" pattern as
  `REMOVE_AUTO_LAYOUT_INTENT`)
- absolute on — positioning intent in project vocabulary (`absolute left-6 top-10`, parent
  `relative` if needed)
- insert — anchor + full spec with the exact snippet:
  `- Insert as last child of the element above: `<div className="flex flex-col gap-4 p-6 rounded-xl bg-white">…</div>``
  (classes derived by measuring the ghost through the existing `suggestUtility` token mapper)

Determinism policy (ratified): exact targets always; exact JSX snippet for inserts only;
move/delete/text state the operation precisely but let the agent author the code.
Guardrails are untouched — they ride the delivery wrappers (src/shared/guardrails.ts), so
new op renderings inherit them.

## 4. Verification

New outcome axes beside the computed-CSS string compare; stages/changelist unchanged.

- **delete** — inverted polarity: neutralize our `display:none`, then `locateBySource`
  finding NO match = verified; still present at window end = mismatch ("element still
  present"). Known edge: after the agent deletes JSX, a following sibling can shift onto
  the same file:line:col — accepted for P1, noted in the plan.
- **text** — `textContent` equality (`getComputedStyle` can't see text). The style
  verifier's neutralization trick has no text analog (there is no cascade to fall back to),
  so the false-done guard is an **HMR-seen gate**: on Vite, listen for the
  `vite:afterUpdate` window event after send; equality only counts as verified once the
  node was replaced OR an HMR update was seen. On Next (no equivalent event) equality is
  accepted directly — documented residual false-done risk, revisit if it bites.
- **move** — DOM sibling-index check against `toIndex` (P3).
- **insert** — post-HMR a fresh `data-dc-source` appears in the anchor's subtree (the
  transform-hook tagger guarantees this); verify by anchor + tag + expected computed
  styles, then swap ghost → real node (P4).

## 5. The design surface

### Properties panel (right)

- **Margin section: deleted** (ratified — margins fully invisible). The margin RowSpecs,
  `marginSectionVisible`, and the Margin entry leave `SECTIONS`; section order becomes
  Layout → Typography → Fill → Stroke → Appearance. This supersedes panel-patterns
  decision #1's margin half; the stable-order principle itself is unchanged.
- **Header position cluster**: X/Y (read-only for flow elements until P3's absolute
  toggle; offsets measured from `offsetParent`) joins W/H at the top — Figma's header
  cluster.
- **Typography** gains nothing for content (text editing is on-canvas), keeps styles.
- Everything else (auto layout, fill, stroke, appearance, tokens, Mixed, math) carries
  over untouched.

### Canvas verbs

- **Double-click** a text-bearing element → inline text edit (`contenteditable`).
- **Del/Backspace** → delete draft on the selection (guarded against editable targets,
  same `isEditable` rule CanvasMode uses).
- P3: drag-to-move (reorder with live insertion indicator inside auto-layout parents;
  pointer arbitration is clean — CanvasMode claims pointerdown only for space-hold/middle),
  arrow-key nudge, 8-point resize handles, Absolute toggle.
- P4: `F` frame tool (draw rect → ghost div), `T` text tool.

### Layers tree (left panel, P2)

Figma-style tree as its OWN panel on the left (ratified). Curated, not a raw DOM tree:
tagged elements only, wrapper noise collapsed, names derived from tag/component/text
context. Hover-syncs with canvas outlines, click selects (shift for multi), Del works from
the tree. Reparent-by-tree-drag arrives with P5, not P2.

## 6. Phasing

- **P1 — op union + text + delete + de-code the panel.** The union at the three choke
  points; text editing and delete end-to-end (preview → translate → verify); Margin section
  removed; X/Y/W/H header row. Smallest slice proving the whole pivot.
  Plan: docs/plans/2026-07-22-figma-pivot-p1.md.
- **P2 — layers tree** (left panel).
- **P3 — move & resize**: drag-reorder + insertion indicators, nudge, resize handles,
  Absolute toggle.
- **P4 — insert (frames)**: F/T ghosts, ghost styling through the normal panel + token
  mapping, insert verification with ghost→real swap.
- **P5 — reparent** (canvas drag-into-parent AND layers-tree drag), multi-select
  structural ops, polish.

## 7. Constraint compliance

Zero new runtime dependencies (DOM + existing Babel tagging only) · zero prod footprint
(all client/overlay work behind existing serve-mode gates) · subscription-only delivery
unchanged (ops ride the same queue/markdown) · token-first strengthened (ghost measurement
feeds the existing mapper) · complementary-not-replacement unchanged.
