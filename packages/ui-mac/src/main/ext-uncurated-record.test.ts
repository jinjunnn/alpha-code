// REQ-099 #306:未策展落账 coordinator + decodeRecordV2 catalog 语义防混用不变量。
// 契约:未策展 = 单次 upsert 双账本(v2 record + 派生 v1 receipt)、id 恒 user:<name>、无供给链
// 字段;catalog 身份不可被未策展伪造/顶替(账本键 (kind,name) 级冲突 fail-closed)。

import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import * as fs from "node:fs"
import * as os from "node:os"
import * as path from "node:path"
import { addReceipt } from "./alpha-installs"
import { findRecordV2, removeRecordV2, upsertRecordV2, type UpsertInput } from "./ext-receipt-v2"
import { installSkillGeneration } from "./ext-skill-generations"
import { recordUncuratedInstall } from "./ext-uncurated-record"

let root = ""
beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "ext-uncurated-"))
})
afterEach(() => {
  try {
    fs.rmSync(root, { recursive: true, force: true })
  } catch {
    /* best effort */
  }
})

const DIGEST_A = `sha256:${"a".repeat(64)}`

function catalogInput(overrides: Partial<UpsertInput> = {}): UpsertInput {
  return {
    id: "mcp:markitdown",
    name: "markitdown",
    kind: "mcp",
    environment: "prod",
    scope: { kind: "global" },
    manifestDigest: DIGEST_A,
    desiredState: "enabled",
    origin: "catalog",
    installedAt: new Date("2026-07-13T08:00:00Z").toISOString(),
    ...overrides,
  }
}

describe("decodeRecordV2 — catalog 语义防混用不变量(#306)", () => {
  test("非 catalog 来源伪造 catalog id → 拒写", () => {
    const r = upsertRecordV2(root, catalogInput({ origin: "created", id: "mcp:markitdown" }))
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.reason).toContain("catalog identity is not forgeable")
  })

  test("非 catalog 来源携带供给链 digest → 拒写", () => {
    const r = upsertRecordV2(root, catalogInput({ origin: "created", id: "user:markitdown" }))
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.reason).toContain("supply-chain digests")
  })

  test("catalog 来源缺保留前缀 → 拒写;command 禁 catalog 来源", () => {
    const bad = upsertRecordV2(root, catalogInput({ id: "user:markitdown" }))
    expect(bad.ok).toBe(false)
    if (!bad.ok) expect(bad.reason).toContain('reserved "mcp:" prefix')
    const cmd = upsertRecordV2(root, catalogInput({ kind: "command", id: "command:x", name: "x", configKey: undefined, manifestDigest: undefined }))
    expect(cmd.ok).toBe(false)
    if (!cmd.ok) expect(cmd.reason).toContain('not allowed for kind "command"')
  })

  test("合法 catalog 与合法未策展 record 都可写", () => {
    expect(upsertRecordV2(root, catalogInput()).ok).toBe(true)
    const u = upsertRecordV2(root, catalogInput({ kind: "plugin", name: "mytool", id: "user:mytool", origin: "created", manifestDigest: undefined }))
    expect(u.ok).toBe(true)
  })
})

describe("recordUncuratedInstall — 未策展唯一落账入口(#306)", () => {
  test("落账 = 单次 upsert 双账本:v2 record(generation 1)+ 派生 v1 receipt,id user:<name>", () => {
    const r = recordUncuratedInstall(root, {
      kind: "mcp",
      name: "my-mcp",
      origin: "created",
      environment: "prod",
      scope: { kind: "global" },
      configKey: "mcp.my-mcp",
    })
    expect(r.ok).toBe(true)
    const rec = findRecordV2(root, "mcp", "my-mcp")
    expect(rec?.id).toBe("user:my-mcp")
    expect(rec?.generation).toBe(1) // 无 addReceipt 前置 —— 首装不是 2
    expect(rec?.origin).toBe("created")
    expect(rec?.manifestDigest).toBeUndefined()
    const raw = JSON.parse(fs.readFileSync(path.join(root, "installs.json"), "utf8")) as { receipts: Array<{ id: string; name: string }> }
    expect(raw.receipts.some((x) => x.id === "user:my-mcp" && x.name === "my-mcp")).toBe(true) // 派生 v1(降级可读)
  })

  test("同键 catalog v2 record 在账 → 拒绝顶替", () => {
    expect(upsertRecordV2(root, catalogInput()).ok).toBe(true)
    const r = recordUncuratedInstall(root, { kind: "mcp", name: "markitdown", origin: "created", environment: "prod", scope: { kind: "global" } })
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.reason).toContain("is a catalog install")
  })

  test("同键 catalog v1 receipt(无 v2)在账 → 拒绝顶替", () => {
    expect(
      addReceipt(root, { id: "mcp:markitdown", name: "markitdown", type: "mcp", scope: "global", installedAt: new Date().toISOString(), origin: "catalog" }).ok,
    ).toBe(true)
    const r = recordUncuratedInstall(root, { kind: "mcp", name: "markitdown", origin: "created", environment: "prod", scope: { kind: "global" } })
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.reason).toContain("catalog v1 receipt")
  })

  test("同名 skill 有 generation store(catalog 管辖)→ 拒绝(防卸载拆代际留 flat 孤儿)", async () => {
    const gen = await installSkillGeneration(root, {
      name: "demo",
      id: "skill:demo",
      environment: "prod",
      scope: { kind: "global" },
      origin: "catalog",
      files: [{ path: "SKILL.md", data: Buffer.from("---\nname: demo\ndescription: t\n---\nbody") }],
      version: "1.0.0",
      manifestDigest: DIGEST_A,
      grantDigest: DIGEST_A,
    })
    expect(gen.ok).toBe(true)
    // 正常态:v2 record 闸先拦
    const viaRecord = recordUncuratedInstall(root, { kind: "skill", name: "demo", origin: "imported", environment: "prod", scope: { kind: "global" } })
    expect(viaRecord.ok).toBe(false)
    if (!viaRecord.ok) expect(viaRecord.reason).toContain("is a catalog install")
    // 崩溃残留态(store 在盘、账本缺记录):generation store 闸兜底
    expect(removeRecordV2(root, "skill", "demo").ok).toBe(true)
    const viaStore = recordUncuratedInstall(root, { kind: "skill", name: "demo", origin: "imported", environment: "prod", scope: { kind: "global" } })
    expect(viaStore.ok).toBe(false)
    if (!viaStore.ok) expect(viaStore.reason).toContain("generation-managed")
  })

  test("未策展重装同名(非 catalog)允许,generation 递增", () => {
    const scope = { kind: "global" as const }
    expect(recordUncuratedInstall(root, { kind: "plugin", name: "np", origin: "created", environment: "prod", scope }).ok).toBe(true)
    const again = recordUncuratedInstall(root, { kind: "plugin", name: "np", origin: "created", environment: "prod", scope })
    expect(again.ok).toBe(true)
    expect(findRecordV2(root, "plugin", "np")?.generation).toBe(2)
  })
})
