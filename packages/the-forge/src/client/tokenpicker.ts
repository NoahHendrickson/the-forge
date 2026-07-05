/** Numeric scale entry (spacing/radius/text) — e.g. { label: '4', px: 16 }. */
export interface ScaleEntry {
  label: string
  px: number
}

/** Named color token — e.g. { label: 'neutral-900', color: 'oklch(...)' }. */
export interface ColorEntry {
  label: string
  color: string
}

export type TokenEntry = ScaleEntry | ColorEntry

export interface OpenOpts<E extends TokenEntry = TokenEntry> {
  /** Row to align to — popover sits within the panel, top set from this element's offsetTop. */
  anchor: HTMLElement
  /** Candidate entries for the anchored field: one numeric scale's steps, or the color palette. */
  entries: E[]
  /** Fired when the user commits a row (Enter or click) — typed to the entry kind the caller
   * passed in `entries`, so scale callers read `.px` and color callers read `.color` with no
   * union narrowing at the call site. */
  onApply: (entry: E) => void
}

/**
 * One instance per Panel. Appended to the panel root, absolutely positioned, hidden by
 * default — mirrors ColorPicker's popover conventions (positioning, outside-click via
 * composedPath, Esc close, window-listener attach/detach guards).
 */
export class TokenPicker {
  root = document.createElement('div')

  /** Invoked at the top of every open(). Panel points this at ColorPicker.close() so the two
   * popovers stay mutually exclusive without either component importing the other — a hook
   * rather than a Panel-side monkey-patch of open(), because reassigning a generic method
   * would erase the per-call entry typing open() provides. */
  beforeOpen: (() => void) | null = null

  private searchInput = document.createElement('input')
  private listEl = document.createElement('div')

  private entries: TokenEntry[] = []
  private filtered: TokenEntry[] = []
  private activeIndex = -1
  private onApply: ((entry: TokenEntry) => void) | null = null

  private globalListenersAttached = false

  private outsideMousedown = (e: Event): void => {
    if (this.root.hidden) return
    // See ColorPicker's identical guard: window-level listeners see the event RETARGETED
    // to the shadow host when the picker lives inside an open shadow root, so `e.target`
    // alone can't tell an in-popover click from an outside one — composedPath()[0] can.
    const target = typeof e.composedPath === 'function' ? e.composedPath()[0] : e.target
    if (target instanceof Node && this.root.contains(target)) return
    this.close()
  }

  private onKeydown = (e: KeyboardEvent): void => {
    if (e.key === 'Escape') this.close()
  }

  constructor(panelRoot: HTMLElement) {
    this.root.className = 'token-popover'
    this.root.hidden = true

    this.searchInput.type = 'text'
    this.searchInput.className = 'tp-search'
    this.root.append(this.searchInput)

    this.listEl.className = 'tp-list'
    this.root.append(this.listEl)

    this.searchInput.addEventListener('input', () => {
      this.applyFilter(this.searchInput.value)
    })
    this.searchInput.addEventListener('keydown', (e) => this.onSearchKeydown(e))

    panelRoot.append(this.root)
  }

  open<E extends TokenEntry>(opts: OpenOpts<E>): void {
    this.beforeOpen?.()
    this.entries = opts.entries
    // The cast is sound because entries and onApply travel together: commit() only ever
    // feeds onApply entries taken from this.entries, which are E by construction.
    this.onApply = opts.onApply as (entry: TokenEntry) => void

    this.root.hidden = false
    const top = (opts.anchor as unknown as { offsetTop: number }).offsetTop ?? 0
    this.root.style.top = `${top}px`

    this.searchInput.value = ''
    this.applyFilter('')
    this.searchInput.focus()

    // The popover is absolutely positioned inside the panel's own scrollable body — for an
    // anchor row far down a long panel, the popover can render below the panel's visible
    // viewport even though the PANEL itself is scrolled to a sane position. Scroll it into
    // view immediately on open so it's never opened off-screen. jsdom elements don't
    // implement scrollIntoView at all, so guard its existence (mirrors moveActive's guard).
    const root = this.root as HTMLElement & { scrollIntoView?: (opts?: ScrollIntoViewOptions) => void }
    if (typeof root.scrollIntoView === 'function') root.scrollIntoView({ block: 'nearest' })

    // capture: true so a focused control's own bubble-phase Escape handler (e.g. NumberField
    // calls stopPropagation() on Escape — see controls.ts) can't starve this listener: the
    // capture phase runs BEFORE the target's bubble-phase handlers fire.
    window.addEventListener('keydown', this.onKeydown, true)
    window.addEventListener('mousedown', this.outsideMousedown)
    this.globalListenersAttached = true
  }

  close(): void {
    this.root.hidden = true
    // close() is called defensively even when the picker was never opened — guard so a
    // no-op close doesn't register a spurious removeEventListener (mirrors ColorPicker).
    if (!this.globalListenersAttached) return
    window.removeEventListener('keydown', this.onKeydown, true)
    window.removeEventListener('mousedown', this.outsideMousedown)
    this.globalListenersAttached = false
  }

  /** Full teardown — removes any active window listeners. Call when the Panel itself is destroyed. */
  destroy(): void {
    this.close()
  }

  private applyFilter(query: string): void {
    const q = query.trim().toLowerCase()
    this.filtered = q === '' ? this.entries : this.entries.filter((e) => e.label.toLowerCase().includes(q))
    this.activeIndex = -1
    this.renderList()
  }

  private onSearchKeydown(e: KeyboardEvent): void {
    if (e.key === 'ArrowDown') {
      e.preventDefault()
      this.moveActive(1)
      return
    }
    if (e.key === 'ArrowUp') {
      e.preventDefault()
      this.moveActive(-1)
      return
    }
    if (e.key === 'Enter') {
      e.preventDefault()
      this.applyActive()
    }
  }

  private moveActive(delta: number): void {
    if (this.filtered.length === 0) return
    if (this.activeIndex === -1) {
      this.activeIndex = delta > 0 ? 0 : this.filtered.length - 1
    } else {
      this.activeIndex = Math.min(this.filtered.length - 1, Math.max(0, this.activeIndex + delta))
    }
    this.updateActiveClasses()
    // Keep the keyboard-active row in view for long scale lists (e.g. the full spacing
    // scale) — jsdom elements don't implement scrollIntoView, so guard its existence.
    const activeRow = this.listEl.children[this.activeIndex] as (Element & { scrollIntoView?: (opts?: ScrollIntoViewOptions) => void }) | undefined
    if (activeRow && typeof activeRow.scrollIntoView === 'function') {
      activeRow.scrollIntoView({ block: 'nearest' })
    }
  }

  /** Toggles tp-row-active in place — hover/keyboard must NEVER rebuild the list:
   *  replaceChildren under a live pointer re-fires mouseenter on the replacement node
   *  (same coordinates), which re-rendered again, looping forever and starving the
   *  row's own mousedown/click. Found by real-browser E2E; jsdom hover never sees it. */
  private updateActiveClasses(): void {
    Array.from(this.listEl.children).forEach((el, idx) => {
      el.classList.toggle('tp-row-active', idx === this.activeIndex)
    })
  }

  private applyActive(): void {
    const entry = this.filtered[this.activeIndex] ?? this.filtered[0]
    if (!entry) return
    this.commit(entry)
  }

  private commit(entry: TokenEntry): void {
    this.onApply?.(entry)
    this.close()
  }

  private renderList(): void {
    this.listEl.replaceChildren()
    this.filtered.forEach((entry, i) => {
      const row = document.createElement('div')
      row.className = 'tp-row'
      if (i === this.activeIndex) row.classList.add('tp-row-active')

      const labelEl = document.createElement('span')
      labelEl.className = 'tp-row-label'
      labelEl.textContent = entry.label

      if ('color' in entry) {
        const swatchEl = document.createElement('span')
        swatchEl.className = 'tp-row-swatch'
        swatchEl.style.background = entry.color
        row.append(swatchEl, labelEl)
      } else {
        const pxEl = document.createElement('span')
        pxEl.className = 'tp-row-px'
        pxEl.textContent = `${entry.px}px`

        row.append(labelEl, document.createTextNode(' — '), pxEl)
      }

      row.addEventListener('mouseenter', () => {
        if (this.activeIndex === i) return
        this.activeIndex = i
        this.updateActiveClasses()
      })
      row.addEventListener('click', () => this.commit(entry))

      this.listEl.append(row)
    })
  }
}
