// REQ-104 #395 —— 启停通道:纯账本单写(setDesiredStateV2 原子 rename;运行时投影在引擎 config-hook
// 从账本派生,见 packages/ext ledger-projection)。set-state 只翻 desiredState,config/alpha.jsonc
// 逐字节不动 —— 恢复平凡、零 config/账本分叉(Codex r1 Blocker 1 重设计)。真盘临时根,零 mock。
import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import * as fs from "node:fs"
import * as os from "node:os"
import * as path from "node:path"
import { setInstallStateByKey } from "./ext-install-planner"
import { findRecordV2, upsertRecordV2, type UpsertInput } from "./ext-receipt-v2"

let root: string
const deps = () => ({ globalRoot: () => root, advisoryGate: () => ({ allowed: true }) as const })
beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "ext-setstate-"))
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

describe("setInstallStateByKey(#395 纯账本翻转)", () => {
  test("plugin/mcp/agent/skill:仅翻账本 desiredState,alpha.jsonc 逐字节不动(投影在引擎 hook 派生)", () => {
    for (const kind of ["plugin", "mcp", "agent", "skill"] as const) {
      record({ name: kind, kind, configKey: `${kind}.${kind}` })
    }
    fs.writeFileSync(path.join(root, "alpha.jsonc"), JSON.stringify({ mcp: { mcp: { type: "local" } }, plugin: ["@x/p@1"], agent: { agent: { description: "d" } } }, null, 2))
    const before = fs.readFileSync(path.join(root, "alpha.jsonc"), "utf8")
    for (const kind of ["plugin", "mcp", "agent", "skill"] as const) {
      const r = setInstallStateByKey({ type: kind, name: kind, scope: "global", state: "disabled" }, deps())
      expect(r.ok).toBe(true)
      expect(findRecordV2(root, kind, kind)!.desiredState).toBe("disabled")
    }
    // config 逐字节未动 —— set-state 从不改 alpha.jsonc(消除 config/账本分叉的根源)。
    expect(fs.readFileSync(path.join(root, "alpha.jsonc"), "utf8")).toBe(before)
    // 往返:再 enable 回来。
    const back = setInstallStateByKey({ type: "plugin", name: "plugin", scope: "global", state: "enabled" }, deps())
    expect(back.ok).toBe(true)
    expect(findRecordV2(root, "plugin", "plugin")!.desiredState).toBe("enabled")
  })

  test("无 v2 记录 → fail-closed(v1-only 无 desired-state 通道)", () => {
    const r = setInstallStateByKey({ type: "skill", name: "ghost", scope: "global", state: "disabled" }, deps())
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.reason).toContain("no v2 record")
  })

  test("损坏账本 → 翻转拒绝(fail closed;setDesiredStateV2 同款损坏闸)", () => {
    record({ name: "sk", kind: "skill" })
    // 注入同 key 损坏记录:setDesiredStateV2 对 corruptKeys 拒写。
    const raw: { records: unknown[] } = JSON.parse(fs.readFileSync(path.join(root, "installs.json"), "utf8"))
    raw.records.push({ schemaVersion: 2, id: "skill:sk", name: "sk", kind: "skill" }) // 缺必填字段 = 损坏
    fs.writeFileSync(path.join(root, "installs.json"), JSON.stringify(raw))
    const r = setInstallStateByKey({ type: "skill", name: "sk", scope: "global", state: "disabled" }, deps())
    expect(r.ok).toBe(false)
  })
})
