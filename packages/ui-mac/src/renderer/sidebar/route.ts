// URL helpers for the alpha Codex-style sidebar.
//
// 一切路由/目录编解码委托给 shared/legacy-route-abi(REQ-084 版本化契约,唯一事实源);
// 本文件只保留既有导出名,importers 免改动。上游 bump 后如见路由 404,查 ABI 模块而非这里。

import { decodeDirectory, encodeDirectory, hrefFor } from "../../shared/legacy-route-abi"

export function base64UrlEncode(value: string): string {
  return encodeDirectory(value)
}

/** 解码失败 throw(保持旧 API 语义:调用方自带 try/catch)。 */
export function base64UrlDecode(value: string): string {
  const decoded = decodeDirectory(value)
  if (decoded === undefined) throw new Error("invalid base64url slug")
  return decoded
}

/** Route to an existing session inside a project directory. */
export function sessionHref(directory: string, sessionID: string): string {
  return hrefFor.session(directory, sessionID)
}

/**
 * Route to a project with no session id. Under the new layout opencode's SessionRoute
 * (app.tsx) auto-creates a draft for this directory, i.e. this starts a brand-new chat.
 */
export function newSessionHref(directory: string): string {
  return hrefFor.directorySession(directory)
}

export function homeHref(): string {
  return hrefFor.home()
}

/** The basename a project shows in the sidebar (matches opencode's worktree → label). */
export function projectLabel(worktree: string): string {
  const trimmed = worktree.replace(/[\/\\]+$/, "")
  const base = trimmed.split(/[\/\\]/).pop()
  return base && base.length > 0 ? base : trimmed
}
