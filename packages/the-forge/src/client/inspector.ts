import { elementOffsets } from './panel-readers'
import { parseSourceAttr, type SourceLocation, type TaggedElement } from './source'

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
  /** Offset from the offsetParent's padding edge (Figma pivot P1) — the panel's read-only
   * X/Y header pair. 0 for SVG and other non-HTMLElements, which have no offset model. */
  x: number
  y: number
  width: number
  height: number
  styles: Record<string, string>
}

export function buildInspectorData(el: TaggedElement): InspectorData {
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
    ...elementOffsets(el),
    width: Math.round(rect.width),
    height: Math.round(rect.height),
    styles,
  }
}
