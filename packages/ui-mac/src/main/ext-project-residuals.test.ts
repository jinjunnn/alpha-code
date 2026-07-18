// ADR-030(REQ-098 #372)—— 收回路径的残留检测与显式清理:
//  · detect 只读:catalog 账(project identity)/ ghost 店(账本四态证明)/ 非终态 journal /
//    只报告面(unknown 店、orphan agent、误置 record);identity fail-closed;
//  · clean:cleanBlockers(账本失据)或 openJournals 在场整单 fail-closed(零自动删除);
//    起步前重巡检 journal;逐项失败隔离;幂等;
//  · Codex review PR#373 两 Blocker 回归锁:账本损坏绝不当 ghost 证据;非 skill--* 结构绝不删。
import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import * as fs from "node:fs"
import * as os from "node:os"
import * as path from "node:path"

import { cleanProjectCatalogResiduals, detectProjectCatalogResiduals } from "./ext-project-residuals"
import { projectScopeIdentity, upsertRecordV2, findRecordV2, type UpsertInput, type ScopeIdentity } from "./ext-receipt-v2"
import { skillStorePaths } from "./ext-skill-generations"
import type { PlannerDeps, PlannerInstallers } from "./ext-install-planner"

let tmp: string
beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "ext-residuals-"))
})
afterEach(() => {
  fs.rmSync(tmp, { recursive: true, force: true })
})

function makeProject(name: string): string {
  const dir = path.join(tmp, name)
  fs.mkdirSync(dir, { recursive: true })
  return fs.realpathSync(dir)
}

function seedRecord(projDir: string, name: string, kind: UpsertInput["kind"], origin: UpsertInput["origin"] = "catalog", scope?: ScopeIdentity): string {
  const identity = projectScopeIdentity(projDir)
  if (!identity.ok) throw new Error(identity.reason)
  const root = path.join(identity.scope.projectPath, ".alpha")
  const w = upsertRecordV2(root, {
    id: origin === "catalog" ? `${kind}:${name}` : `user:${name}`,
    name,
    kind,
    environment: "prod",
    scope: scope ?? identity.scope,
    desiredState: "enabled",
    origin,
    installedAt: new Date().toISOString(),
  })
  if (!w.ok) throw new Error(w.reason)
  return root
}

function seedStore(root: string, name: string): void {
  const sp = skillStorePaths(root, name)
  const genDir = path.join(sp.generations, "gen-000001-abcdef12")
  fs.mkdirSync(genDir, { recursive: true })
  fs.writeFileSync(path.join(genDir, "SKILL.md"), `---\nname: ${name}\ndescription: t\n---\nbody`)
  fs.writeFileSync(sp.pointer, JSON.stringify({ genId: "gen-000001-abcdef12" }))
}

function writeJournal(root: string, txId: string, state: string): void {
  const dir = path.join(root, "ext-tx", "journal")
  fs.mkdirSync(dir, { recursive: true })
  fs.writeFileSync(
    path.join(dir, `${txId}.json`),
    JSON.stringify({ v: 1, txId, op: "install", state, createdAt: "2026-07-15T00:00:00.000Z", updatedAt: "2026-07-15T00:00:00.000Z", items: [] }),
  )
}

const flatRemovals: Array<{ type: string; name: string }> = []
function makeDeps(overrides: Partial<PlannerInstallers> = {}): PlannerDeps {
  const ok = { ok: true as const }
  const installers = {
    persistMcp: () => ok,
    fileifyMcpSecrets: () => ({ fileified: [], skipped: [], refs: {}, restore: () => {}, discard: () => {} }),
    removeMcpSecrets: () => undefined,
    removeMcp: () => ok,
    persistPlugin: () => ok,
    removePlugin: () => ok,
    installVendoredPlugin: () => ({ ok: true as const, files: [] }),
    removePluginPath: () => ok,
    installBuiltinSkill: () => ({ ok: true as const, files: [] }),
    collectBuiltinSkillPayload: () => ({ ok: true as const, files: [] }),
    collectBuiltinAgentPayload: () => ({ ok: true as const, files: [] }),
    installRemoteSkill: () => ({ ok: true as const, files: [] }),
    removeFsInstall: (type: string, name: string) => {
      flatRemovals.push({ type, name })
      return { ok: true as const, files: [] }
    },
    downloadRemoteAsset: async () => ({ ok: true as const, contents: [] }),
    ...overrides,
  } as unknown as PlannerInstallers
  return {
    advisoryGate: () => ({ allowed: true }),
    resolveEntry: async () => null,
    environment: () => "prod",
    platform: () => "darwin",
    globalRoot: () => path.join(tmp, "global"),
    casBaseRoot: () => path.join(tmp, "cas-base"),
    installers,
  }
}

describe("detectProjectCatalogResiduals — 只读报告", () => {
  test("identity fail-closed:相对路径 / 不存在的目录 / 非字符串都拒", () => {
    expect(detectProjectCatalogResiduals("not/abs").ok).toBe(false)
    expect(detectProjectCatalogResiduals(path.join(tmp, "nope")).ok).toBe(false)
    expect(detectProjectCatalogResiduals(42).ok).toBe(false)
  })

  test("空项目 → 全空报告(零写入:不创建 .alpha)", () => {
    const proj = makeProject("clean")
    const r = detectProjectCatalogResiduals(proj)
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.catalogRecords).toEqual([])
    expect(r.ghostStoreKeys).toEqual([])
    expect(r.openJournals).toEqual([])
    expect(r.cleanBlockers).toEqual([])
    expect(fs.existsSync(path.join(proj, ".alpha"))).toBe(false)
  })

  test("catalog 账(带店/不带店)+ ghost 店 + 非终态 journal 各归各位;imported 来源不算残留", () => {
    const proj = makeProject("mixed")
    const root = seedRecord(proj, "with-store", "skill")
    seedStore(root, "with-store")
    seedRecord(proj, "flat-agent", "agent")
    seedRecord(proj, "imported-skill", "skill", "imported-claude")
    seedStore(root, "ghosty")
    writeJournal(root, "tx-open-1", "staging")
    writeJournal(root, "tx-done-1", "committed")

    const r = detectProjectCatalogResiduals(proj)
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.catalogRecords.map((c) => `${c.type}:${c.name}:${c.hasStore}`).sort()).toEqual([
      "agent:flat-agent:false",
      "skill:with-store:true",
    ])
    expect(r.ghostStoreKeys).toEqual(["skill--ghosty"])
    expect(r.openJournals.map((j) => j.txId)).toEqual(["tx-open-1"]) // 终态 journal 不算
    expect(r.cleanBlockers).toEqual([])
  })

  test("不可读 journal 视同在途(state=unreadable 进 openJournals)", () => {
    const proj = makeProject("corrupt-journal")
    const root = seedRecord(proj, "x", "skill")
    const dir = path.join(root, "ext-tx", "journal")
    fs.mkdirSync(dir, { recursive: true })
    fs.writeFileSync(path.join(dir, "tx-bad.json"), "{not json")
    const r = detectProjectCatalogResiduals(proj)
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.openJournals).toHaveLength(1)
    expect(r.openJournals[0]!.state).toBe("unreadable")
  })

  test("B1 回归:账本文件损坏 → cleanBlockers,店绝不判 ghost", () => {
    const proj = makeProject("ledger-corrupt")
    const root = path.join(proj, ".alpha")
    seedStore(root, "victim")
    fs.writeFileSync(path.join(root, "installs.json"), "{broken json")
    const r = detectProjectCatalogResiduals(proj)
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.ghostStoreKeys).toEqual([])
    expect(r.cleanBlockers.length).toBeGreaterThan(0)
  })

  test("B1 回归:该 key 的 v2 record 损坏(可归属)→ cleanBlockers,不判 ghost", () => {
    const proj = makeProject("record-corrupt")
    const root = path.join(proj, ".alpha")
    seedStore(root, "victim")
    fs.mkdirSync(root, { recursive: true })
    fs.writeFileSync(path.join(root, "installs.json"), JSON.stringify({ records: [{ kind: "skill", name: "victim", bogus: true }] }))
    const r = detectProjectCatalogResiduals(proj)
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.ghostStoreKeys).toEqual([])
    expect(r.cleanBlockers.some((b) => b.includes("skill--victim"))).toBe(true)
  })

  test("B2 回归:非 skill--* 形状 / 无 generation 结构的 ext-store 条目 → 只报告", () => {
    const proj = makeProject("unknown-store")
    const root = path.join(proj, ".alpha")
    fs.mkdirSync(path.join(root, "ext-store", "hand-made"), { recursive: true })
    fs.mkdirSync(path.join(root, "ext-store", "skill--hollow"), { recursive: true }) // 无 generations/current
    const r = detectProjectCatalogResiduals(proj)
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.ghostStoreKeys).toEqual([])
    expect(r.unknownStoreEntries.sort()).toEqual(["hand-made", "skill--hollow"])
  })

  test("M1 回归:catalog record 但 scope 非 project → 只报告,不进可清理面", () => {
    const proj = makeProject("misplaced")
    const root = seedRecord(proj, "misplaced-skill", "skill", "catalog", { kind: "global" })
    const r = detectProjectCatalogResiduals(proj)
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.catalogRecords).toEqual([])
    expect(r.warnings.some((w) => w.includes("misplaced catalog record"))).toBe(true)
    expect(findRecordV2(root, "skill", "misplaced-skill")).not.toBeNull()
  })

  test("M3 回归:无账面依据的 agent 文件与 alpha.jsonc agent 条目 → 只报告", () => {
    const proj = makeProject("orphan-agent")
    const root = seedRecord(proj, "backed", "agent") // 有账的不算 orphan
    fs.mkdirSync(path.join(root, "agents"), { recursive: true })
    fs.writeFileSync(path.join(root, "agents", "backed.md"), "x")
    fs.writeFileSync(path.join(root, "agents", "stray.md"), "x")
    fs.writeFileSync(path.join(root, "alpha.jsonc"), JSON.stringify({ agent: { backed: {}, "config-stray": {} } }))
    const r = detectProjectCatalogResiduals(proj)
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.orphanAgentFiles).toEqual(["stray.md"])
    expect(r.orphanAgentConfigEntries).toEqual(["config-stray"])
  })
})

describe("cleanProjectCatalogResiduals — 显式清理", () => {
  test("openJournals 在场 → 整单 fail-closed,零删除", async () => {
    const proj = makeProject("blocked")
    const root = seedRecord(proj, "demo", "skill")
    seedStore(root, "demo")
    writeJournal(root, "tx-open-1", "switching")
    const r = await cleanProjectCatalogResiduals(proj, makeDeps())
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.reason).toContain("open transaction journal")
    expect(findRecordV2(root, "skill", "demo")).not.toBeNull()
    expect(fs.existsSync(skillStorePaths(root, "demo").store)).toBe(true)
  })

  test("B1 回归:账本损坏 → 整单 fail-closed,店与账都不动", async () => {
    const proj = makeProject("blocked-ledger")
    const root = path.join(proj, ".alpha")
    seedStore(root, "victim")
    fs.writeFileSync(path.join(root, "installs.json"), "{broken json")
    const r = await cleanProjectCatalogResiduals(proj, makeDeps())
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.reason).toContain("not provably complete")
    expect(fs.existsSync(skillStorePaths(root, "victim").store)).toBe(true)
  })

  test("happy path:带店 skill journaled teardown、agent flat 面、ghost 店直清;只报告面不动;幂等", async () => {
    flatRemovals.length = 0
    const proj = makeProject("happy")
    const root = seedRecord(proj, "demo", "skill")
    seedStore(root, "demo")
    seedRecord(proj, "helper", "agent")
    seedStore(root, "ghosty")
    fs.mkdirSync(path.join(root, "ext-store", "hand-made"), { recursive: true })

    const r = await cleanProjectCatalogResiduals(proj, makeDeps())
    expect(r.ok).toBe(true) // #336:ok:true 只在零失败时成立(成功臂不再携带 failed)
    if (!r.ok) return
    expect(r.cleaned.sort()).toEqual(["agent:helper", "skill:demo", "store:skill--ghosty"])
    expect(r.reported).toEqual(["unknown-store:hand-made"])
    expect(findRecordV2(root, "skill", "demo")).toBeNull()
    expect(findRecordV2(root, "agent", "helper")).toBeNull()
    expect(fs.existsSync(skillStorePaths(root, "demo").store)).toBe(false)
    expect(fs.existsSync(skillStorePaths(root, "ghosty").store)).toBe(false)
    expect(fs.existsSync(path.join(root, "ext-store", "hand-made"))).toBe(true) // B2:未知目录保留
    // skill 带店绝不走 flat;agent(无店)走既有 flat 管理面
    expect(flatRemovals).toEqual([{ type: "agent", name: "helper" }])

    // 幂等:重跑 no-op(残留已清,只剩只报告面)
    const again = await cleanProjectCatalogResiduals(proj, makeDeps())
    expect(again.ok).toBe(true)
    if (again.ok) expect(again.cleaned).toEqual([])
  })

  test("失败隔离:agent flat 删除失败进 failed → 整单 ok:false(#336 判别位如实),skill 照常清完", async () => {
    flatRemovals.length = 0
    const proj = makeProject("isolation")
    const root = seedRecord(proj, "demo", "skill")
    seedStore(root, "demo")
    seedRecord(proj, "helper", "agent")
    const deps = makeDeps({ removeFsInstall: () => ({ ok: false as const, reason: "disk says no" }) })
    const r = await cleanProjectCatalogResiduals(proj, deps)
    // #336:failed 非空绝不包成外层 ok:true(跨 IPC 的成功判别位必须如实);进度字段保留供呈现。
    expect(r.ok).toBe(false)
    if (r.ok) return
    expect(r.reason).toContain("agent:helper")
    expect(r.cleaned).toEqual(["skill:demo"])
    expect(r.failed).toEqual([{ item: "agent:helper", reason: "disk says no" }])
    expect(findRecordV2(root, "agent", "helper")).not.toBeNull() // 失败项零变更
    expect(fs.existsSync(skillStorePaths(root, "demo").store)).toBe(false)

    // 幂等重试:清障(deps 恢复正常)后重跑只补失败项 → ok:true
    const retry = await cleanProjectCatalogResiduals(proj, makeDeps())
    expect(retry.ok).toBe(true)
    if (retry.ok) expect(retry.cleaned).toEqual(["agent:helper"])
  })

  test("项目移动 → identity 不符的账单项 fail-closed 进 failed → 整单 ok:false,不删任何东西", async () => {
    const proj = makeProject("moving")
    const root = seedRecord(proj, "demo", "skill")
    seedStore(root, "demo")
    const moved = path.join(tmp, "moved-away")
    fs.renameSync(proj, moved)
    const r = await cleanProjectCatalogResiduals(moved, makeDeps())
    expect(r.ok).toBe(false) // #336:失败项在场 = 整单 ok:false
    if (r.ok) return
    expect(r.failed?.some((f) => f.item === "skill:demo" && f.reason.includes("identity mismatch"))).toBe(true)
    const movedRoot = path.join(moved, ".alpha")
    expect(findRecordV2(movedRoot, "skill", "demo")).not.toBeNull()
    expect(fs.existsSync(skillStorePaths(movedRoot, "demo").store)).toBe(true)
  })
})
