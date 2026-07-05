// @vitest-environment jsdom
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { Overlay, CSS } from '../../src/client/overlay'

beforeEach(() => {
  document.body.innerHTML = ''
})

describe('Overlay CSS (Track A visibility correctness)', () => {
  it('declares a shadow-root-wide [hidden] rule as the very first rule, forcing display:none regardless of other selectors', () => {
    const trimmed = CSS.trim()
    // Must be the first rule in the stylesheet so nothing declared later can outrank it.
    expect(trimmed.startsWith('[hidden]')).toBe(true)
    expect(trimmed).toMatch(/^\[hidden\]\s*{\s*display:\s*none\s*!important;?\s*}/)
  })

  it('no longer needs the now-redundant #panel .panel-section[hidden] guard', () => {
    expect(CSS).not.toContain('.panel-section[hidden]')
  })

  it('declares the box-sizing: border-box reset as the SECOND rule, right after [hidden]', () => {
    const rules = CSS.trim()
      .split('}')
      .map((r) => r.trim())
      .filter(Boolean)
    expect(rules[0]).toMatch(/^\[hidden\]/)
    expect(rules[1]).toMatch(/^\*,\s*\*::before,\s*\*::after\s*{\s*box-sizing:\s*border-box;?/)
  })

  it('demotes the quiet #panel button rule to :where() so it cannot outrank later component button rules', () => {
    // Regression test for the Critical specificity bug: a bare `#panel button { ... }`
    // rule (1-0-1) was overriding `.seg`, `.seg-active`, `.am-dot`, `[data-add-layout]`,
    // etc. (all 0-1-0/0-2-0) regardless of source order. :where() has zero specificity,
    // so the later, more specific component rules always win.
    expect(CSS).not.toMatch(/(?<!:where\()#panel button\s*{/)
    expect(CSS).toContain(':where(#panel) button {')
    expect(CSS).toContain(':where(#panel) button:hover {')
    expect(CSS).toContain(':where(#panel) button:active {')
  })

  it('.layout-side .nf gets a fixed flex-basis so the Gap field does not stretch to ~60px tall', () => {
    // .nf's own `flex: 1 1 40%` sets a 40% flex-basis that, inside the column-flex
    // .layout-side, governs the field's HEIGHT — this override pins it back to content size.
    expect(CSS).toMatch(/\.layout-side\s+\.nf\s*{\s*flex:\s*0\s+0\s+auto;?\s*}/)
  })

  it('reveals the color row token-btn on keyboard focus-within, not just hover', () => {
    // A Tabbed-to swatch button can only reveal .token-btn (display:none by default) via
    // :focus-within — without this selector, the color-token dropdown is mouse-only.
    expect(CSS).toContain('.color-row:focus-within .token-btn')
  })

  it('[data-text-align] gets the same stacked (label-above-full-width-track) treatment as [data-align-self], fixing "Center" clipping at 280px (final review fix #7)', () => {
    // The Typography Align row shares its .type-row with the LS number field, leaving too
    // little width for the 3-option segment track — "Center" clips. [data-align-self]
    // already solves this identical problem (5 options, even tighter) by stacking the
    // label above a full-width track; [data-text-align] must get the same rule.
    expect(CSS).toMatch(/\[data-text-align\]\s*{\s*flex-direction:\s*column;\s*align-items:\s*stretch;\s*gap:\s*3px;?\s*}/)
    expect(CSS).toContain('[data-text-align] .seg-field-label { width: auto; }')
  })

  it('[data-flex-direction] gets the same stacked (label-above-full-width-track) treatment, fixing the "Direction" label overflowing its 40px column at 280px (clipping audit)', () => {
    // The Layout Direction row's "Direction" label needs ~48px at 11px against the fixed
    // 40px .seg-field-label column — with overflow: visible it paints under the seg track.
    // [data-align-self]/[data-text-align] already solve this by stacking the label above a
    // full-width track; the Direction row must get the same rule.
    // flex-basis 100% is part of the fix: inside the wrapping .panel-rows the field is
    // otherwise content-sized (~64px) and the track would still crush "Column".
    expect(CSS).toMatch(
      /\[data-flex-direction\]\s*{\s*flex-direction:\s*column;\s*align-items:\s*stretch;\s*gap:\s*3px;\s*flex:\s*1\s+1\s+100%;?\s*}/
    )
    expect(CSS).toContain('[data-flex-direction] .seg-field-label { width: auto; }')
  })

  it('seg labels ellipsize instead of hard-clipping', () => {
    expect(CSS).toMatch(/\.seg\s*{[^}]*text-overflow:\s*ellipsis/s)
  })
  it('token pills ellipsize instead of hard-clipping', () => {
    expect(CSS).toMatch(/\.nf-pill input\s*{[^}]*text-overflow:\s*ellipsis/s)
  })
  it('head-src is a flex row: dir ellipsizes, tail never shrinks', () => {
    expect(CSS).toMatch(/\.panel-head-src\s*{[^}]*display:\s*flex/s)
    expect(CSS).toMatch(/\.src-dir\s*{[^}]*text-overflow:\s*ellipsis/s)
    expect(CSS).toMatch(/\.src-tail\s*{[^}]*flex:\s*none/s)
  })
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

describe('Overlay.showSelectOutlines (B6 multi-select)', () => {
  function multiOutlines(overlay: Overlay): HTMLElement[] {
    return [...overlay.host.shadowRoot!.querySelectorAll('.select-outline-multi')] as HTMLElement[]
  }

  it('draws one pooled outline per rect, class select-outline-multi', () => {
    const overlay = new Overlay()
    overlay.mount()
    overlay.showSelectOutlines([new DOMRect(0, 0, 10, 10), new DOMRect(20, 20, 5, 5)])
    expect(multiOutlines(overlay)).toHaveLength(2)
  })

  it('reuses the pool on a second call rather than growing indefinitely', () => {
    const overlay = new Overlay()
    overlay.mount()
    overlay.showSelectOutlines([new DOMRect(0, 0, 10, 10)])
    overlay.showSelectOutlines([new DOMRect(0, 0, 10, 10), new DOMRect(1, 1, 2, 2)])
    expect(multiOutlines(overlay)).toHaveLength(2)
  })

  it('a shrinking selection hides the now-unused pool slots instead of removing them', () => {
    const overlay = new Overlay()
    overlay.mount()
    overlay.showSelectOutlines([new DOMRect(0, 0, 10, 10), new DOMRect(1, 1, 2, 2), new DOMRect(2, 2, 3, 3)])
    overlay.showSelectOutlines([new DOMRect(0, 0, 10, 10)])
    const all = multiOutlines(overlay)
    expect(all).toHaveLength(3) // pool retained
    expect(all[0].hidden).toBe(false)
    expect(all[1].hidden).toBe(true)
    expect(all[2].hidden).toBe(true)
  })

  it('hideSelectOutlines hides every pooled div', () => {
    const overlay = new Overlay()
    overlay.mount()
    overlay.showSelectOutlines([new DOMRect(0, 0, 10, 10), new DOMRect(1, 1, 2, 2)])
    overlay.hideSelectOutlines()
    expect(multiOutlines(overlay).every((d) => d.hidden)).toBe(true)
  })

  it('setActive(false) hides the multi-outline pool too', () => {
    const overlay = new Overlay()
    overlay.mount()
    overlay.showSelectOutlines([new DOMRect(0, 0, 10, 10)])
    overlay.setActive(false)
    expect(multiOutlines(overlay).every((d) => d.hidden)).toBe(true)
  })

  it('positions each outline via the same place() convention (2px outset)', () => {
    const overlay = new Overlay()
    overlay.mount()
    overlay.showSelectOutlines([new DOMRect(10, 20, 100, 50)])
    const [el] = multiOutlines(overlay)
    expect(el.style.left).toBe('8px')
    expect(el.style.top).toBe('18px')
    expect(el.style.width).toBe('104px')
    expect(el.style.height).toBe('54px')
  })

  it('single-selection outline (#select-outline) is unaffected — no visual change for single-select', () => {
    const overlay = new Overlay()
    overlay.mount()
    overlay.showSelectOutline(new DOMRect(0, 0, 5, 5))
    const sel = overlay.host.shadowRoot!.getElementById('select-outline') as HTMLElement
    expect(sel.hidden).toBe(false)
    expect(multiOutlines(overlay)).toHaveLength(0)
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

  it('auto-clears ripples after 1.5s plus the fade duration', () => {
    const overlay = new Overlay()
    overlay.mount()
    overlay.showRipples([new DOMRect(0, 0, 10, 10)])
    expect(ripples(overlay).every((r) => r.hidden)).toBe(false)
    vi.advanceTimersByTime(1500 + 300) // clear timer, then the fade-out window
    expect(ripples(overlay).every((r) => r.hidden)).toBe(true)
  })

  it('ripples actually fade: opacity drops to 0 before the outline hides, not an instant cut', () => {
    const overlay = new Overlay()
    overlay.mount()
    overlay.showRipples([new DOMRect(0, 0, 10, 10)])
    const [el] = ripples(overlay)
    expect(el.style.opacity).not.toBe('0')
    vi.advanceTimersByTime(1500)
    // opacity must reach 0 (so the CSS transition has something to animate) before hiding
    expect(el.style.opacity).toBe('0')
    expect(el.hidden).toBe(false) // still in the DOM, mid-fade
    vi.advanceTimersByTime(300) // the transition duration declared in CSS
    expect(el.hidden).toBe(true)
  })

  it('setActive(false) clearing ripples still leaves them faded-and-hidden (no snap to opacity 1 on reuse)', () => {
    const overlay = new Overlay()
    overlay.mount()
    overlay.showRipples([new DOMRect(0, 0, 10, 10)])
    const [el] = ripples(overlay)
    overlay.setActive(false)
    vi.advanceTimersByTime(300)
    expect(el.hidden).toBe(true)
    // reusing the pool for a fresh burst of ripples must restore full opacity
    overlay.showRipples([new DOMRect(0, 0, 10, 10)])
    expect(el.style.opacity).toBe('1')
  })

  it('re-triggering showRipples resets the shared clear timer', () => {
    const overlay = new Overlay()
    overlay.mount()
    overlay.showRipples([new DOMRect(0, 0, 10, 10)])
    vi.advanceTimersByTime(1000)
    overlay.showRipples([new DOMRect(0, 0, 10, 10)]) // reset the clock
    vi.advanceTimersByTime(1000)
    expect(ripples(overlay).every((r) => r.hidden)).toBe(false) // only 2000ms since first call, but 1000ms since reset
    vi.advanceTimersByTime(500 + 300) // clear timer fires, then the fade-out window
    expect(ripples(overlay).every((r) => r.hidden)).toBe(true)
  })

  it('setActive(false) starts the fade, hiding once it completes', () => {
    const overlay = new Overlay()
    overlay.mount()
    overlay.showRipples([new DOMRect(0, 0, 10, 10)])
    overlay.setActive(false)
    expect(ripples(overlay).every((r) => r.hidden)).toBe(false) // mid-fade, not instantly gone
    vi.advanceTimersByTime(300)
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

describe('Dock CSS (docked-panel spec)', () => {
  it('panel width is driven by --forge-dock-w with a 320px default (resize hook)', () => {
    expect(CSS).toContain('width: var(--forge-dock-w, 320px)')
    expect(CSS).not.toContain('width: 280px')
  })
  it('panel is a flex column so the footer can pin and the body can scroll', () => {
    expect(CSS).toMatch(/#panel\s*{[^}]*display:\s*flex;\s*flex-direction:\s*column/s)
  })
  it('scrolling moved from #panel to .panel-body (popover-tracking prerequisite)', () => {
    expect(CSS).toMatch(/\.panel-body\s*{[^}]*overflow-y:\s*auto/s)
    expect(CSS).toMatch(/\.panel-body\s*{[^}]*position:\s*relative/s)
    expect(CSS).toContain('.panel-body::-webkit-scrollbar')
    expect(CSS).not.toContain('#panel::-webkit-scrollbar')
  })
  it('docked modifier pins the panel full-height right with square corners', () => {
    expect(CSS).toMatch(/#panel\.docked\s*{[^}]*top:\s*0;\s*right:\s*0;\s*bottom:\s*0/s)
    expect(CSS).toMatch(/#panel\.docked\s*{[^}]*border-radius:\s*0/s)
    expect(CSS).toMatch(/#panel\.docked\s*{[^}]*max-height:\s*none/s)
  })
  it('status strip restyles to static inside the footer', () => {
    expect(CSS).toMatch(/\.panel-footer\s+#status\s*{[^}]*position:\s*static/s)
    expect(CSS).toMatch(/\.panel-footer\s+#status\s*{[^}]*flex-wrap:\s*wrap/s)
  })
  it('Design toggle shifts left of the dock via the dock-open class', () => {
    expect(CSS).toContain('#toggle.dock-open { right: calc(16px + var(--forge-dock-w, 320px)); }')
  })
  it('resize handle spans the left edge with a col-resize cursor', () => {
    expect(CSS).toMatch(/\.panel-resize\s*{[^}]*left:\s*0;\s*top:\s*0;\s*bottom:\s*0/s)
    expect(CSS).toMatch(/\.panel-resize\s*{[^}]*cursor:\s*col-resize/s)
  })
})

describe('Dock polish CSS (PR #2 follow-ups)', () => {
  it('panel head reserves right padding so the absolute mode button cannot overlap a long tag', () => {
    expect(CSS).toContain('#panel .panel-head { position: relative; padding: 12px 36px 10px 12px; }')
  })
})
