import type { Meta, StoryObj } from '@storybook/html-vite'
import { createMenuButton } from '../src/client/ui/menu'
import { mountInShadow } from './mount'

const meta: Meta = {
  title: 'Menu',
}
export default meta

type Story = StoryObj

// Sample items mirror the real sizing menu: modes with a checkmark, separated actions.
const items = () => [
  { value: 'fixed', label: 'Fixed', checked: true },
  { value: 'hug', label: 'Hug' },
  { value: 'fill', label: 'Fill' },
  { value: 'add-min', label: 'Min…', separator: true },
  { value: 'add-max', label: 'Max…' },
  { value: 'variable', label: 'Variable…', separator: true },
]

// The chevron mounts on a W/H field row; its popover appends to .panel-body (position:
// relative) — same containing block panel.ts hands ColorPicker/TokenPicker. Pre-opened
// here (real click, not a copy) so the story shows the popover markup, not just the chevron.
export const Sizing: Story = {
  render: () => {
    const host = document.createElement('div')
    host.className = 'panel-body'
    const mb = createMenuButton({ title: 'Sizing', items, onSelect: () => {}, popoverHost: host })
    host.append(mb.button)
    const el = mountInShadow(host, 'panel')
    mb.button.click()
    return el
  },
}

// Zoom pill: custom label, opens above the trigger for bottom-anchored chrome.
const zoomItems = () => [
  { value: 'fit', label: 'Zoom to fit' },
  { value: '50', label: '50%' },
  { value: '100', label: '100%', checked: true },
  { value: '200', label: '200%' },
]

export const ZoomPill: Story = {
  render: () => {
    const host = document.createElement('div')
    host.className = 'panel-body'
    const mb = createMenuButton({
      label: '100%',
      opensUp: true,
      items: zoomItems,
      onSelect: () => {},
      popoverHost: host,
    })
    host.append(mb.button)
    const el = mountInShadow(host, 'panel')
    mb.button.click()
    return el
  },
}
