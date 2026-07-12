// REQ-095(#187)JSON 模型:安全解析、原型键不作对象行为、节点/深度/字符串预算诚实截断。
import { describe, expect, test } from "bun:test"
import { parseJsonModel, JSON_MAX_NODES } from "./json-model"

describe("parseJsonModel", () => {
  test("对象/数组/标量完整成树", () => {
    const m = parseJsonModel(`{"a": 1, "b": [true, null, "x"], "c": {"d": 2.5}}`)
    expect(m.ok).toBe(true)
    if (!m.ok) return
    expect(m.root.kind).toBe("object")
    if (m.root.kind !== "object") return
    expect(m.root.count).toBe(3)
    const b = m.root.children[1]
    expect(b.kind === "array" && b.count === 3).toBe(true)
    expect(m.truncated).toBe(false)
  })
  test("解析失败 → 诚实错误(调用方回退 Source)", () => {
    const m = parseJsonModel("{oops")
    expect(m.ok).toBe(false)
  })
  test("__proto__/constructor 是普通自有键:出现在树里,且不污染原型", () => {
    const m = parseJsonModel(`{"__proto__": {"polluted": 1}, "constructor": {"x": 2}}`)
    expect(m.ok).toBe(true)
    if (!m.ok) return
    if (m.root.kind !== "object") throw new Error("expect object root")
    const keys = m.root.children.map((c) => c.key)
    expect(keys).toContain("__proto__")
    expect(keys).toContain("constructor")
    expect(({} as Record<string, unknown>).polluted).toBeUndefined()
  })
  test("字符串显示长度截断 + clipped 标记", () => {
    const m = parseJsonModel(JSON.stringify({ s: "x".repeat(500) }), { maxString: 50 })
    expect(m.ok).toBe(true)
    if (!m.ok || m.root.kind !== "object") return
    const s = m.root.children[0]
    expect(s.kind === "value" && s.clipped).toBe(true)
    expect(s.kind === "value" && s.display.length === 50).toBe(true)
  })
  test("节点预算:超限截断 + truncated 标记", () => {
    const arr = JSON.stringify(Array.from({ length: 100 }, (_, i) => i))
    const m = parseJsonModel(arr, { maxNodes: 10 })
    expect(m.ok).toBe(true)
    if (!m.ok) return
    expect(m.truncated).toBe(true)
    if (m.root.kind !== "array") throw new Error("expect array root")
    expect(m.root.truncatedChildren).toBe(true)
    expect(m.root.children.length).toBeLessThan(100)
    expect(m.root.count).toBe(100) // 真实计数仍诚实呈现
  })
  test("深度预算:超深折叠 + depthCut 标记", () => {
    let nested = `1`
    for (let i = 0; i < 20; i++) nested = `{"n": ${nested}}`
    const m = parseJsonModel(nested, { maxDepth: 3 })
    expect(m.ok).toBe(true)
    if (!m.ok) return
    let node = m.root
    let sawDepthCut = false
    while (node.kind === "object" && node.children.length > 0) {
      if (node.depthCut) {
        sawDepthCut = true
        break
      }
      node = node.children[0]
    }
    if (node.kind === "object" && node.depthCut) sawDepthCut = true
    expect(sawDepthCut).toBe(true)
  })
  test("默认预算常量可达(长数组不失控)", () => {
    const arr = JSON.stringify(Array.from({ length: JSON_MAX_NODES + 500 }, (_, i) => i))
    const m = parseJsonModel(arr)
    expect(m.ok).toBe(true)
    if (!m.ok) return
    expect(m.truncated).toBe(true)
    expect(m.nodeCount).toBeLessThanOrEqual(JSON_MAX_NODES)
  })
})
