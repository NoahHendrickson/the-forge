// Row builders for the session feed (extracted from session-feed.ts in the 2026-07-18
// chat-ux polish — same seam as composer-config.ts/feed-anchor.ts: presentation, not
// stream state, and session-feed.ts must stay under 1k lines). Everything here builds a
// detached element; session-feed.ts owns insertion, the MAX_ROWS cap, and the anchor
// spacer. CSS class names are test hooks — extend, don't rename.
import { basename } from './source'
import { renderMarkdown } from './chat-markdown'
import { AGENT_DISPLAY_NAME } from './agent'
import { isHarnessId } from '../shared/chat-constants'

export interface EditPayload {
  file: string
  before: string
  after: string
}

// ---------------------------------------------------------------------------
// Diff disclosure
// ---------------------------------------------------------------------------

/** Multiset line comparison — how many lines of `after` aren't in `before` (added) and
 * vice versa (removed). Deliberately not a real LCS diff: the numbers head a collapsed
 * disclosure whose body shows the full before/after anyway, so "roughly right at zero
 * dependencies" beats shipping a diff engine for a summary chip (Cursor's edit cards
 * carry the same +N −M shape). */
export function diffStats(before: string, after: string): { added: number; removed: number } {
  const counts = new Map<string, number>()
  for (const line of before.split('\n')) counts.set(line, (counts.get(line) ?? 0) + 1)
  let added = 0
  for (const line of after.split('\n')) {
    const n = counts.get(line) ?? 0
    if (n > 0) counts.set(line, n - 1)
    else added++
  }
  let removed = 0
  for (const n of counts.values()) removed += n
  return { added, removed }
}

// Hand-rolled before/after disclosure — no diff library. Collapsed by default (native
// <details> behavior); summary is the basename so long paths don't blow out the row, now
// joined by +N/−M line-delta chips (chat-ux polish) so a collapsed row still says how big
// the edit was. One builder for both attachment points: rows opened WITH a diff
// (tool-started, Claude) and rows upgraded later (tool-finished, Cursor's terminal
// tool_call_update).
export function makeDiffDetails(edit: EditPayload): HTMLElement {
  const details = document.createElement('details')
  details.className = 'session-diff'
  const summary = document.createElement('summary')
  const file = document.createElement('span')
  file.className = 'diff-file'
  file.textContent = basename(edit.file)
  summary.append(file)
  const { added, removed } = diffStats(edit.before, edit.after)
  if (added > 0) {
    const add = document.createElement('span')
    add.className = 'diff-stat-add'
    add.textContent = `+${added}`
    summary.append(add)
  }
  if (removed > 0) {
    const del = document.createElement('span')
    del.className = 'diff-stat-del'
    del.textContent = `−${removed}`
    summary.append(del)
  }
  const before = document.createElement('pre')
  before.className = 'diff-before'
  before.textContent = edit.before
  const after = document.createElement('pre')
  after.className = 'diff-after'
  after.textContent = edit.after
  details.append(summary, before, after)
  return details
}

// ---------------------------------------------------------------------------
// Tool rows
// ---------------------------------------------------------------------------

// 12×12 stroke icons, one per tool CATEGORY (matched on the tool name, which is
// harness-specific free text — 'Edit'/'edit_file'/'Write' all mean the pencil). Static
// trusted strings, so the innerHTML here never carries model output. The fallback is the
// gear — "some tool ran" — never blank.
const ICON_PATHS: ReadonlyArray<[RegExp, string]> = [
  [/edit|write|apply|patch|create/i, 'M9.06 1.94a1.5 1.5 0 0 1 2.12 2.12L4.5 10.75l-2.75.63.63-2.75z'],
  [/read|open|cat|view/i, 'M3 1.5h4.5L10.5 4v6.5a1 1 0 0 1-1 1h-6.5a1 1 0 0 1-1-1v-8a1 1 0 0 1 1-1zM7.5 1.5V4H10'],
  [/bash|terminal|run|exec|command|shell/i, 'M2.5 3.5l3 2.5-3 2.5M6.5 9h3'],
  [/search|grep|glob|find|list|ls/i, 'M5.25 8.5a3.25 3.25 0 1 0 0-6.5 3.25 3.25 0 0 0 0 6.5zM7.75 7.75l2.75 2.75'],
  [/web|fetch|http|browse|url/i, 'M6 10.5a4.5 4.5 0 1 0 0-9 4.5 4.5 0 0 0 0 9zM1.5 6h9M6 1.5c1.5 1.5 1.5 7.5 0 9c-1.5-1.5-1.5-7.5 0-9z'],
  [/todo|task|plan/i, 'M2.5 6l2 2 5-5'],
]
const ICON_FALLBACK =
  'M6 7.75a1.75 1.75 0 1 0 0-3.5 1.75 1.75 0 0 0 0 3.5zM6 1.5v1.25M6 9.25v1.25M1.5 6h1.25M9.25 6h1.25M2.8 2.8l.9.9M8.3 8.3l.9.9M9.2 2.8l-.9.9M3.7 8.3l-.9.9'

function toolIcon(name: string): HTMLElement {
  const span = document.createElement('span')
  span.className = 'tool-icon'
  span.setAttribute('aria-hidden', 'true')
  const path = ICON_PATHS.find(([re]) => re.test(name))?.[1] ?? ICON_FALLBACK
  span.innerHTML = `<svg viewBox="0 0 12 12" fill="none" stroke="currentColor" stroke-width="1.2" stroke-linecap="round" stroke-linejoin="round"><path d="${path}"/></svg>`
  return span
}

export function makeToolRow(toolId: string, name: string, detail: string, edit?: EditPayload): HTMLElement {
  const row = document.createElement('div')
  row.className = 'session-row session-tool-row'
  row.dataset.toolId = toolId
  const label = document.createElement('span')
  label.className = 'tool-name'
  label.textContent = name
  const detailSpan = document.createElement('span')
  detailSpan.className = 'tool-detail'
  detailSpan.textContent = detail
  detailSpan.title = detail
  const spinner = document.createElement('span')
  spinner.className = 'session-spinner'
  // Braille glyph, CSS-rotated while running; tool-finished flips this to ✓ (and adds
  // .done / .tool-done) by matching toolId — see session-feed.ts's tool-finished handler.
  spinner.textContent = '⣋'
  row.append(toolIcon(name), label, detailSpan, spinner)
  if (edit) {
    row.append(makeDiffDetails(edit))
  }
  return row
}

// ---------------------------------------------------------------------------
// Bubbles + status rows
// ---------------------------------------------------------------------------

export function makeAssistantBubble(text: string): HTMLElement {
  // Full text, no truncation — unlike the old snippet row, chat bubbles show the whole
  // message (the panel scrolls instead). Rendered as markdown (chat-ux polish) — see
  // chat-markdown.ts for the safety posture; session-feed.ts re-renders streaming bubbles
  // through setAssistantContent below on every delta.
  const row = document.createElement('div')
  row.className = 'session-row chat-msg chat-assistant'
  row.append(renderMarkdown(text))
  return row
}

/** Streaming re-render: replaces a live bubble's children with a fresh markdown pass over
 * the full accumulated text. Cheap relative to token cadence, and the only way partially
 * streamed block syntax (an open fence, a half-typed list) settles into its final shape. */
export function setAssistantContent(bubble: HTMLElement, text: string): void {
  bubble.replaceChildren(renderMarkdown(text))
}

export function makeUserBubble(text: string, element?: Record<string, unknown>): HTMLElement {
  const row = document.createElement('div')
  row.className = 'session-row chat-msg chat-user'
  // User text stays PLAIN (no markdown) — every reference product renders the user's own
  // words verbatim; pre-wrap on .chat-msg preserves their line breaks.
  row.append(document.createTextNode(text))
  if (element) {
    const source = typeof element.source === 'string' ? element.source : ''
    const tag = typeof element.tag === 'string' ? element.tag : ''
    if (source || tag) {
      const ref = document.createElement('div')
      ref.className = 'chat-msg-ref'
      ref.textContent = [tag, source].filter(Boolean).join(' · ')
      row.append(ref)
    }
  }
  return row
}

/** The "Thinking" placeholder shown between a user send and the first sign of activity
 * (chat-ux polish) — the dead-air gap ChatGPT/Claude fill with a shimmer. Ephemeral
 * chrome, not history: session-feed.ts keeps it out of the MAX_ROWS bookkeeping and
 * removes it on the next event. */
export function makeWorkingRow(): HTMLElement {
  const row = document.createElement('div')
  row.className = 'session-row chat-working'
  const label = document.createElement('span')
  label.textContent = 'Thinking'
  const dots = document.createElement('span')
  dots.className = 'chat-working-dots'
  dots.setAttribute('aria-hidden', 'true')
  for (let i = 0; i < 3; i++) {
    const dot = document.createElement('span')
    dot.className = 'chat-working-dot'
    dots.append(dot)
  }
  row.append(label, dots)
  return row
}

/** Clean-turn completion marker: `✓ Done · $0.012` (cost only when the event carried
 * one — Claude Code prints per-turn cost, Cursor draws a checkpoint line; error turns
 * render an error row instead and never get this). */
export function makeTurnDoneRow(costUsd?: number): HTMLElement {
  const row = document.createElement('div')
  row.className = 'session-row turn-done'
  const check = document.createElement('span')
  check.className = 'turn-done-check'
  check.textContent = '✓'
  const label = document.createElement('span')
  label.textContent = 'Done'
  row.append(check, label)
  if (typeof costUsd === 'number' && Number.isFinite(costUsd) && costUsd > 0) {
    const cost = document.createElement('span')
    cost.className = 'turn-done-cost'
    cost.textContent = `· $${costUsd.toFixed(costUsd < 0.1 ? 3 : 2)}`
    row.append(cost)
  }
  return row
}

export function makeErrorRow(text: string): HTMLElement {
  const row = document.createElement('div')
  row.className = 'session-row session-error-row'
  // The message rides a span so the card CSS can wrap it independently; the ⚠ glyph is a
  // CSS ::before on the row, deliberately NOT a DOM node — host-side tests pin the row's
  // exact textContent, and the icon is presentation, not content.
  const label = document.createElement('span')
  label.className = 'error-text'
  label.textContent = text
  row.append(label)
  return row
}

export function makeConfigRow(e: Record<string, unknown>): HTMLElement {
  const parts: string[] = []
  // Renders the harness's DISPLAY NAME (AGENT_DISPLAY_NAME), not the wire id — same rule as
  // the watch strip's "Linked to Claude Code" copy, never the raw 'claude-code'/'cursor'.
  if (isHarnessId(e.harness)) parts.push(`harness → ${AGENT_DISPLAY_NAME[e.harness]}`)
  if (typeof e.model === 'string') parts.push(`model → ${e.model}`)
  if (typeof e.permissionMode === 'string') parts.push(`permissions → ${e.permissionMode}`)
  if (typeof e.effort === 'string') parts.push(`effort → ${e.effort}`)
  const row = document.createElement('div')
  row.className = 'session-row session-config'
  row.textContent = parts.join(' · ')
  return row
}
