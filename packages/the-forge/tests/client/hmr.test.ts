// @vitest-environment jsdom
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { HmrSignal } from '../../src/client/hmr'

beforeEach(() => {
  document.body.innerHTML = ''
  document.head.innerHTML = ''
  vi.useFakeTimers()
})

afterEach(() => {
  vi.useRealTimers()
  vi.unstubAllGlobals()
})

// Injects the Vite client script tag — since the PR #44 review, the tag alone no longer
// latches HmrSignal's Vite-ness (a matching tag with a dead import probe must degrade to
// accept-equality, never strand rows); it only supplies the probe's import specifier. In
// jsdom the dynamic import always rejects, so tests establish Vite-ness the definitive way:
// an observed vite:afterUpdate event (fireViteUpdate) BEFORE the cursor under test.
function markVitePage(): void {
  const script = document.createElement('script')
  script.src = '/@vite/client'
  document.head.appendChild(script)
}

function fireViteUpdate(): void {
  window.dispatchEvent(new Event('vite:afterUpdate'))
}

/** vite:afterUpdate carrying its real payload shape ({updates: [{acceptedPath}]}) via
 * CustomEvent detail — lets tests pin the per-file trust scoping. */
function fireViteUpdateFor(...paths: string[]): void {
  window.dispatchEvent(
    new CustomEvent('vite:afterUpdate', { detail: { type: 'update', updates: paths.map((p) => ({ acceptedPath: p, path: p })) } })
  )
}

describe('HmrSignal', () => {
  it('trusts everything on a non-Vite page (no client script, no events)', () => {
    const hmr = new HmrSignal()
    hmr.start()
    expect(hmr.trustSince(hmr.mark())).toBe(true)
    hmr.stop()
  })

  it('on a Vite page (an update was observed), trustSince requires an update AFTER the cursor', () => {
    markVitePage()
    const hmr = new HmrSignal()
    hmr.start()
    fireViteUpdate() // definitive latch — the tag alone no longer gates (see markVitePage)
    const cursor = hmr.mark()
    expect(hmr.trustSince(cursor)).toBe(false)
    fireViteUpdate()
    expect(hmr.trustSince(cursor)).toBe(true)
    expect(hmr.trustSince(hmr.mark())).toBe(false) // new cursor — update already consumed
    hmr.stop()
  })

  it('a matching client tag with a dead import probe does NOT gate — degrade, never strand', () => {
    // The PR #44 review's non-root-base class of bug: tag src matches the substring sniff
    // while the probe import can never attach a listener (jsdom's import always rejects,
    // standing in for the 404). Equality must stay trusted — accept-equality degrade.
    markVitePage()
    const hmr = new HmrSignal()
    hmr.start()
    expect(hmr.trustSince(hmr.mark())).toBe(true)
    hmr.stop()
  })

  it('trustSince scopes to the edited file when update paths are known', () => {
    const hmr = new HmrSignal()
    hmr.start()
    fireViteUpdate() // latch Vite-ness
    const cursor = hmr.mark()
    fireViteUpdateFor('/src/Hero.tsx')
    // An unrelated element's update must not vouch for src/Footer.tsx…
    expect(hmr.trustSince(cursor, 'src/Footer.tsx')).toBe(false)
    // …but it does vouch for its own file, and for callers with no file to scope by.
    expect(hmr.trustSince(cursor, 'src/Hero.tsx')).toBe(true)
    expect(hmr.trustSince(cursor)).toBe(true)
    fireViteUpdateFor('/src/Footer.tsx')
    expect(hmr.trustSince(cursor, 'src/Footer.tsx')).toBe(true)
    hmr.stop()
  })

  it('stop() removes the listener; an observed event still proves Vite', () => {
    const hmr = new HmrSignal()
    hmr.start()
    fireViteUpdate() // no script tag, but the event itself is definitive
    const cursor = hmr.mark()
    expect(hmr.trustSince(cursor)).toBe(false) // now known-Vite, nothing since cursor
    hmr.stop()
    fireViteUpdate()
    expect(hmr.trustSince(cursor)).toBe(false) // stopped — the second event was not counted
  })
})

