// REQ-131 / #1130 —— main 侧对引擎 tool policy 面的客户端(Settings「工具」节的唯一数据通道)。
//
// 为什么走 main 而不是 renderer 直连引擎:与 settings-ipc / automation-llm 同一形态 —— sidecar 的
// 地址与 Basic 凭据住在 main 的 serverReady Deferred 里,renderer 只拿到闭集结果码,不拿引擎原文。
//
// 为什么不经生成的 SDK(`@opencode-ai/sdk/v2/client`):本仓自 #433 起未再重生 sdk.gen / openapi.json
// (`git log -- packages/sdk/js/src/v2/gen/sdk.gen.ts`),重生要跑 `bun dev generate` ⇒ 撞 models.dev 网络
// 陷阱且会带出一大片与本票无关的生成物漂移。四条路由形状固定,这里按 protocol 组的定义直接 fetch,
// 并在 main 侧再 decode 一次 wire 契约(`parseToolPolicyInventory`)—— 与引擎侧 decode 同一份 schema,
// 不手写第二份形状判据。
import { parseToolPolicyInventory } from "@opencode-ai/schema/alpha-tool-inventory"
import type {
  ToolPolicyApi,
  ToolPolicyInventoryResult,
  ToolPolicyResetResult,
  ToolPolicyWriteResult,
} from "../shared/tool-policy-wire"

export type ToolPolicyServerInfo = {
  url: string
  username: string | null
  password: string | null
}

export type ToolPolicyClientDeps = {
  awaitServer: () => Promise<ToolPolicyServerInfo>
  fetch?: typeof fetch
  /** 单次请求上限;inventory 要枚举 live registry + MCP,给足但不无限。 */
  timeoutMs?: number
}

export const TOOL_POLICY_ROUTES = {
  inventory: "/api/permission/tool-policy/inventory",
  record: "/api/permission/tool-policy/record",
  recordRemove: "/api/permission/tool-policy/record/remove",
  reset: "/api/permission/tool-policy/reset",
} as const

const DEFAULT_TIMEOUT_MS = 15_000

function authorization(server: ToolPolicyServerInfo): Record<string, string> {
  if (!server.username && !server.password) return {}
  const token = Buffer.from(`${server.username ?? ""}:${server.password ?? ""}`).toString("base64")
  return { Authorization: `Basic ${token}` }
}

function readFailure(status: number): ToolPolicyInventoryResult {
  return { ok: false, code: status === 503 ? "not-wired" : "request-failed" }
}

function writeFailure(status: number): ToolPolicyWriteResult {
  if (status === 503) return { ok: false, code: "not-wired" }
  if (status === 409) return { ok: false, code: "quarantined" }
  if (status === 400) return { ok: false, code: "invalid-record" }
  if (status === 500) return { ok: false, code: "write-failed" }
  return { ok: false, code: "request-failed" }
}

export function createToolPolicyClient(deps: ToolPolicyClientDeps): ToolPolicyApi {
  const doFetch = deps.fetch ?? fetch
  const timeoutMs = deps.timeoutMs ?? DEFAULT_TIMEOUT_MS

  type Sent = { ok: true; response: Response } | { ok: false; code: "engine-unavailable" | "request-failed" }

  async function send(
    route: string,
    directory: string,
    init: { method: "GET" | "PUT" | "POST"; body?: unknown },
  ): Promise<Sent> {
    let server: ToolPolicyServerInfo
    try {
      server = await deps.awaitServer()
    } catch {
      return { ok: false, code: "engine-unavailable" }
    }
    if (!server?.url) return { ok: false, code: "engine-unavailable" }
    const headers: Record<string, string> = {
      ...authorization(server),
      // 引擎侧 location 中间件对这个头做 decodeURIComponent(packages/server/src/location.ts);
      // 非 ASCII 路径不 encode 就会在 Headers 构造时被拒。
      "x-opencode-directory": encodeURIComponent(directory),
      accept: "application/json",
    }
    if (init.body !== undefined) headers["content-type"] = "application/json"
    try {
      const response = await doFetch(new URL(route, server.url), {
        method: init.method,
        headers,
        body: init.body === undefined ? undefined : JSON.stringify(init.body),
        signal: AbortSignal.timeout(timeoutMs),
      })
      return { ok: true, response }
    } catch {
      return { ok: false, code: "request-failed" }
    }
  }

  function requireDirectory(directory: unknown): directory is string {
    return typeof directory === "string" && directory.trim().length > 0
  }

  return {
    async inventory(input) {
      if (!requireDirectory(input?.directory)) return { ok: false, code: "request-failed" }
      const sent = await send(TOOL_POLICY_ROUTES.inventory, input.directory, { method: "GET" })
      if (!sent.ok) return sent
      if (sent.response.status !== 200) return readFailure(sent.response.status)
      try {
        const body = (await sent.response.json()) as { data?: unknown }
        return { ok: true, inventory: parseToolPolicyInventory(body?.data) }
      } catch {
        return { ok: false, code: "invalid-shape" }
      }
    },
    async setRecord(input) {
      if (!requireDirectory(input?.directory)) return { ok: false, code: "request-failed" }
      const sent = await send(TOOL_POLICY_ROUTES.record, input.directory, { method: "PUT", body: input.record })
      if (!sent.ok) return sent
      return sent.response.status === 204 ? { ok: true } : writeFailure(sent.response.status)
    },
    async removeRecord(input) {
      if (!requireDirectory(input?.directory)) return { ok: false, code: "request-failed" }
      const sent = await send(TOOL_POLICY_ROUTES.recordRemove, input.directory, {
        method: "POST",
        body: { selector: input.selector },
      })
      if (!sent.ok) return sent
      return sent.response.status === 204 ? { ok: true } : writeFailure(sent.response.status)
    },
    async reset(input): Promise<ToolPolicyResetResult> {
      if (!requireDirectory(input?.directory)) return { ok: false, code: "request-failed" }
      const sent = await send(TOOL_POLICY_ROUTES.reset, input.directory, { method: "POST" })
      if (!sent.ok) return sent
      if (sent.response.status === 503) return { ok: false, code: "not-wired" }
      if (sent.response.status !== 200) return { ok: false, code: "write-failed" }
      try {
        const body = (await sent.response.json()) as { data?: { backup?: unknown } }
        const backup = body?.data?.backup
        return typeof backup === "string" ? { ok: true, backup } : { ok: true }
      } catch {
        return { ok: false, code: "invalid-shape" }
      }
    },
  }
}
