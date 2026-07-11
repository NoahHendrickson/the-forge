export interface CanvasState { x: number; y: number; scale: number }
export interface CanvasPrefs { on: boolean; state: CanvasState }

export const MIN_SCALE = 0.1
export const MAX_SCALE = 4
export const CANVAS_STORAGE_KEY = 'the-forge:canvas'
export const FIT_MARGIN = 32

export function clampScale(s: number): number {
  return Math.max(MIN_SCALE, Math.min(MAX_SCALE, s))
}

/**
 * Zoom toward a viewport point: the page-point under (cx, cy) must stay under it.
 * With transform-origin 0 0, a page point p projects to p·s + t, so the point under
 * the cursor is p = (c − t)/s and the new translate is t′ = c − p·s′.
 */
export function zoomAt(state: CanvasState, cx: number, cy: number, nextScale: number): CanvasState {
  const scale = clampScale(nextScale)
  const px = (cx - state.x) / state.scale
  const py = (cy - state.y) / state.scale
  return { x: cx - px * scale, y: cy - py * scale, scale }
}

export function panBy(state: CanvasState, dx: number, dy: number): CanvasState {
  return { x: state.x + dx, y: state.y + dy, scale: state.scale }
}

/**
 * Fit the whole artboard into the viewport area the panel doesn't cover. MIN_SCALE
 * deliberately wins over "whole page visible" for absurdly tall pages — a sub-10%
 * artboard is unreadable and unclickable, so the floor is the better failure mode.
 */
export function fitState(
  viewportW: number, viewportH: number, pageW: number, pageH: number, panelW: number
): CanvasState {
  const availW = Math.max(1, viewportW - panelW - FIT_MARGIN * 2)
  const availH = Math.max(1, viewportH - FIT_MARGIN * 2)
  const scale = clampScale(Math.min(availW / Math.max(1, pageW), availH / Math.max(1, pageH)))
  return {
    x: FIT_MARGIN + Math.max(0, (availW - pageW * scale) / 2),
    y: FIT_MARGIN + Math.max(0, (availH - pageH * scale) / 2),
    scale,
  }
}

const DEFAULT_STATE: CanvasState = { x: 0, y: 0, scale: 1 }

export function loadCanvasPrefs(): CanvasPrefs {
  try {
    const raw = sessionStorage.getItem(CANVAS_STORAGE_KEY)
    if (!raw) return { on: false, state: { ...DEFAULT_STATE } }
    // unknown + manual checks at the I/O boundary — project convention, no schema libs.
    const parsed: unknown = JSON.parse(raw)
    const obj = (typeof parsed === 'object' && parsed !== null ? parsed : {}) as {
      on?: unknown
      state?: unknown
    }
    const s = (typeof obj.state === 'object' && obj.state !== null ? obj.state : {}) as {
      x?: unknown; y?: unknown; scale?: unknown
    }
    const num = (v: unknown, fallback: number): number =>
      typeof v === 'number' && Number.isFinite(v) ? v : fallback
    return {
      on: obj.on === true,
      state: { x: num(s.x, 0), y: num(s.y, 0), scale: clampScale(num(s.scale, 1)) },
    }
  } catch {
    // Storage disabled or corrupt JSON — defaults, never crash (dock.ts pattern).
    return { on: false, state: { ...DEFAULT_STATE } }
  }
}

export function saveCanvasPrefs(p: CanvasPrefs): void {
  try {
    sessionStorage.setItem(CANVAS_STORAGE_KEY, JSON.stringify(p))
  } catch {
    // Persistence is a nicety — a full/blocked storage must never break the session.
  }
}
