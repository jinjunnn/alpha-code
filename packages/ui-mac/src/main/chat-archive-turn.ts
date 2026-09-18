// REQ-160 `#1324` —— 把引擎的消息列表切成「一轮」,并铸出上报面 `turn` part 的**确切 JSON**。
// 纯函数、零 electron / 零 fetch:IO 在 chat-archive-uploader.ts,游标在 chat-archive-cursor.ts。
//
// 线契约是 alpha-web 的 `docs/contracts/chat-archive-upload.md`(取代 `desktop-oauth.md` 成为上报面的
// 实现依据),可执行真相是那边的 `lib/chat-archive.ts` / `app/api/chat-archive/turns/route.ts`。
// 本文件只做一件事:**把引擎的形状投影到那份线契约**,不发明第二份判据。
//
// ── 供数方为什么是「旧那一代」的 `/session/:id/message`,不是 `/api/session/:id/message` ──────────
// 引擎同时挂着两代会话 API(`packages/opencode/src/server/routes/instance/httpapi/public.ts:186`
// 按 `/api` 前缀区分)。上报面**两条消息都必填 `provider_id` / `model_id`**,而:
//   · 旧代 `packages/schema/src/v1/session.ts:364-368` 的 `UserMessage.model` 是**必填** Struct
//     (`providerID` + `modelID`),`:479-480` 的 assistant 平铺同名两字段 —— 两条都拿得到;
//   · 新代 `/api` 的投影 `packages/schema/src/session-message.ts:45-51` 的 `user` 只有
//     `text` / `files` / `agents` —— **结构上没有 model**,凑不出必填字段;而且该组自报
//     "Experimental message routes"(`packages/protocol/src/groups/message.ts:49`)。
// 所以本模块的输入形状 = 旧代 `SessionV1.WithParts`(`packages/schema/src/v1/session.ts:510-518`)。
// 这条不是偏好:照新代实现会让每一条上报都被服务端以 `invalid_turn` 终态拒绝。
//
// ── 哪些 assistant 消息**没有**轮次可归属 ─────────────────────────────────────────────────────
// 契约原文:没有 user 前驱的 assistant 消息(compaction / summary / 引擎自发)**跳过**,
// 不得补一条合成的 user 消息 —— 补出来的东西会被当作「用户说过的话」存进证据库。
// 引擎侧这类消息认得出来,判据用**引擎自己的标记**,不用我们猜的代理量:
//   · compaction 产出的 assistant 唯一带 `summary: true`(`packages/opencode/src/session/compaction.ts:401`,
//     全仓仅此一处),它的「user 前驱」是引擎为 compaction 现造的、只挂一个 `compaction` part 的
//     user 消息(同文件 `:566-580`)—— 两条各自都足以判出来,两条都查。
//   · 用户消息里的 `synthetic: true` 文本 part 是引擎注入的提醒/续写指令
//     (`packages/opencode/src/session/reminders.ts:28-46`、`session/prompt.ts:478-485`),
//     **不是用户打的字**;剔掉之后什么都不剩的 user 消息 = 这一轮用户没说话 ⇒ 整轮跳过。
//
// ── 附件 ────────────────────────────────────────────────────────────────────────────────────
// 「附件」= composer 那条通道产出的 FilePart:`url` 是 `data:<mime>;base64,…`
// (`packages/ui-mac/src/renderer/alpha-ui/composer-attachments-core.ts:17`)。`@` 引用的项目文件是
// `file://` 一类的**引用**而不是随消息上传的字节,不在这条线上;引擎自己也把 `text/plain` 与目录
// FilePart 折成文本(`packages/opencode/src/session/message-v2.ts:212`)。
// mime 白名单是服务端 `ALLOWED_ATTACHMENT_MIME` 的那五个,这里按契约**独立**写一遍字面量
// (不从别处派生 —— 期望值与被测对象同源会一起改错还一起自洽)。白名单外的 data URL 附件会被
// 丢掉并留一行日志:整轮带着它发出去只会换回一个 415 终态,把这一轮的**文本**也一起丢掉,
// 而文本正是这个存档存在的理由。
//
// ── 消息的 `content_hash` 不在这里,也不该在这里 ────────────────────────────────────────────
// 服务端按它存下的文本自己算(契约 §The `turn` part),请求体里带了会被 `invalid_turn` 拒。
// 附件哈希相反:客户端声明、服务端按收到的字节重算比对。

import { createHash } from "node:crypto"

/** 服务端 `ALLOWED_ATTACHMENT_MIME`(契约 §Limits 的 mime 行)。独立字面量,故意不从别处 import。 */
export const ARCHIVE_ATTACHMENT_MIME: readonly string[] = Object.freeze([
  "image/png",
  "image/jpeg",
  "image/gif",
  "image/webp",
  "application/pdf",
])

/** 服务端 `MAX_ATTACHMENTS_PER_TURN`。超出这个数的附件不上报(composer 自己也封在 8)。 */
export const ARCHIVE_MAX_ATTACHMENTS_PER_TURN = 8

// ── 引擎侧输入形状(旧代 SessionV1.WithParts 的**本模块用得到的那部分**)──────────────────────
// 刻意写窄:它是从 HTTP 拿回来的 JSON,不是本进程构造的对象,所以每个字段都要在下面显式验形,
// 验不过就跳过该轮(fail-closed),不往线上发一个必被拒的请求。

export type EngineMessagePart = {
  type?: unknown
  text?: unknown
  synthetic?: unknown
  ignored?: unknown
  mime?: unknown
  filename?: unknown
  url?: unknown
}

export type EngineMessageInfo = {
  id?: unknown
  role?: unknown
  time?: { created?: unknown; completed?: unknown }
  model?: { providerID?: unknown; modelID?: unknown }
  providerID?: unknown
  modelID?: unknown
  finish?: unknown
  summary?: unknown
  tokens?: { output?: unknown }
}

export type EngineMessage = { info?: EngineMessageInfo; parts?: readonly EngineMessagePart[] }

// ── 上报面输出形状 ────────────────────────────────────────────────────────────────────────────

export type ArchiveTurnMessage = {
  engine_message_id: string
  role: "user" | "assistant"
  text: string
  provider_id: string
  model_id: string
  finish?: string | null
  tokens_output?: number | null
}

export type ArchiveTurnAttachmentMeta = {
  message_index: 0 | 1
  kind: "image" | "file"
  mime: string
  byte_size: number
  content_hash: string
  filename: string | null
}

/** `turn` part 的**逐字** JSON 体。`JSON.stringify` 它就是要发的那个字符串字段。 */
export type ArchiveTurnBody = {
  engine_session_id: string
  messages: [ArchiveTurnMessage, ArchiveTurnMessage]
  attachments: ArchiveTurnAttachmentMeta[]
}

export type ArchiveTurn = {
  /** 游标值:这一轮终态之后写回 chat-archive-cursor 的 `engine_message_id`(assistant 那条)。 */
  assistantMessageId: string
  body: ArchiveTurnBody
  /** 与 `body.attachments` 同序同长;第 i 个发成 `attachment_<i>` part。 */
  attachmentBytes: Uint8Array[]
}

export type BuildTurnsInput = {
  engineSessionId: string
  messages: readonly EngineMessage[]
  /** 功能启用时刻(ms)。只上报此后**完成**的轮次 —— 不回填历史(owner 2026-09-17)。 */
  enabledAt: number
  /** 上一次终态过的 assistant `engine_message_id`;它之后的才上报。 */
  after?: string
}

export type BuildTurnsResult = {
  turns: ArchiveTurn[]
  /** 被跳过的 assistant 消息及原因;调用方原样记日志(不进线)。 */
  skipped: Array<{ messageId: string; reason: string }>
}

const isNonEmptyString = (v: unknown): v is string => typeof v === "string" && v.length > 0

function partsText(parts: readonly EngineMessagePart[]): string {
  return parts
    .filter((p) => p.type === "text" && typeof p.text === "string" && p.ignored !== true && p.synthetic !== true)
    .map((p) => p.text as string)
    .join("\n")
}

const DATA_URL = /^data:([^;,]+);base64,(.*)$/s

/** data URL → 字节。非 data URL / 非 base64 形态 → null(它不是随消息上传的字节)。 */
export function decodeDataUrl(url: unknown): { mime: string; bytes: Uint8Array } | null {
  if (typeof url !== "string") return null
  const m = DATA_URL.exec(url)
  if (!m) return null
  const mime = m[1].trim().toLowerCase()
  if (!mime) return null
  let buf: Buffer
  try {
    buf = Buffer.from(m[2], "base64")
  } catch {
    return null
  }
  if (buf.byteLength === 0) return null
  return { mime, bytes: new Uint8Array(buf) }
}

export const sha256Hex = (bytes: Uint8Array): string => createHash("sha256").update(bytes).digest("hex")

function collectAttachments(
  parts: readonly EngineMessagePart[],
  messageIndex: 0 | 1,
  sink: { meta: ArchiveTurnAttachmentMeta[]; bytes: Uint8Array[]; dropped: string[] },
) {
  for (const part of parts) {
    if (part.type !== "file") continue
    const decoded = decodeDataUrl(part.url)
    if (!decoded) continue // `@` 引用等非字节 part:不是这条线上的附件
    const mime = isNonEmptyString(part.mime) ? part.mime.toLowerCase() : decoded.mime
    if (!ARCHIVE_ATTACHMENT_MIME.includes(mime)) {
      sink.dropped.push(`mime ${mime}`)
      continue
    }
    if (sink.meta.length >= ARCHIVE_MAX_ATTACHMENTS_PER_TURN) {
      sink.dropped.push(`over ${ARCHIVE_MAX_ATTACHMENTS_PER_TURN} attachments`)
      continue
    }
    sink.meta.push({
      message_index: messageIndex,
      kind: mime.startsWith("image/") ? "image" : "file",
      mime,
      byte_size: decoded.bytes.byteLength,
      content_hash: sha256Hex(decoded.bytes),
      filename: isNonEmptyString(part.filename) ? part.filename.slice(0, 255) : null,
    })
    sink.bytes.push(decoded.bytes)
  }
}

/**
 * 从一个会话的消息列表切出**待上报的轮次**(按时间升序)。
 *
 * 一轮 = 恰两条消息、user → assistant,取 assistant 与它在列表里的**直接前驱**。
 * 任何一条判据不满足就整轮跳过并说明原因 —— 契约里每一个 4xx 都是终态(429 除外),
 * 明知会被拒还发出去 = 把这一轮永久丢掉。
 */
export function buildTurns(input: BuildTurnsInput): BuildTurnsResult {
  const turns: ArchiveTurn[] = []
  const skipped: Array<{ messageId: string; reason: string }> = []
  const messages = input.messages

  for (let i = 0; i < messages.length; i++) {
    const info = messages[i]?.info
    if (!info || info.role !== "assistant") continue
    const assistantId = info.id
    if (!isNonEmptyString(assistantId)) continue

    const note = (reason: string) => skipped.push({ messageId: assistantId, reason })

    // compaction 的产出:引擎全仓唯一一处 `summary: true`。
    if (info.summary === true) {
      note("compaction summary (no user turn to belong to)")
      continue
    }
    const completed = info.time?.completed
    if (typeof completed !== "number") continue // 还没写完;下一次 idle 再看
    if (completed <= input.enabledAt) continue // 启用之前完成的轮次不回填
    if (input.after !== undefined && assistantId <= input.after) continue // 已终态过

    const prev = messages[i - 1]
    const prevInfo = prev?.info
    if (!prevInfo || prevInfo.role !== "user") {
      note("assistant has no user predecessor")
      continue
    }
    const userId = prevInfo.id
    if (!isNonEmptyString(userId) || userId === assistantId) {
      note("user predecessor has no usable engine_message_id")
      continue
    }
    const prevParts = prev?.parts ?? []
    if (prevParts.some((p) => p.type === "compaction")) {
      note("user predecessor is the engine's compaction request")
      continue
    }

    const userProvider = prevInfo.model?.providerID
    const userModel = prevInfo.model?.modelID
    const assistantProvider = info.providerID
    const assistantModel = info.modelID
    if (
      !isNonEmptyString(userProvider) ||
      !isNonEmptyString(userModel) ||
      !isNonEmptyString(assistantProvider) ||
      !isNonEmptyString(assistantModel)
    ) {
      note("provider_id/model_id missing on one of the two messages")
      continue
    }

    const sink = { meta: [] as ArchiveTurnAttachmentMeta[], bytes: [] as Uint8Array[], dropped: [] as string[] }
    collectAttachments(prevParts, 0, sink)
    collectAttachments(messages[i]?.parts ?? [], 1, sink)

    const userText = partsText(prevParts)
    if (userText === "" && sink.meta.length === 0) {
      // 剔掉引擎注入的 synthetic 文本后用户什么都没留下 ⇒ 这一轮不是用户说的话。
      note("user predecessor carries nothing the user authored")
      continue
    }

    const finish = isNonEmptyString(info.finish) ? info.finish.slice(0, 60) : null
    const rawTokens = info.tokens?.output
    const tokensOutput =
      typeof rawTokens === "number" && Number.isSafeInteger(rawTokens) && rawTokens >= 0 ? rawTokens : null

    for (const dropped of sink.dropped) note(`attachment dropped: ${dropped}`)

    turns.push({
      assistantMessageId: assistantId,
      body: {
        engine_session_id: input.engineSessionId,
        messages: [
          { engine_message_id: userId, role: "user", text: userText, provider_id: userProvider, model_id: userModel },
          {
            engine_message_id: assistantId,
            role: "assistant",
            text: partsText(messages[i]?.parts ?? []),
            provider_id: assistantProvider,
            model_id: assistantModel,
            finish,
            tokens_output: tokensOutput,
          },
        ],
        attachments: sink.meta,
      },
      attachmentBytes: sink.bytes,
    })
  }

  return { turns, skipped }
}

/** `billing_path` 的派生规则,与服务端 `billingPathFor` 同一句话。桌面端只用它记日志 —— 线上不带
 *  这个字段(服务端从 `provider_id` 自己派生;带了会因 unknown key 被 `invalid_turn` 拒)。 */
export function billingPathFor(providerId: string): "platform" | "byok" | "custom" {
  if (providerId === "alpha") return "platform"
  if (providerId.endsWith("-byok")) return "byok"
  return "custom"
}
