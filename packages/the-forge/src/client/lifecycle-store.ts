import type { SentChange } from './sent'
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

export function saveLifecycle(state: PersistedLifecycle, storage: Storage = sessionStorage): void {
  try {
    storage.setItem(LIFECYCLE_KEY, JSON.stringify(state))
  } catch {
    // Persistence is a nicety — quota/privacy-mode failures must never break an edit session.
  }
}

/** unknown + manual checks at the I/O boundary — project convention, no schema libs. Any
 * shape violation returns null (start clean), same posture as dock.ts loadPrefs(). */
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
  if (typeof parsed !== 'object' || parsed === null) return null
  const s = parsed as Record<string, unknown>
  if (s.v !== 1) return null
  if (typeof s.designModeOn !== 'boolean') return null
  if (!Array.isArray(s.selection) || !Array.isArray(s.drafts) || !Array.isArray(s.sent)) return null
  return parsed as PersistedLifecycle
}
