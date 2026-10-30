// composer-attachments-core — PURE logic for the alpha composer's attachment channel (REQ-078 T2),
// solid-free so bun test can exercise it directly (alpha-composer.tsx wires it to signals).
//
// REQ-236 `#1553`(方案 docs/design/req236-results-and-attachments.md §2.6)逐类路径:
//   · 图片 —— 不变:dataUrl FilePart(上游 images 通道同形,build-request-parts.ts:185-193)。
//   · UTF-8 文本(MD / TXT / CSV / JSON / 代码…,≤256 KiB)—— `text/plain` dataUrl FilePart;引擎
//     prompt.ts 的 data: 分支把它解码成 synthetic 文本,内容随这条消息进入模型。
//   · PDF / Word / Excel / PPT(≤20 MiB)—— 用户放进来时由 main 存进会话实例目录的隐藏目录(composer-attachment-stage.ts),
//     消息里只带一个 synthetic 空文本 part + metadata 记录;二进制**永不**以 file part 进入模型请求。读取指令由 ext 写。
import {
  ATTACHMENT_METADATA_KEY,
  type AttachmentReader,
  type AttachmentStageResult,
  type StagedAttachmentMeta,
} from "../../shared/attachment-path"

export type AttachmentKind = "image" | "text" | "document"

/** 卡上能写的拒绝 / 失败原因(文案在 i18n,纯核只给码)。 */
export type AttachmentFailure =
  | "type"
  | "image-size"
  | "text-size"
  | "document-size"
  | "read"
  | AttachmentStageFailure

export type AttachmentStageFailure = Extract<AttachmentStageResult, { ok: false }>["reason"]

type AttachmentBase = { id: string; name: string; size: number }

export type ComposerAttachment =
  /** `url` = FileReader dataUrl(data:<mime>;base64,…)—— 提交时原样作 FilePart.url。 */
  | (AttachmentBase & { kind: "image"; mime: string; url: string })
  /** `url` = data:text/plain;base64,<UTF-8 正文>。 */
  | (AttachmentBase & { kind: "text"; mime: "text/plain"; url: string })
  /** 已存到本机:`directory` = 存进去的那个实例目录,`path` = 相对隐藏目录根的 POSIX 路径;`file` 留着供换目录后重存。 */
  | (AttachmentBase & { kind: "document"; mime: string; reader: AttachmentReader; directory: string; path: string; file?: File })
  /** 发送前就没能附上(类型 / 超限 / 读盘 / 暂存失败)—— 卡内说明;`file` 在场 ⇒ 可重试。 */
  | (AttachmentBase & { kind: "failed"; reason: AttachmentFailure; file?: File })

/** 一批读盘的结果:读成的、和如实拒绝的(类型/超限/读失败)。 */
export type AttachmentReadResult = {
  accepted: readonly ComposerAttachment[]
  rejected: readonly { name: string; reason: string }[]
}

/** #663:一批读盘的**在途工单**。读盘结果属于发起它的那条 draft,不属于发起它的组件实例 ——
 *  离开 draft 时工单随草稿快照一起移交,谁在它 settle 时活着,谁就把结果并进自己的附件列表
 *  (已经 settle 的工单照样能移交:promise 记着结果)。约定:**只 resolve,从不 reject** ——
 *  一旦它不 settle,挂起计数就永不归零,工作区切换会被永久拦住。 */
export type PendingAttachmentRead = Promise<AttachmentReadResult>

export const IMAGE_MIME: ReadonlySet<string> = new Set(["image/png", "image/jpeg", "image/gif", "image/webp"])

/** 扩展名 → 本机读取工具(server.py 按扩展名校验路径,所以文档类只认扩展名)。 */
const DOCUMENT_READERS: Readonly<Record<string, { reader: AttachmentReader; mime: string }>> = {
  pdf: { reader: "pdf", mime: "application/pdf" },
  docx: { reader: "word", mime: "application/vnd.openxmlformats-officedocument.wordprocessingml.document" },
  xlsx: { reader: "excel", mime: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" },
  pptx: { reader: "powerpoint", mime: "application/vnd.openxmlformats-officedocument.presentationml.presentation" },
}

/** 按扩展名认作文本(浏览器给 .md / .ts 的 type 常是空串或 video/mp2t,不能只看 type)。内容另要过 UTF-8 校验。 */
const TEXT_EXTENSIONS = new Set(
  (
    "txt md markdown csv tsv json jsonl yaml yml toml xml html htm css scss less js jsx mjs cjs ts tsx py rb go rs java kt " +
    "swift c h cc cpp hpp cs php sh zsh bash sql ini cfg conf log vue svelte lua r scala dart m mm pl gradle proto graphql"
  ).split(" "),
)

/** <input accept> 值(选择器预过滤;真闸门是 classifyAttachment —— 拖拽/粘贴不经 accept)。 */
export const ATTACH_ACCEPT = [
  ...IMAGE_MIME,
  ...Object.keys(DOCUMENT_READERS).map((ext) => `.${ext}`),
  ...[...TEXT_EXTENSIONS].map((ext) => `.${ext}`),
  "text/*",
].join(",")

/** 图片按 Anthropic API 单图 5MB 收;文本 256 KiB;PDF / Office 20 MiB(与 main attachment-picker 同值)。超限如实拒绝。 */
export const IMAGE_MAX_BYTES = 5 * 1024 * 1024
export const TEXT_MAX_BYTES = 256 * 1024
export const DOCUMENT_MAX_BYTES = 20 * 1024 * 1024
export const ATTACH_MAX_COUNT = 8

const extensionOf = (name: string) => {
  const base = name.split("/").at(-1) ?? name
  const dot = base.lastIndexOf(".")
  return dot > 0 ? base.slice(dot + 1).toLowerCase() : ""
}

export type AttachmentClass =
  | { ok: true; kind: "image" }
  | { ok: true; kind: "text" }
  | { ok: true; kind: "document"; reader: AttachmentReader; mime: string }
  | { ok: false; reason: AttachmentFailure }

export function classifyAttachment(f: { name: string; type: string; size: number }): AttachmentClass {
  const ext = extensionOf(f.name)
  if (IMAGE_MIME.has(f.type)) return f.size > IMAGE_MAX_BYTES ? { ok: false, reason: "image-size" } : { ok: true, kind: "image" }
  const document = DOCUMENT_READERS[ext]
  if (document) return f.size > DOCUMENT_MAX_BYTES ? { ok: false, reason: "document-size" } : { ok: true, kind: "document", ...document }
  if (TEXT_EXTENSIONS.has(ext) || f.type.startsWith("text/") || f.type === "application/json")
    return f.size > TEXT_MAX_BYTES ? { ok: false, reason: "text-size" } : { ok: true, kind: "text" }
  return { ok: false, reason: "type" }
}

/** 文本附件的 dataUrl:内容必须是合法 UTF-8(不是就当「这种文件还不能附上」),统一 `text/plain`。 */
export function textAttachmentUrl(bytes: Uint8Array): string | undefined {
  try {
    new TextDecoder("utf-8", { fatal: true }).decode(bytes)
  } catch {
    return undefined
  }
  let binary = ""
  for (let i = 0; i < bytes.length; i += 0x8000) binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000))
  return `data:text/plain;base64,${btoa(binary)}`
}

/** 合并新附件:name+size 相同视为重复选择,静默跳过(不算错);超出总数上限如实拒绝。 */
export function mergeAttachments(
  existing: readonly ComposerAttachment[],
  incoming: readonly ComposerAttachment[],
): { next: ComposerAttachment[]; rejected: Array<{ name: string; reason: string }> } {
  const next = [...existing]
  const rejected: Array<{ name: string; reason: string }> = []
  const seen = new Set(existing.map((a) => `${a.name}\u0000${a.size}`))
  for (const a of incoming) {
    const key = `${a.name}\u0000${a.size}`
    if (seen.has(key)) continue
    if (next.length >= ATTACH_MAX_COUNT) {
      rejected.push({ name: a.name, reason: `最多 ${ATTACH_MAX_COUNT} 个附件` })
      continue
    }
    seen.add(key)
    next.push(a)
  }
  return { next, rejected }
}

/** 会话实例目录变了(新对话页切目录)⇒ 存在旧目录里的文件读取工具够不着,改成可重试的失败卡。 */
export function revalidateStagedDirectory(atts: readonly ComposerAttachment[], directory: string | undefined): ComposerAttachment[] {
  return atts.map((a) =>
    a.kind === "document" && a.directory !== directory ? { id: a.id, name: a.name, size: a.size, kind: "failed", reason: "not-project", file: a.file } : a,
  )
}

/** 附件卡「重新读取」:把消息里记录的同一个暂存附件放回输入框(不重新暂存;`directory` = 会话实例目录,metadata 原样)。 */
export function stagedComposerAttachment(meta: StagedAttachmentMeta, directory: string): ComposerAttachment {
  return { id: `staged:${meta.path}`, name: meta.name, size: meta.size, kind: "document", mime: meta.mime, reader: meta.reader, directory, path: meta.path }
}

/** 提交用的 parts。图片 / 文本 = file part;文档 = synthetic 空文本 + metadata(引擎不把空文本发给模型,message-v2.ts);失败卡不发。 */
export function buildAttachmentParts(atts: readonly ComposerAttachment[]): unknown[] {
  return atts.flatMap((a): unknown[] => {
    if (a.kind === "image" || a.kind === "text") return [{ type: "file", mime: a.mime, url: a.url, filename: a.name }]
    if (a.kind !== "document") return []
    const meta: StagedAttachmentMeta = { v: 1, name: a.name, mime: a.mime, size: a.size, path: a.path, reader: a.reader }
    return [{ type: "text", text: "", synthetic: true, metadata: { [ATTACHMENT_METADATA_KEY]: meta } }]
  })
}

/** 图片的读取方式(AC7):模型直接看 / 云端识图(看不了图 + 已登录)/ 当前模型看不了图 / 能力未知。 */
export type ImageRoute = "native" | "cloud" | "none" | "unknown"

/** `image` = 引擎对当前模型的 `capabilities.input` 是否含 image;undefined = 不知道。 */
export function imageRouteOf(input: { image: boolean | undefined; loggedIn: boolean }): ImageRoute {
  if (input.image === undefined) return "unknown"
  if (input.image) return "native"
  return input.loggedIn ? "cloud" : "none"
}

/** 文件卡第二行的读取路径(AC7):文本「直接进对话」、PDF / Office「本机读取」。 */
export function fileRouteOf(kind: "text" | "document"): "inline" | "local" {
  return kind === "text" ? "inline" : "local"
}
