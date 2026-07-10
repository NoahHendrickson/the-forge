// Pure string -> EditResult transforms for `npx forge-mode init`. No fs/process
// imports here by design (task A2 contract) — a later task wires these into the
// CLI's I/O shell, so this file stays trivially unit-testable and reviewable.
//
// Conservative-fallback rule (global constraint, load-bearing): each function
// recognizes a small, fixture-pinned set of AST shapes. Anything else produces
// `{ kind: 'fallback', reason }` and touches nothing — a wrong automated edit to
// a build config is strictly worse than printing a manual snippet. Do not widen
// the recognized-shape list beyond what's in the task brief / tests without a
// matching fixture; that's overbuilding into exactly the risk this rule exists
// to avoid.

import { parse } from '@babel/parser'
import MagicString from 'magic-string'

export type EditResult =
  | { kind: 'edited'; code: string }
  | { kind: 'already' } // forge import/call already present — idempotent no-op
  | { kind: 'fallback'; reason: string } // unrecognized shape — caller prints the manual snippet

// Minimal structural node shape, mirroring transform.ts's house pattern — we
// don't depend on @babel/types (not an allowed runtime dependency; only
// @babel/parser + magic-string are), so nodes are walked as plain objects with
// manual `unknown`-style checks at every boundary.
interface AstNode {
  type: string
  start?: number | null
  end?: number | null
  [key: string]: unknown
}

function parseModule(code: string): AstNode | null {
  try {
    return parse(code, {
      sourceType: 'module',
      plugins: ['typescript', 'jsx'],
    }).program as unknown as AstNode
  } catch {
    return null
  }
}

// CJS `module.exports = expr` isn't valid `sourceType: 'module'` syntax in all
// cases (top-level `module`/`exports` reads are fine, but babel's 'module'
// sourceType forbids some CJS-only constructs some authors mix in, e.g.
// `require()` calls used as statements alongside CJS exports). We parse CJS
// next.config.js candidates with 'unambiguous' so babel picks the right goal
// per-file instead of us hard-coding 'script' (which would reject any stray
// ESM `import` some hybrid configs still contain).
function parseUnambiguous(code: string): AstNode | null {
  try {
    return parse(code, {
      sourceType: 'unambiguous',
      plugins: ['typescript', 'jsx'],
    }).program as unknown as AstNode
  } catch {
    return null
  }
}

function isNode(value: unknown): value is AstNode {
  return !!value && typeof (value as AstNode).type === 'string'
}

function walk(node: AstNode, visit: (n: AstNode) => void): void {
  visit(node)
  for (const key of Object.keys(node)) {
    if (key === 'loc' || key === 'start' || key === 'end') continue
    const child = node[key]
    if (Array.isArray(child)) {
      for (const c of child) {
        if (isNode(c)) walk(c, visit)
      }
    } else if (isNode(child)) {
      walk(child, visit)
    }
  }
}

function findAll(root: AstNode, predicate: (n: AstNode) => boolean): AstNode[] {
  const found: AstNode[] = []
  walk(root, (n) => {
    if (predicate(n)) found.push(n)
  })
  return found
}

/** Indentation (leading whitespace) of the source line containing `offset`. */
function lineIndentAt(code: string, offset: number): string {
  const lineStart = code.lastIndexOf('\n', offset - 1) + 1
  const match = /^[ \t]*/.exec(code.slice(lineStart))
  return match ? match[0] : ''
}

function lastImportEnd(program: AstNode): number | null {
  const body = program.body as unknown as AstNode[]
  let end: number | null = null
  for (const stmt of body) {
    if (stmt.type === 'ImportDeclaration' && typeof stmt.end === 'number') {
      end = stmt.end
    }
  }
  return end
}

// ---------------------------------------------------------------------------
// addViteForgePlugin
// ---------------------------------------------------------------------------

export function addViteForgePlugin(source: string): EditResult {
  if (source.includes('forge-mode/vite')) return { kind: 'already' }

  const program = parseModule(source)
  if (!program) {
    return { kind: 'fallback', reason: 'vite.config could not be parsed' }
  }

  const body = program.body as unknown as AstNode[]
  const exportDefault = body.find((n) => n.type === 'ExportDefaultDeclaration')
  if (!exportDefault) {
    return { kind: 'fallback', reason: 'no default export found in vite.config' }
  }

  const declaration = exportDefault.declaration as AstNode
  if (!declaration) {
    return { kind: 'fallback', reason: 'export default has no expression' }
  }

  // `export default defineConfig(<arg>)` — unwrap to the argument; anything
  // other than a single-argument call whose argument is itself the config
  // object is out of scope (e.g. `defineConfig(() => ({...}))` factories).
  let configObject: AstNode
  if (declaration.type === 'CallExpression') {
    const args = declaration.arguments as unknown as AstNode[]
    if (args.length !== 1 || args[0].type !== 'ObjectExpression') {
      return {
        kind: 'fallback',
        reason: 'default export call does not take a single config object literal (factory functions are not supported)',
      }
    }
    configObject = args[0]
  } else if (declaration.type === 'ObjectExpression') {
    configObject = declaration
  } else {
    return {
      kind: 'fallback',
      reason: 'default export is not a config object or defineConfig(...) call',
    }
  }

  const properties = configObject.properties as unknown as AstNode[]
  const pluginsProp = properties.find(
    (p) =>
      p.type === 'ObjectProperty' &&
      !p.computed &&
      isNode(p.key) &&
      ((p.key as AstNode).type === 'Identifier'
        ? (p.key as AstNode).name === 'plugins'
        : (p.key as AstNode).type === 'StringLiteral' &&
          (p.key as AstNode).value === 'plugins')
  )
  if (!pluginsProp) {
    return { kind: 'fallback', reason: 'no literal "plugins" property found in vite config' }
  }

  const pluginsValue = pluginsProp.value as AstNode
  if (pluginsValue.type !== 'ArrayExpression') {
    return { kind: 'fallback', reason: '"plugins" is not a literal array' }
  }

  const s = new MagicString(source)
  const elements = pluginsValue.elements as unknown as AstNode[]
  if (elements.length > 0 && typeof elements[0].start === 'number') {
    s.appendLeft(elements[0].start as number, 'theForge(), ')
  } else if (typeof pluginsValue.start === 'number' && typeof pluginsValue.end === 'number') {
    // Empty `plugins: []` — insert between the brackets.
    s.appendLeft((pluginsValue.start as number) + 1, 'theForge()')
  } else {
    return { kind: 'fallback', reason: 'could not locate insertion point in plugins array' }
  }

  insertImportInto(s, program, `import { theForge } from 'forge-mode/vite'`)

  return { kind: 'edited', code: s.toString() }
}

// ---------------------------------------------------------------------------
// wrapNextConfigExport
// ---------------------------------------------------------------------------

export function wrapNextConfigExport(source: string): EditResult {
  if (source.includes('forge-mode/next')) return { kind: 'already' }

  // Try ESM `export default <expr>` first, then CJS `module.exports = <expr>`.
  const esmProgram = parseModule(source)
  if (esmProgram) {
    const body = esmProgram.body as unknown as AstNode[]
    const exportDefault = body.find((n) => n.type === 'ExportDefaultDeclaration')
    if (exportDefault) {
      const declaration = exportDefault.declaration as AstNode
      if (
        declaration.type === 'FunctionDeclaration' ||
        declaration.type === 'ClassDeclaration'
      ) {
        return {
          kind: 'fallback',
          reason: 'export default is a function/class declaration (config-function rewrap is not supported)',
        }
      }
      if (typeof declaration.start !== 'number' || typeof declaration.end !== 'number') {
        return { kind: 'fallback', reason: 'could not locate default export expression' }
      }

      const s = new MagicString(source)
      s.appendLeft(declaration.start, 'withForge(')
      s.appendRight(declaration.end, ')')

      insertImportInto(s, esmProgram, `import { withForge } from 'forge-mode/next'`)

      return { kind: 'edited', code: s.toString() }
    }
  }

  // CJS: `module.exports = <expr>`.
  const cjsProgram = parseUnambiguous(source)
  if (cjsProgram) {
    const body = cjsProgram.body as unknown as AstNode[]
    for (const stmt of body) {
      if (stmt.type !== 'ExpressionStatement') continue
      const expr = stmt.expression as AstNode
      if (expr.type !== 'AssignmentExpression' || expr.operator !== '=') continue
      const left = expr.left as AstNode
      if (
        left.type === 'MemberExpression' &&
        isNode(left.object) &&
        (left.object as AstNode).type === 'Identifier' &&
        (left.object as AstNode).name === 'module' &&
        isNode(left.property) &&
        (left.property as AstNode).type === 'Identifier' &&
        (left.property as AstNode).name === 'exports'
      ) {
        const right = expr.right as AstNode
        if (typeof right.start !== 'number' || typeof right.end !== 'number') {
          return { kind: 'fallback', reason: 'could not locate module.exports expression' }
        }

        const s = new MagicString(source)
        s.appendLeft(right.start, 'withForge(')
        s.appendRight(right.end, ')')

        // A leading directive prologue (e.g. 'use strict') must stay the very first
        // statement(s) in the file — prepending the require unconditionally would land
        // ahead of it and silently de-strictify the module. Babel parses directives into
        // `program.directives`, separate from `body`, so insert after the last one's end
        // when present, else prepend as before.
        const directives = (cjsProgram.directives as unknown as AstNode[]) ?? []
        const lastDirectiveEnd = directives.length > 0 ? directives[directives.length - 1].end : null
        if (typeof lastDirectiveEnd === 'number') {
          s.appendLeft(lastDirectiveEnd, `\n\nconst { withForge } = require('forge-mode/next')`)
        } else {
          s.prepend(`const { withForge } = require('forge-mode/next')\n\n`)
        }

        return { kind: 'edited', code: s.toString() }
      }
    }
  }

  return { kind: 'fallback', reason: 'no recognizable default export or module.exports assignment found in next.config' }
}

// ---------------------------------------------------------------------------
// mountDesignMode
// ---------------------------------------------------------------------------

function jsxElementName(el: AstNode): string | null {
  const opening = el.openingElement as AstNode | undefined
  if (!opening) return null
  const name = opening.name as AstNode
  if (name.type !== 'JSXIdentifier') return null
  return (name.name as string) ?? null
}

// Shared by all three edit functions: insert `importLine` (no trailing
// newline) immediately after the last existing ImportDeclaration, or prepend
// it (plus a blank line) when the file has no imports at all. Consolidated
// here so addViteForgePlugin, wrapNextConfigExport's ESM path, and both
// mountDesignMode* functions don't each reimplement the same splice.
function insertImportInto(s: MagicString, program: AstNode, importLine: string): void {
  const afterLastImport = lastImportEnd(program)
  if (afterLastImport !== null) {
    s.appendLeft(afterLastImport, `\n${importLine}`)
  } else {
    // No existing imports — prepend the import followed by a blank line so
    // it reads as its own paragraph rather than butting against the first
    // statement.
    s.prepend(`${importLine}\n\n`)
  }
}

function mountDesignModeApp(source: string, program: AstNode): EditResult {
  const bodyElements = findAll(program, (n) => n.type === 'JSXElement').filter(
    (el) => jsxElementName(el) === 'body'
  )
  if (bodyElements.length === 0) {
    return { kind: 'fallback', reason: 'no literal <body> element found in layout' }
  }
  // Ambiguous target: with more than one <body> we can't safely pick one to
  // mount into (ties back to the conservative-fallback rule at the top of
  // this file) — bail rather than guess which is "the" body.
  if (bodyElements.length !== 1) {
    return {
      kind: 'fallback',
      reason: `expected exactly one <body> element, found ${bodyElements.length}`,
    }
  }

  const bodyEl = bodyElements[0]
  const opening = bodyEl.openingElement as AstNode
  if (typeof opening.end !== 'number') {
    return { kind: 'fallback', reason: 'could not locate <body> opening tag' }
  }

  // Indent the inserted line to match the existing first child, unless that child sits on
  // the same source line as <body> itself (e.g. `<body>{children}</body>` all on one line) —
  // matching its column would put <ForgeDesignMode /> at <body>'s own indent, not nested
  // under it. In both that case and the no-children case, fall back to one level deeper
  // than <body>'s own line rather than hardcoding a width.
  const bodyLineIndent = lineIndentAt(source, opening.start as number)
  const children = (bodyEl.children as unknown as AstNode[]).filter(
    (c) => !(c.type === 'JSXText' && typeof c.value === 'string' && c.value.trim() === '')
  )
  const firstChild = children[0]
  const firstChildOnOwnLine =
    firstChild !== undefined && source.lastIndexOf('\n', (firstChild.start as number) - 1) >= (opening.end as number)
  const indent = firstChildOnOwnLine ? lineIndentAt(source, firstChild.start as number) : bodyLineIndent + '  '

  const s = new MagicString(source)
  insertImportInto(s, program, `import { ForgeDesignMode } from 'forge-mode/design-mode'`)
  s.appendLeft(opening.end, `\n${indent}<ForgeDesignMode />`)

  return { kind: 'edited', code: s.toString() }
}

function mountDesignModePages(source: string, program: AstNode): EditResult {
  const componentElements = findAll(program, (n) => n.type === 'JSXElement').filter(
    (el) => jsxElementName(el) === 'Component'
  )
  if (componentElements.length === 0) {
    return { kind: 'fallback', reason: 'no <Component> element found in _app' }
  }
  // Ambiguous target: with more than one <Component> we can't safely pick one
  // to mount into (same conservative-fallback rule as the <body> guard above)
  // — bail rather than guess which is "the" Component.
  if (componentElements.length !== 1) {
    return {
      kind: 'fallback',
      reason: `expected exactly one <Component> element, found ${componentElements.length}`,
    }
  }

  const componentEl = componentElements[0]
  if (typeof componentEl.start !== 'number' || typeof componentEl.end !== 'number') {
    return { kind: 'fallback', reason: 'could not locate <Component> element' }
  }

  // Walk up to find the enclosing ReturnStatement's argument to tell apart
  // "sibling in an existing fragment/element" from "the entire return value".
  const parent = findParent(program, componentEl)

  const importLine = `import { ForgeDesignMode } from 'forge-mode/design-mode'`

  if (parent && (parent.type === 'JSXElement' || parent.type === 'JSXFragment')) {
    const indent = lineIndentAt(source, componentEl.start)
    const s = new MagicString(source)
    insertImportInto(s, program, importLine)
    s.appendRight(componentEl.end, `\n${indent}<ForgeDesignMode />`)
    return { kind: 'edited', code: s.toString() }
  }

  // Not nested in a JSX parent — check whether it's the entire return argument.
  const returnStatements = findAll(program, (n) => n.type === 'ReturnStatement')
  const isBareReturn = returnStatements.some((r) => r.argument === componentEl)
  if (!isBareReturn) {
    return { kind: 'fallback', reason: '<Component> is not directly returned or nested in a JSX parent' }
  }

  const s = new MagicString(source)
  insertImportInto(s, program, importLine)
  const original = source.slice(componentEl.start, componentEl.end)
  s.overwrite(componentEl.start, componentEl.end, `<>${original}<ForgeDesignMode /></>`)
  return { kind: 'edited', code: s.toString() }
}

// Finds the direct AST parent of `target` by identity, walking from `root`.
// We don't track parent pointers during the shared `walk()` (transform.ts's
// house pattern doesn't either), so this is a second, narrow traversal scoped
// to exactly this lookup rather than adding parent-pointer bookkeeping to the
// generic walker.
function findParent(root: AstNode, target: AstNode): AstNode | null {
  let result: AstNode | null = null
  const visit = (node: AstNode): void => {
    for (const key of Object.keys(node)) {
      if (key === 'loc' || key === 'start' || key === 'end') continue
      const child = node[key]
      if (Array.isArray(child)) {
        for (const c of child) {
          if (isNode(c)) {
            if (c === target) result = node
            else visit(c)
          }
        }
      } else if (isNode(child)) {
        if (child === target) result = node
        else visit(child)
      }
    }
  }
  visit(root)
  return result
}

export function mountDesignMode(source: string, router: 'app' | 'pages'): EditResult {
  if (source.includes('forge-mode/design-mode')) return { kind: 'already' }

  const program = parseModule(source)
  if (!program) {
    return { kind: 'fallback', reason: 'file could not be parsed' }
  }

  return router === 'app' ? mountDesignModeApp(source, program) : mountDesignModePages(source, program)
}
