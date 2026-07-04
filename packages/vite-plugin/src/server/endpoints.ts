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

export function createForgeMiddleware(queue: Queue) {
  return (req: IncomingMessage, res: ServerResponse, next: () => void): void => {
    const url = req.url ?? ''
    if (!url.startsWith('/__the-forge/')) return next()

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

    if (req.method === 'POST' && pathname === '/__the-forge/queue') {
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

    if (req.method === 'GET' && pathname === '/__the-forge/pull') {
      send(res, 200, { items: queue.pull() })
      return
    }

    if (req.method === 'POST' && pathname === '/__the-forge/mark') {
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

export function writeEndpointFile(dir: string, port: number): void {
  fs.mkdirSync(dir, { recursive: true })
  fs.writeFileSync(path.join(dir, 'endpoint.json'), JSON.stringify({ port, pid: process.pid }))
}
