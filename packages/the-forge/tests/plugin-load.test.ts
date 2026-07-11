import { describe, it, expect } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { EventEmitter } from 'node:events'
import { theForge } from '../src/vite'
import { CLIENT_JS_PATH } from '../src/server/endpoints'

describe('client bundle serving (integration)', () => {
  // dist/ is guaranteed fresh by tests/global-setup.ts (built once before any worker
  // spawns). Never build from a test file — the build's `rm -rf dist` races every
  // parallel worker that reads dist/ artifacts.
  it('GET /__the-forge/client.js through the plugin middleware returns the built client bundle', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-plugin-load-int-'))
    const plugin = theForge()
    ;(plugin.configResolved as (c: { root: string }) => void)({ root })

    const used: Array<(req: unknown, res: unknown, next: () => void) => void> = []
    const httpServer = new EventEmitter() as EventEmitter & { address(): { port: number; address: string } }
    httpServer.address = () => ({ port: 5199, address: '127.0.0.1' })
    ;(plugin.configureServer as (s: unknown) => void)({
      middlewares: { use: (mw: (typeof used)[0]) => used.push(mw) },
      httpServer,
      config: { server: {} },
    })
    httpServer.emit('listening')

    const body = await new Promise<string>((resolve) => {
      const req = { method: 'GET', url: CLIENT_JS_PATH, headers: { host: 'localhost:5173' }, on: () => undefined }
      const res = {
        statusCode: 0,
        on: () => undefined,
        setHeader: () => undefined,
        end: (s?: string) => resolve(s ?? ''),
      }
      used[0](req, res, () => resolve(''))
    })

    expect(body).toBeTruthy()
    // The client only *reads* the data-dc-source attribute (via el.dataset.dcSource);
    // the literal `data-dc-source` string is written by the server-side JSX transform
    // in dist/vite.js, not by the client bundle. Assert on `dcSource`, which is what
    // actually appears in dist/client.js and proves the right bundle was loaded.
    expect(body).toContain('dcSource')
  })
})
