import { describe, expect, test } from "bun:test"
import { patchPermissionDecisionTypes } from "./generate-alpha-sdk"

const generated = `export type PermissionV2DecisionCommand =
  | {
      decision: "once" | "reject"
      grantScope?: unknown
      grantExpiresAt?: unknown
    }
  | {
      decision: "always"
      grantScope: PermissionV2ProjectScope
      grantExpiresAt: null
    }

export type Next = string
`

describe("generate-alpha-sdk", () => {
  test("patches forbidden permission grant fields after upstream generation", () => {
    expect(patchPermissionDecisionTypes(generated)).toContain(
      'decision: "once" | "reject"\n      grantScope?: never\n      grantExpiresAt?: never',
    )
  })

  test("reproduces the committed generated permission type", async () => {
    const committed = await Bun.file(new URL("../packages/sdk/js/src/v2/gen/types.gen.ts", import.meta.url)).text()
    const upstreamShape = committed.replace(
      'decision: "once" | "reject"\n      grantScope?: never\n      grantExpiresAt?: never',
      'decision: "once" | "reject"\n      grantScope?: unknown\n      grantExpiresAt?: unknown',
    )

    expect(upstreamShape).not.toBe(committed)
    expect(patchPermissionDecisionTypes(upstreamShape)).toBe(committed)
  })

  test("fails loudly when generated permission types drift", () => {
    expect(() => patchPermissionDecisionTypes("export type Next = string\n")).toThrow(
      "Permission decision command type declaration was not generated",
    )
    expect(() => patchPermissionDecisionTypes(generated.replaceAll("unknown", "never"))).toThrow(
      "Permission decision forbidden grant field patch did not apply",
    )
  })
})
