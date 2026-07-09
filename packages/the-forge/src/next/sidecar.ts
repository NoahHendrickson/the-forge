import fs from 'node:fs'
import path from 'node:path'
import http, { type Server } from 'node:http'
import { fileURLToPath } from 'node:url'
import { createForgeMiddleware, writeEndpointFile, removeEndpointFile, isAllowedHost } from '../server/endpoints'
import { setupProjectConfig } from '../server/setup'
import { createForgeRuntime } from '../server/runtime'
import type { DispatchOpts } from '../server/dispatch'

export interface SidecarHandle {
  port: number
  close(): Promise<void>
}

export interface SidecarOpts {
  agent: DispatchOpts['agent']
  channelsFlag: boolean
  /** resolveProjectRoot()'d project root. */
  root: string
  /** Injectable for tests; prod impl reads dist/client.js next to this module. Optional —
   * withForge (N4) passes only { agent, channelsFlag, root } in production and relies on
   * the default. */
  clientBundle?: () => string
  /** default '127.0.0.1' */
  listenHost?: string
  /** One-shot missing-ForgeDesignMode hint delay, ms — default 60_000. Injectable so tests
   * don't need to wait out a real 60s timer. */
  hintDelayMs?: number
}

/** Reads the built client bundle the same way the Vite `load()` hook does: client.js sits
 * next to the built module in dist/; under vitest this module resolves from src/, where
 * client.js is never emitted, so fall back to the built dist/client.js. Loud error naming
 * the build command if neither is found. */
function defaultClientBundle(): string {
  const dir = path.dirname(fileURLToPath(import.meta.url))
  const nextToModule = path.join(dir, 'client.js')
  const builtFallback = path.join(dir, '..', 'dist', 'client.js')
  const clientPath = fs.existsSync(nextToModule)
    ? nextToModule
    : fs.existsSync(builtFallback)
      ? builtFallback
      : null
  if (!clientPath) {
    throw new Error('the-forge: client bundle not found — run "npm run build -w the-forge"')
  }
  return fs.readFileSync(clientPath, 'utf8')
}

let singleton: Promise<SidecarHandle> | null = null

/**
 * Module-level singleton: Next.js can load its config (and therefore call withForge) more
 * than once per process (N0 finding) — a second/concurrent ensureSidecar call must resolve
 * the SAME handle rather than binding a second loopback server or writing a second endpoint
 * file. close() clears the singleton so a later call (e.g. after a dev-server restart within
 * the same process, or in tests) binds fresh.
 */
export function ensureSidecar(opts: SidecarOpts): Promise<SidecarHandle> {
  if (singleton) return singleton
  singleton = createSidecar(opts).catch((err) => {
    singleton = null
    throw err
  })
  return singleton
}

async function createSidecar(opts: SidecarOpts): Promise<SidecarHandle> {
  const listenHost = opts.listenHost ?? '127.0.0.1'
  const hintDelayMs = opts.hintDelayMs ?? 60_000
  const clientBundle = opts.clientBundle ?? defaultClientBundle

  const { queue, hub, secret, forgeDir, session } = createForgeRuntime(opts.root)

  // Next's rewrites proxy presents `Host: 127.0.0.1:<sidecar-port>` to this server (the N0
  // spike) — never the original external host, which only ever shows up in
  // `X-Forwarded-Host`. isAllowedHost (server/endpoints.ts) already accepts 127.0.0.1/::1/
  // localhost unconditionally, so a proxied request's Host passes as-is with NO
  // normalization needed here. Deliberately NOT trusting X-Forwarded-Host: it is
  // attacker-controlled on a direct connection, so validating against it would let a
  // DNS-rebound origin spoof its way past the Host check — the very attack the check
  // exists to stop. A direct (non-proxied) connection from such an origin still presents
  // the attacker's real Host and is correctly rejected.
  const middleware = createForgeMiddleware(queue, [], secret, { agent: opts.agent, channelsFlag: opts.channelsFlag, cwd: opts.root }, hub, session)

  let hintTimer: ReturnType<typeof setTimeout> | null = setTimeout(() => {
    hintTimer = null
    console.warn(
      "[the-forge] design mode never loaded — add <ForgeDesignMode /> from 'the-forge/design-mode' to your root layout (or _app.tsx)"
    )
  }, hintDelayMs)
  hintTimer.unref() // must never hold the process open on its own

  const server: Server = http.createServer((req, res) => {
    if (req.method === 'GET' && req.url === '/__the-forge/client.js') {
      // This is the one route createForgeMiddleware doesn't cover, and it embeds the
      // per-start secret in the bootstrap line — so it needs its own copy of the same
      // DNS-rebinding gate every other route gets for free. Costs nothing: the legitimate
      // proxied request always presents a loopback Host (spike-confirmed in the comment
      // above), so isAllowedHost passes it unconditionally.
      if (!isAllowedHost(req.headers.host, [])) {
        res.statusCode = 403
        res.end()
        return
      }
      // Clear the missing-ForgeDesignMode hint the first time the client bundle is actually
      // fetched — proof the page loaded ForgeDesignMode and is talking to the sidecar.
      if (hintTimer) {
        clearTimeout(hintTimer)
        hintTimer = null
      }
      const bootstrap = `globalThis.__THE_FORGE__ = ${JSON.stringify({ secret, agent: opts.agent })};\n`
      res.statusCode = 200
      res.setHeader('Content-Type', 'text/javascript')
      res.end(bootstrap + clientBundle())
      return
    }
    middleware(req, res, () => {
      res.statusCode = 404
      res.end()
    })
  })

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, listenHost, () => resolve())
  })

  const address = server.address()
  const port = address && typeof address === 'object' ? address.port : 0
  writeEndpointFile(forgeDir, port, listenHost, secret)

  const dir = path.dirname(fileURLToPath(import.meta.url))
  setupProjectConfig(opts.root, path.join(dir, 'mcp.js'), opts.root)

  const onExit = () => removeEndpointFile(forgeDir)
  process.once('exit', onExit)

  const close = (): Promise<void> => {
    if (hintTimer) {
      clearTimeout(hintTimer)
      hintTimer = null
    }
    process.removeListener('exit', onExit)
    removeEndpointFile(forgeDir)
    session.manager.stop()
    singleton = null
    return new Promise<void>((resolve, reject) => {
      server.close((err) => (err ? reject(err) : resolve()))
    })
  }

  return { port, close }
}
