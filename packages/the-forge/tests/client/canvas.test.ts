// @vitest-environment jsdom
import { describe, it, expect, beforeEach } from 'vitest'
import {
  clampScale, zoomAt, panBy, fitState, loadCanvasPrefs, saveCanvasPrefs,
  MIN_SCALE, MAX_SCALE, CANVAS_STORAGE_KEY, FIT_MARGIN,
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
