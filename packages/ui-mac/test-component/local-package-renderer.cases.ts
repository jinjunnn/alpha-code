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
/**
 * dispose 的失败形态。**两种,不是一种**(R1 Major):
 *   · `"throw"` —— 传输层炸了(旧夹具只有这一种);
 *   · `"error"` —— **SDK 正常 resolve 成 `{error, response}`**。v2 client 默认
 *     `throwOnError: false`,503 / 404 走的就是这条,`try/catch` 一个字都碰不到。
 * 只模拟 throw 的夹具会让「把 HTTP 错误当成功」这个实现全绿 —— 而用户那一刻看到的是
 *「已生效 / 已移除」,旧引擎实例还在暴露旧技能。
 */
let disposeFailure: "none" | "throw" | "error" = "none"
const engineClient = {
  global: {
    dispose: async () => {
      disposeCalls++
      if (disposeFailure === "throw") throw new Error("engine dispose refused (fixture)")
      if (disposeFailure === "error") return { data: undefined, error: { message: "refused" }, response: { status: 503 } }
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
const { applyPackageMutation } = await import("../src/main/ext-receipt-v2")
const { bundleOwner, computeInstalledGraphDigest } = await import("../src/main/ext-package-ledger-v3")
const { registerExtIpcHandlers } = await import("../src/main/ext-ipc")
// **生产**引擎插件。第 9 跳的判据必须穿过它,不能停在「我读了它会读的那个文件」。
const { AlphaExt } = await import("../../ext/src/plugin")

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
/** `AlphaExt` 需要一个真实存在的项目目录。 */
const engineProject = join(tmp, "engine-project")
mkdirSync(engineProject, { recursive: true })

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
// ⚠️ **目录名刻意不等于 manifest 里的 name**:目录叫 `tide-folder-name`,插件叫 `tide`。
// 一个把显示名实现成「目录名」的错误实现会在卡片上写出 `tide-folder-name` —— 那必须变红。
const tidePlugin = writePlugin("tide-folder-name", (dir) => {
  writeSkill(dir, "premarket-briefing")
  writeSkill(dir, "postmarket-review")
  writeSkill(dir, "manual-only", "user-invocable: true\n")
  mkdirSync(join(dir, "commands"), { recursive: true })
  writeFileSync(join(dir, "commands", "review.md"), "# a slash command\n", "utf8")
  mkdirSync(join(dir, "agents"), { recursive: true })
  writeFileSync(join(dir, "agents", "helper.md"), "# a sub agent\n", "utf8")
}, { name: "tide", version: "0.1.0", description: "tide fixture" })
/** 一个都装不上:三个技能全部声明了调用控制设置(真实语料 10/40 个插件是这个结局)。 */
const blockedPlugin = writePlugin("codex-like", (dir) => {
  for (const name of ["cli-runtime", "result-handling", "prompting"]) writeSkill(dir, name, "user-invocable: true\n")
})
/** 第二个可装包(用来证明区块列的是**账本里有什么**,不是只列最后装的那一个)。 */
const soloPlugin = writePlugin("solo", (dir) => writeSkill(dir, "solo-skill"), {
  name: "solo",
  description: "no version on purpose",
})
/**
 * `#784` R2 Major 的两个夹具:**账本存不下的插件名**。
 *
 * 129 个 `a`:`mintPackageId` 会把它**截成合法的 128 字符 ID**,于是这个插件照样进
 * installable 预览 —— 而显示名带的是**原始 129 字符**。修复之前,它在 receipt commit
 * 那一刻被拒、整个事务回滚:预览说能装,点了确认却失败。
 *
 * ⚠️ 控制字符一律 `String.fromCharCode(1)` 现造,**不写转义字面量** ——
 * 本轮已三次把「转义的 NUL」落盘成真的 NUL 字节,而 NUL 闸会抓到。
 * `JSON.stringify` 会把它转义进 plugin.json,落盘的仍是纯 ASCII。
 */
const longNamePlugin = writePlugin("long-name-dir", (dir) => writeSkill(dir, "long-alpha"), {
  name: "a".repeat(129),
  description: "name longer than the ledger can hold",
})
const controlNamePlugin = writePlugin("control-name-dir", (dir) => writeSkill(dir, "control-alpha"), {
  name: `tide${String.fromCharCode(1)}plugin`,
  description: "name with a control character",
})
/** 非插件目录**而且导入会失败**(R1 Major 3):没有 `.claude-plugin/`、SKILL.md 的
 *  frontmatter 读不出来 ⇒ main 回 `{ok:false, reason}` 且**不带 `route`**。
 *  这个夹具存在的唯一理由:只覆盖成功路径的回归用例,杀不掉「把任何失败都当成插件目录」
 *  这个更现实的错误实现(`isLocalPluginRoute` 写成 `!result.ok`)。 */
const brokenSkillDir = (() => {
  const dir = join(tmp, "broken-skill")
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, "SKILL.md"), "no frontmatter here at all\n", "utf8")
  return realpathSync(dir)
})()
/** 非插件目录:根级 SKILL.md、没有 `.claude-plugin/` ⇒ 必须**逐字不变**走既有单技能导入。 */
const plainSkillDir = (() => {
  const dir = join(tmp, "plain-skill")
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, "SKILL.md"), "---\nname: plain-skill\ndescription: a plain local skill\n---\n\nbody\n", "utf8")
  return realpathSync(dir)
})()

// ── ⑦ DOM 驱动小工具 ───────────────────────────────────────────────────────────────────
const flush = () => new Promise((r) => setTimeout(r, 0))
/** ⚠️ 必须 `await assertion()`:传一个 **async** 断言进来而不 await,它的拒绝会变成
 *  unhandled rejection,而 `waitFor` **立刻返回成功** —— 一条永远绿的假闸。本文件踩过一次。 */
async function waitFor(assertion: () => void | Promise<void>): Promise<void> {
  let failure: unknown
  for (let attempt = 0; attempt < 200; attempt++) {
    try {
      await assertion()
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

/** 引擎注入门实际读的允许集(`packages/ext/src/gen-skill-paths.ts`)。**这是次要事实**——
 *  主判据是下面那个真跑生产 hook 的函数,原因见它的注释。 */
function engineAllowSet(): string[] {
  const file = skillsEnabledPath(globalRoot)
  if (!existsSync(file)) return []
  return (JSON.parse(readFileSync(file, "utf8")) as { keys?: string[] }).keys ?? []
}

/**
 * **跑真正的引擎注入链**,返回它注入进 `cfg.skills.paths` 的目录。
 *
 * R1 Blocker 的教训:**读「引擎会读的那个文件」≠ 跑「引擎的读」。**
 * 之前这里只 `JSON.parse` 了 `skills-enabled.json` —— 而生产链在那之后还要
 * 校验 `v === 1`、过 `SAFE_KEY`、读 `ext-store/<key>/current.json` 取 live generation、
 * `statSync` 确认目录在,**然后才**把路径塞进 `cfg.skills.paths`(`gen-skill-paths.ts`),
 * 而这一整段是由 `AlphaExt` 的 `config` hook 调起来的(`plugin.ts`)。
 * 删掉那个 hook、或让 `current.json` 失效,旧断言**照样全绿**,而用户开了开关、
 * dispose 也调了,下一条消息里依然找不到技能。
 *
 * 所以这里跑的是**生产的 `AlphaExt`**,一行替身都没有。
 */
async function engineInjectedSkillPaths(): Promise<string[]> {
  const previous = process.env.ALPHA_GLOBAL_DIR
  process.env.ALPHA_GLOBAL_DIR = globalRoot
  try {
    const hooks = (await AlphaExt({
      directory: engineProject,
      worktree: engineProject,
      client: { instance: { dispose: async () => {} } },
    } as never)) as unknown as { config: (cfg: Record<string, unknown>) => Promise<void> }
    const cfg: Record<string, unknown> = {}
    await hooks.config(cfg)
    const skills = cfg.skills as { paths?: unknown } | undefined
    return Array.isArray(skills?.paths) ? (skills.paths as string[]) : []
  } finally {
    if (previous === undefined) delete process.env.ALPHA_GLOBAL_DIR
    else process.env.ALPHA_GLOBAL_DIR = previous
  }
}

/** 生产链注入的路径 → 技能名(路径形状 `<root>/ext-store/skill--<name>/generations/<gen>`)。 */
const injectedSkillNames = (paths: readonly string[]): string[] =>
  paths
    .map((dir) => /ext-store\/skill--([^/]+)\/generations\//.exec(dir)?.[1])
    .filter((name): name is string => !!name)
    .sort()
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

/**
 * 用**生产写器**在账本里种一张包图。
 *
 * 为什么必须是种的:「两个包共享同一个 child」与「存量图没有显示名」这两个状态,
 * 走本地导入路径**结构上到不了** —— 同名会被 fresh 闸拒掉,而存量图按定义早于本票。
 * 但它们都是真实可达的(目录包共享 child 是 `ext-package-lifecycle-permutations` 的现役场景)。
 * 所以这里不手搓 JSON,而是喂 `applyPackageMutation` —— 与生产落账**同一个**写器。
 */
function seedPackage(input: {
  packageId: string
  displayName?: string
  children: Array<{ name: string; origin?: string }>
}): void {
  const digest = (seed: string) => `sha256:${seed.repeat(64).slice(0, 64)}`
  const nodes = input.children.map((child) => ({
    componentId: `user:${child.name}`,
    kind: "skill" as const,
    name: child.name,
    required: true,
    manifestDigest: digest("a"),
  }))
  const withoutDigest = {
    packageId: input.packageId,
    envelopeDigest: digest("b"),
    ...(input.displayName === undefined ? {} : { displayName: input.displayName }),
    root: nodes[0]!,
    children: nodes.slice(1),
  }
  const graph = { ...withoutDigest, installedGraphDigest: computeInstalledGraphDigest(withoutDigest) }
  const owner = bundleOwner(graph.packageId, graph.root.manifestDigest)
  const applied = applyPackageMutation(globalRoot, {
    transactionId: `tx-seed-${input.packageId}`,
    operation: "install",
    graphBeforeDigest: null,
    graphAfter: graph,
    childRecordMutations: input.children.map((child) => ({
      op: "upsert" as const,
      input: {
        id: `user:${child.name}`,
        name: child.name,
        kind: "skill" as const,
        environment: "dev" as const,
        scope: { kind: "global" as const },
        desiredState: "disabled" as const,
        origin: (child.origin ?? "imported-claude") as never,
        installedAt: "2026-08-02T00:00:00.000Z",
      },
    })),
    claimMutations: input.children.map((child) => ({ op: "acquire" as const, kind: "skill" as const, name: child.name, owner })),
  })
  if (!applied.ok) throw new Error(`fixture: seeding ${input.packageId} failed: ${applied.reason}`)
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
  // ⚠️ 这一条**必须排第一**:它要的是「一条 receipt 都还没有」的冷启动状态。
  // 放在安装用例之后就只能测到「已经有东西之后账本才坏」,而那条杀不掉通用空态 ——
  // 那时 `installedAll()` 非空,空态本来就不渲染(R1 Major 4 的原话)。
  test("冷启动账本就是坏的 ⇒ 说「读不出」,**同时不许**再说「尚未安装任何扩展」", async () => {
    const ledgerFile = join(globalRoot, "installs.json")
    mkdirSync(globalRoot, { recursive: true })
    writeFileSync(ledgerFile, "{ this is not json", "utf8")
    try {
      await gotoInstalled()
      await waitFor(() => expect(q("[data-packages-unreadable]")).toBeInstanceOf(HTMLElement))
      const banner = q("[data-packages-unreadable]")!
      expect(banner.textContent).toContain(zh["alpha.ext.packagesUnreadableTitle"])
      expect(banner.textContent).toContain("不代表没装")
      // reader 的原始理由里内嵌着 installs.json 的绝对路径 —— 它不许过 wire。
      expect(banner.textContent ?? "").not.toContain(globalRoot)
      // **这一句是本条的要害**:两条互相矛盾的信息不许同时摆给用户。
      // 「读不出」+「尚未安装任何扩展」放在一起,用户会当成东西丢了而去重装,
      // 而重装会撞上同名拒绝。
      expect(document.body.textContent ?? "").not.toContain(zh["alpha.ext.empty"])
      expect(q("[data-installed-package]")).toBeNull()
    } finally {
      rmSync(ledgerFile, { force: true })
      setHubSection("featured")
      await flush()
      await gotoInstalled()
      await waitFor(() => expect(q("[data-packages-unreadable]")).toBeNull())
    }
  })

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

    // 裁决 B:装完默认**关**。判据是**跑一遍生产引擎的注入链** —— 不是「我查了账本」,
    // 也不是「我读了那个文件」(R1 Blocker:读文件 ≠ 跑那条读)。
    expect(await engineInjectedSkillPaths()).toEqual([])
    expect(engineAllowSet()).toEqual([])

    // 界面上必须看得见「已安装 · 未启用」,而且每个技能各有开关。
    const card = packCard("local:tide")!
    // `#784` owner 裁决:卡上写的是**插件作者自己声明的名字**(`plugin.json` 的 `name`),
    // 既不是包里某个技能的名字(`postmarket-review`),也不是目录名(`tide-folder-name`)。
    expect(card.querySelector('[data-package-label="local:tide"]')?.textContent).toBe("tide")
    expect(card.textContent).not.toContain("tide-folder-name")
    expect(card.querySelector('[data-package-label="local:tide"]')?.textContent).not.toBe("postmarket-review")
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
    expect(await engineInjectedSkillPaths()).toEqual([])
    click(q('[data-package-switch="local:tide/premarket-briefing"]'))

    // 「下一条消息里技能真可用」在无头进程里可判的最强形式:**跑生产引擎的 config hook**,
    // 看它到底往 `cfg.skills.paths` 里注入了什么。这条链包含允许集版本闸、SAFE_KEY、
    // live generation 指针与目录存在性 —— 全部真跑,不是「我读了那个文件」。
    await waitFor(async () => expect(injectedSkillNames(await engineInjectedSkillPaths())).toEqual(["premarket-briefing"]))
    const injected = await engineInjectedSkillPaths()
    // 注入的是**这个技能的 live generation 目录**,不是随便一个存在的路径。
    expect(injected).toHaveLength(1)
    expect(injected[0]).toContain(join(globalRoot, "ext-store", "skill--premarket-briefing", "generations"))
    expect(existsSync(injected[0]!)).toBe(true)
    // 另一个仍然是关的 —— 界面**没有**「贴心地」替用户多打开一个。
    expect(injectedSkillNames(injected)).not.toContain("postmarket-review")
    expect(engineAllowSet()).toEqual(["skill--premarket-briefing"])
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
    const beforeInjected = await engineInjectedSkillPaths()
    const row = qa(".alpha-ext-man").find((node) => node.textContent?.includes("premarket-briefing"))
    expect(row).toBeInstanceOf(HTMLElement)
    // 这一行必须先标出「属于扩展包 X」—— 否则那句拒绝毫无来由。
    expect(row!.querySelector("[data-package-member]")?.getAttribute("data-package-member")).toBe("local:tide")
    click(row!.querySelector(".alpha-ext-iconbtn"))

    await waitFor(() => expect(q('[data-row-refusal="skill:premarket-briefing"]')).toBeInstanceOf(HTMLElement))
    const refusal = q('[data-row-refusal="skill:premarket-briefing"]')!
    // 包在界面上的名字 = **插件作者声明的名字**(`#784`)。写死这个值是刻意的:
    // 从 projection 里现算一个期望值,等于让错误实现自己给自己打分。
    expect(refusal.textContent).toContain(zh["alpha.ext.componentOwnedByPackage"].replace("{{pack}}", "tide"))
    // 「怎么办」必须给得出来。
    expect(refusal.querySelector("[data-goto-package]")?.getAttribute("data-goto-package")).toBe("local:tide")
    // **不是假成功**:没有任何一条 toast 说「已移除」。
    expect(toasts().join("\n")).not.toContain(zh["alpha.ext.removed"])
    // 实物没动。
    expect(ledgerSkillNames()).toEqual(beforeSkills)
    expect(await engineInjectedSkillPaths()).toEqual(beforeInjected)
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
    expect(injectedSkillNames(await engineInjectedSkillPaths())).toEqual(["premarket-briefing"])
    click(q('[data-package-remove="local:tide"]'))

    await waitFor(() => expect(packCard("local:tide")).toBeNull())
    expect(ledgerPackageIds()).toEqual([])
    expect(ledgerSkillNames()).toEqual([])
    // 卸完之后引擎**当场**不再暴露它 —— 在这一行之前,整包移除只刷新列表、不重载引擎,
    // 于是技能一直能用到下次重启。这就是 G20 钉的那条接线。
    expect(await engineInjectedSkillPaths()).toEqual([])
    expect(disposeCalls).toBeGreaterThan(0)
    expect(toasts().join("\n")).toContain(zh["alpha.ext.packageRemoved"])
  })

  test("引擎这次没重载成功 ⇒ 如实说「待重载」,不谎报已生效", async () => {
    clearToasts()
    disposeFailure = "error"
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
      disposeFailure = "none"
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
    expect(injectedSkillNames(await engineInjectedSkillPaths())).toContain("plain-skill")
  })

  test("存量图没有显示名 ⇒ **回退到 root 组件名**,不显示 undefined 也不空白", async () => {
    seedPackage({ packageId: "local:legacy-pack", children: [{ name: "legacy-alpha" }, { name: "legacy-beta" }] })
    setHubSection("featured")
    await flush()
    await gotoInstalled()
    await waitFor(() => expect(packCard("local:legacy-pack")).toBeInstanceOf(HTMLElement))
    const label = q('[data-package-label="local:legacy-pack"]')!
    // 缺字段**不许拒载**,也不许把 `undefined` 画到用户脸上。
    expect(label.textContent).toBe("legacy-alpha")
    expect(label.textContent).not.toContain("undefined")
    expect((label.textContent ?? "").trim().length).toBeGreaterThan(0)
  })

  test("显示名再怎么撒谎,**来源标仍然只由 child record 的 `origin` 决定**", async () => {
    // 这是行为闸,不是源码文本闸:把显示名写成最容易被误读成 provenance 的值,
    // 而这个包的 child record 的 origin 是 `imported-claude` ⇒ 界面必须说「来自本地文件夹」。
    seedPackage({
      packageId: "local:liar",
      displayName: "official-catalog-package",
      children: [{ name: "liar-skill", origin: "imported-claude" }],
    })
    setHubSection("featured")
    await flush()
    await gotoInstalled()
    await waitFor(() => expect(packCard("local:liar")).toBeInstanceOf(HTMLElement))
    const card = packCard("local:liar")!
    expect(q('[data-package-label="local:liar"]')?.textContent).toBe("official-catalog-package")
    expect(card.textContent).toContain(zh["alpha.ext.packageFromLocalFolder"])
    expect(card.textContent).not.toContain(zh["alpha.ext.packageFromCatalog"])
    expect(card.querySelector("[data-package-origin]")?.getAttribute("data-package-origin")).toBe("imported-claude")
  })

  test("整包移除后,「留下了什么、为什么」**不随包卡一起消失**(R1 Major 5)", async () => {
    // 两个包共享同一个 child —— 移除其中一个,那个 child 必须被保留并说得出理由。
    seedPackage({ packageId: "local:pack-a", displayName: "pack-a", children: [{ name: "a-only" }, { name: "shared-skill" }] })
    seedPackage({ packageId: "local:pack-b", displayName: "pack-b", children: [{ name: "b-only" }, { name: "shared-skill" }] })
    setHubSection("featured")
    await flush()
    await gotoInstalled()
    await waitFor(() => expect(packCard("local:pack-a")).toBeInstanceOf(HTMLElement))

    click(q('[data-package-remove="local:pack-a"]'))
    // 包卡确实没了(移除成功)。
    await waitFor(() => expect(packCard("local:pack-a")).toBeNull())
    // **而解释还在。** 挂在包卡内部的实现会在这一行变红:卡一消失,原因跟着消失,
    // 用户看见 `shared-skill` 还在却拿不到任何理由。
    const removal = q('[data-package-removal="local:pack-a"]')
    expect(removal).toBeInstanceOf(HTMLElement)
    expect(removal!.textContent).toContain("pack-a")
    expect(removal!.querySelector('[data-package-retained="skill:shared-skill"]')).toBeInstanceOf(HTMLElement)
    expect(removal!.querySelector("[data-retained-reason]")?.getAttribute("data-retained-reason")).toBe("shared-with-package")
    expect(removal!.textContent).toContain(zh["alpha.ext.packageKeptShared"])
    // 独占的那个真的没了,共享的那个真的还在 —— 解释与事实一致,不是一句安慰话。
    expect(ledgerSkillNames()).not.toContain("a-only")
    expect(ledgerSkillNames()).toContain("shared-skill")
    // 用户自己关掉它。
    click(removal!.querySelector("[data-dismiss-removal]"))
    await waitFor(() => expect(q('[data-package-removal="local:pack-a"]')).toBeNull())
  })

  test("R2 Major:名字账本存不下(超长)⇒ **预览期具名告知,确认照样装成**", async () => {
    clearToasts()
    await openImportFolder(longNamePlugin)
    await waitFor(() => expect(previewDialog()).toBeInstanceOf(HTMLElement))
    // ① 预览期就说清楚 —— 在按确认**之前**。
    const notice = q("[data-display-name-notice]")
    expect(notice).toBeInstanceOf(HTMLElement)
    expect(notice!.textContent ?? "").toContain("显示不了")
    // ② 它**不影响能不能装**:确认键照常可用,数量照常写在键面上。
    const confirmButton = q<HTMLButtonElement>(".a-dialog-footer .a-btn:last-child")!
    expect(confirmButton.disabled).toBe(false)

    // ③ **确认之后必须真的装成**。修复之前这里会在 receipt commit 那一刻整个回滚。
    click(confirmButton)
    await waitFor(() => expect(packCard("local:" + "a".repeat(128))).toBeInstanceOf(HTMLElement))
    expect(ledgerSkillNames()).toContain("long-alpha")
    // ④ 装成之后列表**回退到 root 组件名**,不显示半截名字、不显示 undefined。
    const label = q(`[data-package-label="local:${"a".repeat(128)}"]`)!
    expect(label.textContent).toBe("long-alpha")
    expect(label.textContent).not.toContain("undefined")
    // ⑤ 账本里那张图**根本没有** displayName 这个字段(缺席合法,不是存了个截断值)。
    const state = readPackageLedgerStateV1(globalRoot)
    expect(state.ok).toBe(true)
    const graph = state.ok ? state.packageGraphs.find((g) => g.packageId === "local:" + "a".repeat(128)) : undefined
    expect(graph).toBeDefined()
    expect(graph && "displayName" in graph).toBe(false)

    click(q(`[data-package-remove="local:${"a".repeat(128)}"]`))
    await waitFor(() => expect(packCard("local:" + "a".repeat(128))).toBeNull())
  })

  test("R2 Major:名字含控制字符 ⇒ 同样是预览期告知 + 确认装成(不是 commit 期回滚)", async () => {
    clearToasts()
    await openImportFolder(controlNamePlugin)
    await waitFor(() => expect(previewDialog()).toBeInstanceOf(HTMLElement))
    expect(q("[data-display-name-notice]")).toBeInstanceOf(HTMLElement)
    click(q<HTMLButtonElement>(".a-dialog-footer .a-btn:last-child"))
    await waitFor(() => expect(packCard("local:tide-plugin")).toBeInstanceOf(HTMLElement))
    expect(ledgerSkillNames()).toContain("control-alpha")
    expect(q('[data-package-label="local:tide-plugin"]')?.textContent).toBe("control-alpha")
    // 控制字符一个都没进账本(它连字段都没进)。
    const raw = readFileSync(join(globalRoot, "installs.json"), "utf8")
    expect(raw.includes(String.fromCharCode(1))).toBe(false)
    click(q('[data-package-remove="local:tide-plugin"]'))
    await waitFor(() => expect(packCard("local:tide-plugin")).toBeNull())
  })

  test("非插件目录**导入失败**时:保持原行内错误,**不进插件预览**(R1 Major 3)", async () => {
    clearToasts()
    await openImportFolder(brokenSkillDir)
    // 行内红字出现 = main 走的是既有单技能路径并诚实失败了。
    await waitFor(() => expect(q(".alpha-ext-import-err")).toBeInstanceOf(HTMLElement))
    // **预览屏一次都不许出现**。只覆盖成功路径的用例杀不掉「把任何失败都当成插件目录」——
    // 那个实现会在这里弹一个 preview 为 undefined 的弹窗(或直接炸)。
    expect(previewDialog()).toBeNull()
    expect(q(".alpha-ext-import-err")!.textContent ?? "").not.toBe("")
    // 也没有任何东西被装进去。
    expect(ledgerSkillNames()).not.toContain("broken-skill")
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
