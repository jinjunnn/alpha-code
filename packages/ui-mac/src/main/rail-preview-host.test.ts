// REQ-108(#244)—— 右栏 html/pdf 叠放载体(rail-preview-host)单测。
// AC3 契约:与既有隔离 HTML host 同一 deny 组(权限三面全拒 / will-download 拦截 /
// webRequest 零外网 / 导航面全拒 / 无 preload / 一次性 token),只有画布(WebContentsView
// 叠放 + bounds)与内容来源(workspace 守卫)不同。PDF 专属:plugins 只开本 view、
// #toolbar=0 装载、Cmd+P / Cmd+S 拦截、根文档以外一律 403。

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, mock, test } from "bun:test"
import * as fs from "node:fs"
import * as os from "node:os"
import * as path from "node:path"

// ---- electron 打桩(捕获式 fake;须在 import 被测模块之前)----

class FakeSession {
  partition: string
  beforeRequestHandler: ((details: { url: string }, cb: (r: { cancel: boolean }) => void) => void) | null = null
  listeners = new Map<string, Array<(...args: unknown[]) => void>>()
  clearCalls = 0
  protocolHandlers = new Map<string, (request: Request) => Response | Promise<Response>>()
  unhandled: string[] = []
  permissionRequestHandler: unknown
  permissionCheckHandler: unknown
  devicePermissionHandler: unknown
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
  setPermissionRequestHandler(h: unknown) {
    this.permissionRequestHandler = h
  }
  setPermissionCheckHandler(h: unknown) {
    this.permissionCheckHandler = h
  }
  setDevicePermissionHandler(h: unknown) {
    this.devicePermissionHandler = h
  }
  on(event: string, h: (...args: unknown[]) => void) {
    const list = this.listeners.get(event) ?? []
    list.push(h)
    this.listeners.set(event, list)
  }
  emit(event: string, ...args: unknown[]) {
    for (const h of this.listeners.get(event) ?? []) h(...args)
  }
  clearStorageData() {
    this.clearCalls++
    return Promise.resolve()
  }
}

class FakeViewWebContents {
  handlers = new Map<string, Array<(...args: unknown[]) => void>>()
  windowOpenHandler: (() => { action: string }) | null = null
  loadedUrls: string[] = []
  closed = false
  on(event: string, h: (...args: unknown[]) => void) {
    const list = this.handlers.get(event) ?? []
    list.push(h)
    this.handlers.set(event, list)
  }
  emit(event: string, ...args: unknown[]) {
    for (const h of this.handlers.get(event) ?? []) h(...args)
  }
  setWindowOpenHandler(h: () => { action: string }) {
    this.windowOpenHandler = h
  }
  loadURL(url: string) {
    this.loadedUrls.push(url)
    return Promise.resolve()
  }
  isDestroyed() {
    return this.closed
  }
  close() {
    this.closed = true
  }
}

class FakeWebContentsView {
  static instances: FakeWebContentsView[] = []
  opts: { webPreferences: Record<string, unknown> }
  webContents = new FakeViewWebContents()
  bounds: unknown = null
  visible: boolean | null = null
  constructor(opts: { webPreferences: Record<string, unknown> }) {
    this.opts = opts
    FakeWebContentsView.instances.push(this)
  }
  setBounds(b: unknown) {
    this.bounds = b
  }
  setVisible(v: boolean) {
    this.visible = v
  }
}

class FakeSender {
  static nextId = 1
  id = FakeSender.nextId++
  destroyed = false
  sent: Array<[string, unknown]> = []
  onceHandlers = new Map<string, Array<() => void>>()
  isDestroyed() {
    return this.destroyed
  }
  send(channel: string, payload: unknown) {
    this.sent.push([channel, payload])
  }
  once(event: string, h: () => void) {
    const list = this.onceHandlers.get(event) ?? []
    list.push(h)
    this.onceHandlers.set(event, list)
  }
  removeListener() {}
}

class FakeWindow {
  destroyed = false
  children: FakeWebContentsView[] = []
  removed: FakeWebContentsView[] = []
  onceHandlers = new Map<string, Array<() => void>>()
  contentView = {
    addChildView: (v: FakeWebContentsView) => this.children.push(v),
    removeChildView: (v: FakeWebContentsView) => this.removed.push(v),
  }
  isDestroyed() {
    return this.destroyed
  }
  once(event: string, h: () => void) {
    const list = this.onceHandlers.get(event) ?? []
    list.push(h)
    this.onceHandlers.set(event, list)
  }
  removeListener() {}
}

const appState = { packaged: true }
const sessions: FakeSession[] = []
const windowsBySender = new Map<unknown, FakeWindow>()
const ipcHandlers = new Map<string, (...args: unknown[]) => unknown>()
const logLines: string[] = []

const fakeElectron = {
  app: {
    get isPackaged() {
      return appState.packaged
    },
    // 生产用 app.getAppPath() 当锚点(见 officePreviewDir 的注释:__dirname 会随 rollup
    // 拆不拆 chunk 漂移,而漂了只表现为运行时静默 404)。fake 指向 ui-mac 包根,与真实同形。
    getAppPath: () => path.join(import.meta.dir, "..", ".."),
    getPath: (_name: string) => path.join(os.tmpdir(), "alpha-rail-preview-test-userdata"),
  },
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
  WebContentsView: FakeWebContentsView,
  BrowserWindow: {
    fromWebContents: (sender: unknown) => windowsBySender.get(sender) ?? null,
  },
}

mock.module("electron", () => fakeElectron)
mock.module("./logging", () => ({
  write: (name: string, message: string, extra?: Record<string, unknown>, level?: string) => {
    logLines.push(JSON.stringify([name, message, extra ?? {}, level ?? "info"]))
  },
  getLogger: () => undefined,
  rotateServerLogs: () => {},
}))

const {
  closeAllRailPreviews,
  closeRailPreview,
  openRailPreview,
  railPreviewStatus,
  registerRailPreviewIpcHandlers,
  setRailPreviewBounds,
  setRailPreviewVisible,
  __setRailPreviewElectron,
  __setRailPreviewLogSink,
} = await import("./rail-preview-host")
const { HTML_PREVIEW_CSP, HTML_PREVIEW_SCHEME } = await import("../shared/html-preview")
const {
  OFFICE_PREVIEW_ASSETS,
  OFFICE_PREVIEW_CSP,
  OFFICE_PREVIEW_DOCUMENT_PATH,
  OFFICE_PREVIEW_HOST_PATH,
  OFFICE_PREVIEW_OUT_DIR,
} = await import("../shared/office-preview")
const { FILE_VIEWER_DOC_MAX_BYTES } = await import("../shared/file-viewer")

__setRailPreviewElectron(fakeElectron as never)
__setRailPreviewLogSink((name, message, extra, level) => {
  logLines.push(JSON.stringify([name, message, extra ?? {}, level ?? "info"]))
})

let root: string
let outside: string

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "rp-root-"))
  outside = fs.mkdtempSync(path.join(os.tmpdir(), "rp-out-"))
  sessions.length = 0
  FakeWebContentsView.instances.length = 0
  logLines.length = 0
})

afterEach(() => {
  closeAllRailPreviews()
  fs.rmSync(root, { recursive: true, force: true })
  fs.rmSync(outside, { recursive: true, force: true })
})

const write = (rel: string, content: string | Buffer) => {
  const abs = path.join(root, rel)
  fs.mkdirSync(path.dirname(abs), { recursive: true })
  fs.writeFileSync(abs, content)
  return abs
}

const BOUNDS = { x: 700, y: 120, width: 380, height: 500 }

function attach() {
  const sender = new FakeSender()
  const win = new FakeWindow()
  windowsBySender.set(sender, win)
  return { sender, win }
}

function tokenOf(view: FakeWebContentsView): string {
  const url = new URL(view.webContents.loadedUrls[0]!)
  return url.hostname
}

async function serve(ses: FakeSession, url: string, init?: RequestInit): Promise<Response> {
  const handler = ses.protocolHandlers.get(HTML_PREVIEW_SCHEME)!
  return await handler(new Request(url, init))
}

describe("open guards (AC4 通道复用:守卫全过才建 view)", () => {
  test("missing / symlink / directory / traversal / oversize are refused with enum codes", () => {
    const { sender } = attach()
    write("real.html", "<html></html>")
    fs.symlinkSync(path.join(root, "real.html"), path.join(root, "link.html"))
    fs.mkdirSync(path.join(root, "dir.html"))
    fs.writeFileSync(path.join(root, "big.pdf"), Buffer.alloc(FILE_VIEWER_DOC_MAX_BYTES + 1))
    expect(openRailPreview(sender as never, root, "missing.html", "html", BOUNDS)).toEqual({
      ok: false,
      code: "not-found",
    })
    expect(openRailPreview(sender as never, root, "link.html", "html", BOUNDS)).toEqual({ ok: false, code: "symlink" })
    expect(openRailPreview(sender as never, root, "dir.html", "html", BOUNDS)).toEqual({ ok: false, code: "not-a-file" })
    expect(openRailPreview(sender as never, root, "../x.html", "html", BOUNDS)).toEqual({
      ok: false,
      code: "invalid-path",
    })
    expect(openRailPreview(sender as never, root, "big.pdf", "pdf", BOUNDS)).toEqual({ ok: false, code: "too-large" })
    expect(FakeWebContentsView.instances).toHaveLength(0)
  })

  test("a sender without a browser window cannot open a preview", () => {
    const orphan = new FakeSender()
    write("a.html", "<html></html>")
    expect(openRailPreview(orphan as never, root, "a.html", "html", BOUNDS)).toEqual({ ok: false, code: "read-failed" })
  })
})

describe("view creation & lifecycle", () => {
  test("pdf: plugins only on this view, #toolbar=0 fragment, sandboxed, no preload, attached with sanitized bounds", () => {
    const { sender, win } = attach()
    write("doc.pdf", "%PDF-1.4 fake")
    const result = openRailPreview(sender as never, root, "doc.pdf", "pdf", {
      x: 700.6,
      y: -3,
      width: 380.2,
      height: 500.9,
    })
    expect(result.ok).toBe(true)
    const view = FakeWebContentsView.instances[0]!
    expect(view.opts.webPreferences.plugins).toBe(true)
    expect(view.opts.webPreferences.sandbox).toBe(true)
    expect(view.opts.webPreferences.contextIsolation).toBe(true)
    expect(view.opts.webPreferences.nodeIntegration).toBe(false)
    expect(view.opts.webPreferences.webviewTag).toBe(false)
    expect("preload" in view.opts.webPreferences).toBe(false)
    // #1227:`persist:` 不是风格选择 —— Chromium 的 PDF viewer 是内建扩展,扩展在
    // off-the-record(无 persist: 的内存)profile 里不装载,症状是**看起来正常的黑屏**:
    // mime handler 仍挂上 chrome-extension://…/index.html,真正渲染页面的 plugin OOPIF
    // 永远建不出来。真 Chromium 实测见 docs/architecture/2026-09-03-electron-pdf-viewer-session.md。
    expect(String(view.opts.webPreferences.partition)).toStartWith("persist:alpha-rail-preview-")
    expect(win.children).toEqual([view])
    expect(view.bounds).toEqual({ x: 701, y: 0, width: 380, height: 501 })
    const url = view.webContents.loadedUrls[0]!
    expect(url.startsWith(`${HTML_PREVIEW_SCHEME}://`)).toBe(true)
    expect(url.endsWith("/doc.pdf#toolbar=0")).toBe(true)
  })

  test("html: plugins stay off and the url carries no fragment", () => {
    const { sender } = attach()
    write("page.html", "<html><body>hi</body></html>")
    const result = openRailPreview(sender as never, root, "page.html", "html", BOUNDS)
    expect(result.ok).toBe(true)
    const view = FakeWebContentsView.instances[0]!
    expect(view.opts.webPreferences.plugins).toBe(false)
    expect(view.webContents.loadedUrls[0]!.includes("#")).toBe(false)
  })

  test("second open from the same sender replaces the first (唯一 preview surface)", () => {
    const { sender, win } = attach()
    write("a.html", "<html></html>")
    write("b.pdf", "%PDF")
    const first = openRailPreview(sender as never, root, "a.html", "html", BOUNDS)
    expect(first.ok).toBe(true)
    const second = openRailPreview(sender as never, root, "b.pdf", "pdf", BOUNDS)
    expect(second.ok).toBe(true)
    if (!first.ok || !second.ok) return
    expect(win.removed).toHaveLength(1)
    expect(sender.sent).toContainEqual(["rail-preview-closed", { previewId: first.previewId, reason: "replaced" }])
    expect(railPreviewStatus(first.previewId)).toEqual({ ok: false, reason: "unknown or closed preview" })
    expect(railPreviewStatus(second.previewId).ok).toBe(true)
  })

  test("close destroys everything: child view removed, protocol unhandled, storage cleared, token dead", async () => {
    const { sender, win } = attach()
    write("a.html", "<html></html>")
    const result = openRailPreview(sender as never, root, "a.html", "html", BOUNDS)
    expect(result.ok).toBe(true)
    if (!result.ok) return
    const ses = sessions[0]!
    const view = FakeWebContentsView.instances[0]!
    const token = tokenOf(view)
    expect(closeRailPreview(result.previewId)).toEqual({ ok: true })
    expect(win.removed).toEqual([view])
    expect(ses.unhandled).toEqual([HTML_PREVIEW_SCHEME])
    expect(ses.clearCalls).toBe(1)
    expect(view.webContents.closed).toBe(true)
    // handler 已随 close unhandle —— 该 token 的地址空间整个不存在了(比 404 更强)。
    expect(ses.protocolHandlers.size).toBe(0)
    expect(token.length).toBe(32)
    expect(sender.sent).toContainEqual(["rail-preview-closed", { previewId: result.previewId, reason: "closed" }])
    // 幂等。
    expect(closeRailPreview(result.previewId)).toEqual({ ok: false })
  })

  test("renderer crash closes the preview with reason crashed", () => {
    const { sender } = attach()
    write("a.html", "<html></html>")
    const result = openRailPreview(sender as never, root, "a.html", "html", BOUNDS)
    expect(result.ok).toBe(true)
    if (!result.ok) return
    FakeWebContentsView.instances[0]!.webContents.emit("render-process-gone", {}, { reason: "crashed" })
    expect(sender.sent).toContainEqual(["rail-preview-closed", { previewId: result.previewId, reason: "crashed" }])
  })

  test("setBounds re-sanitizes, setVisible flips, and both refuse closed previews", () => {
    const { sender } = attach()
    write("a.html", "<html></html>")
    const result = openRailPreview(sender as never, root, "a.html", "html", BOUNDS)
    expect(result.ok).toBe(true)
    if (!result.ok) return
    const view = FakeWebContentsView.instances[0]!
    expect(setRailPreviewBounds(result.previewId, { x: 1.4, y: 2.6, width: 100.5, height: 0 })).toEqual({ ok: true })
    expect(view.bounds).toEqual({ x: 1, y: 3, width: 101, height: 0 })
    expect(setRailPreviewBounds(result.previewId, { x: Number.NaN, y: 0, width: 1, height: 1 })).toEqual({ ok: false })
    expect(setRailPreviewVisible(result.previewId, false)).toEqual({ ok: true })
    expect(view.visible).toBe(false)
    closeRailPreview(result.previewId)
    expect(setRailPreviewBounds(result.previewId, BOUNDS)).toEqual({ ok: false })
    expect(setRailPreviewVisible(result.previewId, true)).toEqual({ ok: false })
  })
})

describe("session deny group (AC3:与既有隔离 host 同组,一条不放宽)", () => {
  test("permission handlers all deny, downloads are prevented and recorded", () => {
    const { sender } = attach()
    write("a.html", "<html></html>")
    const result = openRailPreview(sender as never, root, "a.html", "html", BOUNDS)
    expect(result.ok).toBe(true)
    if (!result.ok) return
    const ses = sessions[0]!
    let granted: boolean | undefined
    ;(ses.permissionRequestHandler as (wc: unknown, p: string, cb: (ok: boolean) => void) => void)(
      null,
      "media",
      (ok) => {
        granted = ok
      },
    )
    expect(granted).toBe(false)
    expect((ses.permissionCheckHandler as () => boolean)()).toBe(false)
    expect((ses.devicePermissionHandler as () => boolean)()).toBe(false)
    let prevented = false
    ses.emit("will-download", {
      preventDefault: () => {
        prevented = true
      },
    })
    expect(prevented).toBe(true)
    const status = railPreviewStatus(result.previewId)
    expect(status.ok && status.blockedPaths.includes("download")).toBe(true)
  })

  test("webRequest cancels everything except the preview scheme (packaged: devtools too); origin-only diagnostics", () => {
    const { sender } = attach()
    write("a.html", "<html></html>")
    const result = openRailPreview(sender as never, root, "a.html", "html", BOUNDS)
    expect(result.ok).toBe(true)
    if (!result.ok) return
    const ses = sessions[0]!
    const judge = (url: string) => {
      let cancelled: boolean | undefined
      ses.beforeRequestHandler!({ url }, (r) => {
        cancelled = r.cancel
      })
      return cancelled
    }
    expect(judge(`${HTML_PREVIEW_SCHEME}://whatever/x.png`)).toBe(false)
    expect(judge("https://evil.example/exfil?full=path")).toBe(true)
    expect(judge("devtools://devtools/bundled")).toBe(true)
    expect(judge("chrome-extension://mhjfbmdgcfjbbpaeojofohoefgiehjai/index.html")).toBe(true)
    const status = railPreviewStatus(result.previewId)
    expect(status.ok && status.blockedPaths.includes("https://evil.example")).toBe(true)
    expect(status.ok && status.blockedPaths.some((p) => p.includes("full=path"))).toBe(false)
  })

  test("pdf carrier additionally allows the chrome pdf extension and blocks Cmd/Ctrl+P & +S", () => {
    const { sender } = attach()
    write("doc.pdf", "%PDF")
    const result = openRailPreview(sender as never, root, "doc.pdf", "pdf", BOUNDS)
    expect(result.ok).toBe(true)
    const ses = sessions[0]!
    let cancelled: boolean | undefined
    ses.beforeRequestHandler!({ url: "chrome-extension://mhjfbmdgcfjbbpaeojofohoefgiehjai/index.html" }, (r) => {
      cancelled = r.cancel
    })
    expect(cancelled).toBe(false)
    const wc = FakeWebContentsView.instances[0]!.webContents
    const probe = (input: { meta?: boolean; control?: boolean; key: string }) => {
      let prevented = false
      wc.emit("before-input-event", { preventDefault: () => (prevented = true) }, input)
      return prevented
    }
    expect(probe({ meta: true, key: "p" })).toBe(true)
    expect(probe({ control: true, key: "s" })).toBe(true)
    expect(probe({ key: "p" })).toBe(false)
    expect(probe({ meta: true, key: "a" })).toBe(false)
  })

  test("navigation surface is fully denied (window.open / navigate / redirect / webview)", () => {
    const { sender } = attach()
    write("a.html", "<html></html>")
    openRailPreview(sender as never, root, "a.html", "html", BOUNDS)
    const wc = FakeWebContentsView.instances[0]!.webContents
    expect(wc.windowOpenHandler!()).toEqual({ action: "deny" })
    for (const event of ["will-navigate", "will-redirect", "will-attach-webview"]) {
      let prevented = false
      wc.emit(event, { preventDefault: () => (prevented = true) })
      expect({ event, prevented }).toEqual({ event, prevented: true })
    }
  })
})

describe("protocol serving (workspace 守卫供给;根文档 swap 防线;sibling 白名单)", () => {
  test("html root is served with CSP + nosniff; pdf root gets application/pdf without the HTML CSP", async () => {
    const { sender } = attach()
    write("page.html", "<html><body>hi</body></html>")
    const open1 = openRailPreview(sender as never, root, "page.html", "html", BOUNDS)
    expect(open1.ok).toBe(true)
    const htmlSes = sessions[0]!
    const htmlToken = tokenOf(FakeWebContentsView.instances[0]!)
    const htmlResp = await serve(htmlSes, `${HTML_PREVIEW_SCHEME}://${htmlToken}/page.html`)
    expect(htmlResp.status).toBe(200)
    expect(htmlResp.headers.get("Content-Type")).toBe("text/html; charset=utf-8")
    expect(htmlResp.headers.get("Content-Security-Policy")).toBe(HTML_PREVIEW_CSP)
    expect(htmlResp.headers.get("X-Content-Type-Options")).toBe("nosniff")
    expect(await htmlResp.text()).toBe("<html><body>hi</body></html>")

    const { sender: sender2 } = attach()
    write("doc.pdf", "%PDF-1.4 body")
    const open2 = openRailPreview(sender2 as never, root, "doc.pdf", "pdf", BOUNDS)
    expect(open2.ok).toBe(true)
    const pdfSes = sessions[1]!
    const pdfToken = tokenOf(FakeWebContentsView.instances[1]!)
    const pdfResp = await serve(pdfSes, `${HTML_PREVIEW_SCHEME}://${pdfToken}/doc.pdf`)
    expect(pdfResp.status).toBe(200)
    expect(pdfResp.headers.get("Content-Type")).toBe("application/pdf")
    expect(pdfResp.headers.get("Content-Security-Policy")).toBeNull()
    expect(pdfResp.headers.get("X-Content-Type-Options")).toBe("nosniff")
  })

  test("wrong token, wrong method, and traversal are denied", async () => {
    const { sender } = attach()
    write("page.html", "<html></html>")
    openRailPreview(sender as never, root, "page.html", "html", BOUNDS)
    const ses = sessions[0]!
    const token = tokenOf(FakeWebContentsView.instances[0]!)
    expect((await serve(ses, `${HTML_PREVIEW_SCHEME}://deadbeef/page.html`)).status).toBe(404)
    expect((await serve(ses, `${HTML_PREVIEW_SCHEME}://${token}/page.html`, { method: "POST", body: "x" })).status).toBe(
      405,
    )
    // 穿越:白名单扩展名(png)直达路径守卫 → 404;非白名单(txt)在扩展闸就被 403。两者都拒。
    expect((await serve(ses, `${HTML_PREVIEW_SCHEME}://${token}/..%2Fsecret.png`)).status).toBe(404)
    expect((await serve(ses, `${HTML_PREVIEW_SCHEME}://${token}/..%2Fsecret.txt`)).status).toBe(403)
  })

  test("root document replaced on disk is refused with 409, not silently re-served", async () => {
    const { sender } = attach()
    write("page.html", "<html>original</html>")
    openRailPreview(sender as never, root, "page.html", "html", BOUNDS)
    const ses = sessions[0]!
    const token = tokenOf(FakeWebContentsView.instances[0]!)
    fs.writeFileSync(path.join(root, "page.html"), "<html>swapped, longer</html>")
    const resp = await serve(ses, `${HTML_PREVIEW_SCHEME}://${token}/page.html`)
    expect(resp.status).toBe(409)
  })

  test("html siblings: image/font whitelist inside the workspace is served; scripts/styles/symlinks are blocked", async () => {
    const { sender } = attach()
    write("docs/page.html", "<html></html>")
    write("docs/pic.png", Buffer.from([0x89, 0x50, 0x4e, 0x47]))
    write("docs/app.js", "alert(1)")
    fs.writeFileSync(path.join(outside, "evil.png"), "outside")
    fs.symlinkSync(path.join(outside, "evil.png"), path.join(root, "docs/evil.png"))
    const result = openRailPreview(sender as never, root, "docs/page.html", "html", BOUNDS)
    expect(result.ok).toBe(true)
    if (!result.ok) return
    const ses = sessions[0]!
    const token = tokenOf(FakeWebContentsView.instances[0]!)

    const png = await serve(ses, `${HTML_PREVIEW_SCHEME}://${token}/docs/pic.png`)
    expect(png.status).toBe(200)
    expect(png.headers.get("Content-Type")).toBe("image/png")

    const js = await serve(ses, `${HTML_PREVIEW_SCHEME}://${token}/docs/app.js`)
    expect(js.status).toBe(403)

    const sym = await serve(ses, `${HTML_PREVIEW_SCHEME}://${token}/docs/evil.png`)
    expect(sym.status).toBe(404)

    const status = railPreviewStatus(result.previewId)
    expect(status.ok && status.blockedPaths.includes("docs/app.js")).toBe(true)
    expect(status.ok && status.blockedPaths.includes("docs/evil.png")).toBe(true)
  })

  test("pdf carrier serves the root only — even whitelisted image extensions are 403", async () => {
    const { sender } = attach()
    write("doc.pdf", "%PDF")
    write("pic.png", Buffer.from([0x89]))
    openRailPreview(sender as never, root, "doc.pdf", "pdf", BOUNDS)
    const ses = sessions[0]!
    const token = tokenOf(FakeWebContentsView.instances[0]!)
    expect((await serve(ses, `${HTML_PREVIEW_SCHEME}://${token}/pic.png`)).status).toBe(403)
  })
})

describe("IPC + hygiene", () => {
  test("handlers validate arguments fail-closed", async () => {
    registerRailPreviewIpcHandlers()
    const { sender } = attach()
    const event = { sender }
    expect(await ipcHandlers.get("rail-preview-open")!(event, root, "a.html", "exe", BOUNDS)).toEqual({
      ok: false,
      code: "invalid-path",
    })
    expect(await ipcHandlers.get("rail-preview-close")!(event, 42)).toEqual({ ok: false })
    expect(await ipcHandlers.get("rail-preview-status")!(event, "")).toEqual({
      ok: false,
      reason: "invalid arguments",
    })
  })

  test("token never leaks into logs or IPC results", () => {
    const { sender } = attach()
    write("a.html", "<html></html>")
    const result = openRailPreview(sender as never, root, "a.html", "html", BOUNDS)
    expect(result.ok).toBe(true)
    const token = tokenOf(FakeWebContentsView.instances[0]!)
    expect(JSON.stringify(result).includes(token)).toBe(false)
    expect(logLines.some((line) => line.includes(token))).toBe(false)
  })
})


describe("#1229 office 载体:同一套隔离,第三块画布", () => {
  // 宿主页与它的资产是**我们自己的打包产物**,住在 out/office-preview/;测试里就地造一份,
  // 免得判据依赖「有没有跑过 build」这个与被测行为无关的前提(那正是本仓点名过的假红/假绿源)。
  const outDir = path.join(import.meta.dir, "..", "..", "out", OFFICE_PREVIEW_OUT_DIR)
  let madeAssets = false
  beforeAll(() => {
    if (fs.existsSync(path.join(outDir, "app.js"))) return
    fs.mkdirSync(outDir, { recursive: true })
    for (const name of Object.keys(OFFICE_PREVIEW_ASSETS)) fs.writeFileSync(path.join(outDir, name), `/*${name}*/`)
    madeAssets = true
  })
  afterAll(() => {
    if (madeAssets) fs.rmSync(outDir, { recursive: true, force: true })
  })

  test("装载的是宿主页 + 检测出的子类型,工作区路径根本不进 URL", () => {
    const { sender } = attach()
    write("q3.xlsx", "PK\u0003\u0004 fake")
    expect(openRailPreview(sender as never, root, "q3.xlsx", "office-xlsx", BOUNDS).ok).toBe(true)
    const view = FakeWebContentsView.instances[0]!
    const url = new URL(view.webContents.loadedUrls[0]!)
    expect(url.pathname).toBe(`/${OFFICE_PREVIEW_HOST_PATH}`)
    expect(url.search).toBe("?kind=xlsx")
    // 文件名不出现在 URL 里 —— 叠放层的地址不泄露工作区内容。
    expect(view.webContents.loadedUrls[0]!).not.toContain("q3")
    // Office 是纯 DOM/canvas 渲染,不需要插件面。
    expect(view.opts.webPreferences.plugins).toBe(false)
    expect(view.opts.webPreferences.sandbox).toBe(true)
    expect("preload" in view.opts.webPreferences).toBe(false)
    expect(String(view.opts.webPreferences.partition)).toStartWith("persist:alpha-rail-preview-")
  })

  test("资产面是定长白名单:表内的给,表外的一律 403 并记账", async () => {
    const { sender } = attach()
    write("a.docx", "PK\u0003\u0004 fake")
    const opened = openRailPreview(sender as never, root, "a.docx", "office-docx", BOUNDS)
    expect(opened.ok).toBe(true)
    const ses = sessions[0]!
    const token = tokenOf(FakeWebContentsView.instances[0]!)
    for (const name of Object.keys(OFFICE_PREVIEW_ASSETS)) {
      const res = await serve(ses, `${HTML_PREVIEW_SCHEME}://${token}/__alpha_office__/${name}`)
      expect({ name, status: res.status }).toEqual({ name, status: 200 })
      expect(res.headers.get("Content-Security-Policy")).toBe(OFFICE_PREVIEW_CSP)
    }
    for (const bad of ["__alpha_office__/other.js", "__alpha_office__/sub/app.js", "__alpha_office__/../main/index.js"]) {
      const res = await serve(ses, `${HTML_PREVIEW_SCHEME}://${token}/${bad}`)
      expect({ bad, status: res.status }).toEqual({ bad, status: 403 })
    }
    const status = railPreviewStatus((opened as { previewId: string }).previewId)
    expect(status.ok && status.blockedPaths.length > 0).toBe(true)
  })

  test("文档只在定长地址上供给;按它自己的工作区路径取不到,同伴文件也一概取不到", async () => {
    const { sender } = attach()
    write("a.docx", "DOCXBYTES")
    write("sibling.txt", "SECRET-SIBLING")
    expect(openRailPreview(sender as never, root, "a.docx", "office-docx", BOUNDS).ok).toBe(true)
    const ses = sessions[0]!
    const token = tokenOf(FakeWebContentsView.instances[0]!)

    const doc = await serve(ses, `${HTML_PREVIEW_SCHEME}://${token}/${OFFICE_PREVIEW_DOCUMENT_PATH}`)
    expect(doc.status).toBe(200)
    expect(await doc.text()).toBe("DOCXBYTES")
    // html 载体会按根文档路径供给,office 载体**刻意不会** —— 那条路只剩定长地址一条。
    expect((await serve(ses, `${HTML_PREVIEW_SCHEME}://${token}/a.docx`)).status).toBe(403)
    expect((await serve(ses, `${HTML_PREVIEW_SCHEME}://${token}/sibling.txt`)).status).toBe(403)
  })

  test("盘上被换即 409:文档字节不静默变成另一份", async () => {
    const { sender } = attach()
    write("a.docx", "ORIGINAL")
    expect(openRailPreview(sender as never, root, "a.docx", "office-docx", BOUNDS).ok).toBe(true)
    const ses = sessions[0]!
    const token = tokenOf(FakeWebContentsView.instances[0]!)
    write("a.docx", "REPLACED-WITH-A-LONGER-PAYLOAD")
    const res = await serve(ses, `${HTML_PREVIEW_SCHEME}://${token}/${OFFICE_PREVIEW_DOCUMENT_PATH}`)
    expect(res.status).toBe(409)
  })

  test("宿主页产物不在时诚实 404(而不是白屏)—— 构建步骤没跑到要看得见", async () => {
    const { sender } = attach()
    write("a.pptx", "PK fake")
    expect(openRailPreview(sender as never, root, "a.pptx", "office-pptx", BOUNDS).ok).toBe(true)
    const ses = sessions[0]!
    const token = tokenOf(FakeWebContentsView.instances[0]!)
    const missingDir = path.join(outDir, "__absent__")
    // 用一个表内但盘上不存在的名字模拟「打包步骤没跑」:临时把 app.js 挪走。
    const appJs = path.join(outDir, "app.js")
    const stash = `${appJs}.stash`
    fs.renameSync(appJs, stash)
    try {
      const res = await serve(ses, `${HTML_PREVIEW_SCHEME}://${token}/__alpha_office__/app.js`)
      expect(res.status).toBe(404)
    } finally {
      fs.renameSync(stash, appJs)
      fs.rmSync(missingDir, { recursive: true, force: true })
    }
  })

  test("IPC 只受理已知载体名", () => {
    const handler = ipcHandlers.get("rail-preview-open")!
    const { sender } = attach()
    write("a.docx", "PK fake")
    expect(handler({ sender } as never, root, "a.docx", "office-msword", BOUNDS)).toEqual({
      ok: false,
      code: "invalid-path",
    })
    expect(handler({ sender } as never, root, "a.docx", "office-docx", BOUNDS)).toMatchObject({ ok: true })
  })
})
