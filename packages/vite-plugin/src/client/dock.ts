export type PanelMode = 'docked' | 'floating'

export interface PanelPrefs {
  width: number
  mode: PanelMode
}

export const MIN_WIDTH = 280
export const MAX_WIDTH = 560
export const DEFAULT_WIDTH = 320
export const STORAGE_KEY = 'the-forge:panel'

/**
 * Clamp order matters: MIN is applied LAST so it wins over the 50vw viewport cap on
 * tiny windows — an under-min panel is unusable, while a page squeezed below 50% is
 * merely cramped (user-ratified: min 280 = the pre-dock fixed width, so every existing
 * clip fix keeps holding).
 */
export function clampWidth(width: number, viewportWidth: number): number {
  const max = Math.min(MAX_WIDTH, Math.floor(viewportWidth * 0.5))
  return Math.max(MIN_WIDTH, Math.min(width, max))
}

export function loadPrefs(): PanelPrefs {
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    if (!raw) return { width: DEFAULT_WIDTH, mode: 'docked' }
    // unknown + manual checks at the I/O boundary — project convention, no schema libs.
    const parsed: unknown = JSON.parse(raw)
    const obj = (typeof parsed === 'object' && parsed !== null ? parsed : {}) as {
      width?: unknown
      mode?: unknown
    }
    const width =
      typeof obj.width === 'number' && Number.isFinite(obj.width) ? obj.width : DEFAULT_WIDTH
    const mode: PanelMode = obj.mode === 'floating' ? 'floating' : 'docked'
    return { width: clampWidth(width, window.innerWidth), mode }
  } catch {
    // Storage disabled (some privacy modes throw) or corrupt JSON — defaults, never crash.
    return { width: DEFAULT_WIDTH, mode: 'docked' }
  }
}

export function savePrefs(prefs: PanelPrefs): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(prefs))
  } catch {
    // Persistence is a nicety — a full/blocked storage must never break an edit session.
  }
}
