export interface NumberFieldOpts {
  label: string
  min?: number
  max?: number
  /** When true, the field accepts the literal keyword `auto` (case-insensitive, trimmed). */
  allowAuto?: boolean
  onInput: (value: number) => void
  /** Fired when the user types a recognized keyword (currently only 'auto') into an allowAuto field. */
  onKeyword?: (kw: 'auto') => void
}

/**
 * Tiny recursive-descent evaluator for `+ - * / ( )` over decimal numbers. No eval/Function.
 *
 * - Leading-operator expressions (`+8`, `*2`) apply to `current` (current === null → null).
 * - Standalone expressions (`60+12`) ignore `current` entirely.
 * - A plain number string (`42`) parses to its numeric value — this isn't really this
 *   function's job (NumberField handles plain numbers on its own fast path), but returning
 *   the parsed value here is harmless and simplifies field wiring/tests.
 * - Any parse error, trailing garbage, or division by zero returns null.
 */
export function evaluateExpression(expr: string, current: number | null): number | null {
  const trimmed = expr.trim()
  if (trimmed === '') return null

  const leadingOp = /^[-+*/]/.exec(trimmed)

  if (leadingOp) {
    // Leading-operator expression (`+8`, `*2`, `-3`, `/4`) applies to `current`.
    if (current === null) return null
    const op = leadingOp[0]
    const operand = parseFullExpression(trimmed.slice(1))
    if (operand === null) return null
    switch (op) {
      case '+':
        return current + operand
      case '-':
        return current - operand
      case '*':
        return current * operand
      case '/':
        return operand === 0 ? null : current / operand
    }
  }

  // Standalone expression — ignores `current` entirely.
  return parseFullExpression(trimmed)
}

function parseFullExpression(input: string): number | null {
  const parser = new ExprParser(input)
  const value = parser.parseAddSub()
  if (value === null) return null
  if (!parser.atEnd()) return null
  return value
}

class ExprParser {
  private pos = 0
  constructor(private src: string) {}

  private peek(): string {
    this.skipSpace()
    return this.src[this.pos] ?? ''
  }

  private skipSpace(): void {
    while (this.pos < this.src.length && /\s/.test(this.src[this.pos])) this.pos++
  }

  atEnd(): boolean {
    this.skipSpace()
    return this.pos >= this.src.length
  }

  parseAddSub(): number | null {
    let left = this.parseMulDiv()
    if (left === null) return null
    for (;;) {
      const op = this.peek()
      if (op !== '+' && op !== '-') break
      this.pos++
      const right = this.parseMulDiv()
      if (right === null) return null
      left = op === '+' ? left + right : left - right
    }
    return left
  }

  parseMulDiv(): number | null {
    let left = this.parseUnary()
    if (left === null) return null
    for (;;) {
      const op = this.peek()
      if (op !== '*' && op !== '/') break
      this.pos++
      const right = this.parseUnary()
      if (right === null) return null
      if (op === '*') {
        left = left * right
      } else {
        if (right === 0) return null
        left = left / right
      }
    }
    return left
  }

  parseUnary(): number | null {
    const op = this.peek()
    if (op === '+' || op === '-') {
      this.pos++
      const value = this.parseUnary()
      if (value === null) return null
      return op === '-' ? -value : value
    }
    return this.parsePrimary()
  }

  parsePrimary(): number | null {
    this.skipSpace()
    if (this.src[this.pos] === '(') {
      this.pos++
      const value = this.parseAddSub()
      if (value === null) return null
      this.skipSpace()
      if (this.src[this.pos] !== ')') return null
      this.pos++
      return value
    }
    const match = /^\d+(\.\d+)?/.exec(this.src.slice(this.pos))
    if (!match) return null
    this.pos += match[0].length
    return Number.parseFloat(match[0])
  }
}

const MIXED_TEXT = 'Mixed'
const AUTO_TEXT = 'auto'

export class NumberField {
  root = document.createElement('div')

  private input = document.createElement('input')
  private labelEl = document.createElement('span')
  private lastValid: number | null = null
  private scrubStartX = 0
  // Scrub anchor is FIXED at mousedown (absolute drag mapping). External set()
  // during a drag only updates the display — safe because the panel round-trips
  // the exact committed value on refresh.
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
      this.handleChange()
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

  private handleChange(): void {
    const raw = this.input.value

    // Keyword handling (auto) takes priority when allowed.
    if (this.opts.allowAuto && raw.trim().toLowerCase() === AUTO_TEXT) {
      this.setAuto()
      this.opts.onKeyword?.('auto')
      return
    }

    // Plain number path — unchanged from v1.
    const n = Number.parseFloat(raw)
    if (Number.isFinite(n) && /^-?\d+(\.\d+)?$/.test(raw.trim())) {
      this.commit(n)
      return
    }

    // Expression path — only when the input contains expression characters.
    if (/[-+*/()]/.test(raw)) {
      const result = evaluateExpression(raw, this.lastValid)
      if (result === null) {
        this.render(this.lastValid)
      } else {
        this.commit(result)
      }
      return
    }

    // Garbage — revert.
    this.render(this.lastValid)
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

  /** Displays the literal 'Mixed' text; internal value is null (get() reports null). */
  setMixed(): void {
    this.lastValid = null
    this.input.value = MIXED_TEXT
  }

  /** Displays the literal 'auto' text; internal value is null (get() reports null). Only meaningful with allowAuto. */
  setAuto(): void {
    this.lastValid = null
    this.input.value = AUTO_TEXT
  }

  get(): number | null {
    return this.lastValid
  }
}
