// cloud-vision-hooks — 把 cloud-vision.ts 接到插件的五个钩子上(`#1419`,REQ-228 基线 §2-B 第 1–5 条;`#1447` R1 修订)。
//
// 状态**按插件实例**建(#223 R7 的纪律:插件模块被 Bun 缓存、一个引擎进程一份,而实例按 directory 建;
// 模块级可变态会跨项目串扰):每个实例一份「会话 → 登记簿」、「会话 → 当前模型」、「模型 → 能不能看图」、
// 「callID → 模型原来传的 image 引用」。
//
// 五个钩子各管一格,合起来是基线 §2-B:
//   · chat.message —— 用户贴的图:登记;模型看不了图 ⇒ 每张图**追加一个 synthetic text part**(转写块或失败块),
//     图片 part 本身**保留**(UI 里用户的气泡照常显示缩略图;换到能看图的模型时图还在)。追加的 part 随消息持久化,
//     它的 metadata 里带**原图哈希、编号、云端正文**(`#1447` R1 M1)—— 重启后从这里恢复,同图再贴不再出网。
//   · experimental.chat.messages.transform —— 每次请求前:①从历史消息重建登记簿(哈希与编号取持久化标记,不对引擎
//     缩过的字节重算);②回放修正 `cloud_cloud_vision` 的部件(`#1447` R1 B2 / m4):被审核拒绝的调用在引擎里是
//     **抛错**(`mcp/catalog.ts` 对 isError 直接 throw ⇒ 部件 `status:"error"`,`tool.execute.after` 到不了),
//     所以「这张图片无法识别」只能在这里换进本次请求的副本;`input.image` 若已被原地改写成 base64 本体
//     (AI SDK 把同一个 input 对象既交给 execute 又放进 tool-call / tool-result 事件,处理器在收到事件那一刻
//     structuredClone —— 与本插件的异步改写是一场竞速,压缩缓存命中时改写先到),换回原引用或一句省略说明;
//     ③模型看不了图时,把**已带转写块**的用户消息里的图片 part、**已带标记**的 Read 结果里的图片附件,从本次请求的
//     副本里剔掉 —— 否则引擎 transform.ts 的 unsupportedParts 会把它们换成 `ERROR: Cannot read …`,与转写块打架。
//     只改本次请求的副本,不动持久化的消息。
//   · tool.execute.after —— Read 读到图片:登记(记路径);模型看不了图 ⇒ 转写块接到 output 尾部并在 metadata 打标记
//     (同样带哈希 / 编号 / 正文);`cloud_cloud_vision` 成功返回 ⇒ 把 `args.image` 换回模型原来传的引用(m4 的另一半)。
//   · tool.execute.before —— 模型调 `cloud_cloud_vision`:`args.image` 由引用**原地**换成压缩后的 base64、补 `mime`,
//     并**写死** `model:"qwen"` / `fallback_on_refusal:false`(整体替换 output.args 不生效,基线 §1b)。这条路走 `/mcp`,
//     上限是**整包** 262144(`#1447` R1 B1),压缩按 `VISION_MCP_IMAGE_MAX_BYTES`。
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
  visionToolInputOmittedText,
  visionToolRefusedText,
  type VisionImageEntry,
} from "./cloud-vision"
import { contextText, renderTemplate, VISION_SYSTEM_NOTE_ID, VISION_SYSTEM_NOTE_OFFLINE_ID } from "./context-injection"
import { compressForVision, VISION_MCP_IMAGE_MAX_BYTES } from "./vision-image"

export type ModelRef = { readonly providerID: string; readonly modelID: string }

export type CloudVisionHookDeps = {
  /** 本实例的项目目录(相对路径引用按它解析;与 Read 工具同一个基准)。 */
  readonly directory: string
  /** `client.provider.list()`:返回 hey-api 信封 `{ data: { all } }` 或裸 `{ all }` 都认。 */
  readonly listProviders: () => Promise<unknown>
  /** `client.session.messages({ path: { id } })`:hey-api 信封 `{ data: [{ info, parts }] }` 或裸数组都认。缺席 ⇒ 只靠 messages.transform 重建。 */
  readonly listMessages?: (sessionID: string) => Promise<unknown>
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

/** 转写块 part 与 Read 结果 metadata 上的标记键;messages.transform 据它重建登记簿、剔图。 */
export const VISION_MARKER = "alpha_vision"

/** 持久化标记(`#1447` R1 M1):原图哈希、会话内编号、标签、云端正文(失败时没有 text)。 */
export type VisionMarker = { readonly hash: string; readonly number: number; readonly label: string; readonly text?: string }
/** Read 结果 metadata 上的标记:与 `state.attachments` 同序、一一对应。 */
export type VisionReadMarker = { readonly images: readonly VisionMarker[] }

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
  readonly callID?: unknown
  readonly state?: {
    readonly status?: unknown
    readonly input?: Record<string, unknown>
    readonly error?: unknown
    readonly attachments?: unknown
    readonly metadata?: Record<string, unknown>
  }
}

const isMarker = (value: unknown): value is VisionMarker => {
  const m = value as { hash?: unknown; number?: unknown } | null
  return !!m && typeof m === "object" && typeof m.hash === "string" && m.hash !== "" && typeof m.number === "number"
}

/** 用户消息里转写块 part 上的标记。 */
const markerOf = (part: unknown): VisionMarker | undefined => {
  const p = part as { type?: unknown; synthetic?: unknown; metadata?: Record<string, unknown> } | null
  if (!p || p.type !== "text" || p.synthetic !== true || !p.metadata || typeof p.metadata !== "object") return undefined
  const marker = p.metadata[VISION_MARKER]
  return isMarker(marker) ? marker : undefined
}

/** Read 结果 metadata 上的标记。 */
const readMarkerOf = (tool: ToolPartLike): VisionReadMarker | undefined => {
  const marker = tool.state?.metadata?.[VISION_MARKER] as { images?: unknown } | undefined
  return marker && Array.isArray(marker.images) && marker.images.every(isMarker) ? (marker as VisionReadMarker) : undefined
}

const asToolPart = (part: unknown): ToolPartLike | undefined => {
  const p = part as ToolPartLike | null
  return p && p.type === "tool" && p.state && typeof p.state === "object" ? p : undefined
}

const REFUSAL_CODES = /content_refused|content_blocked/

export function createCloudVisionHooks(deps: CloudVisionHookDeps) {
  const env = deps.env ?? process.env
  const readFile = deps.readFile ?? ((p: string) => readFileSync(p, "utf8"))
  const sessions = new Map<string, VisionSession>()
  const sessionModel = new Map<string, ModelRef>()
  const capability = new Map<string, boolean>()
  /** callID → 模型原来传的 image 引用(m4:原地改写只该活在这一次 MCP 调用里)。 */
  const originalRefs = new Map<string, string>()

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

  /** 一条用户消息 → 登记簿:先按标记恢复(哈希 / 编号 / 正文以标记为准),再把没有标记的图片 part 登记进去。 */
  const restoreUserMessage = (session: VisionSession, message: MessageLike) => {
    const images = message.parts.filter(isImageFilePart)
    const byId = new Map(images.map((p) => [p.id, p] as const))
    for (const part of message.parts) {
      const marker = markerOf(part)
      if (!marker) continue
      const id = String((part as { id?: unknown }).id ?? "")
      const imagePart = id.endsWith("-vision") ? byId.get(id.slice(0, -"-vision".length)) : undefined
      const base64 = imagePart ? dataUrlBase64(imagePart.url) : undefined
      session.restore({ hash: marker.hash, number: marker.number, label: marker.label, text: marker.text, base64, partID: imagePart?.id })
    }
    for (const part of images) {
      const base64 = dataUrlBase64(part.url)
      if (base64) session.register({ base64, label: part.filename, partID: part.id })
    }
  }

  /** 一个 Read 结果部件 → 登记簿:标记与附件同序配对;没有标记的附件按字节登记。 */
  const restoreReadPart = (session: VisionSession, tool: ToolPartLike) => {
    if (!Array.isArray(tool.state?.attachments)) return
    const attachments = tool.state.attachments.filter(isImageFilePart)
    const marker = readMarkerOf(tool)
    const filePath = resolveReadPath(tool.state.input)
    attachments.forEach((attachment, i) => {
      const base64 = dataUrlBase64(attachment.url)
      const m = marker?.images[i]
      if (m) session.restore({ hash: m.hash, number: m.number, label: m.label, text: m.text, base64, path: filePath, partID: attachment.id })
      else if (base64) session.register({ base64, path: filePath, partID: attachment.id })
    })
  }

  const rehydrate = (session: VisionSession, message: MessageLike) => {
    if (!Array.isArray(message.parts)) return
    if (message.info.role === "user") return restoreUserMessage(session, message)
    if (message.info.role !== "assistant") return
    for (const part of message.parts) {
      const tool = asToolPart(part)
      if (tool && tool.tool === "read" && tool.state?.status === "completed") restoreReadPart(session, tool)
    }
  }

  /** `#1447` R1 M1:本进程第一次碰到这个会话时,从它的历史消息恢复登记簿(经 SDK;失败只记日志,不拦用户的消息)。 */
  const hydrate = async (sessionID: string, session: VisionSession) => {
    if (session.hydrated) return
    session.hydrated = true
    if (!deps.listMessages) return
    try {
      const response = await deps.listMessages(sessionID)
      const msgs = Array.isArray(response) ? response : (response as { data?: unknown } | null)?.data
      if (!Array.isArray(msgs)) return
      for (const m of msgs as MessageLike[]) if (m?.info) rehydrate(session, m)
    } catch (error) {
      deps.error?.(`[@alpha-code/ext] cloud vision: session history unavailable for ${sessionID} (${error instanceof Error ? error.message : String(error)})`)
    }
  }

  const describeKnown = (session: VisionSession) =>
    session
      .list()
      .map((e) => `${e.number} = ${e.label}${e.path ? ` [${e.path}]` : ""} (sha256 ${e.hash.slice(0, 12)}…)`)
      .join("; ")

  const markerFor = (session: VisionSession, entry: VisionImageEntry, name?: string): VisionMarker => {
    const text = session.transcripts.get(entry.hash)
    return { hash: entry.hash, number: entry.number, label: name ?? entry.label, ...(text !== undefined ? { text } : {}) }
  }

  return {
    /** 基线 §2-B 第 1 条。绝不抛(抛出会打死用户这条消息)。 */
    async chatMessage(input: ChatMessageInput, output: ChatMessageOutput): Promise<void> {
      try {
        const model = output.message?.model ?? input.model
        if (model) sessionModel.set(input.sessionID, model)
        const images = output.parts.filter(isImageFilePart).filter((p) => dataUrlBase64(p.url) !== undefined)
        if (images.length === 0) return
        const session = sessionFor(input.sessionID)
        await hydrate(input.sessionID, session)
        const registered = images.flatMap((part) => {
          const entry = session.register({ base64: dataUrlBase64(part.url)!, label: part.filename, partID: part.id })
          return entry ? [{ part, entry }] : []
        })
        if (await seesImages(model)) return
        const td = transcribeDeps()
        const blocks = await Promise.all(registered.map(({ part, entry }) => transcribeEntry(session, entry, td, part.filename)))
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
            metadata: { [VISION_MARKER]: markerFor(session, entry, part.filename) },
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
        const compressed = await compressForVision(Buffer.from(ref, "base64"), { maxBytes: VISION_MCP_IMAGE_MAX_BYTES })
        args.image = compressed.base64
        args.mime = compressed.mime
      } else {
        const session = sessionFor(input.sessionID)
        await hydrate(input.sessionID, session)
        const entry = session.lookup(ref, deps.directory)
        if (!entry) {
          const known = describeKnown(session)
          throw new Error(
            `${toolId}: no image in this session matches "${ref}". ` +
              (known ? `Known images: ${known}. ` : "No images have been seen in this session yet. ") +
              "Pass an attachment number, a file name, or a path that was already read with the Read tool; for a file that has not been read yet, call Read on that path first — reading it registers the image here.",
          )
        }
        // 这条路走 `/mcp`,上限是整包 262144(B1):按追问预算压,不按直打 HTTP 的 262144 解码后压。
        const compressed = await entry.compressed(VISION_MCP_IMAGE_MAX_BYTES)
        originalRefs.set(input.callID, ref)
        args.image = compressed.base64
        args.mime = compressed.mime
      }
      // owner 2026-09-23:Code Puppy 只用千问、审核拒绝不换 Gemini —— 模型传什么都覆盖。
      args.model = CLOUD_VISION_MODEL
      args.fallback_on_refusal = CLOUD_VISION_FALLBACK_ON_REFUSAL
    },

    /** 基线 §2-B 第 3 条 + m4 的另一半。绝不抛。 */
    async toolAfter(input: ToolInput, output: ToolAfterOutput): Promise<void> {
      try {
        const visionTool = cloudVisionToolId(env)
        if (visionTool && input.tool === visionTool) {
          // 成功返回才到得了这里(isError 在引擎 mcp/catalog.ts 里直接抛)。`input.args` 就是 execute 拿到的那个对象,
          // 也是 AI SDK 放进 tool-result 事件的那个 —— 把 image 换回模型原来的引用,别让 base64 本体跟着事件走。
          const args = input.args as Record<string, unknown> | null
          const original = originalRefs.get(input.callID)
          if (args && typeof args === "object" && original !== undefined) args.image = original
          originalRefs.delete(input.callID)
          return
        }
        if (input.tool !== "read") return
        const attachments = Array.isArray(output.attachments)
          ? output.attachments.filter(isImageFilePart).filter((a) => dataUrlBase64(a.url) !== undefined)
          : []
        if (attachments.length === 0) return
        const session = sessionFor(input.sessionID)
        await hydrate(input.sessionID, session)
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
        const marker: VisionReadMarker = { images: entries.map((entry) => markerFor(session, entry)) }
        metadata[VISION_MARKER] = marker
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

    /** 登记簿重建 + cloud_vision 部件的回放修正(所有模型)+ 看不了图时剔掉已转写的图片(只改本次请求的副本)。绝不抛。 */
    async messagesTransform(_input: unknown, output: MessagesOutput): Promise<void> {
      try {
        const msgs = output.messages
        if (!Array.isArray(msgs) || msgs.length === 0) return
        const lastUser = [...msgs].reverse().find((m) => m?.info?.role === "user")
        const sessionID = lastUser?.info.sessionID
        if (!lastUser || !sessionID) return
        const session = sessionFor(sessionID)
        for (const m of msgs) if (m?.info) rehydrate(session, m)
        session.hydrated = true
        const visionTool = cloudVisionToolId(env)
        // ① 回放修正:与模型能不能看图无关。
        if (visionTool)
          for (let i = 0; i < msgs.length; i++) {
            const m = msgs[i]!
            if (m.info.role !== "assistant" || !Array.isArray(m.parts)) continue
            let changed = false
            const parts = m.parts.map((p) => {
              const tool = asToolPart(p)
              if (!tool || tool.tool !== visionTool || !tool.state) return p
              let next: ToolPartLike = tool
              const image = tool.state.input?.image
              if (typeof image === "string" && looksLikeBase64Image(image)) {
                changed = true
                const original = typeof tool.callID === "string" ? originalRefs.get(tool.callID) : undefined
                next = { ...next, state: { ...next.state, input: { ...next.state!.input, image: original ?? visionToolInputOmittedText() } } }
              }
              if (next.state?.status === "error" && typeof next.state.error === "string" && REFUSAL_CODES.test(next.state.error)) {
                changed = true
                next = { ...next, state: { ...next.state, error: visionToolRefusedText() } }
              }
              return next
            })
            if (changed) msgs[i] = { ...m, parts }
          }
        // ② 看不了图 ⇒ 剔掉已转写的图片。
        const model = lastUser.info.model ?? sessionModel.get(sessionID)
        if (model) sessionModel.set(sessionID, model)
        if (await seesImages(model)) return
        for (let i = 0; i < msgs.length; i++) {
          const m = msgs[i]!
          if (!Array.isArray(m.parts)) continue
          if (m.info.role === "user") {
            if (m.parts.some((p) => markerOf(p) !== undefined) && m.parts.some(isImageFilePart)) msgs[i] = { ...m, parts: m.parts.filter((p) => !isImageFilePart(p)) }
            continue
          }
          if (m.info.role !== "assistant") continue
          let changed = false
          const parts = m.parts.map((p) => {
            const tool = asToolPart(p)
            if (!tool || tool.state?.status !== "completed" || !readMarkerOf(tool)) return p
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
