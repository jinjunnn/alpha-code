// REQ-125 C6 — edit 工具卡的有界 diff 投影。
//
// 白名单引擎:jsdiff(与 C2 审查面板同一通道)只做解析;diff 本体来自服务端
// metadata.diff(单一真源),本模块从不重算 diff。I7:超限补丁不进解析器
// (unavailable,渲染层给「过大」占位),行数硬帽 + 截断标记。渲染为纯文本节点。
import { parsePatch } from "diff"

export const DIFF_PATCH_MAX_CHARS = 200_000
export const DIFF_PATCH_MAX_LINES = 4_000
export const DIFF_MAX_ROWS = 160

export interface DiffRow {
  kind: "add" | "del" | "context" | "gap"
  oldLine?: number
  newLine?: number
  text: string
}

export interface DiffView {
  rows: DiffRow[]
  truncated: boolean
  /** 超限或解析失败:不呈现 diff(渲染层显式说明),绝不吞异常伪装成功。 */
  unavailable: boolean
}

function oversized(patch: string): boolean {
  if (patch.length > DIFF_PATCH_MAX_CHARS) return true
  let lines = 1
  for (let index = 0; index < patch.length; index += 1) {
    if (patch.charCodeAt(index) === 10) {
      lines += 1
      if (lines > DIFF_PATCH_MAX_LINES) return true
    }
  }
  return false
}

export function diffViewOf(patch: string): DiffView {
  if (!patch || oversized(patch)) return { rows: [], truncated: false, unavailable: true }

  let files: ReturnType<typeof parsePatch>
  try {
    files = parsePatch(patch)
  } catch {
    return { rows: [], truncated: false, unavailable: true }
  }

  const rows: DiffRow[] = []
  let truncated = false
  outer: for (const file of files) {
    for (const hunk of file.hunks) {
      if (rows.length > 0) rows.push({ kind: "gap", text: "" })
      let oldLine = hunk.oldStart
      let newLine = hunk.newStart
      for (const line of hunk.lines) {
        if (rows.length >= DIFF_MAX_ROWS) {
          truncated = true
          break outer
        }
        const marker = line[0]
        const text = line.slice(1)
        if (marker === "+") {
          rows.push({ kind: "add", newLine, text })
          newLine += 1
        } else if (marker === "-") {
          rows.push({ kind: "del", oldLine, text })
          oldLine += 1
        } else if (marker === "\\") {
          // "\ No newline at end of file" — 上下文噪声,跳过。
        } else {
          rows.push({ kind: "context", oldLine, newLine, text })
          oldLine += 1
          newLine += 1
        }
      }
    }
  }
  return { rows, truncated, unavailable: false }
}
