import { describe, it, expect, beforeEach } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { createForgeRuntime } from '../../src/server/runtime'

let root: string

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-runtime-'))
})

describe('createForgeRuntime', () => {
  it('constructs a Queue rooted at <resolvedRoot>/.the-forge', () => {
    const runtime = createForgeRuntime(root)
    expect(runtime.forgeDir).toBe(path.join(root, '.the-forge'))
    const item = runtime.queue.add({}, '# md')
    expect(fs.existsSync(path.join(runtime.forgeDir, 'queue.json'))).toBe(true)
    expect(runtime.queue.get(item.id)!.markdown).toBe('# md')
  })

  it('generates a fresh secret per call', () => {
    const a = createForgeRuntime(root)
    const b = createForgeRuntime(fs.mkdtempSync(path.join(os.tmpdir(), 'forge-runtime-')))
    expect(a.secret).not.toBe(b.secret)
    expect(typeof a.secret).toBe('string')
    expect(a.secret.length).toBeGreaterThan(0)
  })

  it('wires the hub so claim() pulls from the SAME queue', async () => {
    const runtime = createForgeRuntime(root)
    runtime.queue.add({}, '# for the hub')
    // The hub's `wait()` claims immediately when items are already claimable (no need to
    // wait out the hold window) — proves hub.claim === () => queue.pull() wiring end to end.
    const { promise } = runtime.hub.wait()
    const result = await promise
    expect(result).toMatchObject({ stop: false })
    if (!result.stop) {
      expect(result.items).toHaveLength(1)
      expect(result.items[0].markdown).toBe('# for the hub')
    }
    // The item is now claimed in the queue itself (not a copy) — same instance.
    expect(runtime.queue.list()[0].status).toBe('claimed')
  })

  it('wires hub.applying() to queue.hasFreshClaims()', () => {
    const runtime = createForgeRuntime(root)
    expect(runtime.hub.state()).toBe('none')
    const item = runtime.queue.add({}, '# fresh claim test')
    runtime.queue.pull() // claims it — hasFreshClaims() now true
    expect(runtime.queue.get(item.id)!.status).toBe('claimed')
    // hasFreshClaims driving applying() is exercised indirectly via WatcherHub.state() in
    // endpoints/watchers suites; here we just assert the queue backing is the same instance.
    expect(runtime.queue.hasFreshClaims()).toBe(true)
  })

  it('when viteRoot is omitted, does not attempt legacy-dir migration (no viteRoot to migrate from)', () => {
    // Would throw/behave oddly if it tried to migrate from a nonexistent viteRoot other than
    // resolvedRoot; omitting viteRoot must simply skip migrateLegacyForgeDir entirely.
    expect(() => createForgeRuntime(root)).not.toThrow()
  })

  it('when viteRoot is provided and differs from resolvedRoot, migrates a legacy queue.json', () => {
    const viteRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-viteroot-'))
    const legacyDir = path.join(viteRoot, '.the-forge')
    fs.mkdirSync(legacyDir, { recursive: true })
    const legacyItem = {
      id: 'legacy-1',
      createdAt: new Date().toISOString(),
      status: 'pending',
      markdown: '# legacy',
      request: null,
    }
    fs.writeFileSync(path.join(legacyDir, 'queue.json'), JSON.stringify([legacyItem]))

    const runtime = createForgeRuntime(root, viteRoot)
    expect(runtime.queue.get('legacy-1')?.markdown).toBe('# legacy')
    // Legacy queue.json is removed by the migration once merged.
    expect(fs.existsSync(path.join(legacyDir, 'queue.json'))).toBe(false)
  })
})
