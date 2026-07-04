import type { InspectorData } from './inspector'

const CSS = `
:host { all: initial; }
#toggle {
  position: fixed; right: 16px; bottom: 16px; z-index: 2147483647;
  font: 500 12px system-ui, sans-serif; padding: 8px 14px;
  border-radius: 999px; border: 1px solid #d0d0cb; background: #fff;
  color: #1a1a18; cursor: pointer;
}
#toggle.active { background: #1a1a18; color: #fff; }
#outline {
  position: fixed; z-index: 2147483646; pointer-events: none;
  border: 1.5px solid #4a90e2; border-radius: 2px;
}
#panel {
  position: fixed; right: 16px; top: 16px; z-index: 2147483647;
  width: 260px; max-height: 70vh; overflow-y: auto;
  font: 400 12px system-ui, sans-serif; background: #fff; color: #1a1a18;
  border: 1px solid #d0d0cb; border-radius: 10px; padding: 12px;
}
#panel .row { display: flex; justify-content: space-between; gap: 8px; padding: 2px 0; }
#panel .key { color: #6b6b66; }
#panel .head { font-weight: 500; margin-bottom: 6px; word-break: break-all; }
`

export class Overlay {
  host = document.createElement('div')
  toggle = document.createElement('button')
  private outline = document.createElement('div')
  private panel = document.createElement('div')

  constructor() {
    const root = this.host.attachShadow({ mode: 'open' })
    const style = document.createElement('style')
    style.textContent = CSS
    this.toggle.id = 'toggle'
    this.toggle.textContent = 'Design'
    this.outline.id = 'outline'
    this.panel.id = 'panel'
    this.outline.hidden = true
    this.panel.hidden = true
    root.append(style, this.toggle, this.outline, this.panel)
  }

  mount(): void {
    document.body.appendChild(this.host)
  }

  contains(target: EventTarget | null): boolean {
    return target instanceof Node && this.host.contains(target)
  }

  setActive(on: boolean): void {
    this.toggle.classList.toggle('active', on)
    if (!on) {
      this.hideOutline()
      this.hidePanel()
    }
  }

  showOutline(rect: DOMRect): void {
    this.outline.hidden = false
    this.outline.style.left = `${rect.left - 2}px`
    this.outline.style.top = `${rect.top - 2}px`
    this.outline.style.width = `${rect.width + 4}px`
    this.outline.style.height = `${rect.height + 4}px`
  }

  hideOutline(): void {
    this.outline.hidden = true
  }

  showPanel(data: InspectorData): void {
    this.panel.hidden = false
    this.panel.replaceChildren()

    const head = document.createElement('div')
    head.className = 'head'
    head.textContent = data.source
      ? `<${data.tag}> — ${data.source.file}:${data.source.line}:${data.source.col}`
      : `<${data.tag}>`
    this.panel.append(head)

    const rows: Array<[string, string]> = [
      ['size', `${data.width} × ${data.height}`],
      ['classes', data.classes.join(' ') || '—'],
      ...Object.entries(data.styles),
    ]
    for (const [key, value] of rows) {
      const row = document.createElement('div')
      row.className = 'row'
      const k = document.createElement('span')
      k.className = 'key'
      k.textContent = key
      const v = document.createElement('span')
      v.textContent = value || '—'
      row.append(k, v)
      this.panel.append(row)
    }
  }

  hidePanel(): void {
    this.panel.hidden = true
  }
}
