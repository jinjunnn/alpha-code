// REQ-014 tier-2 的真实查询实现(SDK v2,与 automation-scheduler 同款 client 构造)。
// 与纯逻辑(tabs-preclean.ts)分离,使单测零 SDK 依赖。
import { createOpencodeClient } from "@opencode-ai/sdk/v2/client"

/** 按目录列会话 id。任何错误 / 分页未尽 = 返回 null(不确定态,调用方 fail-open 不剔)。 */
export async function fetchSessionIdsViaSdk(
  server: { url: string; username: string | null; password: string | null },
  directory: string,
): Promise<ReadonlySet<string> | null> {
  const headers =
    server.username || server.password
      ? { Authorization: `Basic ${Buffer.from(`${server.username ?? ""}:${server.password ?? ""}`).toString("base64")}` }
      : undefined
  const client = createOpencodeClient({ baseUrl: server.url, headers })
  const res = (await client.session.list({ directory, limit: 200 } as never)) as {
    data?: { data?: { id?: string }[]; cursor?: { next?: string } }
    error?: unknown
  }
  if (res.error || !res.data?.data) return null
  if (res.data.cursor?.next) return null // 该目录会话超过一页 → 存在性不确定 → fail-open
  return new Set(res.data.data.map((s) => s.id).filter((x): x is string => typeof x === "string" && x.length > 0))
}
