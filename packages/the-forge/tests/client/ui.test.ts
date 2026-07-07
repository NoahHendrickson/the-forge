// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { createButton } from '../../src/client/ui/button'
import { createSelect } from '../../src/client/ui/select'
import { createColorRow } from '../../src/client/ui/swatch'
import { createMenuButton } from '../../src/client/ui/menu'

beforeEach(() => {
  document.body.innerHTML = ''
})

describe('createButton', () => {
  it('sets label, title, additive class', () => {
    const b = createButton({ label: 'Reset all', title: 'Reset', className: 'x' })
    expect(b.tagName).toBe('BUTTON')
    expect(b.textContent).toBe('Reset all')
    expect(b.title).toBe('Reset')
    expect(b.classList.contains('x')).toBe(true)
  })

  it('with no opts produces an empty, untitled, unclassed button', () => {
    const b = createButton()
    expect(b.tagName).toBe('BUTTON')
    expect(b.textContent).toBe('')
    expect(b.title).toBe('')
    expect(b.className).toBe('')
  })

  it('label-less button (title/className only) leaves textContent empty', () => {
    const b = createButton({ title: 'Expand', className: 'panel-expand' })
    expect(b.textContent).toBe('')
    expect(b.title).toBe('Expand')
    expect(b.className).toBe('panel-expand')
  })

  it('className-less button has no class attribute noise', () => {
    const b = createButton({ label: 'Compare' })
    expect(b.className).toBe('')
    expect(b.textContent).toBe('Compare')
  })

  it('does not set a title attribute when omitted', () => {
    const b = createButton({ label: 'Send to agent' })
    expect(b.hasAttribute('title')).toBe(false)
  })
})

describe('createSelect', () => {
  it('renders options, base class, initial value, and fires onChange', () => {
    const seen: string[] = []
    const s = createSelect({
      className: 'stroke-style',
      value: 'dashed',
      options: [
        { value: 'solid', label: 'Solid' },
        { value: 'dashed', label: 'Dashed' },
      ],
      onChange: (v) => seen.push(v),
    })
    expect(s.className).toBe('size-mode stroke-style')
    expect(s.value).toBe('dashed')
    expect([...s.options].map((o) => o.value)).toEqual(['solid', 'dashed'])
    s.value = 'solid'
    s.dispatchEvent(new Event('change'))
    expect(seen).toEqual(['solid'])
  })

  it('with no className produces the bare base class', () => {
    const s = createSelect({
      options: [
        { value: 'fixed', label: 'Fixed' },
        { value: 'hug', label: 'Hug' },
        { value: 'fill', label: 'Fill' },
      ],
      onChange: () => {},
    })
    expect(s.className).toBe('size-mode')
  })

  it('with no value set defaults to the first option (native select behavior)', () => {
    const s = createSelect({
      options: [
        { value: 'none', label: 'None' },
        { value: 'solid', label: 'Solid' },
      ],
      onChange: () => {},
    })
    expect(s.value).toBe('none')
  })

  it('option labels differ from values and are preserved as textContent', () => {
    const s = createSelect({
      options: [{ value: 'flex-start', label: 'Start' }],
      onChange: () => {},
    })
    expect(s.options[0].value).toBe('flex-start')
    expect(s.options[0].textContent).toBe('Start')
  })

  it('onChange receives the live select value, not a stale snapshot', () => {
    const onChange = vi.fn()
    const s = createSelect({
      options: [
        { value: 'a', label: 'A' },
        { value: 'b', label: 'B' },
      ],
      onChange,
    })
    s.value = 'b'
    s.dispatchEvent(new Event('change'))
    expect(onChange).toHaveBeenCalledWith('b')
  })
})

describe('createColorRow', () => {
  it('builds the .color-row markup: label, checkerboard swatch button, value span', () => {
    const { row, swatch, swatchColor, valueEl } = createColorRow({ label: 'Fill' })
    expect(row.className).toBe('color-row')
    const label = row.querySelector('.nf-label')
    expect(label?.textContent).toBe('Fill')
    expect(swatch.tagName).toBe('BUTTON')
    expect(swatch.type).toBe('button')
    expect(swatch.className).toBe('swatch')
    expect(swatchColor.className).toBe('swatch-color')
    expect(swatchColor.parentElement).toBe(swatch)
    expect(valueEl.className).toBe('color-value')
    expect([...row.children]).toEqual([label, swatch, valueEl])
  })

  it('label-less row with additive class matches the selection-colors shape', () => {
    const { row, swatch, valueEl } = createColorRow({ className: 'sc-row' })
    expect(row.className).toBe('color-row sc-row')
    expect(row.querySelector('.nf-label')).toBeNull()
    expect([...row.children]).toEqual([swatch, valueEl])
  })

  it('with no opts produces the bare labeled-less .color-row', () => {
    const { row } = createColorRow()
    expect(row.className).toBe('color-row')
    expect(row.children.length).toBe(2)
  })

  it('parts are live references — setting color/text reaches the DOM', () => {
    const { row, swatchColor, valueEl } = createColorRow({ label: 'Stroke' })
    swatchColor.style.color = 'rgb(13, 153, 255)'
    valueEl.textContent = '#0D99FF'
    expect((row.querySelector('.swatch-color') as HTMLElement).style.color).toBe('rgb(13, 153, 255)')
    expect(row.querySelector('.color-value')?.textContent).toBe('#0D99FF')
  })
})

describe('createMenuButton', () => {
  function setup(items = () => [
    { value: 'fixed', label: 'Fixed', checked: true },
    { value: 'hug', label: 'Hug' },
    { value: 'add-min', label: 'Min…', separator: true },
  ]) {
    document.body.innerHTML = '<div id="host" style="position: relative"></div>'
    const host = document.getElementById('host')!
    const onSelect = vi.fn()
    const mb = createMenuButton({ title: 'Sizing', items, onSelect, popoverHost: host })
    host.append(mb.button)
    return { host, onSelect, mb }
  }

  it('renders a menu-btn chevron and no popover until clicked', () => {
    const { host, mb } = setup()
    expect(mb.button.className).toContain('menu-btn')
    expect(mb.button.title).toBe('Sizing')
    expect(host.querySelector('.menu-popover')).toBeNull()
  })

  it('click opens a popover with items, checkmark, and separator', () => {
    const { host, mb } = setup()
    mb.button.click()
    const pop = host.querySelector('.menu-popover') as HTMLElement
    expect(pop).toBeTruthy()
    const labels = [...pop.querySelectorAll('.menu-item')].map((b) => (b as HTMLElement).textContent)
    expect(labels[0]).toContain('Fixed')
    expect(labels[0]).toContain('✓') // checked item carries the mark
    expect(labels[1]).toContain('Hug')
    expect(pop.querySelector('.menu-sep')).toBeTruthy() // separator before Min…
  })

  it('item click fires onSelect with the value and closes', () => {
    const { host, onSelect, mb } = setup()
    mb.button.click()
    const items = [...host.querySelectorAll('.menu-item')] as HTMLElement[]
    items[1].click()
    expect(onSelect).toHaveBeenCalledWith('hug')
    expect(host.querySelector('.menu-popover')).toBeNull()
  })

  it('outside mousedown and Escape both close without selecting', () => {
    const { host, onSelect, mb } = setup()
    mb.button.click()
    document.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }))
    expect(host.querySelector('.menu-popover')).toBeNull()

    mb.button.click()
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }))
    expect(host.querySelector('.menu-popover')).toBeNull()
    expect(onSelect).not.toHaveBeenCalled()
  })

  it('items() is re-invoked on every open (dynamic checkmarks)', () => {
    let mode = 'fixed'
    const { host, mb } = setup(() => [
      { value: 'fixed', label: 'Fixed', checked: mode === 'fixed' },
      { value: 'hug', label: 'Hug', checked: mode === 'hug' },
    ])
    mb.button.click()
    mb.close()
    mode = 'hug'
    mb.button.click()
    const labels = [...host.querySelectorAll('.menu-item')].map((b) => (b as HTMLElement).textContent)
    expect(labels[1]).toContain('✓')
    expect(labels[0]).not.toContain('✓')
  })

  it('reopening the same button while open just closes (toggle)', () => {
    const { host, mb } = setup()
    mb.button.click()
    mb.button.click()
    expect(host.querySelector('.menu-popover')).toBeNull()
  })
})
