import { GlobalRegistrator } from "@happy-dom/global-registrator"
import { afterAll, afterEach, beforeEach, describe, expect, test } from "bun:test"
import appPlugin from "@opencode-ai/app/vite"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { pathToFileURL } from "node:url"
import { build } from "vite"
import type { PermChipHarness, render, resetComposerA11yHarness } from "./composer-a11y-test-runtime"

type TestRuntime = {
  render: typeof render
  PermChipHarness: typeof PermChipHarness
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
    // 两档:询问 / 只读。第三档「全自动」随 REQ-126 AC7(#658)退休 —— 它从来没有真的自动
    // 放行过(提交层只对 readonly 分支),档位本身的判据在 shell-commands.test.ts。
    expect(document.querySelectorAll(".a-pop-item[role='menuitemradio']")).toHaveLength(2)
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
