// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { SegmentField, AlignMatrix } from '../../src/client/layout-controls'

beforeEach(() => {
  document.body.innerHTML = ''
})

describe('SegmentField', () => {
  function make() {
    const onInput = vi.fn()
    const sf = new SegmentField({
      label: 'Direction',
      options: [
        { value: 'row', label: 'Row' },
        { value: 'column', label: 'Column' },
      ],
      onInput,
    })
    document.body.appendChild(sf.root)
    const buttons = Array.from(sf.root.querySelectorAll('.seg')) as HTMLElement[]
    return { sf, onInput, buttons }
  }

  it('renders one .seg button per option with its label text', () => {
    const { buttons } = make()
    expect(buttons).toHaveLength(2)
    expect(buttons[0].textContent).toBe('Row')
    expect(buttons[1].textContent).toBe('Column')
  })

  it('clicking a button emits its value via onInput', () => {
    const { onInput, buttons } = make()
    buttons[1].dispatchEvent(new MouseEvent('click', { bubbles: true }))
    expect(onInput).toHaveBeenCalledWith('column')
  })

  it('set(value) marks the matching button .seg-active and clears the rest', () => {
    const { sf, buttons } = make()
    sf.set('row')
    expect(buttons[0].classList.contains('seg-active')).toBe(true)
    expect(buttons[1].classList.contains('seg-active')).toBe(false)

    sf.set('column')
    expect(buttons[0].classList.contains('seg-active')).toBe(false)
    expect(buttons[1].classList.contains('seg-active')).toBe(true)
  })

  it('set(null) clears all active classes (mixed/unknown)', () => {
    const { sf, buttons } = make()
    sf.set('row')
    sf.set(null)
    expect(buttons[0].classList.contains('seg-active')).toBe(false)
    expect(buttons[1].classList.contains('seg-active')).toBe(false)
  })

  it('clicking a button also updates the active state locally', () => {
    const { sf, buttons } = make()
    buttons[0].dispatchEvent(new MouseEvent('click', { bubbles: true }))
    expect(buttons[0].classList.contains('seg-active')).toBe(true)
  })

  it('wraps the segment buttons in a .seg-track appended after the label', () => {
    const { sf, buttons } = make()
    const track = sf.root.querySelector('.seg-track') as HTMLElement
    expect(track).toBeTruthy()
    for (const button of buttons) {
      expect(track.contains(button)).toBe(true)
    }
    // label is a direct child of root, preceding the track
    const label = sf.root.querySelector('.seg-field-label') as HTMLElement
    expect(label.nextElementSibling).toBe(track)
  })

  it('every segment button carries a title so clipped labels are still discoverable', () => {
    const field = new SegmentField({
      label: 'Justify',
      options: [{ value: 'space-between', label: 'Space between' }],
      onInput: () => {},
    })
    const btn = field.root.querySelector('.seg') as HTMLElement
    expect(btn.title).toBe('Space between')
  })
})

describe('AlignMatrix', () => {
  function make() {
    const onInput = vi.fn()
    const am = new AlignMatrix({ onInput })
    document.body.appendChild(am.root)
    return { am, onInput }
  }

  function dots(am: AlignMatrix): HTMLElement[] {
    return Array.from(am.root.querySelectorAll('.am-dot')) as HTMLElement[]
  }

  function dotFor(am: AlignMatrix, j: string, a: string): HTMLElement {
    const found = dots(am).find((d) => d.dataset.j === j && d.dataset.a === a)
    if (!found) throw new Error(`no dot for j=${j} a=${a}`)
    return found
  }

  it('renders a 3x3 grid of dots by default (row, not spaceBetween)', () => {
    const { am } = make()
    am.set(null, null, 'row', false)
    expect(dots(am)).toHaveLength(9)
  })

  it('in row direction, columns map to justify and rows map to align', () => {
    const { am, onInput } = make()
    am.set(null, null, 'row', false)
    // top-right dot: justify flex-end, align flex-start
    const topRight = dotFor(am, 'flex-end', 'flex-start')
    topRight.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    expect(onInput).toHaveBeenLastCalledWith({ justify: 'flex-end', align: 'flex-start' })
  })

  it('in column direction, the same physical dot emits the transposed pair', () => {
    const { am, onInput } = make()
    am.set(null, null, 'column', false)
    // The physical top-right position in a 'column' layout is transposed:
    // rows = justify, columns = align. The physical dot that emitted
    // {justify:'flex-end', align:'flex-start'} in row mode should now
    // emit {justify:'flex-start', align:'flex-end'} in column mode.
    const topRightPhysical = dotFor(am, 'flex-start', 'flex-end')
    topRightPhysical.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    expect(onInput).toHaveBeenLastCalledWith({ justify: 'flex-start', align: 'flex-end' })
  })

  it('set("center","center","row",false) activates the middle dot', () => {
    const { am } = make()
    am.set('center', 'center', 'row', false)
    const middle = dotFor(am, 'center', 'center')
    expect(middle.classList.contains('am-active')).toBe(true)
    for (const d of dots(am)) {
      if (d !== middle) expect(d.classList.contains('am-active')).toBe(false)
    }
  })

  it('spaceBetween renders only 3 dots along the cross axis', () => {
    const { am } = make()
    am.set('space-between', 'center', 'row', true)
    expect(dots(am)).toHaveLength(3)
  })

  it('spaceBetween: clicking a dot emits justify:"space-between" with the chosen align', () => {
    const { am, onInput } = make()
    am.set('space-between', null, 'row', true)
    const [first] = dots(am)
    first.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    expect(onInput).toHaveBeenLastCalledWith(
      expect.objectContaining({ justify: 'space-between' })
    )
  })

  it('spaceBetween in column direction still renders 3 dots (cross axis only)', () => {
    const { am } = make()
    am.set('space-between', 'center', 'column', true)
    expect(dots(am)).toHaveLength(3)
  })

  it('spaceBetween in row direction adds the am-sb-col modifier class (cross axis stacks vertically)', () => {
    const { am } = make()
    am.set('space-between', 'center', 'row', true)
    expect(am.root.classList.contains('am-sb-col')).toBe(true)
    expect(am.root.classList.contains('am-sb-row')).toBe(false)
  })

  it('spaceBetween in column direction adds the am-sb-row modifier class (transpose)', () => {
    const { am } = make()
    am.set('space-between', 'center', 'column', true)
    expect(am.root.classList.contains('am-sb-row')).toBe(true)
    expect(am.root.classList.contains('am-sb-col')).toBe(false)
  })

  it('non-spaceBetween mode carries neither sb modifier class', () => {
    const { am } = make()
    am.set('center', 'center', 'row', false)
    expect(am.root.classList.contains('am-sb-col')).toBe(false)
    expect(am.root.classList.contains('am-sb-row')).toBe(false)
  })
})
