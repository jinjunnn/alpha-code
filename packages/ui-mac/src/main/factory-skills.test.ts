// REQ-036/REQ-052/REQ-065 — factory skills reconcile (pure fs logic on temp dirs).
// REQ-065 形态的 load-bearing 用例:存量 .alpha 出厂链拆除(T2)+ 注入组计算(T1 的输入)、
// 幂等、绝不动用户内容、同名遮蔽不注入(防引擎双源)、REQ-059 逃生门不拆不改、
// legacy `~/.opencode/skill/` 直链清理。
import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { existsSync, mkdirSync, mkdtempSync, readlinkSync, rmSync, symlinkSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { FACTORY_SKILL_IDS, factorySkillIds, factorySkillSources, isAlphaFactoryLink, reconcileFactorySkills } from "./factory-skills"

let tmp: string
let home: string
let res: string
let sources: Record<string, string>
let roots: { alphaRoot: string; opencodeHome: string }

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "alpha-factory-"))
  home = join(tmp, "home")
  res = join(tmp, "app", "resources")
  mkdirSync(join(res, "skills", "skill-creator"), { recursive: true })
  writeFileSync(join(res, "skills", "skill-creator", "SKILL.md"), "---\nname: skill-creator\n---\n")
  for (const n of ["agent-creator", "customize-alpha", "integrate-project"]) {
    mkdirSync(join(res, "factory-skills", n), { recursive: true })
    writeFileSync(join(res, "factory-skills", n, "SKILL.md"), `---\nname: ${n}\n---\n`)
  }
  mkdirSync(home, { recursive: true })
  sources = factorySkillSources({ packaged: true, resourcesPath: res, moduleDir: "/nope" })
  roots = { alphaRoot: join(home, ".alpha"), opencodeHome: join(home, ".opencode") }
})
afterEach(() => {
  delete process.env.ALPHA_FACTORY_SKILLS_DISABLE
  delete process.env.ALPHA_JSONC_TRUTH_DISABLE
  delete process.env.ALPHA_LEGACY_INSTALL_ROOT
  rmSync(tmp, { recursive: true, force: true })
})

// 旧真源位(.alpha/skills,REQ-052 遗留)/ 旧直链位(.opencode/skill,REQ-036 初版)
const truthPath = (name: string) => join(home, ".alpha", "skills", name)
const legacyPath = (name: string) => join(home, ".opencode", "skill", name)

describe("factorySkillSources", () => {
  test("packaged resolves under resourcesPath; dev under moduleDir/../../resources", () => {
    expect(sources["skill-creator"]).toBe(join(res, "skills", "skill-creator"))
    const dev = factorySkillSources({ packaged: false, resourcesPath: "/ignored", moduleDir: join(tmp, "repo/out/main") })
    expect(dev["agent-creator"]).toBe(join(tmp, "repo/resources/factory-skills/agent-creator"))
  })
})

describe("reconcileFactorySkills — REQ-065(.alpha 零出厂件 + 注入组)", () => {
  test("clean env: no .alpha links created, paths point straight at app resources; idempotent", () => {
    const r1 = reconcileFactorySkills(sources, roots)
    expect(r1.paths.sort()).toEqual(Object.values(sources).sort())
    expect(r1.active.sort()).toEqual([...FACTORY_SKILL_IDS].sort())
    // 验收核心:~/.alpha 里零出厂件(连目录都不建)
    expect(existsSync(join(home, ".alpha", "skills"))).toBe(false)
    const r2 = reconcileFactorySkills(sources, roots)
    expect({ ...r2, paths: [...r2.paths].sort(), active: [...r2.active].sort() }).toEqual({
      paths: Object.values(sources).sort(),
      removed: [],
      migrated: [],
      skipped: [],
      active: [...FACTORY_SKILL_IDS].sort(),
    })
    expect(factorySkillIds().sort()).toEqual([...FACTORY_SKILL_IDS].sort()) // 徽标真相 = 就位名单
  })
  test("T2: dismantles OUR stale .alpha factory links (REQ-052 leftovers) and prunes the emptied dir", () => {
    mkdirSync(join(home, ".alpha", "skills"), { recursive: true })
    symlinkSync(sources["skill-creator"], truthPath("skill-creator"))
    symlinkSync("/Applications/old.app/Contents/Resources/factory-skills/agent-creator", truthPath("agent-creator"))
    const r = reconcileFactorySkills(sources, roots)
    expect(r.removed.sort()).toEqual(["agent-creator", "skill-creator"]) // 只有这两个有存量链
    expect(existsSync(truthPath("skill-creator"))).toBe(false)
    expect(existsSync(join(home, ".alpha", "skills"))).toBe(false) // 空目录顺手清
    expect(r.paths.sort()).toEqual(Object.values(sources).sort()) // 拆后照常注入
  })
  test("NEVER touches a real dir at ~/.alpha/skills (catalog-installed/user content) — factory path yields, no dup source", () => {
    mkdirSync(truthPath("skill-creator"), { recursive: true })
    writeFileSync(join(truthPath("skill-creator"), "SKILL.md"), "user's own\n")
    const r = reconcileFactorySkills(sources, roots)
    expect(r.skipped.some((s) => s.name === "skill-creator" && s.reason.includes("user content"))).toBe(true)
    expect(existsSync(join(truthPath("skill-creator"), "SKILL.md"))).toBe(true) // untouched
    const others = Object.entries(sources).filter(([n]) => n !== "skill-creator").map(([, p]) => p).sort()
    expect(r.paths.sort()).toEqual(others) // 同名让位:不注入 skill-creator
    expect(r.active).not.toContain("skill-creator")
  })
  test("NEVER removes a FOREIGN symlink at ~/.alpha/skills, even with the same name (codex High-1 精神)", () => {
    mkdirSync(join(home, ".alpha", "skills"), { recursive: true })
    mkdirSync(join(tmp, "their-skill"), { recursive: true })
    symlinkSync(join(tmp, "their-skill"), truthPath("skill-creator"))
    const r = reconcileFactorySkills(sources, roots)
    expect(r.skipped.some((x) => x.name === "skill-creator" && x.reason.includes("foreign"))).toBe(true)
    expect(readlinkSync(truthPath("skill-creator"))).toBe(join(tmp, "their-skill")) // untouched
    expect(r.paths).not.toContain(sources["skill-creator"]) // 目标未知 → 不注入防双源
    expect(r.active).not.toContain("skill-creator") // 徽标不吹牛(codex M4)
  })
  test("missing source is reported honestly, not silently skipped", () => {
    rmSync(join(res, "factory-skills"), { recursive: true })
    const r = reconcileFactorySkills(sources, roots)
    expect(r.skipped.some((s) => s.name === "agent-creator" && s.reason.includes("source missing"))).toBe(true)
    expect(r.paths).toEqual([sources["skill-creator"]])
  })
  test("ALPHA_FACTORY_SKILLS_DISABLE: cleanup still runs, injection group empty", () => {
    mkdirSync(join(home, ".alpha", "skills"), { recursive: true })
    symlinkSync(sources["skill-creator"], truthPath("skill-creator"))
    process.env.ALPHA_FACTORY_SKILLS_DISABLE = "1"
    const r = reconcileFactorySkills(sources, roots)
    expect(r.removed).toEqual(["skill-creator"]) // 存量链照拆(它们不再有合法形态)
    expect(r.paths).toEqual([])
    expect(r.active).toEqual([])
    expect(factorySkillIds()).toEqual([])
  })
  test("REQ-059 escape hatch (truth channel off): touches NOTHING — no dismantle, no injection (回退保两跳态)", () => {
    mkdirSync(join(home, ".alpha", "skills"), { recursive: true })
    symlinkSync(sources["skill-creator"], truthPath("skill-creator"))
    process.env.ALPHA_JSONC_TRUTH_DISABLE = "1"
    const r = reconcileFactorySkills(sources, roots)
    expect(r.removed).toEqual([])
    expect(r.paths).toEqual([])
    expect(readlinkSync(truthPath("skill-creator"))).toBe(sources["skill-creator"]) // 原样保留
    expect(r.skipped.every((s) => s.reason.includes("escape hatch"))).toBe(true)
  })
})

describe("legacy migration — REQ-036 初版 ~/.opencode/skill 直链", () => {
  test("removes OUR legacy direct links (and prunes the emptied dir); injection unaffected", () => {
    mkdirSync(join(home, ".opencode", "skill"), { recursive: true })
    symlinkSync(sources["skill-creator"], legacyPath("skill-creator"))
    symlinkSync("/Applications/old.app/Contents/Resources/factory-skills/agent-creator", legacyPath("agent-creator"))
    const r = reconcileFactorySkills(sources, roots)
    expect(r.migrated.sort()).toEqual(["agent-creator", "skill-creator"]) // 只有这两个有 legacy 直链
    expect(existsSync(legacyPath("skill-creator"))).toBe(false)
    expect(existsSync(join(home, ".opencode", "skill"))).toBe(false) // 空目录已顺手拆掉
    expect(r.paths.sort()).toEqual(Object.values(sources).sort())
    expect(existsSync(join(home, ".alpha", "skills"))).toBe(false) // 不再建任何 .alpha 出厂链
  })
  test("a user's real dir at the legacy path blocks the item (no duplicate-name double source)", () => {
    mkdirSync(legacyPath("skill-creator"), { recursive: true })
    writeFileSync(join(legacyPath("skill-creator"), "SKILL.md"), "user's own\n")
    const r = reconcileFactorySkills(sources, roots)
    expect(r.skipped.some((s) => s.name === "skill-creator" && s.reason.includes("user content"))).toBe(true)
    const others2 = Object.entries(sources).filter(([n]) => n !== "skill-creator").map(([, p]) => p).sort()
    expect(r.paths.sort()).toEqual(others2)
    expect(r.active).not.toContain("skill-creator")
    expect(existsSync(join(home, ".opencode", "skill"))).toBe(true) // 用户目录原样保留
  })
  test("a FOREIGN legacy symlink is left alone and blocks the item", () => {
    mkdirSync(join(home, ".opencode", "skill"), { recursive: true })
    mkdirSync(join(tmp, "their-skill"), { recursive: true })
    symlinkSync(join(tmp, "their-skill"), legacyPath("skill-creator"))
    const r = reconcileFactorySkills(sources, roots)
    expect(r.skipped.some((s) => s.name === "skill-creator" && s.reason.includes("legacy foreign"))).toBe(true)
    expect(readlinkSync(legacyPath("skill-creator"))).toBe(join(tmp, "their-skill")) // untouched
    expect(r.paths).not.toContain(sources["skill-creator"])
  })
})

describe("isAlphaFactoryLink — 自有链判定(同名 + alpha 资源布局)", () => {
  test("dev/packaged 布局命中;同名异布局/异名同布局都不命中", () => {
    expect(isAlphaFactoryLink("/repo/packages/ui-mac/resources/skills/skill-creator", "skill-creator")).toBe(true)
    expect(isAlphaFactoryLink("/Applications/alpha-code.app/Contents/Resources/factory-skills/agent-creator", "agent-creator")).toBe(true)
    expect(isAlphaFactoryLink("/their/skill", "skill-creator")).toBe(false)
    expect(isAlphaFactoryLink("/x/skills/foo", "skill-creator")).toBe(false) // 异名
    expect(isAlphaFactoryLink("/x/resources/skills/other", "skill-creator")).toBe(false)
  })
})
