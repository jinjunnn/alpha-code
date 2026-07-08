// REQ-063 — 外部生态继承 default-deny + consent 导入(检测/转换/记账纯逻辑,temp 目录)。
import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import * as fs from "node:fs"
import * as os from "node:os"
import * as path from "node:path"
import {
  applyEcosystemDefaultDeny,
  detectExternal,
  EXTERNAL_IMPORT_VERSION,
  hasExternalImportDecision,
  importExternalSkills,
  importGlobalClaudeMd,
  importProjectClaudeMd,
  listAlphaInstructionFiles,
  readGlobalGateMarker,
  withExternalImportDecision,
  writeGlobalGateMarker,
} from "./ecosystem-import"

let tmp: string
const savedEnv: Record<string, string | undefined> = {}
const ENV_KEYS = ["ALPHA_ECOSYSTEM_INHERIT", "OPENCODE_DISABLE_EXTERNAL_SKILLS", "OPENCODE_DISABLE_CLAUDE_CODE_PROMPT", "ALPHA_GLOBAL_DIR"]

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "alpha-eco-"))
  for (const k of ENV_KEYS) {
    savedEnv[k] = process.env[k]
    delete process.env[k]
  }
  process.env.ALPHA_GLOBAL_DIR = path.join(tmp, ".alpha")
})
afterEach(() => {
  for (const k of ENV_KEYS) {
    if (savedEnv[k] === undefined) delete process.env[k]
    else process.env[k] = savedEnv[k]
  }
  fs.rmSync(tmp, { recursive: true, force: true })
})

const mkSkill = (root: string, family: ".claude" | ".agents", name: string) => {
  const dir = path.join(root, family, "skills", name)
  fs.mkdirSync(dir, { recursive: true })
  fs.writeFileSync(path.join(dir, "SKILL.md"), `---\nname: ${name}\ndescription: x\n---\nbody\n`)
  return dir
}

describe("applyEcosystemDefaultDeny — T1(set-if-unset + 逃生)", () => {
  test("默认注入两 flag = 1", () => {
    const env: NodeJS.ProcessEnv = {}
    applyEcosystemDefaultDeny(env)
    expect(env.OPENCODE_DISABLE_EXTERNAL_SKILLS).toBe("1")
    expect(env.OPENCODE_DISABLE_CLAUDE_CODE_PROMPT).toBe("1")
  })
  test("shell 显式值优先(set-if-unset,B21 纪律)", () => {
    const env: NodeJS.ProcessEnv = { OPENCODE_DISABLE_EXTERNAL_SKILLS: "0" }
    applyEcosystemDefaultDeny(env)
    expect(env.OPENCODE_DISABLE_EXTERNAL_SKILLS).toBe("0") // 用户显式恢复继承,尊重
    expect(env.OPENCODE_DISABLE_CLAUDE_CODE_PROMPT).toBe("1")
  })
  test("ALPHA_ECOSYSTEM_INHERIT=1 → 不注入任何 flag(整机恢复上游行为)", () => {
    const env: NodeJS.ProcessEnv = { ALPHA_ECOSYSTEM_INHERIT: "1" }
    applyEcosystemDefaultDeny(env)
    expect(env.OPENCODE_DISABLE_EXTERNAL_SKILLS).toBeUndefined()
    expect(env.OPENCODE_DISABLE_CLAUDE_CODE_PROMPT).toBeUndefined()
  })
})

describe("detectExternal — 只报上游真会继承的范围", () => {
  test("project:.claude/.agents skills + 根 CLAUDE.md;.claude/CLAUDE.md 不算项目级", () => {
    const proj = path.join(tmp, "proj")
    mkSkill(proj, ".claude", "graphify")
    mkSkill(proj, ".agents", "helper")
    fs.mkdirSync(proj, { recursive: true })
    fs.writeFileSync(path.join(proj, "CLAUDE.md"), "# rules\n")
    fs.writeFileSync(path.join(proj, ".claude", "CLAUDE.md"), "# not project-level\n")
    const r = detectExternal(proj, "project")
    expect(r.skills.map((s) => `${s.source}:${s.name}`).sort()).toEqual(["agents:helper", "claude:graphify"])
    expect(r.claudeMd).toBe(path.join(proj, "CLAUDE.md"))
  })
  test("global:CLAUDE.md 只认 ~/.claude/CLAUDE.md;家目录根 CLAUDE.md 不算", () => {
    const home = path.join(tmp, "home")
    mkSkill(home, ".claude", "graphify")
    fs.writeFileSync(path.join(home, "CLAUDE.md"), "# stray\n")
    expect(detectExternal(home, "global").claudeMd).toBeNull()
    fs.mkdirSync(path.join(home, ".claude"), { recursive: true })
    fs.writeFileSync(path.join(home, ".claude", "CLAUDE.md"), "# global rules\n")
    expect(detectExternal(home, "global").claudeMd).toBe(path.join(home, ".claude", "CLAUDE.md"))
  })
  test("无 SKILL.md 的目录 / 隐藏目录不算技能;空根 = 零检出", () => {
    const proj = path.join(tmp, "p2")
    fs.mkdirSync(path.join(proj, ".claude", "skills", "not-a-skill"), { recursive: true })
    fs.mkdirSync(path.join(proj, ".claude", "skills", ".hidden"), { recursive: true })
    const r = detectExternal(proj, "project")
    expect(r.skills).toEqual([])
    expect(detectExternal(path.join(tmp, "nope"), "project")).toEqual({ skills: [], claudeMd: null })
  })
})

describe("转换导入 — 快照 + 溯源 + 不碰源", () => {
  test("global skills:落 ~/.alpha/skills + receipts origin 按来源(imported-claude/agents);源目录不动", () => {
    const home = path.join(tmp, "home")
    mkSkill(home, ".claude", "graphify")
    mkSkill(home, ".agents", "helper")
    const detected = detectExternal(home, "global")
    const r = importExternalSkills(detected.skills, { scope: "global" })
    expect(r.importedSkills.sort()).toEqual(["graphify", "helper"])
    expect(fs.existsSync(path.join(tmp, ".alpha", "skills", "graphify", "SKILL.md"))).toBe(true)
    expect(fs.existsSync(path.join(home, ".claude", "skills", "graphify", "SKILL.md"))).toBe(true) // 源不动
    const ledger = JSON.parse(fs.readFileSync(path.join(tmp, ".alpha", "installs.json"), "utf8"))
    const origins = Object.fromEntries(ledger.receipts.map((x: any) => [x.name, x.origin]))
    expect(origins.graphify).toBe("imported-claude")
    expect(origins.helper).toBe("imported-agents")
  })
  test("同名已存在 → 该项诚实失败,不覆盖既有内容", () => {
    const home = path.join(tmp, "home")
    mkSkill(home, ".claude", "graphify")
    fs.mkdirSync(path.join(tmp, ".alpha", "skills", "graphify"), { recursive: true })
    fs.writeFileSync(path.join(tmp, ".alpha", "skills", "graphify", "SKILL.md"), "user's own\n")
    const r = importExternalSkills(detectExternal(home, "global").skills, { scope: "global" })
    expect(r.importedSkills).toEqual([])
    expect(r.skipped[0].name).toBe("graphify")
    expect(fs.readFileSync(path.join(tmp, ".alpha", "skills", "graphify", "SKILL.md"), "utf8")).toBe("user's own\n")
  })
  test("项目 CLAUDE.md → AGENTS.md(带快照溯源头);已存在 AGENTS.md → 不动 + 如实报告", () => {
    const proj = path.join(tmp, "proj")
    fs.mkdirSync(proj, { recursive: true })
    fs.writeFileSync(path.join(proj, "CLAUDE.md"), "# my rules\n")
    expect(importProjectClaudeMd(proj, path.join(proj, "CLAUDE.md"))).toBe("agents-md-created")
    const agents = fs.readFileSync(path.join(proj, "AGENTS.md"), "utf8")
    expect(agents).toContain("imported from CLAUDE.md")
    expect(agents).toContain("# my rules")
    fs.writeFileSync(path.join(proj, "AGENTS.md"), "existing agents md\n")
    expect(importProjectClaudeMd(proj, path.join(proj, "CLAUDE.md"))).toBe("agents-md-exists")
    expect(fs.readFileSync(path.join(proj, "AGENTS.md"), "utf8")).toBe("existing agents md\n") // 绝不覆盖
  })
  test("全局 CLAUDE.md → ~/.alpha/instructions/(sidecar 注入清单可见)", () => {
    const home = path.join(tmp, "home")
    fs.mkdirSync(path.join(home, ".claude"), { recursive: true })
    fs.writeFileSync(path.join(home, ".claude", "CLAUDE.md"), "# global\n")
    const dest = importGlobalClaudeMd(path.join(home, ".claude", "CLAUDE.md"))
    expect(fs.readFileSync(dest, "utf8")).toBe("# global\n")
    expect(listAlphaInstructionFiles()).toEqual([dest])
  })
})

describe("记账 — 项目 prefs 版本化 + 全局 marker 一次性", () => {
  test("prefs:决策落版本;版本升级 = 重新弹(REQ-060 同款语义)", () => {
    const p1 = withExternalImportDecision({}, "declined", "2026-07-08T00:00:00Z")
    expect(hasExternalImportDecision(p1)).toBe(true)
    expect(hasExternalImportDecision({ externalImport: { version: EXTERNAL_IMPORT_VERSION - 1, decision: "imported", at: "x" } })).toBe(false)
    expect(hasExternalImportDecision({})).toBe(false)
  })
  test("marker:写入后可读回;损坏/缺失 = null(会重新弹,fail-open 到询问而非静默)", () => {
    expect(readGlobalGateMarker()).toBeNull()
    writeGlobalGateMarker({ version: EXTERNAL_IMPORT_VERSION, decision: "imported", at: "2026-07-08T00:00:00Z", imported: ["graphify"] })
    expect(readGlobalGateMarker()?.decision).toBe("imported")
    fs.writeFileSync(path.join(tmp, ".alpha", "ecosystem-import.json"), "{corrupt")
    expect(readGlobalGateMarker()).toBeNull()
  })
})
