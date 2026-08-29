// REQ-108(alpha-code#244)—— 右栏文件查看器的跨运行时契约。
// main(workspace-file-service / rail-preview-host)与 renderer(session-rail/files 查看器)
// 共用:预算、拒绝码、IPC 结果形状。零 electron、零 node 依赖(与 html-preview.ts 同纪律)。
//
// 路径纪律:renderer 只持 workspace 相对路径;绝对路径、fd、token 永不过 IPC。
// 所有校验(realpath / symlink / 类型 / 大小 / range)在 main 侧执行,拒绝 fail-closed。

// ---- 预算(实现契约钉死;帧内数字是演示值,这里才是真源)----

/** 文本族(markdown/code/json/csv/text)完整预览预算;超过走「过大 → 节选」。 */
export const FILE_VIEWER_TEXT_MAX_BYTES = 4 * 1024 * 1024
/** 过大文本的开头节选预算。 */
export const FILE_VIEWER_EXCERPT_BYTES = 256 * 1024
/** 图片内联预算(与 artifact 二进制预览上限同值)。 */
export const FILE_VIEWER_IMAGE_MAX_BYTES = 20 * 1024 * 1024
/** html/pdf 叠放载体的根文档预算(与既有隔离 HTML host 的 32MB 口径一致)。 */
export const FILE_VIEWER_DOC_MAX_BYTES = 32 * 1024 * 1024
/** 单次 chunk 读取上限(main 侧强制;renderer 请求更大也会被夹到这个值)。 */
export const FILE_VIEWER_CHUNK_BYTES = 256 * 1024
/** 单个读取会话累计可读上限(fail-closed:失控的拉取循环在 main 被停)。 */
export const FILE_VIEWER_READ_TOTAL_CAP = 32 * 1024 * 1024
/** 每个 renderer(sender)同时允许的读取会话数。 */
export const FILE_VIEWER_MAX_READS = 4

// ---- 拒绝码(fail-closed 的枚举;renderer 据此选状态与文案,不解析散文)----

export type FileViewerRefusal =
  /** 路径不是安全的 workspace 相对路径(绝对、穿越、空段、NUL…)。 */
  | "invalid-path"
  | "not-found"
  /** 目录输入(AC4:目录一律拒)。 */
  | "not-a-file"
  /** 叶子是 symlink(AC4:不跟随、不读取、不转交)。 */
  | "symlink"
  /** realpath 解析落在 workspace 之外(含父目录 symlink 逃逸)。 */
  | "escapes-workspace"
  /** 校验与 open 之间文件身份变化(替换竞态,AC4)。 */
  | "identity-changed"
  /** 超出该载体的预算(叠放载体 / 保存副本等整文件动作)。 */
  | "too-large"
  /** 并发会话上限。 */
  | "busy"
  | "read-failed"

// ---- 读取会话(有界 range 读,AC5)----

export type WorkspaceFileOpenResult =
  | { ok: true; readId: string; totalBytes: number }
  | { ok: false; code: FileViewerRefusal }

export type WorkspaceFileChunkResult =
  /** bytes 为空且 eof=true 表示已读完。 */
  | { ok: true; bytes: Uint8Array; eof: boolean }
  | { ok: false; code: FileViewerRefusal }

export type WorkspaceFileActionResult = { ok: true } | { ok: false; code: FileViewerRefusal }

// ---- 右栏叠放预览(html/pdf;WebContentsView)----

export type RailPreviewKind = "html" | "pdf"

export type RailPreviewBounds = { x: number; y: number; width: number; height: number }

export type RailPreviewOpenResult =
  | { ok: true; previewId: string }
  | { ok: false; code: FileViewerRefusal }

export type RailPreviewCloseReason = "closed" | "crashed" | "shutdown" | "replaced"

export type RailPreviewClosedEvent = { previewId: string; reason: RailPreviewCloseReason }

/** blockedPaths 语义与 HtmlPreviewStatus 相同:相对路径或外部 origin,绝无 token/绝对路径。 */
export type RailPreviewStatus =
  | { ok: true; previewId: string; open: boolean; blockedPaths: string[] }
  | { ok: false; reason: string }
