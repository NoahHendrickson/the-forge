// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { ColorPicker, hsvToRgb, rgbToHsv } from '../../src/client/colorpicker'
import type { Tokens } from '../../src/client/tokens'

const TOKENS: Tokens = {
  colors: [
    { name: 'red-500', value: '#ef4444' },
    { name: 'red-600', value: '#dc2626' },
    { name: 'blue-500', value: '#3b82f6' },
    { name: 'white', value: '#ffffff' },
    { name: 'black', value: '#000000' },
  ],
  textScale: [],
}

function setupPicker() {
  const panelRoot = document.createElement('div')
  document.body.append(panelRoot)
  const picker = new ColorPicker(panelRoot, () => TOKENS)
  return { panelRoot, picker }
}

function anchorEl(): HTMLElement {
  const anchor = document.createElement('div')
  anchor.style.top = '100px'
  Object.defineProperty(anchor, 'offsetTop', { value: 100, configurable: true })
  document.body.append(anchor)
  return anchor
}

beforeEach(() => {
  document.body.innerHTML = ''
})

afterEach(() => {
  vi.restoreAllMocks()
})

describe('hsvToRgb / rgbToHsv', () => {
  it('converts known pairs: red', () => {
    expect(hsvToRgb(0, 1, 1)).toEqual({ r: 255, g: 0, b: 0 })
    expect(rgbToHsv(255, 0, 0)).toEqual({ h: 0, s: 1, v: 1 })
  })

  it('converts known pairs: white', () => {
    expect(hsvToRgb(0, 0, 1)).toEqual({ r: 255, g: 255, b: 255 })
    expect(rgbToHsv(255, 255, 255)).toEqual({ h: 0, s: 0, v: 1 })
  })

  it('converts known pairs: black', () => {
    expect(hsvToRgb(0, 0, 0)).toEqual({ r: 0, g: 0, b: 0 })
    expect(rgbToHsv(0, 0, 0)).toEqual({ h: 0, s: 0, v: 0 })
  })

  it('converts known pairs: green', () => {
    expect(hsvToRgb(120, 1, 1)).toEqual({ r: 0, g: 255, b: 0 })
    expect(rgbToHsv(0, 255, 0)).toEqual({ h: 120, s: 1, v: 1 })
  })

  it('converts known pairs: blue', () => {
    expect(hsvToRgb(240, 1, 1)).toEqual({ r: 0, g: 0, b: 255 })
    expect(rgbToHsv(0, 0, 255)).toEqual({ h: 240, s: 1, v: 1 })
  })

  it('converts a mid-saturation gray-ish color round trip', () => {
    const rgb = hsvToRgb(210, 0.5, 0.8)
    const hsv = rgbToHsv(rgb.r, rgb.g, rgb.b)
    expect(hsv.h).toBeCloseTo(210, 0)
    expect(hsv.s).toBeCloseTo(0.5, 1)
    expect(hsv.v).toBeCloseTo(0.8, 1)
  })
})

describe('ColorPicker', () => {
  it('root is hidden by default and appended to panel root', () => {
    const { panelRoot, picker } = setupPicker()
    expect(picker.root.isConnected).toBe(true)
    expect(panelRoot.contains(picker.root)).toBe(true)
    expect(picker.root.hidden).toBe(true)
  })

  it('root carries forge-anim for animated show/hide', () => {
    const { picker } = setupPicker()
    expect(picker.root.classList.contains('forge-anim')).toBe(true)
  })

  it('open() shows the popover and renders the palette from injected tokens', () => {
    const { picker } = setupPicker()
    const anchor = anchorEl()
    picker.open({ anchor, initial: '#ff0000', contrastAgainst: null, onPick: vi.fn() })
    expect(picker.root.hidden).toBe(false)
    const swatches = picker.root.querySelectorAll('.cp-palette [title]')
    expect(swatches.length).toBe(TOKENS.colors.length)
    const titles = [...swatches].map((s) => s.getAttribute('title'))
    expect(titles).toContain('red-500')
    expect(titles).toContain('white')
  })

  it('renderPalette groups swatches by family into one .cp-palette-row per family, shadeless tokens in a final row', () => {
    const { panelRoot } = setupPicker()
    const tokens: Tokens = {
      colors: [
        { name: 'red-500', value: '#ef4444' },
        { name: 'red-600', value: '#dc2626' },
        { name: 'blue-500', value: '#3b82f6' },
        { name: 'white', value: '#ffffff' },
        { name: 'black', value: '#000000' },
      ],
      textScale: [],
    }
    const picker = new ColorPicker(panelRoot, () => tokens)
    const anchor = anchorEl()
    picker.open({ anchor, initial: '#ff0000', contrastAgainst: null, onPick: vi.fn() })

    const rows = picker.root.querySelectorAll('.cp-palette-row')
    expect(rows.length).toBe(3) // red, blue, shadeless(white/black)

    const rowNames = [...rows].map((row) => [...row.querySelectorAll('[title]')].map((s) => s.getAttribute('title')))
    expect(rowNames).toContainEqual(['red-500', 'red-600'])
    expect(rowNames).toContainEqual(['blue-500'])
    expect(rowNames).toContainEqual(['white', 'black'])
  })

  it('every .cp-swatch rendered in the palette has title === token name', () => {
    const { picker } = setupPicker()
    const anchor = anchorEl()
    picker.open({ anchor, initial: '#ff0000', contrastAgainst: null, onPick: vi.fn() })
    const swatches = picker.root.querySelectorAll('.cp-swatch')
    expect(swatches.length).toBe(TOKENS.colors.length)
    for (const swatch of swatches) {
      const title = swatch.getAttribute('title')
      const matchingToken = TOKENS.colors.find((t) => t.name === title)
      expect(matchingToken).toBeDefined()
      expect(title).toBeTruthy()
    }
  })

  it('close() hides the popover', () => {
    const { picker } = setupPicker()
    const anchor = anchorEl()
    picker.open({ anchor, initial: '#ff0000', contrastAgainst: null, onPick: vi.fn() })
    picker.close()
    expect(picker.root.hidden).toBe(true)
  })

  it('close() called defensively without a prior open() is a true no-op (no window listener churn)', () => {
    const { picker } = setupPicker()
    const removeSpy = vi.spyOn(window, 'removeEventListener')
    picker.close()
    expect(removeSpy).not.toHaveBeenCalled()
  })

  it('a second close() call in a row does not re-remove listeners', () => {
    const { picker } = setupPicker()
    const anchor = anchorEl()
    picker.open({ anchor, initial: '#ff0000', contrastAgainst: null, onPick: vi.fn() })
    picker.close()
    const removeSpy = vi.spyOn(window, 'removeEventListener')
    picker.close()
    expect(removeSpy).not.toHaveBeenCalledWith('keydown', expect.any(Function))
    expect(removeSpy).not.toHaveBeenCalledWith('mousedown', expect.any(Function))
  })

  it('hex input commits a valid #rrggbb value and emits via onPick', () => {
    const { picker } = setupPicker()
    const anchor = anchorEl()
    const onPick = vi.fn()
    picker.open({ anchor, initial: '#ff0000', contrastAgainst: null, onPick })
    const hex = picker.root.querySelector('.cp-hex') as HTMLInputElement
    hex.value = '#00ff00'
    hex.dispatchEvent(new Event('change', { bubbles: true }))
    expect(onPick).toHaveBeenCalled()
    const [css] = onPick.mock.calls.at(-1)!
    expect(css).toBe('rgb(0, 255, 0)')
  })

  it('hex input reverts on invalid input without emitting', () => {
    const { picker } = setupPicker()
    const anchor = anchorEl()
    const onPick = vi.fn()
    picker.open({ anchor, initial: '#ff0000', contrastAgainst: null, onPick })
    const hex = picker.root.querySelector('.cp-hex') as HTMLInputElement
    onPick.mockClear()
    hex.value = 'not-a-color'
    hex.dispatchEvent(new Event('change', { bubbles: true }))
    expect(onPick).not.toHaveBeenCalled()
    expect(hex.value.toLowerCase()).toBe('#ff0000')
  })

  it('hex input passes through #rrggbbaa (alpha) forms', () => {
    const { picker } = setupPicker()
    const anchor = anchorEl()
    const onPick = vi.fn()
    picker.open({ anchor, initial: '#ff0000', contrastAgainst: null, onPick })
    const hex = picker.root.querySelector('.cp-hex') as HTMLInputElement
    hex.value = '#00ff0080'
    hex.dispatchEvent(new Event('change', { bubbles: true }))
    const [css] = onPick.mock.calls.at(-1)!
    expect(css).toMatch(/^rgba\(0, 255, 0, 0\.(5|50)/)
  })

  it('clicking a palette swatch emits the exact token value with meta.token set', () => {
    const { picker } = setupPicker()
    const anchor = anchorEl()
    const onPick = vi.fn()
    picker.open({ anchor, initial: '#000000', contrastAgainst: null, onPick })
    const swatch = [...picker.root.querySelectorAll('.cp-palette [title]')].find(
      (s) => s.getAttribute('title') === 'red-500'
    ) as HTMLElement
    swatch.click()
    expect(onPick).toHaveBeenCalledWith('#ef4444', { token: 'red-500' })
  })

  it('shows a nearest-token hint when the current color is not exactly on a token, and clicking it snaps', () => {
    const { picker } = setupPicker()
    const anchor = anchorEl()
    const onPick = vi.fn()
    // close to red-500 but not exact
    picker.open({ anchor, initial: '#ee4444', contrastAgainst: null, onPick })
    const hint = picker.root.querySelector('.cp-hint') as HTMLElement
    expect(hint.hidden).toBe(false)
    expect(hint.textContent).toContain('red-500')
    hint.click()
    expect(onPick).toHaveBeenCalledWith('#ef4444', { token: 'red-500' })
  })

  it('hides the nearest-token hint when the current color is exactly on a token', () => {
    const { picker } = setupPicker()
    const anchor = anchorEl()
    picker.open({ anchor, initial: '#ef4444', contrastAgainst: null, onPick: vi.fn() })
    const hint = picker.root.querySelector('.cp-hint') as HTMLElement
    expect(hint.hidden).toBe(true)
  })

  it('contrast line shows AAA badge for black on white (ratio 21)', () => {
    const { picker } = setupPicker()
    const anchor = anchorEl()
    picker.open({ anchor, initial: '#000000', contrastAgainst: '#ffffff', onPick: vi.fn() })
    const contrast = picker.root.querySelector('.cp-contrast') as HTMLElement
    expect(contrast.hidden).toBe(false)
    expect(contrast.textContent).toContain('21')
    expect(contrast.textContent).toContain('AAA')
  })

  it('contrast line is hidden when contrastAgainst is null', () => {
    const { picker } = setupPicker()
    const anchor = anchorEl()
    picker.open({ anchor, initial: '#000000', contrastAgainst: null, onPick: vi.fn() })
    const contrast = picker.root.querySelector('.cp-contrast') as HTMLElement
    expect(contrast.hidden).toBe(true)
  })

  it('contrast line is hidden when contrastAgainst is unparseable', () => {
    const { picker } = setupPicker()
    const anchor = anchorEl()
    picker.open({ anchor, initial: '#000000', contrastAgainst: 'not-a-color', onPick: vi.fn() })
    const contrast = picker.root.querySelector('.cp-contrast') as HTMLElement
    expect(contrast.hidden).toBe(true)
  })

  it('Escape key closes the picker', () => {
    const { picker } = setupPicker()
    const anchor = anchorEl()
    picker.open({ anchor, initial: '#ff0000', contrastAgainst: null, onPick: vi.fn() })
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }))
    expect(picker.root.hidden).toBe(true)
  })

  it('registers its Escape listener with capture: true (final review fix #11)', () => {
    const addSpy = vi.spyOn(window, 'addEventListener')
    const { picker } = setupPicker()
    const anchor = anchorEl()
    picker.open({ anchor, initial: '#ff0000', contrastAgainst: null, onPick: vi.fn() })
    const keydownCall = addSpy.mock.calls.find((c) => c[0] === 'keydown')!
    expect(keydownCall[2]).toBe(true)
  })

  it('Escape closes the picker even when a focused control stopped propagation at the bubble phase (final review fix #11)', () => {
    const { picker } = setupPicker()
    const anchor = anchorEl()
    picker.open({ anchor, initial: '#ff0000', contrastAgainst: null, onPick: vi.fn() })

    const focused = document.createElement('input')
    document.body.append(focused)
    focused.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') e.stopPropagation()
    })
    const event = new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true })
    focused.dispatchEvent(event)

    expect(picker.root.hidden).toBe(true)
  })

  it('outside pointerdown closes the picker', () => {
    const { picker } = setupPicker()
    const anchor = anchorEl()
    picker.open({ anchor, initial: '#ff0000', contrastAgainst: null, onPick: vi.fn() })
    document.body.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }))
    expect(picker.root.hidden).toBe(true)
  })

  it('pointerdown inside the picker does not close it', () => {
    const { picker } = setupPicker()
    const anchor = anchorEl()
    picker.open({ anchor, initial: '#ff0000', contrastAgainst: null, onPick: vi.fn() })
    picker.root.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }))
    expect(picker.root.hidden).toBe(false)
  })

  it('mousedown inside a real shadow root does not close the picker, but an outside mousedown does', () => {
    // Regression test for the shadow-DOM retargeting bug: window-level listeners see
    // `e.target` retargeted to the shadow HOST, not the true element under the cursor.
    // This mounts the picker inside an actual attached (open) shadow root — unlike
    // `setupPicker()`, which appends straight to `document.body` and never exercises
    // shadow retargeting — so a naive `e.target` check would incorrectly close the
    // picker on its very first in-popover mousedown.
    const host = document.createElement('div')
    document.body.append(host)
    const shadow = host.attachShadow({ mode: 'open' })
    const panelRoot = document.createElement('div')
    shadow.append(panelRoot)
    const picker = new ColorPicker(panelRoot, () => TOKENS)
    const anchor = document.createElement('div')
    Object.defineProperty(anchor, 'offsetTop', { value: 100, configurable: true })
    shadow.append(anchor)

    picker.open({ anchor, initial: '#ff0000', contrastAgainst: null, onPick: vi.fn() })
    expect(picker.root.hidden).toBe(false)

    // mousedown inside the popover (composed, so it crosses the shadow boundary and
    // reaches the window listener retargeted to `host`) must NOT close it.
    picker.root.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, composed: true }))
    expect(picker.root.hidden).toBe(false)

    // mousedown truly outside (on document.body, outside the shadow tree entirely) must close it.
    document.body.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, composed: true }))
    expect(picker.root.hidden).toBe(true)
  })

  it('reselection (a second open()) closes any active drag listeners from the SV area', () => {
    const { picker } = setupPicker()
    const anchor = anchorEl()
    picker.open({ anchor, initial: '#ff0000', contrastAgainst: null, onPick: vi.fn() })
    const sv = picker.root.querySelector('.cp-sv') as HTMLElement
    const addSpy = vi.spyOn(window, 'addEventListener')
    const removeSpy = vi.spyOn(window, 'removeEventListener')
    sv.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, clientX: 10, clientY: 10 }))
    expect(addSpy).toHaveBeenCalledWith('mousemove', expect.any(Function))
    // Re-opening (selection change) must clean up the drag listeners.
    picker.open({ anchor, initial: '#00ff00', contrastAgainst: null, onPick: vi.fn() })
    expect(removeSpy).toHaveBeenCalledWith('mousemove', expect.any(Function))
    expect(removeSpy).toHaveBeenCalledWith('mouseup', expect.any(Function))
  })

  it('close() cleans up any active SV-drag window listeners', () => {
    const { picker } = setupPicker()
    const anchor = anchorEl()
    picker.open({ anchor, initial: '#ff0000', contrastAgainst: null, onPick: vi.fn() })
    const sv = picker.root.querySelector('.cp-sv') as HTMLElement
    sv.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, clientX: 10, clientY: 10 }))
    const removeSpy = vi.spyOn(window, 'removeEventListener')
    picker.close()
    expect(removeSpy).toHaveBeenCalledWith('mousemove', expect.any(Function))
    expect(removeSpy).toHaveBeenCalledWith('mouseup', expect.any(Function))
  })

  it('destroy() cleans up any active SV-drag window listeners', () => {
    const { picker } = setupPicker()
    const anchor = anchorEl()
    picker.open({ anchor, initial: '#ff0000', contrastAgainst: null, onPick: vi.fn() })
    const sv = picker.root.querySelector('.cp-sv') as HTMLElement
    sv.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, clientX: 10, clientY: 10 }))
    const removeSpy = vi.spyOn(window, 'removeEventListener')
    picker.destroy()
    expect(removeSpy).toHaveBeenCalledWith('mousemove', expect.any(Function))
    expect(removeSpy).toHaveBeenCalledWith('mouseup', expect.any(Function))
  })

  it('hue slider input drafts the hue and emits an updated rgb', () => {
    const { picker } = setupPicker()
    const anchor = anchorEl()
    const onPick = vi.fn()
    picker.open({ anchor, initial: '#ff0000', contrastAgainst: null, onPick })
    const hue = picker.root.querySelector('.cp-hue') as HTMLInputElement
    hue.value = '120'
    hue.dispatchEvent(new Event('input', { bubbles: true }))
    const [css] = onPick.mock.calls.at(-1)!
    expect(css).toBe('rgb(0, 255, 0)')
  })

  it('emits rgba(...) when the initial color had alpha < 1', () => {
    const { picker } = setupPicker()
    const anchor = anchorEl()
    const onPick = vi.fn()
    picker.open({ anchor, initial: 'rgba(255, 0, 0, 0.5)', contrastAgainst: null, onPick })
    const hue = picker.root.querySelector('.cp-hue') as HTMLInputElement
    hue.value = '120'
    hue.dispatchEvent(new Event('input', { bubbles: true }))
    const [css] = onPick.mock.calls.at(-1)!
    expect(css).toMatch(/^rgba\(0, 255, 0, 0\.5\)$/)
  })

  it('open() scrolls the popover into view (guarded for jsdom), final review fix #7', () => {
    const { picker } = setupPicker()
    const anchor = anchorEl()
    const scrollSpy = vi.fn()
    ;(picker.root as unknown as { scrollIntoView: typeof scrollSpy }).scrollIntoView = scrollSpy
    picker.open({ anchor, initial: '#ff0000', contrastAgainst: null, onPick: vi.fn() })
    expect(scrollSpy).toHaveBeenCalledWith({ block: 'nearest' })
  })

  it('open() does not throw when the popover root lacks scrollIntoView (plain jsdom element)', () => {
    const { picker } = setupPicker()
    const anchor = anchorEl()
    expect(() => picker.open({ anchor, initial: '#ff0000', contrastAgainst: null, onPick: vi.fn() })).not.toThrow()
  })
})
