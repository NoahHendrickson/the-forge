/**
 * The overlay's motion system — the single source for durations and easing curves
 * (2026-07-12 overlay-motion spec). overlay.ts's TOKENS map serializes these into
 * CSS custom properties for shadow-DOM rules; page-context motion (dock margin push,
 * canvas body transform) imports the same constants directly, so a JS timeout and its
 * CSS transition can never drift apart (the RIPPLE_FADE_MS hand-sync lesson).
 */

/** Micro-interactions: press feedback, chip pops, the selection-outline tween. */
export const DUR_FAST_MS = 120
/** Popovers, disclosure expand, chat-row entrances, toasts. */
export const DUR_POP_MS = 180
/** Panel appearance, dock margin push, canvas discrete zooms. */
export const DUR_PANEL_MS = 240

/**
 * Damped-spring easing baked as a CSS linear() curve (authoring-time generated:
 * ζ=0.78, ~2% peak overshoot at ~52% of the duration, fully settled at 100% —
 * user-ratified "subtle, not bouncy"). linear() is the only way to overshoot in
 * pure CSS; cubic-bezier cannot cross 1 and come back.
 */
export const EASE_SPRING =
  'linear(0, 0.123 6%, 0.36 12%, 0.593 18%, 0.775 24%, 0.897 30%, 0.968 36%, 1.004 42%, 1.019 50%, 1.018 58%, 1.011 66%, 1.005 76%, 1.001 88%, 1)'

/** The standard exit / content-enter curve (fast start, gentle settle, no overshoot). */
export const EASE_OUT = 'cubic-bezier(0.22, 1, 0.36, 1)'

/** JS-coordinated motion must check this and skip arming entirely — the CSS-side guard
 * (the reduced-motion block in overlay.ts) only covers shadow-DOM rules. */
export function prefersReducedMotion(): boolean {
  return typeof window.matchMedia === 'function' &&
    window.matchMedia('(prefers-reduced-motion: reduce)').matches
}

/** Re-triggerable one-shot animation: remove the class, force a style flush so the
 * browser sees the removal, re-add it — the standard restart idiom. The class's CSS
 * carries the actual @keyframes animation. */
export function popOnce(el: HTMLElement, className = 'pop'): void {
  if (prefersReducedMotion()) return
  el.classList.remove(className)
  void el.offsetWidth
  el.classList.add(className)
}

/** Arms a one-shot page-context transition on `el` for `property`, at the shared
 * discrete-gesture profile (DUR_PANEL_MS + EASE_OUT): saves the element's prior inline
 * transition VERBATIM, appends the property tween, and self-cleans on transitionend or a
 * DUR_PANEL_MS + 80 timeout, whichever first (jsdom never fires transitionend).
 * transitionend BUBBLES — an unrelated page element finishing its own `property`
 * transition would otherwise bubble up to `el` and kill the tween mid-glide, so the
 * handler checks e.target is `el` itself (PR #34 final review). Returns the cleanup so
 * callers can stash it for direct-manipulation force-clears, or null under reduced
 * motion. `onSettle` runs exactly once as part of cleanup — callers null their stashed
 * handle there, keeping the per-tick `?.()` guard the cheap common case. Extracted from
 * the dock-margin/canvas-zoom twins (PR #34 review — both reviewers). */
export function armPageTransition(
  el: HTMLElement, property: string, onSettle: () => void
): (() => void) | null {
  if (prefersReducedMotion()) return null
  const prev = el.style.transition
  let timer: ReturnType<typeof setTimeout> | null = null
  const cleanup = (): void => {
    el.style.transition = prev
    el.removeEventListener('transitionend', onEnd)
    if (timer) clearTimeout(timer)
    onSettle()
  }
  const onEnd = (e: TransitionEvent): void => {
    if (e.target === el && e.propertyName === property) cleanup()
  }
  el.style.transition = prev
    ? `${prev}, ${property} ${DUR_PANEL_MS}ms ${EASE_OUT}`
    : `${property} ${DUR_PANEL_MS}ms ${EASE_OUT}`
  el.addEventListener('transitionend', onEnd)
  timer = setTimeout(cleanup, DUR_PANEL_MS + 80)
  return cleanup
}

/** Fade-and-collapse a row, then hand control back (the caller does the actual state
 * mutation — e.g. session.removeSeed — in onDone, which triggers the re-render that
 * discards this element). transitionend AND a timeout race to onDone (jsdom and
 * display:none ancestors never fire transitionend); whichever fires first wins. */
export function collapseRow(row: HTMLElement, onDone: () => void): void {
  if (prefersReducedMotion()) {
    onDone()
    return
  }
  row.style.height = `${row.offsetHeight}px`
  row.style.overflow = 'hidden'
  void row.offsetWidth
  row.style.transition =
    `height ${DUR_FAST_MS}ms ${EASE_OUT}, opacity ${DUR_FAST_MS}ms ${EASE_OUT}, ` +
    `padding-top ${DUR_FAST_MS}ms ${EASE_OUT}, padding-bottom ${DUR_FAST_MS}ms ${EASE_OUT}`
  row.style.height = '0px'
  row.style.opacity = '0'
  row.style.paddingTop = '0'
  row.style.paddingBottom = '0'
  let fired = false
  const finish = (): void => {
    if (fired) return
    fired = true
    onDone()
  }
  row.addEventListener('transitionend', finish, { once: true })
  setTimeout(finish, DUR_FAST_MS + 80)
}
