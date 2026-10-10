import { GlobalRegistrator } from "@happy-dom/global-registrator"
import { afterAll, afterEach, beforeEach, describe, expect, test } from "bun:test"
import appPlugin from "@opencode-ai/app/vite"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { pathToFileURL } from "node:url"
import { build } from "vite"
import type * as Runtime from "./composer-a11y-test-runtime"

type TestRuntime = typeof Runtime

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

  test("#1476 menu keyboard: ↑↓ move and wrap, Home/End jump, Enter selects", async () => {
    mount(() => runtime.PermChipHarness())
    const trigger = document.querySelector<HTMLButtonElement>(".a-chip-perm")!
    trigger.click()
    await flush()
    const items = [...document.querySelectorAll<HTMLButtonElement>(".a-pop-item")]
    expect(items).toHaveLength(3)
    expect(document.activeElement).toBe(items[0])

    expect(keydown(items[0]!, "ArrowDown").defaultPrevented).toBe(true)
    expect(document.activeElement).toBe(items[1])
    keydown(items[1]!, "ArrowDown")
    keydown(items[2]!, "ArrowDown")
    expect(document.activeElement).toBe(items[0]) // 环形
    keydown(items[0]!, "ArrowUp")
    expect(document.activeElement).toBe(items[2])
    keydown(items[2]!, "Home")
    expect(document.activeElement).toBe(items[0])
    keydown(items[0]!, "End")
    expect(document.activeElement).toBe(items[2])

    // 回车 = 原生 button 激活:选中「只读」并关闭菜单。
    items[2]!.click()
    await flush()
    expect(document.querySelector(".a-pop-fixed")).toBeNull()
    expect(trigger.getAttribute("data-mode")).toBe("readonly")
  })

  test("#1476 Escape closes the menu and restores trigger focus even when focus is outside it", async () => {
    mount(() => runtime.PermChipHarness())
    const trigger = document.querySelector<HTMLButtonElement>(".a-chip-perm")!
    const textarea = document.createElement("textarea")
    document.body.append(textarea)
    trigger.click()
    await flush()

    textarea.focus() // 焦点跑回输入框,菜单仍开着
    expect(document.querySelector(".a-pop-fixed")).not.toBeNull()
    const escape = keydown(textarea, "Escape")
    await flush()

    expect(escape.defaultPrevented).toBe(true)
    expect(document.querySelector(".a-pop-fixed")).toBeNull()
    expect(document.activeElement).toBe(trigger)
  })

  test("#1476 only one menu open at a time — across chips and across the + / @ list", async () => {
    mount(() => runtime.TwoChipsHarness())
    const a = document.querySelector<HTMLButtonElement>("[data-chip='a'] .a-chip-perm")!
    const b = document.querySelector<HTMLButtonElement>("[data-chip='b'] .a-chip-perm")!
    a.click()
    await flush()
    expect(a.getAttribute("aria-expanded")).toBe("true")
    b.click()
    await flush()
    expect(a.getAttribute("aria-expanded")).toBe("false")
    expect(b.getAttribute("aria-expanded")).toBe("true")
    expect(document.querySelectorAll(".a-pop-fixed")).toHaveLength(1)

    // 「+ / @」列表(另一个持有者)登记打开 ⇒ 芯片菜单让位。
    let listClosed = 0
    const list = {}
    runtime.claimOverlay(list, () => listClosed++)
    await flush()
    expect(document.querySelectorAll(".a-pop-fixed")).toHaveLength(0)
    expect(b.getAttribute("aria-expanded")).toBe("false")

    // 反过来:芯片打开 ⇒ 列表被关。
    a.click()
    await flush()
    expect(listClosed).toBe(1)
    expect(document.querySelectorAll(".a-pop-fixed")).toHaveLength(1)
  })

  test("#1476 the menu repositions when the window resizes", async () => {
    mount(() => runtime.PermChipHarness())
    const trigger = document.querySelector<HTMLButtonElement>(".a-chip-perm")!
    let top = 500
    trigger.getBoundingClientRect = () =>
      ({ top, bottom: top + 24, left: 40, right: 140, width: 100, height: 24, x: 40, y: top }) as DOMRect
    trigger.click()
    await flush()
    const pop = document.querySelector<HTMLElement>(".a-pop-fixed")!
    expect(pop.style.bottom).toBe(`${window.innerHeight - 500 + 8}px`)
    expect(pop.style.zIndex).toBe("var(--a-z-dropdown)")

    top = 300
    window.dispatchEvent(new Event("resize"))
    await flush()
    expect(pop.style.bottom).toBe(`${window.innerHeight - 300 + 8}px`)
  })

  test("#1476 sub-page Escape goes back one level before closing the menu", async () => {
    let closed = 0
    mount(() => runtime.SubPageHarness({ onClosed: () => closed++ }))
    await flush()
    await flush()
    const back = document.querySelector<HTMLButtonElement>(".a-mpa-back")!
    expect(document.activeElement).toBe(back) // 二级页滑入,焦点在「返回」

    // 进入自定义表单(第二级),Esc 退回供应商列表,菜单仍开着。
    document.querySelector<HTMLButtonElement>("[data-alpha-custom-endpoint-entry]")!.click()
    await flush()
    keydown(document.querySelector(".a-mpa input") ?? back, "Escape")
    await flush()
    expect(document.querySelector("[data-alpha-custom-endpoint-entry]")).not.toBeNull()
    expect(document.querySelector(".a-pop-fixed")).not.toBeNull()
    expect(closed).toBe(0)

    // 再 Esc:退出二级页,回到菜单本体 —— 仍不关整个菜单。
    keydown(document.querySelector(".a-mpa-back")!, "Escape")
    await flush()
    expect(document.querySelector(".a-mpa")).toBeNull()
    expect(document.querySelector(".a-pop-fixed")).not.toBeNull()
    expect(closed).toBe(0)

    // 第三次 Esc:关掉菜单。
    keydown(document.querySelector("[data-row='list']")!, "Escape")
    await flush()
    expect(document.querySelector(".a-pop-fixed")).toBeNull()
    expect(closed).toBe(1)
  })

  // combobox(textarea ↔ autocomplete Menu)的证据不在本文件:harness 自建 textarea 会复刻一份
  // 绑定,生产绑定被删掉照样绿(C21 R3 F9)。那条断言真实挂载生产 `AlphaComposerRuntime`,见
  // test-component/alpha-composer-model.cases.ts 的「AlphaComposer 生产 combobox 无障碍绑定」。
})

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

describe("#1476 toasts", () => {
  const pushed: number[] = []
  afterEach(() => pushed.splice(0).forEach((id) => runtime.dismissToast(id)))
  const toastByTitle = (title: string) =>
    [...document.querySelectorAll<HTMLElement>(".a-toast")].find((el) => el.querySelector("b")?.textContent === title)

  test("non-error toasts default to 4s, announce politely and auto-dismiss", async () => {
    expect(runtime.TOAST_DEFAULT_MS).toBe(4000)
    mount(() => runtime.ToastHarness())
    pushed.push(runtime.pushToast({ kind: "success", title: "已切换", duration: 60 }))
    await flush()
    const toast = toastByTitle("已切换")!
    expect(toast.getAttribute("role")).toBe("status")
    expect(toast.getAttribute("aria-live")).toBe("polite")
    expect(toast.hasAttribute("data-persistent")).toBe(false)
    await sleep(120)
    expect(toastByTitle("已切换")).toBeUndefined()
  })

  test("hovering pauses the countdown; leaving resumes it", async () => {
    mount(() => runtime.ToastHarness())
    pushed.push(runtime.pushToast({ title: "悬停", duration: 80 }))
    await flush()
    toastByTitle("悬停")!.dispatchEvent(new MouseEvent("mouseenter"))
    await sleep(160)
    expect(toastByTitle("悬停")).not.toBeUndefined()
    toastByTitle("悬停")!.dispatchEvent(new MouseEvent("mouseleave"))
    await sleep(160)
    expect(toastByTitle("悬停")).toBeUndefined()
  })

  test("error toasts persist until closed and are announced assertively", async () => {
    mount(() => runtime.ToastHarness())
    pushed.push(runtime.pushToast({ kind: "error", title: "发送失败", duration: 20 }))
    await flush()
    await sleep(80)
    const toast = toastByTitle("发送失败")!
    expect(toast).not.toBeUndefined()
    expect(toast.getAttribute("role")).toBe("alert")
    expect(toast.getAttribute("aria-live")).toBe("assertive")
    expect(toast.getAttribute("data-persistent")).toBe("true")
    toast.querySelector<HTMLButtonElement>(".a-toast-x")!.click()
    await flush()
    expect(toastByTitle("发送失败")).toBeUndefined()
  })
})

describe("#1476 tooltip", () => {
  test("keyboard focus reveals the tooltip after the delay and it is wired as the description", async () => {
    expect(runtime.TOOLTIP_DELAY_MS).toBe(400)
    mount(() => runtime.TooltipHarness())
    await flush()
    const trigger = document.querySelector<HTMLButtonElement>("[data-tip-trigger]")!
    expect(trigger.hasAttribute("title")).toBe(false)
    const describedBy = trigger.getAttribute("aria-describedby")!
    expect(document.getElementById(describedBy)!.textContent).toBe("缓存命中 82%")

    trigger.focus()
    trigger.dispatchEvent(new FocusEvent("focusin", { bubbles: true }))
    await sleep(100)
    expect(document.querySelector("[role='tooltip']")).toBeNull() // 0.4s 之前不出
    await sleep(400)
    expect(document.querySelector("[role='tooltip']")!.textContent).toBe("缓存命中 82%")

    keydown(trigger, "Escape")
    await flush()
    expect(document.querySelector("[role='tooltip']")).toBeNull()
  })

  test("pointer hover reveals it; leaving hides it", async () => {
    mount(() => runtime.TooltipHarness())
    const wrap = document.querySelector<HTMLElement>(".a-tip-wrap")!
    wrap.dispatchEvent(new PointerEvent("pointerenter"))
    await sleep(450)
    expect(document.querySelector("[role='tooltip']")).not.toBeNull()
    wrap.dispatchEvent(new PointerEvent("pointerleave"))
    await flush()
    expect(document.querySelector("[role='tooltip']")).toBeNull()
  })

  test("copy button shows 已复制 with a green check for 1.5s after a successful copy", async () => {
    const copied: string[] = []
    Object.defineProperty(window.navigator, "clipboard", {
      value: { writeText: (text: string) => (copied.push(text), Promise.resolve()) },
      configurable: true,
    })
    expect(runtime.COPIED_FEEDBACK_MS).toBe(1500)
    mount(() => runtime.CopyButtonHarness({ text: "答案" }))
    const button = document.querySelector<HTMLButtonElement>(".a-copy-btn")!
    expect(button.getAttribute("aria-label")).toBe("复制回复")
    button.click()
    await flush()
    await flush()
    expect(copied).toEqual(["答案"])
    expect(button.getAttribute("data-copied")).toBe("true")
    expect(document.querySelector("[role='tooltip']")!.textContent).toBe("已复制")
    expect(document.querySelector(".a-copy-btn + [role='status']")?.textContent ?? document.body.textContent).toContain("已复制")
    await sleep(1600)
    expect(button.hasAttribute("data-copied")).toBe(false)
    expect(document.querySelector("[role='tooltip']")).toBeNull()
  })
})
