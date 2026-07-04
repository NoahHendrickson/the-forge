import { DraftStore } from './drafts'
import { parseSourceAttr, type SourceLocation, type TaggedElement } from './source'
import { readTheme, suggestUtility, findExistingUtility, type Theme } from './tokens'

export interface ChangeItem {
  property: string
  beforeCss: string
  afterCss: string
  beforeUtility: string | null
  afterUtility: string | null
  tokenExact: boolean
}

export interface ElementChange {
  tag: string
  source: SourceLocation | null
  className: string
  text: string
  selector: string
  changes: ChangeItem[]
}

export interface ChangeRequest {
  id: string
  createdAt: string
  viewport: { width: number; height: number }
  tailwind: boolean
  elements: ElementChange[]
}

// Keywords that are safe to pass through verbatim as an "after" value instead of the
// getComputedStyle-measured px/rgb/etc equivalent. Restricted to layout/box-model keywords
// (sizing, flex, alignment, border-style) where the computed value would silently invert the
// user's intent (e.g. Hug width 'auto' -> a hardcoded px). Deliberately excludes color keywords
// like 'red' — those DO round-trip meaningfully through getComputedStyle (-> 'rgb(255, 0, 0)')
// and must be measured, not passed through, once COLOR drafts exist (M2b-2).
export const KEYWORD_PASSTHROUGH = new Set([
  'auto',
  'fit-content',
  'min-content',
  'max-content',
  'flex',
  'inline-flex',
  'row',
  'column',
  'row-reverse',
  'column-reverse',
  'wrap',
  'nowrap',
  'wrap-reverse',
  'flex-start',
  'flex-end',
  'center',
  'space-between',
  'space-around',
  'space-evenly',
  'stretch',
  'baseline',
  'normal',
  'none',
  'solid',
  'dashed',
  'dotted',
])

const COLLAPSE: Array<{ into: string; parts: string[] }> = [
  {
    into: 'border-radius',
    parts: ['border-top-left-radius', 'border-top-right-radius', 'border-bottom-right-radius', 'border-bottom-left-radius'],
  },
  { into: 'padding-block', parts: ['padding-top', 'padding-bottom'] },
  { into: 'padding-inline', parts: ['padding-left', 'padding-right'] },
  { into: 'margin-block', parts: ['margin-top', 'margin-bottom'] },
  { into: 'margin-inline', parts: ['margin-left', 'margin-right'] },
]

function collapse(items: Map<string, { beforeCss: string; afterCss: string }>): Map<string, { beforeCss: string; afterCss: string }> {
  const out = new Map(items)
  for (const { into, parts } of COLLAPSE) {
    const present = parts.map((p) => out.get(p))
    if (present.some((v) => v === undefined)) continue
    const [first, ...rest] = present as Array<{ beforeCss: string; afterCss: string }>
    const equal = rest.every((v) => v.beforeCss === first.beforeCss && v.afterCss === first.afterCss)
    if (!equal) continue
    for (const p of parts) out.delete(p)
    out.set(into, first)
  }
  return out
}

function measureComputed(el: TaggedElement, props: Iterable<string>): Map<string, string> {
  const computed = getComputedStyle(el)
  const out = new Map<string, string>()
  for (const prop of props) out.set(prop, computed.getPropertyValue(prop))
  return out
}

export function cssPath(start: TaggedElement): string {
  const parts: string[] = []
  let el: Element | null = start
  let depth = 0
  while (el && depth < 4) {
    const tag = el.tagName.toLowerCase()
    if (el.id) {
      parts.unshift(`${tag}#${el.id}`)
      break
    }
    const parent: Element | null = el.parentElement
    if (parent) {
      const siblings = [...parent.children].filter((c) => c.tagName === el!.tagName)
      const index = siblings.indexOf(el) + 1
      parts.unshift(siblings.length > 1 ? `${tag}:nth-of-type(${index})` : tag)
    } else {
      parts.unshift(tag)
    }
    el = parent
    depth++
  }
  return parts.join(' > ')
}

export function buildChangeRequestWithElements(
  drafts: DraftStore,
  theme: Theme = readTheme()
): { request: ChangeRequest; elements: Map<TaggedElement, ElementChange> } {
  const elementList: ElementChange[] = []
  const elements = new Map<TaggedElement, ElementChange>()

  for (const [el, props] of drafts.entries()) {
    if (!el.isConnected) continue

    const wasComparing = drafts.isComparing(el)
    const inlineTransition = el.style.getPropertyValue('transition')
    el.style.setProperty('transition', 'none')

    let raw: Map<string, { beforeCss: string; afterCss: string }>
    try {
      // measure "after" (drafted) computed values
      if (wasComparing) drafts.compare(el, false)
      const afterCss = measureComputed(el, props.keys())

      // measure "before" (original) computed values
      drafts.compare(el, true)
      const beforeCss = measureComputed(el, props.keys())

      raw = new Map<string, { beforeCss: string; afterCss: string }>()
      for (const [prop, draft] of props) {
        // A drafted layout keyword (e.g. 'auto' for Hug width/height) never round-trips through
        // the computed style — getComputedStyle resolves it to a px measurement, which would
        // silently invert the user's intent (Hug -> a hardcoded px). Pass such keywords through
        // verbatim as the "after" value; "before" stays a real measurement. Restricted to an
        // explicit allowlist (KEYWORD_PASSTHROUGH) rather than a keyword-shape regex, so that
        // color keywords like 'red' are NOT passed through — those must be measured, since
        // getComputedStyle legitimately resolves them to 'rgb(...)'.
        const isKeyword = KEYWORD_PASSTHROUGH.has(draft.value.toLowerCase())
        raw.set(prop, {
          beforeCss: beforeCss.get(prop)!,
          afterCss: isKeyword ? draft.value : afterCss.get(prop)!,
        })
      }
      drafts.compare(el, wasComparing)
    } finally {
      if (inlineTransition) el.style.setProperty('transition', inlineTransition)
      else el.style.removeProperty('transition')
    }

    const className = typeof el.className === 'string' ? el.className : [...el.classList].join(' ')
    const changes: ChangeItem[] = []
    for (const [property, v] of collapse(raw)) {
      const suggestion = suggestUtility(property, v.afterCss, theme)
      changes.push({
        property,
        beforeCss: v.beforeCss,
        afterCss: v.afterCss,
        beforeUtility: theme.spacingBasePx === null ? null : findExistingUtility(className, property),
        afterUtility: suggestion?.utility ?? null,
        tokenExact: suggestion?.tokenExact ?? false,
      })
    }

    const elementChange: ElementChange = {
      tag: el.tagName.toLowerCase(),
      source: el.dataset.dcSource ? parseSourceAttr(el.dataset.dcSource) : null,
      className,
      text: (el.textContent ?? '').replace(/[`]/g, '').replace(/\s+/g, ' ').trim().slice(0, 80),
      selector: cssPath(el),
      changes,
    }
    elementList.push(elementChange)
    elements.set(el, elementChange)
  }

  const request: ChangeRequest = {
    id: crypto.randomUUID(),
    createdAt: new Date().toISOString(),
    viewport: { width: window.innerWidth, height: window.innerHeight },
    tailwind: theme.spacingBasePx !== null,
    elements: elementList,
  }

  return { request, elements }
}

export function buildChangeRequest(drafts: DraftStore, theme: Theme = readTheme()): ChangeRequest {
  return buildChangeRequestWithElements(drafts, theme).request
}

export function renderMarkdown(req: ChangeRequest): string {
  const lines: string[] = []
  lines.push('# Design change request')
  lines.push('')
  lines.push(
    `Apply the following visual edits EXACTLY as specified. Do not restyle anything else. Drafted at viewport ${req.viewport.width}×${req.viewport.height}.`
  )
  lines.push('')

  req.elements.forEach((el, i) => {
    const loc = el.source ? `${el.source.file}:${el.source.line}:${el.source.col}` : '(no source tag — locate by selector/text)'
    lines.push(`## ${i + 1}. <${el.tag}> — ${loc}`)
    if (el.text) lines.push(`Text: "${el.text}"`)
    if (el.className) lines.push(`Current classes: \`${el.className}\``)
    lines.push('')
    for (const c of el.changes) {
      if (c.beforeCss === c.afterCss) continue // no-op — nothing actually changed
      let line = `- ${c.property}: ${c.beforeCss} → ${c.afterCss}`
      if (c.afterUtility) {
        line += c.beforeUtility
          ? ` — change \`${c.beforeUtility}\` → \`${c.afterUtility}\``
          : ` — add \`${c.afterUtility}\``
        line += c.tokenExact ? '' : ' (off the token scale — arbitrary value; double-check intent)'
      }
      lines.push(line)
    }
    lines.push('')
  })

  lines.push('Scope: apply to this call site only. If a change would modify a shared component rendered elsewhere, pause and confirm first.')
  lines.push('After applying, verify each computed value matches the "after" value.')
  return lines.join('\n')
}
