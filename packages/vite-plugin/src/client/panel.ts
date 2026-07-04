import type { TaggedElement } from './source'
import type { InspectorData } from './inspector'
import { DraftStore } from './drafts'
import { NumberField } from './controls'
import { SegmentField, AlignMatrix } from './layout-controls'

interface RowSpec {
  label: string
  props: string[]
  min?: number
  max?: number
  toCss?: (n: number) => string
  fromCss?: (css: string) => number
  /** When true (W/H rows), a sizing-mode <select> (Fixed/Hug/Fill) renders next to the field. */
  sizeMode?: boolean
}

interface SectionSpec {
  title: string
  rows: RowSpec[]
  expandKey?: string
  expandRows?: RowSpec[]
  /** Section renders always (stable DOM order) but is hidden via the `hidden` attribute when this returns false. */
  visible?: (el: TaggedElement) => boolean
  /** Custom section body — used by Layout, which isn't a plain row-field grid. */
  custom?: 'layout'
}

const px = (n: number): string => `${n}px`
const fromPx = (css: string): number => Math.round(Number.parseFloat(css) || 0)

const RADIUS = ['border-top-left-radius', 'border-top-right-radius', 'border-bottom-right-radius', 'border-bottom-left-radius']

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
function normalizeJustify(justify: string): string {
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
function normalizeAlign(align: string): string {
  if (align === 'normal' || align === 'start' || align === '') return 'flex-start'
  if (align === 'end') return 'flex-end'
  return align
}

// Section ORDER is fixed forever: Layout -> Size -> Padding -> Margin -> Appearance.
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
  }

  show(el: TaggedElement, data: InspectorData): void {
    this.el = el
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
      // it as the auto keyword rather than resolving it through fromCss.
      if (spec.sizeMode) {
        const draft = this.drafts.isComparing(el) ? null : this.drafts.current(el, spec.props[0])
        if (draft === 'auto') {
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

      const rowWrap = document.createElement('div')
      rowWrap.className = 'panel-rows'
      this.body.append(rowWrap)
      for (const row of section.rows) rowWrap.append(this.buildRow(row))

      if (section.title === 'Size') {
        rowWrap.append(this.buildFlexChildControls())
      }

      if (section.expandRows && section.expandKey) {
        const expandWrap = document.createElement('div')
        expandWrap.className = 'panel-rows'
        expandWrap.hidden = true
        const btn = document.createElement('button')
        btn.textContent = '⋯'
        btn.setAttribute('data-expand', section.expandKey)
        btn.addEventListener('click', () => {
          expandWrap.hidden = !expandWrap.hidden
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
    addBtn.textContent = 'Add auto layout'
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
      allowAuto: spec.sizeMode,
      onInput: (n) => {
        if (!this.el) return
        this.onBeforeEdit(this.el)
        const css = (spec.toCss ?? px)(n)
        for (const prop of spec.props) this.drafts.apply(this.el, prop, css)
        this.refresh()
        this.onEdited()
      },
    })
    const bound: BoundField = { field, spec }
    this.fields.push(bound)
    return bound
  }
}
