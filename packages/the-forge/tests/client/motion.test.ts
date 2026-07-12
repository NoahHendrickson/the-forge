// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from 'vitest'
import {
  DUR_FAST_MS, DUR_POP_MS, DUR_PANEL_MS, EASE_SPRING, EASE_OUT,
  prefersReducedMotion, popOnce, collapseRow,
} from '../../src/client/motion'

afterEach(() => vi.restoreAllMocks())

function stubReducedMotion(matches: boolean): void {
  vi.spyOn(window, 'matchMedia').mockReturnValue({ matches } as MediaQueryList)
}

describe('motion constants', () => {
  it('durations are ordered fast < pop < panel and all under 300ms', () => {
    expect(DUR_FAST_MS).toBeLessThan(DUR_POP_MS)
    expect(DUR_POP_MS).toBeLessThan(DUR_PANEL_MS)
    expect(DUR_PANEL_MS).toBeLessThanOrEqual(300)
  })
  it('spring is a linear() curve that starts at 0, ends settled at 1, peaks ≤ 1.02', () => {
    expect(EASE_SPRING.startsWith('linear(0,')).toBe(true)
    expect(EASE_SPRING.trimEnd().endsWith('1)')).toBe(true)
    const stops = [...EASE_SPRING.matchAll(/([\d.]+)(?: \d+%)?/g)].map((m) => Number(m[1]))
    expect(Math.max(...stops)).toBeLessThanOrEqual(1.02)
    expect(EASE_OUT.startsWith('cubic-bezier(')).toBe(true)
  })
})

describe('prefersReducedMotion', () => {
  it('mirrors the media query', () => {
    stubReducedMotion(true)
    expect(prefersReducedMotion()).toBe(true)
    stubReducedMotion(false)
    expect(prefersReducedMotion()).toBe(false)
  })
})

describe('popOnce', () => {
  it('re-arms the class so a repeat call can replay the animation', () => {
    stubReducedMotion(false)
    const el = document.createElement('button')
    popOnce(el)
    expect(el.classList.contains('pop')).toBe(true)
    popOnce(el) // must not throw and must leave the class re-applied
    expect(el.classList.contains('pop')).toBe(true)
  })
  it('does nothing under reduced motion', () => {
    stubReducedMotion(true)
    const el = document.createElement('button')
    popOnce(el)
    expect(el.classList.contains('pop')).toBe(false)
  })
})

describe('collapseRow', () => {
  it('fires onDone via the timeout fallback (jsdom never fires transitionend)', () => {
    stubReducedMotion(false)
    vi.useFakeTimers()
    const row = document.createElement('div')
    document.body.appendChild(row)
    const done = vi.fn()
    collapseRow(row, done)
    expect(row.style.height).toBe('0px')
    expect(row.style.opacity).toBe('0')
    expect(done).not.toHaveBeenCalled()
    vi.advanceTimersByTime(DUR_FAST_MS + 100)
    expect(done).toHaveBeenCalledTimes(1)
    vi.advanceTimersByTime(1000) // transitionend after timeout must not double-fire
    row.dispatchEvent(new Event('transitionend'))
    expect(done).toHaveBeenCalledTimes(1)
    vi.useRealTimers()
  })
  it('fires onDone synchronously under reduced motion', () => {
    stubReducedMotion(true)
    const row = document.createElement('div')
    const done = vi.fn()
    collapseRow(row, done)
    expect(done).toHaveBeenCalledTimes(1)
  })
})
