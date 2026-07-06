import type { Meta, StoryObj } from '@storybook/html-vite'
import { SegmentField } from '../src/client/layout-controls'
import { mountInShadow } from './mount'

const meta: Meta = {
  title: 'SegmentField',
}
export default meta

type Story = StoryObj

export const Unset: Story = {
  render: () => {
    const field = new SegmentField({
      label: 'Direction',
      options: [
        { value: 'row', label: 'Horizontal' },
        { value: 'column', label: 'Vertical' },
      ],
      onInput: () => {},
    })
    field.set(null)
    return mountInShadow(field.root, 'panel')
  },
}

export const ActiveSegment: Story = {
  render: () => {
    const field = new SegmentField({
      label: 'Direction',
      options: [
        { value: 'row', label: 'Horizontal' },
        { value: 'column', label: 'Vertical' },
      ],
      onInput: () => {},
    })
    field.set('row')
    return mountInShadow(field.root, 'panel')
  },
}

export const IconSegments: Story = {
  render: () => {
    const field = new SegmentField({
      label: 'Direction',
      options: [
        { value: 'row', label: '→', ariaLabel: 'Horizontal', title: 'flex-direction: row → flex-row' },
        { value: 'column', label: '↓', ariaLabel: 'Vertical', title: 'flex-direction: column → flex-col' },
      ],
      onInput: () => {},
    })
    field.set('row')
    return mountInShadow(field.root, 'panel')
  },
}

// The real composite Direction row: track + independent wrap toggle riding as a
// `trailing` addon, wrapped in a .seg-cluster by SegmentField itself (not by the
// caller) so they stay on one visual row under the [data-flex-direction] column stack.
export const DirectionRowComposite: Story = {
  render: () => {
    const wrapBtn = document.createElement('button')
    wrapBtn.type = 'button'
    wrapBtn.className = 'seg wrap-toggle'
    wrapBtn.textContent = '↩'
    wrapBtn.title = 'flex-wrap: wrap → flex-wrap'
    const field = new SegmentField({
      label: 'Direction',
      options: [
        { value: 'row', label: '→', ariaLabel: 'Horizontal', title: 'flex-direction: row → flex-row' },
        { value: 'column', label: '↓', ariaLabel: 'Vertical', title: 'flex-direction: column → flex-col' },
      ],
      trailing: [wrapBtn],
      onInput: () => {},
    })
    field.root.setAttribute('data-flex-direction', '')
    field.set('row')
    return mountInShadow(field.root, 'panel')
  },
}
