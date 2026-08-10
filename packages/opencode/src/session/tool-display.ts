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
