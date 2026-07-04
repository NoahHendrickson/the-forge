import fs from 'node:fs'
import path from 'node:path'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { Queue } from './queue'

const MAX_BODY = 1024 * 1024

function readBody(req: IncomingMessage): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = []
    let size = 0
    let settled = false

    req.on('data', (c: Buffer) => {
      if (settled) return
      size += c.length
      if (size > MAX_BODY) {
        settled = true
        reject(new Error('body too large'))
      } else {
        chunks.push(c)
      }
    })
    req.on('end', () => {
      if (settled) return
      settled = true
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')))
      } catch {
        reject(new Error('malformed JSON'))
      }
    })
    req.on('error', (e) => {
      if (settled) return
      settled = true
      reject(e)
    })
  })
}

function send(res: ServerResponse, status: number, data: unknown): void {
  res.statusCode = status
  res.setHeader('Content-Type', 'application/json')
  res.end(JSON.stringify(data))
}

/** Extracts the hostname from a Host header value, stripping any port and IPv6 brackets. */
function hostnameOf(host: string): string {
  let h = host.trim()
  if (h.startsWith('[')) {
    // IPv6 literal, e.g. "[::1]:5173" or "[::1]"
    const close = h.indexOf(']')
    return close === -1 ? h : h.slice(1, close)
  }
  const colon = h.indexOf(':')
  return colon === -1 ? h : h.slice(0, colon)
}

function isAllowedHost(host: string | undefined, allowedHosts: string[]): boolean {
  if (!host) return false
  const hostname = hostnameOf(host)
  if (hostname === 'localhost' || hostname.endsWith('.localhost')) return true
  if (hostname === '127.0.0.1' || hostname === '::1') return true
  return allowedHosts.includes(hostname)
}

// Mutating endpoints that require the shared secret when one is configured. GET /status is
// deliberately excluded: it's read-only and only exposes ids/statuses, which are non-sensitive.
const MUTATING_PATHS = new Set(['/__the-forge/queue', '/__the-forge/pull', '/__the-forge/mark'])

export function createForgeMiddleware(queue: Queue, allowedHosts: string[] = [], secret?: string) {
  return (req: IncomingMessage, res: ServerResponse, next: () => void): void => {
    const url = req.url ?? ''
    if (!url.startsWith('/__the-forge/')) return next()

    if (!isAllowedHost(req.headers.host, allowedHosts)) {
      return send(res, 403, { error: 'host not allowed' })
    }

    const origin = req.headers.origin
    if (typeof origin === 'string') {
      let originHost: string | null = null
      try {
        originHost = new URL(origin).host
      } catch {
        originHost = null
      }
      if (!req.headers.host || originHost !== req.headers.host) {
        return send(res, 403, { error: 'cross-origin request rejected' })
      }
    }

    const [pathname, query = ''] = url.split('?')

    // Belt-and-braces against cross-origin/DNS-rebinding bypasses of the Origin/Host checks
    // above — same-origin page scripts are the user's own app and not the adversary, so this
    // only matters when a request slips past the Host/Origin gate. Enforced only when a secret
    // was actually configured (older/degraded setups without one keep working unauthenticated).
    //
    // Threat model scope: this guards against a browser-borne cross-origin attacker. It does
    // NOT defend against another local user on a shared/multi-user machine — this endpoint file
    // (and the queue dir it manages) is written with mode 644, readable by any local account, so
    // a co-resident local user can already read the secret and the queue contents directly from
    // disk. Local-multi-user hardening (e.g. tighter file perms, per-user dirs) is out of scope
    // for this single-user dev tool.
    if (secret && req.method === 'POST' && MUTATING_PATHS.has(pathname)) {
      const provided = req.headers['x-forge-secret']
      if (provided !== secret) {
        return send(res, 403, { error: 'missing or invalid X-Forge-Secret' })
      }
    }

    if (pathname === '/__the-forge/queue') {
      if (req.method !== 'POST') return send(res, 405, { error: 'use POST' })
      readBody(req)
        .then((body) => {
          const { request, markdown } = body as { request?: unknown; markdown?: string }
          if (typeof markdown !== 'string') return send(res, 400, { error: 'markdown required' })
          const item = queue.add(request ?? null, markdown)
          send(res, 200, { id: item.id })
        })
        .catch((e: Error) => send(res, 400, { error: e.message }))
      return
    }

    if (pathname === '/__the-forge/pull') {
      if (req.method !== 'POST') return send(res, 405, { error: 'use POST' })
      send(res, 200, { items: queue.pull() })
      return
    }

    if (pathname === '/__the-forge/mark') {
      if (req.method !== 'POST') return send(res, 405, { error: 'use POST' })
      readBody(req)
        .then((body) => {
          const { ids, status, note } = body as { ids?: string[]; status?: string; note?: string }
          if (!Array.isArray(ids) || (status !== 'applied' && status !== 'failed')) {
            return send(res, 400, { error: 'ids + status(applied|failed) required' })
          }
          send(res, 200, { marked: queue.mark(ids, status, note).map((i) => i.id) })
        })
        .catch((e: Error) => send(res, 400, { error: e.message }))
      return
    }

    if (req.method === 'GET' && pathname === '/__the-forge/status') {
      const idsParam = new URLSearchParams(query).get('ids')
      const wanted = idsParam ? new Set(idsParam.split(',')) : null
      const items = queue
        .list()
        .filter((i) => !wanted || wanted.has(i.id))
        .map(({ id, status, note }) => ({ id, status, note }))
      send(res, 200, { items })
      return
    }

    send(res, 404, { error: 'unknown forge endpoint' })
  }
}

export function writeEndpointFile(dir: string, port: number, host?: string, secret?: string): string {
  fs.mkdirSync(dir, { recursive: true })
  const filePath = path.join(dir, `endpoint-${process.pid}.json`)
  fs.writeFileSync(filePath, JSON.stringify({ port, host, pid: process.pid, secret }))
  return filePath
}

export function removeEndpointFile(dir: string): void {
  try {
    fs.unlinkSync(path.join(dir, `endpoint-${process.pid}.json`))
  } catch {
    // ignore — file may not exist, or dir may not exist
  }
}
