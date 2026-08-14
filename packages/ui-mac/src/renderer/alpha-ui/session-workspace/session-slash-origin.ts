// REQ-125 C7:斜杠命令来源捕获(供时间线「斜杠命令 chip」,C5 消费)。
//
// 上游 session.command 在 send 后不保留命令来源;composer 在发送成功的当下捕获
// {command, arguments, 引擎返回的 assistant messageID},绑定完整会话身份(I8:
// serverKey+directory+sessionID)登记于此。时间线按身份读取并与消息对齐。
// 有界存储(I7):全局与单会话都封顶,超限丢最旧。
//
// ── `#953`:登记落盘,否则 chip 活不过重启 ──────────────────────────────────
// 此前这里是一个模块级 signal,进程一退就没了 —— 消息还在、chip 不在。
// 为什么落在 alpha 自己的 store 而不是随消息落到引擎侧(勘破实测,2026-08-13):
//   ① 非 subtask 命令的用户消息里**只有展开后的模板文本**,命令名不进任何 part
//      (`packages/opencode/src/session/prompt.ts` 的 `SessionPrompt.command`);
//   ② `command.executed` 是瞬时 SSE 事件 —— 本机 30+ 个真实引擎库的 `event` 表里
//      **零条** `command.*`(落库的只有 `message.*` / `session.*` 两族);
//   ③ 唯一现成的持久载体 `TextPart.metadata`(真实库里有 `opencodeComment` 在用)
//      客户端够不着:`CommandInput.parts` 是**只收 file part** 的 union,要写它就得
//      改 `packages/opencode` 的 schema —— 那是 UPSTREAM_PATHS。
// 代价如实记:作用域到此为止是**本机**,换机器/换设备不跟(缺席即零渲染,不显示错的)。
//
// ── 存储即真源:内存里不留副本 ────────────────────────────────────────────
// signal 只做「刚写过」的反应性通知,不承载值。这样「重启后 chip 还在」这条判据才杀得掉
// 「只记在内存里」的实现 —— 每读一次都必须从落盘的字节重建一次。
//
// ── T4(2026-08-09 已批基线):来源缺席时零渲染 ────────────────────────────
// localStorage 是用户可写的,落盘的每一条在读回时**逐条重验**:任何一段不成立就丢掉
// **那一条**。宁可不显示,也不显示一个错的来源。

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

/** 落盘键;值 = `SessionSlashOrigin[]` 的 JSON。 */
const STORE_KEY = "alpha-session-slash-origins-v1"

/** 与 rail-width.ts 同一口径:只要 get/set,便于按调用点注入。 */
type StorageLike = Pick<Storage, "getItem" | "setItem">

function defaultStorage(): StorageLike | null {
  try {
    return typeof localStorage === "undefined" ? null : localStorage
  } catch {
    return null
  }
}

/** 写盘后自增;读路径依赖它取得反应性(值本身不参与结果)。 */
const [revision, bumpRevision] = createSignal(0)

function decodeIdentity(value: unknown): AlphaSessionIdentity | undefined {
  if (typeof value !== "object" || value === null) return undefined
  const { serverKey, directory, sessionID } = value as Record<string, unknown>
  if (typeof serverKey !== "string" || serverKey.length === 0) return undefined
  if (typeof directory !== "string" || directory.length === 0) return undefined
  if (typeof sessionID !== "string" || sessionID.length === 0) return undefined
  return { serverKey, directory, sessionID }
}

/**
 * 落盘字节 → 登记(逐条 fail-closed)。坏的那一条丢掉,好的照常留下。
 * `arguments` 会原样进 chip 文案,类型不对就整条丢 —— 不要把它糊成空串,那是在**显示一个错的**。
 */
function decodeOrigins(raw: string | null): SessionSlashOrigin[] {
  if (!raw) return []
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    return []
  }
  if (!Array.isArray(parsed)) return []
  const decoded: SessionSlashOrigin[] = []
  for (const item of parsed) {
    if (typeof item !== "object" || item === null) continue
    const record = item as Record<string, unknown>
    const identity = decodeIdentity(record.identity)
    if (!identity) continue
    if (typeof record.command !== "string" || record.command.length === 0) continue
    if (typeof record.arguments !== "string") continue
    const assistantMessageID =
      typeof record.assistantMessageID === "string" && record.assistantMessageID.length > 0
        ? record.assistantMessageID
        : undefined
    // E3/E4:来源只认注册方声明的三个字面量;其余值按缺席处理(通用 chip,不猜)。
    const source =
      record.source === "command" || record.source === "mcp" || record.source === "skill" ? record.source : undefined
    decoded.push({
      identity,
      command: record.command,
      arguments: record.arguments,
      ...(assistantMessageID ? { assistantMessageID } : {}),
      ...(source ? { source } : {}),
      at: typeof record.at === "number" && Number.isFinite(record.at) ? record.at : 0,
    })
  }
  return decoded
}

function readAll(storage: StorageLike | null): SessionSlashOrigin[] {
  if (!storage) return []
  try {
    return decodeOrigins(storage.getItem(STORE_KEY))
  } catch {
    return []
  }
}

/** I7:单会话封顶 16、全局封顶 64,超限丢最旧。 */
function bounded(all: SessionSlashOrigin[], entry: SessionSlashOrigin): SessionSlashOrigin[] {
  const sameSession = all.filter((origin) => sameSessionIdentity(origin.identity, entry.identity))
  const overflow = new Set(sameSession.slice(0, Math.max(0, sameSession.length - PER_SESSION_LIMIT)))
  const kept = all.filter((origin) => !overflow.has(origin))
  return kept.slice(Math.max(0, kept.length - GLOBAL_LIMIT))
}

export function recordSessionSlashOrigin(
  entry: SessionSlashOrigin,
  storage: StorageLike | null = defaultStorage(),
): void {
  if (!storage) return
  try {
    storage.setItem(STORE_KEY, JSON.stringify(bounded([...readAll(storage), entry], entry)))
  } catch {
    // 配额/序列化失败:chip 是呈现便利,不能成为发送路径的失败源。
    return
  }
  bumpRevision((value) => value + 1)
}

/** 该会话按时间序的斜杠命令来源(响应式;每次都从落盘字节重建)。 */
export function sessionSlashOriginsFor(
  identity: AlphaSessionIdentity,
  storage: StorageLike | null = defaultStorage(),
): readonly SessionSlashOrigin[] {
  void revision()
  return readAll(storage).filter((origin) => sameSessionIdentity(origin.identity, identity))
}

/** 测试隔离用。 */
export function resetSessionSlashOrigins(storage: StorageLike | null = defaultStorage()): void {
  try {
    storage?.setItem(STORE_KEY, "[]")
  } catch {
    /* 清不掉也不能抛进 UI */
  }
  bumpRevision((value) => value + 1)
}
