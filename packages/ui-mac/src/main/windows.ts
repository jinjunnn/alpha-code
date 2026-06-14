import { BrowserWindow, net, protocol } from "electron"
import { dirname, isAbsolute, join, relative, resolve } from "node:path"
import { fileURLToPath, pathToFileURL } from "node:url"

// oc:// renderer transport + main window. Trimmed from
// opencode/packages/desktop/src/main/windows.ts (no zoom/titlebar/theming/
// recovery dialogs). The scheme name + host MUST stay "oc"/"renderer" because
// the embedded server hardcodes cors:["oc://renderer"] (see sidecar.ts).

const root = dirname(fileURLToPath(import.meta.url))
const rendererRoot = join(root, "../renderer")
const rendererProtocol = "oc"
const rendererHost = "renderer"

// MUST run at module top-level, before app.whenReady().
protocol.registerSchemesAsPrivileged([
  {
    scheme: rendererProtocol,
    privileges: { secure: true, standard: true, supportFetchAPI: true },
  },
])

export function registerRendererProtocol() {
  if (protocol.isProtocolHandled(rendererProtocol)) return
  protocol.handle(rendererProtocol, async (request) => {
    const url = new URL(request.url)
    if (url.host !== rendererHost) return new Response("Not found", { status: 404 })

    const file = resolve(rendererRoot, `.${decodeURIComponent(url.pathname)}`)
    const rel = relative(rendererRoot, file)
    if (rel.startsWith("..") || isAbsolute(rel)) return new Response("Not found", { status: 404 })

    try {
      return await net.fetch(pathToFileURL(file).toString())
    } catch {
      return new Response("Not found", { status: 404 })
    }
  })
}

export function createMainWindow(): BrowserWindow {
  const win = new BrowserWindow({
    width: 1280,
    height: 800,
    show: false,
    autoHideMenuBar: true,
    title: "alpha-code",
    backgroundColor: "#131010",
    ...(process.platform === "darwin"
      ? { titleBarStyle: "hidden" as const, trafficLightPosition: { x: 12, y: 14 } }
      : {}),
    webPreferences: {
      preload: join(root, "../preload/index.js"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  })

  loadWindow(win, "index.html")
  win.once("ready-to-show", () => win.show())
  return win
}

function loadWindow(win: BrowserWindow, html: string) {
  const devUrl = process.env.ELECTRON_RENDERER_URL
  if (devUrl) {
    void win.loadURL(new URL(html, devUrl).toString())
    return
  }
  void win.loadURL(`${rendererProtocol}://${rendererHost}/${html}`)
}
