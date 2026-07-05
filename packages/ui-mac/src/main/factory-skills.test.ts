// REQ-036 — factory skills path resolution (pure logic; fs probed via real temp dirs).
import { afterEach, describe, expect, test } from "bun:test"
import { mkdirSync, mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { FACTORY_SKILL_IDS, factorySkillIds, factorySkillsEnabled, resolveFactorySkillPaths } from "./factory-skills"

const tmp = mkdtempSync(join(tmpdir(), "alpha-factory-"))
afterEach(() => {
  delete process.env.ALPHA_FACTORY_SKILLS_DISABLE
})

describe("resolveFactorySkillPaths", () => {
  test("packaged: resolves under resourcesPath, reports missing dirs honestly", () => {
    const r = resolveFactorySkillPaths({ packaged: true, resourcesPath: tmp, moduleDir: "/nope" })
    expect(r.paths).toEqual([])
    expect(r.missing).toEqual([join(tmp, "skills", "skill-creator"), join(tmp, "factory-skills")])
  })
  test("existing dirs are returned in order (skill-creator first, factory dir second)", () => {
    mkdirSync(join(tmp, "skills", "skill-creator"), { recursive: true })
    mkdirSync(join(tmp, "factory-skills"), { recursive: true })
    const r = resolveFactorySkillPaths({ packaged: true, resourcesPath: tmp, moduleDir: "/nope" })
    expect(r.paths).toEqual([join(tmp, "skills", "skill-creator"), join(tmp, "factory-skills")])
    expect(r.missing).toEqual([])
  })
  test("dev: resolves relative to moduleDir/../../resources", () => {
    const dev = join(tmp, "repo", "out", "main")
    mkdirSync(join(tmp, "repo", "resources", "factory-skills"), { recursive: true })
    mkdirSync(dev, { recursive: true })
    const r = resolveFactorySkillPaths({ packaged: false, resourcesPath: "/ignored", moduleDir: dev })
    expect(r.paths).toContain(join(tmp, "repo", "resources", "factory-skills"))
  })
  test("escape hatch ALPHA_FACTORY_SKILLS_DISABLE=1 injects nothing", () => {
    process.env.ALPHA_FACTORY_SKILLS_DISABLE = "1"
    expect(factorySkillsEnabled()).toBe(false)
    expect(resolveFactorySkillPaths({ packaged: true, resourcesPath: tmp, moduleDir: "/nope" })).toEqual({
      paths: [],
      missing: [],
    })
    expect(factorySkillIds()).toEqual([])
  })
  test("factorySkillIds mirrors the shipped list when enabled", () => {
    expect(factorySkillIds()).toEqual([...FACTORY_SKILL_IDS])
  })
})

// cleanup
process.on("exit", () => rmSync(tmp, { recursive: true, force: true }))
