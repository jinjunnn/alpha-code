import { describe, expect, test } from "bun:test"
import { parseSpikeFlag } from "./spike-flag"

describe("REQ-087 spike flag(永不默认启用)", () => {
  test("只认显式 opt-in 值", () => {
    expect(parseSpikeFlag("1")).toBe(true)
    expect(parseSpikeFlag("true")).toBe(true)
  })

  test("其余一律 off —— 默认关是原型纪律的红线", () => {
    expect(parseSpikeFlag(null)).toBe(false)
    expect(parseSpikeFlag(undefined)).toBe(false)
    expect(parseSpikeFlag("")).toBe(false)
    expect(parseSpikeFlag("0")).toBe(false)
    expect(parseSpikeFlag("yes")).toBe(false)
    expect(parseSpikeFlag("TRUE")).toBe(false)
  })
})
