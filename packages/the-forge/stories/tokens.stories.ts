import type { Meta, StoryObj } from '@storybook/html-vite'
import { CSS } from '../src/client/overlay'
import { mountInShadow } from './mount'

interface Token {
  name: string
  value: string
}

/**
 * Parses every `--name: value;` custom-property declaration out of the product's own `CSS`
 * const (the `:host { ... }` token block in src/client/overlay.ts) — single source, so this
 * story can never show a stale palette/type-scale relative to the shipped overlay.
 *
 * The token block is preceded by a `/* ... *\/` doc comment that itself lists token names
 * (e.g. "--surface / --surface-2: panel and elevated-popover backgrounds.") for humans reading
 * the source — strip block comments first so those mentions can't be mistaken for real
 * declarations (a stray `--surface-2:` inside the comment would otherwise match and its
 * greedy value capture would swallow the real declaration that follows, up to the next `;`).
 *
 * Parsing is anchored to the `:host` rule that declares custom properties — element-scoped
 * custom properties elsewhere in the sheet (the `--cp-hue` pattern) are not design tokens
 * and must never appear in this catalog.
 */
function parseTokens(): Token[] {
  const withoutComments = CSS.replace(/\/\*[\s\S]*?\*\//g, '')
  const hostBlocks = withoutComments.match(/:host\s*{[^}]*}/g) ?? []
  const tokenBlock = hostBlocks.find((block) => block.includes('--')) ?? ''
  const tokens: Token[] = []
  const re = /--([a-z0-9-]+):\s*([^;]+);/gi
  let match: RegExpExecArray | null
  while ((match = re.exec(tokenBlock))) {
    tokens.push({ name: match[1], value: match[2].trim() })
  }
  return tokens
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
