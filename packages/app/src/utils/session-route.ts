import { base64Encode } from "@opencode-ai/core/util/encode"
import { ServerConnection } from "@/context/server"
import { decode64 } from "@/utils/base64"

export function sessionHref(server: ServerConnection.Key, sessionID: string) {
  return `/server/${base64Encode(server)}/session/${sessionID}`
}

export function legacySessionHref(directory: string, sessionID: string) {
  return `/${base64Encode(directory)}/session/${sessionID}`
}

export function requireServerKey(segment: string | undefined) {
  const key = decode64(segment)
  if (!key || base64Encode(key) !== segment) throw new Error("Invalid server route")
  return ServerConnection.Key.make(key)
}

// #933:这是 legacy 会话 href(`/{目录}/session/{id}`,路径无 server 段)进入 canonical 世界的
// 唯一咽喉。应用内的生产者(通知 / fork 对话框 / submit 兜底,#933 迁完;ui-mac 侧 #894/#925
// 迁完)已全部改产 canonical href,走到这里的只剩存量痕迹(升级前发出的 OS 通知、legacy layout
// 存下的 URL)。语义因此从「猜」收成「默认拒绝」:
//   · 同 id 的 tab 开在 active 上 —— 会话确实在 active 上,回 active;
//   · 恰好一个 tab 持有该 id —— 唯一身份,回那台;
//   · 其余(零匹配 / 多台都有且都不是 active)—— 返回 undefined,由调用方回家。
// 旧版在这里回落 active:那正是「落到没有该会话的机器、污染同 id 无关会话」(#894)的来源,
// 对新出现的 legacy 生产者等于默认放行。
export function legacySessionServer(
  tabs: readonly { type: "session"; server: ServerConnection.Key; sessionId: string }[],
  sessionID: string,
  active: ServerConnection.Key,
): ServerConnection.Key | undefined {
  const matches = tabs.filter((tab) => tab.sessionId === sessionID)
  const activeMatch = matches.find((tab) => tab.server === active)
  if (activeMatch) return activeMatch.server
  if (matches.length === 1) return matches[0]?.server
  return undefined
}

type SessionParent = { id: string; parentID?: string }

export async function rootSession<T extends SessionParent>(session: T, get: (sessionID: string) => Promise<T>) {
  const seen = new Set([session.id])
  let current = session
  while (current.parentID) {
    if (seen.has(current.parentID)) throw new Error(`Session parent cycle: ${current.parentID}`)
    seen.add(current.parentID)
    current = await get(current.parentID)
  }
  return current
}
