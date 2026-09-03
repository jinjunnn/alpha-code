// REQ-108(alpha-code#244)—— 右栏文件查看器的 html/pdf 叠放载体(WebContentsView)。
//
// 与 html-preview-host(REQ-096)的关系:**同一套隔离,不同的画布**。
//   · 同一自定义协议(HTML_PREVIEW_SCHEME;handler 按一次性 session 注册,互不寻址);
//   · 同一 session 全 deny 组:权限三面全拒、will-download 拦截、webRequest 零外网、
//     无 preload、导航面全拒、window.open 全拒 —— 逐条与既有 host 相同,一条不放宽(AC3);
//   · 差别只有「画在哪」:不开独立窗口,而是把 WebContentsView 叠放在右栏查看器的内容区
//     (bounds 由 renderer 上报);以及内容来源:workspace 文件经 workspace-file-service 的
//     realpath/symlink/身份守卫供给,不再经 artifact manifest。
//
// PDF(owner 裁决 2026-08-28):用 Chromium 内置 viewer(该 view 单独 plugins:true),
// 一律 `#toolbar=0` 装载(下载/打印按钮整条不存在);纵深:before-input-event 拦
// Cmd/Ctrl+P、Cmd/Ctrl+S,隔离 session 的 will-download 兜底 preventDefault。
// PDF 响应不带 HTML_PREVIEW_CSP(那是 HTML 文档策略,`sandbox` 指令会禁掉 viewer 插件);
// 隔离不靠它 —— 进程/session/网络/导航面与 html 完全同组。
//
// ⚠️ #1227 的黑屏有**两条**独立成因,少修一条仍然全黑,而且两条都不报错:
//   (一) partition 必须带 `persist:`;(二) 网络白名单必须放行 `chrome://resources/`。
// partition 那条:Chromium 的 PDF viewer 是一个内建扩展,
// 而扩展在 **off-the-record(内存态)profile** 里不装载 —— Electron 的无 `persist:` 分区正是
// OTR。症状不是报错,是**看起来正常的黑屏**:mime handler 仍会把 `chrome-extension://
// mhjfbmdgcfjbbpaeojofohoefgiehjai/index.html` 挂上,但真正渲染页面的那个 plugin OOPIF
// 永远建不出来,用户看到 viewer 的深色底 + 空白。实测(见
// docs/architecture/2026-09-03-electron-pdf-viewer-session.md):同一份配置,
// 内存分区 0% 非暗像素 / 两个 frame;`persist:` 分区 93.6% / 三个 frame。
// 隔离面不因此放宽:分区名仍是一次性的(每个 preview 独一份、互不寻址),session 的
// 权限/网络/导航/下载全拒组一条不动;代价只有「落盘」,故 close 时 clearStorageData +
// 删除该分区目录,启动时再扫一遍残留(purgeRailPreviewPartitions)。
//
// 生命周期(设计 §4 遮挡合同):销毁而非隐藏 —— 返回树/切文件/切面板/收起右栏/切会话/
// 窗口关闭都由 renderer 侧 effect 的 cleanup 触发 close;窗口关闭与 sender 销毁在本模块兜底。

import * as crypto from "node:crypto"
import * as fs from "node:fs"
import * as path from "node:path"
import * as electronNs from "electron"
import type {
  BrowserWindow as BrowserWindowT,
  Event as ElectronEvent,
  Input,
  IpcMainInvokeEvent,
  RenderProcessGoneDetails,
  Session,
  WebContents,
  WebContentsView as WebContentsViewT,
} from "electron"
import * as logging from "./logging"
import { ASSET_MIME, HTML_PREVIEW_MAX_ASSET_BYTES } from "./html-preview-host"
import { resolveWorkspaceFile } from "./workspace-file-service"
import {
  HTML_PREVIEW_CSP,
  HTML_PREVIEW_MAX_BLOCKED_ENTRIES,
  HTML_PREVIEW_SCHEME,
} from "../shared/html-preview"
import {
  FILE_VIEWER_DOC_MAX_BYTES,
  type FileViewerRefusal,
  type RailPreviewBounds,
  type RailPreviewClosedEvent,
  type RailPreviewCloseReason,
  type RailPreviewKind,
  type RailPreviewOpenResult,
  type RailPreviewStatus,
} from "../shared/file-viewer"

type ElectronFacade = Pick<typeof electronNs, "app" | "ipcMain" | "session"> & {
  WebContentsView: typeof electronNs.WebContentsView
  BrowserWindow: Pick<typeof electronNs.BrowserWindow, "fromWebContents">
}
let electronRef: ElectronFacade = electronNs as ElectronFacade
export function __setRailPreviewElectron(e: ElectronFacade | null) {
  electronRef = e ?? (electronNs as ElectronFacade)
}

type RailPreviewLogFn = (name: string, message: string, extra?: Record<string, unknown>, level?: string) => void
const defaultLogSink: RailPreviewLogFn = (...args) => {
  const w = (logging as { write?: RailPreviewLogFn }).write
  if (typeof w === "function") w(...args)
}
let writeLog: RailPreviewLogFn = defaultLogSink
export function __setRailPreviewLogSink(fn: RailPreviewLogFn | null) {
  writeLog = fn ?? defaultLogSink
}

const BASE_HEADERS: Record<string, string> = {
  "X-Content-Type-Options": "nosniff",
  "Referrer-Policy": "no-referrer",
  "Cache-Control": "no-store",
}

/**
 * 分区名前缀。`persist:` 不是可选的 —— 见文件头:内存分区里 Chromium PDF viewer 不装载。
 * 前缀之后是一次性的 previewId,故每个 preview 仍是自己的 session(互不寻址不变)。
 */
export const RAIL_PREVIEW_PARTITION_PREFIX = "persist:alpha-rail-preview-"

/** `persist:` 之后的那一段就是 userData/Partitions 下的目录名(Electron 直接以它建目录)。 */
const PARTITION_DIR_PREFIX = RAIL_PREVIEW_PARTITION_PREFIX.slice("persist:".length)

function partitionsRoot(): string | null {
  try {
    return path.join(electronRef.app.getPath("userData"), "Partitions")
  } catch {
    return null
  }
}

/** 落盘代价的收口:preview 关掉就把它的分区目录删掉(best-effort,失败留给启动时的扫尾)。 */
function removePartitionDir(partition: string) {
  const root = partitionsRoot()
  if (!root) return
  const dirName = partition.startsWith("persist:") ? partition.slice("persist:".length) : partition
  if (!dirName.startsWith(PARTITION_DIR_PREFIX)) return
  try {
    fs.rmSync(path.join(root, dirName), { recursive: true, force: true, maxRetries: 3 })
  } catch {
    // 仍被 Chromium 持有 —— 下次启动的 purge 会收掉
  }
}

/**
 * 启动扫尾:上次运行崩溃/强杀会留下分区目录(close 路径没跑到)。只删本模块自己的前缀,
 * 且跳过本次运行仍活着的分区 —— 幂等,可反复调用。
 */
export function purgeRailPreviewPartitions() {
  const root = partitionsRoot()
  if (!root) return
  const live = new Set([...previews.values()].map((r) => r.partition.slice("persist:".length)))
  let entries: string[]
  try {
    entries = fs.readdirSync(root)
  } catch {
    return // 目录还不存在 —— 无残留
  }
  for (const entry of entries) {
    if (!entry.startsWith(PARTITION_DIR_PREFIX) || live.has(entry)) continue
    try {
      fs.rmSync(path.join(root, entry), { recursive: true, force: true, maxRetries: 3 })
    } catch {
      // 下次再说
    }
  }
}

type RailPreviewRecord = {
  previewId: string
  token: string
  kind: RailPreviewKind
  workspaceDir: string
  /** 根文档的 workspace 相对路径(URL 命名空间与 sibling 解析的基准)。 */
  rootRelPath: string
  /** 打开时刻的根文档字节数 —— 服务时复核,盘上被换即 409(swap 防线,与既有 host 同款)。 */
  rootBytes: number
  partition: string
  ses: Session
  view: WebContentsViewT
  win: BrowserWindowT
  sender: WebContents
  closed: boolean
  blockedPaths: string[]
  /** 挂在宿主窗口/发起 renderer 上的清理监听(closeRecord 时摘除,防累积)。 */
  detach?: () => void
}

const previews = new Map<string, RailPreviewRecord>()
const tokens = new Map<string, RailPreviewRecord>()

function recordBlocked(record: RailPreviewRecord, entry: string) {
  if (record.blockedPaths.length >= HTML_PREVIEW_MAX_BLOCKED_ENTRIES) return
  if (!record.blockedPaths.includes(entry)) record.blockedPaths.push(entry)
}

function safeOrigin(rawUrl: string): string {
  try {
    return new URL(rawUrl).origin
  } catch {
    return "invalid-url"
  }
}

// ---- 静态服务(协议 handler)----

function deny(status = 404, body = "Not found"): Response {
  return new Response(body, { status, headers: { ...BASE_HEADERS, "Content-Security-Policy": HTML_PREVIEW_CSP } })
}

function serveRequest(record: RailPreviewRecord, request: Request): Response {
  if (record.closed || tokens.get(record.token) !== record) return deny()
  if (request.method !== "GET" && request.method !== "HEAD") return deny(405, "Method not allowed")
  let url: URL
  try {
    url = new URL(request.url)
  } catch {
    return deny()
  }
  if (url.protocol !== `${HTML_PREVIEW_SCHEME}:` || url.hostname !== record.token) return deny()
  let pathname: string
  try {
    pathname = decodeURIComponent(url.pathname)
  } catch {
    return deny()
  }
  const rel = pathname.replace(/^\/+/, "")

  if (rel === record.rootRelPath) {
    // 根文档:身份/圈禁重证 + 尺寸复核(盘上被换即拒,不静默换内容)。
    const resolved = resolveWorkspaceFile(record.workspaceDir, rel)
    if (!resolved.ok) {
      recordBlocked(record, rel)
      return deny()
    }
    if (resolved.file.size !== record.rootBytes) {
      writeLog("rail-preview", "root document changed on disk", { previewId: record.previewId }, "warn")
      return deny(409, "File changed on disk")
    }
    const contentType = record.kind === "pdf" ? "application/pdf" : "text/html; charset=utf-8"
    const headers: Record<string, string> = { ...BASE_HEADERS, "Content-Type": contentType }
    // CSP 只对 HTML 文档注入(见文件头:`sandbox` 指令会禁掉 PDF viewer 插件)。
    if (record.kind === "html") headers["Content-Security-Policy"] = HTML_PREVIEW_CSP
    let bytes: Buffer
    try {
      bytes = fs.readFileSync(resolved.file.abs)
    } catch {
      return deny()
    }
    return new Response(new Uint8Array(bytes), { status: 200, headers })
  }

  // sibling 资产:仅 html 载体、仅图片/字体白名单(与既有 host 同一份表)、同 workspace 圈禁。
  if (record.kind !== "html") {
    recordBlocked(record, rel || "/")
    return deny(403, "Blocked by preview policy")
  }
  const ext = path.posix.extname(rel).slice(1).toLowerCase()
  const mime = ASSET_MIME[ext]
  if (!mime) {
    recordBlocked(record, rel || "/")
    writeLog("rail-preview", "blocked asset", { previewId: record.previewId, path: rel }, "warn")
    return deny(403, "Blocked by preview policy")
  }
  const resolved = resolveWorkspaceFile(record.workspaceDir, rel)
  if (!resolved.ok) {
    recordBlocked(record, rel)
    return deny()
  }
  if (resolved.file.size > HTML_PREVIEW_MAX_ASSET_BYTES) {
    recordBlocked(record, rel)
    return deny()
  }
  let bytes: Buffer
  try {
    bytes = fs.readFileSync(resolved.file.abs)
  } catch {
    return deny()
  }
  return new Response(new Uint8Array(bytes), {
    status: 200,
    headers: { ...BASE_HEADERS, "Content-Security-Policy": HTML_PREVIEW_CSP, "Content-Type": mime },
  })
}

// ---- session / webContents 硬化(逐条对齐 html-preview-host,AC3)----

function hardenSession(ses: Session, record: RailPreviewRecord) {
  ses.setPermissionRequestHandler((_wc, _permission, callback) => callback(false))
  ses.setPermissionCheckHandler(() => false)
  if (typeof ses.setDevicePermissionHandler === "function") ses.setDevicePermissionHandler(() => false)
  // pdf 工具栏已整条移除;这里是「任何形式的下载都异常」的 fail-closed 兜底。
  ses.on("will-download", (event) => {
    event.preventDefault()
    recordBlocked(record, "download")
    writeLog("rail-preview", "blocked download", { previewId: record.previewId }, "warn")
  })
  ses.webRequest.onBeforeRequest((details, callback) => {
    const allowed =
      details.url.startsWith(`${HTML_PREVIEW_SCHEME}://`) ||
      (!electronRef.app.isPackaged && details.url.startsWith("devtools://")) ||
      // Chromium PDF viewer 自身以 chrome-extension:// 装载(mhjfbmdgcfjbbpaeojofohoefgiehjai),
      // 它的界面又整个由 chrome://resources/ 下的 Lit / mojo / cr_elements 拼出来
      // (#1227 实测被拦的五条:text_defaults_md.css、lit.rollup.js、load_time_data.js、
      // mojo/public/js/bindings.js、cr_a11y_announcer.css)。两者都是编译进 Chromium 的静态
      // 资源,不是文档能发起的外网面;拦掉任一条 = PDF 载体整个不工作(黑屏,且不报错)。
      (record.kind === "pdf" &&
        (details.url.startsWith("chrome-extension://") || details.url.startsWith("chrome://resources/")))
    if (!allowed) {
      recordBlocked(record, safeOrigin(details.url))
      writeLog("rail-preview", "blocked request", { previewId: record.previewId, target: safeOrigin(details.url) }, "warn")
    }
    callback({ cancel: !allowed })
  })
  ses.protocol.handle(HTML_PREVIEW_SCHEME, (request) => serveRequest(record, request))
}

function hardenViewContents(record: RailPreviewRecord) {
  const wc = record.view.webContents
  wc.setWindowOpenHandler(() => ({ action: "deny" as const }))
  wc.on("will-navigate", (event: ElectronEvent) => event.preventDefault())
  wc.on("will-redirect", (event: ElectronEvent) => event.preventDefault())
  wc.on("will-attach-webview", (event: ElectronEvent) => event.preventDefault())
  // 拦 Cmd/Ctrl+P(打印)与 Cmd/Ctrl+S(保存)—— owner 裁决:viewer 的下载/打印通路全关。
  wc.on("before-input-event", (event: ElectronEvent, input: Input) => {
    if (!input.meta && !input.control) return
    const key = (input.key ?? "").toLowerCase()
    if (key === "p" || key === "s") event.preventDefault()
  })
  wc.on("render-process-gone", (_event: ElectronEvent, details: RenderProcessGoneDetails) => {
    writeLog(
      "rail-preview",
      "preview renderer gone",
      { previewId: record.previewId, reason: details?.reason ?? "unknown" },
      "error",
    )
    closeRecord(record, "crashed")
  })
}

// ---- 生命周期 ----

function closeRecord(record: RailPreviewRecord, reason: RailPreviewCloseReason) {
  if (record.closed) return
  record.closed = true
  tokens.delete(record.token)
  previews.delete(record.previewId)
  try {
    record.ses.protocol.unhandle(HTML_PREVIEW_SCHEME)
  } catch {
    // handler 已不在 —— 幂等
  }
  try {
    void record.ses
      .clearStorageData()
      .catch(() => {})
      .finally(() => removePartitionDir(record.partition))
  } catch {
    // best-effort —— 目录仍要试着收掉
    removePartitionDir(record.partition)
  }
  try {
    if (!record.win.isDestroyed()) record.win.contentView.removeChildView(record.view)
  } catch {
    // 窗口已销毁 —— 幂等
  }
  try {
    if (!record.view.webContents.isDestroyed()) record.view.webContents.close()
  } catch {
    // webContents 已关闭 —— 幂等
  }
  try {
    record.detach?.()
  } catch {
    // 宿主已销毁 —— 幂等
  }
  if (!record.sender.isDestroyed()) {
    const event: RailPreviewClosedEvent = { previewId: record.previewId, reason }
    record.sender.send("rail-preview-closed", event)
  }
  writeLog("rail-preview", "closed", { previewId: record.previewId, reason })
}

function sanitizeBounds(bounds: RailPreviewBounds): RailPreviewBounds | null {
  const nums = [bounds?.x, bounds?.y, bounds?.width, bounds?.height]
  if (nums.some((n) => typeof n !== "number" || !Number.isFinite(n))) return null
  return {
    x: Math.max(0, Math.round(bounds.x)),
    y: Math.max(0, Math.round(bounds.y)),
    width: Math.max(0, Math.round(bounds.width)),
    height: Math.max(0, Math.round(bounds.height)),
  }
}

/**
 * 打开一个右栏叠放预览。守卫全过才建 view(loud 拒绝,绝不带病叠放):
 * workspace 圈禁 + symlink/目录拒 + 32MB 预算;每个 sender 至多一个(唯一 preview surface,
 * 新开自动替换旧的)。成功只返回 opaque previewId —— token/URL 不过 IPC。
 */
export function openRailPreview(
  sender: WebContents,
  workspaceDir: string,
  relPath: string,
  kind: RailPreviewKind,
  bounds: RailPreviewBounds,
): RailPreviewOpenResult {
  const refuse = (code: FileViewerRefusal): RailPreviewOpenResult => {
    writeLog("rail-preview", "open refused", { kind, code }, "warn")
    return { ok: false, code }
  }
  const win = electronRef.BrowserWindow.fromWebContents(sender)
  if (!win) return refuse("read-failed")
  const box = sanitizeBounds(bounds)
  if (!box) return refuse("read-failed")

  const resolved = resolveWorkspaceFile(workspaceDir, relPath)
  if (!resolved.ok) return refuse(resolved.code)
  if (resolved.file.size > FILE_VIEWER_DOC_MAX_BYTES) return refuse("too-large")

  // 唯一右栏 preview surface:同一 renderer 的旧叠放先销毁(reason=replaced)。
  for (const record of [...previews.values()]) if (record.sender === sender) closeRecord(record, "replaced")

  const token = crypto.randomBytes(16).toString("hex")
  const previewId = `rp_${crypto.randomBytes(6).toString("hex")}`
  const partition = `${RAIL_PREVIEW_PARTITION_PREFIX}${previewId}`
  const ses = electronRef.session.fromPartition(partition)

  const record: RailPreviewRecord = {
    previewId,
    token,
    kind,
    workspaceDir,
    rootRelPath: relPath,
    rootBytes: resolved.file.size,
    partition,
    ses,
    view: undefined as unknown as WebContentsViewT, // 紧随其后赋值(hardenSession 只用 ses/previewId)
    win,
    sender,
    closed: false,
    blockedPaths: [],
  }
  hardenSession(ses, record)

  const view = new electronRef.WebContentsView({
    webPreferences: {
      partition,
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
      nodeIntegrationInWorker: false,
      nodeIntegrationInSubFrames: false,
      webviewTag: false,
      devTools: !electronRef.app.isPackaged,
      disableDialogs: true,
      safeDialogs: true,
      spellcheck: false,
      // plugins 只开在 pdf 载体的这个 view 上(内置 Chromium PDF viewer);主窗口不动。
      plugins: kind === "pdf",
      // ⚠️ 刻意无 preload —— 与 html-preview-host 同一条铁律:预览上下文零 Alpha bridge。
    },
  })
  record.view = view
  hardenViewContents(record)

  win.contentView.addChildView(view)
  view.setBounds(box)
  const onHostGone = () => closeRecord(record, "closed")
  win.once("closed", onHostGone)
  sender.once("destroyed", onHostGone)
  record.detach = () => {
    win.removeListener("closed", onHostGone)
    sender.removeListener("destroyed", onHostGone)
  }

  previews.set(previewId, record)
  tokens.set(token, record)

  const encodedPath = relPath.split("/").map(encodeURIComponent).join("/")
  const fragment = kind === "pdf" ? "#toolbar=0" : ""
  void Promise.resolve(view.webContents.loadURL(`${HTML_PREVIEW_SCHEME}://${token}/${encodedPath}${fragment}`)).catch(
    (error) => {
      writeLog("rail-preview", "load failed", { previewId, code: (error as { errno?: number })?.errno ?? -1 }, "error")
    },
  )
  writeLog("rail-preview", "opened", { previewId, kind })
  return { ok: true, previewId }
}

export function setRailPreviewBounds(previewId: string, bounds: RailPreviewBounds): { ok: boolean } {
  const record = previews.get(previewId)
  const box = sanitizeBounds(bounds)
  if (!record || record.closed || !box) return { ok: false }
  record.view.setBounds(box)
  return { ok: true }
}

/** 遮挡合同的执行面:强模态期间 renderer 要求隐藏(不销毁),模态关闭后恢复。 */
export function setRailPreviewVisible(previewId: string, visible: boolean): { ok: boolean } {
  const record = previews.get(previewId)
  if (!record || record.closed) return { ok: false }
  record.view.setVisible(visible === true)
  return { ok: true }
}

export function closeRailPreview(previewId: string): { ok: boolean } {
  const record = previews.get(previewId)
  if (!record) return { ok: false }
  closeRecord(record, "closed")
  return { ok: true }
}

export function railPreviewStatus(previewId: string): RailPreviewStatus {
  const record = previews.get(previewId)
  if (!record) return { ok: false, reason: "unknown or closed preview" }
  return { ok: true, previewId, open: !record.closed, blockedPaths: [...record.blockedPaths] }
}

export function closeAllRailPreviews() {
  for (const record of [...previews.values()]) closeRecord(record, "shutdown")
}

// ---- IPC ----

const str = (v: unknown): v is string => typeof v === "string" && v.length > 0

export function registerRailPreviewIpcHandlers() {
  electronRef.ipcMain.handle(
    "rail-preview-open",
    (e: IpcMainInvokeEvent, dir: unknown, rel: unknown, kind: unknown, bounds: unknown) =>
      str(dir) && str(rel) && (kind === "html" || kind === "pdf")
        ? openRailPreview(e.sender, dir, rel, kind, bounds as RailPreviewBounds)
        : ({ ok: false, code: "invalid-path" } satisfies RailPreviewOpenResult),
  )
  electronRef.ipcMain.handle("rail-preview-set-bounds", (_e: IpcMainInvokeEvent, previewId: unknown, bounds: unknown) =>
    str(previewId) ? setRailPreviewBounds(previewId, bounds as RailPreviewBounds) : { ok: false as const },
  )
  electronRef.ipcMain.handle(
    "rail-preview-set-visible",
    (_e: IpcMainInvokeEvent, previewId: unknown, visible: unknown) =>
      str(previewId) ? setRailPreviewVisible(previewId, visible === true) : { ok: false as const },
  )
  electronRef.ipcMain.handle("rail-preview-close", (_e: IpcMainInvokeEvent, previewId: unknown) =>
    str(previewId) ? closeRailPreview(previewId) : { ok: false as const },
  )
  electronRef.ipcMain.handle("rail-preview-status", (_e: IpcMainInvokeEvent, previewId: unknown) =>
    str(previewId) ? railPreviewStatus(previewId) : ({ ok: false, reason: "invalid arguments" } satisfies RailPreviewStatus),
  )
}
