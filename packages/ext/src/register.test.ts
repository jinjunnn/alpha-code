import { describe, expect, test } from "bun:test"
import { applyRegister } from "./register"

describe("applyRegister — alpha_register 纯逻辑(REQ-060 T2)", () => {
  test("agent 注册:白名单字段 → 条目落 agent 域", () => {
    const r = applyRegister(null, "agent", "proj-helper", { description: "d", prompt: "p", mode: "subagent" })
    expect(r.ok).toBe(true)
    if (r.ok) {
      const cfg = JSON.parse(r.next)
      expect(cfg.agent["proj-helper"]).toEqual({ description: "d", prompt: "p", mode: "subagent" })
      expect(r.summary).toContain("registered")
    }
  })

  test("同名 = 更新(创建流迭代),summary 说 updated", () => {
    const first = applyRegister(null, "command", "gen", { template: "t1" })
    expect(first.ok).toBe(true)
    const second = applyRegister(first.ok ? first.next : "", "command", "gen", { template: "t2" })
    expect(second.ok).toBe(true)
    if (second.ok) {
      expect(JSON.parse(second.next).command.gen.template).toBe("t2")
      expect(second.summary).toContain("updated")
    }
  })

  test("字段白名单:未知字段拒绝 loud", () => {
    const r = applyRegister(null, "agent", "x", { prompt: "p", evil: true })
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.reason).toContain("evil")
  })

  test("mcp 字段白名单对齐 ext-config(environment/headers 可,任意键不可)", () => {
    const ok = applyRegister(null, "mcp", "projdb", { type: "local", command: ["npx", "x"], environment: { A: "1" } })
    expect(ok.ok).toBe(true)
    const bad = applyRegister(null, "mcp", "projdb", { type: "local", shell: "rm -rf" })
    expect(bad.ok).toBe(false)
  })

  test("SAFE_NAME:路径分隔/空名拒绝", () => {
    expect(applyRegister(null, "agent", "../evil", { prompt: "p" }).ok).toBe(false)
    expect(applyRegister(null, "agent", "", { prompt: "p" }).ok).toBe(false)
  })

  test("skill:无 entry,skills.paths 注册相对路径且幂等", () => {
    const r1 = applyRegister(null, "skill", "", undefined)
    expect(r1.ok).toBe(true)
    const r2 = applyRegister(r1.ok ? r1.next : "", "skill", "", undefined)
    expect(r2.ok).toBe(true)
    if (r2.ok) expect(JSON.parse(r2.next).skills.paths).toEqual(["./.code-puppy/skills"])
  })

  test("既有 jsonc(含注释/尾逗号)被保留合并;坏 jsonc 拒写(不覆盖用户文件)", () => {
    const existing = `{
      // 项目连接器
      "mcp": { "keep": { "type": "remote", "url": "https://x" } },
    }`
    const r = applyRegister(existing, "agent", "a", { prompt: "p" })
    expect(r.ok).toBe(true)
    if (r.ok) {
      const cfg = JSON.parse(r.next)
      expect(cfg.mcp.keep.url).toBe("https://x")
      expect(cfg.agent.a.prompt).toBe("p")
    }
    expect(applyRegister("{ broken", "agent", "a", { prompt: "p" }).ok).toBe(false)
  })

  test("entry 非对象拒绝", () => {
    expect(applyRegister(null, "agent", "a", undefined).ok).toBe(false)
  })
})

describe("mergeProjectConfig 相对 skills.paths 解析(register 写入的 ./.code-puppy/skills)", () => {
  test("./ 前缀按 directory 解析为绝对", async () => {
    const { mergeProjectConfig } = await import("./project-config")
    const cfg: Record<string, any> = {}
    mergeProjectConfig(cfg, JSON.stringify({ skills: { paths: ["./.code-puppy/skills"] } }), { directory: "/proj/x" })
    expect(cfg.skills.paths).toEqual(["/proj/x/.code-puppy/skills"])
  })
})
