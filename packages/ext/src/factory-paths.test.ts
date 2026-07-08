// REQ-065 修订 — 出厂技能路径内存注入(alpha.jsonc 零系统路径;用户拍板 2026-07-08)。

import { describe, expect, test } from "bun:test"
import { injectFactorySkillPaths } from "./factory-paths"

const DIRS = ["/App.app/Contents/Resources/skills/skill-creator", "/App.app/Contents/Resources/factory-skills/customize-alpha"]

describe("injectFactorySkillPaths — env → cfg.skills.paths 内存注入", () => {
  test("注入到既有 skills.paths 之后(用户条目在前,不动)", () => {
    const cfg: Record<string, unknown> = { skills: { paths: ["/Users/x/.alpha/skills"] } }
    const added = injectFactorySkillPaths(cfg, JSON.stringify(DIRS))
    expect(added).toEqual(DIRS)
    expect((cfg.skills as any).paths).toEqual(["/Users/x/.alpha/skills", ...DIRS])
  })
  test("无 skills 键 → 建对象形态(引擎 schema:object 非数组);幂等去重", () => {
    const cfg: Record<string, unknown> = {}
    injectFactorySkillPaths(cfg, JSON.stringify(DIRS))
    expect(Array.isArray(cfg.skills)).toBe(false)
    expect((cfg.skills as any).paths).toEqual(DIRS)
    expect(injectFactorySkillPaths(cfg, JSON.stringify(DIRS))).toEqual([]) // 已在 → 不重复
  })
  test("env 缺失 / 空数组 / 坏 JSON / 非字符串条目 → 安全 no-op", () => {
    const cfg: Record<string, unknown> = { skills: { paths: ["/keep"] } }
    expect(injectFactorySkillPaths(cfg, undefined)).toEqual([])
    expect(injectFactorySkillPaths(cfg, "[]")).toEqual([])
    expect(injectFactorySkillPaths(cfg, "{corrupt")).toEqual([])
    expect(injectFactorySkillPaths(cfg, JSON.stringify([1, null, ""]))).toEqual([])
    expect((cfg.skills as any).paths).toEqual(["/keep"])
  })
  test("兄弟字段保留(skills.disabled 等不清除)", () => {
    const cfg: Record<string, unknown> = { skills: { paths: [], disabled: ["x"] } }
    injectFactorySkillPaths(cfg, JSON.stringify(DIRS))
    expect((cfg.skills as any).disabled).toEqual(["x"])
  })
})
