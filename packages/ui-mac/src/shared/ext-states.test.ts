// REQ-103 slice 1(issue #195,父 #212 §2)—— availability/activation/health 三态分离单测:
// 每维独立值域 + 边界组合(archived+installed、bundled+未安装、advisory+enabled、disabled+健康)
// 锁死「三维正交、禁止互相塌缩」。

import { describe, expect, test } from "bun:test"
import {
  ACTIVATION_STATES,
  AVAILABILITY_STATES,
  deriveActivation,
  deriveAvailability,
  deriveHealth,
  HEALTH_STATES,
} from "./ext-states"

describe("availability(可获得性)", () => {
  test("层级:installed ≻ bundled ≻ catalog ≻ unavailable", () => {
    expect(deriveAvailability({ installed: true, bundledCompatible: true, inCatalog: true }).state).toBe("installed")
    expect(deriveAvailability({ installed: false, bundledCompatible: true, inCatalog: true }).state).toBe("bundled")
    expect(deriveAvailability({ installed: false, bundledCompatible: false, inCatalog: true }).state).toBe("catalog")
    expect(deriveAvailability({ installed: false, bundledCompatible: false, inCatalog: false }).state).toBe("unavailable")
  })

  test("来源不塌缩:installed 条目仍如实保留 catalog/bundled 来源位", () => {
    const view = deriveAvailability({ installed: true, bundledCompatible: true, inCatalog: true })
    expect(view.sources).toEqual({ installed: true, bundled: true, catalog: true })
  })

  test("seed 平台不兼容 = 不可获得(bundledCompatible=false 不算 bundled)", () => {
    const view = deriveAvailability({ installed: false, bundledCompatible: false, inCatalog: false })
    expect(view.state).toBe("unavailable")
    expect(view.sources.bundled).toBe(false)
  })

  test("值域显式", () => {
    expect([...AVAILABILITY_STATES]).toEqual(["installed", "bundled", "catalog", "unavailable"])
  })
})

describe("activation(激活态)", () => {
  test("未安装 = not-installed(不是 disabled —— 不塌缩)", () => {
    expect(deriveActivation({ ledger: "none" })).toBe("not-installed")
  })

  test("v1-only 存量无 desired-state 通道 → 如实 enabled", () => {
    expect(deriveActivation({ ledger: "v1" })).toBe("enabled")
  })

  test("v2 record 以 desiredState 为真源", () => {
    expect(deriveActivation({ ledger: "v2", desiredState: "enabled" })).toBe("enabled")
    expect(deriveActivation({ ledger: "v2", desiredState: "disabled" })).toBe("disabled")
  })

  test("值域显式", () => {
    expect([...ACTIVATION_STATES]).toEqual(["enabled", "disabled", "not-installed"])
  })
})

describe("health(健康)", () => {
  const ADV = { catalogId: "mcp:word", archivedAt: "2026-03-03" }

  test("已安装、v2 账本、无 advisory、事务落定 → ok", () => {
    expect(deriveHealth({ installed: true, ledger: "v2", transactionState: "committed" })).toEqual({ state: "ok", issues: [] })
  })

  test("未安装且无 advisory → unknown(没有可探测面,不假装 ok)", () => {
    expect(deriveHealth({ installed: false }).state).toBe("unknown")
  })

  test("REQ-105 archived advisory:未安装的浏览行同样 degraded(health ⊥ availability)", () => {
    const view = deriveHealth({ installed: false, advisory: ADV })
    expect(view.state).toBe("degraded")
    expect(view.issues).toEqual([{ kind: "archived-upstream", catalogId: "mcp:word", archivedAt: "2026-03-03" }])
  })

  test("v1-compat 账本 → degraded(digest/generation 链不可验,如实降级)", () => {
    const view = deriveHealth({ installed: true, ledger: "v1" })
    expect(view.state).toBe("degraded")
    expect(view.issues[0]!.kind).toBe("ledger-v1-compat")
  })

  test("REQ-100 事务接缝:pending / rolled-back 都不算健康落定", () => {
    expect(deriveHealth({ installed: true, ledger: "v2", transactionState: "pending", transactionId: "t1" }).issues[0]).toEqual({
      kind: "transaction-pending",
      transactionId: "t1",
    })
    expect(deriveHealth({ installed: true, ledger: "v2", transactionState: "rolled-back", transactionId: "t2" }).state).toBe("degraded")
  })

  test("值域显式", () => {
    expect([...HEALTH_STATES]).toEqual(["ok", "degraded", "unknown"])
  })

  // ── 边界组合:三维互不塌缩(父 AC2)────────────────────────────────────────────────────────────

  test("组合 archived+installed:availability=installed、activation=enabled、health=degraded —— 三维各自独立", () => {
    expect(deriveAvailability({ installed: true, bundledCompatible: false, inCatalog: true }).state).toBe("installed")
    expect(deriveActivation({ ledger: "v2", desiredState: "enabled" })).toBe("enabled")
    expect(deriveHealth({ installed: true, ledger: "v2", advisory: ADV }).state).toBe("degraded")
  })

  test("组合 bundled+未安装:availability=bundled、activation=not-installed、health=unknown(REQ-102 语义:可获得 ⊥ 激活)", () => {
    expect(deriveAvailability({ installed: false, bundledCompatible: true, inCatalog: false }).state).toBe("bundled")
    expect(deriveActivation({ ledger: "none" })).toBe("not-installed")
    expect(deriveHealth({ installed: false }).state).toBe("unknown")
  })

  test("组合 advisory+enabled:health=degraded 不改变 activation(警示 ≠ 禁用;绝不静默禁用用户安装)", () => {
    const health = deriveHealth({ installed: true, ledger: "v2", advisory: ADV })
    const activation = deriveActivation({ ledger: "v2", desiredState: "enabled" })
    expect(health.state).toBe("degraded")
    expect(activation).toBe("enabled")
  })

  test("组合 installed+disabled+健康:disabled ≠ 不健康(激活 ⊥ 健康)", () => {
    expect(deriveActivation({ ledger: "v2", desiredState: "disabled" })).toBe("disabled")
    expect(deriveHealth({ installed: true, ledger: "v2" }).state).toBe("ok")
  })
})
