// REQ-127 #681:catalog LKG(文件桥)+ 平台段唯一投影的单测。
//
// 契约:
//   · 读侧 fail-open —— 缺失 / 坏 JSON / 形状不对 / **旧 V1 形状** / 任一行 pair 不可信 一律 null,
//     调用方回退内置 snapshot 且不声称任何价格;
//   · 写侧与读侧**共用同一个校验函数** —— 校验不过直接不写,合法 LKG 不被覆盖;
//   · 投影里远端字段(id / pricing)本地覆盖不了。

import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import * as fs from "node:fs"
import * as os from "node:os"
import * as path from "node:path"
import {
  isTrustedPair,
  isValidCatalogSnapshot,
  liveAllowlistPath,
  projectPlatformModels,
  readCatalogSnapshot,
  writeCatalogSnapshot,
  type CatalogSnapshot,
} from "./alpha-live-allowlist"
import type { PlatformModel } from "../shared/alpha-model-types"

let tmp = ""
beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "alpha-catalog-snapshot-"))
})
afterEach(() => {
  fs.rmSync(tmp, { recursive: true, force: true })
})

const valid = (): CatalogSnapshot => ({
  fetchedAt: "2026-07-29T00:00:00Z",
  edition: "cn",
  pricingBasisModelId: "deepseek-v4-flash",
  models: [
    { id: "deepseek-v4-flash", provider: "deepseek", minPlan: "free", pricing: { input: 1, output: 1 } },
    { id: "claude-sonnet-5", provider: "anthropic", minPlan: "member", pricing: { input: 21.4, output: 53.6 } },
  ],
})

describe("isTrustedPair", () => {
  test("有限、正、落在 0.1 网格上的 pair 才可信", () => {
    expect(isTrustedPair({ input: 1, output: 1 })).toBe(true)
    expect(isTrustedPair({ input: 71.4, output: 178.6 })).toBe(true)
    // ⚠️ 1.0 与 1 在 JSON 解码后是同一个 number,本判据区分不了 —— 它只证明「落在 0.1 网格」。
    expect(isTrustedPair({ input: 1.0, output: 1 })).toBe(true)
    expect(isTrustedPair({ input: 1.05, output: 1 })).toBe(false)
    expect(isTrustedPair({ input: 0, output: 1 })).toBe(false)
    expect(isTrustedPair({ input: -1, output: 1 })).toBe(false)
    expect(isTrustedPair({ input: Number.NaN, output: 1 })).toBe(false)
    expect(isTrustedPair({ input: Number.POSITIVE_INFINITY, output: 1 })).toBe(false)
    expect(isTrustedPair({ input: "1", output: 1 })).toBe(false)
    expect(isTrustedPair({ input: 1 })).toBe(false)
    expect(isTrustedPair(null)).toBe(false)
  })
})

describe("readCatalogSnapshot — fail-open 读侧", () => {
  test("无缓存 → null(回退内置 snapshot)", () => {
    expect(readCatalogSnapshot(tmp)).toBeNull()
  })

  test("坏 JSON → null,不 throw", () => {
    fs.writeFileSync(liveAllowlistPath(tmp), "{nope")
    expect(readCatalogSnapshot(tmp)).toBeNull()
  })

  test("旧 V1 缓存(无 basis、无逐行 pair)→ null:不迁移、不当 last-known-good", () => {
    fs.writeFileSync(
      liveAllowlistPath(tmp),
      JSON.stringify({ fetchedAt: "2026-07-24T00:00:00Z", edition: "cn", models: [{ id: "deepseek-v4-flash" }] }),
    )
    expect(readCatalogSnapshot(tmp)).toBeNull()
  })

  test("单行 pair 不可信 / basis 空 / models 空 → 整份判无效(不逐行降级)", () => {
    const cases: Array<(s: CatalogSnapshot) => void> = [
      (s) => (s.models[1]!.pricing = { input: 0, output: 1 }),
      (s) => (s.models[1]!.pricing = { input: 1.05, output: 1 }),
      (s) => (s.pricingBasisModelId = ""),
      (s) => (s.models = []),
      (s) => (s.fetchedAt = ""),
    ]
    for (const mutate of cases) {
      const snapshot = valid()
      mutate(snapshot)
      fs.writeFileSync(liveAllowlistPath(tmp), JSON.stringify(snapshot))
      expect(readCatalogSnapshot(tmp), JSON.stringify(snapshot)).toBeNull()
    }
  })
})

describe("write → read 回路(写侧与读侧共用同一个校验函数)", () => {
  test("roundtrip 保真(edition / basis / 逐行 pair 原值)", () => {
    expect(writeCatalogSnapshot(tmp, valid())).toBe(true)
    const back = readCatalogSnapshot(tmp)!
    expect(back.edition).toBe("cn")
    expect(back.pricingBasisModelId).toBe("deepseek-v4-flash")
    expect(back.models.map((m) => m.id)).toEqual(["deepseek-v4-flash", "claude-sonnet-5"])
    expect(back.models[1]!.pricing).toEqual({ input: 21.4, output: 53.6 })
  })

  test("**合法但空**的目录不得覆盖已有 LKG —— 写侧拒绝,磁盘字节一字不变", () => {
    writeCatalogSnapshot(tmp, valid())
    const before = fs.readFileSync(liveAllowlistPath(tmp))
    const empty = { ...valid(), models: [] }
    expect(writeCatalogSnapshot(tmp, empty)).toBe(false)
    expect(fs.readFileSync(liveAllowlistPath(tmp)).equals(before)).toBe(true)
    expect(readCatalogSnapshot(tmp)!.models.length).toBe(2)
  })

  test("任一行 pair 不可信同样不落盘(读侧才发现就已经晚了)", () => {
    writeCatalogSnapshot(tmp, valid())
    const before = fs.readFileSync(liveAllowlistPath(tmp))
    const bad = valid()
    bad.models[0]!.pricing = { input: 1.05, output: 1 }
    expect(writeCatalogSnapshot(tmp, bad)).toBe(false)
    expect(fs.readFileSync(liveAllowlistPath(tmp)).equals(before)).toBe(true)
  })

  // REQ-109 #595:BYOK 白名单已撤销 —— 写侧不产出该字段。
  test("#595:写出的快照不含任何 BYOK 策略字段", () => {
    writeCatalogSnapshot(tmp, valid())
    expect(Object.keys(JSON.parse(fs.readFileSync(liveAllowlistPath(tmp), "utf8")))).not.toContain("byokProviders")
  })

  test("写入是原子的:目录里不留 tmp 残片", () => {
    writeCatalogSnapshot(tmp, valid())
    expect(fs.readdirSync(tmp)).toEqual(["alpha-live-models.json"])
  })
})

describe("projectPlatformModels —— 平台段的唯一投影", () => {
  const local: PlatformModel[] = [
    { id: "deepseek-v4-flash", name: "DeepSeek V4 Flash" },
    { id: "claude-opus-4.8", name: "Claude Opus 4.8", reasoning: true, variants: { 高: { x: 1 } } },
  ]

  test("无快照 → 原样本地目录,且**不声称任何价格**", () => {
    const rows = projectPlatformModels(local, null)
    expect(rows.map((m) => m.id)).toEqual(["deepseek-v4-flash", "claude-opus-4.8"])
    expect(rows.every((m) => m.pricing === undefined)).toBe(true)
  })

  test("远端 authority:本地永远覆盖不了 pricing", () => {
    const snapshot = valid()
    snapshot.models = [{ id: "deepseek-v4-flash", pricing: { input: 9.9, output: 9.9 } }]
    const [row] = projectPlatformModels(
      [{ id: "deepseek-v4-flash", name: "DeepSeek V4 Flash", pricing: { input: 1, output: 1 } }],
      snapshot,
    )
    expect(row!.pricing).toEqual({ input: 9.9, output: 9.9 })
  })

  test("清单以远端为准:已知 id 补展示元数据,未知 id 诚实降级为 id 本名但保留平台 pair", () => {
    const snapshot = valid()
    snapshot.models = [
      { id: "claude-opus-4.8", pricing: { input: 35.7, output: 89.3 } },
      { id: "brand-new-model", pricing: { input: 2.5, output: 7.5 } },
    ]
    const rows = projectPlatformModels(local, snapshot)
    expect(rows.map((m) => m.id)).toEqual(["claude-opus-4.8", "brand-new-model"])
    expect(rows[0]).toEqual({
      id: "claude-opus-4.8",
      name: "Claude Opus 4.8",
      reasoning: true,
      variants: { 高: { x: 1 } },
      pricing: { input: 35.7, output: 89.3 },
    })
    // #679:未知模型只降级 name(用 id 本名),**不再合成任何价格轴**。逐字段全等,所以
    // 悄悄加回一个档位字段(哪怕默认值)在这里就是红的。
    expect(rows[1]).toEqual({
      id: "brand-new-model",
      name: "brand-new-model",
      pricing: { input: 2.5, output: 7.5 },
    })
  })
})

describe("isValidCatalogSnapshot 是导出的单一判据(写侧/读侧引用同一个)", () => {
  test("合法快照通过;非对象、数组、null 一律不通过", () => {
    expect(isValidCatalogSnapshot(valid())).toBe(true)
    expect(isValidCatalogSnapshot(null)).toBe(false)
    expect(isValidCatalogSnapshot([valid()])).toBe(false)
    expect(isValidCatalogSnapshot("x")).toBe(false)
  })
})
