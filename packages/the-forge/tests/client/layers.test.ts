// @vitest-environment jsdom
import { describe, it, expect, beforeEach, vi } from 'vitest'
import {
  buildLayerTree,
  layerLabel,
  LayersTree,
  LeftDock,
  LAYERS_WIDTH,
  LAYERS_STORAGE_KEY,
  loadLayersPrefs,
  type LayersCallbacks,
} from '../../src/client/layers'
import { DraftStore } from '../../src/client/drafts'
import type { TaggedElement } from '../../src/client/source'

beforeEach(() => {
  document.body.innerHTML = ''
  document.documentElement.style.marginLeft = ''
  localStorage.clear()
})

function fixture(): void {
  document.body.innerHTML = `
    <main data-dc-source="src/App.tsx:1:1">
      <div>
        <div data-dc-source="src/App.tsx:3:3" id="card">
          <h1 data-dc-source="src/App.tsx:4:4">Vitality dashboard overview headline</h1>
          <button data-dc-source="src/App.tsx:5:5">Add mod</button>
        </div>
        <img data-dc-source="src/App.tsx:9:3" id="pic" alt="" />
      </div>
    </main>`
}

function makeTree(cb: Partial<LayersCallbacks> = {}, drafts = new DraftStore()) {
  const tree = new LayersTree(drafts, {
    onSelect: cb.onSelect ?? vi.fn(),
    onHover: cb.onHover ?? vi.fn(),
    onDelete: cb.onDelete ?? vi.fn(),
    onClose: cb.onClose ?? vi.fn(),
  })
  document.body.appendChild(tree.root) // jsdom needs it connected for querySelector assertions
  return { tree, drafts }
}

describe('buildLayerTree', () => {
  it('mints nodes for tagged elements only, descending THROUGH untagged wrappers', () => {
    fixture()
    const roots = buildLayerTree(document.body)
    expect(roots).toHaveLength(1)
    expect(roots[0].el.tagName).toBe('MAIN')
    // the untagged <div> wrapper contributes nothing — card and img attach to main
    const kids = roots[0].children
    expect(kids.map((n) => n.el.tagName)).toEqual(['DIV', 'IMG'])
    expect(kids[0].children.map((n) => n.el.tagName)).toEqual(['H1', 'BUTTON'])
  })

  it('preserves document order', () => {
    document.body.innerHTML = `
      <p data-dc-source="a:1:1">one</p>
      <span><p data-dc-source="a:2:1">two</p></span>
      <p data-dc-source="a:3:1">three</p>`
    const labels = buildLayerTree(document.body).map((n) => n.label)
    expect(labels).toEqual(['one', 'two', 'three'])
  })
})

describe('layerLabel', () => {
  const el = (html: string): TaggedElement => {
    document.body.innerHTML = html
    return document.body.firstElementChild as unknown as TaggedElement
  }

  it('text-bearing elements label as their trimmed text with a 24-char cap', () => {
    expect(layerLabel(el('<h1>  Add   mod </h1>'))).toBe('Add mod')
    expect(layerLabel(el('<p>Vitality dashboard overview headline</p>'))).toBe('Vitality dashboard overv…')
  })

  it('structural tags speak designer vocabulary — a div is a Frame', () => {
    expect(layerLabel(el('<div><span>x</span></div>'))).toBe('Frame')
    expect(layerLabel(el('<section><span>x</span></section>'))).toBe('Frame')
    expect(layerLabel(el('<img alt="" />'))).toBe('Image')
    expect(layerLabel(el('<ul><li>a</li></ul>'))).toBe('List')
    expect(layerLabel(el('<svg></svg>'))).toBe('Icon')
  })

  it('unknown tags fall back to the bare tag name', () => {
    expect(layerLabel(el('<video></video>'))).toBe('video')
  })
})

describe('LayersTree rows', () => {
  it('start() renders curated rows with depth data; stop() hides and disconnects', () => {
    fixture()
    const { tree } = makeTree()
    expect(tree.root.hidden).toBe(true)
    tree.start()
    expect(tree.root.hidden).toBe(false)
    const rows = [...tree.root.querySelectorAll('.layer-row')]
    expect(rows.map((r) => (r as HTMLElement).dataset.depth)).toEqual(['0', '1', '2', '2', '1'])
    expect(rows.map((r) => r.querySelector('.layer-label')!.textContent)).toEqual([
      'Main',
      'Frame',
      'Vitality dashboard overv…',
      'Add mod',
      'Image',
    ])
    tree.stop()
    expect(tree.root.hidden).toBe(true)
  })

  it('chevron collapse hides the subtree and survives refresh()', () => {
    fixture()
    const { tree } = makeTree()
    tree.start()
    const cardRow = [...tree.root.querySelectorAll('.layer-row')][1]
    ;(cardRow.querySelector('.layer-chevron') as HTMLElement).click()
    expect(tree.root.querySelectorAll('.layer-row')).toHaveLength(3) // main, card, img
    tree.refresh()
    expect(tree.root.querySelectorAll('.layer-row')).toHaveLength(3) // collapse persisted
  })

  it('click selects (shift = additive); hover calls back in and out', () => {
    fixture()
    const onSelect = vi.fn()
    const onHover = vi.fn()
    const { tree } = makeTree({ onSelect, onHover })
    tree.start()
    const row = [...tree.root.querySelectorAll('.layer-row')][3] as HTMLElement // Add mod
    row.dispatchEvent(new MouseEvent('mouseenter'))
    expect(onHover).toHaveBeenLastCalledWith(document.querySelector('button'))
    row.dispatchEvent(new MouseEvent('mouseleave'))
    expect(onHover).toHaveBeenLastCalledWith(null)
    row.click()
    expect(onSelect).toHaveBeenLastCalledWith(document.querySelector('button'), false)
    row.dispatchEvent(new MouseEvent('click', { shiftKey: true, bubbles: true }))
    expect(onSelect).toHaveBeenLastCalledWith(document.querySelector('button'), true)
  })

  it('Del/Backspace on a row calls onDelete with that row element', () => {
    fixture()
    const onDelete = vi.fn()
    const { tree } = makeTree({ onDelete })
    tree.start()
    const row = [...tree.root.querySelectorAll('.layer-row')][1] as HTMLElement // card
    row.dispatchEvent(new KeyboardEvent('keydown', { key: 'Delete', bubbles: true }))
    expect(onDelete).toHaveBeenCalledWith(document.getElementById('card'))
  })

  it('delete-drafted elements render as tombstones and recover on discard', () => {
    fixture()
    const drafts = new DraftStore()
    const { tree } = makeTree({}, drafts)
    tree.start()
    const card = document.getElementById('card') as unknown as TaggedElement
    drafts.applyDelete(card)
    tree.refresh()
    const row = [...tree.root.querySelectorAll('.layer-row')][1]
    expect(row.classList.contains('layer-deleted')).toBe(true)
    drafts.discard(card)
    tree.refresh()
    expect([...tree.root.querySelectorAll('.layer-row')][1].classList.contains('layer-deleted')).toBe(false)
  })

  it('setSelection highlights rows and auto-expands collapsed ancestors', () => {
    fixture()
    const { tree } = makeTree()
    tree.start()
    const cardRow = [...tree.root.querySelectorAll('.layer-row')][1]
    ;(cardRow.querySelector('.layer-chevron') as HTMLElement).click() // collapse card subtree
    expect(tree.root.querySelectorAll('.layer-row')).toHaveLength(3)
    const btn = document.querySelector('button') as unknown as TaggedElement
    tree.setSelection([btn])
    const rows = [...tree.root.querySelectorAll('.layer-row')]
    expect(rows).toHaveLength(5) // ancestor re-expanded so the selected row is visible
    expect(rows[3].classList.contains('layer-selected')).toBe(true)
  })

  it('the debounced MutationObserver refreshes the tree after DOM churn', async () => {
    vi.useFakeTimers()
    try {
      fixture()
      const { tree } = makeTree()
      tree.start()
      expect(tree.root.querySelectorAll('.layer-row')).toHaveLength(5)
      const extra = document.createElement('p')
      extra.setAttribute('data-dc-source', 'src/App.tsx:99:1')
      extra.textContent = 'fresh'
      document.getElementById('card')!.appendChild(extra)
      await vi.advanceTimersByTimeAsync(200)
      expect(tree.root.querySelectorAll('.layer-row')).toHaveLength(6)
      tree.stop()
    } finally {
      vi.useRealTimers()
    }
  })
})

describe('LeftDock', () => {
  it('enter+open pushes margin-left and exit restores a pre-existing inline value VERBATIM', () => {
    document.documentElement.style.marginLeft = '7px'
    const dock = new LeftDock(document.createElement('div'))
    dock.enter()
    expect(document.documentElement.style.marginLeft).toBe(`${LAYERS_WIDTH}px`)
    dock.exit()
    expect(document.documentElement.style.marginLeft).toBe('7px')
  })

  it('setOpen(false) removes the push and persists; prefs round-trip', () => {
    const dock = new LeftDock(document.createElement('div'))
    dock.enter()
    dock.setOpen(false)
    expect(document.documentElement.style.marginLeft).toBe('')
    expect(loadLayersPrefs()).toEqual({ open: false })
    dock.setOpen(true)
    expect(document.documentElement.style.marginLeft).toBe(`${LAYERS_WIDTH}px`)
    expect(loadLayersPrefs()).toEqual({ open: true })
  })

  it('corrupt stored prefs fall back to open-by-default', () => {
    localStorage.setItem(LAYERS_STORAGE_KEY, '{not json')
    expect(loadLayersPrefs()).toEqual({ open: true })
  })

  it('setCanvasActive suspends the push and restores it, preserving the saved margin', () => {
    document.documentElement.style.marginLeft = '3px'
    const dock = new LeftDock(document.createElement('div'))
    dock.enter()
    dock.setCanvasActive(true)
    expect(document.documentElement.style.marginLeft).toBe('3px') // suspended → the PAGE's own value
    dock.setCanvasActive(false)
    expect(document.documentElement.style.marginLeft).toBe(`${LAYERS_WIDTH}px`)
    dock.exit()
    expect(document.documentElement.style.marginLeft).toBe('3px')
  })

  it('sets the width var on the host', () => {
    const host = document.createElement('div')
    new LeftDock(host)
    expect(host.style.getPropertyValue('--forge-layers-w')).toBe(`${LAYERS_WIDTH}px`)
  })
})
