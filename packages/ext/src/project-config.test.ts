import { describe, expect, test } from "bun:test"
import { isGlobalAlphaDir, mergeProjectConfig } from "./project-config"

const j = (o: unknown) => JSON.stringify(o)

describe("mergeProjectConfig — text-class domains (agent/command/skills, always loaded)", () => {
  test("merges project agent / command (text) into cfg", () => {
    const cfg: Record<string, any> = {}
    const { added } = mergeProjectConfig(cfg, j({
      agent: { "proj-agent": { prompt: "hi" } },
      command: { "proj-cmd": { template: "t" } },
    }))
    expect(cfg.agent["proj-agent"]).toEqual({ prompt: "hi" })
    expect(cfg.command["proj-cmd"]).toEqual({ template: "t" })
    expect(added.sort()).toEqual(["agent.*", "command.*"])
  })

  test("existing (global) wins — project doesn't overwrite same name", () => {
    const cfg: Record<string, any> = { agent: { shared: { prompt: "GLOBAL" } } }
    mergeProjectConfig(cfg, j({ agent: { shared: { prompt: "PROJECT" }, extra: { prompt: "x" } } }))
    expect(cfg.agent.shared).toEqual({ prompt: "GLOBAL" })
    expect(cfg.agent.extra).toEqual({ prompt: "x" })
  })

  test("skills.paths union (OBJECT schema, not array), dedup, existing first", () => {
    const cfg: Record<string, any> = { skills: { paths: ["/global/skills"] } }
    mergeProjectConfig(cfg, j({ skills: { paths: ["/global/skills", "/proj/.alpha/skills"] } }))
    expect(cfg.skills).toEqual({ paths: ["/global/skills", "/proj/.alpha/skills"] })
  })

  test("malformed json → no-op, no throw", () => {
    const cfg: Record<string, any> = {}
    const r = mergeProjectConfig(cfg, "{ not json ][")
    expect(r).toEqual({ added: [], gatedExecutable: [] })
    expect(cfg).toEqual({})
  })

  test("jsonc comments + trailing commas tolerated", () => {
    const cfg: Record<string, any> = {}
    mergeProjectConfig(cfg, `{
      // project agent
      "agent": { "a": { "prompt": "x" }, }, /* block */
    }`, { trustExecutable: true })
    expect(cfg.agent.a).toEqual({ prompt: "x" })
  })

  test("plugin domain NOT merged here (goes via host fan-out, ADR-006)", () => {
    const cfg: Record<string, any> = {}
    const { added } = mergeProjectConfig(cfg, j({ plugin: ["/proj/.alpha/plugins/x.js"] }), { trustExecutable: true })
    expect(cfg.plugin).toBeUndefined()
    expect(added).not.toContain("plugin")
  })
})

describe("mergeProjectConfig — trust gate on executable mcp", () => {
  test("UNTRUSTED (default): mcp gated, agent/command/skills still load", () => {
    const cfg: Record<string, any> = {}
    const r = mergeProjectConfig(cfg, j({
      mcp: { projmcp: { type: "local" } },
      agent: { a: { prompt: "x" } },
      command: { c: { template: "t" } },
      skills: { paths: ["/proj/.alpha/skills"] },
    }))
    expect(cfg.mcp).toBeUndefined() // executable gated — engine can't discover it
    expect(r.gatedExecutable).toContain("mcp")
    expect(cfg.agent.a).toBeDefined() // text-class loads regardless
    expect(cfg.command.c).toBeDefined()
    expect(cfg.skills.paths).toContain("/proj/.alpha/skills")
  })

  test("TRUSTED: mcp loads", () => {
    const cfg: Record<string, any> = {}
    const r = mergeProjectConfig(cfg, j({ mcp: { projmcp: { type: "local" } } }), { trustExecutable: true })
    expect(cfg.mcp.projmcp).toEqual({ type: "local" })
    expect(r.added).toContain("mcp.*")
    expect(r.gatedExecutable).toEqual([])
  })

  test("no mcp in project → nothing gated even when untrusted", () => {
    const cfg: Record<string, any> = {}
    const r = mergeProjectConfig(cfg, j({ agent: { a: { prompt: "x" } } }))
    expect(r.gatedExecutable).toEqual([])
  })

  test("empty mcp object → not gated (nothing to load)", () => {
    const cfg: Record<string, any> = {}
    const r = mergeProjectConfig(cfg, j({ mcp: {} }))
    expect(r.gatedExecutable).toEqual([])
  })
})

describe("isGlobalAlphaDir — home 目录实例不走项目级通道(REQ-060 真机发现)", () => {
  test("home dir: <dir>/.alpha == 全局 root → true", () => {
    expect(isGlobalAlphaDir("/Users/x", "/Users/x/.alpha")).toBe(true)
  })

  test("普通项目目录 → false", () => {
    expect(isGlobalAlphaDir("/Users/x/proj", "/Users/x/.alpha")).toBe(false)
  })

  test("尾斜线/非规范路径容忍(resolve 归一)", () => {
    expect(isGlobalAlphaDir("/Users/x/", "/Users/x/.alpha/")).toBe(true)
    expect(isGlobalAlphaDir("/Users/x/proj/..", "/Users/x/.alpha")).toBe(true)
  })

  test("测试覆盖的全局 root(ALPHA_GLOBAL_DIR 场景):项目目录恰含 .alpha 也不误判", () => {
    expect(isGlobalAlphaDir("/tmp/proj", "/custom/alpha-global")).toBe(false)
    expect(isGlobalAlphaDir("/custom", "/custom/alpha-global")).toBe(false)
    expect(isGlobalAlphaDir("/custom/alpha-global/..", "/custom/alpha-global")).toBe(false)
  })
})
