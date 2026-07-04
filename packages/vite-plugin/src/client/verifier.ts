import type { SentEntry } from './sent'
import { SentRegistry } from './sent'
import type { DraftStore } from './drafts'
import type { TaggedElement } from './source'

const POLL_MS = 2000

/**
 * Units: `verified` and `missing` are per-element counts (how many elements in the
 * entry fully matched, or could not be located). `mismatched` is per-property — a
 * single element with three drafted properties that all fail to match contributes
 * three entries here, not one.
 */
export interface VerifyResult {
  verified: number
  mismatched: Array<{ property: string; expected: string; actual: string }>
  missing: number
}

function locate(el: TaggedElement, dcSource: string | null, doc: Document): TaggedElement | null {
  if (el.isConnected) return el
  if (!dcSource) return null
  return doc.querySelector<TaggedElement>(`[data-dc-source="${dcSource}"]`)
}

/** Per-element verification outcome, used to decide whether that element's drafts can be committed. */
interface ElementVerification {
  el: TaggedElement
  /** properties this entry sent for this element — the only ones eligible for a targeted commit */
  properties: string[]
  verified: number
  mismatched: Array<{ property: string; expected: string; actual: string }>
  missing: number
}

function verifyElements(entry: SentEntry, doc: Document = document): ElementVerification[] {
  return entry.elements.map((el) => {
    const properties = el.changes.map((c) => c.property)
    const target = locate(el.el, el.dcSource, doc)
    if (!target) return { el: el.el, properties, verified: 0, mismatched: [], missing: el.changes.length }

    // Neutralize the draft's inline styles before measuring — inline styles win the
    // cascade, so if the sent draft is still applied as inline style (e.g. the DOM
    // node survived Fast Refresh), getComputedStyle would just read back what WE put
    // there, reporting "implemented" even if the underlying code never adopted the
    // value. Stash and strip each sent property (plus transition, to avoid measuring
    // mid-transition values), measure, then restore in a finally.
    const inlineTransition = target.style.getPropertyValue('transition')
    target.style.setProperty('transition', 'none')
    const stashed = new Map<string, string>()
    for (const change of el.changes) {
      stashed.set(change.property, target.style.getPropertyValue(change.property))
      target.style.removeProperty(change.property)
    }

    const mismatched: ElementVerification['mismatched'] = []
    let verified = 0
    try {
      const computed = getComputedStyle(target)
      for (const change of el.changes) {
        const actual = computed.getPropertyValue(change.property).trim()
        const expected = change.afterCss.trim()
        if (actual === expected) verified++
        else mismatched.push({ property: change.property, expected, actual })
      }
    } finally {
      for (const [prop, value] of stashed) {
        if (value) target.style.setProperty(prop, value)
        else target.style.removeProperty(prop)
      }
      if (inlineTransition) target.style.setProperty('transition', inlineTransition)
      else target.style.removeProperty('transition')
    }

    return { el: el.el, properties, verified, mismatched, missing: 0 }
  })
}

export function verifyEntry(entry: SentEntry, doc: Document = document): VerifyResult {
  const result: VerifyResult = { verified: 0, mismatched: [], missing: 0 }
  for (const ev of verifyElements(entry, doc)) {
    result.verified += ev.verified
    result.mismatched.push(...ev.mismatched)
    result.missing += ev.missing
  }
  return result
}

interface Counters {
  implemented: number
  mismatch: number
  unverified: number
  failed: number
}

function renderSummary(counters: Counters, pending = 0): string {
  const parts: string[] = []
  if (pending > 0) parts.push(`${pending} applying…`)
  if (counters.implemented) parts.push(`${counters.implemented} implemented ✓`)
  if (counters.mismatch) parts.push(`${counters.mismatch} mismatch ⚠`)
  if (counters.unverified) parts.push(`${counters.unverified} applied (unverified)`)
  if (counters.failed) parts.push(`${counters.failed} failed ✗`)
  return parts.join(' · ')
}

export class Verifier {
  private counters: Counters = { implemented: 0, mismatch: 0, unverified: 0, failed: 0 }
  private timer: ReturnType<typeof setInterval> | null = null

  constructor(
    private sent: SentRegistry,
    private drafts: DraftStore,
    private onUpdate: (summary: string) => void
  ) {}

  start(): void {
    if (this.timer) return
    if (this.sent.size() === 0) return
    this.timer = setInterval(() => {
      this.poll()
    }, POLL_MS)
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer)
    this.timer = null
  }

  private poll(): void {
    const ids = this.sent.pendingIds()
    if (ids.length === 0) {
      this.stop()
      return
    }
    fetch(`/__the-forge/status?ids=${ids.join(',')}`)
      .then((res) => (res.ok ? res.json() : { items: [] }))
      .then((body: { items: Array<{ id: string; status: string; note: string | null }> }) => {
        for (const item of body.items) {
          if (item.status === 'applied') this.handleApplied(item.id)
          else if (item.status === 'failed') this.handleFailed(item.id)
        }
        if (this.sent.size() === 0) this.stop()
        this.onUpdate(renderSummary(this.counters, this.sent.size()))
      })
      .catch(() => {
        // transient network errors during polling are silently retried next tick
      })
  }

  private handleApplied(id: string): void {
    const entry = this.sent.take(id)
    if (!entry) return
    // decide per-element: only commit drafts for an element whose changes ALL
    // matched computed style — a mismatched element keeps its drafts so the
    // user can retry or adjust rather than silently losing the edit.
    for (const ev of verifyElements(entry)) {
      if (ev.missing > 0) {
        this.counters.unverified += 1
      } else if (ev.mismatched.length > 0) {
        this.counters.mismatch += 1
      } else {
        this.drafts.commit(ev.el, ev.properties)
        this.counters.implemented += 1
      }
    }
  }

  private handleFailed(id: string): void {
    const entry = this.sent.take(id)
    if (!entry) return
    this.counters.failed += 1
  }
}
