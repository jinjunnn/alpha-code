// ADR-030(REQ-098 #372)—— 收回路径的残留检测与显式清理:
//  · detect 只读:catalog 账 / ghost 店 / 非终态 journal;identity fail-closed;
//  · clean:openJournals 在场整单 fail-closed(零自动删除);无 journal 时 generation-aware
//    幂等清理(skill 带店 = journaled store+ledger teardown;ghost 店直清;agent 走 flat 管理面);
//  · 项目移动 = 单项 fail-closed(不拖垮其余),绝不退化 global。
import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import * as fs from "node:fs"
import * as os from "node:os"
import * as path from "node:path"

import { cleanProjectCatalogResiduals, detectProjectCatalogResiduals } from "./ext-project-residuals"
import { projectScopeIdentity, upsertRecordV2, findRecordV2, type UpsertInput } from "./ext-receipt-v2"
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

function seedRecord(projDir: string, name: string, kind: UpsertInput["kind"], origin: UpsertInput["origin"] = "catalog"): string {
  const identity = projectScopeIdentity(projDir)
  if (!identity.ok) throw new Error(identity.reason)
  const root = path.join(identity.scope.projectPath, ".alpha")
  const w = upsertRecordV2(root, {
    id: origin === "catalog" ? `${kind}:${name}` : `user:${name}`,
    name,
    kind,
    environment: "prod",
    scope: identity.scope,
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
function makeDeps(): PlannerDeps {
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
    installBuiltinAgent: () => ({ ok: true as const, files: [] }),
    installRemoteSkill: () => ({ ok: true as const, files: [] }),
    installRemoteAgent: () => ({ ok: true as const, files: [] }),
    removeFsInstall: (type: string, name: string) => {
      flatRemovals.push({ type, name })
      return { ok: true as const, files: [] }
    },
    downloadRemoteAsset: async () => ({ ok: true as const, contents: [] }),
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
  test("identity fail-closed:相对路径 / 不存在的目录都拒", () => {
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
    expect(fs.existsSync(path.join(proj, ".alpha"))).toBe(false)
  })

  test("catalog 账(带店/不带店)+ ghost 店 + 非终态 journal 各归各位;imported 来源不算残留", () => {
    const proj = makeProject("mixed")
    const root = seedRecord(proj, "with-store", "skill")
    seedStore(root, "with-store")
    seedRecord(proj, "flat-agent", "agent")
    seedRecord(proj, "imported-skill", "skill", "imported-claude")
    const ghost = skillStorePaths(root, "ghosty")
    fs.mkdirSync(path.join(ghost.generations, "gen-000001-deadbeef"), { recursive: true })
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

  test("happy path:带店 skill 走 journaled teardown、agent 走 flat 管理面、ghost 店直清;幂等", async () => {
    flatRemovals.length = 0
    const proj = makeProject("happy")
    const root = seedRecord(proj, "demo", "skill")
    seedStore(root, "demo")
    seedRecord(proj, "helper", "agent")
    const ghost = skillStorePaths(root, "ghosty")
    fs.mkdirSync(path.join(ghost.generations, "gen-000001-deadbeef"), { recursive: true })

    const r = await cleanProjectCatalogResiduals(proj, makeDeps())
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.failed).toEqual([])
    expect(r.cleaned.sort()).toEqual(["agent:helper", "skill:demo", "store:skill--ghosty"])
    expect(findRecordV2(root, "skill", "demo")).toBeNull()
    expect(findRecordV2(root, "agent", "helper")).toBeNull()
    expect(fs.existsSync(skillStorePaths(root, "demo").store)).toBe(false)
    expect(fs.existsSync(ghost.store)).toBe(false)
    // skill 带店绝不走 flat;agent(无店)走既有 flat 管理面
    expect(flatRemovals).toEqual([{ type: "agent", name: "helper" }])

    // 幂等:重跑 no-op(残留已清,detect 为空 → cleaned 空)
    const again = await cleanProjectCatalogResiduals(proj, makeDeps())
    expect(again.ok).toBe(true)
    if (again.ok) expect(again.cleaned).toEqual([])
  })

  test("项目移动 → identity 不符的账单项 fail-closed 进 failed,不删任何东西", async () => {
    const proj = makeProject("moving")
    const root = seedRecord(proj, "demo", "skill")
    seedStore(root, "demo")
    const moved = path.join(tmp, "moved-away")
    fs.renameSync(proj, moved)
    const r = await cleanProjectCatalogResiduals(moved, makeDeps())
    expect(r.ok).toBe(true)
    if (!r.ok) return
    // 账单项因 identity mismatch 失败;店对账里的 key 仍与账绑定,不作为 ghost 清
    expect(r.failed.some((f) => f.item === "skill:demo" && f.reason.includes("identity mismatch"))).toBe(true)
    const movedRoot = path.join(moved, ".alpha")
    expect(findRecordV2(movedRoot, "skill", "demo")).not.toBeNull()
    expect(fs.existsSync(skillStorePaths(movedRoot, "demo").store)).toBe(true)
  })
})
