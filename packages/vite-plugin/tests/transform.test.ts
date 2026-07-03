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
