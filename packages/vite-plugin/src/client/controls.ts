export interface NumberFieldOpts {
  label: string
  min?: number
  max?: number
  onInput: (value: number) => void
}

export class NumberField {
  root = document.createElement('div')

  private input = document.createElement('input')
  private labelEl = document.createElement('span')
  private lastValid: number | null = null
  private scrubStartX = 0
  private scrubStartValue = 0
  private scrubbing = false

  constructor(private opts: NumberFieldOpts) {
    this.root.className = 'nf'
    this.labelEl.className = 'nf-label'
    this.labelEl.textContent = opts.label
    this.input.type = 'text'
    this.input.inputMode = 'numeric'
    this.root.append(this.labelEl, this.input)

    this.input.addEventListener('change', () => {
      const n = Number.parseFloat(this.input.value)
      if (Number.isFinite(n)) this.commit(n)
      else this.render(this.lastValid)
    })

    this.input.addEventListener('keydown', (e) => {
      if (e.key !== 'ArrowUp' && e.key !== 'ArrowDown') return
      e.preventDefault()
      const step = (e.shiftKey ? 10 : 1) * (e.key === 'ArrowUp' ? 1 : -1)
      const base = Number.parseFloat(this.input.value)
      this.commit((Number.isFinite(base) ? base : 0) + step)
    })

    this.labelEl.addEventListener('mousedown', (e) => {
      e.preventDefault()
      this.scrubbing = true
      this.scrubStartX = e.clientX
      this.scrubStartValue = this.lastValid ?? 0
      window.addEventListener('mousemove', this.onScrub)
      window.addEventListener('mouseup', this.endScrub)
    })
  }

  private onScrub = (e: MouseEvent): void => {
    if (!this.scrubbing) return
    this.commit(this.scrubStartValue + (e.clientX - this.scrubStartX))
  }

  private endScrub = (): void => {
    this.scrubbing = false
    window.removeEventListener('mousemove', this.onScrub)
    window.removeEventListener('mouseup', this.endScrub)
  }

  private commit(raw: number): void {
    let n = Math.round(raw)
    if (this.opts.min !== undefined) n = Math.max(this.opts.min, n)
    if (this.opts.max !== undefined) n = Math.min(this.opts.max, n)
    this.render(n)
    this.opts.onInput(n)
  }

  private render(value: number | null): void {
    this.lastValid = value
    this.input.value = value === null ? '' : String(value)
  }

  set(value: number | null): void {
    this.render(value)
  }

  get(): number | null {
    return this.lastValid
  }
}
