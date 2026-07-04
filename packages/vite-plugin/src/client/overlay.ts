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
#panel {
  position: fixed; right: 16px; top: 16px; z-index: 2147483647;
  width: 260px; max-height: 80vh; overflow-y: auto;
  font: 400 12px system-ui, sans-serif; background: #fff; color: #1a1a18;
  border: 1px solid #d0d0cb; border-radius: 10px; padding: 12px;
}
#panel .panel-head { font-weight: 500; margin-bottom: 8px; word-break: break-all; }
#panel .panel-section { color: #6b6b66; margin: 10px 0 4px; font-size: 11px; text-transform: uppercase; letter-spacing: 0.04em; }
#panel .panel-rows { display: flex; flex-wrap: wrap; gap: 6px; align-items: center; }
#panel button { border-radius: 6px; padding: 4px 10px; }
.nf { display: flex; align-items: center; gap: 4px; border: 1px solid #e3e3de; border-radius: 6px; padding: 2px 6px; }
.nf-label { color: #6b6b66; font-size: 11px; cursor: ew-resize; user-select: none; min-width: 16px; }
.nf input { width: 44px; border: none; outline: none; font: 400 12px system-ui, sans-serif; color: #1a1a18; background: transparent; }
`

export class Overlay {
  host = document.createElement('div')
  toggle = document.createElement('button')
  copyButton = document.createElement('button')
  compareAllButton = document.createElement('button')
  resetAllButton = document.createElement('button')

  private outline = document.createElement('div')
  private selectOutline = document.createElement('div')
  private status = document.createElement('div')
  private statusLabel = document.createElement('span')

  constructor() {
    const root = this.host.attachShadow({ mode: 'open' })
    const style = document.createElement('style')
    style.textContent = CSS
    this.toggle.id = 'toggle'
    this.toggle.textContent = 'Design'
    this.outline.id = 'outline'
    this.selectOutline.id = 'select-outline'
    this.status.id = 'status'
    this.copyButton.textContent = 'Copy for agent'
    this.resetAllButton.textContent = 'Reset all'
    this.status.append(this.statusLabel, this.copyButton, this.compareAllButton, this.resetAllButton)
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

  updateStatus(draftCount: number, comparingAll: boolean): void {
    this.status.hidden = draftCount === 0
    this.statusLabel.textContent = `${draftCount} draft${draftCount === 1 ? '' : 's'}`
    this.compareAllButton.textContent = comparingAll ? 'After' : 'Before'
  }
}
