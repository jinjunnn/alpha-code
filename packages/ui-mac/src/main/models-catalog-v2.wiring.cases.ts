// REQ-127 #681 / ADR-039 §4 —— **生产 wiring** 闸门(不是 schema 存在性,不是类型检查)。
//
// 判据从真实用户入口出发:调 `registerModelsIpcHandlers`,拿它注册到 `models-catalog` /
// `models-platform-live` 上的**那两个 handler**,让 V2 fetch → 严格 decoder → 原子 LKG →
// effective projection 整条链真跑一遍,再看 IPC 返回了什么。中间函数一律不直接调。
//
// 三件事在这里落闸:
//   1. **正向**:V2 响应经生产 IPC 后,basis 与逐行双倍数出现在 `models-catalog` 的返回里;
//   2. **反向(持久 negative gate)**:同一入口喂 V1 响应 → basis 为 null、无任何 pricing、
//      contract-health 亮 model-catalog 面。把 alpha-platform-models.ts 的
//      `decodeJsonContract("ModelCatalogV2", …)` 改回 V1,本条即红 —— 那就是 ADR-039 §4 要求的
//      那次 inversion,而它是**自动化**的,不依赖谁记得手工复原一次;
//   3. **反分叉**:同一个 userData 下,sidecar 的 `buildAlphaModelConfig` 与 IPC 投影的 id 列表逐项
//      相等 —— 含「合法但空的响应」与「从来没有缓存」两种退化态。此前两侧各写一份「什么算有效缓存」,
//      空缓存时一边 0 行、一边静态 9 行。
//
// 子进程运行(models-catalog-v2.wiring.test.ts spawn):本链经 alpha-auth / alpha-contract-health /
// logging 拖入 electron,mock.module 在同一进程内会泄漏到别的测试文件。

import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test"
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

const logger = { log: () => {}, warn: () => {}, error: () => {} }

/** 生产代码注册到 ipcMain 上的 handler —— 测试只能经这里拿到它们。 */
const handlers = new Map<string, (...args: unknown[]) => unknown>()

mock.module("electron", () => ({
  app: {
    getVersion: () => "9.9.9",
    getPath: () => "/tmp",
    getName: () => "alpha-code",
    isPackaged: false,
    on: () => {},
    off: () => {},
    whenReady: () => Promise.resolve(),
  },
  BrowserWindow: class {
    isDestroyed() {
      return false
    }
    static getAllWindows() {
      return []
    }
  },
  ipcMain: {
    handle: (channel: string, handler: (...args: unknown[]) => unknown) => {
      handlers.set(channel, handler)
    },
  },
  safeStorage: {
    isEncryptionAvailable: () => false,
    encryptString: (value: string) => Buffer.from(value),
    decryptString: (value: Buffer) => value.toString("utf8"),
  },
  shell: { openExternal: async () => {} },
  utilityProcess: { fork: () => { throw new Error("unexpected utilityProcess.fork") } },
}))
mock.module("./logging", () => ({
  getLogger: () => logger,
  initLogging: () => logger,
  initCrashReporter: () => {},
  startNetLog: async () => {},
  exportDebugLogs: async () => "",
  write: () => {},
  tail: () => "",
  serverLogRoots: () => [],
  rotateServerLogs: () => {},
}))
mock.module("./alpha-endpoints", () => ({
  resolveEndpoints: () => ({ platform: "https://gateway.test" }),
}))
mock.module("./alpha-auth", () => ({ getAccessToken: () => undefined }))

const { registerModelsIpcHandlers } = await import("./models-ipc")
const { buildAlphaModelConfig, getModelCatalog } = await import("./alpha-models")
const { liveAllowlistPath } = await import("./alpha-live-allowlist")
const { getContractFailure } = await import("./alpha-contract-health")
const { initAlphaEnvironment } = await import("./alpha-environment")
import type { EffectiveCatalog } from "../shared/alpha-model-types"

// buildAlphaModelConfig 经 readUserProviderIds → alphaJsoncPath 解析 alpha 全局根。用 main 自己的
// composition root 冻结一份临时环境(**不是**给 process.env.ALPHA_GLOBAL_DIR 赋值 —— 那条路
// 被 alpha-environment.test.ts 的 grep 守卫按设计封死,而它封的就是「绕过 init 伪造根」)。
const envRoot = mkdtempSync(join(tmpdir(), "models-catalog-v2-env-"))
initAlphaEnvironment({ isPackaged: false, channel: "dev", appDataDir: join(envRoot, "appData"), homeDir: envRoot })

// ⚠️ stub 的响应体是 producer fixture 的 `value`,**不是** fixture 文件的完整字节:producer fixture
// 是 `{kind,contract,expect,value}` 包装对象,整份喂给生产 decoder 会得到假红。
const PRODUCER_FIXTURE = join(
  import.meta.dir,
  "../../../alpha-contracts-consumer/vendor/alpha-platform-model-catalog/contracts/v2/fixtures/producer/model-catalog.json",
)
const catalogV2 = (): any => structuredClone(JSON.parse(readFileSync(PRODUCER_FIXTURE, "utf8")).value)
// 本仓提交给平台 cutover gate 的 consumer pin。它必须能真的**跑通生产链路**,而不只是过 schema:
// schema 表达不了「倍数落在 0.1 网格」,所以一份 5.45 这样的 pin 可以 schema 合法、被平台闸接受,
// 却被 Desktop 的 isTrustedPair 整份拒绝 —— 那时闸就是假的。下面那条用例把它当 fetch body 走完整链。
const CONSUMER_PIN = join(
  import.meta.dir,
  "../../../alpha-contracts-consumer/fixtures/consumers/alpha-code-681/model-catalog-v2.json",
)
const consumerPin = (): any => structuredClone(JSON.parse(readFileSync(CONSUMER_PIN, "utf8")).value)
// V1 wire 取自**上游发布的 negative fixture**(`expect: "invalid"`),不是本文件手写的替身:
// 手写别人文法的替身是本仓最贵的返工来源,能消费对方的决定就不要解释它。
// ⚠️ 同样是 `{kind,contract,expect,value}` 包装对象 —— 取 `.value` 再 stringify。
const INVALID_V1_SHAPED = join(
  import.meta.dir,
  "../../../alpha-contracts-consumer/vendor/alpha-platform-model-catalog/contracts/v2/fixtures/invalid/v1-shaped-catalog.json",
)
const catalogV1 = (): any => structuredClone(JSON.parse(readFileSync(INVALID_V1_SHAPED, "utf8")).value)

const realFetch = globalThis.fetch
let userData = ""
let configDir = ""
/** buildAlphaModelConfig 读的每个 env(与 alpha-models.test.ts 同款快照+还原,免得泄漏到宿主)。 */
const MANAGED = ["ALPHA_BASE_URL", "ALPHA_DEFAULT_MODEL", "ALPHA_MODELS_DISABLE", "OPENCODE_CONFIG_DIR"]
const saved: Record<string, string | undefined> = {}

const stubFetch = (body: unknown) => {
  globalThis.fetch = (async () => new Response(JSON.stringify(body))) as unknown as typeof fetch
}
/** 真实生产入口:renderer 调 window.api.models.platformLive() 时跑的就是这个 handler。 */
const invokePlatformLive = () => handlers.get("models-platform-live")!() as Promise<Record<string, unknown>>
/** 真实生产入口:renderer 调 window.api.models.catalog() 时跑的就是这个 handler。 */
const invokeCatalog = () => handlers.get("models-catalog")!() as EffectiveCatalog

beforeEach(() => {
  for (const key of MANAGED) {
    saved[key] = process.env[key]
    delete process.env[key]
  }
  userData = mkdtempSync(join(tmpdir(), "models-catalog-v2-wiring-"))
  handlers.clear()
  registerModelsIpcHandlers(userData)
  // 空 config dir → readUserProviderIds() 看不到用户自定义 provider(隔离本闸关心的平台段)。
  configDir = mkdtempSync(join(tmpdir(), "models-catalog-v2-config-"))
  process.env.OPENCODE_CONFIG_DIR = configDir
  // 平台 provider 注入的两个前置(不设它们 provider.alpha 根本不存在,反分叉断言会空绿)。
  process.env.ALPHA_BASE_URL = "https://gw.example/v1"
  mkdirSync(join(userData, "alpha-secrets"), { recursive: true })
  writeFileSync(join(userData, "alpha-secrets", "ALPHA_API_KEY"), "jwt", { mode: 0o600 })
})
afterEach(() => {
  globalThis.fetch = realFetch
  for (const key of MANAGED) {
    if (saved[key] === undefined) delete process.env[key]
    else process.env[key] = saved[key]
  }
  for (const dir of [userData, configDir]) rmSync(dir, { recursive: true, force: true })
})

const engineModelIds = () => Object.keys((buildAlphaModelConfig(userData)!.provider.alpha as any).models)

describe("#681 生产 wiring:models-catalog IPC 经真实 V2 decoder 返回持久化投影", () => {
  test("production IPC refreshes through the V2 fetch decoder and returns the persisted projection", async () => {
    // 前提自检:刷新之前平台段没有任何价格主张(否则下面的断言可能是本地目录自带的)。
    const before = invokeCatalog()
    expect(before.pricingBasisModelId).toBeNull()
    expect(before.platformModels.every((model) => model.pricing === undefined)).toBe(true)

    stubFetch(catalogV2())
    const live = await invokePlatformLive()
    expect(live.error).toBeUndefined()
    expect(live.pricingBasisModelId).toBe("deepseek-v4-flash")

    // 落盘发生了,而且 IPC 返回的是**这份持久化快照**的投影。
    expect(existsSync(liveAllowlistPath(userData))).toBe(true)
    const after = invokeCatalog()
    expect(after.pricingBasisModelId).toBe("deepseek-v4-flash")
    expect(after.liveSync.status).toBe("live")
    const rows = new Map(after.platformModels.map((model) => [model.id, model]))
    expect(rows.size).toBe(12)
    expect(rows.get("claude-fable-5")!.pricing).toEqual({ input: 71.4, output: 178.6 })
    expect(rows.get("deepseek-v4-flash")!.pricing).toEqual({ input: 1, output: 1 })
    // 双倍数没有被折叠成一个 scalar。
    expect(after.platformModels.some((m) => m.pricing!.input !== m.pricing!.output)).toBe(true)
    // BYOK 段照旧完整(#595 失败域隔离不因代际切换退化)。
    expect(after.byokProviders.map((p) => p.id)).toEqual(getModelCatalog().byokProviders.map((p) => p.id))
  })

  // 提交给平台 cutover gate 的那份 pin,必须**真的能被这台 Desktop 跑起来**。只断言它过 schema
  // 是不够的:schema 不表达「倍数落在 0.1 网格」,一份 `5.45` 的 pin 会过 decoder、过既有 pin 断言,
  // 却在生产的 isTrustedPair 上被整份拒绝 —— 平台闸于是接受了一份 Desktop 跑不动的 pin。
  // 这条把 pin 当真实响应体喂进生产入口,走完 fetch → decoder → 后置语义校验 → LKG → 投影。
  test("提交给平台 cutover gate 的 consumer pin,经生产入口跑通全链(schema 之外的语义也过)", async () => {
    stubFetch(consumerPin())
    const live = await invokePlatformLive()
    expect(live.error, "consumer pin 被生产链路拒绝 —— 这份 pin 不能提交给平台 cutover gate").toBeUndefined()
    expect(existsSync(liveAllowlistPath(userData))).toBe(true)

    const catalog = invokeCatalog()
    expect(catalog.pricingBasisModelId).toBe("deepseek-v4-flash")
    expect(catalog.platformModels.length).toBe(12)
    // 每一行都带着平台的 pair 落到 IPC —— 少一行都说明 pin 里有生产跑不动的数据。
    expect(catalog.platformModels.every((model) => model.pricing !== undefined)).toBe(true)
    // pin 的每一行倍数逐字段原样穿过整条链(不 rounding、不折叠)。
    const wire = new Map<string, unknown>(consumerPin().data.map((m: any) => [m.id, m.pricing_multiplier]))
    for (const model of catalog.platformModels) expect(model.pricing, model.id).toEqual(wire.get(model.id))
  })

  // ── 反向闸(持久 negative gate)。把生产入口改回 V1,这条必须红。 ──────────────────────
  test("同一生产入口喂 V1 响应 → 无 basis、无 pricing、contract-health 亮 model-catalog", async () => {
    stubFetch(catalogV1())
    expect(await invokePlatformLive()).toEqual({ error: "contract-incompatible" })

    const failure = getContractFailure()
    expect(failure?.surface).toBe("model-catalog")
    expect(failure?.expected_version).toBe(2)
    expect(failure?.received_version).toBe(1)

    // V1 响应不得留下任何 LKG,IPC 也不得声称价格。
    expect(existsSync(liveAllowlistPath(userData))).toBe(false)
    const catalog = invokeCatalog()
    expect(catalog.pricingBasisModelId).toBeNull()
    expect(catalog.platformModels.every((model) => model.pricing === undefined)).toBe(true)
    expect(catalog.liveSync.status).toBe("static")
  })

  test("已有合法 LKG 时,一次 V1 响应也不得把它降级(旧 pair 仍在,字节不变)", async () => {
    stubFetch(catalogV2())
    await invokePlatformLive()
    const bytes = readFileSync(liveAllowlistPath(userData))

    stubFetch(catalogV1())
    expect(await invokePlatformLive()).toEqual({ error: "contract-incompatible" })
    expect(readFileSync(liveAllowlistPath(userData)).equals(bytes)).toBe(true)

    const catalog = invokeCatalog()
    expect(catalog.pricingBasisModelId).toBe("deepseek-v4-flash")
    expect(catalog.platformModels.find((m) => m.id === "claude-sonnet-5")!.pricing).toEqual({
      input: 21.4,
      output: 53.6,
    })
  })
})

describe("#681 反分叉:sidecar 引擎配置与 IPC 投影是同一份投影", () => {
  test("有效 LKG:两侧 id 列表逐项相等", async () => {
    stubFetch(catalogV2())
    await invokePlatformLive()
    expect(engineModelIds()).toEqual(invokeCatalog().platformModels.map((m) => m.id))
    expect(engineModelIds().length).toBe(12)
  })

  test("退化态「合法但空的响应」:两侧仍逐项相等(而不是 0 行 vs 静态全量)", async () => {
    const empty = catalogV2()
    empty.data = []
    stubFetch(empty)
    await invokePlatformLive()
    expect(existsSync(liveAllowlistPath(userData))).toBe(false)
    expect(engineModelIds()).toEqual(invokeCatalog().platformModels.map((m) => m.id))
    expect(engineModelIds().length).toBe(getModelCatalog().platformModels.length)
  })

  test("退化态「从来没有缓存」:两侧仍逐项相等", () => {
    expect(existsSync(liveAllowlistPath(userData))).toBe(false)
    expect(engineModelIds()).toEqual(invokeCatalog().platformModels.map((m) => m.id))
    expect(engineModelIds().length).toBe(getModelCatalog().platformModels.length)
  })

  test("引擎配置不携带 pricing(展示投影不进 opencode provider 契约)", async () => {
    stubFetch(catalogV2())
    await invokePlatformLive()
    const models = (buildAlphaModelConfig(userData)!.provider.alpha as any).models
    expect(Object.values(models).every((m: any) => m.pricing === undefined)).toBe(true)
    // 但 variants 仍随投影下发(REQ-029 不能被本次切换弄丢)。
    expect(models["claude-opus-4.8"].variants["高"]).toEqual({ reasoning: { effort: "high" } })
  })
})
