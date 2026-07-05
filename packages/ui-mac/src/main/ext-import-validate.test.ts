// REQ-019 T6:导入校验纯函数单测(非法 frontmatter 拒绝路径 = 验收③的一半;另一半真机 UI 走查)。
import { describe, expect, test } from "bun:test"
import { parseSkillFrontmatter, validGitUrl } from "./ext-import-validate"

describe("parseSkillFrontmatter (T6 导入校验)", () => {
  test("合法 frontmatter → name/description", () => {
    const r = parseSkillFrontmatter(`---\nname: my-skill\ndescription: does things\n---\n\n# body\n`)
    expect(r).toEqual({ ok: true, name: "my-skill", description: "does things" })
  })
  test("引号包裹与大小写键名容忍", () => {
    const r = parseSkillFrontmatter(`---\nName: "quoted-name"\nDescription: 'ok desc'\n---\n`)
    expect(r.ok).toBe(true)
    if (r.ok) expect(r.name).toBe("quoted-name")
  })
  test("缺 --- 头 → 拒绝", () => {
    expect(parseSkillFrontmatter(`name: x\ndescription: y`).ok).toBe(false)
  })
  test("未闭合 → 拒绝", () => {
    expect(parseSkillFrontmatter(`---\nname: x\ndescription: y\n`).ok).toBe(false)
  })
  test("name 缺失 → 拒绝", () => {
    expect(parseSkillFrontmatter(`---\ndescription: y\n---\n`).ok).toBe(false)
  })
  test("name 带路径分隔/越界字符 → 拒绝(防逃逸:name 直接进落盘路径)", () => {
    for (const bad of ["../up", "a/b", "a\\b", ".hidden", "x".repeat(80)]) {
      const r = parseSkillFrontmatter(`---\nname: ${bad}\ndescription: y\n---\n`)
      expect(r.ok).toBe(false)
    }
  })
  test("description 缺失 → 拒绝", () => {
    expect(parseSkillFrontmatter(`---\nname: ok-name\n---\n`).ok).toBe(false)
  })
  test("超长 frontmatter(>8KB 未闭合窗口)→ 拒绝", () => {
    expect(parseSkillFrontmatter(`---\n${"a: b\n".repeat(3000)}---\n`).ok).toBe(false)
  })
})

describe("validGitUrl", () => {
  test("https 仓库地址 → 通过", () => {
    expect(validGitUrl("https://github.com/user/repo")).toBe(true)
    expect(validGitUrl("https://github.com/user/repo.git")).toBe(true)
  })
  test("非 https / ssh / file / 注入形状 → 拒绝", () => {
    for (const bad of [
      "http://github.com/user/repo",
      "git@github.com:user/repo.git",
      "file:///etc/passwd",
      "https://host/repo;rm -rf ~",
      "https://host/repo $(x)",
      "ftp://host/repo",
      123,
      undefined,
    ]) {
      expect(validGitUrl(bad as never)).toBe(false)
    }
  })
})

// ── REQ-033:agent 导入解析/映射(Claude Code → opencode 显式映射,不支持项 loud)──
import { parseAgentImport } from "./ext-import-validate"

const CLAUDE_AGENT = `---
name: code-reviewer
description: Reviews code for quality issues
tools: Read, Grep, Bash
model: sonnet
---

You are a code reviewer. Focus on correctness.
`

const OC_AGENT = `---
name: my-agent
description: opencode native agent
mode: subagent
temperature: 0.2
---

Do things.
`

describe("parseAgentImport (REQ-033)", () => {
  test("Claude Code 格式:识别 + description/body 映射 + tools/model 显式不映射", () => {
    const r = parseAgentImport(CLAUDE_AGENT)
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.format).toBe("claude-code")
    expect(r.name).toBe("code-reviewer")
    const bySource = new Map(r.mapping.map((m) => [m.source, m]))
    expect(bySource.get("description")?.target).toBe("description")
    expect(bySource.get("tools")?.target).toBeNull()
    expect(bySource.get("tools")?.note).toContain("permission")
    expect(bySource.get("model")?.target).toBeNull()
    expect(r.composed).toContain("mode: subagent")
    expect(r.composed).toContain("You are a code reviewer.")
    expect(r.composed).not.toContain("tools:") // 不支持字段绝不静默写入
  })
  test("opencode 原生格式:直入(composed = 原文)", () => {
    const r = parseAgentImport(OC_AGENT)
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.format).toBe("opencode")
    expect(r.composed).toBe(OC_AGENT)
  })
  test("confirm 重解析防线:Claude 转换产物再 parse 合法且为 opencode 格式", () => {
    const r = parseAgentImport(CLAUDE_AGENT)
    if (!r.ok) throw new Error("unexpected")
    const r2 = parseAgentImport(r.composed)
    expect(r2.ok).toBe(true)
    if (!r2.ok) return
    expect(r2.format).toBe("opencode")
    expect(r2.name).toBe("code-reviewer")
  })
  test("坏输入:缺 frontmatter / 缺 description / 非法 name 全拒", () => {
    expect(parseAgentImport("no frontmatter").ok).toBe(false)
    expect(parseAgentImport("---\nname: ok\n---\nbody").ok).toBe(false)
    expect(parseAgentImport("---\nname: ../evil\ndescription: x\n---\nbody").ok).toBe(false)
  })
})
