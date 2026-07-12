// REQ-087 characterization seeds(交付物 4,种子而非全集)。
// 形态与 surface-seam-contract.test.ts 同款:冻结的 packages/app 无法在 bun test 直接 import
// (vite `?worker&url` 依赖),故以源码锚点先「锁住」legacy 行为面 —— 任何 re-freeze/重构若挪动
// 这些不变量,权威门在实现 REQ-088 之前先红掉。锚点变更 = 边界契约变更,须随 spike 报告修订。
//
// 明确标注 OPEN 的验收项见文件底部 test.todo —— 它们需要 live engine(真实 PTY/流式/权限流),
// 不在本 seed 范围内造假通过。
import { describe, expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import { join } from "node:path"
import { SURFACE_RELEASE_STATES } from "../../../shared/alpha-surfaces"

const APP = join(import.meta.dir, "../../../../../app")
const src = (p: string) => readFileSync(join(APP, "src", p), "utf8")

const appTsx = src("app.tsx")
const sessionPage = src("pages/session.tsx")
const sessionLayout = src("pages/session/session-layout.ts")
const terminalPanel = src("pages/session/terminal-panel.tsx")
const sessionCommands = src("pages/session/use-session-commands.tsx")
const layoutPage = src("pages/layout.tsx")
const layoutCtx = src("context/layout.tsx")
const terminalCtx = src("context/terminal.tsx")
const commandCtx = src("context/command.tsx")
const timeline = src("pages/session/timeline/message-timeline.tsx")

describe("REQ-087 §1 persist keys(迁移 = 破坏用户状态,先锁死)", () => {
  test("layout context 全局键 layout / layout.v6", () => {
    expect(layoutCtx).toContain(`Persist.serverGlobal(serverSdk().scope, "layout", ["layout.v6"])`)
  })
  test("layout 页面键 layout.page / layout.page.v1", () => {
    expect(layoutPage).toContain(`Persist.serverGlobal(serverSDK().scope, "layout.page", ["layout.page.v1"])`)
  })
  test("session followup 键(workspace 级)", () => {
    expect(sessionPage).toContain(
      `Persist.serverWorkspace(serverSDK().scope, sdk().directory, "followup", ["followup.v1"])`,
    )
  })
  test("terminal 键(workspace 级)", () => {
    expect(terminalCtx).toContain(`Persist.serverWorkspace(scope, dir, "terminal", legacy)`)
  })
  test("session 级状态键三元组 prompt/terminal/file-view(layout prune 时被一并清理)", () => {
    expect(layoutCtx).toContain(`{ key: "prompt", legacy: "prompt", version: "v2" }`)
    expect(layoutCtx).toContain(`{ key: "terminal", legacy: "terminal", version: "v1" }`)
    expect(layoutCtx).toContain(`{ key: "file-view", legacy: "file", version: "v1" }`)
  })
  test("命令目录键 command.catalog.v1", () => {
    expect(commandCtx).toContain(`Persist.global("command.catalog.v1")`)
  })
})

describe("REQ-087 §2 route→layout 绑定(session-layout.ts 是 Layout 与 Session 的耦合点)", () => {
  test("sessionKey 由 route params + server scope 拼合", () => {
    expect(sessionLayout).toContain(
      `SessionStateKey.from(scope(), SessionRouteKey.fromRoute(params.dir, params.id))`,
    )
    expect(sessionLayout).toContain(`SessionStateKey.from(scope(), SessionRouteKey.fromRoute(params.dir))`)
  })
  test("tabs/view 是 layout context 按 sessionKey 的切片 —— adapter 不得复制该状态", () => {
    expect(sessionLayout).toContain(`tabs: createMemo(() => layout.tabs(sessionKey))`)
    expect(sessionLayout).toContain(`view: createMemo(() => layout.view(sessionKey))`)
  })
  test("session 路由形状 /:dir/session/:id? + 叶包在 SessionProviders", () => {
    expect(appTsx).toContain(`<Route path="/session/:id?" component={SessionRoute} />`)
    expect(appTsx).toMatch(/<SessionProviders>\s*<Leaf \/>\s*<\/SessionProviders>/)
  })
  test("surface override 与默认叶 XOR(单挂载的结构保证)", () => {
    expect(appTsx).toContain(`createSessionRoute(props.surfaces?.session ?? Session)`)
  })
})

describe("REQ-087 §3 terminal panel 依赖形状", () => {
  test("依赖面:useLayout + useTerminal + useSessionLayout(+command/settings/language)", () => {
    expect(terminalPanel).toContain(`const layout = useLayout()`)
    expect(terminalPanel).toContain(`const terminal = useTerminal()`)
    expect(terminalPanel).toContain(`const { params, workspaceKey, view } = useSessionLayout()`)
  })
  test("DOM 锚点 #terminal-panel(spike 探针的单挂载口径)", () => {
    expect(terminalPanel).toContain(`id="terminal-panel"`)
  })
  test("面板开合状态属 view(session 级),高度属 layout(全局)—— 两个所有权不可混", () => {
    expect(terminalPanel).toContain(`view().terminal.opened()`)
    expect(terminalPanel).toContain(`layout.terminal.resize(next)`)
  })
  test("打开即自动建终端 + 全关即收合(生命周期语义)", () => {
    expect(terminalPanel).toContain(`terminal.new()`)
    expect(terminalPanel).toMatch(/prevCount <= 0 \|\| count !== 0/)
  })
  test("跨 workspace 的 handoff 标签快照", () => {
    expect(terminalPanel).toContain(`setTerminalHandoff(`)
    expect(terminalPanel).toContain(`getTerminalHandoff(workspaceKey())`)
  })
  test("断连恢复:onConnectError → clone 恢复一次(recovered 去重)", () => {
    expect(terminalPanel).toContain(`onConnectError={() => recoverTerminal(`)
  })
})

describe("REQ-087 §4 命令注册不累积(AC4 的机制证据)", () => {
  test("session 命令按 key 注册 —— remount 是替换", () => {
    expect(sessionCommands).toContain(`command.register("session", () => [`)
  })
  test("layout 命令同款按 key 注册", () => {
    expect(layoutPage).toContain(`command.register("layout", () => {`)
  })
  test("command context:同 key upsert 替换 + onCleanup 反注册", () => {
    expect(commandCtx).toContain(`return [entry, ...registrations.filter((x) => x.key !== entry.key)]`)
    expect(commandCtx).toContain(`setStore("registrations", (arr) => arr.filter((x) => x !== entry))`)
  })
})

describe("REQ-087 §5 timeline 关键机制锚点", () => {
  test("虚拟列表 + prepend anchor(历史上翻不丢锚)", () => {
    expect(timeline).toContain(`createVirtualizer`)
    expect(timeline).toContain(`prependAnchor = { key: anchor.element.dataset.timelineKey`)
  })
  test("timeline 测量缓存 LRU 上限 16(session 切换不无界增长)", () => {
    expect(timeline).toContain(`while (timelineCache.size > 16) timelineCache.delete(`)
  })
  test("session 页事件订阅有清理(vcs watcher)", () => {
    expect(sessionPage).toContain(`onCleanup(stopVcs)`)
  })
  test("键盘焦点路由:终端开着优先夺焦(adapter 不得截断该链路)", () => {
    expect(sessionPage).toContain(`shouldFocusTerminalOnKeyDown(event) && focusTerminalById(id)`)
    expect(sessionPage).toContain(`makeEventListener(document, "keydown", handleKeyDown)`)
  })
})

describe("REQ-087 §6 通道结论锁定(deep-import 现状不可静默漂移)", () => {
  test("session surface 发布默认仍是 legacy(REQ-088 未交付,flags-off 零变化)", () => {
    expect(SURFACE_RELEASE_STATES.session).toBe("legacy")
  })
  test("@opencode-ai/app exports map 不含 pages 子路径 —— 合法窄通道尚不存在", () => {
    const pkg = JSON.parse(readFileSync(join(APP, "package.json"), "utf8")) as { exports: Record<string, string> }
    expect(Object.keys(pkg.exports).sort()).toEqual(
      [".", "./desktop-menu", "./index.css", "./updater", "./vite", "./wsl/types"].sort(),
    )
  })
  test("deep import 全仓唯一收敛点 = session-spike-host.tsx(拟议 upstream-adapter 边界的占位)", () => {
    const host = readFileSync(join(import.meta.dir, "session-spike-host.tsx"), "utf8")
    expect(host).toContain(`import("../../../../../app/src/pages/session")`)
    // index.tsx 本体不得出现任何对 app/src 的 deep import
    const rendererIndex = readFileSync(join(import.meta.dir, "../../index.tsx"), "utf8")
    expect(rendererIndex).not.toContain(`app/src/pages`)
  })
})

// ———— OPEN:需要 live engine 的验收项,不在源码锚点层造假 ————
// 以下对应 REQ-087 AC5/AC6/AC7 与交付物 4 的运行时部分;进入 REQ-088 前必须用真实引擎取证。
describe("REQ-087 OPEN(live-engine characterization,本 spike 不覆盖)", () => {
  test.todo("AC5 100+ 长 timeline:首屏/stream 更新/上翻历史/跟底与暂停/hash 定位 无跳动不丢锚")
  test.todo("AC6 terminal 生命周期:新建/关闭/重排/切 session/重启恢复 + PTY 不泄漏")
  test.todo("AC6 permission once/always/reject 与 abort/重试 流程")
  test.todo("AC4(运行时半边)event subscription 数与 PTY 数跨切换不线性累积(探针只覆盖 DOM/命令面)")
  test.todo("AC7 mount time / 订阅数 / 内存趋势 / 长 timeline 滚动 vs legacy 基线")
  test.todo("streaming / steer / queue / abort / tool card / file-review panel 焦点返回 characterization")
})
