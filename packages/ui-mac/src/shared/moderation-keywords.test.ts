// REQ-160 AC2(`#1353`)—— 「本机匹配语义 == 服务端匹配语义」的判据。
//
// 本文件守的不是「这个函数能跑」,而是**两侧同义**。语料在 `moderation-keywords.parity.json`,
// 期望值是手写字面量(独立锚点)。三条轴:
//
//   ① 生产实现 `matchKeywords` 对整份语料逐条等于 `expect`;
//   ② 一份**逐字誊抄自权威实现**的参考匹配器对同一份语料给出与 ① 逐条相同的结果
//      —— 抓「我这份漂了」;
//   ③ 五种似是而非的错误实现,**每一种都必须被语料抓住** —— 先证明这份语料能测出已知的坏,
//      再用它判未知的好(《本机验证陷阱》总纪律)。少了 ③,一份退化成 `() => []` 的语料
//      也会让 ① ② 全绿。

import { describe, expect, test } from "bun:test"
import parity from "./moderation-keywords.parity.json"
import { matchKeywords, parseKeywordPayload, isBlockedByKeywords, type ModerationKeyword } from "./moderation-keywords"

type WireRow = { category_code: string; keyword: string }
type ParityCase = {
  name: string
  clause: string
  kills: string
  keywords: WireRow[]
  text: string
  expect: WireRow[]
}

const cases = parity.cases as ParityCase[]
const toInternal = (rows: readonly WireRow[]): ModerationKeyword[] =>
  rows.map((row) => ({ categoryCode: row.category_code, keyword: row.keyword }))
const toWire = (hits: readonly { categoryCode: string; keyword: string }[]): WireRow[] =>
  hits.map((hit) => ({ category_code: hit.categoryCode, keyword: hit.keyword }))

/**
 * 权威实现的逐字誊抄(alpha-web `lib/moderation/keywords.ts` `matchKeywords`,
 * commit `3493075965fab381cf3c82cd6637a3252b503fdb`)。**只在测试里存在**:它是交叉轴,
 * 不是第二份生产实现。誊抄会陈旧 —— 所以它不是主判据,语料的字面期望才是。
 */
function referenceMatch(
  text: string,
  keywords: readonly ModerationKeyword[],
): { categoryCode: string; keyword: string }[] {
  const haystack = text.toLowerCase()
  const hits: { categoryCode: string; keyword: string }[] = []
  for (const entry of keywords) {
    const needle = entry.keyword.trim().toLowerCase()
    if (!needle) continue
    if (!haystack.includes(needle)) continue
    hits.push({ categoryCode: entry.categoryCode, keyword: entry.keyword })
  }
  return hits
}

/** 每一种都是真实会被写出来的实现,且都只错一格。 */
const WRONG_IMPLEMENTATIONS: Record<string, (text: string, keywords: readonly ModerationKeyword[]) => WireRow[]> = {
  "把词编成正则": (text, keywords) =>
    toWire(
      keywords.filter((entry) => {
        const needle = entry.keyword.trim()
        if (!needle) return false
        try {
          return new RegExp(needle, "i").test(text)
        } catch {
          return false
        }
      }),
    ),
  "按词边界匹配": (text, keywords) =>
    toWire(
      keywords.filter((entry) => {
        const needle = entry.keyword.trim().toLowerCase()
        if (!needle) return false
        return text
          .toLowerCase()
          .split(/[^\p{L}\p{N}]+/u)
          .includes(needle)
      }),
    ),
  "顺手加 NFKC 归一": (text, keywords) =>
    toWire(
      keywords.filter((entry) => {
        const needle = entry.keyword.trim().toLowerCase().normalize("NFKC")
        if (!needle) return false
        return text.toLowerCase().normalize("NFKC").includes(needle)
      }),
    ),
  "不 trim 存储词": (text, keywords) =>
    toWire(
      keywords.filter((entry) => {
        const needle = entry.keyword.toLowerCase()
        if (!needle) return false
        return text.toLowerCase().includes(needle)
      }),
    ),
  "命中去重": (text, keywords) => {
    const seen = new Set<string>()
    const hits: WireRow[] = []
    for (const hit of matchKeywords(text, keywords)) {
      if (seen.has(hit.keyword)) continue
      seen.add(hit.keyword)
      hits.push({ category_code: hit.categoryCode, keyword: hit.keyword })
    }
    return hits
  },
}

describe("moderation keyword matching stays同义 with the server", () => {
  test("语料本身是活的:条数、字段、以及每条都声明了它杀掉哪种错误实现", () => {
    expect(cases.length).toBeGreaterThanOrEqual(20)
    for (const one of cases) {
      expect(typeof one.name).toBe("string")
      expect(one.clause.length).toBeGreaterThan(0)
      expect(one.kills.length).toBeGreaterThan(0)
      expect(Array.isArray(one.keywords)).toBe(true)
      expect(Array.isArray(one.expect)).toBe(true)
    }
    // provenance 必须在,否则「与服务端同义」这句话没有可核对的对象。
    expect(parity.authority.repo).toBe("jinjunnn/alpha-web")
    expect(parity.authority.path).toBe("lib/moderation/keywords.ts")
    expect(parity.authority.commit).toHaveLength(40)
  })

  for (const one of cases) {
    test(`① 生产实现 · ${one.name}`, () => {
      expect(toWire(matchKeywords(one.text, toInternal(one.keywords)))).toEqual(one.expect)
    })
  }

  test("② 逐字誊抄的权威实现,对整份语料与生产实现逐条相同", () => {
    for (const one of cases) {
      const keywords = toInternal(one.keywords)
      expect(toWire(referenceMatch(one.text, keywords))).toEqual(toWire(matchKeywords(one.text, keywords)))
    }
  })

  test("③ 先证明这份语料能测出已知的坏:五种错误实现,每一种都被至少一条用例抓住", () => {
    for (const [label, wrong] of Object.entries(WRONG_IMPLEMENTATIONS)) {
      const caught = cases.filter((one) => {
        let produced: WireRow[]
        try {
          produced = wrong(one.text, toInternal(one.keywords))
        } catch {
          return true
        }
        return JSON.stringify(produced) !== JSON.stringify(one.expect)
      })
      expect({ label, caughtBy: caught.map((one) => one.name) }).toMatchObject({ label })
      expect(caught.length).toBeGreaterThan(0)
    }
  })

  test("isBlockedByKeywords 与 matchKeywords 同源:凡语料里有命中的,它就是 true", () => {
    for (const one of cases) {
      expect(isBlockedByKeywords(one.text, toInternal(one.keywords))).toBe(one.expect.length > 0)
    }
  })
})

describe("parseKeywordPayload", () => {
  test("wire 形状 → 内部形状", () => {
    expect(parseKeywordPayload({ keywords: [{ category_code: "contact_wechat", keyword: "微信" }] })).toEqual([
      { categoryCode: "contact_wechat", keyword: "微信" },
    ])
  })

  test("空表是一个结论(「问过了,没有启用词」),不是「没问出来」", () => {
    expect(parseKeywordPayload({ keywords: [] })).toEqual([])
  })

  test("形状不合一律 undefined —— 它与空表的下游动作相反", () => {
    expect(parseKeywordPayload(undefined)).toBeUndefined()
    expect(parseKeywordPayload(null)).toBeUndefined()
    expect(parseKeywordPayload("[]")).toBeUndefined()
    expect(parseKeywordPayload({})).toBeUndefined()
    expect(parseKeywordPayload({ keywords: {} })).toBeUndefined()
    expect(parseKeywordPayload({ keywords: [null] })).toBeUndefined()
    expect(parseKeywordPayload({ keywords: [{ keyword: "微信" }] })).toBeUndefined()
    expect(parseKeywordPayload({ keywords: [{ category_code: "x", keyword: 1 }] })).toBeUndefined()
    // 一行坏掉就整份作废:半份词表比没有词表更危险 —— 它看起来像「问过了」。
    expect(
      parseKeywordPayload({ keywords: [{ category_code: "x", keyword: "微信" }, { category_code: "y" }] }),
    ).toBeUndefined()
  })
})
