// REQ-128 Phase 3 `[T4-renderer]`(`#784`)—— **整条用户可达竖线**,九跳一条不缺。
//
// 为什么整条线必须在**同一个**文件里跑完(而不是 renderer 一半、main 一半各自绿):
// Phase 1 漏掉 renderer 半场 ⇒ 全部票交付、全部过审计,最后才发现用户点不动;
// Phase 2 漏掉三条跨仓竖线 ⇒ 同一形态高一层。按层拆票时,断掉的那一截**不在任何一张票的
// 边界内**,于是每一张票都能诚实地绿。这个文件的存在就是为了让那种绿不可能发生。
//
// 被测的东西,逐条点名(**没有一条是自己拼的等价链**):
//   · 生产 `ExtensionHub` / `ExtensionDetail`(真 Solid DOM,真 `useExtensions`);
//   · 生产 main IPC 表(真 `registerExtIpcHandlers`、真写通道表、真恢复 gate);
//   · 真 `claude-plugin-intake`(布局判定 / 逐技能判决)、真 `collectImportSkillPayload`;
//   · 真 `local-package-preview`(留字节 / 预算 / 生命周期)与真 `local-package-install-port`;
//   · 真 `claude-plugin-install`(四集双射 + 一次 `runExtensionTransaction`)与真 V3 账本;
//   · 真 `skills-enabled.json` —— **引擎注入门实际读的那个文件**(`packages/ext/src/gen-skill-paths.ts`)。
//
// **唯一被替身的**是引擎 HTTP 客户端(`@opencode-ai/sdk/v2/client`):`refreshEngine()` 的
// 出站调用 `POST /global/dispose` 在无头进程里没有对端。替身把它变成一个 spy —— 那是进程边界,
// 不是我们自己的逻辑。G20 断言的就是这个 spy 有没有被叫到。
//
// **每一条用例都实施过一次绕过并确认它变红**(逐条配方与结果:
// `docs/verification/2026-08-02-req128-t4-gate-bypass-experiments.md`)。其中两条第一轮的配方
// **没有**让任何东西变红,而那不是闸失效,是配方本身改错了地方 —— 那两条也记在同一份文档里,
// 因为「我实施了绕过、它红了」这句话的价值全在于它是真的。
//
// ⚠️ 本文件的 `mock.module` 一律**先把函数值存进独立 const,再注册**(本仓教训:
// `{...m, f: wrap(m.f)}` 里的 `m.f` 在注册后指向 wrapper 自己 ⇒ 无限自递归、进程永不返回)。
// ⚠️ 一切会牵出 `solid-js` 的模块**必须动态 import**,且排在 `GlobalRegistrator.register()`
// 之后 —— 静态 import 会让整个文件拿到 server 构建,几十条用例一起挂在
// `getNextContextId cannot be used under non-hydrating context`。

import { afterAll, describe, expect, mock, test } from "bun:test"
import { transformAsync } from "@babel/core"
import presetTypescript from "@babel/preset-typescript"
import { GlobalRegistrator } from "@happy-dom/global-registrator"
import presetSolid from "babel-preset-solid"
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"

// ── ① 引擎客户端替身(G20 的断言对象)────────────────────────────────────────────────────
//     函数值先存 const,再 mock.module。
let disposeCalls = 0
let disposeFails = false
const engineClient = {
  global: {
    dispose: async () => {
      disposeCalls++
      if (disposeFails) throw new Error("engine dispose refused (fixture)")
      return { data: {} }
    },
    event: async () => ({ stream: (async function* () {})() }),
  },
  mcp: {
    status: async () => ({ data: {} }),
    connect: async () => ({ data: {} }),
    disconnect: async () => ({ data: {} }),
  },
  app: { agents: async () => ({ data: [] }) },
}
const createOpencodeClientStub = () => engineClient
mock.module("@opencode-ai/sdk/v2/client", () => ({ createOpencodeClient: createOpencodeClientStub }))

// ── ② main 侧的进程边界替身 ─────────────────────────────────────────────────────────────
type IpcSender = {
  id: number
  on?: (name: string, listener: () => void) => void
  once?: (name: string, listener: () => void) => void
}
type IpcHandler = (event: { sender: IpcSender }, ...args: unknown[]) => unknown
const handlers = new Map<string, IpcHandler>()

const tmp = realpathSync(mkdtempSync(join(tmpdir(), "local-package-renderer-")))
const userData = join(tmp, "user-data")

mock.module("electron", () => ({
  BrowserWindow: class {
    static fromWebContents() {
      return undefined
    }
  },
  dialog: {
    showMessageBox: async () => ({ response: 1, checkboxChecked: false }),
    showOpenDialog: async () => ({ canceled: true, filePaths: [] }),
  },
  ipcMain: { handle: (channel: string, handler: IpcHandler) => handlers.set(channel, handler) },
}))
mock.module("../src/main/ipc", () => ({
  pickedFiles: {
    read: async () => {
      throw new Error("unexpected picked-file read")
    },
  },
}))
mock.module("../src/main/logging", () => ({
  getLogger: () => ({ error: () => {}, log: () => {}, warn: () => {} }),
}))
mock.module("../src/main/ext-advisory-gate", () => ({
  listAdvisoryBlockedFacts: () => ({ ids: [], fresh: true }),
  makeAdvisoryGate: () => () => ({ allowed: true }),
}))
mock.module("../src/main/remote-catalog", () => ({
  downloadRemoteAsset: async () => ({ ok: false, reason: "unexpected remote asset download" }),
  readCachedCatalog: () => null,
  registerPackageCatalogReadIpcHandlers: () => {},
  refreshRemoteCatalog: async () => ({ source: "none", error: "offline in this case file" }),
}))

// ── ③ renderer 侧:DOM + Solid + 生产组件 ────────────────────────────────────────────────
GlobalRegistrator.register()
const solid = await import("solid-js/dist/solid.js")
mock.module("solid-js", () => solid)
const solidWeb = await import("solid-js/web/dist/web.js")
mock.module("solid-js/web", () => solidWeb)
// ⚠️ `solid-js/store` **也**必须钉到 dom 构建。少这一行的后果不是报错,是**静默失去反应性**:
// `use-extensions.ts` 的 `createStore` 会拿 server 构建(bun 走 node 导出条件),于是账本刷新
// 之后 store 变了、而 `installedAll` 这类 memo **永远不再重跑** —— 已安装列表恒空,
// 看上去像「渲染逻辑写错了」。实测:本文件第一版据此少了一半用例(2026-08-02)。
const solidStore = await import("solid-js/store/dist/store.js")
mock.module("solid-js/store", () => solidStore)
mock.module("../src/renderer/auth-recovery", () => ({
  subscribeAuthState: (listener: (state: { status: "logged-out"; mode: "byok" }) => void) => {
    listener({ status: "logged-out", mode: "byok" })
    return () => {}
  },
}))
mock.module("@solidjs/router", () => ({ useLocation: () => ({ pathname: "/" }) }))
mock.module("../src/renderer/alpha-ui/Banner", () => ({ Banner: () => null }))

Bun.plugin({
  name: "local-package-renderer-solid",
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

// ── ③b 安装端口:**真实现**,外加一个可撑开的 in-flight 闸 ──────────────────────────────
//
// 这里不是替身:`installLocalClaudePlugin` 的真函数值先存进独立 const,再注册包装。
// (本仓教训:`{...m, f: wrap(m.f)}` 里的 `m.f` 在 `mock.module` 之后指向 wrapper 自己 ⇒
//  无限自递归、进程活着但永不返回、`sample` 只给出剥了符号的 JS 帧。)
// 包装唯一做的事是「进去之后可以被挂住」—— 「安装进行中取消」这个窗口没法用别的办法撑开。
let installGate: { entered: () => void; held: Promise<void> } | null = null
const realInstallPort = await import("../src/main/local-package-install-port")
const realInstallLocalClaudePlugin = realInstallPort.installLocalClaudePlugin
mock.module("../src/main/local-package-install-port", () => ({
  installLocalClaudePlugin: async (issued: Parameters<typeof realInstallLocalClaudePlugin>[0]) => {
    if (installGate) {
      const gate = installGate
      gate.entered()
      await gate.held
    }
    return realInstallLocalClaudePlugin(issued)
  },
}))

// ── ④ 真 main:环境 + IPC 表 ────────────────────────────────────────────────────────────
const { initAlphaEnvironment } = await import("../src/main/alpha-environment")
const { alphaGlobalRoot } = await import("../src/main/alpha-installs")
const { GATED_WRITE_CHANNELS, LOCAL_PACKAGE_READ_CHANNELS } = await import("../src/main/ext-write-channels")
const { localPackagePreviews } = await import("../src/main/local-package-preview")
const { readLedgerV2, readPackageLedgerStateV1, skillsEnabledPath } = await import("../src/main/ext-receipt-v2")
const { registerExtIpcHandlers } = await import("../src/main/ext-ipc")

delete process.env.ALPHA_GLOBAL_DIR
initAlphaEnvironment({
  isPackaged: false,
  channel: "dev",
  appDataDir: tmp,
  baseRoot: join(tmp, "alpha-code-state"),
  homeDir: join(tmp, "home"),
})
registerExtIpcHandlers(
  userData,
  "dev",
  async () => ({ url: "http://127.0.0.1:39117", username: "opencode", password: "route-password" }),
  join(tmp, "home"),
)
const globalRoot = alphaGlobalRoot()

/**
 * preload 暴露的通道名。**逐字抄自 `src/preload/index.ts`**,并由本文件最后一条用例证明
 * 抄得对(preload 源码里真的有这一行 + 它等于 main 的常量)。
 *
 * 为什么这条闸不能省:preload 里的通道名是**字面量**,写错一个字母时 typecheck 全绿,
 * 而用户点下去拿到的是一句 "No handler registered" —— 整个功能死掉,没有任何东西变红。
 */
const PRELOAD_CHANNELS = {
  importSkillFolder: "ext-import-skill-folder",
  importClaudePluginPreview: "ext-import-claude-plugin-preview",
  importClaudePluginCancel: "ext-import-claude-plugin-cancel",
  importClaudePluginConfirm: "ext-import-claude-plugin-confirm",
  installedPackages: "ext-installed-packages",
} as const

const SENDER: IpcSender = { id: 1, on: () => {}, once: () => {} }
/** `ipcRenderer.invoke` **恒返回 Promise**,即使 main 侧 handler 是同步的
 *  (`ext-factory-skill-ids` 就是)。桥必须复现这一点,否则「renderer 拿到的是 thenable」
 *  这条 wire 事实就被夹具悄悄改掉了。 */
const call = async (channel: string, ...args: unknown[]): Promise<unknown> => {
  const handler = handlers.get(channel)
  if (!handler) throw new Error(`handler not registered: ${channel}`)
  return handler({ sender: SENDER }, ...args)
}

/** 下一次「用户按下文件夹卡」时 main 的 picker 会返回哪个目录(生产 env 短路,main 控制)。 */
let pickDir: string | null = null
/** 非 null ⇒ 整包卸载被强制失败(用来撑开「移除失败必须显示失败」)。 */
let forceUninstallFailure: string | null = null

// ── ⑤ renderer ↔ main 的桥:**走生产 handler**,不重写任何判定 ─────────────────────────
const extBridge: Record<string, unknown> = {
  importSkillFolder: async (target?: unknown) => {
    if (pickDir) process.env.ALPHA_OPEN_DIR = pickDir
    try {
      return await call(PRELOAD_CHANNELS.importSkillFolder, target)
    } finally {
      delete process.env.ALPHA_OPEN_DIR
    }
  },
  importClaudePluginPreview: (previewId: unknown) => call(PRELOAD_CHANNELS.importClaudePluginPreview, previewId),
  importClaudePluginCancel: (previewId: unknown) => call(PRELOAD_CHANNELS.importClaudePluginCancel, previewId),
  importClaudePluginConfirm: (previewId: unknown) => call(PRELOAD_CHANNELS.importClaudePluginConfirm, previewId),
  installedPackages: () => call(PRELOAD_CHANNELS.installedPackages),
  listInstalls: (projectDir?: unknown) => call("ext-list-installs", projectDir),
  inventoryView: (projectDir?: unknown) => call("ext-inventory-view", projectDir),
  setInstallState: (intent: unknown) => call(GATED_WRITE_CHANNELS.setInstallState, intent),
  uninstallV2: (intent: unknown) => call(GATED_WRITE_CHANNELS.uninstallV2, intent),
  uninstallPackage: async (packageId: unknown) => {
    if (forceUninstallFailure) return { ok: false as const, reason: forceUninstallFailure, stage: "plan" as const }
    return call(GATED_WRITE_CHANNELS.uninstallPackage, packageId)
  },
  packageInstalled: (catalogId: unknown) => call("ext-package-installed", catalogId),
  factorySkillIds: () => call("ext-factory-skill-ids"),
  sessionGrants: () => call("ext-session-grants"),
  advisoryActive: () => call("ext-advisory-active"),
  migrateScan: () => call("ext-migrate-scan"),
  checkRuntime: (tool: unknown) => call("ext-check-runtime", tool),
  // 目录面在本文件里不是被测对象(random catalog IO 会把用例变成网络测试)。
  remoteCatalog: async () => ({ source: "none" as const }),
  packageDetail: async () => undefined,
  curationBlob: async () => undefined,
  browseSeed: async () => ({ entries: [] }),
  builtinRead: async () => ({ ok: false as const, reason: "builtin panel not under test here" }),
  onSessionGrantsEnded: () => () => {},
}

Object.defineProperty(window, "api", {
  configurable: true,
  value: {
    updater: { check: async () => {} },
    auth: { start: async () => {}, setMode: async () => {} },
    ext: new Proxy(extBridge, {
      get(target, property: string) {
        if (property in target) return target[property]
        // 缺一个方法就大声说出来 —— 静默 undefined 会把「renderer 根本没接上」伪装成一次
        // 无害的 no-op,而那正是本文件要消灭的形态。
        throw new Error(`ext IPC method not stubbed in this case file: ${String(property)}`)
      },
    }),
  },
})

const { createComponent } = solid
const { render } = solidWeb
const { ExtensionHub } = await import("../src/renderer/extensions/extension-hub")
const { ToastViewport } = await import("../src/renderer/alpha-ui/Toast")
const { setHubSection } = await import("../src/renderer/extensions/ext-hub-state")
const { dict: zh } = await import("../src/renderer/i18n/zh")

const root = document.createElement("div")
root.id = "root"
root.className = "a-ui"
document.body.append(root)
const toastHost = document.body.appendChild(document.createElement("div"))
const disposeToasts = render(() => createComponent(ToastViewport, {}), toastHost)
const disposeHub = render(
  () => createComponent(ExtensionHub, { server: () => ({ baseUrl: "http://127.0.0.1:39117" }), open: () => true, onClose: () => {} }),
  root,
)

afterAll(() => {
  disposeHub()
  disposeToasts()
  delete process.env.ALPHA_OPEN_DIR
  rmSync(tmp, { recursive: true, force: true })
})

// ── ⑥ 夹具:**真目录树**(被测的是读文件系统的生产代码)────────────────────────────────

/** 一个最小合法技能目录。SKILL.md 刻意不含任何路径形 token —— 那会触发自包含启发式。 */
function writeSkill(pluginRoot: string, name: string, frontmatterExtra = ""): void {
  const dir = join(pluginRoot, "skills", name)
  mkdirSync(dir, { recursive: true })
  writeFileSync(
    join(dir, "SKILL.md"),
    `---\nname: ${name}\ndescription: fixture skill ${name}\n${frontmatterExtra}---\n\nbody of ${name}\n`,
    "utf8",
  )
}

function writePlugin(slug: string, build: (root: string) => void, manifest?: Record<string, unknown>): string {
  const dir = join(tmp, "plugins", slug)
  mkdirSync(join(dir, ".claude-plugin"), { recursive: true })
  writeFileSync(
    join(dir, ".claude-plugin", "plugin.json"),
    JSON.stringify(manifest ?? { name: slug, version: "0.1.0", description: `${slug} fixture` }),
    "utf8",
  )
  build(dir)
  return realpathSync(dir)
}

/** 主夹具:两个能装、一个因「带我们兑现不了的调用设置」被具名跳过,外加 commands/ 与 agents/。 */
const tidePlugin = writePlugin("tide", (dir) => {
  writeSkill(dir, "premarket-briefing")
  writeSkill(dir, "postmarket-review")
  writeSkill(dir, "manual-only", "user-invocable: true\n")
  mkdirSync(join(dir, "commands"), { recursive: true })
  writeFileSync(join(dir, "commands", "review.md"), "# a slash command\n", "utf8")
  mkdirSync(join(dir, "agents"), { recursive: true })
  writeFileSync(join(dir, "agents", "helper.md"), "# a sub agent\n", "utf8")
})
/** 一个都装不上:三个技能全部声明了调用控制设置(真实语料 10/40 个插件是这个结局)。 */
const blockedPlugin = writePlugin("codex-like", (dir) => {
  for (const name of ["cli-runtime", "result-handling", "prompting"]) writeSkill(dir, name, "user-invocable: true\n")
})
/** 第二个可装包(用来证明区块列的是**账本里有什么**,不是只列最后装的那一个)。 */
const soloPlugin = writePlugin("solo", (dir) => writeSkill(dir, "solo-skill"), {
  name: "solo",
  description: "no version on purpose",
})
/** 非插件目录:根级 SKILL.md、没有 `.claude-plugin/` ⇒ 必须**逐字不变**走既有单技能导入。 */
const plainSkillDir = (() => {
  const dir = join(tmp, "plain-skill")
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, "SKILL.md"), "---\nname: plain-skill\ndescription: a plain local skill\n---\n\nbody\n", "utf8")
  return realpathSync(dir)
})()

// ── ⑦ DOM 驱动小工具 ───────────────────────────────────────────────────────────────────
const flush = () => new Promise((r) => setTimeout(r, 0))
async function waitFor(assertion: () => void): Promise<void> {
  let failure: unknown
  for (let attempt = 0; attempt < 200; attempt++) {
    try {
      assertion()
      return
    } catch (error) {
      failure = error
      await flush()
    }
  }
  throw failure
}
function click(element: Element | null | undefined): void {
  expect(element).toBeInstanceOf(HTMLElement)
  ;(element as HTMLElement).click()
}
const q = <T extends Element = HTMLElement>(selector: string): T | null => document.querySelector<T>(selector)
const qa = (selector: string): HTMLElement[] => Array.from(document.querySelectorAll<HTMLElement>(selector))
const toasts = (): string[] => qa(".a-toast").map((node) => node.textContent ?? "")
const clearToasts = (): void => qa(".a-toast").forEach((node) => node.remove())
const previewDialog = () => q("[data-local-package-preview]")
const packCard = (packageId: string) => q(`[data-installed-package="${packageId}"]`)

/** 引擎注入门实际读的允许集(`packages/ext/src/gen-skill-paths.ts`)。 */
function engineAllowSet(): string[] {
  const file = skillsEnabledPath(globalRoot)
  if (!existsSync(file)) return []
  return (JSON.parse(readFileSync(file, "utf8")) as { keys?: string[] }).keys ?? []
}
function ledgerSkillNames(): string[] {
  return readLedgerV2(globalRoot)
    .records.filter((record) => record.kind === "skill")
    .map((record) => record.name)
    .sort()
}
function ledgerPackageIds(): string[] {
  const state = readPackageLedgerStateV1(globalRoot)
  return state.ok ? state.packageGraphs.map((graph) => graph.packageId).sort() : ["<unreadable>"]
}

/** 回到已安装页并等它画完 —— 包清单的 resource key 里带着 tab,离开这一页它就不再取数。 */
async function gotoInstalled(): Promise<void> {
  setHubSection("installed")
  await waitFor(() => expect(q(".alpha-ext-page")?.textContent ?? "").toContain(zh["alpha.ext.tabInstalled"]))
}

/** 走生产路径打开预览屏:切到导入页 → 点「文件夹」卡。**不直接调 IPC**。 */
async function openImportFolder(dir: string): Promise<void> {
  pickDir = dir
  setHubSection("create")
  await waitFor(() => expect(q(".alpha-ext-import-row")).toBeInstanceOf(HTMLElement))
  click(qa(".alpha-ext-import-card")[0])
}

// ═══════════════════════════════════════════════════════════════════════════════════════
// 九跳
// ═══════════════════════════════════════════════════════════════════════════════════════

describe("REQ-128 Phase 3 第 1→9 跳(生产 renderer × 生产 main,端到端)", () => {
  test("第 1→3 跳:同一张「文件夹」卡 ⇒ main 分流 ⇒ 预览屏逐条列出装 / 不装 / 具名原因 / 不支持类型", async () => {
    await openImportFolder(tidePlugin)
    await waitFor(() => expect(previewDialog()).toBeInstanceOf(HTMLElement))

    // 会安装 / 不会安装分两段,数量取自**真判决**(不是夹具里写死的期望)。
    const willInstall = qa('[data-preview-component][data-disposition="install"]').map((n) => n.querySelector("b")?.textContent)
    const wontInstall = qa('[data-preview-component][data-disposition="skip"]')
    expect(willInstall.sort()).toEqual(["postmarket-review", "premarket-briefing"])
    expect(wontInstall.map((n) => n.querySelector("b")?.textContent)).toEqual(["manual-only"])

    // **每一条「不装」都带具名原因码 + 一句人话**,没有「其他」这一档,也没有不点名的汇总。
    // 只断言「有 skip 行」杀不掉「原因被折叠成一句失败」—— 所以逐条查原因码与文案。
    const refused = wontInstall[0]!
    expect(refused.querySelector("[data-skip-reason]")?.getAttribute("data-skip-reason")).toBe("control-field-unsupported")
    expect(refused.querySelector(".alpha-ext-man-st")?.textContent ?? "").toContain("没有对应功能的开关")

    // 这一版不安装的**组件类型**逐类具名(不靠「没接线所以到不了」)。
    expect(qa("[data-unsupported-type]").map((n) => n.getAttribute("data-unsupported-type")).sort()).toEqual([
      "agents",
      "commands",
    ])

    // 「没有经过审核」必须在按确认**之前**可见,且不得写成「已检查 / 已验证 / 安全」。
    const unreviewed = q("[data-unreviewed]")?.textContent ?? ""
    expect(unreviewed).toBe(zh["alpha.ext.localPackageUnreviewed"])
    for (const forbidden of ["已验证", "已检查", "安全"]) expect(unreviewed).not.toContain(forbidden)

    // 主按钮上直接写数量 —— 用户按下去之前就知道到底装几个。
    const confirmButton = q<HTMLButtonElement>(".a-dialog-footer .a-btn:last-child")!
    expect(confirmButton.disabled).toBe(false)
    expect(confirmButton.textContent).toBe(zh["alpha.ext.localPackageConfirm"].replace("{{count}}", "2"))

    // 到这里为止**一个字节都没写盘**。
    expect(ledgerSkillNames()).toEqual([])
    expect(ledgerPackageIds()).toEqual([])
  })

  test("取消 = 零写盘,且 main 侧留存字节归零(与 T3 的 G19 对接)", async () => {
    expect(localPackagePreviews.retainedBytes()).toBeGreaterThan(0)
    click(q(".a-dialog-footer .a-btn"))
    await waitFor(() => expect(previewDialog()).toBeNull())
    await waitFor(() => expect(localPackagePreviews.retainedBytes()).toBe(0))
    expect(localPackagePreviews.size()).toBe(0)
    expect(ledgerSkillNames()).toEqual([])
    expect(ledgerPackageIds()).toEqual([])
  })

  test("第 4→6 跳:确认 ⇒ 一次事务装进去 ⇒ 已安装页当场出现扩展包卡,技能**全部未启用**", async () => {
    clearToasts()
    disposeCalls = 0
    await openImportFolder(tidePlugin)
    await waitFor(() => expect(previewDialog()).toBeInstanceOf(HTMLElement))
    click(q(".a-dialog-footer .a-btn:last-child"))

    // 装完自动落在已安装页(裁决 B 之下不跳页 = 用户按完确认什么都看不到)。
    await waitFor(() => expect(packCard("local:tide")).toBeInstanceOf(HTMLElement))
    expect(previewDialog()).toBeNull()

    // 账本半场:两个技能落账,一个包图。
    expect(ledgerSkillNames()).toEqual(["postmarket-review", "premarket-briefing"])
    expect(ledgerPackageIds()).toEqual(["local:tide"])

    // 裁决 B:装完默认**关**。判据是**引擎注入门实际读的那个文件**,不是「我查了账本」。
    expect(engineAllowSet()).toEqual([])

    // 界面上必须看得见「已安装 · 未启用」,而且每个技能各有开关。
    const card = packCard("local:tide")!
    expect(card.textContent).toContain(zh["alpha.ext.packageAllOffLead"])
    expect(qa('[data-package-switch^="local:tide/"]').map((n) => n.getAttribute("data-package-switch")).sort()).toEqual([
      "local:tide/postmarket-review",
      "local:tide/premarket-briefing",
    ])
    expect(qa('[data-package-switch^="local:tide/"]').every((n) => !n.hasAttribute("data-on"))).toBe(true)
    expect(card.textContent).toContain(zh["alpha.ext.packageFromLocalFolder"])
    // 版本如实取自 manifest;`v0.1.0` 而不是造一个。
    expect(card.textContent).toContain("v0.1.0")

    // G20 前半:confirm 成功 ⇒ 引擎被要求当场重扫。
    expect(disposeCalls).toBeGreaterThan(0)
    // 用户读得到的提示里必须说清「都还没启用」。
    expect(toasts().join("\n")).toContain("都还没启用")
  })

  test("第 9 跳:显示未启用 → 用户拨开关 → **引擎允许集里当场出现它** → 引擎重载", async () => {
    disposeCalls = 0
    expect(engineAllowSet()).toEqual([])
    click(q('[data-package-switch="local:tide/premarket-briefing"]'))

    // 「下一条消息里技能真可用」在无头进程里可判的最强形式:引擎注入门读的允许集。
    await waitFor(() => expect(engineAllowSet()).toEqual(["skill--premarket-briefing"]))
    // 另一个仍然是关的 —— 界面**没有**「贴心地」替用户多打开一个。
    expect(engineAllowSet()).not.toContain("skill--postmarket-review")
    // 拨开关同时让引擎重载(`use-extensions.setInstallState` 的既有路径)。
    expect(disposeCalls).toBeGreaterThan(0)

    // 卡上「全部未启用」的引导条随之消失,开关翻成 on。
    await waitFor(() =>
      expect(q('[data-package-switch="local:tide/premarket-briefing"]')?.hasAttribute("data-on")).toBe(true),
    )
    expect(packCard("local:tide")!.textContent).not.toContain(zh["alpha.ext.packageAllOffLead"])
  })

  test("第 8 跳:包内单个技能点「移除」⇒ **明确拒绝 + 指向整包移除**,实物一个字节不动", async () => {
    clearToasts()
    const beforeSkills = ledgerSkillNames()
    const beforeAllow = engineAllowSet()
    const row = qa(".alpha-ext-man").find((node) => node.textContent?.includes("premarket-briefing"))
    expect(row).toBeInstanceOf(HTMLElement)
    // 这一行必须先标出「属于扩展包 X」—— 否则那句拒绝毫无来由。
    expect(row!.querySelector("[data-package-member]")?.getAttribute("data-package-member")).toBe("local:tide")
    click(row!.querySelector(".alpha-ext-iconbtn"))

    await waitFor(() => expect(q('[data-row-refusal="skill:premarket-briefing"]')).toBeInstanceOf(HTMLElement))
    const refusal = q('[data-row-refusal="skill:premarket-briefing"]')!
    // 包在界面上的名字 = **root 组件名**(账本里没有「包显示名」这个事实,不造一个;
    // 组件按名字字典序取 root ⇒ postmarket-review < premarket-briefing,结果确定)。
    // 写死这个值是刻意的:从 projection 里现算一个期望值,等于让错误实现自己给自己打分。
    expect(refusal.textContent).toContain(zh["alpha.ext.componentOwnedByPackage"].replace("{{pack}}", "postmarket-review"))
    // 「怎么办」必须给得出来。
    expect(refusal.querySelector("[data-goto-package]")?.getAttribute("data-goto-package")).toBe("local:tide")
    // **不是假成功**:没有任何一条 toast 说「已移除」。
    expect(toasts().join("\n")).not.toContain(zh["alpha.ext.removed"])
    // 实物没动。
    expect(ledgerSkillNames()).toEqual(beforeSkills)
    expect(engineAllowSet()).toEqual(beforeAllow)
    expect(ledgerPackageIds()).toEqual(["local:tide"])
  })

  test("移除失败**必须显示失败** —— `ok` 之外任何东西不许读成「已移除」", async () => {
    clearToasts()
    forceUninstallFailure = "另一个安装正在进行,这次没有动任何文件。"
    try {
      click(q('[data-package-remove="local:tide"]'))
      await waitFor(() => expect(q('[data-package-error="local:tide"]')).toBeInstanceOf(HTMLElement))
    } finally {
      forceUninstallFailure = null
    }
    // 包**仍然留在列表里**,错误就在卡上。
    expect(packCard("local:tide")).toBeInstanceOf(HTMLElement)
    expect(q('[data-package-error="local:tide"]')!.textContent).toContain(zh["alpha.ext.packageRemoveFailed"])
    expect(toasts().join("\n")).not.toContain(zh["alpha.ext.packageRemoved"])
    expect(ledgerPackageIds()).toEqual(["local:tide"])
    expect(ledgerSkillNames()).toEqual(["postmarket-review", "premarket-briefing"])
  })

  test("第 7 跳(+ G20 后半):整包移除 ⇒ 卡消失、账本清零、**引擎允许集清空**、引擎重载", async () => {
    clearToasts()
    disposeCalls = 0
    expect(engineAllowSet()).toEqual(["skill--premarket-briefing"])
    click(q('[data-package-remove="local:tide"]'))

    await waitFor(() => expect(packCard("local:tide")).toBeNull())
    expect(ledgerPackageIds()).toEqual([])
    expect(ledgerSkillNames()).toEqual([])
    // 卸完之后引擎**当场**不再暴露它 —— 在这一行之前,整包移除只刷新列表、不重载引擎,
    // 于是技能一直能用到下次重启。这就是 G20 钉的那条接线。
    expect(engineAllowSet()).toEqual([])
    expect(disposeCalls).toBeGreaterThan(0)
    expect(toasts().join("\n")).toContain(zh["alpha.ext.packageRemoved"])
  })

  test("引擎这次没重载成功 ⇒ 如实说「待重载」,不谎报已生效", async () => {
    clearToasts()
    disposeFails = true
    try {
      await openImportFolder(soloPlugin)
      await waitFor(() => expect(previewDialog()).toBeInstanceOf(HTMLElement))
      click(q(".a-dialog-footer .a-btn:last-child"))
      await waitFor(() => expect(packCard("local:solo")).toBeInstanceOf(HTMLElement))
      // 账本是 durable 的(装进去了),但呈现必须是「待重载」而不是「当场生效」。
      expect(ledgerPackageIds()).toEqual(["local:solo"])
      expect(toasts().join("\n")).toContain("没能让引擎立即重新加载")
      expect(toasts().join("\n")).not.toContain(zh["alpha.ext.localPackageInstalled"].replace("{{count}}", "1"))
    } finally {
      disposeFails = false
    }
  })

  test("区块列的是**账本里有什么**:版本缺失如实写「未提供版本」,不造一个 1.0.0", () => {
    const card = packCard("local:solo")!
    expect(card.textContent).toContain(zh["alpha.ext.packageNoVersion"])
    expect(card.textContent).not.toContain("v1.0.0")
  })

  test("重复导入 ⇒ 在**按确认之前**说清「先移除整包」", async () => {
    await openImportFolder(soloPlugin)
    await waitFor(() => expect(previewDialog()).toBeInstanceOf(HTMLElement))
    const notice = q("[data-duplicate-import]")
    expect(notice).toBeInstanceOf(HTMLElement)
    expect(notice!.textContent ?? "").toContain("移除")
    click(q(".a-dialog-footer .a-btn"))
    await waitFor(() => expect(previewDialog()).toBeNull())
  })

  test("一个都装不上 ⇒ 同一屏 + 逐条原因,确认键**保留但禁用**并把原因写在键面上", async () => {
    await openImportFolder(blockedPlugin)
    await waitFor(() => expect(previewDialog()).toBeInstanceOf(HTMLElement))
    const confirmButton = q<HTMLButtonElement>(".a-dialog-footer .a-btn:last-child")!
    expect(confirmButton.disabled).toBe(true)
    expect(confirmButton.textContent).toBe(zh["alpha.ext.localPackageNothingToInstall"])
    // 三条都在,每条都带具名原因 —— 不是一句「导入失败」。
    expect(qa('[data-preview-component][data-disposition="skip"]').length).toBe(3)
    expect(q("[data-local-package-blocked]")?.getAttribute("data-local-package-blocked")).toBe("no-installable-component")
    // 这一屏不签发预览 ⇒ main 里一个字节都没留。
    expect(localPackagePreviews.retainedBytes()).toBe(0)
    click(q(".a-dialog-footer .a-btn"))
    await waitFor(() => expect(previewDialog()).toBeNull())
  })

  test("安装进行中点「取消」⇒ **如实说取消不了**,弹窗留在原地,绝不显示成「已取消」", async () => {
    clearToasts()
    // 先把 solo 拿掉,好让这一次导入是一次真安装。
    await gotoInstalled()
    await waitFor(() => expect(packCard("local:solo")).toBeInstanceOf(HTMLElement))
    click(q('[data-package-remove="local:solo"]'))
    await waitFor(() => expect(packCard("local:solo")).toBeNull())

    let entered!: () => void
    let release!: () => void
    const enteredPromise = new Promise<void>((r) => (entered = r))
    const held = new Promise<void>((r) => (release = r))
    installGate = { entered, held }
    try {
      await openImportFolder(soloPlugin)
      await waitFor(() => expect(previewDialog()).toBeInstanceOf(HTMLElement))
      click(q(".a-dialog-footer .a-btn:last-child"))
      await enteredPromise // 安装器真的进去了,而且被挂住

      // 「取消」在安装进行中**照样可点** —— 用户必须有出路。
      const cancelButton = q<HTMLButtonElement>(".a-dialog-footer .a-btn")!
      expect(cancelButton.disabled).toBe(false)
      click(cancelButton)

      // 界面上必须出现「取消不了」,而**不是**把弹窗关掉。
      await waitFor(() => expect(q("[data-local-package-error]")).toBeInstanceOf(HTMLElement))
      expect(q("[data-local-package-error]")!.textContent ?? "").toContain("取消不了")
      expect(previewDialog()).toBeInstanceOf(HTMLElement)
      expect(toasts().join("\n")).not.toContain("已取消")
      // 那批字节**仍然算在计量里** ——「已释放」和「还握着」不能同时为真。
      expect(localPackagePreviews.retainedBytes()).toBeGreaterThan(0)
    } finally {
      installGate = null
      release()
    }
    // 中止不了 ⇒ 它照样装进去了。界面如实呈现的正是这一点。
    await waitFor(() => expect(packCard("local:solo")).toBeInstanceOf(HTMLElement))
    await waitFor(() => expect(localPackagePreviews.retainedBytes()).toBe(0))
  })

  test("账本读不出来 ⇒ 界面说「读不出」,**不许**折叠成「没装」", async () => {
    const ledgerFile = join(globalRoot, "installs.json")
    const backup = join(tmp, "installs.backup.json")
    copyFileSync(ledgerFile, backup)
    try {
      writeFileSync(ledgerFile, "{ this is not json", "utf8")
      // 走用户真走得到的路径:离开已安装页再回来 ⇒ 重读一次。
      setHubSection("featured")
      await waitFor(() => expect(q("[data-installed-package]")).toBeNull())
      setHubSection("installed")
      await waitFor(() => expect(q("[data-packages-unreadable]")).toBeInstanceOf(HTMLElement))

      const banner = q("[data-packages-unreadable]")!
      expect(banner.textContent).toContain(zh["alpha.ext.packagesUnreadableTitle"])
      // 「这不代表没装」必须说出口 —— 折叠成「暂无扩展包」会让用户去重装,而重装会撞同名拒绝。
      expect(banner.textContent).toContain("不代表没装")
      // 绝对路径不许过 wire(reader 的原始 reason 里内嵌着 installs.json 的全路径)。
      expect(banner.textContent ?? "").not.toContain(globalRoot)
      // 并且**没有**任何一张包卡被画出来当作「什么都没装」。
      expect(q("[data-installed-package]")).toBeNull()
    } finally {
      copyFileSync(backup, ledgerFile)
      setHubSection("featured")
      await flush()
      setHubSection("installed")
      await waitFor(() => expect(q("[data-packages-unreadable]")).toBeNull())
    }
  })

  test("非插件目录:既有单技能导入的行为**逐字不变**(回归钉死)", async () => {
    clearToasts()
    await openImportFolder(plainSkillDir)
    // 不弹预览屏。
    await waitFor(() => expect(toasts().length).toBeGreaterThan(0))
    expect(previewDialog()).toBeNull()
    expect(toasts().join("\n")).toContain(zh["alpha.ext.imported"].replace("{{name}}", "plain-skill"))
    expect(ledgerSkillNames()).toContain("plain-skill")
    // 单个本地 skill **维持 `enabled`**(裁决 B 只把「本地包」改成默认关)。
    expect(engineAllowSet()).toContain("skill--plain-skill")
  })

  test("preload 暴露的通道名与 main 的常量逐字一致(写错一个字母 = 功能死掉且什么都不红)", () => {
    const preload = readFileSync(resolve(import.meta.dir, "../src/preload/index.ts"), "utf8")
    for (const [method, channel] of Object.entries(PRELOAD_CHANNELS)) {
      expect(preload, `preload 没有暴露 ${method}`).toContain(`${method}:`)
      expect(preload, `${method} 的通道名对不上`).toContain(`ipcRenderer.invoke("${channel}"`)
    }
    expect(PRELOAD_CHANNELS.importSkillFolder).toBe(GATED_WRITE_CHANNELS.importSkillFolder)
    expect(PRELOAD_CHANNELS.importClaudePluginConfirm).toBe(GATED_WRITE_CHANNELS.importClaudePluginConfirm)
    expect(PRELOAD_CHANNELS.importClaudePluginPreview).toBe(LOCAL_PACKAGE_READ_CHANNELS.importClaudePluginPreview)
    expect(PRELOAD_CHANNELS.importClaudePluginCancel).toBe(LOCAL_PACKAGE_READ_CHANNELS.importClaudePluginCancel)
    expect(PRELOAD_CHANNELS.installedPackages).toBe(LOCAL_PACKAGE_READ_CHANNELS.listInstalledPackages)
  })
})
