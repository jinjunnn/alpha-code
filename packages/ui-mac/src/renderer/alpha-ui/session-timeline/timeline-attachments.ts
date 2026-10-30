// REQ-236 `#1553` AC4 —— 用户气泡上方的附件(纯投影,零 DOM)。
//
// 三类来源,都只读引擎持久化的消息 part(重载后照样在):
//   · 图片 / 旧 PDF:data: FilePart(缩略图直接用它的 dataUrl);
//   · 文本:`text/plain` 的 data: FilePart —— 发送那一刻已经随消息进了对话,结果恒为「已随消息发出」;
//   · PDF / Office:synthetic 文本 part 上的 `codepuppy.attachment` metadata(shared/attachment-path.ts 的冻结形状)。
//
// PDF / Office 的读取结果按事实派生,不转述模型说了什么:
//   「已读取」当且仅当同一会话里有一次该读取工具(按 identity:mcp / 第一方 Office 服务名 / 远端工具名,不按别名)的
//   **成功**调用,且它的 `input.path` 经 normalizePosixPath 后等于 attachmentAbsolutePath(会话目录, metadata.path)——
//   与 ext 写进读取指令的是同一个函数。`read_pdf` 成功但每页都是空串 ⇒「读到 0 字」。
//   没有调用时看本机读取工具的逐服务状态(引擎 mcp.status,当下重新取):不可用 ⇒「读取失败:没有启动」;
//   回合还在跑 ⇒ 准备中「等待本机读取工具」/ 就绪「已存到本机,等助手读取」;回合结束 ⇒「这一轮助手没有读取」。
import type { FilePart, Part } from "@opencode-ai/sdk/v2/client"
import {
  ATTACHMENT_READ_TOOL,
  attachmentAbsolutePath,
  attachmentReaderServer,
  normalizePosixPath,
  stagedAttachmentOf,
  type StagedAttachmentMeta,
} from "../../../shared/attachment-path"

export type TimelineAttachmentRead =
  | { kind: "sent" }
  | { kind: "saved" }
  | { kind: "waiting" }
  | { kind: "read" }
  | { kind: "failed"; reason: "not-running" | "unreadable" | "timeout" }
  | { kind: "not-read" }
  | { kind: "empty" }

export interface TimelineAttachment {
  partID: string
  name: string
  media: "image" | "file"
  label: string
  /** 图片的 dataUrl(缩略图 / 看大图)。 */
  url?: string
  size?: number
  /** PDF / Office 暂存记录(「重新读取」原样带回 composer)。 */
  staged?: StagedAttachmentMeta
  /** 文件卡第二行的读取结果;图片与旧的 data: PDF 没有。 */
  read?: TimelineAttachmentRead
}

/** 会话实例目录与本机读取工具的逐服务状态(`serverSync.child(directory,{mcp:true}).mcp`;缺席 = 还不知道,不下结论)。 */
export type TimelineAttachmentContext = {
  directory?: string
  services?: Readonly<Record<string, unknown>>
}

type ReadInput = TimelineAttachmentContext & { tools: readonly Part[]; turnActive: boolean }

function labelOf(name: string, mime: string) {
  if (mime.startsWith("image/")) return mime.slice("image/".length).toUpperCase()
  if (mime === "application/pdf") return "PDF"
  const base = name.split("/").at(-1) ?? name
  const dot = base.lastIndexOf(".")
  if (dot <= 0) return "FILE"
  return base.slice(dot + 1).toUpperCase()
}

/** data:…;base64,xxx 解码后的字节数。 */
function dataUrlBytes(url: string): number | undefined {
  const comma = url.indexOf(",")
  if (comma < 0 || !url.slice(0, comma).includes(";base64")) return undefined
  const body = url.slice(comma + 1)
  return Math.floor((body.length * 3) / 4) - (body.endsWith("==") ? 2 : body.endsWith("=") ? 1 : 0)
}

type ToolLike = { type?: unknown; display?: { identity?: { source?: unknown; origin?: unknown; name?: unknown } }; state?: { status?: unknown; input?: { path?: unknown }; output?: unknown; error?: unknown } }

function isReadCall(part: Part, server: string, tool: string, target: string): boolean {
  const p = part as ToolLike
  const identity = p.display?.identity
  if (p.type !== "tool" || identity?.source !== "mcp" || identity.origin !== server || identity.name !== tool) return false
  const path = p.state?.input?.path
  return typeof path === "string" && normalizePosixPath(path) === target
}

/** `read_pdf` 的结果 `{ path, pages: string[] }`(server.py):每页都是空串 = 文本层为空(多半是扫描件)。 */
function pdfTextEmpty(output: unknown): boolean {
  try {
    const pages = (JSON.parse(String(output)) as { pages?: unknown }).pages
    return Array.isArray(pages) && pages.every((page) => typeof page === "string" && page.trim() === "")
  } catch {
    return false
  }
}

export function attachmentReadOf(meta: StagedAttachmentMeta, input: ReadInput): TimelineAttachmentRead {
  const server = attachmentReaderServer(meta.reader)
  const tool = ATTACHMENT_READ_TOOL[meta.reader]
  const target = input.directory ? attachmentAbsolutePath(input.directory, meta.path) : undefined
  const calls = target ? input.tools.filter((part) => isReadCall(part, server, tool, target)).map((part) => (part as ToolLike).state!) : []
  const done = calls.find((state) => state.status === "completed")
  if (done) return meta.reader === "pdf" && pdfTextEmpty(done.output) ? { kind: "empty" } : { kind: "read" }
  const failed = calls.findLast((state) => state.status === "error")
  if (failed) return { kind: "failed", reason: /timed?[ _-]?out/i.test(String(failed.error ?? "")) ? "timeout" : "unreadable" }
  if (calls.length > 0) return { kind: "saved" }
  const service = input.services ? ((input.services[server] as { status?: unknown } | undefined)?.status ?? "absent") : undefined
  if (service !== undefined && service !== "connected" && service !== "pending") return { kind: "failed", reason: "not-running" }
  if (!input.turnActive) return { kind: "not-read" }
  return service === "pending" ? { kind: "waiting" } : { kind: "saved" }
}

function fileAttachmentOf(part: FilePart): TimelineAttachment | undefined {
  if (!part.url.startsWith("data:")) return undefined
  const name = part.filename?.trim() || part.mime
  const image = part.mime.startsWith("image/")
  return {
    partID: part.id,
    name,
    media: image ? "image" : "file",
    label: labelOf(name, part.mime),
    ...(image ? { url: part.url } : {}),
    size: dataUrlBytes(part.url),
    ...(part.mime === "text/plain" ? { read: { kind: "sent" } as const } : {}),
  }
}

/** 一条用户消息的附件;读取结果的输入只在真有暂存附件时才取(会话工具列表按需算)。 */
export function timelineAttachmentsOf(parts: readonly Part[], context: () => ReadInput): TimelineAttachment[] {
  return parts.flatMap((part): TimelineAttachment[] => {
    if (part.type === "file") {
      const attachment = fileAttachmentOf(part)
      return attachment ? [attachment] : []
    }
    if (part.type !== "text" || !part.synthetic) return []
    const staged = stagedAttachmentOf(part.metadata)
    if (!staged) return []
    return [
      {
        partID: part.id,
        name: staged.name,
        media: "file",
        label: labelOf(staged.name, staged.mime),
        size: staged.size,
        staged,
        read: attachmentReadOf(staged, context()),
      },
    ]
  })
}

/** 行复用的 rev 片段:读取结果变了行必须重建。 */
export function attachmentRev(attachment: TimelineAttachment): string {
  const read = attachment.read
  return `${attachment.partID}:${read?.kind ?? ""}:${read?.kind === "failed" ? read.reason : ""}`
}
