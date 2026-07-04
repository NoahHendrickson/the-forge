import { describe, it, expect, beforeEach } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { EventEmitter } from 'node:events'
import { theForge, CLIENT_ID } from '../src/index'

type TransformHook = (code: string, id: string) => { code: string } | null

function getPlugin(root = '/proj', options?: Parameters<typeof theForge>[0]) {
  const plugin = theForge(options)
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
  config: { server: { allowedHosts?: string[] | true } }
}

function fakeServer(_root: string): FakeViteServer {
  const httpServer = new EventEmitter() as FakeHttpServer
  httpServer.address = () => ({ port: 5199, address: '127.0.0.1' })
  return {
    middlewares: { use: () => undefined },
    httpServer,
    config: { server: {} },
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

    it('writes a per-session secret into the endpoint file', () => {
      const { plugin } = getPlugin(root)
      const server = fakeServer(root)
      ;(plugin.configureServer as (s: unknown) => void)(server)
      server.httpServer.emit('listening')

      const filePath = path.join(root, '.the-forge', `endpoint-${process.pid}.json`)
      const data = JSON.parse(fs.readFileSync(filePath, 'utf8'))
      expect(typeof data.secret).toBe('string')
      expect(data.secret.length).toBeGreaterThan(0)
    })
  })

  describe('agent / experimentalChannels options', () => {
    let root: string

    beforeEach(() => {
      root = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-plugin-agent-'))
    })

    it('defaults to claude-code / experimentalChannels: false in the client bootstrap', () => {
      const { plugin } = getPlugin(root)
      const server = fakeServer(root)
      ;(plugin.configureServer as (s: unknown) => void)(server)
      server.httpServer.emit('listening')
      const code = (plugin.load as (id: string) => string | null)(CLIENT_ID)!
      expect(code).toContain('"agent":"claude-code"')
    })

    it('threads a configured agent/experimentalChannels into the client bootstrap', () => {
      const { plugin } = getPlugin(root, { agent: 'cursor', experimentalChannels: true })
      const server = fakeServer(root)
      ;(plugin.configureServer as (s: unknown) => void)(server)
      server.httpServer.emit('listening')
      const code = (plugin.load as (id: string) => string | null)(CLIENT_ID)!
      expect(code).toContain('"agent":"cursor"')
    })
  })

  describe('.the-forge dir location (BUG 2: forgeDir resolves the git root, not the vite root)', () => {
    let repoRoot: string
    let viteRoot: string

    beforeEach(() => {
      repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-plugin-forgedir-'))
      fs.mkdirSync(path.join(repoRoot, '.git'))
      viteRoot = path.join(repoRoot, 'fixtures', 'demo-app')
      fs.mkdirSync(viteRoot, { recursive: true })
    })

    it('writes the endpoint file and queue.json at the resolved git root, not the nested vite root', () => {
      const { plugin } = getPlugin(viteRoot)
      const server = fakeServer(viteRoot)
      ;(plugin.configureServer as (s: unknown) => void)(server)
      server.httpServer.emit('listening')

      const endpointAtRoot = path.join(repoRoot, '.the-forge', `endpoint-${process.pid}.json`)
      expect(fs.existsSync(endpointAtRoot)).toBe(true)
      expect(fs.existsSync(path.join(viteRoot, '.the-forge', `endpoint-${process.pid}.json`))).toBe(false)

      // this is what the MCP bin at process.cwd() === repoRoot actually discovers
      const data = JSON.parse(fs.readFileSync(endpointAtRoot, 'utf8'))
      expect(typeof data.secret).toBe('string')
    })

    it('still writes the endpoint file at the vite root itself when no .git is found anywhere above it', () => {
      const noGitRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-plugin-forgedir-nogit-'))
      const nested = path.join(noGitRoot, 'fixtures', 'demo-app')
      fs.mkdirSync(nested, { recursive: true })

      const { plugin } = getPlugin(nested)
      const server = fakeServer(nested)
      ;(plugin.configureServer as (s: unknown) => void)(server)
      server.httpServer.emit('listening')

      expect(fs.existsSync(path.join(nested, '.the-forge', `endpoint-${process.pid}.json`))).toBe(true)
    })

    it('migrates legacy queue.json items from the vite root into the resolved root queue on startup', () => {
      const legacyDir = path.join(viteRoot, '.the-forge')
      fs.mkdirSync(legacyDir, { recursive: true })
      const legacyItem = {
        id: 'legacy-plugin-item',
        createdAt: new Date(0).toISOString(),
        status: 'pending',
        markdown: 'legacy from vite root',
        request: null,
      }
      fs.writeFileSync(path.join(legacyDir, 'queue.json'), JSON.stringify([legacyItem]))

      const { plugin } = getPlugin(viteRoot)
      const server = fakeServer(viteRoot)
      ;(plugin.configureServer as (s: unknown) => void)(server)
      server.httpServer.emit('listening')

      const newQueueFile = path.join(repoRoot, '.the-forge', 'queue.json')
      const onDisk = JSON.parse(fs.readFileSync(newQueueFile, 'utf8'))
      expect(onDisk.map((i: { id: string }) => i.id)).toContain('legacy-plugin-item')
      expect(fs.existsSync(path.join(legacyDir, 'queue.json'))).toBe(false)
    })

    it('leaves a corrupt legacy queue.json untouched and does not throw', () => {
      const legacyDir = path.join(viteRoot, '.the-forge')
      fs.mkdirSync(legacyDir, { recursive: true })
      fs.writeFileSync(path.join(legacyDir, 'queue.json'), 'not valid json')

      const { plugin } = getPlugin(viteRoot)
      const server = fakeServer(viteRoot)
      expect(() => {
        ;(plugin.configureServer as (s: unknown) => void)(server)
        server.httpServer.emit('listening')
      }).not.toThrow()

      expect(fs.readFileSync(path.join(legacyDir, 'queue.json'), 'utf8')).toBe('not valid json')
    })
  })

  describe('project config install location (BUG 1: resolves the git root, not the vite root)', () => {
    let repoRoot: string
    let viteRoot: string

    beforeEach(() => {
      repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-plugin-gitroot-'))
      fs.mkdirSync(path.join(repoRoot, '.git'))
      viteRoot = path.join(repoRoot, 'fixtures', 'demo-app')
      fs.mkdirSync(viteRoot, { recursive: true })
    })

    it('installs .mcp.json and the command file at the resolved git root, not the nested vite root', () => {
      const { plugin } = getPlugin(viteRoot)
      const server = fakeServer(viteRoot)
      ;(plugin.configureServer as (s: unknown) => void)(server)
      server.httpServer.emit('listening')

      expect(fs.existsSync(path.join(repoRoot, '.mcp.json'))).toBe(true)
      expect(fs.existsSync(path.join(repoRoot, '.claude', 'commands', 'forge-design.md'))).toBe(true)
      expect(fs.existsSync(path.join(viteRoot, '.mcp.json'))).toBe(false)
      expect(fs.existsSync(path.join(viteRoot, '.claude', 'commands', 'forge-design.md'))).toBe(false)
    })

    it('still installs at the vite root itself when no .git is found anywhere above it', () => {
      const noGitRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-plugin-nogit-'))
      const nested = path.join(noGitRoot, 'fixtures', 'demo-app')
      fs.mkdirSync(nested, { recursive: true })

      const { plugin } = getPlugin(nested)
      const server = fakeServer(nested)
      ;(plugin.configureServer as (s: unknown) => void)(server)
      server.httpServer.emit('listening')

      expect(fs.existsSync(path.join(nested, '.mcp.json'))).toBe(true)
      expect(fs.existsSync(path.join(nested, '.claude', 'commands', 'forge-design.md'))).toBe(true)
    })
  })

  describe('client bootstrap secret injection', () => {
    let root: string

    beforeEach(() => {
      root = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-plugin-load-'))
    })

    it('prepends globalThis.__THE_FORGE__ with the session secret to the served client bundle', () => {
      const { plugin } = getPlugin(root)
      const server = fakeServer(root)
      ;(plugin.configureServer as (s: unknown) => void)(server)
      server.httpServer.emit('listening')

      const filePath = path.join(root, '.the-forge', `endpoint-${process.pid}.json`)
      const { secret } = JSON.parse(fs.readFileSync(filePath, 'utf8'))

      const code = (plugin.load as (id: string) => string | null)(CLIENT_ID)
      expect(code).toBeTruthy()
      expect(code!.startsWith(`globalThis.__THE_FORGE__ = ${JSON.stringify({ secret, agent: 'claude-code' })};\n`)).toBe(true)
    })
  })
})
