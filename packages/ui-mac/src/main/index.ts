import { randomUUID } from "node:crypto"
import { createServer } from "node:net"
import { homedir } from "node:os"
import { app, BrowserWindow, ipcMain } from "electron"

import type { ServerReadyData } from "../preload/types"
import { spawnLocalServer, type SidecarListener } from "./server"
import { createMainWindow, registerRendererProtocol } from "./windows"

// ---------------------------------------------------------------------------
// alpha-code ui-mac — minimal Electron main (walking skeleton).
// Adapted from opencode/packages/desktop/src/main/index.ts but stripped of
// Effect, WSL, updater, deep-link, logging, and onboarding-test machinery.
// opencode is a read-only submodule: nothing here edits it; the embedded server
// is consumed only through the `virtual:opencode-server` bundle alias.
// ---------------------------------------------------------------------------

let mainWindow: BrowserWindow | null = null
let server: SidecarListener | null = null

// Resolves once the server (embedded sidecar or external) is reachable.
// The renderer reads this via window.api.awaitInitialization().
let resolveServerReady!: (data: ServerReadyData) => void
let rejectServerReady!: (err: unknown) => void
const serverReady = new Promise<ServerReadyData>((resolve, reject) => {
  resolveServerReady = resolve
  rejectServerReady = reject
})

// In-memory key/value store backing the Platform.storage IPC. The real desktop
// uses electron-store; a Map is enough for a skeleton (no persistence yet).
const stores = new Map<string, Map<string, string>>()
function store(name: string) {
  let s = stores.get(name)
  if (!s) stores.set(name, (s = new Map()))
  return s
}
let defaultServerUrl: string | null = null

async function freePort(): Promise<number> {
  const fromEnv = process.env.OPENCODE_PORT
  if (fromEnv) {
    const parsed = Number.parseInt(fromEnv, 10)
    if (!Number.isNaN(parsed)) return parsed
  }
  return await new Promise<number>((resolve, reject) => {
    const srv = createServer()
    srv.on("error", reject)
    srv.listen(0, "127.0.0.1", () => {
      const addr = srv.address()
      if (typeof addr !== "object" || !addr) {
        srv.close()
        reject(new Error("failed to acquire free port"))
        return
      }
      const port = addr.port
      srv.close(() => resolve(port))
    })
  })
}

async function killSidecar() {
  if (!server) return
  const current = server
  server = null
  await current.stop().catch(() => undefined)
}

function registerIpc() {
  // --- lifecycle / server discovery ---
  ipcMain.handle("await-initialization", () => serverReady)
  ipcMain.handle("kill-sidecar", () => killSidecar())
  ipcMain.on("relaunch", () => {
    void killSidecar().finally(() => {
      app.relaunch()
      app.exit(0)
    })
  })

  // --- default server url (Platform.getDefaultServer/setDefaultServer) ---
  ipcMain.handle("get-default-server-url", () => defaultServerUrl)
  ipcMain.handle("set-default-server-url", (_e, url: string | null) => {
    defaultServerUrl = url
  })

  // --- storage (Platform.storage) ---
  ipcMain.handle("store-get", (_e, name: string, key: string) => store(name).get(key) ?? null)
  ipcMain.handle("store-set", (_e, name: string, key: string, value: string) => void store(name).set(key, value))
  ipcMain.handle("store-delete", (_e, name: string, key: string) => void store(name).delete(key))
  ipcMain.handle("store-clear", (_e, name: string) => void store(name).clear())
  ipcMain.handle("store-keys", (_e, name: string) => [...store(name).keys()])
  ipcMain.handle("store-length", (_e, name: string) => store(name).size)

  // --- misc Platform shims (no-op/minimal for the skeleton) ---
  ipcMain.handle("get-window-count", () => BrowserWindow.getAllWindows().length)
  ipcMain.handle("get-window-focused", () => Boolean(BrowserWindow.getFocusedWindow()))
  ipcMain.handle("set-window-focus", () => mainWindow?.focus())
  ipcMain.handle("show-window", () => mainWindow?.show())
  ipcMain.on("open-link", (_e, url: string) => {
    if (/^https?:\/\//.test(url)) void import("electron").then(({ shell }) => shell.openExternal(url))
  })
  ipcMain.handle("open-path", (_e, _path: string) => undefined) // TODO: shell.openPath
  ipcMain.handle("set-background-color", (_e, color: string) => {
    if (mainWindow) mainWindow.setBackgroundColor(color)
  })
}

async function start() {
  try {
    process.chdir(homedir())
  } catch {}

  // Disable opencode's bundled web UI inside the embedded server; we ARE the UI.
  process.env.OPENCODE_DISABLE_EMBEDDED_WEB_UI = "true"

  if (!app.requestSingleInstanceLock()) {
    app.quit()
    return
  }

  await app.whenReady()
  registerRendererProtocol()
  registerIpc()

  // ESCAPE HATCH: point at an already-running `opencode serve` instead of
  // embedding the server. Lets the skeleton run before dist/node is built.
  //   ALPHA_SERVER_URL=http://127.0.0.1:4096 \
  //   ALPHA_SERVER_PASSWORD=... ALPHA_SERVER_USERNAME=opencode bun run dev
  const externalUrl = process.env.ALPHA_SERVER_URL
  if (externalUrl) {
    resolveServerReady({
      url: externalUrl,
      username: process.env.ALPHA_SERVER_USERNAME ?? "opencode",
      password: process.env.ALPHA_SERVER_PASSWORD ?? null,
    })
  } else {
    // Embedded server path (mirrors desktop): free port + per-launch password.
    void (async () => {
      try {
        const hostname = "127.0.0.1"
        const port = await freePort()
        const url = `http://${hostname}:${port}`
        const password = randomUUID()
        const { listener } = await spawnLocalServer(hostname, port, password, {
          userDataPath: app.getPath("userData"),
          onStderr: (m) => console.warn("[server]", m),
          onExit: (code) => console.warn("[server] exited", code),
        })
        server = listener
        resolveServerReady({ url, username: "opencode", password })
      } catch (err) {
        console.error("[server] failed to start", err)
        rejectServerReady(err)
      }
    })()
  }

  mainWindow = createMainWindow()

  // DEV diagnostics: surface renderer console, crashes, failed loads, and any
  // full-window navigation (the router-less bug) to the terminal.
  if (mainWindow) {
    const wc = mainWindow.webContents
    wc.on("console-message", (_e, level, message, line, source) => {
      const tag = ["log", "warn", "error", "info"][level] ?? `l${level}`
      if (level >= 2 || process.env.ALPHA_DEBUG) console.log(`[renderer:${tag}] ${message}${line ? ` (${source}:${line})` : ""}`)
    })
    wc.on("render-process-gone", (_e, d) => console.error(`[renderer GONE] reason=${d.reason} exitCode=${d.exitCode ?? "?"}`))
    wc.on("did-fail-load", (_e, code, desc, url) => console.error(`[did-fail-load] ${code} ${desc} ${url}`))
    wc.on("will-navigate", (_e, url) => console.warn(`[will-navigate] ${url}  <-- router-less nav?`))
    wc.setWindowOpenHandler(({ url }) => {
      console.warn(`[window-open] ${url}`)
      return { action: "deny" }
    })
  }

  // DEV screenshot + interactive click test (gated by ALPHA_SCREENSHOT=<dir>).
  // With ALPHA_DEBUG also set, it clicks the main nav items and reports the URL
  // change + any renderer errors after each, plus a screenshot per step.
  if (process.env.ALPHA_SCREENSHOT && mainWindow) {
    const outDir = process.env.ALPHA_SCREENSHOT
    const delayMs = Number.parseInt(process.env.ALPHA_SCREENSHOT_DELAY ?? "14000", 10)
    const interactive = Boolean(process.env.ALPHA_DEBUG)
    const win = mainWindow
    const { writeFile, mkdir } = await import("node:fs/promises")
    const shot = async (name: string) => {
      const img = await win.webContents.capturePage()
      await mkdir(outDir, { recursive: true }).catch(() => {})
      await writeFile(`${outDir}/${name}.png`, img.toPNG())
      console.log(`[shot] ${name} ${JSON.stringify(img.getSize())}`)
    }
    setTimeout(async () => {
      try {
        await win.webContents.executeJavaScript(
          `window.__err=[];addEventListener('error',e=>__err.push('ERR '+e.message));addEventListener('unhandledrejection',e=>__err.push('REJ '+((e.reason&&e.reason.message)||e.reason)));true`,
        )
        await shot("01-home")
        if (interactive) {
          const clickable = await win.webContents.executeJavaScript(
            `Array.from(document.querySelectorAll('button,a,[role=button]')).map(el=>((el.textContent||'').trim().slice(0,24))).filter(Boolean).slice(0,30)`,
          )
          console.log("[clickable]", JSON.stringify(clickable))
          const labels: string[] = await win.webContents.executeJavaScript(
            `['设置','帮助','项目','Settings','Help','New','+'].filter(l=>[...document.querySelectorAll('button,a,[role=button]')].some(e=>(e.textContent||'').includes(l)))`,
          )
          for (const label of labels) {
            const before = await win.webContents.executeJavaScript(`location.href`)
            const res = await win.webContents.executeJavaScript(
              `(()=>{const el=[...document.querySelectorAll('button,a,[role=button]')].find(e=>(e.textContent||'').includes(${JSON.stringify(label)}));if(!el)return'notfound';try{el.click();return'ok'}catch(e){return'throw '+e.message}})()`,
            )
            await new Promise((r) => setTimeout(r, 1800))
            const after = await win.webContents.executeJavaScript(`location.href`)
            const errs = await win.webContents.executeJavaScript(`window.__err.splice(0)`)
            console.log(`[click ${label}] ${res} url=${before === after ? "same" : after} errs=${JSON.stringify(errs)}`)
            await shot(`click-${label.replace(/[^a-zA-Z0-9]/g, "_")}`)
          }
        }
      } catch (e) {
        console.error("[debug] failed", e)
      } finally {
        app.exit(0)
      }
    }, delayMs)
  }

  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) mainWindow = createMainWindow()
  })
  app.on("window-all-closed", () => {
    if (process.platform !== "darwin") app.quit()
  })
  app.on("before-quit", () => void killSidecar())
  for (const sig of ["SIGINT", "SIGTERM"] as const) {
    process.on(sig, () => void killSidecar().finally(() => app.exit(0)))
  }
}

void start()
