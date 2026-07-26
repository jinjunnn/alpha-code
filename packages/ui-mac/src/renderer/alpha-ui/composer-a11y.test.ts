import { GlobalRegistrator } from "@happy-dom/global-registrator"
import { afterAll, afterEach, beforeEach, describe, expect, test } from "bun:test"
import appPlugin from "@opencode-ai/app/vite"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { pathToFileURL } from "node:url"
import { build } from "vite"
import type {
  AutocompleteHarness,
  PermChipHarness,
  render,
  resetComposerA11yHarness,
} from "./composer-a11y-test-runtime"

type TestRuntime = {
  render: typeof render
  PermChipHarness: typeof PermChipHarness
  AutocompleteHarness: typeof AutocompleteHarness
  resetComposerA11yHarness: typeof resetComposerA11yHarness
}

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

  // 这条测试同时是 roving-focus.test.ts 里 `CROSS_FILE_COMBOBOX_EXCEPTIONS` 的兑现证据:
  // composer-autocomplete.tsx 的 listbox 不走 roving tabIndex,而走 combobox 的
  // aria-activedescendant —— 属性挂在这一侧的 textarea 上,静态闸门读不到关联,所以关联由这里
  // 真实挂载后逐帧断言:活动 id 必须指向该 listbox 内一个 role="option" 且 aria-selected="true"
  // 的元素,键盘移动后仍然如此,关闭后属性消失。
  test("combobox expanded state and active descendant track ArrowDown and ArrowUp", async () => {
    mount(() => runtime.AutocompleteHarness())
    const textarea = document.querySelector<HTMLTextAreaElement>("textarea[role='combobox']")!
    textarea.setSelectionRange(1, 1)
    textarea.dispatchEvent(new InputEvent("input", { bubbles: true }))
    await flush()

    expect(textarea.getAttribute("aria-expanded")).toBe("true")
    const listbox = document.getElementById(textarea.getAttribute("aria-controls")!)!
    const initial = textarea.getAttribute("aria-activedescendant")!
    expect(listbox.getAttribute("role")).toBe("listbox")
    const activeOption = document.getElementById(initial)!
    expect({
      role: activeOption.getAttribute("role"),
      selected: activeOption.getAttribute("aria-selected"),
      insideListbox: listbox.contains(activeOption),
    }).toEqual({ role: "option", selected: "true", insideListbox: true })

    const two = Array.from(listbox.querySelectorAll<HTMLElement>("[role='option']")).find((option) =>
      option.textContent?.includes("/two"),
    )!
    const twoId = two.id

    keydown(textarea, "ArrowDown")
    await flush()
    const down = textarea.getAttribute("aria-activedescendant")!
    expect(down).not.toBe(initial)
    const downOption = document.getElementById(down)!
    expect({
      role: downOption.getAttribute("role"),
      selected: downOption.getAttribute("aria-selected"),
      insideListbox: listbox.contains(downOption),
    }).toEqual({ role: "option", selected: "true", insideListbox: true })

    keydown(textarea, "ArrowUp")
    await flush()
    expect(textarea.getAttribute("aria-activedescendant")).toBe(initial)

    textarea.value = "/two"
    textarea.setSelectionRange(4, 4)
    textarea.dispatchEvent(new InputEvent("input", { bubbles: true }))
    await flush()
    expect(textarea.getAttribute("aria-activedescendant")).toBe(twoId)
    expect(document.getElementById(twoId)?.textContent).toContain("/two")

    keydown(textarea, "Escape")
    await flush()
    expect(textarea.getAttribute("aria-expanded")).toBe("false")
    expect(textarea.hasAttribute("aria-activedescendant")).toBe(false)
  })
})
