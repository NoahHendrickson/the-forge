/**
 * LayoutSection — the auto-layout cluster extracted from panel.ts (PR #16 promise #1):
 * add/remove-auto-layout policy + FLEX_CONTAINER_PROPS, direction+wrap, gap, the 9-dot
 * align matrix, baseline toggle, and the flex-child (Align/size-mode) controls.
 *
 * This module has no test file of its own — its coverage IS tests/client/panel.test.ts
 * and tests/client/design-mode.test.ts (the move that created this file was behavior-
 * neutral; those two suites assert the DOM hooks this class produces).
 */
import type { TaggedElement } from './source'
import { DraftStore } from './drafts'
import { NumberField } from './controls'
import { createButton } from './ui/button'
import { SegmentField, AlignMatrix } from './layout-controls'
import { PanelTokenUi } from './panel-token-ui'
import { type RowSpec, GAP_SPEC } from './panel-specs'
import { fromPx, isFlex, normalizeJustify, normalizeAlign, mainAxisProp, minMaxRowVisible, alignSelfRowOn } from './panel-readers'

// The container-side flex props the panel can draft — the set 'remove auto layout' must
// clean up alongside display (child props like align-self/flex-grow belong to the CHILD's
// own remove story, not the container's).
export const FLEX_CONTAINER_PROPS = ['flex-direction', 'gap', 'justify-content', 'align-items', 'flex-wrap']

interface BoundSizeMode {
  select: HTMLSelectElement
  spec: RowSpec
  field: NumberField
}

interface BoundMinMaxRow {
  rowEl: HTMLElement
  spec: RowSpec
  field: NumberField
}

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
   * the panel's buildField machinery stays the single place fields are born. Must return a
   * real NumberField (not just `{ root }`): refreshLayoutSection drives it via `.set`/`.setAuto`. */
  buildGapField: () => NumberField
}

export class LayoutSection {
  // Layout section widgets (rebuilt per show(), re-set() per refresh()).
  private directionField: SegmentField | null = null
  private gapField: NumberField | null = null
  private alignMatrix: AlignMatrix | null = null
  private baselineToggle: HTMLButtonElement | null = null
  private wrapToggle: HTMLButtonElement | null = null
  private addLayoutBtn: HTMLElement | null = null
  private removeLayoutBtn: HTMLButtonElement | null = null
  private layoutControlsWrap: HTMLElement | null = null

  // Flex-child widgets.
  private alignSelfField: SegmentField | null = null
  private alignSelfWrap: HTMLElement | null = null
  private flexChildControlsWrap: HTMLElement | null = null
  private alignToggle: HTMLButtonElement | null = null
  private sizeModes: BoundSizeMode[] = []

  // M-D min/max sizing: rows registered per-selection (same lifecycle as sizeModes) plus the
  // opened-set latch — a row a user explicitly opened via "Add min…"/"Add max…" stays visible
  // even before any draft/computed value would disclose it on its own (opened-set ∪ live-draft
  // ∪ non-default-computed, see refreshMinMax). Keyed by CSS prop ('min-width', 'max-height', …).
  private minMaxRows: BoundMinMaxRow[] = []
  private openedMinMax = new Set<string>()

  // Align-self disclosure latch — same per-selection lifecycle as openedMinMax (cleared in
  // teardown): toggling ON without a draft latches the row open; the ON state itself is the
  // canonical alignSelfRowOn predicate (opened ∪ live-draft ∪ non-default-computed).
  private alignOpened = false

  constructor(private deps: LayoutSectionDeps) {}

  /** The edit lifecycle every cluster control shares: bail without a selection, snapshot
   * pre-edit state, mutate drafts, re-render, notify. Centralized so the ~8 click handlers
   * can't drift on ordering. */
  private withEdit(fn: (el: TaggedElement) => void): void {
    const el = this.deps.getEl()
    if (!el) return
    this.deps.onBeforeEdit(el)
    fn(el)
    this.deps.refresh()
    this.deps.onEdited()
  }

  /** The − remove button for the section title (today's buildBody layout-branch block). */
  buildRemoveButton(): HTMLButtonElement {
    const removeBtn = createButton({ label: '−' })
    removeBtn.setAttribute('data-remove-layout', '')
    removeBtn.setAttribute('aria-label', 'Remove auto layout')
    removeBtn.title = 'Remove auto layout — the request tells the agent to drop flex/inline-flex/flex-row/flex-col/flex-wrap/gap-*/justify-*/items-* classes'
    removeBtn.hidden = true
    removeBtn.addEventListener('click', () => {
      this.withEdit((el) => {
        if (this.deps.drafts.current(el, 'display') !== null) {
          // Auto layout was added (or display re-drafted) this session — pure undo: targeted
          // discard restores the recorded originals, so the element returns to its stylesheet
          // reality and there is nothing to send.
          this.deps.drafts.discard(el, ['display', ...FLEX_CONTAINER_PROPS])
        } else {
          // Flex comes from the app's own CSS: draft display:block as the deterministic preview,
          // and discard any container-prop drafts so the request is just the removal.
          this.deps.drafts.discard(el, FLEX_CONTAINER_PROPS)
          this.deps.drafts.apply(el, 'display', 'block')
        }
      })
    })
    this.removeLayoutBtn = removeBtn
    return removeBtn
  }

  /** Appends the cluster's children (add-button + controls-wrap) directly onto `parent` —
   * the panel's unified Layout body (panel.ts's buildBody layout branch). */
  buildBodyInto(parent: HTMLElement): void {
    const addBtn = createButton({ label: '+ Add auto layout' })
    addBtn.setAttribute('data-add-layout', '')
    addBtn.addEventListener('click', () => {
      this.withEdit((el) => {
        this.deps.drafts.apply(el, 'display', 'flex')
      })
    })
    this.addLayoutBtn = addBtn
    parent.append(addBtn)

    const controls = document.createElement('div')
    controls.className = 'panel-rows layout-controls'
    this.layoutControlsWrap = controls

    // Wrap lives on the Direction row (Figma UI3 grouping) as an independent toggle —
    // it is NOT part of the exclusive direction segment, so it rides as a SegmentField
    // `trailing` addon (a sibling of the track) rather than a track option.
    const wrapBtn = createButton({ label: '↩' })
    wrapBtn.classList.add('seg', 'wrap-toggle')
    wrapBtn.setAttribute('data-wrap-toggle', '')
    wrapBtn.setAttribute('aria-label', 'Wrap')
    wrapBtn.title = 'flex-wrap: wrap → flex-wrap'
    wrapBtn.addEventListener('click', () => {
      this.withEdit((el) => {
        const current = this.deps.currentValue(el, 'flex-wrap', getComputedStyle(el))
        this.deps.drafts.apply(el, 'flex-wrap', current === 'wrap' ? 'nowrap' : 'wrap')
      })
    })
    this.wrapToggle = wrapBtn

    this.directionField = new SegmentField({
      label: 'Direction',
      options: [
        { value: 'row', label: '→', ariaLabel: 'Horizontal', title: 'flex-direction: row → flex-row' },
        { value: 'column', label: '↓', ariaLabel: 'Vertical', title: 'flex-direction: column → flex-col' },
      ],
      // [data-flex-direction] stacks the field column-wise (label above content) so
      // "Direction" doesn't crush the track — but that same column axis would stack the
      // wrap toggle BELOW the track instead of beside it. The `trailing` addon puts them
      // both in a .seg-cluster so they stay inline while the outer field still stacks
      // label vs cluster (browser-verified: M-B Task 5 caught the toggle rendering on
      // its own row).
      trailing: [wrapBtn],
      onInput: (value) => {
        this.withEdit((el) => {
          this.deps.drafts.apply(el, 'flex-direction', value)
        })
      },
    })
    // Marks the row for the stacked label-above-track CSS ([data-flex-direction] in
    // overlay.ts) — the "Direction" label overflows the shared 40px label column.
    this.directionField.root.setAttribute('data-flex-direction', '')
    controls.append(this.directionField.root)

    const grid = document.createElement('div')
    grid.className = 'layout-grid'

    const tile = document.createElement('div')
    tile.className = 'matrix-tile'

    this.alignMatrix = new AlignMatrix({
      onInput: ({ justify, align }) => {
        this.withEdit((el) => {
          this.deps.drafts.apply(el, 'justify-content', justify)
          this.deps.drafts.apply(el, 'align-items', align)
        })
      },
    })
    tile.append(this.alignMatrix.root)

    // Figma keeps baseline out of the 9-dot matrix (it's an 'align text baseline' extra) —
    // a small toggle under the matrix drafts it. Toggling OFF discards the session draft
    // (stylesheet reality returns); if baseline came from the app's own CSS there is no
    // draft to discard, so OFF drafts flex-start (the normalize default) instead.
    const baselineBtn = createButton({ label: 'Baseline' })
    baselineBtn.classList.add('seg', 'baseline-toggle')
    baselineBtn.setAttribute('data-align-baseline', '')
    baselineBtn.title = 'align-items: baseline → items-baseline'
    baselineBtn.addEventListener('click', () => {
      this.withEdit((el) => {
        const active = this.deps.currentValue(el, 'align-items', getComputedStyle(el)) === 'baseline'
        if (!active) {
          this.deps.drafts.apply(el, 'align-items', 'baseline')
        } else if (this.deps.drafts.current(el, 'align-items') !== null) {
          this.deps.drafts.discard(el, ['align-items'])
        } else {
          this.deps.drafts.apply(el, 'align-items', 'flex-start')
        }
      })
    })
    this.baselineToggle = baselineBtn
    tile.append(baselineBtn)

    grid.append(tile)

    const side = document.createElement('div')
    side.className = 'layout-side'

    const gapField = this.deps.buildGapField()
    this.gapField = gapField
    side.append(gapField.root)

    grid.append(side)
    controls.append(grid)

    parent.append(controls)
  }

  /** The flex-child align block (2026-07-06 layout-polish spec): "Align" group label + the
   * disclosure toggle, then the align-self segment strip. Off = follow the parent's 9-dot
   * alignment; the toggle's behavior lands in onAlignToggle (Task 3). */
  buildFlexChildControls(): HTMLElement {
    const wrap = document.createElement('div')
    wrap.className = 'flex-child-controls'
    this.flexChildControlsWrap = wrap

    const head = document.createElement('div')
    head.className = 'align-head'
    const label = document.createElement('span')
    label.className = 'group-label'
    label.textContent = 'Align'
    const toggle = createButton({ label: '' })
    toggle.classList.add('align-toggle')
    toggle.setAttribute('data-align-toggle', '')
    toggle.setAttribute('aria-label', 'Align independently of parent')
    toggle.title = "align-self — override the parent container's alignment for this element"
    this.alignToggle = toggle
    toggle.addEventListener('click', () => this.onAlignToggle())
    head.append(label, toggle)
    wrap.append(head)

    this.alignSelfField = new SegmentField({
      label: '',
      options: [
        { value: 'auto', label: 'Auto' },
        { value: 'flex-start', label: 'Start', title: 'align-self: flex-start → self-start' },
        { value: 'center', label: 'Center', title: 'align-self: center → self-center' },
        { value: 'flex-end', label: 'End', title: 'align-self: flex-end → self-end' },
        { value: 'stretch', label: 'Stretch' },
      ],
      onInput: (value) => {
        this.withEdit((el) => {
          this.deps.drafts.apply(el, 'align-self', value)
        })
      },
    })
    this.alignSelfField.root.setAttribute('data-align-self', '')
    this.alignSelfField.root.hidden = true
    this.alignSelfWrap = this.alignSelfField.root
    wrap.append(this.alignSelfField.root)
    return wrap
  }

  /** Registers a size-mode select bound to a NumberField — called by panel.ts's buildRow
   * for the Size section rows, so LayoutSection's refresh() can drive their visibility and
   * mode inference the same way it always has (sizeModes was a Panel-private array before
   * the move; it now lives here since only flex-child refresh reads/writes it). The full
   * size-mode lifecycle — registry, read half (updateSizeMode), and write half
   * (onSizeModeChange) — lives entirely in LayoutSection. */
  registerSizeMode(sm: BoundSizeMode): void {
    this.sizeModes.push(sm)
  }

  /** Registers a min/max disclosure row bound to a NumberField — called by panel.ts's
   * buildBody layout branch right after each size row (W/H). Mirrors registerSizeMode's
   * per-selection registry lifecycle (populated in buildBody, cleared in teardown). */
  registerMinMaxRow(reg: BoundMinMaxRow): void {
    this.minMaxRows.push(reg)
  }

  /** "Add min…"/"Add max…" action-item handler (buildRow's select onChange, NOT a size
   * mode — SIZE_MODES itself stays a pure mode table). Opening a row mutates no drafts, so
   * this deliberately isn't withEdit-framed: just latch the prop into openedMinMax, refresh
   * (which both discloses the row AND — via updateSizeMode inside refreshFlexChild — resets
   * the select's value back to the real Fixed/Hug/Fill mode, since 'add-min'/'add-max' were
   * never real modes), then focus the newly-revealed input. */
  openMinMax(sizeSpec: RowSpec, kind: 'min' | 'max'): void {
    const prop = `${kind}-${sizeSpec.props[0]}`
    this.openedMinMax.add(prop)
    this.deps.refresh()
    const reg = this.minMaxRows.find((r) => r.spec.props[0] === prop)
    reg?.field.root.querySelector('input')?.focus()
  }

  private alignOn(el: TaggedElement, computed: CSSStyleDeclaration): boolean {
    const draft = this.deps.drafts.isComparing(el) ? null : this.deps.drafts.current(el, 'align-self')
    return alignSelfRowOn(computed.getPropertyValue('align-self'), draft, this.alignOpened)
  }

  /** Align toggle. OFF→ON latches the row open and drafts nothing (openMinMax's non-withEdit
   * shape — there is nothing to send yet). ON→OFF composes both undo stories in one click:
   * discard any session draft, and if the stylesheet STILL asserts a non-default align-self
   * after the discard, draft `auto` so the change request says "follow the parent" — without
   * the second half, an app-CSS value would auto-reveal the row right back ON. */
  private onAlignToggle(): void {
    const el = this.deps.getEl()
    if (!el) return
    if (!this.alignOn(el, getComputedStyle(el))) {
      this.alignOpened = true
      this.deps.refresh()
      return
    }
    this.alignOpened = false
    this.withEdit((elm) => {
      if (this.deps.drafts.current(elm, 'align-self') !== null) {
        this.deps.drafts.discard(elm, ['align-self'])
      }
      const css = getComputedStyle(elm).getPropertyValue('align-self')
      if (!['', 'auto', 'normal'].includes(css)) {
        this.deps.drafts.apply(elm, 'align-self', 'auto')
      }
    })
  }

  /**
   * Today's refreshLayoutSection + refreshFlexChild, fused: add/remove visibility, direction/
   * wrap/baseline state, matrix set, flex-child visibility.
   */
  refresh(el: TaggedElement, computed: CSSStyleDeclaration, multi: boolean): void {
    if (multi) {
      // Cluster + add/remove are single-select-only (B6, re-scoped M-C): matrix/direction
      // across N elements is ambiguous. DOM stays (stable order) but hidden — the Layout
      // SECTION itself (W/H + padding rows, owned by panel.ts) stays visible in multi.
      if (this.addLayoutBtn) this.addLayoutBtn.hidden = true
      if (this.removeLayoutBtn) this.removeLayoutBtn.hidden = true
      if (this.layoutControlsWrap) this.layoutControlsWrap.hidden = true
      // Flex-child align/size-modes are single-only — DOM stays (stable order) but hidden.
      if (this.flexChildControlsWrap) this.flexChildControlsWrap.hidden = true
      for (const sm of this.sizeModes) sm.select.hidden = true
      // Min/max disclosure rows are single-select-only, same rule as the cluster/flex-child
      // strip above — ambiguous across N elements, so all hidden regardless of opened state.
      for (const mm of this.minMaxRows) mm.rowEl.hidden = true
      return
    }

    this.refreshLayoutSection(el, computed)
    this.refreshFlexChild(el, computed)
    this.refreshMinMax(el, computed)
  }

  /**
   * Disclosure predicate (single-select only) — delegates to the canonical minMaxRowVisible
   * (panel-readers.ts) so the rule lives in one place alongside marginSectionVisible's sibling
   * jsdom-default conventions.
   */
  private refreshMinMax(el: TaggedElement, computed: CSSStyleDeclaration): void {
    for (const mm of this.minMaxRows) {
      const prop = mm.spec.props[0]
      const draft = this.deps.drafts.isComparing(el) ? null : this.deps.drafts.current(el, prop)
      const visible = minMaxRowVisible(prop, computed.getPropertyValue(prop), draft !== null, this.openedMinMax.has(prop))
      mm.rowEl.hidden = !visible
    }
  }

  private refreshLayoutSection(el: TaggedElement, computed: CSSStyleDeclaration): void {
    const flex = isFlex(el)
    if (this.addLayoutBtn) this.addLayoutBtn.hidden = flex
    if (this.removeLayoutBtn) this.removeLayoutBtn.hidden = !flex
    if (this.layoutControlsWrap) this.layoutControlsWrap.hidden = !flex
    if (!flex) return

    const direction = this.deps.currentValue(el, 'flex-direction', computed) === 'column' ? 'column' : 'row'
    const justify = this.deps.currentValue(el, 'justify-content', computed)
    const align = this.deps.currentValue(el, 'align-items', computed)
    const wrap = this.deps.currentValue(el, 'flex-wrap', computed)
    const spaceBetween = justify === 'space-between'

    this.directionField?.set(direction)
    // wrap-reverse deliberately reads as OFF (same as the old Wrap segment) — the toggle is a
    // two-state wrap/nowrap control; reversal is out of its vocabulary.
    const wrapping = wrap === 'wrap'
    this.wrapToggle?.classList.toggle('seg-active', wrapping)
    this.wrapToggle?.setAttribute('aria-pressed', String(wrapping))

    if (this.gapField) {
      if (spaceBetween) {
        // setAuto (Figma "space it out for me") supersedes any bound pill — same rule as
        // the sizeMode W/H auto-continue path above: a switch to Auto must clear the
        // bookkeeping, not just the visible pill, so a later equal-px value can't resurrect it.
        this.gapField.setAuto()
        this.deps.tokenUi.drop(GAP_SPEC)
      } else {
        const gapCss = this.deps.drafts.isComparing(el) ? null : this.deps.drafts.current(el, 'gap')
        const css = gapCss ?? computed.getPropertyValue('gap')
        const value = fromPx(css)
        this.gapField.set(value)

        // B5 re-bind contract — see PanelTokenUi.rebind
        this.deps.tokenUi.rebind(GAP_SPEC, this.gapField, value, false, this.deps.drafts.isComparing(el))
      }
    }

    this.alignMatrix?.set(normalizeJustify(justify), normalizeAlign(align), direction, spaceBetween)
    const baselineOn = normalizeAlign(align) === 'baseline'
    this.baselineToggle?.classList.toggle('seg-active', baselineOn)
    this.baselineToggle?.setAttribute('aria-pressed', String(baselineOn))
  }

  private refreshFlexChild(el: TaggedElement, computed: CSSStyleDeclaration): void {
    const parent = el.parentElement
    const visible = parent !== null && isFlex(parent as TaggedElement)
    if (this.flexChildControlsWrap) this.flexChildControlsWrap.hidden = !visible
    for (const sm of this.sizeModes) sm.select.hidden = !visible
    if (!visible) return

    const parentDirection = getComputedStyle(parent as TaggedElement).flexDirection.startsWith('column')
      ? 'column'
      : 'row'
    const main = mainAxisProp(parentDirection)

    const alignSelf = this.deps.currentValue(el, 'align-self', computed)
    const on = this.alignOn(el, computed)
    this.alignToggle?.setAttribute('aria-pressed', String(on))
    if (this.alignSelfWrap) this.alignSelfWrap.hidden = !on
    if (on) this.alignSelfField?.set(alignSelf || 'auto')

    for (const sm of this.sizeModes) {
      this.updateSizeMode(el, sm, main)
    }
  }

  /**
   * Mode inference heuristic (kept intentionally simple):
   * - Fixed: there's an explicit draft OR inline style for this axis's size prop (px value authored).
   * - Fill: no explicit size draft/inline AND either
   *     - main axis: computed flex-grow >= 1
   *     - cross axis: computed align-self is 'stretch'
   * - Hug: no explicit size draft/inline AND not Fill (default content-based sizing).
   */
  // READ half of the size-mode policy — its WRITE half, onSizeModeChange, sits right below.
  private updateSizeMode(el: TaggedElement, sm: BoundSizeMode, main: 'width' | 'height'): void {
    const prop = sm.spec.props[0] as 'width' | 'height'
    const isMain = prop === main
    const draft = this.deps.drafts.isComparing(el) ? null : this.deps.drafts.current(el, prop)
    const inline = el.style.getPropertyValue(prop)
    const hasExplicitSize = !!draft || !!inline

    if (hasExplicitSize) {
      sm.select.value = 'fixed'
      return
    }

    const computed = getComputedStyle(el)
    if (isMain) {
      const grow = Number.parseFloat(computed.flexGrow || '0')
      if (grow >= 1) {
        sm.select.value = 'fill'
        return
      }
    } else {
      const alignSelfDraft = this.deps.drafts.isComparing(el) ? null : this.deps.drafts.current(el, 'align-self')
      const alignSelfCss = alignSelfDraft ?? computed.alignSelf
      if (alignSelfCss === 'stretch') {
        sm.select.value = 'fill'
        return
      }
    }

    sm.select.value = 'hug'
  }

  // WRITE half of the size-mode policy — its READ half, updateSizeMode, sits right above.
  // Deviates from the shared withEdit frame: the Fixed-mode non-finite-size guard must bail
  // out of the ENTIRE handler (no refresh/onEdited either), not just skip the mutation — so
  // this can't route through withEdit, which always calls refresh/onEdited after `fn` returns.
  onSizeModeChange(spec: RowSpec, mode: string): void {
    const el = this.deps.getEl()
    if (!el) return
    this.deps.onBeforeEdit(el)
    const prop = spec.props[0]
    const parent = el.parentElement
    const parentDirection =
      parent && isFlex(parent as TaggedElement)
        ? getComputedStyle(parent as TaggedElement).flexDirection.startsWith('column')
          ? 'column'
          : 'row'
        : 'row'
    const main = mainAxisProp(parentDirection)
    const isMain = prop === main

    if (mode === 'fixed') {
      // Figma semantics: selecting Fixed pins the element's CURRENT rendered size —
      // it doesn't wait for the user to type a number. First capture the computed size
      // the user SEES (before discarding mode props that may affect layout), then clear
      // whatever mode props produced the current Fill/Hug layout so they don't leak into
      // the change request, then draft the computed size as an explicit px value so
      // the mode-inference heuristic reads it back as Fixed immediately.
      // Cross-axis: only discard align-self when it holds the 'stretch' value Fill wrote —
      // a user-drafted value (e.g. flex-start via the Align segment field) must survive
      // switching this axis to Fixed.
      const modeProps = isMain
        ? ['flex-grow', 'flex-basis']
        : this.deps.drafts.current(el, 'align-self') === 'stretch'
          ? ['align-self']
          : []
      const isAutoNow = this.deps.drafts.current(el, prop) === 'auto'
      if (isAutoNow) modeProps.push(prop)
      let computedSize = Math.round(parseFloat(getComputedStyle(el).getPropertyValue(prop)))
      // If jsdom can't compute the size (returns NaN for 'auto' without layout engine),
      // fall back to the original value that will be restored by discard()
      if (isNaN(computedSize) && isAutoNow) {
        const draftEntry = this.deps.drafts.entries().get(el)?.get(prop)
        computedSize = draftEntry ? Math.round(parseFloat(draftEntry.original)) : computedSize
      }
      // Unconditional guard: whatever the source, never draft a non-finite size — bail
      // out of the pin entirely rather than writing e.g. "NaNpx" into the change request.
      if (!Number.isFinite(computedSize)) return
      this.deps.drafts.discard(el, modeProps)
      this.deps.drafts.apply(el, prop, `${computedSize}px`)
    } else if (mode === 'hug') {
      this.deps.drafts.apply(el, prop, 'auto')
    } else if (mode === 'fill') {
      if (isMain) {
        this.deps.drafts.apply(el, 'flex-grow', '1')
        this.deps.drafts.apply(el, 'flex-basis', '0%')
      } else {
        this.deps.drafts.apply(el, 'align-self', 'stretch')
      }
    }
    this.deps.refresh()
    this.deps.onEdited()
  }

  /** Null out widget refs (today's teardown lines). */
  teardown(): void {
    this.directionField = null
    this.gapField = null
    this.alignMatrix = null
    this.baselineToggle = null
    this.wrapToggle = null
    this.addLayoutBtn = null
    this.removeLayoutBtn = null
    this.layoutControlsWrap = null
    this.alignSelfField = null
    this.alignSelfWrap = null
    this.flexChildControlsWrap = null
    this.alignToggle = null
    this.sizeModes = []
    this.minMaxRows = []
    this.openedMinMax.clear()
    this.alignOpened = false
  }
}
