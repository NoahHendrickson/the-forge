import type { Meta, StoryObj } from '@storybook/html-vite'
import { createButton } from '../src/client/ui/button'
import { mountInShadow } from './mount'

const meta: Meta = {
  title: 'Button',
}
export default meta

type Story = StoryObj

// #status strip buttons — Send / Copy for agent (overlay.ts).
export const SendToAgent: Story = {
  render: () => mountInShadow(createButton({ label: 'Send to agent' }), 'status'),
}

export const CopyForAgent: Story = {
  render: () => mountInShadow(createButton({ label: 'Copy for agent' }), 'status'),
}

// #panel action buttons — Compare / Reset (panel.ts).
export const Compare: Story = {
  render: () => mountInShadow(createButton({ label: 'Compare' }), 'panel'),
}

export const Reset: Story = {
  render: () => mountInShadow(createButton({ label: 'Reset' }), 'panel'),
}

// Dashed "+ Add auto layout" variant — [data-add-layout] in overlay.ts.
export const AddAutoLayout: Story = {
  render: () => {
    const btn = createButton({ label: '+ Add auto layout' })
    btn.setAttribute('data-add-layout', '')
    return mountInShadow(btn, 'panel')
  },
}

// Section expand/collapse control — [data-expand] in overlay.ts.
export const Expand: Story = {
  render: () => {
    const btn = createButton({ label: '⋯' })
    btn.setAttribute('data-expand', 'example-section')
    return mountInShadow(btn, 'panel')
  },
}
