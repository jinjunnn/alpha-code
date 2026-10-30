// REQ-127 #681 / ADR-039 §4 —— **生产 wiring** 闸门(不是 schema 存在性,不是类型检查)。
//
// 判据从真实用户入口出发:调 `registerModelsIpcHandlers`,拿它注册到 `models-catalog` 上的**那个
// handler**,让目录 fetch(`#1556` 起 V3)→ 严格 decoder → 原子 LKG → fork 前钉住 → effective projection 整条链真跑一遍,
// 再看 IPC 返回了什么。`#1555` 删掉了零调用的 `models-platform-live` IPC:刷新侧的生产入口是
// catalog-refresher 驱动的那一轮 `syncLiveAllowlist`(本文件直接驱动它,刷新器自己的触发点/单飞判据在
// catalog-refresher.cases.ts),每轮之后按生产顺序调 `pinAppliedCatalog` 模拟下一次 fork。
//
// 三件事在这里落闸:
//   1. **正向**:V3 响应经生产 IPC 后,basis 与逐行双倍数出现在 `models-catalog` 的返回里;
//   2. **反向(持久 negative gate)**:同一入口喂上一代(V2)响应 → basis 为 null、无任何 pricing、
//      contract-health 亮 model-catalog 面。把 alpha-platform-models.ts 的
//      `decodeJsonContract("ModelCatalogV3", …)` 改回上一代,本条即红 —— 那就是 ADR-039 §4 要求的
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

const logged: unknown[][] = []
const logger = {
  log: (...args: unknown[]) => logged.push(args),
  warn: (...args: unknown[]) => logged.push(args),
  error: (...args: unknown[]) => logged.push(args),
}
let endpoint = "https://gateway.test"
let accessToken: string | undefined
let identity: string | undefined

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
  resolveEndpoints: () => ({ platform: endpoint }),
}))
// `#1557`:models-ipc 现在也挂手动刷新入口(catalog-refresher),它在模块装载时就绑定 isStoredTokenExpired。
mock.module("./alpha-auth", () => ({
  getAccessToken: () => accessToken,
  getAuthIdentityTag: () => identity,
  isStoredTokenExpired: () => false,
}))

const { registerModelsIpcHandlers } = await import("./models-ipc")
const { syncLiveAllowlist } = await import("./alpha-platform-models")
const { buildAlphaModelConfig, getModelCatalog } = await import("./alpha-models")
const { liveAllowlistPath, pinAppliedCatalog } = await import("./alpha-live-allowlist")
const { getContractFailure } = await import("./alpha-contract-health")
const { registerCatalogHealthIpcHandlers } = await import("./alpha-catalog-health")
const { initAlphaEnvironment } = await import("./alpha-environment")
import type { EffectiveCatalog } from "../shared/alpha-model-types"

// buildAlphaModelConfig 经 readCustomProviderRecords → resolveAlphaGlobalRoot 解析 alpha 全局根。用 main 自己的
// composition root 冻结一份临时环境(**不是**给 process.env.ALPHA_GLOBAL_DIR 赋值 —— 那条路
// 被 alpha-environment.test.ts 的 grep 守卫按设计封死,而它封的就是「绕过 init 伪造根」)。
const envRoot = mkdtempSync(join(tmpdir(), "models-catalog-v2-env-"))
initAlphaEnvironment({ isPackaged: false, channel: "dev", appDataDir: join(envRoot, "appData"), homeDir: envRoot })

// ⚠️ stub 的响应体是 producer fixture 的 `value`,**不是** fixture 文件的完整字节:producer fixture
// 是 `{kind,contract,expect,value}` 包装对象,整份喂给生产 decoder 会得到假红。
// `#1556`:目录代际是 V3(每行带 display);文件名里的 v2 是历史名。
const PRODUCER_FIXTURE = join(
  import.meta.dir,
  "../../../alpha-contracts-consumer/vendor/alpha-platform-model-catalog/contracts/v3/fixtures/producer/model-catalog.json",
)
const catalogV3 = (): any => structuredClone(JSON.parse(readFileSync(PRODUCER_FIXTURE, "utf8")).value)
// 本仓提交给平台 cutover gate 的 consumer pin。它必须能真的**跑通生产链路**,而不只是过 schema:
// schema 表达不了「倍数落在 0.1 网格」,所以一份 5.45 这样的 pin 可以 schema 合法、被平台闸接受,
// 却被 Desktop 的 isTrustedPair 整份拒绝 —— 那时闸就是假的。下面那条用例把它当 fetch body 走完整链。
const CONSUMER_PIN = join(
  import.meta.dir,
  "../../../alpha-contracts-consumer/fixtures/consumers/alpha-code-1556/model-catalog-v3.json",
)
const consumerPin = (): any => structuredClone(JSON.parse(readFileSync(CONSUMER_PIN, "utf8")).value)
// 上一代(V2)wire 取自**上游发布的 negative fixture**(`expect: "invalid"`),不是本文件手写的替身:
// 手写别人文法的替身是本仓最贵的返工来源,能消费对方的决定就不要解释它。
// ⚠️ 同样是 `{kind,contract,expect,value}` 包装对象 —— 取 `.value` 再 stringify。
const INVALID_V2_SHAPED = join(
  import.meta.dir,
  "../../../alpha-contracts-consumer/vendor/alpha-platform-model-catalog/contracts/v3/fixtures/invalid/v2-shaped-catalog.json",
)
const catalogPrevGen = (): any => structuredClone(JSON.parse(readFileSync(INVALID_V2_SHAPED, "utf8")).value)

const realFetch = globalThis.fetch
let userData = ""
let configDir = ""
/** buildAlphaModelConfig 读的每个 env(与 alpha-models.test.ts 同款快照+还原,免得泄漏到宿主)。 */
const MANAGED = ["ALPHA_BASE_URL", "ALPHA_DEFAULT_MODEL", "ALPHA_MODELS_DISABLE", "OPENCODE_CONFIG_DIR"]
const saved: Record<string, string | undefined> = {}

const stubFetch = (body: unknown) => {
  globalThis.fetch = (async () => new Response(JSON.stringify(body))) as unknown as typeof fetch
}
/** `#1555`:刷新器跑的那一轮(含补试),之后按生产顺序在下一次 fork 前钉住已应用目录。 */
let generation = 0
const refreshThenFork = async () => {
  const result = (await syncLiveAllowlist(userData)) as Record<string, unknown>
  pinAppliedCatalog(userData, ++generation)
  return result
}
/** 真实生产入口:renderer 调 window.api.models.catalog() 时跑的就是这个 handler。 */
const invokeCatalog = () => handlers.get("models-catalog")!() as EffectiveCatalog

// ── #1084:目录刷新失败的**用户可观察出口**。 ───────────────────────────────────────────────
// 生产里 renderer 拿这个状态只有两条路,两条都必须真的送到:①挂载时 invoke
// `alpha-catalog-health`(启动那次刷新早于 renderer 存在,只有推送的话它到不了);
// ②`alpha-catalog-failure` 推送。所以下面既拿 handler、也拿一个记录 webContents.send 的假窗口。
type CatalogPush = { channel: string; payload: unknown }
const pushed: CatalogPush[] = []
const fakeWindow = {
  isDestroyed: () => false,
  webContents: { send: (channel: string, payload: unknown) => pushed.push({ channel, payload }) },
}
/** renderer 调 window.api.models.refreshHealth() 时跑的就是这个 handler。 */
// `#1556`:两条口子发的是按文档分格的汇总 { platform, byok };本文件只关平台那一格。
type Health = { platform: { code: string; at: string } | null; byok: { code: string; at: string } | null }
const invokeRefreshHealth = () => (handlers.get("alpha-catalog-health")!() as Health).platform
const lastPush = () => (pushed.filter((p) => p.channel === "alpha-catalog-failure").at(-1)?.payload as Health | undefined)?.platform

beforeEach(() => {
  endpoint = "https://gateway.test"
  accessToken = undefined
  identity = undefined
  logged.length = 0
  for (const key of MANAGED) {
    saved[key] = process.env[key]
    delete process.env[key]
  }
  userData = mkdtempSync(join(tmpdir(), "models-catalog-v2-wiring-"))
  handlers.clear()
  pushed.length = 0
  registerModelsIpcHandlers(userData)
  registerCatalogHealthIpcHandlers(() => fakeWindow as never)
  // 空 config dir(`#1392` 起自定义 provider 只来自真源文件,本闸的临时环境根下没有它)—— 隔离本闸关心的平台段。
  configDir = mkdtempSync(join(tmpdir(), "models-catalog-v2-config-"))
  process.env.OPENCODE_CONFIG_DIR = configDir
  // 平台 provider 注入的两个前置(不设它们 provider.alpha 根本不存在,反分叉断言会空绿)。
  process.env.ALPHA_BASE_URL = "https://gw.example/v1"
  mkdirSync(join(userData, "alpha-secrets"), { recursive: true })
  writeFileSync(join(userData, "alpha-secrets", "ALPHA_API_KEY"), "jwt", { mode: 0o600 })
})
afterEach(() => {
  targets.splice(0).forEach((stop) => stop())
  globalThis.fetch = realFetch
  for (const key of MANAGED) {
    if (saved[key] === undefined) delete process.env[key]
    else process.env[key] = saved[key]
  }
  for (const dir of [userData, configDir]) rmSync(dir, { recursive: true, force: true })
})

// #1500:超时只由本地 HTTP 靶站的真实延迟产生,不替换 fetch / AbortSignal / 时钟。
const targets: (() => void)[] = []
const startTarget = (fetch: (request: Request) => Response | Promise<Response>) => {
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch })
  targets.push(() => server.stop(true))
  endpoint = server.url.origin
}
const completed = () => logged.filter((entry) => entry[0] === "alpha-platform-models: request completed")
const waitFor = async (ready: () => boolean, timeoutMs = 11000) => {
  const started = Date.now()
  while (!ready()) {
    if (Date.now() - started >= timeoutMs) throw new Error("HTTP target observation timed out")
    await Bun.sleep(20)
  }
}

const engineModelIds = () => Object.keys((buildAlphaModelConfig(userData)!.provider.alpha as any).models)

describe("#681 生产 wiring:models-catalog IPC 经真实目录 decoder(`#1556` 起 V3)返回持久化投影", () => {
  test("production IPC refreshes through the V3 fetch decoder and returns the persisted projection", async () => {
    // 前提自检:刷新之前平台段没有任何价格主张(否则下面的断言可能是本地目录自带的)。
    const before = invokeCatalog()
    expect(before.pricingBasisModelId).toBeNull()
    expect(before.platformModels.every((model) => model.pricing === undefined)).toBe(true)

    stubFetch(catalogV3())
    const live = await refreshThenFork()
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
    expect(after.byokProviders.map((p) => p.id)).toEqual(getModelCatalog(userData).byokProviders.map((p) => p.id))
  })

  // 提交给平台 cutover gate 的那份 pin,必须**真的能被这台 Desktop 跑起来**。只断言它过 schema
  // 是不够的:schema 不表达「倍数落在 0.1 网格」,一份 `5.45` 的 pin 会过 decoder、过既有 pin 断言,
  // 却在生产的 isTrustedPair 上被整份拒绝 —— 平台闸于是接受了一份 Desktop 跑不动的 pin。
  // 这条把 pin 当真实响应体喂进生产入口,走完 fetch → decoder → 后置语义校验 → LKG → 投影。
  test("提交给平台 cutover gate 的 consumer pin,经生产入口跑通全链(schema 之外的语义也过)", async () => {
    stubFetch(consumerPin())
    const live = await refreshThenFork()
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

  // ── 反向闸(持久 negative gate)。把生产入口改回上一代,这条必须红。 ──────────────────────
  test("同一生产入口喂上一代(V2)响应 → 无 basis、无 pricing、contract-health 亮 model-catalog", async () => {
    stubFetch(catalogPrevGen())
    expect(await refreshThenFork()).toEqual({ error: "contract-incompatible" })

    const failure = getContractFailure()
    expect(failure?.surface).toBe("model-catalog")
    expect(failure?.expected_version).toBe(3)
    expect(failure?.received_version).toBe(2)

    // 上一代响应不得留下任何 LKG,IPC 也不得声称价格(平台段为空,`#1556` AC1)。
    expect(existsSync(liveAllowlistPath(userData))).toBe(false)
    const catalog = invokeCatalog()
    expect(catalog.pricingBasisModelId).toBeNull()
    expect(catalog.platformModels).toEqual([])
    expect(catalog.liveSync.status).toBe("static")
  })

  test("已有合法 LKG 时,一次上一代响应也不得把它降级(旧 pair 仍在,字节不变)", async () => {
    stubFetch(catalogV3())
    await refreshThenFork()
    const bytes = readFileSync(liveAllowlistPath(userData))

    stubFetch(catalogPrevGen())
    expect(await refreshThenFork()).toEqual({ error: "contract-incompatible" })
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
    stubFetch(catalogV3())
    await refreshThenFork()
    expect(engineModelIds()).toEqual(invokeCatalog().platformModels.map((m) => m.id))
    expect(engineModelIds().length).toBe(12)
  })

  test("退化态「合法但空的响应」:两侧仍逐项相等(`#1556`:两侧同为空,不回退随包清单)", async () => {
    const empty = catalogV3()
    empty.data = []
    stubFetch(empty)
    await refreshThenFork()
    expect(existsSync(liveAllowlistPath(userData))).toBe(false)
    expect(engineModelIds()).toEqual(invokeCatalog().platformModels.map((m) => m.id))
    expect(engineModelIds()).toEqual([])
  })

  test("退化态「从来没有缓存」:两侧仍逐项相等(都为空)", () => {
    expect(existsSync(liveAllowlistPath(userData))).toBe(false)
    expect(engineModelIds()).toEqual(invokeCatalog().platformModels.map((m) => m.id))
    expect(engineModelIds()).toEqual([])
  })

  test("引擎配置不携带 pricing(展示投影不进 opencode provider 契约)", async () => {
    stubFetch(catalogV3())
    await refreshThenFork()
    const models = (buildAlphaModelConfig(userData)!.provider.alpha as any).models
    expect(Object.values(models).every((m: any) => m.pricing === undefined)).toBe(true)
    // 但 variants 仍随投影下发(REQ-029 不能被本次切换弄丢)。
    expect(models["claude-opus-4.8"].variants["高"]).toEqual({ reasoning: { effort: "high" } })
  })
})

// ── #1084(#987 CHOICE=A,DECIDE #1078):平台拒绝的分类码必须到得了用户 ────────────────────
//
// 在此之前这条链的终点是 `fetchPlatformModels()` 的返回值:main/index.ts 两处 `.catch(() => {})`
// 把它扔掉,`models-platform-live`(`#1555` 已删)有 preload 桥却零 renderer 消费者 —— 目录刷新失败在产品面上
// 完全不存在。判据因此不看「函数返回了什么」,只看**renderer 拿得到什么**:renderer 侧只有
// `alpha-catalog-health`(invoke)与 `alpha-catalog-failure`(push)这两个口子。
//
// 反向验证(已实跑,#1084 退出条件):把 alpha-platform-models.ts `syncLiveAllowlist` 里
// `reportCatalogRefresh(r.error)` 那一行删掉 ⇒ 本组前两条转红(invoke 返回 null、零推送),
// 即回到「吞掉失败」的原状。第三条钉的是清空:把 `reportCatalogRefresh(null)` 删掉 ⇒ 它转红
// (横幅会永远挂着,即使目录早已刷新成功)。
describe("#1084 目录刷新失败的用户可观察出口", () => {
  const stubRejection = (status: number, body: string) => {
    globalThis.fetch = (async () => new Response(body, { status })) as unknown as typeof fetch
  }

  test("网关拒绝 ⇒ 分类码经生产入口到达 renderer 的两个口子(不是被吞掉)", async () => {
    // 响应字节照抄 alpha-platform packages/gateway/src/worker.ts 的 rateLimitRequest 拒绝体。
    stubRejection(429, '{"error":{"message":"rate limited: too many requests from this IP","code":"rate_limited"}}')
    expect(await refreshThenFork()).toEqual({ error: "rate_limited" })

    expect(invokeRefreshHealth()).toMatchObject({ code: "rate_limited" })
    expect(lastPush()).toMatchObject({ code: "rate_limited" })
  })

  test("无码的拒绝也有出口(http-<status> 同样是分类结果,不许静默)", async () => {
    stubRejection(503, "upstream is down")
    expect(await refreshThenFork()).toEqual({ error: "http-503" })
    expect(invokeRefreshHealth()).toMatchObject({ code: "http-503" })
  })

  test("契约不兼容同样进出口(main 侧「最后一次刷新结局」是单一真源)", async () => {
    stubFetch(catalogPrevGen())
    expect(await refreshThenFork()).toEqual({ error: "contract-incompatible" })
    expect(invokeRefreshHealth()).toMatchObject({ code: "contract-incompatible" })
  })

  test("下一次刷新成功 ⇒ 出口清空(横幅不许永远挂着)", async () => {
    stubRejection(429, '{"error":{"message":"rate limited","code":"rate_limited"}}')
    await refreshThenFork()
    expect(invokeRefreshHealth()).toMatchObject({ code: "rate_limited" })

    stubFetch(catalogV3())
    expect((await refreshThenFork()).error).toBeUndefined()
    expect(invokeRefreshHealth()).toBeNull()
    expect(lastPush()).toBeNull()
  })
})

describe("#1500 真实 HTTP 超时的后台补试与状态仲裁", () => {
  test("AC1:首试真实 8 秒超时先返回,后台一次补试恢复快照并清 health", async () => {
    const requests: string[] = []
    const events: string[] = []
    const first = Promise.withResolvers<Response>()
    const retry = Promise.withResolvers<Response>()
    startTarget((request) => {
      requests.push(request.method)
      events.push(`request-${requests.length}`)
      // Keep each response pending until its behavioral boundary has been observed.
      return requests.length === 1 ? first.promise : retry.promise
    })
    // `#1555`:一轮覆盖首试与补试(刷新器据此单飞);首试到期的结局在补试之前就已上报。
    const round = syncLiveAllowlist(userData)
    await waitFor(() => completed().length === 1)
    events.push("first-returned")
    expect(events).toEqual(["request-1", "first-returned"])
    expect(requests).toEqual(["GET"])
    expect(existsSync(liveAllowlistPath(userData))).toBe(false)
    expect(invokeRefreshHealth()).toMatchObject({ code: "timeout" })
    expect(lastPush()).toMatchObject({ code: "timeout" })
    first.resolve(Response.json(catalogV3()))
    await waitFor(() => requests.length === 2)
    expect(events).toEqual(["request-1", "first-returned", "request-2"])
    expect(existsSync(liveAllowlistPath(userData))).toBe(false)
    expect(invokeRefreshHealth()).toMatchObject({ code: "timeout" })
    retry.resolve(Response.json(catalogV3()))
    expect((await round).error).toBeUndefined()
    pinAppliedCatalog(userData, ++generation)
    expect(completed()).toHaveLength(2)
    expect(requests).toEqual(["GET", "GET"])
    expect(invokeCatalog().liveSync.status).toBe("live")
    expect(invokeCatalog().pricingBasisModelId).toBe("deepseek-v4-flash")
    expect(invokeCatalog().platformModels.find((model) => model.id === "claude-fable-5")?.pricing).toEqual({
      input: 71.4,
      output: 178.6,
    })
    expect(invokeRefreshHealth()).toBeNull()
    expect(lastPush()).toBeNull()
    expect(completed()[0]![1]).toEqual({
      origin: endpoint,
      path: "/v1/models",
      method: "GET",
      attempt: 1,
      durationMs: expect.any(Number),
      exception: "TimeoutError",
    })
    expect(completed()[1]![1]).toEqual({
      origin: endpoint,
      path: "/v1/models",
      method: "GET",
      attempt: 2,
      durationMs: expect.any(Number),
      status: 200,
    })
    expect(logged.flat().some((value) => value instanceof Error)).toBe(false)
    await Bun.sleep(1200)
    expect(requests).toHaveLength(2)
  }, 30000)

  test("AC2:两次真实超时后无第三次 GET,LKG 字节和本地 BYOK 保持可用", async () => {
    let delayed = false
    const requests: string[] = []
    const response = Promise.withResolvers<Response>()
    startTarget((request) => {
      if (delayed) {
        requests.push(request.method)
        return response.promise
      }
      return Response.json(catalogV3())
    })
    await refreshThenFork()
    const bytes = readFileSync(liveAllowlistPath(userData))
    const byok = structuredClone(invokeCatalog().byokProviders)
    delayed = true
    logged.length = 0
    expect(await refreshThenFork()).toEqual({ error: "timeout" })
    await waitFor(() => completed().length === 2)
    expect(completed().map((entry) => entry[1])).toEqual([
      expect.objectContaining({ attempt: 1, exception: "TimeoutError", durationMs: expect.any(Number) }),
      expect.objectContaining({ attempt: 2, exception: "TimeoutError", durationMs: expect.any(Number) }),
    ])
    response.resolve(Response.json(catalogV3()))
    await Bun.sleep(1300)
    expect(requests).toEqual(["GET", "GET"])
    expect(readFileSync(liveAllowlistPath(userData)).equals(bytes)).toBe(true)
    expect(invokeCatalog().platformModels).toHaveLength(12)
    expect(invokeCatalog().byokProviders).toEqual(byok)
    expect(byok.length).toBeGreaterThan(0)
    expect(byok.every((provider) => provider.models.length > 0)).toBe(true)
    expect(invokeRefreshHealth()).toMatchObject({ code: "timeout" })
  }, 30000)

  test("AC3:安全完成日志可计数,真实 429 样本和旧代拒绝保留原码且不补试", async () => {
    // 429 字节沿用 alpha-platform-catalog.cases.ts 的真 worker 捕获样本(原第 276–286 行)。
    const rateLimited = '{"error":{"message":"rate limited: too many requests from this IP","code":"rate_limited"}}'
    let rejected = true
    const requests: string[] = []
    startTarget((request) => {
      requests.push(request.method)
      expect(request.headers.get("authorization")).toBe("Bearer request-secret-1500")
      return rejected
        ? new Response(rateLimited, { status: 429, headers: { "set-cookie": "response-secret-1500" } })
        : Response.json(catalogPrevGen())
    })
    const origin = endpoint
    endpoint += "?token=query-secret-1500"
    accessToken = "request-secret-1500"
    expect(await refreshThenFork()).toEqual({ error: "rate_limited" })
    expect(invokeRefreshHealth()).toMatchObject({ code: "rate_limited" })
    await Bun.sleep(1200)
    expect(requests).toHaveLength(1)
    rejected = false
    expect(await refreshThenFork()).toEqual({ error: "contract-incompatible" })
    expect(invokeRefreshHealth()).toMatchObject({ code: "contract-incompatible" })
    await Bun.sleep(1200)
    expect(requests).toEqual(["GET", "GET"])
    expect(completed()).toHaveLength(2)
    expect(completed()[0]![1]).toEqual({
      origin,
      path: "/",
      method: "GET",
      attempt: 1,
      durationMs: expect.any(Number),
      status: 429,
    })
    expect(completed()[1]![1]).toEqual({
      origin,
      path: "/",
      method: "GET",
      attempt: 1,
      durationMs: expect.any(Number),
      status: 200,
      exception: expect.any(String),
    })
    for (const secret of [
      "Authorization",
      "Cookie",
      "request-secret-1500",
      "query-secret-1500",
      "response-secret-1500",
      rateLimited,
      JSON.stringify(catalogPrevGen()),
    ]) {
      expect(JSON.stringify(logged)).not.toContain(secret)
    }
  })

  for (const change of ["refresh", "account"] as const) {
    test(`AC4:补试开始前 ${change} 变化使旧轮失效,首轮按 8 秒返回`, async () => {
      identity = "account-a"
      let phase = "seed"
      const requests: number[] = []
      const newer = catalogV3()
      newer.data[0].pricing_multiplier = { input: 2, output: 3 }
      startTarget(async () => {
        if (phase === "seed") return Response.json(catalogV3())
        requests.push(Date.now())
        if (phase === "first") await Bun.sleep(8500)
        return Response.json(phase === "new" ? newer : catalogV3())
      })
      await refreshThenFork()
      phase = "first"
      logged.length = 0
      const round = syncLiveAllowlist(userData)
      await waitFor(() => completed().length === 1)
      expect(requests).toHaveLength(1)
      if (change === "refresh") {
        phase = "new"
        expect((await syncLiveAllowlist(userData)).error).toBeUndefined()
      }
      if (change === "account") identity = "account-b"
      expect(await round).toEqual({ error: "timeout" })
      const bytes = readFileSync(liveAllowlistPath(userData))
      const health = invokeRefreshHealth()
      const pushes = pushed.length
      await Bun.sleep(1400)
      expect(requests).toHaveLength(change === "refresh" ? 2 : 1)
      expect(readFileSync(liveAllowlistPath(userData)).equals(bytes)).toBe(true)
      expect(invokeRefreshHealth()).toEqual(health)
      expect(pushed).toHaveLength(pushes)
    }, 30000)
  }

  for (const race of [
    { change: "refresh", reply: "success" },
    { change: "refresh", reply: "429" },
    { change: "account", reply: "success" },
    { change: "account", reply: "旧代" },
  ] as const) {
    test(`AC4:补试在途时 ${race.change} 变化,旧 ${race.reply} 不覆盖快照或 health`, async () => {
      identity = "account-a"
      let seeded = false
      const requests: number[] = []
      const release = Promise.withResolvers<void>()
      const newer = catalogV3()
      newer.data[0].pricing_multiplier = { input: 2, output: 3 }
      startTarget(async () => {
        if (!seeded) return Response.json(catalogV3())
        requests.push(Date.now())
        const attempt = requests.length
        if (attempt === 1) await Bun.sleep(8500)
        if (attempt === 2) {
          await release.promise
          if (race.reply === "429")
            return new Response(
              '{"error":{"message":"rate limited: too many requests from this IP","code":"rate_limited"}}',
              { status: 429 },
            )
          return Response.json(race.reply === "旧代" ? catalogPrevGen() : catalogV3())
        }
        return Response.json(attempt === 3 ? newer : catalogV3())
      })
      await refreshThenFork()
      seeded = true
      logged.length = 0
      const round = syncLiveAllowlist(userData)
      await waitFor(() => completed().length === 1)
      expect(requests).toHaveLength(1)
      await waitFor(() => requests.length === 2)
      if (race.change === "refresh") expect((await syncLiveAllowlist(userData)).error).toBeUndefined()
      if (race.change === "account") identity = "account-b"
      const bytes = readFileSync(liveAllowlistPath(userData))
      const health = invokeRefreshHealth()
      const contract = getContractFailure()
      const pushes = pushed.length
      release.resolve()
      await round
      await waitFor(() => completed().length === (race.change === "refresh" ? 3 : 2))
      expect(readFileSync(liveAllowlistPath(userData)).equals(bytes)).toBe(true)
      expect(invokeRefreshHealth()).toEqual(health)
      expect(getContractFailure()).toEqual(contract)
      expect(pushed).toHaveLength(pushes)
      expect(requests).toHaveLength(race.change === "refresh" ? 3 : 2)
    }, 30000)
  }
})
