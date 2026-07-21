// REQ-087 characterization seeds(交付物 4,种子而非全集)。
// 形态与 surface-seam-contract.test.ts 同款:冻结的 packages/app 无法在 bun test 直接 import
// (vite `?worker&url` 依赖),故以源码锚点先「锁住」legacy 行为面 —— 任何 re-freeze/重构若挪动
// 这些不变量,权威门在实现 REQ-088 之前先红掉。锚点变更 = 边界契约变更,须随 spike 报告修订。
//
// 明确标注 OPEN 的验收项见文件底部 test.todo —— 它们需要 live engine(真实 PTY/流式/权限流),
// 不在本 seed 范围内造假通过。
import { describe, expect, test } from "bun:test"
import { readdirSync, readFileSync } from "node:fs"
import { join, relative } from "node:path"
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
  test("sessionKey 由 SDK directory + route session id + server scope 拼合", () => {
    expect(sessionLayout).toContain(`const directory = createMemo(() => base64Encode(sdk().directory))`)
    expect(sessionLayout).toContain(
      `SessionStateKey.from(scope(), SessionRouteKey.fromRoute(directory(), params.id))`,
    )
    expect(sessionLayout).toContain(`SessionStateKey.from(scope(), SessionRouteKey.fromRoute(directory()))`)
  })
  test("tabs/view 是 layout context 按 sessionKey 的切片 —— adapter 不得复制该状态", () => {
    expect(sessionLayout).toContain(`tabs: createMemo(() => layout.tabs(sessionKey))`)
    expect(sessionLayout).toContain(`view: createMemo(() => layout.view(sessionKey))`)
  })
  test("session 路由形状 /:dir/session/:id? + 叶包在 SessionProviders", () => {
    expect(appTsx).toContain(`<Route path="/session/:id?" component={SessionRoute} />`)
    expect(appTsx).toMatch(/<SessionProviders>\s*<Leaf \/>[\s\S]*PermissionSurface[\s\S]*<\/SessionProviders>/)
  })
  test("surface override 与默认叶 XOR(单挂载的结构保证)", () => {
    expect(appTsx).toContain(
      `createSessionRoute(props.surfaces?.session ?? Session, props.surfaces?.permission)`,
    )
  })
})

describe("REQ-087 §3 terminal panel 依赖形状", () => {
  test("依赖面:useLayout + useTerminal + useSessionLayout(+sdk/command/settings/language)", () => {
    expect(terminalPanel).toContain(`const layout = useLayout()`)
    expect(terminalPanel).toContain(`const terminal = useTerminal()`)
    expect(terminalPanel).toContain(`const sdk = useSDK()`)
    expect(terminalPanel).toContain(`const { workspaceKey, view } = useSessionLayout()`)
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
  test("键盘焦点路由:全局 printable key 归 composer,终端仍经显式 focus helper 聚焦", () => {
    expect(sessionPage).toContain(`const input = inputRef`)
    expect(sessionPage).toContain(`input.focus()`)
    expect(sessionPage).toContain(`makeEventListener(document, "keydown", handleKeyDown)`)
    expect(sessionPage).not.toContain(`shouldFocusTerminalOnKeyDown`)
    expect(terminalPanel).toContain(`focusTerminalById(id)`)
  })
})

describe("REQ-087 §6 通道结论锁定(REQ-088 C1 合法窄通道,不可静默漂移)", () => {
  test("session surface 发布默认仍是 legacy(REQ-088 未交付,flags-off 零变化)", () => {
    expect(SURFACE_RELEASE_STATES.session).toBe("legacy")
  })
  test("@opencode-ai/app exports map = 既有六条 + ./surface/session 窄导出(C1,ADR-027 修订)", () => {
    const pkg = JSON.parse(readFileSync(join(APP, "package.json"), "utf8")) as { exports: Record<string, string> }
    expect(Object.keys(pkg.exports).sort()).toEqual(
      [".", "./desktop-menu", "./index.css", "./updater", "./vite", "./wsl/types", "./surface/session"].sort(),
    )
    // 窄面锁死:该子路径只指向 session 叶源文件,并只暴露上游路由组合所需的显式 allowlist。
    expect(pkg.exports["./surface/session"]).toBe("./src/pages/session.tsx")
    const sessionLeaf = src("pages/session.tsx")
    const exportStatements = sessionLeaf.match(/^export .*$/gm) ?? []
    expect(exportStatements).toEqual([
      "export function SessionPage() {",
      "export function TargetSessionRouteContent(props: { content?: Component }) {",
      "export function SessionRouteErrorBoundary(",
      "export function SessionProviders(props: ParentProps) {",
      "export default function Page() {",
    ])
  })
  test("窄导出全仓唯一消费点 = session-workspace/alpha-session-workspace.tsx(T2 正式化,spike host 已让渡)", () => {
    // 收敛点断言不再钉单文件字符串,而是全 renderer 源码步进扫描:恰好一个非测试文件消费窄导出。
    const rendererDir = join(import.meta.dir, "../..")
    const importers: string[] = []
    const walk = (dir: string) => {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        if (entry.name === "node_modules" || entry.name.startsWith(".")) continue
        if (/\.test\.(ts|tsx)$/.test(entry.name)) continue
        const p = join(dir, entry.name)
        if (entry.isDirectory()) walk(p)
        else if (/\.(ts|tsx)$/.test(entry.name) && readFileSync(p, "utf8").includes("@opencode-ai/app/surface/session"))
          importers.push(p)
      }
    }
    walk(rendererDir)
    expect(importers.map((p) => relative(rendererDir, p))).toEqual([
      "alpha-ui/session-workspace/alpha-session-workspace.tsx",
    ])
    // 相对路径 deep import 保持废除;index.tsx 只消费工厂,不直接消费窄导出。
    const workspace = readFileSync(importers[0], "utf8")
    expect(workspace).toContain(`import("@opencode-ai/app/surface/session")`)
    expect(workspace).not.toContain(`app/src/pages`)
    const rendererIndex = readFileSync(join(import.meta.dir, "../../index.tsx"), "utf8")
    expect(rendererIndex).not.toContain(`app/src/pages`)
  })
})

// ———— live-engine 验收项(REQ-088 C2 已落实,原六项 test.todo → 真测试)————
// 实现在 test-live/req087/req087-live-characterization.test.ts:真引擎(packages/opencode serve)
// + 冻结 app renderer(vite dev)+ 真实 Chromium;不进权威门(依赖本机 Chrome、运行分钟级),
// 入口 scripts/req087-live-characterization.sh。此处锚死套件存在性与六项标题,防静默删除/改名。
describe("REQ-087 live-engine characterization(C2,实现于 test-live/req087)", () => {
  const LIVE_ITEMS = [
    "AC5 100+ 长 timeline:首屏/stream 更新/上翻历史/跟底与暂停/hash 定位 无跳动不丢锚",
    "AC6 terminal 生命周期:新建/关闭/重排/切 session/重启恢复 + PTY 不泄漏",
    "AC6 permission once/always/reject 与 abort/重试 流程",
    "AC4(运行时半边)event subscription 数与 PTY 数跨切换不线性累积(探针只覆盖 DOM/命令面)",
    "AC7 mount time / 订阅数 / 内存趋势 / 长 timeline 滚动 vs legacy 基线",
    "streaming / steer / queue / abort / tool card / file-review panel 焦点返回 characterization",
  ] as const
  const liveSuite = readFileSync(
    join(import.meta.dir, "../../../../test-live/req087/req087-live-characterization.test.ts"),
    "utf8",
  )
  test("六项 live 验收项在真引擎套件中逐一存在(标题精确匹配)", () => {
    for (const item of LIVE_ITEMS) expect(liveSuite).toContain(`"${item}"`)
  })
  test("真引擎口径未被偷换:真实 serve 引擎 + 冻结 app renderer + 真实浏览器", () => {
    const harness = readFileSync(join(import.meta.dir, "../../../../test-live/req087/harness.ts"), "utf8")
    expect(harness).toContain(`packages/opencode/src/index.ts"), "serve"`)
    expect(harness).toContain(`cwd: join(REPO_ROOT, "packages/app")`)
    expect(harness).toContain(`chromium.launch({`)
    // 权威门不吞本套件:ui-mac 单元门仍是 bun test src(本文件自身就在其中)
    const pkg = JSON.parse(readFileSync(join(import.meta.dir, "../../../../package.json"), "utf8")) as {
      scripts: Record<string, string>
    }
    expect(pkg.scripts.test).toBe("bun test src")
    expect(pkg.scripts["test:live:req087"]).toContain("test-live/req087")
  })
})
