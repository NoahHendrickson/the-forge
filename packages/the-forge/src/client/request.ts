import { DraftStore } from './drafts'
import { parseSourceAttr, type SourceLocation, type TaggedElement } from './source'
import { readTheme, readTokens, suggestUtility, findExistingUtility, type Theme } from './tokens'

export interface ChangeItem {
  property: string
  beforeCss: string
  afterCss: string
  beforeUtility: string | null
  afterUtility: string | null
  tokenExact: boolean
  /** Optional plain-language instruction overriding the literal before→after reading — set by the BUILDER (policy lives at construction), rendered generically. */
  intent?: string
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

export const REMOVE_AUTO_LAYOUT_INTENT = 'remove auto layout (flexbox) from this element; remove flex/inline-flex/flex-row/flex-col/flex-wrap/gap-*/justify-*/items-* classes rather than adding `display: block`'

const COLLAPSE: Array<{ into: string; parts: string[] }> = [
  {
    into: 'border-radius',
    parts: ['border-top-left-radius', 'border-top-right-radius', 'border-bottom-right-radius', 'border-bottom-left-radius'],
  },
  { into: 'padding-block', parts: ['padding-top', 'padding-bottom'] },
  { into: 'padding-inline', parts: ['padding-left', 'padding-right'] },
  { into: 'margin-block', parts: ['margin-top', 'margin-bottom'] },
  { into: 'margin-inline', parts: ['margin-left', 'margin-right'] },
  {
    into: 'border-width',
    parts: ['border-top-width', 'border-right-width', 'border-bottom-width', 'border-left-width'],
  },
  {
    into: 'border-style',
    parts: ['border-top-style', 'border-right-style', 'border-bottom-style', 'border-left-style'],
  },
  {
    into: 'border-color',
    parts: ['border-top-color', 'border-right-color', 'border-bottom-color', 'border-left-color'],
  },
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

// `CSS.escape` is universally available in real browsers but some jsdom versions used in
// tests don't expose it as a global — fall back to a minimal spec-compliant escape (per the
// CSSOM spec: escape any char outside [a-zA-Z0-9_-] plus the leading-digit/hyphen-digit rules)
// so the selector stays safe either way.
function escapeCssIdent(value: string): string {
  if (typeof CSS !== 'undefined' && typeof CSS.escape === 'function') return CSS.escape(value)

  let out = value.replace(/[^a-zA-Z0-9_-]/g, (ch) => `\\${ch}`)

  // CSSOM numeric-escape rule: a leading digit, or a leading '-' followed by a digit, cannot be
  // represented as a literal/backslash-escaped character — it must use the \HH (code point hex)
  // escape form, e.g. CSS.escape('0abc') === '\\30 abc'. Without this, `#0abc` is a syntactically
  // invalid selector even though no "special" characters were present to trigger the regex above.
  const leadMatch = /^(-?)([0-9])/.exec(out)
  if (leadMatch) {
    const [, hyphen, digit] = leadMatch
    const hex = digit.codePointAt(0)!.toString(16)
    out = `${hyphen}\\${hex} ${out.slice(hyphen.length + 1)}`
  }

  return out
}

/** Strip backticks + collapse whitespace. Everything this touches is interpolated into
 * `-wrapped code spans in the change-request markdown, and markdown ignores backslash escapes
 * inside code spans — so page-controlled content (e.g. a user-generated class attribute, whose
 * backtick CSS.escape merely backslash-prefixes) could otherwise close the span and inject
 * instruction lines the agent reads as part of the request (2026-07-10 security review).
 * `text` has always had this policy; className/selector get the identical treatment. */
function sanitizeInline(value: string): string {
  return value.replace(/[`]/g, '').replace(/\s+/g, ' ').trim()
}

/** Element identity/context block shared by the precise and prompt builders — tag, source,
 * classes, trimmed text, selector. `changes` is the caller's: measured deltas for the precise
 * flow, always [] for prompts. */
function elementContext(el: TaggedElement, changes: ChangeItem[]): ElementChange {
  const className = typeof el.className === 'string' ? el.className : [...el.classList].join(' ')
  return {
    tag: el.tagName.toLowerCase(),
    source: el.dataset.dcSource ? parseSourceAttr(el.dataset.dcSource) : null,
    className: sanitizeInline(className),
    text: sanitizeInline(el.textContent ?? '').slice(0, 80),
    selector: sanitizeInline(cssPath(el)),
    changes,
  }
}

// Definitions (and their why-comments) moved to src/shared/guardrails.ts so the server's
// Cursor deeplink augmentation can share them without importing client code; SCOPE_GUARDRAIL
// stays re-exported for existing importers.
import { SCOPE_GUARDRAIL, NO_PREVIEW_GUARDRAIL } from '../shared/guardrails'
export { SCOPE_GUARDRAIL }

export function cssPath(start: TaggedElement): string {
  const parts: string[] = []
  let el: Element | null = start
  let depth = 0
  while (el && depth < 4) {
    const tag = el.tagName.toLowerCase()
    if (el.id) {
      parts.unshift(`${tag}#${escapeCssIdent(el.id)}`)
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
  const tokens = readTokens()

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
      // A draft scrubbed back to its original value survives in the DraftStore (apply() keeps
      // it), so it reaches here as a genuine no-op. Dropping it HERE — not just its markdown
      // bullet — keeps empty sections out of the agent's request and lets the caller skip the
      // send entirely when nothing actually changed.
      if (v.beforeCss === v.afterCss) continue
      const suggestion = suggestUtility(property, v.afterCss, theme, tokens)
      const item: ChangeItem = {
        property,
        beforeCss: v.beforeCss,
        afterCss: v.afterCss,
        beforeUtility: theme.spacingBasePx === null ? null : findExistingUtility(className, property),
        afterUtility: suggestion?.utility ?? null,
        tokenExact: suggestion?.tokenExact ?? false,
      }
      // 'display: flex → block' is never the literal ask — it is the panel's deterministic
      // preview of REMOVING auto layout. Stamp the intent here at construction so the agent
      // edits classes (removes the flex family); the renderer prints it without owning policy.
      if (item.property === 'display' && (item.beforeCss === 'flex' || item.beforeCss === 'inline-flex') && item.afterCss === 'block') {
        item.intent = REMOVE_AUTO_LAYOUT_INTENT
      }
      changes.push(item)
    }
    if (changes.length === 0) continue // every drafted property was a no-op — nothing to request

    const elementChange = elementContext(el, changes)
    elementList.push(elementChange)
    elements.set(el, elementChange)
  }

  // No client-side id: the queue item's server-generated id (Queue.add) is the request's one
  // identity everywhere — markdown reminders, mark_applied, /status, the SentRegistry.
  const request: ChangeRequest = {
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
      // Defense-in-depth: buildChangeRequestWithElements already drops no-ops at the source,
      // but renderMarkdown also accepts hand-built ChangeRequests (tests, future callers) —
      // a no-op bullet must never reach the agent regardless of who built the request.
      if (c.beforeCss === c.afterCss) continue
      let line = `- ${c.property}: ${c.beforeCss} → ${c.afterCss}`
      if (c.afterUtility) {
        line += c.beforeUtility
          ? ` — change \`${c.beforeUtility}\` → \`${c.afterUtility}\``
          : ` — add \`${c.afterUtility}\``
        line += c.tokenExact ? '' : ' (off the token scale — arbitrary value; double-check intent)'
      }
      if (c.intent) line += ` — intent: ${c.intent}`
      lines.push(line)
    }
    lines.push('')
  })

  // No scope/no-preview guardrails here (2026-07-10 cost review): queue-delivered markdown
  // always arrives inside an instruction wrapper that already carries them once per delivery
  // (DESIGN_COMMAND/WATCH_COMMAND/PULL_TURN_TEXT/Cursor augmentation — see the placement map
  // in src/shared/guardrails.ts), so repeating them per item was pure token cost. Wrapper-less
  // paths must use renderStandaloneMarkdown below instead.
  return lines.join('\n')
}

/** Markdown + guardrails, for paths where the request travels with NO instruction wrapper of
 * its own — today that's the Copy-for-agent clipboard payload, pasted into an arbitrary agent
 * with no command text in context. Queue-delivered markdown stays lean (see renderMarkdown's
 * closing comment). */
export function renderStandaloneMarkdown(req: ChangeRequest): string {
  return `${renderMarkdown(req)}\n${SCOPE_GUARDRAIL}\n${NO_PREVIEW_GUARDRAIL}`
}

export interface PromptRequest {
  kind: 'prompt'
  createdAt: string
  viewport: { width: number; height: number }
  prompt: string
  elements: ElementChange[]
}

export function buildPromptRequest(
  els: TaggedElement[],
  prompt: string
): { request: PromptRequest; pairs: Array<[TaggedElement, ElementChange]> } {
  const pairs: Array<[TaggedElement, ElementChange]> = els.map((el) => [el, elementContext(el, [])])
  return {
    request: {
      kind: 'prompt',
      createdAt: new Date().toISOString(),
      viewport: { width: window.innerWidth, height: window.innerHeight },
      prompt,
      elements: pairs.map(([, c]) => c),
    },
    pairs,
  }
}

export function renderPromptMarkdown(req: PromptRequest): string {
  const lines: string[] = []
  lines.push('# Design prompt')
  lines.push('')
  lines.push(
    `The user selected the element(s) below in the running app and typed a free-form instruction. Apply it to the identified source location(s). Written at viewport ${req.viewport.width}×${req.viewport.height}.`
  )
  lines.push('')
  req.elements.forEach((el, i) => {
    const loc = el.source ? `${el.source.file}:${el.source.line}:${el.source.col}` : '(no source tag — locate by selector/text)'
    lines.push(`## ${i + 1}. <${el.tag}> — ${loc}`)
    if (el.text) lines.push(`Text: "${el.text}"`)
    if (el.className) lines.push(`Current classes: \`${el.className}\``)
    lines.push(`Selector: \`${el.selector}\``)
    lines.push('')
  })
  lines.push('## Instruction')
  lines.push('')
  lines.push(req.prompt.trim())
  lines.push('')
  lines.push(SCOPE_GUARDRAIL)
  // Unlike renderMarkdown's closing line, this one does NOT say The Forge verifies the result —
  // free-form prompts have no expected computed styles, so nothing is verified (spec: terminal
  // state comes from mark_applied alone). The don't-preview instruction still applies verbatim.
  lines.push('Do not run the app, take screenshots, or preview the result — the user is watching the live app.')
  return lines.join('\n')
}

/** Rebuilds a single-element request + markdown from a failed seed for resend() — the one
 * place that reconstructs the shape `buildChangeRequestWithElements`/`buildPromptRequest`
 * produce fresh, so a future change to either request's fields only needs updating here, not
 * separately in resend(). `seed.prompt !== undefined` is the same mode discriminator used
 * everywhere else a seed is inspected (ChangeList, persistence). */
export function rebuildRequestFromSeed(seed: {
  change: ElementChange
  prompt?: string
}): { request: ChangeRequest | PromptRequest; markdown: string } {
  const viewport = { width: window.innerWidth, height: window.innerHeight }
  if (seed.prompt !== undefined) {
    const request: PromptRequest = {
      kind: 'prompt',
      createdAt: new Date().toISOString(),
      viewport,
      prompt: seed.prompt,
      elements: [seed.change],
    }
    return { request, markdown: renderPromptMarkdown(request) }
  }
  const request: ChangeRequest = {
    createdAt: new Date().toISOString(),
    viewport,
    tailwind: readTheme().spacingBasePx !== null,
    elements: [seed.change],
  }
  return { request, markdown: renderMarkdown(request) }
}
