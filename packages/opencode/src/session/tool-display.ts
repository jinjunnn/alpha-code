// north-star:alpha-owned — alpha 自有文件,住在上游包目录里。ADR-041 工具显示快照。
// 这一行是 north-star 守卫的结构性谓词因子②(ADR-043);缺了它,对本文件的每一次修改都会被
// 当成上游改动而红。命名成 alpha-* 的文件不需要它。
import type { Tool as AITool } from "ai"
import { parseToolDisplaySnapshot, type ToolDisplaySnapshotV1 } from "@opencode-ai/schema/tool-identity"

const displays = new WeakMap<AITool, ToolDisplaySnapshotV1>()

export function attachToolDisplay(tool: AITool, display: ToolDisplaySnapshotV1) {
  const frozen = structuredClone(parseToolDisplaySnapshot(display))
  displays.set(tool, frozen)
  return tool
}

export function getToolDisplay(tool: AITool) {
  const display = displays.get(tool)
  return display ? structuredClone(display) : undefined
}
