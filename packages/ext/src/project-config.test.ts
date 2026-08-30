import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, renameSync, rmSync, symlinkSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { mergeProjectConfig, projectDirectoryIdentity, requireAlphaGlobalRoot, withProjectDirectoryIdentity } from "./project-config"
import { AlphaExt } from "./plugin"

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
    mergeProjectConfig(cfg, j({ skills: { paths: ["/global/skills", "/proj/.code-puppy/skills"] } }))
    expect(cfg.skills).toEqual({ paths: ["/global/skills", "/proj/.code-puppy/skills"] })
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
    const { added } = mergeProjectConfig(cfg, j({ plugin: ["/proj/.code-puppy/plugins/x.js"] }), { trustExecutable: true })
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
      skills: { paths: ["/proj/.code-puppy/skills"] },
    }))
    expect(cfg.mcp).toBeUndefined() // executable gated — engine can't discover it
    expect(r.gatedExecutable).toContain("mcp")
    expect(cfg.agent.a).toBeDefined() // text-class loads regardless
    expect(cfg.command.c).toBeDefined()
    expect(cfg.skills.paths).toContain("/proj/.code-puppy/skills")
  })

  test("TRUSTED: mcp loads", () => {
    const cfg: Record<string, any> = {}
    const r = mergeProjectConfig(cfg, j({ mcp: { projmcp: { type: "local" } } }), { trustExecutable: true })
    expect(cfg.mcp.projmcp).toEqual({ type: "local" })
    expect(r.added).toContain("mcp.*")
    expect(r.gatedExecutable).toEqual([])
  })

  test("TRUSTED same-name MCP preserves the effective/global leaf and only adds absent project names", () => {
    const globalLeaf = { type: "local", command: ["npx", "global-owner"] }
    const cfg: Record<string, unknown> = { mcp: { shared: globalLeaf } }
    const result = mergeProjectConfig(
      cfg,
      j({
        mcp: {
          shared: { type: "local", command: ["npx", "project-owner"] },
          extra: { type: "local", command: ["npx", "project-extra"] },
        },
      }),
      { trustExecutable: true },
    )

    if (!cfg.mcp || typeof cfg.mcp !== "object" || Array.isArray(cfg.mcp)) throw new Error("mcp merge missing")
    expect((cfg.mcp as Record<string, unknown>).shared).toBe(globalLeaf)
    expect((cfg.mcp as Record<string, unknown>).extra).toEqual({ type: "local", command: ["npx", "project-extra"] })
    expect(result.added).toContain("mcp.*")
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
    expect(projectDirectoryIdentity(home, home).status).toBe("retired-home")
    expect(projectDirectoryIdentity(alias, home).status).toBe("retired-home")
    const admitted = projectDirectoryIdentity(project, home)
    expect(admitted.status).toBe("project")
    if (admitted.status === "project") expect(admitted.root).toBe(join(realpathSync(project), ".code-puppy"))
    expect(projectDirectoryIdentity(join(root, "missing"), home).status).toBe("unknown")
  })

  test("项目 `.alpha` terminal symlink 与退休根内项目均拒绝，sentinel 不被读取迁移", () => {
    const retired = join(home, ".alpha")
    mkdirSync(join(retired, "nested"), { recursive: true })
    writeFileSync(join(retired, "sentinel"), "untouched")
    symlinkSync(retired, join(project, ".code-puppy"), "dir")

    expect(projectDirectoryIdentity(project, home).status).toBe("unknown")
    expect(projectDirectoryIdentity(join(retired, "nested"), home).status).toBe("retired-home")
    expect(readFileSync(join(retired, "sentinel"), "utf8")).toBe("untouched")
  })

  test("退休 `~/.alpha` realpath 遇 EACCES → unknown，不回退词法放行", () => {
    const locked = join(root, "locked")
    mkdirSync(join(locked, "retired"), { recursive: true })
    symlinkSync(join(locked, "retired"), join(home, ".alpha"), "dir")
    chmodSync(locked, 0o000)
    try {
      expect(projectDirectoryIdentity(project, home)).toEqual({
        status: "unknown",
        reason: "retired global root identity cannot be confirmed",
      })
    } finally {
      chmodSync(locked, 0o700)
    }
  })

  test("分类后 `.alpha` 换链 → config 不读、alpha_register 不写、plugin 不 import", () => {
    const retired = join(home, ".alpha")
    const admittedRoot = join(project, ".code-puppy")
    const moved = join(project, ".code-puppy-before-race")
    mkdirSync(retired)
    mkdirSync(admittedRoot)
    writeFileSync(join(retired, "sentinel"), "untouched")
    const expected = projectDirectoryIdentity(project, home)
    expect(expected.status).toBe("project")
    if (expected.status !== "project") return
    renameSync(admittedRoot, moved)
    symlinkSync(retired, admittedRoot, "dir")
    const calls = { configRead: 0, registerWrite: 0, pluginImport: 0 }

    const configRead = withProjectDirectoryIdentity(expected, () => {
      calls.configRead++
      return "retired config"
    }, home)
    const registerWrite = withProjectDirectoryIdentity(expected, () => {
      calls.registerWrite++
      writeFileSync(join(retired, "alpha.jsonc"), "must not write")
    }, home)
    const pluginImport = withProjectDirectoryIdentity(expected, () => {
      calls.pluginImport++
      return import("./plugin")
    }, home)

    expect(configRead.ok).toBe(false)
    expect(registerWrite.ok).toBe(false)
    expect(pluginImport.ok).toBe(false)
    expect(calls).toEqual({ configRead: 0, registerWrite: 0, pluginImport: 0 })
    expect(readFileSync(join(retired, "sentinel"), "utf8")).toBe("untouched")
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

  test("`.alpha → retired root` 时 config、consent、fan-out、alpha_register 四路行为均零触达", async () => {
    const retired = join(home, ".alpha")
    mkdirSync(join(retired, "plugins"), { recursive: true })
    const config = JSON.stringify({ agent: { retired: { prompt: "must not load" } } })
    writeFileSync(join(retired, "alpha.jsonc"), config)
    writeFileSync(join(retired, "prefs.json"), JSON.stringify({ extensionsConsent: { version: 1, granted: true } }))
    writeFileSync(join(retired, "plugins", "retired.js"), "export default async () => ({ tool: { retired_tool: {} } })")
    writeFileSync(join(retired, "sentinel"), "untouched")
    symlinkSync(retired, join(project, ".code-puppy"), "dir")

    const global = join(root, "global", "env", "dev")
    mkdirSync(global, { recursive: true })
    const previous = process.env.ALPHA_GLOBAL_DIR
    process.env.ALPHA_GLOBAL_DIR = realpathSync(global)
    try {
      const hooks = await AlphaExt({
        directory: project,
        worktree: project,
        client: { instance: { dispose: async () => {} } },
      } as unknown as Parameters<typeof AlphaExt>[0])
      const exposed = hooks as unknown as {
        config: (cfg: Record<string, unknown>) => Promise<void>
        tool: Record<string, { execute: (args: { type: "agent"; name: string; entry: string }, ctx: { directory: string; sessionID: string }) => Promise<{ metadata: { ok: boolean } }> }>
      }
      const cfg: Record<string, unknown> = {}
      await exposed.config(cfg)
      expect((cfg.agent as Record<string, unknown>).retired).toBeUndefined()
      expect(exposed.tool.retired_tool).toBeUndefined()

      const registered = await exposed.tool.alpha_register.execute(
        { type: "agent", name: "new-agent", entry: JSON.stringify({ prompt: "write" }) },
        { directory: project, sessionID: "s1" },
      )
      expect(registered.metadata.ok).toBe(false)
      expect(readFileSync(join(retired, "alpha.jsonc"), "utf8")).toBe(config)
      expect(readFileSync(join(retired, "sentinel"), "utf8")).toBe("untouched")
    } finally {
      if (previous === undefined) delete process.env.ALPHA_GLOBAL_DIR
      else process.env.ALPHA_GLOBAL_DIR = previous
    }
  })
})
