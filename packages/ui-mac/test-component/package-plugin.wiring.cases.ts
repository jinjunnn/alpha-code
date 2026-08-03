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
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { isAbsolute, join, resolve as resolvePath } from "node:path"
import { applyEdits, modify, parse, type ParseError } from "jsonc-parser"
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
const { setDesiredStateV2, upsertRecordsV2 } = await import("../src/main/ext-receipt-v2")

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

const configPath = () => join(root(), "alpha.jsonc")
const ledgerPath = () => join(root(), "installs.json")
const grantPath = (key: string) => join(root(), "ext-store", key, "grants.json")

// ── 观测手段本身不许有盲区 ────────────────────────────────────────────────────────────────────
//
// 这三个读法此前都是 `try { … } catch { 返回空 }`,于是「正确清空」与「**整个文件被删掉/写坏**」
// 折叠成同一个观察结果:一个卸载时顺手把 `alpha.jsonc` 删了、把 `installs.json` 重置了的实现,
// 四条清零断言仍然全绿。**读不出来是失败,不是「空」** —— 下面一律严格读,读不出就抛。

/** 严格读 `alpha.jsonc`:文件必须在、必须是合法 jsonc、根必须是对象。 */
function readConfigStrict(): Record<string, unknown> {
  const text = readFileSync(configPath(), "utf8") // 缺席 ⇒ 抛(ENOENT)
  const errors: ParseError[] = []
  const parsed: unknown = parse(text, errors)
  if (errors.length > 0) throw new Error(`alpha.jsonc is not valid jsonc (${errors.length} syntax error(s))`)
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed))
    throw new Error("alpha.jsonc root is not an object")
  return parsed as Record<string, unknown>
}

/** 严格读 `plugin[]`:文件与键都必须在,且必须是数组。清空 = `[]`,**不是**「键没了」。 */
function pluginArrayStrict(): unknown[] {
  const value = readConfigStrict().plugin
  if (!Array.isArray(value))
    throw new Error(`alpha.jsonc "plugin" is ${JSON.stringify(value) ?? "undefined"}, expected an array`)
  return value
}

/** 严格读账本:文件必须在、必须是 JSON、根必须是对象、`records` 必须是数组。 */
function readLedgerStrict(): Ledger {
  const parsed: unknown = JSON.parse(readFileSync(ledgerPath(), "utf8")) // 缺席/损坏 ⇒ 抛
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed))
    throw new Error("installs.json root is not an object")
  if (!Array.isArray((parsed as Ledger).records)) throw new Error("installs.json has no records array")
  return parsed as Ledger
}

/** 一个扩展的已授权 capability 集:`<root>/ext-store/<key>/grants.json`(事务拥有的路径)。
 *  存在时严格解析(损坏 ⇒ 抛);**不存在**由调用方用 `existsSync(grantPath(key))` 单独断言 ——
 *  「读不出来」不许和「已经清掉了」用同一个返回值表示。 */
function grantOf(key: string): { capabilities?: string[] } {
  return JSON.parse(readFileSync(grantPath(key), "utf8")) as { capabilities?: string[] }
}

// ── 无关 sentinel:杀掉「整文件清空/删除也算通过」的假绿 ──────────────────────────────────────
//
// 严格读只能抓到「文件没了 / 坏了」。抓不到「文件还在、但被重写成一个空壳」。所以再加一层:
// 卸载**之前**在 config 与账本里各放一件**与本包无关**的东西,卸载**之后**断言它们逐字还在。
// 一个把整份配置或整本账本推倒重写的实现,会连这两件一起抹掉。

const CONFIG_SENTINEL_KEY = "alphaTestUnrelatedSetting"
const CONFIG_SENTINEL_VALUE = "req128-809-untouched"
const LEDGER_SENTINEL_NAME = "req128-809-unrelated-agent"

/** 用 jsonc 的 `modify`/`applyEdits` 写,不手搓 JSON —— 免得 sentinel 自己把文件格式改坏。 */
function seedUnrelatedSentinels(): void {
  const text = readFileSync(configPath(), "utf8")
  const edits = modify(text, [CONFIG_SENTINEL_KEY], CONFIG_SENTINEL_VALUE, {})
  writeFileSync(configPath(), applyEdits(text, edits))
  const written = upsertRecordsV2(root(), [
    {
      // 形状由**生产写器**校验(非 catalog 来源必须是 `user:<name>`、不得带供应链 digest)——
      // 夹具不绕过它,否则 sentinel 自己就是一条账本合同管不着的假记录。
      id: `user:${LEDGER_SENTINEL_NAME}`,
      name: LEDGER_SENTINEL_NAME,
      kind: "agent",
      environment: "dev",
      scope: { kind: "global" },
      version: "1.0.0",
      desiredState: "enabled",
      origin: "imported",
      installedAt: "2026-08-03T00:00:00.000Z",
    },
  ])
  if (!written.ok) throw new Error(`sentinel ledger record could not be written: ${written.reason}`)
}

/** 卸载之后:两件无关的东西必须逐字还在。 */
function expectUnrelatedSentinelsIntact(): void {
  expect(readConfigStrict()[CONFIG_SENTINEL_KEY]).toBe(CONFIG_SENTINEL_VALUE)
  expect(
    (readLedgerStrict().records ?? []).filter((entry) => entry.kind === "agent" && entry.name === LEDGER_SENTINEL_NAME),
  ).toHaveLength(1)
}

const managedDir = () => join(root(), "plugins", fixture.pluginDirName)
const managedJs = () => join(managedDir(), "plugin.js")

/** `main/ext-config.ts` 的目录圈禁谓词,逐条重跑在**真实写下的那个值**上。 */
function confinedUnderPluginsRoot(value: unknown): boolean {
  if (typeof value !== "string") return false
  const pluginsRoot = join(root(), "plugins")
  return isAbsolute(value) && value.endsWith(".js") && resolvePath(value).startsWith(pluginsRoot + "/")
}

// ── ADR-040(`#825` 第 5 条):带 plugin 组件的包整包被拒,拒在取第三方 JS 之前 ──────────────────
//
// 原来这里有八条用例,断言的是「managed plugin 怎么装进去」:落盘两个文件、`plugin[]` 写 wrapper
// 绝对路径、卸载四清零、目录删不掉时如实失败。那条路径已经封死,所以它们随路径一起走。
// 留下来的是这一条真正的判据 —— **它跑的仍然是同一条生产链**(真已验 Catalog → 真 IPC 通道 →
// 真 admission),只是断言换成了「这条链在哪一步、以什么理由停下」。

test("带 opencode-plugin 组件的包:生产 IPC 路径上整包具名拒绝,第三方 JS 一个字节都没取过,盘面零变更", async () => {
  resetDisk()
  const { staged, result } = await install("plugin-kit-sealed")
  // 拒绝发生在**授权之前**:`install()` 只有在拿到 stage="authorize" 时才会发第二次请求,
  // 所以这里 staged 就是终态。授权屏都不该出现 —— 用户不应该被问「要不要授权一个装不了的东西」。
  expect(staged.stage).not.toBe("authorize")
  expect(result).toMatchObject({ ok: false })
  const reason = (result as { reason: string }).reason
  // 具名:说得出是**哪个组件**、按**哪条裁决**。只断 `ok === false` 会把「别处随便一个失败」
  // 也读成通过 —— 本仓已实证过这个粒度问题。
  expect(reason).toContain(LEAF_PLUGIN_ID)
  expect(reason).toContain("ADR-040")

  // 位置承诺:拒在**资产取用之前**。payload.json 会被取(admission 要先看懂这个包是什么),
  // 但那份会被引擎执行的 JS 一个字节都不该下载。把拒绝挪到 builder 里仍然会通过上面的断言,
  // 却过不了这一条。
  expect(fetchedUrls).not.toContain(PLUGIN_ASSET_URL)
  // 连计划都没构造:`runExtensionTransaction` 从未被调用。
  expect(lastPlan).toBeUndefined()

  // 盘面零变更(四个面)。`plugins/` 与 `ext-store/` 一起断,因为「拒了但已经落了目录/授权账」
  // 是这类拒绝最常见的半态。
  expect(existsSync(configPath())).toBe(false)
  expect(existsSync(ledgerPath())).toBe(false)
  expect(existsSync(join(root(), "plugins"))).toBe(false)
  expect(existsSync(join(root(), "ext-store"))).toBe(false)
})

test("对照:同一个包去掉 plugin 组件后照常装成 —— 四个 profile 各自路由到自己的 builder,且 plugin[] 全程没长出来", async () => {
  resetDisk()
  fixture = pluginKitFixture({ withoutPlugin: true })
  const { result } = await install("plugin-kit-without-plugin")
  expect(result).toMatchObject({ ok: true, kind: "agent", name: "plugin-kit-root" })
  expect((result as { installed: string[] }).installed.sort()).toEqual(
    [ROOT_AGENT_ID, LEAF_SKILL_ID, LEAF_MCP_LOCAL_ID, LEAF_MCP_REMOTE_ID].sort(),
  )

  // 这一段是从被删掉的「五个 profile 各自路由」那条原样搬来的四个 profile 半场 —— 它证明
  // 上一条用例的拒绝**不是**把整条 package 通道弄坏了。
  const items = lastPlan!.items
  const keyed = new Map(items.map((item) => [item.key, item]))
  const skillItem = items.find((item) => item.key.startsWith("skill--"))!
  expect(skillItem.action).toBeUndefined()
  expect(skillItem.files?.map((file) => file.path)).toEqual(["SKILL.md"])
  const agentFile = items.find((item) => item.key === "agent--plugin-kit-root")!
  expect(agentFile.action).toBe("file")
  expect(agentFile.file?.relTarget).toBe("agents/plugin-kit-root.md")
  expect(keyed.get("agent--plugin-kit-root--config")?.config?.edits[0]?.keyPath).toEqual(["agent", "plugin-kit-root"])
  for (const name of ["plugin-kit-local", "plugin-kit-remote"]) {
    const item = keyed.get(`mcp--${name}`)!
    expect(item.action, name).toBe("config")
    expect(item.config?.edits[0]?.keyPath, name).toEqual(["mcp", name])
  }
  expect(new Set([skillItem.key, agentFile.key, keyed.get("mcp--plugin-kit-local")!.key, keyed.get("mcp--plugin-kit-remote")!.key]).size).toBe(4)
  // 一条 plugin item 都没有,写盘后的 `alpha.jsonc` 里也没有 `plugin` 键。
  expect(items.filter((item) => item.key.startsWith("plugin--"))).toHaveLength(0)
  expect(readConfigStrict().plugin).toBeUndefined()
})

test("@alpha-code/ext 不受影响:引擎侧接缝走 OPENCODE_CONFIG_CONTENT,与磁盘 plugin[] 无关", async () => {
  resetDisk()
  // 生产注入面(`injectAlphaConfig`)在 sidecar 里跑,这里只需证明它**不经过**被封死的那条路:
  // 它把 alpha 自己的 ext 绝对路径合进 env 通道的对象,磁盘上的 alpha.jsonc 一个字节都不写。
  const { injectAlphaConfig } = await import("../src/main/alpha-config-injection")
  const extPath = join(tmp, "alpha-ext", "index.js")
  mkdirSync(join(tmp, "alpha-ext"), { recursive: true })
  writeFileSync(extPath, "export default {}\n")
  const prevContent = process.env.OPENCODE_CONFIG_CONTENT
  delete process.env.OPENCODE_CONFIG_CONTENT
  const injected = injectAlphaConfig(userData, extPath, "dev")
  expect(injected.ok).toBe(true)
  const envConfig = JSON.parse(process.env.OPENCODE_CONFIG_CONTENT!) as { plugin?: unknown[] }
  // ① alpha 自有 ext 确实进了引擎会读的那份配置(env 通道);
  expect(envConfig.plugin).toEqual([extPath])
  // ② 而磁盘上的 `alpha.jsonc` 里没有它 —— 注入只 seed 了一个 `{$schema}`。
  //    咽喉若误伤这条接缝,①会红;咽喉若其实拦不住磁盘写,②会红。
  expect(readConfigStrict().plugin).toBeUndefined()
  if (prevContent === undefined) delete process.env.OPENCODE_CONFIG_CONTENT
  else process.env.OPENCODE_CONFIG_CONTENT = prevContent
})
