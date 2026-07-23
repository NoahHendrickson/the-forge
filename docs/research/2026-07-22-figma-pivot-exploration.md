# Figma Pivot — Exploration (2026-07-22)

Brainstorm-stage exploration for pivoting design mode from a "CSS property editor with Figma
styling" into a genuine Figma-shaped design tool: frames (divs presented as frames), insert /
delete / move / resize, auto-layout and absolute positioning as first-class Figma concepts,
inline text editing — with a **translation layer** that converts design ops into code intent
only at send time. The user never sees margins, `justify-content`, or CSS property names; the
agent still receives deterministic, token-aware, file:line-targeted instructions.

Grounded in two code-mapping passes (edit pipeline; overlay/interaction layer). Not a plan —
the plan doc comes after the brainstorm converges, per repo convention.

---

## 1. The one-sentence architecture

Today the atomic unit of the entire pipeline is `(element, cssProperty, cssValueString)` —
from `DraftStore.apply` (src/client/drafts.ts:19) through `ChangeItem` (src/client/request.ts:5)
to the verifier's computed-style string-compare (src/client/verifier.ts:97). The pivot replaces
that atom with a **discriminated union of design ops**:

```ts
type DesignOp =
  | { kind: 'style';  el: TaggedElement; prop: string; value: string }   // today's world
  | { kind: 'text';   el: TaggedElement; before: string; after: string }
  | { kind: 'delete'; el: TaggedElement }
  | { kind: 'move';   el: TaggedElement; target: MoveTarget }            // reorder | reparent | absolute
  | { kind: 'insert'; anchor: Anchor; ghost: HTMLElement }               // new frame/text ghost
```

introduced at exactly three layers (the pipeline map identified these as the only choke
points): the draft store, the wire format (`ChangeItem`/`SentChange`), and the verifier's
outcome model. Everything else — queue, dispatch, MCP, guardrails, sessions — is
op-agnostic and untouched.

## 2. Why this is feasible: three load-bearing findings

**a. The `intent` seam already proves the model.** Remove-auto-layout ships today as a fake
CSS delta (`display: flex → block`) carrying `ChangeItem.intent` — free text that tells the
agent "the literal delta is a lie; restructure the classes instead"
(src/client/request.ts:67, src/client/panel-layout.ts:111-135). That is precisely the
design-op → code-intent translation the pivot generalizes. We're not inventing the
translation layer; we're promoting an existing escape hatch to the primary mechanism.

**b. Most "structural" previews are actually style previews.** The scary part of a design
tool — showing the result before the code exists — mostly reduces to inline styles the
existing DraftStore machinery already handles, preserving the instant/revertible/O(1)
compare guarantees:

| Design op | Preview mechanism | React-safe? |
| --- | --- | --- |
| Delete | `display: none` inline (tombstone) | ✅ pure CSS |
| Reorder within auto-layout | CSS `order` inline | ✅ pure CSS |
| Free-move / absolute | `position`/`transform`/inset inline | ✅ pure CSS |
| Resize | `width`/`height` inline (exists today) | ✅ pure CSS |
| Text edit | `contenteditable` on the element | ⚠️ same no-re-render assumption drafts already make |
| Insert frame | real "ghost" DOM node | ⚠️ same assumption; ghost dies on re-render, restorable |
| Reparent | actual DOM move | ❌ riskiest — defer (see §7 Q3) |

The whole drafts system already rests on "React doesn't re-render while designing" (that's
why inline styles work at all). Text and insert previews make the same bet, no worse.

**c. Element identity survives structural edits — including inserts.** The tagger runs in
the transform hook, so an agent-inserted JSX element gets `data-dc-source` automatically on
the next HMR transform (src/transform.ts:31-49, vite `enforce:'pre'` serve-mode hook). New
frames become selectable, verifiable, addressable citizens with zero extra work. Line-shift
churn on following elements is already handled by `(dcSource, sourceIndex)` addressing plus
the restore retry drain (src/client/index.ts:684-719).

Bonus: **ghost nodes are measurable.** Because an inserted frame exists in the DOM as a real
(ghost) element, `getComputedStyle` + `suggestUtility` work on it unchanged — a new frame's
padding/fill/gap arrive at the agent as `p-6 bg-slate-100 gap-4`, token-mapped by the
existing tokens.ts math, which is element-agnostic (src/client/tokens.ts:559-634).

## 3. The design surface (what the user touches)

Figma vocabulary only. Concretely, against the current panel (src/client/panel-specs.ts:239-318):

- **Kill the Margin section outright** (it's already conditional via `marginSectionVisible`;
  now it's gone). Margins remain a *code* concept the translation layer may read or write —
  never a designer-facing control.
- **Position row (X, Y)** joins W/H at the top — Figma's header cluster. X/Y are live for
  absolutely-positioned elements and during drag; for flow elements they're read-only until
  a drag converts (see policy, §7 Q4).
- **Auto layout** is already Figma-shaped (direction, gap, 9-dot matrix, Hug/Fill/Fixed) —
  keep, and promote to canvas-level: insertion indicators while dragging, visual gap/padding
  handles later.
- **Text section gains content editing** — click-into-text or Enter starts `contenteditable`;
  today text is styling-only and content is captured read-only for context (request.ts:155).
- Fill / Stroke / Appearance stay as-is — they're already Figma-native.
- **Toolbar verbs**: `F` frame (draw a rect → ghost div), `T` text, `Del` delete, arrows
  nudge, drag to move, 8-point resize handles on the selection outline.

The panel-patterns decisions (docs/research/2026-07-04-panel-patterns.md) mostly survive —
stable section order, Mixed-not-blank, token pills, math expressions all carry over. Two
need explicit re-ratification: the Margin section's existence (spacing decision #1 kept it),
and "raw DOM tree as a layers panel" as an anti-pattern (see §7 Q1 — a *curated frames
tree* is a different artifact than a raw DOM tree, but it deserves its own decision).

## 4. The translation layer (design ops → code intent, at send time)

One new module (working name `src/client/translate.ts`) renders each `DesignOp` into the
existing wire shape — `ElementChange` grows a `kind`, and the markdown grammar gains
op-specific bullet forms next to the current `property: before → after` lines:

- **Reorder** — both ends are source-addressable:
  `Move the element at src/App.tsx:42:8 to be child #2 of src/App.tsx:30:4` (+ the CSS
  `order` preview is explicitly *not* the ask — same "the delta is a lie" pattern as
  remove-auto-layout).
- **Delete** — `Remove the element at src/App.tsx:42:8 and its children`.
- **Insert** — anchor + spec: `Insert a new <div> as the last child of src/App.tsx:30:4 with
  classes \`flex flex-col gap-4 p-6 rounded-xl bg-white\`` — classes derived by measuring
  the ghost through the existing token mapper.
- **Text** — `Change the text "Sign up" → "Get started" in src/Button.tsx:12:6`.
- **Absolute/move** — positioning intent in project vocabulary (`absolute left-6 top-10`,
  or "increase the gap before this element" when the translation decides flow beats
  absolute — the *designer* dragged; the *translator* picks the code idiom).

Deterministic-first still holds where determinism exists (targets, class lists, child
indices); structural ops are inherently slightly more intent-shaped, which is exactly what
`intent` was built for. Guardrails are unchanged — they ride the delivery wrappers, not the
items (src/shared/guardrails.ts), so new op renderings inherit them for free.

## 5. Verification (the second systemic gap)

Today "Implemented" means one thing: computed-CSS string equality after neutralizing our own
inline override. Structural ops need new outcome axes on `ElementVerification`
(src/client/verifier.ts:50-60):

- **Delete** — *inverted polarity*: `locate` returning null is success (today it's the
  `missing` failure counter).
- **Text** — `textContent` equality; `getComputedStyle` can't see text.
- **Reorder** — DOM sibling-index check against the target index.
- **Insert** — post-HMR, a fresh `data-dc-source` appears in the anchor's subtree; verify by
  parent + tag + expected computed styles (the ghost's measured snapshot is the oracle),
  then swap the ghost for the real node and drop the ghost.

The lifecycle stages (draft → sent → applying → done/mismatch) and the changelist carry over
untouched — only the per-op check function is new.

## 6. Interaction layer: what must be built (from the overlay map)

Foundations that exist and carry the load: real multi-select model with source-addressed
persistence (index.ts:60, 843-873), headless canvas pan/zoom with a reusable
drag-then-squelch-click pattern (canvas.ts:504-579), pooled selection outlines with reflow
re-measurement, and ripple.ts — a generic before/after layout-delta engine that becomes the
structural-preview feedback system (needs: include the subject element, lift the 50-cap).

To build, in rough dependency order:

1. **Element drag layer** — a capture-phase `pointerdown/move/up` trio in index.ts beside
   `onClick`. Arbitration with CanvasMode is clean in principle: canvas claims pointerdown
   only for space-hold or middle-button (canvas.ts:508), so plain left-drag on an element is
   free. Drag deltas divide by `state.scale` (viewport→page px). Inside an auto-layout
   parent, drag means reorder (live insertion indicator, `order` preview); free drag is
   gated by the absolute-positioning policy (§7 Q4).
2. **Keyboard verbs** — `onKey` (index.ts:974) currently handles only Escape. Add Del,
   arrows (nudge = spacing/position micro-ops), F, T; must not collide with CanvasMode's
   Space / +/− / Shift+0/1/2 (canvas.ts:450-469).
3. **Resize handles** — 8-point chrome anchored to the selection rect in the overlay;
   drag → W/H drafts through the existing style path.
4. **Inspector gains position** — x/y and parent-relative offsets are currently read and
   discarded (inspector.ts:25-40); add offsets + parent-flex context ("my parent is flex,
   I'm child 3 of 5") for drop-target and reorder logic.
5. **Ghost/insert chrome** — F-draw rectangle, ghost node styled via the normal panel.
6. **Frames tree (layers)** — curated tree over tagged elements only (component file
   boundaries as natural grouping), hover-synced with outlines. Later phase; needs its own
   ratification (§7 Q1).

## 7. Open questions for the brainstorm

1. **Layers panel.** Panel-patterns lists "raw DOM tree as layers panel" as an anti-pattern.
   A *curated* frames tree (tagged elements only, wrapper-div noise collapsed, names derived
   from component/semantic context) is a different thing — in scope? Which phase?
2. **How hard do we hide code concepts?** Margins: fully invisible, or surfaced read-only
   somewhere for debugging trust ("why is there space here I can't grab?")? And is the
   translation layer *allowed* to rewrite an app's margin-based spacing into gap/padding
   when a designer drags — potentially a bigger diff than the designer expects?
3. **Reparenting** (drag into a different parent) is the one preview that requires really
   moving DOM nodes under React — the riskiest primitive. Propose: defer to the final
   phase; reorder-within-parent + insert + delete cover most of the value first.
4. **Absolute-positioning policy.** Figma's default is absolute; the web's is flow. When a
   designer free-drags an element, do we auto-convert to absolute (Figma-true, but plants
   `position:absolute` into real codebases), or prefer flow-preserving intents (reorder /
   spacing) and require an explicit "absolute" toggle or Alt-drag for true free movement?
   Recommendation: flow-first — inside auto-layout, drag = reorder; absolute is opt-in.
5. **Determinism budget.** Structural ops are inherently more intent-like than
   `py-2.5 → py-6`. Is "deterministic targets + intent-shaped operation" an acceptable
   reading of the deterministic-first constraint, or do we need structured op records the
   agent can apply mechanically (e.g. exact JSX snippets in the request)?

## Amendment (2026-07-22) — brainstorm decisions, user-ratified

The five §7 questions resolved with the user (Q3/Q5 delegated to the agent's judgment):

1. **Layers tree: YES — its own new panel on the LEFT side**, Figma-style, not a section of
   the right properties panel. Curated frames tree over tagged elements (not a raw DOM tree
   — the panel-patterns anti-pattern stands for the raw version). Scheduled as its own
   milestone (P2 in the revised phasing below).
2. **Margins are invisible to the user, fully.** No read-only surfacing. Margins remain a
   code concept the translation layer may read/write; the designer never sees the word.
3. **Reparenting deferred to the final phase** (delegated call). It's the only op whose
   preview must physically move React-owned DOM nodes; reorder-within-parent + insert +
   delete cover most value first, and the layers tree (P2) later gives a safer reparent
   surface (drag a layer row) than canvas drag.
4. **Absolute positioning is an explicit per-element toggle** (select element → "Absolute"
   toggle — Figma's own absolute-position model), never an automatic consequence of
   dragging. Drag inside an auto-layout parent means reorder; flow-first confirmed.
5. **Determinism budget** (delegated call): every op carries deterministic *targets*
   (file:line:col of element/parent + child index). **Insert** additionally emits the exact
   JSX snippet (the ghost tells us everything). Move/delete/text state the operation
   precisely but let the agent author the code — dictating exact JSX for edits to existing
   lines would fight real file formatting.

Revised phasing: **P1** op union + text + delete + de-code the panel → **P2** layers tree →
**P3** move & resize (+ absolute toggle) → **P4** insert (frames) → **P5** reparent +
multi-select structural ops + polish. Design contract: docs/specs/2026-07-22-figma-pivot-design.md.

## 8. Suggested phasing (feature branch per milestone, plan doc each)

- **P1 — Op union + the easy structural ops.** Introduce `DesignOp` at the three choke
  points. Ship **text editing** and **delete** end-to-end (preview → translate → verify),
  since both previews are trivial (`contenteditable`, `display:none`) and delete exercises
  the inverted-polarity verifier. Kill the Margin section; add the X/Y/W/H header row.
  This is the smallest slice that proves the whole pivot.
- **P2 — Move & resize.** Element drag layer + canvas arbitration, reorder-in-auto-layout
  with insertion indicators (`order` preview), arrow nudge, 8-point resize handles,
  absolute positioning per the Q4 policy.
- **P3 — Insert (frames).** F-draw frame ghosts, T text ghosts, ghost styling through the
  normal panel + token mapping, insert verification with ghost→real swap.
- **P4 — Frames tree, reparenting, multi-select structural ops, polish.**

Hard constraints all hold: zero new runtime dependencies (everything above is DOM + existing
Babel tagging), zero prod footprint (all client/overlay work behind the same serve-mode
gates), subscription-only delivery unchanged, token-first output actually *strengthened*
(ghost measurement feeds the existing token mapper).
