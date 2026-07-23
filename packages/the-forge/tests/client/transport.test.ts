import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { createTransport, forgeSecretHeaders } from '../../src/client/transport'

describe('createTransport', () => {
  const realFetch = globalThis.fetch
  let calls: Array<{ input: string; init?: RequestInit }>
  beforeEach(() => {
    calls = []
    globalThis.fetch = vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      calls.push({ input: String(input), init })
      return Promise.resolve(new Response('{}'))
    }) as typeof fetch
  })
  afterEach(() => {
    globalThis.fetch = realFetch
    delete (globalThis as { __THE_FORGE__?: unknown }).__THE_FORGE__
  })

  it('get() prefixes base and sends no headers', async () => {
    const t = createTransport('http://localhost:4610/p/abc')
    await t.get('/__the-forge/status?ids=')
    expect(calls[0].input).toBe('http://localhost:4610/p/abc/__the-forge/status?ids=')
    expect(calls[0].init).toBeUndefined()
  })

  it('default base is empty — current relative-URL behavior', async () => {
    await createTransport().get('/__the-forge/status?ids=')
    expect(calls[0].input).toBe('/__the-forge/status?ids=')
  })

  it('postJson() sends JSON body, content-type, and lazily-read secret', async () => {
    const t = createTransport()
    // secret set AFTER construction — must still be picked up (lazy read per request)
    ;(globalThis as { __THE_FORGE__?: { secret?: string } }).__THE_FORGE__ = { secret: 's3cr3t' }
    await t.postJson('/__the-forge/queue', { a: 1 })
    const init = calls[0].init!
    expect(init.method).toBe('POST')
    expect((init.headers as Record<string, string>)['X-Forge-Secret']).toBe('s3cr3t')
    expect((init.headers as Record<string, string>)['Content-Type']).toBe('application/json')
    expect(init.body).toBe('{"a":1}')
  })

  it('post() sends secret headers and no body', async () => {
    ;(globalThis as { __THE_FORGE__?: { secret?: string } }).__THE_FORGE__ = { secret: 's' }
    await createTransport().post('/__the-forge/unwatch')
    const init = calls[0].init!
    expect(init.method).toBe('POST')
    expect((init.headers as Record<string, string>)['X-Forge-Secret']).toBe('s')
    expect(init.body).toBeUndefined()
  })

  it('custom secretHeaders override the global read', async () => {
    const t = createTransport('', () => ({ 'X-Forge-Secret': 'hub' }))
    await t.post('/x')
    expect((calls[0].init!.headers as Record<string, string>)['X-Forge-Secret']).toBe('hub')
  })

  it('forgeSecretHeaders returns {} with no bootstrap present', () => {
    expect(forgeSecretHeaders()).toEqual({})
  })
})
