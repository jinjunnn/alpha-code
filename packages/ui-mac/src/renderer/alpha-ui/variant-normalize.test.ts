import { describe, expect, test } from "bun:test"
import { normalizeVariant } from "./variant-normalize"

// REQ-041:引擎 variant 标签规范化 —— 英文(low/medium/high,如 deepseek 上游档)与中文(低/中/高)统一。
describe("normalizeVariant", () => {
  test("英文推理档 → 规范中文档(deepseek 类)", () => {
    expect(normalizeVariant("low")).toBe("低")
    expect(normalizeVariant("medium")).toBe("中")
    expect(normalizeVariant("high")).toBe("高")
    expect(normalizeVariant("max")).toBe("超高")
  })
  test("大小写 / 首尾空白容错", () => {
    expect(normalizeVariant("Low")).toBe("低")
    expect(normalizeVariant("  HIGH ")).toBe("高")
    expect(normalizeVariant("Medium")).toBe("中")
  })
  test("中文档 → 自身(alpha-models.json 配置的 3 模型不回归)", () => {
    expect(normalizeVariant("低")).toBe("低")
    expect(normalizeVariant("中")).toBe("中")
    expect(normalizeVariant("高")).toBe("高")
    expect(normalizeVariant("超高")).toBe("超高")
  })
  test("常见同义词", () => {
    expect(normalizeVariant("minimal")).toBe("低")
    expect(normalizeVariant("mid")).toBe("中")
    expect(normalizeVariant("xhigh")).toBe("超高")
  })
  test("无法识别 → undefined(调用方回退显示原文,不假装成默认档)", () => {
    expect(normalizeVariant("turbo")).toBeUndefined()
    expect(normalizeVariant("")).toBeUndefined()
    expect(normalizeVariant(undefined)).toBeUndefined()
  })
})
