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

describe("validGitUrl(#335 SSRF allowlist)", () => {
  test("allowlist forge(exact + dot-boundary 子域 + .git)→ 通过", () => {
    for (const good of [
      "https://github.com/user/repo",
      "https://github.com/user/repo.git",
      "https://gitlab.com/group/sub/repo",
      "https://bitbucket.org/user/repo",
      "https://codeberg.org/user/repo",
      "https://git.sr.ht/~user/repo",
      "https://gist.github.com/user/id", // dot-boundary 子域(forge 自控,非 SSRF)
      "https://github.com/user/repo.git/", // 尾斜杠仍是合法路径段
    ]) {
      expect(validGitUrl(good)).toBe(true)
    }
  })
  test("非 https / ssh / file / 注入形状 → 拒绝", () => {
    for (const bad of [
      "http://github.com/user/repo",
      "git@github.com:user/repo.git",
      "file:///etc/passwd",
      "https://github.com/repo;rm -rf ~", // 注入字符不在路径 charset
      "https://github.com/repo $(x)",
      "ftp://github.com/repo",
      123,
      undefined,
    ]) {
      expect(validGitUrl(bad as never)).toBe(false)
    }
  })
  test("SSRF 面:localhost / 回环 / 私网 / link-local / IP 各编码 / IPv6 → 拒绝", () => {
    for (const bad of [
      "https://localhost/user/repo",
      "https://localhost./user/repo", // 尾点绕过
      "https://localhost.localdomain/user/repo",
      "https://127.0.0.1/user/repo",
      "https://127.0.0.1:443/user/repo",
      "https://0x7f000001/user/repo", // 十六进制 IPv4
      "https://2130706433/user/repo", // 十进制 IPv4
      "https://0177.0.0.1/user/repo", // 八进制 IPv4
      "https://10.0.0.5/user/repo", // RFC1918
      "https://192.168.1.1/user/repo",
      "https://172.16.0.1/user/repo",
      "https://169.254.169.254/latest/meta-data", // 云元数据 link-local
      "https://100.64.0.1/user/repo", // CGNAT
      "https://[::1]/user/repo", // IPv6 loopback
      "https://[fe80::1]/user/repo", // IPv6 link-local
      "https://[fc00::1]/user/repo", // IPv6 ULA
      "https://[::ffff:127.0.0.1]/user/repo", // IPv4-mapped IPv6
      "https://0.0.0.0/user/repo",
    ]) {
      expect(validGitUrl(bad)).toBe(false)
    }
  })
  test("非 allowlist forge / 单标签 / 子域伪装 / 非 443 端口 / userinfo / query·fragment / 裸 host → 拒绝", () => {
    for (const bad of [
      "https://evil.com/user/repo", // 非 allowlist
      "https://gitea.example.com/user/repo",
      "https://internalgit/user/repo", // 单标签(无点)
      "https://notgithub.com/user/repo", // Xgithub.com 非 dot-boundary
      "https://evilgithub.com/user/repo",
      "https://github.com.evil.com/user/repo", // 后缀伪装
      "https://github.com:8080/user/repo", // 非 443 端口
      "https://github.com:22/user/repo",
      "https://user:pass@github.com/user/repo", // userinfo
      "https://user@github.com/user/repo",
      "https://github.com/user/repo?x=1", // query
      "https://github.com/user/repo#frag", // fragment
      "https://github.com", // 裸 host,路径规范化为 "/"
      "https://github.com/", // 无 repo 路径段
    ]) {
      expect(validGitUrl(bad)).toBe(false)
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
