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
  changes: ChangeItem[]
}

export interface ChangeRequest {
  viewport: { width: number; height: number }
  tailwind: boolean
  elements: ElementChange[]
}

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

export function buildChangeRequest(drafts: DraftStore, theme: Theme = readTheme()): ChangeRequest {
  const elements: ElementChange[] = []

  for (const [el, props] of drafts.entries()) {
    const wasComparing = drafts.isComparing(el)

    // measure "after" (drafted) computed values
    if (wasComparing) drafts.compare(el, false)
    const afterComputed = getComputedStyle(el)
    const afterCss = new Map<string, string>()
    for (const prop of props.keys()) afterCss.set(prop, afterComputed.getPropertyValue(prop))

    // measure "before" (original) computed values
    drafts.compare(el, true)
    const beforeComputed = getComputedStyle(el)
    const raw = new Map<string, { beforeCss: string; afterCss: string }>()
    for (const prop of props.keys()) {
      raw.set(prop, {
        beforeCss: beforeComputed.getPropertyValue(prop),
        afterCss: afterCss.get(prop)!,
      })
    }
    drafts.compare(el, wasComparing)

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

    elements.push({
      tag: el.tagName.toLowerCase(),
      source: el.dataset.dcSource ? parseSourceAttr(el.dataset.dcSource) : null,
      className,
      text: (el.textContent ?? '').replace(/[`]/g, '').replace(/\s+/g, ' ').trim().slice(0, 80),
      changes,
    })
  }

  return {
    viewport: { width: window.innerWidth, height: window.innerHeight },
    tailwind: theme.spacingBasePx !== null,
    elements,
  }
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
