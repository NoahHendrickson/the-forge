/**
 * The single place `.color-row` markup is born — used by the panel's Fill/Stroke rows,
 * the multi-select Selection colors rows, and the Storybook swatch story. Markup only:
 * click wiring, refresh closures, and extras (`.sc-count`) stay at the call site, which
 * is why the internal parts are returned rather than just the row.
 */
export interface ColorRowOpts {
  /** When set, a leading `.nf-label` span with this text. */
  label?: string
  /** Additive class(es) — appended after the base 'color-row' class. */
  className?: string
}

export interface ColorRowParts {
  row: HTMLDivElement
  swatch: HTMLButtonElement
  swatchColor: HTMLSpanElement
  valueEl: HTMLSpanElement
}

export function createColorRow(opts: ColorRowOpts = {}): ColorRowParts {
  const row = document.createElement('div')
  row.className = opts.className ? `color-row ${opts.className}` : 'color-row'

  if (opts.label !== undefined) {
    const labelEl = document.createElement('span')
    labelEl.className = 'nf-label'
    labelEl.textContent = opts.label
    row.append(labelEl)
  }

  const swatch = document.createElement('button')
  swatch.type = 'button'
  swatch.className = 'swatch'
  row.append(swatch)

  // Color lives on a child element stacked on top of the parent's checkerboard —
  // see the `.swatch`/`.swatch-color` comment in overlay.ts for why (background-color
  // on the parent itself would paint beneath the checkerboard background-image layers).
  const swatchColor = document.createElement('span')
  swatchColor.className = 'swatch-color'
  swatch.append(swatchColor)

  const valueEl = document.createElement('span')
  valueEl.className = 'color-value'
  row.append(valueEl)

  return { row, swatch, swatchColor, valueEl }
}
