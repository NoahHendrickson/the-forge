import { CSS } from '../src/client/overlay'

export type MountContext = 'panel' | 'status' | 'bare'

/**
 * Renders story content inside a real shadow root carrying the product stylesheet — the
 * fidelity guarantee: every story renders through the SAME `CSS` const the shipped overlay
 * uses, never a copy. `context` wraps content in the ancestor the CSS's `#panel` / `#status`
 * selectors need to match.
 */
export function mountInShadow(content: HTMLElement | HTMLElement[], context: MountContext = 'panel'): HTMLElement {
  const host = document.createElement('div')
  const root = host.attachShadow({ mode: 'open' })
  const style = document.createElement('style')
  style.textContent = CSS
  root.append(style)
  let target: HTMLElement | ShadowRoot = root
  if (context !== 'bare') {
    const wrap = document.createElement('div')
    wrap.id = context // #panel / #status context selectors apply
    // Stories flow in the preview canvas; the product positions these fixed.
    wrap.style.position = 'static'
    root.append(wrap)
    target = wrap
  }
  target.append(...(Array.isArray(content) ? content : [content]))
  return host
}
