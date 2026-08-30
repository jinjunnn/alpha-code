// REQ-096(alpha-code#188)—— 隔离 HTML Artifact Preview:main-owned 一次性静态 host。
//
// Host 机制取「session 级自定义协议」而非 127.0.0.1 loopback http server,理由:
//   · loopback 端口是全机可达的网络面(任何本地进程可探测/竞争),token 只能事后补救;
//     session 级 `ses.protocol.handle` 只在该预览的一次性 partition 内可解析 —— 主 renderer
//     乃至任何其他 webContents 根本无法寻址,天然零网络面;
//   · 主窗口 CSP/CORS 对 loopback 是放行的(renderer-security.ts),loopback URL 一旦泄漏
//     到主 renderer 即可被 fetch;自定义协议对主窗口 session 不存在,泄漏也打不通;
//   · REQ-096 交付 3 点名「由 ArtifactService 提供的 blob:/自定义协议图片和字体」—— 文档口径
//     即自定义协议。
//
// 隔离矩阵(每个预览):
//   · 进程:独立 BrowserWindow,sandbox=true + contextIsolation=true + nodeIntegration=false,
//     **无 preload**(零 window.api / 零 Alpha bridge,AC#3/#7);
//   · session:随机一次性 in-memory partition(无 persist: 前缀),权限 request/check/device
//     全 deny,will-download 拦截,webRequest 默认拒绝一切非本协议请求(零外网,AC#2);
//   · 内容:协议 handler 只服务经 manifest + ADR-019 守卫验证过的 run 内文件 —— 根文档 +
//     同 run artifacts/ 内图片/字体白名单;每个响应注入静态 CSP(shared/html-preview.ts);
//   · 生命周期:一次性 —— 关闭/崩溃/销毁即拆 token、unhandle 协议、清 partition 存储;
//     token/URL 只存在于 main 内存与 loadURL 调用,不过 IPC、不进日志(AC 零泄漏)。
//
// REQ-096 交付 5 的成熟 sanitizer/独立 worker 净化是纵深防御的追加层,不在本文件(安全性
// 不依赖 sanitizer 单点 —— 进程/CSP/协议/网络策略已独立成立);见 issue #188 交付说明。

import * as crypto from "node:crypto"
import * as fs from "node:fs"
import * as path from "node:path"
// bun mock.module 跨测试文件泄漏(Linux 执行顺序下他文件的 electron mock 缺 session/
// BrowserWindow)—— electron 面走依赖注入:默认转发真模块,测试经 __setHtmlPreviewElectron
// 确定性注入 fake(与日志 sink 同款纪律)。
import * as electronNs from "electron"
type ElectronFacade = Pick<typeof electronNs, "app" | "BrowserWindow" | "ipcMain" | "session">
let electronRef: ElectronFacade = electronNs
export function __setHtmlPreviewElectron(e: ElectronFacade | null) {
  electronRef = e ?? electronNs
}
import type { BrowserWindow as BrowserWindowT, Event as ElectronEvent, IpcMainInvokeEvent, RenderProcessGoneDetails, Session, WebContents } from "electron"
// bun mock.module 跨测试文件泄漏(Linux 执行顺序下他文件的 ./logging mock 缺 write 导出),
// 故日志走依赖注入:默认防御式转发真模块,测试经 __setHtmlPreviewLogSink 确定性捕获。
import * as logging from "./logging"
type HtmlPreviewLogFn = (name: string, message: string, extra?: Record<string, unknown>, level?: string) => void
const defaultLogSink: HtmlPreviewLogFn = (...args) => {
  const w = (logging as { write?: HtmlPreviewLogFn }).write
  if (typeof w === "function") w(...args)
}
let writeLog: HtmlPreviewLogFn = defaultLogSink
export function __setHtmlPreviewLogSink(fn: HtmlPreviewLogFn | null) {
  writeLog = fn ?? defaultLogSink
}
import { resolveArtifact } from "./artifact-service"
import { isSafeSavedPath, RUN_ARTIFACTS_SUBDIR } from "./artifact-manifest"
import { safeResolveInAlpha, sanitizeArtifactName } from "./alpha-workdir"
import {
  canPreviewHtml,
  HTML_PREVIEW_CSP,
  HTML_PREVIEW_MAX_BLOCKED_ENTRIES,
  HTML_PREVIEW_MAX_CONCURRENT,
  HTML_PREVIEW_SCHEME,
  type HtmlPreviewClosedEvent,
  type HtmlPreviewCloseReason,
  type HtmlPreviewOpenResult,
  type HtmlPreviewStatus,
} from "../shared/html-preview"

// ---- 预算与白名单 ----

/** 根文档字节预算(REQ-096 AC#5 内存预算的前置闸;超限礼貌拒绝,不 buffer)。 */
export const HTML_PREVIEW_MAX_DOC_BYTES = 32 * 1024 * 1024
/** 单个 sibling 资产字节预算。 */
export const HTML_PREVIEW_MAX_ASSET_BYTES = 32 * 1024 * 1024
// 仅图片/字体可作 sibling 资产(REQ-096 交付 3 的白名单口径;CSS 走 inline style,外链 CSS/JS/
// 子 html 一律 403)。SVG 只能经 <img> 进入(CSP img-src),SVG-as-image 按规范不执行脚本。
// REQ-108(#244):rail-preview-host 复用同一份白名单(sibling 资产口径只此一份真源)。
export const ASSET_MIME: Record<string, string> = {
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  gif: "image/gif",
  webp: "image/webp",
  avif: "image/avif",
  bmp: "image/bmp",
  ico: "image/x-icon",
  svg: "image/svg+xml",
  woff: "font/woff",
  woff2: "font/woff2",
  ttf: "font/ttf",
  otf: "font/otf",
}

const BASE_HEADERS: Record<string, string> = {
  "Content-Security-Policy": HTML_PREVIEW_CSP,
  "X-Content-Type-Options": "nosniff",
  "Referrer-Policy": "no-referrer",
  "Cache-Control": "no-store",
}

// ---- 预览注册表(main 内存;token 永不出本模块)----

type PreviewRecord = {
  previewId: string
  /** 一次性 host token(协议 URL 的 host 段)。只出现在 loadURL 与本表,不过 IPC、不进日志。 */
  token: string
  projectDir: string
  runId: string
  artifactId: string
  /** savedPath 去掉 `artifacts/` 前缀后的 URL 命名空间路径(相对引用在 artifacts/ 内自然解析)。 */
  rootRelPath: string
  /** 打开时刻的根文档字节数 —— 服务时复核,盘上被换即拒(swap 防线)。 */
  rootBytes: number
  partition: string
  ses: Session
  win: BrowserWindowT
  sender?: WebContents
  closed: boolean
  blockedPaths: string[]
}

const previews = new Map<string, PreviewRecord>()
const tokens = new Map<string, PreviewRecord>()

function recordBlocked(record: PreviewRecord, entry: string) {
  if (record.blockedPaths.length >= HTML_PREVIEW_MAX_BLOCKED_ENTRIES) return
  if (!record.blockedPaths.includes(entry)) record.blockedPaths.push(entry)
}

/** 外部请求只留 origin 供诊断(不留 path/query —— 不给不可信文档经日志/状态面外带数据的机会)。 */
function safeOrigin(rawUrl: string): string {
  try {
    return new URL(rawUrl).origin
  } catch {
    return "invalid-url"
  }
}

// ---- 静态服务(协议 handler;只认 GET/HEAD + 活 token + 守卫内路径)----

function deny(status = 404, body = "Not found"): Response {
  return new Response(body, { status, headers: BASE_HEADERS })
}

function serveRequest(record: PreviewRecord, request: Request): Response {
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
  // 复用 manifest 的 savedPath 不变量(无 ../. 段、无 dotfile、无反斜杠/控制字符/绝对形态)。
  const saved = `${RUN_ARTIFACTS_SUBDIR}/${rel}`
  if (!isSafeSavedPath(saved)) {
    recordBlocked(record, rel || "/")
    return deny()
  }
  // ADR-019 realpath 守卫:symlink 逃逸 / .code-puppy 外解析在此被拒。
  const abs = safeResolveInAlpha(record.projectDir, "runs", record.runId, ...saved.split("/"))
  if (!abs) {
    recordBlocked(record, rel)
    return deny()
  }

  if (rel === record.rootRelPath) {
    let st: fs.Stats
    try {
      st = fs.lstatSync(abs)
    } catch {
      return deny()
    }
    if (!st.isFile() || st.size !== record.rootBytes) {
      writeLog("html-preview", "root document changed on disk", { previewId: record.previewId }, "warn")
      return deny(409, "Artifact changed on disk")
    }
    return new Response(new Uint8Array(fs.readFileSync(abs)), {
      status: 200,
      headers: { ...BASE_HEADERS, "Content-Type": "text/html; charset=utf-8" },
    })
  }

  const ext = path.posix.extname(rel).slice(1).toLowerCase()
  const mime = ASSET_MIME[ext]
  if (!mime) {
    recordBlocked(record, rel)
    writeLog("html-preview", "blocked asset", { previewId: record.previewId, path: rel }, "warn")
    return deny(403, "Blocked by preview policy")
  }
  let st: fs.Stats
  try {
    st = fs.lstatSync(abs)
  } catch {
    return deny()
  }
  if (!st.isFile() || st.size > HTML_PREVIEW_MAX_ASSET_BYTES) {
    recordBlocked(record, rel)
    return deny()
  }
  return new Response(new Uint8Array(fs.readFileSync(abs)), {
    status: 200,
    headers: { ...BASE_HEADERS, "Content-Type": mime },
  })
}

// ---- session / window 硬化 ----

function hardenSession(ses: Session, record: PreviewRecord) {
  ses.setPermissionRequestHandler((_wc, _permission, callback) => callback(false))
  ses.setPermissionCheckHandler(() => false)
  if (typeof ses.setDevicePermissionHandler === "function") ses.setDevicePermissionHandler(() => false)
  ses.on("will-download", (event) => event.preventDefault())
  // 默认零网络:该 partition 上除本协议(+ dev 态 devtools 前端)以外的一切请求直接 cancel。
  ses.webRequest.onBeforeRequest((details, callback) => {
    const allowed =
      details.url.startsWith(`${HTML_PREVIEW_SCHEME}://`) || (!electronRef.app.isPackaged && details.url.startsWith("devtools://"))
    if (!allowed) {
      recordBlocked(record, safeOrigin(details.url))
      writeLog("html-preview", "blocked request", { previewId: record.previewId, target: safeOrigin(details.url) }, "warn")
    }
    callback({ cancel: !allowed })
  })
  ses.protocol.handle(HTML_PREVIEW_SCHEME, (request) => serveRequest(record, request))
}

function hardenWebContents(record: PreviewRecord) {
  const wc = record.win.webContents
  wc.setWindowOpenHandler(() => ({ action: "deny" as const }))
  // loadURL 程序化导航不触发 will-navigate —— 文档内发起的一切导航/重定向/子 frame 导航全拒。
  wc.on("will-navigate", (event: ElectronEvent) => event.preventDefault())
  wc.on("will-redirect", (event: ElectronEvent) => event.preventDefault())
  wc.on("will-frame-navigate", (event: ElectronEvent) => event.preventDefault())
  wc.on("will-attach-webview", (event: ElectronEvent) => event.preventDefault())
  wc.on("render-process-gone", (_event: ElectronEvent, details: RenderProcessGoneDetails) => {
    writeLog(
      "html-preview",
      "preview renderer gone",
      { previewId: record.previewId, reason: details?.reason ?? "unknown" },
      "error",
    )
    closeRecord(record, "crashed")
  })
}

// ---- 生命周期 ----

function closeRecord(record: PreviewRecord, reason: HtmlPreviewCloseReason) {
  if (record.closed) return
  record.closed = true
  tokens.delete(record.token)
  previews.delete(record.previewId)
  try {
    record.ses.protocol.unhandle(HTML_PREVIEW_SCHEME)
  } catch {
    // handler 已不在(session 提前销毁)—— 幂等
  }
  try {
    void record.ses.clearStorageData().catch(() => {})
  } catch {
    // best-effort:in-memory partition 随引用消失
  }
  if (!record.win.isDestroyed()) record.win.destroy()
  if (record.sender && !record.sender.isDestroyed()) {
    const event: HtmlPreviewClosedEvent = { previewId: record.previewId, reason }
    record.sender.send("html-preview-closed", event)
  }
  writeLog("html-preview", "closed", { previewId: record.previewId, reason })
}

export type OpenHtmlPreviewOptions = {
  /** 发起预览的 renderer(关闭/崩溃时回推 html-preview-closed)。 */
  sender?: WebContents
  /** 测试注入:根文档字节预算覆盖。 */
  maxDocBytes?: number
}

/**
 * 打开一个隔离 HTML 预览。入口守卫(全部 loud 拒绝,绝不带病开窗):
 *   manifest 已登记 + reconcile 态非 missing/mismatch + canPreviewHtml + ADR-019 路径守卫 +
 *   常规文件(lstat,symlink 拒)+ 字节预算 + 并发上限。
 * 成功只返回 opaque previewId —— 一次性 URL/token 永不离开 main。
 */
export function openHtmlPreview(
  projectDir: string,
  runId: string,
  artifactId: string,
  opts: OpenHtmlPreviewOptions = {},
): HtmlPreviewOpenResult {
  const refuse = (reason: string): HtmlPreviewOpenResult => {
    writeLog("html-preview", "open refused", { runId, artifactId, reason }, "warn")
    return { ok: false, reason }
  }
  if (previews.size >= HTML_PREVIEW_MAX_CONCURRENT)
    return refuse(`preview limit reached (${HTML_PREVIEW_MAX_CONCURRENT} open); close one first`)

  const resolved = resolveArtifact(projectDir, runId, artifactId)
  if (!resolved.ok) return refuse(resolved.reason)
  const entry = resolved.entry
  if (entry.local.state === "missing" || entry.local.state === "mismatch")
    return refuse(`artifact state is ${entry.local.state}; preview refused`)
  if (!isSafeSavedPath(entry.local.savedPath)) return refuse("savedPath violates the relative-path invariant")
  if (!canPreviewHtml(entry.descriptor, entry.local.detectedMime))
    return refuse("artifact is not previewable static HTML")
  const abs = safeResolveInAlpha(projectDir, "runs", runId, ...entry.local.savedPath.split("/"))
  if (!abs) return refuse("path escapes .code-puppy")
  let st: fs.Stats
  try {
    st = fs.lstatSync(abs)
  } catch {
    return refuse("file not found on disk")
  }
  if (!st.isFile()) return refuse("savedPath is not a regular file")
  const maxDoc = opts.maxDocBytes ?? HTML_PREVIEW_MAX_DOC_BYTES
  if (st.size > maxDoc) return refuse(`document exceeds preview budget (${st.size} > ${maxDoc} bytes)`)

  const token = crypto.randomBytes(16).toString("hex")
  const previewId = `hp_${crypto.randomBytes(6).toString("hex")}`
  // 一次性 in-memory partition(无 persist: 前缀);名字用 previewId 派生,不含 token。
  const partition = `alpha-html-preview-${previewId}`
  const ses = electronRef.session.fromPartition(partition)

  const record: PreviewRecord = {
    previewId,
    token,
    projectDir,
    runId,
    artifactId,
    rootRelPath: entry.local.savedPath.slice(`${RUN_ARTIFACTS_SUBDIR}/`.length),
    rootBytes: st.size,
    partition,
    ses,
    win: undefined as unknown as BrowserWindowT, // 紧随其后赋值(hardenSession 只用 ses/previewId)
    sender: opts.sender,
    closed: false,
    blockedPaths: [],
  }
  hardenSession(ses, record)

  const win = new electronRef.BrowserWindow({
    width: 1024,
    height: 768,
    show: true,
    autoHideMenuBar: true,
    title: `隔离预览 — ${sanitizeArtifactName(entry.descriptor.name, "artifact")}`,
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
      // ⚠️ 刻意无 preload —— REQ-096 AC#3/#7:preview 上下文零 Alpha bridge;代码审查门禁止
      // 给 HtmlPreviewHost 配置 preload。
    },
  })
  record.win = win
  hardenWebContents(record)
  win.on("closed", () => closeRecord(record, "closed"))

  previews.set(previewId, record)
  tokens.set(token, record)

  const encodedPath = record.rootRelPath.split("/").map(encodeURIComponent).join("/")
  // 失败日志只留错误码 —— loadURL 错误对象内嵌完整 URL(含 token),绝不整只入日志。
  void Promise.resolve(win.loadURL(`${HTML_PREVIEW_SCHEME}://${token}/${encodedPath}`)).catch((error) => {
    writeLog(
      "html-preview",
      "load failed",
      { previewId, code: (error as { errno?: number })?.errno ?? -1 },
      "error",
    )
  })
  writeLog("html-preview", "opened", { previewId, runId, artifactId })
  return { ok: true, previewId }
}

/** 关闭一个预览(幂等;窗口销毁 → token 失效 → partition 清空)。 */
export function closeHtmlPreview(previewId: string): { ok: boolean } {
  const record = previews.get(previewId)
  if (!record) return { ok: false }
  closeRecord(record, "closed")
  return { ok: true }
}

/** 只读状态(存活性 + 被阻止资源清单)。已关闭/未知 id 一律 ok:false —— 一次性语义,无残留可查。 */
export function htmlPreviewStatus(previewId: string): HtmlPreviewStatus {
  const record = previews.get(previewId)
  if (!record) return { ok: false, reason: "unknown or closed preview" }
  return { ok: true, previewId, open: !record.closed, blockedPaths: [...record.blockedPaths] }
}

/** 全量关闭(应用退出/测试收尾)。 */
export function closeAllHtmlPreviews() {
  for (const record of [...previews.values()]) closeRecord(record, "shutdown")
}

// ---- IPC(renderer 控制通道;artifact-ipc.ts 同风格薄 wiring)----

const str = (v: unknown): v is string => typeof v === "string" && v.length > 0

export function registerHtmlPreviewIpcHandlers() {
  electronRef.ipcMain.handle("html-preview-open", (e: IpcMainInvokeEvent, directory: unknown, runId: unknown, artifactId: unknown) =>
    str(directory) && str(runId) && str(artifactId)
      ? openHtmlPreview(directory, runId, artifactId, { sender: e.sender })
      : ({ ok: false, reason: "invalid arguments" } satisfies HtmlPreviewOpenResult),
  )
  electronRef.ipcMain.handle("html-preview-close", (_e: IpcMainInvokeEvent, previewId: unknown) =>
    str(previewId) ? closeHtmlPreview(previewId) : { ok: false as const },
  )
  electronRef.ipcMain.handle("html-preview-status", (_e: IpcMainInvokeEvent, previewId: unknown) =>
    str(previewId)
      ? htmlPreviewStatus(previewId)
      : ({ ok: false, reason: "invalid arguments" } satisfies HtmlPreviewStatus),
  )
}
