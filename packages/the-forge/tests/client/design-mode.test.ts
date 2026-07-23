// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { Overlay } from '../../src/client/overlay'
import { DesignMode } from '../../src/client/index'
import { DraftStore } from '../../src/client/drafts'
import { Panel } from '../../src/client/panel'
import { readTokens, resetTokensCache } from '../../src/client/tokens'
import * as tokensModule from '../../src/client/tokens'
import { loadLifecycle, saveLifecycle } from '../../src/client/lifecycle-store'
import { SessionFeed } from '../../src/client/session-feed'

// Field identities (data-props) — labels are display text and are free to change.
const P = {
  PY: 'padding-top padding-bottom',
} as const

// DesignMode registers capture-phase listeners on `document`/`window`, which
// persist across tests within this file (jsdom's `document` is shared per
// test file, not per test). Track every instance created via setActive so
// afterEach can deactivate it and avoid leaking listeners into later tests.
const liveModes: DesignMode[] = []

beforeEach(() => {
  document.body.innerHTML = ''
  document.head.innerHTML = ''
  localStorage.clear()
  vi.restoreAllMocks()
  vi.stubGlobal('requestAnimationFrame', (cb: FrameRequestCallback) => {
    cb(0)
    return 1
  })
})

afterEach(() => {
  for (const mode of liveModes.splice(0)) mode.setActive(false)
  vi.unstubAllGlobals()
  document.documentElement.style.marginRight = ''
})

function fullSetup() {
  document.body.innerHTML = `<button data-dc-source="src/Button.tsx:42:8" class="btn">go</button>`
  const overlay = new Overlay()
  overlay.mount()
  const drafts = new DraftStore()
  const panel = new Panel(drafts, () => {})
  overlay.attach(panel.root)
  const mode = new DesignMode(overlay, panel, drafts)
  liveModes.push(mode)
  return { overlay, drafts, panel, mode }
}

describe('DesignMode listener lifecycle (spec §10: zero idle listeners)', () => {
  it('adds no document listeners until activated', () => {
    const addSpy = vi.spyOn(document, 'addEventListener')
    const overlay = new Overlay()
    overlay.mount()
    new DesignMode(overlay)
    expect(addSpy).not.toHaveBeenCalled()
  })

  it('adds capture-phase listeners on activate and removes them on deactivate', () => {
    const addSpy = vi.spyOn(document, 'addEventListener')
    const removeSpy = vi.spyOn(document, 'removeEventListener')
    const winAddSpy = vi.spyOn(window, 'addEventListener')
    const winRemoveSpy = vi.spyOn(window, 'removeEventListener')
    const overlay = new Overlay()
    overlay.mount()
    const mode = new DesignMode(overlay)
    liveModes.push(mode)

    mode.setActive(true)
    const added = [...addSpy.mock.calls.map((c) => c[0]), ...winAddSpy.mock.calls.map((c) => c[0])].sort()
    // Two 'resize' listeners now land on `window`: DesignMode's own onReflow (passive)
    // AND the Dock's onWindowResize (docked by default — see dock.ts enter()), which
    // carries no listener-options object at all.
    expect(added).toEqual(['click', 'dblclick', 'keydown', 'mousemove', 'resize', 'resize', 'scroll'])
    for (const call of addSpy.mock.calls) {
      if (call[0] === 'scroll') expect(call[2]).toEqual({ capture: true, passive: true })
      else expect(call[2]).toBe(true)
    }
    // DesignMode's own resize listener is passive; Dock's onWindowResize is registered
    // with no options object at all (dock.ts enter()) — assert both shapes are present
    // rather than a uniform check across all window listeners.
    expect(winAddSpy.mock.calls.some((call) => call[2] === undefined)).toBe(true)
    expect(winAddSpy.mock.calls.some((call) => JSON.stringify(call[2]) === JSON.stringify({ passive: true }))).toBe(
      true
    )

    mode.setActive(false)
    const removed = [...removeSpy.mock.calls.map((c) => c[0]), ...winRemoveSpy.mock.calls.map((c) => c[0])].sort()
    expect(removed).toEqual(['click', 'dblclick', 'keydown', 'mousemove', 'resize', 'resize', 'scroll'])
  })

  it('toggle button flips design mode', () => {
    const overlay = new Overlay()
    overlay.mount()
    const mode = new DesignMode(overlay)
    liveModes.push(mode)
    overlay.toggle.click()
    expect(mode.active).toBe(true)
    overlay.toggle.click()
    expect(mode.active).toBe(false)
  })

  it('Escape deactivates', () => {
    const overlay = new Overlay()
    overlay.mount()
    const mode = new DesignMode(overlay)
    liveModes.push(mode)
    mode.setActive(true)
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }))
    expect(mode.active).toBe(false)
  })

  it('uses the latest mousemove target when events arrive between frames', () => {
    document.body.innerHTML = `<div data-dc-source="src/a.tsx:1:1" id="first"></div><div data-dc-source="src/b.tsx:2:2" id="second"></div>`
    let queued: FrameRequestCallback | null = null
    vi.stubGlobal('requestAnimationFrame', (cb: FrameRequestCallback) => {
      queued = cb
      return 1
    })
    const overlay = new Overlay()
    overlay.mount()
    const mode = new DesignMode(overlay)
    liveModes.push(mode)
    mode.setActive(true)

    const first = document.getElementById('first')!
    const second = document.getElementById('second')!
    const firstRect = vi.spyOn(first, 'getBoundingClientRect')
    const secondRect = vi.spyOn(second, 'getBoundingClientRect')

    first.dispatchEvent(new MouseEvent('mousemove', { bubbles: true }))
    second.dispatchEvent(new MouseEvent('mousemove', { bubbles: true }))
    queued!(0)

    expect(secondRect).toHaveBeenCalled()
    expect(firstRect).not.toHaveBeenCalled()
  })
})

describe('DesignMode tokens cache invalidation (final review fix #5)', () => {
  afterEach(() => {
    resetTokensCache()
    document.querySelectorAll('style[data-test-dm-tokens]').forEach((el) => el.remove())
    document.documentElement.removeAttribute('style')
  })

  it('activating resets the tokens cache so a theme change since the last activation is picked up', () => {
    document.head.insertAdjacentHTML('beforeend', '<style data-test-dm-tokens>:root { --color-red-500: #fb2c36; }</style>')
    document.documentElement.style.setProperty('--color-red-500', '#fb2c36')

    const overlay = new Overlay()
    overlay.mount()
    const mode = new DesignMode(overlay)
    liveModes.push(mode)

    mode.setActive(true)
    expect(readTokens().colors.some((c) => c.name === 'red-500')).toBe(true)
    mode.setActive(false)

    // Theme changes while inactive (e.g. author edits CSS, HMR reloads styles) — without
    // invalidation, the stale memoized Tokens would still be returned.
    document.documentElement.style.setProperty('--color-blue-500', '#2b7fff')
    document.head.insertAdjacentHTML(
      'beforeend',
      '<style data-test-dm-tokens>:root { --color-blue-500: #2b7fff; }</style>'
    )

    mode.setActive(true)
    expect(readTokens().colors.some((c) => c.name === 'blue-500')).toBe(true)
  })

  it('calls resetTokensCache on activation (spy-verified)', () => {
    const overlay = new Overlay()
    overlay.mount()
    const mode = new DesignMode(overlay)
    liveModes.push(mode)
    const spy = vi.spyOn(tokensModule, 'resetTokensCache')
    mode.setActive(true)
    expect(spy).toHaveBeenCalled()
  })
})

describe('DesignMode selection (M2)', () => {
  it('click selects: retained element, persistent outline, editable panel', () => {
    const { overlay, mode } = fullSetup()
    mode.setActive(true)
    const btn = document.querySelector('button')!
    const appHandler = vi.fn()
    btn.addEventListener('click', appHandler)
    btn.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }))
    expect(appHandler).not.toHaveBeenCalled()
    expect(mode.selected).toBe(btn)
    const root = overlay.host.shadowRoot!
    expect((root.getElementById('select-outline') as HTMLElement).hidden).toBe(false)
    expect((root.getElementById('panel') as HTMLElement).hidden).toBe(false)
    expect(root.getElementById('panel')!.textContent).toContain('src/Button.tsx:42:8')
  })

  it('clicking an untagged area deselects', () => {
    const { mode } = fullSetup()
    mode.setActive(true)
    const btn = document.querySelector('button')!
    btn.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }))
    document.body.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }))
    expect(mode.selected).toBeNull()
  })

  it('Escape deselects first, exits on second press, and stops propagation', () => {
    const { mode } = fullSetup()
    mode.setActive(true)
    const btn = document.querySelector('button')!
    btn.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }))
    const appEsc = vi.fn()
    // Design mode's Escape listener is on `document` in the capture phase, so it
    // runs during the capture descent toward any deeper target — including
    // document.body. Dispatching on document.body (bubbling) puts body genuinely
    // in the propagation path, so stopPropagation() during capture can actually
    // be observed preventing the bubble-phase listener below from firing.
    document.body.addEventListener('keydown', appEsc)
    document.body.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
    expect(mode.selected).toBeNull()
    expect(mode.active).toBe(true)
    document.body.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
    expect(mode.active).toBe(false)
    expect(appEsc).not.toHaveBeenCalled()
  })

  it('Escape from inside the overlay host does NOT deselect', () => {
    const { overlay, mode } = fullSetup()
    mode.setActive(true)
    const btn = document.querySelector('button')!
    btn.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }))
    expect(mode.selected).toBe(btn)
    // Dispatch Escape with the overlay host as the target (shadow retargeting)
    const ev = new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })
    Object.defineProperty(ev, 'target', { value: overlay.host, configurable: true })
    document.dispatchEvent(ev)
    // Selection should remain
    expect(mode.selected).toBe(btn)
    expect(mode.active).toBe(true)
    // But Escape from document should still deselect
    document.body.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
    expect(mode.selected).toBeNull()
  })

  it('drafts survive deactivation but chrome hides', () => {
    const { mode, drafts } = fullSetup()
    mode.setActive(true)
    const btn = document.querySelector('button')! as HTMLElement
    drafts.apply(btn, 'padding-top', '20px')
    mode.setActive(false)
    expect(btn.style.getPropertyValue('padding-top')).toBe('20px')
  })

  it('exiting design mode while comparing restores draft previews', () => {
    const { mode, drafts } = fullSetup()
    mode.setActive(true)
    const btn = document.querySelector('button')! as HTMLElement
    drafts.apply(btn, 'padding-top', '20px')
    drafts.compareAll(true)
    expect(btn.style.getPropertyValue('padding-top')).toBe('')
    mode.setActive(false)
    expect(btn.style.getPropertyValue('padding-top')).toBe('20px')
  })

  it('draft changes drive the status strip and compare-all button', () => {
    const { overlay, mode, drafts } = fullSetup()
    mode.setActive(true)
    const btn = document.querySelector('button')! as HTMLElement
    drafts.apply(btn, 'width', '100px')
    const status = overlay.host.shadowRoot!.getElementById('status') as HTMLElement
    expect(status.hidden).toBe(false)
    overlay.compareAllButton.click()
    expect(drafts.isComparingAll()).toBe(true)
    overlay.resetAllButton.click()
    expect(drafts.elementCount()).toBe(0)
    // The watch strip now renders ONLY for a genuinely linked watcher — 'live' or 'asleep'
    // (composer consolidation Task 3 reversed the 2026-07-05 upfront "○ Not linked" hint: the
    // strip no longer renders for 'none'). The watch poll here never resolves synchronously
    // (real setTimeout(0), not flushed by this test), so watcher state is still its initial
    // 'none' — with zero drafts and no verifier summary, the strip is now hidden.
    expect(status.hidden).toBe(true)
  })

  it('scroll re-measures the selection even when a hover frame is queued', () => {
    const queue: FrameRequestCallback[] = []
    vi.stubGlobal('requestAnimationFrame', (cb: FrameRequestCallback) => {
      queue.push(cb)
      return queue.length
    })
    const { overlay, mode } = fullSetup()
    mode.setActive(true)
    const btn = document.querySelector('button')!
    btn.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }))
    btn.dispatchEvent(new MouseEvent('mousemove', { bubbles: true }))
    document.dispatchEvent(new Event('scroll'))
    expect(queue.length).toBe(2) // hover + reflow queued independently (shared-id code dropped the reflow)
    const spy = vi.spyOn(overlay, 'showSelectOutline')
    for (const cb of queue.splice(0)) cb(0)
    expect(spy).toHaveBeenCalled() // the previously-dropped re-measure

    // hover redraws on the next mousemove after a scroll
    btn.dispatchEvent(new MouseEvent('mousemove', { bubbles: true }))
    for (const cb of queue.splice(0)) cb(0)
    const outline = overlay.host.shadowRoot!.getElementById('outline') as HTMLElement
    expect(outline.hidden).toBe(true) // hovering the SELECTED element → hover outline stays suppressed
  })

  it('copy button writes the rendered change request to the clipboard', async () => {
    const writeText = vi.fn().mockResolvedValue(undefined)
    vi.stubGlobal('navigator', { ...navigator, clipboard: { writeText } })
    const { overlay, mode, drafts } = fullSetup()
    mode.setActive(true)
    const btn = document.querySelector('button')! as HTMLElement
    drafts.apply(btn, 'padding-top', '24px')
    overlay.copyButton.click()
    await Promise.resolve()
    expect(writeText).toHaveBeenCalledTimes(1)
    const md = writeText.mock.calls[0][0] as string
    expect(md).toContain('# Design change request')
    expect(md).toContain('src/Button.tsx:42:8')
    expect(md).toContain('padding-top')
    // Copy is a wrapper-less path (pasted into an arbitrary agent with no command text in
    // context), so the standalone render carries the guardrails the queued markdown dropped.
    expect(md).toContain('this call site only')
    expect(md).toContain('Do not run the app')
    expect(overlay.copyButton.textContent).toBe('Copied ✓')
  })

  it('copy button reports failure without throwing', async () => {
    const writeText = vi.fn().mockRejectedValue(new Error('denied'))
    vi.stubGlobal('navigator', { ...navigator, clipboard: { writeText } })
    const { overlay, mode, drafts } = fullSetup()
    mode.setActive(true)
    const btn = document.querySelector('button')! as HTMLElement
    drafts.apply(btn, 'padding-top', '24px')
    overlay.copyButton.click()
    await Promise.resolve()
    await Promise.resolve()
    expect(overlay.copyButton.textContent).toBe('Copy failed')
  })
})

describe('DesignMode multi-select (B6)', () => {
  function multiSetup() {
    document.body.innerHTML = `
      <button data-dc-source="src/Button.tsx:42:8" class="btn" id="a">a</button>
      <button data-dc-source="src/Button2.tsx:1:1" class="btn" id="b">b</button>
      <button data-dc-source="src/Button3.tsx:2:2" class="btn" id="c">c</button>
    `
    const overlay = new Overlay()
    overlay.mount()
    const drafts = new DraftStore()
    const panel = new Panel(drafts, () => {})
    overlay.attach(panel.root)
    const mode = new DesignMode(overlay, panel, drafts)
    liveModes.push(mode)
    return { overlay, drafts, panel, mode }
  }

  function click(el: Element, opts: MouseEventInit = {}): void {
    el.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, ...opts }))
  }

  it('plain click replaces the selection with just that element', () => {
    const { mode } = multiSetup()
    mode.setActive(true)
    const a = document.getElementById('a')!
    const b = document.getElementById('b')!
    click(a)
    expect(mode.selection).toEqual([a])
    click(b)
    expect(mode.selection).toEqual([b])
  })

  it('shift+click on an unselected element adds it to the selection', () => {
    const { mode } = multiSetup()
    mode.setActive(true)
    const a = document.getElementById('a')!
    const b = document.getElementById('b')!
    click(a)
    click(b, { shiftKey: true })
    expect(mode.selection).toEqual([a, b])
  })

  it('shift+click on an already-selected element removes it', () => {
    const { mode } = multiSetup()
    mode.setActive(true)
    const a = document.getElementById('a')!
    const b = document.getElementById('b')!
    click(a)
    click(b, { shiftKey: true })
    click(a, { shiftKey: true })
    expect(mode.selection).toEqual([b])
  })

  it('shift+click removing the last remaining element deselects entirely', () => {
    const { mode } = multiSetup()
    mode.setActive(true)
    const a = document.getElementById('a')!
    click(a)
    click(a, { shiftKey: true })
    expect(mode.selection).toEqual([])
  })

  it('get selected() returns the first selection member (or null) for single-semantics call sites', () => {
    const { mode } = multiSetup()
    mode.setActive(true)
    const a = document.getElementById('a')!
    const b = document.getElementById('b')!
    expect(mode.selected).toBeNull()
    click(a)
    expect(mode.selected).toBe(a)
    click(b, { shiftKey: true })
    expect(mode.selected).toBe(a) // first member, unchanged by appending b
  })

  it('Escape clears the entire multi-selection', () => {
    const { mode } = multiSetup()
    mode.setActive(true)
    const a = document.getElementById('a')!
    const b = document.getElementById('b')!
    click(a)
    click(b, { shiftKey: true })
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }))
    expect(mode.selection).toEqual([])
    expect(mode.active).toBe(true) // first Escape only deselects
  })

  it('clicking untagged area deselects the whole multi-selection', () => {
    const { mode } = multiSetup()
    mode.setActive(true)
    const a = document.getElementById('a')!
    const b = document.getElementById('b')!
    click(a)
    click(b, { shiftKey: true })
    click(document.body)
    expect(mode.selection).toEqual([])
  })

  it('overlay shows a pooled multi-outline per selected element (single selection keeps using #select-outline)', () => {
    const { overlay, mode } = multiSetup()
    mode.setActive(true)
    const a = document.getElementById('a')!
    const b = document.getElementById('b')!
    const c = document.getElementById('c')!
    click(a)
    const root = overlay.host.shadowRoot!
    expect((root.getElementById('select-outline') as HTMLElement).hidden).toBe(false)
    expect(root.querySelectorAll('.select-outline-multi').length).toBe(0)

    click(b, { shiftKey: true })
    click(c, { shiftKey: true })
    expect((root.getElementById('select-outline') as HTMLElement).hidden).toBe(true)
    const multi = [...root.querySelectorAll('.select-outline-multi')] as HTMLElement[]
    expect(multi.filter((d) => !d.hidden)).toHaveLength(3)
  })

  it('shrinking back to a single element switches back to #select-outline and hides the multi pool', () => {
    const { overlay, mode } = multiSetup()
    mode.setActive(true)
    const a = document.getElementById('a')!
    const b = document.getElementById('b')!
    click(a)
    click(b, { shiftKey: true })
    click(b, { shiftKey: true }) // remove b -> back to [a]
    const root = overlay.host.shadowRoot!
    expect((root.getElementById('select-outline') as HTMLElement).hidden).toBe(false)
    expect([...root.querySelectorAll('.select-outline-multi')].every((d: Element) => (d as HTMLElement).hidden)).toBe(
      true
    )
  })

  it('a single→single selection hop tweens the outline; the first selection does not (motion pass Task 7)', () => {
    const { overlay, mode } = multiSetup()
    mode.setActive(true)
    const a = document.getElementById('a')!
    const b = document.getElementById('b')!
    const spy = vi.spyOn(overlay, 'showSelectOutline')
    click(a) // first selection: outline was hidden, no tween
    expect(spy.mock.calls[0][1]).toBeFalsy()
    click(b) // single -> single hop: tweens
    expect(spy.mock.calls[1][1]).toBe(true)
  })

  it('panel.show is called with the full selection array and the first element data in multi-select', () => {
    const { panel, mode } = multiSetup()
    mode.setActive(true)
    const showSpy = vi.spyOn(panel, 'show')
    const a = document.getElementById('a')!
    const b = document.getElementById('b')!
    click(a)
    click(b, { shiftKey: true })
    expect(showSpy).toHaveBeenLastCalledWith([a, b], expect.objectContaining({ tag: 'button' }))
  })

  it('deselecting shows the docked empty state (design mode still active — docked by default)', () => {
    const { overlay, mode } = multiSetup()
    mode.setActive(true)
    const a = document.getElementById('a')!
    click(a)
    click(document.body)
    const root = overlay.host.shadowRoot!
    const panelEl = root.getElementById('panel') as HTMLElement
    expect(panelEl.hidden).toBe(false)
    expect((panelEl.querySelector('.panel-empty') as HTMLElement).hidden).toBe(false)
  })
})

// The standalone 'Send to agent' button was retired by composer consolidation (Task 3): the
// composer's ↑ (.chat-send) is now the single send surface for both drafted edits and typed
// chat. clickSend() is the drop-in trigger these tests use in place of the old
// overlay.sendButton.click() — same button element the "chat input cluster wiring" describe
// block already drives. The old button's flash-copy feedback ('No changes'/'Already sent'/
// 'Send failed'/the per-rung 'Sent — …' labels) went away WITH the button — there is nothing
// left to assert text content on, so those assertions are dropped; the underlying mechanics
// (POST calls, duplicate filtering, registered ids, onSendComplete) are still asserted below.
// (sentLabelFor, the per-rung flash copy's source, was deleted outright once production-dead —
// postDispatch no longer even parses the rung from the /dispatch response.)
describe('DesignMode composer send verb — drafts (M4 / Task 3)', () => {
  /** Flushes enough microtasks for the /queue POST *and* the chained /dispatch POST to settle. */
  async function flushSend(): Promise<void> {
    for (let i = 0; i < 6; i++) await Promise.resolve()
  }

  function clickSend(panelRoot: HTMLElement): void {
    ;(panelRoot.querySelector('.chat-send') as HTMLButtonElement).click()
  }

  it('a send where every draft is a no-op does not POST /queue', async () => {
    const fetchMock = vi.fn((url: string) => {
      // feed start() fetches the events stream — park it, don't throw
      if (url.startsWith('/__the-forge/session/events')) return new Promise<never>(() => {})
      return Promise.resolve({ ok: true, json: async () => ({}) })
    })
    vi.stubGlobal('fetch', fetchMock)
    const { mode, drafts, panel } = fullSetup()
    mode.setActive(true)
    const btn = document.querySelector('button')! as HTMLElement
    // jsdom's UA stylesheet gives <button> a 2px default border-width — drafting the same
    // value is a genuine no-op (same shape as a user scrubbing a value back to its original).
    drafts.apply(btn, 'border-top-width', '2px')
    clickSend(panel.root)
    await flushSend()
    // After wiring the SessionFeed, start() always fetches /session/events — check no /queue POST
    expect(fetchMock).not.toHaveBeenCalledWith('/__the-forge/queue', expect.anything())
    expect(mode.session.size()).toBe(0)
  })

  it('Copy for agent with only no-op drafts does not copy and flashes "No changes"', async () => {
    const writeText = vi.fn().mockResolvedValue(undefined)
    vi.stubGlobal('navigator', { ...navigator, clipboard: { writeText } })
    const { overlay, mode, drafts } = fullSetup()
    mode.setActive(true)
    const btn = document.querySelector('button')! as HTMLElement
    drafts.apply(btn, 'border-top-width', '2px') // jsdom UA default — a genuine no-op
    overlay.copyButton.click()
    await flushSend()
    expect(writeText).not.toHaveBeenCalled()
    expect(overlay.copyButton.textContent).toBe('No changes')
  })

  it('Copy for agent still works for an in-flight request (no duplicate filter on copy — manual fallback)', async () => {
    const writeText = vi.fn().mockResolvedValue(undefined)
    vi.stubGlobal('navigator', { ...navigator, clipboard: { writeText } })
    const fetchMock = vi.fn((url: string) => {
      if (url === '/__the-forge/queue') return Promise.resolve({ ok: true, json: async () => ({ id: 'q1' }) })
      if (url === '/__the-forge/dispatch') return Promise.resolve({ ok: true, json: async () => ({ rung: 'manual', detail: '' }) })
      return Promise.resolve({ ok: true, json: async () => ({ items: [], watcher: 'none' }) })
    })
    vi.stubGlobal('fetch', fetchMock)
    const { overlay, mode, drafts, panel } = fullSetup()
    mode.setActive(true)
    const btn = document.querySelector('button')! as HTMLElement
    drafts.apply(btn, 'padding-top', '24px')
    clickSend(panel.root)
    await flushSend() // request is now in flight

    overlay.copyButton.click()
    await flushSend()
    expect(writeText).toHaveBeenCalledTimes(1) // copy is the manual escape hatch — never blocked by in-flight state
  })

  it('re-clicking Send with an identical in-flight request does not re-queue', async () => {
    const fetchMock = vi.fn((url: string) => {
      if (url === '/__the-forge/queue') return Promise.resolve({ ok: true, json: async () => ({ id: 'q1' }) })
      if (url === '/__the-forge/dispatch') return Promise.resolve({ ok: true, json: async () => ({ rung: 'manual', detail: '' }) })
      return Promise.resolve({ ok: true, json: async () => ({ items: [], watcher: 'none' }) })
    })
    vi.stubGlobal('fetch', fetchMock)
    const { mode, drafts, panel } = fullSetup()
    mode.setActive(true)
    const btn = document.querySelector('button')! as HTMLElement
    drafts.apply(btn, 'padding-top', '24px')
    clickSend(panel.root)
    await flushSend() // first send settles — drafts stay live until verification

    clickSend(panel.root) // impatient second click, nothing re-edited
    await flushSend()

    const queueCalls = fetchMock.mock.calls.filter(([url]) => url === '/__the-forge/queue')
    expect(queueCalls).toHaveLength(1)
    expect(mode.session.pendingIds()).toEqual(['q1'])
  })

  it('reverting all drafts while another send is in flight does not re-queue (agrees with Copy\'s "No changes")', async () => {
    const fetchMock = vi.fn((url: string) => {
      if (url === '/__the-forge/queue') return Promise.resolve({ ok: true, json: async () => ({ id: 'q1' }) })
      if (url === '/__the-forge/dispatch') return Promise.resolve({ ok: true, json: async () => ({ rung: 'manual', detail: '' }) })
      return Promise.resolve({ ok: true, json: async () => ({ items: [], watcher: 'none' }) })
    })
    vi.stubGlobal('fetch', fetchMock)
    const { mode, drafts, panel } = fullSetup()
    mode.setActive(true)
    const btn = document.querySelector('button')! as HTMLElement
    drafts.apply(btn, 'padding-top', '24px')
    clickSend(panel.root)
    await flushSend() // q1 in flight

    drafts.apply(btn, 'padding-top', '') // reverted to the original — the builder now produces nothing
    clickSend(panel.root)
    await flushSend()

    expect(fetchMock.mock.calls.filter(([url]) => url === '/__the-forge/queue')).toHaveLength(1)
    expect(mode.session.pendingIds()).toEqual(['q1'])
  })

  it('re-editing an in-flight element to a NEW value sends again (not a duplicate)', async () => {
    let nextId = 1
    const fetchMock = vi.fn((url: string) => {
      if (url === '/__the-forge/queue') return Promise.resolve({ ok: true, json: async () => ({ id: `q${nextId++}` }) })
      if (url === '/__the-forge/dispatch') return Promise.resolve({ ok: true, json: async () => ({ rung: 'manual', detail: '' }) })
      return Promise.resolve({ ok: true, json: async () => ({ items: [], watcher: 'none' }) })
    })
    vi.stubGlobal('fetch', fetchMock)
    const { mode, drafts, panel } = fullSetup()
    mode.setActive(true)
    const btn = document.querySelector('button')! as HTMLElement
    drafts.apply(btn, 'padding-top', '24px')
    clickSend(panel.root)
    await flushSend()

    drafts.apply(btn, 'padding-top', '32px') // user kept editing — new value
    clickSend(panel.root)
    await flushSend()

    const queueCalls = fetchMock.mock.calls.filter(([url]) => url === '/__the-forge/queue')
    expect(queueCalls).toHaveLength(2)
    expect(mode.session.pendingIds().sort()).toEqual(['q1', 'q2'])
  })

  it('send posts the request and registers pending ids', async () => {
    const fetchMock = vi.fn((url: string) => {
      if (url === '/__the-forge/queue') return Promise.resolve({ ok: true, json: async () => ({ id: 'q1' }) })
      if (url === '/__the-forge/dispatch') return Promise.resolve({ ok: true, json: async () => ({ rung: 'tmux', detail: 'x' }) })
      if (url.startsWith('/__the-forge/session/events')) return new Promise<never>(() => {}) // feed start() parks here
      throw new Error(`unexpected fetch: ${url}`)
    })
    vi.stubGlobal('fetch', fetchMock)
    const { mode, drafts, panel } = fullSetup()
    mode.setActive(true)
    const btn = document.querySelector('button')! as HTMLElement
    drafts.apply(btn, 'padding-top', '24px')
    clickSend(panel.root)
    await flushSend()
    expect(fetchMock).toHaveBeenCalledWith('/__the-forge/queue', expect.objectContaining({ method: 'POST' }))
    const queueCall = fetchMock.mock.calls.find(([url]) => url === '/__the-forge/queue') as unknown as [string, { body: string }]
    const body = JSON.parse(queueCall[1].body)
    expect(body.markdown).toContain('# Design change request')
    expect(mode.session.pendingIds()).toEqual(['q1'])
  })

  describe('dispatch chaining after a successful queue POST', () => {
    function stubQueueThenDispatch(dispatchResponse: { rung: string; detail: string }) {
      const fetchMock = vi.fn((url: string) => {
        if (url === '/__the-forge/queue') return Promise.resolve({ ok: true, json: async () => ({ id: 'q1' }) })
        if (url === '/__the-forge/dispatch') return Promise.resolve({ ok: true, json: async () => dispatchResponse })
        if (url.startsWith('/__the-forge/session/events')) return new Promise<never>(() => {}) // feed start() parks here
        throw new Error(`unexpected fetch: ${url}`)
      })
      vi.stubGlobal('fetch', fetchMock)
      return fetchMock
    }

    it('POSTs /dispatch after a successful /queue POST', async () => {
      const fetchMock = stubQueueThenDispatch({ rung: 'tmux', detail: 'x' })
      const { mode, drafts, panel } = fullSetup()
      mode.setActive(true)
      const btn = document.querySelector('button')! as HTMLElement
      drafts.apply(btn, 'padding-top', '24px')
      clickSend(panel.root)
      await flushSend()
      expect(fetchMock).toHaveBeenCalledWith('/__the-forge/dispatch', expect.objectContaining({ method: 'POST' }))
    })

    it('still registers the send as successful (pending id tracked) even if /dispatch POST fails', async () => {
      const fetchMock = vi.fn((url: string) => {
        if (url === '/__the-forge/queue') return Promise.resolve({ ok: true, json: async () => ({ id: 'q1' }) })
        if (url === '/__the-forge/dispatch') return Promise.reject(new Error('dispatch network error'))
        if (url.startsWith('/__the-forge/session/events')) return new Promise<never>(() => {}) // feed start() parks here
        throw new Error(`unexpected fetch: ${url}`)
      })
      vi.stubGlobal('fetch', fetchMock)
      const { mode, drafts, panel } = fullSetup()
      mode.setActive(true)
      const btn = document.querySelector('button')! as HTMLElement
      drafts.apply(btn, 'padding-top', '24px')
      clickSend(panel.root)
      await flushSend()
      expect(mode.session.pendingIds()).toEqual(['q1'])
    })
  })

  it('send includes X-Forge-Secret header when globalThis.__THE_FORGE__.secret is set', async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, json: async () => ({ id: 'q1' }) })
    vi.stubGlobal('fetch', fetchMock)
    ;(globalThis as { __THE_FORGE__?: { secret?: string } }).__THE_FORGE__ = { secret: 'shh-secret' }
    const { mode, drafts, panel } = fullSetup()
    mode.setActive(true)
    const btn = document.querySelector('button')! as HTMLElement
    drafts.apply(btn, 'padding-top', '24px')
    clickSend(panel.root)
    await Promise.resolve()
    await Promise.resolve()
    const headers = fetchMock.mock.calls[0][1].headers
    expect(headers['X-Forge-Secret']).toBe('shh-secret')
    delete (globalThis as { __THE_FORGE__?: unknown }).__THE_FORGE__
  })

  it('send omits X-Forge-Secret header when no secret is configured', async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, json: async () => ({ id: 'q1' }) })
    vi.stubGlobal('fetch', fetchMock)
    const { mode, drafts, panel } = fullSetup()
    mode.setActive(true)
    const btn = document.querySelector('button')! as HTMLElement
    drafts.apply(btn, 'padding-top', '24px')
    clickSend(panel.root)
    await Promise.resolve()
    await Promise.resolve()
    const headers = fetchMock.mock.calls[0][1].headers
    expect(headers['X-Forge-Secret']).toBeUndefined()
  })

  it('send registers the live element mapping keyed by the server-assigned id', async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, json: async () => ({ id: 'q7' }) })
    vi.stubGlobal('fetch', fetchMock)
    const { mode, drafts, panel } = fullSetup()
    mode.setActive(true)
    const btn = document.querySelector('button')! as HTMLElement
    drafts.apply(btn, 'padding-top', '24px')
    clickSend(panel.root)
    await Promise.resolve()
    await Promise.resolve()
    const entry = mode.session.take('q7')!
    expect(entry.elements).toHaveLength(1)
    expect(entry.elements[0].el).toBe(btn)
    expect(entry.elements[0].dcSource).toBe('src/Button.tsx:42:8')
    expect(entry.elements[0].changes[0].property).toBe('padding-top')
    expect(entry.elements[0].draftProps).toEqual(['padding-top'])
  })

  it('send failure leaves drafts untouched and registers nothing', async () => {
    const fetchMock = vi.fn().mockRejectedValue(new Error('network down'))
    vi.stubGlobal('fetch', fetchMock)
    const { mode, drafts, panel } = fullSetup()
    mode.setActive(true)
    const btn = document.querySelector('button')! as HTMLElement
    drafts.apply(btn, 'padding-top', '24px')
    clickSend(panel.root)
    await Promise.resolve()
    await Promise.resolve()
    expect(mode.session.size()).toBe(0)
    expect(drafts.hasDrafts(btn)).toBe(true)
    expect(btn.style.getPropertyValue('padding-top')).toBe('24px')
  })

  it('send failure on non-200 response also registers nothing', async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: false, json: async () => ({ error: 'bad' }) })
    vi.stubGlobal('fetch', fetchMock)
    const { mode, drafts, panel } = fullSetup()
    mode.setActive(true)
    const btn = document.querySelector('button')! as HTMLElement
    drafts.apply(btn, 'padding-top', '24px')
    clickSend(panel.root)
    await Promise.resolve()
    await Promise.resolve()
    expect(mode.session.size()).toBe(0)
  })

  it('calls onSendComplete after a successful send registers', async () => {
    const fetchMock = vi.fn((url: string) => {
      if (url === '/__the-forge/queue') return Promise.resolve({ ok: true, json: async () => ({ id: 'q9' }) })
      return Promise.resolve({ ok: true, json: async () => ({ rung: 'tmux', detail: 'x' }) })
    })
    vi.stubGlobal('fetch', fetchMock)
    const { mode, drafts, panel } = fullSetup()
    const onSendComplete = vi.fn()
    mode.onSendComplete = onSendComplete
    mode.setActive(true)
    const btn = document.querySelector('button')! as HTMLElement
    drafts.apply(btn, 'padding-top', '24px')
    clickSend(panel.root)
    await flushSend()
    expect(onSendComplete).toHaveBeenCalledTimes(1)
  })

  it('two rapid clicks result in exactly one /queue POST (re-entrancy guard)', async () => {
    const fetchMock = vi.fn((url: string) => {
      if (url === '/__the-forge/queue') return Promise.resolve({ ok: true, json: async () => ({ id: 'q1' }) })
      return Promise.resolve({ ok: true, json: async () => ({ rung: 'tmux', detail: 'x' }) })
    })
    vi.stubGlobal('fetch', fetchMock)
    const { mode, drafts, panel } = fullSetup()
    mode.setActive(true)
    const btn = document.querySelector('button')! as HTMLElement
    drafts.apply(btn, 'padding-top', '24px')

    clickSend(panel.root)
    clickSend(panel.root)
    await flushSend()
    const queueCalls = fetchMock.mock.calls.filter(([url]) => url === '/__the-forge/queue')
    expect(queueCalls).toHaveLength(1)
  })
})

// The send-everything verb itself (composer consolidation Task 3): feed.onSend combines the
// drafts leg (sendDrafts) and the chat leg (sendChat) behind ONE gesture, drafts first when
// both are present — see the why-comment on feed.onSend in index.ts for the nudge-before-FIFO
// rationale. Also covers the watch strip's new linked-only gating and the setSessionState
// wiring off the same watch poll tick refreshStatus already runs from.
describe('composer send-everything verb + watch strip gating (Task 3)', () => {
  function clickSend(panelRoot: HTMLElement): void {
    ;(panelRoot.querySelector('.chat-send') as HTMLButtonElement).click()
  }

  it('drafts only: fires the queue+dispatch POSTs and never POSTs /session/say', async () => {
    const fetchMock = vi.fn((url: string) => {
      if (url === '/__the-forge/queue') return Promise.resolve({ ok: true, json: async () => ({ id: 'q1' }) })
      if (url === '/__the-forge/dispatch') return Promise.resolve({ ok: true, json: async () => ({ rung: 'manual', detail: '' }) })
      if (url.startsWith('/__the-forge/session/events')) return new Promise<never>(() => {})
      return Promise.resolve({ ok: true, json: async () => ({ watcher: 'none', session: 'idle' }) })
    })
    vi.stubGlobal('fetch', fetchMock)
    const { mode, drafts, panel } = fullSetup()
    mode.setActive(true)
    const btn = document.querySelector('button')! as HTMLElement
    drafts.apply(btn, 'padding-top', '24px')
    clickSend(panel.root)
    for (let i = 0; i < 8; i++) await Promise.resolve()
    const urls = fetchMock.mock.calls.map(([url]) => url)
    expect(urls).toContain('/__the-forge/queue')
    expect(urls).toContain('/__the-forge/dispatch')
    expect(urls).not.toContain('/__the-forge/session/say')
  })

  it('text only: POSTs /session/say and never POSTs /queue', async () => {
    const fetchMock = vi.fn((url: string) => {
      if (url === '/__the-forge/session/say') return Promise.resolve({ ok: true, status: 200, json: async () => ({ ok: true }) })
      if (url.startsWith('/__the-forge/session/events')) return new Promise<never>(() => {})
      return Promise.resolve({ ok: true, json: async () => ({ watcher: 'none', session: 'idle' }) })
    })
    vi.stubGlobal('fetch', fetchMock)
    const { mode, panel } = fullSetup()
    mode.setActive(true)
    const textarea = panel.root.querySelector('.chat-textarea') as HTMLTextAreaElement
    textarea.value = 'hello there'
    clickSend(panel.root)
    for (let i = 0; i < 8; i++) await Promise.resolve()
    const urls = fetchMock.mock.calls.map(([url]) => url)
    expect(urls).toContain('/__the-forge/session/say')
    expect(urls).not.toContain('/__the-forge/queue')
  })

  it('both drafts and text: queues drafts FIRST, then POSTs /session/say (server nudge-before-FIFO order)', async () => {
    const fetchMock = vi.fn((url: string) => {
      if (url === '/__the-forge/queue') return Promise.resolve({ ok: true, json: async () => ({ id: 'q1' }) })
      if (url === '/__the-forge/dispatch') return Promise.resolve({ ok: true, json: async () => ({ rung: 'manual', detail: '' }) })
      if (url === '/__the-forge/session/say') return Promise.resolve({ ok: true, status: 200, json: async () => ({ ok: true }) })
      if (url.startsWith('/__the-forge/session/events')) return new Promise<never>(() => {})
      return Promise.resolve({ ok: true, json: async () => ({ watcher: 'none', session: 'idle' }) })
    })
    vi.stubGlobal('fetch', fetchMock)
    const { mode, drafts, panel } = fullSetup()
    mode.setActive(true)
    const btn = document.querySelector('button')! as HTMLElement
    drafts.apply(btn, 'padding-top', '24px')
    const textarea = panel.root.querySelector('.chat-textarea') as HTMLTextAreaElement
    textarea.value = 'also do this'
    clickSend(panel.root)
    for (let i = 0; i < 10; i++) await Promise.resolve()
    const urls = fetchMock.mock.calls.map(([url]) => url)
    const queueIndex = urls.indexOf('/__the-forge/queue')
    const sayIndex = urls.indexOf('/__the-forge/session/say')
    expect(queueIndex).toBeGreaterThanOrEqual(0)
    expect(sayIndex).toBeGreaterThan(queueIndex) // chat leg fires only after the queue leg settles
    expect(textarea.value).toBe('') // the chat leg still ran its own clear-on-success
  })

  // 2026-07-10 review (ordering race): "drafts apply before the chat turn" used to rest on
  // /dispatch and /session/say racing over the network — if /say won, SessionManager sent the
  // chat turn first and parked the pull nudge behind it. The drafts leg now resolves only after
  // /dispatch settles, making the ordering structural: by the time /say leaves the browser, the
  // embedded rung has already registered the nudge (or auto-started with it), and the server's
  // nudge-before-FIFO flush does the rest.
  it('both drafts and text: /session/say fires only AFTER /dispatch settles, not merely after /queue', async () => {
    let resolveDispatch!: (v: { ok: boolean; json: () => Promise<unknown> }) => void
    const fetchMock = vi.fn((url: string) => {
      if (url === '/__the-forge/queue') return Promise.resolve({ ok: true, json: async () => ({ id: 'q1' }) })
      if (url === '/__the-forge/dispatch') return new Promise((resolve) => (resolveDispatch = resolve))
      if (url === '/__the-forge/session/say') return Promise.resolve({ ok: true, status: 200, json: async () => ({ ok: true }) })
      if (url.startsWith('/__the-forge/session/events')) return new Promise<never>(() => {})
      return Promise.resolve({ ok: true, json: async () => ({ watcher: 'none', session: 'ready' }) })
    })
    vi.stubGlobal('fetch', fetchMock)
    const { mode, drafts, panel } = fullSetup()
    mode.setActive(true)
    const btn = document.querySelector('button')! as HTMLElement
    drafts.apply(btn, 'padding-top', '24px')
    const textarea = panel.root.querySelector('.chat-textarea') as HTMLTextAreaElement
    textarea.value = 'also do this'
    clickSend(panel.root)
    for (let i = 0; i < 10; i++) await Promise.resolve()
    let urls = fetchMock.mock.calls.map(([url]) => url)
    expect(urls).toContain('/__the-forge/queue')
    expect(urls).toContain('/__the-forge/dispatch')
    expect(urls).not.toContain('/__the-forge/session/say') // dispatch unsettled — chat must hold

    resolveDispatch({ ok: true, json: async () => ({ rung: 'embedded', detail: '' }) })
    for (let i = 0; i < 10; i++) await Promise.resolve()
    urls = fetchMock.mock.calls.map(([url]) => url)
    expect(urls).toContain('/__the-forge/session/say')
  })

  // Task 9 (review finding): a second ↑ fired while the first gesture's drafts leg is still
  // in flight used to resolve immediately (the re-entrancy guard returned Promise.resolve(true)
  // synchronously), so the second gesture's chat leg raced /say ahead of the first gesture's own
  // /dispatch — defeating the structural drafts-before-chat ordering the test above pins. The fix
  // makes the re-entrancy guard return the SAME in-flight promise, so a second gesture's chat leg
  // waits for the real queue+dispatch outcome exactly like the first gesture's does.
  it('a second ↑ before /queue resolves: /session/say still fires only after /dispatch settles (Task 9)', async () => {
    let resolveQueue!: (v: { ok: boolean; json: () => Promise<{ id: string }> }) => void
    let resolveDispatch!: (v: { ok: boolean; json: () => Promise<unknown> }) => void
    const fetchMock = vi.fn((url: string) => {
      if (url === '/__the-forge/queue') return new Promise((resolve) => (resolveQueue = resolve))
      if (url === '/__the-forge/dispatch') return new Promise((resolve) => (resolveDispatch = resolve))
      if (url === '/__the-forge/session/say') return Promise.resolve({ ok: true, status: 200, json: async () => ({ ok: true }) })
      if (url.startsWith('/__the-forge/session/events')) return new Promise<never>(() => {})
      return Promise.resolve({ ok: true, json: async () => ({ watcher: 'none', session: 'idle' }) })
    })
    vi.stubGlobal('fetch', fetchMock)
    const { mode, drafts, panel } = fullSetup()
    mode.setActive(true)
    const btn = document.querySelector('button')! as HTMLElement
    drafts.apply(btn, 'padding-top', '24px')
    const textarea = panel.root.querySelector('.chat-textarea') as HTMLTextAreaElement
    textarea.value = 'first gesture text'
    clickSend(panel.root) // gesture 1 — /queue POST fired, unresolved
    for (let i = 0; i < 4; i++) await Promise.resolve()

    clickSend(panel.root) // gesture 2 — drafts leg re-entrant, chat leg must NOT race ahead
    for (let i = 0; i < 4; i++) await Promise.resolve()

    let urls = fetchMock.mock.calls.map(([url]) => url)
    expect(urls.filter((u) => u === '/__the-forge/queue')).toHaveLength(1) // still exactly one /queue POST
    expect(urls).not.toContain('/__the-forge/session/say') // neither gesture's chat leg has fired yet

    resolveQueue({ ok: true, json: async () => ({ id: 'q1' }) })
    for (let i = 0; i < 6; i++) await Promise.resolve()
    urls = fetchMock.mock.calls.map(([url]) => url)
    expect(urls).toContain('/__the-forge/dispatch')
    expect(urls).not.toContain('/__the-forge/session/say') // /dispatch still unsettled — chat must hold

    resolveDispatch({ ok: true, json: async () => ({ rung: 'manual', detail: '' }) })
    for (let i = 0; i < 6; i++) await Promise.resolve()
    urls = fetchMock.mock.calls.map(([url]) => url)
    expect(urls).toContain('/__the-forge/session/say')
    expect(urls.filter((u) => u === '/__the-forge/session/say')).toHaveLength(1) // chatInFlight collapses the two gestures to one POST
  })

  // Task 9, Case B: the exact scenario the false-return contract exists to prevent — if the
  // FIRST gesture's /queue POST fails, a second gesture fired before that failure is known must
  // not let its chat leg through either (it would reference edits that never queued).
  it('a second ↑ before the first /queue POST fails: zero /session/say POSTs from either gesture (Task 9)', async () => {
    let rejectQueue!: (e: Error) => void
    const fetchMock = vi.fn((url: string) => {
      if (url === '/__the-forge/queue') return new Promise((_resolve, reject) => (rejectQueue = reject))
      if (url === '/__the-forge/session/say') return Promise.resolve({ ok: true, status: 200, json: async () => ({ ok: true }) })
      if (url.startsWith('/__the-forge/session/events')) return new Promise<never>(() => {})
      return Promise.resolve({ ok: true, json: async () => ({ watcher: 'none', session: 'idle' }) })
    })
    vi.stubGlobal('fetch', fetchMock)
    const { mode, drafts, panel } = fullSetup()
    mode.setActive(true)
    const btn = document.querySelector('button')! as HTMLElement
    drafts.apply(btn, 'padding-top', '24px')
    const textarea = panel.root.querySelector('.chat-textarea') as HTMLTextAreaElement
    textarea.value = 'still typed this'
    clickSend(panel.root) // gesture 1 — /queue POST fired, unresolved
    for (let i = 0; i < 4; i++) await Promise.resolve()

    clickSend(panel.root) // gesture 2 — shares the same in-flight drafts promise
    for (let i = 0; i < 4; i++) await Promise.resolve()

    rejectQueue(new Error('network down'))
    for (let i = 0; i < 8; i++) await Promise.resolve()

    const urls = fetchMock.mock.calls.map(([url]) => url)
    expect(urls).not.toContain('/__the-forge/session/say')
    expect(urls.filter((u) => u === '/__the-forge/queue')).toHaveLength(1)
    const errorRows = panel.root.querySelectorAll('.session-error-row')
    expect(errorRows.length).toBe(1) // renders once, not once per gesture
    expect(textarea.value).toBe('still typed this') // never swallow the typed message
  })

  // Review fix 1 (Important): the old button flashed 'Send failed' on a failed /queue POST —
  // with the button retired, the drafts leg must surface its failure through the same
  // transient-error mechanism the chat leg already uses (renderTransientError), or a failed
  // queue POST is completely invisible.
  it('a network-failed /queue POST renders the transient queue-failure row', async () => {
    const fetchMock = vi.fn((url: string) => {
      if (url === '/__the-forge/queue') return Promise.reject(new Error('network down'))
      if (url.startsWith('/__the-forge/session/events')) return new Promise<never>(() => {})
      return Promise.resolve({ ok: true, json: async () => ({ watcher: 'none', session: 'idle' }) })
    })
    vi.stubGlobal('fetch', fetchMock)
    const { mode, drafts, panel } = fullSetup()
    mode.setActive(true)
    const btn = document.querySelector('button')! as HTMLElement
    drafts.apply(btn, 'padding-top', '24px')
    clickSend(panel.root)
    for (let i = 0; i < 8; i++) await Promise.resolve()
    const errorRow = panel.root.querySelector('.session-error-row')
    expect(errorRow).not.toBeNull()
    expect(errorRow?.textContent).toBe('failed to queue changes — try again')
    expect(mode.session.size()).toBe(0)
  })

  it('a non-2xx /queue response also renders the transient queue-failure row', async () => {
    const fetchMock = vi.fn((url: string) => {
      if (url === '/__the-forge/queue') return Promise.resolve({ ok: false, status: 500, json: async () => ({ error: 'boom' }) })
      if (url.startsWith('/__the-forge/session/events')) return new Promise<never>(() => {})
      return Promise.resolve({ ok: true, json: async () => ({ watcher: 'none', session: 'idle' }) })
    })
    vi.stubGlobal('fetch', fetchMock)
    const { mode, drafts, panel } = fullSetup()
    mode.setActive(true)
    const btn = document.querySelector('button')! as HTMLElement
    drafts.apply(btn, 'padding-top', '24px')
    clickSend(panel.root)
    for (let i = 0; i < 8; i++) await Promise.resolve()
    const errorRow = panel.root.querySelector('.session-error-row')
    expect(errorRow).not.toBeNull()
    expect(errorRow?.textContent).toBe('failed to queue changes — try again')
  })

  // REVISED pinned semantics (2026-07-10 review, supersedes review fix 1's "the chat leg still
  // fires"): a failed /queue POST now SKIPS the chat leg — the message often refers to the edits
  // ("apply these edits"), and sending it with nothing queued misleads the agent. The original
  // pin's concern (never swallow the typed message) still holds: the text stays in the textarea
  // untouched and the error row explains, so one more ↑ re-sends both together.
  it('queue failure with text present: error row renders, the chat leg is SKIPPED, and the text is preserved', async () => {
    const fetchMock = vi.fn((url: string) => {
      if (url === '/__the-forge/queue') return Promise.reject(new Error('network down'))
      if (url === '/__the-forge/session/say') return Promise.resolve({ ok: true, status: 200, json: async () => ({ ok: true }) })
      if (url.startsWith('/__the-forge/session/events')) return new Promise<never>(() => {})
      return Promise.resolve({ ok: true, json: async () => ({ watcher: 'none', session: 'idle' }) })
    })
    vi.stubGlobal('fetch', fetchMock)
    const { mode, drafts, panel } = fullSetup()
    mode.setActive(true)
    const btn = document.querySelector('button')! as HTMLElement
    drafts.apply(btn, 'padding-top', '24px')
    const textarea = panel.root.querySelector('.chat-textarea') as HTMLTextAreaElement
    textarea.value = 'still typed this'
    clickSend(panel.root)
    for (let i = 0; i < 10; i++) await Promise.resolve()
    const errorRow = panel.root.querySelector('.session-error-row')
    expect(errorRow?.textContent).toBe('failed to queue changes — try again')
    const urls = fetchMock.mock.calls.map(([url]) => url)
    expect(urls).toContain('/__the-forge/queue')
    expect(urls).not.toContain('/__the-forge/session/say') // nothing queued — don't mislead the agent
    expect(textarea.value).toBe('still typed this') // never swallow the typed message
  })

  // Review fix 2 (Minor): the chat text is captured ONCE at onSend entry — a user clearing (or
  // re-editing) the textarea while the awaited /queue POST is in flight must not change what
  // the chat leg sends. Pinned semantics: send what the user had at click time.
  it('clearing the textarea while the queue POST is in flight still says the ORIGINAL click-time text', async () => {
    let resolveQueue!: (v: { ok: boolean; json: () => Promise<{ id: string }> }) => void
    const fetchMock = vi.fn((url: string) => {
      if (url === '/__the-forge/queue') return new Promise((resolve) => (resolveQueue = resolve))
      if (url === '/__the-forge/dispatch') return Promise.resolve({ ok: true, json: async () => ({ rung: 'manual', detail: '' }) })
      if (url === '/__the-forge/session/say') return Promise.resolve({ ok: true, status: 200, json: async () => ({ ok: true }) })
      if (url.startsWith('/__the-forge/session/events')) return new Promise<never>(() => {})
      return Promise.resolve({ ok: true, json: async () => ({ watcher: 'none', session: 'idle' }) })
    })
    vi.stubGlobal('fetch', fetchMock)
    const { mode, drafts, panel } = fullSetup()
    mode.setActive(true)
    const btn = document.querySelector('button')! as HTMLElement
    drafts.apply(btn, 'padding-top', '24px')
    const textarea = panel.root.querySelector('.chat-textarea') as HTMLTextAreaElement
    textarea.value = 'original message'
    clickSend(panel.root)
    await Promise.resolve() // /queue POST now in flight, unresolved

    textarea.value = '' // user clears (or rewrites) mid-gap — must not affect what gets said
    resolveQueue({ ok: true, json: async () => ({ id: 'q1' }) })
    for (let i = 0; i < 10; i++) await Promise.resolve()

    const sayCalls = fetchMock.mock.calls.filter(([url]) => url === '/__the-forge/session/say')
    expect(sayCalls).toHaveLength(1)
    const body = JSON.parse((sayCalls[0] as unknown as [string, { body: string }])[1].body)
    expect(body.text).toBe('original message')
  })

  // Final-review fix C1: embedded:false (chat unavailable) must gate the CHAT leg only —
  // drafts ride the queue/watcher path that opt-out deliberately preserves, so a terminal-only
  // consumer who has drafted edits ('N changes drafted' pill) must still have a working send
  // surface to get them onto the queue.
  describe('drafts send survives embedded:false (final-review fix C1)', () => {
    it('sessionEnabled:false + drafts present: ↑ stays enabled, click sends queue+dispatch, never /session/say', async () => {
      const fetchMock = vi.fn((url: string) => {
        if (url === '/__the-forge/queue') return Promise.resolve({ ok: true, json: async () => ({ id: 'q1' }) })
        if (url === '/__the-forge/dispatch') return Promise.resolve({ ok: true, json: async () => ({ rung: 'manual', detail: '' }) })
        if (url === '/__the-forge/session/say') return Promise.resolve({ ok: true, status: 200, json: async () => ({ ok: true }) })
        if (url.startsWith('/__the-forge/session/events')) return new Promise<never>(() => {})
        return Promise.resolve({ ok: true, json: async () => ({ watcher: 'none', session: 'idle', sessionEnabled: false }) })
      })
      vi.stubGlobal('fetch', fetchMock)
      const { mode, drafts, panel } = fullSetup()
      mode.setActive(true)
      await new Promise((r) => setTimeout(r, 5)) // watch's immediate 0ms poll settles (real timers)

      const btn = document.querySelector('button')! as HTMLElement
      drafts.apply(btn, 'padding-top', '24px')
      // updateDraftPill() is wired off drafts.onChange, immediate (not debounced) — the pill
      // (and therefore the send button) reflects the new count synchronously.
      const sendBtn = panel.root.querySelector('.composer-send') as HTMLButtonElement
      const textarea = panel.root.querySelector('.chat-textarea') as HTMLTextAreaElement
      expect(textarea.disabled).toBe(true) // chat leg stays gated
      expect(sendBtn.disabled).toBe(false) // but drafts license the send surface

      sendBtn.click()
      for (let i = 0; i < 8; i++) await Promise.resolve()

      const urls = fetchMock.mock.calls.map(([url]) => url)
      expect(urls).toContain('/__the-forge/queue')
      expect(urls).toContain('/__the-forge/dispatch')
      expect(urls).not.toContain('/__the-forge/session/say')
    })

    it('sessionEnabled:false + no drafts: ↑ stays disabled', async () => {
      const fetchMock = vi.fn((url: string) => {
        if (url.startsWith('/__the-forge/session/events')) return new Promise<never>(() => {})
        return Promise.resolve({ ok: true, json: async () => ({ watcher: 'none', session: 'idle', sessionEnabled: false }) })
      })
      vi.stubGlobal('fetch', fetchMock)
      const { mode, panel } = fullSetup()
      mode.setActive(true)
      await new Promise((r) => setTimeout(r, 5))

      const sendBtn = panel.root.querySelector('.composer-send') as HTMLButtonElement
      expect(sendBtn.disabled).toBe(true)
    })

    it('a leftover chat text in a disabled textarea is never POSTed to /session/say (belt-and-braces)', async () => {
      // Simulates the disabled-textarea-can-still-hold-text case the fix's belt-and-braces
      // guard targets: directly stuffing .value bypasses the DOM's own disabled-input
      // protections (unlike a real user keystroke, which a disabled textarea can't receive),
      // so onSend's own availability check is what has to catch this, not the textarea's
      // disabled attribute.
      const fetchMock = vi.fn((url: string) => {
        if (url === '/__the-forge/queue') return Promise.resolve({ ok: true, json: async () => ({ id: 'q1' }) })
        if (url === '/__the-forge/dispatch') return Promise.resolve({ ok: true, json: async () => ({ rung: 'manual', detail: '' }) })
        if (url === '/__the-forge/session/say') return Promise.resolve({ ok: true, status: 200, json: async () => ({ ok: true }) })
        if (url.startsWith('/__the-forge/session/events')) return new Promise<never>(() => {})
        return Promise.resolve({ ok: true, json: async () => ({ watcher: 'none', session: 'idle', sessionEnabled: false }) })
      })
      vi.stubGlobal('fetch', fetchMock)
      const { mode, drafts, panel } = fullSetup()
      mode.setActive(true)
      await new Promise((r) => setTimeout(r, 5))

      const textarea = panel.root.querySelector('.chat-textarea') as HTMLTextAreaElement
      expect(textarea.disabled).toBe(true)
      textarea.value = 'stale message' // bypasses the disabled attribute, same as a stale pre-disable value would

      const btn = document.querySelector('button')! as HTMLElement
      drafts.apply(btn, 'padding-top', '24px')
      const sendBtn = panel.root.querySelector('.composer-send') as HTMLButtonElement
      sendBtn.click()
      for (let i = 0; i < 8; i++) await Promise.resolve()

      const urls = fetchMock.mock.calls.map(([url]) => url)
      expect(urls).toContain('/__the-forge/queue')
      expect(urls).not.toContain('/__the-forge/session/say')
    })
  })

  // Final-review fix C2 + deferred-Minor 7: the chat leg lost milestone-B's double-send
  // protection when the send gesture moved to the composer's ↑ (Task 1/3) — a rapid double
  // click must not fire two /session/say POSTs, and clearText-on-success must not wipe text the
  // user retyped during the round trip.
  describe('chat double-send guard + safe clear (final-review fix C2 / deferred-Minor 7)', () => {
    it('double-click ↑ with text in flight sends exactly ONE /session/say POST', async () => {
      let resolveSay!: (v: { ok: boolean; status: number; json: () => Promise<{ ok: boolean }> }) => void
      const fetchMock = vi.fn((url: string) => {
        if (url === '/__the-forge/session/say') return new Promise((resolve) => (resolveSay = resolve))
        if (url.startsWith('/__the-forge/session/events')) return new Promise<never>(() => {})
        return Promise.resolve({ ok: true, json: async () => ({ watcher: 'none', session: 'idle' }) })
      })
      vi.stubGlobal('fetch', fetchMock)
      const { mode, panel } = fullSetup()
      mode.setActive(true)
      const textarea = panel.root.querySelector('.chat-textarea') as HTMLTextAreaElement
      textarea.value = 'hello there'
      clickSend(panel.root)
      await Promise.resolve() // the first /say POST is now in flight, unresolved
      clickSend(panel.root) // second click before the first round trip settles
      await Promise.resolve()
      resolveSay({ ok: true, status: 200, json: async () => ({ ok: true }) })
      for (let i = 0; i < 8; i++) await Promise.resolve()

      const sayCalls = fetchMock.mock.calls.filter(([url]) => url === '/__the-forge/session/say')
      expect(sayCalls).toHaveLength(1)
    })

    it('original-unchanged text IS cleared once the /say POST resolves ok', async () => {
      let resolveSay!: (v: { ok: boolean; status: number; json: () => Promise<{ ok: boolean }> }) => void
      const fetchMock = vi.fn((url: string) => {
        if (url === '/__the-forge/session/say') return new Promise((resolve) => (resolveSay = resolve))
        if (url.startsWith('/__the-forge/session/events')) return new Promise<never>(() => {})
        return Promise.resolve({ ok: true, json: async () => ({ watcher: 'none', session: 'idle' }) })
      })
      vi.stubGlobal('fetch', fetchMock)
      const { mode, panel } = fullSetup()
      mode.setActive(true)
      const textarea = panel.root.querySelector('.chat-textarea') as HTMLTextAreaElement
      textarea.value = 'original message'
      clickSend(panel.root)
      await Promise.resolve()
      resolveSay({ ok: true, status: 200, json: async () => ({ ok: true }) })
      for (let i = 0; i < 8; i++) await Promise.resolve()

      expect(textarea.value).toBe('')
    })

    it('text retyped during the /say round trip is NOT wiped on success', async () => {
      let resolveSay!: (v: { ok: boolean; status: number; json: () => Promise<{ ok: boolean }> }) => void
      const fetchMock = vi.fn((url: string) => {
        if (url === '/__the-forge/session/say') return new Promise((resolve) => (resolveSay = resolve))
        if (url.startsWith('/__the-forge/session/events')) return new Promise<never>(() => {})
        return Promise.resolve({ ok: true, json: async () => ({ watcher: 'none', session: 'idle' }) })
      })
      vi.stubGlobal('fetch', fetchMock)
      const { mode, panel } = fullSetup()
      mode.setActive(true)
      const textarea = panel.root.querySelector('.chat-textarea') as HTMLTextAreaElement
      textarea.value = 'original message'
      clickSend(panel.root)
      await Promise.resolve() // /say POST now in flight

      textarea.value = 'retyped while waiting' // user edits mid-flight — must survive
      resolveSay({ ok: true, status: 200, json: async () => ({ ok: true }) })
      for (let i = 0; i < 8; i++) await Promise.resolve()

      expect(textarea.value).toBe('retyped while waiting')
    })
  })

  describe('watch strip gating', () => {
    beforeEach(() => vi.useFakeTimers())
    afterEach(() => vi.useRealTimers())

    it('is present for a linked (live) watcher, absent once the state is embedded-session-active or none', async () => {
      let watcher: 'live' | 'none' = 'live'
      let session: 'idle' | 'ready' = 'idle'
      const fetchMock = vi.fn((url: string) => {
        if (url.startsWith('/__the-forge/session/events')) return new Promise<never>(() => {})
        if (url === '/__the-forge/status?ids=') return Promise.resolve({ ok: true, json: async () => ({ watcher, session }) })
        return Promise.resolve({ ok: true, json: async () => ({ items: [] }) })
      })
      vi.stubGlobal('fetch', fetchMock)
      const { overlay, mode } = fullSetup()
      mode.setActive(true)
      await vi.advanceTimersByTimeAsync(0) // the immediate first poll

      const watchLabel = overlay.host.shadowRoot!.getElementById('watch') as HTMLElement
      expect(watchLabel.hidden).toBe(false)
      expect(watchLabel.textContent).toContain('Linked to Claude Code')

      // Embedded session active, watcher itself unlinked — the strip must go away: the
      // composer's own placeholder + drafts pill carry this state now, not the strip.
      watcher = 'none'
      session = 'ready'
      await vi.advanceTimersByTimeAsync(5000)
      expect(watchLabel.hidden).toBe(true)

      // Plain 'none' (nothing ever linked, no embedded session either) — also absent, a
      // reversal of the old upfront "○ Not linked" hint.
      session = 'idle'
      await vi.advanceTimersByTimeAsync(5000)
      expect(watchLabel.hidden).toBe(true)
    })

    it('is present for an asleep watcher too (still a linked-terminal state)', async () => {
      const fetchMock = vi.fn((url: string) => {
        if (url.startsWith('/__the-forge/session/events')) return new Promise<never>(() => {})
        if (url === '/__the-forge/status?ids=')
          return Promise.resolve({ ok: true, json: async () => ({ watcher: 'asleep', session: 'idle' }) })
        return Promise.resolve({ ok: true, json: async () => ({ items: [] }) })
      })
      vi.stubGlobal('fetch', fetchMock)
      const { overlay, mode } = fullSetup()
      mode.setActive(true)
      await vi.advanceTimersByTimeAsync(0)

      const watchLabel = overlay.host.shadowRoot!.getElementById('watch') as HTMLElement
      expect(watchLabel.hidden).toBe(false)
      expect(watchLabel.textContent).toContain('asleep')
    })
  })

  describe('setSessionState wiring off the watch poll tick', () => {
    beforeEach(() => vi.useFakeTimers())
    afterEach(() => vi.useRealTimers())

    it('the composer placeholder tracks the embedded-session lifecycle reported by each poll tick', async () => {
      let session: 'idle' | 'starting' | 'busy' = 'idle'
      const fetchMock = vi.fn((url: string) => {
        if (url.startsWith('/__the-forge/session/events')) return new Promise<never>(() => {})
        if (url === '/__the-forge/status?ids=') return Promise.resolve({ ok: true, json: async () => ({ watcher: 'none', session }) })
        return Promise.resolve({ ok: true, json: async () => ({ items: [] }) })
      })
      vi.stubGlobal('fetch', fetchMock)
      const { mode, panel } = fullSetup()
      mode.setActive(true)
      await vi.advanceTimersByTimeAsync(0)

      const textarea = panel.root.querySelector('.chat-textarea') as HTMLTextAreaElement
      expect(textarea.placeholder).toBe('Message, or send your edits…')

      session = 'busy'
      await vi.advanceTimersByTimeAsync(5000)
      expect(textarea.placeholder).toBe('Working…')

      session = 'starting'
      await vi.advanceTimersByTimeAsync(5000)
      expect(textarea.placeholder).toBe('Starting session…')
    })
  })

  describe('harness seeding off the watch poll tick (Task 5, C1)', () => {
    beforeEach(() => vi.useFakeTimers())
    afterEach(() => vi.useRealTimers())

    it('a /status harness value seeds the feed picker; a matching value on a later poll is not re-applied', async () => {
      let harness: string | undefined = undefined
      const fetchMock = vi.fn((url: string) => {
        if (url.startsWith('/__the-forge/session/events')) return new Promise<never>(() => {})
        if (url === '/__the-forge/status?ids=') return Promise.resolve({ ok: true, json: async () => ({ watcher: 'none', harness }) })
        return Promise.resolve({ ok: true, json: async () => ({ items: [] }) })
      })
      vi.stubGlobal('fetch', fetchMock)
      const { mode, panel } = fullSetup()
      const feed = (mode as never as { feed: SessionFeed }).feed
      const setHarnessSpy = vi.spyOn(feed, 'setHarness')
      mode.setActive(true)
      await vi.advanceTimersByTimeAsync(0)
      // harness undefined on the first poll (older/not-yet-landed server field) -> no seed.
      expect(setHarnessSpy).not.toHaveBeenCalled()

      harness = 'cursor'
      await vi.advanceTimersByTimeAsync(5000)
      expect(setHarnessSpy).toHaveBeenCalledTimes(1)
      expect(setHarnessSpy).toHaveBeenCalledWith('cursor')
      const harnessSelect = panel.root.querySelector('.session-harness') as HTMLSelectElement
      expect(harnessSelect.value).toBe('cursor')

      // Same harness reported again on the next tick — must not re-invoke setHarness, or a
      // user's own picker click would get clobbered by a routine stale poll.
      await vi.advanceTimersByTimeAsync(5000)
      expect(setHarnessSpy).toHaveBeenCalledTimes(1)
    })
  })

  describe('failed /session/config POST reverts the composer pickers (Task 5 follow-up)', () => {
    /** Flushes the config POST's .then/.catch chain — plain microtasks, no timers involved. */
    async function flushConfig(): Promise<void> {
      for (let i = 0; i < 4; i++) await Promise.resolve()
    }

    function stubConfigPost(result: 'ok' | '409' | 'reject') {
      const fetchMock = vi.fn((url: string) => {
        if (url === '/__the-forge/session/config') {
          if (result === 'reject') return Promise.reject(new TypeError('network down'))
          return Promise.resolve({ ok: result === 'ok', status: result === 'ok' ? 200 : 409 })
        }
        return Promise.resolve({ ok: true, json: async () => ({ items: [] }) })
      })
      vi.stubGlobal('fetch', fetchMock)
      return fetchMock
    }

    it('a 409 harness POST reverts the harness select to the prior confirmed value', async () => {
      const fetchMock = stubConfigPost('409')
      const { panel } = fullSetup()
      const harnessSelect = panel.root.querySelector('.session-harness') as HTMLSelectElement
      expect(harnessSelect.value).toBe('claude-code')
      harnessSelect.value = 'cursor'
      harnessSelect.dispatchEvent(new Event('change'))
      expect(fetchMock).toHaveBeenCalledWith('/__the-forge/session/config', expect.objectContaining({ method: 'POST' }))
      await flushConfig()
      expect(harnessSelect.value).toBe('claude-code')
    })

    it('a 409 effort POST reverts the effort select', async () => {
      stubConfigPost('409')
      const { panel } = fullSetup()
      const effortSelect = panel.root.querySelector('.session-effort') as HTMLSelectElement
      effortSelect.value = 'xhigh'
      effortSelect.dispatchEvent(new Event('change'))
      await flushConfig()
      // No confirmed effort yet (no config-changed seeded one) — reverts to the placeholder.
      expect(effortSelect.value).toBe('')
    })

    it('a rejected (network-failure) POST reverts too', async () => {
      stubConfigPost('reject')
      const { panel } = fullSetup()
      const permSelect = panel.root.querySelector('.session-permission') as HTMLSelectElement
      permSelect.value = 'plan'
      permSelect.dispatchEvent(new Event('change'))
      await flushConfig()
      expect(permSelect.value).toBe('')
    })

    it('a successful POST does NOT revert — the optimistic value stands until config-changed confirms', async () => {
      stubConfigPost('ok')
      const { panel } = fullSetup()
      const harnessSelect = panel.root.querySelector('.session-harness') as HTMLSelectElement
      const effortSelect = panel.root.querySelector('.session-effort') as HTMLSelectElement
      harnessSelect.value = 'cursor'
      harnessSelect.dispatchEvent(new Event('change'))
      effortSelect.value = 'low'
      effortSelect.dispatchEvent(new Event('change'))
      await flushConfig()
      expect(harnessSelect.value).toBe('cursor')
      expect(effortSelect.value).toBe('low')
    })
  })
})

describe('change list wiring', () => {
  /** Flushes enough microtasks for the /queue POST *and* the chained /dispatch POST to settle —
   * same convention as flushSend() in the send-to-agent describe block above. */
  async function flushSend(): Promise<void> {
    for (let i = 0; i < 6; i++) await Promise.resolve()
  }

  it('mounts the ChangeList inside the panel changes slot', () => {
    const overlay = new Overlay()
    overlay.mount()
    const mode = new DesignMode(overlay)
    liveModes.push(mode)
    overlay.attach(mode.panelRoot)
    expect(mode.panelRoot.querySelector('.changes-section')).not.toBeNull()
  })

  // Composer consolidation Task 2: the Changes list retired its dedicated panel.changesSlot in
  // favor of living inside the chat composer's drafts disclosure (session-feed.ts) — reuse
  // proof for ChangeList itself is changelist.test.ts passing byte-unchanged (see CLAUDE.md).
  it('mounts the (unmodified) ChangeList inside .draft-disclosure, not a dedicated changesSlot', () => {
    const overlay = new Overlay()
    overlay.mount()
    const mode = new DesignMode(overlay)
    liveModes.push(mode)
    overlay.attach(mode.panelRoot)
    const disclosure = mode.panelRoot.querySelector('.draft-disclosure')
    expect(disclosure).not.toBeNull()
    expect(disclosure?.querySelector('.changes-section')).not.toBeNull()
  })

  it('drafting an edit updates the drafts pill via the existing drafts.onChange subscription', () => {
    const { mode, drafts } = fullSetup()
    mode.setActive(true)
    const btn = document.querySelector('button')! as HTMLElement
    const chips = mode.panelRoot.querySelector('.composer-chips') as HTMLElement
    const pill = mode.panelRoot.querySelector('.draft-pill') as HTMLElement
    expect(chips.hidden).toBe(true)
    drafts.apply(btn, 'padding-top', '24px')
    expect(chips.hidden).toBe(false)
    expect(pill.querySelector('.draft-pill-label')!.textContent).toBe('1 change')
  })

  it('seeds sent rows on a successful send and clears them on deactivate', async () => {
    const overlay = new Overlay()
    overlay.mount()
    const mode = new DesignMode(overlay)
    liveModes.push(mode)
    overlay.attach(mode.panelRoot)
    const el = document.createElement('div')
    el.setAttribute('data-dc-source', 'src/App.tsx:3:3')
    document.body.appendChild(el)
    mode.setActive(true)
    mode.select(el as never)
    // draft an edit, then click Send with a stubbed queue/dispatch
    ;(mode as never as { drafts: DraftStore }).drafts.apply(el as never, 'padding-top', '24px')
    const fetchMock = vi.fn((url: string) => {
      if (url === '/__the-forge/queue') return Promise.resolve({ ok: true, json: async () => ({ id: 'q9' }) })
      if (url === '/__the-forge/dispatch') return Promise.resolve({ ok: true, json: async () => ({ rung: 'manual', detail: '' }) })
      return Promise.resolve({ ok: true, json: async () => ({ items: [], watcher: 'none' }) })
    })
    vi.stubGlobal('fetch', fetchMock)
    ;(mode.panelRoot.querySelector('.chat-send') as HTMLButtonElement).click()
    await flushSend()
    expect(mode.panelRoot.querySelectorAll('.change-row').length).toBeGreaterThan(0)
    expect(mode.panelRoot.querySelector('.chip-sent')).not.toBeNull()
    mode.setActive(false)
    mode.setActive(true)
    expect(mode.panelRoot.querySelectorAll('.change-row')).toHaveLength(0)
  })

  // The other half of clear()'s contract ("suppression lifts on the next real mutation"): a
  // deactivate/reactivate cycle must not leave the list permanently blank — a NEW send after
  // reactivation renders its sent row again, and a verifier stage event resurrects in-flight
  // rows. Regression pinned 2026-07-10: index.ts bypassed the ChangeList.addSent/applyStage
  // delegates (calling session.register/applyStage directly), so suppressSeedRecords never
  // reset and every row stayed hidden until a full page reload.
  it('renders rows again after an off/on cycle: new send seeds a sent row, stage event resurrects in-flight rows', async () => {
    vi.useFakeTimers() // act 3 advances the verifier's 2s status poll
    const overlay = new Overlay()
    overlay.mount()
    const mode = new DesignMode(overlay)
    liveModes.push(mode)
    overlay.attach(mode.panelRoot)
    const el = document.createElement('div')
    el.setAttribute('data-dc-source', 'src/App.tsx:3:3')
    document.body.appendChild(el)
    mode.setActive(true)
    mode.select(el as never)
    ;(mode as never as { drafts: DraftStore }).drafts.apply(el as never, 'padding-top', '24px')
    let nextId = 0
    // Both sends stay 'claimed' on the status poll — so the act-3 poll tick below produces a
    // real sent -> applying stage transition through the verifier subscription path.
    const fetchMock = vi.fn((url: string) => {
      if (url === '/__the-forge/queue') return Promise.resolve({ ok: true, json: async () => ({ id: `q${++nextId}` }) })
      if (url === '/__the-forge/dispatch') return Promise.resolve({ ok: true, json: async () => ({ rung: 'manual', detail: '' }) })
      if (url.startsWith('/__the-forge/status?ids=') && nextId > 0) {
        const items = Array.from({ length: nextId }, (_, i) => ({ id: `q${i + 1}`, status: 'claimed', note: null }))
        return Promise.resolve({ ok: true, json: async () => ({ items, watcher: 'none' }) })
      }
      return Promise.resolve({ ok: true, json: async () => ({ items: [], watcher: 'none' }) })
    })
    vi.stubGlobal('fetch', fetchMock)
    ;(mode.panelRoot.querySelector('.chat-send') as HTMLButtonElement).click()
    await flushSend()
    expect(mode.panelRoot.querySelector('.chip-sent')).not.toBeNull()

    mode.setActive(false)
    mode.setActive(true)
    expect(mode.panelRoot.querySelectorAll('.change-row')).toHaveLength(0)

    // A new send after reactivation must be visible — draft a NEW value (the duplicate filter
    // drops an identical in-flight change set) and send again.
    mode.select(el as never)
    ;(mode as never as { drafts: DraftStore }).drafts.apply(el as never, 'padding-top', '32px')
    ;(mode.panelRoot.querySelector('.chat-send') as HTMLButtonElement).click()
    await flushSend()
    expect(mode.panelRoot.querySelectorAll('.change-row').length).toBeGreaterThan(0)
    expect(mode.panelRoot.querySelector('.chip-sent')).not.toBeNull()

    // And a verifier stage event (the other designed suppression-lift) resurrects rows too:
    // hide again, then let a status-poll tick deliver a sent -> applying transition.
    mode.setActive(false)
    mode.setActive(true)
    expect(mode.panelRoot.querySelectorAll('.change-row')).toHaveLength(0)
    await vi.advanceTimersByTimeAsync(2000)
    expect(mode.panelRoot.querySelectorAll('.change-row').length).toBeGreaterThan(0)
    vi.useRealTimers()
  })
})

describe('chat input cluster wiring (Task 6 — floating prompt popup retired)', () => {
  /** Flushes enough microtasks for a fetch .then chain to settle — same convention as
   * flushSend() elsewhere in this file. */
  async function flushMicrotasks(rounds = 6): Promise<void> {
    for (let i = 0; i < rounds; i++) await Promise.resolve()
  }

  /** Benign catch-all for the events stream + status poll — same shape as the
   * "SessionFeed wiring" describe block's makeEventsFetch, inlined here since these tests
   * mostly care about a single specific POST rather than scripted NDJSON lines. */
  function hangingEventsAnd(extra: (url: string) => Promise<unknown> | null) {
    return vi.fn((url: string) => {
      const res = extra(url)
      if (res) return res
      if (url.startsWith('/__the-forge/session/events')) return new Promise<never>(() => {})
      return Promise.resolve({ ok: true, json: async () => ({ watcher: 'none', session: 'idle' }) })
    })
  }

  it('Prompt button sets the chip and focuses the chat textarea (no .prompt-box in DOM)', () => {
    const { mode, overlay, panel } = fullSetup()
    mode.setActive(true)
    const btn = document.querySelector('button')!
    btn.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }))

    const textarea = mode.panelRoot.querySelector('.chat-textarea') as HTMLTextAreaElement
    const focusSpy = vi.spyOn(textarea, 'focus')

    panel.promptButton.click()

    const chip = mode.panelRoot.querySelector('.draft-pill-el') as HTMLElement
    expect(chip.hidden).toBe(false)
    // label format `<tag> · <basename>:<line>` — src/Button.tsx:42:8 → button · Button.tsx:42
    // (element-only state has no `·` prefix beyond the label's own)
    expect(chip.textContent).toContain('button · Button.tsx:42')
    expect(focusSpy).toHaveBeenCalled()
    expect(overlay.host.shadowRoot!.querySelector('.prompt-box')).toBeNull()
  })

  it('clicking Prompt with no selection is a no-op (no chip, no focus)', () => {
    const { mode, panel } = fullSetup()
    mode.setActive(true)
    const textarea = mode.panelRoot.querySelector('.chat-textarea') as HTMLTextAreaElement
    const focusSpy = vi.spyOn(textarea, 'focus')
    panel.promptButton.click()
    expect(focusSpy).not.toHaveBeenCalled()
    expect((mode.panelRoot.querySelector('.draft-pill-el') as HTMLElement).hidden).toBe(true)
  })

  it('say POSTs /session/say with the secret header and the chipped element, then clears the chip', async () => {
    const fetchMock = hangingEventsAnd((url) =>
      url === '/__the-forge/session/say' ? Promise.resolve({ ok: true, status: 200, json: async () => ({ ok: true }) }) : null
    )
    vi.stubGlobal('fetch', fetchMock)
    ;(globalThis as { __THE_FORGE__?: { secret?: string } }).__THE_FORGE__ = { secret: 'shhh' }
    try {
      const { mode, panel } = fullSetup()
      mode.setActive(true)
      const btn = document.querySelector('button')!
      btn.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }))
      panel.promptButton.click() // sets the chip

      const textarea = mode.panelRoot.querySelector('.chat-textarea') as HTMLTextAreaElement
      textarea.value = 'make it pop'
      ;(mode.panelRoot.querySelector('.chat-send') as HTMLButtonElement).click()

      await flushMicrotasks()

      const calls = fetchMock.mock.calls.filter((c: unknown[]) => c[0] === '/__the-forge/session/say')
      expect(calls).toHaveLength(1)
      const [, init] = calls[0] as unknown as [string, { method: string; headers: Record<string, string>; body: string }]
      expect(init.method).toBe('POST')
      expect(init.headers['X-Forge-Secret']).toBe('shhh')
      expect(JSON.parse(init.body)).toEqual({
        text: 'make it pop',
        element: { source: 'src/Button.tsx:42:8', tag: 'button' },
      })
      expect((mode.panelRoot.querySelector('.draft-pill-el') as HTMLElement).hidden).toBe(true)
    } finally {
      delete (globalThis as { __THE_FORGE__?: unknown }).__THE_FORGE__
    }
  })

  it('say with no chipped element omits element from the body', async () => {
    const fetchMock = hangingEventsAnd((url) =>
      url === '/__the-forge/session/say' ? Promise.resolve({ ok: true, status: 200, json: async () => ({ ok: true }) }) : null
    )
    vi.stubGlobal('fetch', fetchMock)
    const { mode } = fullSetup()
    mode.setActive(true)
    const textarea = mode.panelRoot.querySelector('.chat-textarea') as HTMLTextAreaElement
    textarea.value = 'plain message'
    ;(mode.panelRoot.querySelector('.chat-send') as HTMLButtonElement).click()

    await flushMicrotasks()

    const calls = fetchMock.mock.calls.filter((c: unknown[]) => c[0] === '/__the-forge/session/say')
    const [, init] = calls[0] as unknown as [string, { body: string }]
    expect(JSON.parse(init.body)).toEqual({ text: 'plain message' })
  })

  it('429 from /session/say renders a queue-full row in the feed', async () => {
    const fetchMock = hangingEventsAnd((url) =>
      url === '/__the-forge/session/say' ? Promise.resolve({ ok: false, status: 429, json: async () => ({ error: 'chat queue full' }) }) : null
    )
    vi.stubGlobal('fetch', fetchMock)
    const { mode } = fullSetup()
    mode.setActive(true)
    const textarea = mode.panelRoot.querySelector('.chat-textarea') as HTMLTextAreaElement
    textarea.value = 'hello'
    ;(mode.panelRoot.querySelector('.chat-send') as HTMLButtonElement).click()

    await flushMicrotasks()

    const errorRow = mode.panelRoot.querySelector('.session-error-row')
    expect(errorRow).not.toBeNull()
    expect(errorRow?.textContent).toBe('chat queue full — wait for the current turn')
  })

  it('a 500 from /session/say renders the generic failure row and preserves the typed text (final-review fix 3)', async () => {
    const fetchMock = hangingEventsAnd((url) =>
      url === '/__the-forge/session/say' ? Promise.resolve({ ok: false, status: 500, json: async () => ({ error: 'boom' }) }) : null
    )
    vi.stubGlobal('fetch', fetchMock)
    const { mode } = fullSetup()
    mode.setActive(true)
    const textarea = mode.panelRoot.querySelector('.chat-textarea') as HTMLTextAreaElement
    textarea.value = 'do not lose me'
    ;(mode.panelRoot.querySelector('.chat-send') as HTMLButtonElement).click()

    await flushMicrotasks()

    const errorRow = mode.panelRoot.querySelector('.session-error-row')
    expect(errorRow?.textContent).toBe('message failed to send — try again')
    expect(textarea.value).toBe('do not lose me')
    expect(textarea.disabled).toBe(false)
  })

  it('a network failure from /session/say renders the generic failure row and preserves the typed text', async () => {
    const fetchMock = hangingEventsAnd((url) =>
      url === '/__the-forge/session/say' ? Promise.reject(new Error('network down')) : null
    )
    vi.stubGlobal('fetch', fetchMock)
    const { mode } = fullSetup()
    mode.setActive(true)
    const textarea = mode.panelRoot.querySelector('.chat-textarea') as HTMLTextAreaElement
    textarea.value = 'still here'
    ;(mode.panelRoot.querySelector('.chat-send') as HTMLButtonElement).click()

    await flushMicrotasks()

    const errorRow = mode.panelRoot.querySelector('.session-error-row')
    expect(errorRow?.textContent).toBe('message failed to send — try again')
    expect(textarea.value).toBe('still here')
  })

  it('a successful /session/say clears the textarea only after the response resolves', async () => {
    const fetchMock = hangingEventsAnd((url) =>
      url === '/__the-forge/session/say' ? Promise.resolve({ ok: true, status: 200, json: async () => ({ ok: true }) }) : null
    )
    vi.stubGlobal('fetch', fetchMock)
    const { mode } = fullSetup()
    mode.setActive(true)
    const textarea = mode.panelRoot.querySelector('.chat-textarea') as HTMLTextAreaElement
    textarea.value = 'send me'
    ;(mode.panelRoot.querySelector('.chat-send') as HTMLButtonElement).click()

    await flushMicrotasks()

    expect(textarea.value).toBe('')
    expect(textarea.disabled).toBe(false)
  })

  it('changing the effort picker POSTs /session/config with the secret header and only the changed key', async () => {
    const fetchMock = hangingEventsAnd((url) =>
      url === '/__the-forge/session/config' ? Promise.resolve({ ok: true, json: async () => ({ ok: true }) }) : null
    )
    vi.stubGlobal('fetch', fetchMock)
    ;(globalThis as { __THE_FORGE__?: { secret?: string } }).__THE_FORGE__ = { secret: 'shhh' }
    try {
      const { mode } = fullSetup()
      mode.setActive(true)
      const effortSelect = mode.panelRoot.querySelector('.session-effort') as HTMLSelectElement
      effortSelect.value = 'high'
      effortSelect.dispatchEvent(new Event('change'))

      await flushMicrotasks()

      const calls = fetchMock.mock.calls.filter((c: unknown[]) => c[0] === '/__the-forge/session/config')
      expect(calls).toHaveLength(1)
      const [, init] = calls[0] as unknown as [string, { headers: Record<string, string>; body: string }]
      expect(init.headers['X-Forge-Secret']).toBe('shhh')
      expect(JSON.parse(init.body)).toEqual({ effort: 'high' })
    } finally {
      delete (globalThis as { __THE_FORGE__?: unknown }).__THE_FORGE__
    }
  })

  it('sessionEnabled=false (from /status) disables the chat input with the config-disabled reason', async () => {
    const fetchMock = vi.fn((url: string) => {
      if (url.startsWith('/__the-forge/session/events')) return new Promise<never>(() => {})
      return Promise.resolve({ ok: true, json: async () => ({ watcher: 'none', session: 'idle', sessionEnabled: false }) })
    })
    vi.stubGlobal('fetch', fetchMock)
    const { mode } = fullSetup()
    mode.setActive(true)

    await new Promise((r) => setTimeout(r, 5)) // watch's immediate 0ms poll settles (real timers)

    const textarea = mode.panelRoot.querySelector('.chat-textarea') as HTMLTextAreaElement
    const sendBtn = mode.panelRoot.querySelector('.chat-send') as HTMLButtonElement
    const reason = mode.panelRoot.querySelector('.chat-disabled-reason') as HTMLElement
    expect(textarea.disabled).toBe(true)
    expect(sendBtn.disabled).toBe(true)
    expect(reason.hidden).toBe(false)
    expect(reason.textContent).toBe('Embedded sessions are disabled in config')
  })

  it('sessionEnabled absent (older server) leaves the chat input enabled by default', async () => {
    const fetchMock = vi.fn((url: string) => {
      if (url.startsWith('/__the-forge/session/events')) return new Promise<never>(() => {})
      return Promise.resolve({ ok: true, json: async () => ({ watcher: 'none', session: 'idle' }) })
    })
    vi.stubGlobal('fetch', fetchMock)
    const { mode } = fullSetup()
    mode.setActive(true)

    await new Promise((r) => setTimeout(r, 5))

    const textarea = mode.panelRoot.querySelector('.chat-textarea') as HTMLTextAreaElement
    expect(textarea.disabled).toBe(false)
  })

  it('Escape does NOT deselect/deactivate while the chat textarea is focused', () => {
    const { mode } = fullSetup()
    mode.setActive(true)
    const btn = document.querySelector('button')!
    btn.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }))
    expect(mode.selected).toBe(btn)

    const textarea = mode.panelRoot.querySelector('.chat-textarea') as HTMLTextAreaElement
    textarea.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }))

    // overlay.contains(e.target) already ignores every overlay-internal target (onKey,
    // index.ts) — the chat textarea lives inside the panel, itself inside the overlay's
    // shadow host, so no additional stopPropagation wiring is needed on the textarea itself.
    expect(mode.selected).toBe(btn)
    expect(mode.active).toBe(true)
  })
})

describe('DesignMode verifier wiring (M4 Task 4)', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('starts the verifier after a successful send and reflects the summary in the status strip', async () => {
    // URL-dispatched mock (not a mockResolvedValueOnce sequence): the WatchStatus poller's
    // `?ids=` probe now interleaves with the verifier's `?ids=q1` polls on the same fake
    // timers, so a consumed-in-order mock queue would misroute responses between the two.
    const fetchMock = vi.fn((url: string) => {
      if (url === '/__the-forge/queue') return Promise.resolve({ ok: true, json: async () => ({ id: 'q1' }) })
      if (url === '/__the-forge/dispatch')
        return Promise.resolve({ ok: true, json: async () => ({ rung: 'manual', detail: '' }) })
      if (url === '/__the-forge/status?ids=q1')
        return Promise.resolve({ ok: true, json: async () => ({ items: [{ id: 'q1', status: 'applied', note: null }] }) })
      return Promise.resolve({ ok: true, json: async () => ({ items: [], watcher: 'none' }) })
    })
    vi.stubGlobal('fetch', fetchMock)
    const { overlay, mode, drafts, panel } = fullSetup()
    mode.setActive(true)
    const btn = document.querySelector('button')! as HTMLElement
    drafts.apply(btn, 'padding-top', '24px')
    ;(panel.root.querySelector('.chat-send') as HTMLButtonElement).click()
    await Promise.resolve()
    await Promise.resolve()

    // the verifier neutralizes draft inline styles before measuring, so "the code
    // adopted the value" must come from somewhere other than the draft itself. Inserted
    // AFTER the send (matching reality — the agent applies post-Send): a stylesheet that
    // already carries the drafted value at build time makes the draft a no-op, which
    // buildChangeRequest now (correctly) drops instead of sending an empty request.
    const style = document.createElement('style')
    style.textContent = '.btn { padding-top: 24px; }'
    document.head.appendChild(style)

    await vi.advanceTimersByTimeAsync(2000)

    const sentLabel = overlay.host.shadowRoot!.getElementById('sent') as HTMLElement
    expect(sentLabel.hidden).toBe(false)
    expect(sentLabel.textContent).toContain('implemented')
    expect(drafts.hasDrafts(btn)).toBe(false)
  })

  it('stops polling on deactivate and resumes on activate while entries remain', async () => {
    const fetchMock = vi.fn((url: string) => {
      // feed start() fetches the events stream — park it so it doesn't consume the queue stub
      if (url.startsWith('/__the-forge/session/events')) return new Promise<never>(() => {})
      if (url === '/__the-forge/queue') return Promise.resolve({ ok: true, json: async () => ({ id: 'q1' }) })
      return Promise.resolve({ ok: true, json: async () => ({ items: [], watcher: 'none' }) })
    })
    vi.stubGlobal('fetch', fetchMock)
    const { mode, drafts, panel } = fullSetup()
    mode.setActive(true)
    const btn = document.querySelector('button')! as HTMLElement
    drafts.apply(btn, 'padding-top', '24px')
    ;(panel.root.querySelector('.chat-send') as HTMLButtonElement).click()
    await Promise.resolve()
    await Promise.resolve()
    expect(mode.session.size()).toBe(1)

    mode.setActive(false)
    fetchMock.mockClear()
    await vi.advanceTimersByTimeAsync(4000)
    expect(fetchMock).not.toHaveBeenCalled() // stopped: no polling while inactive

    fetchMock.mockResolvedValue({ ok: true, json: async () => ({ items: [], watcher: 'none' }) })
    mode.setActive(true) // entries remain pending -> polling resumes
    await vi.advanceTimersByTimeAsync(2000)
    expect(fetchMock).toHaveBeenCalledWith('/__the-forge/status?ids=q1')
  })

  it('does not start VERIFIER polling on activate when there are no pending sends', () => {
    // The watch-status probe (`?ids=`) legitimately polls while design mode is on — this
    // test guards the VERIFIER staying quiet, so assert no per-id status calls instead of
    // no calls at all.
    const fetchMock = vi.fn((url: string) => {
      void url
      return Promise.resolve({ ok: true, json: async () => ({ items: [], watcher: 'none' }) })
    })
    vi.stubGlobal('fetch', fetchMock)
    const { mode } = fullSetup()
    mode.setActive(true)
    expect(mode.session.size()).toBe(0)
    return vi.advanceTimersByTimeAsync(4000).then(() => {
      // Exclude session/events calls (the feed polls while design mode is on — that's correct)
      const urls = fetchMock.mock.calls.map((c) => c[0]).filter((u: string) => !u.startsWith('/__the-forge/session/events'))
      expect(urls.length).toBeGreaterThan(0) // the watch probe DID poll…
      expect(urls.every((u) => u === '/__the-forge/status?ids=')).toBe(true) // …and nothing else did
    })
  })

  it('refreshes the panel and re-measures the selection outline when a verify update arrives', async () => {
    // URL-dispatched mock — see the summary-strip test above for why.
    const fetchMock = vi.fn((url: string) => {
      if (url === '/__the-forge/queue') return Promise.resolve({ ok: true, json: async () => ({ id: 'q1' }) })
      if (url === '/__the-forge/dispatch')
        return Promise.resolve({ ok: true, json: async () => ({ rung: 'manual', detail: '' }) })
      if (url === '/__the-forge/status?ids=q1')
        return Promise.resolve({ ok: true, json: async () => ({ items: [{ id: 'q1', status: 'applied', note: null }] }) })
      return Promise.resolve({ ok: true, json: async () => ({ items: [], watcher: 'none' }) })
    })
    vi.stubGlobal('fetch', fetchMock)
    const { mode, drafts, panel } = fullSetup()
    mode.setActive(true)
    const btn = document.querySelector('button')! as HTMLElement
    drafts.apply(btn, 'padding-top', '24px')
    mode.select(btn) // panel is showing this element, as it might be while awaiting verification

    ;(panel.root.querySelector('.chat-send') as HTMLButtonElement).click()
    await Promise.resolve()
    await Promise.resolve()

    // Inserted after the send — see the summary-strip test above for why.
    const style = document.createElement('style')
    style.textContent = '.btn { padding-top: 24px; }'
    document.head.appendChild(style)

    const refreshSpy = vi.spyOn(panel, 'refresh')

    await vi.advanceTimersByTimeAsync(2000)

    expect(refreshSpy).toHaveBeenCalled()
  })

  // Final-review F4: the verifier's poll loop re-emits the SAME stage (e.g. 'sent'/'applying')
  // every ~2s tick while a request is still pending — applyStage() already no-ops on same-stage
  // internally, but the index.ts subscription called persist() (a sessionStorage write) on every
  // tick regardless, defeating "storage writes only on state changes".
  it('persists only when a poll re-emission actually changes a row stage, not on identical re-emissions', async () => {
    const fetchMock = vi.fn((url: string) => {
      if (url === '/__the-forge/queue') return Promise.resolve({ ok: true, json: async () => ({ id: 'q1' }) })
      if (url === '/__the-forge/dispatch') return Promise.resolve({ ok: true, json: async () => ({ rung: 'manual', detail: '' }) })
      // Stays 'claimed' (-> 'applying' stage) on every poll tick — an identical re-emission.
      if (url === '/__the-forge/status?ids=q1')
        return Promise.resolve({ ok: true, json: async () => ({ items: [{ id: 'q1', status: 'claimed', note: null }] }) })
      return Promise.resolve({ ok: true, json: async () => ({ items: [], watcher: 'none' }) })
    })
    vi.stubGlobal('fetch', fetchMock)
    const { mode, drafts, panel } = fullSetup()
    mode.setActive(true)
    const btn = document.querySelector('button')! as HTMLElement
    drafts.apply(btn, 'padding-top', '24px')
    ;(panel.root.querySelector('.chat-send') as HTMLButtonElement).click()
    await Promise.resolve()
    await Promise.resolve()

    const setItemSpy = vi.spyOn(Storage.prototype, 'setItem')
    setItemSpy.mockClear()

    // First tick: 'sent' -> 'applying' is a real stage change -> one persist.
    await vi.advanceTimersByTimeAsync(2000)
    const afterFirstTick = setItemSpy.mock.calls.filter(([key]) => key === 'the-forge:lifecycle').length
    expect(afterFirstTick).toBeGreaterThan(0)

    setItemSpy.mockClear()
    // Second tick: still 'claimed' -> still 'applying' — identical re-emission, no persist.
    await vi.advanceTimersByTimeAsync(2000)
    const afterSecondTick = setItemSpy.mock.calls.filter(([key]) => key === 'the-forge:lifecycle').length
    expect(afterSecondTick).toBe(0)
  })
})

describe('DesignMode layout-ripple wiring (M2b Task 4)', () => {
  function fieldInput(root: HTMLElement, props: string): HTMLInputElement {
    const nf = [...root.querySelectorAll('.nf')].find((n) => (n as HTMLElement).dataset.props === props)
    if (!nf) throw new Error(`no field with data-props ${props}`)
    return nf.querySelector('input')!
  }

  function commit(input: HTMLInputElement, value: string): void {
    input.value = value
    input.dispatchEvent(new Event('change', { bubbles: true }))
  }

  function stubRect(el: Element, rect: { x: number; y: number; width: number; height: number }): void {
    el.getBoundingClientRect = () => new DOMRect(rect.x, rect.y, rect.width, rect.height)
  }

  // Queued rAF (rather than the file-level immediate stub) so the test can mutate
  // rects BETWEEN the pre-edit snapshot and the post-edit diff, simulating real reflow.
  function rippleSetup() {
    const queue: FrameRequestCallback[] = []
    vi.stubGlobal('requestAnimationFrame', (cb: FrameRequestCallback) => {
      queue.push(cb)
      return queue.length
    })
    document.body.innerHTML = `
      <div data-dc-source="src/Wrap.tsx:1:1" id="scope">
        <div data-dc-source="src/Selected.tsx:2:2" id="selected" style="padding: 8px;"></div>
        <div data-dc-source="src/Sibling.tsx:3:3" id="sibling"></div>
      </div>
    `
    const overlay = new Overlay()
    overlay.mount()
    const mode = new DesignMode(overlay)
    liveModes.push(mode)
    return { overlay, mode, runRaf: () => queue.splice(0).forEach((cb) => cb(0)) }
  }

  it('editing PY on the selected element ripples the sibling whose rect changed after the edit', () => {
    const { overlay, mode, runRaf } = rippleSetup()
    mode.setActive(true)
    const selected = document.getElementById('selected')! as HTMLElement
    const sibling = document.getElementById('sibling')! as HTMLElement
    stubRect(selected, { x: 0, y: 0, width: 100, height: 20 })
    stubRect(sibling, { x: 0, y: 30, width: 100, height: 20 })

    mode.select(selected)
    const showRipplesSpy = vi.spyOn(overlay, 'showRipples')

    commit(fieldInput(mode.panelRoot, P.PY), '40')
    // post-edit reflow: the sibling moved down (simulating the padding push) before
    // the rAF-scheduled diff runs
    stubRect(sibling, { x: 0, y: 60, width: 100, height: 20 })
    runRaf()

    expect(showRipplesSpy).toHaveBeenCalledWith([sibling.getBoundingClientRect()])
  })

  it('never includes the selected element in ripples', () => {
    const { mode, overlay, runRaf } = rippleSetup()
    mode.setActive(true)
    const selected = document.getElementById('selected')! as HTMLElement
    const sibling = document.getElementById('sibling')! as HTMLElement
    stubRect(selected, { x: 0, y: 0, width: 100, height: 20 })
    stubRect(sibling, { x: 0, y: 30, width: 100, height: 20 })
    mode.select(selected)

    const showRipplesSpy = vi.spyOn(overlay, 'showRipples')
    // the selected element itself also changes rect due to the edit (padding growth) —
    // it must never appear in the ripple set even though it moved.
    commit(fieldInput(mode.panelRoot, P.PY), '40')
    stubRect(selected, { x: 0, y: 0, width: 100, height: 60 })
    stubRect(sibling, { x: 0, y: 90, width: 100, height: 20 })
    runRaf()

    expect(showRipplesSpy).toHaveBeenCalled()
    const selectedRect = selected.getBoundingClientRect()
    for (const [rects] of showRipplesSpy.mock.calls) {
      for (const r of rects) {
        expect(r.x === selectedRect.x && r.y === selectedRect.y && r.width === selectedRect.width).toBe(false)
      }
    }
  })

  it('deactivating cancels a pending ripple rAF (no stray showRipples after exit)', () => {
    const { mode, overlay, runRaf } = rippleSetup()
    mode.setActive(true)
    const selected = document.getElementById('selected')! as HTMLElement
    const sibling = document.getElementById('sibling')! as HTMLElement
    stubRect(selected, { x: 0, y: 0, width: 100, height: 20 })
    stubRect(sibling, { x: 0, y: 30, width: 100, height: 20 })
    mode.select(selected)

    commit(fieldInput(mode.panelRoot, P.PY), '40')
    stubRect(sibling, { x: 0, y: 60, width: 100, height: 20 })

    mode.setActive(false) // exits before the queued rAF runs

    const showRipplesSpy = vi.spyOn(overlay, 'showRipples')
    runRaf() // if the stale callback still ran, this would call showRipples
    expect(showRipplesSpy).not.toHaveBeenCalled()
  })
})

describe('DesignMode layout-ripple debounce (M2b Task 4)', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  function fieldInput(root: HTMLElement, props: string): HTMLInputElement {
    const nf = [...root.querySelectorAll('.nf')].find((n) => (n as HTMLElement).dataset.props === props)
    if (!nf) throw new Error(`no field with data-props ${props}`)
    return nf.querySelector('input')!
  }

  function commit(input: HTMLInputElement, value: string): void {
    input.value = value
    input.dispatchEvent(new Event('change', { bubbles: true }))
  }

  function stubRect(el: Element, rect: { x: number; y: number; width: number; height: number }): void {
    el.getBoundingClientRect = () => new DOMRect(rect.x, rect.y, rect.width, rect.height)
  }

  it('a rapid burst of edits reuses the first snapshot until 300ms of quiet', () => {
    const queue: FrameRequestCallback[] = []
    vi.stubGlobal('requestAnimationFrame', (cb: FrameRequestCallback) => {
      queue.push(cb)
      return queue.length
    })
    const runRaf = () => queue.splice(0).forEach((cb) => cb(0))

    document.body.innerHTML = `
      <div data-dc-source="src/Wrap.tsx:1:1" id="scope">
        <div data-dc-source="src/Selected.tsx:2:2" id="selected" style="padding: 8px;"></div>
        <div data-dc-source="src/Sibling.tsx:3:3" id="sibling"></div>
      </div>
    `
    const overlay = new Overlay()
    overlay.mount()
    const mode = new DesignMode(overlay)
    liveModes.push(mode)
    mode.setActive(true)

    const selected = document.getElementById('selected')! as HTMLElement
    const sibling = document.getElementById('sibling')! as HTMLElement
    stubRect(selected, { x: 0, y: 0, width: 100, height: 20 })
    stubRect(sibling, { x: 0, y: 30, width: 100, height: 20 })
    mode.select(selected)

    // Burst: 3 edits within 300ms — the FIRST snapshot (sibling at y=30) should be
    // the baseline the final diff is measured against, not a snapshot re-taken mid-burst.
    commit(fieldInput(mode.panelRoot, P.PY), '10')
    stubRect(sibling, { x: 0, y: 40, width: 100, height: 20 }) // mid-burst noise
    runRaf()
    vi.advanceTimersByTime(100)
    commit(fieldInput(mode.panelRoot, P.PY), '20')
    stubRect(sibling, { x: 0, y: 50, width: 100, height: 20 }) // mid-burst noise
    runRaf()
    vi.advanceTimersByTime(100)

    const showRipplesSpy = vi.spyOn(overlay, 'showRipples')
    commit(fieldInput(mode.panelRoot, P.PY), '30')
    stubRect(sibling, { x: 0, y: 70, width: 100, height: 20 }) // final settled position
    runRaf()

    expect(showRipplesSpy).toHaveBeenCalledWith([sibling.getBoundingClientRect()])
  })

  it('a slow drag (sub-threshold per-frame, above-threshold cumulative) still ripples on the burst\'s third edit', () => {
    // Discriminating test: each edit moves the sibling +0.4px relative to its PREVIOUS
    // position — below the 0.5px change threshold if re-baselined every frame (the bug:
    // handleEdited's rAF nulled rippleSnapshot, forcing a fresh baseline each edit).
    // Cumulatively across the burst the sibling has moved +1.2px from the DRAG-START
    // baseline, which IS above threshold. This only passes when the snapshot from the
    // first edit in the burst survives to be diffed against on the third edit.
    const queue: FrameRequestCallback[] = []
    vi.stubGlobal('requestAnimationFrame', (cb: FrameRequestCallback) => {
      queue.push(cb)
      return queue.length
    })
    const runRaf = () => queue.splice(0).forEach((cb) => cb(0))

    document.body.innerHTML = `
      <div data-dc-source="src/Wrap.tsx:1:1" id="scope">
        <div data-dc-source="src/Selected.tsx:2:2" id="selected" style="padding: 8px;"></div>
        <div data-dc-source="src/Sibling.tsx:3:3" id="sibling"></div>
      </div>
    `
    const overlay = new Overlay()
    overlay.mount()
    const mode = new DesignMode(overlay)
    liveModes.push(mode)
    mode.setActive(true)

    const selected = document.getElementById('selected')! as HTMLElement
    const sibling = document.getElementById('sibling')! as HTMLElement
    stubRect(selected, { x: 0, y: 0, width: 100, height: 20 })
    stubRect(sibling, { x: 0, y: 30, width: 100, height: 20 }) // drag-start baseline
    mode.select(selected)

    const showRipplesSpy = vi.spyOn(overlay, 'showRipples')

    commit(fieldInput(mode.panelRoot, P.PY), '10')
    stubRect(sibling, { x: 0, y: 30.4, width: 100, height: 20 }) // +0.4px vs previous — sub-threshold
    runRaf()
    vi.advanceTimersByTime(50) // well within the 300ms quiet window

    commit(fieldInput(mode.panelRoot, P.PY), '20')
    stubRect(sibling, { x: 0, y: 30.8, width: 100, height: 20 }) // +0.4px vs previous — sub-threshold
    runRaf()
    vi.advanceTimersByTime(50)

    commit(fieldInput(mode.panelRoot, P.PY), '30')
    stubRect(sibling, { x: 0, y: 31.2, width: 100, height: 20 }) // +0.4px vs previous, +1.2px vs drag-start
    runRaf()

    expect(showRipplesSpy).toHaveBeenCalledWith([sibling.getBoundingClientRect()])
  })

  it('re-snapshots when the selection changes mid-burst', () => {
    const queue: FrameRequestCallback[] = []
    vi.stubGlobal('requestAnimationFrame', (cb: FrameRequestCallback) => {
      queue.push(cb)
      return queue.length
    })
    const runRaf = () => queue.splice(0).forEach((cb) => cb(0))

    // Two separate component trees (separate scopes)
    document.body.innerHTML = `
      <div data-dc-source="src/ComponentA.tsx:1:1" id="compA" style="padding: 8px;">
        <div data-dc-source="src/ChildA.tsx:2:2" id="childA"></div>
        <div data-dc-source="src/SiblingA.tsx:3:3" id="siblingA"></div>
      </div>
      <div data-dc-source="src/ComponentB.tsx:4:4" id="compB" style="padding: 8px;">
        <div data-dc-source="src/ChildB.tsx:5:5" id="childB"></div>
        <div data-dc-source="src/SiblingB.tsx:6:6" id="siblingB"></div>
      </div>
    `
    const overlay = new Overlay()
    overlay.mount()
    const mode = new DesignMode(overlay)
    liveModes.push(mode)
    mode.setActive(true)

    const childA = document.getElementById('childA')! as HTMLElement
    const siblingA = document.getElementById('siblingA')! as HTMLElement
    const childB = document.getElementById('childB')! as HTMLElement
    const siblingB = document.getElementById('siblingB')! as HTMLElement

    // Setup both scopes with distinct positions
    stubRect(childA, { x: 0, y: 0, width: 100, height: 20 })
    stubRect(siblingA, { x: 0, y: 30, width: 100, height: 20 })
    stubRect(childB, { x: 400, y: 0, width: 100, height: 20 })
    stubRect(siblingB, { x: 400, y: 30, width: 100, height: 20 })

    const showRipplesSpy = vi.spyOn(overlay, 'showRipples')

    // STEP 1: Select childA and edit it. This snapshots ComponentA's scope (includes siblingA).
    mode.select(childA)
    commit(fieldInput(mode.panelRoot, P.PY), '10')
    // The rAF is queued but NOT yet run — snapshot still in memory
    expect(queue).toHaveLength(1)

    // Update positions as if layout reflow happened
    stubRect(siblingA, { x: 0, y: 40, width: 100, height: 20 })

    // STEP 2: Before the ripple rAF runs, switch to childB and edit it within debounce.
    // BUG: The old snapshot (childA's scope with siblingA) is still in mode.rippleSnapshot.
    // handleBeforeEdit(childB) should re-snapshot because the element changed, but the
    // buggy code only checks elapsed time, not which element the snapshot was for.
    mode.select(childB)
    commit(fieldInput(mode.panelRoot, P.PY), '10')
    // Now we have TWO rAFs queued: one from childA edit, one from childB edit
    expect(queue).toHaveLength(2)

    // Update childB's sibling position
    stubRect(siblingB, { x: 400, y: 40, width: 100, height: 20 })

    // Run BOTH rAFs and check what ripples were shown
    showRipplesSpy.mockClear()
    runRaf()

    // After running both rAFs:
    // - First rAF (from childA) diffs childA's snapshot against current positions
    // - Second rAF (from childB) diffs either childB's snapshot (CORRECT) or childA's (BUG)
    //
    // If the bug exists: childB's rAF diff runs against childA's snapshot, measuring siblingA.
    // Since siblingA moved from y=30→40, and the snapshot has y=30, it would show a ripple at y=40.
    // But we want it to show siblingB moving from y=30→40 at x=400.

    // Correct behavior: at least one call should have rects with x=400 (siblingB), not x=0 (siblingA).
    expect(showRipplesSpy.mock.calls.length).toBeGreaterThan(0)
    let hasCorrectRipple = false
    for (const callArgs of showRipplesSpy.mock.calls) {
      const rects = callArgs[0]
      for (const rect of rects) {
        if (rect.x === 400) {
          hasCorrectRipple = true
          break
        }
      }
    }
    expect(hasCorrectRipple).toBe(true) // Must see siblingB ripple, not just siblingA
  })

})

describe('DesignMode layout-ripple multi-select (B6 follow-up)', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  function fieldInput(root: HTMLElement, props: string): HTMLInputElement {
    const nf = [...root.querySelectorAll('.nf')].find((n) => (n as HTMLElement).dataset.props === props)
    if (!nf) throw new Error(`no field with data-props ${props}`)
    return nf.querySelector('input')!
  }

  function commit(input: HTMLInputElement, value: string): void {
    input.value = value
    input.dispatchEvent(new Event('change', { bubbles: true }))
  }

  function stubRect(el: Element, rect: { x: number; y: number; width: number; height: number }): void {
    el.getBoundingClientRect = () => new DOMRect(rect.x, rect.y, rect.width, rect.height)
  }

  function click(el: Element, opts: MouseEventInit = {}): void {
    el.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, ...opts }))
  }

  /** Flattens every rect from every showRipples call into one list. */
  function allRippledRects(spy: ReturnType<typeof vi.spyOn>): DOMRect[] {
    return spy.mock.calls.flatMap((call) => call[0] as DOMRect[])
  }

  // Two separate component trees (separate ripple scopes), each with its own sibling —
  // a multi-select spanning both must ripple around BOTH scopes.
  function twoScopeSetup() {
    const queue: FrameRequestCallback[] = []
    vi.stubGlobal('requestAnimationFrame', (cb: FrameRequestCallback) => {
      queue.push(cb)
      return queue.length
    })
    document.body.innerHTML = `
      <div data-dc-source="src/ComponentA.tsx:1:1" id="compA" style="padding: 8px;">
        <div data-dc-source="src/ChildA.tsx:2:2" id="childA"></div>
        <div data-dc-source="src/SiblingA.tsx:3:3" id="siblingA"></div>
      </div>
      <div data-dc-source="src/ComponentB.tsx:4:4" id="compB" style="padding: 8px;">
        <div data-dc-source="src/ChildB.tsx:5:5" id="childB"></div>
        <div data-dc-source="src/SiblingB.tsx:6:6" id="siblingB"></div>
      </div>
    `
    const overlay = new Overlay()
    overlay.mount()
    const mode = new DesignMode(overlay)
    liveModes.push(mode)
    mode.setActive(true)

    const childA = document.getElementById('childA')! as HTMLElement
    const siblingA = document.getElementById('siblingA')! as HTMLElement
    const childB = document.getElementById('childB')! as HTMLElement
    const siblingB = document.getElementById('siblingB')! as HTMLElement
    stubRect(childA, { x: 0, y: 0, width: 100, height: 20 })
    stubRect(siblingA, { x: 0, y: 30, width: 100, height: 20 })
    stubRect(childB, { x: 400, y: 0, width: 100, height: 20 })
    stubRect(siblingB, { x: 400, y: 30, width: 100, height: 20 })

    // Multi-select both children (click + shift-click, the real B6 gesture)
    click(childA)
    click(childB, { shiftKey: true })

    return { overlay, mode, childA, siblingA, childB, siblingB, runRaf: () => queue.splice(0).forEach((cb) => cb(0)) }
  }

  it('a multi-select edit ripples siblings in EVERY selected element\'s scope, not just the last one snapshotted', () => {
    const { overlay, mode, siblingA, siblingB, runRaf } = twoScopeSetup()
    const showRipplesSpy = vi.spyOn(overlay, 'showRipples')

    commit(fieldInput(mode.panelRoot, P.PY), '40')
    // post-edit reflow in BOTH scopes before the rAF-scheduled diff runs
    stubRect(siblingA, { x: 0, y: 60, width: 100, height: 20 })
    stubRect(siblingB, { x: 400, y: 60, width: 100, height: 20 })
    runRaf()

    const rects = allRippledRects(showRipplesSpy)
    // BUG (single-slot snapshot): only childB's snapshot survives the per-element
    // onBeforeEdit loop, so only siblingB ripples and siblingA's reflow is missed.
    expect(rects.some((r) => r.x === 0 && r.y === 60)).toBe(true) // siblingA
    expect(rects.some((r) => r.x === 400 && r.y === 60)).toBe(true) // siblingB
  })

  it('multi-select slow drag (sub-threshold per tick, above-threshold cumulative) still ripples — per-element baselines survive alternating onBeforeEdit calls', () => {
    // Each tick moves both siblings +0.4px (below the 0.5px CHANGE_THRESHOLD).
    // Cumulatively they move +1.2px from the drag-start baseline. This only ripples
    // if each element's FIRST snapshot in the burst survives the alternating
    // per-element onBeforeEdit calls of the multi-select commit loop — the old
    // single-slot state re-snapshotted on EVERY call (rippleSnapshotFor !== el),
    // re-baselining every tick and never crossing the threshold.
    const { overlay, mode, siblingA, siblingB, runRaf } = twoScopeSetup()
    const showRipplesSpy = vi.spyOn(overlay, 'showRipples')

    commit(fieldInput(mode.panelRoot, P.PY), '10')
    stubRect(siblingA, { x: 0, y: 30.4, width: 100, height: 20 })
    stubRect(siblingB, { x: 400, y: 30.4, width: 100, height: 20 })
    runRaf()
    vi.advanceTimersByTime(50) // well within the 300ms quiet window

    commit(fieldInput(mode.panelRoot, P.PY), '20')
    stubRect(siblingA, { x: 0, y: 30.8, width: 100, height: 20 })
    stubRect(siblingB, { x: 400, y: 30.8, width: 100, height: 20 })
    runRaf()
    vi.advanceTimersByTime(50)

    showRipplesSpy.mockClear()
    commit(fieldInput(mode.panelRoot, P.PY), '30')
    stubRect(siblingA, { x: 0, y: 31.2, width: 100, height: 20 })
    stubRect(siblingB, { x: 400, y: 31.2, width: 100, height: 20 })
    runRaf()

    const rects = allRippledRects(showRipplesSpy)
    expect(rects.some((r) => r.x === 0 && r.y === 31.2)).toBe(true) // siblingA
    expect(rects.some((r) => r.x === 400 && r.y === 31.2)).toBe(true) // siblingB
  })

  it('multi-select burst reuses each element\'s first snapshot instead of re-measuring the scope on every tick', () => {
    // Direct churn check: after the burst's first edit, subsequent edits within the
    // debounce window must NOT re-measure the siblings' rects at onBeforeEdit time
    // (only the post-edit rAF diff re-measures). The old single-slot state called
    // snapshotRects() for every element on every tick because the alternating
    // per-element calls always failed the rippleSnapshotFor === el reuse check.
    const { mode, siblingA, siblingB, runRaf } = twoScopeSetup()

    commit(fieldInput(mode.panelRoot, P.PY), '10')
    runRaf() // flush the first diff (one legitimate re-measure per sibling)
    vi.advanceTimersByTime(50)

    let measuresA = 0
    let measuresB = 0
    const rectA = new DOMRect(0, 30, 100, 20)
    const rectB = new DOMRect(400, 30, 100, 20)
    siblingA.getBoundingClientRect = () => (measuresA++, rectA)
    siblingB.getBoundingClientRect = () => (measuresB++, rectB)

    commit(fieldInput(mode.panelRoot, P.PY), '20')
    // No rAF flush yet: any measurement so far came from onBeforeEdit re-snapshotting.
    expect(measuresA).toBe(0)
    expect(measuresB).toBe(0)
    runRaf() // the diff itself measures each sibling exactly once
    expect(measuresA).toBe(1)
    expect(measuresB).toBe(1)
  })

  it('co-selected elements never appear in ripples even when they sit in each other\'s snapshot scope', () => {
    const queue: FrameRequestCallback[] = []
    vi.stubGlobal('requestAnimationFrame', (cb: FrameRequestCallback) => {
      queue.push(cb)
      return queue.length
    })
    const runRaf = (): void => queue.splice(0).forEach((cb) => cb(0))
    // ONE shared scope: each selected element appears in the OTHER's snapshot
    // (snapshotRects only excludes the element it was taken for).
    document.body.innerHTML = `
      <div data-dc-source="src/Wrap.tsx:1:1" id="scope">
        <div data-dc-source="src/SelA.tsx:2:2" id="selA" style="padding: 8px;"></div>
        <div data-dc-source="src/SelB.tsx:3:3" id="selB" style="padding: 8px;"></div>
        <div data-dc-source="src/Sibling.tsx:4:4" id="sibling"></div>
      </div>
    `
    const overlay = new Overlay()
    overlay.mount()
    const mode = new DesignMode(overlay)
    liveModes.push(mode)
    mode.setActive(true)

    const selA = document.getElementById('selA')! as HTMLElement
    const selB = document.getElementById('selB')! as HTMLElement
    const sibling = document.getElementById('sibling')! as HTMLElement
    stubRect(selA, { x: 0, y: 0, width: 100, height: 20 })
    stubRect(selB, { x: 0, y: 30, width: 100, height: 20 })
    stubRect(sibling, { x: 0, y: 60, width: 100, height: 20 })

    click(selA)
    click(selB, { shiftKey: true })
    const showRipplesSpy = vi.spyOn(overlay, 'showRipples')

    commit(fieldInput(mode.panelRoot, P.PY), '40')
    // BOTH edited elements grow (padding), pushing the sibling down
    stubRect(selA, { x: 0, y: 0, width: 100, height: 60 })
    stubRect(selB, { x: 0, y: 70, width: 100, height: 60 })
    stubRect(sibling, { x: 0, y: 140, width: 100, height: 20 })
    runRaf()

    const rects = allRippledRects(showRipplesSpy)
    expect(rects.some((r) => r.y === 140)).toBe(true) // the true sibling ripples
    // Neither co-selected element may ripple, even though each moved and each sits
    // in the other's snapshot scope.
    expect(rects.some((r) => r.height === 60)).toBe(false)
  })
})

describe('Dock integration (docked-panel spec)', () => {
  it('activating design mode docks by default: html margin set, panel visible with empty state', () => {
    const { mode, panel } = fullSetup()
    mode.setActive(true)
    expect(document.documentElement.style.marginRight).toBe('320px')
    expect(panel.root.hidden).toBe(false)
    expect((panel.root.querySelector('.panel-empty') as HTMLElement).hidden).toBe(false)
  })

  it('deactivating restores the html margin and hides the panel', () => {
    const { mode, panel } = fullSetup()
    mode.setActive(true)
    mode.setActive(false)
    expect(document.documentElement.style.marginRight).toBe('')
    expect(panel.root.hidden).toBe(true)
  })

  it('Escape-out (deselect then deactivate) also restores the margin — single setActive(false) path', () => {
    const { mode } = fullSetup()
    mode.setActive(true)
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' })) // no selection -> deactivates
    expect(mode.active).toBe(false)
    expect(document.documentElement.style.marginRight).toBe('')
  })

  it('adds no document-level listeners while inactive (idle-zero preserved with Dock constructed)', () => {
    const addSpy = vi.spyOn(document, 'addEventListener')
    const overlay = new Overlay()
    overlay.mount()
    new DesignMode(overlay)
    expect(addSpy).not.toHaveBeenCalled()
  })
})

describe('Canvas-mode chrome + lifecycle wiring (design-canvas-mode spec Task 7)', () => {
  // CanvasMode persists on/state to sessionStorage (canvas.ts) — a prior test's setOn(true)
  // would otherwise leak into the next test's fresh CanvasMode instance via loadCanvasPrefs().
  beforeEach(() => {
    sessionStorage.clear()
    vi.stubGlobal('scrollTo', vi.fn())
  })

  it('design-mode off suspends canvas (page restored) and design-mode on resumes it', () => {
    const { mode } = fullSetup()
    mode.setActive(true)
    const btn = mode.panelRoot.querySelector('.canvas-toggle') as HTMLButtonElement
    expect(btn).toBe(mode.panelRoot.querySelector('.panel-mode.canvas-toggle'))
    btn.click()
    expect(document.body.style.transform).toContain('scale(1)')
    expect(btn.classList.contains('on')).toBe(true)

    mode.setActive(false)
    expect(document.body.style.transform).toBe('')

    mode.setActive(true)
    expect(document.body.style.transform).toContain('scale(')
    mode.setActive(false)
  })

  it('the zoom pill is hidden until canvas mode is applied, then shows the live percentage', () => {
    const { mode, overlay } = fullSetup()
    mode.setActive(true)
    const wrap = overlay.host.shadowRoot!.querySelector('.zoom-pill-wrap') as HTMLElement
    expect(wrap.hidden).toBe(true)
    const btn = mode.panelRoot.querySelector('.canvas-toggle') as HTMLButtonElement
    btn.click()
    expect(wrap.hidden).toBe(false)
    const pill = wrap.querySelector('.zoom-pill') as HTMLButtonElement
    expect(pill.textContent).toBe('100%')
    // '100%' alone can't prove syncCanvasUi repaints — it's also the constructor label. A real
    // zoom change must flow back into the pill text through the onChange -> syncCanvasUi path.
    ;(mode as never as { canvas: { setZoomCentered(s: number): void } }).canvas.setZoomCentered(0.5)
    expect(pill.textContent).toBe('50%')
    mode.setActive(false)
    expect(wrap.hidden).toBe(true)
  })

  it('wheel over the panel (inside the shadow tree) scrolls the panel, not the artboard', () => {
    const { mode } = fullSetup()
    mode.setActive(true)
    ;(mode.panelRoot.querySelector('.canvas-toggle') as HTMLButtonElement).click()
    const before = document.body.style.transform
    // Real wheel events are composed: true, so composedPath()[0] crosses the shadow boundary
    // and hands CanvasMode the real INNER node — host.contains() can never match that node
    // (Node.contains stops at the shadow boundary), which is exactly the trap containsDeep
    // exists for. Dispatch from inside the panel root to walk that whole path.
    const inPanel = new WheelEvent('wheel', { deltaY: 40, cancelable: true, bubbles: true, composed: true })
    mode.panelRoot.dispatchEvent(inPanel)
    expect(inPanel.defaultPrevented).toBe(false)
    expect(document.body.style.transform).toBe(before)
    // Control: the same wheel over the page itself must still pan the artboard.
    const onPage = new WheelEvent('wheel', { deltaY: 40, cancelable: true, bubbles: true, composed: true })
    document.body.dispatchEvent(onPage)
    expect(onPage.defaultPrevented).toBe(true)
    expect(document.body.style.transform).not.toBe(before)
    mode.setActive(false)
  })

  it('panning/zooming the canvas re-measures the selection outline (final-review fix)', () => {
    // Queued (rather than the file-level immediate) rAF stub — the immediate stub resolves
    // requestAnimationFrame() synchronously INSIDE the call that schedules it, so the id it
    // returns overwrites reflowRaf back to non-zero right after the callback already reset it
    // to 0, permanently wedging the rAF-coalescing guard shut. A queued stub matches real rAF
    // semantics (id is live until the callback actually runs) so the guard behaves correctly
    // across the canvas-toggle click's own reflow(s) and the wheel-triggered one under test.
    const queue: FrameRequestCallback[] = []
    vi.stubGlobal('requestAnimationFrame', (cb: FrameRequestCallback) => {
      queue.push(cb)
      return queue.length
    })
    const runRaf = (): void => queue.splice(0).forEach((cb) => cb(0))

    const { overlay, mode } = fullSetup()
    const btn = document.querySelector('.btn') as HTMLElement
    // Stand-in for "the element's real rect moved because the body transform panned/zoomed" —
    // jsdom's getBoundingClientRect is transform-blind, so a real canvas pan never changes it.
    // Mutating this stub between select() and the wheel dispatch simulates that real-world move.
    const rect = { x: 0, y: 0, width: 50, height: 20 }
    btn.getBoundingClientRect = () => new DOMRect(rect.x, rect.y, rect.width, rect.height)

    mode.setActive(true)
    ;(mode.panelRoot.querySelector('.canvas-toggle') as HTMLButtonElement).click()
    runRaf() // drain canvas-apply's own onChange-triggered reflow(s) before selecting
    mode.select(btn as never)

    const outlineEl = overlay.host.shadowRoot!.querySelector('#select-outline') as HTMLElement
    const before = outlineEl.style.left
    expect(before).toBe('-2px')

    rect.x = 240
    rect.y = 180
    // Real ctrl-wheel zoom, composed so it crosses the shadow boundary like the real gesture.
    const zoom = new WheelEvent('wheel', {
      deltaY: -40, ctrlKey: true, cancelable: true, bubbles: true, composed: true,
    })
    document.body.dispatchEvent(zoom)
    runRaf()

    // The body transform moved the element's visual rect but fired no scroll/resize — canvas's
    // onChange must be the reflow trigger, or the outline is left showing the stale pre-pan rect.
    expect(outlineEl.style.left).toBe('238px')
    expect(outlineEl.style.left).not.toBe(before)
    mode.setActive(false)
  })
})

describe('lifecycle persistence', () => {
  beforeEach(() => sessionStorage.clear())

  it('persists design mode, drafts, and selection on change', () => {
    const overlay = new Overlay()
    overlay.mount()
    const mode = new DesignMode(overlay)
    liveModes.push(mode)
    overlay.attach(mode.panelRoot)
    const el = document.createElement('div')
    el.setAttribute('data-dc-source', 'src/App.tsx:3:3')
    document.body.appendChild(el)
    mode.setActive(true)
    mode.select(el as never)
    ;(mode as never as { drafts: DraftStore }).drafts.apply(el as never, 'padding-top', '24px')
    // R2 F-C: draft persistence is now debounced (trailing 300ms) off drafts.onChange — selection
    // is persisted synchronously (setSelection's own persist() call), but the draft write lands
    // only once setActive(false) below flushes it (or the debounce timer fires).
    const saved = loadLifecycle()
    expect(saved?.designModeOn).toBe(true)
    expect(saved?.selection).toEqual([{ dcSource: 'src/App.tsx:3:3', index: 0 }])
    mode.setActive(false)
    expect(loadLifecycle()?.designModeOn).toBe(false)
    // setActive(false)'s flush must have carried the draft through before teardown cleared it.
    expect(loadLifecycle()?.drafts).toEqual([{ dcSource: 'src/App.tsx:3:3', index: 0, props: [['padding-top', '24px']] }])
  })

  // R1: seeds now carry their own instance index end-to-end (send -> persist -> restore),
  // fixing the index-degradation bug where persist() recomputed sourceIndex(seed.el, ...) —
  // which always resolves to 0 once a placeholder is detached, silently losing which of several
  // DOM instances sharing one dcSource a request actually targeted.
  it('persist -> restore preserves the sent element index for the SECOND of two list instances', async () => {
    document.body.innerHTML = `
      <li data-dc-source="src/List.tsx:4:4" id="first"></li>
      <li data-dc-source="src/List.tsx:4:4" id="second"></li>`
    const second = document.getElementById('second')!
    const fetchMock = vi.fn((url: string) => {
      if (url === '/__the-forge/queue') return Promise.resolve({ ok: true, json: async () => ({ id: 'q1' }) })
      if (url === '/__the-forge/dispatch') return Promise.resolve({ ok: true, json: async () => ({ rung: 'manual', detail: '' }) })
      return Promise.resolve({ ok: true, json: async () => ({ items: [], watcher: 'none' }) })
    })
    vi.stubGlobal('fetch', fetchMock)
    const overlay = new Overlay()
    overlay.mount()
    const mode = new DesignMode(overlay)
    liveModes.push(mode)
    overlay.attach(mode.panelRoot)
    mode.setActive(true)
    ;(mode as never as { drafts: DraftStore }).drafts.apply(second as never, 'padding-top', '24px')
    ;(mode.panelRoot.querySelector('.chat-send') as HTMLButtonElement).click()
    for (let i = 0; i < 6; i++) await Promise.resolve() // flush /queue + /dispatch

    const persisted = loadLifecycle()
    expect(persisted?.sent).toHaveLength(1)
    expect(persisted!.sent[0].elements[0].index).toBe(1) // the SECOND instance, not degraded to 0

    // Simulate a full reload: fresh DesignMode restoring from the same persisted lifecycle.
    const overlay2 = new Overlay()
    overlay2.mount()
    const mode2 = new DesignMode(overlay2)
    liveModes.push(mode2)
    overlay2.attach(mode2.panelRoot)
    mode2.restoreLifecycle(persisted!)

    const reRoundTripped = loadLifecycle()
    expect(reRoundTripped!.sent[0].elements[0].index).toBe(1) // survives a second persist() too
  })

  it('restoreLifecycle re-activates, re-applies drafts, re-arms the verifier, and re-selects', () => {
    document.body.innerHTML = `<div data-dc-source="src/App.tsx:3:3" id="target"></div>`
    const target = document.getElementById('target')!
    const overlay = new Overlay()
    overlay.mount()
    const mode = new DesignMode(overlay)
    liveModes.push(mode)
    overlay.attach(mode.panelRoot)
    mode.restoreLifecycle({
      v: 1,
      designModeOn: true,
      selection: [{ dcSource: 'src/App.tsx:3:3', index: 0 }],
      drafts: [{ dcSource: 'src/App.tsx:3:3', index: 0, props: [['padding-top', '24px']] }],
      sent: [
        {
          id: 'q1',
          elements: [
            {
              dcSource: 'src/App.tsx:3:3',
              index: 0,
              tag: 'div',
              draftProps: ['padding-top'],
              changes: [{ property: 'padding-top', afterCss: '24px' }],
              change: {
                tag: 'div',
                source: { file: 'src/App.tsx', line: 3, col: 3 },
                className: '',
                text: '',
                selector: 'div',
                changes: [{ property: 'padding-top', beforeCss: '8px', afterCss: '24px', beforeUtility: null, afterUtility: 'pt-6', tokenExact: true }],
              },
            },
          ],
        },
      ],
    })
    expect(mode.active).toBe(true)
    expect(target.style.getPropertyValue('padding-top')).toBe('24px') // draft preview re-applied
    expect(mode.selection).toHaveLength(1)
    expect(mode.session.size()).toBe(1) // verifier re-armed against the restored registry
    expect(mode.panelRoot.querySelector('.chip-sent')).not.toBeNull()
  })

  it('a sent element that cannot be located gets a greyed row, not a crash', () => {
    const overlay = new Overlay()
    overlay.mount()
    const mode = new DesignMode(overlay)
    liveModes.push(mode)
    overlay.attach(mode.panelRoot)
    mode.restoreLifecycle({
      v: 1,
      designModeOn: true,
      selection: [],
      drafts: [],
      sent: [
        {
          id: 'q1',
          elements: [
            {
              dcSource: 'gone.tsx:1:1',
              index: 0,
              tag: 'span',
              draftProps: [],
              changes: [{ property: 'color', afterCss: 'rgb(0, 0, 0)' }],
              change: { tag: 'span', source: { file: 'gone.tsx', line: 1, col: 1 }, className: '', text: '', selector: 'span', changes: [{ property: 'color', beforeCss: 'rgb(255, 255, 255)', afterCss: 'rgb(0, 0, 0)', beforeUtility: null, afterUtility: null, tokenExact: false }] },
            },
          ],
        },
      ],
    })
    const row = mode.panelRoot.querySelector('.change-row')!
    expect(row.className).toContain('row-gone')
  })

  it('boot restore is a no-op when design mode was off', () => {
    saveLifecycle({ v: 1, designModeOn: false, selection: [], drafts: [], sent: [] })
    const overlay = new Overlay()
    overlay.mount()
    const mode = new DesignMode(overlay)
    liveModes.push(mode)
    overlay.attach(mode.panelRoot)
    const saved = loadLifecycle()
    if (saved?.designModeOn) mode.restoreLifecycle(saved) // mirrors boot()
    expect(mode.active).toBe(false)
  })
})

// R2 F-C: drafts.onChange previously ran refreshStatus() + changeList.syncDrafts() + persist()
// on EVERY scrub tick — querySelectorAll + JSON.stringify + a synchronous sessionStorage.setItem
// + replaceChildren per drag frame, against the codebase's own "React never re-renders while
// scrubbing" discipline. Fix: refreshStatus() stays immediate (cheap label update);
// syncDrafts()+persist() are debounced on a shared trailing 300ms timer (RIPPLE_DEBOUNCE_MS,
// same "quiet window" concept as the ripple burst logic). flushDraftSync() cancels the timer and
// runs both immediately — called from setActive(false) teardown and at the top of Send's click
// handler so a send/deactivate always sees current, persisted drafts.
describe('debounced scrub persistence (R2 F-C)', () => {
  beforeEach(() => sessionStorage.clear())

  it('a burst of drafts.apply calls debounces sessionStorage.setItem down to at most two calls, then settles to the final value after 300ms', () => {
    vi.useFakeTimers()
    try {
      const { mode, drafts } = fullSetup()
      mode.setActive(true)
      const btn = document.querySelector('button')! as HTMLElement

      const setItemSpy = vi.spyOn(Storage.prototype, 'setItem')
      setItemSpy.mockClear() // narrow to the burst window only — exclude setActive(true)'s own persist

      for (let i = 0; i < 10; i++) drafts.apply(btn, 'padding-top', `${i}px`)

      // At most: one immediate persist from some other synchronous trigger during the burst is
      // NOT expected here (all 10 calls are drafts.apply — no selection change) — so the debounced
      // path itself must not have flushed to storage yet.
      const burstCalls = setItemSpy.mock.calls.filter(([key]) => key === 'the-forge:lifecycle').length
      expect(burstCalls).toBeLessThanOrEqual(2)
      // The Changes list must not have re-rendered per tick either — no draft row yet since
      // syncDrafts() is debounced alongside persist().
      const changeList = (mode as never as { changeList: { root: HTMLElement } }).changeList
      expect(changeList.root.querySelector('.change-row')).toBeNull()

      vi.advanceTimersByTime(300)

      expect(loadLifecycle()?.drafts).toEqual([{ dcSource: 'src/Button.tsx:42:8', index: 0, props: [['padding-top', '9px']] }])
      expect(changeList.root.querySelector('.change-row')).not.toBeNull()
    } finally {
      vi.useRealTimers()
    }
  })

  it('setActive(false) mid-debounce-window flushes drafts to storage immediately', () => {
    vi.useFakeTimers()
    try {
      const { mode, drafts } = fullSetup()
      mode.setActive(true)
      const btn = document.querySelector('button')! as HTMLElement

      drafts.apply(btn, 'padding-top', '24px')
      // No timer advance — still inside the debounce window.
      mode.setActive(false)

      expect(loadLifecycle()?.drafts).toEqual([{ dcSource: 'src/Button.tsx:42:8', index: 0, props: [['padding-top', '24px']] }])
    } finally {
      vi.useRealTimers()
    }
  })

  it('clicking Send mid-debounce-window flushes drafts to storage before the request is built', async () => {
    vi.useFakeTimers()
    try {
      const fetchMock = vi.fn((url: string) => {
        if (url === '/__the-forge/queue') return Promise.resolve({ ok: true, json: async () => ({ id: 'q1' }) })
        return Promise.resolve({ ok: true, json: async () => ({ rung: 'manual', detail: '' }) })
      })
      vi.stubGlobal('fetch', fetchMock)
      const { mode, drafts, panel } = fullSetup()
      mode.setActive(true)
      const btn = document.querySelector('button')! as HTMLElement
      drafts.apply(btn, 'padding-top', '24px')

      ;(panel.root.querySelector('.chat-send') as HTMLButtonElement).click()
      // Flush microtasks under fake timers without advancing real time.
      for (let i = 0; i < 6; i++) await Promise.resolve()

      expect(loadLifecycle()?.drafts !== undefined).toBe(true)
    } finally {
      vi.useRealTimers()
    }
  })
})

// Critical E2E finding: boot() runs restoreLifecycle() before the framework has rendered the
// app, so locateBySource() finds nothing at that instant. These tests reproduce that race by
// calling restoreLifecycle() against an EMPTY document, then appending the element afterward.
describe('lifecycle restore races the framework mount', () => {
  beforeEach(() => {
    sessionStorage.clear()
    vi.useFakeTimers()
  })
  afterEach(() => {
    vi.useRealTimers()
  })

  const savedState = {
    v: 1 as const,
    designModeOn: true,
    selection: [{ dcSource: 'src/App.tsx:3:3', index: 0 }],
    drafts: [{ dcSource: 'src/App.tsx:3:3', index: 0, props: [['padding-top', '24px']] as [string, string][] }],
    sent: [],
  }

  it('restore retries until the framework renders', () => {
    // DOM is empty at restore time — mirrors boot() racing the app mount.
    const overlay = new Overlay()
    overlay.mount()
    const mode = new DesignMode(overlay)
    liveModes.push(mode)
    overlay.attach(mode.panelRoot)
    mode.restoreLifecycle(savedState)
    expect(mode.active).toBe(true)
    expect(mode.selection).toHaveLength(0) // nothing to locate yet

    // Framework "mounts" the element.
    const target = document.createElement('div')
    target.setAttribute('data-dc-source', 'src/App.tsx:3:3')
    document.body.appendChild(target)

    vi.advanceTimersByTime(600)

    expect(target.style.getPropertyValue('padding-top')).toBe('24px')
    expect(mode.selection).toHaveLength(1)
    expect(mode.selection[0]).toBe(target as never)
    expect(loadLifecycle()?.drafts).toEqual([{ dcSource: 'src/App.tsx:3:3', index: 0, props: [['padding-top', '24px']] }])
  })

  it('storage stays lossless during the retry window', () => {
    const overlay = new Overlay()
    overlay.mount()
    const mode = new DesignMode(overlay)
    liveModes.push(mode)
    overlay.attach(mode.panelRoot)
    mode.restoreLifecycle(savedState)

    // Before the element ever appears, storage must still carry the pending draft — persist()
    // must not have clobbered it down to [] just because the live DraftStore is empty.
    expect(loadLifecycle()?.drafts).toEqual([{ dcSource: 'src/App.tsx:3:3', index: 0, props: [['padding-top', '24px']] }])
    expect(loadLifecycle()?.selection).toEqual([{ dcSource: 'src/App.tsx:3:3', index: 0 }])
  })

  it('deactivation cancels the retry', () => {
    const overlay = new Overlay()
    overlay.mount()
    const mode = new DesignMode(overlay)
    liveModes.push(mode)
    overlay.attach(mode.panelRoot)
    mode.restoreLifecycle(savedState)

    mode.setActive(false)

    const target = document.createElement('div')
    target.setAttribute('data-dc-source', 'src/App.tsx:3:3')
    document.body.appendChild(target)

    vi.advanceTimersByTime(15000) // well past the ~12s bounded window

    expect(target.style.getPropertyValue('padding-top')).toBe('')
  })

  it('retry gives up after the bounded window', () => {
    // DOM never gets the element — the whole point of the bound.
    const overlay = new Overlay()
    overlay.mount()
    const mode = new DesignMode(overlay)
    liveModes.push(mode)
    overlay.attach(mode.panelRoot)
    expect(() => {
      mode.restoreLifecycle(savedState)
      vi.advanceTimersByTime(13000)
    }).not.toThrow()

    // A subsequent persist (e.g. a later selection change) must no longer carry the entry —
    // pendingRestore was drained once attempts were exhausted.
    mode.deselect()
    expect(loadLifecycle()?.drafts).toEqual([])
  })
})

// R2 F-B: the boot pass and the retry pass used two divergent selection policies — boot applies
// PARTIAL drafts but queues the ENTIRE saved.selection as unresolved; the retry pass only ever
// touches selection when `this.selection.length === 0` (dead once boot selected anything) and
// required ALL-or-nothing. A partial restore (one of two selected elements exists at boot) left
// the second element's pending selection undrainable — the retry timer spun all 40 attempts as
// a zombie. Fixed via one drainPendingRestore() used by both the boot pass and every retry tick,
// with a per-item selection policy (add located elements while the selection is still
// restore-owned; never stomp a user's own selection).
describe('lifecycle restore: unified per-item drain (R2 F-B)', () => {
  beforeEach(() => {
    sessionStorage.clear()
    vi.useFakeTimers()
  })
  afterEach(() => {
    vi.useRealTimers()
  })

  const twoElementSelectionState = {
    v: 1 as const,
    designModeOn: true,
    selection: [
      { dcSource: 'src/App.tsx:3:3', index: 0 },
      { dcSource: 'src/App.tsx:5:3', index: 0 },
    ],
    drafts: [],
    sent: [],
  }

  it('partial restore: the element present at boot is selected; the late-appearing one is ADDED by retry and the timer stops', () => {
    // First selection element exists at boot time — mirrors a real partial framework mount.
    const first = document.createElement('div')
    first.setAttribute('data-dc-source', 'src/App.tsx:3:3')
    document.body.appendChild(first)

    const overlay = new Overlay()
    overlay.mount()
    const mode = new DesignMode(overlay)
    liveModes.push(mode)
    overlay.attach(mode.panelRoot)
    mode.restoreLifecycle(twoElementSelectionState)

    expect(mode.selection).toHaveLength(1)
    expect(mode.selection[0]).toBe(first as never)

    // Second element appears later.
    const second = document.createElement('div')
    second.setAttribute('data-dc-source', 'src/App.tsx:5:3')
    document.body.appendChild(second)

    vi.advanceTimersByTime(300)

    expect(mode.selection).toHaveLength(2)
    expect(mode.selection).toContain(second as never)

    // Timer must have stopped — advancing well past the full 40x300ms window must cause no
    // further state change (no throw, no further retry work scheduled).
    const selectionBefore = [...mode.selection]
    expect(() => vi.advanceTimersByTime(15000)).not.toThrow()
    expect(mode.selection).toEqual(selectionBefore)
  })

  it("a user selection made mid-window is never stomped by a late-appearing restore element, and pending drains to done", () => {
    const overlay = new Overlay()
    overlay.mount()
    const mode = new DesignMode(overlay)
    liveModes.push(mode)
    overlay.attach(mode.panelRoot)
    // Neither element exists at boot — both selection entries are pending.
    mode.restoreLifecycle(twoElementSelectionState)
    expect(mode.selection).toHaveLength(0)

    // User selects an unrelated element mid-window.
    const userEl = document.createElement('div')
    userEl.setAttribute('data-dc-source', 'src/Other.tsx:1:1')
    document.body.appendChild(userEl)
    mode.select(userEl)
    expect(mode.selection).toEqual([userEl])

    // Now the restore-targeted elements appear.
    const first = document.createElement('div')
    first.setAttribute('data-dc-source', 'src/App.tsx:3:3')
    document.body.appendChild(first)
    const second = document.createElement('div')
    second.setAttribute('data-dc-source', 'src/App.tsx:5:3')
    document.body.appendChild(second)

    vi.advanceTimersByTime(300)

    // The user's own selection must survive untouched.
    expect(mode.selection).toEqual([userEl])

    // Pending restore work must have drained to done (dropped as resolved-obsolete), not kept
    // retrying forever — a later persist() must carry no leftover pending selection.
    mode.select(userEl) // no-op selection change to force a fresh persist() read
    expect(loadLifecycle()?.selection).toEqual([{ dcSource: 'src/Other.tsx:1:1', index: 0 }])
  })
})

// Final-review F1: resend() queued a fresh request and updated the live registry/ChangeList,
// but never called persist() — so a reload within the ~2s verifier-poll window after a re-send
// lost the re-sent entry from the restored session, defeating the milestone's headline guarantee.
describe('resend persistence (final-review F1)', () => {
  beforeEach(() => sessionStorage.clear())

  it('persists the re-sent id so a reload after resend restores it', async () => {
    const fetchMock = vi.fn((url: string) => {
      if (url === '/__the-forge/queue') return Promise.resolve({ ok: true, json: async () => ({ id: 'resent-1' }) })
      if (url === '/__the-forge/dispatch') return Promise.resolve({ ok: true, json: async () => ({ rung: 'manual', detail: '' }) })
      return Promise.resolve({ ok: true, json: async () => ({ items: [], watcher: 'none' }) })
    })
    vi.stubGlobal('fetch', fetchMock)
    const overlay = new Overlay()
    overlay.mount()
    const mode = new DesignMode(overlay)
    liveModes.push(mode)
    overlay.attach(mode.panelRoot)
    const el = document.createElement('div')
    el.setAttribute('data-dc-source', 'src/App.tsx:3:3')
    document.body.appendChild(el)
    mode.setActive(true)

    // Seed a failed sent row directly via restoreLifecycle-shaped state, then trigger Re-send
    // through the panel's ChangeList — the same path a real "Re-send" click takes.
    mode.restoreLifecycle({
      v: 1,
      designModeOn: true,
      selection: [],
      drafts: [],
      sent: [
        {
          id: 'q-failed',
          elements: [
            {
              dcSource: 'src/App.tsx:3:3',
              index: 0,
              tag: 'div',
              draftProps: ['padding-top'],
              changes: [{ property: 'padding-top', afterCss: '24px' }],
              change: {
                tag: 'div',
                source: { file: 'src/App.tsx', line: 3, col: 3 },
                className: '',
                text: '',
                selector: 'div',
                changes: [{ property: 'padding-top', beforeCss: '8px', afterCss: '24px', beforeUtility: null, afterUtility: 'pt-6', tokenExact: true }],
              },
            },
          ],
        },
      ],
    })
    // Force the row into 'failed' so the Re-send button renders.
    const changeList = (mode as never as { changeList: { applyStage: (e: unknown) => void } }).changeList
    changeList.applyStage({ requestId: 'q-failed', elIndex: 0, dcSource: 'src/App.tsx:3:3', stage: 'failed', note: 'nope' })

    const resendBtn = mode.panelRoot.querySelector('.change-resend') as HTMLElement
    expect(resendBtn).not.toBeNull()
    resendBtn.click()
    for (let i = 0; i < 6; i++) await Promise.resolve()

    expect(loadLifecycle()?.sent.some((s) => s.id === 'resent-1')).toBe(true)
  })
})

// R2 F-A: resend() had no re-entrancy guard — the failed row deliberately survives until the
// re-queue POST resolves (F5), so a double-click on "Re-send" before the first POST settles
// fires a second identical /queue POST. isDuplicate() can't catch this: the failed record is
// already resolved (outside the sent-but-unverified duplicate window) by the time the second
// click's prepareSend-equivalent path runs.
describe('resend re-entrancy guard (R2 F-A)', () => {
  beforeEach(() => sessionStorage.clear())

  /** Seeds a failed sent row and returns its Re-send button — same setup as the F1 resend
   * persistence test above, factored out for reuse. */
  function setupFailedResend(fetchMock: ReturnType<typeof vi.fn>): { mode: DesignMode; resendBtn: HTMLElement } {
    vi.stubGlobal('fetch', fetchMock)
    const overlay = new Overlay()
    overlay.mount()
    const mode = new DesignMode(overlay)
    liveModes.push(mode)
    overlay.attach(mode.panelRoot)
    const el = document.createElement('div')
    el.setAttribute('data-dc-source', 'src/App.tsx:3:3')
    document.body.appendChild(el)
    mode.setActive(true)
    mode.restoreLifecycle({
      v: 1,
      designModeOn: true,
      selection: [],
      drafts: [],
      sent: [
        {
          id: 'q-failed',
          elements: [
            {
              dcSource: 'src/App.tsx:3:3',
              index: 0,
              tag: 'div',
              draftProps: ['padding-top'],
              changes: [{ property: 'padding-top', afterCss: '24px' }],
              change: {
                tag: 'div',
                source: { file: 'src/App.tsx', line: 3, col: 3 },
                className: '',
                text: '',
                selector: 'div',
                changes: [{ property: 'padding-top', beforeCss: '8px', afterCss: '24px', beforeUtility: null, afterUtility: 'pt-6', tokenExact: true }],
              },
            },
          ],
        },
      ],
    })
    const changeList = (mode as never as { changeList: { applyStage: (e: unknown) => void } }).changeList
    changeList.applyStage({ requestId: 'q-failed', elIndex: 0, dcSource: 'src/App.tsx:3:3', stage: 'failed', note: 'nope' })
    const resendBtn = mode.panelRoot.querySelector('.change-resend') as HTMLElement
    expect(resendBtn).not.toBeNull()
    return { mode, resendBtn }
  }

  it('clicking Re-send twice rapidly (before the first POST resolves) queues exactly one /queue POST', async () => {
    let resolveQueue!: (v: { ok: boolean; json: () => Promise<{ id: string }> }) => void
    const fetchMock = vi.fn((url: string) => {
      if (url === '/__the-forge/queue') return new Promise((resolve) => (resolveQueue = resolve))
      return Promise.resolve({ ok: true, json: async () => ({ rung: 'manual', detail: '' }) })
    })
    const { resendBtn } = setupFailedResend(fetchMock)

    resendBtn.click()
    resendBtn.click() // still in flight — must be a no-op, not a second POST
    await Promise.resolve()
    await Promise.resolve()

    resolveQueue({ ok: true, json: async () => ({ id: 'resent-1' }) })
    for (let i = 0; i < 6; i++) await Promise.resolve()

    const queueCalls = fetchMock.mock.calls.filter(([url]) => url === '/__the-forge/queue')
    expect(queueCalls).toHaveLength(1)
  })

  it('a resend that fails clears the in-flight guard so a later Re-send click works', async () => {
    let queueCallCount = 0
    const fetchMock = vi.fn((url: string) => {
      if (url === '/__the-forge/queue') {
        queueCallCount++
        return queueCallCount === 1 ? Promise.reject(new Error('network down')) : Promise.resolve({ ok: true, json: async () => ({ id: 'resent-2' }) })
      }
      return Promise.resolve({ ok: true, json: async () => ({ rung: 'manual', detail: '' }) })
    })
    const { resendBtn } = setupFailedResend(fetchMock)

    resendBtn.click()
    for (let i = 0; i < 6; i++) await Promise.resolve()

    // First resend failed — the guard must have been released so a second, later click works.
    resendBtn.click()
    for (let i = 0; i < 6; i++) await Promise.resolve()

    const queueCalls = fetchMock.mock.calls.filter(([url]) => url === '/__the-forge/queue')
    expect(queueCalls).toHaveLength(2)
    expect(loadLifecycle()?.sent.some((s) => s.id === 'resent-2')).toBe(true)
  })
})

// Final-review F3: loadLifecycle only validates top-level shape (v/designModeOn/array-ness) —
// a shallow-valid-but-corrupt `sent` element (e.g. `{}`, missing dcSource/elements/etc.) throws
// mid-restoreLifecycle with capture-phase listeners already attached (setActive(true) ran
// first). boot() must guard the call so corrupt storage degrades to "start clean", not a thrown
// exception on every page load.
describe('boot restore guard against corrupt storage (final-review F3)', () => {
  beforeEach(() => sessionStorage.clear())

  it('drops a shallow-valid-but-corrupt sent entry at the boundary and restores the rest cleanly', () => {
    sessionStorage.setItem(
      'the-forge:lifecycle',
      JSON.stringify({ v: 1, designModeOn: true, selection: [], drafts: [], sent: [{}] })
    )
    const overlay = new Overlay()
    overlay.mount()
    const mode = new DesignMode(overlay)
    liveModes.push(mode)
    overlay.attach(mode.panelRoot)
    const saved = loadLifecycle()
    // R1: loadLifecycle now validates and drops invalid items PER ENTRY — a corrupt array
    // element (missing `id`/`elements`, here `{}`) is dropped by loadLifecycle itself and never
    // reaches restoreLifecycle at all, so saved.sent is simply []. boot()'s try/catch around
    // restoreLifecycle is defense-in-depth only now (see index.ts boot()), not load-bearing —
    // this mirrors that guarded call, but the guard is no longer what saves the session.
    expect(saved?.sent).toEqual([])
    expect(() => {
      if (saved?.designModeOn) {
        try {
          mode.restoreLifecycle(saved)
        } catch {
          mode.setActive(false)
        }
      }
    }).not.toThrow()
    // A clean restore (nothing corrupt survived to restoreLifecycle) leaves the session ACTIVE —
    // no more degrading a good session to "start clean" just because storage carried one
    // now-safely-dropped bad item alongside it.
    expect(mode.active).toBe(true)
  })
})

describe('watcher unlink wiring', () => {
  it('✕ POSTs /unwatch with the secret header, then re-polls watcher state immediately', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue({ ok: true, json: async () => ({ items: [], watcher: 'none' }) })
    vi.stubGlobal('fetch', fetchMock)
    ;(globalThis as { __THE_FORGE__?: unknown }).__THE_FORGE__ = { secret: 's3cret', agent: 'claude-code' }
    try {
      const { overlay, mode } = fullSetup()
      mode.setActive(true) // watch poller only runs while design mode is on
      overlay.unlinkButton.click()
      await new Promise((r) => setTimeout(r, 5)) // fetch .then chain + the re-poll's 0ms timer
      expect(fetchMock).toHaveBeenCalledWith('/__the-forge/unwatch', {
        method: 'POST',
        headers: { 'X-Forge-Secret': 's3cret' },
      })
      // Re-poll: at least one status probe AFTER the unwatch call (setActive fired the first).
      const calls = fetchMock.mock.calls.map((c) => c[0])
      const unwatchIndex = calls.indexOf('/__the-forge/unwatch')
      expect(calls.slice(unwatchIndex + 1)).toContain('/__the-forge/status?ids=')
    } finally {
      delete (globalThis as { __THE_FORGE__?: unknown }).__THE_FORGE__
    }
  })
})

// ---------------------------------------------------------------------------
// SessionFeed wiring (Task 8)
// ---------------------------------------------------------------------------

describe('SessionFeed wiring', () => {
  const encoder = new TextEncoder()

  /** Drain microtasks — each round resolves one Promise level.
   * ReadableStream reads settle as microtasks, so 40 rounds covers startup + a handful of events. */
  async function flushMicrotasks(rounds = 40): Promise<void> {
    for (let i = 0; i < rounds; i++) await new Promise<void>((r) => queueMicrotask(r))
  }

  /** Returns a fetch stub that delivers the given NDJSON lines on the events stream and
   * keeps the stream open (does not close), so the feed parks at reader.read(). All other
   * URLs return a benign JSON response so status polls don't throw. */
  function makeEventsFetch(lines: string[]): ReturnType<typeof vi.fn> {
    return vi.fn((url: string) => {
      if (url.startsWith('/__the-forge/session/events')) {
        return Promise.resolve(
          new Response(
            new ReadableStream<Uint8Array>({
              start(controller) {
                for (const line of lines) controller.enqueue(encoder.encode(line + '\n'))
                // keep open — feed parks at next reader.read() without triggering reconnect
              },
            }),
            { status: 200, headers: { 'Content-Type': 'application/x-ndjson' } }
          )
        )
      }
      return Promise.resolve({ ok: true, json: async () => ({ watcher: 'none', session: 'idle' }) })
    })
  }

  it('feed starts on setActive(true) and stops on setActive(false)', () => {
    const startSpy = vi.spyOn(SessionFeed.prototype, 'start')
    const stopSpy = vi.spyOn(SessionFeed.prototype, 'stop')
    vi.stubGlobal('fetch', vi.fn((url: string) => {
      if (url.startsWith('/__the-forge/session/events')) return new Promise<never>(() => {})
      return Promise.resolve({ ok: true, json: async () => ({ watcher: 'none' }) })
    }))
    const overlay = new Overlay()
    overlay.mount()
    const mode = new DesignMode(overlay)
    liveModes.push(mode)

    mode.setActive(true)
    expect(startSpy).toHaveBeenCalledOnce()

    mode.setActive(false)
    expect(stopSpy).toHaveBeenCalled()
  })

  // The standalone Stop button was retired by composer consolidation (Task 1) \u2014 its job moved
  // onto .composer-send's morph (\u25a0 while busyish and the textarea is empty). This is the
  // behavior equivalent of the old "Stop button POSTs /session/interrupt" test.
  it('composer-send, morphed to \u25a0 while busyish, POSTs /session/interrupt with secret header', async () => {
    const assistantLine = JSON.stringify({
      type: 'feed', seq: 1, at: new Date().toISOString(),
      event: { kind: 'assistant-text', text: 'working\u2026' },
    })
    const fetchMock = makeEventsFetch([assistantLine])
    vi.stubGlobal('fetch', fetchMock)
    ;(globalThis as { __THE_FORGE__?: { secret?: string } }).__THE_FORGE__ = { secret: 'shhh' }
    try {
      const overlay = new Overlay()
      overlay.mount()
      const mode = new DesignMode(overlay)
      liveModes.push(mode)
      overlay.attach(mode.panelRoot)
      mode.setActive(true)

      await flushMicrotasks()

      // composer-send morphs to \u25a0 only while busyish (triggered by assistant-text event) and
      // the textarea is empty.
      const sendBtn = mode.panelRoot.querySelector('.composer-send') as HTMLButtonElement
      expect(sendBtn).not.toBeNull()
      expect(sendBtn.textContent).toBe('\u25a0')
      sendBtn.click()

      const calls = fetchMock.mock.calls.filter(
        (c: unknown[]) => c[0] === '/__the-forge/session/interrupt'
      ) as unknown as [string, { method: string; headers: Record<string, string> }][]
      expect(calls).toHaveLength(1)
      expect(calls[0][1].method).toBe('POST')
      expect(calls[0][1].headers['X-Forge-Secret']).toBe('shhh')
    } finally {
      delete (globalThis as { __THE_FORGE__?: unknown }).__THE_FORGE__
    }
  })

  it('approval decide POSTs /approval/decide {id, allow} when Allow is clicked', async () => {
    const approvalLine = JSON.stringify({
      type: 'approval', id: 'tool-42', toolName: 'Bash', detail: 'rm -rf tmp',
    })
    const fetchMock = makeEventsFetch([approvalLine])
    vi.stubGlobal('fetch', fetchMock)
    ;(globalThis as { __THE_FORGE__?: { secret?: string } }).__THE_FORGE__ = { secret: 'shhh' }
    try {
      const overlay = new Overlay()
      overlay.mount()
      const mode = new DesignMode(overlay)
      liveModes.push(mode)
      overlay.attach(mode.panelRoot)
      mode.setActive(true)

      await flushMicrotasks()

      const allowBtn = mode.panelRoot.querySelector('.session-approval-allow') as HTMLButtonElement
      expect(allowBtn).not.toBeNull()
      allowBtn.click()

      const calls = fetchMock.mock.calls.filter(
        (c: unknown[]) => c[0] === '/__the-forge/approval/decide'
      ) as unknown as [string, { method: string; headers: Record<string, string>; body: string }][]
      expect(calls).toHaveLength(1)
      const body = JSON.parse(calls[0][1].body) as unknown
      expect(body).toEqual({ id: 'tool-42', allow: true })
      expect(calls[0][1].headers['X-Forge-Secret']).toBe('shhh')
    } finally {
      delete (globalThis as { __THE_FORGE__?: unknown }).__THE_FORGE__
    }
  })

  // There is no button left to flash per-rung copy onto (composer consolidation Task 3 —
  // sentLabelFor was later deleted outright, and postDispatch ignores the rung), so this
  // proves the underlying mechanics instead: the queued send still registers when /dispatch
  // answers rung 'embedded'.
  it('registers the queued send when /dispatch answers rung "embedded"', async () => {
    const fetchMock = vi.fn((url: string) => {
      if (url === '/__the-forge/queue') return Promise.resolve({ ok: true, json: async () => ({ id: 'q1' }) })
      if (url === '/__the-forge/dispatch') return Promise.resolve({ ok: true, json: async () => ({ rung: 'embedded' }) })
      if (url.startsWith('/__the-forge/session/events')) return new Promise<never>(() => {})
      return Promise.resolve({ ok: true, json: async () => ({ watcher: 'none', session: 'idle' }) })
    })
    vi.stubGlobal('fetch', fetchMock)
    const { mode, drafts, panel } = fullSetup()
    mode.setActive(true)
    const btn = document.querySelector('button')! as HTMLElement
    drafts.apply(btn, 'padding-top', '24px')
    ;(panel.root.querySelector('.chat-send') as HTMLButtonElement).click()
    for (let i = 0; i < 6; i++) await Promise.resolve()
    expect(mode.session.pendingIds()).toEqual(['q1'])
  })
})

describe('canvas verbs (Figma pivot P1): inline text edit + Del delete', () => {
  function textSetup() {
    const setup = fullSetup()
    setup.mode.setActive(true)
    const btn = document.querySelector('button')! as HTMLElement
    return { ...setup, btn }
  }

  it('double-click on a text element enters contenteditable; Escape commits a text draft without deselecting', () => {
    const { mode, drafts, btn } = textSetup()
    btn.dispatchEvent(new MouseEvent('dblclick', { bubbles: true }))
    expect(btn.hasAttribute('contenteditable')).toBe(true)
    expect(mode.selected).toBe(btn)
    btn.textContent = 'changed'
    btn.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
    expect(btn.hasAttribute('contenteditable')).toBe(false)
    expect(drafts.structuralOf(btn)).toEqual({ kind: 'text', original: 'go', value: 'changed' })
    expect(mode.selected).toBe(btn) // Esc committed the edit — it must NOT also deselect
    expect(mode.active).toBe(true)
  })

  it('an idle in-and-out (no change) leaves no draft', () => {
    const { drafts, btn } = textSetup()
    btn.dispatchEvent(new MouseEvent('dblclick', { bubbles: true }))
    btn.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }))
    expect(btn.hasAttribute('contenteditable')).toBe(false)
    expect(drafts.structuralOf(btn)).toBeNull()
  })

  it('double-click on an element without direct text does nothing', () => {
    const setup = fullSetup()
    setup.mode.setActive(true)
    document.body.insertAdjacentHTML('beforeend', `<div id="wrap" data-dc-source="src/App.tsx:1:1"><span>inner</span></div>`)
    const wrap = document.getElementById('wrap')!
    wrap.dispatchEvent(new MouseEvent('dblclick', { bubbles: true }))
    expect(wrap.hasAttribute('contenteditable')).toBe(false)
  })

  it('deactivating design mode mid-edit commits the draft', () => {
    const { mode, drafts, btn } = textSetup()
    btn.dispatchEvent(new MouseEvent('dblclick', { bubbles: true }))
    btn.textContent = 'edited then toggled off'
    mode.setActive(false)
    expect(btn.hasAttribute('contenteditable')).toBe(false)
    expect(drafts.structuralOf(btn)).toEqual({ kind: 'text', original: 'go', value: 'edited then toggled off' })
  })

  it('Del drafts a delete for the selection, previews display:none, and deselects', () => {
    const { mode, drafts, btn } = textSetup()
    btn.click()
    expect(mode.selected).toBe(btn)
    document.body.dispatchEvent(new KeyboardEvent('keydown', { key: 'Delete', bubbles: true }))
    expect(drafts.structuralOf(btn)).toEqual({ kind: 'delete', priorInlineDisplay: '' })
    expect(btn.style.getPropertyValue('display')).toBe('none')
    expect(mode.selected).toBeNull()
    expect(mode.active).toBe(true) // Del must not fall through to the Escape branch
  })

  it('Backspace in an input never deletes the canvas selection', () => {
    const { mode, drafts, btn } = textSetup()
    btn.click()
    document.body.insertAdjacentHTML('beforeend', `<input id="field" />`)
    const input = document.getElementById('field')!
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Backspace', bubbles: true }))
    expect(drafts.structuralOf(btn)).toBeNull()
    expect(mode.selected).toBe(btn)
  })

  it('Del with nothing selected is inert', () => {
    const { mode, drafts, btn } = textSetup()
    document.body.dispatchEvent(new KeyboardEvent('keydown', { key: 'Delete', bubbles: true }))
    expect(drafts.structuralOf(btn)).toBeNull()
    expect(mode.active).toBe(true)
  })

  it('a click outside the editing element commits and re-selects normally', () => {
    const setup = fullSetup()
    setup.mode.setActive(true)
    const btn = document.querySelector('button')! as HTMLElement
    document.body.insertAdjacentHTML('beforeend', `<p id="other" data-dc-source="src/App.tsx:9:2">para</p>`)
    const other = document.getElementById('other')!
    btn.dispatchEvent(new MouseEvent('dblclick', { bubbles: true }))
    btn.textContent = 'renamed'
    other.click()
    expect(btn.hasAttribute('contenteditable')).toBe(false)
    expect(setup.drafts.structuralOf(btn)).toEqual({ kind: 'text', original: 'go', value: 'renamed' })
    expect(setup.mode.selected).toBe(other)
  })
})
