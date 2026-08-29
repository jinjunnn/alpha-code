import { enterModal } from "./modal-presence"

export type DialogFocusTarget = HTMLElement | SVGElement
export type DialogRestoreFocus = DialogFocusTarget | (() => DialogFocusTarget | null | undefined)

type DialogFocusManager = ReturnType<typeof createDialogFocusManager>
type DialogRestoreRequest = {
  trigger: Element | null
  fallback: () => DialogRestoreFocus | undefined
}
type DialogEntry = {
  root: HTMLElement
  panel: HTMLElement
  manager: DialogFocusManager
  restore: DialogRestoreRequest
  canDismiss: () => boolean
  onClose: () => void
  composing: boolean
}
type SavedLayerState = { inert: string | null; ariaHidden: string | null }
type DialogStack = {
  entries: DialogEntry[]
  layers: Map<HTMLElement, SavedLayerState>
  onKeyDown: (event: KeyboardEvent) => void
  onFocusIn: (event: FocusEvent) => void
  onCompositionStart: (event: CompositionEvent) => void
  onCompositionEnd: (event: CompositionEvent) => void
  observer: MutationObserver
}

const stacks = new WeakMap<Document, DialogStack>()

export function createDialogFocusManager(panel: HTMLElement) {
  let tabDirection: 1 | -1 = 1

  const focusPanel = () => {
    panel.focus()
    return panel.ownerDocument.activeElement === panel
  }

  return {
    focusInitial() {
      if (!panel.isConnected) return
      const autofocus = Array.from(panel.querySelectorAll<HTMLElement | SVGElement>("*")).find(
        (element) => element.hasAttribute("autofocus") || (element as HTMLElement & { autofocus?: boolean }).autofocus,
      )
      if (autofocus) {
        if (isTabbable(autofocus, panel) && focusElement(autofocus)) return
        focusPanel()
        return
      }
      focusPanel()
    },
    setTabDirection(direction: 1 | -1) {
      tabDirection = direction
    },
    focusGuard(guard: HTMLElement) {
      const tabbable = tabbableElements(panel)
      const guardIndex = tabbable.indexOf(guard)
      if (guardIndex < 0) {
        focusPanel()
        return
      }
      const targets = Array.from({ length: tabbable.length - 1 }, (_, offset) => {
        const index = (guardIndex + tabDirection * (offset + 1) + tabbable.length) % tabbable.length
        return tabbable[index]
      }).filter((element) => !element.hasAttribute("data-dialog-focus-guard"))
      if (targets.some(focusElement)) return
      focusPanel()
    },
    containFocus() {
      const active = panel.ownerDocument.activeElement
      if ((active instanceof HTMLElement || active instanceof SVGElement) && isFocusableInPanel(active, panel)) return
      const targets = tabbableElements(panel).filter((element) => !element.hasAttribute("data-dialog-focus-guard"))
      if (targets.some(focusElement)) return
      focusPanel()
    },
  }
}

export function registerDialog(options: {
  root: HTMLElement
  panel: HTMLElement
  manager: DialogFocusManager
  trigger: Element | null
  restoreFocus: () => DialogRestoreFocus | undefined
  canDismiss: () => boolean
  onClose: () => void
}) {
  const stack = dialogStack(options.panel.ownerDocument)
  const entry: DialogEntry = {
    root: options.root,
    panel: options.panel,
    manager: options.manager,
    restore: { trigger: options.trigger, fallback: options.restoreFocus },
    canDismiss: options.canDismiss,
    onClose: options.onClose,
    composing: false,
  }
  stack.entries.push(entry)
  updateLayers(stack, options.panel.ownerDocument)
  // #1173:模态栈是 renderer 里「强模态在场」的唯一真相,把它广播出去 —— 原生叠放层
  // (右栏预览的 WebContentsView)不在 DOM 里,inert/aria-hidden 对它无效,只能靠这个信号让位。
  const releaseModal = enterModal()
  const isTop = () => stack.entries.at(-1) === entry
  let registered = true

  return {
    isTop,
    focusGuard(guard: HTMLElement) {
      if (isTop()) entry.manager.focusGuard(guard)
    },
    unregister() {
      if (!registered) return
      registered = false
      // 先于任何提前 return 释放:unregister 被调用就意味着这个模态已经不在场了。
      releaseModal()
      const index = stack.entries.indexOf(entry)
      if (index < 0) return
      const wasTop = index === stack.entries.length - 1
      stack.entries.splice(index, 1)
      // A surviving inner dialog inherits the removed lower dialog's return path.
      if (!wasTop) stack.entries[index]!.restore = entry.restore
      updateLayers(stack, options.panel.ownerDocument)
      if (wasTop) queueMicrotask(() => restoreDialogFocus(options.panel.ownerDocument, entry.restore))
      if (stack.entries.length > 0) return
      options.panel.ownerDocument.removeEventListener("keydown", stack.onKeyDown, true)
      options.panel.ownerDocument.removeEventListener("focusin", stack.onFocusIn, true)
      options.panel.ownerDocument.removeEventListener("compositionstart", stack.onCompositionStart, true)
      options.panel.ownerDocument.removeEventListener("compositionend", stack.onCompositionEnd, true)
      stack.observer.disconnect()
      stacks.delete(options.panel.ownerDocument)
    },
  }
}

function dialogStack(document: Document) {
  const existing = stacks.get(document)
  if (existing) return existing

  const entries: DialogEntry[] = []
  const observer = new MutationObserver(() => entries.at(-1)?.manager.containFocus())
  const stack: DialogStack = {
    entries,
    layers: new Map(),
    onKeyDown(event) {
      const top = stack.entries.at(-1)
      if (!top) return
      if (event.key === "Tab") {
        top.manager.setTabDirection(event.shiftKey ? -1 : 1)
        return
      }
      if (event.key !== "Escape") return
      if (entryForTarget(stack, event.target)?.composing || event.isComposing) {
        event.stopImmediatePropagation()
        return
      }
      event.preventDefault()
      event.stopImmediatePropagation()
      if (top.canDismiss()) top.onClose()
    },
    onFocusIn(event) {
      const top = stack.entries.at(-1)
      if (!top || (event.target instanceof Node && top.panel.contains(event.target))) return
      top.manager.focusInitial()
    },
    onCompositionStart(event) {
      const entry = entryForTarget(stack, event.target)
      if (entry) entry.composing = true
    },
    onCompositionEnd(event) {
      const entry = entryForTarget(stack, event.target)
      if (entry) entry.composing = false
    },
    observer,
  }
  stacks.set(document, stack)
  document.addEventListener("keydown", stack.onKeyDown, true)
  document.addEventListener("focusin", stack.onFocusIn, true)
  document.addEventListener("compositionstart", stack.onCompositionStart, true)
  document.addEventListener("compositionend", stack.onCompositionEnd, true)
  return stack
}

function updateLayers(stack: DialogStack, document: Document) {
  const top = stack.entries.at(-1)
  const topHost = top ? portalHost(top.root, document.body) : undefined

  stack.observer.disconnect()

  Array.from(document.body.children)
    .filter((element): element is HTMLElement => element instanceof HTMLElement)
    .forEach((element) => {
      if (!stack.layers.has(element)) {
        stack.layers.set(element, {
          inert: element.getAttribute("inert"),
          ariaHidden: element.getAttribute("aria-hidden"),
        })
      }
      const saved = stack.layers.get(element)!
      if (!top || element === topHost) {
        setAttribute(element, "inert", saved.inert)
        setAttribute(element, "aria-hidden", saved.ariaHidden)
        return
      }
      element.setAttribute("inert", "")
      element.setAttribute("aria-hidden", "true")
    })

  stack.entries.forEach((entry) => {
    if (entry === top) {
      entry.root.removeAttribute("inert")
      entry.root.removeAttribute("aria-hidden")
      entry.panel.setAttribute("aria-modal", "true")
      return
    }
    entry.root.setAttribute("inert", "")
    entry.root.setAttribute("aria-hidden", "true")
    entry.panel.removeAttribute("aria-modal")
  })

  if (top) {
    stack.observer.observe(top.panel, { attributes: true, childList: true, subtree: true })
    return
  }
  stack.layers.forEach((saved, element) => {
    setAttribute(element, "inert", saved.inert)
    setAttribute(element, "aria-hidden", saved.ariaHidden)
  })
  stack.layers.clear()
}

function entryForTarget(stack: DialogStack, target: EventTarget | null) {
  if (!(target instanceof Node)) return undefined
  return stack.entries.findLast((entry) => entry.panel.contains(target))
}

function restoreDialogFocus(document: Document, restore: DialogRestoreRequest) {
  if (isRestorable(restore.trigger) && focusElement(restore.trigger)) return
  const explicit = restore.fallback()
  const target = typeof explicit === "function" ? explicit() : explicit
  if (isRestorable(target) && focusElement(target)) return
  if (focusElement(focusAnchor(document))) return
  // A persistent anchor is inert while another dialog survives, so fail closed into its focus domain.
  stacks.get(document)?.entries.at(-1)?.manager.containFocus()
}

function portalHost(root: HTMLElement, body: HTMLElement) {
  if (!root.parentElement || root.parentElement === body) return root
  return portalHost(root.parentElement, body)
}

function setAttribute(element: HTMLElement, name: string, value: string | null) {
  if (value === null) {
    element.removeAttribute(name)
    return
  }
  element.setAttribute(name, value)
}

function tabbableElements(panel: HTMLElement) {
  const candidates = Array.from(panel.querySelectorAll<HTMLElement | SVGElement>("*")).filter((element) =>
    isTabbable(element, panel),
  )
  const radios = candidates.filter((element): element is HTMLInputElement => isRadio(element))
  const radioFiltered = candidates.filter((element) => {
    if (!isRadio(element) || !element.name) return true
    const group = radios.filter((radio) => radio.name === element.name && radio.form === element.form)
    return (group.find((radio) => radio.checked) ?? group[0]) === element
  })
  const index = new Map(radioFiltered.map((element, position) => [element, position]))
  return radioFiltered.toSorted((left, right) => {
    if (left.tabIndex === 0 && right.tabIndex > 0) return 1
    if (left.tabIndex > 0 && right.tabIndex === 0) return -1
    if (left.tabIndex !== right.tabIndex) return left.tabIndex - right.tabIndex
    return index.get(left)! - index.get(right)!
  })
}

function isTabbable(element: HTMLElement | SVGElement, panel: HTMLElement) {
  return element.tabIndex >= 0 && isFocusableInPanel(element, panel)
}

function isFocusableInPanel(element: HTMLElement | SVGElement, panel: HTMLElement) {
  if (!panel.contains(element) || !isVisible(element)) return false
  if ((element as HTMLElement & { disabled?: boolean }).disabled) return false
  return !disabledByFieldset(element)
}

function disabledByFieldset(element: Element) {
  const fieldsets: HTMLFieldSetElement[] = []
  let ancestor = element.parentElement
  while (ancestor) {
    if (ancestor instanceof HTMLFieldSetElement) fieldsets.push(ancestor)
    ancestor = ancestor.parentElement
  }
  return fieldsets.some((fieldset) => {
    if (!fieldset.disabled) return false
    const legend = Array.from(fieldset.children).find((child) => child instanceof HTMLLegendElement)
    return !legend?.contains(element)
  })
}

function isRadio(element: HTMLElement | SVGElement): element is HTMLInputElement {
  return element instanceof HTMLInputElement && element.type === "radio"
}

function isVisible(element: Element) {
  if (!element.isConnected || element.closest("[hidden], [inert], [aria-hidden='true']")) return false
  const style = element.ownerDocument.defaultView?.getComputedStyle(element)
  return style?.display !== "none" && style?.visibility !== "hidden" && style?.visibility !== "collapse"
}

function isRestorable(target: Element | null | undefined): target is DialogFocusTarget {
  if (!target || !(target instanceof HTMLElement || target instanceof SVGElement)) return false
  return isVisible(target) && !(target as HTMLElement & { disabled?: boolean }).disabled
}

function focusElement(element: Element) {
  if (!(element instanceof HTMLElement || element instanceof SVGElement)) return false
  element.focus()
  return element.ownerDocument.activeElement === element
}

function focusAnchor(document: Document) {
  const existing = document.querySelector<HTMLElement>("[data-dialog-focus-anchor]")
  if (existing) return existing
  const anchor = document.createElement("span")
  anchor.className = "a-dialog-focus-anchor"
  anchor.tabIndex = -1
  anchor.setAttribute("data-dialog-focus-anchor", "")
  document.body.append(anchor)
  return anchor
}
