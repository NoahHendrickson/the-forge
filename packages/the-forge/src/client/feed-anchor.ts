/**
 * FeedAnchor — single owner of the feed's anchor-at-top invariant (chat-composer-chip spec
 * §5, extracted per PR #35 review: session-feed.ts must stay under 1k, and the spacer/anchor
 * cluster is a layout policy, not composer state — same seam as feed-divider.ts).
 *
 * The invariant: `spacer` is ALWAYS the last child of the list it was constructed with, and
 * its height is exactly the space the current turn's reply hasn't filled yet — so a just-sent
 * user bubble CAN scroll to the top of the viewport (claude.ai anchoring) and the feed never
 * scrolls into stale blank tail. The spacer is never a session row: the feed's addRow inserts
 * every row BEFORE `spacer` and it is exempt from the MAX_ROWS cap.
 *
 * Ownership model (PR #35 review, adjudicated by Noah's own review over the automation's
 * observer suggestion): mutation sites call `update()` explicitly — addRow, appendDelta, the
 * in-place finalize branch, and tool-finished's late diff append. A MutationObserver could
 * delete those calls, but it's real machinery (subtree + characterData + attributes, plus
 * start/stop lifecycle to honor the zero-idle-overhead product constraint) guarding a
 * cosmetic invariant; the calls live in one file and this type's docs name them.
 */
export class FeedAnchor {
  /** The non-row last child of the list — the feed's addRow inserts rows before this. */
  readonly spacer: HTMLElement
  private readonly list: HTMLElement
  /** The user bubble currently anchored at the viewport top, if any — update() shrinks the
   * spacer as content accumulates below it; nulled when eviction removes it. */
  private anchorRow: HTMLElement | null = null

  constructor(list: HTMLElement) {
    this.list = list
    this.spacer = document.createElement('div')
    this.spacer.className = 'feed-tail-spacer'
    list.append(this.spacer)
  }

  /** Sizes the spacer so `row` CAN reach the viewport top, then anchors it there — without
   * the spacer, scrollIntoView on a short feed is a no-op (nothing below to scroll into the
   * gap) and the streaming reply would render out of view under a bottom-pinned bubble.
   * scrollIntoView is optional-chained: jsdom doesn't implement it (layout-free), and the
   * anchor is purely a visual nicety there. */
  anchor(row: HTMLElement): void {
    this.anchorRow = row
    this.spacer.style.height = `${Math.max(0, this.list.clientHeight - row.offsetHeight)}px`
    row.scrollIntoView?.({ block: 'start' })
  }

  /** Shrinks the spacer as real content accumulates below the anchor — it only ever holds
   * the space the streaming reply hasn't filled yet. All-zero in jsdom (no layout),
   * harmlessly setting height 0. */
  update(): void {
    if (this.anchorRow === null || !this.anchorRow.isConnected) return
    // Early-out on our own last-written value — reading .style.height is not a layout query,
    // so a fully-drained spacer costs nothing per streamed token. Without this, the offset
    // reads below force a synchronous reflow after every delta's textContent write (PR #35
    // review finding 2). Deliberate trade: after draining to 0 the spacer never re-grows
    // within a turn (e.g. an approval row collapsing mid-turn no longer re-pins the anchor) —
    // the next anchor() re-sizes it fresh. '' (never sized) falls through to the measurement.
    if (this.spacer.style.height === '0px') return
    const contentBelow = this.spacer.offsetTop - this.anchorRow.offsetTop
    this.spacer.style.height = `${Math.max(0, this.list.clientHeight - contentBelow)}px`
  }

  /** Drops the anchor when MAX_ROWS eviction removed its row — a detached anchor would
   * freeze the spacer at its last size forever (same staleness hazard as the feed's evicted
   * streaming bubble). Resetting the height itself (not just the bookkeeping) is what
   * actually prevents that freeze: update() is a no-op once anchorRow is null, so whatever
   * height the spacer held at eviction time would otherwise persist untouched. */
  onEvict(removed: HTMLElement[]): void {
    if (this.anchorRow !== null && removed.includes(this.anchorRow)) {
      this.anchorRow = null
      this.spacer.style.height = '0px'
    }
  }
}
