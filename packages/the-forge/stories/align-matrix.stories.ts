import type { Meta, StoryObj } from '@storybook/html-vite'
import { AlignMatrix } from '../src/client/layout-controls'
import { mountInShadow } from './mount'

const meta: Meta = {
  title: 'AlignMatrix',
}
export default meta

type Story = StoryObj

export const Unset: Story = {
  render: () => {
    const matrix = new AlignMatrix({ onInput: () => {} })
    matrix.set(null, null, 'row', false)
    return mountInShadow(matrix.root, 'panel')
  },
}

export const Populated: Story = {
  render: () => {
    const matrix = new AlignMatrix({ onInput: () => {} })
    matrix.set('center', 'flex-start', 'row', false)
    return mountInShadow(matrix.root, 'panel')
  },
}
