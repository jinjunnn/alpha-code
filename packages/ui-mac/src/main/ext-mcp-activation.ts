import { createOpencodeClient } from "@opencode-ai/sdk/v2/client"
// 刻意不从 `packages/opencode/src/util/timeout` import:那是 UPSTREAM_PATHS 下持续滚动重钉的
// vendored 上游,深 import 它的内部模块路径 = 下次 pin bump 上游改名就打断主进程构建。
// 语义与上游那份一致(超时 reject,由本文件末尾的 catch 归一为 reload-pending),ui-mac 侧
// 另有两份同形态的本地实现(use-extensions.ts:225、wsl/runtime.ts:395)。
function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout>
  return Promise.race([
    promise.finally(() => clearTimeout(timer)),
    new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error(label)), ms)
    }),
  ])
}
import type { ServerReadyData } from "../preload/types"

export type McpActivationReference = {
  reference: string
  status: "connected" | "disabled" | "failed" | "reload-pending"
}

/**
 * Reload the engine from durable config after an MCP install. This keeps `{file:...}` resolution
 * inside ConfigVariable at config-load time and returns no config or secret bytes to the renderer.
 */
export async function reloadInstalledMcp(
  name: string,
  awaitServer: () => Promise<ServerReadyData>,
  fetchImpl: typeof fetch = fetch,
  timeoutMs = { awaitServer: 5_000, dispose: 5_000, status: 10_000 },
): Promise<McpActivationReference> {
  try {
    const server = await withTimeout(
      awaitServer(),
      timeoutMs.awaitServer,
      "timed out waiting for the engine before MCP reload",
    )
    const client = createOpencodeClient({
      baseUrl: server.url,
      fetch: fetchImpl,
      headers:
        server.username || server.password
          ? {
              Authorization: `Basic ${Buffer.from(`${server.username ?? ""}:${server.password ?? ""}`).toString(
                "base64",
              )}`,
            }
          : undefined,
    })
    const disposed = await withTimeout(
      client.global.dispose(),
      timeoutMs.dispose,
      "timed out disposing the engine before MCP reload",
    )
    if ((disposed as { error?: unknown }).error) return { reference: name, status: "reload-pending" }

    const status = await withTimeout(
      client.mcp.status(),
      timeoutMs.status,
      "timed out reading MCP status after engine reload",
    )
    if ((status as { error?: unknown }).error) return { reference: name, status: "reload-pending" }
    const state = (status as { data?: Record<string, { status?: unknown }> }).data?.[name]?.status
    if (state === "connected") return { reference: name, status: "connected" }
    if (state === "disabled") return { reference: name, status: "disabled" }
    return { reference: name, status: "failed" }
  } catch {
    return { reference: name, status: "reload-pending" }
  }
}
