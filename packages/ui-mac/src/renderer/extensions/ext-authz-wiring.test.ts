// #348(REQ-100):confirmed 构造/场景判定保持纯函数断言；真实 standalone 授权宿主的
// open/busy/dismissible、三条关闭路径、安全初始焦点与状态转换由 Dialog.test.ts 生产编译渲染覆盖。
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

describe("#352 wiring:插件更新 = 单次 installCatalog(两步链下线,源文本合同)", () => {
  test("updateEntry plugin 分支不再调用 uninstallV2(main 判 fresh/replace)", () => {
    const src = read("use-extensions.ts")
    const branch = src.slice(src.indexOf('entry.type === "plugin"'), src.indexOf('return { ok: false, reason: "unsupported type for update" }'))
    expect(branch).toContain("installPlugin(entry, authorization)")
    expect(branch).not.toContain("uninstallV2")
  })
})
