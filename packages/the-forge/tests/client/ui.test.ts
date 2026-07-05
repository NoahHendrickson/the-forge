// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { createButton } from '../../src/client/ui/button'
import { createSelect } from '../../src/client/ui/select'

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
