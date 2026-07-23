import { describe, it, expect, vi } from 'vitest'
import { WatchStatus } from '../../src/client/watch'
import { Verifier } from '../../src/client/verifier'
import { LifecycleSession } from '../../src/client/lifecycle'
import { DraftStore } from '../../src/client/drafts'
import type { ForgeTransport } from '../../src/client/transport'

function recordingTransport(): { transport: ForgeTransport; gets: string[] } {
  const gets: string[] = []
  const transport: ForgeTransport = {
    base: 'http://hub/p/x',
    secretHeaders: () => ({}),
    get: (path) => {
      gets.push(path)
      return Promise.resolve(new Response(JSON.stringify({ items: [], watcher: 'none' })))
    },
    post: () => Promise.resolve(new Response('{}')),
    postJson: () => Promise.resolve(new Response('{}')),
  }
  return { transport, gets }
}

describe('transport injection', () => {
  it('WatchStatus polls through the injected transport', async () => {
    vi.useFakeTimers()
    const { transport, gets } = recordingTransport()
    const ws = new WatchStatus(() => {}, undefined, undefined, transport)
    ws.start()
    await vi.advanceTimersByTimeAsync(1)
    expect(gets).toEqual(['/__the-forge/status?ids='])
    ws.stop()
    vi.useRealTimers()
  })

  it('Verifier polls through the injected transport', async () => {
    vi.useFakeTimers()
    const { transport, gets } = recordingTransport()
    const session = new LifecycleSession()
    const v = new Verifier(session, new DraftStore(), () => {}, transport)
    // one registered entry so start() arms the poll loop
    session.register('req-1', [])
    v.start()
    await vi.advanceTimersByTimeAsync(2001)
    expect(gets[0]).toBe('/__the-forge/status?ids=req-1')
    v.stop()
    vi.useRealTimers()
  })
})
