// #348(REQ-100)wiring 合同:stage="authorize" 的 renderer 承接必须完整 —— 拦截、两阶段、重驱、
// 批量停止、busy 不可关。hook/Dialog 挂载依赖引擎 client + Solid 运行时,bun test 下不可复现
//(install-scope-wiring.test.ts 同款约束),交互结构按源文本断言;confirmed 构造/场景判定是纯函数,
// 直接行为断言。
import { describe, expect, test } from "bun:test"
import * as fs from "node:fs"
import * as path from "node:path"
import { authzHasHighRisk, authzIsEscalation, buildAuthzConfirmation } from "./ext-authz"
import type { CapabilityDiffWire } from "../../shared/ext-capability-authorization"

const here = import.meta.dir
const read = (rel: string) => fs.readFileSync(path.join(here, rel), "utf8")

const diff = (over: Partial<CapabilityDiffWire>): CapabilityDiffWire => ({
  key: "skill--demo",
  previous: null,
  requested: ["prompt:context"],
  added: ["prompt:context"],
  removed: [],
  requiresConfirmation: true,
  ...over,
})

describe("#348 confirmed 构造与场景判定(纯函数)", () => {
  test("confirmed 只含需确认项,值 = 完整 requested 集(整集覆盖,防 TOCTOU)", () => {
    const diffs = [
      diff({ key: "skill--a", requested: ["prompt:context"], added: [] , previous: ["prompt:context"], requiresConfirmation: false }),
      diff({ key: "mcp--b", requested: ["process:spawn", "engine:config"], added: ["process:spawn"], previous: ["engine:config"] }),
    ]
    expect(buildAuthzConfirmation(diffs)).toEqual({ confirmed: { "mcp--b": ["process:spawn", "engine:config"] } })
  })
  test("escalation 判定:任一需确认项已有基线;首装(previous 全 null)不是 escalation", () => {
    expect(authzIsEscalation([diff({})])).toBe(false)
    expect(authzIsEscalation([diff({ previous: ["prompt:context"], added: ["process:spawn"] })])).toBe(true)
  })
  test("高风险判定看需确认项的完整 requested 集(已授权高风险 + 新增低风险仍须警示)", () => {
    expect(authzHasHighRisk([diff({})])).toBe(false)
    expect(authzHasHighRisk([diff({ added: ["process:spawn"], requested: ["process:spawn"] })])).toBe(true)
    expect(authzHasHighRisk([diff({ added: ["engine:plugin"], requested: ["engine:plugin"], requiresConfirmation: false })])).toBe(false)
    // review minor:added 只有低风险,但完整确认集合仍含高风险 → 必须警示。
    expect(
      authzHasHighRisk([diff({ previous: ["process:spawn"], added: ["prompt:context"], requested: ["process:spawn", "prompt:context"] })]),
    ).toBe(true)
  })
})

describe("#348 wiring:renderer 承接结构(源文本合同)", () => {
  test("use-extensions.ts:installSkill/updateEntry 透传 authorization;失败分支不折叠", () => {
    const src = read("use-extensions.ts")
    expect(src).toContain("installSkill(entry: CatalogEntry, authorization?: AuthorizationConfirmationWire)")
    expect(src).toContain("updateEntry(entry: CatalogEntry, authorization?: AuthorizationConfirmationWire)")
    expect(src).toContain("return installSkill(entry, authorization)")
    expect(src).toContain("export function isAuthzRequired")
  })
  test("extension-hub.tsx:onAdd/runUpdate 拦截 authorize;重驱走 buildAuthzConfirmation", () => {
    const src = read("extension-hub.tsx")
    expect(src).toContain("isAuthzRequired(res)")
    expect(src).toContain("buildAuthzConfirmation(a.diffs)")
    // 重复 authorize:重驱结果非空 → 最新 diff 原地替换(不能只拦第一次)。
    expect(src).toContain("setAuthz({ ...a, diffs: next })")
  })
  test("extension-hub.tsx:runUpdateAll 遇任何弹框停止批量;更新路径单飞 + 模态互斥(review Major 2)", () => {
    const src = read("extension-hub.tsx")
    expect(src).toMatch(/for \(const r of updatable\(\)\) if \(\(await runUpdateOne\(r\)\) !== undefined\) break/)
    // 单行与批量入口都过 updateBlocked(进行中的更新/确认框/授权框在场一律 no-op)。
    expect(src).toContain("const updateBlocked = () => updFlight() || !!confirming() || !!authz() || confirmBusy() || authzBusy()")
    expect((src.match(/if \(updateBlocked\(\)\) return/g) ?? []).length).toBeGreaterThanOrEqual(2)
  })
  test("extension-hub.tsx:hub 全局 Esc 不越过授权框/busy(review Major 1)", () => {
    const src = read("extension-hub.tsx")
    expect(src).toContain("if (confirming() || authz() || confirmBusy() || authzBusy()) return")
  })
  test("extension-hub.tsx:busy 期间 Dialog 不可关(driving/redriving 无取消通道)", () => {
    const src = read("extension-hub.tsx")
    expect(src).toContain("dismissible={!confirmBusy() && !authzBusy()}")
    expect(src).toContain("dismissible={!authzBusy()}")
  })
  test("Dialog.tsx:dismissible=false 封死 backdrop/Esc/关闭按钮三条 dismiss 路径", () => {
    const src = fs.readFileSync(path.join(here, "..", "alpha-ui", "Dialog.tsx"), "utf8")
    expect(src).toContain('e.key === "Escape" && canDismiss()')
    expect(src).toContain("canDismiss() && props.onClose()")
    expect(src).toContain("<Show when={canDismiss()}>")
  })
})

describe("#352 wiring:插件更新 = 单次 installCatalog(两步链下线,源文本合同)", () => {
  test("updateEntry plugin 分支不再调用 uninstallV2(main 判 fresh/replace)", () => {
    const src = read("use-extensions.ts")
    const branch = src.slice(src.indexOf('entry.type === "plugin"'), src.indexOf('return { ok: false, reason: "unsupported type for update" }'))
    expect(branch).toContain("installPlugin(entry, authorization)")
    expect(branch).not.toContain("uninstallV2")
  })
})
