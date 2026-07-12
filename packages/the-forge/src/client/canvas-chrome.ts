import { CanvasMode } from './canvas'
import type { Panel } from './panel'
import { createMenuButton, type MenuButton } from './ui/menu'

export interface CanvasChrome {
  wrap: HTMLElement
  sync: () => void
}

// Presentation assembly for canvas mode's chrome (the zoom pill + its menu), extracted out
// of index.ts (2026-07-11 review — index.ts was pushing 1000 lines and this is DOM assembly,
// not orchestration). Deliberately NOT folded into CanvasMode itself (a reviewer suggested
// that): CanvasMode stays headless page-mechanics with zero ui/ imports, which is what keeps
// canvas.test.ts DOM-chrome-free.
export function buildCanvasChrome(canvas: CanvasMode, panel: Panel): CanvasChrome {
  // Bottom-left zoom affordance (mirrors #toggle/#status's bottom-right cluster) — hidden
  // until canvas mode is actually applied (design mode off ⇒ suspended ⇒ hidden too).
  const wrap = document.createElement('div')
  wrap.className = 'zoom-pill-wrap forge-anim'
  wrap.hidden = true
  const menu: MenuButton = createMenuButton({
    label: '100%',
    opensUp: true,
    popoverHost: wrap,
    items: () => [
      { value: 'in', label: 'Zoom in' },
      { value: 'out', label: 'Zoom out' },
      { value: 'fit', label: 'Zoom to fit', separator: true },
      { value: '0.5', label: '50%', checked: canvas.scale() === 0.5, separator: true },
      { value: '1', label: '100%', checked: canvas.scale() === 1 },
      { value: '2', label: '200%', checked: canvas.scale() === 2 },
    ],
    onSelect: (v) => {
      if (v === 'in') canvas.zoomStep(1)
      else if (v === 'out') canvas.zoomStep(-1)
      else if (v === 'fit') canvas.zoomToFit()
      else canvas.setZoomCentered(Number(v))
    },
  })
  menu.button.classList.add('zoom-pill')
  wrap.appendChild(menu.button)
  panel.canvasButton.addEventListener('click', () => canvas.setOn(!canvas.isOn()))

  const sync = (): void => {
    const applied = canvas.isApplied()
    wrap.hidden = !applied
    menu.button.textContent = `${Math.round(canvas.scale() * 100)}%`
    panel.canvasButton.classList.toggle('on', canvas.isOn())
    panel.canvasButton.title = canvas.isOn() ? 'Exit canvas mode' : 'Canvas mode'
  }

  return { wrap, sync }
}
