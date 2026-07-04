// @vitest-environment jsdom
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { Overlay } from '../../src/client/overlay'

beforeEach(() => {
  document.body.innerHTML = ''
})

describe('Overlay (M2 additions)', () => {
  it('attachPanel mounts an external panel root into the shadow root', () => {
    const overlay = new Overlay()
    overlay.mount()
    const panelRoot = document.createElement('div')
    panelRoot.id = 'panel'
    overlay.attachPanel(panelRoot)
    expect(overlay.host.shadowRoot!.getElementById('panel')).toBe(panelRoot)
  })

  it('selection outline is separate from hover outline and persists', () => {
    const overlay = new Overlay()
    overlay.mount()
    overlay.showSelectOutline(new DOMRect(10, 20, 100, 50))
    overlay.showOutline(new DOMRect(0, 0, 5, 5))
    overlay.hideOutline()
    const sel = overlay.host.shadowRoot!.getElementById('select-outline') as HTMLElement
    expect(sel.hidden).toBe(false)
    overlay.hideSelectOutline()
    expect(sel.hidden).toBe(true)
  })

  it('status strip shows draft count and flips compare label', () => {
    const overlay = new Overlay()
    overlay.mount()
    const status = overlay.host.shadowRoot!.getElementById('status') as HTMLElement
    overlay.updateStatus(0, false)
    expect(status.hidden).toBe(true)
    overlay.updateStatus(3, false)
    expect(status.hidden).toBe(false)
    expect(status.textContent).toContain('3 drafts')
    expect(overlay.compareAllButton.textContent).toBe('Before')
    overlay.updateStatus(3, true)
    expect(overlay.compareAllButton.textContent).toBe('After')
  })

  it('setActive(false) hides selection outline and status', () => {
    const overlay = new Overlay()
    overlay.mount()
    overlay.showSelectOutline(new DOMRect(0, 0, 1, 1))
    overlay.updateStatus(2, false)
    overlay.setActive(false)
    expect((overlay.host.shadowRoot!.getElementById('select-outline') as HTMLElement).hidden).toBe(true)
    expect((overlay.host.shadowRoot!.getElementById('status') as HTMLElement).hidden).toBe(true)
  })

  it('status strip includes the copy button after send', () => {
    const overlay = new Overlay()
    overlay.mount()
    const status = overlay.host.shadowRoot!.getElementById('status')!
    const buttons = [...status.querySelectorAll('button')]
    expect(buttons[1]).toBe(overlay.copyButton)
    expect(overlay.copyButton.textContent).toBe('Copy for agent')
  })
})

describe('Overlay (M4 additions)', () => {
  it('status strip includes the send button first, before copy', () => {
    const overlay = new Overlay()
    overlay.mount()
    const status = overlay.host.shadowRoot!.getElementById('status')!
    const buttons = [...status.querySelectorAll('button')]
    expect(buttons[0]).toBe(overlay.sendButton)
    expect(buttons[1]).toBe(overlay.copyButton)
    expect(overlay.sendButton.textContent).toBe('Send to agent')
  })

  it('updateStatus shows an optional sent span when given sentText', () => {
    const overlay = new Overlay()
    overlay.mount()
    const status = overlay.host.shadowRoot!.getElementById('status') as HTMLElement
    overlay.updateStatus(1, false)
    const sent = overlay.host.shadowRoot!.getElementById('sent') as HTMLElement
    expect(sent.hidden).toBe(true)

    overlay.updateStatus(1, false, '1 applying… · 2 implemented')
    expect(sent.hidden).toBe(false)
    expect(sent.textContent).toBe('1 applying… · 2 implemented')

    overlay.updateStatus(1, false, '')
    expect(sent.hidden).toBe(true)
  })

  it('keeps the strip visible for a verifier summary after drafts hit zero', () => {
    const overlay = new Overlay()
    overlay.mount()
    overlay.updateStatus(0, false, '1 implemented ✓')
    const root = overlay.host.shadowRoot!
    const status = root.getElementById('status') as HTMLElement
    expect(status.hidden).toBe(false)
    expect(overlay.sendButton.hidden).toBe(true)
    expect(overlay.copyButton.hidden).toBe(true)
    expect(overlay.compareAllButton.hidden).toBe(true)
    expect(overlay.resetAllButton.hidden).toBe(true)
    overlay.updateStatus(0, false, '')
    expect(status.hidden).toBe(true)
  })
})

describe('Overlay.showRipples (M2b Task 4)', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  function ripples(overlay: Overlay): HTMLElement[] {
    return [...overlay.host.shadowRoot!.querySelectorAll('.ripple-outline')] as HTMLElement[]
  }

  it('draws one ripple-outline div per rect', () => {
    const overlay = new Overlay()
    overlay.mount()
    overlay.showRipples([new DOMRect(0, 0, 10, 10), new DOMRect(20, 20, 5, 5)])
    expect(ripples(overlay)).toHaveLength(2)
  })

  it('caps ripple outlines at 8', () => {
    const overlay = new Overlay()
    overlay.mount()
    const rects = Array.from({ length: 12 }, (_, i) => new DOMRect(i, i, 10, 10))
    overlay.showRipples(rects)
    expect(ripples(overlay)).toHaveLength(8)
  })

  it('reuses the pool on a second call rather than growing indefinitely', () => {
    const overlay = new Overlay()
    overlay.mount()
    overlay.showRipples([new DOMRect(0, 0, 10, 10)])
    overlay.showRipples([new DOMRect(0, 0, 10, 10), new DOMRect(1, 1, 2, 2)])
    expect(ripples(overlay)).toHaveLength(2)
  })

  it('auto-clears ripples after 1.5s', () => {
    const overlay = new Overlay()
    overlay.mount()
    overlay.showRipples([new DOMRect(0, 0, 10, 10)])
    expect(ripples(overlay).every((r) => r.hidden)).toBe(false)
    vi.advanceTimersByTime(1500)
    expect(ripples(overlay).every((r) => r.hidden)).toBe(true)
  })

  it('re-triggering showRipples resets the shared clear timer', () => {
    const overlay = new Overlay()
    overlay.mount()
    overlay.showRipples([new DOMRect(0, 0, 10, 10)])
    vi.advanceTimersByTime(1000)
    overlay.showRipples([new DOMRect(0, 0, 10, 10)]) // reset the clock
    vi.advanceTimersByTime(1000)
    expect(ripples(overlay).every((r) => r.hidden)).toBe(false) // only 2000ms since first call, but 1000ms since reset
    vi.advanceTimersByTime(500)
    expect(ripples(overlay).every((r) => r.hidden)).toBe(true)
  })

  it('setActive(false) clears ripples immediately', () => {
    const overlay = new Overlay()
    overlay.mount()
    overlay.showRipples([new DOMRect(0, 0, 10, 10)])
    overlay.setActive(false)
    expect(ripples(overlay).every((r) => r.hidden)).toBe(true)
  })

  it('ripple outlines are pointer-events:none and positioned from the rect', () => {
    const overlay = new Overlay()
    overlay.mount()
    overlay.showRipples([new DOMRect(10, 20, 100, 50)])
    const [el] = ripples(overlay)
    expect(el.style.pointerEvents).toBe('none')
    // positioned via the same place() convention as the other outlines (2px outset)
    expect(el.style.left).toBe('8px')
    expect(el.style.top).toBe('18px')
    expect(el.style.width).toBe('104px')
    expect(el.style.height).toBe('54px')
  })
})
