import { parse } from '@babel/parser'
import MagicString, { type SourceMap } from 'magic-string'

interface AstNode {
  type: string
  [key: string]: unknown
}

/**
 * Adds data-dc-source="<relPath>:<line>:<col>" to every host (lowercase)
 * JSX element. Returns null when nothing was tagged or the file can't parse.
 */
export function tagJsxSource(
  code: string,
  relPath: string
): { code: string; map: SourceMap } | null {
  let ast: ReturnType<typeof parse>
  try {
    ast = parse(code, {
      sourceType: 'module',
      plugins: ['jsx', 'typescript'],
    })
  } catch {
    return null
  }

  const s = new MagicString(code)
  let count = 0

  const visit = (node: AstNode): void => {
    if (node.type === 'JSXOpeningElement') {
      const name = node.name as AstNode & { name?: string; end?: number }
      if (
        name.type === 'JSXIdentifier' &&
        typeof name.name === 'string' &&
        /^[a-z]/.test(name.name) &&
        typeof name.end === 'number'
      ) {
        const loc = (node as { loc?: { start: { line: number; column: number } } }).loc
        if (loc) {
          const { line, column } = loc.start
          s.appendLeft(
            name.end,
            ` data-dc-source="${relPath}:${line}:${column + 1}"`
          )
          count++
        }
      }
    }
    for (const key of Object.keys(node)) {
      const child = node[key]
      if (Array.isArray(child)) {
        for (const c of child) {
          if (c && typeof (c as AstNode).type === 'string') visit(c as AstNode)
        }
      } else if (child && typeof (child as AstNode).type === 'string') {
        visit(child as AstNode)
      }
    }
  }

  visit(ast.program as unknown as AstNode)

  if (count === 0) return null
  return { code: s.toString(), map: s.generateMap({ hires: true }) }
}
