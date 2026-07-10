export interface NumberFieldOpts {
  label: string
  /** Tooltip (title attr) on the label — the CSS/Tailwind mapping hint. */
  hint?: string
  min?: number
  max?: number
  /** When true, the field accepts the literal keyword `auto` (case-insensitive, trimmed). */
  allowAuto?: boolean
  onInput: (value: number) => void
  /** Fired when the user types a recognized keyword (currently only 'auto') into an allowAuto field. */
  onKeyword?: (kw: 'auto') => void
  /**
   * When set, a leading-operator entry (typed `+8`, scrub-dragged, etc.) is treated as a
   * RELATIVE delta rather than an absolute commit: instead of calling onInput, the field
   * calls `onRelative(apply)` with a closure the caller applies against ITS OWN baseline(s)
   * (e.g. a multi-select snapshot taken at scrub start) — see NumberField class docs for the
   * full contract.
   */
  onRelative?: (apply: (current: number) => number) => void
  /** Fires on label mousedown, before any scrub move — callers snapshot per-element baselines here. */
  onScrubStart?: () => void
  /** Fires when Backspace/Delete is pressed while the field is pill-bound (see bindToken()). */
  onDetach?: () => void
  /** The single "open the token picker" callback, reachable two ways: the hover-revealed
   * `{ }` button (rendered only when this opt is set — no entries means callers leave it
   * unset, so there's never a dead button) fires it unconditionally, including while
   * pill-bound (swap tokens); the `=` key fires it only when NOT pill-bound. That gating
   * difference is NumberField's own policy, not the caller's — callers wire ONE callback. */
  onTokenOpen?: () => void
  /** Suppress the hover `{ }` button while keeping `onTokenOpen` reachable via `=` and `openToken()`. */
  noTokenButton?: boolean
  /** Number of per-side props behind this field (2 or 4 — 2026-07-07 panel-input-polish
   * spec). Enables comma-list entry (lists expand CSS-shorthand-style to this count via
   * expandShorthand) and the setValues display state. Single-prop callers leave it unset —
   * a comma there stays garbage → revert. */
  valuesCount?: number
  /** Fired with the FULLY EXPANDED, clamped per-prop list (one entry per prop, in the
   * row's props order) after a comma entry, per-side arrow step, or per-side scrub —
   * the caller never re-derives shorthand. */
  onValuesInput?: (values: number[]) => void
}

// Two stroked brace paths in a 12x12 box; `stroke="currentColor"` so panel CSS themes it via
// `color`, no fill so it stays a thin outline glyph at the icon's small render size.
const TOKEN_ICON_SVG =
  '<svg viewBox="0 0 12 12" aria-hidden="true">' +
  '<path d="M4.6 1.5C3.2 1.5 3.7 3.1 3.3 4.5 3.1 5.4 2.4 5.7 1.8 6c.6.3 1.3.6 1.5 1.5.4 1.4-.1 3 1.3 3" fill="none" stroke="currentColor" stroke-linecap="round"/>' +
  '<path d="M7.4 1.5c1.4 0 .9 1.6 1.3 3 .2.9.9 1.2 1.5 1.5-.6.3-1.3.6-1.5 1.5-.4 1.4.1 3-1.3 3" fill="none" stroke="currentColor" stroke-linecap="round"/>' +
  '</svg>'

/** Builds the shared `{ }` token button (class `token-btn`, hover-revealed by panel CSS).
 * Single source for the glyph/title/click wiring — used by NumberField and the panel's
 * color rows, so the affordance can't drift between field kinds. */
export function createTokenButton(onOpen: () => void): HTMLButtonElement {
  const btn = document.createElement('button')
  btn.type = 'button'
  btn.className = 'token-btn'
  btn.innerHTML = TOKEN_ICON_SVG
  btn.title = 'Use design token'
  btn.addEventListener('click', onOpen)
  return btn
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
 *
 * CAVEAT: a bare negative number ('-8') is treated as a leading-operator
 * expression (current − 8), NOT a negative literal. Callers wanting
 * negative literals must intercept plain numbers first (NumberField's
 * change handler does this via its plain-number fast path).
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

/**
 * CSS-shorthand expansion for comma-entered per-side values (2026-07-07 panel-input-polish
 * spec). `count` is the row's prop count (2 or 4). Returns null when the list can't expand:
 * empty, longer than count, or a 3-value list on a 2-prop row (only 4-prop rows have CSS
 * 3-value semantics). 4-prop rules match the border-radius shorthand:
 * [a] → a,a,a,a · [a,b] → a,b,a,b · [a,b,c] → a,b,c,b.
 */
export function expandShorthand(values: number[], count: number): number[] | null {
  if (values.length === 0 || values.length > count) return null
  if (values.length === count) return [...values]
  if (values.length === 1) return new Array(count).fill(values[0])
  if (count === 4 && values.length === 2) return [values[0], values[1], values[0], values[1]]
  if (count === 4 && values.length === 3) return [values[0], values[1], values[2], values[1]]
  return null
}

/**
 * Shortest round-trippable comma form of per-side values — the display half of the same
 * grammar (whatever this renders, expandShorthand restores). Drops trailing redundancy in
 * CSS shorthand order: last==2nd, then 3rd==1st, then 2nd==1st.
 */
export function compressShorthand(values: number[]): number[] {
  const out = [...values]
  if (out.length === 4 && out[3] === out[1]) out.pop()
  if (out.length === 3 && out[2] === out[0]) out.pop()
  if (out.length === 2 && out[1] === out[0]) out.pop()
  return out
}

const MIXED_TEXT = 'Mixed'
const AUTO_TEXT = 'auto'

export class NumberField {
  root = document.createElement('div')

  private input = document.createElement('input')
  private labelEl = document.createElement('span')
  private whisperEl = document.createElement('span')
  private lastValid: number | null = null
  private scrubStartX = 0
  // Scrub anchor is FIXED at mousedown (absolute drag mapping). External set()
  // during a drag only updates the display — safe because the panel round-trips
  // the exact committed value on refresh.
  private scrubStartValue = 0
  private scrubbing = false
  private displayState: 'number' | 'mixed' | 'auto' | 'values' = 'number'
  // Per-side values behind a 'values' display — the baseline for per-side arrows/scrub.
  private lastValues: number[] | null = null
  // Snapshot of lastValues at scrub mousedown (same frozen-baseline contract as scrubStartValue).
  private scrubStartValues: number[] | null = null
  private pillBound = false
  private scrubListenersAttached = false

  constructor(private opts: NumberFieldOpts) {
    this.root.className = 'nf'
    this.labelEl.className = 'nf-label'
    this.labelEl.textContent = opts.label
    if (opts.hint) this.labelEl.title = opts.hint
    this.input.type = 'text'
    this.input.inputMode = 'numeric'
    this.root.append(this.labelEl, this.input)

    this.whisperEl.className = 'nf-whisper'
    this.whisperEl.hidden = true
    this.root.append(this.whisperEl)

    // Callers only wire onTokenOpen when the field has token entries to offer — no entries
    // means no button, never a dead one. Deliberately NOT pill-gated (unlike the `=` key):
    // clicking the icon on an already-bound field reopens the picker to swap tokens.
    if (opts.onTokenOpen && !opts.noTokenButton) {
      this.root.append(createTokenButton(() => this.opts.onTokenOpen?.()))
    }

    this.input.addEventListener('change', () => {
      this.handleChange()
    })

    this.input.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') {
        e.stopPropagation()
        e.preventDefault()
        this.input.blur()
        return
      }
      if (this.pillBound && (e.key === 'Backspace' || e.key === 'Delete')) {
        e.preventDefault()
        this.opts.onDetach?.()
        this.detach()
        return
      }
      if (e.key === '=' && !this.pillBound) {
        e.preventDefault()
        this.opts.onTokenOpen?.()
        return
      }
      if (e.key !== 'ArrowUp' && e.key !== 'ArrowDown') return
      e.preventDefault()
      const step = (e.shiftKey ? 10 : 1) * (e.key === 'ArrowUp' ? 1 : -1)
      if (this.displayState === 'values' && this.lastValues && this.opts.onValuesInput) {
        // Per-side stepping — the absolute path below would parseFloat('16,8') → 16 and
        // collapse the variance to one number for every side.
        const stepped = this.lastValues.map((v) => this.clamp(v + step))
        this.setValues(stepped)
        this.opts.onValuesInput(stepped)
        return
      }
      const base = Number.parseFloat(this.input.value)
      this.commit((Number.isFinite(base) ? base : 0) + step)
    })

    this.labelEl.addEventListener('mousedown', (e) => {
      e.preventDefault()
      this.opts.onScrubStart?.()
      this.scrubbing = true
      this.scrubStartX = e.clientX
      this.scrubStartValue = this.lastValid ?? 0
      this.scrubStartValues = this.displayState === 'values' && this.lastValues ? [...this.lastValues] : null
      window.addEventListener('mousemove', this.onScrub)
      window.addEventListener('mouseup', this.endScrub)
      this.scrubListenersAttached = true
    })
  }

  /** Removes the window scrub listeners if attached. Idempotent. */
  destroy(): void {
    if (!this.scrubListenersAttached) return
    this.scrubbing = false
    window.removeEventListener('mousemove', this.onScrub)
    window.removeEventListener('mouseup', this.endScrub)
    this.scrubListenersAttached = false
  }

  private handleChange(): void {
    const raw = this.input.value
    const trimmed = raw.trim()

    // Mixed and auto displays survive an unedited blur: if the raw value matches
    // the current keyword display, keep the display and return early.
    if (this.displayState === 'mixed' && trimmed === MIXED_TEXT) {
      return
    }
    if (this.displayState === 'auto' && trimmed.toLowerCase() === AUTO_TEXT) {
      return
    }
    if (this.displayState === 'values' && this.lastValues && trimmed === compressShorthand(this.lastValues).join(',')) {
      return
    }

    // Keyword handling (auto) takes priority when allowed.
    if (this.opts.allowAuto && trimmed.toLowerCase() === AUTO_TEXT) {
      this.setAuto()
      this.opts.onKeyword?.('auto')
      return
    }

    // Comma list = per-side values (2026-07-07 spec). Segments are plain decimal literals
    // (negatives allowed — margins), never expressions; the list expands CSS-shorthand-style
    // to the row's prop count and clamps per side. Checked before the number/expression
    // paths so a comma never half-parses as either.
    if (this.opts.valuesCount !== undefined && this.opts.onValuesInput && trimmed.includes(',')) {
      const segments = trimmed.split(',').map((s) => s.trim())
      if (segments.every((s) => /^-?\d+(\.\d+)?$/.test(s))) {
        const expanded = expandShorthand(segments.map(Number.parseFloat), this.opts.valuesCount)
        if (expanded !== null) {
          const clamped = expanded.map((v) => this.clamp(v))
          this.setValues(clamped)
          this.opts.onValuesInput(clamped)
          return
        }
      }
      this.revert()
      return
    }

    // Plain number path — unchanged from v1, EXCEPT: when onRelative is wired, a bare
    // negative number ('-8') must NOT be swallowed here as a negative literal — it stays
    // a leading-operator expression (documented evaluateExpression CAVEAT) so it can route
    // to onRelative below like every other leading-op entry (+8, *2, /4).
    const n = Number.parseFloat(raw)
    const isBareNegative = trimmed.startsWith('-')
    if (Number.isFinite(n) && /^-?\d+(\.\d+)?$/.test(trimmed) && !(this.opts.onRelative && isBareNegative)) {
      this.commit(n)
      return
    }

    // Expression path — only when the input contains expression characters.
    if (/[-+*/()]/.test(raw)) {
      // Leading-operator expressions (`+8`, `-3`, `*2`, `/4`) are RELATIVE deltas when the
      // caller wired onRelative — hand back a closure instead of committing an absolute
      // value here, so a multi-select caller can apply it against each element's own baseline.
      if (this.opts.onRelative && /^[-+*/]/.test(trimmed)) {
        const rawEntry = raw
        this.opts.onRelative((current: number) => {
          const result = evaluateExpression(rawEntry, current)
          return result === null ? current : this.clamp(result)
        })
        return
      }
      const result = evaluateExpression(raw, this.lastValid)
      if (result === null) {
        this.revert()
      } else {
        this.commit(result)
      }
      return
    }

    // Garbage — revert.
    this.revert()
  }

  /**
   * Restores the display the field had before this invalid edit. Plain render(lastValid)
   * would blank the field whenever the prior state was Mixed/auto (lastValid is null in
   * both), so invalid input from those states must re-show the keyword, not an empty box.
   */
  private revert(): void {
    if (this.displayState === 'mixed') this.setMixed()
    else if (this.displayState === 'auto') this.setAuto()
    else if (this.displayState === 'values' && this.lastValues) this.setValues(this.lastValues)
    else this.render(this.lastValid)
  }

  private onScrub = (e: MouseEvent): void => {
    if (!this.scrubbing) return
    if (this.opts.onRelative) {
      // Each move REPLACES the previous move's effect: the closure is applied by the caller
      // against its own immutable per-element baseline(s) snapshotted at onScrubStart, not
      // against this field's lastValid — so re-applying it after a later move stays correct
      // (per-move idempotency), unlike accumulating a running total here.
      const totalDeltaPx = e.clientX - this.scrubStartX
      this.opts.onRelative((baseline: number) => this.clamp(baseline + totalDeltaPx))
      return
    }
    if (this.scrubStartValues && this.opts.onValuesInput) {
      // Values-state scrub: each side moves by the same drag delta from ITS OWN frozen
      // start value — the absolute commit below would overwrite every side with one number.
      const moved = this.scrubStartValues.map((v) => this.clamp(v + (e.clientX - this.scrubStartX)))
      this.setValues(moved)
      this.opts.onValuesInput(moved)
      return
    }
    this.commit(this.scrubStartValue + (e.clientX - this.scrubStartX))
  }

  private endScrub = (): void => {
    this.scrubbing = false
    window.removeEventListener('mousemove', this.onScrub)
    window.removeEventListener('mouseup', this.endScrub)
    this.scrubListenersAttached = false
  }

  private clamp(n: number): number {
    let result = Math.round(n)
    if (this.opts.min !== undefined) result = Math.max(this.opts.min, result)
    if (this.opts.max !== undefined) result = Math.min(this.opts.max, result)
    return result
  }

  private commit(raw: number): void {
    const n = this.clamp(raw)
    this.render(n)
    this.opts.onInput(n)
  }

  private render(value: number | null): void {
    this.lastValid = value
    this.lastValues = null
    this.input.value = value === null ? '' : String(value)
    this.displayState = 'number'
  }

  /** Clears pill binding (readOnly + class + title) without touching lastValid/display — used by set()/setMixed()/setAuto(). */
  private unbindPill(): void {
    if (!this.pillBound) return
    this.pillBound = false
    this.input.readOnly = false
    this.input.title = ''
    this.root.classList.remove('nf-pill')
  }

  set(value: number | null): void {
    this.setWhisper(null)
    this.unbindPill()
    this.render(value)
  }

  /** Displays the literal 'Mixed' text; internal value is null (get() reports null). */
  setMixed(): void {
    this.setWhisper(null)
    this.unbindPill()
    this.lastValid = null
    this.lastValues = null
    this.input.value = MIXED_TEXT
    this.displayState = 'mixed'
  }

  /** Displays the literal 'auto' text; internal value is null (get() reports null). Only meaningful with allowAuto. */
  setAuto(): void {
    this.setWhisper(null)
    this.unbindPill()
    this.lastValid = null
    this.lastValues = null
    this.input.value = AUTO_TEXT
    this.displayState = 'auto'
  }

  /** Displays per-side values in shortest shorthand form (e.g. '16,8' — see
   * compressShorthand); internal value is null (get() reports null), per-side baselines
   * live in lastValues for arrows/scrub. */
  setValues(values: number[]): void {
    this.setWhisper(null)
    this.unbindPill()
    this.lastValid = null
    this.lastValues = [...values]
    this.input.value = compressShorthand(values).join(',')
    this.displayState = 'values'
  }

  get(): number | null {
    return this.lastValid
  }

  /** Binds the field to a display-only token pill (e.g. a design-token reference). readOnly, does not touch lastValid. */
  bindToken(label: string): void {
    this.setWhisper(null)
    this.pillBound = true
    this.input.readOnly = true
    this.input.value = label
    // Spec §5: `.nf-pill` ellipsis-clips long tokens (`spacing-2.5`) — title is the
    // affordance that keeps the full value discoverable on hover.
    this.input.title = label
    this.root.classList.add('nf-pill')
    this.displayState = 'number'
    this.lastValues = null
  }

  /** Detaches a pill binding, restoring the input to an editable number display of lastValid. */
  detach(): void {
    this.pillBound = false
    this.input.readOnly = false
    this.input.title = ''
    this.root.classList.remove('nf-pill')
    this.render(this.lastValid)
  }

  /** Dim right-side context label (e.g. the applied Hug/Fill size mode). Any display
   * mutation (set/setMixed/setAuto/bindToken) clears it — the refresh that changed the
   * display is responsible for re-asserting it, so a whisper can never outlive its mode. */
  setWhisper(text: string | null): void {
    this.whisperEl.textContent = text ?? ''
    this.whisperEl.hidden = text === null
  }

  /** Whether onTokenOpen was wired (menu callers gate their Variable… item on this). */
  canOpenToken(): boolean {
    return !!this.opts.onTokenOpen
  }

  /** External trigger for the token picker — the sizing menu's Variable… item. */
  openToken(): void {
    this.opts.onTokenOpen?.()
  }
}
