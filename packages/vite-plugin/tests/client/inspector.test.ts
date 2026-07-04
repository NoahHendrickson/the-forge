// @vitest-environment jsdom
import { describe, it, expect } from 'vitest'
import { buildInspectorData, STYLE_PROPS } from '../../src/client/inspector'

describe('buildInspectorData', () => {
  it('extracts tag, source, and classes', () => {
    document.body.innerHTML = `<button data-dc-source="src/Button.tsx:42:8" class="btn btn-primary">go</button>`
    const el = document.querySelector('button')!
    const data = buildInspectorData(el)
    expect(data.tag).toBe('button')
    expect(data.source).toEqual({ file: 'src/Button.tsx', line: 42, col: 8 })
    expect(data.classes).toEqual(['btn', 'btn-primary'])
  })

  it('reports every STYLE_PROPS key as a string', () => {
    document.body.innerHTML = `<div data-dc-source="src/a.tsx:1:1"></div>`
    const data = buildInspectorData(document.querySelector('div')!)
    for (const prop of STYLE_PROPS) {
      expect(typeof data.styles[prop]).toBe('string')
    }
  })

  it('handles untagged elements with a null source', () => {
    document.body.innerHTML = `<div class=""></div>`
    const data = buildInspectorData(document.querySelector('div')!)
    expect(data.source).toBeNull()
    expect(data.classes).toEqual([])
    expect(data.width).toBe(0) // jsdom has no layout; rounds to 0
  })
})
