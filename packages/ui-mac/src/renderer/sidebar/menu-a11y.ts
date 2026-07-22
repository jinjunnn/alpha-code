export function focusFirstMenuItem(menu: HTMLElement) {
  queueMicrotask(() =>
    menu.querySelector<HTMLElement>("[role='menuitem']:not([disabled]):not([aria-disabled='true'])")?.focus(),
  )
}

export function dismissMenu(dismiss: () => void, trigger: HTMLElement | undefined) {
  dismiss()
  queueMicrotask(() => trigger?.isConnected && trigger.focus())
}

export function dismissMenuOnEscape(event: KeyboardEvent, dismiss: () => void, trigger: HTMLElement | undefined) {
  if (event.key !== "Escape") return
  event.preventDefault()
  event.stopPropagation()
  dismissMenu(dismiss, trigger)
}
