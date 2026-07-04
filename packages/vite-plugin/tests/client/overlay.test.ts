// @vitest-environment jsdom
import { describe, it, expect, beforeEach } from 'vitest'
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
})
