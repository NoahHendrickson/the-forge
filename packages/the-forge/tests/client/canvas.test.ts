// @vitest-environment jsdom
import { describe, it, expect, beforeEach, vi } from 'vitest'
import {
  clampScale, zoomAt, panBy, fitState, loadCanvasPrefs, saveCanvasPrefs,
  MIN_SCALE, MAX_SCALE, CANVAS_STORAGE_KEY, FIT_MARGIN,
  CanvasMode, type CanvasModeOpts,
} from '../../src/client/canvas'

describe('clampScale', () => {
  it('clamps to [MIN_SCALE, MAX_SCALE]', () => {
    expect(clampScale(0.01)).toBe(MIN_SCALE)
    expect(clampScale(99)).toBe(MAX_SCALE)
    expect(clampScale(1.5)).toBe(1.5)
  })
})

describe('zoomAt', () => {
  it('holds the page-point under the cursor fixed (the zoom invariant)', () => {
    const s0 = { x: -100, y: -50, scale: 1 }
    const cx = 400, cy = 300
    const s1 = zoomAt(s0, cx, cy, 2)
    // page point under cursor before: p = (c - t)/s
    const px = (cx - s0.x) / s0.scale
    const py = (cy - s0.y) / s0.scale
    // after: same page point must project back to the cursor
    expect(px * s1.scale + s1.x).toBeCloseTo(cx)
    expect(py * s1.scale + s1.y).toBeCloseTo(cy)
    expect(s1.scale).toBe(2)
  })
  it('clamps the requested scale', () => {
    expect(zoomAt({ x: 0, y: 0, scale: 1 }, 0, 0, 100).scale).toBe(MAX_SCALE)
  })
})

describe('panBy', () => {
  it('shifts translate, leaves scale alone', () => {
    expect(panBy({ x: 10, y: 20, scale: 2 }, -5, 15)).toEqual({ x: 5, y: 35, scale: 2 })
  })
})

describe('fitState', () => {
  it('fits a tall page fully inside the viewport minus panel and margins, centered', () => {
    const s = fitState(1280, 800, 1280, 4000, 320)
    const availW = 1280 - 320 - FIT_MARGIN * 2
    const availH = 800 - FIT_MARGIN * 2
    expect(s.scale).toBeCloseTo(Math.min(availW / 1280, availH / 4000))
    // whole artboard inside the available box
    expect(s.x).toBeGreaterThanOrEqual(FIT_MARGIN)
    expect(s.y).toBeCloseTo(FIT_MARGIN)
    expect(4000 * s.scale + s.y).toBeLessThanOrEqual(800 - FIT_MARGIN + 0.5)
  })
  it('never returns a scale below MIN_SCALE even for absurdly tall pages', () => {
    expect(fitState(1280, 800, 1280, 100000, 320).scale).toBe(MIN_SCALE)
  })
})

describe('canvas prefs', () => {
  beforeEach(() => sessionStorage.clear())
  it('defaults when nothing stored', () => {
    expect(loadCanvasPrefs()).toEqual({ on: false, state: { x: 0, y: 0, scale: 1 } })
  })
  it('round-trips', () => {
    saveCanvasPrefs({ on: true, state: { x: -12, y: -300, scale: 0.5 } })
    expect(loadCanvasPrefs()).toEqual({ on: true, state: { x: -12, y: -300, scale: 0.5 } })
  })
  it('survives garbage and clamps scale', () => {
    sessionStorage.setItem(CANVAS_STORAGE_KEY, '{"on":"yes","state":{"x":"a","scale":9000}}')
    const p = loadCanvasPrefs()
    expect(p.on).toBe(false)
    expect(p.state).toEqual({ x: 0, y: 0, scale: MAX_SCALE })
    sessionStorage.setItem(CANVAS_STORAGE_KEY, 'not json')
    expect(loadCanvasPrefs().on).toBe(false)
  })
})

function makeCanvas(over: Partial<CanvasModeOpts> = {}): { canvas: CanvasMode; dockCalls: boolean[] } {
  const dockCalls: boolean[] = []
  const canvas = new CanvasMode({
    dock: { setCanvasActive: (on) => dockCalls.push(on), mode: () => 'docked', width: () => 320 },
    hostContains: () => false,
    onChange: () => {},
    ...over,
  })
  return { canvas, dockCalls }
}

describe('CanvasMode enter/exit', () => {
  // jsdom doesn't implement window.scrollTo — unapply() always calls it, so tests that
  // don't stub it themselves (test 3 does, via vi.stubGlobal + vi.unstubAllGlobals) need
  // a shared stub here or jsdom logs a "Not implemented" error and pollutes test output.
  beforeEach(() => {
    sessionStorage.clear()
    document.documentElement.removeAttribute('style')
    document.body.removeAttribute('style')
    vi.stubGlobal('scrollTo', vi.fn())
  })

  it('setOn(true) freezes scroll, transforms body, tells the dock; setOn(false) restores verbatim', () => {
    document.body.style.transform = 'skew(1deg)'      // page's own inline styles must survive
    document.documentElement.style.overflow = 'auto'
    const { canvas, dockCalls } = makeCanvas()
    canvas.setOn(true)
    expect(document.documentElement.style.overflow).toBe('hidden')
    expect(document.body.style.transform).toMatch(/translate\(.*\) scale\(1\)/)
    expect(document.body.style.transformOrigin).toBe('0 0')
    expect(dockCalls).toEqual([true])
    canvas.setOn(false)
    expect(document.body.style.transform).toBe('skew(1deg)')
    expect(document.documentElement.style.overflow).toBe('auto')
    expect(dockCalls).toEqual([true, false])
  })

  it('entry is seeded from the current scroll position (pixel-identical)', () => {
    Object.defineProperty(window, 'scrollY', { value: 250, configurable: true })
    Object.defineProperty(window, 'scrollX', { value: 0, configurable: true })
    const { canvas } = makeCanvas()
    canvas.setOn(true)
    expect(document.body.style.transform).toBe('translate(0px, -250px) scale(1)')
    canvas.setOn(false)
  })

  it('exit scrolls to the page-point at the viewport top-left', () => {
    const scrollTo = vi.fn()
    vi.stubGlobal('scrollTo', scrollTo)
    const { canvas } = makeCanvas()
    canvas.setOn(true)
    canvas.setZoomCentered(0.5) // some non-trivial state
    canvas.setOn(false)
    const [x, y] = scrollTo.mock.calls[0] as [number, number]
    expect(x).toBeGreaterThanOrEqual(0)
    expect(y).toBeGreaterThanOrEqual(0)
    vi.unstubAllGlobals()
  })

  it('suspend() restores the page but keeps the pref; resume() re-applies it', () => {
    const { canvas } = makeCanvas()
    canvas.setOn(true)
    canvas.suspend()
    expect(document.body.style.transform).toBe('')
    expect(canvas.isOn()).toBe(true)
    expect(canvas.isApplied()).toBe(false)
    canvas.resume()
    expect(canvas.isApplied()).toBe(true)
    canvas.setOn(false)
  })

  it('resume() with the pref off does nothing', () => {
    const { canvas } = makeCanvas()
    canvas.resume()
    expect(canvas.isApplied()).toBe(false)
    expect(document.body.style.transform).toBe('')
  })

  it('persists on/state so a reload restores the same view', () => {
    const { canvas } = makeCanvas()
    canvas.setOn(true)
    canvas.setZoomCentered(2)
    const saved = loadCanvasPrefs()
    expect(saved.on).toBe(true)
    expect(saved.state.scale).toBe(2)
    canvas.setOn(false)
  })

  it('falls back to white when NEITHER html nor body has a background (unset computes to rgba(0,0,0,0), never "")', () => {
    const { canvas } = makeCanvas()
    canvas.setOn(true)
    // jsdom normalizes an inline '#ffffff' assignment to 'rgb(255, 255, 255)'
    expect(document.body.style.backgroundColor).toBe('rgb(255, 255, 255)')
    canvas.setOn(false)
    expect(document.body.style.backgroundColor).toBe('')
  })

  it('copies the html background onto a transparent body so the artboard is not gray', () => {
    document.documentElement.style.backgroundColor = 'rgb(20, 20, 30)'
    const { canvas } = makeCanvas()
    canvas.setOn(true)
    expect(document.body.style.backgroundColor).toBe('rgb(20, 20, 30)')
    canvas.setOn(false)
    expect(document.body.style.backgroundColor).toBe('')
    document.documentElement.style.backgroundColor = ''
  })
})

function bodyTransform(): string { return document.body.style.transform }

describe('CanvasMode interactions', () => {
  beforeEach(() => {
    sessionStorage.clear()
    document.documentElement.removeAttribute('style')
    document.body.removeAttribute('style')
    vi.stubGlobal('scrollTo', vi.fn())
    // A prior describe block's test redefines window.scrollY/scrollX (configurable: true)
    // and never restores them — reset here so setOn(true)'s scroll-seed is deterministic
    // regardless of run order within this file.
    Object.defineProperty(window, 'scrollX', { value: 0, configurable: true })
    Object.defineProperty(window, 'scrollY', { value: 0, configurable: true })
  })

  it('plain wheel pans; ctrl-wheel zooms toward the cursor; both prevented', () => {
    const { canvas } = makeCanvas()
    canvas.setOn(true) // seeds translate(0px, 0px) scale(1) at scroll 0
    const pan = new WheelEvent('wheel', { deltaX: 10, deltaY: 40, cancelable: true, bubbles: true })
    window.dispatchEvent(pan)
    expect(pan.defaultPrevented).toBe(true)
    expect(bodyTransform()).toBe('translate(-10px, -40px) scale(1)')
    const zoom = new WheelEvent('wheel', { deltaY: -100, ctrlKey: true, clientX: 0, clientY: 0, cancelable: true, bubbles: true })
    window.dispatchEvent(zoom)
    expect(zoom.defaultPrevented).toBe(true)
    expect(bodyTransform()).toContain('scale(') // scale changed
    expect(canvas.scale()).toBeGreaterThan(1)
    canvas.setOn(false)
  })

  it('wheel inside the overlay host passes through untouched', () => {
    const { canvas } = makeCanvas({ hostContains: () => true })
    canvas.setOn(true)
    const e = new WheelEvent('wheel', { deltaY: 40, cancelable: true, bubbles: true })
    window.dispatchEvent(e)
    expect(e.defaultPrevented).toBe(false)
    expect(bodyTransform()).toBe('translate(0px, 0px) scale(1)')
    canvas.setOn(false)
  })

  it('Shift+0 → 100%, Shift+1 → fit; both skipped when focus is editable', () => {
    const { canvas } = makeCanvas()
    canvas.setOn(true)
    canvas.setZoomCentered(2)
    window.dispatchEvent(new KeyboardEvent('keydown', { code: 'Digit0', shiftKey: true, bubbles: true }))
    expect(canvas.scale()).toBe(1)
    window.dispatchEvent(new KeyboardEvent('keydown', { code: 'Digit1', shiftKey: true, bubbles: true }))
    // jsdom has no layout: body scrollWidth/Height are 0, so fitState clamps to MAX_SCALE.
    // This asserts the key ROUTED to zoomToFit (scale left 1) — fit geometry is E2E's job.
    expect(canvas.scale()).toBe(MAX_SCALE)
    const input = document.createElement('input')
    document.body.appendChild(input)
    canvas.setZoomCentered(2)
    input.dispatchEvent(new KeyboardEvent('keydown', { code: 'Digit0', shiftKey: true, bubbles: true }))
    expect(canvas.scale()).toBe(2)
    input.remove()
    canvas.setOn(false)
  })

  it('space+drag pans and squelches the click that would select', () => {
    const { canvas } = makeCanvas()
    canvas.setOn(true)
    window.dispatchEvent(new KeyboardEvent('keydown', { code: 'Space', bubbles: true }))
    // jsdom (pinned ^25.0.0 here) has no PointerEvent constructor; dock.test.ts/panel.test.ts
    // establish the codebase idiom for this — dispatch a MouseEvent with the pointer type
    // string, since addEventListener('pointerdown', ...) matches by type, not constructor.
    window.dispatchEvent(new MouseEvent('pointerdown', { clientX: 100, clientY: 100, button: 0, bubbles: true, cancelable: true }))
    window.dispatchEvent(new MouseEvent('pointermove', { clientX: 130, clientY: 80, bubbles: true }))
    window.dispatchEvent(new MouseEvent('pointerup', { bubbles: true }))
    window.dispatchEvent(new KeyboardEvent('keyup', { code: 'Space', bubbles: true }))
    expect(bodyTransform()).toBe('translate(30px, -20px) scale(1)')
    // the click right after a pan-drag must not reach the page (selection would fire)
    const click = new MouseEvent('click', { bubbles: true, cancelable: true })
    const reached = vi.fn()
    document.addEventListener('click', reached, true)
    window.dispatchEvent(click)
    expect(reached).not.toHaveBeenCalled()
    document.removeEventListener('click', reached, true)
    canvas.setOn(false)
  })

  it('listeners are fully gone after setOn(false) — zero idle overhead', () => {
    const { canvas } = makeCanvas()
    canvas.setOn(true)
    canvas.setOn(false)
    const e = new WheelEvent('wheel', { deltaY: 40, cancelable: true, bubbles: true })
    window.dispatchEvent(e)
    expect(e.defaultPrevented).toBe(false)
    expect(bodyTransform()).toBe('')
  })
})
