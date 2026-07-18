// REQ-104 #395(r11 pivot 主权注入):disabled 的 mcp/agent 覆盖注入 OPENCODE_CONFIG_CONTENT —— 引擎
// 最后加载(step 6),mergeDeep 压过一切 in-scope 源,disabled 扩展永不被引擎加载。真盘临时根,零 mock。
import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import * as fs from "node:fs"
import * as os from "node:os"
import * as path from "node:path"
import { injectDisabledOverrides } from "./ext-disabled-injection"
import { upsertRecordV2, type UpsertInput } from "./ext-receipt-v2"

let root: string
let saved: string | undefined
beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "ext-inject-"))
  saved = process.env.ALPHA_GLOBAL_DIR
  process.env.ALPHA_GLOBAL_DIR = root
})
afterEach(() => {
  if (saved === undefined) delete process.env.ALPHA_GLOBAL_DIR
  else process.env.ALPHA_GLOBAL_DIR = saved
  fs.rmSync(root, { recursive: true, force: true })
})
const record = (over: Partial<UpsertInput> & { name: string; kind: UpsertInput["kind"] }): void => {
  const w = upsertRecordV2(root, {
    id: `${over.kind}:${over.name}`,
    environment: "prod",
    scope: { kind: "global" },
    desiredState: "enabled",
    origin: "catalog",
    installedAt: "2026-07-18T00:00:00.000Z",
    ...over,
  })
  if (!w.ok) throw new Error(w.reason)
}

describe("injectDisabledOverrides（主权注入）", () => {
  test("disabled mcp → 注入 lone {enabled:false}(引擎 schema 允许);disabled agent → {disable:true}", () => {
    record({ name: "m", kind: "mcp", configKey: "mcp.m", desiredState: "disabled" })
    record({ name: "a", kind: "agent", configKey: "agent.a", desiredState: "disabled" })
    const config: { mcp?: Record<string, unknown>; agent?: Record<string, unknown> } = {}
    injectDisabledOverrides(config, { userDataPath: root, channel: "stable" })
    expect(config.mcp!.m).toEqual({ enabled: false })
    expect(config.agent!.a).toEqual({ disable: true })
  })

  test("已有同名叶 → merge 保留其余字段,只覆盖 enabled/disable", () => {
    record({ name: "m", kind: "mcp", configKey: "mcp.m", desiredState: "disabled" })
    const config = { mcp: { m: { type: "local", command: ["x"], enabled: true } } as Record<string, unknown> }
    injectDisabledOverrides(config, { userDataPath: root, channel: "stable" })
    expect(config.mcp.m).toEqual({ type: "local", command: ["x"], enabled: false })
  })

  test("enabled 记录不注入;skill/plugin 不注入(无 mcp/agent 覆盖面)", () => {
    record({ name: "on", kind: "mcp", configKey: "mcp.on", desiredState: "enabled" })
    record({ name: "sk", kind: "skill", desiredState: "disabled" })
    record({ name: "pl", kind: "plugin", configKey: "plugin:@x/p@1", desiredState: "disabled" })
    const config: { mcp?: Record<string, unknown>; agent?: Record<string, unknown> } = {}
    injectDisabledOverrides(config, { userDataPath: root, channel: "stable" })
    expect(config.mcp).toBeUndefined()
    expect(config.agent).toBeUndefined()
  })

  test("project-scope disabled 记录不注入(全局面只管 global)", () => {
    record({
      name: "pm",
      kind: "mcp",
      configKey: "mcp.pm",
      desiredState: "disabled",
      scope: { kind: "project", projectPath: "/tmp/x", projectPathHash: "a".repeat(64) },
    })
    const config: { mcp?: Record<string, unknown> } = {}
    injectDisabledOverrides(config, { userDataPath: root, channel: "stable" })
    expect(config.mcp).toBeUndefined()
  })

  test("账本不可读 → 跳过不抛(best-effort;alpha.jsonc 投影仍在)", () => {
    fs.writeFileSync(path.join(root, "installs.json"), "corrupt")
    const config: { mcp?: Record<string, unknown> } = { mcp: { keep: { type: "local" } } }
    expect(() => injectDisabledOverrides(config, { userDataPath: root, channel: "stable" })).not.toThrow()
    expect(config.mcp!.keep).toEqual({ type: "local" }) // 未破坏既有
  })
})

// ── Codex r12 B1:agent disable 同时注入 mode 面(引擎末尾 mode→agent 折叠会覆盖 agent.disable）──
describe("injectDisabledOverrides r12 B1（mode 折叠）", () => {
  test("disabled agent → agent[name].disable=true **且** mode[name].disable=true", () => {
    upsertRecordV2(root, {
      id: "agent:w", name: "w", kind: "agent", environment: "prod", scope: { kind: "global" },
      desiredState: "disabled", origin: "catalog", configKey: "agent.w", installedAt: "2026-07-18T00:00:00.000Z",
    })
    const config: { agent?: Record<string, unknown>; mode?: Record<string, unknown> } = {}
    injectDisabledOverrides(config, { userDataPath: root, channel: "stable" })
    expect((config.agent!.w as Record<string, unknown>).disable).toBe(true)
    expect((config.mode!.w as Record<string, unknown>).disable).toBe(true) // 折叠面也压住
  })
})

// ── #397(必改①):session-grant 记录的持久投影强制 ──────────────────────────────────────────────
describe("#397 session-grant 强制(注入面)", () => {
  test("session-grant 记录 ledger enabled → 强制注入 disabled;未命中的 enabled 不注入", () => {
    record({ name: "labs", kind: "mcp", configKey: "mcp.labs", desiredState: "enabled" })
    record({ name: "free", kind: "mcp", configKey: "mcp.free", desiredState: "enabled" })
    record({ name: "la", kind: "agent", configKey: "agent.la", desiredState: "enabled" })
    const config: { mcp?: Record<string, unknown>; agent?: Record<string, unknown>; mode?: Record<string, unknown> } = {}
    injectDisabledOverrides(config, {
      userDataPath: root,
      channel: "stable",
      sessionGrantIds: () => ({ ok: true as const, ids: new Set(["mcp:labs", "agent:la"]) }),
    })
    expect(config.mcp!.labs).toEqual({ enabled: false }) // 持久 enable 非法 → 注入面按 disabled
    expect(config.mcp!.free).toBeUndefined() // 非 session-grant 的 enabled 不受影响
    expect(config.agent!.la).toEqual({ disable: true })
    expect(config.mode!.la).toEqual({ disable: true })
  })
})
