#!/usr/bin/env node
import path from 'node:path'
import readline from 'node:readline'
import { handleMessage, type ForgeBackend, type JsonRpcMessage } from './protocol'
import { baseUrl, type ForgeEndpoint } from './url'
import { discoverEndpoint } from './discover'

const NOT_RUNNING_MESSAGE = 'The Forge dev server is not running — start your Vite dev server first.'

/** Distinguishes "reached a server, but it rejected the request" (stale/mismatched dev server —
 * e.g. it restarted, or the plugin and this bin are different versions) from NOT_RUNNING_MESSAGE,
 * which means the connection itself never succeeded (nothing listening at all). */
function rejectedMessage(status: number): string {
  return `The Forge server rejected the request (HTTP ${status}) — the dev server may have restarted or the plugin/bin versions may differ; restart your Vite dev server and agent session.`
}

function readEndpoint(): ForgeEndpoint | null {
  return discoverEndpoint(path.join(process.cwd(), '.the-forge'))
}

function secretHeaders(endpoint: ForgeEndpoint): Record<string, string> {
  return endpoint.secret ? { 'X-Forge-Secret': endpoint.secret } : {}
}

function makeBackend(): ForgeBackend {
  return {
    async pull() {
      const endpoint = readEndpoint()
      if (!endpoint) throw new Error(NOT_RUNNING_MESSAGE)
      let res: Response
      try {
        res = await fetch(`${baseUrl(endpoint)}/__the-forge/pull`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', ...secretHeaders(endpoint) },
          body: JSON.stringify({}),
          signal: AbortSignal.timeout(10_000),
        })
      } catch {
        throw new Error(NOT_RUNNING_MESSAGE)
      }
      if (!res.ok) throw new Error(rejectedMessage(res.status))
      const data = (await res.json()) as { items: Array<{ id: string; markdown: string; createdAt: string }> }
      return data.items
    },
    async mark(ids, status, note) {
      const endpoint = readEndpoint()
      if (!endpoint) throw new Error(NOT_RUNNING_MESSAGE)
      let res: Response
      try {
        res = await fetch(`${baseUrl(endpoint)}/__the-forge/mark`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', ...secretHeaders(endpoint) },
          body: JSON.stringify({ ids, status, note }),
          signal: AbortSignal.timeout(10_000),
        })
      } catch {
        throw new Error(NOT_RUNNING_MESSAGE)
      }
      if (!res.ok) throw new Error(rejectedMessage(res.status))
      const data = (await res.json()) as { marked: string[] }
      return data.marked
    },
  }
}

const backend = makeBackend()

const rl = readline.createInterface({ input: process.stdin, terminal: false })

rl.on('line', (line: string) => {
  const trimmed = line.trim()
  if (!trimmed) return

  let msg: JsonRpcMessage
  try {
    msg = JSON.parse(trimmed) as JsonRpcMessage
  } catch {
    // Parse failure: no recoverable id, so skip the line per spec.
    return
  }

  handleMessage(msg, backend)
    .then((response) => {
      if (response) process.stdout.write(JSON.stringify(response) + '\n')
    })
    .catch(() => {
      // handleMessage should never throw (tool errors become isError results),
      // but guard the stdio loop regardless.
    })
})
