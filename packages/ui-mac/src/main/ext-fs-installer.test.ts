// Unit tests for the skill/agent file installer's path-escape guards (ADR-014 §8). Everything must be
// confined to ~/.config/opencode — no `..`, no unsafe names, no asset keys that escape resources/.
// The module imports electron (`app`), only touched inside resourcesRoot(); we stub it so the pure
// name/asset validation (which runs first) is testable off-device.
//
// NOTE: writeSkill/writeAgent's WRITE target is os.homedir()/.config/opencode, which is NOT
// env-redirectable under bun (os.homedir() ignores a runtime $HOME change) — so we deliberately only
// exercise the rejection paths here, which return before any disk I/O. Covering a real write would
// pollute the developer's actual config; that path is left to integration.

import { describe, expect, mock, test } from "bun:test"

mock.module("electron", () => ({ app: { isPackaged: false } }))

const { installBuiltinSkill, writeAgent, writeSkill } = await import("./ext-fs-installer")

describe("writeSkill / writeAgent — name validation blocks traversal (no disk I/O on reject)", () => {
  test.each([["../../etc/passwd"], ["a/b"], [""], ["../evil"], [".hidden"]])(
    "writeSkill rejects unsafe name %p",
    (name) => {
      expect(writeSkill(name, "d", "b")).toEqual({ ok: false, reason: "invalid skill name" })
    },
  )

  test.each([["../../etc/passwd"], ["a/b"], [""]])("writeAgent rejects unsafe name %p", (name) => {
    expect(writeAgent(name, "content")).toEqual({ ok: false, reason: "invalid agent name" })
  })
})

describe("installBuiltinSkill — name + asset-key guards", () => {
  test("rejects unsafe skill name before touching resources", () => {
    expect(installBuiltinSkill("skills/valid", "../evil")).toEqual({ ok: false, reason: "invalid skill name" })
  })

  test.each([["../secrets"], ["skills/../../x"], ["plugins/x"], ["skills/a/b"], ["notskills/x"]])(
    "rejects asset key outside resources/skills %p",
    (key) => {
      expect(installBuiltinSkill(key, "good")).toEqual({ ok: false, reason: "invalid asset key" })
    },
  )

  test("honest failure when the (well-formed) asset isn't bundled in this build", () => {
    const r = installBuiltinSkill("skills/definitely-not-bundled", "good")
    expect(r.ok).toBe(false)
    expect((r as any).reason).toContain("未随此版本打包")
  })
})
