export interface SourceLocation {
  file: string
  line: number
  col: number
}

export function parseSourceAttr(value: string): SourceLocation | null {
  const m = /^(.+):(\d+):(\d+)$/.exec(value)
  if (!m) return null
  return { file: m[1], line: Number(m[2]), col: Number(m[3]) }
}

export type TaggedElement = HTMLElement | SVGElement

export function findTaggedElement(start: Element | null): TaggedElement | null {
  let el: Element | null = start
  while (el) {
    if ((el instanceof HTMLElement || el instanceof SVGElement) && el.dataset.dcSource) return el
    el = el.parentElement
  }
  return null
}
