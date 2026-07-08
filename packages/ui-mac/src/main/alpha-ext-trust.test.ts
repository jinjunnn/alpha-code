import { describe, expect, test } from "bun:test"
import {
  EXTENSIONS_CONSENT_VERSION,
  extensionsGranted,
  hasExtensionsDecision,
  listProjectExecutables,
  withExtensionsConsent,
} from "./alpha-ext-trust"

describe("extensionsConsent 决策语义(REQ-060 信任门)", () => {
  test("无记录 = 未决策", () => {
    expect(hasExtensionsDecision({})).toBe(false)
    expect(extensionsGranted({})).toBe(false)
  })

  test("granted 与 denied 都是决策(不再弹);granted 语义分离", () => {
    const g = withExtensionsConsent({}, true, "2026-07-08T00:00:00Z")
    const d = withExtensionsConsent({}, false, "2026-07-08T00:00:00Z")
    expect(hasExtensionsDecision(g)).toBe(true)
    expect(hasExtensionsDecision(d)).toBe(true)
    expect(extensionsGranted(g)).toBe(true)
    expect(extensionsGranted(d)).toBe(false)
  })

  test("旧版本决策失效(版本化重弹)", () => {
    const old = { extensionsConsent: { version: EXTENSIONS_CONSENT_VERSION - 1, granted: true, decidedAt: "x" } }
    expect(hasExtensionsDecision(old)).toBe(false)
    expect(extensionsGranted(old)).toBe(false)
  })

  test("写入保留 prefs 其它字段(与 cloudConsent 共存)", () => {
    const prefs = { cloudConsent: { version: 1, acceptedAt: "y" } }
    const out = withExtensionsConsent(prefs, true, "2026-07-08T00:00:00Z")
    expect(out.cloudConsent).toEqual({ version: 1, acceptedAt: "y" })
    expect((out as Record<string, any>).extensionsConsent.granted).toBe(true)
  })

  test("坏形状(granted 非布尔)不算决策", () => {
    expect(hasExtensionsDecision({ extensionsConsent: { version: EXTENSIONS_CONSENT_VERSION, granted: "yes" } } as any)).toBe(false)
  })
})

describe("listProjectExecutables — 可执行物清单派生", () => {
  test("jsonc mcp 键名 + plugins 只认 .js(ADR-006)", () => {
    const jsonc = `{
      // 项目连接器
      "mcp": { "projdb": { "type": "local", "command": ["npx", "x"] }, "projfetch": {} },
      "agent": { "a": {} },
    }`
    const r = listProjectExecutables(jsonc, ["p.js", "raw.ts", "note.md"])
    expect(r.mcp.sort()).toEqual(["projdb", "projfetch"])
    expect(r.plugins).toEqual(["p.js"])
  })

  test("jsonc 坏/缺 → mcp 空(诚实降级,与 ext 侧一致)", () => {
    expect(listProjectExecutables("{ bad", ["p.js"]).mcp).toEqual([])
    expect(listProjectExecutables(null, []).mcp).toEqual([])
  })

  test("文本类域(agent/command/skills)不进可执行清单", () => {
    const r = listProjectExecutables(`{ "agent": { "a": {} }, "command": { "c": {} }, "skills": { "paths": ["x"] } }`, [])
    expect(r.mcp).toEqual([])
    expect(r.plugins).toEqual([])
  })
})
