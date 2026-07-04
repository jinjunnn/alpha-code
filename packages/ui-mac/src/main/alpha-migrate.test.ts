// Unit tests for legacy-install migration scan/remove (REQ-018 T3). Real temp legacy root via
// OPENCODE_CONFIG_DIR; asserts we find installs and remove them from the legacy root only, never
// touching unrelated content.

import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import * as fs from "node:fs"
import * as os from "node:os"
import * as path from "node:path"
import { isMigrationEnabled, removeLegacy, scanLegacy } from "./alpha-migrate"

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
