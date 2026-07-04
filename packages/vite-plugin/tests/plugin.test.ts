import { describe, it, expect, beforeEach } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { EventEmitter } from 'node:events'
import { theForge, CLIENT_ID } from '../src/index'

type TransformHook = (code: string, id: string) => { code: string } | null

function getPlugin(root = '/proj') {
  const plugin = theForge()
  // simulate vite calling configResolved with a root
  ;(plugin.configResolved as (c: { root: string }) => void)({ root })
  const transform = plugin.transform as unknown as TransformHook
  return { plugin, transform }
}

interface FakeHttpServer extends EventEmitter {
  address(): { port: number; address: string } | null
}

interface FakeViteServer {
  middlewares: { use: (...args: unknown[]) => void }
  httpServer: FakeHttpServer
}

function fakeServer(_root: string): FakeViteServer {
  const httpServer = new EventEmitter() as FakeHttpServer
  httpServer.address = () => ({ port: 5199, address: '127.0.0.1' })
  return {
    middlewares: { use: () => undefined },
    httpServer,
  }
}

describe('theForge plugin', () => {
  it('is dev-only and runs before other transforms', () => {
    const { plugin } = getPlugin()
    expect(plugin.apply).toBe('serve')
    expect(plugin.enforce).toBe('pre')
  })

  it('transforms .tsx under the root with a root-relative path', () => {
    const { transform } = getPlugin()
    const out = transform(`const x = <div />\n`, '/proj/src/App.tsx')
    expect(out!.code).toContain(`data-dc-source="src/App.tsx:1:11"`)
  })

  it('strips vite query strings from ids', () => {
    const { transform } = getPlugin()
    const out = transform(`const x = <div />\n`, '/proj/src/App.tsx?v=abc123')
    expect(out!.code).toContain(`data-dc-source="src/App.tsx:1:11"`)
  })

  it('ignores non-JSX files, node_modules, and files outside the root', () => {
    const { transform } = getPlugin()
    expect(transform(`const x = 1`, '/proj/src/a.ts')).toBeNull()
    expect(
      transform(`const x = <div />`, '/proj/node_modules/lib/index.jsx')
    ).toBeNull()
    expect(transform(`const x = <div />`, '/elsewhere/App.tsx')).toBeNull()
  })

  it('injects the client script into index.html', () => {
    const { plugin } = getPlugin()
    const tags = (plugin.transformIndexHtml as () => unknown[])()
    expect(tags).toEqual([
      {
        tag: 'script',
        attrs: { type: 'module', src: CLIENT_ID },
        injectTo: 'body',
      },
    ])
  })

  it('resolves the client virtual id', () => {
    const { plugin } = getPlugin()
    const resolveId = plugin.resolveId as unknown as (id: string) => string | undefined
    expect(resolveId(CLIENT_ID)).toBe(CLIENT_ID)
    expect(resolveId('/other')).toBeUndefined()
  })

  describe('endpoint file lifecycle', () => {
    let root: string

    beforeEach(() => {
      root = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-plugin-'))
    })

    it('removes the endpoint file when the http server closes', () => {
      const { plugin } = getPlugin(root)
      const server = fakeServer(root)
      ;(plugin.configureServer as (s: unknown) => void)(server)
      server.httpServer.emit('listening')

      const filePath = path.join(root, '.the-forge', `endpoint-${process.pid}.json`)
      expect(fs.existsSync(filePath)).toBe(true)

      server.httpServer.emit('close')
      expect(fs.existsSync(filePath)).toBe(false)
    })
  })
})
