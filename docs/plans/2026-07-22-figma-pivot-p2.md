# Figma Pivot — P2: Layers Tree (left panel)

**Goal:** Milestone P2 of [docs/specs/2026-07-22-figma-pivot-design.md](../specs/2026-07-22-figma-pivot-design.md) —
a Figma-style layers tree as its OWN left-side panel (ratified 2026-07-22): curated (tagged
elements only, untagged wrappers skipped-but-descended), designer-vocabulary labels (divs are
Frames), hover/selection sync with the canvas in both directions, Del works from the tree,
delete-tombstone rows. Reparent-by-tree-drag is P5, not here.

**Architecture:** One new module `src/client/layers.ts` (pure tree math + the LayersTree
component + a lean LeftDock — deliberately NOT a parametrization of dock.ts: the right Dock's
float-mode/resize/tween behavior is proven and stays untouched). Wiring in index.ts only.
Zero server/wire changes. Zero idle overhead: the tree's MutationObserver and listeners exist
only while design mode is on AND the panel is open.

**Branch:** `figma-pivot-p2` (stacked on P1 / PR #44 — rebase if review changes the op union).

## Contract

```ts
// layers.ts
export interface LayerNode {
  el: TaggedElement
  label: string
  children: LayerNode[]
}

/** Curated tree walk: a node per TAGGED element under `root`; untagged elements contribute
 * nothing but are descended through (their tagged descendants attach to the nearest tagged
 * ancestor's children). The overlay host never appears (it mounts on documentElement, and
 * the walk starts at body). */
export function buildLayerTree(root: Element): LayerNode[]

/** Figma vocabulary: direct-text elements label as their trimmed text (24-char cap, "…");
 * else a tag map — div/section/article 'Frame', button 'Button', a 'Link', img/picture
 * 'Image', svg 'Icon', input/textarea/select 'Input', ul/ol 'List', li 'Item', nav/header/
 * footer/main/aside/form capitalized tag; anything else the bare tag name. */
export function layerLabel(el: TaggedElement): string

export interface LayersCallbacks {
  onSelect: (el: TaggedElement, additive: boolean) => void   // row click / shift-click
  onHover: (el: TaggedElement | null) => void                // row enter/leave
  onDelete: (el: TaggedElement) => void                      // Del/Backspace on a focused row
}

export class LayersTree {
  root: HTMLElement            // '.layers-panel' — appended to the overlay shadow root
  constructor(drafts: DraftStore, cb: LayersCallbacks)
  refresh(): void              // rebuild rows from document.body (collapse state survives — WeakSet keyed by element)
  setSelection(els: TaggedElement[]): void  // '.layer-selected' rows; auto-expands ancestors; scrolls first into view
  start(): void                // shows panel + arms the debounced body MutationObserver (childList+subtree only)
  stop(): void                 // hides panel + disconnects observer; idempotent
}

export const LAYERS_WIDTH = 240
export const LAYERS_STORAGE_KEY = 'the-forge:layers'   // { open: boolean }, default open

/** Mirror of Dock's margin push, left side, fixed width: saves/restores any pre-existing
 * inline margin-left VERBATIM; setCanvasActive suspends the push exactly like Dock. */
export class LeftDock {
  constructor(host: HTMLElement)
  enter(): void; exit(): void
  setOpen(open: boolean): void; isOpen(): boolean       // persists to LAYERS_STORAGE_KEY
  setCanvasActive(on: boolean): void
}
```

Row DOM (all class names are test hooks): `.layer-row` with `data-depth`, indent via
`--layer-depth` var; `.layer-chevron` (only when children; toggles `.layer-collapsed` on the
row, hides the subtree); `.layer-label`; `.layer-deleted` when
`drafts.structuralOf(el)?.kind === 'delete'` (tombstones stay visible — the row is how a
delete gets un-done: click → select → discard); `.layer-selected` for current selection.
Rows are real `<div>`s (not ui/button.ts — they're tree items, not buttons); the panel's
header toggle uses `createButton`.

## Wiring (index.ts)

- Constructed with the other chrome; `overlay.attach(layers.root)`. No listeners until start().
- `setActive(true)`: `leftDock.enter()`, and `layers.start()` when the persisted pref is open.
  `setActive(false)`: `layers.stop()`, `leftDock.exit()` (margin restored verbatim).
- `setSelection()` additionally calls `layers.setSelection(this.selection)` — both directions
  stay in sync through the ONE existing selection funnel.
- Callbacks: `onSelect` → `select`/`toggleSelection`; `onHover` → hover outline show/hide;
  `onDelete` → the same delete routine the Del key uses — extracted to a private
  `deleteElements(els)` so canvas-Del and tree-Del can never drift.
- Canvas mode: wherever `dock.setCanvasActive` is called, `leftDock.setCanvasActive` rides
  along (artboard pans behind both panels).
- Refresh triggers: the panel's own debounced MutationObserver (HMR re-renders, agent edits)
  + `drafts.onChange` already funnels through index.ts's refresh path — add `layers.refresh()`
  there (tombstone paint) — + `setSelection` (highlight).
- A `.layers-toggle` button (createButton, fixed top-left, visible only in design mode)
  flips `setOpen`/start/stop.

## Test sketch (tests/client/layers.test.ts + design-mode.test.ts additions)

- buildLayerTree: tagged-only curation; untagged wrapper's tagged children attach to nearest
  tagged ancestor; document order preserved; overlay host absent.
- layerLabel: text label + 24-cap ellipsis; Frame/Button/Image/List/Item map; bare-tag fallback.
- Rows: chevron collapse hides subtree and SURVIVES refresh(); `.layer-deleted` appears for a
  delete-drafted element and clears after discard; click → onSelect(el, false), shift-click →
  (el, true); hover in/out → onHover(el/null); Del on focused row → onDelete(el).
- setSelection: `.layer-selected` on the right rows; collapsed ancestor auto-expands.
- LeftDock: enter+open pushes `margin-left: 240px`; pre-existing inline margin-left survives
  exit verbatim; setCanvasActive suspends/restores; prefs round-trip (corrupt JSON → default).
- design-mode integration: no new document listeners while inactive; activate(open) pushes the
  margin and populates the tree from the fixture DOM; canvas click highlights the row; tree
  click sets `mode.selection`; Del-from-tree tombstones the element (display:none + draft);
  deactivate restores everything.

## Gate

Root `npm test`; `npm run build` + `check-prod-clean.sh` (budget may need another bump — call
it out, don't bury it); real-browser E2E on the demo app: open layers, tree mirrors the three
cards with Figma labels, canvas↔tree selection sync both ways, Del from tree hides a card and
sends/verifies via the embedded session, HMR re-render (agent edit) refreshes the tree.
