import { describe, expect, test } from "bun:test"
import { mergeProjectConfig } from "./project-config"

const j = (o: unknown) => JSON.stringify(o)

describe("mergeProjectConfig — project .alpha/alpha.jsonc → cfg", () => {
  test("merges project mcp / agent / command into cfg", () => {
    const cfg: Record<string, any> = {}
    const added = mergeProjectConfig(cfg, j({
      mcp: { projmcp: { type: "local" } },
      agent: { "proj-agent": { prompt: "hi" } },
      command: { "proj-cmd": { template: "t" } },
    }))
    expect(cfg.mcp.projmcp).toEqual({ type: "local" })
    expect(cfg.agent["proj-agent"]).toEqual({ prompt: "hi" })
    expect(cfg.command["proj-cmd"]).toEqual({ template: "t" })
    expect(added.sort()).toEqual(["agent.*", "command.*", "mcp.*"])
  })

  test("existing (global) wins — project doesn't overwrite same name", () => {
    const cfg: Record<string, any> = { mcp: { shared: { type: "GLOBAL" } } }
    mergeProjectConfig(cfg, j({ mcp: { shared: { type: "PROJECT" }, extra: { type: "local" } } }))
    expect(cfg.mcp.shared).toEqual({ type: "GLOBAL" }) // global preserved
    expect(cfg.mcp.extra).toEqual({ type: "local" }) // new added
  })

  test("skills.paths union (OBJECT schema, not array), dedup, existing first", () => {
    const cfg: Record<string, any> = { skills: { paths: ["/global/skills"] } }
    mergeProjectConfig(cfg, j({ skills: { paths: ["/global/skills", "/proj/.alpha/skills"] } }))
    expect(cfg.skills).toEqual({ paths: ["/global/skills", "/proj/.alpha/skills"] })
  })

  test("skills.paths into empty cfg → object form", () => {
    const cfg: Record<string, any> = {}
    const added = mergeProjectConfig(cfg, j({ skills: { paths: ["/proj/.alpha/skills"] } }))
    expect(cfg.skills).toEqual({ paths: ["/proj/.alpha/skills"] })
    expect(added).toContain("skills.paths")
  })

  test("empty project config → nothing added", () => {
    const cfg: Record<string, any> = { mcp: { x: {} } }
    expect(mergeProjectConfig(cfg, j({}))).toEqual([])
    expect(cfg.mcp).toEqual({ x: {} })
  })

  test("malformed json → no-op, no throw", () => {
    const cfg: Record<string, any> = {}
    expect(mergeProjectConfig(cfg, "{ not json ][")).toEqual([])
    expect(cfg).toEqual({})
  })

  test("jsonc comments + trailing commas tolerated", () => {
    const cfg: Record<string, any> = {}
    const text = `{
      // project mcp
      "mcp": { "a": { "type": "local" }, }, /* block */
    }`
    mergeProjectConfig(cfg, text)
    expect(cfg.mcp.a).toEqual({ type: "local" })
  })

  test("plugin domain NOT merged here (goes via host fan-out, ADR-006)", () => {
    const cfg: Record<string, any> = {}
    const added = mergeProjectConfig(cfg, j({ plugin: ["/proj/.alpha/plugins/x.js"] }))
    expect(cfg.plugin).toBeUndefined()
    expect(added).not.toContain("plugin")
  })
})
