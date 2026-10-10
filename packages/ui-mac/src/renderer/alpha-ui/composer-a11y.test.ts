import { GlobalRegistrator } from "@happy-dom/global-registrator"
import { afterAll, afterEach, beforeEach, describe, expect, test } from "bun:test"
import appPlugin from "@opencode-ai/app/vite"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { pathToFileURL } from "node:url"
import { build } from "vite"
import { readFileSync, readdirSync } from "node:fs"
import { menuMoveIndex } from "./overlay-menu"
import { TOOLTIP_DELAY_MS } from "./Tooltip"
import { TOAST_DURATION_MS } from "./Toast"
import { COPIED_FEEDBACK_MS } from "./CopyButton"

type TestRuntime = typeof import("./composer-a11y-test-runtime")

const runtimeDirectory = mkdtempSync(join(tmpdir(), "alpha-composer-a11y-"))
await build({
  configFile: false,
  logLevel: "silent",
  plugins: [appPlugin.at(-1)!],
  resolve: {
    alias: {
      "@opencode-ai/app": join(import.meta.dir, "composer-a11y-app-stub.ts"),
    },
  },
  build: {
    emptyOutDir: true,
    outDir: runtimeDirectory,
    lib: {
      entry: join(import.meta.dir, "composer-a11y-test-runtime.tsx"),
      formats: ["es"],
      fileName: () => "composer-a11y-test-runtime.js",
    },
    rollupOptions: { output: { inlineDynamicImports: true } },
  },
})

const disposers: Array<() => void> = []
GlobalRegistrator.register()
const runtime = (await import(
  pathToFileURL(join(runtimeDirectory, "composer-a11y-test-runtime.js")).href
)) as TestRuntime

beforeEach(() => {
  runtime.resetComposerA11yHarness()
  document.body.replaceChildren()
})

afterEach(async () => {
  disposers
    .splice(0)
    .reverse()
    .forEach((dispose) => dispose())
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

function keydown(target: Element, key: string) {
  const event = new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true })
  target.dispatchEvent(event)
  return event
}

function mount(component: () => unknown) {
  const host = document.createElement("div")
  document.body.append(host)
  disposers.push(runtime.render(component, host))
  return host
}

describe("composer accessibility behavior", () => {
  test("PermChip moves focus into its popover and Escape closes with trigger focus restored", async () => {
    mount(() => runtime.PermChipHarness())
    const trigger = document.querySelector<HTMLButtonElement>(".a-chip-perm")!

    trigger.click()
    await flush()

    const firstItem = document.querySelector<HTMLButtonElement>(".a-pop-item")!
    expect(trigger.getAttribute("aria-expanded")).toBe("true")
    expect(document.activeElement).toBe(firstItem)
    expect(document.querySelector(".a-pop-fixed[role='menu']")).not.toBeNull()
    // 三档:全部批准 / 请求审批 / 只读(`#1413`)。REQ-126 AC7(#658)退休过一个只在界面上存在的
    // 「全自动」档;这次的三档各自发出不同的请求,那条判据在 shell-commands.test.ts,这里只看可达性。
    expect(document.querySelectorAll(".a-pop-item[role='menuitemradio']")).toHaveLength(3)
    expect(document.querySelector(".a-pop-item.is-on[aria-checked='true']")).not.toBeNull()

    const escape = keydown(firstItem, "Escape")
    await flush()

    expect(escape.defaultPrevented).toBe(true)
    expect(document.querySelector(".a-pop-fixed")).toBeNull()
    expect(trigger.getAttribute("aria-expanded")).toBe("false")
    expect(document.activeElement).toBe(trigger)
  })

  test("PermChip outside-click close preserves focus on the user's click target", async () => {
    mount(() => runtime.PermChipHarness())
    const trigger = document.querySelector<HTMLButtonElement>(".a-chip-perm")!
    const textarea = document.createElement("textarea")
    document.body.append(textarea)

    trigger.click()
    await flush()
    expect(document.activeElement).toBe(document.querySelector(".a-pop-item"))

    textarea.focus()
    textarea.dispatchEvent(new MouseEvent("click", { bubbles: true }))
    await flush()

    expect(document.querySelector(".a-pop-fixed")).toBeNull()
    expect(document.activeElement).toBe(textarea)
    expect(document.activeElement).not.toBe(trigger)
  })

  // combobox(textarea ↔ autocomplete Menu)的证据不在本文件:harness 自建 textarea 会复刻一份
  // 绑定,生产绑定被删掉照样绿(C21 R3 F9)。那条断言真实挂载生产 `AlphaComposerRuntime`,见
  // test-component/alpha-composer-model.cases.ts 的「AlphaComposer 生产 combobox 无障碍绑定」。
})

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

function keyOn(target: Element, key: string) {
  const event = new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true })
  target.dispatchEvent(event)
  return event
}

function describedText(el: Element | null | undefined): string {
  const ids = el?.getAttribute("aria-describedby")?.split(/\s+/).filter(Boolean) ?? []
  return ids.map((id) => document.getElementById(id)?.textContent ?? "").join(" ")
}

// ── REQ-230 AC1(#1476):菜单的一套键盘与开关规则 ─────────────────────────────────
describe("REQ-230 AC1 menu keyboard and close rules", () => {
  test("menuMoveIndex: ↑↓ wrap, Home/End jump, modifiers and IME pass through", () => {
    const k = (key: string, extra: Partial<KeyboardEvent> = {}) =>
      ({
        key,
        isComposing: false,
        ctrlKey: false,
        altKey: false,
        metaKey: false,
        shiftKey: false,
        ...extra,
      }) as KeyboardEvent
    expect(menuMoveIndex(k("ArrowDown"), 3, -1)).toBe(0)
    expect(menuMoveIndex(k("ArrowDown"), 3, 2)).toBe(0)
    expect(menuMoveIndex(k("ArrowUp"), 3, 0)).toBe(2)
    expect(menuMoveIndex(k("ArrowUp"), 3, -1)).toBe(2)
    expect(menuMoveIndex(k("Home"), 3, 2)).toBe(0)
    expect(menuMoveIndex(k("End"), 3, 0)).toBe(2)
    expect(menuMoveIndex(k("Tab"), 3, 0)).toBeUndefined()
    expect(menuMoveIndex(k("ArrowDown", { metaKey: true }), 3, 0)).toBeUndefined()
    expect(menuMoveIndex(k("ArrowDown", { isComposing: true }), 3, 0)).toBeUndefined()
    expect(menuMoveIndex(k("ArrowDown"), 0, -1)).toBeUndefined()
  })

  test("PermChip: ↑↓ / Home / End move focus between menu items", async () => {
    mount(() => runtime.PermChipHarness())
    document.querySelector<HTMLButtonElement>(".a-chip-perm")!.click()
    await flush()
    const items = [...document.querySelectorAll<HTMLButtonElement>(".a-pop-fixed .a-pop-item")]
    expect(items).toHaveLength(3)
    expect(document.activeElement).toBe(items[0])

    expect(keyOn(items[0]!, "ArrowDown").defaultPrevented).toBe(true)
    expect(document.activeElement).toBe(items[1])
    keyOn(items[1]!, "ArrowDown")
    keyOn(items[2]!, "ArrowDown")
    expect(document.activeElement, "↓ 在最后一项应回到第一项").toBe(items[0])
    keyOn(items[0]!, "ArrowUp")
    expect(document.activeElement, "↑ 在第一项应到最后一项").toBe(items[2])
    keyOn(items[2]!, "Home")
    expect(document.activeElement).toBe(items[0])
    keyOn(items[0]!, "End")
    expect(document.activeElement).toBe(items[2])
  })

  test("PermChip: Escape closes even when focus is outside the menu, and returns focus to the trigger", async () => {
    mount(() => runtime.PermChipHarness())
    const trigger = document.querySelector<HTMLButtonElement>(".a-chip-perm")!
    const textarea = document.createElement("textarea")
    document.body.append(textarea)
    trigger.click()
    await flush()
    expect(document.querySelector(".a-pop-fixed")).not.toBeNull()

    textarea.focus()
    const escape = keyOn(textarea, "Escape")
    await flush()

    expect(escape.defaultPrevented).toBe(true)
    expect(document.querySelector(".a-pop-fixed")).toBeNull()
    expect(trigger.getAttribute("aria-expanded")).toBe("false")
    expect(document.activeElement).toBe(trigger)
  })

  test("only one menu is open at a time: another menu claiming the slot closes the chip", async () => {
    mount(() => runtime.PermChipHarness())
    document.querySelector<HTMLButtonElement>(".a-chip-perm")!.click()
    await flush()
    expect(document.querySelector(".a-pop-fixed")).not.toBeNull()

    let otherClosed = 0
    const other = Symbol("other-menu")
    runtime.claimOverlay(other, () => otherClosed++)
    await flush()
    expect(document.querySelector(".a-pop-fixed"), "另一个菜单打开时芯片浮层仍开着").toBeNull()

    // 反过来:芯片再开,先把占着位置的那个关掉。
    document.querySelector<HTMLButtonElement>(".a-chip-perm")!.click()
    await flush()
    expect(otherClosed).toBe(1)
    expect(document.querySelector(".a-pop-fixed")).not.toBeNull()
  })

  test("the chip menu follows its trigger when the window is resized", async () => {
    mount(() => runtime.PermChipHarness())
    const trigger = document.querySelector<HTMLButtonElement>(".a-chip-perm")!
    let top = 600
    trigger.getBoundingClientRect = () =>
      ({ top, left: 40, right: 140, bottom: top + 24, width: 100, height: 24, x: 40, y: top, toJSON() {} }) as DOMRect
    trigger.click()
    await flush()
    const pop = document.querySelector<HTMLElement>(".a-pop-fixed")!
    const before = pop.style.bottom
    top = 300
    window.dispatchEvent(new Event("resize"))
    await flush()
    expect(pop.style.bottom).not.toBe(before)
    expect(pop.style.bottom).toBe(`${Math.round(window.innerHeight - 300 + 8)}px`)
  })

  test("menu container: medium shadow and z token; .a-pop-note defined exactly once", () => {
    const css = (name: string) => readFileSync(join(import.meta.dir, name), "utf8")
    const pop = css("home.css").match(/\n\.a-pop \{[^}]*\}/)?.[0] ?? ""
    expect(pop).toContain("box-shadow: var(--a-shadow-md)")
    expect(pop).toContain("z-index: var(--a-z-dropdown)")
    expect(pop).not.toContain("--a-shadow-overlay")
    const defs = readdirSync(import.meta.dir)
      .filter((file) => file.endsWith(".css"))
      .flatMap((file) => css(file).match(/^\.a-pop-note \{/gm) ?? [])
    expect(defs).toHaveLength(1)
    // 全局横幅在对话框下面一层。
    expect(css("banner.css")).toContain("z-index: calc(var(--a-z-modal) - 1)")
  })
})

// ── REQ-230 AC3:通知 ────────────────────────────────────────────────────────────
describe("REQ-230 AC3 toasts", () => {
  afterEach(() => {
    for (const node of document.querySelectorAll(".a-toast-x")) (node as HTMLButtonElement).click()
  })

  test("default duration is 4 seconds; a normal toast is polite and not persistent", async () => {
    expect(TOAST_DURATION_MS).toBe(4000)
    mount(() => runtime.ToastHarness())
    runtime.pushToast({ title: "已切换模型" })
    await flush()
    const toast = document.querySelector(".a-toast")!
    expect(toast.getAttribute("role")).toBe("status")
    expect(toast.getAttribute("aria-live")).toBe("polite")
    expect(toast.getAttribute("data-persistent")).toBeNull()
  })

  test("a normal toast auto-dismisses, but hovering pauses the countdown", async () => {
    mount(() => runtime.ToastHarness())
    runtime.pushToast({ title: "短命", duration: 80 })
    await flush()
    const toast = document.querySelector<HTMLElement>(".a-toast")!
    toast.dispatchEvent(new MouseEvent("mouseenter"))
    await sleep(160)
    expect(document.querySelector(".a-toast"), "悬停时通知自己消失了").not.toBeNull()
    toast.dispatchEvent(new MouseEvent("mouseleave"))
    await sleep(160)
    expect(document.querySelector(".a-toast"), "离开后没有接着倒计时").toBeNull()
  })

  test("error toasts stay until closed and are announced assertively", async () => {
    mount(() => runtime.ToastHarness())
    runtime.pushToast({ kind: "error", title: "发送失败", detail: "网络断开", duration: 50 })
    await flush()
    const toast = document.querySelector<HTMLElement>(".a-toast")!
    expect(toast.getAttribute("role")).toBe("alert")
    expect(toast.getAttribute("aria-live")).toBe("assertive")
    expect(toast.getAttribute("data-persistent")).toBe("true")
    await sleep(150)
    expect(document.querySelector(".a-toast"), "出错通知自己消失了").not.toBeNull()
    toast.querySelector<HTMLButtonElement>(".a-toast-x")!.click()
    await flush()
    expect(document.querySelector(".a-toast")).toBeNull()
  })
})

// ── REQ-230 AC2:提示 ────────────────────────────────────────────────────────────
describe("REQ-230 AC2 tooltip", () => {
  test("keyboard focus shows the tooltip after the delay; blur and Escape hide it", async () => {
    expect(TOOLTIP_DELAY_MS).toBe(400)
    mount(() => runtime.TooltipHarness())
    const button = document.querySelector<HTMLButtonElement>(".tip-button")!
    expect(button.getAttribute("title")).toBeNull()
    expect(describedText(button)).toBe("发送")

    button.focus()
    await sleep(TOOLTIP_DELAY_MS / 2)
    expect(document.querySelector(".a-tip"), "提示不该立刻出现").toBeNull()
    await sleep(TOOLTIP_DELAY_MS)
    expect(document.querySelector(".a-tip")?.textContent).toBe("发送")

    keyOn(button, "Escape")
    await flush()
    expect(document.querySelector(".a-tip")).toBeNull()

    button.blur()
    button.focus()
    await sleep(TOOLTIP_DELAY_MS + 100)
    expect(document.querySelector(".a-tip")).not.toBeNull()
    button.blur()
    await flush()
    expect(document.querySelector(".a-tip")).toBeNull()
  })

  test("a non-focusable trigger is made keyboard-reachable", async () => {
    mount(() => runtime.TooltipHarness())
    const span = document.querySelector<HTMLElement>(".tip-span")!
    expect(span.tabIndex).toBe(0)
    expect(describedText(span)).toBe("缓存命中 75%")
    span.focus()
    await sleep(TOOLTIP_DELAY_MS + 100)
    expect(document.querySelector(".a-tip")?.textContent).toBe("缓存命中 75%")
    span.blur()
  })

  test("copy button: 24px class, shows 已复制 after a successful copy, then resets", async () => {
    const writes: string[] = []
    const original = Object.getOwnPropertyDescriptor(navigator, "clipboard")
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: { writeText: async (text: string) => void writes.push(text) },
    })
    try {
      mount(() => runtime.CopyButtonHarness({ text: "hello" }))
      const button = document.querySelector<HTMLButtonElement>(".a-copy-btn")!
      expect(button.getAttribute("title")).toBeNull()
      expect(button.getAttribute("aria-label")).toBe("复制消息")
      button.click()
      await flush()
      await flush()
      expect(writes).toEqual(["hello"])
      expect(button.getAttribute("data-copied")).toBe("true")
      expect(document.querySelector(".a-tip")?.textContent).toBe("已复制")
      expect(button.querySelector(".a-copy-live")?.textContent).toBe("已复制")
      await sleep(COPIED_FEEDBACK_MS + 150)
      expect(button.getAttribute("data-copied")).toBeNull()
    } finally {
      if (original) Object.defineProperty(navigator, "clipboard", original)
    }
  }, 5000)
})
