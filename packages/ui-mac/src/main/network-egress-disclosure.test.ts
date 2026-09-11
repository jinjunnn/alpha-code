// REQ-137 (`#1337`) · AC5 覆盖面如实声明 —— 守住「这道网络围栏只罩引擎那棵树,应用自身的联网不在其内」这段话的
// **存在与内容**,在两个落点:产品(终端「沙箱开启」悬停卡的第四句,zh / en)与文档(勘破文档 §覆盖面声明)。
//
// 与 REQ-159 的披露面同法(`#1322`:呈现层用字面量锚点守文案):判据是**独立字面量**(这里手打,不从被守对象派生),
// 缺任一句 ⇒ 红;此外一条**反向**规则 —— 文案若宣称「全部 / 所有出网都被限制」(比实际更大的保护面),必须红。
// 控制臂:两种已知的坏(删掉排除句 / 改成过度声明)各自经**同一个判据函数**判红并点名。
//
// 为什么值得一道闸:边界声明是最容易在「润色文案」时被删掉的那种句子,而删掉之后没有任何行为测试会红 ——
// 产品从此宣称一个不存在的保护面(与 REQ-159 AC4「平台边界如实声明」同族)。

import { describe, expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import { resolve } from "node:path"
import { dict as en } from "../renderer/i18n/en"
import { dict as zh } from "../renderer/i18n/zh"

type Locale = "zh" | "en" | "doc"

/** 必须逐字在场的片段(手打的独立字面量)。 */
const REQUIRED: Record<Locale, string[]> = {
  zh: [
    "助手和终端只能经 Code Puppy 的出网闸门访问已登记的地址",
    "其它地址会被拒绝并留下记录",
    "Code Puppy 应用自身的联网(模型目录、登录、检查更新)不在这道沙箱之内",
  ],
  en: [
    "the assistant and the terminal can only reach registered addresses through Code Puppy's egress gate",
    "anything else is refused and logged",
    "Code Puppy's own traffic (model catalog, sign-in, update checks) is outside this sandbox",
  ],
  doc: ["这道网络围栏只罩引擎 sidecar 那棵进程树", "Electron main", "renderer 的出网不在覆盖内", "不得宣称比这更大的保护面"],
}

/** 过度声明的形状:「全部 / 所有 … 出网 / 联网 / 网络 … 都被 / 受 …」及其英文。命中即红,不论别的句子在不在。 */
const OVERCLAIM: Record<Locale, RegExp> = {
  zh: /(全部|所有|一切)[^。;]{0,12}(出网|联网|网络)[^。;]{0,6}(都|均|全)?(被|受|经)/,
  en: /\ball\b[^.;]{0,20}\b(outbound|network|internet)\b[^.;]{0,20}\b(is|are)\b[^.;]{0,12}\b(restricted|blocked|limited|gated|covered)/i,
  doc: /(全部|所有|一切)[^。;]{0,12}(出网|联网|网络)[^。;]{0,6}(都|均|全)?(被|受|经)/,
}

export function judgeEgressCoverageDisclosure(text: string, locale: Locale): { ok: boolean; detail: string } {
  const problems: string[] = []
  for (const fragment of REQUIRED[locale]) if (!text.includes(fragment)) problems.push(`missing: ${JSON.stringify(fragment)}`)
  const over = OVERCLAIM[locale].exec(text)
  if (over) problems.push(`overclaims a larger protection surface than exists: ${JSON.stringify(over[0])}`)
  return { ok: problems.length === 0, detail: problems.join("; ") || "coverage statement present and honest" }
}

const DOC = resolve(import.meta.dir, "../../../../docs/architecture/2026-09-10-network-egress-on-process-fence.md")
const docStatement = () => {
  const text = readFileSync(DOC, "utf8")
  const m = /<!-- egress-coverage-statement:begin -->([\s\S]*?)<!-- egress-coverage-statement:end -->/.exec(text)
  return m?.[1] ?? ""
}

describe("REQ-137 #1337 AC5 覆盖面如实声明", () => {
  test("产品(终端沙箱悬停卡 zh / en):三句都在,且没有过度声明", () => {
    const zhBody = zh["alpha.terminal.sandboxHoverBody"]
    const enBody = en["alpha.terminal.sandboxHoverBody"]
    expect(typeof zhBody).toBe("string")
    expect(typeof enBody).toBe("string")
    const zhVerdict = judgeEgressCoverageDisclosure(zhBody, "zh")
    const enVerdict = judgeEgressCoverageDisclosure(enBody, "en")
    expect(zhVerdict.detail).toBe("coverage statement present and honest")
    expect(enVerdict.detail).toBe("coverage statement present and honest")
    expect(zhVerdict.ok && enVerdict.ok).toBe(true)
  })

  test("文档(勘破文档 §覆盖面声明,锚点之间):段落在场、四个片段都在、没有过度声明", () => {
    const statement = docStatement()
    expect(statement.length).toBeGreaterThan(0)
    const verdict = judgeEgressCoverageDisclosure(statement, "doc")
    expect(verdict.detail).toBe("coverage statement present and honest")
    expect(verdict.ok).toBe(true)
  })

  test("反向 ①:把声明改成「全部出网都被限制」⇒ 同一判据必红并点名过度声明(三个落点各一次)", () => {
    const zhBad = zh["alpha.terminal.sandboxHoverBody"].replace(/联网也一样[\s\S]*$/, "所有联网都被这道沙箱限制。")
    const enBad = en["alpha.terminal.sandboxHoverBody"].replace(/Network access works[\s\S]*$/, "All network traffic is restricted by this sandbox.")
    const docBad = docStatement().replace(/\*\*Electron main\*\*[\s\S]*$/, "全部出网都被这道围栏限制。")
    for (const [text, locale] of [
      [zhBad, "zh"],
      [enBad, "en"],
      [docBad, "doc"],
    ] as const) {
      const verdict = judgeEgressCoverageDisclosure(text, locale)
      expect(verdict.ok, locale).toBe(false)
      expect(verdict.detail, locale).toMatch(/overclaims a larger protection surface/)
      expect(verdict.detail, locale).toMatch(/missing:/)
    }
  })

  test("反向 ②:只删掉「应用自身不在其内」那一句(其余照旧)⇒ 红并点名缺的是哪一句", () => {
    const zhBad = zh["alpha.terminal.sandboxHoverBody"].replace(";Code Puppy 应用自身的联网(模型目录、登录、检查更新)不在这道沙箱之内,照常直连", "")
    const enBad = en["alpha.terminal.sandboxHoverBody"].replace(" Code Puppy's own traffic (model catalog, sign-in, update checks) is outside this sandbox and connects as before.", "")
    expect(zhBad).not.toBe(zh["alpha.terminal.sandboxHoverBody"])
    expect(enBad).not.toBe(en["alpha.terminal.sandboxHoverBody"])
    const zhVerdict = judgeEgressCoverageDisclosure(zhBad, "zh")
    const enVerdict = judgeEgressCoverageDisclosure(enBad, "en")
    expect(zhVerdict.ok).toBe(false)
    expect(zhVerdict.detail).toContain("不在这道沙箱之内")
    expect(enVerdict.ok).toBe(false)
    expect(enVerdict.detail).toContain("is outside this sandbox")
    // 锚点整段被删 ⇒ 文档判据同样红(空串缺全部片段)
    expect(judgeEgressCoverageDisclosure("", "doc").ok).toBe(false)
  })
})
