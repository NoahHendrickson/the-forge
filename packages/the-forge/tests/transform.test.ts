import { describe, it, expect } from 'vitest'
import { tagJsxSource } from '../src/transform'

describe('tagJsxSource', () => {
  it('tags a host element with file, 1-based line and col', () => {
    const code = `export function App() {\n  return <div className="card">hi</div>\n}\n`
    const result = tagJsxSource(code, 'src/App.tsx')
    expect(result).not.toBeNull()
    expect(result!.code).toContain(
      `<div data-dc-source="src/App.tsx:2:10" className="card">`
    )
  })

  it('does not tag component elements', () => {
    const code = `const x = <Button label="go" />\n`
    const result = tagJsxSource(code, 'src/x.tsx')
    expect(result).toBeNull()
  })
})

describe('tagJsxSource edge cases', () => {
  it('tags self-closing host elements', () => {
    const result = tagJsxSource(`const x = <img src="/a.png" />\n`, 'src/x.tsx')
    expect(result!.code).toContain(
      `<img data-dc-source="src/x.tsx:1:11" src="/a.png" />`
    )
  })

  it('tags web components (lowercase with dash)', () => {
    const result = tagJsxSource(`const x = <my-widget />\n`, 'src/x.tsx')
    expect(result!.code).toContain(`<my-widget data-dc-source="src/x.tsx:1:11" />`)
  })

  it('skips fragments and member-expression components, tags nested hosts', () => {
    const code = `const x = <>\n  <Foo.Bar>\n    <span>y</span>\n  </Foo.Bar>\n</>\n`
    const result = tagJsxSource(code, 'src/x.tsx')
    expect(result!.code).toContain(`<span data-dc-source="src/x.tsx:3:5">y</span>`)
    expect(result!.code).toContain(`<Foo.Bar>`)
  })

  it('tags multiple elements on one line with distinct columns', () => {
    const result = tagJsxSource(`const x = <p><b>a</b></p>\n`, 'src/x.tsx')
    expect(result!.code).toContain(`<p data-dc-source="src/x.tsx:1:11">`)
    expect(result!.code).toContain(`<b data-dc-source="src/x.tsx:1:14">`)
  })

  it('returns null on unparseable code instead of throwing', () => {
    expect(tagJsxSource(`const = <<<`, 'src/broken.tsx')).toBeNull()
  })

  it('returns null for files with no host JSX', () => {
    expect(tagJsxSource(`export const n = 1\n`, 'src/util.ts')).toBeNull()
  })

  it('returns a source map', () => {
    const result = tagJsxSource(`const x = <div />\n`, 'src/x.tsx')
    expect(result!.map).toBeTruthy()
    expect(result!.map.mappings.length).toBeGreaterThan(0)
  })
})
