// REQ-100 #310 — skill generation live 目录投影进 cfg.skills.paths(current.json = 唯一原子真源)。

import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
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

/** 造一个 skill generation:ext-store/<key>/generations/<gen> + current.json 指针 + enabled 账本记录。
 *  #395 起注入是严格 decoder(只注入账本确证 enabled 的);生产流 generation 与账本记录同事务原子
 *  落位,故测试同步写一条 enabled 记录(disabled/缺记录场景由各用例显式覆写账本)。 */
function makeGeneration(name: string, genId: string) {
  const store = join(root, "ext-store", `skill--${name}`)
  const genDir = join(store, "generations", genId)
  mkdirSync(genDir, { recursive: true })
  writeFileSync(join(genDir, "SKILL.md"), `---\nname: ${name}\n---\nbody`)
  writeFileSync(join(store, "current.json"), JSON.stringify({ v: 1, generation: genId, txId: "tx-x", switchedAt: "t" }))
  appendEnabledRecord(name)
  return genDir
}

/** 良构 v2 skill 记录(gen-skill-paths 严格门要求完整 schema)。 */
function skillRecord(name: string, desiredState: "enabled" | "disabled") {
  return { schemaVersion: 2, id: `skill:${name}`, name, kind: "skill", environment: "prod", scope: { kind: "global" }, generation: 1, installedAt: "2026-07-17T00:00:00.000Z", desiredState }
}

/** 账本追加/合并一条 enabled skill 记录(installs.json 累积)。 */
function appendEnabledRecord(name: string) {
  const file = join(root, "installs.json")
  let records: unknown[] = []
  try {
    const parsed: { records?: unknown[] } = JSON.parse(readFileSync(file, "utf8"))
    records = parsed.records ?? []
  } catch {
    /* fresh */
  }
  records = records.filter((r) => !(r && typeof r === "object" && (r as { name?: unknown }).name === name && (r as { kind?: unknown }).kind === "skill"))
  records.push(skillRecord(name, "enabled"))
  writeFileSync(file, JSON.stringify({ v: 2, receipts: [], records }))
}

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
    // 有 generations 目录但无 current.json 指针 = 未 live,不投影。
    mkdirSync(join(root, "ext-store", "skill--dangling", "generations", "gen-000001-aaaaaa"), { recursive: true })
    const good = makeGeneration("ok", "gen-000001-bbbbbb")
    expect(skillGenerationLiveDirs(root)).toEqual([good])
  })

  test("指针指向不存在的 generation → 跳过", () => {
    const store = join(root, "ext-store", "skill--gone")
    mkdirSync(store, { recursive: true })
    writeFileSync(join(store, "current.json"), JSON.stringify({ v: 1, generation: "gen-000009-ffffff", txId: "t", switchedAt: "t" }))
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

// ── #395(REQ-104):账本 desiredState 投影门 —— disabled 的 skill 不注入(装 ≠ 跑)──────────────

function writeLedger(records: unknown[]) {
  writeFileSync(join(root, "installs.json"), JSON.stringify({ v: 2, receipts: [], records }))
}

describe("#395 disabled 投影门", () => {
  test("账本 enabled 的 skill 注入、disabled 的不注入;非 skill 记录不影响 skill 投影", () => {
    const a = makeGeneration("alpha-on", "gen-000001-000001")
    makeGeneration("beta-off", "gen-000001-000002")
    const c = makeGeneration("gamma-on", "gen-000001-000003")
    writeLedger([
      skillRecord("alpha-on", "enabled"),
      skillRecord("beta-off", "disabled"),
      skillRecord("gamma-on", "enabled"),
      { kind: "mcp", name: "beta-off", desiredState: "disabled" }, // 非 skill 记录不影响 skill 投影
    ])
    expect(skillGenerationLiveDirs(root)).toEqual([a, c].sort())
  })

  test("账本缺失/不可解析 → 不注入任何技能(严格 decoder,fail closed;Codex r1 Blocker 2)", () => {
    const a = makeGeneration("solo", "gen-000001-000001")
    expect(skillGenerationLiveDirs(root)).toEqual([a]) // makeGeneration 写了 enabled 记录
    writeFileSync(join(root, "installs.json"), "{ not json")
    expect(skillGenerationLiveDirs(root)).toEqual([]) // 坏账本 = 无 enabled 确证 → 全部不注入
    rmSync(join(root, "installs.json"))
    expect(skillGenerationLiveDirs(root)).toEqual([]) // 缺账本同理
  })

  test("generation 有目录但账本无该记录(孤儿/回滚残留)→ 不注入", () => {
    const store = join(root, "ext-store", "skill--orphan")
    mkdirSync(join(store, "generations", "gen-000001-000001"), { recursive: true })
    writeFileSync(join(store, "generations", "gen-000001-000001", "SKILL.md"), "---\nname: orphan\n---\nbody")
    writeFileSync(join(store, "current.json"), JSON.stringify({ v: 1, generation: "gen-000001-000001", txId: "t", switchedAt: "t" }))
    writeLedger([]) // 空账本:该 generation 无对应记录
    expect(skillGenerationLiveDirs(root)).toEqual([])
  })

  test("畸形/不完整记录不能复活被禁用技能(严格 record 门,Codex r3 Blocker)", () => {
    const a = makeGeneration("legit-off", "gen-000001-000001") // makeGeneration 写良构 enabled;下面覆写
    void a
    // 良构 disabled 记录 + 畸形重复(缺 schemaVersion/id/scope…,只有 desiredState:enabled)——
    // 主进程会排除畸形记录、保留 disabled;ext 门必须同样排除,不得注入。
    writeLedger([
      skillRecord("legit-off", "disabled"),
      { kind: "skill", name: "legit-off", desiredState: "enabled" },
    ])
    expect(skillGenerationLiveDirs(root)).toEqual([])
  })

  test("injectSkillGenerationPaths 同步遵守门(disabled 不进 cfg.skills.paths)", () => {
    const a = makeGeneration("keep", "gen-000001-000001")
    makeGeneration("drop", "gen-000001-000002")
    writeLedger([
      skillRecord("keep", "enabled"),
      skillRecord("drop", "disabled"),
    ])
    const cfg: Record<string, unknown> = {}
    const added = injectSkillGenerationPaths(cfg, root)
    expect(added).toEqual([a])
  })
})
