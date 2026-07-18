// REQ-100 #310 — skill generation live 目录投影进 cfg.skills.paths(current.json = 唯一原子真源)。
// #395(Codex r5 步骤5):注入门只读 main 用真 decodeRecordV2 派生的 `skills-enabled.json` 允许集
// (ext 侧不再镜像 decoder;decoder 强度用例移至 ext-receipt-v2.test.ts 的派生锁步测试)。

import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { injectSkillGenerationPaths, skillGenerationLiveDirs } from "./gen-skill-paths"

let root: string
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "alpha-genpaths-"))
})
afterEach(() => {
  rmSync(root, { recursive: true, force: true })
})

/** main 侧派生允许集(生产流由 ext-receipt-v2 writeLedgerFile 与账本锁步写;此处直造文件)。 */
function writeAllowList(names: string[]) {
  writeFileSync(join(root, "skills-enabled.json"), JSON.stringify({ v: 1, keys: names.map((n) => `skill--${n}`) }))
}

/** 造一个 skill generation:ext-store/<key>/generations/<gen> + current.json 指针 + 允许集条目。
 *  生产流 generation 与账本记录同事务原子落位、派生允许集与账本锁步,故测试同步补允许集
 *  (disabled/缺条目场景由各用例显式覆写)。 */
const allowed = new Set<string>()
function makeGeneration(name: string, genId: string) {
  const store = join(root, "ext-store", `skill--${name}`)
  const genDir = join(store, "generations", genId)
  mkdirSync(genDir, { recursive: true })
  writeFileSync(join(genDir, "SKILL.md"), `---\nname: ${name}\n---\nbody`)
  writeFileSync(join(store, "current.json"), JSON.stringify({ v: 1, generation: genId, txId: "tx-x", switchedAt: "t" }))
  allowed.add(name)
  writeAllowList([...allowed])
  return genDir
}
beforeEach(() => allowed.clear())

describe("skillGenerationLiveDirs", () => {
  test("解析 current.json → live generation 目录(升序)", () => {
    const a = makeGeneration("alpha", "gen-000001-aabbcc")
    const b = makeGeneration("beta", "gen-000002-ddeeff")
    expect(skillGenerationLiveDirs(root).sort()).toEqual([a, b].sort())
  })

  test("无 ext-store → 空(不抛)", () => {
    expect(skillGenerationLiveDirs(root)).toEqual([])
  })

  test("current.json 缺失/损坏 → 跳过该 key(不投影半成品)", () => {
    // 有 generations 目录但无 current.json 指针 = 未 live,不投影(允许集有它也一样)。
    mkdirSync(join(root, "ext-store", "skill--dangling", "generations", "gen-000001-aaaaaa"), { recursive: true })
    writeAllowList(["dangling", "ok"])
    const good = makeGeneration("ok", "gen-000001-bbbbbb")
    expect(skillGenerationLiveDirs(root)).toEqual([good])
  })

  test("指针指向不存在的 generation → 跳过", () => {
    const store = join(root, "ext-store", "skill--gone")
    mkdirSync(store, { recursive: true })
    writeFileSync(join(store, "current.json"), JSON.stringify({ v: 1, generation: "gen-000009-ffffff", txId: "t", switchedAt: "t" }))
    writeAllowList(["gone"])
    expect(skillGenerationLiveDirs(root)).toEqual([])
  })
})

describe("injectSkillGenerationPaths", () => {
  test("注入 live 目录到 cfg.skills.paths(用户条目在前,去重)", () => {
    const dir = makeGeneration("demo", "gen-000001-abcabc")
    const cfg: Record<string, unknown> = { skills: { paths: ["/Users/x/.alpha/skills"] } }
    const added = injectSkillGenerationPaths(cfg, root)
    expect(added).toEqual([dir])
    expect((cfg.skills as { paths: string[] }).paths).toEqual(["/Users/x/.alpha/skills", dir])
    // 幂等
    expect(injectSkillGenerationPaths(cfg, root)).toEqual([])
  })

  test("无 root / 无 generation → 无注入", () => {
    const cfg: Record<string, unknown> = {}
    expect(injectSkillGenerationPaths(cfg, undefined)).toEqual([])
    expect(injectSkillGenerationPaths(cfg, root)).toEqual([])
  })
})

// ── #395(REQ-104):允许集投影门 —— 不在 main 派生允许集里的 skill 不注入(装 ≠ 跑)──────────────

describe("#395 允许集投影门(skills-enabled.json,fail closed)", () => {
  test("允许集内的 skill 注入、不在集内(disabled)的不注入", () => {
    const a = makeGeneration("alpha-on", "gen-000001-000001")
    makeGeneration("beta-off", "gen-000001-000002")
    const c = makeGeneration("gamma-on", "gen-000001-000003")
    writeAllowList(["alpha-on", "gamma-on"]) // beta-off 被 main 排除(disabled)
    expect(skillGenerationLiveDirs(root)).toEqual([a, c].sort())
  })

  test("允许集缺失/不可解析/形状异常/未知版本 → 不注入任何技能(fail closed)", () => {
    const a = makeGeneration("solo", "gen-000001-000001")
    expect(skillGenerationLiveDirs(root)).toEqual([a]) // makeGeneration 已补允许集
    writeFileSync(join(root, "skills-enabled.json"), "{ not json")
    expect(skillGenerationLiveDirs(root)).toEqual([]) // 损坏 = 无 enabled 确证
    writeFileSync(join(root, "skills-enabled.json"), JSON.stringify({ v: 2, keys: ["skill--solo"] }))
    expect(skillGenerationLiveDirs(root)).toEqual([]) // 未知版本 fail closed
    writeFileSync(join(root, "skills-enabled.json"), JSON.stringify({ v: 1, keys: "skill--solo" }))
    expect(skillGenerationLiveDirs(root)).toEqual([]) // keys 非数组 fail closed
    rmSync(join(root, "skills-enabled.json"))
    expect(skillGenerationLiveDirs(root)).toEqual([]) // 缺失同理(升级空窗由 boot reconcile backfill)
  })

  test("generation 有目录但允许集无该条目(孤儿/回滚残留)→ 不注入", () => {
    const store = join(root, "ext-store", "skill--orphan")
    mkdirSync(join(store, "generations", "gen-000001-000001"), { recursive: true })
    writeFileSync(join(store, "generations", "gen-000001-000001", "SKILL.md"), "---\nname: orphan\n---\nbody")
    writeFileSync(join(store, "current.json"), JSON.stringify({ v: 1, generation: "gen-000001-000001", txId: "t", switchedAt: "t" }))
    writeAllowList([]) // 空允许集:无对应条目
    expect(skillGenerationLiveDirs(root)).toEqual([])
  })

  test("允许集条目须匹配受管 key 形状(非法条目忽略,不成注入通道)", () => {
    makeGeneration("keep", "gen-000001-000001")
    writeFileSync(
      join(root, "skills-enabled.json"),
      JSON.stringify({ v: 1, keys: ["../../etc", "skill--", 42, null, "skill--keep"] }),
    )
    const dirs = skillGenerationLiveDirs(root)
    expect(dirs.length).toBe(1)
    expect(dirs[0]).toContain("skill--keep")
  })

  test("injectSkillGenerationPaths 同步遵守门(不在允许集不进 cfg.skills.paths)", () => {
    const a = makeGeneration("keep", "gen-000001-000001")
    makeGeneration("drop", "gen-000001-000002")
    writeAllowList(["keep"])
    const cfg: Record<string, unknown> = {}
    const added = injectSkillGenerationPaths(cfg, root)
    expect(added).toEqual([a])
  })
})
