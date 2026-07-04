import type { TaggedElement } from './source'
import type { InspectorData } from './inspector'
import { DraftStore } from './drafts'
import { NumberField } from './controls'
import { SegmentField, AlignMatrix } from './layout-controls'
import { ColorPicker } from './colorpicker'
import { nearestColorToken, readTokens, parseColor as parseColorLocal } from './tokens'

interface RowSpec {
  label: string
  props: string[]
  min?: number
  max?: number
  toCss?: (n: number) => string
  fromCss?: (css: string) => number
  /** When true (W/H rows), a sizing-mode <select> (Fixed/Hug/Fill) renders next to the field. */
  sizeMode?: boolean
  /** When true (e.g. LH), the field accepts the literal keyword `auto` and displays it via setAuto(). */
  allowAuto?: boolean
  /** Draft value to apply when the user types the `auto` keyword (only meaningful with allowAuto). */
  autoCss?: string
  /**
   * Fired once per prop, immediately before that prop's value is drafted (after onBeforeEdit,
   * before drafts.apply). Used by Stroke's width fields: drafting a border-*-width while the
   * computed border-*-style is 'none' also drafts border-*-style: solid (one-time), so a
   * newly-drafted width is actually visible. Receives the live DraftStore so it can read/write
   * drafts itself (SECTIONS is a module-level const and can't close over a Panel instance).
   */
  onBeforeApply?: (el: TaggedElement, prop: string, drafts: DraftStore) => void
}

interface SectionSpec {
  title: string
  rows: RowSpec[]
  expandKey?: string
  expandRows?: RowSpec[]
  /** Section renders always (stable DOM order) but is hidden via the `hidden` attribute when this returns false. */
  visible?: (el: TaggedElement) => boolean
  /** Custom section body — used by Layout, which isn't a plain row-field grid. */
  custom?: 'layout' | 'typography' | 'fill' | 'stroke'
}

const px = (n: number): string => `${n}px`
const fromPx = (css: string): number => Math.round(Number.parseFloat(css) || 0)

const RADIUS = ['border-top-left-radius', 'border-top-right-radius', 'border-bottom-right-radius', 'border-bottom-left-radius']

const BORDER_WIDTH_PROPS = ['border-top-width', 'border-right-width', 'border-bottom-width', 'border-left-width']
const BORDER_STYLE_PROPS = ['border-top-style', 'border-right-style', 'border-bottom-style', 'border-left-style']
const BORDER_COLOR_PROPS = ['border-top-color', 'border-right-color', 'border-bottom-color', 'border-left-color']

/** border-top-width -> border-top-style (matches each width longhand to its side's style longhand). */
function styleForWidthProp(widthProp: string): string {
  return widthProp.replace('-width', '-style')
}

/**
 * Drafting a border width only becomes visible if the side actually has a style — a computed
 * `border-style: none` swallows any width. So the FIRST time a width is drafted while the
 * computed style for that side is 'none', also draft that side's style to 'solid' (one-time —
 * a later width edit while style is already something else must not stomp a user-chosen style).
 */
function draftSolidIfNone(el: TaggedElement, widthProp: string, drafts: DraftStore): void {
  const styleProp = styleForWidthProp(widthProp)
  const draftStyle = drafts.current(el, styleProp)
  // jsdom reports '' rather than the spec default 'none' for an unset border-style — treat
  // both as "no visible border yet" so the auto-solid behavior works in tests and browsers alike.
  const computedStyle = draftStyle ?? getComputedStyle(el).getPropertyValue(styleProp)
  if (computedStyle === 'none' || computedStyle === '') drafts.apply(el, styleProp, 'solid')
}

/**
 * Walks up from `el` (starting at el itself) for the first ancestor whose (draft-or-computed)
 * background-color has alpha > 0 — the color a Text/Stroke swatch would actually be seen
 * against. Falls back to white when no ancestor paints a background (the page's default canvas).
 */
function effectiveBackground(el: TaggedElement, drafts: DraftStore): string {
  let node: Element | null = el
  while (node) {
    const draft = drafts.isComparing(node as TaggedElement) ? null : drafts.current(node as TaggedElement, 'background-color')
    const css = draft ?? getComputedStyle(node).getPropertyValue('background-color')
    const parsed = parseColorLocal(css)
    if (parsed && parsed.a > 0) return css
    node = node.parentElement
  }
  return '#fff'
}

function isFlex(el: TaggedElement): boolean {
  const d = getComputedStyle(el).display
  return d === 'flex' || d === 'inline-flex'
}

/**
 * Normalizes a computed justify-content keyword to the matrix's flex-start|center|flex-end
 * vocabulary. Display-only: drafts still store whatever canonical keyword the user clicked.
 * An untouched flex container reports 'normal' (real browsers) or '' (jsdom) rather than
 * 'flex-start', so without this the matrix would show zero active dots by default.
 */
export function normalizeJustify(justify: string): string {
  if (justify === 'normal' || justify === 'start' || justify === 'left' || justify === '') return 'flex-start'
  if (justify === 'end' || justify === 'right') return 'flex-end'
  return justify
}

/**
 * Normalizes a computed align-items keyword the same way as normalizeJustify, except
 * 'stretch' is intentionally left as-is (not mapped to a matrix keyword) — stretch is
 * represented by the child's W/H size mode being Fill, not a matrix position, so it must
 * continue to produce no active dot.
 */
export function normalizeAlign(align: string): string {
  if (align === 'normal' || align === 'start' || align === '') return 'flex-start'
  if (align === 'end') return 'flex-end'
  return align
}

/** True when `el` has a direct child text node with non-whitespace content (element children don't count). */
export function hasDirectText(el: Element): boolean {
  return [...el.childNodes].some((n) => n.nodeType === 3 && (n.textContent ?? '').trim() !== '')
}

const WEIGHTS: Array<[value: string, label: string]> = [
  ['100', 'Thin'],
  ['200', 'Extra Light'],
  ['300', 'Light'],
  ['400', 'Regular'],
  ['500', 'Medium'],
  ['600', 'Semibold'],
  ['700', 'Bold'],
  ['800', 'Extra Bold'],
  ['900', 'Black'],
]

/** Snaps a computed font-weight keyword/number to one of the 9 named-weight values. */
function snapWeight(css: string): string {
  if (css === 'normal') return '400'
  if (css === 'bold') return '700'
  const n = Number.parseFloat(css)
  if (!Number.isFinite(n)) return '400'
  // Snap to the nearest named weight (100-900, step 100).
  return String(Math.min(900, Math.max(100, Math.round(n / 100) * 100)))
}

/** Unquotes a computed font-family's first entry for display (e.g. `"Georgia"` -> `Georgia`). */
function firstFamily(computedFontFamily: string): string {
  const first = computedFontFamily.split(',')[0]?.trim() ?? ''
  return first.replace(/^['"]|['"]$/g, '')
}

/** Quotes a family name for use in a font-family CSS value if it contains whitespace. */
function cssFamilyValue(name: string): string {
  return /\s/.test(name) ? `"${name}"` : name
}

/** Enumerates unique font families from document.fonts, feature-detecting its absence (jsdom). */
function documentFontFamilies(): string[] {
  const fonts: unknown = (document as unknown as { fonts?: Iterable<{ family: string; status?: string }> }).fonts
  if (!fonts || typeof (fonts as Iterable<unknown>)[Symbol.iterator] !== 'function') return []
  const seen = new Set<string>()
  for (const face of fonts as Iterable<{ family: string; status?: string }>) {
    if (face.status !== undefined && face.status !== 'loaded') continue
    seen.add(face.family.replace(/^['"]|['"]$/g, ''))
  }
  return [...seen]
}

// Section ORDER is fixed forever: Layout -> Size -> Padding -> Margin -> Typography -> Fill -> Stroke -> Appearance.
const SECTIONS: SectionSpec[] = [
  {
    title: 'Layout',
    rows: [],
    custom: 'layout',
    // The section TITLE is always visible (empty state = title + add-auto-layout button —
    // no floating headerless button). refreshLayoutSection toggles the add-button vs.
    // layout-controls visibility beneath it based on flex-ness.
  },
  {
    title: 'Size',
    rows: [
      { label: 'W', props: ['width'], min: 0, sizeMode: true },
      { label: 'H', props: ['height'], min: 0, sizeMode: true },
    ],
  },
  {
    title: 'Padding',
    expandKey: 'padding',
    rows: [
      { label: 'PX', props: ['padding-left', 'padding-right'], min: 0 },
      { label: 'PY', props: ['padding-top', 'padding-bottom'], min: 0 },
    ],
    expandRows: [
      { label: 'PT', props: ['padding-top'], min: 0 },
      { label: 'PR', props: ['padding-right'], min: 0 },
      { label: 'PB', props: ['padding-bottom'], min: 0 },
      { label: 'PL', props: ['padding-left'], min: 0 },
    ],
  },
  {
    title: 'Margin',
    expandKey: 'margin',
    rows: [
      { label: 'MX', props: ['margin-left', 'margin-right'] },
      { label: 'MY', props: ['margin-top', 'margin-bottom'] },
    ],
    expandRows: [
      { label: 'MT', props: ['margin-top'] },
      { label: 'MR', props: ['margin-right'] },
      { label: 'MB', props: ['margin-bottom'] },
      { label: 'ML', props: ['margin-left'] },
    ],
  },
  {
    title: 'Typography',
    rows: [],
    custom: 'typography',
    visible: hasDirectText,
  },
  {
    title: 'Fill',
    rows: [],
    custom: 'fill',
  },
  {
    title: 'Stroke',
    rows: [],
    custom: 'stroke',
    expandKey: 'stroke',
    expandRows: [
      { label: 'BT', props: ['border-top-width'], min: 0, onBeforeApply: draftSolidIfNone },
      { label: 'BR', props: ['border-right-width'], min: 0, onBeforeApply: draftSolidIfNone },
      { label: 'BB', props: ['border-bottom-width'], min: 0, onBeforeApply: draftSolidIfNone },
      { label: 'BL', props: ['border-left-width'], min: 0, onBeforeApply: draftSolidIfNone },
    ],
  },
  {
    title: 'Appearance',
    expandKey: 'radius',
    rows: [
      { label: 'R', props: RADIUS, min: 0 },
      {
        label: 'O',
        props: ['opacity'],
        min: 0,
        max: 100,
        toCss: (n) => String(n / 100),
        fromCss: (css) => {
          const n = Number.parseFloat(css)
          return Math.round((Number.isFinite(n) ? n : 1) * 100)
        },
      },
    ],
    expandRows: [
      { label: 'TL', props: ['border-top-left-radius'], min: 0 },
      { label: 'TR', props: ['border-top-right-radius'], min: 0 },
      { label: 'BR', props: ['border-bottom-right-radius'], min: 0 },
      { label: 'BL', props: ['border-bottom-left-radius'], min: 0 },
    ],
  },
]

interface BoundField {
  field: NumberField
  spec: RowSpec
}

interface BoundSizeMode {
  select: HTMLSelectElement
  spec: RowSpec
  field: NumberField
}

/** Direction the SIZE dimension corresponds to on the parent's flex axis. */
function mainAxisProp(direction: string): 'width' | 'height' {
  return direction === 'column' ? 'height' : 'width'
}

export class Panel {
  root = document.createElement('div')
  compareButton = document.createElement('button')
  resetButton = document.createElement('button')

  private head = document.createElement('div')
  private headTag = document.createElement('div')
  private headSrc = document.createElement('div')
  private actions = document.createElement('div')
  private body = document.createElement('div')
  private fields: BoundField[] = []
  private sectionEls: Array<{ spec: SectionSpec; el: HTMLElement }> = []
  private el: TaggedElement | null = null
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

  // Single Panel-level ColorPicker instance shared by Fill and Stroke — closed whenever the
  // selection changes (show()) so it never dangles pointing at a since-removed row.
  private colorPicker: ColorPicker

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
      this.drafts.compare(this.el, !this.drafts.isComparing(this.el))
      this.refresh()
    })
    this.resetButton.addEventListener('click', () => {
      if (!this.el) return
      this.onBeforeEdit(this.el)
      this.drafts.discard(this.el)
      this.refresh()
      this.onEdited()
    })
    this.actions.append(this.compareButton, this.resetButton)
    this.root.append(this.head, this.actions, this.body)
    this.colorPicker = new ColorPicker(this.root)
  }

  show(el: TaggedElement, data: InspectorData): void {
    this.el = el
    this.colorPicker.close()
    this.root.hidden = false
    this.headTag.textContent = data.tag
    if (data.source) {
      const srcText = `${data.source.file}:${data.source.line}:${data.source.col}`
      this.headSrc.textContent = srcText
      this.headSrc.title = srcText
      if (!this.headSrc.isConnected) this.head.append(this.headSrc)
    } else {
      this.headSrc.remove()
    }
    // rebuilds all fields per selection; expand state resets by design (revisit in M2b)
    this.buildBody()
    this.refresh()
  }

  hide(): void {
    this.el = null
    this.root.hidden = true
    this.colorPicker.close()
  }

  refresh(): void {
    if (!this.el) return
    const el = this.el
    const computed = getComputedStyle(el)

    for (const { spec, el: sectionEl } of this.sectionEls) {
      sectionEl.hidden = spec.visible ? !spec.visible(el) : false
    }

    for (const { field, spec } of this.fields) {
      // Size-mode (W/H) fields can hold the literal 'auto' draft (Hug mode) — show
      // it as the auto keyword rather than resolving it through fromCss. Draft check
      // stays first; when there's no draft (and we're not in comparing mode), an
      // author-authored inline `auto` (e.g. style="width: auto") shows the same way.
      if (spec.sizeMode) {
        const draft = this.drafts.isComparing(el) ? null : this.drafts.current(el, spec.props[0])
        if (draft === 'auto') {
          field.setAuto()
          continue
        }
        if (draft === null && !this.drafts.isComparing(el) && el.style.getPropertyValue(spec.props[0]) === 'auto') {
          field.setAuto()
          continue
        }
      }
      // allowAuto fields whose current CSS value (draft-or-computed) IS the auto keyword
      // (e.g. line-height: normal) display via setAuto() rather than resolving through fromCss.
      if (spec.allowAuto && !spec.sizeMode) {
        const css = this.currentValue(el, spec.props[0], computed)
        if (css === (spec.autoCss ?? 'normal')) {
          field.setAuto()
          continue
        }
      }
      const values = spec.props.map((p) => this.readValue(el, p, computed, spec))
      const mixed = values.some((v) => v !== values[0])
      if (mixed) field.setMixed()
      else field.set(values[0])
    }

    this.refreshLayoutSection(el, computed)
    this.refreshFlexChild(el, computed)
    this.refreshTypography(el, computed)
    this.refreshFillStroke(el, computed)
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
      if (spaceBetween) this.gapField.setAuto()
      else {
        const gapCss = this.drafts.isComparing(el) ? null : this.drafts.current(el, 'gap')
        const css = gapCss ?? computed.getPropertyValue('gap')
        this.gapField.set(fromPx(css))
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
    this.body.replaceChildren()
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
    this.sizeModes = []
    this.typeFamilySelect = null
    this.typeWeightSelect = null
    this.typeAlignField = null
    this.fillRow = null
    this.textRow = null
    this.strokeStyleSelect = null
    this.strokeColorRow = null

    for (const section of SECTIONS) {
      const title = document.createElement('div')
      title.className = 'panel-section'
      title.textContent = section.title
      this.body.append(title)
      this.sectionEls.push({ spec: section, el: title })

      if (section.custom === 'layout') {
        this.body.append(this.buildLayoutSection())
        continue
      }

      if (section.custom === 'typography') {
        this.body.append(this.buildTypographySection())
        continue
      }

      if (section.custom === 'fill') {
        this.body.append(this.buildFillSection())
        continue
      }

      let rowWrap: HTMLElement
      if (section.custom === 'stroke') {
        // Stroke's body (W+style row, then Color row) is custom, but still a single
        // .panel-rows sibling — the expand-button logic below appends its own expandWrap
        // (BT/BR/BB/BL) as the next body child after it, same shape as every other
        // expandable section.
        rowWrap = this.buildStrokeSection()
        this.body.append(rowWrap)
      } else {
        rowWrap = document.createElement('div')
        rowWrap.className = 'panel-rows'
        this.body.append(rowWrap)
        for (const row of section.rows) rowWrap.append(this.buildRow(row))
      }

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
        this.body.append(expandWrap)
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

  private buildTypographySection(): HTMLElement {
    const wrap = document.createElement('div')
    wrap.className = 'panel-rows'

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
    wrap.append(lsRow)

    return wrap
  }

  /** Renders a token name (exact nearestColorToken match) or a short hex fallback for display. */
  private colorLabel(css: string): string {
    const parsed = parseColorLocal(css)
    if (!parsed) return css
    const nearest = nearestColorToken(parsed, readTokens().colors)
    if (nearest && nearest.distance === 0) return nearest.token.name
    const toHex = (n: number) => Math.max(0, Math.min(255, Math.round(n))).toString(16).padStart(2, '0')
    return `#${toHex(parsed.r)}${toHex(parsed.g)}${toHex(parsed.b)}`
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
    swatch.className = 'swatch swatch-fill'
    row.append(swatch)

    const valueEl = document.createElement('span')
    valueEl.className = 'color-value'
    row.append(valueEl)

    swatch.addEventListener('click', () => {
      this.colorPicker.open({
        anchor: row,
        initial: opts.getCss(),
        contrastAgainst: opts.getContrastAgainst(),
        onPick: (css) => {
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
      swatch.style.color = css
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

  private buildFlexChildControls(): HTMLElement {
    const wrap = document.createElement('div')
    wrap.className = 'flex-child-controls'
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

  private buildField(spec: RowSpec): BoundField {
    const field = new NumberField({
      label: spec.label,
      min: spec.min,
      max: spec.max,
      allowAuto: spec.sizeMode || spec.allowAuto,
      onInput: (n) => {
        if (!this.el) return
        this.onBeforeEdit(this.el)
        const css = (spec.toCss ?? px)(n)
        for (const prop of spec.props) {
          spec.onBeforeApply?.(this.el, prop, this.drafts)
          this.drafts.apply(this.el, prop, css)
        }
        this.refresh()
        this.onEdited()
      },
      onKeyword: spec.allowAuto
        ? (kw) => {
            if (!this.el || kw !== 'auto') return
            this.onBeforeEdit(this.el)
            for (const prop of spec.props) this.drafts.apply(this.el, prop, spec.autoCss ?? 'normal')
            this.refresh()
            this.onEdited()
          }
        : undefined,
    })
    const bound: BoundField = { field, spec }
    this.fields.push(bound)
    return bound
  }
}
