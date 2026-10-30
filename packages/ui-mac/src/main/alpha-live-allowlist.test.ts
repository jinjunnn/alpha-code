// REQ-127 #681:catalog LKG(文件桥)+ 平台段唯一投影的单测。
//
// 契约:
//   · 读侧 fail-open —— 缺失 / 坏 JSON / 形状不对 / **旧 V1/V2 形状** / 任一行 pair 不可信 一律 null,
//     平台段为空且不声称任何价格(`#1556` AC1:不再回退随包清单);
//   · 写侧与读侧**共用同一个校验函数** —— 校验不过直接不写,合法 LKG 不被覆盖;
//   · 投影的每个字段都取自快照(`#1556`:名称 / 品牌 / 能力 / 档位随 V3 `display` 进快照)。

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
    {
      id: "deepseek-v4-flash",
      provider: "deepseek",
      minPlan: "free",
      pricing: { input: 1, output: 1 },
      display: { name: "DeepSeek V4 Flash", brand: "deepseek" },
    },
    {
      id: "claude-sonnet-5",
      provider: "anthropic",
      minPlan: "member",
      pricing: { input: 21.4, output: 53.6 },
      display: { name: "Claude Sonnet 5", brand: "anthropic", web: true },
    },
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
  test("无缓存 → null(平台段为空)", () => {
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
      // `#1556`:V2 时代的 LKG 没有 display —— 读回即无效,平台段如实为空,直到下一次 V3 刷新。
      (s) => delete (s.models[0] as Partial<CatalogSnapshot["models"][number]>).display,
      (s) => (s.models[0]!.display = { name: "", brand: "deepseek" }),
      (s) => (s.models[0]!.display = { name: "x", brand: "deepseek", variants: { 高: "high" } as never }),
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

describe("projectPlatformModels —— 平台段的唯一投影(`#1556` AC1:全部字段取自快照)", () => {
  test("无快照 → 平台段为空,**不声称任何价格**,也不回退任何随包清单", () => {
    expect(projectPlatformModels(null)).toEqual([])
  })

  test("清单与每个字段都以快照为准:名称 / 品牌 / 能力 / 档位取 display,价格取目录行", () => {
    const snapshot = valid()
    snapshot.models = [
      {
        id: "claude-opus-4.8",
        provider: "anthropic",
        pricing: { input: 35.7, output: 89.3 },
        display: { name: "Claude Opus 4.8", brand: "anthropic", reasoning: true, web: true, variants: { 高: { reasoning: { effort: "high" } } } },
      },
      {
        id: "qwen3.7-max",
        provider: "openrouter",
        pricing: { input: 10.5, output: 15.8 },
        display: { name: "Qwen3.7 Max", brand: "qwen" },
      },
    ]
    const rows = projectPlatformModels(snapshot)
    expect(rows).toEqual([
      {
        id: "claude-opus-4.8",
        name: "Claude Opus 4.8",
        brand: "anthropic",
        reasoning: true,
        web: true,
        variants: { 高: { reasoning: { effort: "high" } } },
        pricing: { input: 35.7, output: 89.3 },
      },
      // 品牌来自 display.brand,不是路由腿 provider(qwen 经 OpenRouter 路由)。逐字段全等:悄悄加回
      // 一个档位或价格轴字段(哪怕默认值)在这里就是红的(#679)。
      { id: "qwen3.7-max", name: "Qwen3.7 Max", brand: "qwen", pricing: { input: 10.5, output: 15.8 } },
    ])
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
