// #390(REQ-098):未策展导入(folder/git 技能 + imported agent)走验证共享 CAS + 事务 —— 取代 flat
// copy。裁决 A(2026-07-17 Codex DECIDE)。本套件证明:global 导入落 generation/file 事务(崩溃可恢复、
// 无半成品/无 active-无账本 fail-open)、fresh-only 语义、CAS 内容寻址、以及 ecosystem 路由 wiring。

import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import * as fs from "node:fs"
import * as os from "node:os"
import * as path from "node:path"
import { parse as parseJsonc } from "jsonc-parser"
import { collectImportSkillPayload } from "./ext-fs-installer"
import { installUncuratedAgentImport, installUncuratedSkillImport, type UncuratedImportDeps } from "./ext-install-planner"
import { importExternalSkills, type ExternalSkill } from "./ecosystem-import"
import { hasSkillGeneration } from "./ext-skill-generations"
import { findRecordV2 } from "./ext-receipt-v2"

let root: string
let casBase: string
let src: string
let deps: UncuratedImportDeps

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "alpha-uncurated-"))
  casBase = path.join(root, "cas-base")
  src = fs.mkdtempSync(path.join(os.tmpdir(), "alpha-uncurated-src-"))
  deps = { globalRoot: () => root, casBaseRoot: () => casBase, environment: () => "prod" }
})
afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true })
  fs.rmSync(src, { recursive: true, force: true })
})

function mkSkillDir(dir: string, name: string, extra?: Record<string, string>): void {
  fs.mkdirSync(dir, { recursive: true })
  fs.writeFileSync(path.join(dir, "SKILL.md"), `---\nname: ${name}\ndescription: a ${name} skill\n---\n\n# ${name}\n`)
  for (const [rel, content] of Object.entries(extra ?? {})) {
    const p = path.join(dir, rel)
    fs.mkdirSync(path.dirname(p), { recursive: true })
    fs.writeFileSync(p, content)
  }
}

const AGENT_MD = `---\ndescription: 测试 agent(#390)\nmode: subagent\n---\n\n你是测试 agent。\n`

describe("collectImportSkillPayload — 集中 import 校验 + byte-exact 载荷", () => {
  test("有效目录 → name + POSIX 相对路径载荷(含子目录)", () => {
    mkSkillDir(src, "demo", { "refs/note.md": "hello", "script.py": "print(1)" })
    const r = collectImportSkillPayload(src)
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.name).toBe("demo")
    const paths = r.files.map((f) => f.path).sort()
    expect(paths).toEqual(["SKILL.md", "refs/note.md", "script.py"])
    expect(r.files.every((f) => !f.path.includes("\\"))).toBe(true) // POSIX
  })

  test("缺 SKILL.md → 拒", () => {
    fs.mkdirSync(src, { recursive: true })
    fs.writeFileSync(path.join(src, "readme.md"), "no skill")
    const r = collectImportSkillPayload(src)
    expect(r.ok).toBe(false)
  })

  test("SKILL.md frontmatter 非法 → 拒", () => {
    fs.mkdirSync(src, { recursive: true })
    fs.writeFileSync(path.join(src, "SKILL.md"), "no frontmatter here")
    const r = collectImportSkillPayload(src)
    expect(r.ok).toBe(false)
  })

  test("symlink 文件不入载荷(collectImportFiles 跳 symlink)", () => {
    mkSkillDir(src, "demo")
    fs.writeFileSync(path.join(src, "real.txt"), "real")
    try {
      fs.symlinkSync(path.join(src, "real.txt"), path.join(src, "link.txt"))
    } catch {
      return // 平台不支持 symlink 则跳过
    }
    const r = collectImportSkillPayload(src)
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.files.some((f) => f.path === "link.txt")).toBe(false)
  })

  test("SKILL.md symlink 指向源目录外 → realpath 圈禁拒(review r1 Major 3)", () => {
    fs.mkdirSync(src, { recursive: true })
    const outside = fs.mkdtempSync(path.join(os.tmpdir(), "alpha-uncurated-outside-"))
    fs.writeFileSync(path.join(outside, "secret.md"), "---\nname: demo\ndescription: x\n---\n\n越界内容\n")
    try {
      fs.symlinkSync(path.join(outside, "secret.md"), path.join(src, "SKILL.md"))
    } catch {
      fs.rmSync(outside, { recursive: true, force: true })
      return
    }
    const r = collectImportSkillPayload(src)
    fs.rmSync(outside, { recursive: true, force: true })
    expect(r.ok).toBe(false)
    if (r.ok) return
    // walk 跳 symlink dirent → 「没有 SKILL.md」;或若走到读取层则 realpath 圈禁拒 —— 两者都不读越界字节。
    expect(r.reason).toMatch(/逃逸源目录|不是常规文件|安全打开|没有 SKILL\.md/)
  })

  test("普通文件 symlink 指向源目录外 → 不入载荷 / 圈禁拒(review r1 Major 3)", () => {
    mkSkillDir(src, "demo")
    const outside = fs.mkdtempSync(path.join(os.tmpdir(), "alpha-uncurated-outside2-"))
    fs.writeFileSync(path.join(outside, "secret.txt"), "越界字节")
    try {
      fs.symlinkSync(path.join(outside, "secret.txt"), path.join(src, "leak.txt"))
    } catch {
      fs.rmSync(outside, { recursive: true, force: true })
      return
    }
    const r = collectImportSkillPayload(src)
    fs.rmSync(outside, { recursive: true, force: true })
    // collectImportFiles 在 walk 期跳 symlink dirent → leak.txt 根本不进列表(越界字节永不入 CAS)。
    if (r.ok) expect(r.files.some((f) => f.path === "leak.txt")).toBe(false)
  })

  test("SKILL.md > 256KB → 拒(实际字节帽,review r1 Major 4)", () => {
    fs.mkdirSync(src, { recursive: true })
    const big = "---\nname: demo\ndescription: x\n---\n\n" + "a".repeat(300 * 1024)
    fs.writeFileSync(path.join(src, "SKILL.md"), big)
    const r = collectImportSkillPayload(src)
    expect(r.ok).toBe(false)
    if (r.ok) return
    expect(r.reason).toContain("SKILL.md")
  })

  test("SKILL.md 自身 11MB → 报 SKILL.md 过大而非误报目录帽(review r4 Minor 1)", () => {
    fs.mkdirSync(src, { recursive: true })
    fs.writeFileSync(path.join(src, "SKILL.md"), "---\nname: demo\ndescription: x\n---\n\n" + "a".repeat(11 * 1024 * 1024))
    const r = collectImportSkillPayload(src)
    expect(r.ok).toBe(false)
    if (r.ok) return
    expect(r.reason).toContain("SKILL.md")
    expect(r.reason).not.toContain("10MB")
  })

  test("目录总量 > 10MB → 拒(实际读入字节累计,review r1 Major 4)", () => {
    mkSkillDir(src, "demo")
    // 三个 4MB 文件 = 12MB > 10MB 帽。
    for (let i = 0; i < 3; i++) fs.writeFileSync(path.join(src, `big${i}.bin`), Buffer.alloc(4 * 1024 * 1024, 1))
    const r = collectImportSkillPayload(src)
    expect(r.ok).toBe(false)
    if (r.ok) return
    expect(r.reason).toContain("10MB")
  })
})

describe("installUncuratedSkillImport — global folder 导入走 CAS + generation 事务", () => {
  test("落 generation(非 flat)+ receipt origin imported + id user:<name> + CAS blob 在盘", async () => {
    mkSkillDir(src, "demo", { "refs/a.md": "aaa" })
    const r = await installUncuratedSkillImport(src, deps, { origin: "imported" })
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.kind).toBe("skill")
    expect(r.name).toBe("demo")
    // generation 落地(引擎经 gen 路径发现),flat skills/demo 不存在(无双真源)。
    expect(hasSkillGeneration(root, "demo")).toBe(true)
    expect(fs.existsSync(path.join(root, "skills", "demo"))).toBe(false)
    const rec = findRecordV2(root, "skill", "demo")
    expect(rec?.origin).toBe("imported")
    expect(rec?.id).toBe("user:demo")
    // CAS 内容寻址 blob 至少一份在盘。
    const shardRoot = path.join(casBase, "cas", "v1", "sha256")
    expect(fs.existsSync(shardRoot)).toBe(true)
  })

  test("同名重导入 → fresh-only 拒(不覆盖)", async () => {
    mkSkillDir(src, "demo")
    const first = await installUncuratedSkillImport(src, deps, { origin: "imported" })
    expect(first.ok).toBe(true)
    const again = await installUncuratedSkillImport(src, deps, { origin: "imported" })
    expect(again.ok).toBe(false)
    if (again.ok) return
    // fresh-only:已 generation 化 → checkUncuratedConflict 先命中(uninstall it first)。
    expect(again.reason).toMatch(/already present|generation-managed|uninstall it first/)
  })

  test("同名无账 flat 目录在场 → 拒(不认领未注册内容)", async () => {
    mkSkillDir(src, "demo")
    fs.mkdirSync(path.join(root, "skills", "demo"), { recursive: true })
    fs.writeFileSync(path.join(root, "skills", "demo", "SKILL.md"), "user's own\n")
    const r = await installUncuratedSkillImport(src, deps, { origin: "imported" })
    expect(r.ok).toBe(false)
    if (r.ok) return
    expect(r.reason).toContain("without a ledger record")
    // 用户既有内容不被动。
    expect(fs.readFileSync(path.join(root, "skills", "demo", "SKILL.md"), "utf8")).toBe("user's own\n")
  })

  test("悬空/损坏 generation store 在盘(无健康 generation)→ 拒(review r1 Major 2)", async () => {
    mkSkillDir(src, "demo")
    // 造 ext-store/skill--demo 目录但无 current.json / 无可解析 live generation(悬空 store)。
    fs.mkdirSync(path.join(root, "ext-store", "skill--demo", "generations"), { recursive: true })
    const r = await installUncuratedSkillImport(src, deps, { origin: "imported" })
    expect(r.ok).toBe(false)
    if (r.ok) return
    expect(r.reason).toMatch(/store.*not a healthy generation|fail closed/)
  })

  test("prod/beta 相同载荷共享同一 CAS blob(内容去重,generation 分域)", async () => {
    mkSkillDir(src, "demo")
    await installUncuratedSkillImport(src, deps, { origin: "imported" })
    const shardRoot = path.join(casBase, "cas", "v1", "sha256")
    const countBlobs = (): number => {
      let n = 0
      for (const shard of fs.readdirSync(shardRoot)) {
        n += fs.readdirSync(path.join(shardRoot, shard)).length
      }
      return n
    }
    const before = countBlobs()
    // beta 环境根(不同 generation store),同 casBase 共享 blob。
    const betaRoot = path.join(root, "env", "beta")
    fs.mkdirSync(betaRoot, { recursive: true })
    const betaDeps: UncuratedImportDeps = { globalRoot: () => betaRoot, casBaseRoot: () => casBase, environment: () => "beta" }
    const src2 = fs.mkdtempSync(path.join(os.tmpdir(), "alpha-uncurated-src2-"))
    mkSkillDir(src2, "demo")
    const r2 = await installUncuratedSkillImport(src2, betaDeps, { origin: "imported" })
    fs.rmSync(src2, { recursive: true, force: true })
    expect(r2.ok).toBe(true)
    expect(countBlobs()).toBe(before) // 同内容不新增 blob
    expect(hasSkillGeneration(betaRoot, "demo")).toBe(true)
    expect(hasSkillGeneration(root, "demo")).toBe(true) // 两环境各有 generation
  })
})

describe("installUncuratedAgentImport — imported agent 走 CAS + file/config 单事务", () => {
  test("落 agents/<name>.md + config agent.<name> + receipt origin imported", async () => {
    const r = await installUncuratedAgentImport("demo-agent", AGENT_MD, deps, { origin: "imported" })
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.kind).toBe("agent")
    expect(fs.existsSync(path.join(root, "agents", "demo-agent.md"))).toBe(true)
    const cfg: unknown = parseJsonc(fs.readFileSync(path.join(root, "alpha.jsonc"), "utf8"))
    const agentMap = cfg && typeof cfg === "object" ? (cfg as { agent?: Record<string, unknown> }).agent : undefined
    expect(agentMap?.["demo-agent"]).toBeDefined()
    const rec = findRecordV2(root, "agent", "demo-agent")
    expect(rec?.origin).toBe("imported")
    expect(rec?.id).toBe("user:demo-agent")
  })

  test("重导入同名 → 拒(agent 无更新链)", async () => {
    await installUncuratedAgentImport("demo-agent", AGENT_MD, deps, { origin: "imported" })
    const again = await installUncuratedAgentImport("demo-agent", AGENT_MD, deps, { origin: "imported" })
    expect(again.ok).toBe(false)
  })

  test("名字含 -- → 拒(事务 key 歧义)", async () => {
    const r = await installUncuratedAgentImport("foo--config", AGENT_MD, deps, { origin: "imported" })
    expect(r.ok).toBe(false)
    if (r.ok) return
    expect(r.reason).toContain("--")
  })
})

describe("ecosystem-import 路由 wiring(#390)", () => {
  test("global scope 注入 installer → 走事务路径(installer 被调,不落 flat)", async () => {
    mkSkillDir(src, "eco")
    const calls: Array<{ dir: string; origin: string }> = []
    const installer = async (dir: string, origin: "imported-claude" | "imported-agents") => {
      calls.push({ dir, origin })
      return installUncuratedSkillImport(dir, deps, { origin })
    }
    const skills: ExternalSkill[] = [{ name: "eco", dir: src, source: "claude" }]
    const r = await importExternalSkills(skills, { scope: "global" }, installer)
    expect(calls.length).toBe(1)
    expect(calls[0].origin).toBe("imported-claude")
    expect(r.importedSkills).toEqual(["eco"])
    expect(hasSkillGeneration(root, "eco")).toBe(true)
    expect(fs.existsSync(path.join(root, "skills", "eco"))).toBe(false) // 无 flat 双真源
  })

  test("project scope 不注入 installer → 维持 flat sanctioned 路径(installer 不被调)", async () => {
    const proj = fs.mkdtempSync(path.join(os.tmpdir(), "alpha-uncurated-proj-"))
    mkSkillDir(path.join(proj, "src-skill"), "projskill")
    let called = false
    const installer = async (dir: string, origin: "imported-claude" | "imported-agents") => {
      called = true
      return installUncuratedSkillImport(dir, deps, { origin })
    }
    // project 分支:即便传了 installer,target.scope==="project" 也走 flat(不调 installer)。
    const skills: ExternalSkill[] = [{ name: "projskill", dir: path.join(proj, "src-skill"), source: "claude" }]
    const r = await importExternalSkills(skills, { scope: "project", projectDir: proj }, installer)
    expect(called).toBe(false)
    expect(r.importedSkills).toEqual(["projskill"])
    // flat 路径:落项目 .alpha/skills。
    expect(fs.existsSync(path.join(proj, ".alpha", "skills", "projskill", "SKILL.md"))).toBe(true)
    fs.rmSync(proj, { recursive: true, force: true })
  })
})
