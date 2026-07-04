import { parseSourceAttr, type SourceLocation } from './source'

export const STYLE_PROPS = [
  'display',
  'padding',
  'margin',
  'gap',
  'border-radius',
  'font-size',
  'font-weight',
  'line-height',
  'color',
  'background-color',
] as const

export interface InspectorData {
  tag: string
  source: SourceLocation | null
  classes: string[]
  width: number
  height: number
  styles: Record<string, string>
}

export function buildInspectorData(el: HTMLElement): InspectorData {
  const rect = el.getBoundingClientRect()
  const computed = getComputedStyle(el)
  const styles: Record<string, string> = {}
  for (const prop of STYLE_PROPS) {
    styles[prop] = computed.getPropertyValue(prop)
  }
  return {
    tag: el.tagName.toLowerCase(),
    source: el.dataset.dcSource ? parseSourceAttr(el.dataset.dcSource) : null,
    classes: Array.from(el.classList),
    width: Math.round(rect.width),
    height: Math.round(rect.height),
    styles,
  }
}
