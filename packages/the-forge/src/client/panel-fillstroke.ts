/**
 * FillStrokeSection — the Fill/Stroke cluster extracted from panel.ts (PR #20 review
 * finding 1, the follow-up the empty-states spec deliberately deferred): the Fill/Text
 * color rows, the stroke W+style+Color rows, the four add/remove empty-state title
 * buttons, and the refresh-driven empty-state visibility policy.
 *
 * This module has no test file of its own — its coverage IS tests/client/panel.test.ts
 * (the move that created this file was behavior-neutral; that suite asserts the DOM
 * hooks this class produces).
 */
import type { TaggedElement } from './source'
import { DraftStore } from './drafts'
import { createButton } from './ui/button'
import { createSelect } from './ui/select'
import { BORDER_WIDTH_PROPS, BORDER_STYLE_PROPS, BORDER_COLOR_PROPS, STROKE_STYLES } from './panel-specs'
import { effectiveBackground, hasDirectText, fillIsEmpty, strokeIsEmpty } from './panel-readers'

export interface FillStrokeSectionDeps {
  drafts: DraftStore
  /** The panel's live selection accessor — FillStrokeSection never caches the element. */
  getEl: () => TaggedElement | null
  /** Drafts-aware computed reader — the panel's existing private currentValue, passed through. */
  currentValue: (el: TaggedElement, prop: string, computed: CSSStyleDeclaration) => string
  onBeforeEdit: (el: TaggedElement) => void
  onEdited: () => void
  refresh: () => void
  /** `.color-row` factory — stays panel-side because it wires the shared ColorPicker and the
   * tokenUi color-token button (both Panel-level singletons); passed through like buildGapField. */
  buildColorRow: (opts: {
    label: string
    getCss: () => string
    getContrastAgainst: () => string | null
    onPick: (css: string) => void
  }) => HTMLElement
  /** Stroke-W NumberField factory — the panel's buildField machinery stays the single place
   * fields are born (destroy()/refresh() bookkeeping lives in panel.fields); the section only
   * needs the root element to place. */
  buildStrokeWidthField: () => HTMLElement
  /** Sticky ⋯ expand-state reader (the panel's expandState map, keyed by spec.expandKey). */
  expandOpen: (key: string) => boolean
}

export class FillStrokeSection {
  // Fill/Stroke section widgets (rebuilt per show(), re-set() per refresh()).
  private fillRow: HTMLElement | null = null
  private textRow: HTMLElement | null = null
  private strokeStyleSelect: HTMLSelectElement | null = null
  private strokeColorRow: HTMLElement | null = null
  private fillAddBtn: HTMLButtonElement | null = null
  private fillRemoveBtn: HTMLButtonElement | null = null
  private strokeAddBtn: HTMLButtonElement | null = null
  private strokeRemoveBtn: HTMLButtonElement | null = null
  private strokeRowsWrap: HTMLElement | null = null
  private strokeExpandBtn: HTMLElement | null = null
  private strokeExpandKey: string | null = null
  private strokeExpandWrap: HTMLElement | null = null

  constructor(private deps: FillStrokeSectionDeps) {}

  /** The edit lifecycle every +/−/style handler shares: bail without a selection, snapshot
   * pre-edit state, mutate drafts, re-render, notify — same shape as LayoutSection.withEdit
   * (PR #20 review finding 2, adopted at this module boundary: the skeleton is shared, the
   * genuinely-divergent removal policies stay inline where they can be read whole). */
  private withEdit(fn: (el: TaggedElement) => void): void {
    const el = this.deps.getEl()
    if (!el) return
    this.deps.onBeforeEdit(el)
    fn(el)
    this.deps.refresh()
    this.deps.onEdited()
  }

  buildFillSection(): HTMLElement {
    const wrap = document.createElement('div')
    wrap.className = 'panel-rows'

    const fillRow = this.deps.buildColorRow({
      label: 'Fill',
      getCss: () => {
        const el = this.deps.getEl()
        return el ? this.deps.currentValue(el, 'background-color', getComputedStyle(el)) : ''
      },
      getContrastAgainst: () => {
        const el = this.deps.getEl()
        return el ? this.deps.currentValue(el, 'color', getComputedStyle(el)) : null
      },
      onPick: (css) => {
        const el = this.deps.getEl()
        if (!el) return
        this.deps.drafts.apply(el, 'background-color', css)
      },
    })
    wrap.append(fillRow)
    this.fillRow = fillRow

    const textRow = this.deps.buildColorRow({
      label: 'Text',
      getCss: () => {
        const el = this.deps.getEl()
        return el ? this.deps.currentValue(el, 'color', getComputedStyle(el)) : ''
      },
      getContrastAgainst: () => {
        const el = this.deps.getEl()
        return el ? effectiveBackground(el, this.deps.drafts) : null
      },
      onPick: (css) => {
        const el = this.deps.getEl()
        if (!el) return
        this.deps.drafts.apply(el, 'color', css)
      },
    })
    wrap.append(textRow)
    this.textRow = textRow

    return wrap
  }

  /** The Fill title's [−, +] pair, in Layout's title glyph order (remove first). Only one is
   * ever visible — refresh() flips them on the fill-empty predicate. */
  buildFillTitleButtons(): [HTMLButtonElement, HTMLButtonElement] {
    return [this.buildFillRemoveButton(), this.buildFillAddButton()]
  }

  private buildFillAddButton(): HTMLButtonElement {
    const btn = createButton({ label: '+' })
    btn.setAttribute('data-add-fill', '')
    btn.setAttribute('aria-label', 'Add fill')
    btn.title = 'Add fill — drafts a default background-color the request turns into a bg-* class'
    btn.hidden = true
    btn.addEventListener('click', () => {
      this.withEdit((el) => {
        // #D9D9D9 is Figma's default fill gray — a deliberately-neutral starting point the
        // color picker / nearest-token machinery immediately takes over from.
        this.deps.drafts.apply(el, 'background-color', '#D9D9D9')
      })
    })
    this.fillAddBtn = btn
    return btn
  }

  private buildFillRemoveButton(): HTMLButtonElement {
    const btn = createButton({ label: '−' })
    btn.setAttribute('data-remove-fill', '')
    btn.setAttribute('aria-label', 'Remove fill')
    btn.title = 'Remove fill — the request becomes bg-transparent (background transparent)'
    btn.hidden = true
    btn.addEventListener('click', () => {
      this.withEdit((el) => {
        if (this.deps.drafts.current(el, 'background-color') !== null) {
          // Fill was added (or re-drafted) this session — pure undo, mirroring remove-auto-
          // layout: targeted discard restores the recorded original; nothing to send.
          this.deps.drafts.discard(el, ['background-color'])
        } else {
          // Fill comes from the app's own CSS: draft transparent as the deterministic removal.
          this.deps.drafts.apply(el, 'background-color', 'transparent')
        }
      })
    })
    this.fillRemoveBtn = btn
    return btn
  }

  /** The Stroke title's [−, +] pair — same glyph-order contract as buildFillTitleButtons;
   * buildBody appends these BEFORE appendExpandRows so the ⋯ lands last. */
  buildStrokeTitleButtons(): [HTMLButtonElement, HTMLButtonElement] {
    return [this.buildStrokeRemoveButton(), this.buildStrokeAddButton()]
  }

  private buildStrokeAddButton(): HTMLButtonElement {
    const btn = createButton({ label: '+' })
    btn.setAttribute('data-add-stroke', '')
    btn.setAttribute('aria-label', 'Add stroke')
    btn.title = 'Add stroke — drafts a 1px solid border (border + border-solid)'
    btn.hidden = true
    btn.addEventListener('click', () => {
      this.withEdit((el) => {
        // Width + style only — color is left to compute (usually currentColor), so the new
        // stroke is immediately visible without guessing at the project's palette.
        for (const prop of BORDER_WIDTH_PROPS) this.deps.drafts.apply(el, prop, '1px')
        for (const prop of BORDER_STYLE_PROPS) this.deps.drafts.apply(el, prop, 'solid')
      })
    })
    this.strokeAddBtn = btn
    return btn
  }

  private buildStrokeRemoveButton(): HTMLButtonElement {
    const btn = createButton({ label: '−' })
    btn.setAttribute('data-remove-stroke', '')
    btn.setAttribute('aria-label', 'Remove stroke')
    btn.title = 'Remove stroke — the request tells the agent to drop border classes (border-none)'
    btn.hidden = true
    btn.addEventListener('click', () => {
      this.withEdit((el) => {
        if (BORDER_STYLE_PROPS.some((prop) => this.deps.drafts.current(el, prop) !== null)) {
          // Style is the anchor: adding a stroke always drafts it (directly or via
          // draftSolidIfNone), while a width tweak on a fully-bordered element never does.
          // Anchor drafted this session — pure undo of the whole stroke prop set.
          this.deps.drafts.discard(el, [...BORDER_WIDTH_PROPS, ...BORDER_STYLE_PROPS, ...BORDER_COLOR_PROPS])
        } else {
          // Stroke comes from the app's own CSS: draft border-style none as the removal
          // (request builder → border-none); width/color drafts would contradict it — discard.
          this.deps.drafts.discard(el, [...BORDER_WIDTH_PROPS, ...BORDER_COLOR_PROPS])
          for (const prop of BORDER_STYLE_PROPS) this.deps.drafts.apply(el, prop, 'none')
        }
      })
    })
    this.strokeRemoveBtn = btn
    return btn
  }

  buildStrokeSection(): HTMLElement {
    const wrap = document.createElement('div')
    wrap.className = 'panel-rows stroke-rows'

    const row1 = document.createElement('div')
    row1.className = 'stroke-row'
    row1.append(this.deps.buildStrokeWidthField())

    const styleSelect = createSelect({
      className: 'stroke-style',
      options: STROKE_STYLES.map(([value, label]) => ({ value, label })),
      onChange: (value) => {
        this.withEdit((el) => {
          for (const prop of BORDER_STYLE_PROPS) this.deps.drafts.apply(el, prop, value)
        })
      },
    })
    styleSelect.title = 'border-style → border-solid / border-dashed / border-dotted'
    this.strokeStyleSelect = styleSelect
    row1.append(styleSelect)

    const row2 = document.createElement('div')
    row2.className = 'stroke-row'
    const colorRow = this.deps.buildColorRow({
      label: 'Color',
      getCss: () => {
        const el = this.deps.getEl()
        return el ? this.deps.currentValue(el, 'border-top-color', getComputedStyle(el)) : ''
      },
      getContrastAgainst: () => {
        const el = this.deps.getEl()
        return el ? effectiveBackground(el, this.deps.drafts) : null
      },
      onPick: (css) => {
        const el = this.deps.getEl()
        if (!el) return
        for (const prop of BORDER_COLOR_PROPS) this.deps.drafts.apply(el, prop, css)
      },
    })
    row2.append(colorRow)
    this.strokeColorRow = colorRow

    wrap.append(row1, row2)
    this.strokeRowsWrap = wrap
    return wrap
  }

  /** Called by buildBody's stroke branch right after appendExpandRows: the ⋯ was just
   * appended to the title and expandWrap pushed last — refresh() needs both to hide the
   * whole fine-tune affordance on an empty stroke. The key is read off the spec (not a
   * literal) so a spec rename can't silently break the expand-state restore on a
   * remove→add round-trip (PR #20 review, finding 3). */
  captureStrokeExpand(title: HTMLElement, expandKey: string | undefined, expandWrap: HTMLElement): void {
    this.strokeExpandKey = expandKey ?? null
    this.strokeExpandBtn = title.querySelector<HTMLButtonElement>(`[data-expand="${expandKey}"]`)
    this.strokeExpandWrap = expandWrap
  }

  /** The single-selection refresh pass (panel.refresh()'s !multi branch) — empty-state
   * visibility flips plus the per-row swatch/select re-reads. */
  refresh(el: TaggedElement, computed: CSSStyleDeclaration): void {
    const fillEmpty = fillIsEmpty(this.deps.currentValue(el, 'background-color', computed))
    if (this.fillRow) this.fillRow.hidden = fillEmpty
    if (this.fillAddBtn) this.fillAddBtn.hidden = !fillEmpty
    if (this.fillRemoveBtn) this.fillRemoveBtn.hidden = fillEmpty
    ;(this.fillRow as (HTMLElement & { __refresh?: () => void }) | null)?.__refresh?.()
    if (this.textRow) this.textRow.hidden = !hasDirectText(el)
    ;(this.textRow as (HTMLElement & { __refresh?: () => void }) | null)?.__refresh?.()
    ;(this.strokeColorRow as (HTMLElement & { __refresh?: () => void }) | null)?.__refresh?.()

    const strokeEmpty = strokeIsEmpty((prop) => this.deps.currentValue(el, prop, computed))
    if (this.strokeRowsWrap) this.strokeRowsWrap.hidden = strokeEmpty
    if (this.strokeAddBtn) this.strokeAddBtn.hidden = !strokeEmpty
    if (this.strokeRemoveBtn) this.strokeRemoveBtn.hidden = strokeEmpty
    if (this.strokeExpandBtn) this.strokeExpandBtn.hidden = strokeEmpty
    if (this.strokeExpandWrap) {
      // An empty stroke has nothing to fine-tune: force the BT/BR/BB/BL wrap closed, but
      // restore the user's sticky expandState when the stroke comes back (remove → add
      // round-trip must not silently reset an opened ⋯). Keyed by the captured spec
      // expandKey, never a literal — see the captureStrokeExpand comment.
      const key = this.strokeExpandKey
      this.strokeExpandWrap.hidden = strokeEmpty || key === null || !this.deps.expandOpen(key)
    }

    if (this.strokeStyleSelect) {
      const style = this.deps.currentValue(el, 'border-top-style', computed)
      this.strokeStyleSelect.value = ['none', 'solid', 'dashed', 'dotted'].includes(style) ? style : 'none'
    }
  }

  /** buildBody's reset — drop every widget reference so a rebuild can't refresh stale DOM. */
  teardown(): void {
    this.fillRow = null
    this.textRow = null
    this.strokeStyleSelect = null
    this.strokeColorRow = null
    this.fillAddBtn = null
    this.fillRemoveBtn = null
    this.strokeAddBtn = null
    this.strokeRemoveBtn = null
    this.strokeRowsWrap = null
    this.strokeExpandBtn = null
    this.strokeExpandKey = null
    this.strokeExpandWrap = null
  }
}
