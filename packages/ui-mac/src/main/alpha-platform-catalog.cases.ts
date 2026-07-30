// REQ-109 #595:effective catalog 的**失败域隔离**与 BYOK 主权(main 侧)。
// REQ-127 #681:同一条链上再加 V2 硬切的行为闸 —— fetch 只解 V2、LKG 只存已验证的 basis + 逐行
// pair、契约不兼容时旧 LKG 字节不变。
//
// 落闸的退出条件:
//   4. live 清单不含某 BYOK 供应商(或平台不可达)→ 该供应商仍在目录中;
//   5. 平台目录 contract-incompatible → 本地 BYOK 仍正常返回(契约错误只上报,不阻断)。
//
// 子进程运行(alpha-platform-catalog.test.ts spawn):本模块经 alpha-auth / alpha-contract-health /
// logging 拖入 electron,mock.module 在同一进程内会泄漏到别的测试文件,故整体隔离。

import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test"
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

const logger = { log: () => {}, warn: () => {}, error: () => {} }

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
  ipcMain: { handle: () => {} },
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

const { fetchPlatformModels, getEffectiveCatalog, syncLiveAllowlist } = await import("./alpha-platform-models")
const { getModelCatalog } = await import("./alpha-models")
const { liveAllowlistPath, projectPlatformModels, writeCatalogSnapshot } = await import("./alpha-live-allowlist")
const { getContractFailure } = await import("./alpha-contract-health")

const realFetch = globalThis.fetch
let userData = ""
const localByokIds = getModelCatalog().byokProviders.map((provider) => provider.id)

// #681:stub 的响应体是 producer fixture 的 `value`,**不是** fixture 文件的完整字节。
// producer fixture 是 `{kind,contract,expect,value}` 包装对象;把整个文件当响应喂给生产 decoder
// 会得到假红,而最可能的错误反应是「放松 decoder 让它绿」—— 那会亲手拆掉刚建的闸。
const PRODUCER_FIXTURE = join(
  import.meta.dir,
  "../../../alpha-contracts-consumer/vendor/alpha-platform-model-catalog/contracts/v2/fixtures/producer/model-catalog.json",
)
const catalogV2 = (): any => structuredClone(JSON.parse(readFileSync(PRODUCER_FIXTURE, "utf8")).value)
// V1 wire 同样取自**上游发布的 negative fixture**,不手写替身(同为包装对象,取 `.value`)。
const INVALID_V1_SHAPED = join(
  import.meta.dir,
  "../../../alpha-contracts-consumer/vendor/alpha-platform-model-catalog/contracts/v2/fixtures/invalid/v1-shaped-catalog.json",
)
const catalogV1 = (): any => structuredClone(JSON.parse(readFileSync(INVALID_V1_SHAPED, "utf8")).value)
const stubFetch = (body: unknown) => {
  globalThis.fetch = (async () =>
    new Response(typeof body === "string" ? body : JSON.stringify(body))) as unknown as typeof fetch
}

beforeEach(() => {
  userData = mkdtempSync(join(tmpdir(), "alpha-platform-catalog-"))
})
afterEach(() => {
  globalThis.fetch = realFetch
  rmSync(userData, { recursive: true, force: true })
})

describe("#595 退出条件 4:BYOK 目录不受 live allowlist / 平台连通性收窄", () => {
  test("live 清单只放行一个平台模型、且残留旧 BYOK 白名单字段 → 全部本地 BYOK 供应商仍在目录中", () => {
    writeFileSync(
      join(userData, "alpha-live-models.json"),
      JSON.stringify({
        fetchedAt: "2026-07-24T00:00:00Z",
        edition: "cn",
        byokProviders: ["deepseek"],
        pricingBasisModelId: "deepseek-v4-flash",
        models: [{ id: "deepseek-v4-flash", pricing: { input: 1, output: 1 } }],
      }),
    )
    const effective = getEffectiveCatalog(userData)
    expect(effective.byokProviders.map((provider) => provider.id)).toEqual(localByokIds)
    // 平台段仍按 live 清单收窄 —— 撤销只针对 BYOK 段。
    expect(effective.platformModels.map((model) => model.id)).toEqual(["deepseek-v4-flash"])
    expect(effective.liveSync.status).toBe("cache")
  })

  test("平台不可达(无缓存)→ static 视图,BYOK 目录完整", () => {
    const effective = getEffectiveCatalog(userData)
    expect(effective.liveSync.status).toBe("static")
    expect(effective.byokProviders.map((provider) => provider.id)).toEqual(localByokIds)
  })

  test("写侧不再产出 BYOK 策略字段,读回的目录仍是完整本地 BYOK", () => {
    writeCatalogSnapshot(userData, {
      fetchedAt: "2026-07-24T00:00:00Z",
      edition: "cn",
      pricingBasisModelId: "deepseek-v4-flash",
      models: [],
    })
    expect(getEffectiveCatalog(userData).byokProviders.map((provider) => provider.id)).toEqual(localByokIds)
  })
})

describe("#595 退出条件 5:平台目录契约不兼容不得阻断本地目录", () => {
  test("contract-incompatible 上报到 contract-health,但 models-catalog 仍返回本地 BYOK", async () => {
    globalThis.fetch = (async () => new Response(JSON.stringify({ schema_version: 999, data: "nope" }))) as typeof fetch
    const result = await fetchPlatformModels()
    expect(result).toEqual({ error: "contract-incompatible" })
    // 上报仍然发生(独立失败域:renderer 的 a-contract-failure 面照常亮)。
    expect(getContractFailure()?.surface).toBe("model-catalog")

    // 关键断言:此前 getEffectiveCatalog() 会 rethrow 这个错误,让整个 models-catalog IPC 失败,
    // 连本地 BYOK 一起阵亡。现在必须照常返回本地目录。
    expect(() => getEffectiveCatalog(userData)).not.toThrow()
    const effective = getEffectiveCatalog(userData)
    expect(effective.byokProviders.map((provider) => provider.id)).toEqual(localByokIds)
    expect(effective.byokProviders.every((provider) => provider.models.length > 0)).toBe(true)
    expect(effective.platformProvider.id).toBe(getModelCatalog().platformProvider.id)
  })

  test("契约不兼容后已有缓存仍可用:平台段走 last-known,BYOK 段完整", async () => {
    writeCatalogSnapshot(userData, {
      fetchedAt: "2026-07-24T00:00:00Z",
      edition: "cn",
      pricingBasisModelId: "deepseek-v4-flash",
      models: [{ id: "deepseek-v4-flash", pricing: { input: 1, output: 1 } }],
    })
    globalThis.fetch = (async () => new Response("{ not json")) as typeof fetch
    await fetchPlatformModels()
    const effective = getEffectiveCatalog(userData)
    expect(effective.platformModels.map((model) => model.id)).toEqual(["deepseek-v4-flash"])
    expect(effective.byokProviders.map((provider) => provider.id)).toEqual(localByokIds)
  })
})

// ── REQ-127 #681 / ADR-039:V2 硬切的行为闸 ────────────────────────────────────────────────
describe("#681:fetch → LKG → 投影 全程只认 ModelCatalogV2", () => {
  test("preserves basis and both multipliers for known and unknown models", async () => {
    const wire = catalogV2()
    // 一个本地 snapshot 收录的已知模型 + 一个它没听说过的新模型:两者都必须保住平台 pair。
    wire.data.push({
      id: "brand-new-model",
      object: "model",
      provider: "openrouter",
      min_plan: "member",
      pricing_multiplier: { input: 2.5, output: 7.5 },
    })
    stubFetch(wire)

    const result = await syncLiveAllowlist(userData)
    expect("error" in result).toBe(false)
    expect((result as { pricingBasisModelId: string }).pricingBasisModelId).toBe("deepseek-v4-flash")

    // 磁盘 LKG 存的是原值(不 rounding、不折叠)。
    const onDisk = JSON.parse(readFileSync(liveAllowlistPath(userData), "utf8"))
    expect(onDisk.pricingBasisModelId).toBe("deepseek-v4-flash")
    const diskById = new Map<string, unknown>(onDisk.models.map((m: any) => [m.id, m.pricing]))
    expect(diskById.get("claude-fable-5")).toEqual({ input: 71.4, output: 178.6 })
    expect(diskById.get("brand-new-model")).toEqual({ input: 2.5, output: 7.5 })

    const effective = getEffectiveCatalog(userData)
    expect(effective.pricingBasisModelId).toBe("deepseek-v4-flash")
    const rows = new Map(effective.platformModels.map((model) => [model.id, model]))
    // 已知模型:展示元数据来自本地,pricing 来自平台,逐字段全等。
    expect(rows.get("claude-opus-4.8")!.name).toBe(
      getModelCatalog().platformModels.find((m) => m.id === "claude-opus-4.8")!.name,
    )
    expect(rows.get("claude-opus-4.8")!.pricing).toEqual({ input: 35.7, output: 89.3 })
    // 未知模型:诚实降级为 id 本名,但**保留**平台 pair(不合成、不 1×)。
    expect(rows.get("brand-new-model")!.name).toBe("brand-new-model")
    expect(rows.get("brand-new-model")!.pricing).toEqual({ input: 2.5, output: 7.5 })
    expect(effective.liveSync.status).toBe("live")
  })

  test("本地永远覆盖不了远端 pricing(直测唯一投影)", () => {
    const [row] = projectPlatformModels(
      [{ id: "deepseek-v4-flash", name: "本地名", tier: "std", pricing: { input: 1, output: 1 } }],
      {
        fetchedAt: "2026-07-29T00:00:00Z",
        pricingBasisModelId: "deepseek-v4-flash",
        models: [{ id: "deepseek-v4-flash", pricing: { input: 9.9, output: 9.9 } }],
      },
    )
    expect(row!.pricing).toEqual({ input: 9.9, output: 9.9 })
  })

  test("12 行里 1 行 input:0 → 整份拒绝、LKG 不写、投影里没有任何 pricing", async () => {
    const wire = catalogV2()
    wire.data[3].pricing_multiplier.input = 0
    stubFetch(wire)

    expect(await syncLiveAllowlist(userData)).toEqual({ error: "contract-incompatible" })
    expect(getContractFailure()?.surface).toBe("model-catalog")
    expect(getContractFailure()?.expected_version).toBe(2)
    expect(() => readFileSync(liveAllowlistPath(userData), "utf8")).toThrow()

    const effective = getEffectiveCatalog(userData)
    expect(effective.pricingBasisModelId).toBeNull()
    expect(effective.platformModels.every((model) => model.pricing === undefined)).toBe(true)
    expect(effective.liveSync.status).toBe("static")
    // 失败域仍然隔离:BYOK 段完整返回。
    expect(effective.byokProviders.map((provider) => provider.id)).toEqual(localByokIds)
  })

  test("V1 wire(平台还没部署 V2)→ 整份拒绝,不回退 V1、不回退本地价格", async () => {
    stubFetch(catalogV1())
    expect(await syncLiveAllowlist(userData)).toEqual({ error: "contract-incompatible" })
    expect(getContractFailure()?.received_version).toBe(1)
    expect(getContractFailure()?.expected_version).toBe(2)
    expect(() => readFileSync(liveAllowlistPath(userData), "utf8")).toThrow()
  })

  test("contract-incompatible 时旧 LKG **字节不变**,仍给旧 pair、liveSync 仍为 cache", async () => {
    stubFetch(catalogV2())
    await syncLiveAllowlist(userData)
    const before = readFileSync(liveAllowlistPath(userData))

    stubFetch("{ not json")
    expect(await fetchPlatformModels()).toEqual({ error: "contract-incompatible" })
    expect(readFileSync(liveAllowlistPath(userData)).equals(before)).toBe(true)

    const effective = getEffectiveCatalog(userData)
    expect(effective.platformModels.find((m) => m.id === "claude-fable-5")!.pricing).toEqual({
      input: 71.4,
      output: 178.6,
    })
    expect(effective.byokProviders.map((provider) => provider.id)).toEqual(localByokIds)
  })

  test("**合法但空**的 V2(data: [])不得覆盖已有 LKG —— 磁盘字节完全不变", async () => {
    stubFetch(catalogV2())
    await syncLiveAllowlist(userData)
    const before = readFileSync(liveAllowlistPath(userData))

    const empty = catalogV2()
    empty.data = []
    stubFetch(empty)
    await syncLiveAllowlist(userData)

    expect(readFileSync(liveAllowlistPath(userData)).equals(before)).toBe(true)
    expect(getEffectiveCatalog(userData).platformModels.length).toBe(12)
  })
})
// 「sidecar 引擎配置与 IPC 投影不再分叉」的闸在 models-catalog-v2.wiring.cases.ts —— 那里从**真实**
// registerModelsIpcHandlers 出发观察,而不是直接调内部函数。
