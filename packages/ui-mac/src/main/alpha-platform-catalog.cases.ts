// REQ-109 #595:effective catalog 的**失败域隔离**与 BYOK 主权(main 侧)。
//
// 两条退出条件在这里落闸:
//   4. live allowlist 不含某 BYOK 供应商(或平台不可达)→ 该供应商仍在目录中;
//   5. 平台目录 contract-incompatible → 本地 BYOK 仍正常返回(契约错误只上报,不阻断)。
//
// 子进程运行(alpha-platform-catalog.test.ts spawn):本模块经 alpha-auth / alpha-contract-health /
// logging 拖入 electron,mock.module 在同一进程内会泄漏到别的测试文件,故整体隔离。

import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test"
import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
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

const { fetchPlatformModels, getEffectiveCatalog } = await import("./alpha-platform-models")
const { getModelCatalog } = await import("./alpha-models")
const { writeLiveAllowlist } = await import("./alpha-live-allowlist")
const { getContractFailure } = await import("./alpha-contract-health")

const realFetch = globalThis.fetch
let userData = ""
const localByokIds = getModelCatalog().byokProviders.map((provider) => provider.id)

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
        models: [{ id: "deepseek-v4-flash" }],
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
    writeLiveAllowlist(userData, { fetchedAt: "2026-07-24T00:00:00Z", edition: "cn", models: [] })
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
    writeLiveAllowlist(userData, {
      fetchedAt: "2026-07-24T00:00:00Z",
      edition: "cn",
      models: [{ id: "deepseek-v4-flash" }],
    })
    globalThis.fetch = (async () => new Response("{ not json")) as typeof fetch
    await fetchPlatformModels()
    const effective = getEffectiveCatalog(userData)
    expect(effective.platformModels.map((model) => model.id)).toEqual(["deepseek-v4-flash"])
    expect(effective.byokProviders.map((provider) => provider.id)).toEqual(localByokIds)
  })
})
