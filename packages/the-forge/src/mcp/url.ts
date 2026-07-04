export interface ForgeEndpoint {
  port: number
  host?: string
  secret?: string
}

/**
 * Build the base URL for talking to the dev server's Forge middleware,
 * honoring the actual host Vite bound to (which may be IPv6-only, e.g.
 * `[::1]` on macOS). Falls back to IPv4 loopback when no host is known,
 * and maps wildcard binds to their loopback equivalents.
 */
export function baseUrl(endpoint: ForgeEndpoint): string {
  const { port, host } = endpoint

  if (!host) return `http://127.0.0.1:${port}`
  if (host === '::') return `http://[::1]:${port}`
  if (host === '0.0.0.0') return `http://127.0.0.1:${port}`
  if (host.includes(':')) return `http://[${host}]:${port}`
  return `http://${host}:${port}`
}
