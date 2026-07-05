import type { TaggedElement } from './source'

/** One sent property delta — named once so SentEntry and isDuplicate can't drift apart. */
export interface SentChange {
  property: string
  afterCss: string
}

export interface SentEntry {
  id: string
  elements: Array<{
    el: TaggedElement
    dcSource: string | null
    /** Position among querySelectorAll('[data-dc-source="..."]') matches at send time — passed
     * through to lifecycle-store's resolveElement() so re-locating a disconnected element picks
     * the SAME list instance, not always the first match. Optional and defaults to 0 so existing
     * construction sites (and tests) that never set it keep compiling and behaving exactly as
     * before — first-match was already the historical fallback. */
    index?: number
    /** the DraftStore's actual keys for this element at send time — used for targeted commit,
     * since `changes` may use collapsed shorthand property names (see COLLAPSE in request.ts)
     * that don't match any DraftStore key. */
    draftProps: string[]
    changes: SentChange[]
  }>
}

