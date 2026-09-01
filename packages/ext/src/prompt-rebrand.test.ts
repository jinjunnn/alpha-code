// REQ-062 T1 — 品牌转写纯函数(验收⑦:子串清单 × 8 底座真实样本 + 反例集)。
// drift 锁:逐条断言 rule.from 仍逐字节存在于上游 .txt —— 上游 sync 改写这些句子时本测试变红,
// 即 ADR-015 合并验证的机械化(与 sync tripwire 呼应,清单复核不再靠人肉记得)。

import { describe, expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import { join } from "node:path"
import { REBRAND_RULES, rebrandSystem } from "./prompt-rebrand"

const PROMPT_DIR = join(import.meta.dir, "../../opencode/src/session/prompt")
const read = (f: string) => readFileSync(join(PROMPT_DIR, f), "utf8")

describe("drift 锁 — 每条 from 子串仍存在于上游底座原文", () => {
  for (const rule of REBRAND_RULES) {
    test(`${rule.id} ⊂ ${rule.file}`, () => {
      expect(read(rule.file).includes(rule.from)).toBe(true)
    })
  }
})

describe("rebrandSystem — 8 底座真实样本零残留", () => {
  // 这些底座不含任何「真实事物名」形态的 opencode(无 opencode.json / .opencode / @opencode-ai)
  // → 转写后应当一个 opencode 都不剩(大小写不敏感)。
  const BASES = ["anthropic.txt", "codex.txt", "default.txt", "trinity.txt", "beast.txt", "kimi.txt", "gpt.txt", "gemini.txt", "copilot-gpt-5.txt"]
  for (const f of BASES) {
    test(`${f} 转写后零 opencode 痕迹 + 自称 Code Puppy`, () => {
      const src = read(f)
      const r = rebrandSystem([src])
      expect(r.changed).toBe(true)
      expect(/opencode/i.test(r.system[0])).toBe(false)
      expect(r.system[0].includes("Code Puppy")).toBe(true)
      expect(r.warnings).toEqual([]) // 全部命中,无残留告警
    })
  }
  test("上游 docs/GitHub 指引剔除(anthropic + default)", () => {
    for (const f of ["anthropic.txt", "default.txt"]) {
      const out = rebrandSystem([read(f)]).system[0]
      expect(out.includes("github.com/anomalyco")).toBe(false)
      expect(out.includes("opencode.ai")).toBe(false)
    }
  })
})

describe("反例集 — 真实事物名与用户文本绝不误转", () => {
  test("用户 instructions 里的实体引用原样保留(转了 = 对模型撒谎)", () => {
    const userText = [
      "This repo is a fork of opencode (see packages/opencode).",
      "Config lives in opencode.jsonc; the engine also reads .opencode directories.",
      "We consume @opencode-ai/sdk and @opencode-ai/plugin.",
    ].join("\n")
    const r = rebrandSystem([userText])
    expect(r.system[0]).toBe(userText) // 无 curated 子串命中 → 一字节不动
  })
  test("用户文本含上游仓指引 → 保留原文但报 residual 告警(诚实提示,不静默)", () => {
    const userText = "Upstream repo: https://github.com/anomalyco/opencode — do not send PRs."
    const r = rebrandSystem([userText])
    expect(r.system[0]).toBe(userText)
    expect(r.warnings.some((w) => w.includes("upstream-repo"))).toBe(true)
  })
  test("底座改版失配(首句变体)→ residual 告警而非静默漏改", () => {
    const drifted = "You are OpenCode, an amazing brand-new agent persona."
    const r = rebrandSystem([drifted])
    expect(r.warnings.some((w) => w.includes("identity-line"))).toBe(true)
  })
  test("入参不被修改(纯函数)", () => {
    const arr = ["You are OpenCode, the best coding agent on the planet."]
    rebrandSystem(arr)
    expect(arr[0]).toContain("OpenCode")
  })
})
