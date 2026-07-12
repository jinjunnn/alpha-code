// LegacyRouteAbiV1 — REQ-084:把上游冻结的 URL 方案固化为版本化兼容 ABI(alpha 自有,单一事实源)。
//
// 上游冻结面(re-freeze 时按 ADR-020 §5 复查):
//   - 路由树 app/src/app.tsx:487-501:`/`、`/:dir`(→ Navigate "session")、`/:dir/session/:id?`、`/new-session`;
//   - 目录段 = worktree 绝对路径的 URL-safe base64 无填充(core/src/util/encode.ts,UTF-8);
//   - 解码失败语义 = app/src/utils/base64.ts decode64 的 try/catch → 上游 directory-layout toast + replace "/";
//   - draft href = app/src/context/tabs.tsx:34/141(`?draftId=`,prompt 有值才追加 `&prompt=`)。
// 迁移期间既有 URL 不可破坏:消费方一律走本模块,禁止手搓路由正则或目录编解码。
// 本文件纯逻辑、零 electron/node import(同 alpha-config.ts 模式)—— main 与 renderer 皆可 import。

export const LEGACY_ROUTE_ABI_VERSION = 1

// ---------- 目录编解码(与 core/src/util/encode.ts 逐字节一致) ----------

export function encodeDirectory(directory: string): string {
  const bytes = new TextEncoder().encode(directory)
  let binary = ""
  for (const b of bytes) binary += String.fromCharCode(b)
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=/g, "")
}

/** 任何解码失败返回 undefined(镜像上游 decode64 的 try/catch 语义)。 */
export function decodeDirectory(slug: string): string | undefined {
  try {
    const binary = atob(slug.replace(/-/g, "+").replace(/_/g, "/"))
    const bytes = Uint8Array.from(binary, (c) => c.charCodeAt(0))
    return new TextDecoder().decode(bytes)
  } catch {
    return undefined
  }
}

/** slug 形状检查(编码器可产出的字符集)。只看形状、不解码 —— REQ-014 预清等 fail-open 校验专用。 */
export function isDirectorySlug(slug: string): boolean {
  return /^[A-Za-z0-9_-]+$/.test(slug)
}

// ---------- 类型化路由模型 ----------

export type LegacyRoute =
  | { kind: "home" }
  | { kind: "directory"; directory: string; slug: string } // "/:dir" — 上游 Navigate 到 session
  | { kind: "session"; directory: string; slug: string; id?: string } // "/:dir/session/:id?"
  | { kind: "newSession"; draftId?: string; prompt?: string } // "/new-session?draftId=&prompt="
  | { kind: "invalidDirectory"; slug: string } // 目录段 base64 解码失败 → 上游 toast + replace "/"
  | { kind: "unknown"; pathname: string }

/** 解析上游冻结路由。pathname 内嵌的 "?query" 会被剥离;显式 search 参数优先。 */
export function parseRoute(pathname: string, search?: string): LegacyRoute {
  const qi = pathname.indexOf("?")
  const path = qi === -1 ? pathname : pathname.slice(0, qi)
  const query = search ?? (qi === -1 ? "" : pathname.slice(qi + 1))

  const parts = path.split("/").filter(Boolean)
  if (parts.length === 0 || path === "/index.html") return { kind: "home" }

  if (parts[0] === "new-session") {
    if (parts.length !== 1) return { kind: "unknown", pathname: path }
    const params = new URLSearchParams(query)
    return {
      kind: "newSession",
      draftId: params.get("draftId") ?? undefined,
      prompt: params.get("prompt") ?? undefined,
    }
  }

  const slug = parts[0]
  const isSession = parts[1] === "session" && parts.length <= 3
  if (parts.length !== 1 && !isSession) return { kind: "unknown", pathname: path }
  const directory = decodeDirectory(slug)
  if (directory === undefined) return { kind: "invalidDirectory", slug }
  if (parts.length === 1) return { kind: "directory", directory, slug }
  return { kind: "session", directory, slug, id: parts[2] }
}

// ---------- URL 构造(唯一出口) ----------

export const hrefFor = {
  home: (): string => "/",
  /** "/:dir/session"(无 id)—— 上游在该项目下开新会话/draft 的入口。 */
  directorySession: (directory: string): string => `/${encodeDirectory(directory)}/session`,
  session: (directory: string, sessionId: string): string => `/${encodeDirectory(directory)}/session/${sessionId}`,
  /** 镜像冻结 tabs.tsx draftHref(:34)+ prompt 追加(:141):prompt 有值才带 `&prompt=`。 */
  newSession: (draftId: string, prompt?: string): string =>
    prompt
      ? `/new-session?draftId=${encodeURIComponent(draftId)}&prompt=${encodeURIComponent(prompt)}`
      : `/new-session?draftId=${encodeURIComponent(draftId)}`,
} as const
