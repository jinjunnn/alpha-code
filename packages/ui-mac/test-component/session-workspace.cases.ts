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
  name: "session-workspace-component-test",
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

const runtime = await import("../src/renderer/alpha-ui/session-workspace/session-workspace-test-runtime")
const terminalPanelModule = await import("../src/renderer/alpha-ui/session-rail/terminal/terminal-rail-panel")
const disposers: Array<() => void> = []

beforeEach(() => {
  runtime.resetSessionWorkspaceSnapshot()
  localStorage.clear()
  document.body.replaceChildren()
})

afterEach(() => {
  // #905:崩溃探针是模块级全局信号,任一用例断言失败于复位前抛出都会漏到下一条用例。
  window.__alphaCrashProbe?.(null)
  disposers
    .splice(0)
    .reverse()
    .forEach((dispose) => dispose())
})

afterAll(() => GlobalRegistrator.unregister())

async function flush() {
  await Promise.resolve()
  await Promise.resolve()
}

function mount() {
  const host = document.createElement("div")
  document.body.append(host)
  disposers.push(solidWeb.render(() => runtime.SessionWorkspaceHarness(), host))
  return host
}

function mountQuestion() {
  const host = document.createElement("div")
  document.body.append(host)
  disposers.push(solidWeb.render(() => runtime.SessionQuestionHarness(), host))
  return host
}

function mountPartial(panels: Parameters<typeof runtime.SessionWorkspacePartialHarness>[0]["panels"]) {
  const host = document.createElement("div")
  document.body.append(host)
  disposers.push(solidWeb.render(() => runtime.SessionWorkspacePartialHarness({ panels }), host))
  return host
}

function pointer(type: string, clientX: number) {
  return new MouseEvent(type, { bubbles: true, cancelable: true, clientX })
}

describe("REQ-125 session workspace real Solid mount", () => {
  test("mounts one topbar with timeline, composer dock, and right-rail hosts", async () => {
    const host = mount()
    await flush()

    expect(host.querySelectorAll("[data-alpha-session-workspace]")).toHaveLength(1)
    expect(host.querySelectorAll("[data-alpha-session-workspace-topbar]")).toHaveLength(1)
    // #574 单一顶栏:会话工作区全 DOM 恰一个 header,且它就是拖拽条(topbar 标记落在
    // header 元素本身,session-workspace.css 以此承接 app-region: drag)。
    expect(document.querySelectorAll("header")).toHaveLength(1)
    expect(host.querySelector("header")!.hasAttribute("data-alpha-session-workspace-topbar")).toBe(true)
    expect(host.querySelector("[data-alpha-session-timeline-host]")).not.toBeNull()
    expect(host.querySelector("[data-alpha-session-composer-dock]")).not.toBeNull()
    expect(host.querySelector("[data-alpha-session-composer-host]")).not.toBeNull()
    // REQ-125 C7 直挂:composer 内容渲染在停靠位子树内(无 Portal 逃逸,body 下无游离节点)。
    const composerStub = host.querySelector("[data-alpha-session-composer-stub]")
    expect(composerStub).not.toBeNull()
    expect(composerStub!.closest("[data-alpha-session-composer-host]")).not.toBeNull()
    expect(document.querySelectorAll("[data-alpha-session-composer-stub]")).toHaveLength(1)
    expect(host.querySelector("[data-alpha-session-rail-host]")?.getAttribute("data-alpha-session-rail-panel")).toBe(
      "review",
    )
    expect(host.querySelector("[data-component]")).toBeNull()
  })

  test("terminal and rail controls only switch the placeholder host", async () => {
    const host = mount()
    await flush()
    const buttons = host.querySelectorAll<HTMLButtonElement>(".a-swk-panel-button")

    buttons[0]!.click()
    await flush()
    expect(buttons[0]!.getAttribute("aria-pressed")).toBe("true")
    expect(host.querySelector("[data-alpha-session-rail-panel='terminal']")).not.toBeNull()

    buttons[1]!.click()
    await flush()
    expect(host.querySelector("[data-alpha-session-rail-host]")).toBeNull()
    expect(buttons[1]!.getAttribute("aria-expanded")).toBe("false")

    buttons[1]!.click()
    await flush()
    expect(host.querySelector("[data-alpha-session-rail-panel='terminal']")).not.toBeNull()
  })

  test("terminal panel open/close hands focus through the channel (#554, upstream toggle semantics)", async () => {
    const host = mount()
    await flush()
    const buttons = host.querySelectorAll<HTMLButtonElement>(".a-swk-panel-button")

    // 初始(review 面板)不得触碰终端焦点。
    expect(runtime.terminalChannelCalls).toEqual([])

    // 终端面板从关到开:对当前激活实例发聚焦请求。
    buttons[0]!.click()
    await flush()
    expect(runtime.terminalChannelCalls).toEqual(["requestFocus:pty_1"])

    // 从开到关:撤销未消费的请求。
    buttons[0]!.click()
    await flush()
    expect(runtime.terminalChannelCalls).toEqual(["requestFocus:pty_1", "cancelFocus"])

    // 经右栏总开关重开(lastPanel = terminal):同样走请求端。
    buttons[1]!.click()
    await flush()
    expect(host.querySelector("[data-alpha-session-rail-panel='terminal']")).not.toBeNull()
    expect(runtime.terminalChannelCalls).toEqual(["requestFocus:pty_1", "cancelFocus", "requestFocus:pty_1"])
  })

  test("topbar status renders the approved idle and generating states", async () => {
    const host = mount()
    await flush()
    const status = () => host.querySelector<HTMLElement>("[data-alpha-session-status]")!

    expect(status().dataset.alphaSessionStatus).toBe("idle")
    expect(status().textContent).toContain("空闲")

    runtime.setSessionWorkspaceSnapshot({
      identity: {
        serverKey: "sidecar",
        directory: "/tmp/workspace",
        sessionID: "ses_running",
      },
      project: "workspace",
      title: "整理架构说明",
      activity: "running",
    })
    await flush()

    expect(status().dataset.alphaSessionStatus).toBe("running")
    expect(status().textContent).toContain("正在生成")
  })

  test("tabs fail closed while a lane has not landed its renderer; terminal has a built-in fallback", async () => {
    const host = mountPartial({ review: () => "review-only" })
    await flush()

    const tab = (kind: string) => host.querySelector<HTMLButtonElement>(`[data-alpha-session-rail-tab='${kind}']`)!
    expect(tab("review").disabled).toBe(false)
    expect(tab("files").disabled).toBe(true)
    expect(tab("artifacts").disabled).toBe(true)
    // Terminal is never a dead tab: the shell carries the built-in C550 panel as fallback.
    expect(tab("terminal").disabled).toBe(false)
    const topbarButtons = host.querySelectorAll<HTMLButtonElement>(".a-swk-panel-button")
    expect(topbarButtons[0]!.disabled).toBe(false)

    tab("artifacts").click()
    await flush()
    expect(host.querySelector("[data-alpha-session-rail-host]")?.getAttribute("data-alpha-session-rail-panel")).toBe(
      "review",
    )

    tab("terminal").click()
    await flush()
    const terminalHost = host.querySelector("[data-alpha-session-rail-panel-host='terminal']")
    expect(terminalHost).not.toBeNull()
    expect(terminalHost!.querySelector("[data-alpha-terminal-panel]")).not.toBeNull()
  })

  test("review badge and terminal dot follow the rail meta channels, fail-closed by default", async () => {
    const host = mount()
    await flush()
    const reviewTab = host.querySelector<HTMLButtonElement>("[data-alpha-session-rail-tab='review']")!
    const terminalTab = host.querySelector<HTMLButtonElement>("[data-alpha-session-rail-tab='terminal']")!

    expect(reviewTab.querySelector("[data-alpha-session-review-count]")).toBeNull()
    expect(terminalTab.querySelector("[data-alpha-session-terminal-dot]")).toBeNull()

    runtime.setSessionWorkspaceReviewCount(3)
    runtime.setSessionWorkspaceTerminalRunning(true)
    await flush()
    expect(reviewTab.querySelector("[data-alpha-session-review-count]")!.textContent).toBe("3")
    expect(terminalTab.querySelector("[data-alpha-session-terminal-dot]")).not.toBeNull()

    runtime.setSessionWorkspaceReviewCount(0)
    runtime.setSessionWorkspaceTerminalRunning(false)
    await flush()
    expect(reviewTab.querySelector("[data-alpha-session-review-count]")).toBeNull()
    expect(terminalTab.querySelector("[data-alpha-session-terminal-dot]")).toBeNull()
  })

  test("terminal dot aggregates the publisher registry; concurrent panels never clobber each other", async () => {
    // No railMeta at all — the shell must fall back to the panel-published projection.
    const host = mountPartial({ review: () => "review-only" })
    await flush()
    const dot = () =>
      host.querySelector("[data-alpha-session-rail-tab='terminal'] [data-alpha-session-terminal-dot]")
    expect(dot()).toBeNull()

    // Two real terminal panels publish concurrently (every renderer path mounts this same
    // component): A has a running instance, B is idle.
    const channelFor = (running: boolean) => ({
      identity: { serverKey: "sidecar", directory: "/tmp/workspace", sessionID: "ses_idle" },
      ready: () => true,
      instances: () => [{ id: "pty_1", title: "终端 1", running }],
      activeID: () => "pty_1",
      open() {},
      close() {},
      create() {},
      footStatus: () => ({ running }),
      EngineOutput: () => null,
    })
    const mountPanel = (running: boolean) => {
      const panelHost = document.createElement("div")
      document.body.append(panelHost)
      const dispose = solidWeb.render(
        () => terminalPanelModule.TerminalRailPanel({ channel: channelFor(running), accepts: () => true } as never),
        panelHost,
      )
      return () => {
        dispose()
        panelHost.remove()
      }
    }

    const disposeA = mountPanel(true)
    const disposeB = mountPanel(false)
    await flush()
    // A(true) + B(false) → any = true; B's later idle publish must not clobber A.
    expect(dot()).not.toBeNull()

    // Unregistering B (idle) changes nothing.
    disposeB()
    await flush()
    expect(dot()).not.toBeNull()

    // Unregistering A removes the only running entry — projection drops to false.
    disposeA()
    await flush()
    expect(dot()).toBeNull()
  })

  test("width grip drags within 320-560, remembers per panel, and persists", async () => {
    const host = mount()
    await flush()
    const rail = () => host.querySelector<HTMLElement>("[data-alpha-session-rail-host]")!
    const grip = () => host.querySelector<HTMLElement>(".a-swk-rail-grip")!
    expect(rail().style.width).toBe("400px")
    expect(grip().getAttribute("aria-valuenow")).toBe("400")

    grip().dispatchEvent(pointer("pointerdown", 1000))
    window.dispatchEvent(pointer("pointermove", 940))
    await flush()
    expect(rail().style.width).toBe("460px")
    window.dispatchEvent(pointer("pointermove", 200))
    await flush()
    expect(rail().style.width).toBe("560px")
    window.dispatchEvent(pointer("pointerup", 200))
    await flush()
    expect(JSON.parse(localStorage.getItem("alpha-session-rail-widths-v1")!)).toEqual({ review: 560 })

    // Per-panel memory: the files panel keeps its own width.
    host.querySelector<HTMLButtonElement>("[data-alpha-session-rail-tab='files']")!.click()
    await flush()
    expect(rail().style.width).toBe("400px")

    // Keyboard resize on the separator, clamped at the floor.
    grip().dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowRight", bubbles: true, cancelable: true }))
    await flush()
    expect(rail().style.width).toBe("384px")
    expect(JSON.parse(localStorage.getItem("alpha-session-rail-widths-v1")!)).toEqual({ review: 560, files: 384 })

    // Back to review: remembered width is restored.
    host.querySelector<HTMLButtonElement>("[data-alpha-session-rail-tab='review']")!.click()
    await flush()
    expect(rail().style.width).toBe("560px")
  })

  test("arrow keys move between enabled tabs only", async () => {
    const host = mount()
    await flush()
    const tab = (kind: string) => host.querySelector<HTMLButtonElement>(`[data-alpha-session-rail-tab='${kind}']`)!

    tab("review").dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowRight", bubbles: true, cancelable: true }))
    await flush()
    expect(tab("files").classList.contains("a-swk-rail-tab--on")).toBe(true)

    tab("files").dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowLeft", bubbles: true, cancelable: true }))
    await flush()
    expect(tab("review").classList.contains("a-swk-rail-tab--on")).toBe(true)

    tab("review").dispatchEvent(new KeyboardEvent("keydown", { key: "End", bubbles: true, cancelable: true }))
    await flush()
    expect(tab("artifacts").classList.contains("a-swk-rail-tab--on")).toBe(true)
  })

  test("C21 AC2: every question group carries its own name", async () => {
    const host = mountQuestion()
    await flush()

    const groups = [...host.querySelectorAll<HTMLElement>("[role='radiogroup']")]
    expect(groups).toHaveLength(2)
    // 两组选项标签一模一样(是 / 否)。组自己没有名字时,读屏进第二组只报「radio group, 是」,
    // 用户听不出在答哪道题 —— 名称必须来自可见的问题文本。
    const names = groups.map((group) => document.getElementById(group.getAttribute("aria-labelledby")!)?.textContent)
    expect(names).toEqual(["现在就发布吗?", "失败时自动回滚吗?"])

    // 多选组是 group/checkbox,不是 radiogroup;它同样带名字。
    const multiple = host.querySelectorAll<HTMLElement>(".a-swk-question-options[role='group']")
    expect(multiple).toHaveLength(1)
    expect(document.getElementById(multiple[0]!.getAttribute("aria-labelledby")!)?.textContent).toBe("包含哪些包?")
  })

  test("C21 AC2: a chosen radio cannot be un-chosen; arrows move the choice; multi-select still toggles", async () => {
    const host = mountQuestion()
    await flush()
    const key = (name: string) => new KeyboardEvent("keydown", { key: name, bubbles: true, cancelable: true })
    const group = (index: number) => [...host.querySelectorAll<HTMLElement>(".a-swk-question-options")][index]!
    const radios = (index: number) => [...group(index).querySelectorAll<HTMLButtonElement>("button")]
    const checked = (index: number) =>
      radios(index)
        .filter((button) => button.getAttribute("aria-checked") === "true")
        .map((button) => button.textContent)

    // 未答时:组内仍只有一个 Tab 落点(首项),但一个都没选中。
    expect(checked(0)).toEqual([])
    // 比 textContent 而不是元素:元素数组不等时深比对会打印整棵 happy-dom 树。
    const tabbable = (index: number) =>
      radios(index)
        .filter((button) => button.tabIndex === 0)
        .map((button) => button.textContent)
    expect(tabbable(0)).toEqual(["是"])

    radios(0)[0]!.click()
    await flush()
    expect(checked(0)).toEqual(["是"])

    // APG:已选 radio 上的 Space 什么都不做。原生 button 把 Space/Enter 转成 click,
    // 所以这里的第二次 click 就是键盘上的那一下 —— 它不得把整组清空成「无答案」。
    radios(0)[0]!.click()
    await flush()
    expect(checked(0)).toEqual(["是"])

    // 移动即选中,焦点跟着走,Tab 落点始终只有一个。
    radios(0)[0]!.focus()
    radios(0)[0]!.dispatchEvent(key("ArrowDown"))
    await flush()
    expect(checked(0)).toEqual(["否"])
    expect(document.activeElement).toBe(radios(0)[1])
    expect(tabbable(0)).toEqual(["否"])

    // 第二组独立:第一组的作答不外溢。
    expect(checked(1)).toEqual([])

    // 多选组仍是 checkbox 语义:再点取消,且每个 checkbox 各自留在 Tab 序列里。
    radios(2)[0]!.click()
    radios(2)[1]!.click()
    await flush()
    expect(checked(2)).toEqual(["界面", "内核"])
    radios(2)[0]!.click()
    await flush()
    expect(checked(2)).toEqual(["内核"])
    expect(radios(2).every((button) => button.tabIndex === 0)).toBe(true)
  })

  test("C21 AC2: the rail tablist roves on ←→ and keeps one Tab landing point", async () => {
    const host = mount()
    await flush()
    const tab = (kind: string) => host.querySelector<HTMLButtonElement>(`[data-alpha-session-rail-tab='${kind}']`)!
    const key = (name: string, init: KeyboardEventInit = {}) =>
      new KeyboardEvent("keydown", { key: name, bubbles: true, cancelable: true, ...init })

    // 页签条是横排 flex(.a-swk-rail-tabs),所以键表就是 W3C 横向 tablist 的那张:←→ + Home/End。
    tab("review").dispatchEvent(key("ArrowRight"))
    await flush()
    expect(tab("files").classList.contains("a-swk-rail-tab--on")).toBe(true)
    expect(document.activeElement).toBe(tab("files"))

    tab("files").dispatchEvent(key("ArrowLeft"))
    await flush()
    expect(tab("review").classList.contains("a-swk-rail-tab--on")).toBe(true)

    // ↑↓ 属于纵向 tablist。横排页签条吞掉它就是把页面滚动抢走 —— 必须原样交还。
    const down = key("ArrowDown")
    tab("review").dispatchEvent(down)
    await flush()
    expect(down.defaultPrevented).toBe(false)
    expect(tab("review").classList.contains("a-swk-rail-tab--on")).toBe(true)

    // 带修饰键的方向键归系统(Cmd+→ 导航、VoiceOver 光标是 Ctrl+Option+方向键)。
    const vo = key("ArrowRight", { ctrlKey: true, altKey: true })
    tab("review").dispatchEvent(vo)
    await flush()
    expect(vo.defaultPrevented).toBe(false)
    expect(tab("review").classList.contains("a-swk-rail-tab--on")).toBe(true)

    // 整条页签条在 Tab 序列里只占一个落点(禁用页签也不例外)。
    const tabs = [...host.querySelectorAll<HTMLButtonElement>("[data-alpha-session-rail-tab]")]
    const landing = tabs
      .filter((element) => element.tabIndex === 0)
      .map((element) => element.dataset.alphaSessionRailTab)
    expect(landing).toEqual(["review"])
    expect(tabs.filter((element) => element.tabIndex === -1)).toHaveLength(tabs.length - 1)

    // 非导航键原样放行:页签条不得吞掉 Escape / Tab。
    const escape = key("Escape")
    tab("review").dispatchEvent(escape)
    await flush()
    expect(escape.defaultPrevented).toBe(false)
    expect(tab("review").classList.contains("a-swk-rail-tab--on")).toBe(true)
  })

  // #905:一个右栏面板渲染期抛错,只能降级它自己的区域 —— composer(含未发送草稿)与时间线
  // 骨架必须原样留在 DOM 里,失败区域要给出可点击的重载动作。把 session-workspace-shell.tsx
  // 的分区边界改回单一整页边界(或彻底移除)时,这条用例必崩:探针触发的 throw 不再被任何
  // ErrorBoundary 拦下,会直接从 window.__alphaCrashProbe(...) 同步抛出,整条用例转红。
  test("#905 a crashing rail panel degrades only that region — composer and timeline survive, reload action appears", async () => {
    const host = mount()
    await flush()

    const composerStub = () => host.querySelector("[data-alpha-session-composer-stub]")
    const timelineHost = () => host.querySelector("[data-alpha-session-timeline-host]")
    const topbar = () => host.querySelector("[data-alpha-session-workspace-topbar]")
    const composerBefore = composerStub()
    const timelineBefore = timelineHost()
    expect(composerBefore).not.toBeNull()
    expect(timelineBefore).not.toBeNull()

    // Default lane is "review" and it is already mounted — crash it in place.
    window.__alphaCrashProbe?.("SessionPanelReview")
    await flush()

    // Composer, its (stub) draft node, timeline host, and topbar are the *same* DOM nodes —
    // proof the workspace never unmounted/remounted, unlike the old single full-page boundary.
    expect(composerStub()).toBe(composerBefore)
    expect(timelineHost()).toBe(timelineBefore)
    expect(topbar()).not.toBeNull()

    // The failed region itself shows a local reload action, scoped to that panel's host.
    const reviewPanelHost = host.querySelector("[data-alpha-session-rail-panel-host='review']")!
    expect(reviewPanelHost.querySelector("[data-harness-panel='review']")).toBeNull()
    const reloadButton = reviewPanelHost.querySelector<HTMLButtonElement>(".a-boundary-btn")
    expect(reloadButton).not.toBeNull()

    // Reload action recovers the region without touching the rest of the workspace. Clear the
    // probe first — same discipline as the CDP recipe in alpha-boundary.tsx's own header comment
    // (probe null, then click) — otherwise the remount would crash again on the same throw.
    window.__alphaCrashProbe?.(null)
    reloadButton!.click()
    await flush()
    expect(reviewPanelHost.querySelector("[data-harness-panel='review']")).not.toBeNull()
    expect(composerStub()).toBe(composerBefore)
  })
})
