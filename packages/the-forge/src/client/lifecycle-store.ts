import type { SentChange } from './lifecycle'
import type { ElementChange } from './request'
import type { TaggedElement } from './source'

export const LIFECYCLE_KEY = 'the-forge:lifecycle'

export interface PersistedSentElement {
  dcSource: string | null
  /** Position among querySelectorAll('[data-dc-source="..."]') matches at save time — one
   * source location can render many DOM instances (list items); locate() alone would always
   * resolve the FIRST. */
  index: number
  /** Tag name for a detached placeholder when the element can't be re-located — the verifier's
   * locate() falls back to a dcSource lookup for any disconnected element, so a placeholder
   * self-heals once the element re-appears. */
  tag: string
  draftProps: string[]
  changes: SentChange[]
  change: ElementChange
}

export interface PersistedLifecycle {
  v: 1
  designModeOn: boolean
  selection: Array<{ dcSource: string; index: number }>
  drafts: Array<{ dcSource: string; index: number; props: Array<[prop: string, value: string]> }>
  sent: Array<{ id: string; elements: PersistedSentElement[] }>
}

function matches(dcSource: string, doc: Document): TaggedElement[] {
  // dcSource is our own file:line:col format — no quotes/backslashes — but escape anyway so a
  // hostile attribute value can't break out of the selector string.
  const escaped = dcSource.replace(/["\\]/g, '\\$&')
  return [...doc.querySelectorAll<TaggedElement>(`[data-dc-source="${escaped}"]`)]
}

export function sourceIndex(el: Element, dcSource: string, doc: Document = document): number {
  const i = matches(dcSource, doc).indexOf(el as TaggedElement)
  return i === -1 ? 0 : i
}

export function locateBySource(dcSource: string, index: number, doc: Document = document): TaggedElement | null {
  const els = matches(dcSource, doc)
  return els[index] ?? els[0] ?? null
}

/** THE canonical resolver for "re-find a disconnected element" — every call site that used to
 * hand-roll its own connected-check + dcSource fallback (verifier.locate(), changelist.ts
 * healPlaceholders()) now delegates here, so the precedence rule lives in exactly one place.
 * Precedence: a still-connected `el` wins outright (cheapest, and the most trustworthy — it's
 * literally the node in question); otherwise fall back to locateBySource's index-then-first-
 * match lookup by dcSource; otherwise null (untagged or truly gone). */
export function resolveElement(
  el: TaggedElement | null,
  dcSource: string | null,
  index: number,
  doc: Document = document
): TaggedElement | null {
  if (el && el.isConnected) return el
  if (!dcSource) return null
  return locateBySource(dcSource, index, doc)
}

export function saveLifecycle(state: PersistedLifecycle, storage: Storage = sessionStorage): void {
  try {
    storage.setItem(LIFECYCLE_KEY, JSON.stringify(state))
  } catch {
    // Persistence is a nicety — quota/privacy-mode failures must never break an edit session.
  }
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null
}

function isValidSelectionEntry(v: unknown): v is { dcSource: string; index: number } {
  return isRecord(v) && typeof v.dcSource === 'string' && typeof v.index === 'number'
}

function isValidDraftEntry(v: unknown): v is PersistedLifecycle['drafts'][number] {
  if (!isRecord(v)) return false
  if (typeof v.dcSource !== 'string' || typeof v.index !== 'number') return false
  if (!Array.isArray(v.props)) return false
  return v.props.every(
    (p) => Array.isArray(p) && p.length === 2 && typeof p[0] === 'string' && typeof p[1] === 'string'
  )
}

function isValidSentChange(v: unknown): v is SentChange {
  return isRecord(v) && typeof v.property === 'string' && typeof v.afterCss === 'string'
}

/** Restored ops are METHOD-CALLED, not just displayed — summarizeOp does `op.after.replace`
 * (changelist.ts) and the verifier's text branch does `op.after.slice` — so a malformed op is
 * a crash, not a glitch: the first ChangeList.render() after restore would throw, and boot's
 * defense-in-depth catch can't contain it (its setActive(false) teardown re-renders and
 * re-throws). Unknown kinds fail CLOSED: a future plugin version writing new op kinds under
 * the same v:1 key, read back by a stale cached client bundle, must drop per-item — the
 * module's own convention — not take down the whole restored session (PR #44 review). */
function isValidStructuralOp(v: unknown): boolean {
  if (!isRecord(v)) return false
  if (v.kind === 'delete') return true
  if (v.kind === 'text') return typeof v.before === 'string' && typeof v.after === 'string'
  return false
}

/** `change` (the full ElementChange payload) is only shallow-checked here — it's a big nested
 * shape owned by request.ts, and the fields this module actually reads back out (tag/source/
 * changes array) are what would break a restore. A malformed nested ChangeItem inside
 * `change.changes` is cosmetic (a row summary glitch), not a crash risk, so it's deliberately
 * not walked field-by-field — that's the line between "boundary validation" and reimplementing
 * request.ts's own types here. `change.ops` is the exception: its fields are method-called on
 * restore (see isValidStructuralOp), so it IS walked. */
function isValidElementChange(v: unknown): v is ElementChange {
  if (!isRecord(v)) return false
  if (typeof v.tag !== 'string' || typeof v.selector !== 'string') return false
  // source is SourceLocation | null (request.ts) — an untagged element (no data-dc-source)
  // persists source: null, and renderMarkdown already handles that case by falling back to
  // selector/text. Rejecting null here used to silently drop the whole sent entry.
  if (v.source !== null && (!isRecord(v.source) || typeof v.source.file !== 'string')) return false
  if (!Array.isArray(v.changes)) return false
  if (v.ops !== undefined && (!Array.isArray(v.ops) || !v.ops.every(isValidStructuralOp))) return false
  return true
}

function isValidSentElement(v: unknown): v is PersistedSentElement {
  if (!isRecord(v)) return false
  if (typeof v.dcSource !== 'string' && v.dcSource !== null) return false
  if (typeof v.index !== 'number' || typeof v.tag !== 'string') return false
  if (!Array.isArray(v.draftProps) || !v.draftProps.every((p) => typeof p === 'string')) return false
  if (!Array.isArray(v.changes) || !v.changes.every(isValidSentChange)) return false
  if (!isValidElementChange(v.change)) return false
  // A persisted `prompt` marks a retired kind:'prompt' send (pre-composer-consolidation
  // sessionStorage) — DROP it here rather than restore it: the prompt request kind is gone,
  // so restoring would resurrect a blank-summary row whose resend queues a no-op request.
  // Per-item drop (see loadLifecycle) keeps the rest of the snapshot intact.
  if (v.prompt !== undefined) return false
  return true
}

/** unknown + manual checks at the I/O boundary — project convention, no schema libs. Validates
 * per ITEM and DROPS invalid items rather than failing the whole state: a single corrupt sent
 * entry (e.g. truncated/edited storage) must not throw away otherwise-good drafts/selection/
 * other sent entries. Only a violation of the top-level shape (v/designModeOn/array-ness)
 * still returns null outright — there's no per-item unit to salvage at that level. */
export function loadLifecycle(storage: Storage = sessionStorage): PersistedLifecycle | null {
  let raw: string | null = null
  try {
    raw = storage.getItem(LIFECYCLE_KEY)
  } catch {
    return null
  }
  if (!raw) return null
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    return null
  }
  if (!isRecord(parsed)) return null
  const s = parsed
  if (s.v !== 1) return null
  if (typeof s.designModeOn !== 'boolean') return null
  if (!Array.isArray(s.selection) || !Array.isArray(s.drafts) || !Array.isArray(s.sent)) return null

  const selection = s.selection.filter(isValidSelectionEntry)
  const drafts = s.drafts.filter(isValidDraftEntry)
  const sent: PersistedLifecycle['sent'] = []
  for (const entry of s.sent) {
    if (!isRecord(entry) || typeof entry.id !== 'string' || !Array.isArray(entry.elements)) continue
    const elements = entry.elements.filter(isValidSentElement)
    if (elements.length === 0) continue // an entry that lost every element carries nothing to restore
    sent.push({ id: entry.id, elements })
  }

  return { v: 1, designModeOn: s.designModeOn, selection, drafts, sent }
}
