// #900:renderer 故障诊断落盘的单一脱敏出口。renderer 的当前/失败 URL 经 route-manifest 的
// directory codec(base64url)可直接解回用户工作区绝对路径(shared/route-manifest.ts 的
// `session` 路由:`/server/<serverKey>/session/<sessionId>`,serverKey 走 encodeDirectory);
// 故诊断日志只允许落 route-manifest 的封闭 RouteId 枚举(与 shared/recovery.ts 的 surface
// incident DTO 同一纪律),绝不落原始 URL/Error 对象/绝对路径。零 Electron 依赖,便于直接单测。
import { parseRoute, type RouteId } from "../shared/route-manifest"

export function safeRouteLabel(url: string): RouteId | "unparseable" {
  try {
    const parsed = new URL(url)
    const search = parsed.search.startsWith("?") ? parsed.search.slice(1) : parsed.search
    return parseRoute(parsed.pathname, search).identity.routeId
  } catch {
    return "unparseable"
  }
}

/** `Error#name`/`typeof` only — never `.message`/`.stack`, which can carry the offending
 *  absolute path (e.g. preload ENOENT text) verbatim into the log. */
export function safeErrorName(error: unknown): string {
  if (error instanceof Error) return error.name || "Error"
  if (error === null) return "null"
  return typeof error
}
