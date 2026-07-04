export const CSS = `
[hidden] { display: none !important; }
*, *::before, *::after { box-sizing: border-box; }
:host { all: initial; }

/*
 * Design tokens (Figma UI3 dark reference) — used literally throughout this file.
 * Panel bg:            #2C2C2C
 * Elevated control bg: rgba(255,255,255,0.06)
 * Control hover:        rgba(255,255,255,0.12)
 * Control active/sel:   rgba(255,255,255,0.16)
 * Panel border:         rgba(255,255,255,0.09)
 * Section separator:    rgba(255,255,255,0.07)
 * Control border hover: rgba(255,255,255,0.12)
 * Text primary:         #F5F5F5
 * Text secondary:       #D4D4D4
 * Text muted:           #9A9A9A
 * Accent:               #0D99FF
 * Ripple outline:       #E2954A (must stay distinct from selection accent)
 * Radius: panel 12px, controls 6px, matrix tile 8px.
 * Type: 11px controls/labels, 10px source path, 12px panel tag.
 */

button {
  font: 500 12px system-ui, sans-serif; border-radius: 999px;
  border: 1px solid #d0d0cb; background: #fff; color: #1a1a18;
  cursor: pointer; padding: 6px 12px;
}
#toggle {
  position: fixed; right: 16px; bottom: 16px; z-index: 2147483647; padding: 8px 14px;
  background: #2C2C2C; color: #F5F5F5; border: 1px solid rgba(255,255,255,0.15);
}
#toggle.active { background: #0D99FF; border-color: transparent; color: #fff; }
#status {
  position: fixed; right: 16px; bottom: 60px; z-index: 2147483647;
  display: flex; gap: 6px; align-items: center;
  font: 400 12px system-ui, sans-serif; color: #D4D4D4;
  background: #2C2C2C; border: 1px solid rgba(255,255,255,0.15); border-radius: 999px; padding: 5px 8px 5px 12px;
}
#status button {
  background: rgba(255,255,255,0.06); color: #D4D4D4; border: none; border-radius: 6px;
  font: 500 11px system-ui, sans-serif; padding: 4px 8px;
}
#status button:hover { background: rgba(255,255,255,0.12); }
#outline {
  position: fixed; z-index: 2147483645; pointer-events: none;
  border: 1.5px solid rgba(13,153,255,0.75); border-radius: 2px;
}
#select-outline {
  position: fixed; z-index: 2147483646; pointer-events: none;
  border: 2px solid #0D99FF; border-radius: 2px;
}
.ripple-outline {
  position: fixed; z-index: 2147483644; pointer-events: none;
  border: 1.5px dashed #e2954a; border-radius: 2px;
  opacity: 1; transition: opacity 0.3s ease-out;
}
#panel {
  position: fixed; right: 16px; top: 16px; z-index: 2147483647;
  width: 280px; max-height: 80vh; overflow-y: auto; overflow-x: hidden;
  font: 400 12px system-ui, sans-serif; background: #2C2C2C; color: #F5F5F5;
  border: 1px solid rgba(255,255,255,0.09); border-radius: 12px; padding: 0;
  box-shadow: 0 5px 24px rgba(0,0,0,0.35);
  -webkit-font-smoothing: antialiased;
}
#panel::-webkit-scrollbar { width: 8px; }
#panel::-webkit-scrollbar-thumb { background: rgba(255,255,255,0.15); border-radius: 4px; }

#panel .panel-head { padding: 12px 12px 10px; }
#panel .panel-head-tag { font: 600 12px system-ui, sans-serif; color: #F5F5F5; }
#panel .panel-head-src {
  font: 400 10px ui-monospace, monospace; color: #9A9A9A; margin-top: 2px;
  overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
}
#panel .panel-actions { display: flex; gap: 6px; padding: 0 12px 10px; }

#panel .panel-section {
  display: flex; align-items: center; justify-content: space-between;
  padding: 10px 12px 6px; border-top: 1px solid rgba(255,255,255,0.07);
  font: 600 11px system-ui, sans-serif; color: #E8E8E8; text-transform: none;
}
#panel .panel-section [data-expand] { width: 20px; height: 18px; padding: 0; }

#panel .panel-rows { display: flex; flex-wrap: wrap; gap: 6px; padding: 0 12px 10px; align-items: center; }

#panel button {
  font: 500 11px system-ui, sans-serif; color: #D4D4D4;
  background: rgba(255,255,255,0.06); border: none; border-radius: 6px; padding: 4px 8px;
  cursor: pointer;
}
#panel button:hover { background: rgba(255,255,255,0.12); }
#panel button:active { background: rgba(255,255,255,0.16); }

[data-add-layout] {
  width: 100%; text-align: center; padding: 6px 0; background: transparent;
  border: 1px dashed rgba(255,255,255,0.18); color: #B8B8B8;
}
[data-add-layout]:hover { border-style: solid; background: rgba(255,255,255,0.06); }

.nf {
  display: flex; align-items: center; gap: 4px;
  height: 24px; background: rgba(255,255,255,0.06);
  border: 1px solid transparent; border-radius: 6px; padding: 0 6px;
  flex: 1 1 40%;
}
.nf:hover { border-color: rgba(255,255,255,0.12); }
.nf:focus-within { border-color: #0D99FF; }
.nf-label { color: #9A9A9A; font-size: 10px; cursor: ew-resize; user-select: none; min-width: 16px; }
.nf-label:hover { color: #F5F5F5; }
.nf input {
  width: 100%; min-width: 24px; flex: 1;
  border: none; outline: none; font: 400 11px system-ui, sans-serif; color: #F5F5F5; background: transparent;
}

.seg-field { display: flex; align-items: center; gap: 4px; }
.seg-field-label { flex: none; width: 44px; color: #9A9A9A; font-size: 11px; }
.seg-track {
  flex: 1; display: flex; gap: 2px;
  background: rgba(255,255,255,0.06); border-radius: 6px; padding: 2px;
}
.seg {
  flex: 1; padding: 3px 0; text-align: center; border-radius: 4px;
  background: transparent; color: #B8B8B8; font-size: 10.5px; white-space: nowrap;
}
.seg:hover { color: #F5F5F5; }
.seg-active { background: rgba(255,255,255,0.16); color: #fff; }

.layout-grid { display: flex; gap: 8px; width: 100%; }
.layout-side { flex: 1; display: flex; flex-direction: column; gap: 6px; }

.matrix-tile {
  width: 88px; height: 88px; background: rgba(255,255,255,0.05);
  border: 1px solid rgba(255,255,255,0.08); border-radius: 8px;
  display: flex; align-items: center; justify-content: center; flex: none;
}
.align-matrix {
  display: grid; grid-template-columns: repeat(3, 20px); grid-template-rows: repeat(3, 20px); gap: 2px;
}
.align-matrix.am-sb-col { grid-template-columns: 20px; grid-template-rows: repeat(3, 20px); }
.align-matrix.am-sb-row { grid-template-columns: repeat(3, 20px); grid-template-rows: 20px; }
.am-dot {
  width: 20px; height: 20px; border: none; background: transparent; border-radius: 4px;
  display: flex; align-items: center; justify-content: center; padding: 0;
}
.am-dot::after {
  content: ''; width: 5px; height: 5px; border-radius: 50%; background: rgba(255,255,255,0.28);
}
.am-dot:hover { background: rgba(255,255,255,0.08); }
.am-dot:hover::after { width: 7px; height: 7px; background: rgba(255,255,255,0.6); }
.am-active::after {
  width: 8px; height: 8px; background: #0D99FF; box-shadow: 0 0 0 2px rgba(13,153,255,0.25);
}

.size-row { display: flex; gap: 4px; flex: 1 1 40%; min-width: 0; }
.size-row .nf { flex: 1; }
.size-mode {
  appearance: none; -webkit-appearance: none;
  background-color: rgba(255,255,255,0.06);
  background-image: url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='8' height='8' viewBox='0 0 8 8'%3E%3Cpath d='M1 2.5L4 5.5L7 2.5' stroke='%239A9A9A' stroke-width='1' fill='none' stroke-linecap='round' stroke-linejoin='round'/%3E%3C/svg%3E");
  background-repeat: no-repeat; background-position: right 5px center;
  color: #D4D4D4; border: 1px solid transparent; border-radius: 6px; height: 24px; padding: 0 18px 0 6px;
  font: 400 10.5px system-ui, sans-serif;
}
.size-mode:hover { border-color: rgba(255,255,255,0.12); }

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
