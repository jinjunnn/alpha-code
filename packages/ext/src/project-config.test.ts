import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { mergeProjectConfig, projectDirectoryIdentity, requireAlphaGlobalRoot } from "./project-config"

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

describe("project/root identity fail-closed", () => {
  let root = ""
  let home = ""
  let project = ""

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "alpha-ext-identity-"))
    home = join(root, "home")
    project = join(root, "project")
    mkdirSync(home)
    mkdirSync(project)
  })

  afterEach(() => rmSync(root, { recursive: true, force: true }))

  test("home、home symlink alias 拒绝；普通项目放行；身份不明拒绝", () => {
    const alias = join(root, "home-alias")
    symlinkSync(home, alias)
    expect(projectDirectoryIdentity(home, home)).toBe("retired-home")
    expect(projectDirectoryIdentity(alias, home)).toBe("retired-home")
    expect(projectDirectoryIdentity(project, home)).toBe("project")
    expect(projectDirectoryIdentity(join(root, "missing"), home)).toBe("unknown")
  })

  test("ext 初始化 root 缺失、相对、退休根关系与 symlink alias 一律拒绝", () => {
    const retired = join(home, ".alpha")
    mkdirSync(retired)
    const alias = join(root, "retired-alias")
    symlinkSync(retired, alias)
    expect(() => requireAlphaGlobalRoot(undefined, home)).toThrow()
    expect(() => requireAlphaGlobalRoot("relative/root", home)).toThrow()
    for (const candidate of [home, retired, join(retired, "child"), alias])
      expect(() => requireAlphaGlobalRoot(candidate, home)).toThrow()
  })

  test("main 派生的 canonical 新根通过；非 canonical safe alias 也拒绝", () => {
    const state = join(root, "state", "env", "dev")
    mkdirSync(state, { recursive: true })
    expect(requireAlphaGlobalRoot(realpathSync(state), home)).toBe(realpathSync(state))
    const alias = join(root, "state-alias")
    symlinkSync(state, alias)
    expect(() => requireAlphaGlobalRoot(alias, home)).toThrow()
  })

  test("plugin 将三态 identity gate 接到 config、consent、fan-out 与 alpha_register", () => {
    const source = readFileSync(join(import.meta.dir, "plugin.ts"), "utf8")
    expect(source).toContain("if (projectAllowed(input.directory))")
    expect(source).toContain('if (projectDirectoryIdentity(dir) !== "project") return false')
    expect(source).toContain("const trusted = projectAllowed(input.directory) && readProjectExtensionsConsent(input.directory)")
    expect(source).toContain("if (!projectAllowed(ctx.directory))")
  })
})
