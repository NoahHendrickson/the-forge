const CSS = `
:host { all: initial; }
button {
  font: 500 12px system-ui, sans-serif; border-radius: 999px;
  border: 1px solid #d0d0cb; background: #fff; color: #1a1a18;
  cursor: pointer; padding: 6px 12px;
}
#toggle { position: fixed; right: 16px; bottom: 16px; z-index: 2147483647; padding: 8px 14px; }
#toggle.active { background: #1a1a18; color: #fff; }
#status {
  position: fixed; right: 16px; bottom: 60px; z-index: 2147483647;
  display: flex; gap: 6px; align-items: center;
  font: 400 12px system-ui, sans-serif; color: #1a1a18;
  background: #fff; border: 1px solid #d0d0cb; border-radius: 999px; padding: 5px 8px 5px 12px;
}
#outline {
  position: fixed; z-index: 2147483645; pointer-events: none;
  border: 1.5px solid #4a90e2; border-radius: 2px;
}
#select-outline {
  position: fixed; z-index: 2147483646; pointer-events: none;
  border: 2px solid #4a90e2; border-radius: 2px;
}
.ripple-outline {
  position: fixed; z-index: 2147483644; pointer-events: none;
  border: 1.5px dashed #e2954a; border-radius: 2px;
  opacity: 1; transition: opacity 0.3s ease-out;
}
#panel {
  position: fixed; right: 16px; top: 16px; z-index: 2147483647;
  width: 260px; max-height: 80vh; overflow-y: auto;
  font: 400 12px system-ui, sans-serif; background: #fff; color: #1a1a18;
  border: 1px solid #d0d0cb; border-radius: 10px; padding: 12px;
}
#panel .panel-head { font-weight: 500; margin-bottom: 8px; word-break: break-all; }
#panel .panel-section { color: #6b6b66; margin: 10px 0 4px; font-size: 11px; text-transform: uppercase; letter-spacing: 0.04em; }
#panel .panel-section[hidden] { display: none; }
#panel .panel-rows { display: flex; flex-wrap: wrap; gap: 6px; align-items: center; }
#panel button { border-radius: 6px; padding: 4px 10px; }
.nf { display: flex; align-items: center; gap: 4px; border: 1px solid #e3e3de; border-radius: 6px; padding: 2px 6px; }
.nf-label { color: #6b6b66; font-size: 11px; cursor: ew-resize; user-select: none; min-width: 16px; }
.nf input { width: 44px; border: none; outline: none; font: 400 12px system-ui, sans-serif; color: #1a1a18; background: transparent; }
.seg-field { display: flex; align-items: center; gap: 4px; }
.seg-field-label { color: #6b6b66; font-size: 11px; min-width: 16px; }
.seg { border-radius: 6px; padding: 3px 8px; font-size: 11px; }
.seg.seg-active { background: #1a1a18; color: #fff; }
.align-matrix { display: grid; grid-template-columns: repeat(3, 16px); grid-template-rows: repeat(3, 16px); gap: 3px; }
.am-dot { width: 16px; height: 16px; border-radius: 3px; padding: 0; border: 1px solid #e3e3de; background: #fff; }
.am-dot.am-active { background: #1a1a18; border-color: #1a1a18; }
.size-row { display: flex; align-items: center; gap: 4px; }
.size-mode { border: 1px solid #e3e3de; border-radius: 6px; font: 400 11px system-ui, sans-serif; color: #1a1a18; background: #fff; padding: 2px 4px; }
.layout-section, .flex-child-controls { display: flex; flex-direction: column; gap: 6px; width: 100%; }
`

export class Overlay {
  host = document.createElement('div')
  toggle = document.createElement('button')
  sendButton = document.createElement('button')
  copyButton = document.createElement('button')
  compareAllButton = document.createElement('button')
  resetAllButton = document.createElement('button')

  private outline = document.createElement('div')
  private selectOutline = document.createElement('div')
  private status = document.createElement('div')
  private statusLabel = document.createElement('span')
  private sentLabel = document.createElement('span')

  /** Pool of ripple-outline divs, reused across showRipples() calls instead of recreated. */
  private ripplePool: HTMLElement[] = []
  private rippleClearTimer: ReturnType<typeof setTimeout> | null = null

  /** Max ripple outlines shown at once — keeps the effect legible when many siblings shift. */
  private static readonly RIPPLE_CAP = 8
  /** Ripples fade and clear this long after the most recent showRipples() call. */
  private static readonly RIPPLE_CLEAR_MS = 1500
  /** Matches the `.ripple-outline` CSS transition duration — time to fully fade before hiding. */
  private static readonly RIPPLE_FADE_MS = 300

  constructor() {
    const root = this.host.attachShadow({ mode: 'open' })
    const style = document.createElement('style')
    style.textContent = CSS
    this.toggle.id = 'toggle'
    this.toggle.textContent = 'Design'
    this.outline.id = 'outline'
    this.selectOutline.id = 'select-outline'
    this.status.id = 'status'
    this.sendButton.textContent = 'Send to agent'
    this.copyButton.textContent = 'Copy for agent'
    this.resetAllButton.textContent = 'Reset all'
    this.sentLabel.id = 'sent'
    this.sentLabel.hidden = true
    this.status.append(this.statusLabel, this.sendButton, this.copyButton, this.compareAllButton, this.resetAllButton, this.sentLabel)
    this.outline.hidden = true
    this.selectOutline.hidden = true
    this.status.hidden = true
    root.append(style, this.toggle, this.status, this.outline, this.selectOutline)
  }

  mount(): void {
    document.body.appendChild(this.host)
  }

  attachPanel(panelRoot: HTMLElement): void {
    this.host.shadowRoot!.appendChild(panelRoot)
  }

  contains(target: EventTarget | null): boolean {
    return target instanceof Node && this.host.contains(target)
  }

  setActive(on: boolean): void {
    this.toggle.classList.toggle('active', on)
    if (!on) {
      this.hideOutline()
      this.hideSelectOutline()
      this.status.hidden = true
      this.clearRipples()
    }
  }

  private place(box: HTMLElement, rect: DOMRect): void {
    box.hidden = false
    box.style.left = `${rect.left - 2}px`
    box.style.top = `${rect.top - 2}px`
    box.style.width = `${rect.width + 4}px`
    box.style.height = `${rect.height + 4}px`
  }

  showOutline(rect: DOMRect): void {
    this.place(this.outline, rect)
  }

  hideOutline(): void {
    this.outline.hidden = true
  }

  showSelectOutline(rect: DOMRect): void {
    this.place(this.selectOutline, rect)
  }

  hideSelectOutline(): void {
    this.selectOutline.hidden = true
  }

  /**
   * Draws up to RIPPLE_CAP dashed outlines at the given rects (siblings that reflowed
   * after an edit). Reuses a pool of divs across calls rather than recreating them.
   * A single shared timer clears all ripples RIPPLE_CLEAR_MS after the most recent call
   * (re-triggering resets the timer, so a fresh edit extends the fade window).
   */
  showRipples(rects: DOMRect[]): void {
    const shown = rects.slice(0, Overlay.RIPPLE_CAP)
    while (this.ripplePool.length < shown.length) {
      const div = document.createElement('div')
      div.className = 'ripple-outline'
      div.style.pointerEvents = 'none'
      div.hidden = true
      this.host.shadowRoot!.appendChild(div)
      this.ripplePool.push(div)
    }
    this.ripplePool.forEach((div, i) => {
      if (i < shown.length) {
        this.place(div, shown[i])
        div.style.opacity = '1' // full opacity again — a reused div may still be mid-fade-out
      } else {
        div.hidden = true
      }
    })
    if (this.rippleClearTimer) clearTimeout(this.rippleClearTimer)
    this.rippleClearTimer = setTimeout(() => {
      this.rippleClearTimer = null
      this.clearRipples()
    }, Overlay.RIPPLE_CLEAR_MS)
  }

  /**
   * Starts the fade-then-hide sequence: dropping opacity to 0 lets the CSS transition
   * on `.ripple-outline` actually animate, instead of the outline vanishing instantly.
   * The divs are hidden RIPPLE_FADE_MS later, once the transition has had time to finish.
   */
  private clearRipples(): void {
    if (this.rippleClearTimer) {
      clearTimeout(this.rippleClearTimer)
      this.rippleClearTimer = null
    }
    for (const div of this.ripplePool) div.style.opacity = '0'
    setTimeout(() => {
      for (const div of this.ripplePool) div.hidden = true
    }, Overlay.RIPPLE_FADE_MS)
  }

  updateStatus(draftCount: number, comparingAll: boolean, sentText?: string): void {
    // Strip is visible when there are drafts OR a non-empty summary
    this.status.hidden = draftCount === 0 && !sentText
    // Draft-count label and controls are hidden when no drafts (they act on drafts)
    this.statusLabel.hidden = draftCount === 0
    this.sendButton.hidden = draftCount === 0
    this.copyButton.hidden = draftCount === 0
    this.compareAllButton.hidden = draftCount === 0
    this.resetAllButton.hidden = draftCount === 0
    // Draft count text (shown only when visible)
    this.statusLabel.textContent = `${draftCount} draft${draftCount === 1 ? '' : 's'}`
    // Compare button label
    this.compareAllButton.textContent = comparingAll ? 'After' : 'Before'
    // Sent summary label
    this.sentLabel.hidden = !sentText
    this.sentLabel.textContent = sentText ?? ''
  }
}
