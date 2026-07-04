# M3: Change Requests + Clipboard Floor Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Turn drafts into deterministic, token-aware change requests and put them on the clipboard as an agent-ready prompt — completing the first full draft→agent→code loop via paste (MCP delivery is M4).

**Architecture:** Two new client modules — `tokens.ts` (Tailwind v4 theme reader + px→utility mapper + existing-utility detection) and `request.ts` (ChangeRequest builder consuming `DraftStore.entries()`, longhand collapsing, markdown renderer) — plus a "Copy for agent" button in the overlay status strip wired through DesignMode. Spec: `docs/specs/2026-07-03-design-companion-design.md` §4 (format), §10 open questions (viewport recorded; call-site scope default; screenshots deferred to M4).

**Tech Stack:** unchanged — TypeScript strict, vanilla DOM, vitest + jsdom. No new dependencies (clipboard via `navigator.clipboard`).

## Global Constraints

- No new runtime dependencies. Root `npm test` (typecheck + vitest) stays green.
- Tailwind detection is **v4-only** in M3 (theme read from CSS custom properties on `:root`: `--spacing`, `--radius-*`). Non-Tailwind projects (no `--spacing` var) get css-value-only requests with `authored: null` — this is the supported inline-style path, not an error. Tailwind v3 config files: deferred, documented.
- Screenshots: deferred to M4 (requires the companion CLI). The format keeps no placeholder fields for them.
- Every change carries `before`/`after` css values. "Before" css is measured by flipping the element to its originals via `DraftStore.compare(el, true)`, reading `getComputedStyle` (synchronous), and restoring prior compare state — exact, no stored duplication.
- Scope default (spec §10 open question): requests instruct "apply to this call site only; confirm before changing a shared component used elsewhere." No per-element scope UI in M3.
- Requests record `viewport: { width, height }` from `window.innerWidth/Height`.
- Utility suggestions must be marked `tokenExact: false` whenever the value doesn't land on the token scale (arbitrary-value fallback like `pt-[13px]`).
- Interfaces that must not break: `DraftStore` (only consumed; `entries()` exists), `Overlay.updateStatus` signature MAY gain the copy button but existing tests must keep passing with minimal edits.
- Copy button visible only when drafts exist (same rule as the strip); label flips to "Copied ✓" for 1.5s after a successful write.

---

### Task 1: Tailwind v4 token mapper (`tokens.ts`)

**Files:**
- Create: `packages/vite-plugin/src/client/tokens.ts`
- Test: `packages/vite-plugin/tests/client/tokens.test.ts`

**Interfaces:**
- Consumes: nothing (pure + DOM read).
- Produces:
  - `interface Theme { rootFontPx: number; spacingBasePx: number | null; radiusScale: Record<string, number> }` — `spacingBasePx === null` means "not a Tailwind v4 project".
  - `readTheme(root?: Element): Theme`
  - `suggestUtility(prop: string, css: string, theme: Theme): { utility: string; tokenExact: boolean } | null` — `null` when not Tailwind or prop unmapped.
  - `findExistingUtility(className: string, prop: string): string | null` — bare (unprefixed-variant) utility on the element for that prop, or null.
  - `UTILITY_PREFIXES: Record<string, string>` — css prop → utility prefix table (exported for the renderer/tests).

- [ ] **Step 1: Write the failing tests**

`packages/vite-plugin/tests/client/tokens.test.ts`:

```ts
// @vitest-environment jsdom
import { describe, it, expect, beforeEach } from 'vitest'
import { readTheme, suggestUtility, findExistingUtility, type Theme } from '../../src/client/tokens'

const TW: Theme = { rootFontPx: 16, spacingBasePx: 4, radiusScale: { sm: 4, md: 6, lg: 8, xl: 12 } }
const PLAIN: Theme = { rootFontPx: 16, spacingBasePx: null, radiusScale: {} }

beforeEach(() => {
  document.documentElement.removeAttribute('style')
})

describe('readTheme', () => {
  it('reads spacing base and radius names from :root custom properties', () => {
    const root = document.documentElement
    root.style.setProperty('--spacing', '0.25rem')
    root.style.setProperty('--radius-lg', '0.5rem')
    root.style.setProperty('--radius-sm', '4px')
    const theme = readTheme(root)
    expect(theme.spacingBasePx).toBe(4)
    expect(theme.radiusScale.lg).toBe(8)
    expect(theme.radiusScale.sm).toBe(4)
  })

  it('returns spacingBasePx null when --spacing is absent (non-Tailwind project)', () => {
    expect(readTheme(document.documentElement).spacingBasePx).toBeNull()
  })
})

describe('suggestUtility', () => {
  it('maps spacing props to scale utilities, including half steps', () => {
    expect(suggestUtility('padding-top', '24px', TW)).toEqual({ utility: 'pt-6', tokenExact: true })
    expect(suggestUtility('padding-top', '10px', TW)).toEqual({ utility: 'pt-2.5', tokenExact: true })
    expect(suggestUtility('margin-left', '-8px', TW)).toEqual({ utility: '-ml-2', tokenExact: true })
  })

  it('falls back to arbitrary values off the scale', () => {
    expect(suggestUtility('padding-top', '13px', TW)).toEqual({ utility: 'pt-[13px]', tokenExact: false })
  })

  it('maps synthetic collapsed props py/px and rounded', () => {
    expect(suggestUtility('padding-block', '24px', TW)).toEqual({ utility: 'py-6', tokenExact: true })
    expect(suggestUtility('padding-inline', '16px', TW)).toEqual({ utility: 'px-4', tokenExact: true })
    expect(suggestUtility('border-radius', '8px', TW)).toEqual({ utility: 'rounded-lg', tokenExact: true })
  })

  it('maps radius to nearest named token, full for pills, arbitrary otherwise', () => {
    expect(suggestUtility('border-top-left-radius', '12px', TW)).toEqual({ utility: 'rounded-tl-xl', tokenExact: true })
    expect(suggestUtility('border-radius', '999px', TW)).toEqual({ utility: 'rounded-full', tokenExact: true })
    expect(suggestUtility('border-radius', '9px', TW)).toEqual({ utility: 'rounded-[9px]', tokenExact: false })
  })

  it('maps size and opacity', () => {
    expect(suggestUtility('width', '200px', TW)).toEqual({ utility: 'w-50', tokenExact: true })
    expect(suggestUtility('opacity', '0.5', TW)).toEqual({ utility: 'opacity-50', tokenExact: true })
    expect(suggestUtility('opacity', '0.505', TW)).toEqual({ utility: 'opacity-[0.505]', tokenExact: false })
  })

  it('returns null for non-Tailwind themes and unmapped props', () => {
    expect(suggestUtility('padding-top', '24px', PLAIN)).toBeNull()
    expect(suggestUtility('color', 'red', TW)).toBeNull()
  })
})

describe('findExistingUtility', () => {
  const cls = 'mt-4 rounded-lg bg-blue-600 px-4 py-2.5 text-sm text-white'
  it('finds the bare utility for a prop', () => {
    expect(findExistingUtility(cls, 'padding-block')).toBe('py-2.5')
    expect(findExistingUtility(cls, 'padding-inline')).toBe('px-4')
    expect(findExistingUtility(cls, 'margin-top')).toBe('mt-4')
    expect(findExistingUtility(cls, 'border-radius')).toBe('rounded-lg')
  })

  it('does not confuse rounded with per-corner utilities', () => {
    expect(findExistingUtility('rounded-tl-xl p-2', 'border-radius')).toBeNull()
    expect(findExistingUtility('rounded-tl-xl p-2', 'border-top-left-radius')).toBe('rounded-tl-xl')
  })

  it('ignores variant-prefixed utilities and returns null when absent', () => {
    expect(findExistingUtility('md:pt-8 text-sm', 'padding-top')).toBeNull()
  })
})
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npm run test -w @design-companion/vite`
Expected: FAIL — `Cannot find module '../../src/client/tokens'`

- [ ] **Step 3: Write the implementation**

`packages/vite-plugin/src/client/tokens.ts`:

```ts
export interface Theme {
  rootFontPx: number
  spacingBasePx: number | null
  radiusScale: Record<string, number>
}

const RADIUS_NAMES = ['xs', 'sm', 'md', 'lg', 'xl', '2xl', '3xl', '4xl']

function toPx(value: string, rootFontPx: number): number {
  const n = Number.parseFloat(value)
  return value.trim().endsWith('rem') ? n * rootFontPx : n
}

export function readTheme(root: Element = document.documentElement): Theme {
  const cs = getComputedStyle(root)
  const rootFontPx = Number.parseFloat(cs.fontSize) || 16
  const spacing = cs.getPropertyValue('--spacing').trim()
  const spacingBasePx = spacing ? toPx(spacing, rootFontPx) : null
  const radiusScale: Record<string, number> = {}
  for (const name of RADIUS_NAMES) {
    const v = cs.getPropertyValue(`--radius-${name}`).trim()
    if (v) radiusScale[name] = toPx(v, rootFontPx)
  }
  return { rootFontPx, spacingBasePx, radiusScale }
}

// css prop (incl. synthetic collapsed props) → utility prefix
export const UTILITY_PREFIXES: Record<string, string> = {
  'padding-top': 'pt',
  'padding-right': 'pr',
  'padding-bottom': 'pb',
  'padding-left': 'pl',
  'padding-block': 'py',
  'padding-inline': 'px',
  'margin-top': 'mt',
  'margin-right': 'mr',
  'margin-bottom': 'mb',
  'margin-left': 'ml',
  'margin-block': 'my',
  'margin-inline': 'mx',
  width: 'w',
  height: 'h',
  'border-radius': 'rounded',
  'border-top-left-radius': 'rounded-tl',
  'border-top-right-radius': 'rounded-tr',
  'border-bottom-right-radius': 'rounded-br',
  'border-bottom-left-radius': 'rounded-bl',
  opacity: 'opacity',
}

const RADIUS_PROPS = new Set(
  Object.keys(UTILITY_PREFIXES).filter((p) => p.includes('radius'))
)

export function suggestUtility(
  prop: string,
  css: string,
  theme: Theme
): { utility: string; tokenExact: boolean } | null {
  const prefix = UTILITY_PREFIXES[prop]
  if (!prefix || theme.spacingBasePx === null) return null

  if (prop === 'opacity') {
    const pct = Number.parseFloat(css) * 100
    const rounded = Math.round(pct)
    if (Math.abs(pct - rounded) < 0.001) {
      return { utility: `opacity-${rounded}`, tokenExact: true }
    }
    return { utility: `opacity-[${css}]`, tokenExact: false }
  }

  const px = Number.parseFloat(css)

  if (RADIUS_PROPS.has(prop)) {
    if (px >= 999) return { utility: `${prefix}-full`, tokenExact: true }
    for (const [name, value] of Object.entries(theme.radiusScale)) {
      if (Math.abs(value - px) < 0.5) return { utility: `${prefix}-${name}`, tokenExact: true }
    }
    return { utility: `${prefix}-[${px}px]`, tokenExact: false }
  }

  const steps = px / theme.spacingBasePx
  const half = Math.round(steps * 2) / 2
  if (Math.abs(steps - half) < 0.01 && half !== 0) {
    const abs = Math.abs(half)
    const sign = half < 0 ? '-' : ''
    return { utility: `${sign}${prefix}-${abs}`, tokenExact: true }
  }
  if (px === 0) return { utility: `${prefix}-0`, tokenExact: true }
  return { utility: `${prefix}-[${px}px]`, tokenExact: false }
}

export function findExistingUtility(className: string, prop: string): string | null {
  const prefix = UTILITY_PREFIXES[prop]
  if (!prefix) return null
  for (const cls of className.split(/\s+/)) {
    if (cls.includes(':')) continue // variant-prefixed — out of scope for detection
    const bare = cls.startsWith('-') ? cls.slice(1) : cls
    if (!bare.startsWith(`${prefix}-`)) continue
    const suffix = bare.slice(prefix.length + 1)
    // guard: 'rounded-' must not match 'rounded-tl-…' (a longer registered prefix)
    const corner = /^(tl|tr|br|bl)(-|$)/.test(suffix)
    if (prefix === 'rounded' && corner) continue
    return cls
  }
  return null
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm run test -w @design-companion/vite`
Expected: PASS (all suites; 71 + 12 new)

- [ ] **Step 5: Commit**

```bash
git add packages/vite-plugin/src/client/tokens.ts packages/vite-plugin/tests/client/tokens.test.ts
git commit -m "feat: tailwind v4 token mapper — theme reader, utility suggestion, class detection"
```

---

### Task 2: Change-request builder + markdown renderer (`request.ts`)

**Files:**
- Create: `packages/vite-plugin/src/client/request.ts`
- Test: `packages/vite-plugin/tests/client/request.test.ts`

**Interfaces:**
- Consumes: `DraftStore` (Task M2a-1, incl. `entries()`, `compare()`, `isComparing()`), `parseSourceAttr`/`SourceLocation` (source.ts), `readTheme`/`suggestUtility`/`findExistingUtility` (Task 1).
- Produces:
  - `interface ChangeItem { property: string; beforeCss: string; afterCss: string; beforeUtility: string | null; afterUtility: string | null; tokenExact: boolean }`
  - `interface ElementChange { tag: string; source: SourceLocation | null; className: string; text: string; changes: ChangeItem[] }`
  - `interface ChangeRequest { viewport: { width: number; height: number }; tailwind: boolean; elements: ElementChange[] }`
  - `buildChangeRequest(drafts: DraftStore, theme?: Theme): ChangeRequest` (theme defaults to `readTheme()`)
  - `renderMarkdown(req: ChangeRequest): string`
  - Longhand collapsing: 4 equal corner radii → one `border-radius` item; equal `padding-top`+`padding-bottom` → `padding-block`; equal left+right → `padding-inline`; same for margins. Uncollapsed longhands pass through as-is.
  - "Before" css measured via temporary `compare(el, true)` + `getComputedStyle`, restoring prior compare state.

- [ ] **Step 1: Write the failing tests**

`packages/vite-plugin/tests/client/request.test.ts`:

```ts
// @vitest-environment jsdom
import { describe, it, expect, beforeEach } from 'vitest'
import { DraftStore } from '../../src/client/drafts'
import { buildChangeRequest, renderMarkdown } from '../../src/client/request'
import type { Theme } from '../../src/client/tokens'

const TW: Theme = { rootFontPx: 16, spacingBasePx: 4, radiusScale: { lg: 8, xl: 12 } }
const PLAIN: Theme = { rootFontPx: 16, spacingBasePx: null, radiusScale: {} }

function makeButton(): HTMLElement {
  document.body.innerHTML = `<button data-dc-source="src/App.tsx:7:9" class="mt-4 rounded-lg py-2.5 text-sm" style="padding-top: 10px; padding-bottom: 10px;">Add mod</button>`
  return document.querySelector('button')!
}

beforeEach(() => {
  document.body.innerHTML = ''
})

describe('buildChangeRequest', () => {
  it('captures source, classes, text, and before/after css per change', () => {
    const el = makeButton()
    const store = new DraftStore()
    store.apply(el, 'padding-top', '24px')
    store.apply(el, 'padding-bottom', '24px')
    const req = buildChangeRequest(store, TW)
    expect(req.tailwind).toBe(true)
    expect(req.elements).toHaveLength(1)
    const e = req.elements[0]
    expect(e.source).toEqual({ file: 'src/App.tsx', line: 7, col: 9 })
    expect(e.text).toBe('Add mod')
    expect(e.changes).toHaveLength(1) // collapsed to padding-block
    const c = e.changes[0]
    expect(c.property).toBe('padding-block')
    expect(c.beforeCss).toBe('10px')
    expect(c.afterCss).toBe('24px')
    expect(c.beforeUtility).toBe('py-2.5')
    expect(c.afterUtility).toBe('py-6')
    expect(c.tokenExact).toBe(true)
  })

  it('collapses four equal corner radii into border-radius', () => {
    const el = makeButton()
    const store = new DraftStore()
    for (const c of ['top-left', 'top-right', 'bottom-right', 'bottom-left']) {
      store.apply(el, `border-${c}-radius`, '12px')
    }
    const req = buildChangeRequest(store, TW)
    expect(req.elements[0].changes).toEqual([
      expect.objectContaining({ property: 'border-radius', afterCss: '12px', afterUtility: 'rounded-xl' }),
    ])
  })

  it('keeps unequal longhands separate', () => {
    const el = makeButton()
    const store = new DraftStore()
    store.apply(el, 'padding-top', '24px')
    store.apply(el, 'padding-bottom', '8px')
    const req = buildChangeRequest(store, TW)
    const props = req.elements[0].changes.map((c) => c.property).sort()
    expect(props).toEqual(['padding-bottom', 'padding-top'])
  })

  it('leaves the element in its pre-build compare state', () => {
    const el = makeButton()
    const store = new DraftStore()
    store.apply(el, 'padding-top', '24px')
    buildChangeRequest(store, TW)
    expect(el.style.getPropertyValue('padding-top')).toBe('24px') // drafts still applied
    store.compare(el, true)
    buildChangeRequest(store, TW)
    expect(store.isComparing(el)).toBe(true) // comparing state preserved
  })

  it('produces authored-null changes for non-Tailwind themes', () => {
    const el = makeButton()
    const store = new DraftStore()
    store.apply(el, 'padding-top', '24px')
    const req = buildChangeRequest(store, PLAIN)
    expect(req.tailwind).toBe(false)
    const c = req.elements[0].changes.find((x) => x.property === 'padding-top')!
    expect(c.afterUtility).toBeNull()
    expect(c.beforeCss).toBe('10px')
    expect(c.afterCss).toBe('24px')
  })
})

describe('renderMarkdown', () => {
  it('renders location, authored delta, scope note, and verify instruction', () => {
    const el = makeButton()
    const store = new DraftStore()
    store.apply(el, 'padding-top', '24px')
    store.apply(el, 'padding-bottom', '24px')
    const md = renderMarkdown(buildChangeRequest(store, TW))
    expect(md).toContain('src/App.tsx:7:9')
    expect(md).toContain('`py-2.5` → `py-6`')
    expect(md).toContain('padding-block: 10px → 24px')
    expect(md).toContain('this call site only')
    expect(md).toContain('EXACTLY')
    expect(md).toContain('verify')
  })

  it('renders css-only lines when not Tailwind', () => {
    const el = makeButton()
    const store = new DraftStore()
    store.apply(el, 'padding-top', '24px')
    const md = renderMarkdown(buildChangeRequest(store, PLAIN))
    expect(md).toContain('padding-top: 10px → 24px')
    expect(md).not.toContain('→ `')
  })
})
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npm run test -w @design-companion/vite`
Expected: FAIL — `Cannot find module '../../src/client/request'`

- [ ] **Step 3: Write the implementation**

`packages/vite-plugin/src/client/request.ts`:

```ts
import { DraftStore } from './drafts'
import { parseSourceAttr, type SourceLocation, type TaggedElement } from './source'
import { readTheme, suggestUtility, findExistingUtility, type Theme } from './tokens'

export interface ChangeItem {
  property: string
  beforeCss: string
  afterCss: string
  beforeUtility: string | null
  afterUtility: string | null
  tokenExact: boolean
}

export interface ElementChange {
  tag: string
  source: SourceLocation | null
  className: string
  text: string
  changes: ChangeItem[]
}

export interface ChangeRequest {
  viewport: { width: number; height: number }
  tailwind: boolean
  elements: ElementChange[]
}

const COLLAPSE: Array<{ into: string; parts: string[] }> = [
  {
    into: 'border-radius',
    parts: ['border-top-left-radius', 'border-top-right-radius', 'border-bottom-right-radius', 'border-bottom-left-radius'],
  },
  { into: 'padding-block', parts: ['padding-top', 'padding-bottom'] },
  { into: 'padding-inline', parts: ['padding-left', 'padding-right'] },
  { into: 'margin-block', parts: ['margin-top', 'margin-bottom'] },
  { into: 'margin-inline', parts: ['margin-left', 'margin-right'] },
]

function collapse(items: Map<string, { beforeCss: string; afterCss: string }>): Map<string, { beforeCss: string; afterCss: string }> {
  const out = new Map(items)
  for (const { into, parts } of COLLAPSE) {
    const present = parts.map((p) => out.get(p))
    if (present.some((v) => v === undefined)) continue
    const [first, ...rest] = present as Array<{ beforeCss: string; afterCss: string }>
    const equal = rest.every((v) => v.beforeCss === first.beforeCss && v.afterCss === first.afterCss)
    if (!equal) continue
    for (const p of parts) out.delete(p)
    out.set(into, first)
  }
  return out
}

export function buildChangeRequest(drafts: DraftStore, theme: Theme = readTheme()): ChangeRequest {
  const elements: ElementChange[] = []

  for (const [el, props] of drafts.entries()) {
    const wasComparing = drafts.isComparing(el)

    // measure "after" (drafted) computed values
    if (wasComparing) drafts.compare(el, false)
    const afterComputed = getComputedStyle(el)
    const afterCss = new Map<string, string>()
    for (const prop of props.keys()) afterCss.set(prop, afterComputed.getPropertyValue(prop))

    // measure "before" (original) computed values
    drafts.compare(el, true)
    const beforeComputed = getComputedStyle(el)
    const raw = new Map<string, { beforeCss: string; afterCss: string }>()
    for (const prop of props.keys()) {
      raw.set(prop, {
        beforeCss: beforeComputed.getPropertyValue(prop),
        afterCss: afterCss.get(prop)!,
      })
    }
    drafts.compare(el, wasComparing)

    const className = typeof el.className === 'string' ? el.className : [...el.classList].join(' ')
    const changes: ChangeItem[] = []
    for (const [property, v] of collapse(raw)) {
      const suggestion = suggestUtility(property, v.afterCss, theme)
      changes.push({
        property,
        beforeCss: v.beforeCss,
        afterCss: v.afterCss,
        beforeUtility: theme.spacingBasePx === null ? null : findExistingUtility(className, property),
        afterUtility: suggestion?.utility ?? null,
        tokenExact: suggestion?.tokenExact ?? false,
      })
    }

    elements.push({
      tag: el.tagName.toLowerCase(),
      source: el.dataset.dcSource ? parseSourceAttr(el.dataset.dcSource) : null,
      className,
      text: (el.textContent ?? '').trim().slice(0, 80),
      changes,
    })
  }

  return {
    viewport: { width: window.innerWidth, height: window.innerHeight },
    tailwind: theme.spacingBasePx !== null,
    elements,
  }
}

export function renderMarkdown(req: ChangeRequest): string {
  const lines: string[] = []
  lines.push('# Design change request')
  lines.push('')
  lines.push(
    `Apply the following visual edits EXACTLY as specified. Do not restyle anything else. Drafted at viewport ${req.viewport.width}×${req.viewport.height}.`
  )
  lines.push('')

  req.elements.forEach((el, i) => {
    const loc = el.source ? `${el.source.file}:${el.source.line}:${el.source.col}` : '(no source tag — locate by selector/text)'
    lines.push(`## ${i + 1}. <${el.tag}> — ${loc}`)
    if (el.text) lines.push(`Text: "${el.text}"`)
    if (el.className) lines.push(`Current classes: \`${el.className}\``)
    lines.push('')
    for (const c of el.changes) {
      let line = `- ${c.property}: ${c.beforeCss} → ${c.afterCss}`
      if (c.afterUtility) {
        line += c.beforeUtility
          ? ` — change \`${c.beforeUtility}\` → \`${c.afterUtility}\``
          : ` — add \`${c.afterUtility}\``
        line += c.tokenExact ? '' : ' (off the token scale — arbitrary value; double-check intent)'
      }
      lines.push(line)
    }
    lines.push('')
  })

  lines.push('Scope: apply to this call site only. If a change would modify a shared component rendered elsewhere, pause and confirm first.')
  lines.push('After applying, verify each computed value matches the "after" value.')
  return lines.join('\n')
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm run test -w @design-companion/vite`
Expected: PASS (83 + new; typecheck clean via root `npm test`)

- [ ] **Step 5: Commit**

```bash
git add packages/vite-plugin/src/client/request.ts packages/vite-plugin/tests/client/request.test.ts
git commit -m "feat: change-request builder with longhand collapsing and markdown renderer"
```

---

### Task 3: "Copy for agent" button

**Files:**
- Modify: `packages/vite-plugin/src/client/overlay.ts` (add `copyButton` to the status strip)
- Modify: `packages/vite-plugin/src/client/index.ts` (wire copy → build → clipboard → label feedback)
- Modify: `packages/vite-plugin/tests/client/overlay.test.ts`, `tests/client/design-mode.test.ts`

**Interfaces:**
- Consumes: `buildChangeRequest`, `renderMarkdown` (Task 2).
- Produces: `Overlay.copyButton: HTMLButtonElement` — first button in the status strip, label `Copy for agent`; DesignMode wires click → `navigator.clipboard.writeText(renderMarkdown(buildChangeRequest(this.drafts)))` → label `Copied ✓` for 1500ms (timer cleared on re-click; label restored). On clipboard failure, label `Copy failed` for 1500ms; error not thrown.

- [ ] **Step 1: Write the failing tests**

Add to `tests/client/overlay.test.ts` (in the M2 describe):

```ts
it('status strip includes the copy button first', () => {
  const overlay = new Overlay()
  overlay.mount()
  const status = overlay.host.shadowRoot!.getElementById('status')!
  const buttons = [...status.querySelectorAll('button')]
  expect(buttons[0]).toBe(overlay.copyButton)
  expect(overlay.copyButton.textContent).toBe('Copy for agent')
})
```

Add to `tests/client/design-mode.test.ts` (M2 describe; uses the existing `fullSetup` helper):

```ts
it('copy button writes the rendered change request to the clipboard', async () => {
  const writeText = vi.fn().mockResolvedValue(undefined)
  vi.stubGlobal('navigator', { ...navigator, clipboard: { writeText } })
  const { overlay, mode, drafts } = fullSetup()
  mode.setActive(true)
  const btn = document.querySelector('button')! as HTMLElement
  drafts.apply(btn, 'padding-top', '24px')
  overlay.copyButton.click()
  await Promise.resolve()
  expect(writeText).toHaveBeenCalledTimes(1)
  const md = writeText.mock.calls[0][0] as string
  expect(md).toContain('# Design change request')
  expect(md).toContain('src/Button.tsx:42:8')
  expect(md).toContain('padding-top')
  expect(overlay.copyButton.textContent).toBe('Copied ✓')
})

it('copy button reports failure without throwing', async () => {
  const writeText = vi.fn().mockRejectedValue(new Error('denied'))
  vi.stubGlobal('navigator', { ...navigator, clipboard: { writeText } })
  const { overlay, mode, drafts } = fullSetup()
  mode.setActive(true)
  const btn = document.querySelector('button')! as HTMLElement
  drafts.apply(btn, 'padding-top', '24px')
  overlay.copyButton.click()
  await Promise.resolve()
  await Promise.resolve()
  expect(overlay.copyButton.textContent).toBe('Copy failed')
})
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npm run test -w @design-companion/vite`
Expected: FAIL — `copyButton` undefined.

- [ ] **Step 3: Implement**

In `overlay.ts`: add `copyButton = document.createElement('button')` public field; `copyButton.textContent = 'Copy for agent'`; insert as FIRST button in the status strip (`this.status.append(this.statusLabel, this.copyButton, this.compareAllButton, this.resetAllButton)`).

In `index.ts` (DesignMode constructor), wire:

```ts
private copyTimer: ReturnType<typeof setTimeout> | null = null

// in constructor:
overlay.copyButton.addEventListener('click', () => {
  const md = renderMarkdown(buildChangeRequest(this.drafts))
  navigator.clipboard
    .writeText(md)
    .then(() => this.flashCopyLabel('Copied ✓'))
    .catch(() => this.flashCopyLabel('Copy failed'))
})

private flashCopyLabel(label: string): void {
  const btn = this.overlay.copyButton
  btn.textContent = label
  if (this.copyTimer) clearTimeout(this.copyTimer)
  this.copyTimer = setTimeout(() => {
    btn.textContent = 'Copy for agent'
    this.copyTimer = null
  }, 1500)
}
```

Add imports: `import { buildChangeRequest, renderMarkdown } from './request'`.

- [ ] **Step 4: Run the full suite**

Run: `npm test` (root)
Expected: typecheck clean; all tests pass.

- [ ] **Step 5: Commit**

```bash
git add packages/vite-plugin/src/client/overlay.ts packages/vite-plugin/src/client/index.ts packages/vite-plugin/tests/client/overlay.test.ts packages/vite-plugin/tests/client/design-mode.test.ts
git commit -m "feat: copy-for-agent button — change request to clipboard with feedback"
```

---

### Task 4: Full-loop E2E — the milestone proof (controller-heavy)

**Files:** none created by the implementer beyond gates; the controller runs the loop.

**Interfaces:** none — this task proves M3 end-to-end.

- [ ] **Step 1: Automated gates (implementer or controller)**

Run: `npm test && ./scripts/check-prod-clean.sh`
Expected: typecheck clean, all tests green, `PASS: production build is clean`

- [ ] **Step 2: Controller browser verification**

`npm run build -w @design-companion/vite && npm run dev -w demo-app`, then in a real browser:

1. Toggle design mode; scrub the first button's PY to 24 and set radius to 12.
2. Status strip shows "Copy for agent"; click it; label flips to "Copied ✓".
3. Read the clipboard (or intercept `writeText`): markdown contains `src/App.tsx:<line>:<col>`, `py-2.5` → `py-6`, `rounded-lg` → `rounded-xl`, the call-site scope note, and the verify instruction. Tailwind v4 vars must have been read from the real `:root` (tokenExact true for both).

- [ ] **Step 3: Controller full-loop proof with a real agent**

From `fixtures/demo-app`, run the copied markdown through a real headless Claude Code session:

```bash
claude -p "<markdown from step 2>" --permission-mode acceptEdits
```

Then verify:
1. `git diff fixtures/demo-app/src/App.tsx` shows `py-2.5` → `py-6` and `rounded-lg` → `rounded-xl` on the first button's className — and nothing else.
2. In the still-running browser: HMR applied; with drafts reset, computed `padding-top` is 24px and `border-top-left-radius` is 12px — the drafted look is now the real code.
3. Record the transcript outcome (did the agent need to search, or did it go straight to the file:line?) in the task report — this is format-quality evidence for M4.
4. Revert the fixture edit afterward (`git checkout -- fixtures/demo-app/src/App.tsx`) — the proof is recorded in the report, not kept in the tree.

- [ ] **Step 4: Commit (docs only if needed)**

No code expected; if gates required fixes, commit them per their own TDD cycle.

---

## Self-Review

- **Spec coverage:** §4 change-request format (source + before/after + authored + tokenExact + viewport; screenshots deferred per §10 note) → Task 2; §3.3 token mapper (v4 CSS-first via `:root` vars, arbitrary-value fallback flags) → Task 1; §7 universal floor ("Copy as prompt") pulled forward → Task 3; M3 milestone proof (agent applies a drafted change deterministically) → Task 4; §10 open questions (call-site scope default, viewport recorded) → Tasks 2's renderer + constraints.
- **Placeholder scan:** clean — complete code and commands in every implementation step; Task 4 is deliberately a verification protocol, not code.
- **Type consistency:** `Theme`/`suggestUtility`/`findExistingUtility` (Task 1) match Task 2's imports; `ChangeRequest`/`renderMarkdown` (Task 2) match Task 3's wiring; `DraftStore.entries()`/`compare()`/`isComparing()` calls match the M2a API; `Overlay.copyButton` consistent between overlay.ts and index.ts changes.
