const FOCUSABLE_SELECTOR = [
  "a[href]",
  "area[href]",
  "button:not([disabled])",
  "input:not([disabled]):not([type=hidden])",
  "select:not([disabled])",
  "textarea:not([disabled])",
  "iframe",
  "object",
  "embed",
  "[contenteditable]:not([contenteditable=false])",
  "[tabindex]:not([tabindex='-1'])",
].join(",")

/** DOM-only focus boundary shared by the Solid Dialog and its behavior tests. */
export function createDialogFocusManager(panel: HTMLElement, trigger: Element | null) {
  const focusableElements = () =>
    Array.from(panel.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR)).filter(
      (element) =>
        element.tabIndex >= 0 &&
        !element.closest("[hidden], [inert], [aria-hidden='true']") &&
        element.getAttribute("aria-disabled") !== "true",
    )

  return {
    focusInitial() {
      if (!panel.isConnected) return
      const autofocus = focusableElements().find((element) => element.hasAttribute("autofocus"))
      if (autofocus) return autofocus.focus()
      panel.focus()
    },
    handleKeyDown(event: KeyboardEvent, dismissible: boolean, onClose: () => void) {
      if (event.key === "Escape") {
        if (event.isComposing) {
          event.stopPropagation()
          return
        }
        event.preventDefault()
        event.stopImmediatePropagation()
        if (dismissible) onClose()
        return
      }
      if (event.key !== "Tab") return

      const focusable = focusableElements()
      if (focusable.length === 0) {
        event.preventDefault()
        panel.focus()
        return
      }

      const active = panel.ownerDocument.activeElement
      const target = event.shiftKey ? focusable.at(-1)! : focusable[0]!
      const atBoundary = event.shiftKey ? active === focusable[0] : active === focusable.at(-1)
      if (!atBoundary && focusable.includes(active as HTMLElement)) return
      event.preventDefault()
      target.focus()
    },
    restore() {
      const view = panel.ownerDocument.defaultView
      if (view && trigger instanceof view.HTMLElement && trigger.isConnected) trigger.focus()
    },
  }
}
