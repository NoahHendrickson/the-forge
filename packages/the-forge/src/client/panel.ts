import type { TaggedElement } from './source'
import type { InspectorData } from './inspector'
import { DraftStore } from './drafts'
import { NumberField } from './controls'
import { SegmentField, AlignMatrix } from './layout-controls'
import { ColorPicker } from './colorpicker'
import { TokenPicker, type TokenEntry } from './tokenpicker'
import { nearestColorToken, readTokens, readTheme, parseColor as parseColorLocal, rgbToHex } from './tokens'
import {
  type RowSpec,
  type SectionSpec,
  BORDER_WIDTH_PROPS,
  BORDER_STYLE_PROPS,
  BORDER_COLOR_PROPS,
  GAP_SPEC,
  utilityPrefixFor,
  draftSolidIfNone,
  tokenEntriesFor,
  WEIGHTS,
  SECTIONS,
} from './panel-specs'
import {
  px,
  fromPx,
  effectiveBackground,
  isFlex,
  normalizeJustify,
  normalizeAlign,
  hasDirectText,
  snapWeight,
  firstFamily,
  cssFamilyValue,
  documentFontFamilies,
  mainAxisProp,
} from './panel-readers'

export { tokenEntriesFor } from './panel-specs'
export { normalizeJustify, normalizeAlign, hasDirectText } from './panel-readers'

interface BoundField {
  field: NumberField
  spec: RowSpec
}

interface BoundSizeMode {
  select: HTMLSelectElement
  spec: RowSpec
  field: NumberField
}

export class Panel {
  root = document.createElement('div')
  compareButton = document.createElement('button')
  resetButton = document.createElement('button')
  footer = document.createElement('div')
  resizeHandle = document.createElement('div')
  modeButton = document.createElement('button')
  /** Mount slot for the Changes lifecycle list (changelist.ts) — owned/populated by
   * DesignMode, positioned here so it pins between the scrolling sections and the footer
   * and stays visible in the docked no-selection empty state (body hidden, footer kept). */
  changesSlot = document.createElement('div')

  private head = document.createElement('div')
  private headTag = document.createElement('div')
  private headSrc = document.createElement('div')
  private actions = document.createElement('div')
  private body = document.createElement('div')
  /** The per-selection rebuild target inside `body`. Sections live HERE, the popover
   * singletons live directly in `body` — so buildBody() can wipe sectionsRoot freely
   * without any "remember to re-seed the pickers" invariant (PR #2 review). */
  private sectionsRoot = document.createElement('div')
  private emptyEl = document.createElement('div')
  /** Dock currently active (NOT the persisted preference — Dock owns that). */
  private docked = false
  private fields: BoundField[] = []
  // `els` holds the section TITLE plus every body wrap belonging to that section (rowWrap,
  // expandWrap, custom-body wrap — whatever buildBody appended for it) so refresh() can hide
  // them all together. Hiding only the title (the pre-fix behavior) left a section's fields
  // visible/interactive underneath a hidden title, which is the bug this fixes (final review
  // finding E2).
  private sectionEls: Array<{ spec: SectionSpec; els: HTMLElement[] }> = []
  private el: TaggedElement | null = null
  /** Full selection (B6) — [] when hidden, [el] in single-select (mirrors `el` for back-compat). */
  private els: TaggedElement[] = []
  // Persists expand/collapse state per section across show() calls (selecting another
  // element rebuilds the DOM but should keep sections the user expanded, expanded).
  private expandState = new Map<string, boolean>()

  // Layout section widgets (rebuilt per show(), re-set() per refresh()).
  private directionField: SegmentField | null = null
  private gapField: NumberField | null = null
  private alignMatrix: AlignMatrix | null = null
  private wrapField: SegmentField | null = null
  private addLayoutBtn: HTMLElement | null = null
  private layoutControlsWrap: HTMLElement | null = null

  // Flex-child widgets.
  private alignSelfField: SegmentField | null = null
  private alignSelfWrap: HTMLElement | null = null
  private flexChildControlsWrap: HTMLElement | null = null
  private sizeModes: BoundSizeMode[] = []

  // Typography section widgets (rebuilt per show(), re-set() per refresh()).
  private typeFamilySelect: HTMLSelectElement | null = null
  private typeWeightSelect: HTMLSelectElement | null = null
  private typeAlignField: SegmentField | null = null

  // Fill/Stroke section widgets (rebuilt per show(), re-set() per refresh()).
  private fillRow: HTMLElement | null = null
  private textRow: HTMLElement | null = null
  private strokeStyleSelect: HTMLSelectElement | null = null
  private strokeColorRow: HTMLElement | null = null

  // Selection colors (B6, multi-select only) — section title + rows wrap, rebuilt per show().
  private selectionColorsTitle: HTMLElement | null = null
  private selectionColorsRows: HTMLElement | null = null

  // Scrub baselines (B6): Map<el, Map<prop, number>> snapshotted once at onScrubStart, reused
  // (never re-snapshotted) across every onRelative call in the same drag — see NumberField's
  // onScrub contract (each move re-applies against the SAME baseline, not the running value).
  private scrubBaselines: Map<TaggedElement, Map<string, number>> | null = null
  // Identity of the NumberField instance currently mid-scrub (cleared on window mouseup) —
  // distinguishes a scrub-drag onRelative call (uses frozen scrubBaselines) from a typed
  // relative expression (+8 via change event, which always reads a fresh current value).
  private scrubbingField: NumberField | null = null

  // Single Panel-level ColorPicker instance shared by Fill and Stroke — closed whenever the
  // selection changes (show()) so it never dangles pointing at a since-removed row.
  private colorPicker: ColorPicker

  // Single Panel-level TokenPicker instance (B5) shared by every NumberField's `=` key —
  // closed whenever the selection changes (show()/hide()), same lifecycle as colorPicker.
  private tokenPicker: TokenPicker

  // Bound token pills, keyed by the owning field's spec.props.join(',') (a stable per-field
  // identity — see MULTI_PROP_SYNTHETIC above). B1's set()/setMixed()/setAuto() unconditionally
  // clear a field's pill state, so a plain refresh() would silently drop every bound pill even
  // when nothing about that field changed. This map lets refresh() re-apply bindToken() when
  // the field's current (draft-or-computed) value still matches what was bound — cleared
  // wholesale on selection change (show()), and per-entry when the value diverges (refresh()).
  private boundTokens = new Map<string, { label: string; px: number }>()

  constructor(
    private drafts: DraftStore,
    private onEdited: () => void,
    // Optional third param (rather than an options object) — keeps every existing
    // `new Panel(drafts, onEdited)` call site and test untouched. Called by every
    // control handler immediately BEFORE drafts.apply(...), so callers can snapshot
    // pre-edit layout state (e.g. for the ripple indicator) while onEdited (which
    // fires after apply) is used for post-edit re-measurement.
    private onBeforeEdit: (el: TaggedElement) => void = () => {}
  ) {
    this.root.id = 'panel'
    this.root.hidden = true
    this.head.className = 'panel-head'
    this.headTag.className = 'panel-head-tag'
    this.headSrc.className = 'panel-head-src'
    this.head.append(this.headTag)
    this.actions.className = 'panel-actions'
    this.compareButton.textContent = 'Compare'
    this.resetButton.textContent = 'Reset'
    this.compareButton.addEventListener('click', () => {
      if (!this.el) return
      const turningOn = !this.drafts.isComparing(this.el)
      for (const el of this.els) this.drafts.compare(el, turningOn)
      this.refresh()
    })
    this.resetButton.addEventListener('click', () => {
      if (!this.el) return
      for (const el of this.els) {
        this.onBeforeEdit(el)
        this.drafts.discard(el)
      }
      // Reset must clear pill bookkeeping wholesale, not just per-field on divergence — a
      // coincidentally-equal original value (e.g. the author's own inline px matches a
      // scale step) would otherwise resurrect a pill backed by no draft at all.
      this.boundTokens.clear()
      this.refresh()
      this.onEdited()
    })
    this.actions.append(this.compareButton, this.resetButton)
    this.body.className = 'panel-body'
    this.sectionsRoot.className = 'panel-sections'
    this.body.append(this.sectionsRoot)
    this.emptyEl.className = 'panel-empty'
    this.emptyEl.textContent = 'Click an element to edit'
    this.emptyEl.hidden = true
    this.footer.className = 'panel-footer'
    this.resizeHandle.className = 'panel-resize'
    this.modeButton.className = 'panel-mode'
    this.modeButton.type = 'button'
    this.head.append(this.modeButton)
    this.root.append(this.resizeHandle, this.head, this.actions, this.emptyEl, this.body, this.changesSlot, this.footer)
    // Popovers mount in the BODY (the scroll container), not the root — anchor.offsetTop
    // and the popover's absolute top must share the body's scrolled coordinate space or
    // the popover stops tracking its row the moment the sections scroll (see overlay.ts
    // .panel-body comment).
    this.colorPicker = new ColorPicker(this.body)
    this.tokenPicker = new TokenPicker(this.body)
    // Mutual exclusivity (final review fix #11): opening one popover must close the other —
    // two open at once would overlap/fight for the same anchor-relative position. Wired here
    // (wrapping each instance's own open(), rather than editing every call site or having the
    // components import each other) so ColorPicker and TokenPicker stay fully decoupled from
    // one another; only Panel, which holds both instances, knows they're mutually exclusive.
    const colorPickerOpen = this.colorPicker.open.bind(this.colorPicker)
    this.colorPicker.open = (opts) => {
      this.tokenPicker.close()
      colorPickerOpen(opts)
    }
    const tokenPickerOpen = this.tokenPicker.open.bind(this.tokenPicker)
    this.tokenPicker.open = (opts) => {
      this.colorPicker.close()
      tokenPickerOpen(opts)
    }
  }

  show(elOrEls: TaggedElement | TaggedElement[], data: InspectorData): void {
    const els = Array.isArray(elOrEls) ? elOrEls : [elOrEls]
    this.els = els
    const el = els[0] ?? null
    this.el = el
    this.colorPicker.close()
    this.tokenPicker.close()
    this.boundTokens.clear()
    this.root.hidden = false
    this.actions.hidden = false
    this.body.hidden = false
    this.emptyEl.hidden = true
    if (els.length > 1) {
      this.headTag.textContent = `${els.length} selected`
      this.headSrc.remove()
    } else {
      this.headTag.textContent = data.tag
      if (data.source) {
        const srcText = `${data.source.file}:${data.source.line}:${data.source.col}`
        const slash = data.source.file.lastIndexOf('/')
        const dirSpan = document.createElement('span')
        dirSpan.className = 'src-dir'
        dirSpan.textContent = slash === -1 ? '' : data.source.file.slice(0, slash + 1)
        const tailSpan = document.createElement('span')
        tailSpan.className = 'src-tail'
        tailSpan.textContent = `${slash === -1 ? data.source.file : data.source.file.slice(slash + 1)}:${data.source.line}:${data.source.col}`
        this.headSrc.replaceChildren(dirSpan, tailSpan)
        this.headSrc.title = srcText
        if (!this.headSrc.isConnected) this.head.append(this.headSrc)
      } else {
        this.headSrc.remove()
      }
    }
    // rebuilds all fields per selection; expand state PERSISTS across selection changes
    // (see this.expandState, applied in buildBody()) — B1 made this intentional, superseding
    // the earlier "resets by design" plan.
    this.buildBody()
    this.refresh()
  }

  hide(): void {
    this.el = null
    this.els = []
    this.colorPicker.close()
    this.tokenPicker.close()
    if (this.docked) {
      // Docked empty state: root stays visible (the dock holds its space), header says
      // why the controls are gone, footer (status strip) remains usable.
      this.root.hidden = false
      this.headTag.textContent = 'No selection'
      this.headSrc.remove()
      this.actions.hidden = true
      this.body.hidden = true
      this.emptyEl.hidden = false
    } else {
      this.root.hidden = true
    }
  }

  /**
   * Dock-active flag (set by Dock, not persisted here). Docked changes what "no
   * selection" looks like: the root stays visible with an empty-state hint instead of
   * hiding, so the dock never collapses mid-session. Re-runs hide() when nothing is
   * selected so the visibility rules of the NEW mode apply immediately.
   */
  setDocked(on: boolean): void {
    this.docked = on
    this.root.classList.toggle('docked', on)
    if (!this.el) this.hide()
  }

  /**
   * Applies `hidden` to every DOM element belonging to a section (title + body wraps) —
   * see the sectionEls field comment (final review finding E2: a hidden TITLE alone left
   * the section's fields visible/interactive underneath it).
   *
   * The section's expandWrap (its collapsible BT/BR/BB/BL-style sub-rows, when present)
   * is always the LAST entry in `els` and is special-cased: forcing it hidden=false
   * whenever the section becomes visible would fight the independent expand/collapse
   * toggle (persisted in expandState) — so when un-hiding, the expandWrap is left to
   * whatever expandState already set it to via buildBody(), not forced visible.
   */
  private setSectionHidden(spec: SectionSpec, els: HTMLElement[], hidden: boolean): void {
    const expandWrap = spec.expandRows && spec.expandKey ? els[els.length - 1] : null
    for (const el of els) {
      if (hidden) {
        el.hidden = true
      } else if (el === expandWrap) {
        el.hidden = !(this.expandState.get(spec.expandKey!) ?? false)
      } else {
        el.hidden = false
      }
    }
  }

  refresh(): void {
    if (!this.el) return
    const el = this.el
    const computed = getComputedStyle(el)
    const multi = this.isMulti()

    for (const { spec, els: sectionEls } of this.sectionEls) {
      if (spec.title === 'Layout') {
        // Decision (B6): Layout is single-element only — matrix/direction across N
        // elements is ambiguous, so the whole section (not just its controls) hides.
        this.setSectionHidden(spec, sectionEls, multi)
        continue
      }
      if (spec.title === 'Fill' || spec.title === 'Stroke') {
        // Replaced by Selection colors in multi-mode — title AND body hide together.
        this.setSectionHidden(spec, sectionEls, multi || (spec.visible ? !spec.visible(el) : false))
        continue
      }
      if (multi) {
        // visible when applicable to ANY element in the selection (hasDirectText any, flex any…).
        this.setSectionHidden(spec, sectionEls, spec.visible ? !this.els.some((e) => spec.visible!(e)) : false)
      } else {
        this.setSectionHidden(spec, sectionEls, spec.visible ? !spec.visible(el) : false)
      }
    }
    if (this.selectionColorsTitle) this.selectionColorsTitle.hidden = !multi

    for (const { field, spec } of this.fields) {
      // Size-mode (W/H) fields can hold the literal 'auto' draft (Hug mode) — show
      // it as the auto keyword rather than resolving it through fromCss. Draft check
      // stays first; when there's no draft (and we're not in comparing mode), an
      // author-authored inline `auto` (e.g. style="width: auto") shows the same way.
      if (spec.sizeMode && !multi) {
        const draft = this.drafts.isComparing(el) ? null : this.drafts.current(el, spec.props[0])
        if (draft === 'auto') {
          field.setAuto()
          this.boundTokens.delete(spec.props.join(','))
          continue
        }
        if (draft === null && !this.drafts.isComparing(el) && el.style.getPropertyValue(spec.props[0]) === 'auto') {
          field.setAuto()
          this.boundTokens.delete(spec.props.join(','))
          continue
        }
      }
      // allowAuto fields whose current CSS value (draft-or-computed) IS the auto keyword
      // (e.g. line-height: normal) display via setAuto() rather than resolving through fromCss.
      if (spec.allowAuto && !spec.sizeMode && !multi) {
        const css = this.currentValue(el, spec.props[0], computed)
        if (css === (spec.autoCss ?? 'normal')) {
          field.setAuto()
          this.boundTokens.delete(spec.props.join(','))
          continue
        }
      }
      const values = multi
        ? this.els.flatMap((e) => spec.props.map((p) => this.readValue(e, p, getComputedStyle(e), spec)))
        : spec.props.map((p) => this.readValue(el, p, computed, spec))
      const mixed = values.some((v) => v !== values[0])
      if (mixed) field.setMixed()
      else field.set(values[0])
      if (multi) continue // no token-pill bookkeeping across a multi-selection

      // B5: set() above unconditionally cleared any pill (B1 contract) — re-apply it when
      // this field has a bound token AND the just-read value still equals the bound px
      // (same-field refresh with an unchanged draft). A DIFFERING value (user edited the
      // field directly, or a different draft arrived) leaves the pill cleared and drops
      // the stale entry from boundTokens so it doesn't keep getting checked forever.
      //
      // Compare mode is an exception to BOTH halves of that: while comparing, `values`
      // was read from the ORIGINAL (pre-draft) computed style, not the live draft, so it
      // diverging from bound.px is expected and must NOT be treated as "the user changed
      // it" — skip the delete so un-compare can still re-bind. And the pill itself must
      // stay hidden while comparing (a pristine-preview state showing a token pill would
      // lie about what's actually drafted), so skip the bindToken call too.
      const key = spec.props.join(',')
      const bound = this.boundTokens.get(key)
      if (bound && !this.drafts.isComparing(el)) {
        if (!mixed && values[0] === bound.px) field.bindToken(bound.label)
        else this.boundTokens.delete(key)
      }
    }

    if (!multi) {
      // Layout/flex-child controls, family/weight/align selects, and Fill/Stroke's
      // single-element swatches are single-selection only (B6 decision).
      this.refreshLayoutSection(el, computed)
      this.refreshFlexChild(el, computed)
      this.refreshTypography(el, computed)
      this.refreshFillStroke(el, computed)
    } else {
      // Flex-child align/size-modes are single-only — DOM stays (stable order) but hidden.
      if (this.flexChildControlsWrap) this.flexChildControlsWrap.hidden = true
      for (const sm of this.sizeModes) sm.select.hidden = true
      this.refreshSelectionColors()
    }
  }

  private refreshLayoutSection(el: TaggedElement, computed: CSSStyleDeclaration): void {
    const flex = isFlex(el)
    if (this.addLayoutBtn) this.addLayoutBtn.hidden = flex
    if (this.layoutControlsWrap) this.layoutControlsWrap.hidden = !flex
    if (!flex) return

    const direction = this.currentValue(el, 'flex-direction', computed) === 'column' ? 'column' : 'row'
    const justify = this.currentValue(el, 'justify-content', computed)
    const align = this.currentValue(el, 'align-items', computed)
    const wrap = this.currentValue(el, 'flex-wrap', computed)
    const spaceBetween = justify === 'space-between'

    this.directionField?.set(direction)
    this.wrapField?.set(wrap === 'wrap' ? 'wrap' : 'nowrap')

    if (this.gapField) {
      const gapKey = GAP_SPEC.props.join(',')
      if (spaceBetween) {
        // setAuto (Figma "space it out for me") supersedes any bound pill — same rule as
        // the sizeMode W/H auto-continue path above: a switch to Auto must clear the
        // bookkeeping, not just the visible pill, so a later equal-px value can't resurrect it.
        this.gapField.setAuto()
        this.boundTokens.delete(gapKey)
      } else {
        const gapCss = this.drafts.isComparing(el) ? null : this.drafts.current(el, 'gap')
        const css = gapCss ?? computed.getPropertyValue('gap')
        const value = fromPx(css)
        this.gapField.set(value)

        // Same B5 re-bind contract as the generic field loop above (including the Compare
        // exception from B5's Compare-round-trip fix): skip while comparing so the pristine
        // preview state never shows a pill, and don't drop the entry on a Compare-induced
        // "divergence" that isn't really a user edit.
        const bound = this.boundTokens.get(gapKey)
        if (bound && !this.drafts.isComparing(el)) {
          if (value === bound.px) this.gapField.bindToken(bound.label)
          else this.boundTokens.delete(gapKey)
        }
      }
    }

    this.alignMatrix?.set(normalizeJustify(justify), normalizeAlign(align), direction, spaceBetween)
  }

  private refreshFlexChild(el: TaggedElement, computed: CSSStyleDeclaration): void {
    const parent = el.parentElement
    const visible = parent !== null && isFlex(parent as TaggedElement)
    if (this.alignSelfWrap) this.alignSelfWrap.hidden = !visible
    for (const sm of this.sizeModes) sm.select.hidden = !visible
    if (!visible) return

    const parentDirection = getComputedStyle(parent as TaggedElement).flexDirection.startsWith('column')
      ? 'column'
      : 'row'
    const main = mainAxisProp(parentDirection)

    const alignSelf = this.currentValue(el, 'align-self', computed)
    this.alignSelfField?.set(alignSelf || 'auto')

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
  private updateSizeMode(el: TaggedElement, sm: BoundSizeMode, main: 'width' | 'height'): void {
    const prop = sm.spec.props[0] as 'width' | 'height'
    const isMain = prop === main
    const draft = this.drafts.isComparing(el) ? null : this.drafts.current(el, prop)
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
      const alignSelfDraft = this.drafts.isComparing(el) ? null : this.drafts.current(el, 'align-self')
      const alignSelfCss = alignSelfDraft ?? computed.alignSelf
      if (alignSelfCss === 'stretch') {
        sm.select.value = 'fill'
        return
      }
    }

    sm.select.value = 'hug'
  }

  private refreshTypography(el: TaggedElement, computed: CSSStyleDeclaration): void {
    if (!this.typeFamilySelect && !this.typeWeightSelect && !this.typeAlignField) return

    if (this.typeFamilySelect) {
      const current = firstFamily(this.currentValue(el, 'font-family', computed))
      if (current && ![...this.typeFamilySelect.options].some((o) => o.value === current)) {
        const opt = document.createElement('option')
        opt.value = current
        opt.textContent = current
        this.typeFamilySelect.insertBefore(opt, this.typeFamilySelect.firstChild)
      }
      if (current) this.typeFamilySelect.value = current
    }

    if (this.typeWeightSelect) {
      this.typeWeightSelect.value = snapWeight(this.currentValue(el, 'font-weight', computed))
    }

    if (this.typeAlignField) {
      const align = this.currentValue(el, 'text-align', computed)
      this.typeAlignField.set(align === 'start' || align === '' ? 'left' : align)
    }
  }

  private refreshFillStroke(el: TaggedElement, computed: CSSStyleDeclaration): void {
    ;(this.fillRow as (HTMLElement & { __refresh?: () => void }) | null)?.__refresh?.()
    if (this.textRow) this.textRow.hidden = !hasDirectText(el)
    ;(this.textRow as (HTMLElement & { __refresh?: () => void }) | null)?.__refresh?.()
    ;(this.strokeColorRow as (HTMLElement & { __refresh?: () => void }) | null)?.__refresh?.()

    if (this.strokeStyleSelect) {
      const style = this.currentValue(el, 'border-top-style', computed)
      this.strokeStyleSelect.value = ['none', 'solid', 'dashed', 'dotted'].includes(style) ? style : 'none'
    }
  }

  private isMulti(): boolean {
    return this.els.length > 1
  }

  private currentValue(el: TaggedElement, prop: string, computed: CSSStyleDeclaration): string {
    const draft = this.drafts.isComparing(el) ? null : this.drafts.current(el, prop)
    return draft ?? computed.getPropertyValue(prop)
  }

  private readValue(el: TaggedElement, prop: string, computed: CSSStyleDeclaration, spec: RowSpec): number {
    const draft = this.drafts.isComparing(el) ? null : this.drafts.current(el, prop)
    const css = draft ?? computed.getPropertyValue(prop)
    return (spec.fromCss ?? fromPx)(css)
  }

  private buildBody(): void {
    for (const { field } of this.fields) field.destroy()
    if (this.gapField) this.gapField.destroy()
    // Rebuilding fields orphans any field mid-scrub — drop the reference so a stray
    // mouseup's endScrub closure (still attached to window until it fires) has nothing
    // matching to clear, and so a fresh selection never resolves onRelative against a
    // previous selection's baselines.
    this.scrubbingField = null
    this.scrubBaselines = null
    // Only sectionsRoot is wiped — the popover singletons are siblings of it directly in
    // `body` (same scrolled coordinate space, see the constructor's why-comment) and are
    // structurally untouchable by rebuilds. An earlier version cleared `body` itself and
    // had to remember to re-seed the pickers; the wrapper deletes that invariant.
    this.sectionsRoot.replaceChildren()
    this.fields = []
    this.sectionEls = []
    this.directionField = null
    this.gapField = null
    this.alignMatrix = null
    this.wrapField = null
    this.addLayoutBtn = null
    this.layoutControlsWrap = null
    this.alignSelfField = null
    this.alignSelfWrap = null
    this.flexChildControlsWrap = null
    this.sizeModes = []
    this.typeFamilySelect = null
    this.typeWeightSelect = null
    this.typeAlignField = null
    this.fillRow = null
    this.textRow = null
    this.strokeStyleSelect = null
    this.strokeColorRow = null
    this.selectionColorsTitle = null
    this.selectionColorsRows = null

    const multi = this.isMulti()

    for (const section of SECTIONS) {
      const title = document.createElement('div')
      title.className = 'panel-section'
      title.textContent = section.title
      this.sectionsRoot.append(title)
      // Every body element belonging to this section (title + rowWrap + custom body +
      // expandWrap, whichever apply) collects here so refresh() can hide them all together —
      // see the sectionEls field comment (final review finding E2).
      const sectionBodyEls: HTMLElement[] = [title]

      if (section.custom === 'layout') {
        const layoutBody = this.buildLayoutSection()
        this.sectionsRoot.append(layoutBody)
        sectionBodyEls.push(layoutBody)
        this.sectionEls.push({ spec: section, els: sectionBodyEls })
        continue
      }

      if (section.custom === 'typography') {
        const typographyBody = this.buildTypographySection(multi)
        this.sectionsRoot.append(typographyBody)
        sectionBodyEls.push(typographyBody)
        this.sectionEls.push({ spec: section, els: sectionBodyEls })
        continue
      }

      if (section.custom === 'fill') {
        const fillBody = this.buildFillSection()
        this.sectionsRoot.append(fillBody)
        sectionBodyEls.push(fillBody)
        this.sectionEls.push({ spec: section, els: sectionBodyEls })
        continue
      }

      let rowWrap: HTMLElement
      if (section.custom === 'stroke') {
        // Stroke's body (W+style row, then Color row) is custom, but still a single
        // .panel-rows sibling — the expand-button logic below appends its own expandWrap
        // (BT/BR/BB/BL) as the next body child after it, same shape as every other
        // expandable section.
        rowWrap = this.buildStrokeSection()
        this.sectionsRoot.append(rowWrap)
      } else {
        rowWrap = document.createElement('div')
        rowWrap.className = 'panel-rows'
        this.sectionsRoot.append(rowWrap)
        for (const row of section.rows) rowWrap.append(this.buildRow(row))
      }
      sectionBodyEls.push(rowWrap)

      if (section.title === 'Size') {
        rowWrap.append(this.buildFlexChildControls())
      }

      if (section.expandRows && section.expandKey) {
        const expandKey = section.expandKey
        const expandWrap = document.createElement('div')
        expandWrap.className = 'panel-rows'
        expandWrap.hidden = !(this.expandState.get(expandKey) ?? false)
        const btn = document.createElement('button')
        btn.textContent = '⋯'
        btn.setAttribute('data-expand', expandKey)
        btn.addEventListener('click', () => {
          expandWrap.hidden = !expandWrap.hidden
          this.expandState.set(expandKey, !expandWrap.hidden)
        })
        title.append(btn)
        for (const row of section.expandRows) expandWrap.append(this.buildRow(row))
        this.sectionsRoot.append(expandWrap)
        sectionBodyEls.push(expandWrap)
      }

      this.sectionEls.push({ spec: section, els: sectionBodyEls })

      // Selection colors (B6): a genuinely new section that only exists in multi-mode —
      // built right after Stroke (replacing Fill+Stroke) so section order stays fixed.
      // Unlike Fill/Stroke (which pre-exist for single-mode and get hidden), this DOM
      // isn't created at all in single-select — keeps the pre-existing single-el section
      // list assertion (Layout..Appearance, no 9th entry) untouched.
      if (section.title === 'Stroke' && multi) {
        this.sectionsRoot.append(this.buildSelectionColorsSection())
      }
    }
  }

  private buildLayoutSection(): HTMLElement {
    const wrap = document.createElement('div')
    wrap.className = 'panel-rows layout-section'

    const addBtn = document.createElement('button')
    addBtn.textContent = '+ Add auto layout'
    addBtn.setAttribute('data-add-layout', '')
    addBtn.addEventListener('click', () => {
      if (!this.el) return
      this.onBeforeEdit(this.el)
      this.drafts.apply(this.el, 'display', 'flex')
      this.refresh()
      this.onEdited()
    })
    this.addLayoutBtn = addBtn
    wrap.append(addBtn)

    const controls = document.createElement('div')
    controls.className = 'panel-rows layout-controls'
    this.layoutControlsWrap = controls

    this.directionField = new SegmentField({
      label: 'Direction',
      options: [
        { value: 'row', label: 'Row' },
        { value: 'column', label: 'Column' },
      ],
      onInput: (value) => {
        if (!this.el) return
        this.onBeforeEdit(this.el)
        this.drafts.apply(this.el, 'flex-direction', value)
        this.refresh()
        this.onEdited()
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
        if (!this.el) return
        this.onBeforeEdit(this.el)
        this.drafts.apply(this.el, 'justify-content', justify)
        this.drafts.apply(this.el, 'align-items', align)
        this.refresh()
        this.onEdited()
      },
    })
    tile.append(this.alignMatrix.root)
    grid.append(tile)

    const side = document.createElement('div')
    side.className = 'layout-side'

    this.gapField = new NumberField({
      label: 'Gap',
      min: 0,
      allowAuto: true,
      onInput: (n) => {
        if (!this.el) return
        this.onBeforeEdit(this.el)
        this.drafts.apply(this.el, 'gap', px(n))
        this.refresh()
        this.onEdited()
      },
      onDetach: () => {
        // Mirrors buildField's onDetach — drop the bookkeeping so a later refresh() doesn't
        // try to re-bind a pill the user explicitly detached via Backspace.
        this.boundTokens.delete(GAP_SPEC.props.join(','))
      },
      onTokenKey: this.isMulti()
        ? undefined
        : () => {
            if (!this.el || !this.gapField) return
            const entries = tokenEntriesFor(GAP_SPEC, readTheme(), readTokens())
            if (!entries) return
            const field = this.gapField
            this.tokenPicker.open({
              anchor: field.root,
              entries,
              onApply: (entry) => {
                if (!this.el) return
                this.onBeforeEdit(this.el)
                this.drafts.apply(this.el, 'gap', px(entry.px))
                this.refresh()
                this.onEdited()
                const label = this.pillLabelFor(GAP_SPEC, entry)
                field.bindToken(label)
                this.boundTokens.set(GAP_SPEC.props.join(','), { label, px: entry.px })
              },
            })
          },
      onKeyword: (kw) => {
        if (!this.el || kw !== 'auto') return
        this.onBeforeEdit(this.el)
        this.drafts.apply(this.el, 'justify-content', 'space-between')
        // Figma semantics: switching gap to Auto means "space it out for me" —
        // any explicit gap draft is cleared (not just zeroed) so justify-content
        // alone controls spacing. Use a targeted discard (not commit) so a
        // pre-existing inline gap the app itself authored is restored rather
        // than silently destroyed.
        if (this.drafts.current(this.el, 'gap') !== null) this.drafts.discard(this.el, ['gap'])
        this.refresh()
        this.onEdited()
      },
    })
    side.append(this.gapField.root)

    this.wrapField = new SegmentField({
      label: 'Wrap',
      options: [
        { value: 'nowrap', label: 'No wrap' },
        { value: 'wrap', label: 'Wrap' },
      ],
      onInput: (value) => {
        if (!this.el) return
        this.onBeforeEdit(this.el)
        this.drafts.apply(this.el, 'flex-wrap', value)
        this.refresh()
        this.onEdited()
      },
    })
    side.append(this.wrapField.root)

    grid.append(side)
    controls.append(grid)

    wrap.append(controls)
    return wrap
  }

  private buildTypographySection(multi = false): HTMLElement {
    const wrap = document.createElement('div')
    wrap.className = 'panel-rows'

    if (!multi) {
      // Row 1 — Family.
      const familySelect = document.createElement('select')
      familySelect.className = 'size-mode type-family'
      const families = new Set<string>()
      if (this.el) {
        const current = firstFamily(getComputedStyle(this.el).getPropertyValue('font-family'))
        if (current) families.add(current)
      }
      for (const f of documentFontFamilies()) families.add(f)
      for (const f of ['system-ui', 'serif', 'monospace']) families.add(f)
      for (const f of families) {
        const opt = document.createElement('option')
        opt.value = f
        opt.textContent = f
        familySelect.append(opt)
      }
      familySelect.addEventListener('change', () => {
        if (!this.el) return
        this.onBeforeEdit(this.el)
        this.drafts.apply(this.el, 'font-family', cssFamilyValue(familySelect.value))
        this.refresh()
        this.onEdited()
      })
      this.typeFamilySelect = familySelect
      wrap.append(familySelect)

      // Row 2 — Weight.
      const weightSelect = document.createElement('select')
      weightSelect.className = 'size-mode type-weight'
      for (const [value, label] of WEIGHTS) {
        const opt = document.createElement('option')
        opt.value = value
        opt.textContent = label
        weightSelect.append(opt)
      }
      weightSelect.addEventListener('change', () => {
        if (!this.el) return
        this.onBeforeEdit(this.el)
        this.drafts.apply(this.el, 'font-weight', weightSelect.value)
        this.refresh()
        this.onEdited()
      })
      this.typeWeightSelect = weightSelect
      wrap.append(weightSelect)
    }

    // Row 3 — Size + Line height.
    const sizeRow = document.createElement('div')
    sizeRow.className = 'type-row'
    sizeRow.append(
      this.buildField({ label: 'S', props: ['font-size'], min: 1 }).field.root,
      this.buildField({
        label: 'LH',
        props: ['line-height'],
        allowAuto: true,
        autoCss: 'normal',
        fromCss: (css) => Math.round(Number.parseFloat(css)) || 0,
      }).field.root
    )
    wrap.append(sizeRow)

    // Row 4 — Letter spacing + Align.
    const lsRow = document.createElement('div')
    lsRow.className = 'type-row'
    lsRow.append(this.buildField({ label: 'LS', props: ['letter-spacing'] }).field.root)

    if (!multi) {
      this.typeAlignField = new SegmentField({
        label: 'Align',
        options: [
          { value: 'left', label: 'Left' },
          { value: 'center', label: 'Center' },
          { value: 'right', label: 'Right' },
        ],
        onInput: (value) => {
          if (!this.el) return
          this.onBeforeEdit(this.el)
          this.drafts.apply(this.el, 'text-align', value)
          this.refresh()
          this.onEdited()
        },
      })
      this.typeAlignField.root.setAttribute('data-text-align', '')
      lsRow.append(this.typeAlignField.root)
    }
    wrap.append(lsRow)

    return wrap
  }

  /** Renders a token name (exact nearestColorToken match) or a short hex fallback for display. */
  private colorLabel(css: string): string {
    const parsed = parseColorLocal(css)
    if (!parsed) return css
    // Fully-transparent always renders as the literal keyword — a nearest-token guess (which
    // only compares r/g/b) would otherwise report some opaque color's name for a color that's
    // actually invisible.
    if (parsed.a === 0) return 'transparent'
    // Token names are only claimed for fully-opaque colors — a semi-transparent value must
    // show its own hex (with alpha) rather than borrowing an opaque token's name, even when
    // the r/g/b channels coincide.
    if (parsed.a === 1) {
      const nearest = nearestColorToken(parsed, readTokens().colors)
      if (nearest && nearest.distance === 0) return nearest.token.name
    }
    return rgbToHex(parsed.r, parsed.g, parsed.b, parsed.a)
  }

  /** Builds a `.color-row` — swatch button + value text — wired to open the shared ColorPicker. */
  private buildColorRow(opts: {
    label: string
    getCss: () => string
    getContrastAgainst: () => string | null
    onPick: (css: string) => void
  }): HTMLElement {
    const row = document.createElement('div')
    row.className = 'color-row'

    const labelEl = document.createElement('span')
    labelEl.className = 'nf-label'
    labelEl.textContent = opts.label
    row.append(labelEl)

    const swatch = document.createElement('button')
    swatch.type = 'button'
    swatch.className = 'swatch'
    row.append(swatch)

    // Color lives on a child element stacked on top of the parent's checkerboard —
    // see the `.swatch`/`.swatch-color` comment in overlay.ts for why (background-color
    // on the parent itself would paint beneath the checkerboard background-image layers).
    const swatchColor = document.createElement('span')
    swatchColor.className = 'swatch-color'
    swatch.append(swatchColor)

    const valueEl = document.createElement('span')
    valueEl.className = 'color-value'
    row.append(valueEl)

    swatch.addEventListener('click', () => {
      this.colorPicker.open({
        anchor: row,
        initial: opts.getCss(),
        contrastAgainst: opts.getContrastAgainst(),
        // `meta.token` (the exact token name, when the pick came from a palette swatch
        // or nearest-token hint) is intentionally unused here — reserved surface for B5's
        // token pills (showing which colors are backed by a design token) rather than dead code.
        onPick: (css, _meta) => {
          if (!this.el) return
          this.onBeforeEdit(this.el)
          opts.onPick(css)
          this.refresh()
          this.onEdited()
        },
      })
    })

    ;(row as HTMLElement & { __refresh?: () => void }).__refresh = () => {
      const css = opts.getCss()
      swatchColor.style.color = css
      valueEl.textContent = this.colorLabel(css)
    }
    return row
  }

  private buildFillSection(): HTMLElement {
    const wrap = document.createElement('div')
    wrap.className = 'panel-rows'

    const fillRow = this.buildColorRow({
      label: 'Fill',
      getCss: () => (this.el ? this.currentValue(this.el, 'background-color', getComputedStyle(this.el)) : ''),
      getContrastAgainst: () => (this.el ? this.currentValue(this.el, 'color', getComputedStyle(this.el)) : null),
      onPick: (css) => {
        if (!this.el) return
        this.drafts.apply(this.el, 'background-color', css)
      },
    })
    wrap.append(fillRow)
    this.fillRow = fillRow

    const textRow = this.buildColorRow({
      label: 'Text',
      getCss: () => (this.el ? this.currentValue(this.el, 'color', getComputedStyle(this.el)) : ''),
      getContrastAgainst: () => (this.el ? effectiveBackground(this.el, this.drafts) : null),
      onPick: (css) => {
        if (!this.el) return
        this.drafts.apply(this.el, 'color', css)
      },
    })
    wrap.append(textRow)
    this.textRow = textRow

    return wrap
  }

  private buildStrokeSection(): HTMLElement {
    const wrap = document.createElement('div')
    wrap.className = 'panel-rows stroke-rows'

    const row1 = document.createElement('div')
    row1.className = 'stroke-row'
    const widthField = this.buildField({
      label: 'W',
      props: BORDER_WIDTH_PROPS,
      min: 0,
      fromCss: (css) => {
        const n = Math.round(Number.parseFloat(css))
        return Number.isFinite(n) ? n : 0
      },
      onBeforeApply: draftSolidIfNone,
    })
    row1.append(widthField.field.root)

    const styleSelect = document.createElement('select')
    styleSelect.className = 'size-mode stroke-style'
    for (const [value, label] of [
      ['none', 'None'],
      ['solid', 'Solid'],
      ['dashed', 'Dashed'],
      ['dotted', 'Dotted'],
    ] as const) {
      const opt = document.createElement('option')
      opt.value = value
      opt.textContent = label
      styleSelect.append(opt)
    }
    styleSelect.addEventListener('change', () => {
      if (!this.el) return
      this.onBeforeEdit(this.el)
      for (const prop of BORDER_STYLE_PROPS) this.drafts.apply(this.el, prop, styleSelect.value)
      this.refresh()
      this.onEdited()
    })
    this.strokeStyleSelect = styleSelect
    row1.append(styleSelect)

    const row2 = document.createElement('div')
    row2.className = 'stroke-row'
    const colorRow = this.buildColorRow({
      label: 'Color',
      getCss: () => (this.el ? this.currentValue(this.el, 'border-top-color', getComputedStyle(this.el)) : ''),
      getContrastAgainst: () => (this.el ? effectiveBackground(this.el, this.drafts) : null),
      onPick: (css) => {
        if (!this.el) return
        for (const prop of BORDER_COLOR_PROPS) this.drafts.apply(this.el, prop, css)
      },
    })
    row2.append(colorRow)
    this.strokeColorRow = colorRow

    wrap.append(row1, row2)
    return wrap
  }

  /**
   * "Selection colors" (B6, multi-select only) — aggregates background-color/color/
   * border-top-color across every element in the selection, grouped by exact rgba, one
   * row per unique color with a usage count. Its section TITLE is a normal SECTIONS-array
   * entry (appended right after Stroke in buildBody) so it participates in the same
   * hidden-via-refresh convention as every other section.
   */
  private buildSelectionColorsSection(): HTMLElement {
    const title = document.createElement('div')
    title.className = 'panel-section'
    title.textContent = 'Selection colors'
    this.selectionColorsTitle = title
    this.sectionsRoot.append(title)

    const rows = document.createElement('div')
    rows.className = 'panel-rows sc-rows'
    this.selectionColorsRows = rows
    return rows
  }

  /** Usage of one exact color: which (el, prop) pairs currently hold it. */
  private groupSelectionColors(): Array<{ css: string; usages: Array<{ el: TaggedElement; prop: string }> }> {
    const groups = new Map<string, { css: string; usages: Array<{ el: TaggedElement; prop: string }> }>()
    for (const el of this.els) {
      const computed = getComputedStyle(el)
      for (const prop of ['background-color', 'color', 'border-top-color']) {
        // `color` is meaningless to aggregate for an element with no direct text of its own
        // (it's rendering nothing) — e.g. a pure layout wrapper's inherited/cascaded `color`
        // would otherwise show up as a "usage" the user never actually sees painted.
        if (prop === 'color' && !hasDirectText(el)) continue
        // border-top-color similarly means nothing when there's no visible border to paint
        // it on — a computed width of 0 (no border authored) or an explicit `none` style
        // means the color, however it resolves (often currentColor), is never rendered.
        if (prop === 'border-top-color') {
          const styleCss = this.currentValue(el, 'border-top-style', computed)
          const widthCss = this.currentValue(el, 'border-top-width', computed)
          const widthPx = Number.parseFloat(widthCss)
          if (styleCss === 'none' || !Number.isFinite(widthPx) || widthPx === 0) continue
        }
        const css = this.currentValue(el, prop, computed)
        const parsed = parseColorLocal(css)
        if (!parsed || parsed.a === 0) continue // skip transparent/unset
        const key = `${parsed.r},${parsed.g},${parsed.b},${parsed.a}`
        let group = groups.get(key)
        if (!group) {
          group = { css, usages: [] }
          groups.set(key, group)
        }
        group.usages.push({ el, prop })
      }
    }
    return [...groups.values()]
  }

  private refreshSelectionColors(): void {
    if (!this.selectionColorsRows) return
    const rows = this.selectionColorsRows
    rows.replaceChildren()
    for (const group of this.groupSelectionColors()) {
      const row = document.createElement('div')
      row.className = 'color-row sc-row'

      const swatch = document.createElement('button')
      swatch.type = 'button'
      swatch.className = 'swatch'
      const swatchColor = document.createElement('span')
      swatchColor.className = 'swatch-color'
      swatchColor.style.color = group.css
      swatch.append(swatchColor)
      row.append(swatch)

      const valueEl = document.createElement('span')
      valueEl.className = 'color-value'
      valueEl.textContent = this.colorLabel(group.css)
      row.append(valueEl)

      const countEl = document.createElement('span')
      countEl.className = 'sc-count'
      countEl.textContent = `×${group.usages.length}`
      row.append(countEl)

      swatch.addEventListener('click', () => {
        this.colorPicker.open({
          anchor: row,
          initial: group.css,
          contrastAgainst: null,
          onPick: (css) => {
            for (const { el, prop } of group.usages) {
              this.onBeforeEdit(el)
              if (prop === 'border-top-color') {
                for (const borderProp of BORDER_COLOR_PROPS) this.drafts.apply(el, borderProp, css)
              } else {
                this.drafts.apply(el, prop, css)
              }
            }
            this.refresh()
            this.onEdited()
          },
        })
      })

      rows.append(row)
    }
  }

  private buildFlexChildControls(): HTMLElement {
    const wrap = document.createElement('div')
    wrap.className = 'flex-child-controls'
    this.flexChildControlsWrap = wrap
    this.alignSelfField = new SegmentField({
      label: 'Align',
      options: [
        { value: 'auto', label: 'Auto' },
        { value: 'flex-start', label: 'Start' },
        { value: 'center', label: 'Center' },
        { value: 'flex-end', label: 'End' },
        { value: 'stretch', label: 'Stretch' },
      ],
      onInput: (value) => {
        if (!this.el) return
        this.onBeforeEdit(this.el)
        this.drafts.apply(this.el, 'align-self', value)
        this.refresh()
        this.onEdited()
      },
    })
    this.alignSelfField.root.setAttribute('data-align-self', '')
    this.alignSelfWrap = this.alignSelfField.root
    wrap.append(this.alignSelfField.root)
    return wrap
  }

  private buildRow(spec: RowSpec): HTMLElement {
    const bound = this.buildField(spec)
    if (!spec.sizeMode) return bound.field.root

    const row = document.createElement('div')
    row.className = 'size-row'
    row.append(bound.field.root)

    const select = document.createElement('select')
    select.className = 'size-mode'
    for (const [value, label] of [
      ['fixed', 'Fixed'],
      ['hug', 'Hug'],
      ['fill', 'Fill'],
    ] as const) {
      const opt = document.createElement('option')
      opt.value = value
      opt.textContent = label
      select.append(opt)
    }
    select.addEventListener('change', () => {
      this.onSizeModeChange(spec, select.value)
    })
    row.append(select)

    this.sizeModes.push({ select, spec, field: bound.field })
    return row
  }

  private onSizeModeChange(spec: RowSpec, mode: string): void {
    if (!this.el) return
    this.onBeforeEdit(this.el)
    const prop = spec.props[0]
    const parent = this.el.parentElement
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
        : this.drafts.current(this.el, 'align-self') === 'stretch'
          ? ['align-self']
          : []
      const isAutoNow = this.drafts.current(this.el, prop) === 'auto'
      if (isAutoNow) modeProps.push(prop)
      let computedSize = Math.round(parseFloat(getComputedStyle(this.el).getPropertyValue(prop)))
      // If jsdom can't compute the size (returns NaN for 'auto' without layout engine),
      // fall back to the original value that will be restored by discard()
      if (isNaN(computedSize) && isAutoNow) {
        const draftEntry = this.drafts.entries().get(this.el)?.get(prop)
        computedSize = draftEntry ? Math.round(parseFloat(draftEntry.original)) : computedSize
      }
      // Unconditional guard: whatever the source, never draft a non-finite size — bail
      // out of the pin entirely rather than writing e.g. "NaNpx" into the change request.
      if (!Number.isFinite(computedSize)) return
      this.drafts.discard(this.el, modeProps)
      this.drafts.apply(this.el, prop, `${computedSize}px`)
    } else if (mode === 'hug') {
      this.drafts.apply(this.el, prop, 'auto')
    } else if (mode === 'fill') {
      if (isMain) {
        this.drafts.apply(this.el, 'flex-grow', '1')
        this.drafts.apply(this.el, 'flex-basis', '0%')
      } else {
        this.drafts.apply(this.el, 'align-self', 'stretch')
      }
    }
    this.refresh()
    this.onEdited()
  }

  /**
   * Full Tailwind utility label for a token-picker entry applied to `spec` (e.g. `px-4`,
   * `rounded-md`, `text-sm`). Radius rows are NOT special-cased to `rounded-*` uniformly —
   * a single-corner row (TL/TR/BR/BL, props.length === 1) must yield its own honest
   * `rounded-tl-md`-style label via UTILITY_PREFIXES (utilityPrefixFor resolves each
   * longhand's own prefix), while the linked R row (all 4 corners) resolves through
   * MULTI_PROP_SYNTHETIC to the collapsed `rounded-md` form.
   */
  private pillLabelFor(spec: RowSpec, entry: TokenEntry): string {
    if (spec.props.some((p) => p === 'font-size')) return `text-${entry.label}`
    const prefix = utilityPrefixFor(spec.props) ?? spec.props[0]
    return `${prefix}-${entry.label}`
  }

  private buildField(spec: RowSpec): BoundField {
    // Shared commit path — used by the field's own onInput AND by the token picker's
    // onApply (per the brief: "call the SAME handler the field's onInput uses").
    // Plain numbers/standalone expressions and token picks are always ABSOLUTE — in
    // multi-select that means applying the SAME css to every element in the selection.
    const commit = (n: number): void => {
      if (!this.el) return
      const css = (spec.toCss ?? px)(n)
      for (const el of this.els) {
        this.onBeforeEdit(el)
        for (const prop of spec.props) {
          spec.onBeforeApply?.(el, prop, this.drafts)
          this.drafts.apply(el, prop, css)
        }
      }
      this.refresh()
      this.onEdited()
    }

    // B6: a leading-operator entry (+8, *2, ...) is a RELATIVE delta — for each element in
    // the selection, read ITS OWN current value per prop and apply the closure against it
    // (never overwriting with the same absolute number). This is the core VisBug behavior:
    // el A at 10px + el B at 20px, both `+8`, land at 18px/28px — never both at 18.
    const commitRelative = (apply: (current: number) => number): void => {
      if (!this.el) return
      for (const el of this.els) {
        this.onBeforeEdit(el)
        const computed = getComputedStyle(el)
        for (const prop of spec.props) {
          const current = this.readValue(el, prop, computed, spec)
          const css = (spec.toCss ?? px)(apply(current))
          spec.onBeforeApply?.(el, prop, this.drafts)
          this.drafts.apply(el, prop, css)
        }
      }
      this.refresh()
      this.onEdited()
    }

    // B6 scrub: baselines are snapshotted ONCE per drag (onScrubStart) — every subsequent
    // onRelative call during that same drag (each mousemove tick) resolves `apply(baseline)`
    // against the SAME frozen per-element-per-prop baseline, so a move REPLACES the previous
    // move's effect instead of accumulating (matches NumberField's own single-el scrub contract).
    const commitScrubRelative = (apply: (baseline: number) => number): void => {
      if (!this.el) return
      const baselines = this.scrubBaselines
      for (const el of this.els) {
        this.onBeforeEdit(el)
        const computed = getComputedStyle(el)
        for (const prop of spec.props) {
          const baseline = baselines?.get(el)?.get(prop) ?? this.readValue(el, prop, computed, spec)
          const css = (spec.toCss ?? px)(apply(baseline))
          spec.onBeforeApply?.(el, prop, this.drafts)
          this.drafts.apply(el, prop, css)
        }
      }
      this.refresh()
      this.onEdited()
    }

    // B6's onRelative/onScrubStart are wired ONLY in multi-select. Single-selection keeps
    // the pre-B6 NumberField construction byte-for-byte: NumberField's own documented CAVEAT
    // means wiring onRelative at all changes how a bare negative number (`-8`) parses (it
    // becomes `current - 8`, a relative delta, instead of the literal -8) — acceptable/intended
    // for multi-select's relative-delta model, but would silently regress single-element
    // typing (e.g. letter-spacing "-1") if wired unconditionally. isMulti() is fixed for the
    // lifetime of this field (buildBody() rebuilds fields fresh on every selection change).
    const multi = this.isMulti()

    const field = new NumberField({
      label: spec.label,
      min: spec.min,
      max: spec.max,
      allowAuto: spec.sizeMode || spec.allowAuto,
      onInput: commit,
      onRelative: multi
        ? (apply) => {
            // Relative deltas apply per-element against each element's own current value —
            // never an absolute overwrite (the core VisBug behavior: el A at 10px + el B at
            // 20px, both `+8`, land at 18px/28px). While a scrub is in progress for THIS
            // field, resolve against the frozen onScrubStart baselines instead of a fresh
            // read, so each drag tick replaces (not accumulates on) the previous tick.
            if (this.scrubbingField === field) commitScrubRelative(apply)
            else commitRelative(apply)
          }
        : undefined,
      onScrubStart: multi
        ? () => {
            this.scrubbingField = field
            this.snapshotScrubBaselines(spec)
            const endScrub = (): void => {
              if (this.scrubbingField === field) {
                this.scrubbingField = null
                this.scrubBaselines = null
              }
              window.removeEventListener('mouseup', endScrub)
            }
            window.addEventListener('mouseup', endScrub)
          }
        : undefined,
      onKeyword: spec.allowAuto
        ? (kw) => {
            if (!this.el || kw !== 'auto') return
            for (const el of this.els) {
              this.onBeforeEdit(el)
              for (const prop of spec.props) this.drafts.apply(el, prop, spec.autoCss ?? 'normal')
            }
            this.refresh()
            this.onEdited()
          }
        : undefined,
      onDetach: () => {
        // Backspace on a pill: field.detach() (called by NumberField itself right after this)
        // restores the numeric display — drafts are untouched. Just drop the bookkeeping so a
        // later refresh() doesn't try to re-bind a pill the user explicitly detached.
        this.boundTokens.delete(spec.props.join(','))
      },
      onTokenKey: multi
        ? undefined
        : () => {
            if (!this.el) return
            const entries = tokenEntriesFor(spec, readTheme(), readTokens())
            if (!entries) return
            this.tokenPicker.open({
              anchor: field.root,
              entries,
              onApply: (entry) => {
                commit(entry.px)
                const label = this.pillLabelFor(spec, entry)
                field.bindToken(label)
                this.boundTokens.set(spec.props.join(','), { label, px: entry.px })
              },
            })
          },
    })
    const bound: BoundField = { field, spec }
    this.fields.push(bound)
    return bound
  }

  /**
   * Snapshots each selected element's CURRENT (draft-or-computed) value for every prop this
   * field spec covers — taken once at scrub start (label mousedown), reused unchanged across
   * every onRelative call in the same drag. Keyed by field identity via `scrubbingField` (set
   * in onScrubStart) so commitScrubRelative knows which field's baselines are live.
   */
  private snapshotScrubBaselines(spec: RowSpec): void {
    const baselines = new Map<TaggedElement, Map<string, number>>()
    for (const el of this.els) {
      const computed = getComputedStyle(el)
      const perProp = new Map<string, number>()
      for (const prop of spec.props) perProp.set(prop, this.readValue(el, prop, computed, spec))
      baselines.set(el, perProp)
    }
    this.scrubBaselines = baselines
  }
}
