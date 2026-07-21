import { expect, test } from "bun:test"
import type { PermissionV2DecisionCommand } from "../src/v2/gen/types.gen"

type OnceOrReject = Extract<PermissionV2DecisionCommand, { decision: "once" | "reject" }>

test("forbids grant fields on once and reject permission decisions", () => {
  const grantScopeForbidden: [OnceOrReject["grantScope"]] extends [undefined] ? true : false = true
  const grantExpiresAtForbidden: [OnceOrReject["grantExpiresAt"]] extends [undefined] ? true : false = true

  expect(grantScopeForbidden).toBe(true)
  expect(grantExpiresAtForbidden).toBe(true)
})
