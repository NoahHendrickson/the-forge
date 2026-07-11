import path from 'node:path'
import http, { type Server } from 'node:http'
import { fileURLToPath } from 'node:url'
import { createForgeMiddleware, writeEndpointFile, removeEndpointFile } from '../server/endpoints'
import { readClientBundle } from '../server/client-bundle'
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
  /** `false` disables the embedded-session dispatch rung — see DispatchConfig.embedded.
   * Optional: existing callers/tests that omit it keep the rung enabled (default true). */
  embedded?: boolean
  /** resolveProjectRoot()'d project root. */
  root: string
  /** Injectable for tests; prod impl is the shared readClientBundle (server/client-bundle.ts).
   * Optional — withForge (N4) passes only { agent, channelsFlag, root } in production and
   * relies on the default. */
  clientBundle?: () => string
  /** default '127.0.0.1' */
  listenHost?: string
  /** One-shot missing-ForgeDesignMode hint delay, ms — default 60_000. Injectable so tests
   * don't need to wait out a real 60s timer. */
  hintDelayMs?: number
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
  const clientBundle = opts.clientBundle ?? readClientBundle

  const { queue, hub, secret, forgeDir, session } = createForgeRuntime(opts.root, undefined, { defaultAgent: opts.agent })

  let hintTimer: ReturnType<typeof setTimeout> | null = setTimeout(() => {
    hintTimer = null
    console.warn(
      "[the-forge] design mode never loaded — add <ForgeDesignMode /> from 'forge-mode/design-mode' to your root layout (or _app.tsx)"
    )
  }, hintDelayMs)
  hintTimer.unref() // must never hold the process open on its own

  // The middleware only invokes its clientBundle provider on the fully gated 200 path of the
  // CLIENT_JS_PATH route (after the Host gate, Origin-vs-Host check, and method check), so
  // this wrapper doubles as the "design mode actually loaded" signal: clear the
  // missing-ForgeDesignMode hint on the first real serve. A DNS-rebound or cross-origin probe
  // the middleware 403s never reaches the provider and thus never false-clears the hint (PR
  // #29 review — the previous URL-peek here cleared on any allowed-Host request, including
  // ones about to be rejected for cross-origin).
  const serveClientBundle = (): string => {
    if (hintTimer) {
      clearTimeout(hintTimer)
      hintTimer = null
    }
    return clientBundle()
  }

  // Next's rewrites proxy presents `Host: 127.0.0.1:<sidecar-port>` to this server (the N0
  // spike) — never the original external host, which only ever shows up in
  // `X-Forwarded-Host`. isAllowedHost (server/endpoints.ts) already accepts 127.0.0.1/::1/
  // localhost unconditionally, so a proxied request's Host passes as-is with NO
  // normalization needed here. Deliberately NOT trusting X-Forwarded-Host: it is
  // attacker-controlled on a direct connection, so validating against it would let a
  // DNS-rebound origin spoof its way past the Host check — the very attack the check
  // exists to stop. A direct (non-proxied) connection from such an origin still presents
  // the attacker's real Host and is correctly rejected.
  // The client bundle rides the middleware's CLIENT_JS_PATH route (2026-07-10 security
  // review, finding 4): the bundle embeds the per-start secret in its bootstrap line, so
  // serving it from inside createForgeMiddleware puts it behind the same Host gate AND
  // Origin-vs-Host check as every other forge route — the previous hand-rolled route here
  // checked Host but never Origin.
  const middleware = createForgeMiddleware(queue, [], secret, { agent: opts.agent, channelsFlag: opts.channelsFlag, cwd: opts.root, embedded: opts.embedded }, hub, session, serveClientBundle)

  const server: Server = http.createServer((req, res) => {
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

  const onExit = () => {
    removeEndpointFile(forgeDir)
    session.manager.stop()
  }
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
