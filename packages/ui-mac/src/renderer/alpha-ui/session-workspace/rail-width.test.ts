import { describe, expect, test } from "bun:test"
import { clampRailWidth, railMaxWidth, readRailWidths, rememberRailWidth } from "./rail-width"

// REQ-140 anchors are the values owner approved in docs/design/2026-08-28-req140-rail-width
// (floor 320, session column 480, ceiling = workspace − 480), written here as independent
// literals. Importing the production constants instead would make this file self-referential:
// the pre-REQ-140 version asserted `clampRailWidth(9000) === RAIL_MAX_WIDTH`, which stayed green
// for every possible ceiling.

function memoryStorage(initial?: Record<string, string>) {
  const map = new Map(Object.entries(initial ?? {}))
  return {
    getItem: (key: string) => map.get(key) ?? null,
    setItem: (key: string, value: string) => void map.set(key, value),
  }
}

describe("REQ-140 rail width contract", () => {
  test("an unmeasured workspace clamps the 320 floor only — there is no fixed ceiling", () => {
    expect(clampRailWidth(400)).toBe(400)
    expect(clampRailWidth(100)).toBe(320)
    expect(clampRailWidth(319)).toBe(320)
    // The old contract capped this at 560; REQ-140 removed the fixed ceiling entirely.
    expect(clampRailWidth(9000)).toBe(9000)
    expect(clampRailWidth(561)).toBe(561)
    expect(clampRailWidth(455.6)).toBe(456)
    expect(clampRailWidth(undefined)).toBe(400)
    expect(clampRailWidth(Number.NaN)).toBe(400)
    expect(clampRailWidth(Number.POSITIVE_INFINITY)).toBe(400)
    expect(railMaxWidth(undefined)).toBeUndefined()
    expect(railMaxWidth(0)).toBeUndefined()
    expect(railMaxWidth(Number.NaN)).toBeUndefined()
  })

  test("a measured workspace caps the rail at workspace − 480, in instance values", () => {
    // 1280px window minus the 256px project sidebar = 1024px workspace.
    expect(railMaxWidth(1024)).toBe(544)
    expect(clampRailWidth(9000, 1024)).toBe(544)
    expect(railMaxWidth(1200)).toBe(720)
    expect(clampRailWidth(9000, 1200)).toBe(720)
    expect(railMaxWidth(2304)).toBe(1824)
    expect(clampRailWidth(9000, 2304)).toBe(1824)
    // Under the ceiling the user's width is untouched.
    expect(clampRailWidth(700, 1200)).toBe(700)
  })

  test("below an 800px workspace the 320 floor wins and the session column takes the remainder", () => {
    expect(railMaxWidth(800)).toBe(320)
    expect(clampRailWidth(9000, 800)).toBe(320)
    expect(railMaxWidth(760)).toBe(320)
    expect(clampRailWidth(9000, 760)).toBe(320)
    expect(clampRailWidth(400, 760)).toBe(320)
    expect(clampRailWidth(420, 500)).toBe(320)
  })

  test("a narrow window never rewrites the remembered width — the storage clamp has no ceiling", () => {
    const storage = memoryStorage()
    rememberRailWidth("review", 900, storage)
    expect(readRailWidths(storage)).toEqual({ review: 900 })
    // Displayed at a 760px workspace the rail shows 320; widening back to 1500 restores 900.
    expect(clampRailWidth(readRailWidths(storage).review, 760)).toBe(320)
    expect(clampRailWidth(readRailWidths(storage).review, 1500)).toBe(900)
  })

  test("round-trips per-panel widths and re-validates on read", () => {
    const storage = memoryStorage()
    rememberRailWidth("review", 520, storage)
    rememberRailWidth("artifacts", 100, storage)
    expect(readRailWidths(storage)).toEqual({ review: 520, artifacts: 320 })
  })

  test("hostile or corrupt storage yields an empty map, never a throw", () => {
    expect(readRailWidths(memoryStorage({ "alpha-session-rail-widths-v1": "not json" }))).toEqual({})
    expect(readRailWidths(memoryStorage({ "alpha-session-rail-widths-v1": '["array"]' }))).toEqual({})
    expect(
      readRailWidths(memoryStorage({ "alpha-session-rail-widths-v1": '{"review":"wide","files":420}' })),
    ).toEqual({ files: 420 })
    expect(readRailWidths(null)).toEqual({})
    const throwing = {
      getItem: () => {
        throw new Error("denied")
      },
      setItem: () => {
        throw new Error("denied")
      },
    }
    expect(readRailWidths(throwing)).toEqual({})
    expect(() => rememberRailWidth("review", 400, throwing)).not.toThrow()
  })
})
