// REQ-236 `#1553` AC2:输入框里的 PDF / Word / Excel / PPT 附件「本机存一份」。
//
// 只在用户选择 / 拖入 / 粘贴时由 renderer 经 IPC 调用(方案 §2.6)。落点 = 会话**实例目录**的隐藏目录下
// `attachments/<uuid>/<净化后的文件名>` —— 实例目录也是本机读取工具的授权工作区(server.py require_workspace_path)。
// 路径只经 alpha-workdir 的 ensureAlphaScaffold / safeResolveInAlpha / sanitizeArtifactName,不写隐藏目录名;
// 实例目录不被 resolveProjectAlphaRoot 接纳(主目录等)⇒ 失败,renderer 在卡上如实说明。
import { randomUUID } from "node:crypto"
import * as fs from "node:fs"
import * as path from "node:path"
import {
  ATTACHMENT_READ_TOOL,
  attachmentReaderExtension,
  attachmentRelPath,
  type AttachmentReader,
  type AttachmentStageResult,
} from "../shared/attachment-path"
import { ensureAlphaScaffold, safeResolveInAlpha, sanitizeArtifactName } from "./alpha-workdir"
import { MAX_ATTACHMENT_BYTES } from "./attachment-picker"

/** 净化后仍以读取工具要求的扩展名结尾(超长截断、dotfile 回退都不能把扩展名弄丢,否则读取工具拒收)。 */
function stagedFileName(name: string, extension: string): string {
  const safe = sanitizeArtifactName(name, `attachment${extension}`)
  if (safe.toLowerCase().endsWith(extension)) return safe
  return `${safe.slice(0, 128 - extension.length)}${extension}`
}

export function stageComposerAttachment(directory: unknown, name: unknown, reader: unknown, bytes: unknown): AttachmentStageResult {
  if (typeof directory !== "string" || typeof name !== "string" || typeof reader !== "string" || !Object.hasOwn(ATTACHMENT_READ_TOOL, reader))
    return { ok: false, reason: "invalid" }
  const data = bytes instanceof Uint8Array ? bytes : bytes instanceof ArrayBuffer ? new Uint8Array(bytes) : undefined
  if (!data) return { ok: false, reason: "invalid" }
  if (data.byteLength > MAX_ATTACHMENT_BYTES) return { ok: false, reason: "too-large" }
  if (!ensureAlphaScaffold(directory)) return { ok: false, reason: "not-project" }
  const rel = attachmentRelPath(randomUUID(), stagedFileName(name, attachmentReaderExtension(reader as AttachmentReader)))
  const target = safeResolveInAlpha(directory, ...rel.split("/"))
  if (!target) return { ok: false, reason: "not-project" }
  try {
    fs.mkdirSync(path.dirname(target), { recursive: true })
    fs.writeFileSync(target, data, { flag: "wx" })
  } catch {
    return { ok: false, reason: "write-failed" }
  }
  return { ok: true, path: rel }
}
