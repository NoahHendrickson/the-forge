/** Tracks whether a dev-server code update reached this page since a given cursor.
 *
 * Why it exists (Figma pivot P1, spec §4): the css verifier's false-done guard is
 * neutralize-inline-then-measure — the cascade underneath our override is the code's truth.
 * Text has no cascade: if the drafted node survived HMR, its textContent IS our own draft, and
 * equality with the expected value proves nothing. The style trick has no text analog, so the
 * guard becomes "only trust equality on a surviving node once a code update demonstrably
 * reached the page" — Vite fires 'vite:afterUpdate' on window for exactly this. On Next there
 * is no page-visible update event at all, so trustSince() returns true there (documented
 * residual false-done risk; a full Fast-Refresh remount instead replaces the node, which the
 * caller's identity check catches without needing this signal).
 *
 * Vite detection: onVite latches ONLY once a listener demonstrably attached (the hot-context
 * import resolved) or a vite event was actually observed — never from the script-tag sniff
 * alone. The sniff used to latch it, which broke the degrade promise: any setup where the tag
 * matches but the probe can't attach (non-root `base`: tag src '/app/@vite/client' matches the
 * substring, the hardcoded absolute import 404s) gated every text verify on a signal that
 * could never arrive — permanent 'unverified' (PR #44 review). A failed probe on an exotic
 * Vite setup now degrades to the legacy accept-equality behavior, never to a stuck row.
 *
 * Lives in its own module (PR #44 follow-up): probing which dev server is in front of us is
 * not verification — verifier.ts consumes the signal through mark()/trustSince() only. */
const MAX_UPDATE_LOG = 200

/** Pulls the touched module paths out of a vite:afterUpdate payload — hot-context payloads
 * carry {updates: [{path, acceptedPath}]}; window CustomEvents may carry the same under
 * .detail; anything else yields [] (an update with unknown shape trusts globally, the
 * pre-path-scoping behavior). */
function extractUpdatePaths(payload: unknown): string[] {
  const body = isObj(payload) && 'detail' in payload ? (payload as { detail?: unknown }).detail : payload
  if (!isObj(body) || !Array.isArray((body as { updates?: unknown }).updates)) return []
  const paths: string[] = []
  for (const u of (body as { updates: unknown[] }).updates) {
    if (!isObj(u)) continue
    for (const v of [(u as { acceptedPath?: unknown }).acceptedPath, (u as { path?: unknown }).path]) {
      if (typeof v === 'string') paths.push(v)
    }
  }
  return paths
}

function isObj(v: unknown): v is object {
  return typeof v === 'object' && v !== null
}

/** Vite update paths are dev-server-absolute ('/src/App.tsx', possibly '?t='-suffixed);
 * data-dc-source files are whatever the tagger recorded (project-relative or absolute).
 * Suffix-match either way after stripping query strings and leading slashes. */
function pathMatchesFile(updatePath: string, file: string): boolean {
  const norm = (s: string): string => s.split('?')[0].replace(/^\/+/, '')
  const a = norm(updatePath)
  const b = norm(file)
  return a === b || a.endsWith(`/${b}`) || b.endsWith(`/${a}`)
}

export class HmrSignal {
  private count = 0
  private onVite = false
  private listening = false
  /** seq (count value AFTER the update) + touched module paths, bounded to MAX_UPDATE_LOG.
   * Paths let trustSince scope trust to the edited element's OWN file: a page-global counter
   * let any unrelated element's hot update vouch for a failed text edit in the same request —
   * false Implemented, and commitStructural then destroys the draft (PR #44 review). */
  private updates: Array<{ seq: number; paths: string[] }> = []
  private hot: { on(e: string, cb: (p?: unknown) => void): void; off?(e: string, cb: (p?: unknown) => void): void } | null = null
  private handler = (payload?: unknown): void => {
    this.count++
    this.onVite = true
    this.updates.push({ seq: this.count, paths: extractUpdatePaths(payload) })
    if (this.updates.length > MAX_UPDATE_LOG) this.updates.shift()
  }

  start(doc: Document = document): void {
    if (this.listening) return
    this.listening = true
    // Belt (tests + any future page-level dispatch) …
    window.addEventListener('vite:afterUpdate', this.handler)
    // … and braces (the path that actually fires on real Vite, caught by the P1 E2E):
    // 'vite:afterUpdate' is NOT a DOM event — client.mjs's notifyListeners only invokes
    // import.meta.hot listeners, and this bundle is served raw (never Vite-transformed), so
    // it has no import.meta.hot. Mint our own hot context by importing the HMR client and
    // calling createHotContext — the exact preamble Vite injects into transformed modules.
    // The specifier comes from the injected client tag's own src when present — a hardcoded
    // '/@vite/client' 404s on any non-root `base` (PR #44 review) — and lives in a variable
    // so esbuild leaves the import dynamic instead of trying to resolve a dev-server-only
    // path at build time. On Next the import rejects and we stay in trust-always mode
    // (spec §4's documented Next behavior).
    const viteClientPath = doc.querySelector('script[src*="/@vite/client"]')?.getAttribute('src') ?? '/@vite/client'
    import(viteClientPath).then(
      (mod: { createHotContext?: (path: string) => { on(e: string, cb: (p?: unknown) => void): void } }) => {
        if (!this.listening || typeof mod.createHotContext !== 'function') return
        this.onVite = true
        this.hot = mod.createHotContext('/__the-forge/hmr-signal')
        this.hot.on('vite:afterUpdate', this.handler)
      },
      () => {} // not Vite (or client unreachable) — the window listener remains the only ear
    )
  }

  stop(): void {
    if (!this.listening) return
    this.listening = false
    window.removeEventListener('vite:afterUpdate', this.handler)
    this.hot?.off?.('vite:afterUpdate', this.handler)
    this.hot = null
  }

  /** Monotonic cursor — record at send time, test with trustSince at verify time. */
  mark(): number {
    return this.count
  }

  /** True when a code update demonstrably reached the page since `cursor` — scoped to `file`
   * (the element's own data-dc-source file) when both it and the updates' path info are
   * available. Non-Vite pages (no listener ever attached) trust unconditionally. */
  trustSince(cursor: number, file?: string | null): boolean {
    if (!this.onVite) return true
    const since = this.updates.filter((u) => u.seq > cursor)
    if (since.length === 0) return false
    if (!file) return true
    return since.some((u) => u.paths.length === 0 || u.paths.some((p) => pathMatchesFile(p, file)))
  }
}
