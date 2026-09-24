// cloud-vision-hooks — 把 cloud-vision.ts 接到插件的五个钩子上(`#1419`,REQ-228 基线 §2-B 第 1–5 条)。
//
// 状态**按插件实例**建(#223 R7 的纪律:插件模块被 Bun 缓存、一个引擎进程一份,而实例按 directory 建;
// 模块级可变态会跨项目串扰):每个实例一份「会话 → 登记簿」、「会话 → 当前模型」、「模型 → 能不能看图」。
//
// 五个钩子各管一格,合起来是基线 §2-B:
//   · chat.message —— 用户贴的图:登记;模型看不了图 ⇒ 每张图**追加一个 synthetic text part**(转写块或失败块),
//     图片 part 本身**保留**(UI 里用户的气泡照常显示缩略图;换到能看图的模型时图还在)。追加的 part 随消息持久化,
//     后续轮次不再调用;同会话同内容按哈希去重。
//   · experimental.chat.messages.transform —— 每次请求前:①从历史消息重建登记簿(进程重启后内存是空的);
//     ②模型看不了图时,把**已带转写块**的用户消息里的图片 part、以及**已带转写标记**的 Read 结果里的图片附件,
//     从这次发给模型的消息里剔掉 —— 否则引擎 transform.ts 的 unsupportedParts 会把它们换成一句
//     `ERROR: Cannot read … Inform the user.`,与转写块打架。只改本次请求的副本,不动持久化的消息。
//   · tool.execute.after —— Read 读到图片:登记(记路径);模型看不了图 ⇒ 转写块接到 output 尾部并打标记;
//     `cloud_cloud_vision` 的结果被审核拒绝 ⇒ 替换成「这张图片无法识别」。
//   · tool.execute.before —— 模型调 `cloud_cloud_vision`:`args.image` 由引用**原地**换成压缩后的 base64、补 `mime`,
//     并**写死** `model:"qwen"` / `fallback_on_refusal:false`(整体替换 output.args 不生效,基线 §1b)。
//   · experimental.chat.system.transform —— 只对看不了图的模型追加一句登记过的说明(不提 gemini)。
//
// 「模型能不能看图」的真源是引擎的 `capabilities.input.image`(#1437 起如实):system.transform / 引擎自己递进来的
// Model 对象直接读;chat.message 只给 `{providerID, modelID}`,经 `client.provider.list()`(`/provider`,
// Provider.ListResult)查同一格。查不到 ⇒ 按看不了处理(基线 §2-B 第 6 条:代价是多一次识图,不会漏识)。

import { readFileSync } from "node:fs"
import path from "node:path"
import {
  CLOUD_VISION_FALLBACK_ON_REFUSAL,
  CLOUD_VISION_MODEL,
  cloudVisionAccess,
  cloudVisionToolId,
  dataUrlBase64,
  isImageFilePart,
  looksLikeBase64Image,
  transcribeEntry,
  VisionSession,
  visionToolRefusedText,
  type VisionImageEntry,
} from "./cloud-vision"
import { contextText, renderTemplate, VISION_SYSTEM_NOTE_ID, VISION_SYSTEM_NOTE_OFFLINE_ID } from "./context-injection"
import { compressForVision } from "./vision-image"

export type ModelRef = { readonly providerID: string; readonly modelID: string }

export type CloudVisionHookDeps = {
  /** 本实例的项目目录(相对路径引用按它解析;与 Read 工具同一个基准)。 */
  readonly directory: string
  /** `client.provider.list()`:返回 hey-api 信封 `{ data: { all } }` 或裸 `{ all }` 都认。 */
  readonly listProviders: () => Promise<unknown>
  readonly env?: Record<string, string | undefined>
  readonly readFile?: (p: string) => string
  readonly fetch?: typeof fetch
  readonly timeoutMs?: number
  readonly log?: (message: string) => void
  readonly error?: (message: string) => void
}

/** 引擎 `/provider`(Provider.ListResult)里某个模型的 `capabilities.input.image`;找不到 / 形状不对 ⇒ undefined(不是 false)。 */
export function imageCapabilityOf(list: unknown, model: ModelRef): boolean | undefined {
  const root = list as { data?: { all?: unknown }; all?: unknown } | null | undefined
  const all = root?.data?.all ?? root?.all
  if (!Array.isArray(all)) return undefined
  const provider = all.find((p) => (p as { id?: unknown } | null)?.id === model.providerID) as { models?: Record<string, unknown> } | undefined
  const entry = provider?.models?.[model.modelID] as { capabilities?: { input?: { image?: unknown } } } | undefined
  const image = entry?.capabilities?.input?.image
  return typeof image === "boolean" ? image : undefined
}

/** 转写块 part 与 Read 结果 metadata 上的标记键;messages.transform 据它决定哪些图片要从本次请求里剔掉。 */
export const VISION_MARKER = "alpha_vision"

type ChatMessageInput = { readonly sessionID: string; readonly model?: ModelRef }
type ChatMessageOutput = { readonly message: { readonly id?: string; readonly model?: ModelRef }; readonly parts: unknown[] }
type ToolInput = { readonly tool: string; readonly sessionID: string; readonly callID: string; readonly args?: unknown }
type ToolAfterOutput = { title?: string; output?: string; metadata?: unknown; attachments?: unknown; content?: unknown }
type SystemInput = { readonly sessionID?: string; readonly model?: { readonly id?: string; readonly providerID?: string; readonly capabilities?: { readonly input?: { readonly image?: unknown } } } }
type MessageLike = { readonly info: { readonly role?: string; readonly sessionID?: string; readonly model?: ModelRef }; readonly parts: unknown[] }
type MessagesOutput = { readonly messages: MessageLike[] }
type ToolPartLike = {
  readonly type?: unknown
  readonly tool?: unknown
  readonly state?: { readonly status?: unknown; readonly input?: { readonly filePath?: unknown }; readonly attachments?: unknown; readonly metadata?: Record<string, unknown> }
}

const hasVisionMarker = (part: unknown): boolean => {
  const p = part as { type?: unknown; synthetic?: unknown; metadata?: Record<string, unknown> } | null
  return !!p && p.type === "text" && p.synthetic === true && !!p.metadata && typeof p.metadata === "object" && VISION_MARKER in p.metadata
}

const asToolPart = (part: unknown): ToolPartLike | undefined => {
  const p = part as ToolPartLike | null
  return p && p.type === "tool" && p.state && typeof p.state === "object" ? p : undefined
}

export function createCloudVisionHooks(deps: CloudVisionHookDeps) {
  const env = deps.env ?? process.env
  const readFile = deps.readFile ?? ((p: string) => readFileSync(p, "utf8"))
  const sessions = new Map<string, VisionSession>()
  const sessionModel = new Map<string, ModelRef>()
  const capability = new Map<string, boolean>()

  const sessionFor = (sessionID: string): VisionSession => {
    let s = sessions.get(sessionID)
    if (!s) sessions.set(sessionID, (s = new VisionSession()))
    return s
  }
  const modelKey = (m: ModelRef) => `${m.providerID}/${m.modelID}`

  async function seesImages(model: ModelRef | undefined): Promise<boolean> {
    if (!model) return false
    const key = modelKey(model)
    const known = capability.get(key)
    if (known !== undefined) return known
    let value: boolean | undefined
    try {
      value = imageCapabilityOf(await deps.listProviders(), model)
    } catch (error) {
      deps.error?.(`[@alpha-code/ext] cloud vision: provider list unavailable (${error instanceof Error ? error.message : String(error)})`)
    }
    if (value !== undefined) capability.set(key, value)
    else deps.error?.(`[@alpha-code/ext] cloud vision: capabilities.input.image unknown for ${key} — treating the model as unable to see images (fail-closed)`)
    return value ?? false
  }

  const transcribeDeps = () => ({ access: cloudVisionAccess(env, readFile), fetch: deps.fetch, timeoutMs: deps.timeoutMs, log: deps.error })

  const resolveReadPath = (args: unknown): string | undefined => {
    const filePath = (args as { filePath?: unknown } | null)?.filePath
    return typeof filePath === "string" && filePath ? path.resolve(deps.directory, filePath) : undefined
  }

  /** 从一条历史消息把图片重新登记进会话登记簿(哈希按 part id 缓存,重复请求不重算)。 */
  const rehydrate = (session: VisionSession, message: MessageLike) => {
    if (!Array.isArray(message.parts)) return
    if (message.info.role === "user") {
      for (const part of message.parts) {
        if (!isImageFilePart(part)) continue
        const base64 = dataUrlBase64(part.url)
        if (base64) session.register({ base64, label: part.filename, partID: part.id })
      }
      return
    }
    if (message.info.role !== "assistant") return
    for (const part of message.parts) {
      const tool = asToolPart(part)
      if (!tool || tool.tool !== "read" || tool.state?.status !== "completed" || !Array.isArray(tool.state.attachments)) continue
      const filePath = resolveReadPath(tool.state.input)
      for (const attachment of tool.state.attachments) {
        if (!isImageFilePart(attachment)) continue
        const base64 = dataUrlBase64(attachment.url)
        if (base64) session.register({ base64, path: filePath, partID: attachment.id })
      }
    }
  }

  const describeKnown = (session: VisionSession) =>
    session
      .list()
      .map((e) => `${e.number} = ${e.label}${e.path ? ` [${e.path}]` : ""} (sha256 ${e.hash.slice(0, 12)}…)`)
      .join("; ")

  return {
    /** 基线 §2-B 第 1 条。绝不抛(抛出会打死用户这条消息)。 */
    async chatMessage(input: ChatMessageInput, output: ChatMessageOutput): Promise<void> {
      try {
        const model = output.message?.model ?? input.model
        if (model) sessionModel.set(input.sessionID, model)
        const images = output.parts.filter(isImageFilePart).filter((p) => dataUrlBase64(p.url) !== undefined)
        if (images.length === 0) return
        const session = sessionFor(input.sessionID)
        const registered = images.flatMap((part) => {
          const entry = session.register({ base64: dataUrlBase64(part.url)!, label: part.filename, partID: part.id })
          return entry ? [{ part, entry }] : []
        })
        if (await seesImages(model)) return
        const td = transcribeDeps()
        const blocks = await Promise.all(registered.map(({ part, entry }) => transcribeEntry(session, entry, td, part.filename ?? entry.label)))
        registered.forEach(({ part, entry }, i) => {
          const messageID = (part as { messageID?: string }).messageID ?? output.message?.id
          // id 接在图片 part 的 id 后面:引擎按 id 排序读回 parts(message-v2.ts orderBy PartTable.id),
          // 后缀让它紧跟自己那张图、排在下一个 part 之前;PartID 只要求 `prt` 前缀(session/schema.ts:19)。
          output.parts.push({
            id: `${part.id}-vision`,
            sessionID: input.sessionID,
            messageID,
            type: "text",
            text: blocks[i],
            synthetic: true,
            metadata: { [VISION_MARKER]: { hash: entry.hash, number: entry.number } },
          })
        })
      } catch (error) {
        deps.error?.(`[@alpha-code/ext] cloud vision (chat.message) failed: ${error instanceof Error ? error.message : String(error)}`)
      }
    },

    /** 基线 §2-B 第 2 条。命中 `cloud_cloud_vision` 时抛出 = 模型看到的工具错误(与 web search 闸同一机制)。 */
    async toolBefore(input: ToolInput, output: { args: unknown }): Promise<void> {
      const toolId = cloudVisionToolId(env)
      if (!toolId || input.tool !== toolId) return
      const args = output.args as Record<string, unknown> | null
      if (!args || typeof args !== "object") return
      const ref = args.image
      if (typeof ref !== "string" || ref.trim() === "")
        throw new Error(`${toolId}: "image" is required — pass an attachment number, a file name, or a path already read with the Read tool`)
      if (looksLikeBase64Image(ref)) {
        const compressed = await compressForVision(Buffer.from(ref, "base64"))
        args.image = compressed.base64
        args.mime = compressed.mime
      } else {
        const session = sessionFor(input.sessionID)
        const entry = session.lookup(ref, deps.directory)
        if (!entry) {
          const known = describeKnown(session)
          throw new Error(
            `${toolId}: no image in this session matches "${ref}". ` +
              (known ? `Known images: ${known}. ` : "No images have been seen in this session yet. ") +
              "Pass an attachment number, a file name, or a path that was already read with the Read tool; for a file that has not been read yet, call Read on that path first — reading it registers the image here.",
          )
        }
        const compressed = await entry.compressed()
        args.image = compressed.base64
        args.mime = compressed.mime
      }
      // owner 2026-09-23:Code Puppy 只用千问、审核拒绝不换 Gemini —— 模型传什么都覆盖。
      args.model = CLOUD_VISION_MODEL
      args.fallback_on_refusal = CLOUD_VISION_FALLBACK_ON_REFUSAL
    },

    /** 基线 §2-B 第 3 条 + `content_refused` 文案。绝不抛。 */
    async toolAfter(input: ToolInput, output: ToolAfterOutput): Promise<void> {
      try {
        const visionTool = cloudVisionToolId(env)
        if (visionTool && input.tool === visionTool) {
          const content = output.content
          if (!Array.isArray(content)) return
          for (const item of content as Array<{ type?: unknown; text?: unknown }>) {
            if (!item || item.type !== "text" || typeof item.text !== "string") continue
            let parsed: unknown
            try {
              parsed = JSON.parse(item.text)
            } catch {
              continue
            }
            const code = (parsed as { error?: { code?: unknown } } | null)?.error?.code
            if (code === "content_refused" || code === "content_blocked") item.text = visionToolRefusedText()
          }
          return
        }
        if (input.tool !== "read") return
        const attachments = Array.isArray(output.attachments)
          ? output.attachments.filter(isImageFilePart).filter((a) => dataUrlBase64(a.url) !== undefined)
          : []
        if (attachments.length === 0) return
        const session = sessionFor(input.sessionID)
        const filePath = resolveReadPath(input.args)
        const entries = attachments.flatMap((a) => {
          const entry = session.register({ base64: dataUrlBase64(a.url)!, path: filePath, partID: a.id })
          return entry ? [entry] : []
        })
        if (entries.length === 0) return
        if (await seesImages(sessionModel.get(input.sessionID))) return
        const td = transcribeDeps()
        const blocks = await Promise.all(entries.map((entry: VisionImageEntry) => transcribeEntry(session, entry, td)))
        output.output = `${output.output ?? ""}\n${blocks.join("\n")}`
        const metadata =
          output.metadata && typeof output.metadata === "object" && !Array.isArray(output.metadata)
            ? (output.metadata as Record<string, unknown>)
            : (output.metadata = {})
        metadata[VISION_MARKER] = { hashes: entries.map((e) => e.hash), numbers: entries.map((e) => e.number) }
      } catch (error) {
        deps.error?.(`[@alpha-code/ext] cloud vision (tool.execute.after) failed: ${error instanceof Error ? error.message : String(error)}`)
      }
    },

    /** 基线 §2-B 第 4 条。只对看不了图的模型追加一段登记过的说明。绝不抛。 */
    async systemTransform(input: SystemInput, output: { system: string[] }): Promise<void> {
      try {
        const model = input.model
        const image = model?.capabilities?.input?.image
        if (model?.providerID && model.id && typeof image === "boolean") capability.set(`${model.providerID}/${model.id}`, image)
        if (image === true) return
        const toolId = cloudVisionToolId(env)
        const access = cloudVisionAccess(env, readFile)
        output.system.push(toolId && access.ok ? renderTemplate(VISION_SYSTEM_NOTE_ID, { name: toolId }) : contextText(VISION_SYSTEM_NOTE_OFFLINE_ID))
      } catch (error) {
        deps.error?.(`[@alpha-code/ext] cloud vision (system.transform) failed: ${error instanceof Error ? error.message : String(error)}`)
      }
    },

    /** 登记簿重建 + 看不了图时剔掉已转写的图片(只改本次请求的副本)。绝不抛。 */
    async messagesTransform(_input: unknown, output: MessagesOutput): Promise<void> {
      try {
        const msgs = output.messages
        if (!Array.isArray(msgs) || msgs.length === 0) return
        const lastUser = [...msgs].reverse().find((m) => m?.info?.role === "user")
        const sessionID = lastUser?.info.sessionID
        if (!lastUser || !sessionID) return
        const session = sessionFor(sessionID)
        for (const m of msgs) if (m?.info) rehydrate(session, m)
        const model = lastUser.info.model ?? sessionModel.get(sessionID)
        if (model) sessionModel.set(sessionID, model)
        if (await seesImages(model)) return
        for (let i = 0; i < msgs.length; i++) {
          const m = msgs[i]!
          if (!Array.isArray(m.parts)) continue
          if (m.info.role === "user") {
            if (m.parts.some(hasVisionMarker) && m.parts.some(isImageFilePart)) msgs[i] = { ...m, parts: m.parts.filter((p) => !isImageFilePart(p)) }
            continue
          }
          if (m.info.role !== "assistant") continue
          let changed = false
          const parts = m.parts.map((p) => {
            const tool = asToolPart(p)
            if (!tool || tool.state?.status !== "completed" || !tool.state.metadata || !(VISION_MARKER in tool.state.metadata)) return p
            if (!Array.isArray(tool.state.attachments) || !tool.state.attachments.some(isImageFilePart)) return p
            changed = true
            return { ...tool, state: { ...tool.state, attachments: tool.state.attachments.filter((a) => !isImageFilePart(a)) } }
          })
          if (changed) msgs[i] = { ...m, parts }
        }
      } catch (error) {
        deps.error?.(`[@alpha-code/ext] cloud vision (messages.transform) failed: ${error instanceof Error ? error.message : String(error)}`)
      }
    },

    /** 测试与诊断用:本实例里某会话的登记簿。 */
    sessionState(sessionID: string): VisionSession | undefined {
      return sessions.get(sessionID)
    },
  }
}

export type CloudVisionHooks = ReturnType<typeof createCloudVisionHooks>
