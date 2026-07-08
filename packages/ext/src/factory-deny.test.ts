// REQ-067 — 出厂默认禁项内存注入(permission.skill deny + 键入兜底占位;零明文)。

import { describe, expect, test } from "bun:test"
import { applyFactoryDeny } from "./factory-deny"

const ENV = JSON.stringify(["customize-opencode"])

describe("applyFactoryDeny — env → cfg 内存注入", () => {
  test("注入 permission.skill deny + 占位 command", () => {
    const cfg: Record<string, unknown> = {}
    expect(applyFactoryDeny(cfg, ENV)).toEqual(["customize-opencode"])
    expect((cfg.permission as any).skill["customize-opencode"]).toBe("deny")
    expect((cfg.command as any)["customize-opencode"].description).toContain("已禁用")
    expect((cfg.command as any)["customize-opencode"].template).toContain("/customize-alpha")
  })
  test("set-if-absent:用户任何层已配同名键 → 让位(权限与占位各自独立判)", () => {
    const cfg: Record<string, unknown> = {
      permission: { skill: { "customize-opencode": "allow" } },
      command: { "customize-opencode": { template: "user's own" } },
    }
    expect(applyFactoryDeny(cfg, ENV)).toEqual([])
    expect((cfg.permission as any).skill["customize-opencode"]).toBe("allow")
    expect((cfg.command as any)["customize-opencode"].template).toBe("user's own")
  })
  test("既有 permission 兄弟键保留;env 缺失/空/坏 JSON 安全 no-op", () => {
    const cfg: Record<string, unknown> = { permission: { bash: "ask" } }
    applyFactoryDeny(cfg, ENV)
    expect((cfg.permission as any).bash).toBe("ask")
    const c2: Record<string, unknown> = {}
    expect(applyFactoryDeny(c2, undefined)).toEqual([])
    expect(applyFactoryDeny(c2, "[]")).toEqual([])
    expect(applyFactoryDeny(c2, "{bad")).toEqual([])
    expect(c2.permission).toBeUndefined()
  })
})
