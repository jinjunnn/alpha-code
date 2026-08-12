// URL helpers for the alpha Codex-style sidebar.
//
// 一切路由/目录编解码委托给 shared/route-manifest(REQ-089 版本化契约,唯一事实源);
// 本文件只保留既有导出名,importers 免改动。上游 bump 后如见路由 404,查 manifest 而非这里。

import { decodeDirectory, encodeDirectory, hrefFor } from "../../shared/route-manifest"

export function base64UrlEncode(value: string): string {
  return encodeDirectory(value)
}

/** 解码失败 throw(保持旧 API 语义:调用方自带 try/catch)。 */
export function base64UrlDecode(value: string): string {
  const decoded = decodeDirectory(value)
  if (decoded === undefined) throw new Error("invalid base64url slug")
  return decoded
}

// #925:这里曾有 `sessionHref(directory, sessionID)` —— legacy 会话 href(`/{目录}/session/{id}`,
// 路径里没有 server 段)在 ui-mac 的**唯一**产生器。它产出的 href 逼着壳事后反推 server
// (`packages/app/src/utils/session-route.ts` 的 `legacySessionServer`:同 id 的 tab,否则回落到
// 「完成时的 active server」),多 server(WSL/remote)下会把会话导向没有它的机器;那台机器上若
// 恰好有同 id 会话,打开并污染的是那个无关会话(#894 修的首页那一条,与本器的四个消费者同形)。
// 咽喉在产生器:该导出已**删除**,不是改签名 —— 两个参数都是 string,改签名会让漏改的调用点把
// 目录当 serverKey 编进 canonical 路由,编译期抓不住。要给会话拼 href,用
// `shared/route-manifest` 的 `hrefFor.session(serverKey, sessionId)`:没有 server 身份就拼不出来,
// 对新调用点默认拒绝。
// #933 收尾:`packages/app` 侧的三个 legacy 生产者(通知 / fork / submit 兜底)也已迁 canonical,
// `legacySessionServer` 反推兜底改为默认拒绝(推不出唯一身份 → 回家),`navFor.legacySession`
// 一并撤掉 —— 本注释开头那句「反推兜底必须留着」自此不再成立。

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
