// REQ-036/REQ-052 — factory skills two-hop bridge reconcile (pure fs logic on temp dirs).
// The load-bearing cases: idempotence, re-point on app path change, never touching user content,
// the escape hatch removing ONLY our links, and legacy `~/.opencode/skill/` direct-link migration.
import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { existsSync, mkdirSync, mkdtempSync, readlinkSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { FACTORY_SKILL_IDS, factorySkillIds, factorySkillSources, isAlphaFactoryLink, reconcileFactorySkillLinks } from "./factory-skills"

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
  mkdirSync(join(res, "factory-skills", "agent-creator"), { recursive: true })
  writeFileSync(join(res, "skills", "skill-creator", "SKILL.md"), "---\nname: skill-creator\n---\n")
  writeFileSync(join(res, "factory-skills", "agent-creator", "SKILL.md"), "---\nname: agent-creator\n---\n")
  mkdirSync(home, { recursive: true })
  sources = factorySkillSources({ packaged: true, resourcesPath: res, moduleDir: "/nope" })
  roots = { alphaRoot: join(home, ".alpha"), opencodeHome: join(home, ".opencode") }
})
afterEach(() => {
  delete process.env.ALPHA_FACTORY_SKILLS_DISABLE
  rmSync(tmp, { recursive: true, force: true })
})

// 真源(.alpha)/ 引擎可见位(.opencode/skills,经桥)/ 旧直链位(.opencode/skill,迁移源)
const truthPath = (name: string) => join(home, ".alpha", "skills", name)
const enginePath = (name: string) => join(home, ".opencode", "skills", name)
const legacyPath = (name: string) => join(home, ".opencode", "skill", name)

describe("factorySkillSources", () => {
  test("packaged resolves under resourcesPath; dev under moduleDir/../../resources", () => {
    expect(sources["skill-creator"]).toBe(join(res, "skills", "skill-creator"))
    const dev = factorySkillSources({ packaged: false, resourcesPath: "/ignored", moduleDir: join(tmp, "repo/out/main") })
    expect(dev["agent-creator"]).toBe(join(tmp, "repo/resources/factory-skills/agent-creator"))
  })
})

describe("reconcileFactorySkillLinks — two-hop (.alpha truth + bridge)", () => {
  test("creates truth links in .alpha, bridges via .opencode/skills; second run is a stable no-op", () => {
    const r1 = reconcileFactorySkillLinks(sources, roots)
    expect(r1.linked.sort()).toEqual([...FACTORY_SKILL_IDS].sort())
    expect(r1.active.sort()).toEqual([...FACTORY_SKILL_IDS].sort())
    // truth = .alpha 内 symlink → app 资源(零拷贝);引擎经 skills.paths(alpha.jsonc)发现,无 .opencode 桥
    expect(readlinkSync(truthPath("skill-creator"))).toBe(sources["skill-creator"])
    // T3 不变量:.opencode 内不再建任何 alpha skills 桥
    expect(existsSync(enginePath("skill-creator"))).toBe(false)
    expect(existsSync(legacyPath("skill-creator"))).toBe(false)
    const r2 = reconcileFactorySkillLinks(sources, roots)
    expect({ ...r2, active: [...r2.active].sort() }).toEqual({
      linked: [],
      removed: [],
      migrated: [],
      skipped: [],
      active: [...FACTORY_SKILL_IDS].sort(),
    })
    expect(factorySkillIds().sort()).toEqual([...FACTORY_SKILL_IDS].sort()) // 徽标真相 = 就位名单
  })
  test("re-points a stale ALPHA truth link after the app moved (Resources layout + same name)", () => {
    mkdirSync(join(home, ".alpha", "skills"), { recursive: true })
    symlinkSync("/Applications/old.app/Contents/Resources/skills/skill-creator", truthPath("skill-creator"))
    const r = reconcileFactorySkillLinks(sources, roots)
    expect(r.linked).toContain("skill-creator")
    expect(readlinkSync(truthPath("skill-creator"))).toBe(sources["skill-creator"])
  })
  test("NEVER re-points a FOREIGN symlink at the truth path, even with the same name (codex High-1)", () => {
    mkdirSync(join(home, ".alpha", "skills"), { recursive: true })
    mkdirSync(join(tmp, "their-skill"), { recursive: true })
    symlinkSync(join(tmp, "their-skill"), truthPath("skill-creator"))
    const r = reconcileFactorySkillLinks(sources, roots)
    expect(r.skipped.some((x) => x.name === "skill-creator" && x.reason.includes("foreign"))).toBe(true)
    expect(readlinkSync(truthPath("skill-creator"))).toBe(join(tmp, "their-skill")) // untouched
    expect(r.active).not.toContain("skill-creator") // 徽标不吹牛(codex M4)
  })
  test("NEVER replaces a real directory at the truth path (catalog-installed / user content)", () => {
    mkdirSync(truthPath("skill-creator"), { recursive: true })
    writeFileSync(join(truthPath("skill-creator"), "SKILL.md"), "user's own\n")
    const r = reconcileFactorySkillLinks(sources, roots)
    expect(r.skipped.some((s) => s.name === "skill-creator")).toBe(true)
    expect(() => readlinkSync(truthPath("skill-creator"))).toThrow() // still a real dir
    expect(readlinkSync(truthPath("agent-creator"))).toBe(sources["agent-creator"]) // other link still made
    expect(r.active).toContain("agent-creator")
  })
  // (T3 REQ-059:桥退役 —— 原「不替换 .opencode/skills 内异源 item 链」测试随桥删除;引擎现经
  //  skills.paths 发现 .alpha 真源,不再往 .opencode 建任何 skills 链。存量 .opencode/skills 桥由
  //  reconcileEngineConfigTruth 的 cleanup 拆除,并有独立 boot 单测覆盖异源链保护。)
  test("missing source is reported honestly, not silently skipped", () => {
    rmSync(join(res, "factory-skills"), { recursive: true })
    const r = reconcileFactorySkillLinks(sources, roots)
    expect(r.skipped.some((s) => s.name === "agent-creator" && s.reason.includes("source missing"))).toBe(true)
  })
  test("escape hatch removes OUR truth links (engine loses sight) but leaves user content", () => {
    reconcileFactorySkillLinks(sources, roots)
    process.env.ALPHA_FACTORY_SKILLS_DISABLE = "1"
    const r = reconcileFactorySkillLinks(sources, roots)
    expect(r.removed.sort()).toEqual([...FACTORY_SKILL_IDS].sort())
    expect(existsSync(truthPath("skill-creator"))).toBe(false)
    expect(factorySkillIds()).toEqual([])
  })
  test("escape hatch does not remove a real dir at the truth path", () => {
    mkdirSync(truthPath("agent-creator"), { recursive: true })
    process.env.ALPHA_FACTORY_SKILLS_DISABLE = "1"
    const r = reconcileFactorySkillLinks(sources, roots)
    expect(r.removed).toEqual([])
    expect(existsSync(truthPath("agent-creator"))).toBe(true)
  })
  test("escape hatch does NOT remove a foreign symlink even if it points at some skills/ path (codex High-2)", () => {
    mkdirSync(join(home, ".alpha", "skills"), { recursive: true })
    mkdirSync(join(tmp, "other-tool", "skills", "foo"), { recursive: true })
    symlinkSync(join(tmp, "other-tool", "skills", "foo"), truthPath("skill-creator")) // 名字不同 → 非我们的
    process.env.ALPHA_FACTORY_SKILLS_DISABLE = "1"
    const r = reconcileFactorySkillLinks(sources, roots)
    expect(r.removed).toEqual([])
    expect(existsSync(truthPath("skill-creator"))).toBe(true)
  })
})

describe("legacy migration — REQ-036 初版 ~/.opencode/skill 直链", () => {
  test("migrates OUR legacy direct links to the two-hop layout (and prunes the emptied dir)", () => {
    mkdirSync(join(home, ".opencode", "skill"), { recursive: true })
    symlinkSync(sources["skill-creator"], legacyPath("skill-creator"))
    symlinkSync("/Applications/old.app/Contents/Resources/factory-skills/agent-creator", legacyPath("agent-creator"))
    const r = reconcileFactorySkillLinks(sources, roots)
    expect(r.migrated.sort()).toEqual([...FACTORY_SKILL_IDS].sort())
    expect(r.active.sort()).toEqual([...FACTORY_SKILL_IDS].sort())
    expect(existsSync(legacyPath("skill-creator"))).toBe(false)
    expect(existsSync(join(home, ".opencode", "skill"))).toBe(false) // 空目录已顺手拆掉
    expect(readlinkSync(truthPath("skill-creator"))).toBe(sources["skill-creator"]) // 真源(引擎经 skills.paths 发现)
  })
  test("a user's real dir at the legacy path blocks the whole item (no duplicate-name double source)", () => {
    mkdirSync(legacyPath("skill-creator"), { recursive: true })
    writeFileSync(join(legacyPath("skill-creator"), "SKILL.md"), "user's own\n")
    const r = reconcileFactorySkillLinks(sources, roots)
    expect(r.skipped.some((s) => s.name === "skill-creator" && s.reason.includes("user content"))).toBe(true)
    expect(existsSync(truthPath("skill-creator"))).toBe(false) // 不另建同名出厂链
    expect(r.active).not.toContain("skill-creator")
    expect(r.active).toContain("agent-creator")
    expect(existsSync(join(home, ".opencode", "skill"))).toBe(true) // 用户目录原样保留
  })
  test("a FOREIGN legacy symlink is left alone and blocks the item", () => {
    mkdirSync(join(home, ".opencode", "skill"), { recursive: true })
    mkdirSync(join(tmp, "their-skill"), { recursive: true })
    symlinkSync(join(tmp, "their-skill"), legacyPath("skill-creator"))
    const r = reconcileFactorySkillLinks(sources, roots)
    expect(r.skipped.some((s) => s.name === "skill-creator" && s.reason.includes("legacy foreign"))).toBe(true)
    expect(readlinkSync(legacyPath("skill-creator"))).toBe(join(tmp, "their-skill")) // untouched
    expect(existsSync(truthPath("skill-creator"))).toBe(false)
  })
  test("disabled + legacy links present: migration still clears our old links, nothing is recreated", () => {
    mkdirSync(join(home, ".opencode", "skill"), { recursive: true })
    symlinkSync(sources["skill-creator"], legacyPath("skill-creator"))
    process.env.ALPHA_FACTORY_SKILLS_DISABLE = "1"
    const r = reconcileFactorySkillLinks(sources, roots)
    expect(r.migrated).toEqual(["skill-creator"])
    expect(existsSync(legacyPath("skill-creator"))).toBe(false)
    expect(existsSync(truthPath("skill-creator"))).toBe(false)
    expect(factorySkillIds()).toEqual([])
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
