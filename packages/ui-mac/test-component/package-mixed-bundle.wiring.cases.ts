// REQ-128 `#697` —— canonical mixed Bundle 的**生产接线**闸。
//
// 判据不是「协调器能拼出一个多组件计划」——那是单元测试。判据是走 `registerExtIpcHandlers` 注册的
// 真 `ext-install-catalog` 通道:真已验 Catalog → 真 admission → 真 `runExtensionTransaction` →
// 真 config switch / 真密钥 store / 真 V3 账本;失败与崩溃则经**真 ext-ipc recoveryOpts**收敛。
//
// 这里的每一条 fault 都可达:
//   · download   —— 资产 HTTP 失败(签名 digest 对不上 ⇒ 完整性拒);
//   · secret     —— 版本目录认领不下来 ⇒ populatePrepared 抛错(授权终闸后、switch 前);
//   · config     —— live 出现未登记的 mcp 叶 ⇒ 锁内 precondition 拒;
//   · probe      —— skill 资产 frontmatter name 与组件名不符 ⇒ pre-switch probe 判不健康;
//   · receipt    —— 账本提交接缝抛错 ⇒ journal 保持非终态,由生产恢复收敛;
//   · 全部 `TX_CRASH_POINTS` —— 进程在每一个点死掉,恢复后必须**全旧或全新**。
//
// 「全旧或全新」的判据是盘面本身(agent md / skill generation / mcp config 叶 / 三条 child record /
// 图 / claim / 密钥版本目录),不是返回值。半装 = 其中任意一项与其余不一致。

import { createHash } from "node:crypto"
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterAll, expect, mock, test } from "bun:test"
import type { PackageAdmissionPreviewV1 } from "../src/shared/package-admission"
import type { PackageGraphV1 } from "../src/main/ext-package-ledger-v3"
import type { TxCrashPoint, TxHooks, TxPlan } from "../src/main/ext-transaction"
import {
  assertMatchesVendoredBundleShape,
  EXPECTED_SKIP_REASON,
  LEAF_MCP_ID,
  LEAF_SKILL_ID,
  LEAF_UNSUPPORTED_ID,
  MCP_SECRET_PREREQUISITE_ID,
  MIXED_BUNDLE_PACKAGE_ID,
  mixedBundleFixture,
  ROOT_AGENT_ID,
  type MixedBundleFixture,
} from "./package-mixed-bundle.fixture"

type IpcHandler = (event: { sender: { id: number } }, ...args: unknown[]) => unknown

const handlers = new Map<string, IpcHandler>()
const tmp = mkdtempSync(join(tmpdir(), "req128-697-mixed-"))
const userData = join(tmp, "user-data")
const secretCanary = "REQ128_697_BUNDLE_SECRET_5b1e07"
const snapshotDigest = "5".repeat(64)

// 当前这一轮用的夹具(每个用例换一份;refreshRemoteCatalog 的 mock 每次读它)。
let fixture: MixedBundleFixture = mixedBundleFixture()
/** 让某个 URL 的取用失败 —— download fault 的到达方式。 */
let failAssetUrlContaining: string | null = null
let payloadFetches = 0
let assetFetches = 0
const fetchedUrls: string[] = []

// `crashAt` 是引擎自带的故障注入点,生产不传。下面(electron 等基础 mock 之后)会把
// ext-transaction 包一层再让 ext-ipc 装载它。
let crashAt: TxCrashPoint | undefined
let failLedgerCommitOnce = false
let lastPlan: TxPlan | undefined
/** 模拟「持锁进程真的死了」:crashAt 刻意不释放锁,而本进程还活着 —— 把锁里的 pid 改成一个
 *  确定不存在的 pid,生产恢复的陈旧判据(`holder pid … not alive`)才谈得上被触发。
 *  这是崩溃注入没做完的那半件事,不是绕过恢复:收敛仍由真 recoveryOpts 完成。 */
let deadPid = 0

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

// remote-catalog:只替换**网络那一段**(`refreshRemoteCatalog`)。目录读通道的注册与安全视图
// 投影仍走真实现 —— 详情页那一面必须是生产投影出来的,否则「三个面逐字相同」里的第一个面
// 就是本用例自己造的。函数值同样在 mock 之前抓下来(见上面 ext-transaction 的同款陷阱)。
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
      catalog: { version: "2026-08-01", entries: [{}], packages: [fixture.envelope] },
      version: "2026-08-01",
      fetchedAt: "2026-08-01T00:00:00.000Z",
      via: "channel-dev",
      channel: "dev",
      snapshotDigest,
    } as never),
}))

const reloadedMcp: string[] = []
mock.module("../src/main/ext-mcp-activation", () => ({
  reloadInstalledMcp: async (name: string) => {
    reloadedMcp.push(name)
    return { reference: name, status: "connected" }
  },
}))

const originalFetch = globalThis.fetch
globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
  expect(init?.redirect).toBe("error")
  const url = String(input)
  fetchedUrls.push(url)
  if (failAssetUrlContaining && url.includes(failAssetUrlContaining))
    return new Response("nope", { status: 503 })
  // payload 的 url 都带 `/alpha-package/payload.json`;markdown 资产不带。
  if (url.endsWith("/alpha-package/payload.json")) {
    payloadFetches++
    const component = fixture.envelope.components.find((entry) => entry.payloadRef.url === url)
    if (!component) throw new Error(`unexpected payload fetch: ${url}`)
    return new Response(fixture.payloadByDigest.get(component.payloadRef.sha256)!, { status: 200 })
  }
  assetFetches++
  for (const [digest, bytes] of fixture.assetByDigest)
    if (url.includes("AGENT.md") ? digest === sha(fixture.agentAsset) : digest === sha(fixture.skillAsset))
      return new Response(bytes, { status: 200 })
  throw new Error(`unexpected asset fetch: ${url}`)
}) as typeof fetch

const sha = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex")

// ── 事务注入面 ────────────────────────────────────────────────────────────────────────────────
// electron 等基础 mock **之后**才装载 ext-transaction(它的依赖链会牵出 electron),然后把
// `runExtensionTransaction` 包一层再交给 ext-ipc。走的仍是真 `registerExtIpcHandlers` → 真
// admission → 真事务,只多了一个注入的死亡点 / 提交失败点;其余导出(恢复、journal 读取)原样透传。
const realTransactionModule = await import("../src/main/ext-transaction")
// **函数值**要在 mock 之前抓下来。`mock.module` 会就地改写模块命名空间对象,所以
// `realTransactionModule.runExtensionTransaction` 在注册之后指的是包装器本身 —— 直接调它
// 就是无限自递归(实测:计划被反复重建,事务一步都没跑,进程活着但永不返回)。
const realRunExtensionTransaction = realTransactionModule.runExtensionTransaction
mock.module("../src/main/ext-transaction", () => ({
  ...realTransactionModule,
  runExtensionTransaction: (root: string, plan: TxPlan, hooks: TxHooks) => {
    lastPlan = plan
    const commitReceipt = hooks.commitReceipt
    return realRunExtensionTransaction(root, plan, {
      ...hooks,
      ...(crashAt ? { crashAt } : {}),
      ...(commitReceipt
        ? {
            commitReceipt: async (records) => {
              if (failLedgerCommitOnce) {
                failLedgerCommitOnce = false
                throw new Error("injected ledger commit failure")
              }
              return commitReceipt(records)
            },
          }
        : {}),
    })
  },
}))

const { readBundleAuthorizationReceipt } = realTransactionModule
const { initAlphaEnvironment, getAlphaEnvironment } = await import("../src/main/alpha-environment")
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
  async () => ({ url: "http://127.0.0.1:39121", username: "opencode", password: "route-password" }),
  join(tmp, "home"),
)

afterAll(() => {
  globalThis.fetch = originalFetch
  rmSync(tmp, { recursive: true, force: true })
})

const root = () => getAlphaEnvironment().mutableRoot

/** 每个用例一块干净盘面(全局根 + userData),但**共用**已注册的生产 handler。 */
function resetDisk() {
  for (const dir of [root(), userData]) {
    rmSync(dir, { recursive: true, force: true })
    mkdirSync(dir, { recursive: true })
  }
  crashAt = undefined
  failLedgerCommitOnce = false
  failAssetUrlContaining = null
  deadPid = 0
  lastPlan = undefined
  payloadFetches = 0
  assetFetches = 0
  fetchedUrls.length = 0
  reloadedMcp.length = 0
  logLines.length = 0
}

async function preview(attemptId: string) {
  const install = handlers.get("ext-install-catalog")
  if (!install) throw new Error("ext-install-catalog handler was not registered")
  const intent = { catalogId: MIXED_BUNDLE_PACKAGE_ID, scope: { scope: "global" as const }, attemptId }
  const first = await install({ sender: { id: 1 } }, intent)
  return { install, intent, first }
}

async function installBundle(attemptId: string, secrets: Record<string, string>) {
  const { install, intent, first } = await preview(attemptId)
  const staged = first as {
    ok: false
    stage?: string
    reason?: string
    authorization?: Array<{ key: string; requested: string[] }>
    packageAuthorization?: PackageAdmissionPreviewV1
  }
  if (staged.stage !== "authorize" || !staged.packageAuthorization)
    return { preview: staged, result: first }
  const result = await install(
    { sender: { id: 1 } },
    {
      ...intent,
      grants: { secrets },
      authorization: {
        confirmed: Object.fromEntries(staged.authorization!.map((item) => [item.key, item.requested])),
        binding: staged.packageAuthorization.binding,
      },
    },
  )
  return { preview: staged, result }
}

const grants = () => ({ [MCP_SECRET_PREREQUISITE_ID]: secretCanary })

/**
 * 崩溃注入**故意**不释放锁(那正是进程猝死的样子),但本进程还活着,所以生产恢复看到的是一把
 * 「持有者仍在跑」的锁,永远不会接管它。把锁文件里的 pid 换成一个确定不存在的 pid,让盘面真的
 * 长成「持锁进程已死」——这是崩溃模拟没做完的那半件事。收敛本身仍由真 ext-ipc recoveryOpts 完成。
 */
function makeLockHolderDead() {
  const lockFile = join(root(), "ext-tx", "tx.lock")
  if (!existsSync(lockFile)) return false
  const holder = JSON.parse(readFileSync(lockFile, "utf8")) as { pid: number }
  if (deadPid === 0) {
    // 找一个确定不存在的 pid(向上探,直到 kill(pid,0) 报 ESRCH)。
    for (let candidate = 999_000; candidate < 999_400; candidate++) {
      try {
        process.kill(candidate, 0)
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ESRCH") {
          deadPid = candidate
          break
        }
      }
    }
    if (deadPid === 0) throw new Error("could not find a dead pid to simulate process death")
  }
  writeFileSync(lockFile, `${JSON.stringify({ ...holder, pid: deadPid }, null, 2)}\n`)
  return true
}

type Ledger = {
  v?: number
  records?: Array<{ kind: string; name: string }>
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

const configText = () => {
  try {
    return readFileSync(join(root(), "alpha.jsonc"), "utf8")
  } catch {
    return ""
  }
}

const secretVersions = () => {
  try {
    return readdirSync(join(userData, "alpha-mcp-secrets", "generic-bundle-remote"))
  } catch {
    return []
  }
}

/**
 * 盘面的**九个**观测点。「全旧或全新」= 这九个要么全是 absent 的那一套,要么全是 present 的
 * 那一套;任何混合都是半装包。返回布尔向量而不是一个聚合判断 —— 失败信息要指得出是哪一格。
 */
function diskFacts() {
  const state = ledger()
  const recordKey = (kind: string, name: string) =>
    (state.records ?? []).some((record) => record.kind === kind && record.name === name)
  return {
    agentFile: existsSync(join(root(), "agents", "generic-bundle-agent.md")),
    agentConfigLeaf: configText().includes('"generic-bundle-agent"'),
    skillGeneration: existsSync(join(root(), "ext-store", "skill--generic-bundle-skill", "current.json")),
    mcpConfigLeaf: configText().includes('"generic-bundle-remote"'),
    agentRecord: recordKey("agent", "generic-bundle-agent"),
    skillRecord: recordKey("skill", "generic-bundle-skill"),
    mcpRecord: recordKey("mcp", "generic-bundle-remote"),
    packageGraph: (state.packageGraphs ?? []).length > 0,
    claims: (state.claims ?? []).length > 0,
  }
}

function expectAllOldOrAllNew(label: string) {
  const facts = diskFacts()
  const values = Object.values(facts)
  const allNew = values.every(Boolean)
  const allOld = values.every((value) => !value)
  expect(
    allNew || allOld,
    `${label}: 盘面既不是「全旧」也不是「全新」 —— ${JSON.stringify(facts)}`,
  ).toBe(true)
  if (allNew) expectCoherentInstall(label)
  return allNew ? "new" : "old"
}

/** 「全新」不只是九格都为 true —— 图、claim、record 三者必须互相指得上。 */
function expectCoherentInstall(label: string) {
  const state = ledger()
  expect(state.v, label).toBe(3)
  const graph = state.packageGraphs![0]!
  expect(graph.packageId, label).toBe(MIXED_BUNDLE_PACKAGE_ID)
  expect([graph.root.componentId, ...graph.children.map((child) => child.componentId)].sort(), label).toEqual(
    [ROOT_AGENT_ID, LEAF_MCP_ID, LEAF_SKILL_ID].sort(),
  )
  const owner = `bundle:${MIXED_BUNDLE_PACKAGE_ID}@${graph.root.manifestDigest}`
  expect(
    (state.claims ?? []).map((claim) => `${claim.kind}:${claim.name}`).sort(),
    `${label}: 每个装上的 child 都要有 claim`,
  ).toEqual(["agent:generic-bundle-agent", "mcp:generic-bundle-remote", "skill:generic-bundle-skill"])
  for (const claim of state.claims ?? [])
    expect(claim.owners, `${label}: claim 必须由这个 Bundle 持有`).toEqual([owner])
  // 「无 child-only record」:被跳过的组件绝不出现在 record / claim / 图里。
  expect((state.records ?? []).some((record) => record.name === "generic-bundle-future"), label).toBe(false)
  expect((state.claims ?? []).some((claim) => claim.name === "generic-bundle-future"), label).toBe(false)
}

// ── ① canonical mixed Bundle 的一次成功安装 ─────────────────────────────────────────────────

test("the production ext-install-catalog channel activates a mixed Bundle in one transaction and one ledger mutation", async () => {
  resetDisk()
  fixture = mixedBundleFixture()
  await assertMatchesVendoredBundleShape(fixture, (actual, expectedShape, label) =>
    expect(actual, label).toEqual(expectedShape),
  )

  const { preview: staged, result } = await installBundle("mixed-bundle-1", grants())
  const plan = staged.packageAuthorization!.plan

  // ── 确认屏:三个会装的组件 + 一个不会装的,原因逐字来自 decoder。
  expect(plan.items.filter((item) => item.included).map((item) => item.componentId)).toEqual([
    ROOT_AGENT_ID,
    LEAF_MCP_ID,
    LEAF_SKILL_ID,
  ])
  const skippedRow = plan.items.find((item) => !item.included)
  if (!skippedRow || skippedRow.included) throw new Error("授权确认屏必须带着被跳过的组件")
  expect(skippedRow.componentId).toBe(LEAF_UNSUPPORTED_ID)
  expect(skippedRow.skipReasonCode).toBe(EXPECTED_SKIP_REASON)
  // 授权集只含会装的三个 —— 没人被要求为一个不会到货的组件授权。
  expect(staged.authorization!.map((item) => item.key).sort()).toEqual([
    "agent--generic-bundle-agent",
    "mcp--generic-bundle-remote",
    "skill--generic-bundle-skill",
  ])
  // binding 逐组件:itemDigests 三个键,graphDigest 与 envelopeDigest 各不相同。
  expect(Object.keys(staged.packageAuthorization!.binding.itemDigests).sort()).toEqual(
    [ROOT_AGENT_ID, LEAF_MCP_ID, LEAF_SKILL_ID].sort(),
  )
  expect(staged.packageAuthorization!.binding.graphDigest).not.toBe(
    staged.packageAuthorization!.binding.envelopeDigest,
  )
  // 被跳过的组件**零字节**。判据是取过的 URL 集合,不是次数:preview 与确认各重验一次
  // (main 每次绑定都重读签名事实),次数会随重验轮数变,而「哪些东西被取过」不会。
  expect([...new Set(fetchedUrls)].sort()).toEqual(
    [
      ...fixture.envelope.components
        .filter((component) => component.id !== LEAF_UNSUPPORTED_ID)
        .map((component) => component.payloadRef.url),
      "https://alphacodeone.com/catalog/assets/agent.generic-bundle-agent/1.0.0/AGENT.md",
      "https://alphacodeone.com/catalog/assets/skill.generic-bundle-skill/1.0.0/SKILL.md",
    ].sort(),
  )
  expect(fetchedUrls.filter((url) => url.includes("generic-bundle-future"))).toEqual([])
  expect(payloadFetches).toBeGreaterThan(0)
  expect(assetFetches).toBeGreaterThan(0)

  expect(result).toMatchObject({ ok: true, kind: "agent", name: "generic-bundle-agent" })
  const outcome = result as { installed: string[]; skipped: Array<{ id: string; reason: string }> }
  expect(outcome.installed).toEqual([ROOT_AGENT_ID, LEAF_MCP_ID, LEAF_SKILL_ID])
  expect(outcome.skipped).toEqual([{ id: LEAF_UNSUPPORTED_ID, reason: EXPECTED_SKIP_REASON }])
  // main 内部的重载指令不过线。
  expect(Object.keys(result as object)).not.toContain("activateMcp")
  // 全新安装的 catalog MCP 默认关 ⇒ 一次 live 重载都不该发生(「无 double load」的下界)。
  expect(reloadedMcp).toEqual([])

  // ── 一次事务、一份 mutation。
  const journals = readdirSync(join(root(), "ext-tx", "journal"))
  expect(journals).toHaveLength(1)
  const journal = JSON.parse(readFileSync(join(root(), "ext-tx", "journal", journals[0]!), "utf8")) as {
    state: string
    items: Array<{ key: string; packageMutation?: unknown }>
  }
  expect(journal.state).toBe("committed")
  expect(journal.items.filter((item) => item.packageMutation !== undefined).map((item) => item.key)).toEqual([
    "agent--generic-bundle-agent",
  ])
  // 「无 double load」:一个 item key 只出现一次。
  expect(new Set(journal.items.map((item) => item.key)).size).toBe(journal.items.length)

  expectCoherentInstall("mixed bundle install")
  expect(diskFacts()).toEqual({
    agentFile: true,
    agentConfigLeaf: true,
    skillGeneration: true,
    mcpConfigLeaf: true,
    agentRecord: true,
    skillRecord: true,
    mcpRecord: true,
    packageGraph: true,
    claims: true,
  })

  // 密钥:一个版本目录、明文只在那一个 0600 文件里,config 只引用它。
  expect(secretVersions()).toHaveLength(1)
  const secretFile = join(userData, "alpha-mcp-secrets", "generic-bundle-remote", secretVersions()[0]!, "C_TOKEN")
  expect(readFileSync(secretFile, "utf8")).toBe(secretCanary)
  expect(configText()).toContain(`{file:${secretFile}}`)
  expect(configText()).not.toContain(secretCanary)
  expect(JSON.stringify(result)).not.toContain(secretCanary)
  expect(logLines.join("\n")).not.toContain(secretCanary)

  // ── §4.3 闸 ③:三个面对同一个被跳过的组件给出**逐字相同**的原因。
  //
  // 三个值分别来自三条独立的生产路径:详情页读的是 `ext-remote-catalog` 投影出来的安全视图,
  // 确认屏读的是 admission 的 plan preview,收据读的是引擎写在盘上的 Bundle 授权收据。
  // 断言的不是「都非空」,是**同一个字符串**,而且还要等于 decoder 的那个 token —— 只比较三者
  // 相等的话,三处一起变成 `""` 仍然全绿。
  const browse = (await handlers.get("ext-remote-catalog")!({ sender: { id: 1 } })) as {
    catalog: { packages: Array<{ catalogId: string; components: Array<{ componentId: string; skipReasonCode: string | null }> }> }
  }
  const safeViewLeaf = browse.catalog.packages
    .find((view) => view.catalogId === MIXED_BUNDLE_PACKAGE_ID)!
    .components.find((component) => component.componentId === LEAF_UNSUPPORTED_ID)!
  const skippedKey = `skipped--${createHash("sha256").update(LEAF_UNSUPPORTED_ID).digest("hex").slice(0, 24)}`
  const receipt = readBundleAuthorizationReceipt(root(), journals[0]!.replace(".json", ""))
  expect(receipt, "Bundle 授权收据必须落盘").not.toBeNull()

  const faces = {
    safeView: safeViewLeaf.skipReasonCode,
    confirmScreen: skippedRow.skipReasonCode,
    receipt: receipt!.skippedOptional.find((entry) => entry.key === skippedKey)?.reason,
  }
  expect(faces).toEqual({
    safeView: EXPECTED_SKIP_REASON,
    confirmScreen: EXPECTED_SKIP_REASON,
    receipt: EXPECTED_SKIP_REASON,
  })
  // 收据里只该有这一条被跳过的组件(会装的三个都不该混进 skippedOptional)。
  expect(receipt!.skippedOptional).toEqual([{ key: skippedKey, reason: EXPECTED_SKIP_REASON }])
  // 计划面与收据面同源:引擎落的就是 admission 交上去的那份。
  expect(lastPlan?.skippedOptional).toEqual(receipt!.skippedOptional)
})

// ── ② 具名 fault:download / secret / config / probe / receipt ────────────────────────────────

test("named production faults leave the disk entirely old", async () => {
  // download —— 签名资产取不到。
  resetDisk()
  fixture = mixedBundleFixture()
  failAssetUrlContaining = "SKILL.md"
  const download = await installBundle("mixed-bundle-download", grants())
  expect(download.result).toMatchObject({ ok: false })
  expect(expectAllOldOrAllNew("download fault")).toBe("old")

  // secret populate —— 版本目录认领不下来(授权终闸之后、任何 live switch 之前)。
  // 到达方式是「该是目录的位置上是一个普通文件」:`claimMcpSecretVersionDir` 的 `ensureRealDir`
  // 因此拒绝。用它而不是 chmod:目录权限对目录所有者不总是拦得住(实测 0500 仍能建子目录),
  // 那种夹具会安静地变成「什么都没注入」。
  resetDisk()
  fixture = mixedBundleFixture()
  mkdirSync(join(userData, "alpha-mcp-secrets"), { recursive: true })
  writeFileSync(join(userData, "alpha-mcp-secrets", "generic-bundle-remote"), "not a directory\n")
  const secretFault = await installBundle("mixed-bundle-secret", grants())
  expect(secretFault.result).toMatchObject({ ok: false })
  expect(expectAllOldOrAllNew("secret populate fault")).toBe("old")
  expect(secretVersions()).toEqual([])

  // config —— live 出现一个未登记的同名 mcp 叶(锁内 precondition 拒)。
  resetDisk()
  fixture = mixedBundleFixture()
  writeFileSync(
    join(root(), "alpha.jsonc"),
    `${JSON.stringify({ mcp: { "generic-bundle-remote": { type: "remote", url: "https://hand.written/" } } }, null, 2)}\n`,
  )
  const handwritten = configText()
  const configFault = await installBundle("mixed-bundle-config", grants())
  expect(configFault.result).toMatchObject({ ok: false })
  expect(configText()).toBe(handwritten)
  expect(existsSync(join(root(), "agents", "generic-bundle-agent.md"))).toBe(false)
  expect(ledger().packageGraphs ?? []).toEqual([])

  // probe —— skill 资产的 frontmatter name 与组件名不符 ⇒ pre-switch 判不健康。
  resetDisk()
  fixture = mixedBundleFixture({ breakSkillFrontmatterName: true })
  const probeFault = await installBundle("mixed-bundle-probe", grants())
  expect(probeFault.result).toMatchObject({ ok: false })
  expect(expectAllOldOrAllNew("probe fault")).toBe("old")

  // receipt —— 账本提交接缝抛错。事务不得把它当成功;盘面收敛后仍是全旧或全新。
  resetDisk()
  fixture = mixedBundleFixture()
  failLedgerCommitOnce = true
  const receiptFault = await installBundle("mixed-bundle-receipt", grants())
  expect(receiptFault.result).toMatchObject({ ok: false })
  // 触发一次生产恢复(任何受闸写通道都会先经 recoveryGate)。
  await preview("mixed-bundle-receipt-recover")
  expectAllOldOrAllNew("ledger commit fault")
})

// ── ③ 全部 TX_CRASH_POINTS ────────────────────────────────────────────────────────────────────

test("every TX_CRASH_POINT converges through the real ext-ipc recovery to all-old or all-new", async () => {
  const points = realTransactionModule.TX_CRASH_POINTS
  expect(points.length).toBeGreaterThan(10)
  const outcomes: Record<string, string> = {}
  const fired: string[] = []
  for (const point of points) {
    resetDisk()
    fixture = mixedBundleFixture()
    crashAt = point
    const crashed = await installBundle(`mixed-bundle-crash-${point}`, grants()).catch((error) => ({
      preview: undefined,
      result: { ok: false, reason: String(error) },
    }))
    crashAt = undefined
    // 注入是否真的生效:调用没返回成功,且锁**仍被持有**(crashAt 刻意不做任何清理,这正是
    // 进程猝死的样子)。判据放在锁上而不是 journal 上 —— 第一个点 `after-lock` 早于 journal,
    // 拿 journal 判会把「崩得更早」误报成「没崩」。
    const injected = (crashed.result as { ok?: unknown }).ok !== true
    if (injected) {
      expect(makeLockHolderDead(), `crash at ${point}: 崩溃后锁应当仍被持有`).toBe(true)
      fired.push(point)
    }
    // 生产恢复:下一次任何受闸写通道调用都先经 recoveryGate.withRecoveredWrite(真 recoveryOpts)。
    await preview(`mixed-bundle-crash-${point}-recover`)
    outcomes[point] = expectAllOldOrAllNew(`crash at ${point}`)
    // 无 secret orphan:密钥版本目录要么零个(全旧),要么恰好一个且被 live config 引用(全新)。
    const versions = secretVersions()
    if (outcomes[point] === "old") expect(versions, `crash at ${point}: secret orphan`).toEqual([])
    else {
      expect(versions, `crash at ${point}`).toHaveLength(1)
      expect(configText()).toContain(join(userData, "alpha-mcp-secrets", "generic-bundle-remote", versions[0]!, "C_TOKEN"))
    }
    expect(logLines.join("\n"), `crash at ${point}: 明文不得进日志`).not.toContain(secretCanary)
  }
  // 两端都要真的出现过 —— 全是 "old" 说明注入根本没跑到提交,全是 "new" 说明崩溃没生效。
  expect(new Set(Object.values(outcomes)), JSON.stringify(outcomes)).toEqual(new Set(["old", "new"]))
  // 哪些点**没**在这张计划上生效,要显式点名,不能默默当成「都测过了」。
  // `mid-materialize` 只在 `journal.items[0]` 本身是 generation 时才抛(materialize 循环对非
  // generation item 先 `continue`),而 canonical mixed Bundle 的第一条 item 是 agent 的 file
  // action。这是引擎的结构事实,不是本用例的取舍;将来它变得可达(或某个现在会生效的点悄悄
  // 不生效了),下面这条就会红。
  expect(
    points.filter((point) => !fired.includes(point)),
    "在这张计划上未生效的崩溃点必须逐个具名",
  ).toEqual(["mid-materialize"])
}, 300_000)
