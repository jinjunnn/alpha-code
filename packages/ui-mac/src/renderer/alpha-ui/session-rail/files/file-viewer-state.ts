/**
 * REQ-108(#244)—— 文件查看器状态机(context-free;IO 注入,与 files-state 同纪律)。
 *
 * AC5 的读取合同在这里兑现:读取是**拉取式**的有界 chunk 循环 —— 每个 await 之后都过
 * epoch 闸,取消/切文件/关闭查看器/组件卸载都会让循环当场停止并归还 main 侧读取会话;
 * 没有任何"后台读完再丢弃"的路径,也没有迟到内容能闪现(epoch 不符的结果一律丢弃)。
 *
 * 拒绝码 → 状态的映射(AC4/AC6,fail-closed 且分四种说法):
 *   symlink / escapes-workspace / invalid-path / identity-changed → 不安全(零动作,不转交);
 *   too-large → 过大(文本族给节选);not-found / read-failed / busy / not-a-file → 读取失败(可重试)。
 */

import { createSignal } from "solid-js"
import { detectOoxmlContainer, OOXML_LIMITS, type OoxmlSubtype } from "../../artifact-workbench/renderers/ooxml"
import {
  presentOfficeStructure,
  type OfficeStructurePresentation,
} from "../../artifact-workbench/renderers/office-structure"
import {
  officeViewerContentOf,
  type OfficeViewerContent,
} from "../../artifact-workbench/renderers/office-content"
import {
  FILE_VIEWER_CHUNK_BYTES,
  FILE_VIEWER_EXCERPT_BYTES,
  FILE_VIEWER_IMAGE_MAX_BYTES,
  FILE_VIEWER_TEXT_MAX_BYTES,
  type FileViewerRefusal,
  type RailPreviewKind,
  type WorkspaceFileChunkResult,
  type WorkspaceFileOpenResult,
} from "../../../../shared/file-viewer"
import {
  bytesLookBinary,
  concatChunks,
  decodeUtf8,
  splitViewerPath,
  viewerPlanFor,
  type ViewerPlan,
  type ViewerTextView,
} from "./file-viewer-core"

export type ViewerFilePhase =
  | { phase: "loading"; bytesRead: number }
  | {
      phase: "text"
      view: ViewerTextView
      effectiveMime: string | null
      text: string
      mode: "preview" | "source"
      hasModes: boolean
      excerpt: boolean
      totalBytes: number
    }
  | { phase: "image"; bytes: Uint8Array; mime: string; totalBytes: number }
  | { phase: "overlay"; overlay: RailPreviewKind }
  /**
   * OOXML(#1227):`subtype` 是**检测出来的**身份(与扩展名冲突时按检测为准并给 warning);
   * `structure` 复用产物面板同一份结构闸呈现;content 为 undefined 表示没过闸(只画 structure)。
   */
  /**
   * `carrier` = 这一刻用哪块画布(#1229)。`layout` 走隔离叠放层里的版式渲染(默认);
   * 宿主页报「渲染失败」时翻成 `text`,回到 #1227 那条文字提取 —— 用户看到降级的内容,
   * 而不是对着一块空白等。结构闸没过时恒 `text`(那时压根不该把字节交给渲染库)。
   */
  | {
      phase: "office"
      subtype: OoxmlSubtype | null
      claimedSubtype: OoxmlSubtype
      structure: OfficeStructurePresentation
      content: OfficeViewerContent | undefined
      totalBytes: number
      carrier: "layout" | "text"
      /** 仅 carrier 从 layout 翻成 text 时存在 —— 供诚实说明「为什么不是版式」。 */
      layoutFailure?: string
    }
  | { phase: "oversize"; totalBytes: number; excerptAvailable: boolean }
  | { phase: "unsafe"; code: FileViewerRefusal }
  | { phase: "fail"; code: FileViewerRefusal }
  | { phase: "unsupported"; totalBytes: number | null; binary: boolean }

export interface ViewerEntry {
  path: string
  name: string
  dir: string
  plan: ViewerPlan
}

export interface FileViewerIO {
  openRead: (path: string) => Promise<WorkspaceFileOpenResult>
  readChunk: (readId: string, offset: number, length: number) => Promise<WorkspaceFileChunkResult>
  closeRead: (readId: string) => void
  openExternal: (path: string) => void
  reveal: (path: string) => void
  saveCopy: (path: string) => void
}

const UNSAFE_CODES: ReadonlySet<FileViewerRefusal> = new Set([
  "symlink",
  "escapes-workspace",
  "invalid-path",
  "identity-changed",
])

export function createFileViewerState(io: FileViewerIO) {
  const [current, setCurrent] = createSignal<ViewerEntry>()
  const [filePhase, setFilePhase] = createSignal<ViewerFilePhase>()

  let epoch = 0
  let activeReadId: string | undefined

  const abortRead = () => {
    epoch++
    if (activeReadId !== undefined) {
      io.closeRead(activeReadId)
      activeReadId = undefined
    }
  }

  const refusalPhase = (code: FileViewerRefusal, plan: ViewerPlan): ViewerFilePhase => {
    if (UNSAFE_CODES.has(code)) return { phase: "unsafe", code }
    if (code === "too-large") return { phase: "oversize", totalBytes: 0, excerptAvailable: plan.kind === "text" }
    return { phase: "fail", code }
  }

  /** 有界拉取循环;返回 undefined = 本轮已过期(epoch 闸)。 */
  const pump = async (
    readId: string,
    totalBytes: number,
    limit: number,
    mine: number,
  ): Promise<Uint8Array | undefined | { failed: FileViewerRefusal }> => {
    const chunks: Uint8Array[] = []
    let offset = 0
    const target = Math.min(totalBytes, limit)
    while (offset < target) {
      const result = await io.readChunk(readId, offset, Math.min(FILE_VIEWER_CHUNK_BYTES, target - offset))
      if (epoch !== mine) return undefined
      if (!result.ok) return { failed: result.code }
      if (result.bytes.length === 0) break
      chunks.push(result.bytes)
      offset += result.bytes.length
      setFilePhase({ phase: "loading", bytesRead: offset })
      if (result.eof) break
    }
    return concatChunks(chunks)
  }

  const load = async (entry: ViewerEntry, opts: { excerpt: boolean }) => {
    abortRead()
    const mine = epoch
    setFilePhase({ phase: "loading", bytesRead: 0 })

    if (entry.plan.kind === "overlay") {
      // 载体校验与供给都在 main(rail-preview-host);view 侧 effect 驱动 open/close。
      setFilePhase({ phase: "overlay", overlay: entry.plan.overlay })
      return
    }

    const opened = await io.openRead(entry.path)
    if (epoch !== mine) {
      if (opened.ok) io.closeRead(opened.readId)
      return
    }
    if (!opened.ok) {
      setFilePhase(refusalPhase(opened.code, entry.plan))
      return
    }
    activeReadId = opened.readId
    const totalBytes = opened.totalBytes

    const done = (phase: ViewerFilePhase) => {
      io.closeRead(opened.readId)
      if (activeReadId === opened.readId) activeReadId = undefined
      setFilePhase(phase)
    }

    if (entry.plan.kind === "unsupported") {
      // 只取事实(大小),不取内容 —— 诚实卡用。
      done({ phase: "unsupported", totalBytes, binary: false })
      return
    }

    if (entry.plan.kind === "office") {
      // 预算取检测闸自己的上限 —— 超了它必拒,没有必要先把字节拉过来。
      if (totalBytes > OOXML_LIMITS.maxCompressedBytes) {
        done({ phase: "oversize", totalBytes, excerptAvailable: false })
        return
      }
      const officeBytes = await pump(opened.readId, totalBytes, OOXML_LIMITS.maxCompressedBytes, mine)
      if (officeBytes === undefined) {
        io.closeRead(opened.readId)
        return
      }
      if (!(officeBytes instanceof Uint8Array)) {
        done(refusalPhase(officeBytes.failed, entry.plan))
        return
      }
      // 检测是异步的(zip.js 动态 import + 有界 inflate)—— 之后必须再过一次 epoch 闸,
      // 否则切文件/返回树期间到站的结果会覆盖新选中的内容。
      const detection = await detectOoxmlContainer(officeBytes, { retainContentParts: true })
      if (epoch !== mine) {
        io.closeRead(opened.readId)
        return
      }
      // 结构闸的判据与产物面板同一份(扩展名/检测冲突也在它里面裁);plan 已保证这是
      // Office 家族,故 presentOfficeStructure 不会返回 null —— 兜底只是不让类型带 null 往下走。
      const structure = presentOfficeStructure({ name: entry.name, detection }) ?? {
        status: "checking" as const,
        quickLook: false as const,
      }
      done({
        phase: "office",
        subtype: detection.status === "detected" ? detection.subtype : null,
        claimedSubtype: entry.plan.claimedSubtype,
        structure,
        content: structure.status === "pass" ? officeViewerContentOf(detection) : undefined,
        totalBytes,
        // 只有过了结构闸的容器才配拿到版式画布 —— 畸形/加密/超限的一律不进渲染库。
        carrier: structure.status === "pass" ? "layout" : "text",
      })
      return
    }

    const budget = entry.plan.kind === "image" ? FILE_VIEWER_IMAGE_MAX_BYTES : FILE_VIEWER_TEXT_MAX_BYTES
    if (!opts.excerpt && totalBytes > budget) {
      done({ phase: "oversize", totalBytes, excerptAvailable: entry.plan.kind === "text" })
      return
    }

    const limit = opts.excerpt ? FILE_VIEWER_EXCERPT_BYTES : budget
    const bytes = await pump(opened.readId, totalBytes, limit, mine)
    if (bytes === undefined) {
      io.closeRead(opened.readId)
      return
    }
    if (bytes instanceof Uint8Array) {
      if (entry.plan.kind === "image") {
        done({ phase: "image", bytes, mime: entry.plan.mime, totalBytes })
        return
      }
      if (bytesLookBinary(bytes)) {
        // 扩展名声称文本、字节不是 —— 不伪装成文本显示(AC6)。
        done({ phase: "unsupported", totalBytes, binary: true })
        return
      }
      done({
        phase: "text",
        view: entry.plan.view,
        effectiveMime: entry.plan.effectiveMime,
        text: decodeUtf8(bytes),
        mode: entry.plan.view === "markdown" ? "preview" : "source",
        hasModes: entry.plan.hasModes,
        excerpt: opts.excerpt,
        totalBytes,
      })
      return
    }
    done(refusalPhase(bytes.failed, entry.plan))
  }

  /** 打开(或切换到)一个 workspace 相对路径。同路径重复打开是显式 reload。 */
  const open = (path: string) => {
    const { name, dir } = splitViewerPath(path)
    const entry: ViewerEntry = { path, name, dir, plan: viewerPlanFor(path) }
    setCurrent(entry)
    void load(entry, { excerpt: false })
  }

  /** 返回树(取消按钮与返回箭头共用):停读、清状态。 */
  const close = () => {
    abortRead()
    setCurrent(undefined)
    setFilePhase(undefined)
  }

  /** 面板被切走(AC5 五条终止路之一):停读;读取中直接退出查看器,已到站的内容保留。 */
  const deactivate = () => {
    const phase = filePhase()
    if (phase?.phase === "loading") {
      close()
      return
    }
    abortRead()
  }

  const retry = () => {
    const entry = current()
    if (entry) void load(entry, { excerpt: false })
  }

  /** 叠放载体在 view 侧被 main 拒绝/崩溃时,按同一套拒绝码映射落态(AC6 不留白屏)。 */
  const applyRefusal = (code: FileViewerRefusal) => {
    const entry = current()
    if (!entry) return
    setFilePhase(refusalPhase(code, entry.plan))
  }

  /**
   * 版式画布画不出来时的降级(#1229):不重读文件、不重跑检测 —— 内容早就装配好了,
   * 这里只是换一块画布,并留下原因。幂等:已经在 text 上就什么都不做。
   */
  const demoteOfficeToText = (reason: string) => {
    const phase = filePhase()
    if (phase?.phase !== "office" || phase.carrier === "text") return
    setFilePhase({ ...phase, carrier: "text", layoutFailure: reason.slice(0, 200) })
  }

  const loadExcerpt = () => {
    const entry = current()
    if (entry) void load(entry, { excerpt: true })
  }

  const setMode = (mode: "preview" | "source") => {
    const phase = filePhase()
    if (phase?.phase !== "text" || !phase.hasModes) return
    // 模式切换不重新读取 —— 同一份已读内容两种呈现(交互契约)。
    setFilePhase({ ...phase, mode })
  }

  const openExternal = () => {
    const entry = current()
    if (entry) io.openExternal(entry.path)
  }
  const reveal = () => {
    const entry = current()
    if (entry) io.reveal(entry.path)
  }
  const saveCopy = () => {
    const entry = current()
    if (entry) io.saveCopy(entry.path)
  }

  /** 卸载清理(切会话经 keyed remount 也走这里)。 */
  const dispose = () => {
    abortRead()
  }

  return {
    current,
    filePhase,
    open,
    close,
    deactivate,
    retry,
    applyRefusal,
    demoteOfficeToText,
    loadExcerpt,
    setMode,
    openExternal,
    reveal,
    saveCopy,
    dispose,
  }
}

export type FileViewerState = ReturnType<typeof createFileViewerState>
