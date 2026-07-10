// @vitest-environment jsdom
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { Overlay, CSS, TOKENS } from '../../src/client/overlay'

// The overlay's why-comments live as TS comments in the source (kept out of the shipped
// CSS string for package-budget reasons — see perf(client) shipped-CSS-comments commit),
// so tests that assert on comment TEXT read the source file directly instead of `CSS`.
const overlaySource = readFileSync(path.join(__dirname, '../../src/client/overlay.ts'), 'utf8')

beforeEach(() => {
  document.body.innerHTML = ''
})

describe('Overlay CSS (Track A visibility correctness)', () => {
  it('ships no comment prose in the CSS string — TS comments belong BETWEEN template segments', () => {
    // A `//` line inside the template literal is not a CSS comment: the browser's error
    // recovery swallows the entire next rule (a pasted-inside comment silently killed
    // .matrix-tile — user-reported). Line-start match only: data-URI `http://` is legit.
    expect(CSS).not.toMatch(/(^|\n)\s*\/\//)
    // /* */ would parse, but it ships as bundle bytes — the whole point of the migration.
    expect(CSS).not.toContain('/*')
  })

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

describe('Overlay CSS design tokens (Task 1)', () => {
  const count = (s: string) => CSS.split(s).length - 1

  it('declares the second :host rule directly after the :host { all: initial } reset', () => {
    // Separate rule (not folded into `all: initial`) keeps reset and tokens visually
    // distinct — `all` does not reset custom properties anyway.
    expect(CSS).toMatch(/:host\s*{\s*all:\s*initial;?\s*}\s*:host\s*{/)
  })

  it('declares every TOKENS entry exactly once in the generated :host block', () => {
    for (const [name, value] of Object.entries(TOKENS)) {
      expect(CSS).toContain(`--${name}: ${value}`)
      expect(count(`--${name}: ${value}`)).toBe(1) // declared exactly once
    }
  })


  it('the ripple token unifies the lowercase #e2954a case variant', () => {
    expect(count('e2954a')).toBe(0)
    expect(count('#E2954A')).toBe(1) // declaration only, inside --ripple
  })

  it('every tokenized color appears only in its :host declaration — no leftover literal uses', () => {
    // Ratchet: for every color-valued token, the raw literal may appear exactly once
    // (its generated declaration); every other use must be var(--name). Non-color tokens
    // (font stacks, px sizes) collide with unrelated CSS text, so the ratchet is colors-only.
    for (const value of Object.values(TOKENS)) {
      if (!/^#|^rgba?\(/.test(value)) continue
      expect(count(value)).toBe(1)
    }
  })


  it('the ripple why-comment ("must stay distinct from selection accent") is preserved verbatim', () => {
    // Lives as a TS comment adjacent to the CSS now (not inside the CSS string itself) —
    // see the source-comments note above.
    expect(overlaySource).toContain('must stay distinct from selection accent')
  })

  it('the palette comment block documents token names, not raw values', () => {
    // The token doc block is now the TS comment block directly above `export const CSS`
    // (see the source-comments note above), not a CSS-embedded /* */ comment.
    const commentBlock = overlaySource.slice(
      overlaySource.indexOf('// Design tokens'),
      overlaySource.indexOf('export const CSS'),
    )
    expect(commentBlock).toContain('--surface')
    expect(commentBlock).toContain('--accent')
    expect(commentBlock).toContain('--ripple')
    // Should no longer repeat the raw hex/rgba values as the primary documentation content
    expect(commentBlock).not.toContain('#2C2C2C')
    expect(commentBlock).not.toContain('rgba(255,255,255,0.06)')
  })

  it('font shorthands reference the font-family and type-scale tokens via var()', () => {
    expect(CSS).toContain('font: 500 var(--text-md) var(--font-ui)')
    expect(CSS).toContain('var(--font-mono)')
    expect(CSS).not.toMatch(/font:\s*[0-9]+\s+[0-9]+(\.[0-9]+)?px\s+system-ui/)
    expect(CSS).not.toMatch(/font:\s*[0-9]+\s+[0-9]+(\.[0-9]+)?px\s+ui-monospace/)
  })

  it('every var(--X) in CSS resolves to a real TOKENS key or a known non-token custom property', () => {
    // Reverse guard (final-review finding): a `var(--text)` typo compiled fine and fell
    // back to inherited color by accident — nothing caught it because no test walked CSS
    // looking for var() references that don't name a real token. This ratchets that class
    // of bug into a test failure instead of a silent inherit-fallback.
    const NON_TOKEN_VARS = [
      // Set at runtime by the resize/dock feature (dock.ts), not a design token — has its
      // own `, <fallback>px` default at every use site, so it's legitimately absent here.
      'forge-dock-w',
      // Set at runtime by colorpicker.ts (svArea.style.setProperty) to drive the hue
      // gradient — not a design token, has its own `, red` fallback at its one use site.
      'cp-hue',
    ]
    const found = new Set([...CSS.matchAll(/var\(--([a-zA-Z0-9-]+)/g)].map((m) => m[1]))
    const tokenKeys = new Set(Object.keys(TOKENS))
    for (const name of found) {
      const known = tokenKeys.has(name) || NON_TOKEN_VARS.includes(name)
      expect(known, `var(--${name}) is not a TOKENS key or allowlisted non-token`).toBe(true)
    }
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

  // 'Send to agent' (the standalone button) was retired by composer consolidation Task 3 — the
  // composer's ↑ is the only send surface now — so the strip's only button ahead of Copy is the
  // watch ✕.
  it('status strip orders copy button after the watch ✕', () => {
    const overlay = new Overlay()
    overlay.mount()
    const status = overlay.host.shadowRoot!.getElementById('status')!
    const buttons = [...status.querySelectorAll('button')]
    expect(buttons[1]).toBe(overlay.copyButton)
    expect(overlay.copyButton.textContent).toBe('Copy for agent')
  })

  it("has no standalone 'Send to agent' button — the composer's ↑ is the only send surface", () => {
    const overlay = new Overlay()
    overlay.mount()
    expect('sendButton' in overlay).toBe(false)
    const status = overlay.host.shadowRoot!.getElementById('status')!
    const labels = [...status.querySelectorAll('button')].map((b) => b.textContent)
    expect(labels).not.toContain('Send to agent')
  })
})

describe('Overlay (M4 additions)', () => {
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
    // Scoped to #panel's own rule, not a bare substring check, in case some other floating
    // control ever legitimately carries its own fixed width elsewhere in the sheet.
    expect(CSS).toMatch(/#panel\s*{[^}]*width:\s*var\(--forge-dock-w/s)
    expect(CSS).not.toMatch(/#panel\s*{[^}]*width:\s*280px/s)
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

describe('Overlay CSS feed divider (composer-consolidation Task 4)', () => {
  it('feed slot defaults to a 45% flex-basis split, overridden by inline px once dragged/restored', () => {
    expect(CSS).toMatch(/\.panel-feed-slot\s*{[^}]*flex:\s*0\s+1\s+45%/s)
  })
  it('divider is a slim row-resize handle with a hover/active grab affordance', () => {
    expect(CSS).toMatch(/\.feed-divider\s*{[^}]*height:\s*5px/s)
    expect(CSS).toMatch(/\.feed-divider\s*{[^}]*cursor:\s*row-resize/s)
    expect(CSS).toContain('.feed-divider:hover, .feed-divider:active { background: rgba(13,153,255,0.4); }')
  })
})

describe('Dock polish CSS (PR #2 follow-ups)', () => {
  // Padding widened from 36px (PR #2, mode-button-only) to 96px (prompt-mode) to reserve
  // room for the whole .panel-head-actions cluster (Prompt + mode button), not just the
  // mode button alone — see the .panel-head-actions tests below.
  it('panel head reserves right padding so the absolute action cluster cannot overlap a long tag', () => {
    expect(CSS).toContain('#panel .panel-head { position: relative; padding: 12px 96px 10px 12px; }')
  })
})

describe('Overlay CSS panel-prompt anchor (prompt-mode, floating prompt popup retired Task 6)', () => {
  it('.panel-prompt itself is a layout-only class hook with no CSS rule of its own', () => {
    // .panel-prompt itself is a layout-only class hook with no CSS rule of its own (see
    // panel.ts / the why-comment in overlay.ts source) — its stable-contract status is
    // documented in source comments, not a CSS-embedded rule.
    expect(overlaySource).toContain('.panel-prompt')
  })

  // Finding 1 fix: .panel-head is a block container (position: relative only, so
  // .panel-mode can corner-anchor) — margin-left: auto on .panel-prompt had no effect.
  // The fix anchors a shared .panel-head-actions flex wrapper instead, since
  // .panel-prompt (content-sized "Prompt" label) can't share .panel-mode's fixed 22px
  // width for a guessed fixed `right:` offset.
  it('anchors the header action cluster to the corner as a flex row, not .panel-prompt directly', () => {
    expect(CSS).toMatch(/\.panel-head-actions\s*{[^}]*position:\s*absolute/s)
    expect(CSS).toMatch(/\.panel-head-actions\s*{[^}]*display:\s*flex/s)
    expect(CSS).not.toMatch(/\.panel-prompt\s*{[^}]*margin-left:\s*auto/s)
  })
})

describe('Overlay CSS chat composer / element chip / controls (composer consolidation Task 1)', () => {
  it('styles the composer, controls row, model picker, chip, and input cluster as test-hook classes', () => {
    expect(CSS).toContain('.chat-composer')
    expect(CSS).toContain('.composer-controls')
    expect(CSS).toContain('.session-model')
    expect(CSS).toContain('.chat-chip')
    expect(CSS).toContain('.chat-input')
    expect(CSS).toContain('.chat-textarea')
    expect(CSS).toContain('.chat-disabled-reason')
  })

  // SessionFeed mounts INSIDE #panel (unlike the old floating prompt popup, which mounted as a shadow-
  // root sibling) — but there is still no generic `#panel button` dark-token fallback, so
  // .composer-send needs the same explicit dark styling as .session-approval-allow/.prompt-send used to.
  it('styles .composer-send with the dark control tokens, not the light base button fallback', () => {
    expect(CSS).toMatch(/\.composer-send\s*{[^}]*background:\s*var\(--control\)/s)
    expect(CSS).toMatch(/\.composer-send:hover\s*{[^}]*background:\s*var\(--control-hover\)/s)
  })

  it('has no CSS-string comments (bundle-byte guard)', () => {
    // /* */ would parse, but it ships as bundle bytes — the whole point of the migration
    // (see the identical check earlier in this file).
    const chatBlockStart = CSS.indexOf('.chat-composer')
    expect(chatBlockStart).toBeGreaterThan(-1)
    expect(CSS.slice(chatBlockStart)).not.toContain('/*')
  })
})

describe('Overlay (watch-unlink — Task 2)', () => {
  it('updateStatus keeps the strip visible with zero drafts when a watch indicator is present (not-linked upfront)', () => {
    const overlay = new Overlay()
    overlay.updateStatus(0, false, undefined, { text: '○ Not linked — type /forge-watch in Claude Code to link', live: false, unlinkable: false })
    expect(overlay.status.hidden).toBe(false)
  })

  it('unlink ✕ is shown for unlinkable states and hidden for none', () => {
    const overlay = new Overlay()
    expect(overlay.unlinkButton.className).toContain('watch-unlink')
    overlay.updateStatus(0, false, undefined, { text: '● Linked to Claude Code', live: true, unlinkable: true })
    expect(overlay.unlinkButton.hidden).toBe(false)
    overlay.updateStatus(0, false, undefined, { text: '○ Not linked — type /forge-watch in Claude Code to link', live: false, unlinkable: false })
    expect(overlay.unlinkButton.hidden).toBe(true)
    overlay.updateStatus(1, false)
    expect(overlay.unlinkButton.hidden).toBe(true)
  })
})

// ---------------------------------------------------------------------------
// Session feed CSS hooks (Task 7) — test hooks that must not be renamed
// ---------------------------------------------------------------------------

describe('SessionFeed CSS hooks (Task 7)', () => {
  it('CSS declares .session-feed as a test hook class', () => {
    expect(CSS).toContain('.session-feed')
  })

  it('CSS declares .session-row as a test hook class', () => {
    expect(CSS).toContain('.session-row')
  })

  it('CSS declares .session-approval as a test hook class', () => {
    expect(CSS).toContain('.session-approval')
  })

  it('CSS declares .composer-send as a test hook class (composer consolidation Task 1 — retires .session-stop)', () => {
    expect(CSS).toContain('.composer-send')
  })

  it('CSS declares .chat-composer for the composer card (composer consolidation Task 1 — retires the status row)', () => {
    expect(CSS).toContain('.chat-composer')
  })

  it('CSS declares .session-error-row for error rows', () => {
    expect(CSS).toContain('.session-error-row')
  })
})

// ---------------------------------------------------------------------------
// Chat rendering CSS hooks (Task 5) — test hooks that must not be renamed
// ---------------------------------------------------------------------------

describe('SessionFeed chat CSS hooks (Task 5)', () => {
  it('CSS declares .chat-msg as the bubble base class', () => {
    expect(CSS).toContain('.chat-msg')
  })

  it('CSS declares .chat-user for user bubbles', () => {
    expect(CSS).toContain('.chat-user')
  })

  it('CSS declares .chat-assistant for assistant bubbles', () => {
    expect(CSS).toContain('.chat-assistant')
  })

  it('CSS declares .chat-streaming for the in-progress delta bubble', () => {
    expect(CSS).toContain('.chat-streaming')
  })

  it('CSS declares .chat-msg-ref for the element chip echo line', () => {
    expect(CSS).toContain('.chat-msg-ref')
  })

  it('CSS declares .session-diff for the diff disclosure', () => {
    expect(CSS).toContain('.session-diff')
  })

  it('CSS declares .diff-before and .diff-after for the diff bodies', () => {
    expect(CSS).toContain('.diff-before')
    expect(CSS).toContain('.diff-after')
  })

  it('CSS declares .session-config for the config-changed row', () => {
    expect(CSS).toContain('.session-config')
  })
})
