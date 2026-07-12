// @vitest-environment jsdom
import { describe, it, expect, beforeEach, vi } from 'vitest'
import {
  clampScale, zoomAt, panBy, fitState, fitRectState, loadCanvasPrefs, saveCanvasPrefs,
  zoomStopAfter, zoomStopBefore,
  MIN_SCALE, MAX_SCALE, CANVAS_STORAGE_KEY, FIT_MARGIN, WHEEL_LINE_PX, ZOOM_WHEEL_CLAMP,
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

describe('fitRectState', () => {
  it('centers an offset page rect in the available box (zoom-to-selection math)', () => {
    const rect = { x: 100, y: 100, w: 200, h: 100 }
    const s = fitRectState(1024, 768, rect, 320)
    const availW = 1024 - 320 - FIT_MARGIN * 2
    const availH = 768 - FIT_MARGIN * 2
    expect(s.scale).toBeCloseTo(Math.min(availW / 200, availH / 100))
    // the rect's center must project to the available box's center
    const cx = (rect.x + rect.w / 2) * s.scale + s.x
    const cy = (rect.y + rect.h / 2) * s.scale + s.y
    expect(cx).toBeCloseTo(FIT_MARGIN + availW / 2)
    expect(cy).toBeCloseTo(FIT_MARGIN + availH / 2)
  })
  it('fitState is the whole-page special case of fitRectState', () => {
    expect(fitState(1280, 800, 1280, 4000, 320))
      .toEqual(fitRectState(1280, 800, { x: 0, y: 0, w: 1280, h: 4000 }, 320))
  })
})

describe('zoom ladder (Figma powers-of-2 stops)', () => {
  it('steps up and down through powers of two', () => {
    expect(zoomStopAfter(1)).toBe(2)
    expect(zoomStopBefore(1)).toBe(0.5)
    expect(zoomStopAfter(1.5)).toBe(2)
    expect(zoomStopBefore(1.5)).toBe(1)
    expect(zoomStopAfter(0.3)).toBe(0.5)
    expect(zoomStopBefore(0.3)).toBe(0.25)
  })
  it('clamps at the scale bounds', () => {
    expect(zoomStopAfter(MAX_SCALE)).toBe(MAX_SCALE)
    expect(zoomStopBefore(0.125)).toBe(MIN_SCALE) // 2^-4 = 0.0625 clamps up to 0.1
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
    // the click right after a pan-drag must not reach the page (selection would fire).
    // Body-dispatched so the path is window → document → body: the window-capture squelch
    // must be what stops it before the document-capture spy (a window-dispatched click
    // never reaches document at all, which would pass this vacuously).
    const click = new MouseEvent('click', { bubbles: true, cancelable: true })
    const reached = vi.fn()
    document.addEventListener('click', reached, true)
    document.body.dispatchEvent(click)
    expect(reached).not.toHaveBeenCalled()
    expect(click.defaultPrevented).toBe(true)
    document.removeEventListener('click', reached, true)
    canvas.setOn(false)
  })

  it('wheel pan during a space-drag survives the next pointermove (live-state panning)', () => {
    const { canvas } = makeCanvas()
    canvas.setOn(true)
    window.dispatchEvent(new KeyboardEvent('keydown', { code: 'Space', bubbles: true }))
    window.dispatchEvent(new MouseEvent('pointerdown', { clientX: 100, clientY: 100, button: 0, bubbles: true, cancelable: true }))
    // A wheel pan lands mid-drag — its delta must not be reverted by the next pointermove.
    window.dispatchEvent(new WheelEvent('wheel', { deltaX: 5, deltaY: 7, cancelable: true, bubbles: true }))
    window.dispatchEvent(new MouseEvent('pointermove', { clientX: 130, clientY: 80, bubbles: true }))
    window.dispatchEvent(new MouseEvent('pointerup', { bubbles: true }))
    window.dispatchEvent(new KeyboardEvent('keyup', { code: 'Space', bubbles: true }))
    // wheel: (-5, -7) + drag: (+30, -20) = (25, -27)
    expect(bodyTransform()).toBe('translate(25px, -27px) scale(1)')
    // consume the one-shot squelch this pan-drag armed (a real browser always fires the
    // click right after pointerup; jsdom doesn't, so it would leak into the next test)
    const eaten = new MouseEvent('click', { bubbles: true, cancelable: true })
    window.dispatchEvent(eaten)
    expect(eaten.defaultPrevented).toBe(true)
    canvas.setOn(false)
  })

  it('pointercancel ends the drag WITHOUT arming the squelch — a later click passes through', () => {
    const { canvas } = makeCanvas()
    canvas.setOn(true)
    window.dispatchEvent(new KeyboardEvent('keydown', { code: 'Space', bubbles: true }))
    window.dispatchEvent(new MouseEvent('pointerdown', { clientX: 100, clientY: 100, button: 0, bubbles: true, cancelable: true }))
    window.dispatchEvent(new MouseEvent('pointermove', { clientX: 130, clientY: 80, bubbles: true }))
    window.dispatchEvent(new MouseEvent('pointercancel', { bubbles: true }))
    window.dispatchEvent(new KeyboardEvent('keyup', { code: 'Space', bubbles: true }))
    // pointercancel means the browser never fires a click for this gesture — an unrelated
    // later click must NOT be eaten. Dispatch on body (not window): a window-targeted
    // event's propagation path is just window, so it would never reach a document-capture
    // spy and the assertion would be vacuous.
    const reached = vi.fn()
    document.addEventListener('click', reached, true)
    document.body.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }))
    expect(reached).toHaveBeenCalledTimes(1)
    document.removeEventListener('click', reached, true)
    // and the drag itself is dead: a stray pointermove after cancel changes nothing
    const before = bodyTransform()
    window.dispatchEvent(new MouseEvent('pointermove', { clientX: 500, clientY: 500, bubbles: true }))
    expect(bodyTransform()).toBe(before)
    canvas.setOn(false)
  })

  it('setOn(false) mid-drag tears the drag down — no transform written onto the restored page', () => {
    const { canvas } = makeCanvas()
    canvas.setOn(true)
    window.dispatchEvent(new KeyboardEvent('keydown', { code: 'Space', bubbles: true }))
    window.dispatchEvent(new MouseEvent('pointerdown', { clientX: 100, clientY: 100, button: 0, bubbles: true, cancelable: true }))
    window.dispatchEvent(new MouseEvent('pointermove', { clientX: 130, clientY: 80, bubbles: true }))
    canvas.setOn(false) // exits with the drag still in flight
    expect(bodyTransform()).toBe('')
    window.dispatchEvent(new MouseEvent('pointermove', { clientX: 300, clientY: 300, bubbles: true }))
    expect(bodyTransform()).toBe('') // the dead drag must not write onto the restored page
    // and the teardown must not have armed a squelch either (body-dispatched — see the
    // pointercancel test for why window.dispatchEvent would make this vacuous)
    const reached = vi.fn()
    document.addEventListener('click', reached, true)
    document.body.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }))
    expect(reached).toHaveBeenCalledTimes(1)
    document.removeEventListener('click', reached, true)
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

describe('CanvasMode gesture-end persistence (2026-07-11 review: split paint from persist)', () => {
  beforeEach(() => {
    sessionStorage.clear()
    document.documentElement.removeAttribute('style')
    document.body.removeAttribute('style')
    vi.stubGlobal('scrollTo', vi.fn())
  })

  it('wheel pan does not persist synchronously; a trailing debounce persists it at rest', () => {
    vi.useFakeTimers()
    const { canvas } = makeCanvas()
    canvas.setOn(true) // discrete action — persists synchronously
    const beforePan = loadCanvasPrefs()
    const pan = new WheelEvent('wheel', { deltaX: 10, deltaY: 40, cancelable: true, bubbles: true })
    window.dispatchEvent(pan)
    // The tick itself paints (setState) but must not have written storage yet.
    expect(loadCanvasPrefs()).toEqual(beforePan)
    vi.advanceTimersByTime(250)
    const after = loadCanvasPrefs()
    expect(after.state.x).toBe(-10)
    expect(after.state.y).toBe(-40)
    canvas.setOn(false)
    vi.useRealTimers()
  })

  it('suspend() flushes an un-flushed wheel debounce and persists the latest state', () => {
    vi.useFakeTimers()
    const { canvas } = makeCanvas()
    canvas.setOn(true)
    const pan = new WheelEvent('wheel', { deltaX: 10, deltaY: 40, cancelable: true, bubbles: true })
    window.dispatchEvent(pan) // setState fires, wheel's trailing debounce armed but NOT yet fired
    canvas.suspend() // removeListeners() must flush the pending debounce; unapply() persists too
    const saved = loadCanvasPrefs()
    expect(saved.state.x).toBe(-10)
    expect(saved.state.y).toBe(-40)
    vi.useRealTimers()
  })
})

describe('CanvasMode onChange notifies exactly once per action (2026-07-11 review: single-site notification)', () => {
  beforeEach(() => {
    sessionStorage.clear()
    document.documentElement.removeAttribute('style')
    document.body.removeAttribute('style')
    vi.stubGlobal('scrollTo', vi.fn())
  })

  it('setOn(true), suspend(), resume(), setOn(false) each fire onChange exactly once', () => {
    let calls = 0
    const { canvas } = makeCanvas({ onChange: () => { calls++ } })
    canvas.setOn(true)
    expect(calls).toBe(1)
    canvas.suspend()
    expect(calls).toBe(2)
    canvas.resume()
    expect(calls).toBe(3)
    canvas.setOn(false)
    expect(calls).toBe(4)
  })
})

describe('CanvasMode Figma-parity pass (2026-07-11 optimization review)', () => {
  beforeEach(() => {
    sessionStorage.clear()
    document.documentElement.removeAttribute('style')
    document.body.removeAttribute('style')
    vi.stubGlobal('scrollTo', vi.fn())
    Object.defineProperty(window, 'scrollX', { value: 0, configurable: true })
    Object.defineProperty(window, 'scrollY', { value: 0, configurable: true })
  })

  it('normalizes DOM_DELTA_LINE wheel deltas (Firefox mouse wheel) to pixels', () => {
    const { canvas } = makeCanvas()
    canvas.setOn(true)
    window.dispatchEvent(new WheelEvent('wheel', { deltaY: 3, deltaMode: 1, cancelable: true, bubbles: true }))
    expect(bodyTransform()).toBe(`translate(0px, ${-3 * WHEEL_LINE_PX}px) scale(1)`)
    canvas.setOn(false)
  })

  it('shift+wheel pans horizontally when the device reports only deltaY', () => {
    const { canvas } = makeCanvas()
    canvas.setOn(true)
    window.dispatchEvent(new WheelEvent('wheel', { deltaY: 40, shiftKey: true, cancelable: true, bubbles: true }))
    expect(bodyTransform()).toBe('translate(-40px, 0px) scale(1)')
    // a device that already remaps to deltaX is left alone (no double-swap)
    window.dispatchEvent(new WheelEvent('wheel', { deltaX: 10, shiftKey: true, cancelable: true, bubbles: true }))
    expect(bodyTransform()).toBe('translate(-50px, 0px) scale(1)')
    canvas.setOn(false)
  })

  it('caps a discrete mouse notch: ctrl+wheel deltaY −1000 zooms exp(clamp·0.01), not exp(10)', () => {
    const { canvas } = makeCanvas()
    canvas.setOn(true)
    window.dispatchEvent(new WheelEvent('wheel', { deltaY: -1000, ctrlKey: true, clientX: 0, clientY: 0, cancelable: true, bubbles: true }))
    expect(canvas.scale()).toBeCloseTo(Math.exp(ZOOM_WHEEL_CLAMP * 0.01), 5)
    canvas.setOn(false)
  })

  it('at the zoom clamp, further zoom-in wheel ticks fire no onChange (no-op repaints skipped)', () => {
    let calls = 0
    const { canvas } = makeCanvas({ onChange: () => { calls++ } })
    canvas.setOn(true)
    canvas.setZoomCentered(MAX_SCALE)
    const before = calls
    window.dispatchEvent(new WheelEvent('wheel', { deltaY: -100, ctrlKey: true, clientX: 0, clientY: 0, cancelable: true, bubbles: true }))
    expect(calls).toBe(before)
    expect(canvas.scale()).toBe(MAX_SCALE)
    canvas.setOn(false)
  })

  it('bare +/− step the powers-of-2 ladder; Cmd/Ctrl-modified zoom keys stay the browser’s', () => {
    const { canvas } = makeCanvas()
    canvas.setOn(true)
    window.dispatchEvent(new KeyboardEvent('keydown', { code: 'Equal', bubbles: true, cancelable: true }))
    expect(canvas.scale()).toBe(2)
    window.dispatchEvent(new KeyboardEvent('keydown', { code: 'Minus', bubbles: true, cancelable: true }))
    expect(canvas.scale()).toBe(1)
    const browserZoom = new KeyboardEvent('keydown', { code: 'Equal', metaKey: true, bubbles: true, cancelable: true })
    window.dispatchEvent(browserZoom)
    expect(canvas.scale()).toBe(1)
    expect(browserZoom.defaultPrevented).toBe(false)
    canvas.setOn(false)
  })

  it('Shift+2 fits the selection; no-op when nothing is selected', () => {
    let rect: { left: number; top: number; width: number; height: number } | null = null
    const { canvas } = makeCanvas({ selectionRect: () => rect })
    canvas.setOn(true)
    window.dispatchEvent(new KeyboardEvent('keydown', { code: 'Digit2', shiftKey: true, bubbles: true }))
    expect(canvas.scale()).toBe(1) // nothing selected → untouched
    rect = { left: 100, top: 100, width: 200, height: 100 }
    window.dispatchEvent(new KeyboardEvent('keydown', { code: 'Digit2', shiftKey: true, bubbles: true }))
    // state was identity, so the viewport rect IS the page rect — must match the pure math
    const expected = fitRectState(
      window.innerWidth, window.innerHeight, { x: 100, y: 100, w: 200, h: 100 }, 320
    )
    expect(canvas.scale()).toBeCloseTo(expected.scale)
    expect(bodyTransform()).toBe(`translate(${expected.x}px, ${expected.y}px) scale(${expected.scale})`)
    canvas.setOn(false)
  })

  it('middle-button drag pans without space and does NOT squelch the next click', () => {
    const { canvas } = makeCanvas()
    canvas.setOn(true)
    window.dispatchEvent(new MouseEvent('pointerdown', { clientX: 100, clientY: 100, button: 1, bubbles: true, cancelable: true }))
    window.dispatchEvent(new MouseEvent('pointermove', { clientX: 130, clientY: 80, bubbles: true }))
    window.dispatchEvent(new MouseEvent('pointerup', { bubbles: true }))
    expect(bodyTransform()).toBe('translate(30px, -20px) scale(1)')
    // middle release fires auxclick, not click — an unrelated click must pass through
    const reached = vi.fn()
    document.addEventListener('click', reached, true)
    document.body.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }))
    expect(reached).toHaveBeenCalledTimes(1)
    document.removeEventListener('click', reached, true)
    canvas.setOn(false)
  })

  it('hand cursor: grab on space, grabbing while dragging, page cursor restored after', () => {
    document.documentElement.style.cursor = 'crosshair' // page's own inline cursor survives
    const { canvas } = makeCanvas()
    canvas.setOn(true)
    window.dispatchEvent(new KeyboardEvent('keydown', { code: 'Space', bubbles: true }))
    expect(document.documentElement.style.cursor).toBe('grab')
    window.dispatchEvent(new MouseEvent('pointerdown', { clientX: 0, clientY: 0, button: 0, bubbles: true, cancelable: true }))
    expect(document.documentElement.style.cursor).toBe('grabbing')
    window.dispatchEvent(new MouseEvent('pointerup', { bubbles: true }))
    expect(document.documentElement.style.cursor).toBe('grab') // space still held
    window.dispatchEvent(new KeyboardEvent('keyup', { code: 'Space', bubbles: true }))
    expect(document.documentElement.style.cursor).toBe('crosshair')
    canvas.setOn(false)
    expect(document.documentElement.style.cursor).toBe('crosshair')
    document.documentElement.style.cursor = ''
    // consume the squelch the drag armed (jsdom never fires the post-pointerup click itself)
    window.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }))
  })

  it('promotes the artboard to a compositor layer while on (will-change) and restores it', () => {
    document.body.style.willChange = 'opacity'
    const { canvas } = makeCanvas()
    canvas.setOn(true)
    expect(document.body.style.willChange).toBe('transform')
    canvas.setOn(false)
    expect(document.body.style.willChange).toBe('opacity')
    document.body.style.willChange = ''
  })

  it('Safari pinch rides gesturestart/gesturechange when GestureEvent exists', () => {
    ;(window as unknown as { GestureEvent?: unknown }).GestureEvent = function GestureEvent() {}
    try {
      const { canvas } = makeCanvas()
      canvas.setOn(true) // listeners registered with the feature detect satisfied
      window.dispatchEvent(Object.assign(new Event('gesturestart', { cancelable: true, bubbles: true }), {
        clientX: 0, clientY: 0, scale: 1,
      }))
      const change = Object.assign(new Event('gesturechange', { cancelable: true, bubbles: true }), {
        clientX: 0, clientY: 0, scale: 2,
      })
      window.dispatchEvent(change)
      expect(change.defaultPrevented).toBe(true)
      expect(canvas.scale()).toBe(2) // cumulative: gesture-start scale (1) × e.scale (2)
      canvas.setOn(false)
    } finally {
      delete (window as unknown as { GestureEvent?: unknown }).GestureEvent
    }
  })
})
