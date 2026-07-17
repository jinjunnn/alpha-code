// REQ-103 slice 1(issue #195,父 #212 §1)—— 五维所有权:值域严格校验 + 来源映射纯函数。
// 映射表逐来源锁死:内置 catalog 快照 / signed channel / packaged seed / 本地安装(receipts),
// 以及 AC1 反塌缩(官方 authored 的条目绝不显示成 alpha authored;curated ≠ authored)。

import { describe, expect, test } from "bun:test"
import {
  decodeOwnershipDims,
  DISTRIBUTION_CHANNELS,
  ownershipFromCatalogEntry,
  ownershipFromInstall,
  ownershipFromSeedAsset,
  PARTY_ALPHA,
  PARTY_UNKNOWN,
  PARTY_USER,
  RUNTIME_SURFACES,
  runtimeSurfacesForKind,
  SUPPORT_TIERS,
  supportTierForSource,
  type OwnershipDims,
} from "./ext-ownership"

const VALID: OwnershipDims = {
  authored: "official",
  curated: "alpha",
  distributed: "engine-config",
  runtimeSurfaces: ["local-subprocess"],
  supportTier: "curated",
}

describe("decodeOwnershipDims(严格校验)", () => {
  test("合法五维通过并回读同值", () => {
    const decoded = decodeOwnershipDims(VALID)
    expect(decoded.ok).toBe(true)
    if (decoded.ok) expect(decoded.dims).toEqual(VALID)
  })

  test("未知键 loud 拒绝(严格 schema,绝不静默丢弃)", () => {
    const decoded = decodeOwnershipDims({ ...VALID, sponsor: "x" })
    expect(decoded.ok).toBe(false)
    if (!decoded.ok) expect(decoded.errors.join(";")).toContain('unknown key "sponsor"')
  })

  test.each([
    ["非对象", "nope"],
    ["distributed 越域", { ...VALID, distributed: "carrier-pigeon" }],
    ["supportTier 越域", { ...VALID, supportTier: "vip" }],
    ["runtimeSurfaces 空数组", { ...VALID, runtimeSurfaces: [] }],
    ["runtimeSurfaces 越域", { ...VALID, runtimeSurfaces: ["kernel-mode"] }],
    ["runtimeSurfaces 重复", { ...VALID, runtimeSurfaces: ["model-context", "model-context"] }],
    ["authored 空串", { ...VALID, authored: "" }],
    ["curated 超长", { ...VALID, curated: "x".repeat(65) }],
  ])("越域/畸形输入拒绝:%s", (_label, input) => {
    expect(decodeOwnershipDims(input).ok).toBe(false)
  })

  test("错误可定位(带 at 前缀路径)", () => {
    const decoded = decodeOwnershipDims({ ...VALID, supportTier: "vip" }, "manifest.ownership")
    expect(decoded.ok).toBe(false)
    if (!decoded.ok) expect(decoded.errors[0]).toStartWith("manifest.ownership.supportTier")
  })
})

describe("来源映射:catalog 条目(内置快照 bundled / signed channel remote|cache)", () => {
  test("official local MCP(内置快照)→ authored=official、curated=alpha、engine-config、local-subprocess、curated", () => {
    const dims = ownershipFromCatalogEntry(
      { type: "mcp", source: "official", installSpec: { kind: "mcp", mcpType: "local" } },
      "bundled",
    )
    expect(dims).toEqual({
      authored: "official",
      curated: PARTY_ALPHA,
      distributed: "engine-config",
      runtimeSurfaces: ["local-subprocess"],
      supportTier: "curated",
    })
  })

  test("remote MCP → runtimeSurfaces=[remote-service](分发责任仍是 engine-config:MCP 无字节分发)", () => {
    const dims = ownershipFromCatalogEntry({ type: "mcp", source: "community", installSpec: { kind: "mcp", mcpType: "remote" } }, "remote")
    expect(dims.runtimeSurfaces).toEqual(["remote-service"])
    expect(dims.distributed).toBe("engine-config")
    expect(dims.supportTier).toBe("community")
  })

  test("community skill + remoteAsset(signed channel)→ remote-catalog / model-context", () => {
    const dims = ownershipFromCatalogEntry({ type: "skill", source: "community", remoteAsset: { files: [] } }, "remote")
    expect(dims.distributed).toBe("remote-catalog")
    expect(dims.runtimeSurfaces).toEqual(["model-context"])
  })

  test("alpha builtin skill → bundled / supportTier=alpha", () => {
    const dims = ownershipFromCatalogEntry({ type: "skill", source: "alpha", installSpec: { kind: "skill", source: "builtin" } }, "cache")
    expect(dims.distributed).toBe("bundled")
    expect(dims.supportTier).toBe("alpha")
  })

  test("plugin:vendored 资产 → bundled;无资产 → npm;运行面恒 engine-process", () => {
    const vendored = ownershipFromCatalogEntry({ type: "plugin", source: "community", installSpec: { kind: "plugin", vendoredAssetKey: "k" } }, "remote")
    const npm = ownershipFromCatalogEntry({ type: "plugin", source: "community", installSpec: { kind: "plugin" } }, "remote")
    expect(vendored.distributed).toBe("bundled")
    expect(npm.distributed).toBe("npm")
    expect(vendored.runtimeSurfaces).toEqual(["engine-process"])
  })

  test("cloud → distributed=cloud / cloud-pipeline", () => {
    const dims = ownershipFromCatalogEntry({ type: "cloud", source: "alpha" }, "remote")
    expect(dims.distributed).toBe("cloud")
    expect(dims.runtimeSurfaces).toEqual(["cloud-pipeline"])
  })

  test("skill 无 installSpec.source:通道兜底 —— 内置快照=bundled,signed channel=remote-catalog", () => {
    expect(ownershipFromCatalogEntry({ type: "skill", source: "alpha" }, "bundled").distributed).toBe("bundled")
    expect(ownershipFromCatalogEntry({ type: "skill", source: "alpha" }, "remote").distributed).toBe("remote-catalog")
  })

  test("AC1 反塌缩:非 alpha 来源的条目 authored 绝不是 alpha(curated 恒 alpha ≠ authored)", () => {
    for (const source of ["official", "community", "user"]) {
      const dims = ownershipFromCatalogEntry({ type: "mcp", source, installSpec: { kind: "mcp", mcpType: "local" } }, "remote")
      expect(dims.authored).toBe(source)
      expect(dims.authored).not.toBe(PARTY_ALPHA)
      expect(dims.curated).toBe(PARTY_ALPHA)
    }
  })
})

describe("来源映射:packaged seed(REQ-102)", () => {
  test("official seed 资产 → authored=official、curated=alpha、bundled、curated tier", () => {
    expect(ownershipFromSeedAsset({ type: "mcp", source: "official" })).toEqual({
      authored: "official",
      curated: PARTY_ALPHA,
      distributed: "bundled",
      runtimeSurfaces: ["local-subprocess"],
      supportTier: "curated",
    })
  })

  test("alpha seed skill → supportTier=alpha / model-context", () => {
    const dims = ownershipFromSeedAsset({ type: "skill", source: "alpha" })
    expect(dims.supportTier).toBe("alpha")
    expect(dims.runtimeSurfaces).toEqual(["model-context"])
  })
})

describe("来源映射:本地安装(receipts/records)", () => {
  test("catalog 安装且条目仍可解析 → 与浏览面同一推导(不各推一套)", () => {
    const entry = { type: "skill", source: "community", remoteAsset: { files: [] } }
    const viaInstall = ownershipFromInstall({ id: "skill:x", kind: "skill", origin: "catalog" }, { entry, channel: "remote" })
    expect(viaInstall).toEqual(ownershipFromCatalogEntry(entry, "remote"))
  })

  test("catalog 安装但条目已从 catalog 消失 → 如实降级:authored=unknown、tier=user、curated 保留 alpha", () => {
    const dims = ownershipFromInstall({ id: "mcp:gone", kind: "mcp", origin: "catalog" })
    expect(dims.authored).toBe(PARTY_UNKNOWN)
    expect(dims.curated).toBe(PARTY_ALPHA)
    expect(dims.supportTier).toBe("user")
    expect(dims.distributed).toBe("engine-config")
    expect(dims.runtimeSurfaces).toEqual(["local-subprocess"])
  })

  test("created(自定义 MCP)→ authored=curated=user、engine-config、tier=user", () => {
    expect(ownershipFromInstall({ id: "user:my-mcp", kind: "mcp", origin: "created" })).toEqual({
      authored: PARTY_USER,
      curated: PARTY_USER,
      distributed: "engine-config",
      runtimeSurfaces: ["local-subprocess"],
      supportTier: "user",
    })
  })

  test("imported npm plugin → distributed=npm;imported-claude skill → local-import", () => {
    expect(ownershipFromInstall({ id: "user:p", kind: "plugin", origin: "imported" }).distributed).toBe("npm")
    expect(ownershipFromInstall({ id: "user:s", kind: "skill", origin: "imported-claude" }).distributed).toBe("local-import")
  })

  test("全部来源映射的产物都过严格校验(值域闭环)", () => {
    const all: OwnershipDims[] = [
      ownershipFromCatalogEntry({ type: "bundle", source: "alpha" }, "bundled"),
      ownershipFromSeedAsset({ type: "plugin", source: "community" }),
      ownershipFromInstall({ id: "user:a", kind: "agent", origin: "imported-agents" }),
      ownershipFromInstall({ id: "cloud:gone", kind: "cloud", origin: "catalog" }),
    ]
    for (const dims of all) expect(decodeOwnershipDims(dims).ok).toBe(true)
  })
})

describe("值域与 kind 级推导", () => {
  test("枚举显式且互不重叠(#212 §1)", () => {
    expect([...RUNTIME_SURFACES]).toEqual(["engine-process", "local-subprocess", "remote-service", "model-context", "cloud-pipeline"])
    expect([...SUPPORT_TIERS]).toEqual(["alpha", "curated", "community", "user"])
    expect([...DISTRIBUTION_CHANNELS]).toEqual(["bundled", "remote-catalog", "npm", "engine-config", "cloud", "local-import"])
  })

  test("supportTierForSource:未知来源兜底 user(不向上猜)", () => {
    expect(supportTierForSource(undefined)).toBe("user")
    expect(supportTierForSource("somebody")).toBe("user")
  })

  test("runtimeSurfacesForKind:command/未知 kind 兜底 model-context", () => {
    expect(runtimeSurfacesForKind("command")).toEqual(["model-context"])
    expect(runtimeSurfacesForKind("mcp", { mcpType: "remote" })).toEqual(["remote-service"])
  })
})
