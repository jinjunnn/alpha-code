// north-star:alpha-owned — alpha 自有文件,住在上游包目录里。ADR-033 §5 B 类退回后的 SDK 侧判据。
// 这一行是 north-star 守卫的结构性谓词因子②(ADR-043);缺了它,对本文件的每一次修改都会被
// 当成上游改动而红。命名成 alpha-* 的文件不需要它。
import { expect, test } from "bun:test"
import type { PermissionV2DecisionCommand } from "../src/v2/gen/types.gen"

type OnceOrReject = Extract<PermissionV2DecisionCommand, { decision: "once" | "reject" }>

test("forbids grant fields on once and reject permission decisions", () => {
  const grantScopeForbidden: [OnceOrReject["grantScope"]] extends [undefined] ? true : false = true
  const grantExpiresAtForbidden: [OnceOrReject["grantExpiresAt"]] extends [undefined] ? true : false = true

  expect(grantScopeForbidden).toBe(true)
  expect(grantExpiresAtForbidden).toBe(true)
})
