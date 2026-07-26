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
const key = (name: string, init: KeyboardEventInit = {}) =>
  new KeyboardEvent("keydown", { key: name, bubbles: true, cancelable: true, ...init })

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

  test("C21 AC2: the tablist honours ←→/Home/End and keeps one Tab landing point", async () => {
    const host = mount(() => runtime.TerminalRailHarness())
    await flush()

    // roving tabIndex:整条页签条在 Tab 序列里只占一个落点 —— 激活页签。
    expect(tabButton(host, "pty_1")?.tabIndex).toBe(0)
    expect(tabButton(host, "pty_2")?.tabIndex).toBe(-1)

    tabButton(host, "pty_1")!.focus()
    tabButton(host, "pty_1")!.dispatchEvent(key("ArrowRight"))
    await flush()

    // 移动即激活:与点击同一条通道,且 DOM 焦点跟到新页签。
    expect(runtime.channelCalls).toContain("open:pty_2")
    expect(tabButton(host, "pty_2")?.getAttribute("aria-selected")).toBe("true")
    expect(document.activeElement).toBe(tabButton(host, "pty_2"))
    expect(tabButton(host, "pty_2")?.tabIndex).toBe(0)
    expect(tabButton(host, "pty_1")?.tabIndex).toBe(-1)

    // 环形移动 + Home/End 直达两端。
    tabButton(host, "pty_2")!.dispatchEvent(key("ArrowRight"))
    await flush()
    expect(tabButton(host, "pty_1")?.getAttribute("aria-selected")).toBe("true")

    tabButton(host, "pty_1")!.dispatchEvent(key("End"))
    await flush()
    expect(tabButton(host, "pty_2")?.getAttribute("aria-selected")).toBe("true")

    // 横排 tablist 不认 ↑↓(那是纵向 tablist 的键),也不认带修饰键的方向键。
    for (const ignored of [key("ArrowDown"), key("ArrowUp"), key("ArrowLeft", { metaKey: true })]) {
      tabButton(host, "pty_2")!.dispatchEvent(ignored)
      await flush()
      expect(ignored.defaultPrevented).toBe(false)
      expect(tabButton(host, "pty_2")?.getAttribute("aria-selected")).toBe("true")
    }

    // 非导航键不被页签条吞掉(Tab/Escape 仍归外层)。
    const escape = key("Escape")
    tabButton(host, "pty_2")!.dispatchEvent(escape)
    await flush()
    expect(escape.defaultPrevented).toBe(false)
    expect(tabButton(host, "pty_2")?.getAttribute("aria-selected")).toBe("true")
  })

  test("C21 AC2: the new-terminal button sits outside the tablist, the close button leaves the Tab sequence, and closing hands focus to a survivor", async () => {
    const host = mount(() => runtime.TerminalRailHarness())
    await flush()

    // 新建按钮不是页签,已移出 role="tablist"。关闭按钮仍在页签子树内 —— 那是 APG 可删除页签的
    // 形态(tab 是 tablist 的 required-owned,不是「只能拥有」):它退出 Tab 序列,键盘入口是
    // 页签上的 Delete。所以这里断言的是「新建按钮在外」,不是「tablist 子树里只有 tab」。
    const tablist = host.querySelector<HTMLElement>("[role='tablist']")!
    expect(tablist.querySelector("[data-alpha-terminal-new]")).toBeNull()
    expect(host.querySelector("[data-alpha-terminal-new]")).not.toBeNull()

    // 关闭按钮退出 Tab 序列:N 个实例不得产生 N+1 个停靠点。
    // 断言比的是 id 而不是元素本身:元素数组一旦不等,深比对要打印整棵 happy-dom 树。
    const stops = [...host.querySelectorAll<HTMLElement>("[role='tablist'] button")]
      .filter((element) => element.tabIndex === 0)
      .map((element) => element.id || element.className)
    expect(stops).toEqual([tabButton(host, "pty_1")!.id])
    expect(host.querySelector<HTMLElement>("[data-alpha-terminal-close='pty_1']")?.tabIndex).toBe(-1)

    // 键盘关闭走页签上的 Delete(APG 可删除页签的键),焦点交给存活的相邻页签 ——
    // 被删元素带着焦点消失会把焦点丢回 <body>,键盘用户得从头 Tab 回来。
    tabButton(host, "pty_1")!.focus()
    const del = key("Delete")
    tabButton(host, "pty_1")!.dispatchEvent(del)
    await flush()
    expect(del.defaultPrevented).toBe(true)
    expect(runtime.channelCalls).toContain("close:pty_1")
    expect(tab(host, "pty_1")).toBeNull()
    expect(document.activeElement).toBe(tabButton(host, "pty_2"))

    // 关掉最后一个实例:面板落到空态,焦点交给空态的「新建」按钮,不掉回 body。
    const last = key("Delete")
    tabButton(host, "pty_2")!.dispatchEvent(last)
    await flush()
    expect(host.querySelector("[data-alpha-terminal-empty]")).not.toBeNull()
    expect(document.activeElement).toBe(host.querySelector("[data-alpha-terminal-new]"))
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

  test("switching tabs hands focus through the channel: request precedes open, output consumes it (#554)", async () => {
    const host = mount(() => runtime.TerminalRailHarness())
    await flush()
    // 初始挂载无未消费请求:不得凭空聚焦。
    expect(runtime.channelCalls).toEqual([])
    expect(
      host
        .querySelector("[data-alpha-terminal-engine-output='pty_1']")
        ?.getAttribute("data-alpha-terminal-focus-consumed"),
    ).toBeNull()

    tabButton(host, "pty_2")!.click()
    await flush()

    // 请求端先于切激活发出(上游页签语义),随 keyed 重挂被引擎输出一次性消费。
    const requestAt = runtime.channelCalls.indexOf("requestFocus:pty_2")
    expect(requestAt).toBeGreaterThanOrEqual(0)
    expect(requestAt).toBeLessThan(runtime.channelCalls.indexOf("open:pty_2"))
    expect(runtime.channelCalls).toContain("focusConsumed:pty_2")
    expect(
      host
        .querySelector("[data-alpha-terminal-engine-output='pty_2']")
        ?.getAttribute("data-alpha-terminal-focus-consumed"),
    ).toBe("true")
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

  test("same-directory session switch rejects the stale channel until re-projection (I8)", async () => {
    const host = mount(() => runtime.TerminalRailHarness())
    await flush()
    expect(host.querySelectorAll("[data-alpha-terminal-tab]")).toHaveLength(2)

    // 同 workspace(serverKey+directory 不变)切到另一会话:旧 channel 身份不再被 live.accepts
    // 接受 → 面板即刻按 channel 缺席处理(空态 + 新建禁用),旧投影不得继续渲染。
    runtime.setTerminalLiveSession("ses_b")
    await flush()
    expect(host.querySelector("[data-alpha-terminal-empty]")).not.toBeNull()
    expect(host.querySelector("[role='tablist']")).toBeNull()
    expect(host.querySelector("[data-alpha-terminal-output]")).toBeNull()
    expect(host.querySelector("[data-alpha-terminal-engine-output='pty_1']")).toBeNull()
    expect(
      host.querySelector<HTMLButtonElement>("[data-alpha-terminal-empty] [data-alpha-terminal-new]")?.disabled,
    ).toBe(true)

    // 适配器按新会话身份重投影 → 面板恢复实例形态(workspace 级 PTY 状态共享)。
    runtime.projectTerminalChannel("ses_b")
    await flush()
    expect(host.querySelector("[data-alpha-terminal-empty]")).toBeNull()
    expect(host.querySelectorAll("[data-alpha-terminal-tab]")).toHaveLength(2)
    expect(
      host.querySelector("[data-alpha-terminal-output] [data-alpha-terminal-engine-output='pty_1']"),
    ).not.toBeNull()
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
