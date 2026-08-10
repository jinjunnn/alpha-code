import { describe, expect, test } from "bun:test"
import { patchPermissionDecisionTypes, removeDuplicateToolDisplayTypes } from "./generate-alpha-sdk"

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

  test("publishes the same optional display snapshot in both SDK surfaces", async () => {
    for (const path of ["../packages/sdk/js/src/gen/types.gen.ts", "../packages/sdk/js/src/v2/gen/types.gen.ts"]) {
      const generatedTypes = await Bun.file(new URL(path, import.meta.url)).text()
      expect(generatedTypes).toContain("export type ToolDisplaySnapshotV1 =")
      expect(generatedTypes).toContain("display?: ToolDisplaySnapshotV1")
    }
    const v2 = await Bun.file(new URL("../packages/sdk/js/src/v2/gen/types.gen.ts", import.meta.url)).text()
    expect(v2).not.toContain("ToolDisplaySnapshotV11")
    expect(v2).not.toContain("export type ToolPart1 =")
  })

  test("fails loudly when generated permission types drift", () => {
    expect(() => patchPermissionDecisionTypes("export type Next = string\n")).toThrow(
      "Permission decision command type declaration was not generated",
    )
    expect(() => patchPermissionDecisionTypes(generated.replaceAll("unknown", "never"))).toThrow(
      "Permission decision forbidden grant field patch did not apply",
    )
  })

  test("removes the unreachable duplicate tool display declarations", () => {
    const input = `export type ToolDisplaySnapshotV1 = { technicalId: string }

export type ToolDisplaySnapshotV11 = {
  technicalId: string
}

export type ToolPart1 = {
  display?: ToolDisplaySnapshotV11
}

export type SessionStatus2 = { type: "session.status" }
`
    expect(removeDuplicateToolDisplayTypes(input)).toBe(`export type ToolDisplaySnapshotV1 = { technicalId: string }

export type SessionStatus2 = { type: "session.status" }
`)
  })

  test("fails loudly when duplicate tool display generation drifts", () => {
    expect(() => removeDuplicateToolDisplayTypes("export type SessionStatus2 = {}\n")).toThrow(
      "Duplicate generated tool display declarations were not found",
    )
    expect(() =>
      removeDuplicateToolDisplayTypes(`export type ToolDisplaySnapshotV1 = {}

export type ToolDisplaySnapshotV11 = {}

export interface Unexpected { mustSurvive: true }

export type ToolPart1 = { display?: ToolDisplaySnapshotV11 }

export type SessionStatus2 = {}
`),
    ).toThrow("Duplicate generated tool display declarations contain an unexpected declaration")
  })
})
