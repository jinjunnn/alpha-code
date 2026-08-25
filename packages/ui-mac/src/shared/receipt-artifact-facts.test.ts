// REQ-105(#319):receipt 上的两个事实(卡片版本 / 执行物内容地址)如何被诚实呈现。
//
// AC5 的后半句是「不会把未知或未验证 digest 表示为已审计」。这一组判据钉的就是那条边界:
// 缺省、空串、少一位、大写、错前缀、别的算法 —— 一律归到同一个诚实结论(digest: null),
// 而不是把半截字符串原样端到用户面前当成一个可核对的身份。

import { describe, expect, test } from "bun:test"
import { RECEIPT_DIGEST_RE, receiptArtifactFacts } from "./receipt-artifact-facts"

const GOOD = `sha256:${"ab12".repeat(16)}`

describe("receiptArtifactFacts", () => {
  test("a well-formed recorded digest is exposed whole and in a short comparable form", () => {
    expect(GOOD).toMatch(RECEIPT_DIGEST_RE) // 夹具自证:先确认这个手段能认出「好的」
    const facts = receiptArtifactFacts({ version: "1.0.0", payloadDigest: GOOD })
    expect(facts.version).toBe("1.0.0")
    expect(facts.digest).toBe(GOOD)
    // 短形态必须是全值的**前缀**加省略号 —— 它是给人肉眼比对 catalog/lock 上同一个值用的,
    // 不能是重新哈希、重新编码或截了中段的东西。
    expect(facts.digestShort).toBe("sha256:ab12ab12ab12…")
    expect(GOOD.startsWith(facts.digestShort!.slice(0, -1))).toBe(true)
  })

  test("version and digest are independent facts — one present does not manufacture the other", () => {
    expect(receiptArtifactFacts({ version: "1.0.0" })).toEqual({ version: "1.0.0", digest: null, digestShort: null })
    expect(receiptArtifactFacts({ payloadDigest: GOOD }).version).toBeUndefined()
    expect(receiptArtifactFacts({ payloadDigest: GOOD }).digest).toBe(GOOD)
  })

  test("no receipt at all is 'not recorded', not an empty-looking digest", () => {
    for (const input of [undefined, null, {}]) {
      const facts = receiptArtifactFacts(input)
      expect(facts.digest).toBeNull()
      expect(facts.digestShort).toBeNull()
      expect(facts.version).toBeUndefined()
    }
  })

  test.each([
    ["empty string", ""],
    ["hex only, no algorithm", "ab12".repeat(16)],
    ["one hex digit short", `sha256:${"ab12".repeat(15)}abc`],
    ["one hex digit long", `sha256:${"ab12".repeat(16)}a`],
    ["uppercase hex", `sha256:${"AB12".repeat(16)}`],
    ["non-hex character", `sha256:${"ab1z".repeat(16)}`],
    ["different algorithm", `sha512:${"ab12".repeat(16)}`],
    ["leading whitespace", ` sha256:${"ab12".repeat(16)}`],
    ["trailing whitespace", `sha256:${"ab12".repeat(16)} `],
    ["prefix only", "sha256:"],
    ["human placeholder", "unknown"],
  ])("a malformed recorded value is refused, not rendered as an identity (%s)", (_label, payloadDigest) => {
    const facts = receiptArtifactFacts({ version: "1.0.0", payloadDigest })
    expect(facts.digest).toBeNull()
    expect(facts.digestShort).toBeNull()
    // 版本仍然如实说得出口 —— 拒的是 digest,不是整张 receipt。
    expect(facts.version).toBe("1.0.0")
  })

  test("an empty version string is absent, not a blank label", () => {
    expect(receiptArtifactFacts({ version: "", payloadDigest: GOOD }).version).toBeUndefined()
  })
})
