// brand-residue-scan — [ac#1198] REQ-139 值级品牌残留防复发闸(AC4)。
//
// 背景:REQ-139 改名轮的枚举轴是 `alpha.brand.*` 键消费者 + 身份面字面量(brand-guard.test.ts),
// 「Alpha 焊在别的键的句子里」对键名检索结构性不可见 —— 只有对**值**做词级扫描才看得见。
// 本闸的判定域 = en/zh/zht 三份 dict 的有限键值集,用 Object.entries 全量派生(单一权威,
// 不抄键清单)—— 新增「值里含旧名的键」自动被扫。零 allowlist。
//
// 丁类技术标识符(AC3:出现在文案里的 env var 名 / 文件名 / 目录名,标识本体还活着,改文案 = 失实)
// 在匹配前整 token 剥离;剥离用非词占位符防拼接歧义。坐标对照(2026-08-31 勘破):
//   ALPHA_FACTORY_SKILLS_DISABLE = src/main/factory-skills.ts:40
//   ALPHA_CLOUD_URL              = src/main/alpha-endpoints.ts:24
//   alpha-workspace              = resources/factory-skills/alpha-workspace/ 目录名
//   alpha.env                    = BYOK env 文件名(alpha-byok-env.ts)
//
// 手段自证(观测手段自己有盲区):内嵌坏样本必命中、故意不存在的针 0 命中、扫描量下限断言
// (防「跑了 0 条 = 假绿」)。变异自证记录在 PR(向 zh.ts 临时加含 Alpha 的值 → 红,还原 → 绿)。

import { describe, expect, test } from "bun:test"
import { dict as en } from "./en"
import { dict as zh } from "./zh"
import { dict as zht } from "./zht"

const TECH_TOKENS = ["ALPHA_FACTORY_SKILLS_DISABLE", "ALPHA_CLOUD_URL", "alpha-workspace", "alpha.env"] as const

// 独立词 Alpha/ALPHA/alpha;词边界 = 非 [A-Za-z0-9_](AC4 钉死的边界)
const BRAND_WORD = /(?<![A-Za-z0-9_])(?:Alpha|ALPHA|alpha)(?![A-Za-z0-9_])/

function stripTechTokens(value: string): string {
  let out = value
  for (const token of TECH_TOKENS) out = out.split(token).join("§") // 非词占位符,防止剥离后两侧拼出新词
  return out
}

function scan(dicts: Record<string, Record<string, string>>, needle: RegExp): { locale: string; key: string; value: string }[] {
  const hits: { locale: string; key: string; value: string }[] = []
  for (const [locale, dict] of Object.entries(dicts)) {
    for (const [key, value] of Object.entries(dict)) {
      if (needle.test(stripTechTokens(value))) hits.push({ locale, key, value })
    }
  }
  return hits
}

const DICTS = { en, zh, zht } as Record<string, Record<string, string>>

describe("brand residue scan gate (REQ-139 / ac#1198)", () => {
  test("扫描量下限:三份 dict 都真的被枚举了(0 条即假绿)", () => {
    expect(Object.keys(en).length).toBeGreaterThan(1000)
    expect(Object.keys(zh).length).toBeGreaterThan(1000)
    expect(Object.keys(zht).length).toBeGreaterThan(15)
  })

  test("手段自证:内嵌坏样本必命中;技术 token 剥离后不误命中", () => {
    const bad = scan({ probe: { k: "restart Alpha now" } }, BRAND_WORD)
    expect(bad).toEqual([{ locale: "probe", key: "k", value: "restart Alpha now" }])
    // 小写与全大写独立词同样命中
    expect(scan({ p: { a: "由 alpha 注入", b: "ALPHA 出品" } }, BRAND_WORD).length).toBe(2)
    // 丁类 token 剥离:含 token 的真实文案形状不红
    expect(
      scan(
        {
          p: {
            a: "可用 ALPHA_CLOUD_URL 覆盖",
            b: "已被 ALPHA_FACTORY_SKILLS_DISABLE 关闭",
            c: "按 alpha-workspace 技能的目录约定",
            d: "请在 alpha.env 中删除 {{key}}",
          },
        },
        BRAND_WORD,
      ),
    ).toEqual([])
    // 非独立词不命中(词内出现)
    expect(scan({ p: { a: "alphabetical order", b: "DeepAlpha" } }, BRAND_WORD)).toEqual([])
  })

  test("手段自证:故意不存在的针 0 命中(自证不幻觉)", () => {
    const needle = /(?<![A-Za-z0-9_])(?:Zzyzzaxx)(?![A-Za-z0-9_])/
    expect(scan(DICTS, needle)).toEqual([])
  })

  test("en/zh/zht 全部值:剥离技术 token 后,独立词 Alpha/ALPHA/alpha 零命中", () => {
    const hits = scan(DICTS, BRAND_WORD)
    const report = hits.map((h) => `[${h.locale}] ${h.key}: ${h.value}`).join("\n")
    expect(report).toBe("")
  })
})
