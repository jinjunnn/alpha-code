// REQ-038 — home composer slash/@ trigger detection + mention part building (pure logic).
// The interesting cases are the ones the session page already gets right: a slash token closes on
// whitespace, @ only triggers on a word boundary, edited-away mentions must not send parts.

import { describe, expect, test } from "bun:test"
import {
  applyMention,
  buildMentionParts,
  buildSlashList,
  commandOrigin,
  COMMAND_ORIGIN_LABEL,
  detectTrigger,
  displayDescription,
  filterGovernanceDenied,
  rankSlashMatch,
  slashSection,
  sourceTag,
  triggerSignature,
  type CommandOrigin,
  type MentionPart,
} from "./composer-autocomplete-core"

describe("detectTrigger — slash", () => {
  test("bare '/' at caret 1 opens with empty query", () => {
    expect(detectTrigger("/", 1)).toEqual({ mode: "slash", query: "", tokenStart: 0, caret: 1 })
  })
  test("'/rev' filters by 'rev'", () => {
    expect(detectTrigger("/rev", 4)?.query).toBe("rev")
  })
  test("query lowercases", () => {
    expect(detectTrigger("/Rev", 4)?.query).toBe("rev")
  })
  test("a following space closes the menu (upstream parity)", () => {
    expect(detectTrigger("/review ", 8)).toBeNull()
    expect(detectTrigger("/review pr 12", 13)).toBeNull()
  })
  test("slash not at position 0 is not a command", () => {
    expect(detectTrigger("hi /rev", 7)?.mode).not.toBe("slash")
  })
})

describe("detectTrigger — @", () => {
  test("'@' at start opens with empty query", () => {
    expect(detectTrigger("@", 1)).toEqual({ mode: "at", query: "", tokenStart: 0, caret: 1 })
  })
  test("mid-text '@ge' after whitespace triggers with query", () => {
    const v = detectTrigger("ask @ge", 7)
    expect(v).toEqual({ mode: "at", query: "ge", tokenStart: 4, caret: 7 })
  })
  test("email-like text does NOT trigger (no word boundary)", () => {
    expect(detectTrigger("mail me a@b.com", 15)).toBeNull()
  })
  test("caret inside an earlier word does not see a later @", () => {
    expect(detectTrigger("hello @x", 4)).toBeNull()
  })
  test("token ends at whitespace — caret after a completed mention does not re-trigger", () => {
    expect(detectTrigger("ask @general ", 13)).toBeNull()
  })
})

describe("triggerSignature / dismissal identity", () => {
  test("same token → same signature; typing changes it", () => {
    const t1 = "/re"
    const v1 = detectTrigger(t1, 3)!
    const t2 = "/rev"
    const v2 = detectTrigger(t2, 4)!
    expect(triggerSignature(v1, t1)).not.toBe(triggerSignature(v2, t2))
    expect(triggerSignature(v1, t1)).toBe(triggerSignature(detectTrigger(t1, 3)!, t1))
  })
})

describe("applyMention", () => {
  test("replaces the @token and appends a space, caret lands after it", () => {
    const v = detectTrigger("ask @ge to check", 7)! // token [4,7)
    const r = applyMention("ask @ge to check", v, "@general")
    expect(r.text).toBe("ask @general  to check")
    expect(r.caret).toBe(4 + "@general".length + 1)
  })
})

describe("buildMentionParts", () => {
  const ws = "/Users/me/proj"
  test("agent part carries source offsets (upstream shape)", () => {
    const mentions: MentionPart[] = [{ type: "agent", name: "general", content: "@general" }]
    const parts = buildMentionParts("do it @general now", ws, mentions) as any[]
    expect(parts).toHaveLength(1)
    expect(parts[0]).toEqual({
      type: "agent",
      name: "general",
      source: { value: "@general", start: 6, end: 14 },
    })
  })
  test("file part gets an absolute file:// url + filename", () => {
    const mentions: MentionPart[] = [{ type: "file", path: "src/a b.ts", content: "@src/a b.ts" }]
    const parts = buildMentionParts("see @src/a b.ts", ws, mentions) as any[]
    expect(parts[0].type).toBe("file")
    expect(parts[0].url).toBe("file:///Users/me/proj/src/a%20b.ts")
    expect(parts[0].filename).toBe("a b.ts")
    expect(parts[0].mime).toBe("text/plain")
  })
  test("path with # / ? is fully encoded (per-segment, not encodeURI)", () => {
    const mentions: MentionPart[] = [{ type: "file", path: "docs/a#b?c.md", content: "@docs/a#b?c.md" }]
    const parts = buildMentionParts("see @docs/a#b?c.md", ws, mentions) as any[]
    expect(parts[0].url).toBe("file:///Users/me/proj/docs/a%23b%3Fc.md")
  })
  test("mention edited out of the text sends NO part", () => {
    const mentions: MentionPart[] = [{ type: "agent", name: "general", content: "@general" }]
    expect(buildMentionParts("do it yourself", ws, mentions)).toHaveLength(0)
  })
})

// ── REQ-066 斜杠菜单卫生:治理过滤(T1)+ 来源归类(T2)────────────────────────────
describe("filterGovernanceDenied — 治理禁用项不进菜单(REQ-066 T1)", () => {
  const cmds = [
    { name: "customize-opencode", source: "command", description: "(已禁用)该技能已在 alpha 治理中禁用" }, // 占位覆盖形态
    { name: "graphify", source: "skill" },
    { name: "deploy", source: "command" },
  ]
  test("deny 的名字两种形态都隐藏:占位 command 源 + skill 源", () => {
    const denied = new Set(["customize-opencode", "graphify"])
    expect(filterGovernanceDenied(cmds, denied).map((c) => c.name)).toEqual(["deploy"])
  })
  test("解禁(空 deny 集)→ 全部可见 —— 判定依据是治理真源,不是文案前缀", () => {
    expect(filterGovernanceDenied(cmds, new Set()).map((c) => c.name)).toEqual([
      "customize-opencode",
      "graphify",
      "deploy",
    ])
  })
})

describe("commandOrigin — 来源归类(REQ-066 T2)", () => {
  const none: ReadonlySet<string> = new Set()
  test("引擎内置按名字判(source 恒为 command,同名覆盖不改变内置身份)", () => {
    expect(commandOrigin({ name: "init", source: "command" }, none)).toBe("builtin")
    expect(commandOrigin({ name: "review", source: "command" }, none)).toBe("builtin")
  })
  test("skill 源 = 技能;在 receipts 导入集内 = 导入", () => {
    expect(commandOrigin({ name: "graphify", source: "skill" }, none)).toBe("skill")
    expect(commandOrigin({ name: "graphify", source: "skill" }, new Set(["graphify"]))).toBe("imported")
  })
  test("mcp 源 = MCP;config/文件命令(含 source 缺省的旧引擎)= 项目", () => {
    expect(commandOrigin({ name: "context7-docs", source: "mcp" }, none)).toBe("mcp")
    expect(commandOrigin({ name: "deploy", source: "command" }, none)).toBe("project")
    expect(commandOrigin({ name: "legacy" }, none)).toBe("project")
  })
  test("导入集只对 skill 源生效(同名 config 命令不误标导入)", () => {
    expect(commandOrigin({ name: "deploy", source: "command" }, new Set(["deploy"]))).toBe("project")
  })
  test("五类都有中文标签", () => {
    for (const k of ["builtin", "skill", "project", "mcp", "imported"] as const)
      expect(COMMAND_ORIGIN_LABEL[k].length).toBeGreaterThan(0)
  })
})

// ── REQ-072:分组 / 来源四档 / 中文映射 / 搜索排序 ─────────────────────────────
const entry = (trigger: string, origin: CommandOrigin, description?: string, title?: string) => ({
  trigger,
  origin,
  description,
  title,
})

describe("slashSection / sourceTag — 类型分节 × 归属四档(拍板①②)", () => {
  const factory: ReadonlySet<string> = new Set(["alpha-workspace", "skill-creator"])
  test("分节:builtin/mcp/project 各归其节,skill 与 imported 同入「技能」", () => {
    expect(slashSection("builtin")).toBe("builtin")
    expect(slashSection("mcp")).toBe("mcp")
    expect(slashSection("project")).toBe("project")
    expect(slashSection("skill")).toBe("skill")
    expect(slashSection("imported")).toBe("skill")
  })
  test("归属:出厂技能在「技能」节但签「内置」;自装/导入 = 个人", () => {
    expect(sourceTag("skill", "alpha-workspace", factory)).toBe("内置")
    expect(sourceTag("skill", "wrangler", factory)).toBe("个人")
    expect(sourceTag("imported", "graphify", factory)).toBe("个人")
    expect(sourceTag("builtin", "init", factory)).toBe("内置")
    expect(sourceTag("mcp", "context7", factory)).toBe("MCP")
    expect(sourceTag("project", "deploy", factory)).toBe("项目")
  })
})

describe("displayDescription — 中文映射只覆盖出厂/内置,外来如实原文(拍板③)", () => {
  test("映射命中 → 中文;未命中 → 原描述;都没有 → title 兜底", () => {
    expect(displayDescription(entry("init", "builtin", "guided AGENTS.md setup"))).toContain("初始化")
    expect(displayDescription(entry("wrangler", "skill", "Cloudflare Workers CLI"))).toBe("Cloudflare Workers CLI")
    expect(displayDescription(entry("bare", "project", undefined, "Bare Title"))).toBe("Bare Title")
  })
})

describe("rankSlashMatch — 前缀 > 名称包含 > 简介命中(根因③)", () => {
  test("等级次序与不中", () => {
    expect(rankSlashMatch(entry("wrangler", "skill"), "wr")).toBe(0)
    expect(rankSlashMatch(entry("web-wrangler", "skill"), "wr")).toBe(1)
    expect(rankSlashMatch(entry("deploy", "skill", "wrangler deploy helper"), "wr")).toBe(2)
    expect(rankSlashMatch(entry("other", "skill", "nothing"), "wr")).toBe(-1)
  })
  test("中文查询命中映射后的中文简介(搜「审查」能找到 /review)", () => {
    expect(rankSlashMatch(entry("review", "builtin", "review changes"), "审查")).toBe(2)
  })
  test("空查询全命中(等级 0)", () => {
    expect(rankSlashMatch(entry("anything", "project"), "")).toBe(0)
  })
})

describe("buildSlashList — 无查询分节字母序 / 有查询跨节合并 / 全量不截断(根因②)", () => {
  const entries = [
    entry("review", "builtin"),
    entry("init", "builtin"),
    entry("wrangler", "skill"),
    entry("alpha-workspace", "skill"),
    entry("deploy", "project"),
    entry("context7", "mcp"),
  ]
  test("无查询:节序 内置→技能→项目→MCP,节内字母序,flat = 节序拼接", () => {
    const { flat, groups } = buildSlashList(entries, "")
    expect(groups.map((g) => g.section)).toEqual(["builtin", "skill", "project", "mcp"])
    expect(groups[0].items.map((e) => e.trigger)).toEqual(["init", "review"])
    expect(groups[1].items.map((e) => e.trigger)).toEqual(["alpha-workspace", "wrangler"])
    expect(flat.map((e) => e.trigger)).toEqual(["init", "review", "alpha-workspace", "wrangler", "deploy", "context7"])
  })
  test("有查询:groups 清空、跨节按命中等级合并(前缀在前)", () => {
    const { flat, groups } = buildSlashList([...entries, entry("workspace-tool", "skill", "wrangler helper")], "wr")
    expect(groups).toEqual([])
    expect(flat.map((e) => e.trigger)).toEqual(["wrangler", "workspace-tool"]) // 0 级 < 2 级
  })
  test("全量:超过 12 条也一条不丢(旧 slice(0,12) 根因回归锁)", () => {
    const many = Array.from({ length: 30 }, (_, i) => entry(`skill-${String(i).padStart(2, "0")}`, "skill" as const))
    expect(buildSlashList(many, "").flat).toHaveLength(30)
    expect(buildSlashList(many, "skill").flat).toHaveLength(30) // 搜索态同样不截断
    expect(buildSlashList(many, "skill-2").flat.map((e) => e.trigger)).toEqual(
      Array.from({ length: 10 }, (_, i) => `skill-2${i}`),
    )
  })
  test("空集不产节;无命中返回空 flat(空态由 UI 呈现,不闪没)", () => {
    expect(buildSlashList([], "").groups).toEqual([])
    expect(buildSlashList(entries, "zzz").flat).toEqual([])
  })
})
