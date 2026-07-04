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
