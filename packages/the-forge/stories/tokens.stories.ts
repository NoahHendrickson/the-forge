import type { Meta, StoryObj } from '@storybook/html-vite'
import { TOKENS } from '../src/client/overlay'
import { mountInShadow } from './mount'

interface Token {
  name: string
  value: string
}

// TOKENS is the canonical registry (overlay.ts generates its :host block from it),
// so this catalog is in sync with the shipped stylesheet by construction.
function parseTokens(): Token[] {
  return Object.entries(TOKENS).map(([name, value]) => ({ name, value }))
}

function isColor(value: string): boolean {
  return /^#|^rgba?\(/.test(value)
}

function buildPalette(): HTMLElement {
  const grid = document.createElement('div')
  grid.style.display = 'grid'
  grid.style.gridTemplateColumns = 'repeat(auto-fill, minmax(140px, 1fr))'
  grid.style.gap = '12px'

  for (const token of parseTokens()) {
    if (!isColor(token.value)) continue
    const cell = document.createElement('div')
    cell.style.display = 'flex'
    cell.style.flexDirection = 'column'
    cell.style.gap = '6px'

    const swatch = document.createElement('div')
    swatch.style.height = '48px'
    swatch.style.borderRadius = '8px'
    swatch.style.border = '1px solid var(--border-strong)'
    swatch.style.background = token.value

    const label = document.createElement('span')
    label.style.font = '400 var(--text-sm) var(--font-ui)'
    label.style.color = 'var(--text-primary)'
    label.textContent = `--${token.name}`

    const value = document.createElement('span')
    value.style.font = '400 var(--text-xs) var(--font-mono)'
    value.style.color = 'var(--text-muted)'
    value.textContent = token.value

    cell.append(swatch, label, value)
    grid.append(cell)
  }
  return grid
}

function buildTypeSpecimen(): HTMLElement {
  const wrap = document.createElement('div')
  wrap.style.display = 'flex'
  wrap.style.flexDirection = 'column'
  wrap.style.gap = '10px'

  for (const token of parseTokens()) {
    if (!token.name.startsWith('text-') || isColor(token.value)) continue
    // Type-scale tokens only (--text-xs/sm/md) — the --text-* color tokens (primary/
    // secondary/title/faint/muted) are colors and are filtered out by isColor() above.
    const row = document.createElement('div')
    row.style.display = 'flex'
    row.style.alignItems = 'baseline'
    row.style.gap = '12px'

    const sample = document.createElement('span')
    sample.style.font = `400 ${token.value} var(--font-ui)`
    sample.style.color = 'var(--text-primary)'
    sample.textContent = 'The quick brown fox'

    const label = document.createElement('span')
    label.style.font = '400 var(--text-xs) var(--font-mono)'
    label.style.color = 'var(--text-muted)'
    label.textContent = `--${token.name} (${token.value})`

    row.append(sample, label)
    wrap.append(row)
  }
  return wrap
}

const meta: Meta = {
  title: 'Tokens',
}
export default meta

type Story = StoryObj

export const Palette: Story = {
  render: () => mountInShadow(buildPalette(), 'bare'),
}

export const TypeSpecimen: Story = {
  render: () => mountInShadow(buildTypeSpecimen(), 'bare'),
}
