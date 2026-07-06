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
