import type { Meta, StoryObj } from '@storybook/html-vite'
import { PromptBox } from '../src/client/prompt'
import type { TaggedElement } from '../src/client/source'
import { mountInShadow } from './mount'

const meta: Meta = {
  title: 'PromptBox',
}
export default meta

type Story = StoryObj

/** A positioned fixture element for PromptBox.open() to anchor against — position: fixed
 * coordinates are viewport-relative, so this lives directly in the document, not the shadow
 * root the box itself mounts into (mirrors how the real overlay anchors against page elements
 * outside its own shadow DOM). */
function anchorFixture(): TaggedElement {
  const el = document.createElement('div')
  el.textContent = 'Anchored element'
  el.style.cssText =
    'position: fixed; top: 160px; left: 80px; width: 160px; height: 40px; ' +
    'display: flex; align-items: center; justify-content: center; ' +
    'border: 1px dashed #999; color: #999; font: 12px system-ui;'
  document.body.appendChild(el)
  return el as unknown as TaggedElement
}

export const Default: Story = {
  render: () => {
    const box = new PromptBox()
    const host = mountInShadow(box.root, 'bare')
    box.open(anchorFixture())
    return host
  },
}

export const Filled: Story = {
  render: () => {
    const box = new PromptBox()
    const host = mountInShadow(box.root, 'bare')
    box.open(anchorFixture())
    box.textarea.value = 'Make this button larger and change the color to blue'
    box.textarea.dispatchEvent(new Event('input'))
    return host
  },
}

export const Busy: Story = {
  render: () => {
    const box = new PromptBox()
    const host = mountInShadow(box.root, 'bare')
    box.open(anchorFixture())
    box.textarea.value = 'Make this button larger and change the color to blue'
    box.textarea.dispatchEvent(new Event('input'))
    box.setBusy(true)
    return host
  },
}
