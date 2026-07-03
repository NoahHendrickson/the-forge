# M1: Source Tagging + Inspector Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A Vite plugin that tags every host JSX element with its source location in dev mode, plus a shadow-DOM toolbar overlay with hover/select and an inspector panel showing source, classes, size, and computed styles.

**Architecture:** Single npm package `@design-companion/vite` with two build outputs — a Node-side Vite plugin (`src/index.ts`, `src/transform.ts`) and a browser client bundle (`src/client/*`) the plugin serves via a virtual module and injects into `index.html`. A fixture React app under `fixtures/demo-app` exercises the whole loop. Spec: `docs/specs/2026-07-03-design-companion-design.md` (§3.1, §3.2, §10, M1).

**Tech Stack:** TypeScript (strict), npm workspaces, Vite 6, @babel/parser + magic-string (transform), tsup (build), vitest (+jsdom for client tests), React 18 + Tailwind v4 fixture.

## Global Constraints

- Plugin is dev-only: `apply: 'serve'` — must never run in `vite build` (spec §10).
- Transform runs `enforce: 'pre'` (before the React plugin compiles JSX away).
- Tag **host elements only** (lowercase JSX names). Components/fragments are never tagged — no prop pollution.
- Attribute name: `data-dc-source`, value `<relative-file>:<line>:<col>`, line and col **1-based**.
- Files under `node_modules/` and outside the Vite root are never transformed.
- Every transform returns a source map (magic-string `hires`) — line-number fidelity is a spec commitment (§10).
- Overlay renders in a shadow root; **zero document-level listeners while design mode is off** (§10).
- Hover hit-testing rAF-throttled; overlay ignores events originating from itself.
- No new runtime dependencies beyond: `@babel/parser`, `magic-string`. `vite` is a peer dependency.
- Node ≥ 20. TypeScript `strict: true` everywhere.

---

### Task 1: Workspace scaffold + core transform (happy path)

**Files:**
- Create: `package.json` (workspace root)
- Create: `.gitignore`
- Create: `packages/vite-plugin/package.json`
- Create: `packages/vite-plugin/tsconfig.json`
- Create: `packages/vite-plugin/vitest.config.ts`
- Create: `packages/vite-plugin/src/transform.ts`
- Test: `packages/vite-plugin/tests/transform.test.ts`

**Interfaces:**
- Consumes: nothing (first task)
- Produces: `tagJsxSource(code: string, relPath: string): { code: string; map: SourceMap } | null` — returns `null` when nothing was tagged or the file fails to parse; later tasks (plugin wrapper) rely on this exact signature.

- [ ] **Step 1: Scaffold the workspace**

`package.json` (root):

```json
{
  "name": "design-companion",
  "private": true,
  "workspaces": ["packages/*", "fixtures/*"],
  "scripts": {
    "test": "npm run test -w @design-companion/vite",
    "build": "npm run build -w @design-companion/vite"
  }
}
```

`.gitignore`:

```
node_modules/
dist/
.design-companion/
```

`packages/vite-plugin/package.json`:

```json
{
  "name": "@design-companion/vite",
  "version": "0.0.1",
  "type": "module",
  "main": "./dist/index.js",
  "types": "./dist/index.d.ts",
  "files": ["dist"],
  "scripts": {
    "build": "tsup",
    "test": "vitest run",
    "test:watch": "vitest"
  },
  "dependencies": {
    "@babel/parser": "^7.26.0",
    "magic-string": "^0.30.0"
  },
  "peerDependencies": {
    "vite": ">=5"
  },
  "devDependencies": {
    "@types/node": "^22.0.0",
    "jsdom": "^25.0.0",
    "tsup": "^8.0.0",
    "typescript": "^5.6.0",
    "vite": "^6.0.0",
    "vitest": "^2.1.0"
  }
}
```

`packages/vite-plugin/tsconfig.json`:

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "ESNext",
    "moduleResolution": "bundler",
    "lib": ["ES2022", "DOM", "DOM.Iterable"],
    "strict": true,
    "skipLibCheck": true,
    "noEmit": true,
    "types": ["node"]
  },
  "include": ["src", "tests"]
}
```

`packages/vite-plugin/vitest.config.ts`:

```ts
import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    include: ['tests/**/*.test.ts'],
  },
})
```

Run: `npm install` (from repo root). Expected: lockfile created, no errors.

- [ ] **Step 2: Write the failing test**

`packages/vite-plugin/tests/transform.test.ts`:

```ts
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
```

(The `<` of `<div` sits at line 2, column 10 when counting 1-based.)

- [ ] **Step 3: Run test to verify it fails**

Run: `npm run test -w @design-companion/vite`
Expected: FAIL — `Cannot find module '../src/transform'`

- [ ] **Step 4: Write the implementation**

`packages/vite-plugin/src/transform.ts`:

```ts
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
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `npm run test -w @design-companion/vite`
Expected: PASS (2 tests)

- [ ] **Step 6: Commit**

```bash
git add package.json .gitignore packages/vite-plugin
git commit -m "feat: workspace scaffold and JSX source-tagging transform"
```

---

### Task 2: Transform edge cases

**Files:**
- Modify: `packages/vite-plugin/src/transform.ts` (only if a test exposes a gap)
- Test: `packages/vite-plugin/tests/transform.test.ts`

**Interfaces:**
- Consumes: `tagJsxSource` from Task 1 (same signature)
- Produces: verified behavior later tasks depend on — self-closing support, fragment/member-expression skipping, parse-error → `null`, source map presence, web-component tagging.

- [ ] **Step 1: Write the failing tests**

Append to `packages/vite-plugin/tests/transform.test.ts`:

```ts
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
```

- [ ] **Step 2: Run tests**

Run: `npm run test -w @design-companion/vite`
Expected: all PASS with the Task 1 implementation (it was written to cover these). If any fail, fix `transform.ts` minimally until green — do not weaken assertions.

- [ ] **Step 3: Commit**

```bash
git add packages/vite-plugin/tests/transform.test.ts packages/vite-plugin/src/transform.ts
git commit -m "test: transform edge cases (self-closing, fragments, columns, parse errors)"
```

---

### Task 3: Vite plugin wrapper

**Files:**
- Create: `packages/vite-plugin/src/index.ts`
- Test: `packages/vite-plugin/tests/plugin.test.ts`

**Interfaces:**
- Consumes: `tagJsxSource(code, relPath)` from Task 1.
- Produces: `designCompanion(): Plugin` (named export, also default). Serves the client bundle at virtual id `/@design-companion/client` by reading `client.js` next to the built plugin file (Task 7 produces that file). Exports `CLIENT_ID = '/@design-companion/client'` for tests.

- [ ] **Step 1: Write the failing tests**

`packages/vite-plugin/tests/plugin.test.ts`:

```ts
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
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npm run test -w @design-companion/vite`
Expected: FAIL — `Cannot find module '../src/index'`

- [ ] **Step 3: Write the implementation**

`packages/vite-plugin/src/index.ts`:

```ts
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import type { Plugin } from 'vite'
import { tagJsxSource } from './transform'

export const CLIENT_ID = '/@design-companion/client'

export function designCompanion(): Plugin {
  let root = process.cwd()

  return {
    name: 'design-companion',
    apply: 'serve',
    enforce: 'pre',

    configResolved(config) {
      root = config.root
    },

    transform(code, id) {
      const [file] = id.split('?')
      if (!/\.[jt]sx$/.test(file)) return null
      if (file.includes('/node_modules/')) return null
      const rel = path.relative(root, file)
      if (rel.startsWith('..') || path.isAbsolute(rel)) return null
      return tagJsxSource(code, rel)
    },

    resolveId(id) {
      if (id === CLIENT_ID) return CLIENT_ID
      return undefined
    },

    load(id) {
      if (id !== CLIENT_ID) return null
      const dir = path.dirname(fileURLToPath(import.meta.url))
      return fs.readFileSync(path.join(dir, 'client.js'), 'utf8')
    },

    transformIndexHtml() {
      return [
        {
          tag: 'script',
          attrs: { type: 'module', src: CLIENT_ID },
          injectTo: 'body',
        },
      ]
    },
  }
}

export default designCompanion
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm run test -w @design-companion/vite`
Expected: PASS (all tests so far)

- [ ] **Step 5: Commit**

```bash
git add packages/vite-plugin/src/index.ts packages/vite-plugin/tests/plugin.test.ts
git commit -m "feat: vite plugin wrapper — dev-only tagging + client script injection"
```

---

### Task 4: Client source utilities

**Files:**
- Create: `packages/vite-plugin/src/client/source.ts`
- Test: `packages/vite-plugin/tests/client/source.test.ts`

**Interfaces:**
- Consumes: nothing (pure DOM utilities).
- Produces:
  - `interface SourceLocation { file: string; line: number; col: number }`
  - `parseSourceAttr(value: string): SourceLocation | null`
  - `findTaggedElement(start: Element | null): HTMLElement | null` — nearest self-or-ancestor with `data-dc-source`.

- [ ] **Step 1: Write the failing tests**

`packages/vite-plugin/tests/client/source.test.ts`:

```ts
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
})
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npm run test -w @design-companion/vite`
Expected: FAIL — `Cannot find module '../../src/client/source'`

- [ ] **Step 3: Write the implementation**

`packages/vite-plugin/src/client/source.ts`:

```ts
export interface SourceLocation {
  file: string
  line: number
  col: number
}

export function parseSourceAttr(value: string): SourceLocation | null {
  const m = /^(.+):(\d+):(\d+)$/.exec(value)
  if (!m) return null
  return { file: m[1], line: Number(m[2]), col: Number(m[3]) }
}

export function findTaggedElement(start: Element | null): HTMLElement | null {
  let el: Element | null = start
  while (el) {
    if (el instanceof HTMLElement && el.dataset.dcSource) return el
    el = el.parentElement
  }
  return null
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm run test -w @design-companion/vite`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add packages/vite-plugin/src/client/source.ts packages/vite-plugin/tests/client/source.test.ts
git commit -m "feat: client source-attribute parsing and tagged-element lookup"
```

---

### Task 5: Inspector data extraction

**Files:**
- Create: `packages/vite-plugin/src/client/inspector.ts`
- Test: `packages/vite-plugin/tests/client/inspector.test.ts`

**Interfaces:**
- Consumes: `parseSourceAttr`, `SourceLocation` from Task 4.
- Produces:
  - `interface InspectorData { tag: string; source: SourceLocation | null; classes: string[]; width: number; height: number; styles: Record<string, string> }`
  - `buildInspectorData(el: HTMLElement): InspectorData`
  - `STYLE_PROPS: readonly string[]` — the computed properties shown in the panel.

- [ ] **Step 1: Write the failing tests**

`packages/vite-plugin/tests/client/inspector.test.ts`:

```ts
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
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npm run test -w @design-companion/vite`
Expected: FAIL — `Cannot find module '../../src/client/inspector'`

- [ ] **Step 3: Write the implementation**

`packages/vite-plugin/src/client/inspector.ts`:

```ts
import { parseSourceAttr, type SourceLocation } from './source'

export const STYLE_PROPS = [
  'display',
  'padding',
  'margin',
  'gap',
  'border-radius',
  'font-size',
  'font-weight',
  'line-height',
  'color',
  'background-color',
] as const

export interface InspectorData {
  tag: string
  source: SourceLocation | null
  classes: string[]
  width: number
  height: number
  styles: Record<string, string>
}

export function buildInspectorData(el: HTMLElement): InspectorData {
  const rect = el.getBoundingClientRect()
  const computed = getComputedStyle(el)
  const styles: Record<string, string> = {}
  for (const prop of STYLE_PROPS) {
    styles[prop] = computed.getPropertyValue(prop)
  }
  return {
    tag: el.tagName.toLowerCase(),
    source: el.dataset.dcSource ? parseSourceAttr(el.dataset.dcSource) : null,
    classes: Array.from(el.classList),
    width: Math.round(rect.width),
    height: Math.round(rect.height),
    styles,
  }
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm run test -w @design-companion/vite`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add packages/vite-plugin/src/client/inspector.ts packages/vite-plugin/tests/client/inspector.test.ts
git commit -m "feat: inspector data extraction from selected elements"
```

---

### Task 6: Overlay UI + design-mode controller

**Files:**
- Create: `packages/vite-plugin/src/client/overlay.ts`
- Create: `packages/vite-plugin/src/client/index.ts`
- Test: `packages/vite-plugin/tests/client/design-mode.test.ts`

**Interfaces:**
- Consumes: `findTaggedElement` (Task 4), `buildInspectorData`, `InspectorData` (Task 5).
- Produces:
  - `class Overlay` — `host: HTMLElement`, `toggle: HTMLButtonElement`, `mount(): void`, `setActive(on: boolean): void`, `showOutline(rect: DOMRect): void`, `hideOutline(): void`, `showPanel(data: InspectorData): void`, `hidePanel(): void`, `contains(target: EventTarget | null): boolean`
  - `class DesignMode` — `constructor(overlay: Overlay)`, `active: boolean`, `setActive(on: boolean): void`; installs capture-phase `mousemove`/`click`/`keydown` document listeners only while active.
  - `src/client/index.ts` boots: `const overlay = new Overlay(); overlay.mount(); new DesignMode(overlay)`.

- [ ] **Step 1: Write the failing tests**

`packages/vite-plugin/tests/client/design-mode.test.ts`:

```ts
// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { Overlay } from '../../src/client/overlay'
import { DesignMode } from '../../src/client/index'

beforeEach(() => {
  document.body.innerHTML = ''
  vi.restoreAllMocks()
  vi.stubGlobal('requestAnimationFrame', (cb: FrameRequestCallback) => {
    cb(0)
    return 1
  })
})

describe('Overlay', () => {
  it('mounts a shadow-DOM host with toggle, outline, and panel', () => {
    const overlay = new Overlay()
    overlay.mount()
    expect(document.body.contains(overlay.host)).toBe(true)
    const root = overlay.host.shadowRoot!
    expect(root.getElementById('toggle')).toBeTruthy()
    expect(root.getElementById('outline')).toBeTruthy()
    expect(root.getElementById('panel')).toBeTruthy()
  })

  it('hides outline and panel when deactivated', () => {
    const overlay = new Overlay()
    overlay.mount()
    overlay.showOutline(new DOMRect(0, 0, 10, 10))
    overlay.setActive(false)
    const root = overlay.host.shadowRoot!
    expect((root.getElementById('outline') as HTMLElement).hidden).toBe(true)
    expect((root.getElementById('panel') as HTMLElement).hidden).toBe(true)
  })
})

describe('DesignMode listener lifecycle (spec §10: zero idle listeners)', () => {
  it('adds no document listeners until activated', () => {
    const addSpy = vi.spyOn(document, 'addEventListener')
    const overlay = new Overlay()
    overlay.mount()
    new DesignMode(overlay)
    expect(addSpy).not.toHaveBeenCalled()
  })

  it('adds capture-phase listeners on activate and removes them on deactivate', () => {
    const addSpy = vi.spyOn(document, 'addEventListener')
    const removeSpy = vi.spyOn(document, 'removeEventListener')
    const overlay = new Overlay()
    overlay.mount()
    const mode = new DesignMode(overlay)

    mode.setActive(true)
    const added = addSpy.mock.calls.map((c) => c[0]).sort()
    expect(added).toEqual(['click', 'keydown', 'mousemove'])
    for (const call of addSpy.mock.calls) expect(call[2]).toBe(true)

    mode.setActive(false)
    const removed = removeSpy.mock.calls.map((c) => c[0]).sort()
    expect(removed).toEqual(['click', 'keydown', 'mousemove'])
  })

  it('toggle button flips design mode', () => {
    const overlay = new Overlay()
    overlay.mount()
    const mode = new DesignMode(overlay)
    overlay.toggle.click()
    expect(mode.active).toBe(true)
    overlay.toggle.click()
    expect(mode.active).toBe(false)
  })

  it('Escape deactivates', () => {
    const overlay = new Overlay()
    overlay.mount()
    const mode = new DesignMode(overlay)
    mode.setActive(true)
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }))
    expect(mode.active).toBe(false)
  })

  it('click selects the nearest tagged element and prevents the app click', () => {
    document.body.innerHTML = `<button data-dc-source="src/Button.tsx:42:8" class="btn">go</button>`
    const overlay = new Overlay()
    overlay.mount()
    const mode = new DesignMode(overlay)
    mode.setActive(true)

    const btn = document.querySelector('button')!
    const appHandler = vi.fn()
    btn.addEventListener('click', appHandler)
    btn.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }))

    expect(appHandler).not.toHaveBeenCalled()
    const panel = overlay.host.shadowRoot!.getElementById('panel') as HTMLElement
    expect(panel.hidden).toBe(false)
    expect(panel.textContent).toContain('src/Button.tsx:42:8')
    expect(panel.textContent).toContain('btn')
  })
})
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npm run test -w @design-companion/vite`
Expected: FAIL — `Cannot find module '../../src/client/overlay'`

- [ ] **Step 3: Write the overlay**

`packages/vite-plugin/src/client/overlay.ts`:

```ts
import type { InspectorData } from './inspector'

const CSS = `
:host { all: initial; }
#toggle {
  position: fixed; right: 16px; bottom: 16px; z-index: 2147483647;
  font: 500 12px system-ui, sans-serif; padding: 8px 14px;
  border-radius: 999px; border: 1px solid #d0d0cb; background: #fff;
  color: #1a1a18; cursor: pointer;
}
#toggle.active { background: #1a1a18; color: #fff; }
#outline {
  position: fixed; z-index: 2147483646; pointer-events: none;
  border: 1.5px solid #4a90e2; border-radius: 2px;
}
#panel {
  position: fixed; right: 16px; top: 16px; z-index: 2147483647;
  width: 260px; max-height: 70vh; overflow-y: auto;
  font: 400 12px system-ui, sans-serif; background: #fff; color: #1a1a18;
  border: 1px solid #d0d0cb; border-radius: 10px; padding: 12px;
}
#panel .row { display: flex; justify-content: space-between; gap: 8px; padding: 2px 0; }
#panel .key { color: #6b6b66; }
#panel .head { font-weight: 500; margin-bottom: 6px; word-break: break-all; }
`

export class Overlay {
  host = document.createElement('div')
  toggle = document.createElement('button')
  private outline = document.createElement('div')
  private panel = document.createElement('div')

  constructor() {
    const root = this.host.attachShadow({ mode: 'open' })
    const style = document.createElement('style')
    style.textContent = CSS
    this.toggle.id = 'toggle'
    this.toggle.textContent = 'Design'
    this.outline.id = 'outline'
    this.panel.id = 'panel'
    this.outline.hidden = true
    this.panel.hidden = true
    root.append(style, this.toggle, this.outline, this.panel)
  }

  mount(): void {
    document.body.appendChild(this.host)
  }

  contains(target: EventTarget | null): boolean {
    return target instanceof Node && this.host.contains(target)
  }

  setActive(on: boolean): void {
    this.toggle.classList.toggle('active', on)
    if (!on) {
      this.hideOutline()
      this.hidePanel()
    }
  }

  showOutline(rect: DOMRect): void {
    this.outline.hidden = false
    this.outline.style.left = `${rect.left - 2}px`
    this.outline.style.top = `${rect.top - 2}px`
    this.outline.style.width = `${rect.width + 4}px`
    this.outline.style.height = `${rect.height + 4}px`
  }

  hideOutline(): void {
    this.outline.hidden = true
  }

  showPanel(data: InspectorData): void {
    this.panel.hidden = false
    this.panel.replaceChildren()

    const head = document.createElement('div')
    head.className = 'head'
    head.textContent = data.source
      ? `<${data.tag}> — ${data.source.file}:${data.source.line}:${data.source.col}`
      : `<${data.tag}>`
    this.panel.append(head)

    const rows: Array<[string, string]> = [
      ['size', `${data.width} × ${data.height}`],
      ['classes', data.classes.join(' ') || '—'],
      ...Object.entries(data.styles),
    ]
    for (const [key, value] of rows) {
      const row = document.createElement('div')
      row.className = 'row'
      const k = document.createElement('span')
      k.className = 'key'
      k.textContent = key
      const v = document.createElement('span')
      v.textContent = value || '—'
      row.append(k, v)
      this.panel.append(row)
    }
  }

  hidePanel(): void {
    this.panel.hidden = true
  }
}
```

- [ ] **Step 4: Write the controller + entry point**

`packages/vite-plugin/src/client/index.ts`:

```ts
import { Overlay } from './overlay'
import { findTaggedElement } from './source'
import { buildInspectorData } from './inspector'

export class DesignMode {
  active = false
  private rafId = 0

  constructor(private overlay: Overlay) {
    overlay.toggle.addEventListener('click', () => this.setActive(!this.active))
  }

  setActive(on: boolean): void {
    if (on === this.active) return
    this.active = on
    this.overlay.setActive(on)
    if (on) {
      document.addEventListener('mousemove', this.onMove, true)
      document.addEventListener('click', this.onClick, true)
      document.addEventListener('keydown', this.onKey, true)
    } else {
      document.removeEventListener('mousemove', this.onMove, true)
      document.removeEventListener('click', this.onClick, true)
      document.removeEventListener('keydown', this.onKey, true)
      if (this.rafId) cancelAnimationFrame(this.rafId)
      this.rafId = 0
    }
  }

  private onMove = (e: MouseEvent): void => {
    if (this.rafId) return
    this.rafId = requestAnimationFrame(() => {
      this.rafId = 0
      if (!this.active || this.overlay.contains(e.target)) return
      const el = findTaggedElement(e.target as Element)
      if (el) this.overlay.showOutline(el.getBoundingClientRect())
      else this.overlay.hideOutline()
    })
  }

  private onClick = (e: MouseEvent): void => {
    if (this.overlay.contains(e.target)) return
    e.preventDefault()
    e.stopPropagation()
    const el = findTaggedElement(e.target as Element)
    if (el) this.overlay.showPanel(buildInspectorData(el))
    else this.overlay.hidePanel()
  }

  private onKey = (e: KeyboardEvent): void => {
    if (e.key === 'Escape') this.setActive(false)
  }
}

function boot(): void {
  const overlay = new Overlay()
  overlay.mount()
  new DesignMode(overlay)
}

if (typeof document !== 'undefined' && !import.meta.vitest) {
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', boot)
  } else {
    boot()
  }
}
```

Note: `import.meta.vitest` is undefined at runtime and truthy under vitest with `define` — add to `vitest.config.ts` `test` block: `globals: false` is fine, but add top-level `define: { 'import.meta.vitest': 'true' }` so the boot block is skipped in tests:

```ts
import { defineConfig } from 'vitest/config'

export default defineConfig({
  define: { 'import.meta.vitest': 'true' },
  test: {
    include: ['tests/**/*.test.ts'],
  },
})
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `npm run test -w @design-companion/vite`
Expected: PASS (all suites)

- [ ] **Step 6: Commit**

```bash
git add packages/vite-plugin/src/client packages/vite-plugin/tests/client/design-mode.test.ts packages/vite-plugin/vitest.config.ts
git commit -m "feat: shadow-DOM overlay with hover outline, click-select inspector, idle-safe listeners"
```

---

### Task 7: Build pipeline, fixture app, end-to-end verification

**Files:**
- Create: `packages/vite-plugin/tsup.config.ts`
- Create: `fixtures/demo-app/package.json`
- Create: `fixtures/demo-app/vite.config.ts`
- Create: `fixtures/demo-app/index.html`
- Create: `fixtures/demo-app/src/main.tsx`
- Create: `fixtures/demo-app/src/App.tsx`
- Create: `fixtures/demo-app/src/index.css`
- Create: `scripts/check-prod-clean.sh`

**Interfaces:**
- Consumes: the built plugin (`dist/index.js`) and client (`dist/client.js`) from Tasks 3/6.
- Produces: a runnable demo (`npm run dev -w demo-app`) and a production-safety check script used from the repo root.

- [ ] **Step 1: Add the build config**

`packages/vite-plugin/tsup.config.ts`:

```ts
import { defineConfig } from 'tsup'

export default defineConfig([
  {
    entry: { index: 'src/index.ts' },
    format: ['esm'],
    dts: true,
    platform: 'node',
    external: ['vite'],
    clean: true,
  },
  {
    entry: { client: 'src/client/index.ts' },
    format: ['esm'],
    platform: 'browser',
    define: { 'import.meta.vitest': 'undefined' },
  },
])
```

Run: `npm run build -w @design-companion/vite`
Expected: `dist/index.js`, `dist/index.d.ts`, `dist/client.js` created without errors.

- [ ] **Step 2: Create the fixture app**

`fixtures/demo-app/package.json`:

```json
{
  "name": "demo-app",
  "private": true,
  "type": "module",
  "scripts": {
    "dev": "vite",
    "build": "vite build"
  },
  "dependencies": {
    "react": "^18.3.0",
    "react-dom": "^18.3.0"
  },
  "devDependencies": {
    "@design-companion/vite": "*",
    "@tailwindcss/vite": "^4.0.0",
    "@types/react": "^18.3.0",
    "@types/react-dom": "^18.3.0",
    "@vitejs/plugin-react": "^4.3.0",
    "tailwindcss": "^4.0.0",
    "typescript": "^5.6.0",
    "vite": "^6.0.0"
  }
}
```

`fixtures/demo-app/vite.config.ts`:

```ts
import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'
import { designCompanion } from '@design-companion/vite'

export default defineConfig({
  plugins: [designCompanion(), react(), tailwindcss()],
})
```

`fixtures/demo-app/index.html`:

```html
<!doctype html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <title>design-companion demo</title>
  </head>
  <body>
    <div id="root"></div>
    <script type="module" src="/src/main.tsx"></script>
  </body>
</html>
```

`fixtures/demo-app/src/index.css`:

```css
@import "tailwindcss";
```

`fixtures/demo-app/src/main.tsx`:

```tsx
import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import App from './App'
import './index.css'

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>
)
```

`fixtures/demo-app/src/App.tsx`:

```tsx
export default function App() {
  return (
    <main className="min-h-screen bg-neutral-100 p-8 font-sans">
      <div className="mx-auto max-w-sm rounded-xl bg-white p-6 shadow-sm">
        <h1 className="text-lg font-medium text-neutral-900">Vitality</h1>
        <p className="mt-1 text-sm text-neutral-500">Tier 7 · 173 total</p>
        <button
          className="mt-4 rounded-lg bg-blue-600 px-4 py-2.5 text-sm text-white"
          onClick={() => alert('app click handler fired')}
        >
          Add mod
        </button>
      </div>
    </main>
  )
}
```

Run: `npm install` (root). Expected: workspace link resolves `@design-companion/vite`.

- [ ] **Step 3: Add the production-safety check**

`scripts/check-prod-clean.sh`:

```bash
#!/usr/bin/env bash
# Spec §10: production output must contain no trace of the companion.
set -euo pipefail
cd "$(dirname "$0")/.."
npm run build -w demo-app
if grep -r "data-dc-source\|design-companion" fixtures/demo-app/dist/; then
  echo "FAIL: companion artifacts found in production build" >&2
  exit 1
fi
echo "PASS: production build is clean"
```

Run: `chmod +x scripts/check-prod-clean.sh && ./scripts/check-prod-clean.sh`
Expected: `PASS: production build is clean`

- [ ] **Step 4: Manual verification checklist (real browser)**

Run: `npm run dev -w demo-app` and open the printed localhost URL. Verify each item:

1. Elements panel: the `<button>` has `data-dc-source="src/App.tsx:<line>:<col>"` pointing at the real line in `App.tsx`.
2. "Design" toggle button floats bottom-right.
3. **Before toggling on:** clicking "Add mod" fires the app's alert (companion is inert).
4. Toggle on → hovering elements draws the blue outline; moving the mouse is smooth.
5. Click the button → inspector panel shows `src/App.tsx:<line>:<col>`, the Tailwind class list, size, and computed styles; the app alert does **not** fire.
6. Escape exits design mode; clicking "Add mod" fires the alert again.
7. Edit `App.tsx` (change button text), save → HMR applies, tags still present.

- [ ] **Step 5: Commit**

```bash
git add packages/vite-plugin/tsup.config.ts fixtures/demo-app scripts/check-prod-clean.sh
git commit -m "feat: build pipeline, tailwind fixture app, prod-cleanliness check"
```

---

## Self-Review

- **Spec coverage (M1):** attribute injection (§3.1) → Tasks 1–3; toolbar select/inspect (§3.2) → Tasks 4–6; performance commitments testable in M1 (§10: dev-only, idle listeners, rAF throttle, prod-clean) → Tasks 3, 6, 7. Panel edits/token mapping/dispatch are M2+ by design.
- **Placeholder scan:** none — every step has complete code and exact commands.
- **Type consistency:** `tagJsxSource` signature identical in Tasks 1–3; `SourceLocation`/`InspectorData`/`Overlay` methods match between Tasks 4–6; `CLIENT_ID` shared between Task 3 impl and tests.
