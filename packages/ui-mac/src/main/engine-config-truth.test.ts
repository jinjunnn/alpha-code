import { describe, expect, test } from "bun:test"
import {
  ALPHA_CONFIG_TOP_KEYS,
  isAlphaOwnedConfig,
  isJunkOnlyDir,
  OPENCODE_JUNK_ENTRIES,
  planConfigMerge,
} from "./engine-config-truth"

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

  test("plugin[] union dedup, existing order preserved", () => {
    const existing = { plugin: ["/a/.alpha/plugins/x.js"] }
    const p = planConfigMerge(existing, { plugin: ["/a/.alpha/plugins/x.js", "/a/.alpha/plugins/y.js"] }, undefined)
    expect(p.changed).toBe(true)
    expect(p.merged.plugin).toEqual(["/a/.alpha/plugins/x.js", "/a/.alpha/plugins/y.js"])
  })

  test("fully idempotent second pass = no change", () => {
    const legacy = { mcp: { markitdown: { type: "local" } }, plugin: ["/p.js"] }
    const first = planConfigMerge({ $schema: "https://opencode.ai/config.json" }, legacy, undefined)
    const second = planConfigMerge(first.merged, legacy, undefined)
    expect(second.changed).toBe(false)
  })
})
