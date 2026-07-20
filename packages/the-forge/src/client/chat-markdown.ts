// Zero-dependency markdown → DOM renderer for assistant chat bubbles (2026-07-18 chat-ux
// polish). Hand-rolled on purpose: a markdown library is a runtime dependency, and the
// product constraint is @babel/parser + magic-string only. Scope is the subset agent CLIs
// actually emit — paragraphs, headings, fenced code, lists, quotes, inline
// code/bold/italic/links — NOT full CommonMark; unrecognized syntax renders literally,
// which is the safe failure mode for a chat surface.
//
// Safety: DOM is built exclusively with createElement/textContent — model output never
// reaches innerHTML, so it can never inject markup. Links only get an href when the target
// parses as http(s) (a `javascript:` target renders as plain text), and always carry
// target=_blank rel=noreferrer so a click can never reach back into the dev-server page.
//
// Plain text passes through byte-identical via textContent — the existing bubble tests pin
// exact textContent equality, and streaming re-renders (session-feed.ts appendDelta calls
// this on the full accumulated text each delta) must not drift the visible text while
// markers are still unclosed mid-stream: an unclosed `**` simply renders literally until
// its closer arrives, same reflow-as-it-streams behavior as claude.ai/ChatGPT.

/** Matches inline tokens in precedence order: code span first (its content is opaque —
 * `*` inside backticks must not become emphasis), then link, bold, italic. */
const INLINE_RE = /`([^`]+)`|\[([^\]]+)\]\(([^)\s]+)\)|\*\*([^*]+)\*\*|\*([^*\s][^*]*)\*/

function parseInline(text: string): Node[] {
  const nodes: Node[] = []
  let rest = text
  while (rest.length > 0) {
    const m = INLINE_RE.exec(rest)
    if (!m) {
      nodes.push(document.createTextNode(rest))
      break
    }
    if (m.index > 0) nodes.push(document.createTextNode(rest.slice(0, m.index)))
    if (m[1] !== undefined) {
      const code = document.createElement('code')
      code.className = 'md-code-inline'
      code.textContent = m[1]
      nodes.push(code)
    } else if (m[2] !== undefined && m[3] !== undefined) {
      // http(s) only — anything else (javascript:, data:, relative) is rendered as the
      // link TEXT with no href at all, not a best-effort anchor: a dead-looking span is
      // safer than a live surprising one.
      if (/^https?:\/\//i.test(m[3])) {
        const a = document.createElement('a')
        a.className = 'md-link'
        a.href = m[3]
        a.target = '_blank'
        a.rel = 'noreferrer noopener'
        a.append(...parseInline(m[2]))
        nodes.push(a)
      } else {
        nodes.push(document.createTextNode(m[2]))
      }
    } else if (m[4] !== undefined) {
      const strong = document.createElement('strong')
      strong.append(...parseInline(m[4]))
      nodes.push(strong)
    } else if (m[5] !== undefined) {
      const em = document.createElement('em')
      em.append(...parseInline(m[5]))
      nodes.push(em)
    }
    rest = rest.slice(m.index + m[0].length)
  }
  return nodes
}

/** Joins a block's source lines back together with literal '\n' text — the bubble keeps
 * `white-space: pre-wrap` (chat text has meaningful soft breaks), so a text node newline
 * IS a rendered line break; no <br> elements needed. */
function appendLines(el: HTMLElement, lines: string[]): void {
  lines.forEach((line, i) => {
    if (i > 0) el.append(document.createTextNode('\n'))
    el.append(...parseInline(line))
  })
}

/**
 * Renders markdown to a detached fragment the caller mounts (session-feed.ts replaces the
 * assistant bubble's children with it on every final text AND every streaming delta).
 */
export function renderMarkdown(text: string): DocumentFragment {
  const frag = document.createDocumentFragment()
  const lines = text.split('\n')
  let i = 0
  let para: string[] = []

  const flushPara = (): void => {
    if (para.length === 0) return
    const p = document.createElement('p')
    p.className = 'md-p'
    appendLines(p, para)
    frag.append(p)
    para = []
  }

  while (i < lines.length) {
    const line = lines[i]
    const fence = /^```/.exec(line)
    if (fence) {
      flushPara()
      const code: string[] = []
      i++
      while (i < lines.length && !/^```\s*$/.test(lines[i])) {
        code.push(lines[i])
        i++
      }
      i++ // consume the closing fence (or run off the end mid-stream — fine, renders open)
      const pre = document.createElement('pre')
      pre.className = 'md-code'
      pre.textContent = code.join('\n')
      frag.append(pre)
      continue
    }
    const heading = /^(#{1,4})\s+(.*)$/.exec(line)
    if (heading) {
      flushPara()
      const h = document.createElement('div')
      h.className = `md-h md-h${heading[1].length}`
      h.append(...parseInline(heading[2]))
      frag.append(h)
      i++
      continue
    }
    const isUl = (l: string): boolean => /^\s*[-*]\s+/.test(l)
    const isOl = (l: string): boolean => /^\s*\d+[.)]\s+/.test(l)
    if (isUl(line) || isOl(line)) {
      flushPara()
      const ordered = isOl(line)
      const list = document.createElement(ordered ? 'ol' : 'ul')
      list.className = 'md-list'
      while (i < lines.length && (ordered ? isOl(lines[i]) : isUl(lines[i]))) {
        const item = document.createElement('li')
        item.append(...parseInline(lines[i].replace(ordered ? /^\s*\d+[.)]\s+/ : /^\s*[-*]\s+/, '')))
        list.append(item)
        i++
      }
      frag.append(list)
      continue
    }
    if (/^>\s?/.test(line)) {
      flushPara()
      const quoted: string[] = []
      while (i < lines.length && /^>\s?/.test(lines[i])) {
        quoted.push(lines[i].replace(/^>\s?/, ''))
        i++
      }
      const quote = document.createElement('blockquote')
      quote.className = 'md-quote'
      appendLines(quote, quoted)
      frag.append(quote)
      continue
    }
    if (line.trim() === '') {
      flushPara()
      i++
      continue
    }
    para.push(line)
    i++
  }
  flushPara()
  return frag
}
