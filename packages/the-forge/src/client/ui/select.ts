// The .size-mode dropdown — every panel select shares this base class, with an
// optional additive suffix (e.g. 'type-weight'). Markup + options only; call sites
// keep their own ids and any post-creation `.value` assignment (set via refresh()).
export interface SelectOpts {
  /** Appended after the base 'size-mode' class, e.g. 'type-weight'. */
  className?: string
  options: ReadonlyArray<{ value: string; label: string }>
  value?: string
  onChange: (value: string) => void
}

export function createSelect(opts: SelectOpts): HTMLSelectElement {
  const select = document.createElement('select')
  select.className = opts.className ? `size-mode ${opts.className}` : 'size-mode'
  for (const { value, label } of opts.options) {
    const opt = document.createElement('option')
    opt.value = value
    opt.textContent = label
    select.append(opt)
  }
  if (opts.value !== undefined) select.value = opts.value
  select.addEventListener('change', () => {
    opts.onChange(select.value)
  })
  return select
}
