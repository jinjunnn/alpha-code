import { randomUUID } from "node:crypto"
import { mkdirSync, rmSync } from "node:fs"
import * as http from "node:http"
import { createServer } from "node:net"
import { homedir, tmpdir } from "node:os"
import { join } from "node:path"
import { getCACertificates, setDefaultCACertificates } from "node:tls"
import type { Event } from "electron"
import { app, BrowserWindow } from "electron"

import { Deferred, Effect } from "effect"
import contextMenu from "electron-context-menu"

import type { ServerReadyData } from "../preload/types"
import { checkAppExists, resolveAppPath } from "./apps"
import { CHANNEL } from "./constants"
import { registerIpcHandlers, sendDeepLinks, sendMenuCommand } from "./ipc"
import { registerExtIpcHandlers } from "./ext-ipc"
import { registerAccountIpcHandlers } from "./account-ipc"
import { registerCloudIpcHandlers } from "./cloud-ipc"
import { registerModelsIpcHandlers } from "./models-ipc"
import { registerProviderIpcHandlers } from "./provider-ipc"
import { forwardInitializationFailure } from "./initialization"
import { exportDebugLogs, initCrashReporter, initLogging, startNetLog, write as writeLog } from "./logging"
import { parseMarkdown } from "./markdown"
import { createMenu } from "./menu"
import {
  getDefaultServerUrl,
  preferAppEnv,
  setDefaultServerUrl,
  spawnLocalServer,
  type SidecarListener,
} from "./server"
import { setupAutoUpdater, showUpdaterDialog } from "./updater"
import {
  createMainWindow,
  registerRendererProtocol,
  setRelaunchHandler,
  setBackgroundColor,
  setDockIcon,
} from "./windows"
import { createWslServersController } from "./wsl/servers"
import { registerWslIpcHandlers } from "./wsl/ipc"
import { spawnWslSidecar } from "./wsl/sidecar"
import { migrate } from "./migrate"
import { ensureAlphaLayoutDefault } from "./alpha-defaults"
import { initEndpoints } from "./alpha-endpoints"
import { registerEndpointsIpcHandlers } from "./endpoints-ipc"
import { initByokKeys, injectByokKeysIntoEnv } from "./alpha-byok-keys"
import {
  enableProxy,
  getAuthState,
  handleAuthDeepLink,
  initAuthEnv,
  logout as authLogout,
  setAuthDeps,
  setAuthMode,
  startAuth,
} from "./alpha-auth"

const APP_NAMES: Record<string, string> = {
  dev: "alpha-code",
  beta: "alpha-code Beta",
  prod: "alpha-code",
}
const APP_IDS: Record<string, string> = {
  dev: "ai.opencode.desktop.dev",
  beta: "ai.opencode.desktop.beta",
  prod: "ai.opencode.desktop",
}
const TEST_ONBOARDING = process.env.OPENCODE_TEST_ONBOARDING === "1"
const jsCallStackFeature = "DocumentPolicyIncludeJSCallStacksInCrashReports"

let logger: ReturnType<typeof initLogging>
let mainWindow: BrowserWindow | null = null
let server: SidecarListener | null = null

const pendingDeepLinks: string[] = []

function useEnvProxy() {
  try {
    // Electron 41.2 runs Node 24.14.1; latest @types/node@24 is 24.12.2.
    ;(http as any).setGlobalProxyFromEnv()
  } catch (error) {
    logger.warn("failed to load proxy environment", error)
  }
}

function emitDeepLinks(urls: string[]) {
  // alpha-code://auth/* is consumed by the auth module (PKCE token exchange) and never forwarded
  // to the renderer; every other deep link flows on as before.
  const forwarded = urls.filter((url) => !handleAuthDeepLink(url))
  if (forwarded.length === 0) return
  pendingDeepLinks.push(...forwarded)
  if (mainWindow) sendDeepLinks(mainWindow, forwarded)
}

async function killSidecar() {
  if (!server) return
  const current = server
  server = null
  await current.stop()
}

function ensureLoopbackNoProxy() {
  const loopback = ["127.0.0.1", "localhost", "::1"]
  const upsert = (key: string) => {
    const items = (process.env[key] ?? "")
      .split(",")
      .map((value: string) => value.trim())
      .filter((value: string) => Boolean(value))

    for (const host of loopback) {
      if (items.some((value: string) => value.toLowerCase() === host)) continue
      items.push(host)
    }

    process.env[key] = items.join(",")
  }

  upsert("NO_PROXY")
  upsert("no_proxy")
}

const main = Effect.gen(function* () {
  contextMenu({ showSaveImageAs: true, showLookUpSelection: false, showSearchWithGoogle: false })

  // on macOS apps run in `/` which can cause issues with ripgrep
  try {
    process.chdir(homedir())
  } catch {}

  process.env.OPENCODE_DISABLE_EMBEDDED_WEB_UI = "true"

  const appId = app.isPackaged ? APP_IDS[CHANNEL] : "ai.opencode.desktop.dev"
  const onboardingTestRoot = ((): string | undefined => {
    if (!TEST_ONBOARDING) return

    const root = join(tmpdir(), `opencode-onboarding-${randomUUID()}`)
    rmSync(root, { recursive: true, force: true })
    ;["data", "config", "cache", "state", "desktop", "session"].forEach((dir) =>
      mkdirSync(join(root, dir), { recursive: true }),
    )
    process.env.OPENCODE_DB = ":memory:"
    process.env.XDG_DATA_HOME = join(root, "data")
    process.env.XDG_CONFIG_HOME = join(root, "config")
    process.env.XDG_CACHE_HOME = join(root, "cache")
    process.env.XDG_STATE_HOME = join(root, "state")
    return root
  })()
  app.setName(app.isPackaged ? APP_NAMES[CHANNEL] : "alpha-code")
  app.setAppUserModelId(appId)
  // B15: surface the MIT attribution in the native About panel (opencode is MIT — its copyright +
  // permission notice must ship with the app; full text in resources/NOTICE.txt).
  app.setAboutPanelOptions({
    applicationName: "alpha-code",
    applicationVersion: app.getVersion(),
    copyright: "© 2025 opencode (MIT). alpha-code fork build.",
    credits: "Built on OpenCode (MIT) — https://github.com/anomalyco/opencode",
  })
  app.setPath(
    "userData",
    onboardingTestRoot ? join(onboardingTestRoot, "desktop") : join(app.getPath("appData"), appId),
  )
  if (onboardingTestRoot) app.setPath("sessionData", join(onboardingTestRoot, "session"))
  logger = initLogging()
  initCrashReporter()

  const wslServers = createWslServersController(
    app.getVersion(),
    async (distro) => {
      logger.log("spawning wsl sidecar", { distro })
      return spawnWslSidecar(distro, {
        onLine: (line) => logger.log("wsl sidecar", { distro, stream: line.stream, text: line.text }),
      })
    },
    {
      logger: {
        log: (message, meta) => logger.log(message, meta),
        error: (message, meta) => logger.error(message, meta),
      },
    },
  )
  const stopSidecars = async () => {
    await killSidecar()
    wslServers.stopAll()
  }
  const relaunch = () => {
    void stopSidecars().finally(() => {
      app.relaunch()
      app.exit(0)
    })
  }

  try {
    setDefaultCACertificates([...new Set([...getCACertificates("default"), ...getCACertificates("system")])])
  } catch (error) {
    logger.warn("failed to load system certificates", error)
  }

  logger.log("app starting", {
    version: app.getVersion(),
    packaged: app.isPackaged,
    onboardingTest: Boolean(onboardingTestRoot),
  })

  ensureLoopbackNoProxy()
  useEnvProxy()
  app.commandLine.appendSwitch("proxy-bypass-list", "<-loopback>")
  const features = app.commandLine.getSwitchValue("enable-features")
  app.commandLine.appendSwitch("enable-features", features ? `${jsCallStackFeature},${features}` : jsCallStackFeature)
  // Dev always exposes CDP for the visual-audit harness; ALPHA_CDP=1 also opens it on a
  // PACKAGED build so the real-data (logged-in) UI can be screenshot-audited via CDP.
  if (!app.isPackaged || process.env.ALPHA_CDP === "1") app.commandLine.appendSwitch("remote-debugging-port", "9222")

  if (!app.requestSingleInstanceLock()) {
    app.quit()
    return
  }

  preferAppEnv(app.getPath("userData"))
  // Load the endpoint resolver (userData pin + persisted login discovery) BEFORE initAuthEnv, so the
  // proxy URL it derives reflects discovery/pin, not just the hardcoded default. See alpha-endpoints.ts.
  initEndpoints(app.getPath("userData"))
  // Derive the platform proxy env (ALPHA_BASE_URL/ALPHA_API_KEY for the model proxy + cloud MCP)
  // from any stored login or DEV_PLATFORM_TOKEN, BEFORE the sidecar forks so it inherits them.
  initAuthEnv(app.getPath("userData"))
  // Load alpha's encrypted BYOK key vault (migrates any key off opencode auth.json once) and bridge
  // each stored key into its provider's keyEnv BEFORE the sidecar forks, so buildAlphaModelConfig
  // (sidecar) can inline it as a direct-node apiKey. See alpha-byok-keys.ts.
  initByokKeys(app.getPath("userData"))
  injectByokKeysIntoEnv()

  // Auth callbacks arrive as alpha-code://auth/callback?code=...&state=... — strip the query before
  // logging so the single-use PKCE code / CSRF state never lands in main.log (exportDebugLogs ships it).
  const redactDeepLink = (u: string): string => {
    try {
      const p = new URL(u)
      return p.search ? `${p.origin}${p.pathname}?<redacted>` : `${p.origin}${p.pathname}`
    } catch {
      return "<invalid-url>"
    }
  }

  app.on("second-instance", (_event: Event, argv: string[]) => {
    const urls = argv.filter((arg: string) => arg.startsWith("opencode://") || arg.startsWith("alpha-code://"))
    if (urls.length) {
      logger.log("deep link received via second-instance", { urls: urls.map(redactDeepLink) })
      emitDeepLinks(urls)
    }
    if (mainWindow) {
      mainWindow.show()
      mainWindow.focus()
    }
  })

  app.on("open-url", (event: Event, url: string) => {
    event.preventDefault()
    logger.log("deep link received via open-url", { url: redactDeepLink(url) })
    emitDeepLinks([url])
    // Bring the app to the foreground. The auth callback arrives while the browser is focused;
    // unlike "second-instance", "open-url" does NOT auto-activate the app, so login would otherwise
    // complete silently in the background. steal:true overrides macOS focus-stealing prevention.
    if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore()
      mainWindow.show()
      mainWindow.focus()
    }
    app.focus({ steal: true })
  })

  app.on("before-quit", () => {
    void stopSidecars()
  })

  app.on("will-quit", () => {
    void stopSidecars()
  })

  app.on("child-process-gone", (_event, details) => {
    writeLog("utility", "child process gone", { details }, "error")
  })

  app.on("render-process-gone", (_event, webContents, details) => {
    writeLog("window", "app render process gone", { url: webContents.getURL(), details }, "error")
  })

  setRelaunchHandler(() => {
    relaunch()
  })

  for (const signal of ["SIGINT", "SIGTERM"] as const) {
    process.on(signal, () => {
      void stopSidecars().finally(() => app.exit(0))
    })
  }

  const serverReady = Deferred.makeUnsafe<ServerReadyData, unknown>()

  yield* Effect.promise(() => app.whenReady())

  if (!TEST_ONBOARDING) migrate()
  ensureAlphaLayoutDefault()
  // Packaged builds only: on macOS this sets the user-level Launch Services handler pref to the
  // bundle the process runs from — in dev that is node_modules' bare Electron.app, which then hijacks
  // the schemes system-wide: auth callbacks cold-start a blank Electron welcome window instead of the
  // installed app (until the installed app relaunches and re-registers). Dev deep-link testing:
  // ALPHA_DEV_PROTOCOL=1, and keep the dev instance running so open-url is delivered to it.
  if (app.isPackaged || process.env.ALPHA_DEV_PROTOCOL === "1") {
    app.setAsDefaultProtocolClient("opencode")
    // Own auth-callback scheme, registered alongside opencode:// (not replacing it), so a co-installed
    // official opencode desktop can neither hijack nor be hijacked by our alpha-code://auth/callback.
    app.setAsDefaultProtocolClient("alpha-code")
  }
  registerRendererProtocol()
  setDockIcon()
  const updater = setupAutoUpdater(stopSidecars)
  registerIpcHandlers({
    killSidecar: () => killSidecar(),
    relaunch,
    awaitInitialization: Effect.fnUntraced(
      function* () {
        logger.log("awaiting server ready")
        const res = yield* Deferred.await(serverReady)
        logger.log("server ready", { url: res.url })
        return res
      },
      (e) => Effect.runPromise(e),
    ),
    consumeInitialDeepLinks: () => pendingDeepLinks.splice(0),
    getDefaultServerUrl: () => getDefaultServerUrl(),
    setDefaultServerUrl: (url) => setDefaultServerUrl(url),
    getDisplayBackend: async () => null,
    setDisplayBackend: async () => undefined,
    parseMarkdown: async (markdown) => parseMarkdown(markdown),
    checkAppExists: (appName) => checkAppExists(appName),
    resolveAppPath: async (appName) => resolveAppPath(appName),
    updater,
    showUpdater: () => showUpdaterDialog(updater, true),
    setBackgroundColor: (color) => setBackgroundColor(color),
    exportDebugLogs: () => exportDebugLogs(),
    recordFatalRendererError: (error) => writeLog("renderer", "fatal renderer error", { ...error }, "error"),
    auth: {
      getState: () => getAuthState(),
      start: () => startAuth(),
      logout: () => authLogout(),
      setMode: (mode) => setAuthMode(mode),
      enableProxy: () => enableProxy(),
    },
  })
  registerWslIpcHandlers(wslServers)
  registerExtIpcHandlers()
  registerAccountIpcHandlers()
  registerCloudIpcHandlers()
  registerModelsIpcHandlers()
  registerProviderIpcHandlers()
  registerEndpointsIpcHandlers()
  void updater.start()
  const updateTimer = setInterval(() => void updater.check(), 10 * 60 * 1000)
  updateTimer.unref()
  app.once("will-quit", () => clearInterval(updateTimer))
  yield* Effect.promise(() => startNetLog()).pipe(
    Effect.catch((error) =>
      Effect.sync(() => {
        logger.warn("failed to start net log", error)
      }),
    ),
  )

  const port = yield* Effect.gen(function* () {
    const fromEnv = process.env.OPENCODE_PORT
    if (fromEnv) {
      const parsed = Number.parseInt(fromEnv, 10)
      if (!Number.isNaN(parsed)) return parsed
    }

    const res = yield* Deferred.make<number, unknown>()
    const server = createServer()
    server.on("error", (e) => Deferred.failSync(res, () => e))
    server.listen(0, "127.0.0.1", () => {
      const address = server.address()
      if (typeof address !== "object" || !address) {
        server.close()
        Deferred.failSync(res, () => new Error("Failed to get port"))
        return
      }
      const port = address.port
      server.close(() => Effect.runSync(Deferred.succeed(res, port)))
    })

    return yield* Deferred.await(res)
  })
  const hostname = "127.0.0.1"
  const url = `http://${hostname}:${port}`
  const password = randomUUID()

  yield* Effect.gen(function* () {
    logger.log("sidecar connection started", { url })

    ensureLoopbackNoProxy()
    useEnvProxy()

    logger.log("spawning sidecar", { url })
    const { listener, health } = yield* Effect.promise(() =>
      spawnLocalServer(hostname, port, password, {
        userDataPath: app.getPath("userData"),
        onStdout: (message) => writeLog("server", "stdout", { message }),
        onStderr: (message) => writeLog("server", "stderr", { message }, "warn"),
        onExit: (code) => writeLog("utility", "sidecar exited", { code }, "warn"),
      }),
    )
    server = listener
    yield* Deferred.succeed(serverReady, {
      url,
      username: "opencode",
      password,
    })

    if (process.platform === "win32") {
      void wslServers.initialize().catch((error) => logger.error("wsl server initialization failed", error))
    }

    yield* Effect.promise(() => health.wait).pipe(
      Effect.timeout("30 seconds"),
      Effect.catch((e) =>
        Effect.sync(() => {
          logger.error("sidecar health check failed", e.toString())
        }),
      ),
    )

    logger.log("loading task finished")
  }).pipe(forwardInitializationFailure(serverReady), Effect.forkChild)

  // A1 (window-first): open the window as soon as the sidecar has spawned (serverReady settles) rather
  // than blocking on the health probe (~line 410), which can lag many seconds under a slow sidecar / MCP
  // storm. The renderer shows a splash and gates on this same serverReady via awaitInitialization; the
  // forked task finishes health.wait in the background. Awaiting serverReady (not zero-wait) keeps the
  // forked spawn alive to completion; we ignore its failure so the window still opens to surface the
  // connection error, matching the prior behavior.
  yield* Deferred.await(serverReady).pipe(Effect.catch(() => Effect.sync(() => {})))

  mainWindow = createMainWindow()

  // In-place sidecar respawn — NOT a full app relaunch (ad-hoc-signed builds quit on relaunch, ADR-017).
  // Re-forks on the SAME host/port/password with freshly-derived env (login set ALPHA_BASE_URL/
  // ALPHA_API_KEY → buildAlphaModelConfig injects provider.alpha), then reloads the renderer so it
  // reconnects (url/password unchanged → awaitInitialization stays valid) and re-fetches providers →
  // the proxy activates with zero clicks and no restart.
  const respawnSidecar = async () => {
    if (!mainWindow || mainWindow.isDestroyed()) return
    try {
      logger.log("respawning sidecar (proxy activation)")
      await killSidecar()
      ensureLoopbackNoProxy()
      useEnvProxy()
      const { listener, health } = await spawnLocalServer(hostname, port, password, {
        userDataPath: app.getPath("userData"),
        onStdout: (message) => writeLog("server", "stdout", { message }),
        onStderr: (message) => writeLog("server", "stderr", { message }, "warn"),
        onExit: (code) => writeLog("utility", "sidecar exited", { code }, "warn"),
      })
      server = listener
      await Promise.race([health.wait.catch(() => {}), new Promise((resolve) => setTimeout(resolve, 20000))])
      if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.reload()
      logger.log("sidecar respawned + renderer reloaded")
    } catch (error) {
      logger.error("sidecar respawn failed", error)
    }
  }

  setAuthDeps({ getWindow: () => mainWindow, respawn: respawnSidecar })
  if (mainWindow) {
    createMenu({
      trigger: (id) => {
        const win = BrowserWindow.getFocusedWindow() ?? mainWindow
        if (win) sendMenuCommand(win, id)
      },
      checkForUpdates: () => {
        void showUpdaterDialog(updater, true)
      },
      relaunch: () => {
        relaunch()
      },
    })
  }
})

Effect.runFork(main)
