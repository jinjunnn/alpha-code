import { describe, expect, test } from "bun:test"
import {
  clampRailWidth,
  RAIL_DEFAULT_WIDTH,
  RAIL_MAX_WIDTH,
  RAIL_MIN_WIDTH,
  readRailWidths,
  rememberRailWidth,
} from "./rail-width"

function memoryStorage(initial?: Record<string, string>) {
  const map = new Map(Object.entries(initial ?? {}))
  return {
    getItem: (key: string) => map.get(key) ?? null,
    setItem: (key: string, value: string) => void map.set(key, value),
  }
}

describe("REQ-125 C4 rail width memory", () => {
  test("clamps to the approved 320-560 contract and defaults on garbage", () => {
    expect(clampRailWidth(400)).toBe(400)
    expect(clampRailWidth(100)).toBe(RAIL_MIN_WIDTH)
    expect(clampRailWidth(9000)).toBe(RAIL_MAX_WIDTH)
    expect(clampRailWidth(455.6)).toBe(456)
    expect(clampRailWidth(undefined)).toBe(RAIL_DEFAULT_WIDTH)
    expect(clampRailWidth(Number.NaN)).toBe(RAIL_DEFAULT_WIDTH)
    expect(clampRailWidth(Number.POSITIVE_INFINITY)).toBe(RAIL_DEFAULT_WIDTH)
  })

  test("round-trips per-panel widths and re-validates on read", () => {
    const storage = memoryStorage()
    rememberRailWidth("review", 520, storage)
    rememberRailWidth("artifacts", 100, storage)
    expect(readRailWidths(storage)).toEqual({ review: 520, artifacts: RAIL_MIN_WIDTH })
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
