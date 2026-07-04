#!/usr/bin/env node
import fs from 'node:fs'
import path from 'node:path'
import readline from 'node:readline'
import { handleMessage, type ForgeBackend, type JsonRpcMessage } from './protocol'
import { baseUrl, type ForgeEndpoint } from './url'

const NOT_RUNNING_MESSAGE = 'The Forge dev server is not running — start your Vite dev server first.'

function readEndpoint(): ForgeEndpoint | null {
  try {
    const raw = fs.readFileSync(path.join(process.cwd(), '.the-forge', 'endpoint.json'), 'utf8')
    const data = JSON.parse(raw) as { port?: number; host?: string }
    if (typeof data.port !== 'number') return null
    return { port: data.port, host: data.host }
  } catch {
    return null
  }
}

function makeBackend(): ForgeBackend {
  return {
    async pull() {
      const endpoint = readEndpoint()
      if (!endpoint) throw new Error(NOT_RUNNING_MESSAGE)
      let res: Response
      try {
        res = await fetch(`${baseUrl(endpoint)}/__the-forge/pull`, {
          signal: AbortSignal.timeout(10_000),
        })
      } catch {
        throw new Error(NOT_RUNNING_MESSAGE)
      }
      if (!res.ok) throw new Error(NOT_RUNNING_MESSAGE)
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
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ ids, status, note }),
          signal: AbortSignal.timeout(10_000),
        })
      } catch {
        throw new Error(NOT_RUNNING_MESSAGE)
      }
      if (!res.ok) throw new Error(NOT_RUNNING_MESSAGE)
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
