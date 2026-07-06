// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { Panel, normalizeJustify, normalizeAlign, hasDirectText, tokenEntriesFor, colorTokenEntries } from '../../src/client/panel'
import { DraftStore } from '../../src/client/drafts'
import { buildInspectorData } from '../../src/client/inspector'
import { resetTokensCache, type Theme, type Tokens } from '../../src/client/tokens'
import { buildChangeRequest } from '../../src/client/request'

function setup(html = `<div data-dc-source="src/Card.tsx:4:7" id="t" style="padding: 8px; width: 200px;"></div>`) {
  document.body.innerHTML = html
  const el = document.getElementById('t')! as HTMLElement
  const drafts = new DraftStore()
  const onEdited = vi.fn()
  const panel = new Panel(drafts, onEdited)
  document.body.appendChild(panel.root)
  panel.show(el, buildInspectorData(el))
  return { el, drafts, panel, onEdited }
}

// Field identities (data-props) — labels are display text and are free to change.
const P = {
  W: 'width',
  H: 'height',
  MIN_W: 'min-width',
  MAX_W: 'max-width',
  MIN_H: 'min-height',
  MAX_H: 'max-height',
  PX: 'padding-left padding-right',
  PY: 'padding-top padding-bottom',
  PT: 'padding-top',
  PR: 'padding-right',
  PB: 'padding-bottom',
  PL: 'padding-left',
  MX: 'margin-left margin-right',
  MY: 'margin-top margin-bottom',
  GAP: 'gap',
  R: 'border-top-left-radius border-top-right-radius border-bottom-right-radius border-bottom-left-radius',
  O: 'opacity',
  S: 'font-size',
  LH: 'line-height',
  LS: 'letter-spacing',
  TL: 'border-top-left-radius',
  STROKE_W: 'border-top-width border-right-width border-bottom-width border-left-width',
} as const

function fieldInput(panel: Panel, props: string): HTMLInputElement {
  const nf = [...panel.root.querySelectorAll('.nf')].find((n) => (n as HTMLElement).dataset.props === props)
  if (!nf) throw new Error(`no field with data-props ${props}`)
  return nf.querySelector('input')!
}

// Test-only access to the Panel's private tokenUi.picker (the token-picker/pill cluster now
// lives in panel-token-ui.ts — see panel.ts's `private tokenUi: PanelTokenUi`).
function pickerOf(panel: Panel): { root: HTMLElement; open: (opts: unknown) => void } {
  return (panel as unknown as { tokenUi: { picker: { root: HTMLElement; open: (opts: unknown) => void } } }).tokenUi
    .picker
}

function commit(input: HTMLInputElement, value: string): void {
  input.value = value
  input.dispatchEvent(new Event('change', { bubbles: true }))
}

beforeEach(() => {
  document.body.innerHTML = ''
})

// A couple of tests stub getComputedStyle to simulate flex-layout measurements jsdom can't
// produce itself; unstub unconditionally here so a failed assertion mid-test can't leak the
// stub into later tests.
afterEach(() => {
  vi.unstubAllGlobals()
})

describe('Panel', () => {
  it('shows header with source location and populates fields from computed styles', () => {
    const { panel } = setup()
    expect(panel.root.textContent).toContain('src/Card.tsx:4:7')
    expect(fieldInput(panel, P.W).value).toBe('200')
    expect(fieldInput(panel, P.PX).value).toBe('8')
    expect(fieldInput(panel, P.PY).value).toBe('8')
  })

  it('numeric fields carry data-props identity', () => {
    const { panel } = setup()
    const roots = [...panel.root.querySelectorAll('.nf')] as HTMLElement[]
    expect(roots.find((n) => n.dataset.props === 'padding-left padding-right')).toBeDefined()
    expect(roots.find((n) => n.dataset.props === 'width')).toBeDefined()
    expect(roots.find((n) => n.dataset.props === 'gap')).toBeDefined()
  })

  it('field labels carry CSS/Tailwind hint tooltips', () => {
    const { panel } = setup()
    const nf = [...panel.root.querySelectorAll('.nf')].find(
      (n) => (n as HTMLElement).dataset.props === P.PX
    ) as HTMLElement
    expect((nf.querySelector('.nf-label') as HTMLElement).title).toBe('padding-left, padding-right → px-*')
  })

  it('padding and margin speak designer labels (H/V + T/R/B/L)', () => {
    const { panel } = setup()
    const labelFor = (props: string): string => {
      const nf = [...panel.root.querySelectorAll('.nf')].find(
        (n) => (n as HTMLElement).dataset.props === props
      ) as HTMLElement
      return (nf.querySelector('.nf-label') as HTMLElement).textContent ?? ''
    }
    expect(labelFor(P.PX)).toBe('H')
    expect(labelFor(P.PY)).toBe('V')
    expect(labelFor(P.PT)).toBe('T')
    expect(labelFor(P.MX)).toBe('H')
    expect(labelFor(P.MY)).toBe('V')
  })

  it('renders the header as two separate nodes: tag and source', () => {
    const { panel } = setup()
    const tagEl = panel.root.querySelector('.panel-head-tag') as HTMLElement
    const srcEl = panel.root.querySelector('.panel-head-src') as HTMLElement
    expect(tagEl).toBeTruthy()
    expect(srcEl).toBeTruthy()
    expect(tagEl.textContent).toBe('div')
    expect(srcEl.textContent).toBe('src/Card.tsx:4:7')
    expect(srcEl.getAttribute('title')).toBe('src/Card.tsx:4:7')
  })

  it('header shows only the tag node when there is no source', () => {
    document.body.innerHTML = `<div id="t" style="padding: 8px; width: 200px;"></div>`
    const el = document.getElementById('t')! as HTMLElement
    const drafts = new DraftStore()
    const panel = new Panel(drafts, vi.fn())
    document.body.appendChild(panel.root)
    panel.show(el, buildInspectorData(el))
    const tagEl = panel.root.querySelector('.panel-head-tag') as HTMLElement
    const srcEl = panel.root.querySelector('.panel-head-src') as HTMLElement
    expect(tagEl.textContent).toBe('div')
    expect(srcEl).toBeFalsy()
  })

  it('source path renders as dir + tail spans so the filename:line never gets cut', () => {
    const { panel } = setup()
    const src = panel.root.querySelector('.panel-head-src') as HTMLElement
    const dir = src.querySelector('.src-dir') as HTMLElement
    const tail = src.querySelector('.src-tail') as HTMLElement
    expect(dir.textContent).toBe('src/')
    expect(tail.textContent).toBe('Card.tsx:4:7')
    expect(src.textContent).toBe('src/Card.tsx:4:7') // concatenation unchanged
    expect(src.title).toBe('src/Card.tsx:4:7')
  })

  it('wraps Compare/Reset buttons in a .panel-actions container', () => {
    const { panel } = setup()
    const actions = panel.root.querySelector('.panel-actions') as HTMLElement
    expect(actions).toBeTruthy()
    expect(actions.contains(panel.compareButton)).toBe(true)
    expect(actions.contains(panel.resetButton)).toBe(true)
  })

  it('editing a linked padding field writes both longhands as drafts', () => {
    const { el, panel, drafts, onEdited } = setup()
    commit(fieldInput(panel, P.PX), '16')
    expect(drafts.current(el, 'padding-left')).toBe('16px')
    expect(drafts.current(el, 'padding-right')).toBe('16px')
    expect(el.style.getPropertyValue('padding-left')).toBe('16px')
    expect(onEdited).toHaveBeenCalled()
  })

  it('shows mixed linked values via setMixed', () => {
    const { panel } = setup(
      `<div data-dc-source="src/a.tsx:1:1" id="t" style="padding-left: 4px; padding-right: 12px;"></div>`
    )
    expect(fieldInput(panel, P.PX).value).toBe('Mixed')
  })

  it('expanding padding reveals per-side fields that edit one longhand', () => {
    const { el, panel, drafts } = setup()
    ;(panel.root.querySelector('[data-expand="padding"]') as HTMLElement).click()
    commit(fieldInput(panel, P.PT), '20')
    expect(drafts.current(el, 'padding-top')).toBe('20px')
    expect(drafts.current(el, 'padding-bottom')).toBeNull()
  })

  it('radius linked field writes all four corner longhands', () => {
    const { el, panel, drafts } = setup()
    commit(fieldInput(panel, P.R), '10')
    for (const c of ['top-left', 'top-right', 'bottom-right', 'bottom-left']) {
      expect(drafts.current(el, `border-${c}-radius`)).toBe('10px')
    }
  })

  it('opacity field maps percent to 0-1 css', () => {
    const { el, panel, drafts } = setup()
    commit(fieldInput(panel, P.O), '60')
    expect(drafts.current(el, 'opacity')).toBe('0.6')
  })

  it('per-element compare and reset buttons drive the store', () => {
    const { el, panel, drafts } = setup()
    commit(fieldInput(panel, P.W), '300')
    panel.compareButton.click()
    expect(drafts.isComparing(el)).toBe(true)
    panel.compareButton.click()
    expect(drafts.isComparing(el)).toBe(false)
    panel.resetButton.click()
    expect(drafts.hasDrafts(el)).toBe(false)
    expect(fieldInput(panel, P.W).value).toBe('200') // refreshed back to computed
  })

  it('hide clears the panel', () => {
    const { panel } = setup()
    panel.hide()
    expect(panel.root.hidden).toBe(true)
  })

  it('fields show on-screen (original) values while comparing', () => {
    const { el, panel } = setup()
    commit(fieldInput(panel, P.W), '300')
    panel.compareButton.click()
    expect(fieldInput(panel, P.W).value).toBe('200')
    panel.compareButton.click()
    expect(fieldInput(panel, P.W).value).toBe('300')
  })

  it('opacity 0 round-trips as 0, not 100', () => {
    const { panel } = setup()
    commit(fieldInput(panel, P.O), '0')
    panel.refresh()
    expect(fieldInput(panel, P.O).value).toBe('0')
  })

  it('mixed detection still works while comparing', () => {
    const { panel, drafts, el } = setup(
      `<div data-dc-source="src/a.tsx:1:1" id="t" style="padding-left: 4px; padding-right: 12px;"></div>`
    )
    commit(fieldInput(panel, P.PX), '16')
    drafts.compare(el, true)
    panel.refresh()
    expect(fieldInput(panel, P.PX).value).toBe('Mixed') // originals differ → mixed again
  })

  it('section order is Layout, Margin, Typography, Fill, Stroke, Appearance regardless of visibility', () => {
    const { panel } = setup()
    // Sections with an expand button now parent it inside the title row, so title row
    // textContent includes the '⋯' glyph for expandable sections (and Layout's title row
    // also carries the '−' remove-auto-layout button) — compare the leading label text
    // only (title row's first text-bearing segment) rather than exact equality.
    const titles = [...panel.root.querySelectorAll('.panel-section')].map(
      (n) => n.textContent?.replace('⋯', '').replace('−', '').trim()
    )
    expect(titles).toEqual(['Layout', 'Margin', 'Typography', 'Fill', 'Stroke', 'Appearance'])
  })

  it('expand button is parented inside the section title row, not the rows wrap', () => {
    const { panel } = setup()
    const sections = [...panel.root.querySelectorAll('.panel-section')]
    // Padding no longer has its own section (M-C unified Layout) — its `⋯` expand button
    // now lives on the Layout title, alongside the '−' remove-auto-layout button.
    const layoutTitle = sections.find((s) => s.textContent?.includes('Layout'))!
    const btn = layoutTitle.querySelector('[data-expand="padding"]')
    expect(btn).toBeTruthy()
    // must NOT be inside a .panel-rows wrap
    expect(layoutTitle.querySelector('.panel-rows [data-expand="padding"]')).toBeFalsy()
  })

  it('Layout section TITLE stays visible (but still first) for a non-flex element — empty state is title + add-auto-layout button, no floating headerless button', () => {
    const { panel } = setup()
    const sections = [...panel.root.querySelectorAll('.panel-section')]
    // Title row textContent also carries the '−' remove-auto-layout button and (since M-C)
    // the '⋯' padding-expand button — strip both glyphs before comparing the label.
    expect(sections[0].textContent?.replace('−', '').replace('⋯', '')).toBe('Layout')
    expect((sections[0] as HTMLElement).hidden).toBe(false)
    // the layout CONTROLS (direction/gap/align/wrap) are hidden — only the
    // add-auto-layout button is shown alongside the always-visible title
    const btn = panel.root.querySelector('[data-add-layout]') as HTMLElement
    expect(btn.hidden).toBe(false)
    const controlsWrap = panel.root.querySelector('.layout-controls') as HTMLElement
    expect(controlsWrap.hidden).toBe(true)
  })

  function flexSetup(styleExtra = '') {
    return setup(
      `<div data-dc-source="src/Card.tsx:4:7" id="t" style="display: flex; width: 200px; height: 100px; ${styleExtra}"></div>`
    )
  }

  it('Layout section is visible for a flex element', () => {
    const { panel } = flexSetup()
    const sections = [...panel.root.querySelectorAll('.panel-section')]
    // Title row textContent also carries the '−' remove-auto-layout button and '⋯' padding-expand.
    expect(sections[0].textContent?.replace('−', '').replace('⋯', '')).toBe('Layout')
    expect((sections[0] as HTMLElement).hidden).toBe(false)
  })

  it('unified Layout body composes W/H, cluster, padding, align in order (2026-07-06 layout-polish spec)', () => {
    const { panel } = flexSetup()
    const body = panel.root.querySelector('.layout-section') as HTMLElement
    const kinds = [...body.children].map((c) =>
      c.classList.contains('size-row')
        ? 'size'
        : c.hasAttribute('data-minmax-row')
          ? (c as HTMLElement).dataset.propsRow?.startsWith('min')
            ? 'minmax-min'
            : 'minmax-max'
          : c.classList.contains('flex-child-controls')
            ? 'align'
            : c.classList.contains('layout-controls') || c.hasAttribute('data-add-layout')
              ? 'cluster'
              : c.hasAttribute('data-padding-row')
                ? 'padding'
                : c.className
    )
    expect(kinds).toEqual([
      'size',
      'minmax-min',
      'minmax-max',
      'size',
      'minmax-min',
      'minmax-max',
      'cluster',
      'cluster',
      'padding',
      'align',
    ])
  })

  it('padding block carries a group label and one line with both H/V fields', () => {
    const { panel } = setup()
    const block = panel.root.querySelector('[data-padding-row]') as HTMLElement
    expect(block).toBeTruthy()
    expect((block.querySelector('.group-label') as HTMLElement).textContent).toBe('Padding')
    const fields = [...block.querySelectorAll('.padding-fields .nf')] as HTMLElement[]
    expect(fields.map((f) => f.dataset.props)).toEqual([
      'padding-left padding-right',
      'padding-top padding-bottom',
    ])
  })

  it('align block carries a group label and the toggle button', () => {
    const { panel } = setup()
    const wrap = panel.root.querySelector('.flex-child-controls') as HTMLElement
    expect((wrap.querySelector('.group-label') as HTMLElement).textContent).toBe('Align')
    expect(wrap.querySelector('[data-align-toggle]')).toBeTruthy()
  })

  it('layout controls compose a layout-grid with a matrix-tile and a layout-side column', () => {
    const { panel } = flexSetup()
    const controlsWrap = panel.root.querySelector('.layout-controls') as HTMLElement
    const grid = controlsWrap.querySelector('.layout-grid') as HTMLElement
    expect(grid).toBeTruthy()
    const tile = grid.querySelector('.matrix-tile') as HTMLElement
    const side = grid.querySelector('.layout-side') as HTMLElement
    expect(tile).toBeTruthy()
    expect(side).toBeTruthy()
    // matrix-tile wraps the align-matrix
    expect(tile.querySelector('.align-matrix')).toBeTruthy()
    // layout-side contains only Gap (a .nf) — Wrap moved to the Direction row (Task 2)
    const gapField = side.querySelector('.nf')
    expect(gapField).toBeTruthy()
    // Direction segment field renders as a full row OUTSIDE the grid (before it)
    const directionField = [...controlsWrap.querySelectorAll('.seg-field')].find(
      (n) => n.querySelector('.seg-field-label')?.textContent === 'Direction'
    )!
    expect(grid.contains(directionField)).toBe(false)
  })

  it('direction row is icon pair + wrap toggle; layout-side holds only Gap', () => {
    const { panel } = flexSetup()
    const dirField = [...panel.root.querySelectorAll('.seg-field')].find(
      (n) => n.querySelector('.seg-field-label')?.textContent === 'Direction'
    ) as HTMLElement
    const segs = [...dirField.querySelectorAll('.seg-track .seg')] as HTMLElement[]
    expect(segs.map((b) => b.textContent)).toEqual(['→', '↓'])
    expect(segs.map((b) => b.getAttribute('aria-label'))).toEqual(['Horizontal', 'Vertical'])
    const wrapBtn = dirField.querySelector('[data-wrap-toggle]') as HTMLElement
    expect(wrapBtn).toBeTruthy()
    expect(wrapBtn.getAttribute('aria-label')).toBe('Wrap')
    const side = panel.root.querySelector('.layout-side') as HTMLElement
    expect(side.querySelector('.seg-field')).toBeNull() // old Wrap segment gone
    expect(side.querySelector('.nf')).toBeTruthy() // Gap stays
  })

  it('direction row nests track + wrap toggle in a .seg-cluster (label stays outside)', () => {
    const { panel } = flexSetup()
    const dirField = [...panel.root.querySelectorAll('.seg-field')].find(
      (n) => n.querySelector('.seg-field-label')?.textContent === 'Direction'
    ) as HTMLElement
    const cluster = dirField.querySelector('.seg-cluster') as HTMLElement
    expect(cluster).toBeTruthy()
    expect(cluster.querySelector('.seg-track')).toBeTruthy()
    expect(cluster.querySelector('[data-wrap-toggle]')).toBeTruthy()
    expect(cluster.querySelector('.seg-field-label')).toBeNull()
  })

  it('wrap toggle drafts flex-wrap and reflects state', () => {
    const { el, panel } = flexSetup()
    const wrapBtn = panel.root.querySelector('[data-wrap-toggle]') as HTMLButtonElement
    wrapBtn.click()
    expect(el.style.getPropertyValue('flex-wrap')).toBe('wrap')
    expect(wrapBtn.classList.contains('seg-active')).toBe(true)
    expect(wrapBtn.getAttribute('aria-pressed')).toBe('true')
    wrapBtn.click()
    expect(el.style.getPropertyValue('flex-wrap')).toBe('nowrap')
    expect(wrapBtn.classList.contains('seg-active')).toBe(false)
  })

  it('non-flex element shows only the add-auto-layout button in Layout section', () => {
    const { el, panel, drafts } = setup()
    const btn = panel.root.querySelector('[data-add-layout]') as HTMLElement
    expect(btn).toBeTruthy()
    btn.click()
    expect(drafts.current(el, 'display')).toBe('flex')
  })

  it('add-auto-layout button label is prefixed with "+ " per the empty-state plan', () => {
    const { panel } = setup()
    const btn = panel.root.querySelector('[data-add-layout]') as HTMLElement
    expect(btn.textContent).toBe('+ Add auto layout')
  })

  it('add-auto-layout reveals layout controls after refresh', () => {
    const { panel } = setup()
    ;(panel.root.querySelector('[data-add-layout]') as HTMLElement).click()
    const sections = [...panel.root.querySelectorAll('.panel-section')]
    expect((sections[0] as HTMLElement).hidden).toBe(false)
    expect((panel.root.querySelector('[data-add-layout]') as HTMLElement).hidden).toBe(true)
  })

  it('direction segment field drafts flex-direction', () => {
    const { el, panel, drafts } = flexSetup()
    const seg = [...panel.root.querySelectorAll('.seg-field')].find(
      (n) => n.querySelector('.seg-field-label')?.textContent === 'Direction'
    )!
    const buttons = [...seg.querySelectorAll('.seg')] as HTMLElement[]
    const column = buttons.find((b) => b.getAttribute('aria-label') === 'Vertical')!
    column.click()
    expect(drafts.current(el, 'flex-direction')).toBe('column')
  })

  it('direction field carries [data-flex-direction] so the stacked-label CSS applies (280px clipping audit)', () => {
    const { panel } = flexSetup()
    const seg = panel.root.querySelector('[data-flex-direction]')!
    expect(seg).toBeTruthy()
    expect(seg.querySelector('.seg-field-label')?.textContent).toBe('Direction')
  })

  it('gap field drafts gap:Npx on a number', () => {
    const { el, panel, drafts } = flexSetup()
    commit(fieldInput(panel, P.GAP), '24')
    expect(drafts.current(el, 'gap')).toBe('24px')
  })

  it('gap field typed "auto" drafts justify-content:space-between and clears gap draft', () => {
    const { el, panel, drafts } = flexSetup()
    commit(fieldInput(panel, P.GAP), '24')
    expect(drafts.current(el, 'gap')).toBe('24px')
    commit(fieldInput(panel, P.GAP), 'auto')
    expect(drafts.current(el, 'justify-content')).toBe('space-between')
    expect(drafts.current(el, 'gap')).toBeNull()
  })

  it('gap field displays auto when computed justify-content is space-between', () => {
    const { panel } = flexSetup('justify-content: space-between;')
    expect(fieldInput(panel, P.GAP).value).toBe('auto')
  })

  it('gap auto restores a pre-existing inline gap instead of destroying it', () => {
    const { el, panel, drafts } = flexSetup('gap: 16px;')
    commit(fieldInput(panel, P.GAP), '24')
    expect(drafts.current(el, 'gap')).toBe('24px')
    commit(fieldInput(panel, P.GAP), 'auto')
    expect(drafts.current(el, 'justify-content')).toBe('space-between')
    expect(drafts.current(el, 'gap')).toBeNull()
    expect(el.style.getPropertyValue('gap')).toBe('16px')
  })

  it('default flex container (computed justify/align normal or empty) shows an active dot at flex-start/flex-start', () => {
    // flexSetup() sets only `display: flex` — no justify-content/align-items authored.
    // jsdom's getComputedStyle reports '' for these (real browsers report 'normal'); both
    // must normalize to flex-start so the matrix isn't stuck with zero active dots.
    const { panel } = flexSetup()
    const active = panel.root.querySelector('.am-dot.am-active') as HTMLElement
    expect(active).toBeTruthy()
    expect(active.dataset.j).toBe('flex-start')
    expect(active.dataset.a).toBe('flex-start')
  })

  it('space-between with no explicit align-items shows active dot in 3-dot space-between mode with flex-start align', () => {
    const { panel } = flexSetup('justify-content: space-between;')
    const dots = [...panel.root.querySelectorAll('.am-dot')] as HTMLElement[]
    expect(dots).toHaveLength(3)
    const active = panel.root.querySelector('.am-dot.am-active') as HTMLElement
    expect(active).toBeTruthy()
    expect(active.dataset.a).toBe('flex-start')
  })

  it('explicit align-items: stretch shows no active dot (stretch is represented via Fill, not a matrix position)', () => {
    const { panel } = flexSetup('align-items: stretch;')
    const active = panel.root.querySelector('.am-dot.am-active')
    expect(active).toBeNull()
  })

  it('align matrix click drafts justify-content and align-items', () => {
    const { el, panel, drafts } = flexSetup()
    const dot = panel.root.querySelector('.am-dot') as HTMLElement
    dot.click()
    expect(drafts.current(el, 'justify-content')).not.toBeNull()
    expect(drafts.current(el, 'align-items')).not.toBeNull()
  })

  it('align matrix re-maps when direction changes', () => {
    const { panel, el, drafts } = flexSetup()
    // click flex-end/flex-start dot in row mode
    const dot = [...panel.root.querySelectorAll('.am-dot')].find(
      (d) => (d as HTMLElement).dataset.j === 'flex-end' && (d as HTMLElement).dataset.a === 'flex-start'
    ) as HTMLElement
    dot.click()
    expect(drafts.current(el, 'justify-content')).toBe('flex-end')
    expect(drafts.current(el, 'align-items')).toBe('flex-start')

    const seg = [...panel.root.querySelectorAll('.seg-field')].find(
      (n) => n.querySelector('.seg-field-label')?.textContent === 'Direction'
    )!
    const columnBtn = [...seg.querySelectorAll('.seg')].find(
      (b) => b.getAttribute('aria-label') === 'Vertical'
    ) as HTMLElement
    columnBtn.click()
    // after direction change, the matrix should have re-rendered with column mapping;
    // the physical dot that emitted (flex-end, flex-start) in row mode now emits
    // the transposed pair in column mode.
    const dotAfter = [...panel.root.querySelectorAll('.am-dot')].find(
      (d) => (d as HTMLElement).dataset.j === 'flex-start' && (d as HTMLElement).dataset.a === 'flex-end'
    ) as HTMLElement
    expect(dotAfter).toBeTruthy()
  })

  describe('baseline alignment', () => {
    it('toggle drafts align-items baseline and carries active state; matrix has no active dot', () => {
      const { el, panel } = flexSetup()
      const btn = panel.root.querySelector('[data-align-baseline]') as HTMLButtonElement
      btn.click()
      expect(el.style.getPropertyValue('align-items')).toBe('baseline')
      expect(btn.classList.contains('seg-active')).toBe(true)
      expect(btn.getAttribute('aria-pressed')).toBe('true')
      expect(panel.root.querySelector('.am-dot.am-active')).toBeNull()
      expect(btn.classList.contains('baseline-toggle')).toBe(true)
    })

    it('clicking active toggle releases baseline (targeted discard of the session draft)', () => {
      const { el, panel } = flexSetup()
      const btn = panel.root.querySelector('[data-align-baseline]') as HTMLButtonElement
      btn.click()
      expect(el.style.getPropertyValue('align-items')).toBe('baseline')
      btn.click()
      expect(el.style.getPropertyValue('align-items')).toBe('')
      expect(btn.classList.contains('seg-active')).toBe(false)
      expect(btn.getAttribute('aria-pressed')).toBe('false')
    })

    it('app-authored baseline (no session draft): toggle starts active, OFF drafts flex-start', () => {
      const { el, panel, drafts } = flexSetup('align-items: baseline;')
      const btn = panel.root.querySelector('[data-align-baseline]') as HTMLButtonElement
      // baseline comes from the app's own CSS — active on show(), with no draft to discard
      expect(btn.classList.contains('seg-active')).toBe(true)
      expect(btn.getAttribute('aria-pressed')).toBe('true')
      expect(drafts.current(el, 'align-items')).toBeNull()

      btn.click()

      expect(drafts.current(el, 'align-items')).toBe('flex-start')
      expect(btn.classList.contains('seg-active')).toBe(false)
      expect(btn.getAttribute('aria-pressed')).toBe('false')
    })

    it('clicking a matrix dot exits baseline', () => {
      const { el, panel, drafts } = flexSetup()
      const btn = panel.root.querySelector('[data-align-baseline]') as HTMLButtonElement
      btn.click()
      expect(drafts.current(el, 'align-items')).toBe('baseline')

      const dot = panel.root.querySelector('.am-dot') as HTMLElement
      dot.click()

      expect(drafts.current(el, 'align-items')).toBe(dot.dataset.a)
      expect(btn.classList.contains('seg-active')).toBe(false)
    })
  })

  describe('remove auto layout', () => {
    it('remove button is visible only when the element is flex (mirror of add)', () => {
      const { panel: nonFlexPanel } = setup()
      const nonFlexRemove = nonFlexPanel.root.querySelector('[data-remove-layout]') as HTMLElement
      const nonFlexAdd = nonFlexPanel.root.querySelector('[data-add-layout]') as HTMLElement
      expect(nonFlexRemove.hidden).toBe(true)
      expect(nonFlexAdd.hidden).toBe(false)

      const { panel: flexPanel } = flexSetup()
      const flexRemove = flexPanel.root.querySelector('[data-remove-layout]') as HTMLElement
      const flexAdd = flexPanel.root.querySelector('[data-add-layout]') as HTMLElement
      expect(flexRemove.hidden).toBe(false)
      expect(flexAdd.hidden).toBe(true)
    })

    it('added-this-session: remove is a pure undo (discards drafts, nothing left to send)', () => {
      const { el, panel, drafts } = setup()
      ;(panel.root.querySelector('[data-add-layout]') as HTMLElement).click()
      commit(fieldInput(panel, P.GAP), '24')
      expect(drafts.current(el, 'gap')).toBe('24px')

      ;(panel.root.querySelector('[data-remove-layout]') as HTMLElement).click()

      expect(el.style.display).toBe('')
      expect(el.style.getPropertyValue('gap')).toBe('')
      expect(buildChangeRequest(drafts).elements.find((e) => e.selector === '#t')).toBeUndefined()
    })

    it('stylesheet flex: remove drafts display block and discards other flex drafts', () => {
      const { el, panel, drafts } = flexSetup()
      const dot = panel.root.querySelector('.am-dot') as HTMLElement
      dot.click()
      expect(drafts.current(el, 'justify-content')).not.toBeNull()

      ;(panel.root.querySelector('[data-remove-layout]') as HTMLElement).click()

      expect(drafts.current(el, 'display')).toBe('block')
      expect(drafts.current(el, 'justify-content')).toBeNull()
    })
  })

  it('flex-child controls are hidden when parent is not flex', () => {
    const { panel } = setup()
    const alignSelf = panel.root.querySelector('[data-align-self]') as HTMLElement
    expect(alignSelf.hidden).toBe(true)
    // .size-row wraps only the W/H sizing-mode selects (Typography's family/weight selects
    // reuse the .size-mode chrome class for styling but aren't part of the flex-child registry).
    const modes = [...panel.root.querySelectorAll('.size-row .size-mode')] as HTMLElement[]
    expect(modes.length).toBeGreaterThan(0)
    expect(modes.every((m) => m.hidden)).toBe(true)
  })

  function childSetup() {
    document.body.innerHTML = `<div id="parent" style="display: flex; flex-direction: row;">
      <div data-dc-source="src/Child.tsx:1:1" id="t" style="width: 50px; height: 50px;"></div>
    </div>`
    const el = document.getElementById('t')! as HTMLElement
    const drafts = new DraftStore()
    const onEdited = vi.fn()
    const panel = new Panel(drafts, onEdited)
    document.body.appendChild(panel.root)
    panel.show(el, buildInspectorData(el))
    return { el, drafts, panel, onEdited }
  }

  it('align strip is OFF by default when parent is flex and align-self is default', () => {
    const { panel } = childSetup()
    const toggle = panel.root.querySelector('[data-align-toggle]') as HTMLElement
    const strip = panel.root.querySelector('[data-align-self]') as HTMLElement
    expect(toggle.getAttribute('aria-pressed')).toBe('false')
    expect(strip.hidden).toBe(true)
    // size-mode selects still shown for flex children — the toggle gates only the strip
    const modes = [...panel.root.querySelectorAll('.size-row .size-mode')] as HTMLElement[]
    expect(modes.every((m) => !m.hidden)).toBe(true)
  })

  it('toggling ON reveals the strip without drafting anything', () => {
    const { el, panel, drafts } = childSetup()
    ;(panel.root.querySelector('[data-align-toggle]') as HTMLElement).click()
    const strip = panel.root.querySelector('[data-align-self]') as HTMLElement
    expect(strip.hidden).toBe(false)
    expect(drafts.current(el, 'align-self')).toBeNull()
    // nothing to send: opening the row is not an edit (same contract as opening a min/max row)
    expect(buildChangeRequest(drafts).elements.find((e) => e.selector === '#t')).toBeUndefined()
  })

  it('picking a segment after toggling ON drafts align-self', () => {
    const { el, panel, drafts } = childSetup()
    ;(panel.root.querySelector('[data-align-toggle]') as HTMLElement).click()
    const seg = panel.root.querySelector('[data-align-self]')!
    const startBtn = [...seg.querySelectorAll('.seg')].find((b) => b.textContent === 'Start') as HTMLElement
    startBtn.click()
    expect(drafts.current(el, 'align-self')).toBe('flex-start')
    expect((panel.root.querySelector('[data-align-toggle]') as HTMLElement).getAttribute('aria-pressed')).toBe('true')
  })

  it('toggling OFF discards a session draft (pure undo, Baseline semantics)', () => {
    const { el, panel, drafts } = childSetup()
    const toggle = panel.root.querySelector('[data-align-toggle]') as HTMLElement
    toggle.click()
    const seg = panel.root.querySelector('[data-align-self]')!
    ;([...seg.querySelectorAll('.seg')].find((b) => b.textContent === 'Center') as HTMLElement).click()
    expect(drafts.current(el, 'align-self')).toBe('center')
    toggle.click()
    expect(drafts.current(el, 'align-self')).toBeNull()
    expect((panel.root.querySelector('[data-align-self]') as HTMLElement).hidden).toBe(true)
  })

  it('auto-ON when the app CSS sets align-self; toggling OFF drafts align-self: auto', () => {
    document.body.innerHTML = `<div id="parent" style="display: flex; flex-direction: row;">
      <div data-dc-source="src/Child.tsx:1:1" id="t" style="align-self: center; width: 50px;"></div>
    </div>`
    const el = document.getElementById('t')! as HTMLElement
    const drafts = new DraftStore()
    const panel = new Panel(drafts, vi.fn())
    document.body.appendChild(panel.root)
    panel.show(el, buildInspectorData(el))
    const toggle = panel.root.querySelector('[data-align-toggle]') as HTMLElement
    expect(toggle.getAttribute('aria-pressed')).toBe('true')
    expect((panel.root.querySelector('[data-align-self]') as HTMLElement).hidden).toBe(false)
    toggle.click()
    expect(drafts.current(el, 'align-self')).toBe('auto')
  })

  it('cross-axis Fill turns the align toggle ON (stretch is real, never masked)', () => {
    const { panel } = childSetup()
    const hRow = fieldInput(panel, P.H).closest('.nf')!.parentElement!
    const select = hRow.querySelector('.size-mode') as HTMLSelectElement
    select.value = 'fill'
    select.dispatchEvent(new Event('change', { bubbles: true }))
    expect((panel.root.querySelector('[data-align-toggle]') as HTMLElement).getAttribute('aria-pressed')).toBe('true')
    expect((panel.root.querySelector('[data-align-self]') as HTMLElement).hidden).toBe(false)
  })

  it('manual-open latch clears on selection change', () => {
    const { panel } = childSetup()
    ;(panel.root.querySelector('[data-align-toggle]') as HTMLElement).click()
    expect((panel.root.querySelector('[data-align-self]') as HTMLElement).hidden).toBe(false)
    // reselect the same element: buildBody rebuilds, latch must not survive
    const el = document.getElementById('t')! as HTMLElement
    panel.show(el, buildInspectorData(el))
    expect((panel.root.querySelector('[data-align-self]') as HTMLElement).hidden).toBe(true)
  })

  it('W size-mode Fill on a row parent drafts flex-grow and flex-basis (main axis)', () => {
    const { el, panel, drafts } = childSetup()
    const wRow = fieldInput(panel, P.W).closest('.nf')!.parentElement!
    const select = wRow.querySelector('.size-mode') as HTMLSelectElement
    select.value = 'fill'
    select.dispatchEvent(new Event('change', { bubbles: true }))
    expect(drafts.current(el, 'flex-grow')).toBe('1')
    expect(drafts.current(el, 'flex-basis')).toBe('0%')
  })

  it('H size-mode Fill on a row parent drafts align-self:stretch (cross axis)', () => {
    const { el, panel, drafts } = childSetup()
    const hRow = fieldInput(panel, P.H).closest('.nf')!.parentElement!
    const select = hRow.querySelector('.size-mode') as HTMLSelectElement
    select.value = 'fill'
    select.dispatchEvent(new Event('change', { bubbles: true }))
    expect(drafts.current(el, 'align-self')).toBe('stretch')
  })

  it('H size-mode Hug drafts height:auto and the field shows auto', () => {
    const { el, panel, drafts } = childSetup()
    const hRow = fieldInput(panel, P.H).closest('.nf')!.parentElement!
    const select = hRow.querySelector('.size-mode') as HTMLSelectElement
    select.value = 'hug'
    select.dispatchEvent(new Event('change', { bubbles: true }))
    expect(drafts.current(el, 'height')).toBe('auto')
    expect(fieldInput(panel, P.H).value).toBe('auto')
  })

  it('W size-mode Fill then Fixed pins width as a px draft and clears flex-grow/flex-basis', () => {
    const { el, panel, drafts } = childSetup()
    const wRow = fieldInput(panel, P.W).closest('.nf')!.parentElement!
    const select = wRow.querySelector('.size-mode') as HTMLSelectElement
    select.value = 'fill'
    select.dispatchEvent(new Event('change', { bubbles: true }))
    expect(drafts.current(el, 'flex-grow')).toBe('1')
    select.value = 'fixed'
    select.dispatchEvent(new Event('change', { bubbles: true }))
    expect(drafts.current(el, 'width')).toMatch(/^\d+px$/)
    expect(drafts.current(el, 'flex-grow')).toBeNull()
    expect(drafts.current(el, 'flex-basis')).toBeNull()
  })

  it('W size-mode Fixed sticks on refresh after Fill then Fixed', () => {
    const { panel } = childSetup()
    const wRow = fieldInput(panel, P.W).closest('.nf')!.parentElement!
    const select = wRow.querySelector('.size-mode') as HTMLSelectElement
    select.value = 'fill'
    select.dispatchEvent(new Event('change', { bubbles: true }))
    select.value = 'fixed'
    select.dispatchEvent(new Event('change', { bubbles: true }))
    panel.refresh()
    expect(select.value).toBe('fixed')
  })

  it('H size-mode Hug then Fixed pins height as a px draft, not auto', () => {
    const { el, panel, drafts } = childSetup()
    const hRow = fieldInput(panel, P.H).closest('.nf')!.parentElement!
    const select = hRow.querySelector('.size-mode') as HTMLSelectElement
    select.value = 'hug'
    select.dispatchEvent(new Event('change', { bubbles: true }))
    expect(drafts.current(el, 'height')).toBe('auto')
    select.value = 'fixed'
    select.dispatchEvent(new Event('change', { bubbles: true }))
    expect(drafts.current(el, 'height')).toMatch(/^\d+px$/)
    expect(drafts.current(el, 'height')).not.toBe('auto')
  })

  it('cross-axis Fixed preserves a user-drafted align-self (only discards it when Fill wrote "stretch")', () => {
    const { el, panel, drafts } = childSetup()
    const seg = panel.root.querySelector('[data-align-self]')!
    const startBtn = [...seg.querySelectorAll('.seg')].find((b) => b.textContent === 'Start') as HTMLElement
    startBtn.click()
    expect(drafts.current(el, 'align-self')).toBe('flex-start')

    // Switch H (cross axis on a row parent) to Fixed — must NOT clobber the user's align-self.
    const hRow = fieldInput(panel, P.H).closest('.nf')!.parentElement!
    const select = hRow.querySelector('.size-mode') as HTMLSelectElement
    select.value = 'fixed'
    select.dispatchEvent(new Event('change', { bubbles: true }))

    expect(drafts.current(el, 'align-self')).toBe('flex-start')
  })

  it('Fixed pins the size the user SEES (computed before mode drafts are discarded)', () => {
    // Set up flex parent with filled child
    document.body.innerHTML = `<div id="parent" style="display: flex; flex-direction: row; width: 400px;">
      <div data-dc-source="src/Child.tsx:1:1" id="t" style="width: 50px; height: 50px;"></div>
    </div>`
    const parent = document.getElementById('parent')! as HTMLElement
    const child = document.getElementById('t')! as HTMLElement
    const drafts = new DraftStore()
    const onEdited = vi.fn()
    const panel = new Panel(drafts, onEdited)
    document.body.appendChild(panel.root)
    panel.show(child, buildInspectorData(child))

    // Apply Fill mode to width (drafts flex-grow: 1, flex-basis: 0%)
    const wRow = fieldInput(panel, P.W).closest('.nf')!.parentElement!
    const select = wRow.querySelector('.size-mode') as HTMLSelectElement
    select.value = 'fill'
    select.dispatchEvent(new Event('change', { bubbles: true }))

    // Stub getComputedStyle to simulate flex layout: while Fill is active, element is 200px;
    // once discarded, it would collapse to 50px
    const realGCS = window.getComputedStyle.bind(window)
    vi.stubGlobal('getComputedStyle', (el: Element) => {
      const cs = realGCS(el)
      if (el === child) {
        const filled = (el as HTMLElement).style.flexGrow === '1'
        return new Proxy(cs, {
          get(t, k) {
            if (k === 'getPropertyValue') {
              return (prop: string) =>
                prop === 'width' ? (filled ? '200px' : '50px') : cs.getPropertyValue(prop)
            }
            return Reflect.get(t, k)
          },
        })
      }
      return cs
    })

    // Switch mode to Fixed: should pin 200px (what user sees), not 50px (post-collapse)
    select.value = 'fixed'
    select.dispatchEvent(new Event('change', { bubbles: true }))
    expect(drafts.current(child, 'width')).toBe('200px')
  })

  it('Fixed pin bails when the computed size is not finite (no NaN draft)', () => {
    document.body.innerHTML = `<div id="parent" style="display: flex; flex-direction: row; width: 400px;">
      <div data-dc-source="src/Child.tsx:1:1" id="t" style="width: 50px; height: 50px;"></div>
    </div>`
    const child = document.getElementById('t')! as HTMLElement
    const drafts = new DraftStore()
    const onEdited = vi.fn()
    const panel = new Panel(drafts, onEdited)
    document.body.appendChild(panel.root)
    panel.show(child, buildInspectorData(child))

    const realGCS = window.getComputedStyle.bind(window)
    vi.stubGlobal('getComputedStyle', (el: Element) => {
      const cs = realGCS(el)
      if (el === child) {
        return new Proxy(cs, {
          get(t, k) {
            if (k === 'getPropertyValue') {
              return (prop: string) => (prop === 'width' ? 'not-a-size' : cs.getPropertyValue(prop))
            }
            return Reflect.get(t, k)
          },
        })
      }
      return cs
    })

    const wRow = fieldInput(panel, P.W).closest('.nf')!.parentElement!
    const select = wRow.querySelector('.size-mode') as HTMLSelectElement
    select.value = 'fixed'
    select.dispatchEvent(new Event('change', { bubbles: true }))

    // Pin bailed out entirely — no NaN draft was written (width draft stays whatever it was, i.e. null)
    expect(drafts.current(child, 'width')).toBeNull()
  })

  it('W/H shows the auto keyword when the element authored inline style="width: auto" (no draft)', () => {
    const { panel } = setup(
      `<div data-dc-source="src/Card.tsx:4:7" id="t" style="width: auto; height: 100px;"></div>`
    )
    expect(fieldInput(panel, P.W).value).toBe('auto')
  })

  it('has a Prompt button in the header, hidden when nothing is selected', () => {
    const { panel, el } = setup()
    expect(panel.promptButton.classList.contains('panel-prompt')).toBe(true)
    expect(panel.root.querySelector('.panel-head .panel-prompt')).toBe(panel.promptButton)
    panel.hide()
    expect(panel.promptButton.hidden).toBe(true)
    panel.show(el, buildInspectorData(el))
    expect(panel.promptButton.hidden).toBe(false)
  })

})

describe('min/max sizing disclosure (M-D)', () => {
  // data-minmax-row is the disclosure hook: located either directly (data-props-row) or by
  // walking up from the field's own data-props attr (fieldInput already resolves that).
  const minMaxRow = (panel: Panel, props: string) =>
    (panel.root.querySelector(`[data-minmax-row][data-props-row="${props}"]`) ??
      fieldInput(panel, props).closest('[data-minmax-row]')) as HTMLElement

  it('rows exist in the Layout body but are hidden for default-valued elements', () => {
    const { panel } = setup()
    expect(fieldInput(panel, P.MIN_W)).toBeTruthy() // row markup exists
    expect(minMaxRow(panel, P.MIN_W).hidden).toBe(true)
  })

  it('a non-default computed min-width discloses its row on selection', () => {
    const { panel } = setup(
      `<div data-dc-source="src/Card.tsx:4:7" id="t" style="padding: 8px; width: 200px; min-width: 120px;"></div>`
    )
    expect(minMaxRow(panel, P.MIN_W).hidden).toBe(false)
    expect(minMaxRow(panel, P.MAX_W).hidden).toBe(true) // independent per row
  })

  it('Add min… on the W select opens the min-width row and resets the select to the real mode', () => {
    document.body.innerHTML = `<div id="parent" style="display: flex; flex-direction: row;">
      <div data-dc-source="src/Child.tsx:1:1" id="t" style="width: 50px; height: 50px;"></div>
    </div>`
    const el = document.getElementById('t')! as HTMLElement
    const drafts = new DraftStore()
    const onEdited = vi.fn()
    const panel = new Panel(drafts, onEdited)
    document.body.appendChild(panel.root)
    panel.show(el, buildInspectorData(el))

    const wRow = fieldInput(panel, P.W).closest('.nf')!.parentElement!
    const select = wRow.querySelector('.size-mode') as HTMLSelectElement
    select.value = 'add-min'
    select.dispatchEvent(new Event('change', { bubbles: true }))

    expect(minMaxRow(panel, P.MIN_W).hidden).toBe(false)
    expect(['fixed', 'hug', 'fill']).toContain(select.value)
  })

  it('typing auto clears: drafts the initial keyword and the row stays while the draft lives', () => {
    const { el, panel } = setup(
      `<div data-dc-source="src/Card.tsx:4:7" id="t" style="padding: 8px; width: 200px; max-width: 200px;"></div>`
    )
    expect(minMaxRow(panel, P.MAX_W).hidden).toBe(false)
    commit(fieldInput(panel, P.MAX_W), 'auto')
    expect(el.style.getPropertyValue('max-width')).toBe('none')
    expect(minMaxRow(panel, P.MAX_W).hidden).toBe(false) // draft latch
  })

  it('multi-select hides all min/max rows', () => {
    document.body.innerHTML = `
      <div data-dc-source="src/A.tsx:1:1" id="a" style="width: 100px; min-width: 120px;"></div>
      <div data-dc-source="src/B.tsx:2:2" id="b" style="width: 100px;"></div>
    `
    const a = document.getElementById('a')! as HTMLElement
    const b = document.getElementById('b')! as HTMLElement
    const drafts = new DraftStore()
    const onEdited = vi.fn()
    const panel = new Panel(drafts, onEdited)
    document.body.appendChild(panel.root)
    panel.show([a, b], buildInspectorData(a))

    expect(minMaxRow(panel, P.MIN_W).hidden).toBe(true)
    expect(minMaxRow(panel, P.MAX_W).hidden).toBe(true)
    expect(minMaxRow(panel, P.MIN_H).hidden).toBe(true)
    expect(minMaxRow(panel, P.MAX_H).hidden).toBe(true)
  })
})

describe('Panel expand-state persistence (B1 nit)', () => {
  // The expand button's title (.panel-section) is followed by TWO .panel-rows siblings:
  // the always-visible rowWrap, then the expandWrap the button toggles. Grab the second one.
  function expandWrapFor(panel: Panel): HTMLElement {
    const title = (panel.root.querySelector('[data-expand="padding"]') as HTMLElement).closest('.panel-section')!
    const rowsWraps = [] as HTMLElement[]
    let sib = title.nextElementSibling as HTMLElement | null
    while (sib && rowsWraps.length < 2) {
      rowsWraps.push(sib)
      sib = sib.nextElementSibling as HTMLElement | null
    }
    return rowsWraps[1]
  }

  it('keeps a section expanded across a second show() call for a different element', () => {
    document.body.innerHTML = `
      <div data-dc-source="src/a.tsx:1:1" id="a" style="padding: 8px;"></div>
      <div data-dc-source="src/b.tsx:1:1" id="b" style="padding: 4px;"></div>
    `
    const a = document.getElementById('a')! as HTMLElement
    const b = document.getElementById('b')! as HTMLElement
    const drafts = new DraftStore()
    const panel = new Panel(drafts, vi.fn())
    document.body.appendChild(panel.root)

    panel.show(a, buildInspectorData(a))
    ;(panel.root.querySelector('[data-expand="padding"]') as HTMLElement).click()
    expect(expandWrapFor(panel).hidden).toBe(false)

    panel.show(b, buildInspectorData(b))
    expect(expandWrapFor(panel).hidden).toBe(false)
  })

  it('defaults to collapsed for a section that was never expanded', () => {
    const { panel } = setup()
    expect(expandWrapFor(panel).hidden).toBe(true)
  })
})

describe('Panel onBeforeEdit pre-hook (M2b Task 4)', () => {
  function setupWithBeforeEdit(html?: string) {
    document.body.innerHTML =
      html ?? `<div data-dc-source="src/Card.tsx:4:7" id="t" style="padding: 8px; width: 200px;"></div>`
    const el = document.getElementById('t')! as HTMLElement
    const drafts = new DraftStore()
    const onEdited = vi.fn()
    const onBeforeEdit = vi.fn()
    const panel = new Panel(drafts, onEdited, onBeforeEdit)
    document.body.appendChild(panel.root)
    panel.show(el, buildInspectorData(el))
    return { el, drafts, panel, onEdited, onBeforeEdit }
  }

  it('is optional — omitting it does not throw on edit', () => {
    const { panel } = setup()
    expect(() => commit(fieldInput(panel, P.W), '300')).not.toThrow()
  })

  it('a plain number-field edit calls onBeforeEdit with the element before onEdited', () => {
    const { el, panel, onBeforeEdit, onEdited } = setupWithBeforeEdit()
    commit(fieldInput(panel, P.PX), '16')
    expect(onBeforeEdit).toHaveBeenCalledWith(el)
    expect(onBeforeEdit.mock.invocationCallOrder[0]).toBeLessThan(onEdited.mock.invocationCallOrder[0])
  })

  it('reset also calls onBeforeEdit before onEdited', () => {
    const { el, panel, onBeforeEdit, onEdited } = setupWithBeforeEdit()
    commit(fieldInput(panel, P.W), '300')
    onBeforeEdit.mockClear()
    onEdited.mockClear()
    panel.resetButton.click()
    expect(onBeforeEdit).toHaveBeenCalledWith(el)
    expect(onBeforeEdit.mock.invocationCallOrder[0]).toBeLessThan(onEdited.mock.invocationCallOrder[0])
  })

  it('add-auto-layout calls onBeforeEdit before onEdited', () => {
    const { el, panel, onBeforeEdit, onEdited } = setupWithBeforeEdit()
    const btn = panel.root.querySelector('[data-add-layout]') as HTMLElement
    btn.click()
    expect(onBeforeEdit).toHaveBeenCalledWith(el)
    expect(onBeforeEdit.mock.invocationCallOrder[0]).toBeLessThan(onEdited.mock.invocationCallOrder[0])
  })

  it('size-mode select change calls onBeforeEdit before onEdited', () => {
    document.body.innerHTML = `<div id="parent" style="display: flex; flex-direction: row;">
      <div data-dc-source="src/Child.tsx:1:1" id="t" style="width: 50px; height: 50px;"></div>
    </div>`
    const el = document.getElementById('t')! as HTMLElement
    const drafts = new DraftStore()
    const onEdited = vi.fn()
    const onBeforeEdit = vi.fn()
    const panel = new Panel(drafts, onEdited, onBeforeEdit)
    document.body.appendChild(panel.root)
    panel.show(el, buildInspectorData(el))

    const wRow = fieldInput(panel, P.W).closest('.nf')!.parentElement!
    const select = wRow.querySelector('.size-mode') as HTMLSelectElement
    select.value = 'fill'
    select.dispatchEvent(new Event('change', { bubbles: true }))
    expect(onBeforeEdit).toHaveBeenCalledWith(el)
    expect(onBeforeEdit.mock.invocationCallOrder[0]).toBeLessThan(onEdited.mock.invocationCallOrder[0])
  })
})

describe('normalizeJustify', () => {
  it('maps normal, start, left, and the jsdom empty string to flex-start', () => {
    expect(normalizeJustify('normal')).toBe('flex-start')
    expect(normalizeJustify('start')).toBe('flex-start')
    expect(normalizeJustify('left')).toBe('flex-start')
    expect(normalizeJustify('')).toBe('flex-start')
  })

  it('maps end and right to flex-end', () => {
    expect(normalizeJustify('end')).toBe('flex-end')
    expect(normalizeJustify('right')).toBe('flex-end')
  })

  it('passes through center and space-between unchanged', () => {
    expect(normalizeJustify('center')).toBe('center')
    expect(normalizeJustify('space-between')).toBe('space-between')
  })
})

describe('normalizeAlign', () => {
  it('maps normal, start, and the jsdom empty string to flex-start', () => {
    expect(normalizeAlign('normal')).toBe('flex-start')
    expect(normalizeAlign('start')).toBe('flex-start')
    expect(normalizeAlign('')).toBe('flex-start')
  })

  it('maps end to flex-end', () => {
    expect(normalizeAlign('end')).toBe('flex-end')
  })

  it('passes through center unchanged', () => {
    expect(normalizeAlign('center')).toBe('center')
  })

  it('does NOT map stretch — it must match no dot in the align matrix', () => {
    const result = normalizeAlign('stretch')
    expect(result).toBe('stretch')
    expect(result).not.toBe('flex-start')
    expect(result).not.toBe('flex-end')
    expect(result).not.toBe('center')
  })
})

describe('hasDirectText', () => {
  it('returns true when the element has a direct non-whitespace text node child', () => {
    document.body.innerHTML = `<div id="t">Hello</div>`
    expect(hasDirectText(document.getElementById('t')!)).toBe(true)
  })

  it('returns false when the element only has element children', () => {
    document.body.innerHTML = `<div id="t"><span>Hello</span></div>`
    expect(hasDirectText(document.getElementById('t')!)).toBe(false)
  })

  it('returns false when the direct text child is whitespace-only', () => {
    document.body.innerHTML = `<div id="t">   \n  <span>Hello</span></div>`
    expect(hasDirectText(document.getElementById('t')!)).toBe(false)
  })
})

describe('tokenEntriesFor', () => {
  const TW: Theme = { rootFontPx: 16, spacingBasePx: 4, radiusScale: { sm: 4, md: 6, lg: 8, xl: 12 } }
  const PLAIN: Theme = { rootFontPx: 16, spacingBasePx: null, radiusScale: {} }
  const TOKENS: Tokens = {
    colors: [],
    textScale: [
      { name: 'sm', px: 14 },
      { name: 'base', px: 16 },
      { name: 'lg', px: 18 },
    ],
  }

  it('spacing prop (padding-top) returns the Tailwind numeric scale x spacingBasePx', () => {
    const entries = tokenEntriesFor({ props: ['padding-top'] }, TW, TOKENS)
    expect(entries).not.toBeNull()
    const four = entries!.find((e) => e.label === '4')
    expect(four).toEqual({ label: '4', px: 16 }) // spot-check 4 -> 16px at base 4
    // full Tailwind numeric scale is present
    expect(entries!.map((e) => e.label)).toEqual(
      ['0', '0.5', '1', '1.5', '2', '2.5', '3', '3.5', '4', '5', '6', '7', '8', '9', '10', '11', '12', '14', '16', '20', '24', '28', '32', '36', '40', '44', '48', '52', '56', '60', '64', '72', '80', '96']
    )
  })

  it('spacing prop returns null when spacingBasePx is null (non-Tailwind project)', () => {
    expect(tokenEntriesFor({ props: ['padding-top'] }, PLAIN, TOKENS)).toBeNull()
  })

  it('width/height/gap/margin props also resolve via the spacing scale', () => {
    for (const props of [['width'], ['height'], ['gap'], ['margin-left', 'margin-right']]) {
      expect(tokenEntriesFor({ props }, TW, TOKENS)).not.toBeNull()
    }
  })

  it('radius prop returns theme.radiusScale entries', () => {
    const entries = tokenEntriesFor({ props: ['border-top-left-radius'] }, TW, TOKENS)
    expect(entries).toEqual([
      { label: 'sm', px: 4 },
      { label: 'md', px: 6 },
      { label: 'lg', px: 8 },
      { label: 'xl', px: 12 },
    ])
  })

  it('font-size prop returns readTokens().textScale entries', () => {
    const entries = tokenEntriesFor({ props: ['font-size'] }, TW, TOKENS)
    expect(entries).toEqual([
      { label: 'sm', px: 14 },
      { label: 'base', px: 16 },
      { label: 'lg', px: 18 },
    ])
  })

  it('opacity (and other unmapped props) return null — no picker', () => {
    expect(tokenEntriesFor({ props: ['opacity'] }, TW, TOKENS)).toBeNull()
  })
})

describe('colorTokenEntries', () => {
  it('maps tokens.colors to {label, color} entries preserving readTokens() sorted order', () => {
    const tokens: Tokens = {
      colors: [
        { name: 'red-100', value: '#ffcccc' },
        { name: 'red-500', value: '#ff0000' },
        { name: 'blue-400', value: '#0000ff' },
      ],
      textScale: [],
    }
    const entries = colorTokenEntries(tokens)
    expect(entries).not.toBeNull()
    expect(entries).toEqual([
      { label: 'red-100', color: '#ffcccc' },
      { label: 'red-500', color: '#ff0000' },
      { label: 'blue-400', color: '#0000ff' },
    ])
  })

  it('filters out unparseable token value (e.g. var(--indirect))', () => {
    const tokens: Tokens = {
      colors: [
        { name: 'red-500', value: '#ff0000' },
        { name: 'indirect', value: 'var(--indirect)' },
        { name: 'blue-500', value: '#0000ff' },
      ],
      textScale: [],
    }
    const entries = colorTokenEntries(tokens)
    expect(entries).toEqual([
      { label: 'red-500', color: '#ff0000' },
      { label: 'blue-500', color: '#0000ff' },
    ])
  })

  it('returns null when color set is empty or all colors are unparseable', () => {
    const emptyTokens: Tokens = {
      colors: [],
      textScale: [],
    }
    expect(colorTokenEntries(emptyTokens)).toBeNull()

    const unparseableTokens: Tokens = {
      colors: [{ name: 'indirect', value: 'var(--indirect)' }],
      textScale: [],
    }
    expect(colorTokenEntries(unparseableTokens)).toBeNull()
  })
})

describe('Panel Typography section', () => {
  function textSetup(styleExtra = '') {
    return setup(
      `<div data-dc-source="src/Card.tsx:4:7" id="t" style="${styleExtra}">Some text</div>`
    )
  }

  function emptySetup() {
    return setup(`<div data-dc-source="src/Card.tsx:4:7" id="t"></div>`)
  }

  function typographySection(panel: Panel): HTMLElement {
    return [...panel.root.querySelectorAll('.panel-section')].find(
      (n) => n.textContent?.replace('⋯', '').trim() === 'Typography'
    ) as HTMLElement
  }

  it('is hidden for an element with no direct text child', () => {
    const { panel } = emptySetup()
    expect(typographySection(panel).hidden).toBe(true)
  })

  it('hides the Typography BODY (not just the title) for an element with no direct text child (final review fix #1)', () => {
    const { panel } = emptySetup()
    // The body immediately follows the title in DOM order (buildBody appends the custom
    // typography wrap right after the section title).
    const bodyWrap = typographySection(panel).nextElementSibling as HTMLElement
    expect(bodyWrap).toBeTruthy()
    expect(bodyWrap.hidden).toBe(true)
  })

  it('is visible for an element with a direct text child', () => {
    const { panel } = textSetup()
    expect(typographySection(panel).hidden).toBe(false)
  })

  it('sits between Margin and Fill in stable DOM order', () => {
    const { panel } = textSetup()
    const titles = [...panel.root.querySelectorAll('.panel-section')].map(
      (n) => n.textContent?.replace('⋯', '').trim()
    )
    const marginIdx = titles.indexOf('Margin')
    const typographyIdx = titles.indexOf('Typography')
    const fillIdx = titles.indexOf('Fill')
    expect(typographyIdx).toBe(marginIdx + 1)
    expect(fillIdx).toBe(typographyIdx + 1)
  })

  it('family select lists the current computed family first, deduped, then document.fonts, then fallbacks', () => {
    const { panel } = textSetup('font-family: Georgia, serif;')
    const select = panel.root.querySelector('.type-family') as HTMLSelectElement
    expect(select).toBeTruthy()
    const options = [...select.options].map((o) => o.value)
    expect(options[0]).toBe('Georgia')
    // dedupe: 'serif' appears once even though it's both a fallback and possibly a computed family
    expect(options.filter((o) => o === 'Georgia')).toHaveLength(1)
    expect(options).toContain('system-ui')
    expect(options).toContain('serif')
    expect(options).toContain('monospace')
  })

  it('family select drafts font-family, quoting names with spaces', () => {
    const { el, panel, drafts } = textSetup()
    const select = panel.root.querySelector('.type-family') as HTMLSelectElement
    const opt = document.createElement('option')
    opt.value = 'Times New Roman'
    select.append(opt)
    select.value = 'Times New Roman'
    select.dispatchEvent(new Event('change', { bubbles: true }))
    expect(drafts.current(el, 'font-family')).toBe('"Times New Roman"')
  })

  it('family select drafts an unquoted single-word family name', () => {
    const { el, panel, drafts } = textSetup()
    const select = panel.root.querySelector('.type-family') as HTMLSelectElement
    select.value = 'monospace'
    select.dispatchEvent(new Event('change', { bubbles: true }))
    expect(drafts.current(el, 'font-family')).toBe('monospace')
  })

  it('weight select shows computed 400 as value 400', () => {
    const { panel } = textSetup('font-weight: 400;')
    const select = panel.root.querySelector('.type-weight') as HTMLSelectElement
    expect(select.value).toBe('400')
  })

  it('weight select snaps computed "normal" to 400 and "bold" to 700', () => {
    const { panel } = textSetup('font-weight: normal;')
    const select = panel.root.querySelector('.type-weight') as HTMLSelectElement
    expect(select.value).toBe('400')
  })

  it('weight select drafts font-weight on change', () => {
    const { el, panel, drafts } = textSetup()
    const select = panel.root.querySelector('.type-weight') as HTMLSelectElement
    select.value = '600'
    select.dispatchEvent(new Event('change', { bubbles: true }))
    expect(drafts.current(el, 'font-weight')).toBe('600')
  })

  it('typography and stroke selects carry CSS-hint titles', () => {
    const { panel } = textSetup()
    expect((panel.root.querySelector('.type-weight') as HTMLElement).title).toBe('font-weight → font-*')
    expect((panel.root.querySelector('.type-family') as HTMLElement).title).toBe('font-family')
    expect((panel.root.querySelector('.stroke-style') as HTMLElement).title).toBe(
      'border-style → border-solid / border-dashed / border-dotted'
    )
  })

  it('S field drafts font-size in px', () => {
    const { el, panel, drafts } = textSetup()
    commit(fieldInput(panel, P.S), '18')
    expect(drafts.current(el, 'font-size')).toBe('18px')
  })

  it('LH field shows auto when computed line-height is normal', () => {
    const { panel } = textSetup('line-height: normal;')
    expect(fieldInput(panel, P.LH).value).toBe('auto')
  })

  it('LH field typing a number drafts line-height in px', () => {
    const { el, panel, drafts } = textSetup()
    commit(fieldInput(panel, P.LH), '24')
    expect(drafts.current(el, 'line-height')).toBe('24px')
  })

  it('LS field allows negative values and drafts letter-spacing in px', () => {
    const { el, panel, drafts } = textSetup()
    commit(fieldInput(panel, P.LS), '-1')
    expect(drafts.current(el, 'letter-spacing')).toBe('-1px')
  })

  it('Align segment drafts text-align', () => {
    const { el, panel, drafts } = textSetup()
    const seg = panel.root.querySelector('[data-text-align]')!
    const centerBtn = [...seg.querySelectorAll('.seg')].find((b) => b.textContent === 'Center') as HTMLElement
    centerBtn.click()
    expect(drafts.current(el, 'text-align')).toBe('center')
  })

  it('Align segment maps computed "start" to the Left active dot', () => {
    const { panel } = textSetup('text-align: start;')
    const seg = panel.root.querySelector('[data-text-align]')!
    const leftBtn = [...seg.querySelectorAll('.seg')].find((b) => b.textContent === 'Left') as HTMLElement
    expect(leftBtn.classList.contains('seg-active')).toBe(true)
  })
})

describe('Panel Fill section', () => {
  function fillSection(panel: Panel): HTMLElement {
    return [...panel.root.querySelectorAll('.panel-section')].find(
      (n) => n.textContent?.replace('⋯', '').trim() === 'Fill'
    ) as HTMLElement
  }

  function colorRows(panel: Panel): HTMLElement[] {
    return [...fillSection(panel).parentElement!.querySelectorAll('.color-row')].filter((row) => {
      // Fill section's rows sit in the .panel-rows sibling immediately after the Fill title.
      const title = row.closest('.panel-rows')?.previousElementSibling
      return title === fillSection(panel) && !(row as HTMLElement).hidden
    }) as HTMLElement[]
  }

  it('shows a swatch and value text reflecting the computed background-color', () => {
    const { panel } = setup(
      `<div data-dc-source="src/Card.tsx:4:7" id="t" style="background-color: rgb(255, 0, 0);"></div>`
    )
    const rows = colorRows(panel)
    const fillRow = rows[0]
    const swatch = fillRow.querySelector('.swatch') as HTMLElement
    expect(swatch).toBeTruthy()
    // Color lives on the `.swatch-color` child stacked over the checkerboard base —
    // see overlay.ts's `.swatch`/`.swatch-color` split.
    const swatchColor = swatch.querySelector('.swatch-color') as HTMLElement
    expect(swatchColor).toBeTruthy()
    expect(swatchColor.style.color).toBe('rgb(255, 0, 0)')
  })

  it('Text row is hidden for an element with no direct text child', () => {
    const { panel } = setup(`<div data-dc-source="src/Card.tsx:4:7" id="t"><span>x</span></div>`)
    const rows = colorRows(panel)
    expect(rows).toHaveLength(1) // only Fill, Text row absent/hidden
  })

  it('Text row is visible for an element with direct text', () => {
    const { panel } = setup(`<div data-dc-source="src/Card.tsx:4:7" id="t">Hello</div>`)
    const rows = colorRows(panel)
    expect(rows).toHaveLength(2)
  })

  it('clicking the Fill swatch opens the picker with contrastAgainst set to the computed text color', () => {
    const { panel } = setup(
      `<div data-dc-source="src/Card.tsx:4:7" id="t" style="background-color: rgb(255,255,255); color: rgb(0,0,0);">Hi</div>`
    )
    const openSpy = vi.fn()
    ;(panel as unknown as { colorPicker: { open: typeof openSpy } }).colorPicker.open = openSpy
    const fillRow = colorRows(panel)[0]
    const swatch = fillRow.querySelector('.swatch') as HTMLElement
    swatch.click()
    expect(openSpy).toHaveBeenCalledTimes(1)
    const opts = openSpy.mock.calls[0][0]
    expect(opts.contrastAgainst).toBe('rgb(0, 0, 0)')
  })

  it('picking a fill color drafts background-color live', () => {
    const { el, panel, drafts } = setup(
      `<div data-dc-source="src/Card.tsx:4:7" id="t" style="background-color: rgb(255,255,255);"></div>`
    )
    const fillRow = colorRows(panel)[0]
    const swatch = fillRow.querySelector('.swatch') as HTMLElement
    let onPick: ((css: string, meta: { token?: string }) => void) | null = null
    ;(panel as unknown as { colorPicker: { open: (opts: any) => void } }).colorPicker.open = (opts) => {
      onPick = opts.onPick
    }
    swatch.click()
    onPick!('rgb(10, 20, 30)', {})
    expect(drafts.current(el, 'background-color')).toBe('rgb(10, 20, 30)')
  })

  it('clicking the Text swatch opens the picker with contrastAgainst set to the effective background', () => {
    const { panel } = setup(
      `<div data-dc-source="src/Card.tsx:4:7" id="t" style="background-color: rgb(20,20,20); color: rgb(255,255,255);">Hi</div>`
    )
    const openSpy = vi.fn()
    ;(panel as unknown as { colorPicker: { open: typeof openSpy } }).colorPicker.open = openSpy
    const textRow = colorRows(panel)[1]
    const swatch = textRow.querySelector('.swatch') as HTMLElement
    swatch.click()
    expect(openSpy).toHaveBeenCalledTimes(1)
    const opts = openSpy.mock.calls[0][0]
    expect(opts.contrastAgainst).toBe('rgb(20, 20, 20)')
  })

  it('a fully-transparent Fill shows the literal "transparent" label, not a nearest-token guess', () => {
    const { panel } = setup(
      `<div data-dc-source="src/Card.tsx:4:7" id="t" style="background-color: transparent;"></div>`
    )
    const fillRow = colorRows(panel)[0]
    const valueEl = fillRow.querySelector('.color-value') as HTMLElement
    expect(valueEl.textContent).toBe('transparent')
  })

  it('a semi-transparent Fill shows a hex fallback, not a token name, even if the rgb matches a token', () => {
    document.head.insertAdjacentHTML('beforeend', '<style data-test-cl-tokens>:root { --color-red-500: #ff0000; }</style>')
    document.documentElement.style.setProperty('--color-red-500', '#ff0000')
    try {
      const { panel } = setup(
        `<div data-dc-source="src/Card.tsx:4:7" id="t" style="background-color: rgba(255, 0, 0, 0.5);"></div>`
      )
      const fillRow = colorRows(panel)[0]
      const valueEl = fillRow.querySelector('.color-value') as HTMLElement
      expect(valueEl.textContent).not.toBe('red-500')
      expect(valueEl.textContent).toBe('#ff000080')
    } finally {
      document.querySelectorAll('style[data-test-cl-tokens]').forEach((s) => s.remove())
      document.documentElement.removeAttribute('style')
      resetTokensCache()
    }
  })
})

describe('Panel Stroke section', () => {
  function strokeSection(panel: Panel): HTMLElement {
    return [...panel.root.querySelectorAll('.panel-section')].find(
      (n) => n.textContent?.replace('⋯', '').trim() === 'Stroke'
    ) as HTMLElement
  }

  function strokeWidthField(panel: Panel): HTMLInputElement {
    const nf = strokeSection(panel).nextElementSibling!.querySelector('.nf') as HTMLElement
    return nf.querySelector('input') as HTMLInputElement
  }

  it('is always visible', () => {
    const { panel } = setup(`<div data-dc-source="src/Card.tsx:4:7" id="t"></div>`)
    expect(strokeSection(panel).hidden).toBe(false)
  })

  it('W field drafts all four border-*-width longhands', () => {
    const { el, panel, drafts } = setup(
      `<div data-dc-source="src/Card.tsx:4:7" id="t" style="border-style: solid;"></div>`
    )
    commit(strokeWidthField(panel), '3')
    for (const side of ['top', 'right', 'bottom', 'left']) {
      expect(drafts.current(el, `border-${side}-width`)).toBe('3px')
    }
  })

  it('W field shows Mixed when computed per-side widths differ', () => {
    const { panel } = setup(
      `<div data-dc-source="src/Card.tsx:4:7" id="t" style="border-style: solid; border-top-width: 2px; border-right-width: 4px; border-bottom-width: 2px; border-left-width: 2px;"></div>`
    )
    expect(strokeWidthField(panel).value).toBe('Mixed')
  })

  it('drafting a width while computed border-style is none also drafts border-style: solid', () => {
    const { el, panel, drafts } = setup(`<div data-dc-source="src/Card.tsx:4:7" id="t"></div>`)
    commit(strokeWidthField(panel), '2')
    for (const side of ['top', 'right', 'bottom', 'left']) {
      expect(drafts.current(el, `border-${side}-style`)).toBe('solid')
    }
  })

  it('style select drafts all four border-*-style longhands', () => {
    const { el, panel, drafts } = setup(`<div data-dc-source="src/Card.tsx:4:7" id="t"></div>`)
    const select = strokeSection(panel).nextElementSibling!.querySelector('.stroke-style') as HTMLSelectElement
    select.value = 'dashed'
    select.dispatchEvent(new Event('change', { bubbles: true }))
    for (const side of ['top', 'right', 'bottom', 'left']) {
      expect(drafts.current(el, `border-${side}-style`)).toBe('dashed')
    }
  })

  it('expand reveals per-side width fields (border-top/right/bottom/left-width)', () => {
    const { panel } = setup(`<div data-dc-source="src/Card.tsx:4:7" id="t"></div>`)
    const btn = strokeSection(panel).querySelector('[data-expand="stroke"]') as HTMLElement
    expect(btn).toBeTruthy()
    btn.click()
    const propsList = [...panel.root.querySelectorAll('.nf')].map((n) => (n as HTMLElement).dataset.props)
    expect(propsList).toEqual(
      expect.arrayContaining(['border-top-width', 'border-right-width', 'border-bottom-width', 'border-left-width'])
    )
  })

  it('clicking the border-color swatch opens the picker with contrastAgainst set to the effective background', () => {
    const { panel } = setup(
      `<div data-dc-source="src/Card.tsx:4:7" id="t" style="background-color: rgb(30,30,30);"></div>`
    )
    const openSpy = vi.fn()
    ;(panel as unknown as { colorPicker: { open: typeof openSpy } }).colorPicker.open = openSpy
    const swatch = strokeSection(panel).nextElementSibling!.querySelector('.swatch') as HTMLElement
    swatch.click()
    expect(openSpy).toHaveBeenCalledTimes(1)
    const opts = openSpy.mock.calls[0][0]
    expect(opts.contrastAgainst).toBe('rgb(30, 30, 30)')
  })

  it('picking a border color drafts all four border-*-color longhands', () => {
    const { el, panel, drafts } = setup(`<div data-dc-source="src/Card.tsx:4:7" id="t"></div>`)
    let onPick: ((css: string, meta: { token?: string }) => void) | null = null
    ;(panel as unknown as { colorPicker: { open: (opts: any) => void } }).colorPicker.open = (opts) => {
      onPick = opts.onPick
    }
    const swatch = strokeSection(panel).nextElementSibling!.querySelector('.swatch') as HTMLElement
    swatch.click()
    onPick!('rgb(1, 2, 3)', {})
    for (const side of ['top', 'right', 'bottom', 'left']) {
      expect(drafts.current(el, `border-${side}-color`)).toBe('rgb(1, 2, 3)')
    }
  })
})

describe('Panel color rows + token-btn icon (T5)', () => {
  function fillSection(panel: Panel): HTMLElement {
    return [...panel.root.querySelectorAll('.panel-section')].find(
      (n) => n.textContent?.replace('⋯', '').trim() === 'Fill'
    ) as HTMLElement
  }

  function colorRows(panel: Panel): HTMLElement[] {
    return [...fillSection(panel).parentElement!.querySelectorAll('.color-row')].filter((row) => {
      const title = row.closest('.panel-rows')?.previousElementSibling
      return title === fillSection(panel) && !(row as HTMLElement).hidden
    }) as HTMLElement[]
  }

  function strokeSection(panel: Panel): HTMLElement {
    return [...panel.root.querySelectorAll('.panel-section')].find(
      (n) => n.textContent?.replace('⋯', '').trim() === 'Stroke'
    ) as HTMLElement
  }

  function setupColorTokens(html?: string) {
    // readTokens() caches at module scope — earlier tests in this file (or file order in a
    // full-suite run) can leave a stale no-color-tokens snapshot cached, so every setup here
    // must reset it before applying its own theme.
    resetTokensCache()
    document.head.insertAdjacentHTML(
      'beforeend',
      '<style data-test-cb-tokens>:root { --color-red-500: #ff0000; --color-blue-400: #0000ff; }</style>'
    )
    document.documentElement.style.setProperty('--color-red-500', '#ff0000')
    document.documentElement.style.setProperty('--color-blue-400', '#0000ff')
    return setup(html)
  }

  afterEach(() => {
    document.querySelectorAll('style[data-test-cb-tokens]').forEach((s) => s.remove())
    document.documentElement.removeAttribute('style')
    resetTokensCache()
  })

  it('Fill row contains a .token-btn when the theme has color tokens', () => {
    const { panel } = setupColorTokens(
      `<div data-dc-source="src/Card.tsx:4:7" id="t" style="background-color: rgb(255, 0, 0);"></div>`
    )
    const fillRow = colorRows(panel)[0]
    expect(fillRow.querySelector('.token-btn')).not.toBeNull()
  })

  it('Fill row has no .token-btn when the theme defines no color tokens', () => {
    resetTokensCache()
    const { panel } = setup(
      `<div data-dc-source="src/Card.tsx:4:7" id="t" style="background-color: rgb(255, 0, 0);"></div>`
    )
    const fillRow = colorRows(panel)[0]
    expect(fillRow.querySelector('.token-btn')).toBeNull()
  })

  it('clicking the Fill token-btn opens the token popover listing color entries with .tp-row-swatch', () => {
    const { panel } = setupColorTokens(
      `<div data-dc-source="src/Card.tsx:4:7" id="t" style="background-color: rgb(255, 0, 0);"></div>`
    )
    const fillRow = colorRows(panel)[0]
    const btn = fillRow.querySelector('.token-btn') as HTMLButtonElement
    const picker = pickerOf(panel)
    btn.click()
    expect(picker.root.hidden).toBe(false)
    const rows = [...picker.root.querySelectorAll('.tp-row')]
    expect(rows.length).toBeGreaterThan(0)
    expect(picker.root.querySelectorAll('.tp-row-swatch').length).toBeGreaterThan(0)
    expect(rows.some((r) => r.textContent?.includes('red-500'))).toBe(true)
  })

  it('picking red-500 from the Fill token-btn drafts the exact token value and shows a pilled token name', () => {
    const { el, panel, drafts } = setupColorTokens(
      `<div data-dc-source="src/Card.tsx:4:7" id="t" style="background-color: rgb(255, 255, 255);"></div>`
    )
    const fillRow = colorRows(panel)[0]
    const btn = fillRow.querySelector('.token-btn') as HTMLButtonElement
    btn.click()
    const picker = pickerOf(panel)
    const row = [...picker.root.querySelectorAll('.tp-row')].find((r) => r.textContent?.includes('red-500'))!
    ;(row as HTMLElement).click()

    expect(drafts.current(el, 'background-color')).toBe('#ff0000')
    const valueEl = fillRow.querySelector('.color-value') as HTMLElement
    expect(valueEl.textContent).toBe('red-500')
    expect(valueEl.classList.contains('color-value-pill')).toBe(true)
  })

  it('picking a raw color via the ColorPicker that matches no token shows a hex label with no pill (derived-state round trip)', () => {
    const { el, panel, drafts } = setupColorTokens(
      `<div data-dc-source="src/Card.tsx:4:7" id="t" style="background-color: rgb(255, 255, 255);"></div>`
    )
    const fillRow = colorRows(panel)[0]
    const swatch = fillRow.querySelector('.swatch') as HTMLElement
    let onPick: ((css: string, meta: { token?: string }) => void) | null = null
    ;(panel as unknown as { colorPicker: { open: (opts: any) => void } }).colorPicker.open = (opts) => {
      onPick = opts.onPick
    }
    swatch.click()
    onPick!('rgb(10, 20, 30)', {})

    expect(drafts.current(el, 'background-color')).toBe('rgb(10, 20, 30)')
    const valueEl = fillRow.querySelector('.color-value') as HTMLElement
    expect(valueEl.textContent).toBe('#0a141e')
    expect(valueEl.classList.contains('color-value-pill')).toBe(false)
  })

  it('Stroke Color row: picking a token drafts all four border-*-color longhands', () => {
    const { el, panel, drafts } = setupColorTokens(`<div data-dc-source="src/Card.tsx:4:7" id="t"></div>`)
    const strokeColorRow = strokeSection(panel).nextElementSibling!.querySelector('.color-row') as HTMLElement
    const btn = strokeColorRow.querySelector('.token-btn') as HTMLButtonElement
    expect(btn).not.toBeNull()
    btn.click()
    const picker = pickerOf(panel)
    const row = [...picker.root.querySelectorAll('.tp-row')].find((r) => r.textContent?.includes('blue-400'))!
    ;(row as HTMLElement).click()

    for (const side of ['top', 'right', 'bottom', 'left']) {
      expect(drafts.current(el, `border-${side}-color`)).toBe('#0000ff')
    }
  })

  it('request end-to-end pin: after a token pick, the built change request after-utility is the token form with no arbitrary bracket', () => {
    // suggestUtility() gates every utility suggestion (including colors) on
    // theme.spacingBasePx !== null as its Tailwind-detection heuristic — a `--spacing` custom
    // property must be present for readTheme() to report a Tailwind project.
    document.documentElement.style.setProperty('--spacing', '4px')
    const { panel, drafts } = setupColorTokens(
      `<button data-dc-source="src/Card.tsx:4:7" id="t" style="background-color: rgb(255, 255, 255);">Hi</button>`
    )
    const fillRow = colorRows(panel)[0]
    const btn = fillRow.querySelector('.token-btn') as HTMLButtonElement
    btn.click()
    const picker = pickerOf(panel)
    const row = [...picker.root.querySelectorAll('.tp-row')].find((r) => r.textContent?.includes('red-500'))!
    ;(row as HTMLElement).click()

    const req = buildChangeRequest(drafts)
    const change = req.elements[0].changes.find((c) => c.property === 'background-color')!
    expect(change.afterUtility).toBe('bg-red-500')
    expect(change.afterUtility).not.toMatch(/\[.*\]/)
  })
})

describe('Panel + TokenPicker (`=` token picker, B5)', () => {
  function setupTailwind(html?: string) {
    document.documentElement.style.setProperty('--spacing', '4px')
    document.documentElement.style.setProperty('--radius-sm', '4px')
    document.documentElement.style.setProperty('--radius-md', '6px')
    document.documentElement.style.setProperty('--radius-lg', '8px')
    return setup(html)
  }

  afterEach(() => {
    document.documentElement.removeAttribute('style')
    document.head.innerHTML = ''
    resetTokensCache()
  })

  function pxField(panel: Panel, props: string): HTMLElement {
    const nf = [...panel.root.querySelectorAll('.nf')].find((n) => (n as HTMLElement).dataset.props === props)
    if (!nf) throw new Error(`no field with data-props ${props}`)
    return nf as HTMLElement
  }

  function pressEquals(input: HTMLInputElement): KeyboardEvent {
    const ev = new KeyboardEvent('keydown', { key: '=', bubbles: true, cancelable: true })
    input.dispatchEvent(ev)
    return ev
  }

  it('`=` on a spacing field (PX) opens the token picker with the spacing scale entries', () => {
    const { panel } = setupTailwind()
    const input = pxField(panel, P.PX).querySelector('input') as HTMLInputElement
    const picker = pickerOf(panel)
    pressEquals(input)
    expect(picker.root.hidden).toBe(false)
    const rows = [...picker.root.querySelectorAll('.tp-row')]
    expect(rows.some((r) => r.textContent?.includes('4') && r.textContent?.includes('16px'))).toBe(true)
  })

  it('`=` on the Opacity field (no scale) does nothing — tokenEntriesFor is null', () => {
    const { panel } = setupTailwind()
    const input = pxField(panel, P.O).querySelector('input') as HTMLInputElement
    const picker = pickerOf(panel)
    pressEquals(input)
    expect(picker.root.hidden).toBe(true)
  })

  it('applying a spacing entry drafts px through the normal commit path and binds a full-utility pill', () => {
    const { el, panel, drafts } = setupTailwind()
    const field = pxField(panel, P.PX)
    const input = field.querySelector('input') as HTMLInputElement
    pressEquals(input)
    const picker = pickerOf(panel)
    const row = [...picker.root.querySelectorAll('.tp-row')].find((r) => r.textContent?.includes('4') && r.textContent?.includes('16px'))!
    ;(row as HTMLElement).click()

    expect(drafts.current(el, 'padding-left')).toBe('16px')
    expect(drafts.current(el, 'padding-right')).toBe('16px')
    expect(input.readOnly).toBe(true)
    expect(input.value).toBe('px-4')
    expect(field.classList.contains('nf-pill')).toBe(true)
  })

  it('applying a radius entry binds a rounded-<name> pill', () => {
    const { el, panel, drafts } = setupTailwind()
    const field = pxField(panel, P.R)
    const input = field.querySelector('input') as HTMLInputElement
    pressEquals(input)
    const picker = pickerOf(panel)
    const row = [...picker.root.querySelectorAll('.tp-row')].find((r) => r.textContent?.includes('md'))!
    ;(row as HTMLElement).click()

    const radiusProps = [
      'border-top-left-radius',
      'border-top-right-radius',
      'border-bottom-right-radius',
      'border-bottom-left-radius',
    ]
    for (const prop of radiusProps) expect(drafts.current(el, prop)).toBe('6px')
    expect(input.value).toBe('rounded-md')
  })

  it('applying a font-size entry binds a text-<name> pill', () => {
    // readTokens() only discovers a --text-* NAME by scanning stylesheet rules (not inline
    // style properties) — a real <style> declaration is required, mirroring tokens.test.ts.
    const style = document.createElement('style')
    style.textContent = `:root { --text-sm: 14px; }`
    document.head.appendChild(style)
    document.documentElement.style.setProperty('--text-sm', '14px')
    const { el, panel, drafts } = setupTailwind(`<div data-dc-source="src/Card.tsx:4:7" id="t">Some text</div>`)
    const input = fieldInput(panel, P.S)
    pressEquals(input)
    const picker = pickerOf(panel)
    const row = [...picker.root.querySelectorAll('.tp-row')].find((r) => r.textContent?.includes('sm'))!
    ;(row as HTMLElement).click()

    expect(drafts.current(el, 'font-size')).toBe('14px')
    expect(input.value).toBe('text-sm')
  })

  it('Backspace on a pill-bound field detaches: numeric display returns, draft is unchanged', () => {
    const { el, panel, drafts } = setupTailwind()
    const field = pxField(panel, P.PX)
    const input = field.querySelector('input') as HTMLInputElement
    pressEquals(input)
    const picker = pickerOf(panel)
    const row = [...picker.root.querySelectorAll('.tp-row')].find((r) => r.textContent?.includes('4') && r.textContent?.includes('16px'))!
    ;(row as HTMLElement).click()
    expect(drafts.current(el, 'padding-left')).toBe('16px')

    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Backspace', bubbles: true, cancelable: true }))

    expect(field.classList.contains('nf-pill')).toBe(false)
    expect(input.value).toBe('16')
    expect(drafts.current(el, 'padding-left')).toBe('16px') // draft unchanged
  })

  it('a bound pill survives refresh() when the draft still equals the bound px', () => {
    const { panel, onEdited } = setupTailwind()
    const field = pxField(panel, P.PX)
    const input = field.querySelector('input') as HTMLInputElement
    pressEquals(input)
    const picker = pickerOf(panel)
    const row = [...picker.root.querySelectorAll('.tp-row')].find((r) => r.textContent?.includes('4') && r.textContent?.includes('16px'))!
    ;(row as HTMLElement).click()
    expect(input.value).toBe('px-4')

    // An unrelated edit elsewhere triggers refresh(); the PX pill must survive since its
    // draft (16px) still matches the bound entry (B1's set()/setMixed() clear pills, but
    // Panel re-applies bindToken when the draft is unchanged).
    onEdited.mockClear()
    panel.refresh()
    expect(input.value).toBe('px-4')
    expect(field.classList.contains('nf-pill')).toBe(true)
  })

  it('a bound pill is cleared when the draft value diverges from the bound px', () => {
    const { el, panel, drafts } = setupTailwind()
    const field = pxField(panel, P.PX)
    const input = field.querySelector('input') as HTMLInputElement
    pressEquals(input)
    const picker = pickerOf(panel)
    const row = [...picker.root.querySelectorAll('.tp-row')].find((r) => r.textContent?.includes('4') && r.textContent?.includes('16px'))!
    ;(row as HTMLElement).click()
    expect(input.value).toBe('px-4')

    drafts.apply(el, 'padding-left', '20px')
    drafts.apply(el, 'padding-right', '20px')
    panel.refresh()

    expect(field.classList.contains('nf-pill')).toBe(false)
    expect(input.value).toBe('20')
  })

  it('a bound pill on a sizeMode (W/H) field is dropped once the field switches to auto (Hug) display', () => {
    // A pill bound while W is Fixed must not silently resurrect if the user switches to Hug
    // and back to the exact same px later — refresh()'s early `setAuto()` continue must clear
    // the bookkeeping too, not just the visible pill state.
    const { el, panel, drafts } = setupTailwind()
    const field = pxField(panel, P.W)
    const input = field.querySelector('input') as HTMLInputElement
    pressEquals(input)
    const picker = pickerOf(panel)
    const row = [...picker.root.querySelectorAll('.tp-row')].find((r) => r.textContent?.includes('4') && r.textContent?.includes('16px'))!
    ;(row as HTMLElement).click()
    expect(input.value).toBe('w-4')

    drafts.apply(el, 'width', 'auto')
    panel.refresh()
    expect(input.value).toBe('auto')

    drafts.apply(el, 'width', '16px')
    panel.refresh()
    expect(field.classList.contains('nf-pill')).toBe(false)
    expect(input.value).toBe('16')
  })

  it('a bound pill is cleared on selection change (show() with a new element)', () => {
    const { panel } = setupTailwind()
    const field = pxField(panel, P.PX)
    const input = field.querySelector('input') as HTMLInputElement
    pressEquals(input)
    const picker = pickerOf(panel)
    const row = [...picker.root.querySelectorAll('.tp-row')].find((r) => r.textContent?.includes('4') && r.textContent?.includes('16px'))!
    ;(row as HTMLElement).click()
    expect(input.value).toBe('px-4')

    const el2 = document.createElement('div')
    el2.id = 't2'
    el2.dataset.dcSource = 'src/Card.tsx:5:7'
    el2.style.padding = '8px'
    document.body.appendChild(el2)
    panel.show(el2, buildInspectorData(el2))

    const field2 = pxField(panel, P.PX)
    expect(field2.classList.contains('nf-pill')).toBe(false)
  })

  it('show() closes any open token picker from a previous selection', () => {
    const { panel } = setupTailwind()
    const input = pxField(panel, P.PX).querySelector('input') as HTMLInputElement
    pressEquals(input)
    const picker = pickerOf(panel)
    expect(picker.root.hidden).toBe(false)

    const el2 = document.createElement('div')
    el2.id = 't2'
    el2.dataset.dcSource = 'src/Card.tsx:5:7'
    document.body.appendChild(el2)
    panel.show(el2, buildInspectorData(el2))
    expect(picker.root.hidden).toBe(true)
  })

  it('hide() closes any open token picker', () => {
    const { panel } = setupTailwind()
    const input = pxField(panel, P.PX).querySelector('input') as HTMLInputElement
    pressEquals(input)
    const picker = pickerOf(panel)
    expect(picker.root.hidden).toBe(false)
    panel.hide()
    expect(picker.root.hidden).toBe(true)
  })

  it('single-corner radius rows (TL/TR/BR/BL) bind an honest rounded-<side>-<name> pill, not rounded-<name>', () => {
    const { el, panel, drafts } = setupTailwind()
    const btn = panel.root.querySelectorAll('[data-expand]')
    // expand the Appearance section's radius group to reveal TL/TR/BR/BL
    const radiusBtn = [...btn].find((b) => b.getAttribute('data-expand') === 'radius') as HTMLElement
    radiusBtn.click()

    const field = pxField(panel, P.TL)
    const input = field.querySelector('input') as HTMLInputElement
    pressEquals(input)
    const picker = pickerOf(panel)
    const row = [...picker.root.querySelectorAll('.tp-row')].find((r) => r.textContent?.includes('md'))!
    ;(row as HTMLElement).click()

    expect(drafts.current(el, 'border-top-left-radius')).toBe('6px')
    // The OTHER three corners must NOT be touched by a single-corner row.
    expect(drafts.current(el, 'border-top-right-radius')).toBeNull()
    expect(input.value).toBe('rounded-tl-md')
  })

  it('the linked R row (all 4 corners) still binds the collapsed rounded-<name> pill', () => {
    // Pins the R row's behavior alongside the TL row fix above so the two can't regress
    // into each other (R must stay collapsed, TL must stay per-side).
    const { panel } = setupTailwind()
    const field = pxField(panel, P.R)
    const input = field.querySelector('input') as HTMLInputElement
    pressEquals(input)
    const picker = pickerOf(panel)
    const row = [...picker.root.querySelectorAll('.tp-row')].find((r) => r.textContent?.includes('md'))!
    ;(row as HTMLElement).click()
    expect(input.value).toBe('rounded-md')
  })

  it('radiusScale {} (non-Tailwind project) makes `=` on a radius field a no-op', () => {
    // Fix for B5 minor #5: tokenEntriesFor must return null (not []) for an empty scale so
    // openScaleTokenPicker's entries guard (`if (!entries) return`) actually fires.
    document.documentElement.style.removeProperty('--radius-sm')
    document.documentElement.style.removeProperty('--radius-md')
    document.documentElement.style.removeProperty('--radius-lg')
    resetTokensCache()
    const { panel } = setup()
    const input = pxField(panel, P.R).querySelector('input') as HTMLInputElement
    const picker = pickerOf(panel)
    pressEquals(input)
    expect(picker.root.hidden).toBe(true)
  })

  it('un-Compare restores a bound pill (Compare must not permanently destroy pill bookkeeping)', () => {
    const { el, panel, drafts } = setupTailwind()
    const field = pxField(panel, P.PX)
    const input = field.querySelector('input') as HTMLInputElement
    pressEquals(input)
    const picker = pickerOf(panel)
    const row = [...picker.root.querySelectorAll('.tp-row')].find((r) => r.textContent?.includes('4') && r.textContent?.includes('16px'))!
    ;(row as HTMLElement).click()
    expect(input.value).toBe('px-4')

    // Enter Compare: the field must show the ORIGINAL (pre-draft) value with NO pill —
    // a pill during Compare would lie about what's actually drafted.
    drafts.compare(el, true)
    panel.refresh()
    expect(field.classList.contains('nf-pill')).toBe(false)

    // Leave Compare: the bound entry must have survived the round-trip so the pill returns.
    drafts.compare(el, false)
    panel.refresh()
    expect(field.classList.contains('nf-pill')).toBe(true)
    expect(input.value).toBe('px-4')
  })

  it('Reset clears pill bookkeeping wholesale, even for a coincidentally-equal original value', () => {
    // Fix for B5 minor #4: an author-authored inline value that happens to equal the bound
    // px must NOT resurrect a pill after Reset discards the draft entirely.
    const { el, panel, drafts } = setupTailwind(
      `<div data-dc-source="src/Card.tsx:4:7" id="t" style="padding-left: 16px; padding-right: 16px; width: 200px;"></div>`
    )
    const field = pxField(panel, P.PX)
    const input = field.querySelector('input') as HTMLInputElement
    pressEquals(input)
    const picker = pickerOf(panel)
    const row = [...picker.root.querySelectorAll('.tp-row')].find((r) => r.textContent?.includes('4') && r.textContent?.includes('16px'))!
    ;(row as HTMLElement).click()
    expect(input.value).toBe('px-4')

    panel.resetButton.click()
    expect(drafts.hasDrafts(el)).toBe(false)
    // Original inline value (16px) coincidentally equals the bound px — without the fix,
    // refresh()'s per-field re-check would see values[0] === bound.px and resurrect the pill.
    expect(field.classList.contains('nf-pill')).toBe(false)
    expect(input.value).toBe('16')
  })
})

describe('Panel Gap field + TokenPicker (B5 important #1)', () => {
  function setupTailwindFlex(styleExtra = '') {
    document.documentElement.style.setProperty('--spacing', '4px')
    document.documentElement.style.setProperty('--radius-sm', '4px')
    document.documentElement.style.setProperty('--radius-md', '6px')
    document.documentElement.style.setProperty('--radius-lg', '8px')
    return setup(
      `<div data-dc-source="src/Card.tsx:4:7" id="t" style="display: flex; width: 200px; height: 100px; ${styleExtra}"></div>`
    )
  }

  afterEach(() => {
    document.documentElement.removeAttribute('style')
    document.head.innerHTML = ''
    resetTokensCache()
  })

  function gapInput(panel: Panel): HTMLInputElement {
    return fieldInput(panel, P.GAP)
  }

  function pressEquals(input: HTMLInputElement): KeyboardEvent {
    const ev = new KeyboardEvent('keydown', { key: '=', bubbles: true, cancelable: true })
    input.dispatchEvent(ev)
    return ev
  }

  it('`=` on the Gap field opens the token picker with the spacing scale entries', () => {
    const { panel } = setupTailwindFlex()
    const input = gapInput(panel)
    const picker = pickerOf(panel)
    pressEquals(input)
    expect(picker.root.hidden).toBe(false)
    const rows = [...picker.root.querySelectorAll('.tp-row')]
    expect(rows.some((r) => r.textContent?.includes('4') && r.textContent?.includes('16px'))).toBe(true)
  })

  it('applying a spacing entry to Gap drafts gap:Npx and binds a gap-<n> pill', () => {
    const { el, panel, drafts } = setupTailwindFlex()
    const input = gapInput(panel)
    pressEquals(input)
    const picker = pickerOf(panel)
    const row = [...picker.root.querySelectorAll('.tp-row')].find((r) => r.textContent?.includes('4') && r.textContent?.includes('16px'))!
    ;(row as HTMLElement).click()

    expect(drafts.current(el, 'gap')).toBe('16px')
    expect(input.readOnly).toBe(true)
    expect(input.value).toBe('gap-4')
  })

  it('a bound Gap pill survives an unrelated refresh() when the draft still equals the bound px', () => {
    const { panel } = setupTailwindFlex()
    const input = gapInput(panel)
    pressEquals(input)
    const picker = pickerOf(panel)
    const row = [...picker.root.querySelectorAll('.tp-row')].find((r) => r.textContent?.includes('4') && r.textContent?.includes('16px'))!
    ;(row as HTMLElement).click()
    expect(input.value).toBe('gap-4')

    panel.refresh()
    expect(input.value).toBe('gap-4')
  })

  it('a bound Gap pill is cleared when the draft value diverges from the bound px', () => {
    const { el, panel, drafts } = setupTailwindFlex()
    const input = gapInput(panel)
    pressEquals(input)
    const picker = pickerOf(panel)
    const row = [...picker.root.querySelectorAll('.tp-row')].find((r) => r.textContent?.includes('4') && r.textContent?.includes('16px'))!
    ;(row as HTMLElement).click()
    expect(input.value).toBe('gap-4')

    drafts.apply(el, 'gap', '20px')
    panel.refresh()
    expect(input.value).toBe('20')
  })

  it('switching Gap to Auto (space-between) clears a bound pill — setAuto path must not resurrect it later', () => {
    const { el, panel, drafts } = setupTailwindFlex()
    const input = gapInput(panel)
    pressEquals(input)
    const picker = pickerOf(panel)
    const row = [...picker.root.querySelectorAll('.tp-row')].find((r) => r.textContent?.includes('4') && r.textContent?.includes('16px'))!
    ;(row as HTMLElement).click()
    expect(input.value).toBe('gap-4')

    commit(input, 'auto')
    expect(drafts.current(el, 'justify-content')).toBe('space-between')
    expect(input.value).toBe('auto')

    // Switch back off space-between with the SAME 16px — must show a plain number, not a
    // resurrected pill, since the Auto detour must have cleared the bookkeeping.
    drafts.discard(el, ['justify-content'])
    drafts.apply(el, 'gap', '16px')
    panel.refresh()
    expect(input.value).toBe('16')
  })

  it('Backspace on a Gap pill detaches: numeric display returns, draft is unchanged', () => {
    const { el, panel, drafts } = setupTailwindFlex()
    const input = gapInput(panel)
    pressEquals(input)
    const picker = pickerOf(panel)
    const row = [...picker.root.querySelectorAll('.tp-row')].find((r) => r.textContent?.includes('4') && r.textContent?.includes('16px'))!
    ;(row as HTMLElement).click()
    expect(drafts.current(el, 'gap')).toBe('16px')

    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Backspace', bubbles: true, cancelable: true }))
    expect(input.readOnly).toBe(false)
    expect(input.value).toBe('16')
    expect(drafts.current(el, 'gap')).toBe('16px')
  })
})

describe('Panel + token-btn icon (T4)', () => {
  function setupTailwind(html?: string) {
    document.documentElement.style.setProperty('--spacing', '4px')
    document.documentElement.style.setProperty('--radius-sm', '4px')
    document.documentElement.style.setProperty('--radius-md', '6px')
    document.documentElement.style.setProperty('--radius-lg', '8px')
    return setup(html)
  }

  function setupTailwindFlex(styleExtra = '') {
    document.documentElement.style.setProperty('--spacing', '4px')
    document.documentElement.style.setProperty('--radius-sm', '4px')
    document.documentElement.style.setProperty('--radius-md', '6px')
    document.documentElement.style.setProperty('--radius-lg', '8px')
    return setup(
      `<div data-dc-source="src/Card.tsx:4:7" id="t" style="display: flex; width: 200px; height: 100px; ${styleExtra}"></div>`
    )
  }

  afterEach(() => {
    document.documentElement.removeAttribute('style')
    document.head.innerHTML = ''
    resetTokensCache()
  })

  function pxField(panel: Panel, props: string): HTMLElement {
    const nf = [...panel.root.querySelectorAll('.nf')].find((n) => (n as HTMLElement).dataset.props === props)
    if (!nf) throw new Error(`no field with data-props ${props}`)
    return nf as HTMLElement
  }

  it('PX field root contains a .token-btn; Opacity (O) and Stroke width (W) do not', () => {
    const { panel } = setupTailwind()
    expect(pxField(panel, P.PX).querySelector('.token-btn')).not.toBeNull()
    expect(pxField(panel, P.O).querySelector('.token-btn')).toBeNull()
    // Size's Width and Stroke's border-width used to share the display label 'W' — data-props
    // disambiguates them directly now, no section-scoping needed.
    const strokeWidth = pxField(panel, P.STROKE_W)
    expect(strokeWidth.querySelector('.token-btn')).toBeNull()
  })

  it('clicking PX\'s .token-btn opens the token popover with spacing entries', () => {
    const { panel } = setupTailwind()
    const field = pxField(panel, P.PX)
    const btn = field.querySelector('.token-btn') as HTMLButtonElement
    const picker = pickerOf(panel)
    btn.click()
    expect(picker.root.hidden).toBe(false)
    const rows = [...picker.root.querySelectorAll('.tp-row')]
    expect(rows.some((r) => r.textContent?.includes('4') && r.textContent?.includes('16px'))).toBe(true)
  })

  it('picking an entry via the icon applies the draft and binds a pill (same end state as `=`)', () => {
    const { el, panel, drafts } = setupTailwind()
    const field = pxField(panel, P.PX)
    const btn = field.querySelector('.token-btn') as HTMLButtonElement
    const input = field.querySelector('input') as HTMLInputElement
    btn.click()
    const picker = pickerOf(panel)
    const row = [...picker.root.querySelectorAll('.tp-row')].find((r) => r.textContent?.includes('4') && r.textContent?.includes('16px'))!
    ;(row as HTMLElement).click()

    expect(drafts.current(el, 'padding-left')).toBe('16px')
    expect(drafts.current(el, 'padding-right')).toBe('16px')
    expect(input.readOnly).toBe(true)
    expect(input.value).toBe('px-4')
    expect(field.classList.contains('nf-pill')).toBe(true)

    panel.refresh()
    expect(input.value).toBe('px-4')
  })

  it('with a pill already bound, clicking the icon re-opens the picker and swaps the pill on a new pick', () => {
    const { el, panel, drafts } = setupTailwind()
    const field = pxField(panel, P.PX)
    const btn = field.querySelector('.token-btn') as HTMLButtonElement
    const input = field.querySelector('input') as HTMLInputElement
    const picker = pickerOf(panel)

    btn.click()
    const row4 = [...picker.root.querySelectorAll('.tp-row')].find((r) => r.textContent?.includes('4') && r.textContent?.includes('16px'))!
    ;(row4 as HTMLElement).click()
    expect(input.value).toBe('px-4')

    // Icon click fires even while pill-bound (unlike the `=` key, which is gated off once bound).
    btn.click()
    expect(picker.root.hidden).toBe(false)
    const row8 = [...picker.root.querySelectorAll('.tp-row')].find((r) => r.textContent?.includes('8') && r.textContent?.includes('32px'))
    expect(row8).toBeDefined()
    ;(row8 as HTMLElement).click()

    expect(drafts.current(el, 'padding-left')).toBe('32px')
    expect(input.value).toBe('px-8')
    expect(field.classList.contains('nf-pill')).toBe(true)
  })

  it('multi-select: no .token-btn rendered on any field', () => {
    // Theme must define BOTH numeric and color tokens so this assertion holds for the real
    // reason (every token-backed row's own multi gate), not merely because the Fill/Stroke
    // sections happen to be hidden in multi-select (see buildColorRow's `!this.isMulti()` gate).
    resetTokensCache()
    document.documentElement.style.setProperty('--spacing', '4px')
    document.documentElement.style.setProperty('--color-red-500', '#ff0000')
    document.documentElement.style.setProperty('--color-blue-400', '#0000ff')
    document.head.insertAdjacentHTML(
      'beforeend',
      '<style data-test-cb-tokens>:root { --color-red-500: #ff0000; --color-blue-400: #0000ff; }</style>'
    )
    document.body.innerHTML = `
      <div data-dc-source="src/A.tsx:1:1" id="a" style="padding: 10px; width: 100px; background-color: rgb(255, 0, 0);"></div>
      <div data-dc-source="src/B.tsx:2:2" id="b" style="padding: 20px; width: 100px; background-color: rgb(0, 0, 255);"></div>
    `
    const a = document.getElementById('a')! as HTMLElement
    const b = document.getElementById('b')! as HTMLElement
    const drafts = new DraftStore()
    const panel = new Panel(drafts, vi.fn())
    document.body.appendChild(panel.root)
    panel.show([a, b], buildInspectorData(a))

    expect(panel.root.querySelector('.token-btn')).toBeNull()

    document.querySelectorAll('style[data-test-cb-tokens]').forEach((s) => s.remove())
    document.documentElement.removeAttribute('style')
    resetTokensCache()
  })

  it('gap field (flex element) has a .token-btn with the same open/apply flow', () => {
    const { el, panel, drafts } = setupTailwindFlex()
    const gapField = (panel as unknown as { gapField: { root: HTMLElement } }).gapField
    const btn = gapField.root.querySelector('.token-btn') as HTMLButtonElement
    const input = gapField.root.querySelector('input') as HTMLInputElement
    expect(btn).not.toBeNull()
    const picker = pickerOf(panel)

    btn.click()
    expect(picker.root.hidden).toBe(false)
    const row = [...picker.root.querySelectorAll('.tp-row')].find((r) => r.textContent?.includes('4') && r.textContent?.includes('16px'))!
    ;(row as HTMLElement).click()

    expect(drafts.current(el, 'gap')).toBe('16px')
    expect(input.readOnly).toBe(true)
    expect(input.value).toBe('gap-4')
  })
})

describe('Panel + ColorPicker lifecycle', () => {
  it('show() closes any open color picker from a previous selection', () => {
    const { panel } = setup(`<div data-dc-source="src/Card.tsx:4:7" id="t"></div>`)
    const swatch = panel.root.querySelector('.color-row .swatch') as HTMLElement
    swatch.click()
    const picker = (panel as unknown as { colorPicker: { root: HTMLElement } }).colorPicker
    expect(picker.root.hidden).toBe(false)

    const el2 = document.createElement('div')
    el2.id = 't2'
    el2.dataset.dcSource = 'src/Card.tsx:5:7'
    document.body.appendChild(el2)
    panel.show(el2, buildInspectorData(el2))
    expect(picker.root.hidden).toBe(true)
  })

  it('hide() closes any open color picker', () => {
    const { panel } = setup(`<div data-dc-source="src/Card.tsx:4:7" id="t"></div>`)
    const swatch = panel.root.querySelector('.color-row .swatch') as HTMLElement
    swatch.click()
    const picker = (panel as unknown as { colorPicker: { root: HTMLElement } }).colorPicker
    expect(picker.root.hidden).toBe(false)
    panel.hide()
    expect(picker.root.hidden).toBe(true)
  })

  it('opening the token picker (`=`) closes an already-open color picker (final review fix #11)', () => {
    document.documentElement.style.setProperty('--spacing', '4px')
    try {
      const { panel } = setup(`<div data-dc-source="src/Card.tsx:4:7" id="t" style="padding: 8px;"></div>`)
      const swatch = panel.root.querySelector('.color-row .swatch') as HTMLElement
      swatch.click()
      const colorPicker = (panel as unknown as { colorPicker: { root: HTMLElement } }).colorPicker
      expect(colorPicker.root.hidden).toBe(false)

      const input = fieldInput(panel, P.PX)
      input.dispatchEvent(new KeyboardEvent('keydown', { key: '=', bubbles: true, cancelable: true }))
      const tokenPicker = pickerOf(panel)
      expect(tokenPicker.root.hidden).toBe(false)
      expect(colorPicker.root.hidden).toBe(true)
    } finally {
      document.documentElement.removeAttribute('style')
      resetTokensCache()
    }
  })

  it('opening the color picker closes an already-open token picker (final review fix #11)', () => {
    document.documentElement.style.setProperty('--spacing', '4px')
    try {
      const { panel } = setup(`<div data-dc-source="src/Card.tsx:4:7" id="t" style="padding: 8px;"></div>`)
      const input = fieldInput(panel, P.PX)
      input.dispatchEvent(new KeyboardEvent('keydown', { key: '=', bubbles: true, cancelable: true }))
      const tokenPicker = pickerOf(panel)
      expect(tokenPicker.root.hidden).toBe(false)

      const swatch = panel.root.querySelector('.color-row .swatch') as HTMLElement
      swatch.click()
      const colorPicker = (panel as unknown as { colorPicker: { root: HTMLElement } }).colorPicker
      expect(colorPicker.root.hidden).toBe(false)
      expect(tokenPicker.root.hidden).toBe(true)
    } finally {
      document.documentElement.removeAttribute('style')
      resetTokensCache()
    }
  })
})

describe('Panel multi-select: `=` token picker is gated off (final review fix #6)', () => {
  function multiSetupTailwind(htmlA?: string, htmlB?: string) {
    document.documentElement.style.setProperty('--spacing', '4px')
    return {
      ...(() => {
        document.body.innerHTML = `
          <div data-dc-source="src/A.tsx:1:1" id="a" style="${htmlA ?? 'padding: 10px; width: 100px;'}"></div>
          <div data-dc-source="src/B.tsx:2:2" id="b" style="${htmlB ?? 'padding: 20px; width: 100px;'}"></div>
        `
        const a = document.getElementById('a')! as HTMLElement
        const b = document.getElementById('b')! as HTMLElement
        const drafts = new DraftStore()
        const panel = new Panel(drafts, vi.fn())
        document.body.appendChild(panel.root)
        panel.show([a, b], buildInspectorData(a))
        return { a, b, drafts, panel }
      })(),
    }
  }

  afterEach(() => {
    document.documentElement.removeAttribute('style')
    resetTokensCache()
  })

  it('`=` on a regular field (PX) in multi-select does not open the token picker', () => {
    const { panel } = multiSetupTailwind()
    const input = fieldInput(panel, P.PX)
    const picker = pickerOf(panel)
    input.dispatchEvent(new KeyboardEvent('keydown', { key: '=', bubbles: true, cancelable: true }))
    expect(picker.root.hidden).toBe(true)
  })

  it('`=` on a regular field in multi-select produces no pill and no boundTokens entry', () => {
    const { panel } = multiSetupTailwind()
    const field = fieldInput(panel, P.PX).closest('.nf') as HTMLElement
    const input = fieldInput(panel, P.PX)
    input.dispatchEvent(new KeyboardEvent('keydown', { key: '=', bubbles: true, cancelable: true }))
    expect(field.classList.contains('nf-pill')).toBe(false)
    const boundTokens = (panel as unknown as { tokenUi: { bound: Map<string, unknown> } }).tokenUi.bound
    expect(boundTokens.size).toBe(0)
  })

  it('`=` on the Gap field in multi-select does not open the token picker', () => {
    // Gap only renders inside the Layout section, which is single-select only (B6) — so
    // build a single-then-multi scenario isn't representative; instead verify directly that
    // gapField's `=` path is gated the same way by checking multi-select hides Layout
    // entirely (already covered elsewhere) AND that show()-ing multi never wires an active
    // gap onTokenOpen that could fire. Exercised via the private gapField reference.
    const { panel } = multiSetupTailwind('display: flex; gap: 8px;', 'display: flex; gap: 16px;')
    const picker = pickerOf(panel)
    const gapField = (panel as unknown as { gapField: { root: HTMLElement } | null }).gapField
    // Layout (and therefore Gap) is hidden entirely in multi-select — but defensively confirm
    // that even if reached, `=` cannot open the picker.
    if (gapField) {
      const input = gapField.root.querySelector('input') as HTMLInputElement
      input.dispatchEvent(new KeyboardEvent('keydown', { key: '=', bubbles: true, cancelable: true }))
    }
    expect(picker.root.hidden).toBe(true)
  })
})

describe('Panel multi-select (B6)', () => {
  function multiSetup(htmlA?: string, htmlB?: string) {
    document.body.innerHTML = `
      <div data-dc-source="src/A.tsx:1:1" id="a" style="${htmlA ?? 'padding: 10px; width: 100px;'}"></div>
      <div data-dc-source="src/B.tsx:2:2" id="b" style="${htmlB ?? 'padding: 20px; width: 100px;'}"></div>
    `
    const a = document.getElementById('a')! as HTMLElement
    const b = document.getElementById('b')! as HTMLElement
    const drafts = new DraftStore()
    const onEdited = vi.fn()
    const panel = new Panel(drafts, onEdited)
    document.body.appendChild(panel.root)
    panel.show([a, b], buildInspectorData(a))
    return { a, b, drafts, panel, onEdited }
  }

  it('header shows "N selected" and hides the source line', () => {
    const { panel } = multiSetup()
    const tagEl = panel.root.querySelector('.panel-head-tag') as HTMLElement
    const srcEl = panel.root.querySelector('.panel-head-src') as HTMLElement | null
    expect(tagEl.textContent).toBe('2 selected')
    expect(srcEl).toBeFalsy()
  })

  it('a field with equal values across the selection shows that value', () => {
    const { panel } = multiSetup('width: 100px;', 'width: 100px;')
    expect(fieldInput(panel, P.W).value).toBe('100')
  })

  it('a field with divergent values across the selection shows Mixed', () => {
    const { panel } = multiSetup('padding: 10px;', 'padding: 20px;')
    expect(fieldInput(panel, P.PX).value).toBe('Mixed')
  })

  it('a plain typed number applies the same absolute css to every element', () => {
    const { a, b, panel, drafts } = multiSetup()
    commit(fieldInput(panel, P.W), '250')
    expect(drafts.current(a, 'width')).toBe('250px')
    expect(drafts.current(b, 'width')).toBe('250px')
  })

  it('a relative delta (+8) applies per-element against each own current value', () => {
    const { a, b, panel, drafts } = multiSetup('width: 10px;', 'width: 20px;')
    commit(fieldInput(panel, P.W), '+8')
    expect(drafts.current(a, 'width')).toBe('18px')
    expect(drafts.current(b, 'width')).toBe('28px')
  })

  it('a relative multiply (*2) applies per-element too', () => {
    const { a, b, panel, drafts } = multiSetup('width: 10px;', 'width: 20px;')
    commit(fieldInput(panel, P.W), '*2')
    expect(drafts.current(a, 'width')).toBe('20px')
    expect(drafts.current(b, 'width')).toBe('40px')
  })

  it('scrub: onScrubStart snapshots per-element baselines; subsequent onRelative calls replace, not accumulate', () => {
    const { a, b, panel, drafts } = multiSetup('width: 10px;', 'width: 20px;')
    const input = fieldInput(panel, P.W)
    const label = input.closest('.nf')!.querySelector('.nf-label') as HTMLElement
    label.dispatchEvent(new MouseEvent('mousedown', { clientX: 0 }))
    window.dispatchEvent(new MouseEvent('mousemove', { clientX: 5 }))
    expect(drafts.current(a, 'width')).toBe('15px')
    expect(drafts.current(b, 'width')).toBe('25px')
    // second move REPLACES the first against the SAME baseline (10/20), not 15/25
    window.dispatchEvent(new MouseEvent('mousemove', { clientX: 12 }))
    expect(drafts.current(a, 'width')).toBe('22px')
    expect(drafts.current(b, 'width')).toBe('32px')
    window.dispatchEvent(new MouseEvent('mouseup'))
  })

  it('Compare acts on every element in the selection', () => {
    const { a, b, panel, drafts } = multiSetup()
    commit(fieldInput(panel, P.W), '250')
    panel.compareButton.click()
    expect(drafts.isComparing(a)).toBe(true)
    expect(drafts.isComparing(b)).toBe(true)
  })

  it('Reset acts on every element in the selection', () => {
    const { a, b, panel, drafts } = multiSetup()
    commit(fieldInput(panel, P.W), '250')
    panel.resetButton.click()
    expect(drafts.hasDrafts(a)).toBe(false)
    expect(drafts.hasDrafts(b)).toBe(false)
  })

  it('multi-select: Layout section stays visible with rows; cluster and remove hidden (M-C)', () => {
    const { panel } = multiSetup()
    const layoutTitle = [...panel.root.querySelectorAll('.panel-section')].find((n) => n.textContent?.startsWith('Layout'))!
    // Unlike Fill/Stroke (fully hidden in multi), Layout's W/H and padding rows keep the
    // B6 relative-delta behavior across a selection — only the cluster/add/remove hide.
    expect((layoutTitle as HTMLElement).hidden).toBe(false)
    expect((panel.root.querySelector('.layout-controls') as HTMLElement).hidden).toBe(true)
    expect((panel.root.querySelector('[data-add-layout]') as HTMLElement).hidden).toBe(true)
    expect((panel.root.querySelector('[data-remove-layout]') as HTMLElement).hidden).toBe(true)
    expect(fieldInput(panel, P.W)).toBeTruthy() // W row alive in multi
    expect(fieldInput(panel, P.PX)).toBeTruthy() // padding row alive in multi
  })

  it('Layout section BODY (not just the title) stays visible in multi-select — it holds the live W/H/padding rows (M-C)', () => {
    const { panel } = multiSetup()
    const layoutTitle = [...panel.root.querySelectorAll('.panel-section')].find((n) => n.textContent?.startsWith('Layout'))!
    // Layout's unified body (.layout-section wrap, holding size rows, the cluster, and
    // padding rows) is the very next sibling after the title.
    const bodyWrap = layoutTitle.nextElementSibling as HTMLElement
    expect(bodyWrap.classList.contains('layout-section')).toBe(true)
    expect(bodyWrap.hidden).toBe(false)
  })

  it('size-mode selects are hidden in multi-select', () => {
    const { panel } = multiSetup()
    const selects = [...panel.root.querySelectorAll('.size-row .size-mode')] as HTMLElement[]
    expect(selects.length).toBeGreaterThan(0)
    expect(selects.every((s) => s.hidden)).toBe(true)
  })

  it('flex-child controls (.flex-child-controls) are hidden in multi-select', () => {
    const { panel } = multiSetup()
    const wrap = panel.root.querySelector('.flex-child-controls') as HTMLElement
    expect(wrap.hidden).toBe(true)
  })

  it('multi-select with a flex FIRST element still hides the cluster (early-return precedes any flex read)', () => {
    const { panel } = multiSetup('display: flex; width: 100px;', 'width: 100px;')
    expect((panel.root.querySelector('.layout-controls') as HTMLElement).hidden).toBe(true)
    expect((panel.root.querySelector('[data-add-layout]') as HTMLElement).hidden).toBe(true)
    expect((panel.root.querySelector('[data-remove-layout]') as HTMLElement).hidden).toBe(true)
  })

  it('single-element show() remains unaffected: Layout visibility follows single-el rules', () => {
    document.body.innerHTML = `<div data-dc-source="src/Card.tsx:4:7" id="t" style="width: 200px;"></div>`
    const el = document.getElementById('t')! as HTMLElement
    const drafts = new DraftStore()
    const panel = new Panel(drafts, vi.fn())
    document.body.appendChild(panel.root)
    panel.show(el, buildInspectorData(el))
    const layoutTitle = [...panel.root.querySelectorAll('.panel-section')].find((n) => n.textContent?.startsWith('Layout'))!
    expect((layoutTitle as HTMLElement).hidden).toBe(false)
  })
})

describe('Margin section disclosure', () => {
  function marginSection(panel: Panel): HTMLElement {
    // Margin's title row parents the expand button, so textContent includes the '⋯'
    // glyph — strip it before comparing the leading label text.
    return [...panel.root.querySelectorAll('.panel-section')].find(
      (n) => n.textContent?.replace('⋯', '').trim() === 'Margin'
    ) as HTMLElement
  }

  it('is hidden for a margin-less element', () => {
    const { panel } = setup(`<div data-dc-source="src/Card.tsx:4:7" id="t" style="padding: 8px; width: 200px;"></div>`)
    const title = marginSection(panel)
    const body = title.nextElementSibling as HTMLElement
    expect(title.hidden).toBe(true)
    expect(body.hidden).toBe(true)
  })

  it('is shown when the element has margins', () => {
    const { panel } = setup(`<div data-dc-source="src/Card.tsx:4:7" id="t" style="margin-top: 12px;"></div>`)
    const title = marginSection(panel)
    const body = title.nextElementSibling as HTMLElement
    expect(title.hidden).toBe(false)
    expect(body.hidden).toBe(false)
  })

  it('stays shown while a margin draft exists after editing to 0', () => {
    const { panel } = setup(`<div data-dc-source="src/Card.tsx:4:7" id="t" style="margin-top: 12px; margin-bottom: 12px;"></div>`)
    const title = marginSection(panel)
    expect(title.hidden).toBe(false)
    commit(fieldInput(panel, P.MY), '0')
    expect(title.hidden).toBe(false)
  })

  it('multi-select: shown when ANY selected element has margins', () => {
    document.body.innerHTML = `
      <div data-dc-source="src/A.tsx:1:1" id="a" style="margin-top: 12px;"></div>
      <div data-dc-source="src/B.tsx:2:2" id="b"></div>
    `
    const a = document.getElementById('a')! as HTMLElement
    const b = document.getElementById('b')! as HTMLElement
    const drafts = new DraftStore()
    const panel = new Panel(drafts, vi.fn())
    document.body.appendChild(panel.root)
    panel.show([a, b], buildInspectorData(a))
    const title = marginSection(panel)
    expect(title.hidden).toBe(false)
  })
})

describe('Panel multi-select Typography (B6)', () => {
  function multiSetup(styleA: string, styleB: string) {
    document.body.innerHTML = `
      <div data-dc-source="src/A.tsx:1:1" id="a" style="${styleA}">Hello</div>
      <div data-dc-source="src/B.tsx:2:2" id="b" style="${styleB}">World</div>
    `
    const a = document.getElementById('a')! as HTMLElement
    const b = document.getElementById('b')! as HTMLElement
    const drafts = new DraftStore()
    const panel = new Panel(drafts, vi.fn())
    document.body.appendChild(panel.root)
    panel.show([a, b], buildInspectorData(a))
    return { a, b, drafts, panel }
  }

  it('shows only S/LH/LS number fields; family/weight/align selects are hidden', () => {
    const { panel } = multiSetup('font-size: 16px;', 'font-size: 16px;')
    expect(panel.root.querySelector('.type-family')).toBeFalsy()
    expect(panel.root.querySelector('.type-weight')).toBeFalsy()
    expect(panel.root.querySelector('[data-text-align]')).toBeFalsy()
    expect(fieldInput(panel, P.S)).toBeTruthy()
    expect(fieldInput(panel, P.LH)).toBeTruthy()
    expect(fieldInput(panel, P.LS)).toBeTruthy()
  })

  it('font-size is Mixed-capable: divergent sizes across selection show Mixed', () => {
    const { panel } = multiSetup('font-size: 16px;', 'font-size: 24px;')
    expect(fieldInput(panel, P.S).value).toBe('Mixed')
  })
})

describe('Panel multi-select: Fill/Stroke replaced by Selection colors (B6)', () => {
  // hasText defaults true (kept for existing tests that exercise `color` usage aggregation,
  // which per final-review fix #8 is only counted when the element has direct text).
  function multiSetup(styleA: string, styleB: string, hasText = true) {
    const textA = hasText ? 'Hello' : ''
    const textB = hasText ? 'World' : ''
    document.body.innerHTML = `
      <div data-dc-source="src/A.tsx:1:1" id="a" style="${styleA}">${textA}</div>
      <div data-dc-source="src/B.tsx:2:2" id="b" style="${styleB}">${textB}</div>
    `
    const a = document.getElementById('a')! as HTMLElement
    const b = document.getElementById('b')! as HTMLElement
    const drafts = new DraftStore()
    const panel = new Panel(drafts, vi.fn())
    document.body.appendChild(panel.root)
    panel.show([a, b], buildInspectorData(a))
    return { a, b, drafts, panel }
  }

  function sectionTitles(panel: Panel): string[] {
    return [...panel.root.querySelectorAll('.panel-section')].map((n) => n.textContent?.replace('⋯', '').trim() ?? '')
  }

  it('Fill and Stroke section titles are hidden in multi-select', () => {
    const { panel } = multiSetup('background-color: red;', 'background-color: blue;')
    const fillTitle = [...panel.root.querySelectorAll('.panel-section')].find((n) => n.textContent === 'Fill')!
    const strokeTitleEl = [...panel.root.querySelectorAll('.panel-section')].find(
      (n) => n.textContent?.replace('⋯', '').trim() === 'Stroke'
    )!
    expect((fillTitle as HTMLElement).hidden).toBe(true)
    expect((strokeTitleEl as HTMLElement).hidden).toBe(true)
  })

  it('Fill and Stroke section BODIES (not just titles) are hidden in multi-select (final review fix #1)', () => {
    const { panel } = multiSetup('background-color: red;', 'background-color: blue;')
    const fillTitle = [...panel.root.querySelectorAll('.panel-section')].find((n) => n.textContent === 'Fill')!
    const strokeTitleEl = [...panel.root.querySelectorAll('.panel-section')].find(
      (n) => n.textContent?.replace('⋯', '').trim() === 'Stroke'
    )!
    const fillBody = fillTitle.nextElementSibling as HTMLElement
    expect(fillBody.classList.contains('panel-rows')).toBe(true)
    expect(fillBody.hidden).toBe(true)
    // Stroke's body is its own rowWrap (stroke-rows) — the first .panel-rows sibling after
    // the Stroke title, followed by the T/R/B/L expandWrap.
    const strokeBody = strokeTitleEl.nextElementSibling as HTMLElement
    expect(strokeBody.classList.contains('stroke-rows')).toBe(true)
    expect(strokeBody.hidden).toBe(true)
    const strokeExpandWrap = strokeBody.nextElementSibling as HTMLElement
    expect(strokeExpandWrap.classList.contains('panel-rows')).toBe(true)
    expect(strokeExpandWrap.hidden).toBe(true)
  })

  it('a "Selection colors" section is present and visible only in multi-select', () => {
    const { panel } = multiSetup('background-color: red;', 'background-color: blue;')
    expect(sectionTitles(panel)).toContain('Selection colors')
    const scTitle = [...panel.root.querySelectorAll('.panel-section')].find((n) => n.textContent === 'Selection colors')!
    expect((scTitle as HTMLElement).hidden).toBe(false)
  })

  it('Selection colors rows are unaffected by the Fill/Stroke body-hiding change (final review fix #1)', () => {
    const { panel } = multiSetup('background-color: red;', 'background-color: blue;')
    const scTitle = [...panel.root.querySelectorAll('.panel-section')].find((n) => n.textContent === 'Selection colors')!
    const scBody = scTitle.nextElementSibling as HTMLElement
    expect(scBody.classList.contains('sc-rows')).toBe(true)
    expect(scBody.hidden).toBe(false)
    expect(scBody.querySelectorAll('.sc-row').length).toBeGreaterThan(0)
  })

  it('single-select never shows Selection colors', () => {
    document.body.innerHTML = `<div data-dc-source="src/Card.tsx:4:7" id="t" style="background-color: red;"></div>`
    const el = document.getElementById('t')! as HTMLElement
    const drafts = new DraftStore()
    const panel = new Panel(drafts, vi.fn())
    document.body.appendChild(panel.root)
    panel.show(el, buildInspectorData(el))
    expect(sectionTitles(panel)).not.toContain('Selection colors')
  })

  function scRows(panel: Panel): HTMLElement[] {
    const scTitle = [...panel.root.querySelectorAll('.panel-section')].find((n) => n.textContent === 'Selection colors')!
    return [...(scTitle.parentElement!.querySelector('.sc-rows') as HTMLElement).querySelectorAll('.sc-row')] as HTMLElement[]
  }

  it('groups identical colors into one row with a count; distinct colors get distinct rows', () => {
    // border-top-color defaults to currentColor (the `color` value) when not set explicitly —
    // pin it to a third, distinct color on both elements so counts aren't accidentally aliased
    // by that cascade default. border-style/border-width are set explicitly so the
    // border-top-color usage survives the "computed border-top-width is 0" filter (fix #8) —
    // both elements have direct text, so `color` also survives the hasDirectText filter.
    const { panel } = multiSetup(
      'background-color: rgb(255, 0, 0); color: rgb(255, 0, 0); border-style: solid; border-width: 1px; border-top-color: rgb(9, 9, 9);',
      'background-color: rgb(255, 0, 0); color: rgb(0, 0, 255); border-style: solid; border-width: 1px; border-top-color: rgb(9, 9, 9);'
    )
    const rows = scRows(panel)
    // usages: a.bg=red, a.color=red, a.border=gray, b.bg=red, b.color=blue, b.border=gray
    // => red x3, blue x1, gray x2
    const counts = rows.map((r) => (r.querySelector('.sc-count') as HTMLElement).textContent)
    expect(counts.sort()).toEqual(['×1', '×2', '×3'])
  })

  it('skips fully-transparent colors', () => {
    const { panel } = multiSetup(
      'background-color: transparent; color: rgb(1, 2, 3); border-style: solid; border-width: 1px; border-top-color: rgb(1, 2, 3);',
      'background-color: transparent; color: rgb(1, 2, 3); border-style: solid; border-width: 1px; border-top-color: rgb(1, 2, 3);'
    )
    const rows = scRows(panel)
    expect(rows).toHaveLength(1)
    expect((rows[0].querySelector('.sc-count') as HTMLElement).textContent).toBe('×4')
  })

  it('skips `color` usage for an element with no direct text (fix #8)', () => {
    const { panel } = multiSetup(
      'background-color: rgb(255, 0, 0); color: rgb(0, 255, 0);',
      'background-color: rgb(255, 0, 0); color: rgb(0, 255, 0);',
      false // no direct text on either element
    )
    const rows = scRows(panel)
    // Only background-color usages should be counted (color skipped entirely) — one row, ×2.
    expect(rows).toHaveLength(1)
    expect((rows[0].querySelector('.sc-count') as HTMLElement).textContent).toBe('×2')
  })

  it('skips `border-top-color` usage when the computed border-top-width is 0 (fix #8)', () => {
    // No border-width/style authored at all -> computed border-top-width is 0 (or border-style
    // none) -> the border-top-color usage (which would otherwise default to currentColor) must
    // not be counted, even though `color` itself IS counted (both elements have direct text).
    const { panel } = multiSetup(
      'background-color: rgb(255, 0, 0); color: rgb(0, 255, 0);',
      'background-color: rgb(255, 0, 0); color: rgb(0, 255, 0);'
    )
    const rows = scRows(panel)
    const counts = rows.map((r) => (r.querySelector('.sc-count') as HTMLElement).textContent).sort()
    expect(counts).toEqual(['×2', '×2'])
  })

  it('counts `border-top-color` when a real border is present (width > 0 and style solid)', () => {
    const { panel } = multiSetup(
      'border-style: solid; border-width: 1px; border-top-color: rgb(9, 9, 9);',
      'border-style: solid; border-width: 1px; border-top-color: rgb(9, 9, 9);',
      false
    )
    const rows = scRows(panel)
    expect(rows).toHaveLength(1)
    expect((rows[0].querySelector('.sc-count') as HTMLElement).textContent).toBe('×2')
  })

  it('clicking a row opens the ColorPicker with contrastAgainst null', () => {
    const { panel } = multiSetup('background-color: rgb(255, 0, 0);', 'background-color: rgb(255, 0, 0);')
    const openSpy = vi.fn()
    ;(panel as unknown as { colorPicker: { open: typeof openSpy } }).colorPicker.open = openSpy
    const rows = scRows(panel)
    ;(rows[0].querySelector('.swatch') as HTMLElement).click()
    expect(openSpy).toHaveBeenCalledTimes(1)
    expect(openSpy.mock.calls[0][0].contrastAgainst).toBeNull()
  })

  it('picking a color replaces it on exactly the elements/props that had it', () => {
    const { a, b, panel, drafts } = multiSetup(
      'background-color: rgb(255, 0, 0); color: rgb(255, 0, 0); border-top-color: rgb(10, 10, 10);',
      'background-color: rgb(0, 255, 0); color: rgb(10, 10, 10); border-top-color: rgb(10, 10, 10);'
    )
    let onPick: ((css: string, meta: { token?: string }) => void) | null = null
    ;(panel as unknown as { colorPicker: { open: (opts: any) => void } }).colorPicker.open = (opts) => {
      onPick = opts.onPick
    }
    const rows = scRows(panel)
    const redRow = rows.find((r) => (r.querySelector('.sc-count') as HTMLElement).textContent === '×2')!
    ;(redRow.querySelector('.swatch') as HTMLElement).click()
    onPick!('rgb(9, 9, 9)', {})
    // a's bg and color were both red -> both replaced
    expect(drafts.current(a, 'background-color')).toBe('rgb(9, 9, 9)')
    expect(drafts.current(a, 'color')).toBe('rgb(9, 9, 9)')
    // b's bg was green and color/border were the OTHER shared color (gray) -> untouched
    expect(drafts.current(b, 'background-color')).toBeNull()
    expect(drafts.current(b, 'color')).toBeNull()
  })

  it('picking a border-top-color usage applies all four border color longhands for that element', () => {
    const { a, panel, drafts } = multiSetup(
      'border-style: solid; border-width: 1px; border-color: rgb(255, 0, 0); color: rgb(20, 20, 20); background-color: rgb(20, 20, 20);',
      'background-color: rgb(0, 255, 0); color: rgb(20, 20, 20);'
    )
    let onPick: ((css: string, meta: { token?: string }) => void) | null = null
    ;(panel as unknown as { colorPicker: { open: (opts: any) => void } }).colorPicker.open = (opts) => {
      onPick = opts.onPick
    }
    const rows = scRows(panel)
    const redRow = rows.find((r) => (r.querySelector('.sc-count') as HTMLElement).textContent === '×1')!
    ;(redRow.querySelector('.swatch') as HTMLElement).click()
    onPick!('rgb(9, 9, 9)', {})
    for (const side of ['top', 'right', 'bottom', 'left']) {
      expect(drafts.current(a, `border-${side}-color`)).toBe('rgb(9, 9, 9)')
    }
  })

  it('refresh regroups after an edit', () => {
    const { a, panel, drafts } = multiSetup('background-color: rgb(255, 0, 0);', 'background-color: rgb(0, 255, 0);')
    expect(scRows(panel)).toHaveLength(2)
    drafts.apply(a, 'background-color', 'rgb(0, 255, 0)')
    panel.refresh()
    expect(scRows(panel)).toHaveLength(1)
    expect((scRows(panel)[0].querySelector('.sc-count') as HTMLElement).textContent).toBe('×2')
  })
})

describe('Docked mode structure (docked-panel spec)', () => {
  function freshPanel() {
    const drafts = new DraftStore()
    const panel = new Panel(drafts, () => {})
    document.body.appendChild(panel.root)
    return panel
  }

  function makeTagged(): HTMLElement {
    document.body.innerHTML = `<div data-dc-source="src/Card.tsx:4:7" id="t" style="padding: 8px; width: 200px;"></div>`
    return document.getElementById('t')! as HTMLElement
  }

  it('creates footer, resize handle, and mode button with their hook classes', () => {
    const panel = freshPanel()
    expect(panel.footer.className).toBe('panel-footer')
    expect(panel.resizeHandle.className).toBe('panel-resize')
    expect(panel.modeButton.className).toBe('panel-mode')
    expect(panel.root.contains(panel.footer)).toBe(true)
    expect(panel.root.contains(panel.resizeHandle)).toBe(true)
    expect(panel.root.contains(panel.modeButton)).toBe(true)
  })

  it('body div carries the panel-body scroll-container class', () => {
    const panel = freshPanel()
    expect(panel.root.querySelector('.panel-body')).not.toBeNull()
  })

  it('setDocked(true) with no selection shows the root with the empty state', () => {
    const panel = freshPanel()
    panel.setDocked(true)
    expect(panel.root.classList.contains('docked')).toBe(true)
    expect(panel.root.hidden).toBe(false)
    const empty = panel.root.querySelector('.panel-empty') as HTMLElement
    expect(empty.hidden).toBe(false)
    expect(empty.textContent).toBe('Click an element to edit')
    expect((panel.root.querySelector('.panel-body') as HTMLElement).hidden).toBe(true)
  })

  it('show() in docked mode hides the empty state and reveals body/actions', () => {
    const panel = freshPanel()
    panel.setDocked(true)
    const el = makeTagged()
    panel.show(el, buildInspectorData(el))
    expect((panel.root.querySelector('.panel-empty') as HTMLElement).hidden).toBe(true)
    expect((panel.root.querySelector('.panel-body') as HTMLElement).hidden).toBe(false)
  })

  it('hide() in docked mode returns to the empty state with "No selection" header', () => {
    const panel = freshPanel()
    panel.setDocked(true)
    const el = makeTagged()
    panel.show(el, buildInspectorData(el))
    panel.hide()
    expect(panel.root.hidden).toBe(false)
    expect((panel.root.querySelector('.panel-empty') as HTMLElement).hidden).toBe(false)
    expect(panel.root.querySelector('.panel-head-tag')!.textContent).toBe('No selection')
  })

  it('setDocked(false) with no selection hides the root (floating behavior)', () => {
    const panel = freshPanel()
    panel.setDocked(true)
    panel.setDocked(false)
    expect(panel.root.classList.contains('docked')).toBe(false)
    expect(panel.root.hidden).toBe(true)
  })

  it('popovers mount inside the panel-body scroll container, not the root', () => {
    const panel = freshPanel()
    const body = panel.root.querySelector('.panel-body') as HTMLElement
    expect(body.querySelector('.color-popover')).not.toBeNull()
    expect(body.querySelector('.token-popover')).not.toBeNull()
  })

  it('opening one popover closes the other (mutual exclusion, both directions)', () => {
    // Two popovers open at once would overlap/fight for the same anchor-relative position.
    // ColorPicker's open() is wrapped by Panel; TokenPicker instead exposes a beforeOpen
    // hook (its open() is generic, so wrapping would erase the per-call entry typing) —
    // this pins BOTH mechanisms so a future rewiring of either can't silently drop one.
    const panel = freshPanel()
    const body = panel.root.querySelector('.panel-body') as HTMLElement
    const inner = panel as unknown as {
      colorPicker: { open: (opts: unknown) => void }
    }
    const tokenPicker = pickerOf(panel)
    const tokenRoot = body.querySelector('.token-popover') as HTMLElement
    const colorRoot = body.querySelector('.color-popover') as HTMLElement
    const anchor = document.createElement('div')
    body.append(anchor)

    tokenPicker.open({ anchor, entries: [{ label: '4', px: 16 }], onApply: () => {} })
    expect(tokenRoot.hidden).toBe(false)
    inner.colorPicker.open({ anchor, initial: '#ff0000', contrastAgainst: null, onPick: () => {} })
    expect(colorRoot.hidden).toBe(false)
    expect(tokenRoot.hidden).toBe(true) // color open closed token

    tokenPicker.open({ anchor, entries: [{ label: '4', px: 16 }], onApply: () => {} })
    expect(tokenRoot.hidden).toBe(false)
    expect(colorRoot.hidden).toBe(true) // token open (beforeOpen hook) closed color
  })

  it('popovers survive buildBody() on show() — regression for the body-rebuild wipeout', () => {
    // buildBody() runs on every show() and used to unconditionally replaceChildren() the
    // body, which also wiped the constructor-created popover roots living in that same
    // container (they're only ever appended once, at construction). Rebuilds now wipe only
    // the .panel-sections wrapper; the popovers are its siblings directly in .panel-body,
    // structurally out of reach. Guard both the first rebuild and a second one
    // (re-selection), since the first show() was the one that silently destroyed the
    // popovers in production.
    const panel = freshPanel()
    const body = panel.root.querySelector('.panel-body') as HTMLElement
    const el = makeTagged()
    panel.show(el, buildInspectorData(el))
    expect(body.querySelector('.color-popover')).not.toBeNull()
    expect(body.querySelector('.token-popover')).not.toBeNull()
    panel.show(el, buildInspectorData(el))
    expect(body.querySelector('.color-popover')).not.toBeNull()
    expect(body.querySelector('.token-popover')).not.toBeNull()
    // The structural guarantee: sections rebuild inside the wrapper, popovers outside it.
    const sections = body.querySelector('.panel-sections') as HTMLElement
    expect(sections).not.toBeNull()
    expect(sections.querySelector('.panel-section')).not.toBeNull()
    expect(sections.querySelector('.color-popover')).toBeNull()
    expect(sections.querySelector('.token-popover')).toBeNull()
  })
})
