import type { Meta, StoryObj } from '@storybook/html-vite'
import { createSelect } from '../src/client/ui/select'
import { WEIGHTS, STROKE_STYLES, SIZE_MODES } from '../src/client/panel-specs'
import { mountInShadow } from './mount'

const meta: Meta = {
  title: 'Select',
}
export default meta

type Story = StoryObj

// Font family — panel.ts seeds this from the current element's computed family plus
// document.fonts; the static fallback list ('system-ui', 'serif', 'monospace') stands in here.
export const Family: Story = {
  render: () =>
    mountInShadow(
      createSelect({
        className: 'type-family',
        options: ['system-ui', 'serif', 'monospace'].map((f) => ({ value: f, label: f })),
        value: 'system-ui',
        onChange: () => {},
      }),
      'panel'
    ),
}

// Font weight — the real WEIGHTS table from panel-specs.ts.
export const Weight: Story = {
  render: () =>
    mountInShadow(
      createSelect({
        className: 'type-weight',
        options: WEIGHTS.map(([value, label]) => ({ value, label })),
        value: '400',
        onChange: () => {},
      }),
      'panel'
    ),
}

// Stroke style — the real STROKE_STYLES table from panel-specs.ts.
export const StrokeStyle: Story = {
  render: () =>
    mountInShadow(
      createSelect({
        className: 'stroke-style',
        options: STROKE_STYLES.map(([value, label]) => ({ value, label })),
        value: 'solid',
        onChange: () => {},
      }),
      'panel'
    ),
}

// Size mode — the real SIZE_MODES table from panel-specs.ts (per-row sibling select in buildRow).
export const SizeMode: Story = {
  render: () =>
    mountInShadow(
      createSelect({
        options: SIZE_MODES.map(([value, label]) => ({ value, label })),
        value: 'fixed',
        onChange: () => {},
      }),
      'panel'
    ),
}
