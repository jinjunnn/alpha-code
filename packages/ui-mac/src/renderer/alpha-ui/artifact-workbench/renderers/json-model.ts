// JSON 安全模型 — REQ-095(#187)。纯逻辑、零依赖,bun:test 可全测。
// 原则:
//   · JSON.parse 安全解析("__proto__"/"constructor" 只是普通自有键 —— 遍历用 Object.entries,
//     不沿原型链解释,REQ-095 §3「不解释原型键为对象行为」);
//   · 节点/深度/字符串显示长度预算:超限截断 + 诚实标记,绝不整棵摊平进 DOM;
//   · 解析失败 → 诚实错误(调用方回退 Source 视图),不半解析。

export type JsonNode =
  | { kind: "value"; key: string | null; display: string; vtype: "string" | "number" | "boolean" | "null"; clipped: boolean }
  | { kind: "object" | "array"; key: string | null; count: number; children: JsonNode[]; truncatedChildren: boolean; depthCut: boolean }

export type JsonModel =
  | { ok: true; root: JsonNode; nodeCount: number; truncated: boolean }
  | { ok: false; error: string }

export const JSON_MAX_NODES = 2000
export const JSON_MAX_DEPTH = 12
export const JSON_MAX_STRING = 200

type Budget = { nodes: number; truncated: boolean }

function displayOf(v: string | number | boolean | null, maxString: number): { display: string; vtype: "string" | "number" | "boolean" | "null"; clipped: boolean } {
  if (v === null) return { display: "null", vtype: "null", clipped: false }
  if (typeof v === "boolean") return { display: v ? "true" : "false", vtype: "boolean", clipped: false }
  if (typeof v === "number") return { display: String(v), vtype: "number", clipped: false }
  const clipped = v.length > maxString
  return { display: clipped ? v.slice(0, maxString) : v, vtype: "string", clipped }
}

function nodeOf(key: string | null, value: unknown, depth: number, budget: Budget, maxDepth: number, maxString: number): JsonNode {
  budget.nodes -= 1
  if (Array.isArray(value)) {
    if (depth >= maxDepth)
      return { kind: "array", key, count: value.length, children: [], truncatedChildren: value.length > 0, depthCut: true }
    const children: JsonNode[] = []
    let truncatedChildren = false
    for (let i = 0; i < value.length; i++) {
      if (budget.nodes <= 0) {
        truncatedChildren = true
        budget.truncated = true
        break
      }
      children.push(nodeOf(String(i), value[i], depth + 1, budget, maxDepth, maxString))
    }
    return { kind: "array", key, count: value.length, children, truncatedChildren, depthCut: false }
  }
  if (value !== null && typeof value === "object") {
    // Object.entries = 仅自有可枚举键;"__proto__" 在 JSON.parse 产物上就是普通自有键。
    const entries = Object.entries(value as Record<string, unknown>)
    if (depth >= maxDepth)
      return { kind: "object", key, count: entries.length, children: [], truncatedChildren: entries.length > 0, depthCut: true }
    const children: JsonNode[] = []
    let truncatedChildren = false
    for (const [k, v] of entries) {
      if (budget.nodes <= 0) {
        truncatedChildren = true
        budget.truncated = true
        break
      }
      children.push(nodeOf(k, v, depth + 1, budget, maxDepth, maxString))
    }
    return { kind: "object", key, count: entries.length, children, truncatedChildren, depthCut: false }
  }
  const d = displayOf(value as string | number | boolean | null, maxString)
  return { kind: "value", key, ...d }
}

export function parseJsonModel(
  text: string,
  opts?: { maxNodes?: number; maxDepth?: number; maxString?: number },
): JsonModel {
  const maxNodes = Math.max(1, opts?.maxNodes ?? JSON_MAX_NODES)
  const maxDepth = Math.max(1, opts?.maxDepth ?? JSON_MAX_DEPTH)
  const maxString = Math.max(8, opts?.maxString ?? JSON_MAX_STRING)
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : "invalid JSON" }
  }
  const budget: Budget = { nodes: maxNodes, truncated: false }
  const root = nodeOf(null, parsed, 0, budget, maxDepth, maxString)
  const used = maxNodes - budget.nodes
  return { ok: true, root, nodeCount: used, truncated: budget.truncated || budget.nodes <= 0 }
}
