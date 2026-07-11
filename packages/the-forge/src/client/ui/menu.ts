import { createButton } from './button'

export interface MenuItem {
  value: string
  label: string
  /** Renders a trailing ✓ — the currently-applied mode. */
  checked?: boolean
  /** Renders a divider line above this item. */
  separator?: boolean
}

export interface MenuButtonOpts {
  title?: string
  /** Computed fresh on every open — checkmarks and gated items are dynamic. */
  items: () => MenuItem[]
  onSelect: (value: string) => void
  /** Positioned ancestor the popover appends to — the panel body, same host as TokenPicker. */
  popoverHost: HTMLElement
  /** Trigger label — defaults to the '▾' chevron. Call sites may update button.textContent live. */
  label?: string
  /** Open the popover ABOVE the trigger (for bottom-anchored chrome like the zoom pill). */
  opensUp?: boolean
}

export interface MenuButton {
  button: HTMLButtonElement
  close: () => void
}

// Must match .menu-popover's `min-width: 120px` in overlay.ts — this is only the clamp
// used to keep the popover from overhanging popoverHost's right edge (line 86 below), so a
// drift between the two would misposition the popover without erroring.
const MENU_WIDTH = 120

/**
 * The '▾' chevron + popover menu — born here so every dropdown-menu affordance shares one
 * open/close contract (outside-mousedown + Escape, document listeners attached only while
 * open — zero idle overhead). The popover is rebuilt from opts.items() on every open so
 * checkmarks and context-gated items can't go stale.
 */
export function createMenuButton(opts: MenuButtonOpts): MenuButton {
  const button = createButton({ label: opts.label ?? '▾', title: opts.title, className: 'menu-btn' })
  button.type = 'button'
  let popover: HTMLElement | null = null

  const close = (): void => {
    if (!popover) return
    popover.remove()
    popover = null
    document.removeEventListener('mousedown', onDocDown, true)
    document.removeEventListener('keydown', onDocKey, true)
  }

  // Shadow DOM retargets e.target to the host — composedPath()[0] sees the real node
  // (same convention as TokenPicker's outside-click handler).
  const onDocDown = (e: MouseEvent): void => {
    const target = (e.composedPath?.()[0] ?? e.target) as Node
    if (popover?.contains(target) || button.contains(target)) return
    close()
  }
  const onDocKey = (e: KeyboardEvent): void => {
    if (e.key === 'Escape') close()
  }

  const open = (): void => {
    popover = document.createElement('div')
    popover.className = 'menu-popover'
    for (const item of opts.items()) {
      if (item.separator) {
        const sep = document.createElement('div')
        sep.className = 'menu-sep'
        popover.append(sep)
      }
      const btn = document.createElement('button')
      btn.type = 'button'
      btn.className = 'menu-item'
      btn.textContent = item.label
      if (item.checked) {
        const check = document.createElement('span')
        check.className = 'menu-check'
        check.textContent = '✓'
        btn.append(check)
      }
      btn.addEventListener('click', () => {
        close()
        opts.onSelect(item.value)
      })
      popover.append(btn)
    }
    // offsetTop/offsetLeft resolve against the popoverHost (the nearest positioned
    // ancestor) — nothing between the button and the host is positioned, by contract.
    // Append before measuring — offsetHeight is 0 until the popover is in the tree.
    opts.popoverHost.append(popover)
    popover.style.top = opts.opensUp
      ? `${button.offsetTop - popover.offsetHeight - 2}px`
      : `${button.offsetTop + button.offsetHeight + 2}px`
    popover.style.left = `${Math.max(0, Math.min(button.offsetLeft, opts.popoverHost.clientWidth - MENU_WIDTH))}px`
    document.addEventListener('mousedown', onDocDown, true)
    document.addEventListener('keydown', onDocKey, true)
  }

  button.addEventListener('click', () => {
    if (popover) close()
    else open()
  })

  return { button, close }
}
