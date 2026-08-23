// north-star:alpha-owned — alpha 自有文件,住在上游包目录里。ADR-033 收编时从 schema/agent.ts 抽出的 AgentID。
// 这一行是 north-star 守卫的结构性谓词因子②(ADR-043);缺了它,对本文件的每一次修改都会被
// 当成上游改动而红。命名成 alpha-* 的文件不需要它。
import { Schema } from "effect"

export const AgentID = Schema.String.pipe(Schema.brand("AgentV2.ID"))
export type AgentID = typeof AgentID.Type
