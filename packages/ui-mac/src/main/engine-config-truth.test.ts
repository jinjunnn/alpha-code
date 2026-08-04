import { describe, expect, test } from "bun:test"
import { homedir } from "node:os"
import { join } from "node:path"
import {
  ALPHA_CONFIG_TOP_KEYS,
  alphaGlobalRoot,
  ensureSkillsPath,
  isAlphaOwnedConfig,
  isFactoryResourcePath,
  isJunkOnlyDir,
  OPENCODE_JUNK_ENTRIES,
  planConfigMerge,
  rewriteFactorySkillPaths,
  stripFactoryBuiltinPolicyLeaves,
} from "./engine-config-truth"

test("alphaGlobalRoot 无 main 快照时拒绝缺失、相对与退休根", () => {
  const saved = process.env.ALPHA_GLOBAL_DIR
  try {
    delete process.env.ALPHA_GLOBAL_DIR
    expect(() => alphaGlobalRoot()).toThrow()
    process.env.ALPHA_GLOBAL_DIR = "relative/root"
    expect(() => alphaGlobalRoot()).toThrow()
    process.env.ALPHA_GLOBAL_DIR = join(homedir(), ".alpha")
    expect(() => alphaGlobalRoot()).toThrow()
  } finally {
    if (saved === undefined) delete process.env.ALPHA_GLOBAL_DIR
    else process.env.ALPHA_GLOBAL_DIR = saved
  }
})

describe("ensureSkillsPath — skills.paths OBJECT form (真机 ConfigInvalidError 回归锁)", () => {
  test("empty config → skills = { paths: [dir] }(object,非数组)", () => {
    const c: Record<string, unknown> = {}
    expect(ensureSkillsPath(c, "/a/.alpha/skills")).toBe(true)
    expect(c.skills).toEqual({ paths: ["/a/.alpha/skills"] })
  })
  test("idempotent when already present in object.paths", () => {
    const c: Record<string, unknown> = { skills: { paths: ["/a/.alpha/skills"] } }
    expect(ensureSkillsPath(c, "/a/.alpha/skills")).toBe(false)
  })
  test("self-heals legacy ARRAY form → object.paths(真机 bug:引擎 schema 期望 object,拒绝数组)", () => {
    const c: Record<string, unknown> = { skills: ["/a/.alpha/skills"] }
    expect(ensureSkillsPath(c, "/a/.alpha/skills")).toBe(true)
    expect(c.skills).toEqual({ paths: ["/a/.alpha/skills"] })
  })
  test("preserves sibling skills fields + appends absent path", () => {
    const c: Record<string, unknown> = { skills: { paths: ["/other"], disabled: ["x"] } }
    ensureSkillsPath(c, "/a/.alpha/skills")
    expect((c.skills as any).paths).toEqual(["/other", "/a/.alpha/skills"])
    expect((c.skills as any).disabled).toEqual(["x"])
  })
})

// ── REQ-065:出厂技能 skills.paths 组重写(直指 app 资源;.alpha 零出厂件)────────────
const NAMES = ["skill-creator", "agent-creator"]
const NEW_DIRS = [
  "/Applications/alpha-code.app/Contents/Resources/skills/skill-creator",
  "/Applications/alpha-code.app/Contents/Resources/factory-skills/agent-creator",
]

describe("isFactoryResourcePath — 布局 + 出厂名单双重判定", () => {
  test("资源布局 + 名单内命中;名单外同布局(用户自加)不命中", () => {
    expect(isFactoryResourcePath(NEW_DIRS[0], NAMES)).toBe(true)
    expect(isFactoryResourcePath("/repo/packages/ui-mac/resources/factory-skills/agent-creator", NAMES)).toBe(true)
    expect(isFactoryResourcePath("/Users/x/proj/resources/skills/my-own-skill", NAMES)).toBe(false) // 名单外
    expect(isFactoryResourcePath("/a/.alpha/skills", NAMES)).toBe(false) // 用户安装物目录
    expect(isFactoryResourcePath("/x/skills/skill-creator", NAMES)).toBe(false) // 异布局
  })
})

describe("rewriteFactorySkillPaths — REQ-065 T1(每启动重写出厂组)", () => {
  test("fresh config: injects factory dirs alongside the user-installs dir", () => {
    const c: Record<string, unknown> = { skills: { paths: ["/a/.alpha/skills"] } }
    expect(rewriteFactorySkillPaths(c, NEW_DIRS, NAMES)).toBe(true)
    expect((c.skills as any).paths).toEqual(["/a/.alpha/skills", ...NEW_DIRS])
  })
  test("idempotent when already current", () => {
    const c: Record<string, unknown> = { skills: { paths: ["/a/.alpha/skills", ...NEW_DIRS] } }
    expect(rewriteFactorySkillPaths(c, NEW_DIRS, NAMES)).toBe(false)
  })
  test("app moved: stale factory paths from the old install are dropped, current ones injected", () => {
    const c: Record<string, unknown> = {
      skills: { paths: ["/a/.alpha/skills", "/Applications/old.app/Contents/Resources/skills/skill-creator"] },
    }
    expect(rewriteFactorySkillPaths(c, NEW_DIRS, NAMES)).toBe(true)
    expect((c.skills as any).paths).toEqual(["/a/.alpha/skills", ...NEW_DIRS])
  })
  test("disabled ([] dirs): strips factory entries, keeps user entries untouched", () => {
    const c: Record<string, unknown> = { skills: { paths: ["/users/own/path", NEW_DIRS[0]], disabled: ["x"] } }
    expect(rewriteFactorySkillPaths(c, [], NAMES)).toBe(true)
    expect((c.skills as any).paths).toEqual(["/users/own/path"])
    expect((c.skills as any).disabled).toEqual(["x"]) // 兄弟字段保留
  })
  test("no skills key + no dirs = no-op; malformed skills value gets normalized when writing", () => {
    const empty: Record<string, unknown> = {}
    expect(rewriteFactorySkillPaths(empty, NEW_DIRS, NAMES)).toBe(true)
    expect((empty.skills as any).paths).toEqual(NEW_DIRS)
    const arr: Record<string, unknown> = { skills: ["/legacy-array"] }
    expect(rewriteFactorySkillPaths(arr, NEW_DIRS, NAMES)).toBe(true)
    expect((arr.skills as any).paths).toEqual(NEW_DIRS) // 数组形态自愈为 object.paths(引擎 schema)
  })
})

const mcpNames = (...n: string[]) => new Set(n)
const pluginKeys = (...n: string[]) => new Set(n)

describe("isAlphaOwnedConfig", () => {
  test("empty / undefined parsed = owned no-op", () => {
    expect(isAlphaOwnedConfig({ parsed: undefined, receiptMcpNames: mcpNames(), receiptPluginKeys: pluginKeys() }).owned).toBe(true)
    expect(isAlphaOwnedConfig({ parsed: {}, receiptMcpNames: mcpNames(), receiptPluginKeys: pluginKeys() }).owned).toBe(true)
  })

  test("all-alpha config (mcp in receipts + governance) = owned", () => {
    const v = isAlphaOwnedConfig({
      parsed: {
        $schema: "https://opencode.ai/config.json",
        mcp: { markitdown: { type: "local" }, fetch: { type: "local" } },
        plugin: ["/Users/x/.alpha/plugins/notify.js"],
        agent: { "alpha-automation": { hidden: true } },
        permission: { skill: { "customize-opencode": "deny" } },
      },
      receiptMcpNames: mcpNames("markitdown", "fetch"),
      receiptPluginKeys: pluginKeys("plugin:opencode-notify@0.3.1"),
    })
    expect(v.owned).toBe(true)
  })

  test("stray top-level key (user-authored) = NOT owned, bail-out", () => {
    const v = isAlphaOwnedConfig({
      parsed: { mcp: {}, keybinds: { leader: "ctrl+x" } },
      receiptMcpNames: mcpNames(),
      receiptPluginKeys: pluginKeys(),
    })
    expect(v.owned).toBe(false)
    if (!v.owned) expect(v.reason).toContain("keybinds")
  })

  test("mcp not in receipts = STILL owned (.opencode is alpha territory), surfaced as unaccounted", () => {
    const v = isAlphaOwnedConfig({
      parsed: { mcp: { markitdown: { type: "local" }, myOwnServer: { type: "remote" } } },
      receiptMcpNames: mcpNames("markitdown"),
      receiptPluginKeys: pluginKeys(),
    })
    expect(v.owned).toBe(true) // 放宽:.opencode = alpha 写入领地,记账不全不 bail
    if (v.owned) {
      expect(v.unaccountedMcp).toContain("myOwnServer")
      expect(v.unaccountedMcp).not.toContain("markitdown") // 有 receipt 的不列
    }
  })

  test("top-key whitelist covers the alpha write domains", () => {
    for (const k of ["$schema", "mcp", "plugin", "agent", "permission", "command", "provider"]) {
      expect(ALPHA_CONFIG_TOP_KEYS.has(k)).toBe(true)
    }
    expect(ALPHA_CONFIG_TOP_KEYS.has("keybinds")).toBe(false)
  })
})

describe("isJunkOnlyDir", () => {
  test("only engine bootstrap junk = deletable", () => {
    expect(isJunkOnlyDir(["package.json", "node_modules", "opencode.jsonc"])).toBe(true)
    expect(isJunkOnlyDir(["opencode.jsonc"])).toBe(true) // only the config file (will be migrated/deleted)
    expect(isJunkOnlyDir([])).toBe(true)
  })

  test("user content present = NOT deletable", () => {
    expect(isJunkOnlyDir(["package.json", "skill"])).toBe(false) // a real user skill dir
    expect(isJunkOnlyDir(["mytool.ts"])).toBe(false)
  })

  test("junk whitelist is exactly the bootstrap set", () => {
    for (const e of ["package.json", "node_modules", "package-lock.json", "bun.lock", ".gitignore"]) {
      expect(OPENCODE_JUNK_ENTRIES.has(e)).toBe(true)
    }
    expect(OPENCODE_JUNK_ENTRIES.has("skill")).toBe(false)
  })

  test("custom config file names excluded from residual", () => {
    expect(isJunkOnlyDir(["opencode.json", "node_modules"], ["opencode.json"])).toBe(true)
  })
})

describe("planConfigMerge", () => {
  test("empty existing + legacy mcp → merged with schema, changed", () => {
    const p = planConfigMerge(undefined, { mcp: { markitdown: { type: "local" } } }, undefined)
    expect(p.changed).toBe(true)
    expect((p.merged.mcp as any).markitdown).toEqual({ type: "local" })
    expect(p.merged.$schema).toBe("https://opencode.ai/config.json")
    expect(p.added).toContain("mcp.*")
  })

  test("idempotent: existing already has the key → no change", () => {
    const existing = { $schema: "https://opencode.ai/config.json", mcp: { markitdown: { type: "local" } } }
    const p = planConfigMerge(existing, { mcp: { markitdown: { type: "OTHER" } } }, undefined)
    expect(p.changed).toBe(false) // existing wins (copy-don't-overwrite), name already present
    expect((p.merged.mcp as any).markitdown).toEqual({ type: "local" })
  })

  test("copy-don't-delete: legacy adds absent name, keeps existing", () => {
    const existing = { mcp: { markitdown: { type: "local" } } }
    const p = planConfigMerge(existing, { mcp: { markitdown: { type: "X" }, fetch: { type: "local" } } }, undefined)
    expect(p.changed).toBe(true)
    expect((p.merged.mcp as any).markitdown).toEqual({ type: "local" }) // existing preserved
    expect((p.merged.mcp as any).fetch).toEqual({ type: "local" }) // new added
  })

  test("XDG provider migrated into alpha truth", () => {
    const p = planConfigMerge(
      { $schema: "https://opencode.ai/config.json" },
      undefined,
      { provider: { deepseek: { options: { baseURL: "https://api.deepseek.com" } } } },
    )
    expect(p.changed).toBe(true)
    expect((p.merged.provider as any).deepseek).toBeDefined()
    expect(p.added).toContain("provider.*")
  })

  test("existing provider not clobbered by XDG copy", () => {
    const existing = { provider: { deepseek: { options: { baseURL: "ALPHA" } } } }
    const p = planConfigMerge(existing, undefined, { provider: { deepseek: { options: { baseURL: "XDG" } } } })
    expect(p.changed).toBe(false)
    expect((p.merged.provider as any).deepseek.options.baseURL).toBe("ALPHA")
  })

  // ADR-040(`#832`):legacy 的 plugin[] 不再并进来。断言分两条 —— 「既有那条还在」与「legacy 那条
  // 没进来」是两件事,只断长度或只断 changed 都会被「等量替换」这类错误实现满足。
  test("legacy plugin[] 不并入:existing 那条原样保留,legacy 独有的那条不出现", () => {
    const existing = { plugin: ["/a/.alpha/plugins/x.js"] }
    const p = planConfigMerge(existing, { plugin: ["/a/.alpha/plugins/x.js", "/a/.alpha/plugins/y.js"] }, undefined)
    expect(p.merged.plugin).toEqual(["/a/.alpha/plugins/x.js"]) // 逐元素:既有一个不少、legacy 一个不多
    expect(p.added).not.toContain("plugin[]")
    expect(p.changed).toBe(false) // 只有 plugin 有差异 ⇒ 没有任何可迁内容 ⇒ 免写盘
  })

  test("existing 根本没有 plugin 键时,legacy 的 plugin[] 也不会凭空造出这个键", () => {
    const p = planConfigMerge({ $schema: "https://opencode.ai/config.json" }, { plugin: ["/only-legacy.js"] }, undefined)
    expect(p.merged.plugin).toBeUndefined()
    expect(p.changed).toBe(false)
  })

  test("plugin 之外的域照常迁移(闸不能顺手把整次 merge 也一起关掉)", () => {
    const p = planConfigMerge(undefined, { mcp: { markitdown: { type: "local" } }, plugin: ["/p.js"] }, undefined)
    expect(p.changed).toBe(true)
    expect((p.merged.mcp as any).markitdown).toEqual({ type: "local" })
    expect(p.merged.plugin).toBeUndefined()
  })

  test("fully idempotent second pass = no change", () => {
    const legacy = { mcp: { markitdown: { type: "local" } }, plugin: ["/p.js"] }
    const first = planConfigMerge({ $schema: "https://opencode.ai/config.json" }, legacy, undefined)
    const second = planConfigMerge(first.merged, legacy, undefined)
    expect(second.changed).toBe(false)
  })
})

describe("stripFactoryBuiltinPolicyLeaves — REQ-067(出厂默认禁明文剥离)", () => {
  const NAMES2 = ["customize-opencode"]
  test("剥 permission.skill deny + 治理打底 + 占位 command(整链清空)", () => {
    const c: Record<string, unknown> = {
      permission: { skill: { "*": "allow", "customize-opencode": "deny" } },
      command: { "customize-opencode": { description: "(已禁用)该技能已在 alpha 治理中禁用", template: "x" } },
    }
    expect(stripFactoryBuiltinPolicyLeaves(c, NAMES2)).toBe(true)
    expect(c.permission).toBeUndefined() // skill 只剩打底 → 整链删
    expect(c.command).toBeUndefined()
  })
  test("用户自己的 deny 与自建同名 command 不碰", () => {
    const c: Record<string, unknown> = {
      permission: { skill: { "*": "allow", "customize-opencode": "deny", "my-skill": "deny" } },
      command: { "customize-opencode": { description: "user's own command", template: "y" } },
    }
    expect(stripFactoryBuiltinPolicyLeaves(c, NAMES2)).toBe(true)
    expect((c.permission as any).skill["my-skill"]).toBe("deny") // 用户自禁保留
    expect((c.permission as any).skill["*"]).toBe("allow")
    expect((c.command as any)["customize-opencode"].description).toBe("user's own command") // 无占位指纹不碰
  })
  test("幂等:干净配置 no-op", () => {
    const c: Record<string, unknown> = { skills: { paths: ["/a"] } }
    expect(stripFactoryBuiltinPolicyLeaves(c, NAMES2)).toBe(false)
  })
})
