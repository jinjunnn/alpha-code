import { GlobalRegistrator } from "@happy-dom/global-registrator"
import { afterAll, afterEach, beforeEach, describe, expect, mock, test } from "bun:test"
import appPlugin from "@opencode-ai/app/vite"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { pathToFileURL } from "node:url"
import { build } from "vite"
import type { createComponent, createSignal } from "solid-js"
import type { render } from "solid-js/web"
import type { DIALOG_TITLE_ERROR, Dialog } from "./Dialog"
import type { ExtAuthzDialogState, ExtStandaloneAuthzDialog } from "../extensions/ext-authz"

type TestRuntime = {
  createComponent: typeof createComponent
  createSignal: typeof createSignal
  render: typeof render
  DIALOG_TITLE_ERROR: typeof DIALOG_TITLE_ERROR
  Dialog: typeof Dialog
  ExtStandaloneAuthzDialog: typeof ExtStandaloneAuthzDialog
}

// Compile the production component with the same Solid Vite plugin as the Electron renderer.
// Bun's native TSX transform is React-shaped and would silently lose Solid refs and reactive DOM
// expressions, recreating the false-positive test problem this suite exists to prevent.
const runtimeDirectory = mkdtempSync(join(tmpdir(), "alpha-dialog-render-"))
await build({
  configFile: false,
  logLevel: "silent",
  plugins: [appPlugin.at(-1)!],
  build: {
    emptyOutDir: true,
    outDir: runtimeDirectory,
    lib: {
      entry: join(import.meta.dir, "dialog-test-runtime.ts"),
      formats: ["es"],
      fileName: () => "dialog-test-runtime.js",
    },
    rollupOptions: { output: { inlineDynamicImports: true } },
  },
})

const disposers: Array<() => void> = []
GlobalRegistrator.register()
const runtime = (await import(pathToFileURL(join(runtimeDirectory, "dialog-test-runtime.js")).href)) as TestRuntime

beforeEach(() => {
  document.body.replaceChildren()
})

afterEach(async () => {
  disposers.splice(0).reverse().forEach((dispose) => dispose())
  await flush()
})

afterAll(async () => {
  await GlobalRegistrator.unregister()
  rmSync(runtimeDirectory, { recursive: true, force: true })
})

async function flush() {
  await Promise.resolve()
  await Promise.resolve()
}

function element<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  attributes: Record<string, string | number | boolean> = {},
  text?: string,
) {
  const node = document.createElement(tag)
  Object.entries(attributes).forEach(([name, value]) => {
    if (value === false) return
    node.setAttribute(name, value === true ? "" : String(value))
  })
  if (text) node.textContent = text
  return node
}

function keydown(target: Element, key: string, options: KeyboardEventInit = {}) {
  const event = new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true, ...options })
  target.dispatchEvent(event)
  return event
}

function mountDialog(options: {
  title?: string
  children?: unknown
  restoreFocus?: Element | (() => Element | null | undefined)
  dismissible?: boolean
  busy?: boolean
} = {}) {
  const surface = document.createElement("div")
  const trigger = element("button", {}, "Open")
  surface.append(trigger)
  document.body.append(surface)
  trigger.focus()

  const host = document.createElement("div")
  document.body.append(host)
  const [open, setOpen] = runtime.createSignal(true)
  const [dismissible, setDismissible] = runtime.createSignal(options.dismissible ?? true)
  const [busy, setBusy] = runtime.createSignal(options.busy ?? false)
  const close = mock(() => setOpen(false))
  disposers.push(
    runtime.render(
      () =>
        runtime.createComponent(runtime.Dialog, {
          get open() {
            return open()
          },
          onClose: close,
          get title() {
            return options.title ?? "Test dialog"
          },
          description: "Dialog description",
          get dismissible() {
            return dismissible()
          },
          get busy() {
            return busy()
          },
          get restoreFocus() {
            return options.restoreFocus
          },
          get children() {
            return options.children ?? element("button", { autofocus: true }, "Cancel")
          },
        }),
      host,
    ),
  )

  return { trigger, host, open, setOpen, setDismissible, setBusy, close }
}

function dialog() {
  return document.querySelector<HTMLElement>("[role='dialog']")!
}

function rootOf(panel: Element) {
  return panel.closest<HTMLElement>(".a-dialog-root")!
}

function guard(panel: Element, edge: "start" | "end") {
  return panel.querySelector<HTMLElement>(`[data-dialog-focus-guard='${edge}']`)!
}

describe("Alpha Dialog real Solid render contract", () => {
  test("mounts only while open with a real accessible name, description, and busy state", async () => {
    const mounted = mountDialog({ busy: true })
    await flush()

    expect(dialog().getAttribute("aria-modal")).toBe("true")
    expect(document.getElementById(dialog().getAttribute("aria-labelledby")!)?.textContent).toBe("Test dialog")
    expect(document.getElementById(dialog().getAttribute("aria-describedby")!)?.textContent).toBe("Dialog description")
    expect(dialog().getAttribute("aria-busy")).toBe("true")

    mounted.setBusy(false)
    await flush()
    expect(dialog().hasAttribute("aria-busy")).toBe(false)

    mounted.setOpen(false)
    await flush()
    expect(document.querySelector("[role='dialog']")).toBeNull()
  })

  for (const path of ["Escape", "backdrop", "close button"] as const) {
    test(`${path} closes through the production event path and restores focus`, async () => {
      const mounted = mountDialog()
      await flush()

      if (path === "Escape") keydown(dialog().querySelector("button")!, "Escape")
      if (path === "backdrop") rootOf(dialog()).querySelector<HTMLElement>(".a-dialog-backdrop")!.click()
      if (path === "close button") dialog().querySelector<HTMLElement>(".a-dialog-close")!.click()
      await flush()

      expect(mounted.close.mock.calls.length).toBe(1)
      expect(document.querySelector("[role='dialog']")).toBeNull()
      expect(document.activeElement).toBe(mounted.trigger)
    })
  }

  test("dismissible=false consumes Escape and blocks backdrop and close-button paths", async () => {
    const mounted = mountDialog({ dismissible: false, busy: true })
    await flush()

    expect(dialog().querySelector(".a-dialog-close")).toBeNull()
    rootOf(dialog()).querySelector<HTMLElement>(".a-dialog-backdrop")!.click()
    const escape = keydown(dialog().querySelector("button")!, "Escape")
    await flush()
    expect(escape.defaultPrevented).toBe(true)
    expect(mounted.close).not.toHaveBeenCalled()
    expect(document.querySelector("[role='dialog']")).not.toBeNull()

    mounted.setDismissible(true)
    await flush()
    expect(dialog().querySelector(".a-dialog-close")).not.toBeNull()
  })

  test("document focusin fallback keeps escaped focus in the top dialog", async () => {
    const mounted = mountDialog()
    await flush()
    const cancel = dialog().querySelector<HTMLButtonElement>("button[autofocus]")!

    mounted.trigger.focus()
    expect(document.activeElement).toBe(cancel)
  })
})

describe("#348 production authorization host", () => {
  test("drives authorization state, safe focus, busy lock, all dismiss paths, and confirm", async () => {
    const stable = element("button", {}, "Extension Hub close")
    document.body.append(stable)
    stable.focus()
    const host = document.createElement("div")
    document.body.append(host)
    const initial: ExtAuthzDialogState = {
      name: "Demo skill",
      isBundle: false,
      mode: "install",
      diffs: [
        {
          key: "skill--demo",
          previous: null,
          requested: ["prompt:context"],
          added: ["prompt:context"],
          removed: [],
          requiresConfirmation: true,
        },
      ],
    }
    const [state, setState] = runtime.createSignal<ExtAuthzDialogState | null>(null)
    const [busy, setBusy] = runtime.createSignal(false)
    const cancel = mock(() => setState(null))
    const confirm = mock(() => setState(null))
    disposers.push(
      runtime.render(
        () =>
          runtime.createComponent(runtime.ExtStandaloneAuthzDialog, {
            get state() {
              return state()
            },
            get busy() {
              return busy()
            },
            onCancel: cancel,
            onConfirm: confirm,
            restoreFocus: stable,
          }),
        host,
      ),
    )

    setState(initial)
    await flush()
    const safeCancel = dialog().querySelector<HTMLButtonElement>(".a-btn[data-variant='ghost']")!
    expect(safeCancel.autofocus).toBe(true)
    expect(safeCancel.disabled).toBe(false)
    expect(document.activeElement === safeCancel).toBe(true)
    const firstTitle = document.getElementById(dialog().getAttribute("aria-labelledby")!)!.textContent

    setState({ ...initial, mode: "update", diffs: initial.diffs.map((diff) => ({ ...diff, previous: ["prompt:context"] })) })
    await flush()
    expect(document.getElementById(dialog().getAttribute("aria-labelledby")!)!.textContent).not.toBe(firstTitle)

    setBusy(true)
    await flush()
    expect(dialog().getAttribute("aria-busy")).toBe("true")
    expect(dialog().querySelector(".a-dialog-close")).toBeNull()
    keydown(safeCancel, "Escape")
    rootOf(dialog()).querySelector<HTMLElement>(".a-dialog-backdrop")!.click()
    expect(cancel).not.toHaveBeenCalled()
    expect(document.querySelector("[role='dialog']")).not.toBeNull()

    setBusy(false)
    await flush()
    keydown(safeCancel, "Escape")
    await flush()
    expect(cancel).toHaveBeenCalledTimes(1)
    expect(document.activeElement).toBe(stable)

    setState(initial)
    await flush()
    rootOf(dialog()).querySelector<HTMLElement>(".a-dialog-backdrop")!.click()
    await flush()
    expect(cancel).toHaveBeenCalledTimes(2)

    setState(initial)
    await flush()
    dialog().querySelector<HTMLElement>(".a-dialog-close")!.click()
    await flush()
    expect(cancel).toHaveBeenCalledTimes(3)

    setState(initial)
    await flush()
    dialog().querySelector<HTMLElement>(".a-btn[data-variant='primary']")!.click()
    await flush()
    expect(confirm).toHaveBeenCalledTimes(1)
    expect(document.querySelector("[role='dialog']")).toBeNull()
  })
})

describe("sentinel focus boundary", () => {
  test("uses native tab-index order while excluding negative, CSS-hidden, and disabled-fieldset targets", async () => {
    const fieldset = element("fieldset", { disabled: true })
    fieldset.append(element("button", { id: "fieldset-disabled" }, "Disabled"))
    mountDialog({
      dismissible: false,
      children: [
        element("button", { id: "negative", tabindex: -1 }, "Negative"),
        element("button", { id: "hidden", style: "display: none" }, "Hidden"),
        fieldset,
        element("div", { id: "editable", contenteditable: "true", tabindex: 0 }, "Editable"),
        element("summary", { id: "summary", tabindex: 0 }, "Summary"),
        element("audio", { id: "audio", controls: true, style: "display: block" }),
        element("video", { id: "video", controls: true, style: "display: block" }),
        element("iframe", { id: "frame", title: "Frame" }),
        element("button", { id: "priority", tabindex: 2 }, "Priority"),
      ],
    })
    await flush()

    const panel = dialog()
    keydown(panel, "Tab")
    guard(panel, "end").focus()
    expect(document.activeElement?.id).toBe("priority")

    keydown(panel, "Tab", { shiftKey: true })
    guard(panel, "end").focus()
    expect(document.activeElement?.id).toBe("frame")
    expect(document.activeElement?.id).not.toBe("negative")
    expect(document.activeElement?.id).not.toBe("hidden")
    expect(document.activeElement?.id).not.toBe("fieldset-disabled")

    document.getElementById("priority")!.remove()
    for (const id of ["editable", "summary", "audio", "video", "frame"]) {
      keydown(panel, "Tab")
      guard(panel, "end").focus()
      expect(document.activeElement?.id).toBe(id)
      document.getElementById(id)!.remove()
    }
    keydown(panel, "Tab")
    guard(panel, "end").focus()
    expect(document.activeElement).toBe(panel)
  })

  test("radio groups wrap to the selected member, or the first member when none is selected", async () => {
    const mounted = mountDialog({
      dismissible: false,
      children: [
        element("input", { id: "radio-a", type: "radio", name: "plan" }),
        element("input", { id: "radio-b", type: "radio", name: "plan", checked: true }),
      ],
    })
    await flush()

    keydown(dialog(), "Tab")
    guard(dialog(), "end").focus()
    expect(document.activeElement?.id).toBe("radio-b")

    mounted.setOpen(false)
    await flush()
    mountDialog({
      dismissible: false,
      children: [
        element("input", { id: "radio-c", type: "radio", name: "plan-2" }),
        element("input", { id: "radio-d", type: "radio", name: "plan-2" }),
      ],
    })
    await flush()
    keydown(dialog(), "Tab")
    guard(dialog(), "end").focus()
    expect(document.activeElement?.id).toBe("radio-c")
  })

  test("hidden autofocus fails closed to the panel instead of looping", async () => {
    mountDialog({
      children: [
        element("button", { autofocus: true, style: "display: none" }, "Hidden autofocus"),
        element("button", {}, "Visible action"),
      ],
    })
    await flush()
    expect(document.activeElement).toBe(dialog())
  })

  test("recomputes targets after dynamic replacement", async () => {
    const [replacement, setReplacement] = runtime.createSignal(false)
    const original = element("button", { id: "original" }, "Original")
    const next = element("button", { id: "replacement" }, "Replacement")
    mountDialog({ dismissible: false, children: () => (replacement() ? next : original) })
    await flush()

    keydown(dialog(), "Tab")
    guard(dialog(), "end").focus()
    expect(document.activeElement?.id).toBe("original")

    setReplacement(true)
    await flush()
    keydown(dialog(), "Tab")
    guard(dialog(), "end").focus()
    expect(document.activeElement?.id).toBe("replacement")
  })

  for (const mutation of ["disabled", "removed"] as const) {
    test(`recaptures focus when the active button is ${mutation}`, async () => {
      const active = element("button", { id: "active-action" }, "Active action")
      const fallback = element("button", { id: "fallback-action" }, "Fallback action")
      mountDialog({ dismissible: false, children: [active, fallback] })
      await flush()

      active.focus()
      expect(document.activeElement).toBe(active)
      if (mutation === "disabled") active.disabled = true
      if (mutation === "removed") active.remove()
      await flush()

      expect(dialog().contains(document.activeElement)).toBe(true)
      expect(document.activeElement).toBe(fallback)
    })
  }
})

describe("Dialog stack and IME", () => {
  test("only the top dialog is modal, traps focus, and closes on Escape", async () => {
    const external = element("button", {}, "External")
    document.body.append(external)
    external.focus()
    const host = document.createElement("div")
    document.body.append(host)
    const [outerOpen, setOuterOpen] = runtime.createSignal(true)
    const [innerOpen, setInnerOpen] = runtime.createSignal(false)
    const outerClose = mock(() => setOuterOpen(false))
    const innerClose = mock(() => setInnerOpen(false))
    const innerTrigger = element("button", { id: "open-inner", autofocus: true }, "Open inner")
    innerTrigger.addEventListener("click", () => setInnerOpen(true))
    const innerAction = element("button", { id: "inner-action", autofocus: true }, "Inner action")

    disposers.push(
      runtime.render(
        () =>
          runtime.createComponent(runtime.Dialog, {
            get open() {
              return outerOpen()
            },
            onClose: outerClose,
            title: "Outer dialog",
            get children() {
              return [
                innerTrigger,
                runtime.createComponent(runtime.Dialog, {
                  get open() {
                    return innerOpen()
                  },
                  onClose: innerClose,
                  title: "Inner dialog",
                  children: innerAction,
                }),
              ]
            },
          }),
        host,
      ),
    )
    await flush()

    innerTrigger.focus()
    innerTrigger.click()
    await flush()
    const panels = Array.from(document.querySelectorAll<HTMLElement>("[role='dialog']"))
    const outer = panels.find((panel) => panel.textContent?.includes("Outer dialog"))!
    const inner = panels.find((panel) => panel.textContent?.includes("Inner dialog"))!

    expect(outer.hasAttribute("aria-modal")).toBe(false)
    expect(rootOf(outer).hasAttribute("inert")).toBe(true)
    expect(rootOf(outer).getAttribute("aria-hidden")).toBe("true")
    expect(inner.getAttribute("aria-modal")).toBe("true")
    expect(external.hasAttribute("inert")).toBe(true)

    rootOf(outer).querySelector<HTMLElement>(".a-dialog-backdrop")!.click()
    expect(outerClose).not.toHaveBeenCalled()

    keydown(inner, "Tab")
    guard(inner, "end").focus()
    expect(inner.contains(document.activeElement)).toBe(true)
    expect(outer.contains(document.activeElement)).toBe(false)

    keydown(inner.querySelector("button")!, "Escape")
    await flush()
    expect(innerClose).toHaveBeenCalledTimes(1)
    expect(outerClose).not.toHaveBeenCalled()
    expect(document.querySelectorAll("[role='dialog']")).toHaveLength(1)
    expect(dialog().getAttribute("aria-modal")).toBe("true")
    expect(document.activeElement).toBe(innerTrigger)

    keydown(dialog(), "Escape")
    await flush()
    expect(outerClose).toHaveBeenCalledTimes(1)
    expect(document.activeElement).toBe(external)
    expect(external.hasAttribute("inert")).toBe(false)
  })

  test("preserves the outer trigger across non-LIFO dialog closure", async () => {
    const external = element("button", { id: "outer-trigger" }, "Open outer")
    document.body.append(external)
    external.focus()
    const host = document.createElement("div")
    document.body.append(host)
    const [outerOpen, setOuterOpen] = runtime.createSignal(true)
    const [innerOpen, setInnerOpen] = runtime.createSignal(false)
    const innerTrigger = element("button", { id: "inner-trigger" }, "Open inner")

    disposers.push(
      runtime.render(
        () => [
          runtime.createComponent(runtime.Dialog, {
            get open() {
              return outerOpen()
            },
            onClose: () => setOuterOpen(false),
            title: "Outer dialog",
            children: innerTrigger,
          }),
          runtime.createComponent(runtime.Dialog, {
            get open() {
              return innerOpen()
            },
            onClose: () => setInnerOpen(false),
            title: "Inner dialog",
            children: element("button", { autofocus: true }, "Inner action"),
          }),
        ],
        host,
      ),
    )
    await flush()

    innerTrigger.focus()
    setInnerOpen(true)
    await flush()
    setOuterOpen(false)
    await flush()
    expect(document.querySelectorAll("[role='dialog']")).toHaveLength(1)

    setInnerOpen(false)
    await flush()
    expect(document.activeElement).toBe(external)
    expect(document.activeElement).not.toBe(document.querySelector("[data-dialog-focus-anchor]"))
    expect(external.hasAttribute("inert")).toBe(false)
  })

  test("restores into the surviving outer dialog when the persistent anchor is inert", async () => {
    const primed = mountDialog()
    await flush()
    primed.trigger.remove()
    primed.setOpen(false)
    await flush()
    const anchor = document.querySelector<HTMLElement>("[data-dialog-focus-anchor]")!
    expect(document.activeElement).toBe(anchor)

    const host = document.createElement("div")
    document.body.append(host)
    const [innerOpen, setInnerOpen] = runtime.createSignal(false)
    const innerTrigger = element("button", { autofocus: true }, "Open inner")
    const outerAction = element("button", {}, "Outer action")

    disposers.push(
      runtime.render(
        () => [
          runtime.createComponent(runtime.Dialog, {
            open: true,
            onClose() {},
            title: "Surviving outer dialog",
            dismissible: false,
            children: [innerTrigger, outerAction],
          }),
          runtime.createComponent(runtime.Dialog, {
            get open() {
              return innerOpen()
            },
            onClose: () => setInnerOpen(false),
            title: "Closing inner dialog",
            children: element("button", { autofocus: true }, "Inner action"),
          }),
        ],
        host,
      ),
    )
    await flush()

    innerTrigger.focus()
    setInnerOpen(true)
    await flush()
    innerTrigger.remove()
    setInnerOpen(false)
    await flush()

    const outer = dialog()
    expect(anchor.hasAttribute("inert")).toBe(true)
    expect(document.activeElement).toBe(outerAction)
    expect(outer.contains(document.activeElement)).toBe(true)
    expect(document.activeElement).not.toBe(document.body)
    expect(document.activeElement).not.toBe(anchor)
  })

  test("clears lower-dialog composition by event target after the stack top changes", async () => {
    const host = document.createElement("div")
    document.body.append(host)
    const [outerOpen, setOuterOpen] = runtime.createSignal(true)
    const [innerOpen, setInnerOpen] = runtime.createSignal(false)
    const outerClose = mock(() => setOuterOpen(false))
    const innerClose = mock(() => setInnerOpen(false))
    const input = element("input", { autofocus: true })

    disposers.push(
      runtime.render(
        () => [
          runtime.createComponent(runtime.Dialog, {
            get open() {
              return outerOpen()
            },
            onClose: outerClose,
            title: "Outer composition dialog",
            children: input,
          }),
          runtime.createComponent(runtime.Dialog, {
            get open() {
              return innerOpen()
            },
            onClose: innerClose,
            title: "Inner composition dialog",
            children: element("button", { autofocus: true }, "Inner action"),
          }),
        ],
        host,
      ),
    )
    await flush()

    input.dispatchEvent(new CompositionEvent("compositionstart", { bubbles: true }))
    setInnerOpen(true)
    await flush()
    const composing = keydown(input, "Escape")
    expect(composing.defaultPrevented).toBe(false)
    expect(innerClose).not.toHaveBeenCalled()

    input.dispatchEvent(new CompositionEvent("compositionend", { bubbles: true }))
    keydown(document.querySelectorAll("[role='dialog']")[1]!, "Escape")
    await flush()
    expect(innerClose).toHaveBeenCalledTimes(1)

    keydown(input, "Escape")
    await flush()
    expect(outerClose).toHaveBeenCalledTimes(1)
  })

  for (const title of ["Import", "Custom MCP", "Agent preview"]) {
    test(`${title} dialog contains composing Escape before raw document listeners`, async () => {
      const mounted = mountDialog({ title, children: element("input", { autofocus: true }) })
      await flush()
      const input = dialog().querySelector("input")!
      const raw = mock(() => {})
      document.addEventListener("keydown", raw)

      const flagged = keydown(input, "Escape", { isComposing: true })
      expect(flagged.defaultPrevented).toBe(false)
      expect(raw).not.toHaveBeenCalled()
      expect(mounted.close).not.toHaveBeenCalled()

      input.dispatchEvent(new CompositionEvent("compositionstart", { bubbles: true }))
      const composing = keydown(input, "Escape")
      expect(composing.defaultPrevented).toBe(false)
      expect(raw).not.toHaveBeenCalled()
      expect(mounted.close).not.toHaveBeenCalled()

      input.dispatchEvent(new CompositionEvent("compositionend", { bubbles: true }))
      const escape = keydown(input, "Escape")
      await flush()
      expect(escape.defaultPrevented).toBe(true)
      expect(raw).not.toHaveBeenCalled()
      expect(mounted.close).toHaveBeenCalledTimes(1)
      document.removeEventListener("keydown", raw)
    })
  }
})

describe("fail-closed title and focus restoration", () => {
  for (const [label, title] of [["empty", ""], ["whitespace", "   "], ["undefined", undefined]] as const) {
    test(`rejects ${label} title before mounting a modal`, async () => {
      const host = document.createElement("div")
      document.body.append(host)
      expect(() =>
        runtime.render(
          () =>
            runtime.createComponent(runtime.Dialog, {
              open: true,
              onClose() {},
              title: title as string,
            }),
          host,
        ),
      ).toThrow(runtime.DIALOG_TITLE_ERROR)
      await flush()
      expect(document.querySelector("[role='dialog']")).toBeNull()
    })
  }

  test("restores a focusable SVG trigger", async () => {
    const trigger = document.createElementNS("http://www.w3.org/2000/svg", "svg")
    trigger.setAttribute("tabindex", "0")
    document.body.append(trigger)
    trigger.focus()
    const host = document.createElement("div")
    document.body.append(host)
    const [open, setOpen] = runtime.createSignal(true)
    disposers.push(
      runtime.render(
        () =>
          runtime.createComponent(runtime.Dialog, {
            get open() {
              return open()
            },
            onClose: () => setOpen(false),
            title: "SVG restore",
          }),
        host,
      ),
    )
    await flush()
    setOpen(false)
    await flush()
    expect(document.activeElement).toBe(trigger)
  })

  for (const state of ["removed", "hidden", "inert"] as const) {
    test(`uses the explicit stable target when the trigger is ${state}`, async () => {
      const stable = element("button", {}, "Stable focus")
      document.body.append(stable)
      const mounted = mountDialog({ restoreFocus: stable })
      await flush()

      if (state === "removed") mounted.trigger.remove()
      if (state === "hidden") mounted.trigger.hidden = true
      if (state === "inert") mounted.trigger.setAttribute("inert", "")
      mounted.setOpen(false)
      await flush()
      expect(document.activeElement).toBe(stable)
    })
  }

  test("uses the Dialog-owned focus anchor rather than body when no restore target survives", async () => {
    const mounted = mountDialog()
    await flush()
    mounted.trigger.remove()
    mounted.setOpen(false)
    await flush()

    expect(document.activeElement).toBe(document.querySelector("[data-dialog-focus-anchor]"))
    expect(document.activeElement).not.toBe(document.body)
  })
})
