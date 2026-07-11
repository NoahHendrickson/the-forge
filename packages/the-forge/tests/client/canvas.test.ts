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
