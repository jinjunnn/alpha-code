// REQ-036 — factory skills symlink-bridge reconcile (pure fs logic on temp dirs).
// The load-bearing cases: idempotence, re-point on app path change, never touching user content,
// and the escape hatch removing ONLY our links.
import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { existsSync, mkdirSync, mkdtempSync, readlinkSync, rmSync, symlinkSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { FACTORY_SKILL_IDS, factorySkillIds, factorySkillSources, reconcileFactorySkillLinks } from "./factory-skills"

let tmp: string
let home: string
let res: string
let sources: Record<string, string>

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "alpha-factory-"))
  home = join(tmp, "home")
  res = join(tmp, "app-resources")
  mkdirSync(join(res, "skills", "skill-creator"), { recursive: true })
  mkdirSync(join(res, "factory-skills", "agent-creator"), { recursive: true })
  writeFileSync(join(res, "skills", "skill-creator", "SKILL.md"), "---\nname: skill-creator\n---\n")
  writeFileSync(join(res, "factory-skills", "agent-creator", "SKILL.md"), "---\nname: agent-creator\n---\n")
  mkdirSync(home, { recursive: true })
  sources = factorySkillSources({ packaged: true, resourcesPath: res, moduleDir: "/nope" })
})
afterEach(() => {
  delete process.env.ALPHA_FACTORY_SKILLS_DISABLE
  rmSync(tmp, { recursive: true, force: true })
})

const linkPath = (name: string) => join(home, ".opencode", "skill", name)

describe("factorySkillSources", () => {
  test("packaged resolves under resourcesPath; dev under moduleDir/../../resources", () => {
    expect(sources["skill-creator"]).toBe(join(res, "skills", "skill-creator"))
    const dev = factorySkillSources({ packaged: false, resourcesPath: "/ignored", moduleDir: join(tmp, "repo/out/main") })
    expect(dev["agent-creator"]).toBe(join(tmp, "repo/resources/factory-skills/agent-creator"))
  })
})

describe("reconcileFactorySkillLinks", () => {
  test("creates both links; second run is a no-op", () => {
    const r1 = reconcileFactorySkillLinks(sources, home)
    expect(r1.linked.sort()).toEqual([...FACTORY_SKILL_IDS].sort())
    expect(readlinkSync(linkPath("skill-creator"))).toBe(sources["skill-creator"])
    const r2 = reconcileFactorySkillLinks(sources, home)
    expect(r2).toEqual({ linked: [], removed: [], skipped: [] })
  })
  test("re-points a stale link after the app moved", () => {
    mkdirSync(join(home, ".opencode", "skill"), { recursive: true })
    symlinkSync("/Applications/old.app/Contents/Resources/skills/skill-creator", linkPath("skill-creator"))
    const r = reconcileFactorySkillLinks(sources, home)
    expect(r.linked).toContain("skill-creator")
    expect(readlinkSync(linkPath("skill-creator"))).toBe(sources["skill-creator"])
  })
  test("NEVER replaces a user's real directory of the same name", () => {
    mkdirSync(linkPath("skill-creator"), { recursive: true })
    writeFileSync(join(linkPath("skill-creator"), "SKILL.md"), "user's own\n")
    const r = reconcileFactorySkillLinks(sources, home)
    expect(r.skipped.some((s) => s.name === "skill-creator")).toBe(true)
    expect(readlinkSync(linkPath("agent-creator"))).toBe(sources["agent-creator"]) // other link still made
    expect(() => readlinkSync(linkPath("skill-creator"))).toThrow() // still a real dir
  })
  test("missing source is reported honestly, not silently skipped", () => {
    rmSync(join(res, "factory-skills"), { recursive: true })
    const r = reconcileFactorySkillLinks(sources, home)
    expect(r.skipped.some((s) => s.name === "agent-creator" && s.reason.includes("source missing"))).toBe(true)
  })
  test("escape hatch removes OUR links but leaves user content", () => {
    reconcileFactorySkillLinks(sources, home)
    process.env.ALPHA_FACTORY_SKILLS_DISABLE = "1"
    const r = reconcileFactorySkillLinks(sources, home)
    expect(r.removed.sort()).toEqual([...FACTORY_SKILL_IDS].sort())
    expect(existsSync(linkPath("skill-creator"))).toBe(false)
    expect(factorySkillIds()).toEqual([])
  })
  test("escape hatch does not remove a user's real dir", () => {
    mkdirSync(linkPath("agent-creator"), { recursive: true })
    process.env.ALPHA_FACTORY_SKILLS_DISABLE = "1"
    const r = reconcileFactorySkillLinks(sources, home)
    expect(r.removed).toEqual([])
    expect(existsSync(linkPath("agent-creator"))).toBe(true)
  })
})
