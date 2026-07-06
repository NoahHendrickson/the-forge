import type { TaggedElement } from './source'
import type { InspectorData } from './inspector'
import { DraftStore } from './drafts'
import { NumberField } from './controls'
import { createButton } from './ui/button'
import { createSelect } from './ui/select'
import { createMenuButton } from './ui/menu'
import { createColorRow } from './ui/swatch'
import { SegmentField } from './layout-controls'
import { ColorPicker } from './colorpicker'
import { PanelTokenUi, colorDisplay } from './panel-token-ui'
import { LayoutSection } from './panel-layout'
import { readTokens, readTheme, parseColor as parseColorLocal } from './tokens'
import {
  type RowSpec,
  type SectionSpec,
  BORDER_WIDTH_PROPS,
  BORDER_STYLE_PROPS,
  BORDER_COLOR_PROPS,
  GAP_SPEC,
  draftSolidIfNone,
  tokenEntriesFor,
  colorTokenEntries,
  cssHintFor,
  WEIGHTS,
  STROKE_STYLES,
  SIZE_ROWS,
  PADDING_ROWS,
  minMaxRowsFor,
  SECTIONS,
} from './panel-specs'
import {
  px,
  fromPx,
  effectiveBackground,
  normalizeJustify,
  normalizeAlign,
  hasDirectText,
  snapWeight,
  firstFamily,
  cssFamilyValue,
  documentFontFamilies,
} from './panel-readers'

export { tokenEntriesFor, colorTokenEntries } from './panel-specs'
export { normalizeJustify, normalizeAlign, hasDirectText } from './panel-readers'

interface BoundField {
  field: NumberField
  spec: RowSpec
}

export class Panel {
  root = document.createElement('div')
  compareButton = createButton()
  resetButton = createButton()
  footer = document.createElement('div')
  resizeHandle = document.createElement('div')
  modeButton = createButton()
  /** Free-form prompt entry point (prompt-mode spec) — lives in the panel header, hidden
   * whenever there's no live selection (docked "No selection" state included). Panel does
   * NOT know about PromptBox itself; index.ts wires the click (Task 4). */
  promptButton = createButton({ label: 'Prompt', className: 'panel-prompt' })
  /** Mount slot for the Changes lifecycle list (changelist.ts) — owned/populated by
   * DesignMode, positioned here so it pins between the scrolling sections and the footer
   * and stays visible in the docked no-selection empty state (body hidden, footer kept). */
  changesSlot = document.createElement('div')

  private head = document.createElement('div')
  private headTag = document.createElement('div')
  private headSrc = document.createElement('div')
  /** Corner action cluster (Prompt + mode toggle) — a single absolutely-positioned flex
   * wrapper so .panel-prompt (content-sized) can sit beside .panel-mode (fixed 22px)
   * without either button needing a guessed fixed offset (overlay.ts .panel-head-actions). */
  private headActions = document.createElement('div')
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

  // Layout section + flex-child widgets — owned by LayoutSection (panel-layout.ts),
  // rebuilt per show() via buildBody()/buildFlexChildControls(), re-set() per refresh().
  private layoutSection: LayoutSection
  // The gap NumberField itself stays born in panel.ts (buildGapField, the single field-birth
  // site) — LayoutSection holds its own reference for refresh purposes, but panel.ts still
  // owns destroy() on rebuild, same as every other field in `this.fields`.
  private gapField: NumberField | null = null

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
  // Owned by PanelTokenUi, which also owns the bound-pill bookkeeping (see its class docs).
  private tokenUi: PanelTokenUi

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
      this.tokenUi.clear()
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
    this.promptButton.type = 'button'
    this.promptButton.hidden = true
    this.headActions.className = 'panel-head-actions'
    this.headActions.append(this.promptButton, this.modeButton)
    this.head.append(this.headActions)
    this.root.append(this.resizeHandle, this.head, this.actions, this.emptyEl, this.body, this.changesSlot, this.footer)
    // Popovers mount in the BODY (the scroll container), not the root — anchor.offsetTop
    // and the popover's absolute top must share the body's scrolled coordinate space or
    // the popover stops tracking its row the moment the sections scroll (see overlay.ts
    // .panel-body comment).
    this.colorPicker = new ColorPicker(this.body)
    this.tokenUi = new PanelTokenUi(this.body, () => this.el)
    this.layoutSection = new LayoutSection({
      drafts: this.drafts,
      getEl: () => this.el,
      currentValue: (el, prop, computed) => this.currentValue(el, prop, computed),
      onBeforeEdit: (el) => this.onBeforeEdit(el),
      onEdited: () => this.onEdited(),
      refresh: () => this.refresh(),
      tokenUi: this.tokenUi,
      buildGapField: () => this.buildGapField(),
    })
    // Mutual exclusivity (final review fix #11): opening one popover must close the other —
    // two open at once would overlap/fight for the same anchor-relative position. Wired here
    // so ColorPicker and TokenPicker stay fully decoupled from one another; only Panel, which
    // holds both instances, knows they're mutually exclusive. TokenPicker exposes a beforeOpen
    // hook instead of having its open() wrapped — monkey-patching a generic method would erase
    // the per-call entry typing open<E>() provides (PR #6 review).
    const colorPickerOpen = this.colorPicker.open.bind(this.colorPicker)
    this.colorPicker.open = (opts) => {
      this.tokenUi.picker.close()
      colorPickerOpen(opts)
    }
    this.tokenUi.picker.beforeOpen = () => this.colorPicker.close()
  }

  show(elOrEls: TaggedElement | TaggedElement[], data: InspectorData): void {
    const els = Array.isArray(elOrEls) ? elOrEls : [elOrEls]
    this.els = els
    const el = els[0] ?? null
    this.el = el
    this.colorPicker.close()
    this.tokenUi.picker.close()
    this.tokenUi.clear()
    this.root.hidden = false
    this.actions.hidden = false
    this.body.hidden = false
    this.emptyEl.hidden = true
    this.promptButton.hidden = false
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
    this.tokenUi.picker.close()
    this.promptButton.hidden = true
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
      // Decision (B6, re-scoped M-C): the auto-layout cluster (matrix/direction) across N
      // elements is ambiguous, so LayoutSection.refresh (below) hides just the cluster/add/
      // remove widgets in multi — but the section itself (W/H + padding rows) stays visible,
      // since those rows keep the same relative-delta multi behavior as every other row.
      // Layout has no `visible` predicate, so it falls through to the generic path and is
      // always shown here.
      if (spec.title === 'Fill' || spec.title === 'Stroke') {
        // Replaced by Selection colors in multi-mode — title AND body hide together.
        this.setSectionHidden(spec, sectionEls, multi || (spec.visible ? !spec.visible(el, this.drafts) : false))
        continue
      }
      if (multi) {
        // visible when applicable to ANY element in the selection (hasDirectText any, flex any…).
        this.setSectionHidden(spec, sectionEls, spec.visible ? !this.els.some((e) => spec.visible!(e, this.drafts)) : false)
      } else {
        this.setSectionHidden(spec, sectionEls, spec.visible ? !spec.visible(el, this.drafts) : false)
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
          this.tokenUi.drop(spec)
          continue
        }
        if (draft === null && !this.drafts.isComparing(el) && el.style.getPropertyValue(spec.props[0]) === 'auto') {
          field.setAuto()
          this.tokenUi.drop(spec)
          continue
        }
      }
      // allowAuto fields whose current CSS value (draft-or-computed) IS the auto keyword
      // (e.g. line-height: normal) display via setAuto() rather than resolving through fromCss.
      if (spec.allowAuto && !spec.sizeMode && !multi) {
        const css = this.currentValue(el, spec.props[0], computed)
        if (css === (spec.autoCss ?? 'normal')) {
          field.setAuto()
          this.tokenUi.drop(spec)
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

      // B5 re-bind contract — see PanelTokenUi.rebind
      this.tokenUi.rebind(spec, field, values[0], mixed, this.drafts.isComparing(el))
    }

    this.layoutSection.refresh(el, computed, multi)
    if (!multi) {
      // Family/weight/align selects and Fill/Stroke's single-element swatches are
      // single-selection only (B6 decision).
      this.refreshTypography(el, computed)
      this.refreshFillStroke(el, computed)
    } else {
      this.refreshSelectionColors()
    }
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
    this.gapField = null
    this.layoutSection.teardown()
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
      if (section.hint) title.title = section.hint
      this.sectionsRoot.append(title)
      // Every body element belonging to this section (title + rowWrap + custom body +
      // expandWrap, whichever apply) collects here so refresh() can hide them all together —
      // see the sectionEls field comment (final review finding E2).
      const sectionBodyEls: HTMLElement[] = [title]

      if (section.custom === 'layout') {
        // Remove ('−') comes first in the title, then the padding '⋯' expand (added by the
        // generic expandRows block below) — button order in the title matches the M-B glyph-
        // strip test convention ('Layout−⋯').
        title.append(this.layoutSection.buildRemoveButton())

        // Unified UI3-style Layout body (spec M-C; reordered 2026-07-06 layout-polish spec):
        // W/H rows -> auto-layout cluster -> padding block -> align block, one fixed order,
        // flex or not (the ORDER is the contract — see panel.test.ts's composition test).
        const rowWrap = document.createElement('div')
        rowWrap.className = 'panel-rows layout-section'
        // Size block (2026-07-06 size-pair spec): a "Size" group label above ONE line holding
        // the W and H size-rows side by side — mirrors the padding block's structure below.
        const sizeBlock = document.createElement('div')
        sizeBlock.className = 'size-block'
        sizeBlock.setAttribute('data-size-block', '')
        const sizeLabel = document.createElement('span')
        sizeLabel.className = 'group-label'
        sizeLabel.textContent = 'Size'
        const sizeFields = document.createElement('div')
        sizeFields.className = 'size-fields'
        for (const row of SIZE_ROWS) sizeFields.append(this.buildRow(row))
        sizeBlock.append(sizeLabel, sizeFields)
        rowWrap.append(sizeBlock)
        // Min/max disclosure rows sit BELOW the pair (W's pair then H's) with axis-qualified
        // labels — they can no longer nest under their own axis row now that W|H share a line.
        // Hidden until LayoutSection.refresh discloses them (opened / drafted / non-default).
        for (const row of SIZE_ROWS) {
          for (const mm of minMaxRowsFor(row)) {
            const mmBound = this.buildField(mm)
            const mmRow = document.createElement('div')
            mmRow.className = 'panel-rows'
            mmRow.setAttribute('data-minmax-row', '')
            mmRow.setAttribute('data-props-row', mm.props.join(' '))
            mmRow.hidden = true
            mmRow.append(mmBound.field.root)
            rowWrap.append(mmRow)
            this.layoutSection.registerMinMaxRow({ rowEl: mmRow, spec: mm, field: mmBound.field })
          }
        }
        // buildBodyInto appends the add-button + controls wrap directly onto rowWrap, so the
        // section body stays a single flat .panel-rows (CSS contract) with no carrier to drain.
        this.layoutSection.buildBodyInto(rowWrap)

        // Padding block (2026-07-06 layout-polish spec): a "Padding" group label above ONE
        // line holding the H (left/right) and V (top/bottom) fields side by side — Margin's
        // H|V shorthand explained by its section title; padding's is explained here.
        const padBlock = document.createElement('div')
        padBlock.className = 'padding-block'
        padBlock.setAttribute('data-padding-row', '')
        const padLabel = document.createElement('span')
        padLabel.className = 'group-label'
        padLabel.textContent = 'Padding'
        const padFields = document.createElement('div')
        padFields.className = 'padding-fields'
        for (const row of PADDING_ROWS) padFields.append(this.buildRow(row))
        padBlock.append(padLabel, padFields)
        rowWrap.append(padBlock)

        // Align block LAST (2026-07-06 layout-polish spec): the per-child override is the
        // exception, not the default surface — designers think container-first (9-dot matrix
        // on the parent), so align-self sits at the bottom, behind Task 3's toggle.
        rowWrap.append(this.layoutSection.buildFlexChildControls())

        this.sectionsRoot.append(rowWrap)
        sectionBodyEls.push(rowWrap)
        this.appendExpandRows(section, title, sectionBodyEls)

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
      this.appendExpandRows(section, title, sectionBodyEls)

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

  /**
   * The `⋯`-expandable sub-rows shared by every section with `expandRows`/`expandKey`
   * (Layout's padding T/R/B/L, Stroke's border-width T/R/B/L, Appearance's radius corners) —
   * appends the toggle button to the section's title row and the collapsible row wrap right
   * after `rowWrap` in `sectionsRoot`, same shape regardless of which section owns it.
   */
  private appendExpandRows(section: SectionSpec, title: HTMLElement, sectionBodyEls: HTMLElement[]): void {
    if (!section.expandRows || !section.expandKey) return
    const expandKey = section.expandKey
    const expandWrap = document.createElement('div')
    expandWrap.className = 'panel-rows'
    expandWrap.hidden = !(this.expandState.get(expandKey) ?? false)
    const btn = createButton({ label: '⋯' })
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

  /**
   * The single field-birth site for the Gap NumberField — LayoutSection.buildBodyInto() calls
   * this via deps.buildGapField() rather than constructing a NumberField itself, so every
   * field in the panel (Gap included) is still born in exactly one place (buildField/this).
   * Shared absolute-commit path for gap — the field's own onInput AND the token picker's
   * apply route through it, so the two can't drift (PR #6 review: the picker's inlined
   * commit body was byte-equivalent to onInput).
   */
  private buildGapField(): NumberField {
    const commitGap = (n: number): void => {
      if (!this.el) return
      this.onBeforeEdit(this.el)
      this.drafts.apply(this.el, 'gap', px(n))
      this.refresh()
      this.onEdited()
    }

    const field = new NumberField({
      label: 'Gap',
      hint: cssHintFor(GAP_SPEC),
      min: 0,
      allowAuto: true,
      onInput: commitGap,
      onDetach: () => {
        // Mirrors buildField's onDetach — drop the bookkeeping so a later refresh() doesn't
        // try to re-bind a pill the user explicitly detached via Backspace.
        this.tokenUi.drop(GAP_SPEC)
      },
      onTokenOpen:
        !this.isMulti() && tokenEntriesFor(GAP_SPEC, readTheme(), readTokens()) !== null
          ? () => {
              this.tokenUi.openScalePicker(GAP_SPEC, field, commitGap)
            }
          : undefined,
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
    field.root.dataset.props = GAP_SPEC.props.join(' ')
    this.gapField = field
    return field
  }

  private buildTypographySection(multi = false): HTMLElement {
    const wrap = document.createElement('div')
    wrap.className = 'panel-rows'

    if (!multi) {
      // Row 1 — Family.
      const families = new Set<string>()
      if (this.el) {
        const current = firstFamily(getComputedStyle(this.el).getPropertyValue('font-family'))
        if (current) families.add(current)
      }
      for (const f of documentFontFamilies()) families.add(f)
      for (const f of ['system-ui', 'serif', 'monospace']) families.add(f)
      const familySelect = createSelect({
        className: 'type-family',
        options: [...families].map((f) => ({ value: f, label: f })),
        onChange: (value) => {
          if (!this.el) return
          this.onBeforeEdit(this.el)
          this.drafts.apply(this.el, 'font-family', cssFamilyValue(value))
          this.refresh()
          this.onEdited()
        },
      })
      familySelect.title = 'font-family'
      this.typeFamilySelect = familySelect
      wrap.append(familySelect)

      // Row 2 — Weight.
      const weightSelect = createSelect({
        className: 'type-weight',
        options: WEIGHTS.map(([value, label]) => ({ value, label })),
        onChange: (value) => {
          if (!this.el) return
          this.onBeforeEdit(this.el)
          this.drafts.apply(this.el, 'font-weight', value)
          this.refresh()
          this.onEdited()
        },
      })
      weightSelect.title = 'font-weight → font-*'
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

  /** Builds a `.color-row` — swatch button + value text — wired to open the shared ColorPicker. */
  private buildColorRow(opts: {
    label: string
    getCss: () => string
    getContrastAgainst: () => string | null
    onPick: (css: string) => void
  }): HTMLElement {
    const { row, swatch, swatchColor, valueEl } = createColorRow({ label: opts.label })

    // Icon only when the theme actually offers color tokens AND we're on a single selection —
    // mirrors the numeric fields' `onTokenOpen: !multi && ...` gate (controls.ts). Multi-select
    // section-hiding already keeps this row out of reach, but the gate should be a true local
    // invariant of the row itself, not something that only holds because a sibling hides it.
    if (!this.isMulti() && colorTokenEntries(readTokens()) !== null) {
      row.append(
        this.tokenUi.colorTokenButton(row, (css) => {
          if (!this.el) return
          this.onBeforeEdit(this.el)
          opts.onPick(css)
          this.refresh()
          this.onEdited()
        })
      )
    }

    swatch.addEventListener('click', () => {
      this.colorPicker.open({
        anchor: row,
        initial: opts.getCss(),
        contrastAgainst: opts.getContrastAgainst(),
        // `meta.token` (the exact token name, when the pick came from a palette swatch or
        // nearest-token hint) is intentionally unused: the value chip's token pill is DERIVED
        // from an exact-match check in colorDisplay() on every refresh, so a palette pick
        // needs no special-casing here — it lands on token-space and pills automatically.
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
      const display = colorDisplay(css)
      valueEl.textContent = display.text
      valueEl.classList.toggle('color-value-pill', display.token)
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

    const styleSelect = createSelect({
      className: 'stroke-style',
      options: STROKE_STYLES.map(([value, label]) => ({ value, label })),
      onChange: (value) => {
        if (!this.el) return
        this.onBeforeEdit(this.el)
        for (const prop of BORDER_STYLE_PROPS) this.drafts.apply(this.el, prop, value)
        this.refresh()
        this.onEdited()
      },
    })
    styleSelect.title = 'border-style → border-solid / border-dashed / border-dotted'
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
      const { row, swatch, swatchColor, valueEl } = createColorRow({ className: 'sc-row' })
      swatchColor.style.color = group.css
      valueEl.textContent = colorDisplay(group.css).text

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

  private buildRow(spec: RowSpec): HTMLElement {
    const bound = this.buildField(spec)
    if (!spec.sizeMode) return bound.field.root

    const row = document.createElement('div')
    row.className = 'size-row'
    row.append(bound.field.root)

    // Figma UI3 keeps min/max in the sizing dropdown — action items, not modes. SIZE_MODES
    // itself stays a pure mode table (stories import it as the canonical catalog). The
    // variable binding also lives here (2026-07-06 size-pair spec) — W/H render no { } button.
    const menu = createMenuButton({
      title: 'Sizing — Fixed: exact px · Hug: fit-content · Fill: stretch / flex-1 · min/max · variable',
      popoverHost: this.body,
      items: () => this.layoutSection.sizeMenuItems(spec, bound.field.canOpenToken()),
      onSelect: (value) => {
        if (value === 'add-min' || value === 'add-max') {
          this.layoutSection.openMinMax(spec, value === 'add-min' ? 'min' : 'max')
          return
        }
        if (value === 'variable') {
          bound.field.openToken()
          return
        }
        this.layoutSection.onSizeModeChange(spec, value)
      },
    })
    row.append(menu.button)

    this.layoutSection.registerSizeMode({ menuBtn: menu.button, spec, field: bound.field, mode: 'fixed' })
    return row
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
      hint: cssHintFor(spec),
      min: spec.min,
      max: spec.max,
      allowAuto: spec.sizeMode || spec.allowAuto,
      noTokenButton: !!spec.sizeMode,
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
        this.tokenUi.drop(spec)
      },
      onTokenOpen:
        !multi && tokenEntriesFor(spec, readTheme(), readTokens()) !== null
          ? () => this.tokenUi.openScalePicker(spec, field, commit)
          : undefined,
    })
    // Stable machine identity for tests/tooling — labels are designer-facing display text and
    // may collide across sections (Size H vs Padding H); props are the field's real identity.
    field.root.dataset.props = spec.props.join(' ')
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
