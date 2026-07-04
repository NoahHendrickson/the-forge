import type { TaggedElement } from './source'

/** Snapshot size cap — bounds worst-case measurement cost on large scopes. */
const SNAPSHOT_CAP = 50

/** Rect dimensions compared by diffRects; any one changing beyond the threshold counts as "moved". */
const RECT_DIMENSIONS = ['x', 'y', 'width', 'height'] as const

/** Rect changes at or below this size (px) are treated as sub-pixel jitter, not a real reflow. */
const CHANGE_THRESHOLD = 0.5

/**
 * Captures the current rects of every tagged element in scope, excluding `selected`.
 *
 * Scope is the nearest ancestor of `selected` carrying `data-dc-source` (i.e. the
 * enclosing tagged component), falling back to `doc.body` when there is none — this
 * keeps the ripple search local to the edited component's tree instead of scanning
 * the whole page. Capped at SNAPSHOT_CAP elements to bound measurement cost.
 */
export function snapshotRects(selected: TaggedElement, doc: Document = document): Map<TaggedElement, DOMRect> {
  const scope = selected.parentElement?.closest('[data-dc-source]') ?? doc.body
  const snapshot = new Map<TaggedElement, DOMRect>()
  const candidates = scope.querySelectorAll('[data-dc-source]')
  for (const el of candidates) {
    if (snapshot.size >= SNAPSHOT_CAP) break
    if (el === selected) continue
    snapshot.set(el as TaggedElement, (el as TaggedElement).getBoundingClientRect())
  }
  return snapshot
}

/**
 * Re-measures every element in `before` and returns those still connected to the
 * document whose rect changed by more than CHANGE_THRESHOLD px in any dimension.
 */
export function diffRects(before: Map<TaggedElement, DOMRect>): TaggedElement[] {
  const changed: TaggedElement[] = []
  for (const [el, prevRect] of before) {
    if (!el.isConnected) continue
    const rect = el.getBoundingClientRect()
    const moved = RECT_DIMENSIONS.some((dim) => Math.abs(rect[dim] - prevRect[dim]) > CHANGE_THRESHOLD)
    if (moved) changed.push(el)
  }
  return changed
}
