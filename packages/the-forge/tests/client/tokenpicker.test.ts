// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { TokenPicker, type TokenEntry } from '../../src/client/tokenpicker'

const ENTRIES: TokenEntry[] = [
  { label: '0', px: 0 },
  { label: '1', px: 4 },
  { label: '2', px: 8 },
  { label: '4', px: 16 },
  { label: '8', px: 32 },
]

function setupPicker() {
  const panelRoot = document.createElement('div')
  document.body.append(panelRoot)
  const picker = new TokenPicker(panelRoot)
  return { panelRoot, picker }
}

function anchorEl(): HTMLElement {
  const anchor = document.createElement('div')
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

describe('TokenPicker', () => {
  it('root is hidden by default and appended to panel root', () => {
    const { panelRoot, picker } = setupPicker()
    expect(picker.root.isConnected).toBe(true)
    expect(panelRoot.contains(picker.root)).toBe(true)
    expect(picker.root.hidden).toBe(true)
    expect(picker.root.className).toBe('token-popover')
  })

  it('open() shows the popover positioned near the anchor and renders all entries', () => {
    const { picker } = setupPicker()
    const anchor = anchorEl()
    picker.open({ anchor, entries: ENTRIES, onApply: vi.fn() })
    expect(picker.root.hidden).toBe(false)
    expect(picker.root.style.top).toBe('100px')
    const rows = picker.root.querySelectorAll('.tp-row')
    expect(rows.length).toBe(ENTRIES.length)
  })

  it('renders each row as "label — Npx"', () => {
    const { picker } = setupPicker()
    const anchor = anchorEl()
    picker.open({ anchor, entries: ENTRIES, onApply: vi.fn() })
    const rows = [...picker.root.querySelectorAll('.tp-row')]
    expect(rows[1].textContent).toContain('1')
    expect(rows[1].textContent).toContain('4px')
  })

  it('close() hides the popover', () => {
    const { picker } = setupPicker()
    const anchor = anchorEl()
    picker.open({ anchor, entries: ENTRIES, onApply: vi.fn() })
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
    picker.open({ anchor, entries: ENTRIES, onApply: vi.fn() })
    picker.close()
    const removeSpy = vi.spyOn(window, 'removeEventListener')
    picker.close()
    expect(removeSpy).not.toHaveBeenCalledWith('keydown', expect.any(Function))
    expect(removeSpy).not.toHaveBeenCalledWith('mousedown', expect.any(Function))
  })

  it('typing in the search input filters rows by label substring', () => {
    const { picker } = setupPicker()
    const anchor = anchorEl()
    picker.open({ anchor, entries: ENTRIES, onApply: vi.fn() })
    const search = picker.root.querySelector('.tp-search') as HTMLInputElement
    search.value = '4'
    search.dispatchEvent(new Event('input', { bubbles: true }))
    const rows = [...picker.root.querySelectorAll('.tp-row')]
    expect(rows.length).toBe(1)
    expect(rows[0].textContent).toContain('4')
  })

  it('search input is autofocused on open', () => {
    const { picker } = setupPicker()
    const anchor = anchorEl()
    picker.open({ anchor, entries: ENTRIES, onApply: vi.fn() })
    const search = picker.root.querySelector('.tp-search') as HTMLInputElement
    expect(document.activeElement).toBe(search)
  })

  it('clicking a row applies that entry via onApply and closes', () => {
    const { picker } = setupPicker()
    const anchor = anchorEl()
    const onApply = vi.fn()
    picker.open({ anchor, entries: ENTRIES, onApply })
    const rows = [...picker.root.querySelectorAll('.tp-row')]
    ;(rows[2] as HTMLElement).click()
    expect(onApply).toHaveBeenCalledWith(ENTRIES[2])
    expect(picker.root.hidden).toBe(true)
  })

  it('ArrowDown/ArrowUp move a keyboard-active row, Enter applies it', () => {
    const { picker } = setupPicker()
    const anchor = anchorEl()
    const onApply = vi.fn()
    picker.open({ anchor, entries: ENTRIES, onApply })
    const search = picker.root.querySelector('.tp-search') as HTMLInputElement
    search.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true }))
    search.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true }))
    search.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }))
    // Two ArrowDown presses from nothing-active lands on index 1 (0 -> 1).
    expect(onApply).toHaveBeenCalledWith(ENTRIES[1])
  })

  it('ArrowUp from the first row wraps or stays put (no throw) and Enter still applies the active row', () => {
    const { picker } = setupPicker()
    const anchor = anchorEl()
    const onApply = vi.fn()
    picker.open({ anchor, entries: ENTRIES, onApply })
    const search = picker.root.querySelector('.tp-search') as HTMLInputElement
    search.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true }))
    search.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowUp', bubbles: true }))
    search.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }))
    expect(onApply).toHaveBeenCalledWith(ENTRIES[0])
  })

  it('hovering a row marks it active (keyboard nav starts from the hovered row)', () => {
    const { picker } = setupPicker()
    const anchor = anchorEl()
    picker.open({ anchor, entries: ENTRIES, onApply: vi.fn() })
    const rows = [...picker.root.querySelectorAll('.tp-row')]
    rows[3].dispatchEvent(new MouseEvent('mouseenter', { bubbles: true }))
    // renderList() rebuilds row DOM on every state change (mirrors ColorPicker's re-render
    // pattern) — re-query rather than reuse the stale pre-hover node reference.
    const rowsAfter = [...picker.root.querySelectorAll('.tp-row')]
    expect(rowsAfter[3].classList.contains('tp-row-active')).toBe(true)
  })

  it('hover toggles tp-row-active IN PLACE — never rebuilds the row nodes (real-browser regression)', () => {
    // Under a real pointer, replaceChildren() on mouseenter replaces the hovered node at the
    // same coordinates, which makes Chromium immediately re-fire mouseenter on the replacement
    // -> infinite render loop, starving the row's own mousedown/click. jsdom never fires real
    // hover so this only shows up as a node-identity break in a unit test, not a timeout.
    const { picker } = setupPicker()
    const anchor = anchorEl()
    picker.open({ anchor, entries: ENTRIES, onApply: vi.fn() })
    const listEl = picker.root.querySelector('.tp-list') as HTMLElement
    const rowsBefore = [...listEl.children]

    rowsBefore[3].dispatchEvent(new MouseEvent('mouseenter', { bubbles: true }))

    const rowsAfter = [...listEl.children]
    expect(rowsAfter[3]).toBe(rowsBefore[3])
    expect(rowsAfter[3].classList.contains('tp-row-active')).toBe(true)
    // Previously-hovered row identity is unaffected, and its active class is cleared.
    rowsBefore[1].dispatchEvent(new MouseEvent('mouseenter', { bubbles: true }))
    const rowsAfter2 = [...listEl.children]
    expect(rowsAfter2[1]).toBe(rowsBefore[1])
    expect(rowsAfter2[1].classList.contains('tp-row-active')).toBe(true)
    expect(rowsAfter2[3].classList.contains('tp-row-active')).toBe(false)
  })

  it('keyboard ArrowDown moves the active row in place — never rebuilds the row nodes', () => {
    const { picker } = setupPicker()
    const anchor = anchorEl()
    picker.open({ anchor, entries: ENTRIES, onApply: vi.fn() })
    const listEl = picker.root.querySelector('.tp-list') as HTMLElement
    const rowsBefore = [...listEl.children]
    const search = picker.root.querySelector('.tp-search') as HTMLInputElement

    search.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true }))

    const rowsAfter = [...listEl.children]
    expect(rowsAfter).toEqual(rowsBefore) // same node objects, same order
    expect(rowsAfter[0].classList.contains('tp-row-active')).toBe(true)
  })

  it('Escape closes the picker', () => {
    const { picker } = setupPicker()
    const anchor = anchorEl()
    picker.open({ anchor, entries: ENTRIES, onApply: vi.fn() })
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }))
    expect(picker.root.hidden).toBe(true)
  })

  it('registers its Escape listener with capture: true (final review fix #11)', () => {
    const addSpy = vi.spyOn(window, 'addEventListener')
    const { picker } = setupPicker()
    const anchor = anchorEl()
    picker.open({ anchor, entries: ENTRIES, onApply: vi.fn() })
    const keydownCall = addSpy.mock.calls.find((c) => c[0] === 'keydown')!
    expect(keydownCall[2]).toBe(true)
  })

  it('Escape closes the picker even when a focused control stopped propagation at the bubble phase (final review fix #11)', () => {
    // Mirrors NumberField's own Escape handler, which calls stopPropagation() at the BUBBLE
    // phase (see controls.ts) — without `capture: true` on the picker's window listener,
    // that stopPropagation would starve it entirely.
    const { picker } = setupPicker()
    const anchor = anchorEl()
    picker.open({ anchor, entries: ENTRIES, onApply: vi.fn() })

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
    picker.open({ anchor, entries: ENTRIES, onApply: vi.fn() })
    document.body.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }))
    expect(picker.root.hidden).toBe(true)
  })

  it('pointerdown inside the picker does not close it', () => {
    const { picker } = setupPicker()
    const anchor = anchorEl()
    picker.open({ anchor, entries: ENTRIES, onApply: vi.fn() })
    picker.root.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }))
    expect(picker.root.hidden).toBe(false)
  })

  it('mousedown inside a real shadow root does not close the picker, but an outside mousedown does', () => {
    // Regression test mirroring ColorPicker's shadow-DOM retargeting guard (composedPath()[0]).
    const host = document.createElement('div')
    document.body.append(host)
    const shadow = host.attachShadow({ mode: 'open' })
    const panelRoot = document.createElement('div')
    shadow.append(panelRoot)
    const picker = new TokenPicker(panelRoot)
    const anchor = document.createElement('div')
    Object.defineProperty(anchor, 'offsetTop', { value: 100, configurable: true })
    shadow.append(anchor)

    picker.open({ anchor, entries: ENTRIES, onApply: vi.fn() })
    expect(picker.root.hidden).toBe(false)

    picker.root.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, composed: true }))
    expect(picker.root.hidden).toBe(false)

    document.body.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, composed: true }))
    expect(picker.root.hidden).toBe(true)
  })

  it('ArrowDown scrolls the newly active row into view (guarded for jsdom)', () => {
    const { picker } = setupPicker()
    const anchor = anchorEl()
    // jsdom's HTMLElement doesn't implement scrollIntoView at all — install a shared stub
    // on the prototype so it survives renderList()'s replaceChildren()/re-create per move.
    const scrollSpy = vi.fn()
    ;(Element.prototype as unknown as { scrollIntoView: typeof scrollSpy }).scrollIntoView = scrollSpy
    try {
      picker.open({ anchor, entries: ENTRIES, onApply: vi.fn() })
      const search = picker.root.querySelector('.tp-search') as HTMLInputElement
      search.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true }))
      const rowsAfter = [...picker.root.querySelectorAll('.tp-row')] as HTMLElement[]
      const activeAfter = rowsAfter.findIndex((r) => r.classList.contains('tp-row-active'))
      expect(activeAfter).toBe(0)
      expect(scrollSpy).toHaveBeenCalledWith({ block: 'nearest' })
    } finally {
      delete (Element.prototype as unknown as { scrollIntoView?: unknown }).scrollIntoView
    }
  })

  it('does not throw when the active row lacks scrollIntoView (plain jsdom element)', () => {
    const { picker } = setupPicker()
    const anchor = anchorEl()
    picker.open({ anchor, entries: ENTRIES, onApply: vi.fn() })
    const search = picker.root.querySelector('.tp-search') as HTMLInputElement
    expect(() => search.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true }))).not.toThrow()
  })

  it('reselection (a second open()) resets the filter and keyboard-active state', () => {
    const { picker } = setupPicker()
    const anchor = anchorEl()
    picker.open({ anchor, entries: ENTRIES, onApply: vi.fn() })
    const search = picker.root.querySelector('.tp-search') as HTMLInputElement
    search.value = '4'
    search.dispatchEvent(new Event('input', { bubbles: true }))
    expect(picker.root.querySelectorAll('.tp-row').length).toBe(1)

    picker.open({ anchor, entries: ENTRIES, onApply: vi.fn() })
    expect(picker.root.querySelectorAll('.tp-row').length).toBe(ENTRIES.length)
    expect((picker.root.querySelector('.tp-search') as HTMLInputElement).value).toBe('')
  })

  it('open() scrolls the popover into view (guarded for jsdom), final review fix #7', () => {
    const { picker } = setupPicker()
    const anchor = anchorEl()
    const scrollSpy = vi.fn()
    ;(picker.root as unknown as { scrollIntoView: typeof scrollSpy }).scrollIntoView = scrollSpy
    picker.open({ anchor, entries: ENTRIES, onApply: vi.fn() })
    expect(scrollSpy).toHaveBeenCalledWith({ block: 'nearest' })
  })

  it('open() does not throw when the popover root lacks scrollIntoView (plain jsdom element)', () => {
    const { picker } = setupPicker()
    const anchor = anchorEl()
    expect(() => picker.open({ anchor, entries: ENTRIES, onApply: vi.fn() })).not.toThrow()
  })

  describe('color entries', () => {
    const COLOR_ENTRIES: TokenEntry[] = [
      { label: 'red-500', color: '#ef4444' },
      { label: 'neutral-900', color: 'oklch(0.2 0 0)' },
    ]

    it('renders a swatch + label, no px span, for color entries', () => {
      const { picker } = setupPicker()
      const anchor = anchorEl()
      picker.open({ anchor, entries: COLOR_ENTRIES, onApply: vi.fn() })
      const rows = [...picker.root.querySelectorAll('.tp-row')]
      expect(rows.length).toBe(COLOR_ENTRIES.length)

      const row0 = rows[0]
      const swatch = row0.querySelector('.tp-row-swatch') as HTMLElement
      expect(swatch).not.toBeNull()
      // jsdom normalizes hex to rgb() in style.background.
      expect(swatch.style.background).toBe('rgb(239, 68, 68)')

      const label = row0.querySelector('.tp-row-label') as HTMLElement
      expect(label.textContent).toBe('red-500')

      expect(row0.querySelector('.tp-row-px')).toBeNull()
    })

    it('search filters color entries by label', () => {
      const { picker } = setupPicker()
      const anchor = anchorEl()
      picker.open({ anchor, entries: COLOR_ENTRIES, onApply: vi.fn() })
      const search = picker.root.querySelector('.tp-search') as HTMLInputElement
      search.value = 'neutral'
      search.dispatchEvent(new Event('input', { bubbles: true }))
      const rows = [...picker.root.querySelectorAll('.tp-row')]
      expect(rows.length).toBe(1)
      expect(rows[0].textContent).toContain('neutral-900')
    })

    it('Enter commits the keyboard-active color entry via onApply intact', () => {
      const { picker } = setupPicker()
      const anchor = anchorEl()
      const onApply = vi.fn()
      picker.open({ anchor, entries: COLOR_ENTRIES, onApply })
      const search = picker.root.querySelector('.tp-search') as HTMLInputElement
      search.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true }))
      search.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }))
      expect(onApply).toHaveBeenCalledWith(COLOR_ENTRIES[0])
    })

    it('clicking a color row applies that entry via onApply intact and closes', () => {
      const { picker } = setupPicker()
      const anchor = anchorEl()
      const onApply = vi.fn()
      picker.open({ anchor, entries: COLOR_ENTRIES, onApply })
      const rows = [...picker.root.querySelectorAll('.tp-row')]
      ;(rows[1] as HTMLElement).click()
      expect(onApply).toHaveBeenCalledWith(COLOR_ENTRIES[1])
      expect(picker.root.hidden).toBe(true)
    })
  })
})
