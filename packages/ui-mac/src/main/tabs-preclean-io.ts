// REQ-014 tier-2 的真实查询实现。S21 真机实测钉死契约:`GET /api/session/{sessionID}` →
// 200 = 存活;404 + `_tag:"SessionNotFoundError"` = 悬空;其余一律 null(不确定 → 调用方 fail-open)。
// (原版按目录 `session.list` 判集合被真机证伪:limit 不生效、每页仅 2 条 → cursor.next 恒在 →
// 「分页未尽 fail-open」使 tier-2 恒空转;改按 id 直查,语义精确且无分页面。)
// 纯 fetch 不引 SDK,单测零依赖;每请求 1500ms 超时,总预算由 runner 的 queryBudgetMs 统管。

export async function checkSessionExistsViaFetch(
  server: { url: string; username: string | null; password: string | null },
  sessionId: string,
): Promise<boolean | null> {
  const headers: Record<string, string> =
    server.username || server.password
      ? { Authorization: `Basic ${Buffer.from(`${server.username ?? ""}:${server.password ?? ""}`).toString("base64")}` }
      : {}
  try {
    const res = await fetch(`${server.url}/api/session/${encodeURIComponent(sessionId)}`, {
      headers,
      signal: AbortSignal.timeout(1500),
    })
    if (res.status === 200) return true
    if (res.status === 404) {
      try {
        const body = (await res.json()) as { _tag?: string }
        return body?._tag === "SessionNotFoundError" ? false : null
      } catch {
        return null // 404 但非典型 body → 不确定,fail-open
      }
    }
    return null // 401/5xx/其他 → 不确定
  } catch {
    return null // 网络错/超时 → 不确定
  }
}
