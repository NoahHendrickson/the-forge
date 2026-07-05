// The single place overlay buttons are born — markup only; call sites keep their own
// ids, event listeners, and data attributes.
export interface ButtonOpts {
  label?: string
  title?: string
  /** Additive class(es) — appended, never replacing context styling. */
  className?: string
}

export function createButton(opts: ButtonOpts = {}): HTMLButtonElement {
  const btn = document.createElement('button')
  if (opts.label !== undefined) btn.textContent = opts.label
  if (opts.title !== undefined) btn.title = opts.title
  if (opts.className !== undefined) btn.className = opts.className
  return btn
}
