// REQ-104 #396 —— Pack 整包事实纯派生单测:体积已知/未知/零下载三分、密钥并集、运行面并集、
// 最低支持档、能力并集(与 #348 同真源)与高危优先排序、来源标注去重。纯模块直测,零 mock(仓规)。
import { describe, expect, test } from "bun:test"
import type { CatalogEntry } from "./catalog-types"
import { derivePackFacts, formatPackBytes } from "./ext-pack-facts"

const entry = (over: Partial<CatalogEntry> & { id: string; type: CatalogEntry["type"]; name: string }): CatalogEntry => ({
  displayName: over.name,
  description: "fixture",
  source: "official",
  category: "test",
  ...over,
})

const remoteAsset = (bytes: number[]) => ({
  version: "1",
  files: bytes.map((b, i) => ({ path: `f${i}`, sha256: "a".repeat(64), bytes: b, url: `https://x/${i}` })),
})

describe("derivePackFacts(#396 纯派生)", () => {
  test("体积三分:remoteAsset 求和已知;npm 插件/无资产 remote skill 未知;builtin/vendored/mcp/cloud 零下载不算未知", () => {
    const facts = derivePackFacts([
      entry({ id: "skill:a", type: "skill", name: "a", remoteAsset: remoteAsset([1024 * 1024, 512 * 1024]) }),
      entry({ id: "plugin:npm", type: "plugin", name: "npm-p", installSpec: { kind: "plugin", package: "x" } }),
      entry({ id: "plugin:v", type: "plugin", name: "vend-p", installSpec: { kind: "plugin", package: "y", vendoredAssetKey: "k" } }),
      entry({ id: "skill:b", type: "skill", name: "b", installSpec: { kind: "skill", source: "builtin", targetDir: "global" } }),
      entry({ id: "mcp:r", type: "mcp", name: "r", installSpec: { kind: "mcp", mcpType: "remote", url: "https://x" } }),
    ])
    expect(facts.knownBytes).toBe(1024 * 1024 + 512 * 1024)
    expect(facts.unknownSizeCount).toBe(1)
  })

  test("密钥并集去重保序;无密钥子项计数;运行面并集按 RUNTIME_SURFACES 序", () => {
    const facts = derivePackFacts([
      entry({ id: "mcp:a", type: "mcp", name: "a", installSpec: { kind: "mcp", mcpType: "local", command: ["x"], requiredEnvVars: ["KEY_A", "KEY_B"] } }),
      entry({ id: "mcp:b", type: "mcp", name: "b", installSpec: { kind: "mcp", mcpType: "remote", url: "https://x", requiredEnvVars: ["KEY_B"] } }),
      entry({ id: "skill:c", type: "skill", name: "c", installSpec: { kind: "skill", source: "builtin", targetDir: "global" } }),
    ])
    expect(facts.secrets).toEqual(["KEY_A", "KEY_B"])
    expect(facts.secretFreeCount).toBe(1)
    // local-subprocess(local mcp)先于 remote-service(remote mcp)与 model-context(skill)—— 枚举序。
    expect(facts.surfaces[0]).toBe("local-subprocess")
    expect(facts.surfaces).toContain("remote-service")
    expect(facts.surfaces).toContain("model-context")
  })

  test("最低支持档:official+community 混合 → community;能力并集高危优先且来源去重", () => {
    const facts = derivePackFacts([
      entry({ id: "plugin:x", type: "plugin", name: "Excel", source: "community", installSpec: { kind: "plugin", package: "x" } }),
      entry({ id: "mcp:f", type: "mcp", name: "fetch", installSpec: { kind: "mcp", mcpType: "local", command: ["uvx"] } }),
      entry({ id: "skill:s", type: "skill", name: "清洗", installSpec: { kind: "skill", source: "builtin", targetDir: "global" } }),
    ])
    expect(facts.lowestTier).toBe("community")
    // 高危(engine:plugin / process:spawn)排前,随后枚举序(prompt:context, engine:config)。
    expect(facts.caps.map((c) => c.cap)).toEqual(["engine:plugin", "process:spawn", "prompt:context", "engine:config"])
    const engineConfig = facts.caps.find((c) => c.cap === "engine:config")!
    expect(engineConfig.from).toEqual(["Excel", "fetch"])
    expect(facts.caps.find((c) => c.cap === "engine:plugin")!.from).toEqual(["Excel"])
  })

  test("空套件:全零 + 空集(不抛、不造)", () => {
    const facts = derivePackFacts([])
    expect(facts).toEqual({ knownBytes: 0, unknownSizeCount: 0, secrets: [], secretFreeCount: 0, surfaces: [], lowestTier: "alpha", caps: [] })
  })
})

describe("formatPackBytes", () => {
  test("≥1MB 一位小数;其下取整 KB;0 = 0 KB", () => {
    expect(formatPackBytes(3.2 * 1024 * 1024)).toBe("3.2 MB")
    expect(formatPackBytes(1536)).toBe("2 KB")
    expect(formatPackBytes(0)).toBe("0 KB")
  })
})
