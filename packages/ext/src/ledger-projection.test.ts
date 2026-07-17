// REQ-104 #395 —— 账本派生启用投影(引擎 config-hook 每次施加):disabled 的 mcp/agent 叶设
// disabled:true、plugin[] 移除条目;enabled 剥离 Alpha 管理的 disabled 键;账本不可读 = 不改 cfg。
import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { applyLedgerEnableProjection } from "./ledger-projection"

let root: string
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "alpha-ledgerproj-"))
})
afterEach(() => {
  rmSync(root, { recursive: true, force: true })
})
const writeLedger = (records: unknown[]) => writeFileSync(join(root, "installs.json"), JSON.stringify({ v: 2, receipts: [], records }))

describe("applyLedgerEnableProjection", () => {
  test("disabled mcp/agent → 叶 disabled:true(其余键原样);plugin → 从 plugin[] 移除(按 configKey)", () => {
    writeLedger([
      { kind: "mcp", name: "m", desiredState: "disabled", configKey: "mcp.m" },
      { kind: "agent", name: "a", desiredState: "disabled", configKey: "agent.a" },
      { kind: "plugin", name: "p", desiredState: "disabled", configKey: "plugin:@x/p@1.0.0" },
      { kind: "plugin", name: "v", desiredState: "disabled", configKey: "plugin-path:/r/plugins/v@ab/plugin.js" },
    ])
    const cfg = {
      mcp: { m: { type: "local", command: ["x"] }, other: { type: "remote" } },
      agent: { a: { description: "d" } },
      plugin: ["@x/p@1.0.0", ["/r/plugins/v@ab/plugin.js", { opt: 1 }], "@keep/me@2"],
    }
    const n = applyLedgerEnableProjection(cfg, root)
    expect(cfg.mcp.m).toEqual({ type: "local", command: ["x"], disabled: true })
    expect(cfg.mcp.other).toEqual({ type: "remote" }) // 无账本记录 → 不碰
    expect(cfg.agent.a).toEqual({ description: "d", disabled: true })
    expect(cfg.plugin).toEqual(["@keep/me@2"]) // 两个 disabled 条目移除,无记录的保留
    expect(n).toBe(4)
  })

  test("enabled 记录 → 剥离 Alpha 管理的 disabled 键;plugin enabled 不动 plugin[]", () => {
    writeLedger([
      { kind: "mcp", name: "m", desiredState: "enabled", configKey: "mcp.m" },
      { kind: "plugin", name: "p", desiredState: "enabled", configKey: "plugin:@x/p@1.0.0" },
    ])
    const cfg = { mcp: { m: { type: "local", disabled: true } }, plugin: ["@x/p@1.0.0"] }
    applyLedgerEnableProjection(cfg, root)
    expect(cfg.mcp.m).toEqual({ type: "local" }) // disabled 键被剥离
    expect(cfg.plugin).toEqual(["@x/p@1.0.0"]) // enabled 的 plugin 条目保留
  })

  test("账本缺失/不可解析 → 不改 cfg(启停唯一权威是账本,读不到不投影;不误禁用户手写条目)", () => {
    const cfg = { mcp: { m: { type: "local" } }, plugin: ["@x/p@1"] }
    expect(applyLedgerEnableProjection(cfg, root)).toBe(0) // 无 installs.json
    writeFileSync(join(root, "installs.json"), "{ not json")
    expect(applyLedgerEnableProjection(cfg, root)).toBe(0)
    expect(cfg).toEqual({ mcp: { m: { type: "local" } }, plugin: ["@x/p@1"] })
  })

  test("无 alphaRoot → no-op", () => {
    expect(applyLedgerEnableProjection({}, undefined)).toBe(0)
  })
})
