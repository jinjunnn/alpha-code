// REQ-104 #395 —— 启停通道:持久化 config 投影 + 账本翻转(锁内普通原子写,非事务)。
// disabled plugin 必须从磁盘 config 缺席(引擎 import 插件早于 config-hook);mcp/agent 写 disabled:true 叶;
// skill 无 config 面(投影经引擎注入门)。config 自持 disabled 态 → 免疫「删账本复活」。真盘临时根,零 mock。
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
const writeCfg = (cfg: unknown) => fs.writeFileSync(path.join(root, "alpha.jsonc"), JSON.stringify(cfg, null, 2))
const readCfg = (): Record<string, any> => JSON.parse(fs.readFileSync(path.join(root, "alpha.jsonc"), "utf8"))

describe("setInstallStateByKey(#395 持久化投影 + 账本翻转)", () => {
  test("plugin:disable 从 plugin[] 移除条目 + 账本翻关;enable 按 configKey 补回 + 账本翻开(往返)", () => {
    record({ name: "np", kind: "plugin", configKey: "plugin:@x/np@1.0.0" })
    writeCfg({ plugin: ["@x/np@1.0.0"] })
    const dis = setInstallStateByKey({ type: "plugin", name: "np", scope: "global", state: "disabled" }, deps())
    expect(dis.ok).toBe(true)
    expect(readCfg().plugin).toEqual([]) // disabled plugin 从 disk config 缺席(引擎 import 前)
    expect(findRecordV2(root, "plugin", "np")!.desiredState).toBe("disabled")
    const en = setInstallStateByKey({ type: "plugin", name: "np", scope: "global", state: "enabled" }, deps())
    expect(en.ok).toBe(true)
    expect(readCfg().plugin).toEqual(["@x/np@1.0.0"])
    expect(findRecordV2(root, "plugin", "np")!.desiredState).toBe("enabled")
  })

  test("mcp:disable 写引擎消费键 enabled:false(其余键原样);enable 剥离该键", () => {
    record({ name: "demo", kind: "mcp", configKey: "mcp.demo" })
    writeCfg({ mcp: { demo: { type: "local", command: ["x"] } } })
    expect(setInstallStateByKey({ type: "mcp", name: "demo", scope: "global", state: "disabled" }, deps()).ok).toBe(true)
    expect(readCfg().mcp.demo).toEqual({ type: "local", command: ["x"], enabled: false })
    expect(setInstallStateByKey({ type: "mcp", name: "demo", scope: "global", state: "enabled" }, deps()).ok).toBe(true)
    expect(readCfg().mcp.demo).toEqual({ type: "local", command: ["x"] })
  })

  test("agent:disable/enable 翻引擎消费键 disable;enable 缺生效面(叶不存在)fail-closed 不写账", () => {
    record({ name: "bot", kind: "agent", configKey: "agent.bot" })
    writeCfg({ agent: { bot: { description: "d" } } })
    expect(setInstallStateByKey({ type: "agent", name: "bot", scope: "global", state: "disabled" }, deps()).ok).toBe(true)
    expect(readCfg().agent.bot).toEqual({ description: "d", disable: true })
    writeCfg({ agent: {} }) // 叶被外力删掉
    const en = setInstallStateByKey({ type: "agent", name: "bot", scope: "global", state: "enabled" }, deps())
    expect(en.ok).toBe(false)
    if (!en.ok) expect(en.reason).toContain("config entry missing")
    expect(findRecordV2(root, "agent", "bot")!.desiredState).toBe("disabled")
  })

  test("skill:纯账本翻转,alpha.jsonc 逐字节不动(投影 = 引擎侧注入门消费账本)", () => {
    record({ name: "sk", kind: "skill" })
    writeCfg({ mcp: {} })
    const before = fs.readFileSync(path.join(root, "alpha.jsonc"), "utf8")
    expect(setInstallStateByKey({ type: "skill", name: "sk", scope: "global", state: "disabled" }, deps()).ok).toBe(true)
    expect(findRecordV2(root, "skill", "sk")!.desiredState).toBe("disabled")
    expect(fs.readFileSync(path.join(root, "alpha.jsonc"), "utf8")).toBe(before)
  })

  test("无 v2 记录 → fail-closed", () => {
    const r = setInstallStateByKey({ type: "skill", name: "ghost", scope: "global", state: "disabled" }, deps())
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.reason).toContain("no v2 record")
  })

  test("alpha.jsonc 不可解析 → 投影拒绝(fail closed,账本不动)", () => {
    record({ name: "np2", kind: "plugin", configKey: "plugin:@x/np2@1.0.0" })
    fs.writeFileSync(path.join(root, "alpha.jsonc"), "{ not jsonc !!!")
    const r = setInstallStateByKey({ type: "plugin", name: "np2", scope: "global", state: "disabled" }, deps())
    expect(r.ok).toBe(false)
    expect(findRecordV2(root, "plugin", "np2")!.desiredState).toBe("enabled") // 账本未翻
  })
})

// ── Codex r3 回归:路径身份匹配(等价形态)+ enable 失败回滚 config ──────────────────────────────
describe("#395 Codex r3 回归", () => {
  test("vendored plugin:disk 条目为 file:// 等价形态时,disable 仍按解析路径命中移除(禁用不绕过)", () => {
    const abs = path.join(root, "plugins", "v@ab", "plugin.js")
    record({ name: "v", kind: "plugin", configKey: `plugin-path:${abs}` })
    // disk 存的是 file:// 形态(引擎/用户等价改写)——账本键是绝对路径,须解析后匹配。
    writeCfg({ plugin: [`file://${abs}`, "@keep/other@1"] })
    const dis = setInstallStateByKey({ type: "plugin", name: "v", scope: "global", state: "disabled" }, deps())
    expect(dis.ok).toBe(true)
    expect(readCfg().plugin).toEqual(["@keep/other@1"]) // file:// 形态被解析命中并移除
    expect(findRecordV2(root, "plugin", "v")!.desiredState).toBe("disabled")
  })

  test("enable 时账本损坏(setDesiredStateV2 拒写)→ config 回滚,不留 config-enabled/账本-disabled 分叉", () => {
    const abs = path.join(root, "plugins", "np@cd", "plugin.js")
    record({ name: "np3", kind: "plugin", configKey: `plugin-path:${abs}` })
    writeCfg({ plugin: [] }) // disabled 投影:缺席
    // 先合法置 disabled(config 已缺席),再注入同 key 损坏记录使 enable 的账本写被拒。
    const raw: { records: any[] } = JSON.parse(fs.readFileSync(path.join(root, "installs.json"), "utf8"))
    raw.records = raw.records.map((r: any) => (r.name === "np3" ? { ...r, desiredState: "disabled" } : r))
    raw.records.push({ schemaVersion: 2, id: "plugin:np3", name: "np3", kind: "plugin" }) // 损坏重复
    fs.writeFileSync(path.join(root, "installs.json"), JSON.stringify(raw))
    const en = setInstallStateByKey({ type: "plugin", name: "np3", scope: "global", state: "enabled" }, deps())
    expect(en.ok).toBe(false) // 账本拒写
    // 关键:enable 先写账本(失败即止),config 从未被补回 —— 不留启用条目。
    expect(readCfg().plugin).toEqual([])
  })
})
