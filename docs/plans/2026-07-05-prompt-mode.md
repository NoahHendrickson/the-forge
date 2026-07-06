# Prompt mode — free-form prompts on a selected element (2026-07-05)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

Spec: [docs/specs/2026-07-05-prompt-mode-design.md](../specs/2026-07-05-prompt-mode-design.md).

**Goal:** A `Prompt` button in the panel header opens a floating textarea anchored to the selected element; sending packages the prompt + element source context into the existing queue → dispatch → `mark_applied` loop.

**Architecture:** Client-only. New `src/client/prompt.ts` (PromptBox), a prompt-request builder/renderer beside the existing ones in `request.ts`, an optional `prompt` field threaded through seed/persistence types, and wiring in `index.ts`. **Zero server/MCP changes** — the queue stores `request` write-only; agents only read markdown. The verifier needs zero changes: a seed with `changes: []` already flows `handleApplied` → `verifyElements` → `{verified:0, mismatched:[], missing:0}` → stage `'done'` (verifier.ts:287-307), which is exactly the approved "done on mark_applied" semantics (and `drafts.commit(el, [])` is a no-op).

**Tech stack:** TypeScript, vanilla DOM in the shadow overlay, vitest + jsdom. No new dependencies.

## Global constraints (from spec + CLAUDE.md)

- Zero new runtime dependencies; zero production footprint; zero idle overhead — PromptBox attaches scroll/resize listeners only while open, removes them on close.
- New buttons go through `src/client/ui/button.ts` (`createButton`) — never raw `createElement('button')`.
- Panel/overlay CSS class names are test hooks — extend, don't rename. New hooks: `.prompt-box`, `.prompt-textarea`, `.prompt-send`, `.panel-prompt`.
- Why-comments preserved verbatim when moving code (Task 1 moves the scope-guardrail line's comment).
- `unknown` + manual checks at I/O boundaries (Task 2 extends `isValidSentElement` by hand — no schema libs).
- Prompt sends are independent of draft sends: `draftProps: []`, never touch the DraftStore.
- Prompt row label truncates at 80 chars (matches element-text trim).
- Tests mirror `src/`; root `npm test` (typecheck + vitest) is the gate after every task; real-browser E2E before merge (jsdom can't see positioning — project gotcha).

**Sequencing:** four code tasks, in order, each leaving `npm test` green and each its own commit; Task 5 is the E2E gate. Run all single-file test commands from `packages/the-forge/`.

---

### Task 1 — `request.ts`: prompt request builder + markdown renderer

**Files:**
- Modify: `packages/the-forge/src/client/request.ts`
- Test: `packages/the-forge/tests/client/request.test.ts`

**Interfaces produced (later tasks rely on these exact names):**

```ts
export interface PromptRequest {
  kind: 'prompt'
  createdAt: string
  viewport: { width: number; height: number }
  prompt: string
  elements: ElementChange[] // changes is always [] for prompt requests
}
export function buildPromptRequest(
  els: TaggedElement[],
  prompt: string
): { request: PromptRequest; pairs: Array<[TaggedElement, ElementChange]> }
export function renderPromptMarkdown(req: PromptRequest): string
```

- [ ] **Step 1: Write failing tests** — append to `tests/client/request.test.ts`:

```ts
describe('buildPromptRequest / renderPromptMarkdown', () => {
  it('captures element context with an empty changes list', () => {
    const el = document.createElement('button') as unknown as TaggedElement
    el.dataset.dcSource = 'src/App.tsx:12:4'
    el.className = 'px-4 py-2'
    el.textContent = 'Get started'
    document.body.appendChild(el)
    const { request, pairs } = buildPromptRequest([el], 'make this more prominent')
    expect(request.kind).toBe('prompt')
    expect(request.prompt).toBe('make this more prominent')
    expect(request.elements).toHaveLength(1)
    expect(request.elements[0]).toMatchObject({
      tag: 'button',
      className: 'px-4 py-2',
      text: 'Get started',
      changes: [],
    })
    expect(request.elements[0].source).toEqual({ file: 'src/App.tsx', line: 12, col: 4 })
    expect(pairs[0][0]).toBe(el)
    el.remove()
  })

  it('renders markdown with instruction, per-element context, and guardrails', () => {
    const req: PromptRequest = {
      kind: 'prompt', createdAt: 'now', viewport: { width: 1440, height: 900 },
      prompt: 'make this more prominent',
      elements: [{ tag: 'button', source: { file: 'src/App.tsx', line: 12, col: 4 },
        className: 'px-4', text: 'Go', selector: 'div > button', changes: [] }],
    }
    const md = renderPromptMarkdown(req)
    expect(md).toContain('# Design prompt')
    expect(md).toContain('## 1. <button> — src/App.tsx:12:4')
    expect(md).toContain('Selector: `div > button`')
    expect(md).toContain('## Instruction')
    expect(md).toContain('make this more prominent')
    expect(md).toContain('Scope: apply to this call site only.')
    // prompt flow has no style verifier — its no-preview line must NOT promise verification
    expect(md).toContain('Do not run the app, take screenshots, or preview the result')
    expect(md).not.toContain('verifies the changes automatically')
  })

  it('renders a no-source fallback header', () => {
    const req: PromptRequest = {
      kind: 'prompt', createdAt: 'now', viewport: { width: 800, height: 600 }, prompt: 'x',
      elements: [{ tag: 'div', source: null, className: '', text: '', selector: 'div', changes: [] }],
    }
    expect(renderPromptMarkdown(req)).toContain('(no source tag — locate by selector/text)')
  })
})
```

- [ ] **Step 2: Run to verify failure** — `npx vitest run tests/client/request.test.ts` → FAIL (`buildPromptRequest` not exported).

- [ ] **Step 3: Implement.** In `request.ts`:

  1. Extract the element-context block that `buildChangeRequestWithElements` builds inline (request.ts:222-229) into a shared helper, and use it in BOTH builders (DRY — this is the only behavioral-neutral refactor in the task):

```ts
/** Element identity/context block shared by the precise and prompt builders — tag, source,
 * classes, trimmed text, selector. `changes` is the caller's: measured deltas for the precise
 * flow, always [] for prompts. */
function elementContext(el: TaggedElement, changes: ChangeItem[]): ElementChange {
  const className = typeof el.className === 'string' ? el.className : [...el.classList].join(' ')
  return {
    tag: el.tagName.toLowerCase(),
    source: el.dataset.dcSource ? parseSourceAttr(el.dataset.dcSource) : null,
    className,
    text: (el.textContent ?? '').replace(/[`]/g, '').replace(/\s+/g, ' ').trim().slice(0, 80),
    selector: cssPath(el),
    changes,
  }
}
```

  In `buildChangeRequestWithElements`, replace the inline `const elementChange: ElementChange = {...}` with `const elementChange = elementContext(el, changes)` (the `className` local above it is still used by the `changes` loop — compute it before, or pass through; keep the existing `findExistingUtility(className, …)` call working).

  2. Extract the scope guardrail into a shared const, moving its why-comment verbatim:

```ts
// "skip and report", never "pause": an unresolved (claimed-but-unmarked) item goes stale
// after CLAIM_TIMEOUT_MS and gets re-delivered on a later watch cycle — a paused agent would
// be re-asked the same question every few minutes. The command texts (server/setup.ts) spell
// out the MCP mechanics: mark_applied status "failed", note "needs confirmation: <why>".
export const SCOPE_GUARDRAIL =
  'Scope: apply to this call site only. If a change would modify a shared component rendered elsewhere, skip it and report it back as needing confirmation — do not pause waiting for an answer.'
```

  `renderMarkdown` pushes `SCOPE_GUARDRAIL` instead of its literal (its no-preview line stays exactly as-is, verifier promise included).

  3. Add the prompt builder + renderer:

```ts
export interface PromptRequest {
  kind: 'prompt'
  createdAt: string
  viewport: { width: number; height: number }
  prompt: string
  elements: ElementChange[]
}

export function buildPromptRequest(
  els: TaggedElement[],
  prompt: string
): { request: PromptRequest; pairs: Array<[TaggedElement, ElementChange]> } {
  const pairs: Array<[TaggedElement, ElementChange]> = els.map((el) => [el, elementContext(el, [])])
  return {
    request: {
      kind: 'prompt',
      createdAt: new Date().toISOString(),
      viewport: { width: window.innerWidth, height: window.innerHeight },
      prompt,
      elements: pairs.map(([, c]) => c),
    },
    pairs,
  }
}

export function renderPromptMarkdown(req: PromptRequest): string {
  const lines: string[] = []
  lines.push('# Design prompt')
  lines.push('')
  lines.push(
    `The user selected the element(s) below in the running app and typed a free-form instruction. Apply it to the identified source location(s). Written at viewport ${req.viewport.width}×${req.viewport.height}.`
  )
  lines.push('')
  req.elements.forEach((el, i) => {
    const loc = el.source ? `${el.source.file}:${el.source.line}:${el.source.col}` : '(no source tag — locate by selector/text)'
    lines.push(`## ${i + 1}. <${el.tag}> — ${loc}`)
    if (el.text) lines.push(`Text: "${el.text}"`)
    if (el.className) lines.push(`Current classes: \`${el.className}\``)
    lines.push(`Selector: \`${el.selector}\``)
    lines.push('')
  })
  lines.push('## Instruction')
  lines.push('')
  lines.push(req.prompt.trim())
  lines.push('')
  lines.push(SCOPE_GUARDRAIL)
  // Unlike renderMarkdown's closing line, this one does NOT say The Forge verifies the result —
  // free-form prompts have no expected computed styles, so nothing is verified (spec: terminal
  // state comes from mark_applied alone). The don't-preview instruction still applies verbatim.
  lines.push('Do not run the app, take screenshots, or preview the result — the user is watching the live app.')
  return lines.join('\n')
}
```

- [ ] **Step 4: Verify** — `npx vitest run tests/client/request.test.ts` → PASS (including all pre-existing tests: the `elementContext`/`SCOPE_GUARDRAIL` refactor must not change `renderMarkdown` output byte-for-byte).
- [ ] **Step 5: Root gate** — `npm test` from repo root → green.
- [ ] **Step 6: Commit** — `git commit -m "feat(client): prompt request builder + markdown renderer"`

---

### Task 2 — lifecycle plumbing: `prompt` on seeds, persistence round-trip, Changes-list rows

**Files:**
- Modify: `packages/the-forge/src/client/lifecycle.ts` (SentSeed, toPersistedSent, restoreSent)
- Modify: `packages/the-forge/src/client/lifecycle-store.ts` (PersistedSentElement, isValidSentElement)
- Modify: `packages/the-forge/src/client/changelist.ts` (renderSeedRecord)
- Test: `packages/the-forge/tests/client/lifecycle.test.ts`, `tests/client/lifecycle-store.test.ts`, `tests/client/changelist.test.ts`, `tests/client/verifier.test.ts`

**Interfaces:**
- Consumes: nothing from Task 1 (independent — the `prompt` field is a plain string).
- Produces: `SentSeed.prompt?: string`, `PersistedSentElement.prompt?: string`. Task 4 sets `prompt` on seeds it builds; ChangeList renders it.

- [ ] **Step 1: Write failing tests.**

`tests/client/lifecycle.test.ts` — persistence projection round-trip:

```ts
it('round-trips a prompt seed through toPersistedSent/restoreSent', () => {
  const session = new LifecycleSession()
  const el = document.createElement('button') as unknown as TaggedElement
  el.dataset.dcSource = 'src/App.tsx:5:2'
  const change: ElementChange = { tag: 'button', source: { file: 'src/App.tsx', line: 5, col: 2 },
    className: '', text: '', selector: 'button', changes: [] }
  session.register('id-1', [{ el, dcSource: 'src/App.tsx:5:2', index: 0, draftProps: [], change, prompt: 'make it pop' }])
  const persisted = session.toPersistedSent()
  expect(persisted[0].elements[0].prompt).toBe('make it pop')

  const restored = new LifecycleSession()
  restored.restoreSent(persisted, () => null) // placeholder path
  expect(restored.records()[0].seed.prompt).toBe('make it pop')
})
```

`tests/client/lifecycle-store.test.ts` — boundary validation:

```ts
it('accepts an optional string prompt and drops a non-string one', () => {
  const base = { dcSource: 'a.tsx:1:1', index: 0, tag: 'div', draftProps: [], changes: [],
    change: { tag: 'div', source: { file: 'a.tsx', line: 1, col: 1 }, className: '', text: '', selector: 'div', changes: [] } }
  const state = { v: 1, designModeOn: true, selection: [], drafts: [], sent: [
    { id: 'ok', elements: [{ ...base, prompt: 'hi' }] },
    { id: 'bad', elements: [{ ...base, prompt: 42 }] },
  ] }
  sessionStorage.setItem(LIFECYCLE_KEY, JSON.stringify(state))
  const loaded = loadLifecycle()!
  expect(loaded.sent).toHaveLength(1)
  expect(loaded.sent[0].elements[0].prompt).toBe('hi')
})
```

`tests/client/changelist.test.ts` — prompt row rendering (follow the file's existing setup helpers for constructing ChangeList + session):

```ts
it('renders a prompt seed row with the prompt text as summary, truncated at 80 chars', () => {
  const long = 'p'.repeat(100)
  // register via session with seed { ..., draftProps: [], change: { ...changes: [] }, prompt: long }
  const summary = list.root.querySelector('.change-summary')!
  expect(summary.textContent).toBe('p'.repeat(80) + '…')
  expect(summary.getAttribute('title')).toBe(long)
})
```

`tests/client/verifier.test.ts` — pin the zero-changes → done behavior the design leans on (it should already pass; the test exists to keep it true):

```ts
it('flips an entry with zero changes straight to done on applied (prompt sends)', () => {
  // Follow the file's existing handleApplied test pattern: register an entry whose element
  // has changes: [] and draftProps: [], mock /status to answer { id, status: 'applied' },
  // run a poll tick, and assert the emitted StageEvent has stage 'done' (not 'unverified').
})
```

- [ ] **Step 2: Run to verify failure** — `npx vitest run tests/client/lifecycle.test.ts tests/client/lifecycle-store.test.ts tests/client/changelist.test.ts` → FAIL on the prompt-field tests (TS error: `prompt` not in SentSeed). The verifier test may already pass — that's fine, it's a pin.

- [ ] **Step 3: Implement.**

`lifecycle.ts` — `SentSeed` gains:

```ts
  /** Free-form prompt text for kind:'prompt' sends (spec 2026-07-05-prompt-mode). Presence of
   * this field is what marks a seed as a prompt send everywhere downstream: ChangeList renders
   * it as the row summary instead of property deltas, and resend() rebuilds a prompt request
   * from it. Absent on draft sends. */
  prompt?: string
```

`toPersistedSent()` element projection adds `prompt: seed.prompt,` (JSON.stringify drops `undefined` — draft-send persistence bytes are unchanged). `restoreSent()` seed construction adds `prompt: pe.prompt,`.

`lifecycle-store.ts` — `PersistedSentElement` gains `prompt?: string`; `isValidSentElement` gains one line before the final `return true`:

```ts
  if (v.prompt !== undefined && typeof v.prompt !== 'string') return false
```

`changelist.ts` — in `renderSeedRecord`, replace the unconditional `summarize(...)` with:

```ts
    // A prompt seed has no property deltas — its summary IS the prompt text (spec: truncate at
    // 80 chars, same bound as the element-text trim; full text in the title tooltip).
    const { text, full } =
      row.seed.prompt !== undefined
        ? { text: row.seed.prompt.length > 80 ? `${row.seed.prompt.slice(0, 80)}…` : row.seed.prompt, full: row.seed.prompt }
        : summarize(row.seed.change.changes)
```

- [ ] **Step 4: Verify** — the three test files above + `npx vitest run tests/client/verifier.test.ts` → PASS.
- [ ] **Step 5: Root gate** — `npm test` → green.
- [ ] **Step 6: Commit** — `git commit -m "feat(client): prompt field through seed/persistence/changelist"`

---

### Task 3 — PromptBox UI: `src/client/prompt.ts`, overlay CSS, panel header button, story

**Files:**
- Create: `packages/the-forge/src/client/prompt.ts`
- Modify: `packages/the-forge/src/client/overlay.ts` (CSS block + `mountPromptBox`)
- Modify: `packages/the-forge/src/client/panel.ts` (header `Prompt` button)
- Create: `packages/the-forge/stories/prompt-box.stories.ts`
- Test: `packages/the-forge/tests/client/prompt.test.ts` (new, mirrors `src/client/prompt.ts`), `tests/client/panel.test.ts`, `tests/client/overlay.test.ts`

**Interfaces produced (Task 4 relies on these exact names):**

```ts
export class PromptBox {
  root: HTMLDivElement          // .prompt-box, hidden when closed
  textarea: HTMLTextAreaElement // .prompt-textarea
  sendButton: HTMLButtonElement // .prompt-send, via createButton
  onSend: (text: string) => void // host-assigned; fired with trimmed non-empty text
  open(anchor: TaggedElement): void
  close(): void
  isOpen(): boolean
  setBusy(on: boolean): void
}
// overlay.ts
mountPromptBox(el: HTMLElement): void  // appends into the shadow root, like mountPanel
// panel.ts
promptButton: HTMLButtonElement        // .panel-prompt, in the panel header
```

- [ ] **Step 1: Write failing tests** — `tests/client/prompt.test.ts`:

```ts
import { PromptBox } from '../../src/client/prompt'

function anchored(): TaggedElement {
  const el = document.createElement('div') as unknown as TaggedElement
  document.body.appendChild(el)
  return el
}

describe('PromptBox', () => {
  it('starts hidden with send disabled; open() shows and focuses', () => {
    const box = new PromptBox()
    document.body.appendChild(box.root)
    expect(box.root.hidden).toBe(true)
    box.open(anchored())
    expect(box.root.hidden).toBe(false)
    expect(box.isOpen()).toBe(true)
    expect(box.sendButton.disabled).toBe(true) // empty textarea
  })

  it('enables send only for non-whitespace text', () => {
    const box = new PromptBox(); document.body.appendChild(box.root); box.open(anchored())
    box.textarea.value = '   '
    box.textarea.dispatchEvent(new Event('input'))
    expect(box.sendButton.disabled).toBe(true)
    box.textarea.value = 'hello'
    box.textarea.dispatchEvent(new Event('input'))
    expect(box.sendButton.disabled).toBe(false)
  })

  it('fires onSend with trimmed text on click and on Cmd/Ctrl+Enter', () => {
    const box = new PromptBox(); document.body.appendChild(box.root); box.open(anchored())
    const sent: string[] = []
    box.onSend = (t) => sent.push(t)
    box.textarea.value = '  hi  '
    box.textarea.dispatchEvent(new Event('input'))
    box.sendButton.click()
    box.textarea.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', metaKey: true }))
    expect(sent).toEqual(['hi', 'hi'])
  })

  it('close() and Escape hide, discard text, and clear busy', () => {
    const box = new PromptBox(); document.body.appendChild(box.root); box.open(anchored())
    box.textarea.value = 'draft text'
    box.setBusy(true)
    box.textarea.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }))
    expect(box.isOpen()).toBe(false)
    box.open(anchored())
    expect(box.textarea.value).toBe('') // discarded, not restored
    expect(box.sendButton.disabled).toBe(true) // busy cleared, empty again
  })

  it('setBusy(true) blocks onSend and disables the controls', () => {
    const box = new PromptBox(); document.body.appendChild(box.root); box.open(anchored())
    let fired = 0
    box.onSend = () => fired++
    box.textarea.value = 'hi'
    box.textarea.dispatchEvent(new Event('input'))
    box.setBusy(true)
    box.sendButton.click()
    box.textarea.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', ctrlKey: true }))
    expect(fired).toBe(0)
    expect(box.sendButton.disabled).toBe(true)
  })

  it('removes its reposition listeners on close (zero idle overhead)', () => {
    const box = new PromptBox(); document.body.appendChild(box.root)
    const addSpy = vi.spyOn(window, 'addEventListener')
    const removeSpy = vi.spyOn(window, 'removeEventListener')
    box.open(anchored())
    const added = addSpy.mock.calls.filter(([t]) => t === 'resize' || t === 'scroll').length
    box.close()
    const removed = removeSpy.mock.calls.filter(([t]) => t === 'resize' || t === 'scroll').length
    expect(added).toBeGreaterThan(0)
    expect(removed).toBe(added)
  })
})
```

`tests/client/panel.test.ts` — add:

```ts
it('has a Prompt button in the header, hidden when nothing is selected', () => {
  // build Panel via the file's existing setup helper
  expect(panel.promptButton.classList.contains('panel-prompt')).toBe(true)
  expect(panel.root.querySelector('.panel-head .panel-prompt')).toBe(panel.promptButton)
  panel.hide()
  expect(panel.promptButton.hidden).toBe(true)
  panel.show(el, buildInspectorData(el)) // any tagged fixture the file already uses
  expect(panel.promptButton.hidden).toBe(false)
})
```

`tests/client/overlay.test.ts` — extend the CSS-string assertions (established pattern):

```ts
it('styles the prompt box', () => {
  expect(CSS).toContain('.prompt-box')
  expect(CSS).toContain('.prompt-textarea')
  expect(CSS).toContain('.prompt-send')
  expect(CSS).toContain('.panel-prompt')
})
```

- [ ] **Step 2: Run to verify failure** — `npx vitest run tests/client/prompt.test.ts tests/client/panel.test.ts tests/client/overlay.test.ts` → FAIL (module not found / button missing / CSS missing).

- [ ] **Step 3: Implement `src/client/prompt.ts`:**

```ts
import { createButton } from './ui/button'
import type { TaggedElement } from './source'

/** Gap between the anchor element's rect and the box, and the viewport clamp margin. */
const GAP = 8

/** Floating free-form prompt box, anchored to the selected element (spec
 * 2026-07-05-prompt-mode). Dumb on purpose: it owns text entry, anchoring, and busy state;
 * the HOST (DesignMode) owns what "send" means (queue POST, seeds, dispatch) via onSend and
 * decides when to close (queue success) vs un-busy (queue failure). Scroll/resize reposition
 * listeners exist ONLY while open — zero idle overhead, same rule as design mode's own
 * document listeners (index.ts setActive). */
export class PromptBox {
  root = document.createElement('div')
  textarea = document.createElement('textarea')
  sendButton = createButton({ label: 'Send', className: 'prompt-send' })

  /** Host-assigned send handler; called with trimmed, non-empty text while not busy. */
  onSend: (text: string) => void = () => {}

  private anchor: TaggedElement | null = null
  private busy = false

  constructor() {
    this.root.className = 'prompt-box'
    this.root.hidden = true
    this.textarea.className = 'prompt-textarea'
    this.textarea.placeholder = 'Describe the change…'
    this.textarea.rows = 3
    this.textarea.addEventListener('input', () => this.syncSendDisabled())
    this.textarea.addEventListener('keydown', (e) => {
      // Esc closes the BOX only — stopPropagation keeps DesignMode's document-capture Escape
      // (deselect/exit, index.ts onKey) out of it. onKey also ignores overlay-internal targets
      // via overlay.contains(), so this is belt-and-braces, not the only line of defense.
      if (e.key === 'Escape') {
        e.stopPropagation()
        this.close()
      } else if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
        e.preventDefault()
        this.trySend()
      }
    })
    this.sendButton.addEventListener('click', () => this.trySend())
    this.root.append(this.textarea, this.sendButton)
  }

  /** Reposition on scroll/resize while open — capture-phase scroll like index.ts onReflow,
   * since scroll events don't bubble from inner containers. */
  private reposition = (): void => {
    if (this.anchor && this.anchor.isConnected) this.place(this.anchor.getBoundingClientRect())
  }

  open(anchor: TaggedElement): void {
    this.anchor = anchor
    if (this.root.hidden) {
      this.root.hidden = false
      window.addEventListener('scroll', this.reposition, { capture: true, passive: true })
      window.addEventListener('resize', this.reposition, { passive: true })
    }
    this.syncSendDisabled()
    this.place(anchor.getBoundingClientRect())
    this.textarea.focus()
  }

  close(): void {
    if (this.root.hidden) return
    this.root.hidden = true
    this.anchor = null
    this.busy = false
    this.textarea.value = '' // discard on close — spec'd v1 behavior, no draft-restore
    this.textarea.disabled = false
    this.syncSendDisabled()
    window.removeEventListener('scroll', this.reposition, true)
    window.removeEventListener('resize', this.reposition)
  }

  isOpen(): boolean {
    return !this.root.hidden
  }

  /** True while the queue POST is in flight — the host clears it via close() (success) or
   * setBusy(false) (failure, box stays open so the text isn't lost). */
  setBusy(on: boolean): void {
    this.busy = on
    this.textarea.disabled = on
    this.syncSendDisabled()
  }

  private trySend(): void {
    const text = this.textarea.value.trim()
    if (!text || this.busy) return
    this.onSend(text)
  }

  private syncSendDisabled(): void {
    this.sendButton.disabled = this.busy || this.textarea.value.trim() === ''
  }

  /** Below the anchor first; flips above when below would clip and above fits; clamps into the
   * viewport with a GAP margin either way. position:fixed coordinates — same space as the
   * overlay's outlines. */
  private place(rect: DOMRect): void {
    const w = this.root.offsetWidth
    const h = this.root.offsetHeight
    let top = rect.bottom + GAP
    if (top + h > window.innerHeight && rect.top - GAP - h >= 0) top = rect.top - GAP - h
    const left = Math.max(GAP, Math.min(rect.left, window.innerWidth - w - GAP))
    this.root.style.top = `${Math.max(GAP, top)}px`
    this.root.style.left = `${left}px`
  }
}
```

- [ ] **Step 4: Implement overlay CSS + mount.** In `overlay.ts`'s `CSS` const, new block using the design tokens (near the panel styles):

```css
.prompt-box {
  position: fixed; z-index: 2147483646; width: 280px; box-sizing: border-box;
  display: flex; flex-direction: column; gap: 6px; padding: 8px;
  background: var(--surface); border: 1px solid var(--border-strong); border-radius: 8px;
  box-shadow: 0 8px 24px rgba(0,0,0,0.4);
}
.prompt-textarea {
  box-sizing: border-box; width: 100%; resize: vertical; min-height: 56px;
  background: var(--control); color: var(--text-primary); border: 1px solid var(--border-panel);
  border-radius: 4px; padding: 6px; font: 400 var(--text-sm)/1.4 var(--font-ui); outline: none;
}
.prompt-textarea:focus { border-color: var(--accent); }
.prompt-box .prompt-send { align-self: flex-end; }
.panel-prompt { margin-left: auto; }
```

(Match the exact button styling idiom of neighboring panel buttons when placing `.prompt-send`/`.panel-prompt` — extend existing selectors, never rename. If `.panel-mode` already carries `margin-left: auto`, put `.panel-prompt` before it and drop the margin rule here.)

In the `Overlay` class, next to `mountPanel` (overlay.ts:490):

```ts
  /** Prompt box mounts in the shadow root like the panel — fixed-position sibling of the
   * outlines, so its coordinates share the overlay's viewport space. */
  mountPromptBox(el: HTMLElement): void {
    this.host.shadowRoot!.appendChild(el)
  }
```

- [ ] **Step 5: Implement panel button.** In `panel.ts`: add the public field `promptButton = createButton({ label: 'Prompt', className: 'panel-prompt' })` (import `createButton` from `./ui/button`), append it in the constructor **before** `this.modeButton` (`this.head.append(this.promptButton, this.modeButton)` replacing the lone modeButton append at panel.ts:190); set `this.promptButton.hidden = false` in `show()` and `= true` in `hide()` (a docked "No selection" panel must not offer Prompt — index.ts only opens for a live selection, but the button hiding is the visible affordance). Panel does NOT know about PromptBox — index.ts wires the click (Task 4).

- [ ] **Step 6: Story** — `stories/prompt-box.stories.ts`, following `button.stories.ts`'s pattern with `mount.ts`: render a real `PromptBox`, call `open()` on a positioned fixture element, show default/filled/busy states.

- [ ] **Step 7: Verify** — `npx vitest run tests/client/prompt.test.ts tests/client/panel.test.ts tests/client/overlay.test.ts` → PASS. Spot-check Storybook: `npm run storybook -w the-forge`.
- [ ] **Step 8: Root gate** — `npm test` → green.
- [ ] **Step 9: Commit** — `git commit -m "feat(client): PromptBox, overlay styles, panel header Prompt button"`

---

### Task 4 — DesignMode wiring: open/close, sendPrompt, resend branch, CLAUDE.md row

**Files:**
- Modify: `packages/the-forge/src/client/index.ts`
- Modify: `CLAUDE.md` (src/client modules table)
- Test: `packages/the-forge/tests/client/design-mode.test.ts`

**Interfaces:**
- Consumes: `buildPromptRequest`/`renderPromptMarkdown` (Task 1), `SentSeed.prompt` (Task 2), `PromptBox`/`mountPromptBox`/`panel.promptButton` (Task 3).
- Produces: nothing new — wiring only.

- [ ] **Step 1: Write failing tests** — `tests/client/design-mode.test.ts`, following the file's existing send-test fixtures (mocked `fetch`, real DOM):

```ts
describe('prompt sends', () => {
  it('toggles the prompt box from the panel button, anchored to the selection', () => {
    // activate, select a tagged element
    mode.panelRoot // panel visible
    panel.promptButton.click()
    expect(promptBoxRoot(overlay).hidden).toBe(false)
    panel.promptButton.click()
    expect(promptBoxRoot(overlay).hidden).toBe(true)
  })

  it('queues a prompt request and registers prompt seeds on success', async () => {
    // select el; open box; type; click send (mock fetch: /queue -> {id:'q1'}, /dispatch -> {rung:'watcher'})
    // after microtasks:
    expect(fetchCalls[0].url).toBe('/__the-forge/queue')
    const body = JSON.parse(fetchCalls[0].init.body)
    expect(body.request.kind).toBe('prompt')
    expect(body.request.prompt).toBe('make it pop')
    expect(body.markdown).toContain('# Design prompt')
    expect(mode.session.records()[0].seed.prompt).toBe('make it pop')
    expect(mode.session.records()[0].seed.draftProps).toEqual([]) // never touches drafts
    expect(promptBoxRoot(overlay).hidden).toBe(true) // closed on queue success
  })

  it('keeps the box open with text intact on queue failure', async () => {
    // mock /queue -> 500; send
    expect(promptBoxRoot(overlay).hidden).toBe(false)
    expect(textarea.value).toBe('make it pop') // not discarded — user retries
    expect(textarea.disabled).toBe(false)      // busy lifted
  })

  it('closes the box on selection change and on deactivate', () => {
    // open box, then mode.select(otherEl) → hidden; open again, mode.setActive(false) → hidden
  })

  it('re-sends a failed prompt seed as a fresh prompt request', async () => {
    // register a prompt seed, drive it to failed via verifier status mock, click Re-send
    const body = JSON.parse(lastQueueCall.init.body)
    expect(body.request.kind).toBe('prompt')
    expect(body.markdown).toContain('## Instruction')
  })
})
```

- [ ] **Step 2: Run to verify failure** — `npx vitest run tests/client/design-mode.test.ts` → FAIL.

- [ ] **Step 3: Implement in `index.ts`.**

Imports: add `buildPromptRequest, renderPromptMarkdown, type PromptRequest` to the `./request` import; `import { PromptBox } from './prompt'`.

Field + constructor wiring (constructor, after `this.panel.changesSlot.appendChild(...)`):

```ts
  private promptBox = new PromptBox()
```

```ts
    overlay.mountPromptBox(this.promptBox.root)
    this.promptBox.onSend = (text) => this.sendPrompt(text)
    this.panel.promptButton.addEventListener('click', () => {
      if (this.promptBox.isOpen()) this.promptBox.close()
      else if (this.selected) this.promptBox.open(this.selected) // multi-select anchors to the first
    })
```

Send path (next to `resend()`; mirrors its then-chain style):

```ts
  /** Queues a free-form prompt for the current selection. Independent of draft sends by spec:
   * reads the selection, never the DraftStore (draftProps: []), and skips isDuplicate — every
   * typed prompt is intentional. Re-entrancy comes from setBusy: trySend() no-ops while the
   * queue POST is in flight. On success the box closes (text's job is done — the Changes-list
   * row takes over); on failure it stays open with the text intact so the user can retry. */
  private sendPrompt(text: string): void {
    const { request, pairs } = buildPromptRequest(this.selection, text)
    if (pairs.length === 0) return
    const md = renderPromptMarkdown(request)
    this.promptBox.setBusy(true)
    fetch('/__the-forge/queue', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...forgeSecretHeaders() },
      body: JSON.stringify({ request, markdown: md }),
    })
      .then((res) => (res.ok ? (res.json() as Promise<{ id: string }>) : Promise.reject(new Error('queue failed'))))
      .then((body) => {
        const seeds: SentSeed[] = pairs.map(([el, change]) => {
          const dcSource = el.dataset.dcSource ?? null
          return { el, dcSource, index: dcSource ? sourceIndex(el, dcSource) : 0, draftProps: [], change, prompt: text }
        })
        this.promptBox.close()
        this.registerQueuedSend(body.id, seeds)
        this.postDispatch(() => {
          /* request is safely queued — manual rung, same as Send */
        })
      })
      .catch(() => {
        this.promptBox.setBusy(false)
        this.flashButton(this.promptBox.sendButton, 'Send failed', 'Send')
      })
  }
```

Close hooks: in `setSelection()` add `this.promptBox.close()` as the first line (any selection change — including deselect — closes and discards, per spec); in `setActive(false)`'s teardown add `this.promptBox.close()` next to `this.panel.hide()`.

Resend branch — in `resend()`, replace the unconditional `ChangeRequest` construction with:

```ts
    // A failed PROMPT seed re-queues as a fresh prompt request, not a ChangeRequest — its
    // change.changes is empty, so renderMarkdown would produce a bullet-less no-op request.
    let request: ChangeRequest | PromptRequest
    let md: string
    if (seed.prompt !== undefined) {
      request = {
        kind: 'prompt',
        createdAt: new Date().toISOString(),
        viewport: { width: window.innerWidth, height: window.innerHeight },
        prompt: seed.prompt,
        elements: [seed.change],
      }
      md = renderPromptMarkdown(request)
    } else {
      request = {
        createdAt: new Date().toISOString(),
        viewport: { width: window.innerWidth, height: window.innerHeight },
        tailwind: readTheme().spacingBasePx !== null,
        elements: [seed.change],
      }
      md = renderMarkdown(request)
    }
```

(The rest of `resend()` — the fetch, removeSeed-on-success, re-entrancy guard, flash-on-failure — is untouched.)

- [ ] **Step 4: Update `CLAUDE.md`** — add to the src/client modules table, after `request.ts`:

```
| `prompt.ts` | `PromptBox` — element-anchored free-form prompt box (panel-header Prompt button); sends ride the same queue/dispatch path with `kind: 'prompt'`, lifecycle rows flip on mark_applied alone |
```

- [ ] **Step 5: Verify** — `npx vitest run tests/client/design-mode.test.ts` → PASS.
- [ ] **Step 6: Root gate** — `npm test` → green.
- [ ] **Step 7: Commit** — `git commit -m "feat(client): wire prompt sends through DesignMode"`

---

### Task 5 — Real-browser E2E + gates

**Files:** none (verification only; fix-forward commits if the checklist finds bugs).

- [ ] **Step 1: Build + fresh server.** `npm run build`, kill stale dev servers (`lsof -iTCP:5173` — often bound on `[::1]`), then `npm run dev -w demo-app`. (Restart is mandatory: Vite caches the old client bundle across builds.)
- [ ] **Step 2: E2E checklist in a real browser** (Chrome, via Playwright MCP or manually):
  1. Toggle design mode, select an element → `Prompt` button visible in the panel header.
  2. Click Prompt → box appears anchored below the element; scroll the page → box tracks; select an element near the viewport bottom → box flips above.
  3. Send disabled when empty; type text → enabled; Esc closes and discards; reopen → empty.
  4. Type a prompt, Cmd+Enter → box closes, a `sent` row with the prompt text appears in the Changes list, `.the-forge/queue.json` at the git root has a `pending` item whose markdown starts `# Design prompt` and contains the correct `file:line:col`.
  5. Run the agent side (`/forge-design` or MCP `pull_design_edits` + `mark_applied` with `applied`) → row flips to `done` with no style verification; with `failed` + note → row shows the note with working Re-send/Dismiss; Re-send queues a fresh `# Design prompt` item.
  6. Multi-select two elements → prompt markdown contains two context blocks.
  7. Reload mid-flight (send, then reload before mark_applied) → prompt row restores from sessionStorage with its text.
  8. Escape with box closed still deselects; typing in the textarea never triggers design-mode shortcuts.
- [ ] **Step 3: Prod gate** — `./scripts/check-prod-clean.sh` → all gates pass (client-only change; this is belt-and-braces).
- [ ] **Step 4: Final root gate** — `npm test` → green. Then hand the branch to the user for the merge decision (project convention: merge decision always belongs to the user).

---

## Self-review notes

- Spec coverage: UX flow (T3+T4), request format (T1), lifecycle (T2 + verifier pin), module table (T4), testing incl. E2E (all + T5), mic deferral (no code — spec-only). ✔
- The verifier/`drafts.commit(el, [])` no-change claim is load-bearing — T2's verifier test pins it rather than trusting the reading.
- `renderMarkdown` byte-stability after the T1 refactor is asserted by the pre-existing request tests staying green.
