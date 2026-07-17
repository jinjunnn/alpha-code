// REQ-104 #395 —— 启停通道端到端:mcp/agent/plugin 走 journaled config 事务(投影与账本原子,
// 账本翻转在 commitReceipt);skill 纯账本翻转零 config 触碰;enable 缺生效面 fail-closed;
// commitReceipt 失败 → 引擎回滚 config(两面永不背离)。真盘临时根,零 mock.module(仓规)。
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
const readCfg = () => JSON.parse(fs.readFileSync(path.join(root, "alpha.jsonc"), "utf8")) as Record<string, unknown>

describe("setInstallStateByKey(#395 投影事务)", () => {
  test("plugin:enable 按 configKey 物化 plugin[] 条目 + 账本翻开;disable 移除条目 + 账本翻关(原子往返)", async () => {
    record({ name: "np", kind: "plugin", desiredState: "disabled", configKey: "plugin:@x/np@1.0.0" })
    writeCfg({ plugin: [] })
    const en = await setInstallStateByKey({ type: "plugin", name: "np", scope: "global", state: "enabled" }, deps())
    expect(en.ok).toBe(true)
    expect(readCfg().plugin).toEqual(["@x/np@1.0.0"])
    expect(findRecordV2(root, "plugin", "np")!.desiredState).toBe("enabled")
    const dis = await setInstallStateByKey({ type: "plugin", name: "np", scope: "global", state: "disabled" }, deps())
    expect(dis.ok).toBe(true)
    expect(readCfg().plugin).toEqual([])
    expect(findRecordV2(root, "plugin", "np")!.desiredState).toBe("disabled")
  })

  test("mcp:disable 写引擎原生 disabled:true(其余键原样);enable 剥离该键", async () => {
    record({ name: "demo", kind: "mcp", configKey: "mcp.demo" })
    writeCfg({ mcp: { demo: { type: "local", command: ["x"] } } })
    const dis = await setInstallStateByKey({ type: "mcp", name: "demo", scope: "global", state: "disabled" }, deps())
    expect(dis.ok).toBe(true)
    expect((readCfg().mcp as Record<string, unknown>).demo).toEqual({ type: "local", command: ["x"], disabled: true })
    const en = await setInstallStateByKey({ type: "mcp", name: "demo", scope: "global", state: "enabled" }, deps())
    expect(en.ok).toBe(true)
    expect((readCfg().mcp as Record<string, unknown>).demo).toEqual({ type: "local", command: ["x"] })
  })

  test("agent:disable/enable 翻 disabled 叶;enable 缺生效面(叶不存在)fail-closed 不写账", async () => {
    record({ name: "bot", kind: "agent", configKey: "agent.bot" })
    writeCfg({ agent: { bot: { description: "d" } } })
    expect((await setInstallStateByKey({ type: "agent", name: "bot", scope: "global", state: "disabled" }, deps())).ok).toBe(true)
    expect((readCfg().agent as Record<string, unknown>).bot).toEqual({ description: "d", disabled: true })
    // 叶被外力删掉后 enable:无从重建生效面 → 诚实拒绝,账本保持 disabled。
    writeCfg({ agent: {} })
    const en = await setInstallStateByKey({ type: "agent", name: "bot", scope: "global", state: "enabled" }, deps())
    expect(en.ok).toBe(false)
    if (!en.ok) expect(en.reason).toContain("config entry missing")
    expect(findRecordV2(root, "agent", "bot")!.desiredState).toBe("disabled")
  })

  test("skill:纯账本翻转,alpha.jsonc 逐字节不动(投影 = 引擎侧注入门消费账本)", async () => {
    record({ name: "sk", kind: "skill" })
    writeCfg({ mcp: {} })
    const before = fs.readFileSync(path.join(root, "alpha.jsonc"), "utf8")
    const r = await setInstallStateByKey({ type: "skill", name: "sk", scope: "global", state: "disabled" }, deps())
    expect(r.ok).toBe(true)
    expect(findRecordV2(root, "skill", "sk")!.desiredState).toBe("disabled")
    expect(fs.readFileSync(path.join(root, "alpha.jsonc"), "utf8")).toBe(before)
  })

  test("alpha.jsonc 不可解析 → 投影 kinds 的翻转整体拒绝(fail closed,账本不动)", async () => {
    record({ name: "np2", kind: "plugin", desiredState: "disabled", configKey: "plugin:@x/np2@1.0.0" })
    fs.writeFileSync(path.join(root, "alpha.jsonc"), "{ not jsonc !!!")
    const r = await setInstallStateByKey({ type: "plugin", name: "np2", scope: "global", state: "enabled" }, deps())
    expect(r.ok).toBe(false)
    expect(findRecordV2(root, "plugin", "np2")!.desiredState).toBe("disabled")
  })
})
