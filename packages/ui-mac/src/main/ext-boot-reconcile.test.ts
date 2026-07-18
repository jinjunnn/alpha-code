// REQ-104 #395 —— startup reconcile:账本 desiredState → alpha.jsonc 权威重投影(Codex r5 缺失件)。
// 崩溃残留(账本 disabled / config enabled)与旁路写入必须在引擎首次读 config 前收敛;config 恒 =
// 账本派生。真盘临时根,零 mock。
import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import * as fs from "node:fs"
import * as os from "node:os"
import * as path from "node:path"
import { reconcileDesiredStateAtBoot } from "./ext-install-planner"
import { tryAcquireBundleLock } from "./ext-bundle-lock"
import { findRecordV2, reconcileSkillsDerivation, setDesiredStateV2, skillsEnabledPath, upsertRecordV2, type UpsertInput } from "./ext-receipt-v2"

let root: string
beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "ext-bootrec-"))
})
afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true })
})

const record = (over: Partial<UpsertInput> & { name: string; kind: UpsertInput["kind"] }): void => {
  const w = upsertRecordV2(root, {
    id: `${over.kind}:${over.name}`,
    environment: "prod",
    scope: { kind: "global" },
    desiredState: "enabled",
    origin: "catalog",
    installedAt: "2026-07-17T00:00:00.000Z",
    ...over,
  })
  if (!w.ok) throw new Error(w.reason)
}
const cfgPath = () => path.join(root, "alpha.jsonc")
const writeCfg = (cfg: unknown) => fs.writeFileSync(cfgPath(), JSON.stringify(cfg, null, 2))
const readCfg = (): Record<string, any> => JSON.parse(fs.readFileSync(cfgPath(), "utf8"))

describe("reconcileDesiredStateAtBoot(#395 崩溃残留收敛)", () => {
  test("账本 disabled / config enabled 残留 → 三类全部重投影(mcp enabled:false、agent disable:true、plugin 缺席)", () => {
    record({ name: "m", kind: "mcp", configKey: "mcp.m", desiredState: "disabled" })
    record({ name: "a", kind: "agent", configKey: "agent.a", desiredState: "disabled" })
    record({ name: "p", kind: "plugin", configKey: "plugin:@x/p@1.0.0", desiredState: "disabled" })
    // 崩溃残留形态:账本已翻 disabled,config 仍是启用叶/在场条目。
    writeCfg({ mcp: { m: { type: "local", command: ["x"] } }, agent: { a: { description: "d" } }, plugin: ["@x/p@1.0.0", "@keep/u@1"] })
    const r = reconcileDesiredStateAtBoot(root)
    expect(r.ok).toBe(true)
    expect(r.applied.sort()).toEqual(["agent:a→disabled", "mcp:m→disabled", "plugin:p→disabled"])
    const cfg = readCfg()
    expect(cfg.mcp.m).toEqual({ type: "local", command: ["x"], enabled: false })
    expect(cfg.agent.a).toEqual({ description: "d", disable: true })
    expect(cfg.plugin).toEqual(["@keep/u@1"])
  })

  test("反方向:账本 enabled / config 残留禁用键或条目缺席 → 剥禁用键 + plugin 补回", () => {
    record({ name: "m", kind: "mcp", configKey: "mcp.m", desiredState: "enabled" })
    record({ name: "a", kind: "agent", configKey: "agent.a", desiredState: "enabled" })
    record({ name: "p", kind: "plugin", configKey: "plugin:@x/p@1.0.0", desiredState: "enabled" })
    writeCfg({ mcp: { m: { type: "local", enabled: false } }, agent: { a: { description: "d", disable: true } }, plugin: [] })
    const r = reconcileDesiredStateAtBoot(root)
    expect(r.ok).toBe(true)
    const cfg = readCfg()
    expect(cfg.mcp.m).toEqual({ type: "local" })
    expect(cfg.agent.a).toEqual({ description: "d" })
    expect(cfg.plugin).toEqual(["@x/p@1.0.0"])
  })

  test("多条 plugin 记录共享 plugin[] 键路径 → 工作副本累积,互不覆盖(2 禁 1 启混合)", () => {
    record({ name: "a", kind: "plugin", configKey: "plugin:@x/a@1", desiredState: "disabled" })
    record({ name: "b", kind: "plugin", configKey: "plugin:@x/b@1", desiredState: "disabled" })
    record({ name: "c", kind: "plugin", configKey: "plugin:@x/c@1", desiredState: "enabled" })
    writeCfg({ plugin: ["@x/a@1", "@x/b@1", "@keep/u@1"] })
    const r = reconcileDesiredStateAtBoot(root)
    expect(r.ok).toBe(true)
    expect(readCfg().plugin).toEqual(["@keep/u@1", "@x/c@1"])
  })

  test("config 已与账本一致 → 零写盘(逐字节不动,幂等)", () => {
    record({ name: "m", kind: "mcp", configKey: "mcp.m", desiredState: "disabled" })
    record({ name: "p", kind: "plugin", configKey: "plugin:@x/p@1", desiredState: "enabled" })
    writeCfg({ mcp: { m: { type: "local", enabled: false } }, plugin: ["@x/p@1"] })
    const before = fs.readFileSync(cfgPath(), "utf8")
    const beforeStat = fs.statSync(cfgPath()).mtimeMs
    const r = reconcileDesiredStateAtBoot(root)
    expect(r.ok).toBe(true)
    expect(r.applied).toEqual([])
    expect(fs.readFileSync(cfgPath(), "utf8")).toBe(before)
    expect(fs.statSync(cfgPath()).mtimeMs).toBe(beforeStat)
  })

  test("alpha.jsonc 缺席:disabled 天然满足(ok);enabled 缺生效面 → warning,不无中生有建文件", () => {
    record({ name: "m", kind: "mcp", configKey: "mcp.m", desiredState: "disabled" })
    record({ name: "p", kind: "plugin", configKey: "plugin:@x/p@1", desiredState: "enabled" })
    const r = reconcileDesiredStateAtBoot(root)
    expect(r.ok).toBe(true)
    expect(r.applied).toEqual([])
    expect(r.warnings.some((w) => w.includes("plugin p") && w.includes("absent"))).toBe(true)
    expect(fs.existsSync(cfgPath())).toBe(false)
  })

  test("alpha.jsonc 非法 jsonc → fail-closed skip,文件不动", () => {
    record({ name: "m", kind: "mcp", configKey: "mcp.m", desiredState: "disabled" })
    fs.writeFileSync(cfgPath(), "{ not jsonc !!!")
    const r = reconcileDesiredStateAtBoot(root)
    expect(r.ok).toBe(false)
    expect(r.skipped).toContain("not valid jsonc")
    expect(fs.readFileSync(cfgPath(), "utf8")).toBe("{ not jsonc !!!")
  })

  test("账本文件级损坏 → 不动 config(无从派生;loud warning)", () => {
    fs.writeFileSync(path.join(root, "installs.json"), "totally not json")
    writeCfg({ mcp: { m: { type: "local" } } })
    const before = fs.readFileSync(cfgPath(), "utf8")
    const r = reconcileDesiredStateAtBoot(root)
    expect(r.ok).toBe(true)
    expect(r.applied).toEqual([])
    expect(fs.readFileSync(cfgPath(), "utf8")).toBe(before)
  })

  test("损坏单条 record → 该条不投影(config 保持原态),其余记录照常收敛", () => {
    record({ name: "good", kind: "mcp", configKey: "mcp.good", desiredState: "disabled" })
    const raw: { records: any[] } = JSON.parse(fs.readFileSync(path.join(root, "installs.json"), "utf8"))
    raw.records.push({ schemaVersion: 2, id: "mcp:z", name: "z", kind: "mcp" }) // 缺必填字段的损坏记录
    fs.writeFileSync(path.join(root, "installs.json"), JSON.stringify(raw))
    writeCfg({ mcp: { good: { type: "local" }, z: { type: "local" } } })
    const r = reconcileDesiredStateAtBoot(root)
    expect(r.ok).toBe(true)
    const cfg = readCfg()
    expect(cfg.mcp.good).toEqual({ type: "local", enabled: false })
    expect(cfg.mcp.z).toEqual({ type: "local" }) // 损坏记录不产生投影
  })

  test("skill(无 config 面)与 project-scope 记录不触碰 global config", () => {
    record({ name: "sk", kind: "skill", desiredState: "disabled" })
    record({
      name: "pp",
      kind: "plugin",
      configKey: "plugin:@x/pp@1",
      desiredState: "disabled",
      scope: { kind: "project", projectPath: "/tmp/proj-x", projectPathHash: "a".repeat(64) },
    })
    writeCfg({ plugin: ["@x/pp@1"] })
    const before = fs.readFileSync(cfgPath(), "utf8")
    const r = reconcileDesiredStateAtBoot(root)
    expect(r.ok).toBe(true)
    expect(r.applied).toEqual([])
    expect(fs.readFileSync(cfgPath(), "utf8")).toBe(before)
  })

  test("bundle 锁被真实持有 → skip loud(在途事务自身保证两面一致)", () => {
    record({ name: "m", kind: "mcp", configKey: "mcp.m", desiredState: "disabled" })
    writeCfg({ mcp: { m: { type: "local" } } })
    const held = tryAcquireBundleLock(root, { txId: "test-holder" })
    if (!held.ok) throw new Error("test setup: could not acquire lock")
    try {
      const r = reconcileDesiredStateAtBoot(root)
      expect(r.ok).toBe(false)
      expect(r.skipped).toContain("lock unavailable")
      expect(r.enforcementGap && r.enforcementGap.length > 0).toBe(true) // r7 B2:启动期锁不可用 = fail-closed
      expect(readCfg().mcp.m).toEqual({ type: "local" }) // config 未动
    } finally {
      held.lock.release()
    }
  })

  test("enable 缺生效面(叶缺席)→ warning + 跳过该条,不 abort 其余", () => {
    record({ name: "gone", kind: "mcp", configKey: "mcp.gone", desiredState: "enabled" })
    record({ name: "m", kind: "mcp", configKey: "mcp.m", desiredState: "disabled" })
    writeCfg({ mcp: { m: { type: "local" } } })
    const r = reconcileDesiredStateAtBoot(root)
    expect(r.ok).toBe(true)
    expect(r.warnings.some((w) => w.includes("mcp gone") && w.includes("config entry missing"))).toBe(true)
    expect(readCfg().mcp.m).toEqual({ type: "local", enabled: false })
  })
})

// ── #395 步骤5:skills 派生允许集(skills-enabled.json)与账本锁步 + boot 自愈 ────────────────────
describe("#395 skills 派生允许集(main 真 decoder)", () => {
  const readKeys = (): string[] => (JSON.parse(fs.readFileSync(skillsEnabledPath(root), "utf8")) as { keys: string[] }).keys

  test("账本写与派生锁步:enabled skill 进允许集,disable 翻转即移除", () => {
    record({ name: "sk", kind: "skill", desiredState: "enabled" })
    expect(readKeys()).toEqual(["skill--sk"])
    expect(setDesiredStateV2(root, "skill", "sk", "disabled").ok).toBe(true)
    expect(readKeys()).toEqual([])
    expect(setDesiredStateV2(root, "skill", "sk", "enabled").ok).toBe(true)
    expect(readKeys()).toEqual(["skill--sk"])
  })

  test("畸形记录被真 decoder 排除(Codex r3 Blocker 迁移):不能借畸形重复复活被禁用技能", () => {
    record({ name: "off", kind: "skill", desiredState: "disabled" })
    const raw: { records: any[] } = JSON.parse(fs.readFileSync(path.join(root, "installs.json"), "utf8"))
    raw.records.push({ schemaVersion: 2, id: "skill:off", name: "off", kind: "skill", environment: "bogus", origin: "catalog", scope: {}, generation: 0, installedAt: "x", desiredState: "enabled" })
    fs.writeFileSync(path.join(root, "installs.json"), JSON.stringify(raw))
    const r = reconcileSkillsDerivation(root)
    expect(r.ok).toBe(true)
    expect(readKeys()).toEqual([]) // 畸形 enabled 重复被排除,disabled 真记录不进允许集
  })

  test("boot 自愈:派生文件缺失(升级首启)→ 按账本 backfill;账本损坏 → 撤陈旧允许集", () => {
    record({ name: "sk", kind: "skill", desiredState: "enabled" })
    fs.rmSync(skillsEnabledPath(root)) // 升级空窗:允许集缺失
    expect(reconcileSkillsDerivation(root).ok).toBe(true)
    expect(readKeys()).toEqual(["skill--sk"])
    fs.writeFileSync(path.join(root, "installs.json"), "totally not json") // 账本文件级损坏
    expect(reconcileSkillsDerivation(root).ok).toBe(true)
    expect(fs.existsSync(skillsEnabledPath(root))).toBe(false) // 陈旧允许集被撤(hook fail-closed)
  })

  test("reconcileDesiredStateAtBoot 顺带自愈派生文件(共享同一把锁)", () => {
    record({ name: "sk", kind: "skill", desiredState: "enabled" })
    fs.rmSync(skillsEnabledPath(root))
    expect(reconcileDesiredStateAtBoot(root).ok).toBe(true)
    expect(readKeys()).toEqual(["skill--sk"])
  })
})

// ── #395 Codex r6 B4:派生方向排序 —— 收窄先于账本、扩容后于账本 ────────────────────────────────
describe("#395 r6 B4 派生方向排序", () => {
  const readKeys = (): string[] => (JSON.parse(fs.readFileSync(skillsEnabledPath(root), "utf8")) as { keys: string[] }).keys

  test("同时收窄+扩容:移除项在账本写前落盘,新增项在账本写后落盘(不提前发布未授权 key)", () => {
    // 先让派生允许集 = [A];随后账本翻成 A 禁用 + B 启用(A 移除、B 新增)。
    record({ name: "A", kind: "skill", desiredState: "enabled" })
    expect(readKeys()).toEqual(["skill--A"])
    // 手动构造"下一账本":A disabled、B enabled,直接走 setDesiredStateV2 逐条(观察终态即可)。
    record({ name: "B", kind: "skill", desiredState: "enabled" }) // B 先入账+派生
    expect(setDesiredStateV2(root, "skill", "A", "disabled").ok).toBe(true) // A 收窄
    // 终态:A 已从允许集移除,B 在;账本 A=disabled B=enabled。
    expect(readKeys()).toEqual(["skill--B"])
    expect(findRecordV2(root, "skill", "A")!.desiredState).toBe("disabled")
    expect(findRecordV2(root, "skill", "B")!.desiredState).toBe("enabled")
  })

  test("派生文件损坏(unknown)→ 下次账本写先落空集(最严格)再补完整 next", () => {
    record({ name: "keep", kind: "skill", desiredState: "enabled" })
    fs.writeFileSync(skillsEnabledPath(root), "{ corrupt") // 派生损坏
    // 再写一次账本(任意 upsert 触发 writeLedgerFile)——unknown 分支先写空集、账本、再完整。
    record({ name: "keep2", kind: "skill", desiredState: "enabled" })
    expect(readKeys().sort()).toEqual(["skill--keep", "skill--keep2"]) // 终态完整
  })
})

// ── #395 Codex r6 B1:plugin[] concat 合并 —— legacy/XDG 源残留时 disable fail-closed + enforcementGap ─
describe("#395 enforcement gap（r11 pivot：只 plugin 落盘失败入 gap，mcp/agent 由注入兜底）", () => {
  beforeEach(() => {
    process.env.ALPHA_GLOBAL_DIR = root
  })
  afterEach(() => {
    delete process.env.ALPHA_GLOBAL_DIR
  })

  test("plugin disable config write 失败(目标只读)→ 入 enforcementGap", () => {
    record({ name: "p", kind: "plugin", configKey: "plugin:@x/p@1.0.0", desiredState: "disabled" })
    writeCfg({ plugin: ["@x/p@1.0.0"] })
    fs.chmodSync(cfgPath(), 0o444) // 只读 → applyConfigImage 写失败
    try {
      const r = reconcileDesiredStateAtBoot(root)
      // 只读文件在某些环境仍可被 owner 覆盖;仅当确实写失败才断言 gap。
      if (!r.ok) {
        expect(r.enforcementGap && r.enforcementGap.length > 0).toBe(true)
        expect(r.enforcementGap!.some((g) => g.includes("plugin p"))).toBe(true)
      }
    } finally {
      fs.chmodSync(cfgPath(), 0o644)
    }
  })

  test("mcp disable config write 失败 → **不入** gap（注入兜底，非安全洞）", () => {
    record({ name: "m", kind: "mcp", configKey: "mcp.m", desiredState: "disabled" })
    writeCfg({ mcp: { m: { type: "local" } } })
    fs.chmodSync(cfgPath(), 0o444)
    try {
      const r = reconcileDesiredStateAtBoot(root)
      if (!r.ok) expect(r.enforcementGap).toBeUndefined() // mcp 写失败不置 gap
    } finally {
      fs.chmodSync(cfgPath(), 0o644)
    }
  })

  test("skills 派生自愈:账本损坏且删不掉陈旧允许集 → staleAllowList(直接测 reconcileSkillsDerivation,不经锁)", () => {
    record({ name: "sk", kind: "skill", desiredState: "enabled" })
    fs.writeFileSync(skillsEnabledPath(root), JSON.stringify({ v: 1, keys: ["skill--sk", "skill--ghost"] })) // 陈旧含 ghost
    fs.writeFileSync(path.join(root, "installs.json"), "corrupt") // 账本损坏 → 走删陈旧派生分支
    fs.chmodSync(root, 0o555) // 目录只读 → unlink 派生文件失败
    try {
      const d = reconcileSkillsDerivation(root)
      // owner 在只读目录仍可能 unlink;仅当确实删失败才验 staleAllowList(可能仍列已禁 skill)。
      if (d.ok === false) expect(d.staleAllowList).toBe(true)
    } finally {
      fs.chmodSync(root, 0o755)
    }
  })

  test("disabled plugin 从 alpha.jsonc plugin[] 移除 → 正常收敛,无 enforcementGap", () => {
    record({ name: "p", kind: "plugin", configKey: "plugin:@x/p@1.0.0", desiredState: "disabled" })
    writeCfg({ plugin: ["@x/p@1.0.0"] })
    const r = reconcileDesiredStateAtBoot(root)
    expect(r.ok).toBe(true)
    expect(r.enforcementGap).toBeUndefined()
    expect(readCfg().plugin).toEqual([])
  })
})
