// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { pillLabelFor, colorDisplay, PanelTokenUi } from '../../src/client/panel-token-ui'
import { NumberField } from '../../src/client/controls'
import { RADIUS } from '../../src/client/panel-specs'
import { resetTokensCache } from '../../src/client/tokens'
import type { TaggedElement } from '../../src/client/source'
import type { ScaleEntry } from '../../src/client/tokenpicker'

describe('pillLabelFor', () => {
  it('linked radius row (RADIUS props) resolves through MULTI_PROP_SYNTHETIC to rounded-md', () => {
    const entry: ScaleEntry = { label: 'md', px: 6 }
    expect(pillLabelFor({ label: 'R', props: RADIUS, min: 0 }, entry)).toBe('rounded-md')
  })

  it('single-corner radius row (own longhand prefix) resolves to rounded-tl-md', () => {
    const entry: ScaleEntry = { label: 'md', px: 6 }
    expect(pillLabelFor({ label: 'TL', props: ['border-top-left-radius'], min: 0 }, entry)).toBe('rounded-tl-md')
  })

  it('font-size row is special-cased to text-<label> regardless of UTILITY_PREFIXES', () => {
    const entry: ScaleEntry = { label: 'sm', px: 14 }
    expect(pillLabelFor({ label: 'S', props: ['font-size'], min: 0 }, entry)).toBe('text-sm')
  })

  it('[padding-left, padding-right] resolves through MULTI_PROP_SYNTHETIC to px-<label>', () => {
    const entry: ScaleEntry = { label: '4', px: 16 }
    expect(pillLabelFor({ label: 'PX', props: ['padding-left', 'padding-right'], min: 0 }, entry)).toBe('px-4')
  })
})

describe('colorDisplay', () => {
  function setupColorTokens() {
    resetTokensCache()
    document.head.insertAdjacentHTML(
      'beforeend',
      '<style data-test-ptu-tokens>:root { --color-red-500: #ff0000; }</style>'
    )
    document.documentElement.style.setProperty('--color-red-500', '#ff0000')
  }

  function teardownColorTokens() {
    document.querySelectorAll('style[data-test-ptu-tokens]').forEach((s) => s.remove())
    document.documentElement.removeAttribute('style')
    resetTokensCache()
  }

  beforeEach(() => {
    setupColorTokens()
  })

  afterEach(() => {
    teardownColorTokens()
  })

  it('exact opaque token match reports the token name and token: true', () => {
    expect(colorDisplay('rgb(255, 0, 0)')).toEqual({ text: 'red-500', token: true })
  })

  it('fully-transparent rgba(0,0,0,0) reports the literal "transparent" keyword, not a nearest-token guess', () => {
    expect(colorDisplay('rgba(0, 0, 0, 0)')).toEqual({ text: 'transparent', token: false })
  })

  it('semi-transparent value whose rgb equals a token shows its own hex-with-alpha, not the token name (alpha-guard pinned)', () => {
    const result = colorDisplay('rgba(255, 0, 0, 0.5)')
    expect(result.token).toBe(false)
    expect(result.text).toBe('#ff000080')
    expect(result.text).not.toBe('red-500')
  })

  it('unparseable css falls back to the raw string with token: false', () => {
    expect(colorDisplay('not-a-color')).toEqual({ text: 'not-a-color', token: false })
  })
})

describe('PanelTokenUi', () => {
  function setupSpacingTheme() {
    document.documentElement.style.setProperty('--spacing', '4px')
  }

  function teardownSpacingTheme() {
    document.documentElement.removeAttribute('style')
  }

  function makeEl(): TaggedElement {
    document.body.innerHTML = `<div id="t" style="padding-left: 16px; padding-right: 16px;"></div>`
    return document.getElementById('t') as unknown as TaggedElement
  }

  function makeUi(el: TaggedElement | null) {
    const popoverParent = document.createElement('div')
    document.body.append(popoverParent)
    return new PanelTokenUi(popoverParent, () => el)
  }

  const PX_SPEC = { label: 'PX', props: ['padding-left', 'padding-right'], min: 0 }

  beforeEach(() => {
    setupSpacingTheme()
  })

  afterEach(() => {
    teardownSpacingTheme()
    document.body.innerHTML = ''
  })

  // Drives the REAL TokenPicker DOM (open -> click a tp-row) rather than calling the private
  // onApply callback directly, per the brief: assert against the real module, no mocks.
  // Matches on the exact .tp-row-label text — a substring match against the whole row's
  // textContent is unsafe here because the px suffix ("1 — 4px") can itself contain the
  // label text being searched for (e.g. label '1' has px text '4px', which contains '4').
  function openAndPick(ui: PanelTokenUi, field: NumberField, commitPx: (px: number) => void, label: string): void {
    ui.openScalePicker(PX_SPEC, field, commitPx)
    expect(ui.picker.root.hidden).toBe(false)
    const row = [...ui.picker.root.querySelectorAll('.tp-row')].find(
      (r) => r.querySelector('.tp-row-label')?.textContent === label
    )
    if (!row) throw new Error(`no tp-row for label ${label}`)
    ;(row as HTMLElement).click()
  }

  it('openScalePicker applying an entry binds the field pill and records the bound px', () => {
    const el = makeEl()
    const ui = makeUi(el)
    let committed: number | null = null
    const field = new NumberField({ label: 'PX', min: 0, onInput: (v) => (committed = v) })

    openAndPick(ui, field, (px) => field.set(px), '4') // spacingBasePx 4 -> step '4' == 16px

    expect(ui.picker.root.hidden).toBe(true) // commit() closes the popover
    // The field is now pill-bound (readOnly input showing the token label, not the raw number).
    const input = field.root.querySelector('input') as HTMLInputElement
    expect(input.readOnly).toBe(true)
    expect(input.value).toBe('px-4')
  })

  it('rebind with the same px re-binds the pill after set() unconditionally cleared it (B5 contract)', () => {
    const el = makeEl()
    const ui = makeUi(el)
    const field = new NumberField({ label: 'PX', min: 0, onInput: () => {} })
    openAndPick(ui, field, (px) => field.set(px), '4')

    // Simulate refresh(): set() clears the pill; rebind with the SAME px re-applies it.
    field.set(16)
    expect((field.root.querySelector('input') as HTMLInputElement).readOnly).toBe(false)
    ui.rebind(PX_SPEC, field, 16, false, false)
    const input = field.root.querySelector('input') as HTMLInputElement
    expect(input.readOnly).toBe(true)
    expect(input.value).toBe('px-4')
  })

  it('rebind with a diverged px drops the entry, and a later equal-px rebind does not resurrect it', () => {
    const el = makeEl()
    const ui = makeUi(el)
    const field = new NumberField({ label: 'PX', min: 0, onInput: () => {} })
    openAndPick(ui, field, (px) => field.set(px), '4')

    field.set(20) // user edited directly — value now diverges from the bound px (16)
    ui.rebind(PX_SPEC, field, 20, false, false)
    expect((field.root.querySelector('input') as HTMLInputElement).readOnly).toBe(false)

    // Even though the value now happens to equal the ORIGINAL bound px again, the entry was
    // already dropped by the diverging rebind above — it must not resurrect.
    field.set(16)
    ui.rebind(PX_SPEC, field, 16, false, false)
    expect((field.root.querySelector('input') as HTMLInputElement).readOnly).toBe(false)
  })

  it('Task 12: rebind uses round-equality on a fractional-px theme (Math.round(bound.px) === value)', () => {
    // --spacing 3.75px makes step '3.5' == 13.125px. readValue's fromPx rounds the CSS back
    // to 13 for display (panel-patterns doc) — the bound entry's exact px stays 13.125. That
    // rounding gap must not read as user divergence.
    teardownSpacingTheme()
    document.documentElement.style.setProperty('--spacing', '3.75px')
    resetTokensCache()
    const el = makeEl()
    const ui = makeUi(el)
    const field = new NumberField({ label: 'PX', min: 0, onInput: () => {} })
    openAndPick(ui, field, (px) => field.set(px), '3.5')

    field.set(13) // simulate refresh(): the rounded display value
    expect((field.root.querySelector('input') as HTMLInputElement).readOnly).toBe(false)
    ui.rebind(PX_SPEC, field, 13, false, false)
    const input = field.root.querySelector('input') as HTMLInputElement
    expect(input.readOnly).toBe(true)
    expect(input.value).toBe('px-3.5')
  })

  it('Task 12 boundary: an exact .5-fraction bound px (13.5, displayed 14) keeps its pill', () => {
    // --spacing 9px makes step '1.5' == 13.5px — the exact-half case. fromPx displays it as
    // Math.round(13.5) = 14 (half-up); round-equality must keep the pill. (The earlier
    // epsilon form |bound.px - value| < 0.5 failed exactly here: |13.5 - 14| === 0.5.)
    teardownSpacingTheme()
    document.documentElement.style.setProperty('--spacing', '9px')
    resetTokensCache()
    const el = makeEl()
    const ui = makeUi(el)
    const field = new NumberField({ label: 'PX', min: 0, onInput: () => {} })
    openAndPick(ui, field, (px) => field.set(px), '1.5')

    field.set(14) // simulate refresh(): Math.round(13.5) = 14
    ui.rebind(PX_SPEC, field, 14, false, false)
    const input = field.root.querySelector('input') as HTMLInputElement
    expect(input.readOnly).toBe(true)
    expect(input.value).toBe('px-1.5')
  })

  it('Task 12: rebind still drops a value that is not the rounding of the bound px', () => {
    teardownSpacingTheme()
    document.documentElement.style.setProperty('--spacing', '3.75px')
    resetTokensCache()
    const el = makeEl()
    const ui = makeUi(el)
    const field = new NumberField({ label: 'PX', min: 0, onInput: () => {} })
    openAndPick(ui, field, (px) => field.set(px), '3.5')

    field.set(14) // Math.round(13.125) = 13 !== 14 -> a real user edit, not rounding noise
    ui.rebind(PX_SPEC, field, 14, false, false)
    expect((field.root.querySelector('input') as HTMLInputElement).readOnly).toBe(false)
  })

  it('Task 12 boundary: 13 for a bound 13.5px unbinds — half-up rounds 13.5 to 14, not 13', () => {
    teardownSpacingTheme()
    document.documentElement.style.setProperty('--spacing', '9px')
    resetTokensCache()
    const el = makeEl()
    const ui = makeUi(el)
    const field = new NumberField({ label: 'PX', min: 0, onInput: () => {} })
    openAndPick(ui, field, (px) => field.set(px), '1.5')

    field.set(13) // Math.round(13.5) = 14 !== 13 -> divergence, must unbind
    ui.rebind(PX_SPEC, field, 13, false, false)
    expect((field.root.querySelector('input') as HTMLInputElement).readOnly).toBe(false)
  })

  it('rebind with comparing: true neither binds nor drops — a later non-comparing rebind still binds', () => {
    const el = makeEl()
    const ui = makeUi(el)
    const field = new NumberField({ label: 'PX', min: 0, onInput: () => {} })
    openAndPick(ui, field, (px) => field.set(px), '4')

    field.set(16) // clears the pill display only; bound map entry is untouched by set()
    ui.rebind(PX_SPEC, field, 8, false, true) // comparing — diverging value must be ignored
    expect((field.root.querySelector('input') as HTMLInputElement).readOnly).toBe(false) // still not bound (comparing skips bindToken)

    // Un-compare with the ORIGINAL bound value: the bound entry must still be present because
    // the comparing rebind above did not delete it.
    ui.rebind(PX_SPEC, field, 16, false, false)
    const input = field.root.querySelector('input') as HTMLInputElement
    expect(input.readOnly).toBe(true)
    expect(input.value).toBe('px-4')
  })

  it('drop empties this field\'s bookkeeping — a subsequent equal-px rebind produces no pill', () => {
    const el = makeEl()
    const ui = makeUi(el)
    const field = new NumberField({ label: 'PX', min: 0, onInput: () => {} })
    openAndPick(ui, field, (px) => field.set(px), '4')

    ui.drop(PX_SPEC)
    field.set(16)
    ui.rebind(PX_SPEC, field, 16, false, false)
    expect((field.root.querySelector('input') as HTMLInputElement).readOnly).toBe(false)
  })

  it('clear empties ALL bookkeeping — a subsequent equal-px rebind produces no pill', () => {
    const el = makeEl()
    const ui = makeUi(el)
    const field = new NumberField({ label: 'PX', min: 0, onInput: () => {} })
    openAndPick(ui, field, (px) => field.set(px), '4')

    ui.clear()
    field.set(16)
    ui.rebind(PX_SPEC, field, 16, false, false)
    expect((field.root.querySelector('input') as HTMLInputElement).readOnly).toBe(false)
  })

  describe('colorTokenButton', () => {
    function setupColorTokens() {
      resetTokensCache()
      document.head.insertAdjacentHTML(
        'beforeend',
        '<style data-test-ptu-cb-tokens>:root { --color-red-500: #ff0000; --color-blue-400: #0000ff; }</style>'
      )
      document.documentElement.style.setProperty('--color-red-500', '#ff0000')
      document.documentElement.style.setProperty('--color-blue-400', '#0000ff')
    }

    function teardownColorTokens() {
      document.querySelectorAll('style[data-test-ptu-cb-tokens]').forEach((s) => s.remove())
      resetTokensCache()
    }

    afterEach(() => {
      teardownColorTokens()
    })

    it('returns a .token-btn button', () => {
      const el = makeEl()
      const ui = makeUi(el)
      const row = document.createElement('div')
      const btn = ui.colorTokenButton(row, () => {})
      expect(btn.classList.contains('token-btn')).toBe(true)
    })

    it('clicking it with color tokens present opens the picker with .tp-row-swatch rows', () => {
      setupColorTokens()
      const el = makeEl()
      const ui = makeUi(el)
      const row = document.createElement('div')
      document.body.append(row)
      const btn = ui.colorTokenButton(row, () => {})
      btn.click()
      expect(ui.picker.root.hidden).toBe(false)
      const swatches = ui.picker.root.querySelectorAll('.tp-row-swatch')
      expect(swatches.length).toBeGreaterThan(0)
      expect(ui.picker.root.textContent).toContain('red-500')
    })

    it('clicking a row invokes applyColor with the token\'s exact css value', () => {
      setupColorTokens()
      const el = makeEl()
      const ui = makeUi(el)
      const row = document.createElement('div')
      document.body.append(row)
      const applyColor = vi.fn()
      const btn = ui.colorTokenButton(row, applyColor)
      btn.click()

      const tpRow = [...ui.picker.root.querySelectorAll('.tp-row')].find((r) => r.textContent?.includes('red-500'))!
      ;(tpRow as HTMLElement).click()

      expect(applyColor).toHaveBeenCalledWith('#ff0000')
    })

    it('does nothing (no picker open) when getEl() returns null — no element selected', () => {
      const ui = makeUi(null)
      setupColorTokens()
      const row = document.createElement('div')
      document.body.append(row)
      const btn = ui.colorTokenButton(row, () => {})
      btn.click()
      expect(ui.picker.root.hidden).toBe(true)
    })
  })
})
