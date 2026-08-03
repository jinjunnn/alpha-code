// REQ-128 Phase 4 `#809` —— managed OpenCode Plugin 的**生产接线**闸。
//
// 判据不是「builder 能拼出几条 item」——那是单元测试。判据是走 `registerExtIpcHandlers` 注册的
// 真通道:真已验 Catalog → 真 admission → 真 `runExtensionTransaction` → 真 config switch → 真 V3
// 账本;卸载同样走真 `ext-uninstall-package`。一条注入 helper 都不传给 admission
// (不传 `deps.fetchAsset`,只替换 `globalThis.fetch`)—— 注入态下把生产那条取用/复验删掉也全绿。
//
// 本文件回答四件事,每件都是本票的一条退出条件:
//   ① **五个 profile 各自路由到不同的具名 builder**(§5 第 7 类 A 的行为半场:一次真安装的计划
//      里同时出现四个 builder 的特征 item;表对了而分派仍是 `else → mcp` 的实现在这里必红);
//   ② **file item key 恰是 `plugin--<name>--f<i>`**(否则 `ext-health-probe-router.ts:40-41`
//      fail-closed 拒掉整次安装);
//   ③ **经生产 install 真写盘后**,读回真实 `alpha.jsonc`,断言 `plugin[]` 里那一条是 managed
//      wrapper 的**精确绝对路径**、满足目录圈禁、且**不存在**任何同名的 legacy/npm 条目;
//   ④ 整包卸载后**四条一起**:目录 / `plugin[]` / grants / **账本记录**。第四条走**生产卸载后
//      重读账本**,不断言中间那份 mutation 的 `graphAfter === null`(那是自己拼等价链)。

import { createHash } from "node:crypto"
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { isAbsolute, join, resolve as resolvePath } from "node:path"
import { parse } from "jsonc-parser"
import { afterAll, expect, mock, test } from "bun:test"
import type { PackageAdmissionPreviewV1 } from "../src/shared/package-admission"
import type { PackageGraphV1 } from "../src/main/ext-package-ledger-v3"
import type { TxHooks, TxPlan } from "../src/main/ext-transaction"
import {
  LEAF_MCP_LOCAL_ID,
  LEAF_MCP_REMOTE_ID,
  LEAF_PLUGIN_ID,
  LEAF_SKILL_ID,
  PLUGIN_ASSET_URL,
  PLUGIN_KIT_PACKAGE_ID,
  PLUGIN_NAME,
  pluginKitFixture,
  ROOT_AGENT_ID,
  type PluginKitFixture,
} from "./package-plugin.fixture"

type IpcHandler = (event: { sender: { id: number } }, ...args: unknown[]) => unknown

const handlers = new Map<string, IpcHandler>()
const tmp = mkdtempSync(join(tmpdir(), "req128-809-plugin-"))
const userData = join(tmp, "user-data")
const snapshotDigest = "7".repeat(64)

let fixture: PluginKitFixture = pluginKitFixture()
let lastPlan: TxPlan | undefined
const fetchedUrls: string[] = []

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
  ipcMain: {
    handle: (channel: string, handler: IpcHandler) => handlers.set(channel, handler),
  },
}))

mock.module("../src/main/ipc", () => ({
  pickedFiles: {
    read: async () => {
      throw new Error("unexpected picked-file read")
    },
  },
}))

const logLines: string[] = []
mock.module("../src/main/logging", () => ({
  getLogger: () => ({
    error: (m: unknown) => logLines.push(String(m)),
    log: (m: unknown) => logLines.push(String(m)),
    warn: (m: unknown) => logLines.push(String(m)),
  }),
}))

mock.module("../src/main/ext-advisory-gate", () => ({
  listAdvisoryBlockedFacts: () => ({ ids: [], fresh: true }),
  makeAdvisoryGate: () => () => ({ allowed: true }),
}))

// 只替换**网络那一段**。目录读通道的注册与安全视图投影仍走真实现。
// ⚠️ 函数值必须在 `mock.module` **之前**存进独立 const:`mock.module` 就地改写模块命名空间对象,
// 注册之后再从命名空间取那个名字拿到的是包装器自己 ⇒ 无限自递归。
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
      catalog: { version: "2026-08-03", entries: [], packages: [fixture.envelope] },
      version: "2026-08-03",
      fetchedAt: "2026-08-03T00:00:00.000Z",
      via: "channel-dev",
      channel: "dev",
      snapshotDigest,
    } as never),
}))

mock.module("../src/main/ext-mcp-activation", () => ({
  reloadInstalledMcp: async (name: string) => ({ reference: name, status: "connected" }),
}))

const sha = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex")

const originalFetch = globalThis.fetch
globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
  expect(init?.redirect).toBe("error")
  const url = String(input)
  fetchedUrls.push(url)
  if (url.endsWith("/alpha-package/payload.json")) {
    const component = fixture.envelope.components.find((entry) => entry.payloadRef.url === url)
    if (!component) throw new Error(`unexpected payload fetch: ${url}`)
    return new Response(fixture.payloadByDigest.get(component.payloadRef.sha256)!, { status: 200 })
  }
  const asset = fixture.assetByUrl.get(url)
  if (!asset) throw new Error(`unexpected asset fetch: ${url}`)
  return new Response(asset, { status: 200 })
}) as typeof fetch

// electron 等基础 mock **之后**才装载 ext-transaction(依赖链会牵出 electron)。这里只截计划,
// 不改行为:走的仍是真 `runExtensionTransaction`。
const realTransactionModule = await import("../src/main/ext-transaction")
const realRunExtensionTransaction = realTransactionModule.runExtensionTransaction
mock.module("../src/main/ext-transaction", () => ({
  ...realTransactionModule,
  runExtensionTransaction: (root: string, plan: TxPlan, hooks: TxHooks) => {
    lastPlan = plan
    return realRunExtensionTransaction(root, plan, hooks)
  },
}))

const { initAlphaEnvironment, getAlphaEnvironment } = await import("../src/main/alpha-environment")
const { registerExtIpcHandlers } = await import("../src/main/ext-ipc")
const { managedPluginWrapperSourceV1 } = await import("../src/main/managed-plugin-wrapper")
const { setDesiredStateV2 } = await import("../src/main/ext-receipt-v2")

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
  async () => ({ url: "http://127.0.0.1:39121", username: "opencode", password: "route-password" }),
  join(tmp, "home"),
)

afterAll(() => {
  globalThis.fetch = originalFetch
  rmSync(tmp, { recursive: true, force: true })
})

const root = () => getAlphaEnvironment().mutableRoot

function resetDisk() {
  for (const dir of [root(), userData]) {
    rmSync(dir, { recursive: true, force: true })
    mkdirSync(dir, { recursive: true })
  }
  fixture = pluginKitFixture()
  lastPlan = undefined
  fetchedUrls.length = 0
  logLines.length = 0
}

async function install(attemptId: string) {
  const handler = handlers.get("ext-install-catalog")
  if (!handler) throw new Error("ext-install-catalog handler was not registered")
  const intent = { catalogId: PLUGIN_KIT_PACKAGE_ID, scope: { scope: "global" as const }, attemptId }
  const staged = (await handler({ sender: { id: 1 } }, intent)) as {
    ok: false
    stage?: string
    authorization?: Array<{ key: string; requested: string[] }>
    packageAuthorization?: PackageAdmissionPreviewV1
    reason?: string
  }
  if (staged.stage !== "authorize" || !staged.packageAuthorization) return { staged, result: staged as unknown }
  const result = await handler(
    { sender: { id: 1 } },
    {
      ...intent,
      authorization: {
        confirmed: Object.fromEntries(staged.authorization!.map((item) => [item.key, item.requested])),
        binding: staged.packageAuthorization.binding,
      },
    },
  )
  return { staged, result }
}

type Ledger = {
  records?: Array<{ kind: string; name: string; configKey?: string; desiredState?: string }>
  packageGraphs?: PackageGraphV1[]
  claims?: Array<{ kind: string; name: string; owners: string[] }>
}

const ledger = (): Ledger => {
  try {
    return JSON.parse(readFileSync(join(root(), "installs.json"), "utf8")) as Ledger
  } catch {
    return {}
  }
}

/** 真实 `alpha.jsonc` 的 `plugin[]` —— 读的是**生产写下的那个文件**,不是计划里的中间值。 */
const pluginArray = (): unknown[] => {
  try {
    const parsed = parse(readFileSync(join(root(), "alpha.jsonc"), "utf8")) as { plugin?: unknown }
    return Array.isArray(parsed?.plugin) ? parsed.plugin : []
  } catch {
    return []
  }
}

/** 一个扩展的已授权 capability 集:`<root>/ext-store/<key>/grants.json`(事务拥有的路径)。 */
const grantOf = (key: string): { capabilities?: string[] } | null => {
  try {
    return JSON.parse(readFileSync(join(root(), "ext-store", key, "grants.json"), "utf8")) as {
      capabilities?: string[]
    }
  } catch {
    return null
  }
}

const managedDir = () => join(root(), "plugins", fixture.pluginDirName)
const managedJs = () => join(managedDir(), "plugin.js")

/** `main/ext-config.ts` 的目录圈禁谓词,逐条重跑在**真实写下的那个值**上。 */
function confinedUnderPluginsRoot(value: unknown): boolean {
  if (typeof value !== "string") return false
  const pluginsRoot = join(root(), "plugins")
  return isAbsolute(value) && value.endsWith(".js") && resolvePath(value).startsWith(pluginsRoot + "/")
}

// ── ① 五个 profile 各自路由到一个具名 builder(行为半场)+ ② file item key 形状 ───────────────

test("五个已登记 profile 在一次真安装里各自路由到自己的 builder,plugin 的 file item key 恰是 plugin--<name>--f<i>", async () => {
  resetDisk()
  const { result } = await install("plugin-kit-routing")
  expect(result).toMatchObject({ ok: true, kind: "agent", name: "plugin-kit-root" })
  expect((result as { installed: string[] }).installed.sort()).toEqual(
    [ROOT_AGENT_ID, LEAF_SKILL_ID, LEAF_MCP_LOCAL_ID, LEAF_MCP_REMOTE_ID, LEAF_PLUGIN_ID].sort(),
  )

  const items = lastPlan!.items
  const keyed = new Map(items.map((item) => [item.key, item]))

  // skill builder:generation item(无 action)+ 一条 `SKILL.md` 文件清单。
  const skillItem = items.find((item) => item.key.startsWith("skill--"))!
  expect(skillItem.action).toBeUndefined()
  expect(skillItem.files?.map((file) => file.path)).toEqual(["SKILL.md"])

  // agent builder:file item(`agents/<name>.md`)+ 一条 `agent.<name>` config item。
  const agentFile = items.find((item) => item.key === "agent--plugin-kit-root")!
  expect(agentFile.action).toBe("file")
  expect(agentFile.file?.relTarget).toBe("agents/plugin-kit-root.md")
  expect(keyed.get("agent--plugin-kit-root--config")?.config?.edits[0]?.keyPath).toEqual(["agent", "plugin-kit-root"])

  // mcp builder(local 与 remote **同一个** builder):各一条 `mcp.<name>` config item。
  for (const name of ["plugin-kit-local", "plugin-kit-remote"]) {
    const item = keyed.get(`mcp--${name}`)!
    expect(item.action, name).toBe("config")
    expect(item.config?.edits[0]?.keyPath, name).toEqual(["mcp", name])
  }

  // plugin builder:两条 file item + 一条写整个 `plugin` 数组的 config item。
  // key 形状是硬要求:`ext-health-probe-router` 对不匹配 `plugin--<name>--f<i>` 的 file item
  // 一律判不健康 ⇒ pre-switch 拒掉整次安装。
  const pluginFiles = items.filter((item) => item.action === "file" && item.key.startsWith("plugin--"))
  expect(pluginFiles.map((item) => item.key)).toEqual([
    `plugin--${PLUGIN_NAME}--f0`,
    `plugin--${PLUGIN_NAME}--f1`,
  ])
  expect(pluginFiles.map((item) => item.file!.relTarget)).toEqual([
    `plugins/${fixture.pluginDirName}/plugin.js`,
    `plugins/${fixture.pluginDirName}/upstream.js`,
  ])
  const pluginConfig = keyed.get(`plugin--${PLUGIN_NAME}`)!
  expect(pluginConfig.action).toBe("config")
  expect(pluginConfig.config?.edits[0]?.keyPath).toEqual(["plugin"])
  // 四个 builder 的特征 item 互不相同 ⇒ 「五个 profile 路由到不同的具名 builder」是被跑出来的。
  expect(new Set([skillItem.key, agentFile.key, keyed.get("mcp--plugin-kit-local")!.key, pluginConfig.key]).size).toBe(4)
})

// ── 落盘形态:wrapper 由宿主生成,第三方字节逐字节不改 ────────────────────────────────────────

test("落盘两个文件:wrapper 的字节恰是生成器的输出,upstream.js 与签名字节逐字节相同", async () => {
  resetDisk()
  const { result } = await install("plugin-kit-disk")
  expect(result).toMatchObject({ ok: true })

  expect(readdirSync(managedDir()).sort()).toEqual(["plugin.js", "upstream.js"])
  const wrapper = managedPluginWrapperSourceV1(LEAF_PLUGIN_ID)
  expect(wrapper.ok).toBe(true)
  expect(readFileSync(managedJs(), "utf8")).toBe((wrapper as { ok: true; source: string }).source)
  expect(sha(new Uint8Array(readFileSync(join(managedDir(), "upstream.js"))))).toBe(sha(fixture.pluginAsset))

  const record = ledger().records!.find((entry) => entry.kind === "plugin" && entry.name === PLUGIN_NAME)!
  expect(record.configKey).toBe(`plugin-path:${managedJs()}`)
  // 零 registry 连接(§5 第 3 类):**每一条**发出去的 URL 都必须是签名信封里的那几条。
  // 写成「没调用 Npm.add」会被第二个加载器绕过,写成「网络调用数为零」恒假 —— 判据是白名单。
  const signedUrls = new Set([
    ...fixture.envelope.components.map((component) => component.payloadRef.url),
    ...fixture.assetByUrl.keys(),
  ])
  expect(fetchedUrls.filter((url) => !signedUrls.has(url))).toEqual([])
  expect(fetchedUrls).toContain(PLUGIN_ASSET_URL)
})

// ── ③ 第 3 类:经生产 install 真写盘之后,读回真实 alpha.jsonc ─────────────────────────────────
//
// ⚠️ **一条实测出来的、票面与基线都没说到的事实**(报告里已单列):今天**任何**签名 package 的
// 组件都落 `desiredState: "disabled"` —— `package-admission` 传给 `nextDesiredState` 的只有
// `{origin:"catalog"}`,没有 source、没有 curation ⇒ `initialDesiredState` 走
// 「catalog 且 source !== "alpha"」那一格。而 plugin 的「已装未启用」在引擎里的表示**就是**
// 「不在 `plugin[]` 里」(条目在场 = 加载,没有 per-entry 禁用键;生产的启停投影
// `computeEnableProjectionEdit` 对 plugin 的 disabled 定义逐字如此)。
//   ⇒ 首装之后 `plugin[]` 是空的,这是**正确行为**,不是漏写。
//   ⇒ 而 `ext-set-install-state` 对 package child **一律拒**(实测:
//      `curation-unverifiable — the entry is not resolvable from the verified catalog`,
//      因为它按 `record.id` 去 legacy `catalog.entries` 里找条目,而 package child 不在那里)。
// 所以下面分两半:第一半断言首装之后**没有**写任何东西进 `plugin[]`(含否定面);第二半把
// 「用户已经把它开着」这个 durable intent 用**生产写器** `setDesiredStateV2` 落进账本,再跑一次
// **真安装**,断言生产那条 config item 写进去的是精确的 managed 绝对路径。被测对象(config item
// 的值)全程没有被注入过。

test("首装落 disabled ⇒ plugin[] 里一条都不写(且没有裸包名/legacy 同名条目)", async () => {
  resetDisk()
  const { result } = await install("plugin-kit-config-disabled")
  expect(result).toMatchObject({ ok: true })
  expect(pluginArray()).toEqual([])
  // 账本已经知道该指向哪个文件 —— 「没写进配置」不是因为宿主算不出这个值。
  const record = ledger().records!.find((entry) => entry.kind === "plugin" && entry.name === PLUGIN_NAME)!
  expect(record.desiredState).toBe("disabled")
  expect(record.configKey).toBe(`plugin-path:${managedJs()}`)
})

test("desiredState 为 enabled 时,生产 install 写进 plugin[] 的是精确的 managed 绝对路径,且无同名 legacy/npm 条目", async () => {
  resetDisk()
  expect(await install("plugin-kit-config-first")).toMatchObject({ result: { ok: true } })
  // durable intent = 用户把它开着。用**生产账本写器**落这一步(它正是启停通道在过完闸之后调的
  // 那个函数),被测的那条 config item 本身一点没被碰。
  expect(setDesiredStateV2(root(), "plugin", PLUGIN_NAME, "enabled").ok).toBe(true)
  expect(pluginArray()).toEqual([]) // 账本翻转本身不写配置 —— 下面那条路径才是被测对象
  expect(await install("plugin-kit-config-enabled")).toMatchObject({ result: { ok: true } })

  const array = pluginArray()
  expect(array).toEqual([managedJs()])
  expect(confinedUnderPluginsRoot(array[0])).toBe(true)
  // 否定面:裸包名 / vendored 目录路径这类同名条目**一条都不许在**。一个把配置写成
  // `opencode-notify@0.3.1` 的实现在这里必红(那正是 npm 通道会被走通的形态)。
  for (const entry of array) {
    expect(typeof entry).toBe("string")
    expect(String(entry).startsWith(PLUGIN_NAME)).toBe(false)
    expect(String(entry)).not.toContain("@0.3.1")
  }
  expect(array.filter((entry) => String(entry).includes(`/${PLUGIN_NAME}`))).toHaveLength(1)
})

// ── ④ 第 8 类:整包卸载,四条一起 ─────────────────────────────────────────────────────────────

test("整包卸载:目录 / plugin[] / grants / 账本记录 四条一起消失(账本是重读出来的)", async () => {
  resetDisk()
  expect(await install("plugin-kit-uninstall-first")).toMatchObject({ result: { ok: true } })
  expect(setDesiredStateV2(root(), "plugin", PLUGIN_NAME, "enabled").ok).toBe(true)
  expect(await install("plugin-kit-uninstall")).toMatchObject({ result: { ok: true } })

  // 前置事实:四条现在都**在**。否则下面四条断言就是恒真式。
  expect(existsSync(managedDir())).toBe(true)
  expect(pluginArray()).toEqual([managedJs()])
  expect(grantOf(`plugin--${PLUGIN_NAME}`)?.capabilities).toEqual(["engine:config", "engine:plugin"])
  expect(ledger().records!.some((entry) => entry.kind === "plugin" && entry.name === PLUGIN_NAME)).toBe(true)

  const uninstall = handlers.get("ext-uninstall-package")
  if (!uninstall) throw new Error("ext-uninstall-package handler was not registered")
  const outcome = (await uninstall({ sender: { id: 1 } }, PLUGIN_KIT_PACKAGE_ID)) as { ok: boolean; reason?: string }
  expect(outcome.reason ?? "").toBe("")
  expect(outcome.ok).toBe(true)

  // ① 目录
  expect(existsSync(managedDir())).toBe(false)
  // ② plugin[]
  expect(pluginArray()).toEqual([])
  // ③ grants
  expect(grantOf(`plugin--${PLUGIN_NAME}`)).toBeNull()
  // ④ **账本记录** —— 跑完生产卸载再把账本读回来,不断言中间那份 mutation 的字段。
  const after = ledger()
  expect(after.packageGraphs ?? []).toEqual([])
  expect((after.records ?? []).filter((entry) => entry.kind === "plugin")).toEqual([])
  expect((after.claims ?? []).filter((entry) => entry.kind === "plugin")).toEqual([])
})

// ── 完整性:第三方字节被掉包 ⇒ **整包**被拒,不是「那个叶子被跳过」 ────────────────────────────

test("JS 资产字节与签名不符 ⇒ 整包安装被拒,盘面零变更", async () => {
  resetDisk()
  fixture = pluginKitFixture({ corruptPluginAsset: true })
  const { staged, result } = await install("plugin-kit-integrity")
  const outcome = (staged.stage === "authorize" ? result : staged) as { ok: boolean; reason?: string }
  expect(outcome.ok).toBe(false)
  expect(outcome.reason).toContain("package asset unavailable or failed integrity")
  // 判据是**整包被拒**:别的组件一件都没落地(「某个叶子被跳过」对畸形值恒真)。
  expect(existsSync(join(root(), "plugins"))).toBe(false)
  expect(existsSync(join(root(), "agents"))).toBe(false)
  expect(pluginArray()).toEqual([])
  expect(ledger().packageGraphs ?? []).toEqual([])
})

// ── 如实登记:生产启停通道今天拒绝 package child ───────────────────────────────────────────────
//
// 这条**不是**本票要修的东西,写在这里是为了让它有一处会红的记录:`setInstallStateByKey` 的
// curation 闸按 `record.id` 去 legacy `catalog.entries` 里找条目,而签名 package 的 child 从来
// 不在那张表里 ⇒ 用户在 Hub 上点「启用」必然被拒。对 skill/agent/mcp 它「只是」开不了;对
// managed plugin 它是致命的 —— plugin 的唯一启用面就是出现在 `plugin[]` 里。
// 哪天这条闸被修好,本用例会红,而红的时候正是该把它删掉的时候。
test("已登记边界:生产启停通道今天对 package child 一律拒(managed plugin 因此无法被用户启用)", async () => {
  resetDisk()
  expect(await install("plugin-kit-enable-boundary")).toMatchObject({ result: { ok: true } })
  const setState = handlers.get("ext-set-install-state")
  if (!setState) throw new Error("ext-set-install-state handler was not registered")
  const outcome = (await setState(
    { sender: { id: 1 } },
    { type: "plugin", name: PLUGIN_NAME, scope: "global", state: "enabled" },
  )) as { ok: boolean; code?: string; reason?: string }
  expect(outcome.ok).toBe(false)
  expect(outcome.code).toBe("curation-unverifiable")
  expect(pluginArray()).toEqual([])
})
