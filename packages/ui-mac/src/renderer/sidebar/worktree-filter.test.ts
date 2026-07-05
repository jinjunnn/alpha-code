// B4 数据层过滤谓词单测(S17 T5)。
import { describe, expect, test } from "bun:test"
import { isUnderSkippedWorktree, shouldSkipWorktree } from "./worktree-filter"

const none = new Set<string>()

describe("shouldSkipWorktree", () => {
  test('"/" 全局桶恒剔除', () => {
    expect(shouldSkipWorktree("/", none)).toBe(true)
  })
  test("macOS home 根 exact 剔除(含尾斜杠)", () => {
    expect(shouldSkipWorktree("/Users/tide", none)).toBe(true)
    expect(shouldSkipWorktree("/Users/tide/", none)).toBe(true)
  })
  test("home 子目录是正常项目,不剔除", () => {
    expect(shouldSkipWorktree("/Users/tide/app/alpha-code", none)).toBe(false)
    expect(shouldSkipWorktree("/Users/tide/Documents", none)).toBe(false) // Documents 级不自动剔(设计)
  })
  test("非 /Users 前缀路径不误伤", () => {
    expect(shouldSkipWorktree("/opt/work", none)).toBe(false)
    expect(shouldSkipWorktree("/private/tmp/x", none)).toBe(false)
  })
  test("hidden exact 剔除;子目录不 exact 匹配", () => {
    const hidden = new Set(["/Users/tide/Documents"])
    expect(shouldSkipWorktree("/Users/tide/Documents", hidden)).toBe(true)
    expect(shouldSkipWorktree("/Users/tide/Documents/proj", hidden)).toBe(false)
  })
})

describe("isUnderSkippedWorktree(会话事件守卫)", () => {
  test("undefined → false", () => {
    expect(isUnderSkippedWorktree(undefined, none)).toBe(false)
  })
  test("home 本身命中(经 exact 语义)", () => {
    expect(isUnderSkippedWorktree("/Users/tide", none)).toBe(true)
  })
  test("hidden worktree 的子目录按前缀命中(防 loadProjects 循环)", () => {
    const hidden = new Set(["/Users/tide/Documents"])
    expect(isUnderSkippedWorktree("/Users/tide/Documents/sub/deep", hidden)).toBe(true)
  })
  test('hidden 含 "/" 时不作前缀吞并', () => {
    const hidden = new Set(["/"])
    expect(isUnderSkippedWorktree("/Users/tide/app/x", hidden)).toBe(false)
  })
  test("hidden 尾斜杠形态同样前缀命中", () => {
    const hidden = new Set(["/Users/tide/Documents/"])
    expect(isUnderSkippedWorktree("/Users/tide/Documents/sub", hidden)).toBe(true)
  })
  test("无关目录不命中", () => {
    const hidden = new Set(["/Users/tide/Documents"])
    expect(isUnderSkippedWorktree("/Users/tide/app/alpha-code", hidden)).toBe(false)
  })
})
