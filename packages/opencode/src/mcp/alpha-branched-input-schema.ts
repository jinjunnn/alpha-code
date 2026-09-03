// alpha 自有(住在上游包目录里,`origin/dev` 从来没有过这条路径;basename `alpha-` 满足
// ADR-043 谓词的因子②)。north-star:alpha-owned
//
// `#793` 桌面半场:让**根上用 `oneOf`/`anyOf` 表达分支**的 MCP 工具,广播给模型的 schema 自洽。
//
// ── 缺陷 ────────────────────────────────────────────────────────────────────────
// 上游 `./catalog.ts` 的 `convertTool` 合成广播 schema 时无条件写死两件事:
//
//     properties: (mcpTool.inputSchema.properties ?? {}),
//     additionalProperties: false,
//
// JSON Schema 的 `additionalProperties` **只看它所在那一层的 `properties` /
// `patternProperties`**,看不见 `oneOf` / `anyOf` 分支里的字段。于是一个根上只有分支、
// 根上没有 properties 的工具,过了 `convertTool` 就变成:
//
//     根:不许出现任何字段        分支:每个都要求 5 个字段
//
// —— **没有任何对象能同时满足**。模型拿到这份自相矛盾的 schema,发 `{}` 是它的合理服从。
// 实测(2026-09-03,alpha-platform 生产广播的 `cloud_dispatch`
// `{type:"object",$schema,oneOf:[2 分支]}`,分支各 9 properties / 5 required):
//
//     现状 → 模型看到 topLevelProps=[]  additionalProperties=false  hasOneOf=2
//
// 这不是某一个工具的事:**任何**广播根级 `oneOf`/`anyOf` 的第三方 MCP 工具今天都被打成不可用。
//
// ── 修法只做一件事 ──────────────────────────────────────────────────────────────
// **根上有分支时,不给根戴 `additionalProperties: false`。** 收窄本身没有放弃 —— 它在分支里,
// 而分支被原样透传;根上那顶帽子结构上表达不了这层收窄(它看不见分支)。除此之外一个字节不动:
// 根上是普通 object 的工具(绝大多数 MCP 工具)走的还是上游那条路,`properties` +
// `additionalProperties:false` 的 fail-closed 初衷原样保留。
//
// 刻意**不做**的事(留在这里是为了让下一个人不必重新推一遍):
//   · **不把分支的 properties 并到根上再保留 `additionalProperties:false`。** 判别联合里
//     同名字段在不同分支下取不同的常量(`autonomy: {const:"pipeline"}` vs
//     `{const:"bounded-agent"}`),并集必须替它们决定谁赢 —— 那是替 JSON Schema 重写一遍
//     合并语义,而且会**新造**一个矛盾(根钉死 pipeline ⇒ bounded-agent 分支不可满足)。
//   · **不动 `properties` 那一行。** 根上有分支时它是 `{}`,而 `{}` 在没有
//     `additionalProperties:false` 作伴时不构成任何约束。
//
// 判据不在这段散文里:`test/tool/alpha-mcp-branched-schema.test.ts` 起真的 MCP server 广播
// 分支 schema、走真的 `SessionTools.resolve`,断言模型看到的那个对象。

import type { JSONSchema7 } from "ai"

function hasRootBranches(schema: JSONSchema7): boolean {
  for (const key of ["oneOf", "anyOf"] as const) {
    const branches = schema[key]
    if (Array.isArray(branches) && branches.length > 0) return true
  }
  return false
}

/**
 * 根上有 `oneOf`/`anyOf` 分支时,摘掉根上的 `additionalProperties: false`(它禁掉的正是分支
 * 要求的字段);其余形态原样返回**同一个对象引用**。
 */
export function repairBranchedRootSchema<T extends JSONSchema7>(schema: T): T {
  if (schema.additionalProperties !== false) return schema
  if (!hasRootBranches(schema)) return schema
  const { additionalProperties: _rootClosureCannotSeeBranches, ...open } = schema
  return open as T
}
