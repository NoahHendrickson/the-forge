import { describe, it, expect, beforeEach, vi } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { EventEmitter } from 'node:events'

// Captures createForgeMiddleware's dispatchConfig arg instead of driving a real /dispatch
// request: pre-gate, a dispatch against an idle session would auto-start it and spawn a REAL
// `claude` child on the test machine — the capture proves the threading with zero side effects.
const middlewareArgs: unknown[][] = []
vi.mock('../src/server/endpoints', async (importOriginal) => {
  const mod = await importOriginal<typeof import('../src/server/endpoints')>()
  return {
    ...mod,
    createForgeMiddleware: (...args: unknown[]) => {
      middlewareArgs.push(args)
      return mod.createForgeMiddleware(...(args as Parameters<typeof mod.createForgeMiddleware>))
    },
  }
})

import { theForge } from '../src/vite'

interface FakeHttpServer extends EventEmitter {
  address(): { port: number; address: string } | null
}

function fakeServer() {
  const httpServer = new EventEmitter() as FakeHttpServer
  httpServer.address = () => ({ port: 5199, address: '127.0.0.1' })
  return {
    middlewares: { use: () => undefined },
    httpServer,
    config: { server: {} as { allowedHosts?: string[] | true } },
  }
}

let root: string

beforeEach(() => {
  middlewareArgs.length = 0
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-plugin-embedded-'))
})

describe('theForge embedded option threading', () => {
  function configure(options?: Parameters<typeof theForge>[0]): void {
    const plugin = theForge(options)
    ;(plugin.configResolved as (c: { root: string }) => void)({ root })
    ;(plugin.configureServer as (s: unknown) => void)(fakeServer())
  }

  it('threads embedded: false into the middleware dispatch config', () => {
    configure({ embedded: false })
    expect(middlewareArgs).toHaveLength(1)
    const dispatchConfig = middlewareArgs[0]![3] as { embedded?: boolean }
    expect(dispatchConfig.embedded).toBe(false)
  })

  it('omitted option leaves the rung enabled (embedded !== false)', () => {
    configure()
    expect(middlewareArgs).toHaveLength(1)
    const dispatchConfig = middlewareArgs[0]![3] as { embedded?: boolean }
    expect(dispatchConfig.embedded).not.toBe(false)
  })
})
