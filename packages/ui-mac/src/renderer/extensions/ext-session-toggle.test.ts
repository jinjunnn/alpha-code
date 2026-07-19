// #408 PR-C:会话开关纯派生层的 L1 —— 开关状态机 / 拒绝码→文案路由 / disposed re-assert 计划 /
// 会话结束回落(grant 集清空 ⇒ 状态机回 off)。

import { describe, expect, test } from "bun:test"
import type { SessionGrantWire } from "../../shared/ext-session-grant-wire"
import { connectOutcome, findSessionGrant, grantsToReassert, sessionRefusalRoute, sessionToggleView } from "./ext-session-toggle"

const grant = (id: string, directory: string): SessionGrantWire => ({
  id,
  kind: "mcp",
  name: id.replace(/^mcp:/, ""),
  version: "1.0.0",
  directory,
  grantedAt: "2026-07-19T00:00:00.000Z",
})

const DIR_A = "/proj/a"
const DIR_B = "/proj/b"

describe("开关状态机(grant 在场 = 开;连接真伪单独如实呈现)", () => {
  test("无 grant → off(muted,「每次会话单独开启」);grant + 连接成功 → on(ok,「本次会话已启用」)", () => {
    expect(sessionToggleView(undefined, undefined)).toEqual({ on: false, textKey: "alpha.ext.sessionOffRow", tone: "muted" })
    expect(sessionToggleView(grant("mcp:labs1", DIR_A), "connected")).toEqual({ on: true, textKey: "alpha.ext.sessionOnRow", tone: "ok" })
  })

  test("grant 在场但连接失败 → 开关亮 + warn + 如实提示(绝不把已授权谎报成已连接)", () => {
    expect(sessionToggleView(grant("mcp:labs1", DIR_A), "failed")).toEqual({ on: true, textKey: "alpha.ext.sessionOnNoLink", tone: "warn" })
  })

  test("会话结束回落:grant 集清空(main 事件驱动)⇒ 同一入参路径回 off —— 开关归位、行保留", () => {
    const grants: SessionGrantWire[] = [grant("mcp:labs1", DIR_A)]
    expect(sessionToggleView(findSessionGrant(grants, "mcp:labs1", DIR_A), "connected").on).toBe(true)
    const afterEnded: SessionGrantWire[] = [] // onSessionGrantsEnded → store 清空
    expect(sessionToggleView(findSessionGrant(afterEnded, "mcp:labs1", DIR_A), undefined)).toEqual({
      on: false,
      textKey: "alpha.ext.sessionOffRow",
      tone: "muted",
    })
  })

  test("directory 维度:grant 只在自己的 instance 空间显示为开;无 directory(home 路由)恒 off", () => {
    const grants = [grant("mcp:labs1", DIR_A)]
    expect(findSessionGrant(grants, "mcp:labs1", DIR_A)?.directory).toBe(DIR_A)
    expect(findSessionGrant(grants, "mcp:labs1", DIR_B)).toBeUndefined()
    expect(findSessionGrant(grants, "mcp:labs1", undefined)).toBeUndefined()
  })
})

describe("connect 结果 → 连接真伪(r1 Major:SDK throwOnError:false 的 {error} 返回不抛)", () => {
  test("HTTP 错误以 {error} 返回(404 配置缺失等)= 未连接 → grant 在场时必须进 on-no-link,绝不记 connected", () => {
    expect(connectOutcome({ error: { status: 404 } })).toBe(false)
    const g = grant("mcp:labs1", DIR_A)
    const link = connectOutcome({ error: { status: 404 } }) ? ("connected" as const) : ("failed" as const)
    expect(sessionToggleView(g, link)).toEqual({ on: true, textKey: "alpha.ext.sessionOnNoLink", tone: "warn" })
  })

  test("成功(有结果且无 error)→ true;空结果/缺失 → false(fail-closed)", () => {
    expect(connectOutcome({ data: true } as { error?: unknown })).toBe(true)
    expect(connectOutcome({})).toBe(true) // 无 error 键 = SDK 成功臂
    expect(connectOutcome(null)).toBe(false)
    expect(connectOutcome(undefined)).toBe(false)
  })
})

describe("拒绝码 → UI 路由(按机器码,不解析 reason)", () => {
  test("expired-review → 确认对话框;kind-unsupported → info toast;泛拒/缺码 → error toast", () => {
    expect(sessionRefusalRoute("expired-review-confirmation-required")).toEqual({ kind: "expired-confirm" })
    expect(sessionRefusalRoute("session-grant-kind-unsupported")).toEqual({
      kind: "toast",
      tone: "info",
      textKey: "alpha.ext.sessionKindUnsupportedToast",
    })
    expect(sessionRefusalRoute("session-grant-refused")).toEqual({
      kind: "toast",
      tone: "error",
      textKey: "alpha.ext.sessionRefusedToast",
    })
    expect(sessionRefusalRoute(undefined)).toEqual({ kind: "toast", tone: "error", textKey: "alpha.ext.sessionRefusedToast" })
  })
})

describe("disposed 后 re-assert 计划", () => {
  test("事件带 directory → 只重断言该 instance 空间;缺失 → 全量(幂等重校验)", () => {
    const grants = [grant("mcp:labs1", DIR_A), grant("mcp:labs2", DIR_B)]
    expect(grantsToReassert(grants, DIR_A).map((g) => g.id)).toEqual(["mcp:labs1"])
    expect(grantsToReassert(grants, "/elsewhere")).toEqual([])
    expect(grantsToReassert(grants, undefined).map((g) => g.id)).toEqual(["mcp:labs1", "mcp:labs2"])
  })
})
