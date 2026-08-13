// REQ-125 C7:斜杠命令来源捕获(供时间线「斜杠命令 chip」,C5 消费)。
//
// 上游 session.command 在 send 后不保留命令来源;composer 在发送成功的当下捕获
// {command, arguments, 引擎返回的 assistant messageID},绑定完整会话身份(I8:
// serverKey+directory+sessionID)登记于此。时间线按身份读取并与消息对齐。
// 有界存储(I7):全局与单会话都封顶,超限丢最旧。

import { createSignal } from "solid-js"
import { sameSessionIdentity, type AlphaSessionIdentity } from "./session-workspace-core"

export type SessionSlashOrigin = {
  identity: AlphaSessionIdentity
  command: string
  arguments: string
  /** 引擎对该命令回复的 assistant message id(response.info.id);对齐用户消息 = 其前一条。 */
  assistantMessageID?: string
  /** 引擎 `/command` 注册方声明的来源(E3/E4 chip 分型);缺席 = 通用 chip,不猜。 */
  source?: "command" | "mcp" | "skill"
  at: number
}

const PER_SESSION_LIMIT = 16
const GLOBAL_LIMIT = 64

const [origins, setOrigins] = createSignal<readonly SessionSlashOrigin[]>([])

export function recordSessionSlashOrigin(entry: SessionSlashOrigin): void {
  setOrigins((previous) => {
    const next = [...previous, entry]
    const sameSession = next.filter((origin) => sameSessionIdentity(origin.identity, entry.identity))
    const sessionOverflow = new Set(sameSession.slice(0, Math.max(0, sameSession.length - PER_SESSION_LIMIT)))
    const bounded = next.filter((origin) => !sessionOverflow.has(origin))
    return bounded.slice(Math.max(0, bounded.length - GLOBAL_LIMIT))
  })
}

/** 该会话按时间序的斜杠命令来源(响应式)。 */
export function sessionSlashOriginsFor(identity: AlphaSessionIdentity): readonly SessionSlashOrigin[] {
  return origins().filter((origin) => sameSessionIdentity(origin.identity, identity))
}

/** 测试隔离用。 */
export function resetSessionSlashOrigins(): void {
  setOrigins([])
}
