import type { TaggedElement } from './source'
import type { InspectorData } from './inspector'
import { DraftStore } from './drafts'
import { NumberField } from './controls'

interface RowSpec {
  label: string
  props: string[]
  min?: number
  max?: number
  toCss?: (n: number) => string
  fromCss?: (css: string) => number
}

interface SectionSpec {
  title: string
  rows: RowSpec[]
  expandKey?: string
  expandRows?: RowSpec[]
}

const px = (n: number): string => `${n}px`
const fromPx = (css: string): number => Math.round(Number.parseFloat(css) || 0)

const RADIUS = ['border-top-left-radius', 'border-top-right-radius', 'border-bottom-right-radius', 'border-bottom-left-radius']

const SECTIONS: SectionSpec[] = [
  {
    title: 'Size',
    rows: [
      { label: 'W', props: ['width'], min: 0 },
      { label: 'H', props: ['height'], min: 0 },
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

export class Panel {
  root = document.createElement('div')
  compareButton = document.createElement('button')
  resetButton = document.createElement('button')

  private head = document.createElement('div')
  private body = document.createElement('div')
  private fields: BoundField[] = []
  private el: TaggedElement | null = null

  constructor(
    private drafts: DraftStore,
    private onEdited: () => void
  ) {
    this.root.id = 'panel'
    this.root.hidden = true
    this.head.className = 'panel-head'
    this.compareButton.textContent = 'Compare'
    this.resetButton.textContent = 'Reset'
    this.compareButton.addEventListener('click', () => {
      if (!this.el) return
      this.drafts.compare(this.el, !this.drafts.isComparing(this.el))
      this.refresh()
    })
    this.resetButton.addEventListener('click', () => {
      if (!this.el) return
      this.drafts.discard(this.el)
      this.refresh()
      this.onEdited()
    })
    this.root.append(this.head, this.compareButton, this.resetButton, this.body)
  }

  show(el: TaggedElement, data: InspectorData): void {
    this.el = el
    this.root.hidden = false
    this.head.textContent = data.source
      ? `<${data.tag}> — ${data.source.file}:${data.source.line}:${data.source.col}`
      : `<${data.tag}>`
    this.buildBody()
    this.refresh()
  }

  hide(): void {
    this.el = null
    this.root.hidden = true
  }

  refresh(): void {
    if (!this.el) return
    const computed = getComputedStyle(this.el)
    for (const { field, spec } of this.fields) {
      const values = spec.props.map((p) => this.readValue(this.el!, p, computed, spec))
      const mixed = values.some((v) => v !== values[0])
      field.set(mixed ? null : values[0])
    }
  }

  private readValue(el: TaggedElement, prop: string, computed: CSSStyleDeclaration, spec: RowSpec): number {
    const draft = this.drafts.isComparing(el) ? null : this.drafts.current(el, prop)
    const css = draft ?? computed.getPropertyValue(prop)
    return (spec.fromCss ?? fromPx)(css)
  }

  private buildBody(): void {
    this.body.replaceChildren()
    this.fields = []
    for (const section of SECTIONS) {
      const title = document.createElement('div')
      title.className = 'panel-section'
      title.textContent = section.title
      this.body.append(title)
      const rowWrap = document.createElement('div')
      rowWrap.className = 'panel-rows'
      this.body.append(rowWrap)
      for (const row of section.rows) rowWrap.append(this.buildField(row))

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
        rowWrap.append(btn)
        for (const row of section.expandRows) expandWrap.append(this.buildField(row))
        this.body.append(expandWrap)
      }
    }
  }

  private buildField(spec: RowSpec): HTMLElement {
    const field = new NumberField({
      label: spec.label,
      min: spec.min,
      max: spec.max,
      onInput: (n) => {
        if (!this.el) return
        const css = (spec.toCss ?? px)(n)
        for (const prop of spec.props) this.drafts.apply(this.el, prop, css)
        this.refresh()
        this.onEdited()
      },
    })
    this.fields.push({ field, spec })
    return field.root
  }
}
