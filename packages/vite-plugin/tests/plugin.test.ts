import { describe, it, expect } from 'vitest'
import { designCompanion, CLIENT_ID } from '../src/index'

type TransformHook = (code: string, id: string) => { code: string } | null

function getPlugin() {
  const plugin = designCompanion()
  // simulate vite calling configResolved with a root
  ;(plugin.configResolved as (c: { root: string }) => void)({ root: '/proj' })
  const transform = plugin.transform as unknown as TransformHook
  return { plugin, transform }
}

describe('designCompanion plugin', () => {
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
})
