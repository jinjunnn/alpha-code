// REQ-109 #595:effective catalog 的**失败域隔离**与 BYOK 主权(main 侧)。
// REQ-127 #681:同一条链上再加硬切的行为闸 —— fetch 只解一代目录(`#1556` 起 V3)、LKG 只存已验证的 basis +
// 逐行 pair + display、契约不兼容时旧 LKG 字节不变。
// REQ-237 `#1556` AC1:无有效快照 ⇒ 平台段空且不声称任何价格(不再回退随包清单);AC9:已下载 ≠ 已应用时目录
// 视图里两个版本不同(picker 据此显示「将在引擎下次启动后生效」)。
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
mock.module("./alpha-auth", () => ({ getAccessToken: () => undefined, getAuthIdentityTag: () => undefined }))

const { fetchPlatformModels, getEffectiveCatalog, syncLiveAllowlist } = await import("./alpha-platform-models")
const { getModelCatalog } = await import("./alpha-models")
const { liveAllowlistPath, pinAppliedCatalog, projectPlatformModels, writeCatalogSnapshot } = await import(
  "./alpha-live-allowlist"
)
const { getContractFailure } = await import("./alpha-contract-health")

const realFetch = globalThis.fetch
let userData = ""
const localByokIds = getModelCatalog("/nonexistent-user-data").byokProviders.map((provider) => provider.id)
const BUNDLED_BYOK_VERSION = (await import("./alpha-models.json")).default.byokCatalog.catalog_version

// #681:stub 的响应体是 producer fixture 的 `value`,**不是** fixture 文件的完整字节。
// producer fixture 是 `{kind,contract,expect,value}` 包装对象;把整个文件当响应喂给生产 decoder
// 会得到假红,而最可能的错误反应是「放松 decoder 让它绿」—— 那会亲手拆掉刚建的闸。
const PRODUCER_FIXTURE = join(
  import.meta.dir,
  "../../../alpha-contracts-consumer/vendor/alpha-platform-model-catalog/contracts/v3/fixtures/producer/model-catalog.json",
)
const catalogV3 = (): any => structuredClone(JSON.parse(readFileSync(PRODUCER_FIXTURE, "utf8")).value)
// 上一代(V2)wire 同样取自**上游发布的 negative fixture**,不手写替身(同为包装对象,取 `.value`)。
const INVALID_V2_SHAPED = join(
  import.meta.dir,
  "../../../alpha-contracts-consumer/vendor/alpha-platform-model-catalog/contracts/v3/fixtures/invalid/v2-shaped-catalog.json",
)
const catalogV2 = (): any => structuredClone(JSON.parse(readFileSync(INVALID_V2_SHAPED, "utf8")).value)
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
        models: [{ id: "deepseek-v4-flash", pricing: { input: 1, output: 1 }, display: { name: "DeepSeek V4 Flash", brand: "deepseek" } }],
      }),
    )
    pinAppliedCatalog(userData, 1) // `#1555`:picker 读 fork 前钉住的已应用目录;这里模拟那次 fork
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

  // `#1556` AC1:没有有效快照 ⇒ 平台段为空、如实标 static(picker 据此显示「平台模型清单尚未获取」)、不声称任何价格。
  // 此前这一态回退随包 12 条平台模型(无价格)—— 那份随包清单就是要消灭的第二权威。
  test("`#1556` AC1:无快照 ⇒ 平台段空、basis 为 null、static,不回退任何随包清单", () => {
    for (const setup of [
      () => {},
      () => writeFileSync(join(userData, "alpha-live-models.json"), "{corrupt"),
      // V2 时代留在盘上的 LKG(没有 display):判无效,同样是「尚未获取」。
      () =>
        writeFileSync(
          join(userData, "alpha-live-models.json"),
          JSON.stringify({
            fetchedAt: "2026-10-29T00:00:00Z",
            edition: "cn",
            pricingBasisModelId: "deepseek-v4-flash",
            models: [{ id: "deepseek-v4-flash", pricing: { input: 1, output: 1 } }],
          }),
        ),
    ]) {
      setup()
      pinAppliedCatalog(userData, 1)
      const effective = getEffectiveCatalog(userData)
      expect(effective.platformModels).toEqual([])
      expect(effective.pricingBasisModelId).toBeNull()
      expect(effective.liveSync).toEqual({ status: "static" })
      expect(effective.applied.platformFetchedAt).toBeNull()
      expect(JSON.stringify(effective.platformModels)).not.toContain("pricing")
      expect(effective.byokProviders.map((provider) => provider.id)).toEqual(localByokIds)
    }
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
    expect(effective.platformProvider.id).toBe(getModelCatalog(userData).platformProvider.id)
  })

  test("契约不兼容后已有缓存仍可用:平台段走 last-known,BYOK 段完整", async () => {
    writeCatalogSnapshot(userData, {
      fetchedAt: "2026-07-24T00:00:00Z",
      edition: "cn",
      pricingBasisModelId: "deepseek-v4-flash",
      models: [{ id: "deepseek-v4-flash", pricing: { input: 1, output: 1 }, display: { name: "DeepSeek V4 Flash", brand: "deepseek" } }],
    })
    globalThis.fetch = (async () => new Response("{ not json")) as typeof fetch
    await fetchPlatformModels()
    pinAppliedCatalog(userData, 1) // `#1555`:picker 读 fork 前钉住的已应用目录;这里模拟那次 fork
    const effective = getEffectiveCatalog(userData)
    expect(effective.platformModels.map((model) => model.id)).toEqual(["deepseek-v4-flash"])
    expect(effective.byokProviders.map((provider) => provider.id)).toEqual(localByokIds)
  })
})

// ── REQ-127 #681 / ADR-039:目录硬切的行为闸(`#1556` 起 V3)────────────────────────────────────
describe("#681:fetch → LKG → 投影 全程只认 ModelCatalogV3", () => {
  test("preserves basis, both multipliers and display for existing and brand-new models", async () => {
    const wire = catalogV3()
    // 一个平台刚上线的新模型:名称 / 品牌随 display 一起到,不必等发版;平台 pair 原样保住。
    wire.data.push({
      id: "brand-new-model",
      object: "model",
      provider: "openrouter",
      min_plan: "member",
      pricing_multiplier: { input: 2.5, output: 7.5 },
      display: { name: "Brand New Model", brand: "qwen" },
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

    pinAppliedCatalog(userData, 1) // `#1555`:picker 读 fork 前钉住的已应用目录;这里模拟那次 fork
    const effective = getEffectiveCatalog(userData)
    expect(effective.pricingBasisModelId).toBe("deepseek-v4-flash")
    const rows = new Map(effective.platformModels.map((model) => [model.id, model]))
    // 每个字段都来自快照:名称 / 品牌 / 档位来自 display,pricing 来自目录行,逐字段全等(`#1556` AC1)。
    const opusWire = wire.data.find((m: any) => m.id === "claude-opus-4.8")
    expect(rows.get("claude-opus-4.8")!.name).toBe(opusWire.display.name)
    expect(rows.get("claude-opus-4.8")!.brand).toBe("anthropic")
    expect(rows.get("claude-opus-4.8")!.variants).toEqual(opusWire.display.variants)
    expect(rows.get("claude-opus-4.8")!.pricing).toEqual({ input: 35.7, output: 89.3 })
    // 品牌是 display.brand,不是路由腿 provider(qwen 经 openrouter)。
    expect(rows.get("qwen3.7-max")!.brand).toBe("qwen")
    expect(rows.get("brand-new-model")).toEqual({ id: "brand-new-model", name: "Brand New Model", brand: "qwen", pricing: { input: 2.5, output: 7.5 } })
    expect(effective.liveSync.status).toBe("live")
  })

  test("投影的 pricing 只来自快照行(直测唯一投影)", () => {
    const [row] = projectPlatformModels({
      fetchedAt: "2026-07-29T00:00:00Z",
      pricingBasisModelId: "deepseek-v4-flash",
      models: [{ id: "deepseek-v4-flash", pricing: { input: 9.9, output: 9.9 }, display: { name: "DeepSeek V4 Flash", brand: "deepseek" } }],
    })
    expect(row!.pricing).toEqual({ input: 9.9, output: 9.9 })
  })

  test("12 行里 1 行 input:0 → 整份拒绝、LKG 不写、平台段为空且没有任何 pricing", async () => {
    const wire = catalogV3()
    wire.data[3].pricing_multiplier.input = 0
    stubFetch(wire)

    expect(await syncLiveAllowlist(userData)).toEqual({ error: "contract-incompatible" })
    expect(getContractFailure()?.surface).toBe("model-catalog")
    expect(getContractFailure()?.expected_version).toBe(3)
    expect(() => readFileSync(liveAllowlistPath(userData), "utf8")).toThrow()

    const effective = getEffectiveCatalog(userData)
    expect(effective.pricingBasisModelId).toBeNull()
    expect(effective.platformModels).toEqual([])
    expect(effective.liveSync.status).toBe("static")
    // 失败域仍然隔离:BYOK 段完整返回。
    expect(effective.byokProviders.map((provider) => provider.id)).toEqual(localByokIds)
  })

  test("V2 wire(平台还没部署 V3)→ 整份拒绝,不回退 V2、不回退本地清单", async () => {
    stubFetch(catalogV2())
    expect(await syncLiveAllowlist(userData)).toEqual({ error: "contract-incompatible" })
    expect(getContractFailure()?.received_version).toBe(2)
    expect(getContractFailure()?.expected_version).toBe(3)
    expect(() => readFileSync(liveAllowlistPath(userData), "utf8")).toThrow()
  })

  test("contract-incompatible 时旧 LKG **字节不变**,仍给旧 pair、liveSync 仍为 cache", async () => {
    stubFetch(catalogV3())
    await syncLiveAllowlist(userData)
    const before = readFileSync(liveAllowlistPath(userData))

    stubFetch("{ not json")
    expect(await fetchPlatformModels()).toEqual({ error: "contract-incompatible" })
    expect(readFileSync(liveAllowlistPath(userData)).equals(before)).toBe(true)

    pinAppliedCatalog(userData, 1) // `#1555`:picker 读 fork 前钉住的已应用目录;这里模拟那次 fork
    const effective = getEffectiveCatalog(userData)
    expect(effective.platformModels.find((m) => m.id === "claude-fable-5")!.pricing).toEqual({
      input: 71.4,
      output: 178.6,
    })
    expect(effective.byokProviders.map((provider) => provider.id)).toEqual(localByokIds)
  })

  test("**合法但空**的 V3(data: [])不得覆盖已有 LKG —— 磁盘字节完全不变", async () => {
    stubFetch(catalogV3())
    await syncLiveAllowlist(userData)
    const before = readFileSync(liveAllowlistPath(userData))

    const empty = catalogV3()
    empty.data = []
    stubFetch(empty)
    await syncLiveAllowlist(userData)

    expect(readFileSync(liveAllowlistPath(userData)).equals(before)).toBe(true)
    pinAppliedCatalog(userData, 1) // `#1555`:picker 读 fork 前钉住的已应用目录;这里模拟那次 fork
    expect(getEffectiveCatalog(userData).platformModels.length).toBe(12)
  })
})
// ── ac#962:gateway 嵌套信封的分类码要穿过**生产接线**,不只是纯函数 ───────────────────────
describe("ac#962:平台拒绝的分类码穿过生产 fetchPlatformModels()", () => {
  test("429 + {error:{message,code}} ⇒ 返回那个码,不是 http-429", async () => {
    // 响应字节照抄 alpha-platform packages/gateway/src/worker.ts 的 rateLimitRequest 拒绝体
    // (本票勘破轮把真 worker 跑起来捕获到的那一份)。期望值是独立字面量,不 import 生产常量。
    globalThis.fetch = (async () =>
      new Response('{"error":{"message":"rate limited: too many requests from this IP","code":"rate_limited"}}', {
        status: 429,
      })) as unknown as typeof fetch

    // 断言的是**生产函数**的返回值:把 alpha-platform-models.ts:52 的 `await httpErrorCode(res)`
    // 换成自拼 `http-${res.status}`,platform-error-code.test.ts 那 6 条纯函数判据全绿,只有这一条红。
    expect(await fetchPlatformModels()).toEqual({ error: "rate_limited" })
  })
})
// [#1084,取代上面那条「到不了用户」的诚实标注] 分类码现在有出口了:syncLiveAllowlist 的每一条
// 出路都经 reportCatalogRefresh 落到 alpha-catalog-health,renderer 的 CatalogFailureBanner 渲染它。
// 本文件仍只断言**生产函数的返回值**(它测的是分类,不是出口);出口那一跳的闸在
// models-catalog-v2.wiring.cases.ts(main 半场)与 test-component/catalog-failure-banner.cases.ts
// (renderer 半场,真 DOM)。

// 「sidecar 引擎配置与 IPC 投影不再分叉」的闸在 models-catalog-v2.wiring.cases.ts —— 那里从**真实**
// registerModelsIpcHandlers 出发观察,而不是直接调内部函数。

// ── REQ-237 `#1555` AC5(方案 req236 §2.4):刷新成功只改「已下载」,picker 在下一次引擎换代前仍显示已应用版本 ──
// 现码(picker 直接读 LKG)上这条红:刷新一成功 picker 就变,而引擎要等下一次 fork —— 两边不是同一份。
describe("`#1555` AC5:picker 与引擎读同一份已应用目录", () => {
  test("刷新成功后 picker 仍显示已应用版本,目录视图同时带「已下载」与「已应用」两个版本", async () => {
    writeCatalogSnapshot(userData, {
      fetchedAt: "2026-07-24T00:00:00Z",
      edition: "cn",
      pricingBasisModelId: "deepseek-v4-flash",
      models: [{ id: "deepseek-v4-flash", pricing: { input: 1, output: 1 }, display: { name: "DeepSeek V4 Flash", brand: "deepseek" } }],
    })
    pinAppliedCatalog(userData, 1) // 这一代引擎 fork 时钉住的版本

    stubFetch(catalogV3())
    expect("error" in (await syncLiveAllowlist(userData))).toBe(false)
    const downloadedAt = JSON.parse(readFileSync(liveAllowlistPath(userData), "utf8")).fetchedAt
    expect(downloadedAt).not.toBe("2026-07-24T00:00:00Z")

    const before = getEffectiveCatalog(userData)
    expect(before.platformModels.map((model) => model.id)).toEqual(["deepseek-v4-flash"])
    expect(before.applied).toEqual({ platformFetchedAt: "2026-07-24T00:00:00Z", byokVersion: BUNDLED_BYOK_VERSION })
    expect(before.downloaded).toEqual({ platformFetchedAt: downloadedAt, byokVersion: BUNDLED_BYOK_VERSION })

    pinAppliedCatalog(userData, 2) // 下一次引擎换代
    const after = getEffectiveCatalog(userData)
    expect(after.platformModels).toHaveLength(12)
    expect(after.applied).toEqual(after.downloaded)
  })
})

// ── REQ-237 `#1556` AC9:BYOK 那份同样分「已下载」与「已应用」—— 下载了新版本之后 picker 视图两字段不同,
// 下一次 fork 钉住后相同。picker 据此显示「模型清单已更新,将在引擎下次启动后生效」(组件判据在
// test-component/alpha-composer-model.cases.ts)。把 getEffectiveCatalog 的 downloaded.byokVersion 改回读已应用,本条转红。
describe("`#1556` AC9:BYOK 目录的已下载 ≠ 已应用", () => {
  test("下载新版本后 picker 视图两字段不同;下一次引擎换代后相同", async () => {
    const { writeByokCatalogLkg } = await import("./alpha-live-allowlist")
    const bundled = (await import("./alpha-models.json")).default.byokCatalog
    pinAppliedCatalog(userData, 1)
    const fresh = getEffectiveCatalog(userData)
    expect(fresh.applied.byokVersion).toBe(fresh.downloaded.byokVersion)

    expect(writeByokCatalogLkg(userData, { ...structuredClone(bundled), catalog_version: bundled.catalog_version + 1 } as never)).toBe(true)
    const pending = getEffectiveCatalog(userData)
    expect(pending.applied.byokVersion).toBe(bundled.catalog_version)
    expect(pending.downloaded.byokVersion).toBe(bundled.catalog_version + 1)

    pinAppliedCatalog(userData, 2)
    const applied = getEffectiveCatalog(userData)
    expect(applied.applied).toEqual(applied.downloaded)
    expect(applied.applied.byokVersion).toBe(bundled.catalog_version + 1)
  })
})
