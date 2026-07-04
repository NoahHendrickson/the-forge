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

export function findTaggedElement(start: Element | null): HTMLElement | null {
  let el: Element | null = start
  while (el) {
    if (el instanceof HTMLElement && el.dataset.dcSource) return el
    el = el.parentElement
  }
  return null
}
