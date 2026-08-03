// REQ-128 Phase 4 `#809` —— **profile → child kind** 这一张表的闸(已批基线 §5 第 7 类)。
//
// 在它之前,同一件事被三处各写一遍三元,而三处都以 `else → "mcp"` 收尾。后果不是「少认一个
// profile」而是**认错**:一个只在合同侧登记、宿主表没跟上的 profile 会被静默当成 MCP 装进
// `alpha.jsonc` 的 `mcp` 段,卸载侧 fail-closed ⇒ **装得上、卸不掉**;而两个调用点上的
// `as "skill" | "agent" | "mcp"` 强转让编译器也看不见。
//
// **A+B 两条都要,缺一条都是假闸:**
//   · **只写 B(未登记即拒)不够** —— 一张把 `opencode-plugin` 错映成 `skill`、同时对未知
//     profile 默认拒绝的表,完全满足 B。
//   · **只写 A(四个都在表里)不够** —— 一个把 `else` 留在那里的实现对已登记的四个都对,
//     对第五个静默变 `mcp`。
//
// **期望集从 `PROFILE_REGISTRY_V1` 派生**(断言表的键集 == 注册表的 profileId 集),不写字面表:
// 否则就是「期望值恰好等于可硬编码的常量」。逐个 profile 的 kind 值仍是字面量 —— 那正是 A 要钉
// 的东西(覆盖率由注册表派生,映射本身由人声明)。
//
// 「各自路由到不同的具名 builder」的**行为半场**不在本文件:它在
// `package-plugin.wiring.test.ts`(一次真安装的计划里同时出现四个 builder 的特征 item)。
// 本文件只钉表本身。

import { describe, expect, test } from "bun:test"
import {
  assertPackageChildKindTableV1,
  isPackageChildKindV1,
  packageChildKindV1,
  packageChildPreviewKeyV1,
  packageChildTxKeyV1,
  PACKAGE_CHILD_KIND_PROFILE_IDS_V1,
} from "./ext-package-lifecycle"
import { PROFILE_REGISTRY_V1 } from "../shared/host-extension-package-contract/registry"

describe("package child kind 路由表 (#809 · 基线 §5 第 7 类)", () => {
  // ── A:全覆盖 ────────────────────────────────────────────────────────────────
  test("表的键集恰等于 PROFILE_REGISTRY_V1 的 profileId 集(期望值从注册表派生)", () => {
    const registered = PROFILE_REGISTRY_V1.map((profile) => profile.profileId).sort()
    expect(registered.length).toBeGreaterThanOrEqual(4) // 前提自检:注册表读空时不能静默通过
    expect(PACKAGE_CHILD_KIND_PROFILE_IDS_V1).toEqual(registered)
    // 运行期的第二道(同一判据落在生产模块里,不只活在测试里)。
    expect(() => assertPackageChildKindTableV1()).not.toThrow()
  })

  test("每一个已登记 profile 都路由到它自己的 kind(而不是全都落进 mcp)", () => {
    const routed = Object.fromEntries(
      PROFILE_REGISTRY_V1.map((profile) => {
        const outcome = packageChildKindV1(profile.profileId)
        expect(outcome.ok, profile.profileId).toBe(true)
        return [profile.profileId, outcome.ok ? outcome.kind : null]
      }),
    )
    expect(routed).toEqual({
      skill: "skill",
      agent: "agent",
      "mcp-local": "mcp",
      "mcp-remote": "mcp",
    })
    // ADR-040(`#830`):**没有任何 package profile 派生出 `plugin`**。这一条是那条裁决在这张表
    // 上的具名形式 —— 把 `opencode-plugin: "plugin"` 加回来,上面那条 exact-set 与这一条同时红。
    expect(Object.values(routed)).not.toContain("plugin")
  })

  test("四个 kind 各自派生出互不相同的事务 key 前缀(一个 kind 一个授权账/journal 位置)", () => {
    const keys = (["skill", "agent", "mcp", "plugin"] as const).map((kind) => packageChildTxKeyV1(kind, "x"))
    expect(new Set(keys).size).toBe(4)
    // plugin 的 key 与 seed 通道的逻辑主 item key 逐字相同 —— 两条通道清的是同一个授权账。
    expect(packageChildTxKeyV1("plugin", "opencode-notify")).toBe("plugin--opencode-notify")
  })

  // ── B:未登记即拒 ────────────────────────────────────────────────────────────
  test("未登记的第五个 profile 被具名拒绝,而不是静默变成 mcp", () => {
    // `opencode-plugin` 排第一位:ADR-040(`#830`)把它撤出注册表之后,它就是一个**未登记**的
    // profile,必须走具名拒绝那一支。把它悄悄加回表里,这一条红。
    for (const unknown of ["opencode-plugin", "opencode-tui-plugin", "cloud", "bundle", "", "MCP-LOCAL"]) {
      const outcome = packageChildKindV1(unknown)
      expect(outcome.ok, unknown).toBe(false)
      if (!outcome.ok) {
        expect(outcome.reason).toContain(JSON.stringify(unknown).slice(1, -1) || "")
        expect(outcome.reason).toContain("fail closed")
      }
    }
  })

  test("原型链上的名字不算登记(`toString` / `constructor` 不得被当成 profile)", () => {
    for (const inherited of ["toString", "constructor", "hasOwnProperty", "__proto__"]) {
      const outcome = packageChildKindV1(inherited)
      expect(outcome.ok, inherited).toBe(false)
    }
  })

  // ── 预览 key:账本图里的 kind 比 package 通道宽,不许强转回一个真实 kind ────────
  test("账本图里出现 package 通道装不出来的 kind ⇒ 预览 key 不得与任何真实 tx key 相撞", () => {
    // 此前这里是 `packageChildTxKeyV1(node.kind as "skill"|"agent"|"mcp", …)`:`command:foo`
    // 会被强转成 `mcp--foo`,与一个**真实 MCP child** 的授权账 key 逐字相同 ⇒ 预览行上显示
    // 的是别人的 capability。
    expect(packageChildPreviewKeyV1("command", "foo")).not.toBe(packageChildTxKeyV1("mcp", "foo"))
    expect(packageChildPreviewKeyV1("bundle", "foo")).not.toBe(packageChildTxKeyV1("mcp", "foo"))
    expect(packageChildPreviewKeyV1("cloud", "foo")).not.toBe(packageChildTxKeyV1("mcp", "foo"))
    // 四个真实 kind 仍然逐字走同一个派生 —— 预览与事务/授权账必须是同一个 key。
    for (const kind of ["skill", "agent", "mcp", "plugin"] as const)
      expect(packageChildPreviewKeyV1(kind, "foo")).toBe(packageChildTxKeyV1(kind, "foo"))
  })

  test("isPackageChildKindV1 恰认这四个", () => {
    for (const kind of ["skill", "agent", "mcp", "plugin"]) expect(isPackageChildKindV1(kind)).toBe(true)
    for (const kind of ["command", "bundle", "cloud", "", "Plugin"]) expect(isPackageChildKindV1(kind)).toBe(false)
  })
})
