// @vitest-environment jsdom
import { describe, it, expect } from 'vitest'
import { renderMarkdown } from '../../src/client/chat-markdown'

/** Mounts the fragment so querySelector works. */
function render(text: string): HTMLElement {
  const host = document.createElement('div')
  host.append(renderMarkdown(text))
  return host
}

describe('plain text passthrough', () => {
  it('single-line plain text survives byte-identical through textContent', () => {
    const host = render('line 6')
    expect(host.textContent).toBe('line 6')
    expect(host.querySelector('p.md-p')).not.toBeNull()
  })

  it('300 chars of plain text stay untruncated (the bubble pin)', () => {
    const long = 'x'.repeat(300)
    expect(render(long).textContent).toBe(long)
  })

  it('soft line breaks inside a paragraph are preserved as newline text', () => {
    // .chat-msg keeps white-space: pre-wrap, so the \n text node IS the rendered break
    expect(render('a\nb').textContent).toBe('a\nb')
  })

  it('blank lines split paragraphs', () => {
    const host = render('first\n\nsecond')
    const paras = host.querySelectorAll('p.md-p')
    expect(paras).toHaveLength(2)
    expect(paras[0].textContent).toBe('first')
    expect(paras[1].textContent).toBe('second')
  })
})

describe('block syntax', () => {
  it('fenced code becomes pre.md-code with verbatim content (no inline parsing inside)', () => {
    const host = render('```ts\nconst a = **not bold**\n```')
    const pre = host.querySelector('pre.md-code')
    expect(pre?.textContent).toBe('const a = **not bold**')
    expect(pre?.querySelector('strong')).toBeNull()
  })

  it('an unclosed fence mid-stream renders as an open code block (no crash, no loss)', () => {
    const host = render('```\npartial')
    expect(host.querySelector('pre.md-code')?.textContent).toBe('partial')
  })

  it('headings map # count to .md-h levels', () => {
    const host = render('## Section')
    const h = host.querySelector('.md-h')
    expect(h?.classList.contains('md-h2')).toBe(true)
    expect(h?.textContent).toBe('Section')
  })

  it('dash bullets group into one ul.md-list', () => {
    const host = render('- one\n- two')
    const list = host.querySelector('ul.md-list')
    expect(list?.querySelectorAll('li')).toHaveLength(2)
    expect(list?.querySelectorAll('li')[1].textContent).toBe('two')
  })

  it('numbered items group into ol.md-list with markers stripped', () => {
    const host = render('1. first\n2. second')
    const list = host.querySelector('ol.md-list')
    expect(list?.querySelectorAll('li')).toHaveLength(2)
    expect(list?.querySelectorAll('li')[0].textContent).toBe('first')
  })

  it('> lines become a blockquote.md-quote', () => {
    const host = render('> quoted wisdom')
    expect(host.querySelector('blockquote.md-quote')?.textContent).toBe('quoted wisdom')
  })
})

describe('inline syntax', () => {
  it('backtick spans become code.md-code-inline and protect their content', () => {
    const host = render('use `py-6` here')
    expect(host.querySelector('code.md-code-inline')?.textContent).toBe('py-6')
    expect(host.textContent).toBe('use py-6 here')
  })

  it('emphasis inside a code span is NOT parsed', () => {
    const host = render('`**raw**`')
    expect(host.querySelector('strong')).toBeNull()
    expect(host.querySelector('code.md-code-inline')?.textContent).toBe('**raw**')
  })

  it('** becomes strong, single * becomes em', () => {
    const host = render('**bold** and *slanted*')
    expect(host.querySelector('strong')?.textContent).toBe('bold')
    expect(host.querySelector('em')?.textContent).toBe('slanted')
    expect(host.textContent).toBe('bold and slanted')
  })

  it('unclosed markers render literally (mid-stream safety)', () => {
    expect(render('**not done').textContent).toBe('**not done')
  })
})

describe('links — the safety boundary', () => {
  it('http(s) links become anchors with target=_blank rel=noreferrer', () => {
    const host = render('see [docs](https://example.com/x)')
    const a = host.querySelector('a.md-link') as HTMLAnchorElement
    expect(a).not.toBeNull()
    expect(a.href).toBe('https://example.com/x')
    expect(a.target).toBe('_blank')
    expect(a.rel).toContain('noreferrer')
    expect(a.textContent).toBe('docs')
  })

  it('a javascript: target renders the text with NO anchor at all', () => {
    const host = render('[click](javascript:doEvil)')
    expect(host.querySelector('a')).toBeNull()
    expect(host.textContent).toBe('click')
  })

  it('a relative target also gets no anchor (http/https only)', () => {
    const host = render('[here](/local/path)')
    expect(host.querySelector('a')).toBeNull()
    expect(host.textContent).toBe('here')
  })

  it('model output can never inject markup — angle brackets stay text', () => {
    const host = render('<img src=x onerror=alert(1)>')
    expect(host.querySelector('img')).toBeNull()
    expect(host.textContent).toBe('<img src=x onerror=alert(1)>')
  })
})
