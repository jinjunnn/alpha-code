// B3 cloud-run 回流 watcher 的纯解析核(renderer,无 DOM/无 SDK 依赖,可单测)。
// 输入 = /global/event firehose 信封;命中条件 = message.part.updated 里的**第一方 cloud
// facade** tool part(#934:准入 = 持久化 identity (mcp, "cloud"),与时间线产物行同一枚
// 铸币,见 cloud-facade-identity.ts;`cloud_` 别名前缀不再参与 —— 它由第三方完全控制,
// opencode mcp/catalog.ts:119 / tool/registry.ts:195)到达 completed 帧,且:
//   · source "dispatch" —— 远端名 `cloud_dispatch`、output 是已受理回执(CloudJobAcceptedV1:queued + job_id)。
//     REQ-236 #1551:受理即交给宿主跟踪,模型之后等不等都一样落盘;这是**唯一**能记下发起会话的来源;
//   · source "status" —— 任一 facade 调用(cloud_await / cloud_status …)的 output 已是终态。只触发交付,不带归属。

import { isCloudFacadeToolPart } from "./cloud-facade-identity"
import type { CloudRunState } from "../../preload/types"

export type CloudRunTerminal = "completed" | "failed" | "cancelled"

export type CloudRunHit = {
  /** firehose 信封目录(会话所在目录;调用方负责映射到项目 worktree)。 */
  directory: string
  runId: string
  source: "dispatch" | "status"
  sessionID?: string
  messageID?: string
  partID?: string
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

/** 已受理的 dispatch 回执(CloudJobAcceptedV1:schema_version 1、status queued、job_id)→ job_id;其它 → null。 */
export function parseAcceptedDispatch(output: string): string | null {
  let accepted: unknown
  try {
    accepted = JSON.parse(output)
  } catch {
    return null
  }
  if (!accepted || typeof accepted !== "object") return null
  const record = accepted as Record<string, unknown>
  if (record.schema_version !== 1 || record.status !== "queued") return null
  return typeof record.job_id === "string" && record.job_id ? record.job_id : null
}

export function extractCloudRunHit(event: unknown): CloudRunHit | null {
  const e = event as { directory?: unknown; payload?: { type?: unknown; properties?: { part?: unknown } } } | null
  if (!e || typeof e.directory !== "string" || !e.directory) return null
  if (e.payload?.type !== "message.part.updated") return null
  const part = e.payload.properties?.part as
    | {
        type?: unknown
        id?: unknown
        sessionID?: unknown
        messageID?: unknown
        display?: { identity?: { name?: unknown } }
        state?: { status?: unknown; output?: unknown }
      }
    | undefined
  if (!part || part.type !== "tool") return null
  // #934:发现云任务的准入从 `cloud_` 别名前缀改为持久化 identity(与产物行同一枚铸币)。
  // 冒名 `cloud_x` 的 plugin/MCP 工具不再驱动 run-watcher;快照缺失 fail-closed 不命中。
  if (!isCloudFacadeToolPart(part)) return null
  if (part.state?.status !== "completed") return null
  if (typeof part.state.output !== "string") return null
  const ids = {
    ...(typeof part.sessionID === "string" && part.sessionID ? { sessionID: part.sessionID } : {}),
    ...(typeof part.messageID === "string" && part.messageID ? { messageID: part.messageID } : {}),
    ...(typeof part.id === "string" && part.id ? { partID: part.id } : {}),
  }
  if (part.display?.identity?.name === "cloud_dispatch") {
    const runId = parseAcceptedDispatch(part.state.output)
    return runId ? { directory: e.directory, runId, source: "dispatch", ...ids } : null
  }
  const run = parseRunFromOutput(part.state.output)
  if (!run) return null
  return { directory: e.directory, runId: run.runId, source: "status", ...ids }
}

/**
 * 交付落定时该弹的提示(#1551 AC2):只在 saved / failed 时弹;交付失败绝不说「已回流 / 已保存」。
 * key 是 i18n 键,detail 不含路径之外的任何本地信息。
 */
export function runStateToast(state: CloudRunState): {
  kind: "success" | "info" | "error"
  key: "alpha.cloud.runSaved" | "alpha.cloud.runEnded" | "alpha.cloud.runSaveFailed"
  detail: string
} | null {
  if (state.delivery.status === "failed")
    return {
      kind: "error",
      key: "alpha.cloud.runSaveFailed",
      detail: `${state.runId}: ${state.delivery.failure?.code ?? "unknown"}`,
    }
  if (state.delivery.status !== "saved") return null
  if (state.job.status === "completed")
    return { kind: "success", key: "alpha.cloud.runSaved", detail: state.runId }
  return { kind: "info", key: "alpha.cloud.runEnded", detail: state.runId }
}
