export interface SegmentFieldOpts {
  label: string
  options: Array<{ value: string; label: string }>
  onInput: (value: string) => void
}

/** A row of small toggle buttons — dumb view: state in via set(), events out via onInput. */
export class SegmentField {
  root = document.createElement('div')

  private buttons: HTMLElement[] = []

  constructor(private opts: SegmentFieldOpts) {
    this.root.className = 'seg-field'

    const labelEl = document.createElement('span')
    labelEl.className = 'seg-field-label'
    labelEl.textContent = opts.label
    this.root.append(labelEl)

    for (const option of opts.options) {
      const button = document.createElement('button')
      button.type = 'button'
      button.className = 'seg'
      button.textContent = option.label
      button.dataset.value = option.value
      button.addEventListener('click', () => {
        this.setActiveValue(option.value)
        this.opts.onInput(option.value)
      })
      this.root.append(button)
      this.buttons.push(button)
    }
  }

  private setActiveValue(value: string | null): void {
    for (const button of this.buttons) {
      button.classList.toggle('seg-active', button.dataset.value === value)
    }
  }

  /** `set(null)` clears selection (mixed/unknown). */
  set(value: string | null): void {
    this.setActiveValue(value)
  }
}

export interface AlignMatrixOpts {
  onInput: (v: { justify: string; align: string }) => void
}

const KEYWORDS = ['flex-start', 'center', 'flex-end'] as const
type Keyword = (typeof KEYWORDS)[number]

/**
 * 3x3 grid of dot buttons fusing justify-content x align-items into one spatial widget.
 *
 * Grid position -> (justify, align) mapping FOLLOWS flex-direction:
 * - 'row': columns = justify, rows = align.
 * - 'column': transposed — rows = justify, columns = align.
 *
 * When spaceBetween is true the main axis is meaningless (space-between collapses
 * it), so only 3 dots render along the cross axis; clicks always emit
 * justify: 'space-between' paired with the clicked align keyword.
 */
export class AlignMatrix {
  root = document.createElement('div')

  constructor(private opts: AlignMatrixOpts) {
    this.root.className = 'align-matrix'
  }

  set(justify: string | null, align: string | null, direction: 'row' | 'column', spaceBetween: boolean): void {
    this.root.innerHTML = ''
    this.root.className = 'align-matrix'

    if (spaceBetween) {
      this.renderSpaceBetween(align, direction)
      return
    }

    this.renderFull(justify, align, direction)
  }

  private renderFull(justify: string | null, align: string | null, direction: 'row' | 'column'): void {
    // Physical grid: row index 0..2 (top->bottom), col index 0..2 (left->right).
    for (let row = 0; row < 3; row++) {
      for (let col = 0; col < 3; col++) {
        const { j, a } = this.mapPosition(row, col, direction)
        const dot = this.makeDot(j, a)
        if (j === justify && a === align) dot.classList.add('am-active')
        dot.addEventListener('click', () => {
          this.opts.onInput({ justify: j, align: a })
        })
        this.root.append(dot)
      }
    }
  }

  private renderSpaceBetween(align: string | null, direction: 'row' | 'column'): void {
    // Cross-axis-only: 3 dots. In 'row', cross axis is align (vertical);
    // in 'column', cross axis is align too (conceptually horizontal), but
    // since spaceBetween only needs the align keyword, we render the same
    // 3 keywords regardless of direction — direction only affects layout,
    // never the emitted semantics here.
    for (const a of KEYWORDS) {
      const dot = this.makeDot('space-between', a)
      if (a === align) dot.classList.add('am-active')
      dot.addEventListener('click', () => {
        this.opts.onInput({ justify: 'space-between', align: a })
      })
      this.root.append(dot)
    }
    // direction is accepted for API symmetry / future layout-only styling hooks.
    void direction
  }

  private mapPosition(row: number, col: number, direction: 'row' | 'column'): { j: Keyword; a: Keyword } {
    if (direction === 'row') {
      // columns = justify, rows = align
      return { j: KEYWORDS[col], a: KEYWORDS[row] }
    }
    // column: transposed — rows = justify, columns = align
    return { j: KEYWORDS[row], a: KEYWORDS[col] }
  }

  private makeDot(j: string, a: string): HTMLElement {
    const dot = document.createElement('button')
    dot.type = 'button'
    dot.className = 'am-dot'
    dot.dataset.j = j
    dot.dataset.a = a
    return dot
  }
}
