// Unit tests for legacy-install migration scan/remove (REQ-018 T3). Real temp legacy root via
// OPENCODE_CONFIG_DIR; asserts we find installs and remove them from the legacy root only, never
// touching unrelated content.

import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import * as fs from "node:fs"
import * as os from "node:os"
import * as path from "node:path"
import { isMigrationEnabled, removeLegacy, scanLegacy, verifyLegacyProvenance, type ProvenanceRequest } from "./alpha-migrate"

let root = ""
const prev = process.env.OPENCODE_CONFIG_DIR
beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "alpha-migrate-"))
  process.env.OPENCODE_CONFIG_DIR = root
})
afterEach(() => {
  if (prev === undefined) delete process.env.OPENCODE_CONFIG_DIR
  else process.env.OPENCODE_CONFIG_DIR = prev
  fs.rmSync(root, { recursive: true, force: true })
})

function seedSkill(name: string) {
  const dir = path.join(root, "skills", name)
  fs.mkdirSync(dir, { recursive: true })
  fs.writeFileSync(path.join(dir, "SKILL.md"), `---\nname: ${name}\n---\n`, "utf8")
}
function seedAgent(name: string) {
  fs.mkdirSync(path.join(root, "agent"), { recursive: true })
  fs.writeFileSync(path.join(root, "agent", `${name}.md`), "---\ndescription: d\n---\n", "utf8")
}
function seedConfig(obj: unknown) {
  fs.writeFileSync(path.join(root, "opencode.jsonc"), JSON.stringify(obj, null, 2), "utf8")
}

describe("scanLegacy", () => {
  test("empty root → empty inventory", () => {
    const inv = scanLegacy()
    expect(inv).toMatchObject({ skills: [], agents: [], mcp: [], plugins: [] })
  })

  test("finds skills (with SKILL.md), agents, mcp keys, plugin pkgs", () => {
    seedSkill("safe-refactor")
    seedSkill("no-skill-md-here") // has dir but we'll break it below
    fs.rmSync(path.join(root, "skills", "no-skill-md-here", "SKILL.md"))
    seedAgent("my-agent")
    seedConfig({
      mcp: { markitdown: { type: "local", command: ["uvx", "markitdown-mcp"] } },
      plugin: ["opencode-notify@0.3.1", ["some-plugin", { opt: 1 }]],
    })
    const inv = scanLegacy()
    expect(inv.skills).toEqual(["safe-refactor"]) // dir without SKILL.md excluded
    expect(inv.agents).toEqual(["my-agent"])
    expect(inv.mcp.map((m) => m.name)).toEqual(["markitdown"])
    expect(inv.mcp[0]!.config).toMatchObject({ command: ["uvx", "markitdown-mcp"] })
    expect(inv.plugins).toEqual(["opencode-notify@0.3.1", "some-plugin"])
  })
})

describe("removeLegacy", () => {
  test("removes a skill dir, leaves siblings", () => {
    seedSkill("gone")
    seedSkill("stay")
    const r = removeLegacy("skill", "gone")
    expect(r.ok).toBe(true)
    expect(fs.existsSync(path.join(root, "skills", "gone"))).toBe(false)
    expect(fs.existsSync(path.join(root, "skills", "stay"))).toBe(true)
  })

  test("removes an agent md", () => {
    seedAgent("gone")
    expect(removeLegacy("agent", "gone").ok).toBe(true)
    expect(fs.existsSync(path.join(root, "agent", "gone.md"))).toBe(false)
  })

  test("removes an mcp key, preserves other config", () => {
    seedConfig({ model: "x", mcp: { a: { type: "local", command: ["npx"] }, b: { type: "local", command: ["bun"] } } })
    expect(removeLegacy("mcp", "a").ok).toBe(true)
    const cfg = JSON.parse(fs.readFileSync(path.join(root, "opencode.jsonc"), "utf8"))
    expect(cfg.mcp.a).toBeUndefined()
    expect(cfg.mcp.b).toBeDefined()
    expect(cfg.model).toBe("x")
  })

  test("removes a plugin from the array by base name (ignores version)", () => {
    seedConfig({ plugin: ["opencode-notify@0.3.1", "keep-me"] })
    expect(removeLegacy("plugin", "opencode-notify@9.9.9").ok).toBe(true)
    const cfg = JSON.parse(fs.readFileSync(path.join(root, "opencode.jsonc"), "utf8"))
    expect(cfg.plugin).toEqual(["keep-me"])
  })

  test("rejects unsafe names; missing items are no-op success", () => {
    expect(removeLegacy("skill", "../evil").ok).toBe(false)
    expect(removeLegacy("skill", "never-there").ok).toBe(true)
  })
})

describe("isMigrationEnabled — gated off by default (A6/T8)", () => {
  test("off unless ALPHA_MIGRATE_ENABLE=1", () => {
    delete process.env.ALPHA_MIGRATE_ENABLE
    expect(isMigrationEnabled()).toBe(false)
    process.env.ALPHA_MIGRATE_ENABLE = "1"
    try {
      expect(isMigrationEnabled()).toBe(true)
    } finally {
      delete process.env.ALPHA_MIGRATE_ENABLE
    }
  })
})

// REQ-044 ①:provenance 终审 —— 名字命中只是候选,必须证明是 alpha 自装才放行(fail-closed)。
describe("verifyLegacyProvenance (REQ-044)", () => {
  let resources = ""
  beforeEach(() => {
    resources = fs.mkdtempSync(path.join(os.tmpdir(), "alpha-res-"))
  })
  afterEach(() => {
    fs.rmSync(resources, { recursive: true, force: true })
  })

  function seedAsset(name: string, files: Record<string, string>) {
    const dir = path.join(resources, "skills", name)
    fs.mkdirSync(dir, { recursive: true })
    for (const [rel, content] of Object.entries(files)) {
      fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true })
      fs.writeFileSync(path.join(dir, rel), content, "utf8")
    }
  }
  function seedLegacySkill(name: string, files: Record<string, string>) {
    const dir = path.join(root, "skills", name)
    fs.mkdirSync(dir, { recursive: true })
    for (const [rel, content] of Object.entries(files)) {
      fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true })
      fs.writeFileSync(path.join(dir, rel), content, "utf8")
    }
  }
  const skillReq = (name: string): ProvenanceRequest => ({ type: "skill", name, builtinAssetKey: `skills/${name}` })
  const one = (req: ProvenanceRequest) => verifyLegacyProvenance([req], resources)[0]!

  test("skill: byte-identical copy of the packaged asset → verified", () => {
    const files = { "SKILL.md": "---\nname: s\n---\nbody\n", "ref/notes.md": "n\n" }
    seedAsset("safe-refactor", files)
    seedLegacySkill("safe-refactor", files)
    expect(one(skillReq("safe-refactor")).verified).toBe(true)
  })

  test("skill: one-byte drift / extra file / missing file → excluded (user-authored or modified)", () => {
    seedAsset("safe-refactor", { "SKILL.md": "same\n" })
    seedLegacySkill("safe-refactor", { "SKILL.md": "same!\n" })
    expect(one(skillReq("safe-refactor")).verified).toBe(false)

    seedLegacySkill("extra", { "SKILL.md": "same\n", "mine.md": "user file\n" })
    seedAsset("extra", { "SKILL.md": "same\n" })
    expect(one(skillReq("extra")).verified).toBe(false)

    seedAsset("missing", { "SKILL.md": "same\n", "ref/deep.md": "d\n" })
    seedLegacySkill("missing", { "SKILL.md": "same\n" })
    expect(one(skillReq("missing")).verified).toBe(false)
  })

  test("skill: user-authored same-name (asset not bundled / no asset key) → excluded", () => {
    // S21 real-machine case: user-authored mcp-builder collides with a catalog name whose asset
    // never shipped — must never be offered for migration.
    seedLegacySkill("mcp-builder", { "SKILL.md": "user's own content\n" })
    const v = one(skillReq("mcp-builder"))
    expect(v.verified).toBe(false)
    expect(v.reason).toContain("not bundled")
    expect(one({ type: "skill", name: "mcp-builder" }).verified).toBe(false) // no asset key at all
  })

  const mcpSpec = { mcpType: "local" as const, command: ["uvx", "markitdown-mcp@0.0.1a4"], requiredEnvVars: [] as string[] }

  test("mcp: alpha-shaped legacy config (unpinned or older pin) → verified", () => {
    seedConfig({ mcp: { markitdown: { type: "local", command: ["uvx", "markitdown-mcp"] } } })
    expect(one({ type: "mcp", name: "markitdown", spec: mcpSpec }).verified).toBe(true)
    seedConfig({ mcp: { markitdown: { type: "local", command: ["uvx", "markitdown-mcp@0.0.1a1"], enabled: true } } })
    expect(one({ type: "mcp", name: "markitdown", spec: mcpSpec }).verified).toBe(true)
  })

  test("mcp: user-custom env var / foreign key / extra arg → excluded", () => {
    seedConfig({ mcp: { markitdown: { type: "local", command: ["uvx", "markitdown-mcp"], environment: { MY_SECRET: "x" } } } })
    expect(one({ type: "mcp", name: "markitdown", spec: mcpSpec }).verified).toBe(false)

    seedConfig({ mcp: { markitdown: { type: "local", command: ["uvx", "markitdown-mcp"], note: "mine" } } })
    expect(one({ type: "mcp", name: "markitdown", spec: mcpSpec }).verified).toBe(false)

    seedConfig({ mcp: { markitdown: { type: "local", command: ["uvx", "markitdown-mcp", "--my-flag"] } } })
    expect(one({ type: "mcp", name: "markitdown", spec: mcpSpec }).verified).toBe(false)
  })

  test("mcp: declared env var allowed; concrete workspace arg matches template by count", () => {
    const spec = {
      mcpType: "local" as const,
      command: ["npx", "-y", "@modelcontextprotocol/server-github@2025.4.8"],
      requiredEnvVars: ["GITHUB_PERSONAL_ACCESS_TOKEN"],
    }
    seedConfig({
      mcp: {
        github: {
          type: "local",
          command: ["npx", "-y", "@modelcontextprotocol/server-github"],
          environment: { GITHUB_PERSONAL_ACCESS_TOKEN: "tok" },
        },
      },
    })
    expect(one({ type: "mcp", name: "github", spec }).verified).toBe(true)
    const fsSpec = { mcpType: "local" as const, command: ["npx", "-y", "@modelcontextprotocol/server-filesystem@2026.1.14", "{workspace}"] }
    seedConfig({ mcp: { filesystem: { type: "local", command: ["npx", "-y", "@modelcontextprotocol/server-filesystem", "/Users/me/proj"] } } })
    expect(one({ type: "mcp", name: "filesystem", spec: fsSpec }).verified).toBe(true)
  })

  test("plugin: unpinned or same pin → verified; different pin or path → excluded", () => {
    seedConfig({ plugin: ["opencode-notify"] })
    expect(one({ type: "plugin", name: "opencode-notify", package: "opencode-notify@0.3.1" }).verified).toBe(true)
    seedConfig({ plugin: ["opencode-notify@0.3.1"] })
    expect(one({ type: "plugin", name: "opencode-notify", package: "opencode-notify@0.3.1" }).verified).toBe(true)
    seedConfig({ plugin: ["opencode-notify@9.9.9"] })
    expect(one({ type: "plugin", name: "opencode-notify", package: "opencode-notify@0.3.1" }).verified).toBe(false)
    seedConfig({ plugin: [] })
    expect(one({ type: "plugin", name: "opencode-notify", package: "opencode-notify@0.3.1" }).verified).toBe(false)
  })
})
