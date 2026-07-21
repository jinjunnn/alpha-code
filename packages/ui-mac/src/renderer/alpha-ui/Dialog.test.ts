import { GlobalRegistrator } from "@happy-dom/global-registrator"
import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import { join } from "node:path"
import { createDialogFocusManager } from "./dialog-core"

beforeEach(() => {
  GlobalRegistrator.register()
})

afterEach(async () => {
  await GlobalRegistrator.unregister()
})

function fixture(autofocus = true) {
  const trigger = document.createElement("button")
  const panel = document.createElement("div")
  const close = document.createElement("button")
  const cancel = document.createElement("button")
  const confirm = document.createElement("button")
  panel.tabIndex = -1
  if (autofocus) cancel.setAttribute("autofocus", "")
  panel.append(close, cancel, confirm)
  document.body.append(trigger, panel)
  trigger.focus()
  return { trigger, panel, close, cancel, confirm, manager: createDialogFocusManager(panel, trigger) }
}

describe("Alpha Dialog focus and keyboard contract", () => {
  test("initial focus honors [autofocus] and otherwise uses the dialog container", () => {
    const explicit = fixture()
    explicit.manager.focusInitial()
    expect(document.activeElement).toBe(explicit.cancel)

    document.body.replaceChildren()
    const fallback = fixture(false)
    fallback.manager.focusInitial()
    expect(document.activeElement).toBe(fallback.panel)
  })

  test("Tab and Shift+Tab wrap at the focus boundary", () => {
    const dialog = fixture()
    dialog.panel.addEventListener("keydown", (event) => dialog.manager.handleKeyDown(event, true, () => {}))

    dialog.confirm.focus()
    const forward = new KeyboardEvent("keydown", { key: "Tab", bubbles: true, cancelable: true })
    dialog.confirm.dispatchEvent(forward)
    expect(forward.defaultPrevented).toBe(true)
    expect(document.activeElement).toBe(dialog.close)

    const backward = new KeyboardEvent("keydown", { key: "Tab", shiftKey: true, bubbles: true, cancelable: true })
    dialog.close.dispatchEvent(backward)
    expect(backward.defaultPrevented).toBe(true)
    expect(document.activeElement).toBe(dialog.confirm)
  })

  test("Tab recovers the boundary when dynamic content left focus outside", () => {
    const dialog = fixture()
    const outside = document.createElement("button")
    document.body.append(outside)
    document.addEventListener("keydown", (event) => dialog.manager.handleKeyDown(event, true, () => {}), true)

    outside.focus()
    const tab = new KeyboardEvent("keydown", { key: "Tab", bubbles: true, cancelable: true })
    outside.dispatchEvent(tab)
    expect(tab.defaultPrevented).toBe(true)
    expect(document.activeElement).toBe(dialog.close)
  })

  test("Escape closes only dismissible dialogs and ignores IME composition", () => {
    const dialog = fixture()
    let closes = 0
    let outerEscapes = 0
    dialog.panel.addEventListener("keydown", (event) => dialog.manager.handleKeyDown(event, true, () => closes++))
    document.addEventListener("keydown", () => outerEscapes++)

    const composing = new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true })
    Object.defineProperty(composing, "isComposing", { value: true })
    dialog.cancel.dispatchEvent(composing)
    expect(closes).toBe(0)
    expect(composing.defaultPrevented).toBe(false)
    expect(outerEscapes).toBe(0)

    const escape = new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true })
    dialog.cancel.dispatchEvent(escape)
    expect(closes).toBe(1)
    expect(escape.defaultPrevented).toBe(true)
    expect(outerEscapes).toBe(0)

    const locked = fixture()
    locked.panel.addEventListener("keydown", (event) => locked.manager.handleKeyDown(event, false, () => closes++))
    const blocked = new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true })
    locked.cancel.dispatchEvent(blocked)
    expect(closes).toBe(1)
    expect(blocked.defaultPrevented).toBe(true)
  })

  test("closing restores focus to the connected trigger", () => {
    const dialog = fixture()
    dialog.manager.focusInitial()
    dialog.panel.remove()
    dialog.manager.restore()
    expect(document.activeElement).toBe(dialog.trigger)
  })

  test("component wiring owns modal name, optional description, busy, and backdrop policy", () => {
    const source = readFileSync(join(import.meta.dir, "Dialog.tsx"), "utf8")
    expect(source).toContain('aria-modal="true"')
    expect(source).toContain("aria-labelledby={titleId}")
    expect(source).toContain("id={titleId}")
    expect(source).toContain("aria-describedby={props.description ? descriptionId : undefined}")
    expect(source).toContain("id={descriptionId}")
    expect(source).toContain('aria-busy={props.busy ? "true" : undefined}')
    expect(source).toContain("canDismiss() && props.onClose()")
    expect(source).toContain('document.addEventListener("keydown", onDocumentKeyDown, true)')
    expect(source).toContain("queueMicrotask(() => manager.restore())")
  })
})
