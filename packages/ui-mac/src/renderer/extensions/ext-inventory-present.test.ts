// ext-inventory-present 单测(REQ-103 #195):锁死 inventoryView → 呈现原语的映射。
//   · 三态渲染映射(health → dot 色 + 文案 key;activation/availability 正交不塌缩);
//   · 详情页两段存在性(所有权 5 行、来源与签名段的签名/分发/版本行);
//   · 隔离态开关 disabled 契约(当前数据面无 revoked kind → 不锁,OPEN 见模块头);
//   · inventoryRowFor 同 id 取已安装行优先(AC5 同名并存的行选择)。
import { describe, expect, test } from "bun:test"
import {
  authoredLabelKey,
  curatedLabelKey,
  inventoryInstallRow,
  inventoryRowFor,
  healthPresentation,
  isSwitchLocked,
  ownershipRows,
  trustRows,
  trustSignatureKey,
} from "./ext-inventory-present"
import type { OwnershipDims } from "../../shared/ext-ownership"
import type { HealthView } from "../../shared/ext-states"
import type { InventoryRow, ExtInventory } from "../../preload/types"

const communityMcp: OwnershipDims = {
  authored: "community",
  curated: "alpha",
  distributed: "engine-config",
  runtimeSurfaces: ["local-subprocess"],
  supportTier: "community",
}

describe("所有权段(AC1:作者与甄选分开陈述)", () => {
  test("5 行、顺序固定、作者≠甄选", () => {
    const rows = ownershipRows(communityMcp)
    expect(rows.map((r) => r.labelKey)).toEqual([
      "alpha.ext.ownAuthor",
      "alpha.ext.ownCurated",
      "alpha.ext.ownDistributed",
      "alpha.ext.ownRuntime",
      "alpha.ext.ownSupport",
    ])
    // 社区作者 + Alpha 甄选 —— 两维独立,不塌缩成「Alpha 出品」。
    expect(rows[0]!.valueKeys).toEqual(["alpha.ext.partyCommunity"])
    expect(rows[1]!.valueKeys).toEqual(["alpha.ext.curatedAlpha"])
    expect(rows[0]!.valueKeys).not.toEqual(rows[1]!.valueKeys)
  })

  test("多运行面如实并列(不塌缩为单值)", () => {
    const rows = ownershipRows({ ...communityMcp, runtimeSurfaces: ["local-subprocess", "remote-service"] })
    expect(rows[3]!.valueKeys).toEqual(["alpha.ext.surfLocalSubprocess", "alpha.ext.surfRemoteService"])
  })

  test("作者维越域/未知如实落 unknown,不猜", () => {
    expect(authoredLabelKey("unknown")).toBe("alpha.ext.partyUnknown")
    expect(authoredLabelKey("user")).toBe("alpha.ext.partyUser")
    expect(authoredLabelKey("official")).toBe("alpha.ext.partyOfficial")
    expect(curatedLabelKey("user")).toBe("alpha.ext.curatedUser")
  })
})

describe("来源与签名段(信任链就近;发布钥不在读面 → 省略)", () => {
  test("已验签名通道:签名 + 分发 + 版本 三行", () => {
    const rows = trustRows(communityMcp, "remote", "2026-07-13.1")
    expect(rows.map((r) => r.labelKey)).toEqual([
      "alpha.ext.trustSignatureLabel",
      "alpha.ext.trustDistLabel",
      "alpha.ext.trustVersionLabel",
    ])
    expect(rows[0]!.valueKeys).toEqual(["alpha.ext.trustSignedChannel"])
    expect(rows[2]!.value).toBe("2026-07-13.1")
  })

  test("catalogChannel 决定签名文案:remote/cache=已验,bundled=内置信任,null=不可用", () => {
    expect(trustSignatureKey("remote")).toBe("alpha.ext.trustSignedChannel")
    expect(trustSignatureKey("cache")).toBe("alpha.ext.trustSignedChannel")
    expect(trustSignatureKey("bundled")).toBe("alpha.ext.trustBundled")
    expect(trustSignatureKey(null)).toBe("alpha.ext.trustUnverified")
  })

  test("无 catalogVersion 时不产版本行(不造)", () => {
    const rows = trustRows(communityMcp, "bundled", null)
    expect(rows.some((r) => r.labelKey === "alpha.ext.trustVersionLabel")).toBe(false)
  })
})

describe("已安装三态:health → dot 色 + 文案(与 activation 正交)", () => {
  const view = (state: HealthView["state"], issues: HealthView["issues"] = []): HealthView => ({ state, issues })

  test("ok → 绿点·运行健康", () => {
    expect(healthPresentation(view("ok"))).toEqual({ tone: "ok", textKey: "alpha.ext.healthOk" })
  })

  test("v1-compat 单独存在不作运行故障 dot(仍绿·运行健康)", () => {
    // 迁移窗口既有事实:完整性不可验 ≠ 运行不健康 —— 否则现存 v1 安装一片琥珀。
    expect(healthPresentation(view("degraded", [{ kind: "ledger-v1-compat" }]))).toEqual({
      tone: "ok",
      textKey: "alpha.ext.healthOk",
    })
  })

  test("上游归档 → 琥珀·上游已归档", () => {
    const h = view("degraded", [{ kind: "archived-upstream", catalogId: "mcp:word", archivedAt: "2026-03-03" }])
    expect(healthPresentation(h)).toEqual({ tone: "warn", textKey: "alpha.ext.healthArchived" })
  })

  test("事务未落定 / 已回滚 → 琥珀,各自文案", () => {
    expect(healthPresentation(view("degraded", [{ kind: "transaction-pending", transactionId: "t1" }]))).toEqual({
      tone: "warn",
      textKey: "alpha.ext.healthTxPending",
    })
    expect(healthPresentation(view("degraded", [{ kind: "transaction-rolled-back", transactionId: "t2" }]))).toEqual({
      tone: "warn",
      textKey: "alpha.ext.healthTxRolledBack",
    })
  })

  test("archived 优先级高于事务(多问题时取最重的运行面警示)", () => {
    const h = view("degraded", [
      { kind: "transaction-pending", transactionId: "t1" },
      { kind: "archived-upstream", catalogId: "mcp:word", archivedAt: "2026-03-03" },
    ])
    expect(healthPresentation(h).textKey).toBe("alpha.ext.healthArchived")
  })

  test("unknown(未安装浏览行)→ muted·未安装,不塌缩成 ok", () => {
    expect(healthPresentation(view("unknown"))).toEqual({ tone: "muted", textKey: "alpha.ext.healthUnknown" })
  })
})

describe("隔离态锁开关契约(设计稿:签名撤销强制停用)", () => {
  test("当前数据面无 revoked/quarantine kind → 恒不锁(OPEN:数据面需补 kind)", () => {
    // 既有任一 health 形态都不得锁开关(不造隔离态);补 kind 后在 isSwitchLocked 并入即锁。
    expect(isSwitchLocked({ state: "ok", issues: [] })).toBe(false)
    expect(
      isSwitchLocked({ state: "degraded", issues: [{ kind: "archived-upstream", catalogId: "x", archivedAt: "d" }] }),
    ).toBe(false)
  })
})

describe("inventoryRowFor / inventoryInstallRow(AC5 同名并存的行选择)", () => {
  const mk = (scope: InventoryRow["scope"]): InventoryRow => ({
    id: "skill:helper",
    name: "helper",
    kind: "skill",
    scope,
    ownership: communityMcp,
    availability: { state: "installed", sources: { installed: true, bundled: false, catalog: true } },
    activation: "enabled",
    health: { state: "ok", issues: [] },
  })
  const view: ExtInventory = {
    catalogVersion: "v1",
    catalogChannel: "remote",
    rows: [mk("global"), mk("project"), { ...mk(null), id: "mcp:other" }],
    warnings: [],
  }

  test("同 id 多 scope:优先取已安装行(scope≠null)", () => {
    expect(inventoryRowFor(view, "skill:helper")?.scope).not.toBeNull()
  })

  test("global 与 project 同名各取各(单独操作)", () => {
    expect(inventoryInstallRow(view, "skill:helper", "global")?.scope).toBe("global")
    expect(inventoryInstallRow(view, "skill:helper", "project")?.scope).toBe("project")
  })

  test("无匹配 id → undefined(不兜底猜)", () => {
    expect(inventoryRowFor(view, "mcp:missing")).toBeUndefined()
    expect(inventoryRowFor(undefined, "skill:helper")).toBeUndefined()
  })
})
