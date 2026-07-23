import type { TaggedElement } from './source'
import type { DraftStore } from './drafts'
import { hasDirectText } from './panel-readers'
import { createButton } from './ui/button'

/** One curated tree node — a TAGGED element; untagged wrappers never mint nodes. */
export interface LayerNode {
  el: TaggedElement
  label: string
  children: LayerNode[]
}

/**
 * Curated tree walk (Figma pivot P2, spec §5): a node per tagged element under `root`;
 * untagged elements contribute nothing but are descended THROUGH, so their tagged
 * descendants attach to the nearest tagged ancestor's children — the tree shows the
 * designer's structure, not the DOM's wrapper noise (panel-patterns anti-pattern: a raw
 * DOM tree as a layers panel). The overlay host can never appear: it mounts on
 * documentElement and walks start at body.
 */
export function buildLayerTree(root: Element): LayerNode[] {
  const out: LayerNode[] = []
  for (const child of root.children) {
    const el = child as TaggedElement
    if (el.dataset?.dcSource) {
      out.push({ el, label: layerLabel(el), children: buildLayerTree(child) })
    } else {
      out.push(...buildLayerTree(child))
    }
  }
  return out
}

const LABEL_CAP = 24

/** Designer vocabulary for the structural tags — a div IS a frame in the pivot's model.
 * Text-bearing elements label as their content instead (Figma's text-layer behavior). */
const TAG_LABELS: Record<string, string> = {
  div: 'Frame',
  section: 'Frame',
  article: 'Frame',
  main: 'Main',
  nav: 'Nav',
  header: 'Header',
  footer: 'Footer',
  aside: 'Aside',
  form: 'Form',
  button: 'Button',
  a: 'Link',
  img: 'Image',
  picture: 'Image',
  svg: 'Icon',
  input: 'Input',
  textarea: 'Input',
  select: 'Input',
  ul: 'List',
  ol: 'List',
  li: 'Item',
}

export function layerLabel(el: TaggedElement): string {
  if (hasDirectText(el)) {
    const t = (el.textContent ?? '').replace(/\s+/g, ' ').trim()
    if (t) return t.length > LABEL_CAP ? `${t.slice(0, LABEL_CAP)}…` : t
  }
  const tag = el.tagName.toLowerCase()
  return TAG_LABELS[tag] ?? tag
}

export interface LayersCallbacks {
  onSelect: (el: TaggedElement, additive: boolean) => void
  onHover: (el: TaggedElement | null) => void
  onDelete: (el: TaggedElement) => void
  /** The head's ‹ button — the host (index.ts) owns open-state truth (LeftDock prefs). */
  onClose: () => void
}

/** Quiet-window for MutationObserver-driven rebuilds — HMR re-renders land as bursts. */
const REFRESH_DEBOUNCE_MS = 100

/**
 * The layers tree component (Figma pivot P2). Presentation + interaction only — selection
 * truth stays in DesignMode (rows call back; setSelection paints). Zero idle overhead:
 * the body MutationObserver exists only between start() and stop(). The observer can never
 * feed back on itself — rows render into the overlay's shadow tree, which hangs off
 * documentElement, outside the observed body subtree.
 */
export class LayersTree {
  root = document.createElement('div')

  private list = document.createElement('div')
  /** Collapse state keyed by ELEMENT identity so it survives refresh()'s row rebuilds
   * (same nodes re-render across HMR bursts; a replaced node naturally re-expands). */
  private collapsed = new WeakSet<Element>()
  private selection = new Set<TaggedElement>()
  private observer: MutationObserver | null = null
  private refreshTimer: ReturnType<typeof setTimeout> | null = null
  private running = false

  constructor(
    private drafts: DraftStore,
    private cb: LayersCallbacks
  ) {
    this.root.className = 'layers-panel'
    this.root.hidden = true
    const head = document.createElement('div')
    head.className = 'layers-head'
    const title = document.createElement('span')
    title.textContent = 'Layers'
    const close = createButton({ label: '‹', title: 'Hide layers', className: 'layers-close' })
    close.addEventListener('click', () => this.cb.onClose())
    head.append(title, close)
    this.list.className = 'layers-list'
    this.root.append(head, this.list)
  }

  start(): void {
    if (this.running) return
    this.running = true
    this.root.hidden = false
    this.observer = new MutationObserver(() => this.scheduleRefresh())
    // childList+subtree only — attribute churn (our own inline-style drafts, canvas's body
    // transform) must not thrash the tree; tombstone paint rides drafts.onChange instead.
    this.observer.observe(document.body, { childList: true, subtree: true })
    this.refresh()
  }

  stop(): void {
    if (!this.running) return
    this.running = false
    this.root.hidden = true
    this.observer?.disconnect()
    this.observer = null
    if (this.refreshTimer) clearTimeout(this.refreshTimer)
    this.refreshTimer = null
  }

  isRunning(): boolean {
    return this.running
  }

  /** Debounced refresh for external burst-y triggers (drafts.onChange fires per scrub tick;
   * the tombstone strike-through doesn't need per-tick tree rebuilds). */
  refreshSoon(): void {
    if (this.running) this.scheduleRefresh()
  }

  private scheduleRefresh(): void {
    if (this.refreshTimer) clearTimeout(this.refreshTimer)
    this.refreshTimer = setTimeout(() => {
      this.refreshTimer = null
      this.refresh()
    }, REFRESH_DEBOUNCE_MS)
  }

  refresh(): void {
    if (!this.running) return
    this.list.replaceChildren()
    for (const node of buildLayerTree(document.body)) this.renderNode(node, 0)
  }

  /** Paints selection highlights, auto-expanding collapsed ancestors so a canvas click can
   * never select an invisible row, and reveals the first selected row. */
  setSelection(els: TaggedElement[]): void {
    this.selection = new Set(els)
    if (!this.running) return
    for (const el of els) {
      let node: Element | null = el.parentElement
      while (node && node !== document.body) {
        this.collapsed.delete(node)
        node = node.parentElement
      }
    }
    this.refresh()
    const first = this.list.querySelector('.layer-selected')
    // jsdom has no scrollIntoView — presence-check keeps the unit environment honest.
    if (first && typeof first.scrollIntoView === 'function') first.scrollIntoView({ block: 'nearest' })
  }

  private renderNode(node: LayerNode, depth: number): void {
    const row = document.createElement('div')
    row.className = 'layer-row'
    row.dataset.depth = String(depth)
    row.style.setProperty('--layer-depth', String(depth))
    row.tabIndex = 0
    if (this.selection.has(node.el)) row.classList.add('layer-selected')
    if (this.drafts.structuralOf(node.el)?.kind === 'delete') row.classList.add('layer-deleted')

    const isCollapsed = this.collapsed.has(node.el)
    if (node.children.length > 0) {
      const chevron = document.createElement('span')
      chevron.className = 'layer-chevron'
      chevron.textContent = isCollapsed ? '▸' : '▾'
      chevron.addEventListener('click', (e) => {
        e.stopPropagation()
        if (isCollapsed) this.collapsed.delete(node.el)
        else this.collapsed.add(node.el)
        this.refresh()
      })
      row.appendChild(chevron)
      if (isCollapsed) row.classList.add('layer-collapsed')
    } else {
      const spacer = document.createElement('span')
      spacer.className = 'layer-chevron layer-chevron-empty'
      row.appendChild(spacer)
    }

    const label = document.createElement('span')
    label.className = 'layer-label'
    label.textContent = node.label
    row.appendChild(label)

    row.addEventListener('click', (e) => this.cb.onSelect(node.el, e.shiftKey))
    row.addEventListener('mouseenter', () => this.cb.onHover(node.el.isConnected ? node.el : null))
    row.addEventListener('mouseleave', () => this.cb.onHover(null))
    row.addEventListener('keydown', (e) => {
      if (e.key !== 'Delete' && e.key !== 'Backspace') return
      e.preventDefault()
      e.stopPropagation()
      this.cb.onDelete(node.el)
    })

    this.list.appendChild(row)
    if (!isCollapsed) for (const child of node.children) this.renderNode(child, depth + 1)
  }
}

export const LAYERS_WIDTH = 240
export const LAYERS_STORAGE_KEY = 'the-forge:layers'

interface LayersPrefs {
  open: boolean
}

export function loadLayersPrefs(): LayersPrefs {
  try {
    const raw = localStorage.getItem(LAYERS_STORAGE_KEY)
    if (!raw) return { open: true } // the tree is the pivot's centerpiece — open by default
    const parsed: unknown = JSON.parse(raw)
    const obj = (typeof parsed === 'object' && parsed !== null ? parsed : {}) as { open?: unknown }
    return { open: obj.open !== false }
  } catch {
    return { open: true }
  }
}

export function saveLayersPrefs(prefs: LayersPrefs): void {
  try {
    localStorage.setItem(LAYERS_STORAGE_KEY, JSON.stringify(prefs))
  } catch {
    // persistence is a nicety — never break the session over storage (same rule as dock.ts)
  }
}

/**
 * The layers panel's page push — a lean LEFT mirror of Dock's margin mechanism,
 * deliberately NOT a parametrization of dock.ts (the right Dock's float/resize/tween
 * behavior is proven and stays untouched; this one is fixed-width and dock-only).
 * Same disciplines: pre-existing inline margin-left saved and restored VERBATIM;
 * setCanvasActive suspends the push while the artboard owns the page.
 */
export class LeftDock {
  private prefs: LayersPrefs
  /** null = untouched; '' = touched, page had no inline value (Dock's exact contract). */
  private savedMarginLeft: string | null = null
  private active = false
  private canvasActive = false

  constructor(private host: HTMLElement) {
    this.prefs = loadLayersPrefs()
    this.host.style.setProperty('--forge-layers-w', `${LAYERS_WIDTH}px`)
  }

  isOpen(): boolean {
    return this.prefs.open
  }

  enter(): void {
    this.active = true
    if (this.prefs.open) this.apply()
  }

  exit(): void {
    this.active = false
    this.remove()
    this.canvasActive = false // same stale-suspension reset as Dock.exit()
  }

  setOpen(open: boolean): void {
    if (open === this.prefs.open) return
    this.prefs = { open }
    saveLayersPrefs(this.prefs)
    if (!this.active) return
    if (open) this.apply()
    else this.remove()
  }

  setCanvasActive(on: boolean): void {
    if (on === this.canvasActive) return
    this.canvasActive = on
    if (this.active && this.prefs.open) this.sync()
  }

  private apply(): void {
    if (this.savedMarginLeft === null) {
      this.savedMarginLeft = document.documentElement.style.marginLeft
    }
    this.sync()
  }

  private remove(): void {
    if (this.savedMarginLeft === null) return
    document.documentElement.style.marginLeft = this.savedMarginLeft
    this.savedMarginLeft = null
  }

  private sync(): void {
    document.documentElement.style.marginLeft = this.canvasActive
      ? (this.savedMarginLeft ?? '')
      : `${LAYERS_WIDTH}px`
  }
}
