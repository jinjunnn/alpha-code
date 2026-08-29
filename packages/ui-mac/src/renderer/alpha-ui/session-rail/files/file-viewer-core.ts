/**
 * REQ-108(#244)—— 文件查看器的纯逻辑核:呈现计划、二进制嗅探、chunk 拼接。
 *
 * AC2:呈现计划**严格复用** #207 renderer registry 的路由决策(routeArtifact),本文件只把
 * RendererId 映射到查看器的载体形态,不自建第二套格式判定。本地文件没有 claimed/detected
 * MIME(magic 检测归 artifact 域),路由按文件名扩展走 registry 的同一条 ③ 分支。
 */

import { routeArtifact, type RendererId } from "../../artifact-workbench/renderers/registry"
import type { RailPreviewKind } from "../../../../shared/file-viewer"

export type ViewerTextView = "markdown" | "code" | "json" | "csv" | "text"

export type ViewerPlan =
  /** hasModes:该格式有两种呈现(Markdown:预览|源码);其余文本族只有一种。 */
  | { kind: "text"; view: ViewerTextView; hasModes: boolean; effectiveMime: string | null }
  | { kind: "image"; mime: string }
  | { kind: "overlay"; overlay: RailPreviewKind }
  | { kind: "unsupported" }

const TEXT_VIEWS: Partial<Record<RendererId, ViewerTextView>> = {
  markdown: "markdown",
  code: "code",
  json: "json",
  csv: "csv",
  text: "text",
}

export function viewerPlanFor(name: string): ViewerPlan {
  const decision = routeArtifact({ name })
  const textView = TEXT_VIEWS[decision.rendererId]
  if (textView)
    return {
      kind: "text",
      view: textView,
      hasModes: textView === "markdown",
      effectiveMime: decision.effectiveMime,
    }
  if (decision.rendererId === "image")
    return { kind: "image", mime: decision.effectiveMime ?? "application/octet-stream" }
  if (decision.rendererId === "pdf") return { kind: "overlay", overlay: "pdf" }
  if (decision.rendererId === "html") return { kind: "overlay", overlay: "html" }
  return { kind: "unsupported" }
}

/** 与 main 侧 artifact 读取同口径:首 8 KiB 内出现 NUL ⇒ 按二进制处置,不伪装成文本。 */
export function bytesLookBinary(first: Uint8Array): boolean {
  const window = first.subarray(0, Math.min(first.length, 8 * 1024))
  return window.includes(0)
}

export function concatChunks(chunks: readonly Uint8Array[]): Uint8Array {
  const total = chunks.reduce((sum, chunk) => sum + chunk.length, 0)
  const out = new Uint8Array(total)
  let offset = 0
  for (const chunk of chunks) {
    out.set(chunk, offset)
    offset += chunk.length
  }
  return out
}

export function decodeUtf8(bytes: Uint8Array): string {
  return new TextDecoder("utf-8", { fatal: false }).decode(bytes)
}

/** 标题行的「文件名 + 上级目录暗示」。 */
export function splitViewerPath(path: string): { name: string; dir: string } {
  const index = path.lastIndexOf("/")
  if (index === -1) return { name: path, dir: "" }
  return { name: path.slice(index + 1), dir: `${path.slice(0, index)}/` }
}
