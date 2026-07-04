import fs from 'node:fs'
import path from 'node:path'
import type { ForgeEndpoint } from './url'

interface EndpointFileData {
  port?: number
  host?: string
  pid?: number
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
    if (!best || entry.mtimeMs > best.mtimeMs) best = entry
  }

  if (!best) return null
  return { port: best.data.port as number, host: best.data.host }
}
