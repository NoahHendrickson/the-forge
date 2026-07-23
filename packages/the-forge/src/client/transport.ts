/** ForgeTransport — the ONE seam between client UI modules and a forge runtime's HTTP
 * surface (O0 seams pass, docs/specs/2026-07-22-studio-o0-o1-design.md §3.1). Today every
 * consumer talks to the same-origin dev-server runtime: base '' (relative URLs) and the
 * bootstrap-injected secret. The studio shell (O1) constructs one per project with an
 * absolute `/p/<id>`-prefixed base and a hub-delivered secret instead — no consumer changes.
 * Global `fetch` is read at CALL time (not captured at construction) so tests that stub
 * globalThis.fetch keep working unchanged. */
export interface ForgeTransport {
  /** Prefix prepended to every path ('' today; 'http://localhost:<hub>/p/<id>' in the shell). */
  base: string
  /** Auth headers, read lazily per request — see forgeSecretHeaders below for why lazy. */
  secretHeaders(): Record<string, string>
  /** GET returning the raw Response — callers keep their own res.ok/.json handling. */
  get(path: string): Promise<Response>
  /** Bodyless POST with secret headers (interrupt/unwatch shape). */
  post(path: string): Promise<Response>
  /** JSON POST with secret headers (queue/dispatch/config/decide/say shape). */
  postJson(path: string, body?: unknown): Promise<Response>
}

/** Belt-and-braces against cross-origin/DNS-rebinding bypasses of the server's Origin/Host
 * checks — same-origin page scripts are the user's own app and not the adversary. The secret
 * is injected by the server into `globalThis.__THE_FORGE__` (see index.ts load()); read it
 * lazily on each send so a value set after this module first evaluates is still picked up. */
export function forgeSecretHeaders(): Record<string, string> {
  const secret = (globalThis as { __THE_FORGE__?: { secret?: string } }).__THE_FORGE__?.secret
  return secret ? { 'X-Forge-Secret': secret } : {}
}

export function createTransport(
  base = '',
  secretHeaders: () => Record<string, string> = forgeSecretHeaders
): ForgeTransport {
  return {
    base,
    secretHeaders,
    get: (path) => fetch(base + path),
    post: (path) => fetch(base + path, { method: 'POST', headers: secretHeaders() }),
    postJson: (path, body) =>
      fetch(base + path, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...secretHeaders() },
        body: JSON.stringify(body),
      }),
  }
}
