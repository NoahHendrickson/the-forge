import type { Meta, StoryObj } from '@storybook/html-vite'
import { ColorPicker } from '../src/client/colorpicker'
import { createColorRow } from '../src/client/ui/swatch'
import { mountInShadow } from './mount'

const meta: Meta = {
  title: 'Swatch',
}
export default meta

type Story = StoryObj

/** Renders the real product `.color-row` (ui/swatch.ts) — the same builder panel.ts uses. */
function buildColorRow(label: string, css: string): HTMLElement {
  const { row, swatchColor, valueEl } = createColorRow({ label })
  swatchColor.style.color = css
  valueEl.textContent = css
  return row
}

export const ColorRow: Story = {
  render: () => mountInShadow(buildColorRow('Fill', '#0D99FF'), 'panel'),
}

export const ColorPickerPopover: Story = {
  render: () => {
    const row = buildColorRow('Fill', '#0D99FF')
    const panel = mountInShadow(row, 'panel')
    const panelRoot = (panel.shadowRoot as ShadowRoot).getElementById('panel') as HTMLElement
    const picker = new ColorPicker(panelRoot)
    picker.open({
      anchor: row,
      initial: '#0D99FF',
      contrastAgainst: '#2C2C2C',
      onPick: () => {},
    })
    return panel
  },
}
