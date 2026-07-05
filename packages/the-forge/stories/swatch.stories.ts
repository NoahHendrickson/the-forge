import type { Meta, StoryObj } from '@storybook/html-vite'
import { ColorPicker } from '../src/client/colorpicker'
import { mountInShadow } from './mount'

const meta: Meta = {
  title: 'Swatch',
}
export default meta

type Story = StoryObj

/** Builds a `.color-row` exactly as Panel.buildColorRow does (swatch button + value text). */
function buildColorRow(label: string, css: string): HTMLElement {
  const row = document.createElement('div')
  row.className = 'color-row'

  const labelEl = document.createElement('span')
  labelEl.className = 'nf-label'
  labelEl.textContent = label
  row.append(labelEl)

  const swatch = document.createElement('button')
  swatch.type = 'button'
  swatch.className = 'swatch'
  row.append(swatch)

  const swatchColor = document.createElement('span')
  swatchColor.className = 'swatch-color'
  swatchColor.style.color = css
  swatch.append(swatchColor)

  const valueEl = document.createElement('span')
  valueEl.className = 'color-value'
  valueEl.textContent = css
  row.append(valueEl)

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
