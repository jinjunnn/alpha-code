// B3 cloud-run 回流 watcher 的纯解析核(renderer,无 DOM/无 SDK 依赖,可单测)。
// 输入 = /global/event firehose 信封;命中条件 = message.part.updated 里的**第一方 cloud
// facade** tool part(#934:准入 = 持久化 identity (mcp, "cloud"),与时间线产物行同一枚
// 铸币,见 cloud-facade-identity.ts;`cloud_` 别名前缀不再参与 —— 它由第三方完全控制,
// opencode mcp/catalog.ts:119 / tool/registry.ts:195)到达 completed 帧且 output 中的
// 云任务状态是终态(completed/failed/cancelled)。
// dispatch 帧(queued/running)不动作;终态判定以 cloud_await / cloud_status 的 output 为准。

import { isCloudFacadeToolPart } from "./cloud-facade-identity"

export type CloudRunTerminal = "completed" | "failed" | "cancelled"

export type CloudRunHit = {
  /** firehose 信封目录(会话所在目录;调用方负责映射到项目 worktree)。 */
  directory: string
  runId: string
  terminal: CloudRunTerminal
}

const TERMINAL = new Set<string>(["completed", "failed", "cancelled"])

/** tool output 可能是纯 JSON,也可能是带包裹文本的 JSON —— 先整体 parse,失败退回字段正则。 */
export function parseRunFromOutput(output: string): { runId: string; terminal: CloudRunTerminal } | null {
  let jobId: unknown
  let status: unknown
  try {
    const obj = JSON.parse(output)
    if (obj && typeof obj === "object") {
      jobId = (obj as Record<string, unknown>).job_id
      status = (obj as Record<string, unknown>).status
    }
  } catch {
    jobId = /"job_id"\s*:\s*"([^"]+)"/.exec(output)?.[1]
    status = /"status"\s*:\s*"(completed|failed|cancelled|queued|running|blocked)"/.exec(output)?.[1]
  }
  if (typeof jobId !== "string" || !jobId) return null
  if (typeof status !== "string" || !TERMINAL.has(status)) return null
  return { runId: jobId, terminal: status as CloudRunTerminal }
}

export function extractCloudRunHit(event: unknown): CloudRunHit | null {
  const e = event as { directory?: unknown; payload?: { type?: unknown; properties?: { part?: unknown } } } | null
  if (!e || typeof e.directory !== "string" || !e.directory) return null
  if (e.payload?.type !== "message.part.updated") return null
  const part = e.payload.properties?.part as
    | { type?: unknown; state?: { status?: unknown; output?: unknown } }
    | undefined
  if (!part || part.type !== "tool") return null
  // #934:发现云任务的准入从 `cloud_` 别名前缀改为持久化 identity(与产物行同一枚铸币)。
  // 冒名 `cloud_x` 的 plugin/MCP 工具不再驱动 run-watcher;快照缺失 fail-closed 不命中。
  if (!isCloudFacadeToolPart(part)) return null
  if (part.state?.status !== "completed") return null
  if (typeof part.state.output !== "string") return null
  const run = parseRunFromOutput(part.state.output)
  if (!run) return null
  return { directory: e.directory, ...run }
}
