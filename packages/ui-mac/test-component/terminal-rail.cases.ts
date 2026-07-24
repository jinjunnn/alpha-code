import { transformAsync } from "@babel/core"
import presetTypescript from "@babel/preset-typescript"
import { GlobalRegistrator } from "@happy-dom/global-registrator"
import { afterAll, afterEach, beforeEach, describe, expect, mock, test } from "bun:test"
import presetSolid from "babel-preset-solid"

GlobalRegistrator.register()
const solid = await import("solid-js/dist/solid.js")
mock.module("solid-js", () => solid)
const solidWeb = await import("solid-js/web/dist/web.js")
mock.module("solid-js/web", () => solidWeb)

Bun.plugin({
  name: "terminal-rail-component-test",
  setup(builder) {
    builder.onLoad({ filter: /packages\/ui-mac\/src\/.*\.tsx$/ }, async (args) => {
      const transformed = await transformAsync(await Bun.file(args.path).text(), {
        filename: args.path,
        presets: [
          [presetSolid, { generate: "dom", hydratable: false }],
          [presetTypescript, { allExtensions: true, isTSX: true, onlyRemoveTypeImports: true }],
        ],
        sourceMaps: "inline",
      })
      return { contents: transformed?.code ?? "", loader: "js" }
    })
  },
})

const runtime = await import("../src/renderer/alpha-ui/session-rail/terminal/terminal-rail-test-runtime")
const disposers: Array<() => void> = []

beforeEach(() => {
  runtime.resetTerminalRailHarness()
  document.body.replaceChildren()
})

afterEach(() =>
  disposers
    .splice(0)
    .reverse()
    .forEach((dispose) => dispose()),
)

afterAll(() => GlobalRegistrator.unregister())

async function flush() {
  await Promise.resolve()
  await Promise.resolve()
}

function mount(component: () => unknown) {
  const host = document.createElement("div")
  document.body.append(host)
  disposers.push(solidWeb.render(() => component(), host))
  return host
}

const tab = (host: HTMLElement, id: string) => host.querySelector<HTMLElement>(`[data-alpha-terminal-tab="${id}"]`)
const tabButton = (host: HTMLElement, id: string) => tab(host, id)?.querySelector<HTMLButtonElement>("[role='tab']")

describe("REQ-125 terminal rail panel real Solid mount", () => {
  test("renders instance tabs, run indicators, engine output, and the foot from the channel", async () => {
    const host = mount(() => runtime.TerminalRailHarness())
    await flush()

    expect(host.querySelectorAll("[data-alpha-terminal-tab]")).toHaveLength(2)
    expect(tabButton(host, "pty_1")?.getAttribute("aria-selected")).toBe("true")
    expect(tabButton(host, "pty_2")?.getAttribute("aria-selected")).toBe("false")

    // 运行指示:仅在跑的实例带呼吸点;面板根暴露「任一在跑」供右栏 tab 层消费。
    expect(tab(host, "pty_1")?.querySelector(".a-term-rundot")).not.toBeNull()
    expect(tab(host, "pty_2")?.querySelector(".a-term-rundot")).toBeNull()
    expect(host.querySelector("[data-alpha-terminal-panel]")?.getAttribute("data-alpha-terminal-any-running")).toBe(
      "true",
    )

    // 引擎输出:激活实例挂进输出区外框;脚条 = 运行中 · zsh · 80×24。
    expect(
      host.querySelector("[data-alpha-terminal-output] [data-alpha-terminal-engine-output='pty_1']"),
    ).not.toBeNull()
    const foot = host.querySelector<HTMLElement>("[data-alpha-terminal-foot]")!
    expect(foot.querySelector("[data-alpha-terminal-foot-state]")?.getAttribute("data-alpha-terminal-foot-state")).toBe(
      "running",
    )
    expect(foot.textContent).toContain("运行中")
    expect(foot.textContent).toContain("zsh")
    expect(foot.textContent).toContain("80×24")

    // 运行结束 → 呼吸点与「任一在跑」一起消失(状态驱动,非一次性渲染)。
    runtime.setTerminalInstances([
      { id: "pty_1", title: "终端 1", running: false, foot: { running: false, shell: "zsh", cols: 80, rows: 24 } },
    ])
    await flush()
    expect(tab(host, "pty_1")?.querySelector(".a-term-rundot")).toBeNull()
    expect(
      host.querySelector("[data-alpha-terminal-panel]")?.getAttribute("data-alpha-terminal-any-running"),
    ).toBeNull()
  })

  test("switching tabs goes through the channel and remounts the engine output", async () => {
    const host = mount(() => runtime.TerminalRailHarness())
    await flush()

    tabButton(host, "pty_2")!.click()
    await flush()

    expect(runtime.channelCalls).toContain("open:pty_2")
    expect(tabButton(host, "pty_2")?.getAttribute("aria-selected")).toBe("true")
    expect(tabButton(host, "pty_1")?.getAttribute("aria-selected")).toBe("false")
    expect(
      host.querySelector("[data-alpha-terminal-output] [data-alpha-terminal-engine-output='pty_2']"),
    ).not.toBeNull()
    expect(host.querySelector("[data-alpha-terminal-engine-output='pty_1']")).toBeNull()
    expect(
      host
        .querySelector("[data-alpha-terminal-foot] [data-alpha-terminal-foot-state]")
        ?.getAttribute("data-alpha-terminal-foot-state"),
    ).toBe("idle")
  })

  test("create and close go through the channel and the active tab follows", async () => {
    const host = mount(() => runtime.TerminalRailHarness())
    await flush()

    host.querySelector<HTMLButtonElement>(".a-term-add")!.click()
    await flush()
    expect(runtime.channelCalls).toContain("create")
    expect(host.querySelectorAll("[data-alpha-terminal-tab]")).toHaveLength(3)
    expect(tabButton(host, "pty_3")?.getAttribute("aria-selected")).toBe("true")

    host.querySelector<HTMLButtonElement>("[data-alpha-terminal-close='pty_3']")!.click()
    await flush()
    expect(runtime.channelCalls).toContain("close:pty_3")
    expect(host.querySelectorAll("[data-alpha-terminal-tab]")).toHaveLength(2)
    expect(tabButton(host, "pty_1")?.getAttribute("aria-selected")).toBe("true")
    expect(
      host.querySelector("[data-alpha-terminal-output] [data-alpha-terminal-engine-output='pty_1']"),
    ).not.toBeNull()
  })

  test("stale activeID falls back to the first instance instead of a blank stage", async () => {
    runtime.setTerminalActiveID("pty_gone")
    const host = mount(() => runtime.TerminalRailHarness())
    await flush()

    expect(tabButton(host, "pty_1")?.getAttribute("aria-selected")).toBe("true")
    expect(
      host.querySelector("[data-alpha-terminal-output] [data-alpha-terminal-engine-output='pty_1']"),
    ).not.toBeNull()
  })

  test("no instances shows the approved empty state with a working create entry", async () => {
    runtime.setTerminalInstances([])
    runtime.setTerminalActiveID(undefined)
    const host = mount(() => runtime.TerminalRailHarness())
    await flush()

    expect(host.querySelector("[data-alpha-terminal-empty]")).not.toBeNull()
    expect(host.querySelector("[role='tablist']")).toBeNull()
    expect(host.querySelector("[data-alpha-terminal-empty]")?.textContent).toContain("还没有终端")

    const create = host.querySelector<HTMLButtonElement>("[data-alpha-terminal-empty] [data-alpha-terminal-new]")!
    expect(create.disabled).toBe(false)
    create.click()
    await flush()
    expect(runtime.channelCalls).toContain("create")
    expect(host.querySelectorAll("[data-alpha-terminal-tab]")).toHaveLength(1)
  })

  test("without an engine channel the panel fails closed to the empty state", async () => {
    const host = mount(() => runtime.TerminalRailHarnessWithoutEngine())
    await flush()

    expect(host.querySelector("[data-alpha-terminal-empty]")).not.toBeNull()
    expect(host.querySelector("[role='tablist']")).toBeNull()
    expect(host.querySelector("[data-alpha-terminal-output]")).toBeNull()
    expect(host.querySelector(".a-term-rundot")).toBeNull()
    expect(
      host.querySelector<HTMLButtonElement>("[data-alpha-terminal-empty] [data-alpha-terminal-new]")?.disabled,
    ).toBe(true)
  })

  test("a channel that is not ready is treated the same as absent (fail closed)", async () => {
    runtime.setTerminalChannelReady(false)
    const host = mount(() => runtime.TerminalRailHarness())
    await flush()

    expect(host.querySelector("[data-alpha-terminal-empty]")).not.toBeNull()
    expect(
      host.querySelector<HTMLButtonElement>("[data-alpha-terminal-empty] [data-alpha-terminal-new]")?.disabled,
    ).toBe(true)

    // 引擎就绪后无需重挂:同一面板切换到实例形态。
    runtime.setTerminalChannelReady(true)
    await flush()
    expect(host.querySelector("[data-alpha-terminal-empty]")).toBeNull()
    expect(host.querySelectorAll("[data-alpha-terminal-tab]")).toHaveLength(2)
  })
})
