// @vitest-environment jsdom
import { describe, it, expect } from 'vitest'
import { parseSourceAttr, findTaggedElement } from '../../src/client/source'

describe('parseSourceAttr', () => {
  it('parses file:line:col', () => {
    expect(parseSourceAttr('src/App.tsx:12:4')).toEqual({
      file: 'src/App.tsx',
      line: 12,
      col: 4,
    })
  })

  it('keeps colons in the file path (windows-style)', () => {
    expect(parseSourceAttr('C:/proj/src/App.tsx:3:7')).toEqual({
      file: 'C:/proj/src/App.tsx',
      line: 3,
      col: 7,
    })
  })

  it('returns null for malformed values', () => {
    expect(parseSourceAttr('nonsense')).toBeNull()
    expect(parseSourceAttr('file.tsx:x:y')).toBeNull()
  })
})

describe('findTaggedElement', () => {
  it('returns the element itself when tagged', () => {
    document.body.innerHTML = `<div data-dc-source="src/a.tsx:1:1" id="a"></div>`
    const el = document.getElementById('a')!
    expect(findTaggedElement(el)).toBe(el)
  })

  it('walks up to the nearest tagged ancestor', () => {
    document.body.innerHTML = `<section data-dc-source="src/a.tsx:1:1" id="outer"><svg><path id="leaf"/></svg></section>`
    const leaf = document.getElementById('leaf')!
    expect(findTaggedElement(leaf)).toBe(document.getElementById('outer'))
  })

  it('returns null when nothing is tagged', () => {
    document.body.innerHTML = `<div id="a"></div>`
    expect(findTaggedElement(document.getElementById('a'))).toBeNull()
    expect(findTaggedElement(null)).toBeNull()
  })

  it('returns tagged SVG elements themselves', () => {
    document.body.innerHTML = `<div data-dc-source="src/a.tsx:1:1"><svg><path data-dc-source="src/Icon.tsx:5:3" id="p"/></svg></div>`
    const p = document.getElementById('p')!
    expect(findTaggedElement(p)).toBe(p)
  })
})
