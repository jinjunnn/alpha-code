// `#1242`(REQ-154 T9)—— 「alpha 出厂的技能不得是空壳」这条保证的闸门。
//
// 删掉本文件会失去什么:出厂技能可以退化成只有 frontmatter 的空壳而无一物变红。空壳对
// system 段几乎不花钱(`skill/index.ts:321` 只注 name+description+location,正文不进),
// 代价发生在模型**调用之后** —— 它拿回一份空的 `<skill_files>`,然后空手继续或者现编。
//
// 判据本体在 `./alpha-skill-placeholder.ts`(与名字无关,只看内容,两条独立的轴)。
// **本文件的第一件事是先在三个已知空壳上证明那个判据 3/3 命中** —— 一个恒绿的判据不算判据,
// 而 alpha 今天出厂的 9 份技能全都不是空壳,所以正样本必须自己带进来。
//
// 三个正样本是 owner 本机 `~/.config/opencode/skills/` 下的**存量残留**(2026-06-23,由 alpha
// 那版已撤掉的安装实现写出;今天的 `installBuiltinSkill` 在资产未打包时诚实失败,仓内 grep
// 「请补充上游内容」零命中)。这里逐字节内联而不是去读 home 目录 —— 读 home 的测试在 CI 上
// 必然拿不到文件,而「文件不在就跳过」的正样本等于没有正样本。逐字节来源与 sha256:
//   ~/.config/opencode/skills/canvas-design/SKILL.md    d65be40c251a5aa18a86c6c6c13d5260dcc58edd2ca53ef8106c5d17101b7470
//   ~/.config/opencode/skills/brand-guidelines/SKILL.md 7d563d8bcef63597e09f740031d2ad48768916dd942437137c30c04bb91fddbf
//   ~/.config/opencode/skills/mcp-builder/SKILL.md      e7b2146bfc5b313cb3319ac4a6a0f17a2f7dacade4612142bb7597913872ec95
//
// 被测集合**不写散文枚举**:它 = `factorySkillSources()`(注入组的唯一权威)∪ 磁盘上
// `resources/{skills,factory-skills}/*/` 的每一个目录。新加一个出厂技能默认就在辖区内。

import { createHash } from "node:crypto"
import { existsSync, readdirSync, readFileSync } from "node:fs"
import { join, resolve } from "node:path"
import { describe, expect, test } from "bun:test"

import { factorySkillSources } from "./factory-skills"
import { classifySkill, MIN_BODY_LINES, PLACEHOLDER_RESIDUE_MARKER, skillBody } from "./alpha-skill-placeholder"

const UI_MAC = resolve(import.meta.dir, "..", "..")
const RESOURCES = join(UI_MAC, "resources")

/** 三个已知空壳,逐字节内联(sha256 见抬头)。 */
const KNOWN_SHELLS: ReadonlyArray<{ name: string; sha256: string; source: string }> = [
  {
    name: "canvas-design",
    sha256: "d65be40c251a5aa18a86c6c6c13d5260dcc58edd2ca53ef8106c5d17101b7470",
    source:
      "---\nname: canvas-design\ndescription: 用设计哲学产出 .png/.pdf 视觉作品(Anthropic example-skills)。\n---\n\n用设计哲学产出 .png/.pdf 视觉作品(Anthropic example-skills)。\n\n> 本技能条目来自official(skill:canvas-design)。如需完整脚本/正文,请补充上游内容。\n",
  },
  {
    name: "brand-guidelines",
    sha256: "7d563d8bcef63597e09f740031d2ad48768916dd942437137c30c04bb91fddbf",
    source:
      "---\nname: brand-guidelines\ndescription: 把品牌色彩/字体规范应用到各类产物(Anthropic example-skills)。\n---\n\n把品牌色彩/字体规范应用到各类产物(Anthropic example-skills)。\n\n> 本技能条目来自official(skill:brand-guidelines)。如需完整脚本/正文,请补充上游内容。\n",
  },
  {
    name: "mcp-builder",
    sha256: "e7b2146bfc5b313cb3319ac4a6a0f17a2f7dacade4612142bb7597913872ec95",
    source:
      "---\nname: mcp-builder\ndescription: 编写高质量 MCP server 的指南(Anthropic example-skills)。\n---\n\n编写高质量 MCP server 的指南(Anthropic example-skills)。\n\n> 本技能条目来自official(skill:mcp-builder)。如需完整脚本/正文,请补充上游内容。\n",
  },
]

/** 磁盘上 alpha 真正随包发出去的每一份 SKILL.md(不枚举名字)。 */
function shippedSkills(): Array<{ id: string; path: string; source: string }> {
  const out: Array<{ id: string; path: string; source: string }> = []
  for (const root of ["skills", "factory-skills"]) {
    const dir = join(RESOURCES, root)
    if (!existsSync(dir)) continue
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue
      const md = join(dir, entry.name, "SKILL.md")
      if (!existsSync(md)) continue
      out.push({ id: `${root}/${entry.name}`, path: md, source: readFileSync(md, "utf8") })
    }
  }
  return out
}

describe("先证明判据测得出已知的坏 —— 三个已知空壳 3/3 命中", () => {
  for (const shell of KNOWN_SHELLS) {
    test(`${shell.name}:内联副本与来源逐字节相同,且被判为空壳`, () => {
      expect(createHash("sha256").update(shell.source).digest("hex")).toBe(shell.sha256)
      const verdict = classifySkill(shell.source)
      expect(verdict.placeholder).toBe(true)
      expect(verdict.placeholder && verdict.reason.length > 0).toBe(true)
    })
  }
  test("三个全中(3/3),不是碰巧命中其中一两个", () => {
    const hits = KNOWN_SHELLS.filter((s) => classifySkill(s.source).placeholder)
    expect(hits.length).toBe(KNOWN_SHELLS.length)
  })
})

describe("两条轴各自都能独立命中(缺一条不会让另一条替它兜底)", () => {
  test("轴①残留指纹:正文很长、结构齐全,但含占位句 → 仍判空壳", () => {
    const body = ["# Title", ...Array.from({ length: 40 }, (_, i) => `- 第 ${i} 条真实内容`)].join("\n")
    const withMarker = `---\nname: x\ndescription: d\n---\n\n${body}\n\n> 如需完整脚本/正文,${PLACEHOLDER_RESIDUE_MARKER}。\n`
    const v = classifySkill(withMarker)
    expect(v.placeholder).toBe(true)
    expect(v.placeholder && v.reason).toContain(PLACEHOLDER_RESIDUE_MARKER)
    // 去掉那一句(其余不动)⇒ 不再命中 ⇒ 命中的确实是轴①,不是被别的轴顺手抓到的
    expect(classifySkill(withMarker.replace(/\n> 如需完整脚本[^\n]*\n/, "\n")).placeholder).toBe(false)
  })
  test("轴②实质地板:把占位句删掉的空壳仍判空壳(存量指纹不是唯一依靠)", () => {
    for (const shell of KNOWN_SHELLS) {
      const scrubbed = shell.source.replace(/\n> 本技能条目来自[^\n]*\n/, "\n")
      expect(scrubbed.includes(PLACEHOLDER_RESIDUE_MARKER)).toBe(false)
      const v = classifySkill(scrubbed)
      expect(v.placeholder, `${shell.name} 去掉指纹后漏判`).toBe(true)
      expect(v.placeholder && v.reason).toContain("非空行")
    }
  })
  test("轴②不误伤:刚过地板、有结构的短技能判为正常", () => {
    const ok = `---\nname: x\ndescription: d\n---\n\n# T\n\n- a\n- b\n- c\n- d\n- e\n`
    expect(skillBody(ok).split("\n").filter((l) => l.trim()).length).toBeGreaterThanOrEqual(MIN_BODY_LINES)
    expect(classifySkill(ok).placeholder).toBe(false)
  })
})

describe("alpha 出厂技能:零空壳", () => {
  const shipped = shippedSkills()

  test("被测集合非空,且覆盖注入组的每一个成员(权威 = factorySkillSources)", () => {
    expect(shipped.length).toBeGreaterThan(0)
    const injected = factorySkillSources({ packaged: false, resourcesPath: "/ignored", moduleDir: join(UI_MAC, "out", "main") })
    const covered = new Set(shipped.map((s) => join(RESOURCES, s.id)))
    for (const [name, dir] of Object.entries(injected)) {
      expect(covered.has(dir), `注入组成员 ${name}(${dir})不在被测集合里`).toBe(true)
    }
  })

  for (const skill of shippedSkills()) {
    test(`${skill.id} 不是空壳`, () => {
      const v = classifySkill(skill.source)
      expect(v.placeholder ? `${skill.path}: ${v.reason}` : "ok").toBe("ok")
    })
  }

  test("余量是量出来的,不是骑在阈值边上", () => {
    const counts = shipped.map((s) => skillBody(s.source).split("\n").filter((l) => l.trim()).length)
    // 2026-09-06 实测:出厂最小 = alpha-workspace 的 19 条,地板 6 ⇒ 3.1 倍。
    // 这条断言的用途是:哪天有人把一份出厂技能砍到贴着地板,它先红,而不是等它掉到地板下面。
    expect(Math.min(...counts)).toBeGreaterThanOrEqual(MIN_BODY_LINES * 2)
  })
})

describe("office-docs 说明书不得再教做不到的事(`#1242` 的另一半)", () => {
  const officeDocs = readFileSync(join(RESOURCES, "factory-skills", "office-docs", "SKILL.md"), "utf8")
  const serverPy = readFileSync(join(RESOURCES, "office-mcp", "server.py"), "utf8")

  test("drift 锁:write_xlsx 的 schema 仍然只收 {name, cells} 且 additionalProperties:false", () => {
    // 说明书里那张能力表的依据。schema 一旦放宽,这条先红,提醒回来重写说明书。
    expect(serverPy.includes('"required": ["name", "cells"],')).toBe(true)
    expect(serverPy.includes('"additionalProperties": False,')).toBe(true)
    expect(serverPy.includes('"write_xlsx",')).toBe(true)
  })
  test("drift 锁:write_docx 的 heading/table 块与 level 透传仍在(#1245 落地后的现实)", () => {
    // 说明书第 23、50 行那两格能力表的依据。这三条任一消失 ⇒ 说明书又在教做不到的事,先红。
    expect(serverPy.includes("document.add_heading(block[\"text\"], level=block[\"level\"])")).toBe(true)
    expect(serverPy.includes('"type": {"const": "heading"}')).toBe(true)
    expect(serverPy.includes('counts = {"paragraph": 0, "heading": 0, "table": 0}')).toBe(true)
  })
  test("说明书不得否认 server.py 已有的能力(反向漂移锁)", () => {
    // #1245 扩面后出现过的真实缺陷:说明书还在教模型「否认」一个已经存在的能力。
    // 正向锁(说明书别吹牛)与反向锁(说明书别贬低)是两个方向,都要有。
    const eastAsiaIsSet = serverPy.includes('DOCX_DEFAULT_EAST_ASIA_FONT = "宋体"')
    const refusesUnknown = serverPy.includes("def reject_unknown_keys(")
    expect(eastAsiaIsSet).toBe(true)
    expect(refusesUnknown).toBe(true)
    // server.py 设了中文字体 ⇒ 说明书不得说它没设、也不得叫模型别提
    expect(officeDocs).not.toContain("do not set an East Asian font")
    expect(officeDocs).not.toContain("Do not tell the user you chose a Chinese typeface")
    // server.py 显式拒绝未知键 ⇒ 说明书不得说它静默丢弃
    expect(officeDocs).not.toContain("does **not** raise — it is dropped")
  })

  test("schema 做不到的承诺已从说明书里清除(逐条点名)", () => {
    for (const promise of [
      "freeze the header row",
      "add an autofilter",
      "Charts and pivots should reference ranges",
      "dates as dates",
      "Apply number\nformats",
      "merging is fine for titles",
    ]) {
      expect(officeDocs.includes(promise), `说明书仍在承诺做不到的事:${promise}`).toBe(false)
    }
  })
  test("补上的产出物质量段与能力真相段都在", () => {
    for (const heading of ["## What each writer really accepts", "## What the document itself should look like"]) {
      expect(officeDocs.includes(heading), `office-docs 少了这一节:${heading}`).toBe(true)
    }
    const flat = officeDocs.replace(/\s+/g, " ")
    for (const requirement of [
      "Never describe the file as styled when you did not style it",
      "Lead with the conclusion",
      "Two heading levels at most",
      "Full-width punctuation",
      // #1245 之后中文字体是真设的(server.py DOCX_DEFAULT_EAST_ASIA_FONT = 宋体),
      // 原先那句「不要告诉用户你选了中文字体」已反向漂移,改断言新的真话。
      "Say which typeface you set",
      "Dates do not",
    ]) {
      expect(flat, `office-docs 少了这条要求:${requirement}`).toContain(requirement)
    }
  })
})
