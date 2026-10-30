// REQ-236 `#1553`:暂存附件的路径语义与 metadata 形状 —— main(暂存)、ext(读取指令)、renderer(「已读取」判定)
// 共用这一份,不各写一份(方案 §2.6「本机存一份」与路径语义)。纯模块:无 node / electron 依赖,ext 经相对路径 import。
//
// metadata 里只存**相对隐藏目录根**的 POSIX 路径 `attachments/<uuid>/<净化后的文件名>`,不含隐藏目录名本身 ——
// 隐藏目录改名、按项目迁移后仍有效;绝对路径只由 attachmentAbsolutePath 算出。
import { ALPHA_OFFICE_CONNECTORS, type AlphaOfficeFormat } from "./office-advisories"
import { PROJECT_HIDDEN_DIR } from "./project-hidden-dir"

/** 用户消息里那个 synthetic text part 的 metadata 键(冻结面;键名以命名迁移方案定稿为准)。 */
export const ATTACHMENT_METADATA_KEY = "codepuppy.attachment"

export type AttachmentReader = AlphaOfficeFormat

/** 冻结面 `{ v:1, name, mime, size, path, reader }`。 */
export type StagedAttachmentMeta = {
  v: 1
  name: string
  mime: string
  size: number
  /** 相对隐藏目录根的 POSIX 路径。 */
  path: string
  reader: AttachmentReader
}

/** 暂存 IPC 的结果(main → renderer)。 */
export type AttachmentStageResult =
  | { ok: true; path: string }
  | { ok: false; reason: "too-large" | "not-project" | "write-failed" | "invalid" }

const ATTACHMENTS_DIR = "attachments"
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/

/** 本机读取工具的远端名(`resources/office-mcp/server.py` 的 tools_for)。 */
export const ATTACHMENT_READ_TOOL: Readonly<Record<AttachmentReader, string>> = Object.freeze({
  word: "read_docx",
  excel: "read_xlsx",
  powerpoint: "read_pptx",
  pdf: "read_pdf",
})

/** 读取工具所在的 MCP 服务名(第一方 Office 登记表 ALPHA_OFFICE_CONNECTORS 的 name)。 */
export function attachmentReaderServer(reader: AttachmentReader): string {
  return ALPHA_OFFICE_CONNECTORS.find((connector) => connector.format === reader)!.name
}

/** 读取工具要求的扩展名(server.py require_workspace_path 按它校验)。 */
export function attachmentReaderExtension(reader: AttachmentReader): string {
  return ALPHA_OFFICE_CONNECTORS.find((connector) => connector.format === reader)!.extension
}

/** `attachments/<uuid>/<name>`(name 须已净化、不含分隔符)。 */
export function attachmentRelPath(id: string, name: string): string {
  return `${ATTACHMENTS_DIR}/${id}/${name}`
}

/** POSIX 规范化:折叠重复分隔符、去掉 `.`、按段消解 `..`;保留开头的 `/`。两端比较路径都先过它。 */
export function normalizePosixPath(input: string): string {
  const absolute = input.startsWith("/")
  const out: string[] = []
  for (const segment of input.split("/")) {
    if (segment === "" || segment === ".") continue
    if (segment === "..") {
      if (out.length > 0 && out[out.length - 1] !== "..") out.pop()
      else if (!absolute) out.push("..")
      continue
    }
    out.push(segment)
  }
  return (absolute ? "/" : "") + out.join("/")
}

/** `<实例目录>/<隐藏目录>/<relPath>` 的规范化绝对路径。ext 写指令、renderer 判「已读取」都用它。 */
export function attachmentAbsolutePath(instanceDirectory: string, relPath: string): string {
  return normalizePosixPath(`${instanceDirectory}/${PROJECT_HIDDEN_DIR}/${relPath}`)
}

/** 从 part.metadata 读出冻结形状;形状不对、路径不是 `attachments/<uuid>/<单段名>` 一律 undefined(fail-closed)。 */
export function stagedAttachmentOf(metadata: unknown): StagedAttachmentMeta | undefined {
  const value = (metadata as Record<string, unknown> | null | undefined)?.[ATTACHMENT_METADATA_KEY] as
    | Partial<StagedAttachmentMeta>
    | undefined
  if (!value || typeof value !== "object" || value.v !== 1) return undefined
  if (typeof value.name !== "string" || typeof value.mime !== "string" || typeof value.size !== "number") return undefined
  if (typeof value.reader !== "string" || !Object.hasOwn(ATTACHMENT_READ_TOOL, value.reader)) return undefined
  const segments = typeof value.path === "string" ? value.path.split("/") : []
  if (segments.length !== 3 || segments[0] !== ATTACHMENTS_DIR || !UUID.test(segments[1]!)) return undefined
  const name = segments[2]!
  if (!name || name === "." || name === ".." || name.includes("\\")) return undefined
  return { v: 1, name: value.name, mime: value.mime, size: value.size, path: value.path as string, reader: value.reader }
}
