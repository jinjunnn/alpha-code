// REQ-096(#188):隔离 HTML preview host 单测(electron 打桩,alpha-surfaces.test.ts 同款)。
// 契约:守卫拒绝(escape/未登记/missing/mismatch/非 HTML/预算)、一次性 token 失效、
// window/session 硬化选项(sandbox/partition/无 preload/权限全拒/webRequest 拦截/导航全拒)、
// 静态 CSP 注入、并发上限、关闭/崩溃清理、日志与 IPC 零 token/URL 泄漏。

import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test"
import * as fs from "node:fs"
import * as os from "node:os"
import * as path from "node:path"

// ---- electron 打桩(捕获式 fake;须在 import 被测模块之前)----

class FakeSession {
  partition: string
  permissionRequestHandler: ((wc: unknown, p: string, cb: (ok: boolean) => void) => void) | null = null
  permissionCheckHandler: (() => boolean) | null = null
  devicePermissionHandler: (() => boolean) | null = null
  beforeRequestHandler:
    | ((details: { url: string }, cb: (r: { cancel: boolean }) => void) => void)
    | null = null
  listeners = new Map<string, Array<(...args: unknown[]) => void>>()
  clearCalls = 0
  protocolHandlers = new Map<string, (request: Request) => Response | Promise<Response>>()
  unhandled: string[] = []
  protocol = {
    handle: (scheme: string, h: (request: Request) => Response | Promise<Response>) => {
      this.protocolHandlers.set(scheme, h)
    },
    unhandle: (scheme: string) => {
      this.protocolHandlers.delete(scheme)
      this.unhandled.push(scheme)
    },
  }
  webRequest = {
    onBeforeRequest: (h: (details: { url: string }, cb: (r: { cancel: boolean }) => void) => void) => {
      this.beforeRequestHandler = h
    },
  }
  constructor(partition: string) {
    this.partition = partition
  }
  setPermissionRequestHandler(h: (wc: unknown, p: string, cb: (ok: boolean) => void) => void) {
    this.permissionRequestHandler = h
  }
  setPermissionCheckHandler(h: () => boolean) {
    this.permissionCheckHandler = h
  }
  setDevicePermissionHandler(h: () => boolean) {
    this.devicePermissionHandler = h
  }
  on(event: string, h: (...args: unknown[]) => void) {
    const list = this.listeners.get(event) ?? []
    list.push(h)
    this.listeners.set(event, list)
  }
  clearStorageData() {
    this.clearCalls++
    return Promise.resolve()
  }
}

class FakeWebContents {
  handlers = new Map<string, Array<(...args: unknown[]) => void>>()
  windowOpenHandler: (() => { action: string }) | null = null
  constructor(public win: FakeBrowserWindow) {}
  on(event: string, h: (...args: unknown[]) => void) {
    const list = this.handlers.get(event) ?? []
    list.push(h)
    this.handlers.set(event, list)
  }
  setWindowOpenHandler(h: () => { action: string }) {
    this.windowOpenHandler = h
  }
  isDestroyed() {
    return this.win.destroyed
  }
}

class FakeBrowserWindow {
  static instances: FakeBrowserWindow[] = []
  opts: { webPreferences: Record<string, unknown> } & Record<string, unknown>
  webContents: FakeWebContents
  loadedUrls: string[] = []
  closedHandlers: Array<() => void> = []
  destroyed = false
  constructor(opts: { webPreferences: Record<string, unknown> } & Record<string, unknown>) {
    this.opts = opts
    this.webContents = new FakeWebContents(this)
    FakeBrowserWindow.instances.push(this)
  }
  loadURL(url: string) {
    this.loadedUrls.push(url)
    return Promise.resolve()
  }
  on(event: string, h: () => void) {
    if (event === "closed") this.closedHandlers.push(h)
  }
  isDestroyed() {
    return this.destroyed
  }
  destroy() {
    if (this.destroyed) return
    this.destroyed = true
    for (const h of [...this.closedHandlers]) h()
  }
}

const appState = { packaged: false }
const sessions: FakeSession[] = []
const ipcHandlers = new Map<string, (...args: unknown[]) => unknown>()
const logLines: string[] = []

mock.module("electron", () => ({
  app: {
    get isPackaged() {
      return appState.packaged
    },
  },
  BrowserWindow: FakeBrowserWindow,
  dialog: {},
  session: {
    fromPartition: (partition: string) => {
      const ses = new FakeSession(partition)
      sessions.push(ses)
      return ses
    },
  },
  ipcMain: {
    handle: (channel: string, handler: (...args: unknown[]) => unknown) => {
      ipcHandlers.set(channel, handler)
    },
  },
  utilityProcess: {
    fork: () => {
      throw new Error("unexpected utilityProcess.fork")
    },
  },
}))
mock.module("./logging", () => ({
  write: (name: string, message: string, extra?: Record<string, unknown>, level?: string) => {
    logLines.push(JSON.stringify([name, message, extra ?? {}, level ?? "info"]))
  },
  getLogger: () => undefined,
  rotateServerLogs: () => {},
}))

const {
  closeAllHtmlPreviews,
  closeHtmlPreview,
  htmlPreviewStatus,
  openHtmlPreview,
  registerHtmlPreviewIpcHandlers,
  __setHtmlPreviewLogSink,
  __setHtmlPreviewElectron,
} = await import("./html-preview-host")
const { registerDownloadedArtifact } = await import("./artifact-service")
const { deriveArtifactDescriptors } = await import("../shared/cloud-artifact-descriptor")
const { HTML_PREVIEW_CSP, HTML_PREVIEW_MAX_CONCURRENT, HTML_PREVIEW_SCHEME } = await import("../shared/html-preview")

// electron 面确定性注入(同款纪律;mock.module 保留以兜 import 期)
__setHtmlPreviewElectron({
  app: {
    get isPackaged() {
      return appState.packaged
    },
  },
  BrowserWindow: FakeBrowserWindow,
  session: {
    fromPartition: (partition) => {
      const ses = new FakeSession(partition)
      sessions.push(ses)
      return ses
    },
  },
  ipcMain: {
    handle: (channel, handler) => {
      ipcHandlers.set(channel, handler)
    },
  },
} as never)

// 日志确定性捕获(依赖注入,免受 bun mock.module 跨文件泄漏影响)
__setHtmlPreviewLogSink((name, message, extra, level) => {
  logLines.push(JSON.stringify([name, message, extra ?? {}, level ?? "info"]))
})

// ---- fixtures ----

const RUN_ID = "job_run1"
let projectDir = ""
let htmlId = ""

function makeDescriptor(meta: { name: string; size?: number; mime?: string; detectedMime?: string }) {
  const [d] = deriveArtifactDescriptors(RUN_ID, [meta], { producer: "pipeline" })
  return d
}

function writeArtifactFile(rel: string, content: Buffer | string) {
  const abs = path.join(projectDir, ".alpha", "runs", RUN_ID, "artifacts", ...rel.split("/"))
  fs.mkdirSync(path.dirname(abs), { recursive: true })
  fs.writeFileSync(abs, content)
  return abs
}

function registerHtml(name = "report.html", content = "<h1>hello preview</h1>") {
  const abs = writeArtifactFile(name, content)
  const descriptor = makeDescriptor({ name, size: fs.statSync(abs).size, mime: "text/html" })
  const reg = registerDownloadedArtifact(projectDir, RUN_ID, { descriptor, savedPath: `artifacts/${name}` })
  if (!reg.ok) throw new Error(`fixture registration failed: ${reg.reason}`)
  return descriptor.id
}

function lastWindow() {
  return FakeBrowserWindow.instances[FakeBrowserWindow.instances.length - 1]!
}

function lastSession() {
  return sessions[sessions.length - 1]!
}

function tokenOf(win: FakeBrowserWindow) {
  const m = new RegExp(`^${HTML_PREVIEW_SCHEME}://([0-9a-f]{32})/`).exec(win.loadedUrls[0] ?? "")
  if (!m) throw new Error("loadURL not called with preview scheme")
  return m[1]!
}

async function serve(ses: FakeSession, url: string, method = "GET") {
  const handler = ses.protocolHandlers.get(HTML_PREVIEW_SCHEME)
  if (!handler) throw new Error("protocol handler not registered")
  return await handler({ url, method } as Request)
}

const fakeSender = () => {
  const sent: Array<{ channel: string; payload: unknown }> = []
  return {
    sent,
    sender: {
      send: (channel: string, payload: unknown) => sent.push({ channel, payload }),
      isDestroyed: () => false,
    } as never,
  }
}

beforeEach(() => {
  projectDir = fs.mkdtempSync(path.join(os.tmpdir(), "html-preview-host-"))
  fs.mkdirSync(path.join(projectDir, ".alpha", "runs", RUN_ID, "artifacts"), { recursive: true })
  htmlId = registerHtml()
})

afterEach(() => {
  closeAllHtmlPreviews()
  FakeBrowserWindow.instances.length = 0
  sessions.length = 0
  appState.packaged = false
  fs.rmSync(projectDir, { recursive: true, force: true })
})

// ---------------------------------------------------------------------------

describe("openHtmlPreview — 守卫拒绝(不开窗、不建 session)", () => {
  test("穿越 runId 拒绝", () => {
    const r = openHtmlPreview(projectDir, "../../etc", htmlId)
    expect(r).toEqual({ ok: false, reason: "invalid run id" })
    expect(FakeBrowserWindow.instances.length).toBe(0)
  })

  test("未登记 artifact 拒绝", () => {
    const r = openHtmlPreview(projectDir, RUN_ID, "art_job_run1_9_deadbeef")
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.reason).toContain("not found")
  })

  test("mismatch 态拒绝", () => {
    const abs = writeArtifactFile("bad.html", "<p>x</p>")
    const descriptor = makeDescriptor({ name: "bad.html", size: fs.statSync(abs).size + 999, mime: "text/html" })
    const reg = registerDownloadedArtifact(projectDir, RUN_ID, { descriptor, savedPath: "artifacts/bad.html" })
    if (!reg.ok) throw new Error(reg.reason)
    expect(reg.entry.local.state).toBe("mismatch")
    const r = openHtmlPreview(projectDir, RUN_ID, descriptor.id)
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.reason).toContain("mismatch")
  })

  test("盘上文件消失(missing)拒绝", () => {
    fs.rmSync(path.join(projectDir, ".alpha", "runs", RUN_ID, "artifacts", "report.html"))
    const r = openHtmlPreview(projectDir, RUN_ID, htmlId)
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.reason).toContain("missing")
  })

  test("非 HTML(magic 检测 text/plain)拒绝 —— 声明 html 不作数", () => {
    const abs = writeArtifactFile("fake.html", "not html at all")
    const descriptor = makeDescriptor({
      name: "fake.html",
      size: fs.statSync(abs).size,
      mime: "text/html",
      detectedMime: "text/plain",
    })
    const reg = registerDownloadedArtifact(projectDir, RUN_ID, { descriptor, savedPath: "artifacts/fake.html" })
    if (!reg.ok) throw new Error(reg.reason)
    const r = openHtmlPreview(projectDir, RUN_ID, descriptor.id)
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.reason).toContain("not previewable")
  })

  test("根文档超出字节预算拒绝", () => {
    const r = openHtmlPreview(projectDir, RUN_ID, htmlId, { maxDocBytes: 4 })
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.reason).toContain("preview budget")
  })
})

describe("窗口与 session 硬化(隔离矩阵)", () => {
  test("webPreferences:sandbox/contextIsolation/无 node/无 webview/**无 preload**", () => {
    const r = openHtmlPreview(projectDir, RUN_ID, htmlId)
    expect(r.ok).toBe(true)
    const prefs = lastWindow().opts.webPreferences
    expect(prefs.sandbox).toBe(true)
    expect(prefs.contextIsolation).toBe(true)
    expect(prefs.nodeIntegration).toBe(false)
    expect(prefs.nodeIntegrationInWorker).toBe(false)
    expect(prefs.nodeIntegrationInSubFrames).toBe(false)
    expect(prefs.webviewTag).toBe(false)
    expect("preload" in prefs).toBe(false)
  })

  test("一次性 in-memory partition:非 persist、每预览唯一", () => {
    openHtmlPreview(projectDir, RUN_ID, htmlId)
    openHtmlPreview(projectDir, RUN_ID, htmlId)
    const [a, b] = FakeBrowserWindow.instances
    const pa = String(a!.opts.webPreferences.partition)
    const pb = String(b!.opts.webPreferences.partition)
    expect(pa.startsWith("alpha-html-preview-")).toBe(true)
    expect(pa.startsWith("persist:")).toBe(false)
    expect(pa).not.toBe(pb)
    expect(sessions[0]!.partition).toBe(pa)
    expect(sessions[1]!.partition).toBe(pb)
  })

  test("打包态 devTools 关闭;dev 态开启", () => {
    openHtmlPreview(projectDir, RUN_ID, htmlId)
    expect(lastWindow().opts.webPreferences.devTools).toBe(true)
    appState.packaged = true
    openHtmlPreview(projectDir, RUN_ID, htmlId)
    expect(lastWindow().opts.webPreferences.devTools).toBe(false)
  })

  test("权限三面全拒(request/check/device)+ 下载拦截", () => {
    openHtmlPreview(projectDir, RUN_ID, htmlId)
    const ses = lastSession()
    let granted: boolean | null = null
    ses.permissionRequestHandler!({}, "clipboard-sanitized-write", (ok) => (granted = ok))
    expect(granted).toBe(false)
    expect(ses.permissionCheckHandler!()).toBe(false)
    expect(ses.devicePermissionHandler!()).toBe(false)
    const downloadHandlers = ses.listeners.get("will-download") ?? []
    expect(downloadHandlers.length).toBe(1)
    let prevented = false
    downloadHandlers[0]!({ preventDefault: () => (prevented = true) })
    expect(prevented).toBe(true)
  })

  test("webRequest 默认零网络:外部请求 cancel 并记入 blockedPaths(仅 origin)", () => {
    const r = openHtmlPreview(projectDir, RUN_ID, htmlId)
    if (!r.ok) throw new Error(r.reason)
    const ses = lastSession()
    const results: boolean[] = []
    ses.beforeRequestHandler!({ url: "https://evil.example/exfil?q=secret" }, (res) => results.push(res.cancel))
    ses.beforeRequestHandler!({ url: `${HTML_PREVIEW_SCHEME}://sometoken/x.png` }, (res) => results.push(res.cancel))
    expect(results).toEqual([true, false])
    const status = htmlPreviewStatus(r.previewId)
    if (!status.ok) throw new Error("status missing")
    expect(status.blockedPaths).toContain("https://evil.example")
    expect(JSON.stringify(status)).not.toContain("secret")
  })

  test("导航面全拒:popup deny + will-navigate/redirect/frame-navigate/attach-webview preventDefault", () => {
    openHtmlPreview(projectDir, RUN_ID, htmlId)
    const wc = lastWindow().webContents
    expect(wc.windowOpenHandler!()).toEqual({ action: "deny" })
    for (const event of ["will-navigate", "will-redirect", "will-frame-navigate", "will-attach-webview"]) {
      const handlers = wc.handlers.get(event) ?? []
      expect(handlers.length).toBe(1)
      let prevented = false
      handlers[0]!({ preventDefault: () => (prevented = true) })
      expect(prevented).toBe(true)
    }
  })
})

describe("静态服务(协议 handler)", () => {
  test("根文档 200:text/html + 静态 CSP + nosniff", async () => {
    openHtmlPreview(projectDir, RUN_ID, htmlId)
    const win = lastWindow()
    const res = await serve(lastSession(), win.loadedUrls[0]!)
    expect(res.status).toBe(200)
    expect(res.headers.get("Content-Type")).toBe("text/html; charset=utf-8")
    expect(res.headers.get("Content-Security-Policy")).toBe(HTML_PREVIEW_CSP)
    expect(res.headers.get("X-Content-Type-Options")).toBe("nosniff")
    expect(await res.text()).toContain("hello preview")
  })

  test("同 run sibling 图片/字体 200;嵌套子目录可达", async () => {
    writeArtifactFile("pic.png", Buffer.from([0x89, 0x50, 0x4e, 0x47]))
    writeArtifactFile("img/nested.woff2", Buffer.from([0x77, 0x4f, 0x46, 0x32]))
    openHtmlPreview(projectDir, RUN_ID, htmlId)
    const token = tokenOf(lastWindow())
    const png = await serve(lastSession(), `${HTML_PREVIEW_SCHEME}://${token}/pic.png`)
    expect(png.status).toBe(200)
    expect(png.headers.get("Content-Type")).toBe("image/png")
    expect(png.headers.get("Content-Security-Policy")).toBe(HTML_PREVIEW_CSP)
    const woff = await serve(lastSession(), `${HTML_PREVIEW_SCHEME}://${token}/img/nested.woff2`)
    expect(woff.status).toBe(200)
    expect(woff.headers.get("Content-Type")).toBe("font/woff2")
  })

  test("非白名单扩展(js/css/html 子资源)403 且计入 blockedPaths", async () => {
    writeArtifactFile("app.js", "alert(1)")
    const r = openHtmlPreview(projectDir, RUN_ID, htmlId)
    if (!r.ok) throw new Error(r.reason)
    const token = tokenOf(lastWindow())
    const res = await serve(lastSession(), `${HTML_PREVIEW_SCHEME}://${token}/app.js`)
    expect(res.status).toBe(403)
    const status = htmlPreviewStatus(r.previewId)
    if (!status.ok) throw new Error("status missing")
    expect(status.blockedPaths).toContain("app.js")
  })

  test("路径逃逸 / dotfile / 根路径全部 404", async () => {
    openHtmlPreview(projectDir, RUN_ID, htmlId)
    const token = tokenOf(lastWindow())
    for (const p of ["..%2F..%2Fstatus.json", ".secret.png", ""]) {
      const res = await serve(lastSession(), `${HTML_PREVIEW_SCHEME}://${token}/${p}`)
      expect(res.status).toBe(404)
    }
  })

  test("错 token 404;非 GET/HEAD 405", async () => {
    openHtmlPreview(projectDir, RUN_ID, htmlId)
    const wrong = "0".repeat(32)
    expect((await serve(lastSession(), `${HTML_PREVIEW_SCHEME}://${wrong}/report.html`)).status).toBe(404)
    expect((await serve(lastSession(), lastWindow().loadedUrls[0]!, "POST")).status).toBe(405)
  })

  test("根文档开窗后被换(尺寸漂移)→ 409 拒服务", async () => {
    openHtmlPreview(projectDir, RUN_ID, htmlId)
    writeArtifactFile("report.html", "<h1>hello preview</h1><script>alert(1)</script>")
    const res = await serve(lastSession(), lastWindow().loadedUrls[0]!)
    expect(res.status).toBe(409)
  })
})

describe("一次性生命周期", () => {
  test("close → token 失效 + unhandle + partition 清空 + 状态消失", async () => {
    const r = openHtmlPreview(projectDir, RUN_ID, htmlId)
    if (!r.ok) throw new Error(r.reason)
    const ses = lastSession()
    const win = lastWindow()
    const url = win.loadedUrls[0]!
    const handler = ses.protocolHandlers.get(HTML_PREVIEW_SCHEME)!
    expect((await handler({ url, method: "GET" } as Request)).status).toBe(200)

    expect(closeHtmlPreview(r.previewId)).toEqual({ ok: true })
    expect((await handler({ url, method: "GET" } as Request)).status).toBe(404) // 旧 handler 引用也拒
    expect(ses.unhandled).toContain(HTML_PREVIEW_SCHEME)
    expect(ses.clearCalls).toBe(1)
    expect(win.destroyed).toBe(true)
    expect(htmlPreviewStatus(r.previewId).ok).toBe(false)
    expect(closeHtmlPreview(r.previewId)).toEqual({ ok: false }) // 幂等
  })

  test("用户直接关窗 → 自动清理 + 推送 html-preview-closed", () => {
    const { sent, sender } = fakeSender()
    const r = openHtmlPreview(projectDir, RUN_ID, htmlId, { sender })
    if (!r.ok) throw new Error(r.reason)
    lastWindow().destroy()
    expect(htmlPreviewStatus(r.previewId).ok).toBe(false)
    expect(sent).toEqual([{ channel: "html-preview-closed", payload: { previewId: r.previewId, reason: "closed" } }])
  })

  test("preview renderer 崩溃 → 只拆本预览,reason=crashed", () => {
    const { sent, sender } = fakeSender()
    const r = openHtmlPreview(projectDir, RUN_ID, htmlId, { sender })
    if (!r.ok) throw new Error(r.reason)
    const gone = lastWindow().webContents.handlers.get("render-process-gone")![0]!
    gone({}, { reason: "crashed" })
    expect(htmlPreviewStatus(r.previewId).ok).toBe(false)
    expect(sent[0]!.payload).toEqual({ previewId: r.previewId, reason: "crashed" })
    expect(lastWindow().destroyed).toBe(true)
  })

  test("并发上限:第 4 个礼貌拒绝;关一个后可再开", () => {
    for (let i = 0; i < HTML_PREVIEW_MAX_CONCURRENT; i++) {
      expect(openHtmlPreview(projectDir, RUN_ID, htmlId).ok).toBe(true)
    }
    const overflow = openHtmlPreview(projectDir, RUN_ID, htmlId)
    expect(overflow.ok).toBe(false)
    if (!overflow.ok) expect(overflow.reason).toContain("limit")
    expect(FakeBrowserWindow.instances.length).toBe(HTML_PREVIEW_MAX_CONCURRENT)
    lastWindow().destroy()
    expect(openHtmlPreview(projectDir, RUN_ID, htmlId).ok).toBe(true)
  })
})

describe("IPC 控制通道", () => {
  test("注册三个 channel;参数校验;经 handler 全链路开/关", async () => {
    registerHtmlPreviewIpcHandlers()
    expect([...ipcHandlers.keys()]).toEqual(
      expect.arrayContaining(["html-preview-open", "html-preview-close", "html-preview-status"]),
    )
    const openH = ipcHandlers.get("html-preview-open")!
    expect(await openH({ sender: fakeSender().sender }, "", RUN_ID, htmlId)).toEqual({
      ok: false,
      reason: "invalid arguments",
    })
    const { sender } = fakeSender()
    const opened = (await openH({ sender }, projectDir, RUN_ID, htmlId)) as { ok: boolean; previewId?: string }
    expect(opened.ok).toBe(true)
    // 返回体只有 opaque previewId —— 无 url/token/path 字段
    expect(Object.keys(opened).sort()).toEqual(["ok", "previewId"])
    const statusH = ipcHandlers.get("html-preview-status")!
    const status = (await statusH({}, opened.previewId)) as { ok: boolean; open?: boolean }
    expect(status).toMatchObject({ ok: true, open: true })
    const closeH = ipcHandlers.get("html-preview-close")!
    expect(await closeH({}, opened.previewId)).toEqual({ ok: true })
    expect(((await statusH({}, opened.previewId)) as { ok: boolean }).ok).toBe(false)
  })
})

describe("零泄漏(marker)", () => {
  test("token 与一次性 URL 不进日志、不进 IPC 推送、不进状态面", async () => {
    const { sent, sender } = fakeSender()
    const r = openHtmlPreview(projectDir, RUN_ID, htmlId, { sender })
    if (!r.ok) throw new Error(r.reason)
    const win = lastWindow()
    const ses = lastSession()
    const token = tokenOf(win)
    // 全生命周期演练:正常服务、被拒资产、外部请求、加载失败日志路径、关闭
    await serve(ses, win.loadedUrls[0]!)
    writeArtifactFile("x.js", "1")
    await serve(ses, `${HTML_PREVIEW_SCHEME}://${token}/x.js`)
    ses.beforeRequestHandler!({ url: "https://tracker.example/p" }, () => {})
    const statusJson = JSON.stringify(htmlPreviewStatus(r.previewId))
    closeHtmlPreview(r.previewId)

    expect(token.length).toBe(32)
    const everything = logLines.join("\n")
    expect(everything).not.toContain(token)
    expect(everything).not.toContain(`${HTML_PREVIEW_SCHEME}://`)
    expect(everything).not.toContain(projectDir) // 绝对路径也不进日志
    expect(statusJson).not.toContain(token)
    expect(JSON.stringify(sent)).not.toContain(token)
  })
})
