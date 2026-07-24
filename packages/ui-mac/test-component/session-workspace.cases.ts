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
const claim = await import("../src/renderer/alpha-ui/session-workspace/session-approval-claim")
const disposers: Array<() => void> = []

beforeEach(() => {
  runtime.resetSessionWorkspaceSnapshot()
  localStorage.clear()
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

function mount() {
  const host = document.createElement("div")
  document.body.append(host)
  disposers.push(solidWeb.render(() => runtime.SessionWorkspaceHarness(), host))
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

  test("approval claim hands over first-establish-then-yield: only a ready dock holds presentation", async () => {
    claim.resetSessionApprovalClaim()
    const [ready, setReady] = solid.createSignal(false)
    const [sessionID, setSessionID] = solid.createSignal<string | undefined>("ses_a")
    const dispose = solid.createRoot((dispose: () => void) => {
      claim.bindSessionApprovalClaim({ sessionID, ready })
      return dispose
    })
    await flush()

    // list 在途/失败期不夺权 —— watcher 保持可呈现,无「两边都不呈现」窗口。
    expect(claim.sessionApprovalDockClaimed("ses_a")).toBe(false)

    setReady(true)
    await flush()
    expect(claim.sessionApprovalDockClaimed("ses_a")).toBe(true)

    // 失去就绪(重连 refetch / 通道失败)同步让权。
    setReady(false)
    await flush()
    expect(claim.sessionApprovalDockClaimed("ses_a")).toBe(false)

    setReady(true)
    await flush()
    setSessionID("ses_b")
    await flush()
    expect(claim.sessionApprovalDockClaimed("ses_a")).toBe(false)
    expect(claim.sessionApprovalDockClaimed("ses_b")).toBe(true)

    dispose()
    await flush()
    expect(claim.sessionApprovalDockClaimed("ses_b")).toBe(false)
    claim.resetSessionApprovalClaim()
  })

  test("same-session competing claims resolve to exactly one presenter (token ownership)", async () => {
    claim.resetSessionApprovalClaim()
    const [readyA, setReadyA] = solid.createSignal(false)
    const [readyB, setReadyB] = solid.createSignal(false)
    const dispose = solid.createRoot((dispose: () => void) => {
      claim.bindSessionApprovalClaim({ sessionID: () => "ses_x", ready: readyA })
      claim.bindSessionApprovalClaim({ sessionID: () => "ses_x", ready: readyB })
      return dispose
    })
    await flush()
    expect(claim.sessionApprovalDockClaimed("ses_x")).toBe(false)

    setReadyA(true)
    await flush()
    expect(claim.sessionApprovalDockClaimed("ses_x")).toBe(true)

    // 同会话第二个竞争者就绪:仍恰一个呈现者(owner 判定见 session-approval-claim/host 测试)。
    setReadyB(true)
    await flush()
    expect(claim.sessionApprovalDockClaimed("ses_x")).toBe(true)

    // 先立者退出:它的(迟到)释放只对自己的 token 生效 —— B 仍持权,watcher 不得恢复呈现。
    setReadyA(false)
    await flush()
    expect(claim.sessionApprovalDockClaimed("ses_x")).toBe(true)

    setReadyB(false)
    await flush()
    expect(claim.sessionApprovalDockClaimed("ses_x")).toBe(false)

    dispose()
    claim.resetSessionApprovalClaim()
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
})
