// #408(REQ-104):session-grant 会话级启用 —— main 侧 grant 登记面的 L1。
// 覆盖裁决必答面:generation 失效栅栏(异步授权 × 会话结束竞态)、directory 维度撤销、
// re-assert 失败清除(disposed re-assert 的 main 半场)、持久面字节不变、fail-closed 拒绝分支。

import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import * as fs from "node:fs"
import * as os from "node:os"
import * as path from "node:path"
import { curationBlobUrl } from "../shared/catalog-curation"
import type { AdvisoryGate } from "./ext-advisory-gate"
import type { VerifiedCatalogEntry } from "./ext-install-planner"
import { upsertRecordV2 } from "./ext-receipt-v2"
import {
  createSessionGrantRegistry,
  grantSessionGrant,
  revokeSessionGrant,
  type SessionGrantDeps,
  type SessionGrantRegistry,
} from "./ext-session-grants"

const SHA_A = "a".repeat(64)
const SHA_B = "b".repeat(64)

// 有效 curation(与 ext-curation-policy.test.ts 同構;labs ⇒ session-grant)。
const curation = (
  catalogId: string,
  version: string,
  over: Partial<{ tier: string; activationPolicy: string; reviewedAt: string; reviewBefore: string }> = {},
) => ({
  schema: "alpha.catalog.curation.v1",
  tier: over.tier ?? "labs",
  activationPolicy: over.activationPolicy ?? "session-grant",
  deliveryMode: "installable",
  review: {
    reviewedAt: over.reviewedAt ?? "2026-07-01T00:00:00Z",
    reviewedBy: "alpha-review",
    upstreamStatus: "active",
    supportTier: "best-effort",
    reviewBefore: over.reviewBefore ?? "2027-07-01T00:00:00Z",
  },
  applicability: { frameworks: ["*"] },
  summaries: { capabilities: [], networkDomains: [], requiredSecrets: [], runtimeDependencies: [], download: { bytes: null, basis: "unknown" } },
  refs: {
    sbom: { sha256: SHA_A, bytes: 1024, url: curationBlobUrl(catalogId, version, "sbom", SHA_A), format: "cyclonedx-1.6+json" },
    intakeProvenance: {
      sha256: SHA_B,
      bytes: 512,
      url: curationBlobUrl(catalogId, version, "intakeProvenance", SHA_B),
      format: "alpha.intake-provenance.v1+json",
    },
  },
})

const ID = "mcp:labs1"
const NAME = "labs1"
const VERSION = "1.0.0"
const DIR_A = path.join(os.tmpdir(), "proj-a")
const DIR_B = path.join(os.tmpdir(), "proj-b")

const entryOf = (over: Partial<{ id: string; type: string; name: string; version: string; curation: unknown }> = {}) => ({
  id: over.id ?? ID,
  type: over.type ?? "mcp",
  name: over.name ?? NAME,
  version: over.version ?? VERSION,
  curation: over.curation ?? curation(over.id ?? ID, over.version ?? VERSION),
})

const verifiedOf = (entry: unknown): VerifiedCatalogEntry =>
  ({ entry, channel: "cache", catalogVersion: "2026.07.01" }) as VerifiedCatalogEntry

const ALLOW: AdvisoryGate = () => ({ allowed: true })

let root: string
let registry: SessionGrantRegistry

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "sg-"))
  registry = createSessionGrantRegistry()
  registry.beginSession(1)
})
afterEach(() => fs.rmSync(root, { recursive: true, force: true }))

/** 账本里种一条 global catalog 记录(session-grant 条目按 #397 恒 desiredState=disabled 落账)。 */
function seedRecord(over: Partial<Parameters<typeof upsertRecordV2>[1]> = {}) {
  const w = upsertRecordV2(root, {
    id: ID,
    name: NAME,
    kind: "mcp" as const,
    environment: "prod" as const,
    scope: { kind: "global" as const },
    version: VERSION,
    desiredState: "disabled" as const,
    origin: "catalog" as const,
    installedAt: "2026-07-18T00:00:00.000Z",
    ...over,
  })
  expect(w.ok).toBe(true)
}

function depsOf(over: Partial<SessionGrantDeps> = {}): SessionGrantDeps {
  return {
    registry,
    globalRoot: () => root,
    resolveEntry: async () => verifiedOf(entryOf()),
    advisoryGate: ALLOW,
    now: () => "2026-07-18T12:00:00.000Z",
    ...over,
  }
}

const grantInput = (over: Partial<{ catalogId: string; directory: string; confirmExpiredReview: boolean }> = {}) => ({
  catalogId: ID,
  directory: DIR_A,
  ...over,
})

describe("授予(fail-closed 校验链)", () => {
  test("已装 labs mcp + 已验 catalog 同身份 → ok;grant 携 directory 且入登记处;账本 desiredState 不动", async () => {
    seedRecord()
    const r = await grantSessionGrant(grantInput(), depsOf())
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.grant).toEqual({ id: ID, kind: "mcp", name: NAME, version: VERSION, directory: DIR_A, grantedAt: "2026-07-18T12:00:00.000Z" })
    expect(registry.list()).toHaveLength(1)
  })

  test("输入解码 fail-closed:未知键 / 相对路径 directory / 空 catalogId 一律拒", async () => {
    seedRecord()
    for (const bad of [
      { ...grantInput(), rogue: 1 },
      grantInput({ directory: "relative/dir" }),
      grantInput({ catalogId: "" }),
      "junk",
    ]) {
      const r = await grantSessionGrant(bad, depsOf())
      expect(r.ok).toBe(false)
      if (!r.ok) expect(r.code).toBe("session-grant-refused")
    }
    expect(registry.list()).toHaveLength(0)
  })

  test("无活跃会话(sidecar 未起/已结束)→ 拒", async () => {
    seedRecord()
    registry.endSession()
    const r = await grantSessionGrant(grantInput(), depsOf())
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.reason).toContain("no active engine session")
  })

  test("未安装(无 global catalog 记录)→ 拒;grant 通道绝不代装", async () => {
    const r = await grantSessionGrant(grantInput(), depsOf())
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.reason).toContain("no installed global catalog record")
  })

  test("同 id 多条 global catalog 记录 = 歧义 → 拒(fail closed)", async () => {
    seedRecord()
    seedRecord({ name: "labs1-alias", kind: "mcp" as const })
    const r = await grantSessionGrant(grantInput(), depsOf())
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.reason).toContain("ambiguous")
  })

  test("kind ≠ mcp(引擎无瞬态激活面)→ session-grant-kind-unsupported", async () => {
    seedRecord({ id: "agent:labsy", name: "labsy", kind: "agent" as const })
    const r = await grantSessionGrant(grantInput({ catalogId: "agent:labsy" }), depsOf())
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.code).toBe("session-grant-kind-unsupported")
  })

  test("advisory 否决 → 拒,且优先于 curation 拒绝(非 session-grant 条目也先报 advisory)", async () => {
    seedRecord()
    const blocked: AdvisoryGate = () => ({ allowed: false, advisoryId: "ADV-1", reason: "withdrawn upstream" })
    const nonSessionGrant = verifiedOf(entryOf({ curation: curation(ID, VERSION, { tier: "precache", activationPolicy: "default-disabled" }) }))
    const r = await grantSessionGrant(grantInput(), depsOf({ advisoryGate: blocked, resolveEntry: async () => nonSessionGrant }))
    expect(r.ok).toBe(false)
    if (!r.ok) {
      expect(r.reason).toContain("advisory ADV-1")
      expect(r.code).toBe("session-grant-refused")
    }
  })

  test("获取顺序:resolveEntry 先行刷新 —— 刷新带回的新 active advisory 必须拒(r1 Major:旧 LKG 冻结视图不得绕过 R14 新激活阻断)", async () => {
    seedRecord()
    // 模拟 plannerDeps 语义:resolveEntry 刷新并持久化 advisories;advisory gate 冻结「调用时」
    // 的视图。刷新前 = 未阻断(旧 LKG 尚新鲜),刷新后 = 新 active advisory 阻断。
    let refreshed = false
    const gate: AdvisoryGate = () =>
      refreshed ? { allowed: false, advisoryId: "ADV-R14", reason: "activated by this refresh" } : { allowed: true }
    const deps = depsOf({
      advisoryGate: gate,
      resolveEntry: async () => {
        refreshed = true // 刷新落盘 → advisory 面翻新
        return verifiedOf(entryOf())
      },
    })
    const r = await grantSessionGrant(grantInput(), deps)
    expect(r.ok).toBe(false)
    if (!r.ok) {
      expect(r.reason).toContain("advisory ADV-R14")
      expect(r.code).toBe("session-grant-refused")
    }
    expect(registry.list()).toHaveLength(0)
  })

  test("resolver rejection(r2 Major):已有 grant 的 re-assert 遇 resolveEntry 抛错 → 结构化拒 + 旧 grant 撤下,绝不上抛/存活", async () => {
    seedRecord()
    expect((await grantSessionGrant(grantInput(), depsOf())).ok).toBe(true)
    expect(registry.list()).toHaveLength(1)
    const r = await grantSessionGrant(
      grantInput(),
      depsOf({
        resolveEntry: async () => {
          throw new Error("catalog refresh I/O failure")
        },
      }),
    )
    expect(r.ok).toBe(false)
    if (!r.ok) {
      expect(r.code).toBe("session-grant-refused")
      expect(r.reason).toContain("catalog refresh I/O failure")
    }
    expect(registry.list()).toHaveLength(0) // 重校验不可证 = 同 key 旧 grant 必须撤下(fail closed)
  })

  test("resolver rejection + advisory 已阻断 → advisory 拒绝优先(reason 是 advisory,非 resolver 失败)", async () => {
    seedRecord()
    const blocked: AdvisoryGate = () => ({ allowed: false, advisoryId: "ADV-2", reason: "blocked upstream" })
    const r = await grantSessionGrant(
      grantInput(),
      depsOf({
        advisoryGate: blocked,
        resolveEntry: async () => {
          throw new Error("catalog refresh I/O failure")
        },
      }),
    )
    expect(r.ok).toBe(false)
    if (!r.ok) {
      expect(r.reason).toContain("advisory ADV-2")
      expect(r.reason).not.toContain("catalog refresh I/O failure")
    }
    expect(registry.list()).toHaveLength(0)
  })

  test("已验 entry 解析不到(下架/离线/security)→ 拒,不降格放行", async () => {
    seedRecord()
    const r = await grantSessionGrant(grantInput(), depsOf({ resolveEntry: async () => null }))
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.reason).toContain("not resolvable from the verified catalog")
  })

  test("身份四元组失配(装 1.0.0,catalog 2.0.0)→ 拒", async () => {
    seedRecord()
    const drifted = verifiedOf(entryOf({ version: "2.0.0", curation: curation(ID, "2.0.0") }))
    const r = await grantSessionGrant(grantInput(), depsOf({ resolveEntry: async () => drifted }))
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.reason).toContain("identity does not match")
  })

  test("record 无 version(v1 遗留无法自证身份)→ 拒", async () => {
    seedRecord({ version: undefined })
    const r = await grantSessionGrant(grantInput(), depsOf())
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.reason).toContain("no version")
  })

  test("未策展 / curation 无效 / activationPolicy 非 session-grant → 各自拒", async () => {
    seedRecord()
    const cases: Array<[unknown, string]> = [
      [verifiedOf({ id: ID, type: "mcp", name: NAME, version: VERSION }), "not curated"],
      [verifiedOf(entryOf({ curation: { ...curation(ID, VERSION), rogue: 1 } })), "FAILED validation"],
      [verifiedOf(entryOf({ curation: curation(ID, VERSION, { tier: "precache", activationPolicy: "default-disabled" }) })), "not a session-grant entry"],
    ]
    for (const [verified, needle] of cases) {
      const r = await grantSessionGrant(grantInput(), depsOf({ resolveEntry: async () => verified as VerifiedCatalogEntry }))
      expect(r.ok).toBe(false)
      if (!r.ok) expect(r.reason).toContain(needle)
    }
  })

  test("复审过期:无确认 → expired-review-confirmation-required;confirmExpiredReview:true → ok", async () => {
    seedRecord()
    // reviewBefore 必须晚于 reviewedAt(decode 不变量),但早于 now(2026-07-18)= 已过期
    const expired = verifiedOf(entryOf({ curation: curation(ID, VERSION, { reviewedAt: "2025-01-01T00:00:00Z", reviewBefore: "2026-01-01T00:00:00Z" }) }))
    const deps = depsOf({ resolveEntry: async () => expired })
    const refused = await grantSessionGrant(grantInput(), deps)
    expect(refused.ok).toBe(false)
    if (!refused.ok) expect(refused.code).toBe("expired-review-confirmation-required")
    const confirmed = await grantSessionGrant(grantInput({ confirmExpiredReview: true }), deps)
    expect(confirmed.ok).toBe(true)
  })
})

describe("generation 失效栅栏(裁决 Q3 竞态不变量)", () => {
  test("授权期间会话结束:迟到的 resolveEntry 完成后 commit 被栅栏拒,Map 保持空(零复活窗口)", async () => {
    seedRecord()
    let releaseResolve!: (v: VerifiedCatalogEntry | null) => void
    const gate = new Promise<VerifiedCatalogEntry | null>((res) => (releaseResolve = res))
    const pending = grantSessionGrant(grantInput(), depsOf({ resolveEntry: () => gate }))
    registry.endSession() // 会话在授权途中结束(崩溃/kill/respawn 同路)
    releaseResolve(verifiedOf(entryOf())) // 授权此刻才完成 —— 一切校验都会通过,唯栅栏拒
    const r = await pending
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.reason).toContain("session ended while the grant was being authorized")
    expect(registry.list()).toHaveLength(0)
    // 新会话(respawn)从空集开始,旧代 grant 无从复活
    registry.beginSession(2)
    expect(registry.list()).toHaveLength(0)
  })

  test("endSession 顺序不变量:先撤 active 标记再清 Map —— 结束后旧代 commit 一律拒", () => {
    registry.commit(1, { id: ID, kind: "mcp", name: NAME, version: VERSION, directory: DIR_A, grantedAt: "t" })
    const ended = registry.endSession()
    expect(ended.endedGen).toBe(1)
    expect(ended.grants).toHaveLength(1)
    expect(registry.activeGeneration()).toBeNull()
    expect(registry.commit(1, { id: ID, kind: "mcp", name: NAME, version: VERSION, directory: DIR_A, grantedAt: "t" })).toBe(false)
    expect(registry.list()).toHaveLength(0)
    // 无活跃会话时幂等:endedGen=null(调用方据此跳过事件)
    expect(registry.endSession().endedGen).toBeNull()
  })
})

describe("directory 维度(裁决必改②:enforcement 空间)", () => {
  test("同条目两个 directory = 两条 grant;revoke 只撤对应 directory,另一实例空间不受影响", async () => {
    seedRecord()
    const deps = depsOf()
    expect((await grantSessionGrant(grantInput({ directory: DIR_A }), deps)).ok).toBe(true)
    expect((await grantSessionGrant(grantInput({ directory: DIR_B }), deps)).ok).toBe(true)
    expect(registry.list()).toHaveLength(2)
    expect(revokeSessionGrant({ catalogId: ID, directory: DIR_A }, { registry })).toEqual({ ok: true })
    const left = registry.list()
    expect(left).toHaveLength(1)
    expect(left[0]!.directory).toBe(DIR_B)
  })

  test("revoke 幂等:重复撤 / 会话结束后撤 / 从未授予撤 → 恒 ok;输入解码仍 fail-closed", () => {
    expect(revokeSessionGrant({ catalogId: ID, directory: DIR_A }, { registry })).toEqual({ ok: true })
    expect(revokeSessionGrant({ catalogId: ID, directory: DIR_A }, { registry })).toEqual({ ok: true })
    registry.endSession()
    expect(revokeSessionGrant({ catalogId: ID, directory: DIR_A }, { registry })).toEqual({ ok: true })
    const bad = revokeSessionGrant({ catalogId: ID, directory: "not-absolute" }, { registry })
    expect(bad.ok).toBe(false)
    const rogue = revokeSessionGrant({ catalogId: ID, directory: DIR_A, extra: 1 }, { registry })
    expect(rogue.ok).toBe(false)
  })
})

describe("re-assert(global.disposed 后重校验)的 main 半场", () => {
  test("同 key 重授予幂等 ok;身份漂移后重授予 → 拒且既有 grant 就地撤下(开关必须回落)", async () => {
    seedRecord()
    const deps = depsOf()
    expect((await grantSessionGrant(grantInput(), deps)).ok).toBe(true)
    expect((await grantSessionGrant(grantInput(), deps)).ok).toBe(true) // re-assert 常态:幂等
    expect(registry.list()).toHaveLength(1)
    // dispose 之后条目在 catalog 侧漂移(update/下架)—— 重校验失败必须撤旧 grant,绝不静默保持
    const drifted = depsOf({ resolveEntry: async () => verifiedOf(entryOf({ version: "2.0.0", curation: curation(ID, "2.0.0") })) })
    const r = await grantSessionGrant(grantInput(), drifted)
    expect(r.ok).toBe(false)
    expect(registry.list()).toHaveLength(0)
  })
})

describe("持久面零写(不变量)", () => {
  test("grant 成功、各类拒绝、revoke 后:installs.json 与 alpha.jsonc 字节完全不变", async () => {
    seedRecord()
    const configPath = path.join(root, "alpha.jsonc")
    fs.writeFileSync(configPath, `{\n  // alpha config\n  "mcp": { "${NAME}": { "type": "local", "command": ["x"], "enabled": false } }\n}\n`)
    const ledgerPath = path.join(root, "installs.json")
    const ledgerBefore = fs.readFileSync(ledgerPath)
    const configBefore = fs.readFileSync(configPath)
    const listingBefore = fs.readdirSync(root).sort() // seed 阶段的派生文件(skills-enabled.json)属安装面,非 grant 面

    expect((await grantSessionGrant(grantInput(), depsOf())).ok).toBe(true)
    expect((await grantSessionGrant(grantInput({ catalogId: "mcp:absent" }), depsOf())).ok).toBe(false)
    expect((await grantSessionGrant(grantInput(), depsOf({ resolveEntry: async () => null }))).ok).toBe(false)
    expect(revokeSessionGrant({ catalogId: ID, directory: DIR_A }, { registry }).ok).toBe(true)
    registry.endSession()

    expect(fs.readFileSync(ledgerPath).equals(ledgerBefore)).toBe(true)
    expect(fs.readFileSync(configPath).equals(configBefore)).toBe(true)
    // 且根目录没有任何新落盘文件(无会话戳/无 grant 持久面)
    expect(fs.readdirSync(root).sort()).toEqual(listingBefore)
  })
})
