import fs from 'node:fs'
import path from 'node:path'
import type { ForgeEndpoint } from './url'

interface EndpointFileData {
  port?: number
  host?: string
  pid?: number
  secret?: string
}

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch (e) {
    // ESRCH: no such process — dead. EPERM: exists but we lack permission — alive.
    return (e as NodeJS.ErrnoException).code === 'EPERM'
  }
}

/** Hosts our own server can legitimately record: loopback names/addresses and the wildcard
 * binds baseUrl (src/mcp/url.ts) maps to loopback. Anything else means the endpoint file was
 * NOT written by our plugin — a planted file could otherwise point the pull loop (whose
 * change requests the agent auto-applies as edits) at an attacker-controlled server
 * (2026-07-10 security review, finding 2). The trade-off — a dev server deliberately bound to
 * a single non-loopback interface loses MCP discovery — is accepted: the bin runs on the same
 * machine, so loopback is the only transport it ever needs. */
function isLoopbackHost(host: string | undefined): boolean {
  if (host === undefined) return true
  if (host === 'localhost' || host === '::1' || host === '::' || host === '0.0.0.0') return true
  if (host.startsWith('127.')) return true // 127.0.0.0/8, e.g. 127.0.0.1
  if (host === '::ffff:127.0.0.1') return true // IPv4-mapped loopback
  return false
}

function readEntry(filePath: string): { data: EndpointFileData; mtimeMs: number } | null {
  try {
    const raw = fs.readFileSync(filePath, 'utf8')
    const data = JSON.parse(raw) as EndpointFileData
    const mtimeMs = fs.statSync(filePath).mtimeMs
    return { data, mtimeMs }
  } catch {
    return null
  }
}

/**
 * Discover the live dev server endpoint for a project's .the-forge directory.
 *
 * Each dev server process writes its own `endpoint-<pid>.json`. We list all
 * such files, filter to ones whose pid is still alive, and pick the most
 * recently modified live entry. A legacy single `endpoint.json` (written by
 * older versions) is only used when no per-pid files are present, and always
 * loses to any per-pid file.
 */
export function discoverEndpoint(dir: string): ForgeEndpoint | null {
  let names: string[]
  try {
    names = fs.readdirSync(dir)
  } catch {
    return null
  }

  const perPid = names.filter((n) => /^endpoint-\d+\.json$/.test(n))
  const candidates = perPid.length > 0 ? perPid : names.filter((n) => n === 'endpoint.json')

  let best: { data: EndpointFileData; mtimeMs: number } | null = null
  for (const name of candidates) {
    const entry = readEntry(path.join(dir, name))
    if (!entry) continue
    if (typeof entry.data.pid !== 'number' || !isAlive(entry.data.pid)) continue
    if (typeof entry.data.port !== 'number') continue
    if (entry.data.host !== undefined && typeof entry.data.host !== 'string') continue
    if (!isLoopbackHost(entry.data.host)) continue
    if (!best || entry.mtimeMs > best.mtimeMs) best = entry
  }

  if (!best) return null
  return { port: best.data.port as number, host: best.data.host, secret: best.data.secret }
}

/** Walk cap mirrors resolveProjectRoot's GIT_WALK_MAX_LEVELS (server/setup.ts). */
const DISCOVER_WALK_MAX_LEVELS = 10

/**
 * Walks up from `startDir` (bounded) looking for the nearest directory whose `.the-forge`
 * yields a live endpoint. This removes the historical requirement that the agent session run
 * exactly at the git root: the plugin writes `.the-forge` at the resolved project root, and a
 * session opened in any subdirectory now finds it. Nearest directory wins (so a nested
 * project's own `.the-forge` beats an ancestor's); within a directory, discoverEndpoint's
 * newest-live-pid rule applies unchanged. A dead or absent `.the-forge` never stops the walk —
 * only a LIVE endpoint does.
 */
export function discoverEndpointFrom(startDir: string): ForgeEndpoint | null {
  let dir = path.resolve(startDir)
  for (let i = 0; i <= DISCOVER_WALK_MAX_LEVELS; i++) {
    const found = discoverEndpoint(path.join(dir, '.the-forge'))
    if (found) return found
    const parent = path.dirname(dir)
    if (parent === dir) break // reached filesystem root
    dir = parent
  }
  return null
}
