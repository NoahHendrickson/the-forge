import type { Meta, StoryObj } from '@storybook/html-vite'
import { NumberField } from '../src/client/controls'
import { mountInShadow } from './mount'

const meta: Meta = {
  title: 'NumberField',
}
export default meta

type Story = StoryObj

export const Plain: Story = {
  render: () => {
    const field = new NumberField({ label: 'W', onInput: () => {} })
    field.set(240)
    return mountInShadow(field.root, 'panel')
  },
}

export const AllowAuto: Story = {
  render: () => {
    const field = new NumberField({ label: 'H', allowAuto: true, onInput: () => {} })
    field.setAuto()
    return mountInShadow(field.root, 'panel')
  },
}

export const PillBound: Story = {
  render: () => {
    const field = new NumberField({ label: 'Gap', onInput: () => {} })
    field.bindToken('space-4')
    return mountInShadow(field.root, 'panel')
  },
}
