// REQ-104 #395 —— fresh-intake 初始启用分类器单测:目录来源矩阵(alpha 开/official·community·
// 缺省 关)、非目录 intake 恒开、既有记录当前策略优先(nextDesiredState)。真盘临时账本,零 mock。
import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import * as fs from "node:fs"
import * as os from "node:os"
import * as path from "node:path"
import { initialDesiredState, nextDesiredState } from "./ext-install-policy"
import { upsertRecordV2 } from "./ext-receipt-v2"

let root: string
beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "ext-policy-"))
})
afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true })
})

describe("initialDesiredState(#394 裁决 + v5 Q1)", () => {
  test("目录来源矩阵:alpha 默认开;official/community/缺省一律默认关(官方出品 ≠ 我们审过)", () => {
    expect(initialDesiredState({ origin: "catalog", source: "alpha" })).toBe("enabled")
    expect(initialDesiredState({ origin: "catalog", source: "official" })).toBe("disabled")
    expect(initialDesiredState({ origin: "catalog", source: "community" })).toBe("disabled")
    expect(initialDesiredState({ origin: "catalog" })).toBe("disabled")
  })

  test("非目录 intake(用户显式导入/创建)恒开 —— 不属「第三方非默认启用」面", () => {
    for (const origin of ["imported", "created", "imported-claude", "imported-agents"]) {
      expect(initialDesiredState({ origin })).toBe("enabled")
    }
  })
})

describe("nextDesiredState(存量当前策略优先)", () => {
  test("无记录 = fresh 分类;有记录 = 保留当前状态(更新/重装绝不翻用户手动设过的状态)", () => {
    expect(nextDesiredState(root, "skill", "demo", { origin: "catalog", source: "official" })).toBe("disabled")
    const w = upsertRecordV2(root, {
      id: "skill:demo",
      name: "demo",
      kind: "skill",
      environment: "prod",
      scope: { kind: "global" },
      desiredState: "enabled",
      origin: "catalog",
      installedAt: "2026-07-17T00:00:00.000Z",
    })
    expect(w.ok).toBe(true)
    // official 来源但用户已有 enabled 记录 → 更新保持 enabled(不被分类器翻关)。
    expect(nextDesiredState(root, "skill", "demo", { origin: "catalog", source: "official" })).toBe("enabled")
  })
})

describe("#397 activationPolicy 声明优先序(Codex 裁决钉死)", () => {
  test("规则 1:有效声明 > 来源分类 —— default-enabled 开(即使 official);default-disabled 关(即使 alpha)", () => {
    expect(initialDesiredState({ origin: "catalog", source: "official", activationPolicy: "default-enabled" })).toBe("enabled")
    expect(initialDesiredState({ origin: "catalog", source: "alpha", activationPolicy: "default-disabled" })).toBe("disabled")
  })

  test("session-grant → 持久账本恒 disabled(会话级启用 = #408)", () => {
    expect(initialDesiredState({ origin: "catalog", source: "official", activationPolicy: "session-grant" })).toBe("disabled")
  })

  test("复审过期(排他截止):fresh install 一律先落 disabled,即使 default-enabled", () => {
    expect(initialDesiredState({ origin: "catalog", source: "alpha", activationPolicy: "default-enabled", reviewExpired: true })).toBe("disabled")
    expect(initialDesiredState({ origin: "catalog", source: "official", activationPolicy: "default-disabled", reviewExpired: true })).toBe("disabled")
  })

  test("声明优先于 cloud 例外;无声明时 cloud 例外与 #395 面逐字不变", () => {
    expect(initialDesiredState({ origin: "catalog", source: "official", kind: "cloud", activationPolicy: "default-disabled" })).toBe("disabled")
    expect(initialDesiredState({ origin: "catalog", source: "official", kind: "cloud" })).toBe("enabled")
  })

  test("声明只对 origin=catalog 生效(非目录 intake 不进合同面)", () => {
    expect(initialDesiredState({ origin: "imported", activationPolicy: "session-grant" })).toBe("enabled")
  })

  test("规则 3/4:prior 只对 default-enabled/default-disabled(与未策展面)保留;session-grant 不被 prior 保留", () => {
    const w = upsertRecordV2(root, {
      id: "mcp:labs-x",
      name: "labs-x",
      kind: "mcp",
      environment: "prod",
      scope: { kind: "global" },
      desiredState: "enabled", // 非法存量(session-grant 不该持久 enabled)—— 重分类必须压回 disabled
      origin: "catalog",
      installedAt: "2026-07-17T00:00:00.000Z",
    })
    expect(w.ok).toBe(true)
    expect(nextDesiredState(root, "mcp", "labs-x", { origin: "catalog", source: "official", activationPolicy: "session-grant" })).toBe("disabled")
    // 同一记录若声明是 default-disabled → prior enabled 保留(存量不回溯)。
    expect(nextDesiredState(root, "mcp", "labs-x", { origin: "catalog", source: "official", activationPolicy: "default-disabled" })).toBe("enabled")
  })
})
