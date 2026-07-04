export interface TokenEntry {
  /** Suffix-free scale label — e.g. '4' (spacing), 'md' (radius), 'sm' (font-size). */
  label: string
  px: number
}

export interface OpenOpts {
  /** Row to align to — popover sits within the panel, top set from this element's offsetTop. */
  anchor: HTMLElement
  /** Candidate entries for the anchored field's scale (spacing/radius/text). */
  entries: TokenEntry[]
  /** Fired when the user commits a row (Enter or click). */
  onApply: (entry: TokenEntry) => void
}

/**
 * One instance per Panel. Appended to the panel root, absolutely positioned, hidden by
 * default — mirrors ColorPicker's popover conventions (positioning, outside-click via
 * composedPath, Esc close, window-listener attach/detach guards).
 */
export class TokenPicker {
  root = document.createElement('div')

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

  open(opts: OpenOpts): void {
    this.entries = opts.entries
    this.onApply = opts.onApply

    this.root.hidden = false
    const top = (opts.anchor as unknown as { offsetTop: number }).offsetTop ?? 0
    this.root.style.top = `${top}px`

    this.searchInput.value = ''
    this.applyFilter('')
    this.searchInput.focus()

    window.addEventListener('keydown', this.onKeydown)
    window.addEventListener('mousedown', this.outsideMousedown)
    this.globalListenersAttached = true
  }

  close(): void {
    this.root.hidden = true
    // close() is called defensively even when the picker was never opened — guard so a
    // no-op close doesn't register a spurious removeEventListener (mirrors ColorPicker).
    if (!this.globalListenersAttached) return
    window.removeEventListener('keydown', this.onKeydown)
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
    this.renderList()
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

      const pxEl = document.createElement('span')
      pxEl.className = 'tp-row-px'
      pxEl.textContent = `${entry.px}px`

      row.append(labelEl, document.createTextNode(' — '), pxEl)

      row.addEventListener('mouseenter', () => {
        this.activeIndex = i
        this.renderList()
      })
      row.addEventListener('click', () => this.commit(entry))

      this.listEl.append(row)
    })
  }
}
