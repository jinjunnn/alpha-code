// REQ-128 Phase 4 `#810` —— **签名 package / 套件安装路径收口 + 引擎重扫**的闸。
//
// 缺陷:三个 Hub 安装入口(`runPackageAction` / `installBundle` / `confirmPackageAuthz`)全部
// 直连 `extIpc.installCatalog`,**一个都不调 `refreshEngine()`**;而组件的注入面只在引擎实例
// 构造时装载 ⇒ placebo 安装:账本翻了、盘上有了、界面说「已安装」,用户下一条消息里什么都没有。
//
// ⚠️ 本文件的判据形状是被 R1 审计 F13 钉死的:**必须驱动三个生产 Hub 动作本身**。
// 只测一个新 helper 的话,一个「新写了收口方法、而 Hub 仍旧直连 `extIpc`」的实现
// **生产行为一点没变而测试全绿**(假闸形态⑧:没测生产接线)。所以这里:
//   · 三个动作全部经**真实 DOM 点击**触发(卡片按钮 / 确认屏按钮),不直接调函数;
//   · `useExtensions` 的收口方法上挂一个**真包装**(真函数值先存 const 再 `mock.module`),
//     任何一个入口改回直连 `extIpc`,它就不在计数里 ⇒ 红;
//   · 另加一条**出站计数相等**:到达 IPC 的 `installCatalog` 次数必须等于经过收口方法的次数,
//     于是「既走收口方法、又另外直连一次」也红。
//
// 被替身的只有进程边界:
//   · 引擎 HTTP 客户端(`@opencode-ai/sdk/v2/client`)—— `refreshEngine()` 的
//     `POST /global/dispose` 在无头进程里没有对端。这个 spy 就是「引擎有没有被叫去重扫」的判据。
//   · `globalThis.fetch` —— 签名 package 的 payload/资产取用。admission 自己那条取用/复验
//     仍是生产实现(不传 `deps.fetchAsset`)。
// main 侧其余一律真实现:真 `registerExtIpcHandlers`、真 admission、真事务、真 legacy planner。
//
// ⚠️ 本仓踩过的三条本机纪律,本文件逐条遵守:
//   · `mock.module` 会**就地改写**已捕获的模块命名空间对象 ⇒ 函数值必须先存进独立 const;
//   · 一切会牵出 `solid-js` 的模块必须**动态** import,且排在 `GlobalRegistrator.register()` 之后;
//   · `solid-js/store` **也**必须钉到 dom 构建 —— 少这一行不报错,而是静默失去反应性。

import { afterAll, expect, mock, test } from "bun:test"
import { transformAsync } from "@babel/core"
import presetTypescript from "@babel/preset-typescript"
import { GlobalRegistrator } from "@happy-dom/global-registrator"
import presetSolid from "babel-preset-solid"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import bundledCatalog from "../src/renderer/extensions/alpha-catalog.json"
import { LEAF_MCP_ID, MIXED_BUNDLE_PACKAGE_ID, mixedBundleFixture } from "./package-mixed-bundle.fixture"
import { pinShippedPlatform } from "./pin-shipped-platform"

// 本文件要验的是**发布平台上**的安装行为,而它会走到生产平台闸
// (套件/条目 `compatibility.platforms` = darwin/win32,ADR-026):linux runner 上套件安装被
// 就地拒掉(DOM 原话「platform linux not supported by this bundle」),授权屏永不出现。
// 与两个兄弟 cases 文件同款 opt-in;它自陈本轮平台是模拟,不静默降级。
pinShippedPlatform()

// ── ① 引擎客户端替身 = 「引擎有没有被叫去重扫」的唯一判据 ──────────────────────────────
//     函数值先存 const,再 mock.module。
let disposeCalls = 0
/**
 * dispose 的失败形态取 **`"error"`**(SDK 正常 resolve 成 `{error, response}`)——
 * v2 client 默认 `throwOnError: false`,503 / 404 走的就是这条,`try/catch` 一个字都碰不到。
 * 只模拟 throw 的夹具会让「把 HTTP 错误当成功」的实现全绿。
 */
let disposeFailure: "none" | "error" = "none"
const engineClient = {
  global: {
    dispose: async () => {
      disposeCalls++
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

// ── ② main 侧进程边界替身 ────────────────────────────────────────────────────────────────
type IpcSender = { id: number; on?: (n: string, l: () => void) => void; once?: (n: string, l: () => void) => void }
type IpcHandler = (event: { sender: IpcSender }, ...args: unknown[]) => unknown
const handlers = new Map<string, IpcHandler>()

const tmp = mkdtempSync(join(tmpdir(), "req128-810-reload-"))
const userData = join(tmp, "user-data")
const snapshotDigest = "3".repeat(64)

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
mock.module("../src/main/ext-mcp-activation", () => ({
  reloadInstalledMcp: async (name: string) => ({ reference: name, status: "connected" }),
  probeProjectMcpActivation: async () => "unverifiable" as const,
}))

// ── ③ catalog:随包条目 + 两条本票自有的套件 + 一个签名 package ──────────────────────────
//
// 随包 catalog 四条套件的必需成员全都带 `{workspace}` 占位(planner 无 workspace grant 即拒),
// 所以这里另立两条**只含一个真实成员**的套件:一条给成功路径,一条给「引擎重扫失败」路径。
// 成员是随包 catalog 里真实的 `mcp:markitdown` / `mcp:fetch`(uvx,无占位、无必填环境变量;
// `mcp:excel` 是 REQ-135 退役负例,不得用作成功夹具)。
const BUNDLE_OK = "bundle:req810-reload"
const BUNDLE_PENDING = "bundle:req810-reload-pending"
const BUNDLE_OK_NAME = "req810-reload-suite"
const BUNDLE_PENDING_NAME = "req810-reload-pending-suite"
const testBundle = (id: string, name: string, member: string) => ({
  id,
  type: "bundle",
  name,
  displayName: name,
  description: "REQ-128 #810 fixture bundle.",
  source: "alpha",
  category: "dev",
  license: "MIT",
  redistributable: true,
  version: "1.0.0",
  bundleItems: [{ catalogEntryId: member, optional: false, installOrder: 1 }],
})

const fixture = mixedBundleFixture()
const catalogEntries = [
  ...(bundledCatalog as unknown as { entries: unknown[] }).entries,
  testBundle(BUNDLE_OK, BUNDLE_OK_NAME, "mcp:markitdown"),
  testBundle(BUNDLE_PENDING, BUNDLE_PENDING_NAME, "mcp:fetch"),
]
const catalogDocument = {
  version: "2026-08-03",
  entries: catalogEntries,
  packages: [fixture.envelope],
}

// URL → 字节。payload 由信封的 `payloadRef` 给出;资产由 payload 自己给出 —— agent 是
// `behavior.asset`、skill 是 `behavior.files`、command 是 `behavior.template`,都要**逐条**登记进这张表。
const bytesByUrl = new Map<string, Uint8Array>()
for (const component of fixture.envelope.components) {
  const payload = fixture.payloadByDigest.get(component.payloadRef.sha256)
  if (!payload) throw new Error(`fixture: payload bytes missing for ${component.id}`)
  bytesByUrl.set(component.payloadRef.url, payload)
  const decoded = JSON.parse(new TextDecoder().decode(payload)) as {
    behavior?: {
      asset?: { url: string; sha256: string }
      files?: Array<{ url: string; sha256: string }>
      template?: { url: string; sha256: string }
    }
  }
  for (const ref of [
    ...(decoded.behavior?.asset ? [decoded.behavior.asset] : []),
    ...(decoded.behavior?.files ?? []),
    ...(decoded.behavior?.template ? [decoded.behavior.template] : []),
  ]) {
    const assetBytes = fixture.assetByDigest.get(ref.sha256)
    if (!assetBytes) throw new Error(`fixture: asset bytes missing for ${component.id} (${ref.url})`)
    bytesByUrl.set(ref.url, assetBytes)
  }
}

// 只替换网络那一段:目录读通道的注册与安全视图投影仍走真实现。
const realRemoteCatalog = await import("../src/main/remote-catalog")
const realRegisterPackageCatalogReadIpcHandlers = realRemoteCatalog.registerPackageCatalogReadIpcHandlers
const realEvaluateRemoteCatalogPackages = realRemoteCatalog.evaluateRemoteCatalogPackages
mock.module("../src/main/remote-catalog", () => ({
  ...realRemoteCatalog,
  downloadRemoteAsset: async () => ({ ok: false, reason: "unexpected remote asset download" }),
  readCachedCatalog: () => null,
  registerPackageCatalogReadIpcHandlers: realRegisterPackageCatalogReadIpcHandlers,
  refreshRemoteCatalog: async () =>
    realEvaluateRemoteCatalogPackages({
      source: "remote",
      catalog: catalogDocument,
      version: "2026-08-03",
      fetchedAt: "2026-08-03T00:00:00.000Z",
      via: "channel-dev",
      channel: "dev",
      snapshotDigest,
    } as never),
}))

// ── ④ renderer:DOM + Solid dom 构建 ────────────────────────────────────────────────────
GlobalRegistrator.register()
// ⚠️ **必须排在 `GlobalRegistrator.register()` 之后**:它自己会把 `globalThis.fetch` 换成
// happy-dom 的实现,于是装在它前面的替身被静默顶掉,payload 取用变成真出网 ——
// 报错是 `Cross-Origin Request Blocked` 与 404,与被测的东西毫无关系。
const originalFetch = globalThis.fetch
globalThis.fetch = (async (input: string | URL | Request) => {
  const url = String(input)
  const bytes = bytesByUrl.get(url)
  if (!bytes) throw new Error(`unexpected network fetch: ${url}`)
  return new Response(bytes, { status: 200 })
}) as typeof fetch
const solid = await import("solid-js/dist/solid.js")
mock.module("solid-js", () => solid)
const solidWeb = await import("solid-js/web/dist/web.js")
mock.module("solid-js/web", () => solidWeb)
// `solid-js/store` 少这一行**不报错**,而是静默失去反应性(store 变了、memo 永不重跑)。
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
  name: "req810-reload-solid",
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

// ── ⑤ 收口方法的真包装 = F13 的判据 ─────────────────────────────────────────────────────
//
// **这不是替身**:`useExtensions` 的真函数值先存进独立 const,包装只在调用前后记一笔。
// 一个「新写了 helper 而 Hub 仍旧直连 `extIpc`」的实现,在这里的计数是 0 ⇒ 红。
type CentralCall = { catalogId: string; attemptId: string | undefined; authorized: boolean }
const centralCalls: CentralCall[] = []
const realUseExtensionsModule = await import("../src/renderer/extensions/use-extensions")
const realUseExtensions = realUseExtensionsModule.useExtensions
mock.module("../src/renderer/extensions/use-extensions", () => ({
  ...realUseExtensionsModule,
  useExtensions: ((...args: Parameters<typeof realUseExtensions>) => {
    const api = realUseExtensions(...args)
    const realInstallCatalogIntent = api.installCatalogIntent
    // 收口方法缺席 ⇒ 大声炸掉。静默 undefined 会把「根本没有收口」伪装成一次无害的 no-op。
    if (typeof realInstallCatalogIntent !== "function")
      throw new Error("useExtensions() has no installCatalogIntent — the #810 chokepoint is missing")
    return {
      ...api,
      installCatalogIntent: (intent: Parameters<typeof realInstallCatalogIntent>[0]) => {
        centralCalls.push({
          catalogId: intent.catalogId,
          attemptId: intent.attemptId,
          authorized: intent.authorization !== undefined,
        })
        return realInstallCatalogIntent(intent)
      },
    }
  }) as typeof realUseExtensions,
}))

// ── ⑥ 真 main:环境 + IPC 表 ─────────────────────────────────────────────────────────────
const { initAlphaEnvironment } = await import("../src/main/alpha-environment")
const { registerExtIpcHandlers } = await import("../src/main/ext-ipc")
const { readPackageLedgerStateV1 } = await import("../src/main/ext-receipt-v2")
const { alphaGlobalRoot } = await import("../src/main/alpha-installs")

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
  async () => ({ url: "http://127.0.0.1:39131", username: "opencode", password: "route-password" }),
  join(tmp, "home"),
)
const globalRoot = alphaGlobalRoot()

// ── ⑦ renderer ↔ main 的桥:走生产 handler,不重写任何判定 ───────────────────────────────
const SENDER: IpcSender = { id: 1, on: () => {}, once: () => {} }
const call = async (channel: string, ...args: unknown[]): Promise<unknown> => {
  const handler = handlers.get(channel)
  if (!handler) throw new Error(`handler not registered: ${channel}`)
  return handler({ sender: SENDER }, ...args)
}

/** 到达 IPC 边界的安装意图。与 `centralCalls` 判**相等**:多出来的那一次就是绕过收口的那一次。 */
const ipcInstallIntents: Array<{ catalogId?: unknown }> = []

const extBridge: Record<string, unknown> = {
  installCatalog: async (intent: unknown) => {
    ipcInstallIntents.push(intent as { catalogId?: unknown })
    return call("ext-install-catalog", intent)
  },
  remoteCatalog: () => call("ext-remote-catalog"),
  packageDetail: (catalogId: unknown) => call("ext-package-detail", catalogId),
  packageInstalled: (catalogId: unknown) => call("ext-package-installed", catalogId),
  installedPackages: () => call("ext-installed-packages"),
  listInstalls: (projectDir?: unknown) => call("ext-list-installs", projectDir),
  inventoryView: (projectDir?: unknown) => call("ext-inventory-view", projectDir),
  factorySkillIds: () => call("ext-factory-skill-ids"),
  sessionGrants: () => call("ext-session-grants"),
  advisoryActive: () => call("ext-advisory-active"),
  migrateScan: () => call("ext-migrate-scan"),
  checkRuntime: (tool: unknown) => call("ext-check-runtime", tool),
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
    openDirectoryPicker: async () => undefined,
    ext: new Proxy(extBridge, {
      get(target, property: string) {
        if (property in target) return target[property]
        // 缺一个方法就大声说出来 —— 静默 undefined 会把「renderer 根本没接上」伪装成 no-op。
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
  () => createComponent(ExtensionHub, { server: () => ({ baseUrl: "http://127.0.0.1:39131" }), open: () => true, onClose: () => {} }),
  root,
)

afterAll(() => {
  disposeHub()
  disposeToasts()
  globalThis.fetch = originalFetch
  rmSync(tmp, { recursive: true, force: true })
})

// ── ⑧ DOM 驱动小工具 ────────────────────────────────────────────────────────────────────
const flush = () => new Promise((r) => setTimeout(r, 0))
/** ⚠️ 必须 `await assertion()`:传一个 async 断言进来而不 await,它的拒绝会变成 unhandled
 *  rejection,而 `waitFor` **立刻返回成功** —— 一条永远绿的假闸。 */
async function waitFor(assertion: () => void | Promise<void>): Promise<void> {
  let failure: unknown
  for (let attempt = 0; attempt < 300; attempt++) {
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

/** 当前打开的对话框里那颗「确认安装」主按钮(package 授权屏与套件确认框共用同一句文案)。 */
function confirmInstallButton(): HTMLElement | undefined {
  return qa("[role='dialog'] button").find((node) => (node.textContent ?? "").trim() === zh["alpha.ext.confirmInstall"])
}

/** 能力授权框(第二阶段)的主按钮。文案与上面那颗**不同**,不能共用一个查找。 */
function authzConfirmButton(): HTMLElement | undefined {
  return qa("[role='dialog'] button").find((node) => (node.textContent ?? "").trim() === zh["alpha.ext.authz.confirmInstall"])
}

/** 条目卡:卡上没有 id 属性,按 `<b title={e.name}>` 定位(name 是 catalog 身份的一半)。 */
function entryCard(name: string): HTMLElement {
  const label = qa(".alpha-ext-card b").find((node) => node.getAttribute("title") === name)
  expect(label, `entry card for ${name} is not on screen`).toBeInstanceOf(HTMLElement)
  const card = label!.closest<HTMLElement>(".alpha-ext-card")
  expect(card).toBeInstanceOf(HTMLElement)
  return card!
}

function ledgerPackageIds(): string[] {
  const state = readPackageLedgerStateV1(globalRoot)
  return state.ok ? state.packageGraphs.map((graph) => graph.packageId).sort() : ["<unreadable>"]
}

/**
 * 走生产路径装一条套件:套件页 → 卡片「添加」→ 确认框「确认安装」→ **能力授权框「授权并安装」**。
 *
 * 第二步不是多余的:legacy planner 对套件成员的 capability 一律要求显式确认
 *(`silent inheritance refused`),所以套件的**首驱恒落 authorize 臂**,真正落盘的是重驱那一趟。
 * 于是一条套件 = 两次经过收口方法,而只有后一次会重扫 —— 这正是「authorize 不是安装」的行为半场。
 */
async function installBundleThroughUi(name: string): Promise<void> {
  // package 授权屏与套件确认框共用同一个 Dialog 宿主,且前者优先渲染 —— 它没关干净时,
  // 下面点到的会是**另一条路径**的按钮。这条前置断言把那种串味变成一句明白话。
  expect(q("[data-package-authorization]"), "a package authorization dialog is still open").toBeNull()
  setHubSection("bundles")
  await waitFor(() => expect(entryCard(name)).toBeInstanceOf(HTMLElement))
  click(entryCard(name).querySelector(".alpha-ext-add"))
  await waitFor(() => expect(confirmInstallButton()).toBeInstanceOf(HTMLElement))
  click(confirmInstallButton())
  await waitFor(() => expect(authzConfirmButton()).toBeInstanceOf(HTMLElement))
  click(authzConfirmButton())
}

// ═══════════════════════════════════════════════════════════════════════════════════════
// 判据
// ═══════════════════════════════════════════════════════════════════════════════════════

test("① 入口一 `runPackageAction`:卡片「安装」经收口方法出站,而 authorize 臂**不**重扫", async () => {
  setHubSection("featured")
  await waitFor(() => expect(q(`[data-package-card="${MIXED_BUNDLE_PACKAGE_ID}"]`)).toBeInstanceOf(HTMLElement))
  const disposeBefore = disposeCalls
  click(q(`[data-package-card="${MIXED_BUNDLE_PACKAGE_ID}"] .alpha-ext-add`))
  // 首驱恒落 authorize 臂 ⇒ 授权屏出现。
  await waitFor(() => expect(q("[data-package-authorization]")).toBeInstanceOf(HTMLElement))

  expect(centralCalls).toEqual([{ catalogId: MIXED_BUNDLE_PACKAGE_ID, attemptId: expect.any(String), authorized: false }])
  // 盘上还什么都没发生 ⇒ 一次重扫都不许有。谎报「已生效」与不重扫是同一个缺陷的两面。
  expect(disposeCalls).toBe(disposeBefore)
})

test("② 入口二 `confirmPackageAuthz`:确认屏落盘 ⇒ 同一个收口方法 + 引擎当场重扫一次", async () => {
  const input = q<HTMLInputElement>("[data-package-authorization] .alpha-ext-key-input")
  expect(input, "package authorization screen has no required-secret field").toBeInstanceOf(HTMLInputElement)
  // 夹具的 MCP 叶带一个必填密钥 ⇒ 确认按钮在填完之前是禁用的。这条只为让下面的点击走
  // **用户真实做得到**的那条路;密钥面本身的判据在 `ext-package-detail-wiring` 里,不在这里重述。
  expect((q("[data-package-authorization] .alpha-ext-key-name")?.textContent ?? "").length).toBeGreaterThan(0)
  input!.value = "req810-secret"
  input!.dispatchEvent(new Event("input", { bubbles: true }))

  const disposeBefore = disposeCalls
  clearToasts()
  await waitFor(() => expect(confirmInstallButton()?.hasAttribute("disabled")).toBe(false))
  click(confirmInstallButton())

  // 真落盘:账本里出现这个包(不是「我调过 install」这种内部事实)。
  await waitFor(() => expect(ledgerPackageIds()).toContain(MIXED_BUNDLE_PACKAGE_ID))
  expect(centralCalls.at(-1)).toEqual({
    catalogId: MIXED_BUNDLE_PACKAGE_ID,
    attemptId: expect.any(String),
    authorized: true,
  })
  // 首驱与确认屏是**同一次 attempt**:确认屏若自己另铸一个 id,admission 会当场拒。
  expect(centralCalls.at(-1)!.attemptId).toBe(centralCalls[0]!.attemptId)
  expect(disposeCalls).toBe(disposeBefore + 1)
  // 重扫成功 ⇒ 不许出现「要重载」。
  expect(toasts().join("\n")).not.toContain(zh["alpha.ext.addedPendingReload"])
})

test("③ 入口三 `installBundle`:套件装完同样经收口方法 + 引擎重扫一次", async () => {
  const disposeBefore = disposeCalls
  const centralBefore = centralCalls.length
  clearToasts()
  await installBundleThroughUi(BUNDLE_OK_NAME)

  await waitFor(() => expect(toasts().join("\n")).toContain(zh["alpha.ext.added"]))
  // 首驱(authorize)+ 重驱(落盘)各一次,两次都经过同一个收口方法。
  expect(centralCalls.slice(centralBefore)).toEqual([
    { catalogId: BUNDLE_OK, attemptId: undefined, authorized: false },
    { catalogId: BUNDLE_OK, attemptId: undefined, authorized: true },
  ])
  // **只有落盘那一次**重扫:authorize 臂上盘面还没动,重扫它就是谎报。
  expect(disposeCalls).toBe(disposeBefore + 1)
  expect(toasts().join("\n")).not.toContain(zh["alpha.ext.addedPendingReload"])
})

test("④ 重扫失败**如实**呈现「要重载」,不谎报「已添加」", async () => {
  disposeFailure = "error"
  const disposeBefore = disposeCalls
  clearToasts()
  try {
    await installBundleThroughUi(BUNDLE_PENDING_NAME)
    await waitFor(() => expect(toasts().join("\n")).toContain(zh["alpha.ext.addedPendingReload"]))
  } finally {
    disposeFailure = "none"
  }
  // 重扫**被叫到了**(这是「失败」不是「没调」),而用户读到的那句话必须是「要重载」。
  expect(disposeCalls).toBe(disposeBefore + 1)
  expect(toasts().join("\n")).not.toContain(zh["alpha.ext.added"])
})

test("⑤ 出站计数相等:到达 IPC 的每一次安装都经过了收口方法", () => {
  // 三个入口共六次出站(package 首驱 + 确认屏,两条套件各首驱 + 重驱)。任何一次直连 `extIpc` 都会让
  // 右边多出来一次而左边不动 —— 「既走收口方法又另外直连一次」的实现在这里红。
  expect(ipcInstallIntents.length).toBe(centralCalls.length)
  expect(centralCalls.map((entry) => entry.catalogId)).toEqual([
    MIXED_BUNDLE_PACKAGE_ID,
    MIXED_BUNDLE_PACKAGE_ID,
    BUNDLE_OK,
    BUNDLE_OK,
    BUNDLE_PENDING,
    BUNDLE_PENDING,
  ])
  expect(ipcInstallIntents.map((intent) => intent.catalogId)).toEqual(centralCalls.map((entry) => entry.catalogId))
  // 夹具自检:被装的那个 package 里真的有一个 MCP 组件(套件成员之外还有 fs 类组件),
  // 也就是说「装完要重扫」这件事对本夹具是真需求,不是摆设。
  expect(fixture.envelope.components.map((component) => component.id)).toContain(LEAF_MCP_ID)
})
