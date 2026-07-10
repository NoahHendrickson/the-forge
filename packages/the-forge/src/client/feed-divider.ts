/** sessionStorage key the feed split (feedSlot's dragged px height) persists under. */
export const FEED_SPLIT_KEY = 'the-forge:feed-split'

export interface FeedDividerHandle {
  /** The divider element itself — Panel appends it into root between body and feedSlot. */
  el: HTMLElement
  /**
   * Current feed area height in px (feedSlot's inline flex-basis), or -1 when still on
   * the CSS default (`.panel-feed-slot`'s 45% flex-basis — no inline override yet because
   * neither a drag nor a restored persisted value has happened). -1 rather than a
   * computed px number because jsdom (and a not-yet-laid-out real panel) has no reliable
   * height to compute a percentage against; callers that need a concrete px figure should
   * drag first.
   */
  feedSplit(): number
}

/** Installs the panel↔chat drag handle between the properties body and the SessionFeed's
 * feedSlot (composer-consolidation Task 4; extracted out of Panel by the feed-divider
 * extraction review round — Nitro finding 1) — mirrors resizeHandle's (dock.ts) house pattern
 * (pointerdown arms document-level move/up, disarmed on up/cancel — zero idle listeners) but
 * drives feedSlot's flex-basis (vertical split) rather than the whole panel's width, and lives
 * here rather than in Dock since it only redistributes space WITHIN the panel. Restores any
 * persisted split against `feedSlot` immediately (before returning) so a fresh Panel picks up
 * where a previous session left off — same restore-on-construct timing the old Panel
 * constructor did inline. */
export function installFeedDivider(opts: { feedSlot: HTMLElement; root: HTMLElement; storage: Storage }): FeedDividerHandle {
  const { feedSlot, root, storage } = opts
  const el = document.createElement('div')
  el.className = 'feed-divider'

  function feedSplit(): number {
    const basis = feedSlot.style.flexBasis
    if (!basis || !basis.endsWith('px')) return -1
    const value = parseInt(basis, 10)
    return Number.isFinite(value) ? value : -1
  }

  /** Reads+validates the persisted split; null on absent/corrupt/disabled storage — the
   * caller's job is deciding what "null" means (constructor: stay on the CSS default). */
  function readFeedSplit(): number | null {
    try {
      const raw = storage.getItem(FEED_SPLIT_KEY)
      if (raw === null) return null
      const value = parseInt(raw, 10)
      return Number.isFinite(value) && value > 0 ? value : null
    } catch {
      // Storage disabled/blocked (privacy modes) — fall back to the CSS default, never throw.
      return null
    }
  }

  function saveFeedSplit(value: number): void {
    try {
      storage.setItem(FEED_SPLIT_KEY, String(Math.round(value)))
    } catch {
      // Persistence is a nicety — a full/blocked storage must never break a drag.
    }
  }

  const onFeedDragStart = (e: PointerEvent): void => {
    if (e.button !== 0) return // primary button only — a right-click must not start a drag
    e.preventDefault()
    const startY = e.clientY
    const panelHeight = root.getBoundingClientRect().height
    // Entering the drag from the CSS default (feedSplit() === -1) has no px figure to
    // start from yet — seed it from the same 45% the CSS default paints, so the first
    // pixel of movement continues smoothly from where the divider visually was.
    const startHeight = feedSplit() === -1 ? panelHeight * 0.45 : feedSplit()
    const minSplit = 120
    const maxSplit = Math.max(minSplit, panelHeight - 120)
    let current = Math.min(maxSplit, Math.max(minSplit, startHeight))
    // Document-level (not window, unlike resizeHandle's onResizeStart in dock.ts) per the
    // composer-consolidation Task 4 contract — armed only for the drag's duration, same
    // zero-idle-listeners discipline. No setPointerCapture — jsdom doesn't implement it,
    // and document listeners cover the pointer leaving the handle anyway.
    const onMove = (ev: PointerEvent): void => {
      // Divider sits ABOVE feedSlot: dragging it UP (clientY decreases) grows the feed
      // area below it, dragging it DOWN shrinks it — hence the subtraction of delta.
      const delta = ev.clientY - startY
      current = Math.min(maxSplit, Math.max(minSplit, startHeight - delta))
      feedSlot.style.flexBasis = `${current}px`
    }
    const onUp = (): void => {
      document.removeEventListener('pointermove', onMove)
      document.removeEventListener('pointerup', onUp)
      document.removeEventListener('pointercancel', onUp)
      saveFeedSplit(current)
    }
    document.addEventListener('pointermove', onMove)
    document.addEventListener('pointerup', onUp)
    document.addEventListener('pointercancel', onUp)
  }

  const onFeedDividerReset = (): void => {
    feedSlot.style.flexBasis = ''
    try {
      storage.removeItem(FEED_SPLIT_KEY)
    } catch {
      // Storage disabled/blocked — the inline style reset above still lands.
    }
  }

  el.addEventListener('pointerdown', onFeedDragStart)
  el.addEventListener('dblclick', onFeedDividerReset)

  const restoredSplit = readFeedSplit()
  if (restoredSplit !== null) feedSlot.style.flexBasis = `${restoredSplit}px`

  return { el, feedSplit }
}
