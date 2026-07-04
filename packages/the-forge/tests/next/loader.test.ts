import { describe, it, expect, vi } from 'vitest'
import path from 'node:path'
import forgeLoader from '../../src/next/loader'

// Stub of the webpack-loader-API subset both Turbopack and webpack support
// (this.resourcePath, this.getOptions(), this.callback(err, code, map)) — see
// LoaderContext in src/next/loader.ts. No real bundler in these unit tests.
function makeContext(resourcePath: string, root: string) {
  const callback = vi.fn()
  const ctx = {
    resourcePath,
    getOptions: () => ({ root }),
    callback,
  }
  return { ctx, callback }
}

describe('forgeLoader', () => {
  it('tags a .tsx source and calls back with file:line:col from a known snippet', () => {
    const root = '/project'
    const resourcePath = path.join(root, 'src/App.tsx')
    const { ctx, callback } = makeContext(resourcePath, root)
    const code = `export function App() {\n  return <div className="card">hi</div>\n}\n`

    forgeLoader.call(ctx as any, code)

    expect(callback).toHaveBeenCalledTimes(1)
    const [err, outCode, map] = callback.mock.calls[0]
    expect(err).toBeNull()
    expect(outCode).toContain(`<div data-dc-source="src/App.tsx:2:10" className="card">`)
    expect(map).toBeTruthy()
  })

  it('passes .ts (no x) sources through unchanged', () => {
    const root = '/project'
    const resourcePath = path.join(root, 'src/util.ts')
    const { ctx, callback } = makeContext(resourcePath, root)
    const code = `export const n = 1\n`

    forgeLoader.call(ctx as any, code)

    expect(callback).toHaveBeenCalledWith(null, code, undefined)
  })

  it('passes node_modules paths through unchanged', () => {
    const root = '/project'
    const resourcePath = path.join(root, 'node_modules/pkg/Comp.tsx')
    const { ctx, callback } = makeContext(resourcePath, root)
    const code = `export function C() { return <div>hi</div> }\n`

    forgeLoader.call(ctx as any, code)

    expect(callback).toHaveBeenCalledWith(null, code, undefined)
  })

  it('returns parse-failure source verbatim (tagJsxSource returns null)', () => {
    const root = '/project'
    const resourcePath = path.join(root, 'src/broken.tsx')
    const { ctx, callback } = makeContext(resourcePath, root)
    const code = `const = <<<`

    forgeLoader.call(ctx as any, code)

    expect(callback).toHaveBeenCalledWith(null, code, undefined)
  })

  it('relativizes resourcePath against options.root with POSIX separators', () => {
    const root = '/project'
    // nested dir to prove path.sep -> '/' normalization matters
    const resourcePath = path.join(root, 'src', 'components', 'Widget.tsx')
    const { ctx, callback } = makeContext(resourcePath, root)
    const code = `export function Widget() { return <div>hi</div> }\n`

    forgeLoader.call(ctx as any, code)

    const [, outCode] = callback.mock.calls[0]
    expect(outCode).toContain('data-dc-source="src/components/Widget.tsx:1:')
  })

  it('passes through untagged when the resourcePath escapes root', () => {
    const root = '/project/sub'
    // Resolves to a path outside root -> relative path starts with '..'
    const resourcePath = path.join('/project/other/Widget.tsx')
    const { ctx, callback } = makeContext(resourcePath, root)
    const code = `export function Widget() { return <div>hi</div> }\n`

    forgeLoader.call(ctx as any, code)

    expect(callback).toHaveBeenCalledWith(null, code, undefined)
  })
})
