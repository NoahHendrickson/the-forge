// @vitest-environment jsdom
import { describe, it, expect, vi } from 'vitest'
import { PromptBox } from '../../src/client/prompt'
import type { TaggedElement } from '../../src/client/source'

function anchored(): TaggedElement {
  const el = document.createElement('div') as unknown as TaggedElement
  document.body.appendChild(el)
  return el
}

describe('PromptBox', () => {
  it('starts hidden with send disabled; open() shows and focuses', () => {
    const box = new PromptBox()
    document.body.appendChild(box.root)
    expect(box.root.hidden).toBe(true)
    box.open(anchored())
    expect(box.root.hidden).toBe(false)
    expect(box.isOpen()).toBe(true)
    expect(box.sendButton.disabled).toBe(true) // empty textarea
  })

  it('enables send only for non-whitespace text', () => {
    const box = new PromptBox(); document.body.appendChild(box.root); box.open(anchored())
    box.textarea.value = '   '
    box.textarea.dispatchEvent(new Event('input'))
    expect(box.sendButton.disabled).toBe(true)
    box.textarea.value = 'hello'
    box.textarea.dispatchEvent(new Event('input'))
    expect(box.sendButton.disabled).toBe(false)
  })

  it('fires onSend with trimmed text on click and on Cmd/Ctrl+Enter', () => {
    const box = new PromptBox(); document.body.appendChild(box.root); box.open(anchored())
    const sent: string[] = []
    box.onSend = (t) => sent.push(t)
    box.textarea.value = '  hi  '
    box.textarea.dispatchEvent(new Event('input'))
    box.sendButton.click()
    box.textarea.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', metaKey: true }))
    expect(sent).toEqual(['hi', 'hi'])
  })

  it('close() and Escape hide, discard text, and clear busy', () => {
    const box = new PromptBox(); document.body.appendChild(box.root); box.open(anchored())
    box.textarea.value = 'draft text'
    box.setBusy(true)
    box.textarea.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }))
    expect(box.isOpen()).toBe(false)
    box.open(anchored())
    expect(box.textarea.value).toBe('') // discarded, not restored
    expect(box.sendButton.disabled).toBe(true) // busy cleared, empty again
  })

  it('setBusy(true) blocks onSend and disables the controls', () => {
    const box = new PromptBox(); document.body.appendChild(box.root); box.open(anchored())
    let fired = 0
    box.onSend = () => fired++
    box.textarea.value = 'hi'
    box.textarea.dispatchEvent(new Event('input'))
    box.setBusy(true)
    box.sendButton.click()
    box.textarea.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', ctrlKey: true }))
    expect(fired).toBe(0)
    expect(box.sendButton.disabled).toBe(true)
  })

  it('removes its reposition listeners on close (zero idle overhead)', () => {
    const box = new PromptBox(); document.body.appendChild(box.root)
    const addSpy = vi.spyOn(window, 'addEventListener')
    const removeSpy = vi.spyOn(window, 'removeEventListener')
    box.open(anchored())
    const added = addSpy.mock.calls.filter(([t]) => t === 'resize' || t === 'scroll').length
    box.close()
    const removed = removeSpy.mock.calls.filter(([t]) => t === 'resize' || t === 'scroll').length
    expect(added).toBeGreaterThan(0)
    expect(removed).toBe(added)
  })
})
