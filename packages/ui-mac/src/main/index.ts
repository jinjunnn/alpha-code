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
import { registerAutomationIpcHandlers } from "./automation-ipc"
import { startAutomationScheduler } from "./automation-scheduler"
import { registerModelsIpcHandlers } from "./models-ipc"
import { syncLiveAllowlist } from "./alpha-platform-models"
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
import { initialSelfHealState, noteSpawn, planSelfHeal } from "./sidecar-self-heal"
import { initEndpoints } from "./alpha-endpoints"
import { registerEndpointsIpcHandlers } from "./endpoints-ipc"
import { initByokKeys, injectByokKeysIntoEnv, setByokKeyDeps } from "./alpha-byok-keys"
import {
  enableProxy,
  ensureFreshToken,
  getAuthState,
  handleAuthDeepLink,
  initAuthEnv,
  isStoredTokenExpired,
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
// B2:当前运行的 sidecar 在 fork 时冻住的 access token 的过期时刻(config {file:} 在加载时解析一次,
// 之后 main 侧刷新传不进去)。整点 tick 据此做「快过期 → 静默 respawn 换血」的备胎。
let sidecarTokenExpiresAt: number | undefined
const markSidecarTokenSnapshot = () => {
  sidecarTokenExpiresAt = getAuthState().expiresAt
}

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

// B5 crash self-heal(wiring;决策逻辑在 sidecar-self-heal.ts)。gen 区分「本代 child 崩了」与
// 「上一代 child 的迟到 exit」;蓄意 kill 的信号 = killSidecar 先把 `server` 置 null 再 stop。
let quittingApp = false
let sidecarGen = 0
let selfHeal = initialSelfHealState()
let selfHealTimer: NodeJS.Timeout | null = null
let requestSidecarRespawn: (() => Promise<void>) | null = null

function handleSidecarExit(gen: number, code: number) {
  writeLog("utility", "sidecar exited", { code }, "warn")
  if (quittingApp) return
  if (gen !== sidecarGen) return
  if (!server) return
  const plan = planSelfHeal(selfHeal, Date.now())
  selfHeal = plan.state
  if (plan.action === "give-up") {
    writeLog("utility", "sidecar crash-loop — self-heal gave up; login/proxy toggles still respawn manually", { attempts: selfHeal.attempts }, "error")
    return
  }
  writeLog("utility", "sidecar self-heal scheduled", { delayMs: plan.delayMs, attempt: selfHeal.attempts }, "warn")
  if (selfHealTimer) clearTimeout(selfHealTimer)
  selfHealTimer = setTimeout(() => {
    selfHealTimer = null
    void requestSidecarRespawn?.()
  }, plan.delayMs)
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
    // REQ-018:安装真源(~/.alpha)与引擎桥根(~/.opencode)不在 XDG 下 → 测试态显式改道,
    // 否则隔离 test build 的定制中心安装会写进真实 home(os.homedir() 不吃 env 重定向)。
    process.env.ALPHA_GLOBAL_DIR = join(root, "alpha-home")
    process.env.ALPHA_OPENCODE_HOME = join(root, "opencode-home")
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
  // ⚠️ initAuthEnv / initByokKeys 不能在这里调(REQ-002 联调实锤,2026-07-03):它们解密 safeStorage
  // 凭证,而 macOS 上 app ready 之前 safeStorage 不可用 → 解密静默失败 → 每次冷启动都"未登录"、
  // BYOK 钥匙库曾因此走明文兜底。已移至 whenReady 之后、sidecar fork 之前(见下)。

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
    quittingApp = true // B5:退出期的 sidecar exit 不触发自愈
    if (selfHealTimer) clearTimeout(selfHealTimer)
    void stopSidecars()
  })

  app.on("will-quit", () => {
    quittingApp = true
    if (selfHealTimer) clearTimeout(selfHealTimer)
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

  // Derive the platform proxy env (ALPHA_BASE_URL/ALPHA_API_KEY for the model proxy + cloud MCP)
  // from any stored login or DEV_PLATFORM_TOKEN,AFTER app ready(safeStorage 可用)且 BEFORE
  // sidecar fork(~L400)。修复:冷启动登录态恢复(原 pre-ready 调用解密恒失败)。A6:ALPHA_BASE_URL
  // 过 sidecar env 白名单;密钥不进 sidecar env,由 spawnLocalServer 在 fork 时经 syncSecretFiles
  // 落入 {file:} 通道(alpha-secret-files.ts)。
  initAuthEnv(app.getPath("userData"))
  // Load alpha's encrypted BYOK key vault (migrates any key off opencode auth.json once) and bridge
  // each stored key into its provider's keyEnv in MAIN's env BEFORE the sidecar forks — that's the
  // source syncSecretFiles mirrors into the {file:} channel that buildAlphaModelConfig (sidecar)
  // references (A6). See alpha-byok-keys.ts.
  initByokKeys(app.getPath("userData"))
  injectByokKeysIntoEnv()
  // REQ-001:异步同步 B 网关 edition 白名单缓存(fire-and-forget,不阻塞窗口/首个 fork——B1 纪律)。
  // 首启无缓存 → 本次 fork 用内置 snapshot;同步成功后 picker 立即收窄,装配随下次 fork/respawn 生效。
  void syncLiveAllowlist(app.getPath("userData")).catch(() => {})

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
  registerExtIpcHandlers(app.getPath("userData"))
  registerAccountIpcHandlers()
  registerCloudIpcHandlers()
  // 自动化(REQ-021 A1/ADR-022):IPC + 主进程调度器。执行链等 serverReady(与 renderer 同一
  // Deferred;respawn 后 url/password 不变故一次 await 长期有效)。应用未运行不执行(诚实边界)。
  registerAutomationIpcHandlers()
  startAutomationScheduler({ awaitServer: () => Effect.runPromise(Deferred.await(serverReady)) })
  registerModelsIpcHandlers(app.getPath("userData"))
  registerProviderIpcHandlers()
  registerEndpointsIpcHandlers()
  void updater.start()
  const updateTimer = setInterval(() => void updater.check(), 10 * 60 * 1000)
  updateTimer.unref()
  app.once("will-quit", () => clearInterval(updateTimer))

  // B2:token 保活 tick(每小时)。到提前量(7d token 提前 24h,见 alpha-auth-clock.ts)就轮换刷新;
  // 备胎:运行中 sidecar 在 fork 时冻住的 token 快死(<30min,即 app 连续跑满一个 token 寿命)时,
  // 续期 + 静默 respawn 换血——7d 寿命下极少发生,发生时接受一次界面重载并留日志。
  const authTimer = setInterval(() => {
    void (async () => {
      await ensureFreshToken().catch(() => {})
      if (sidecarTokenExpiresAt && sidecarTokenExpiresAt - Date.now() < 30 * 60 * 1000) {
        logger.log("B2: sidecar's fork-time token near expiry — quiet respawn to rotate")
        await respawnSidecar()
      }
    })()
  }, 60 * 60 * 1000)
  authTimer.unref()
  app.once("will-quit", () => clearInterval(authTimer))
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

    // B2:存储的 access token 已过期(app 停机超过 token 寿命)→ fork 前 await 续期一次(fetch 10s
    // 超时封顶)。死 token fork 出的 sidecar 每次模型调用都 401,先续再 fork 才有意义;仅过期才阻塞
    // (未过期时的近期续期由整点 tick 异步做,不碰启动路径——B1 纪律)。
    if (isStoredTokenExpired()) yield* Effect.promise(() => ensureFreshToken().catch(() => {}))
    markSidecarTokenSnapshot()

    logger.log("spawning sidecar", { url })
    const spawnGen = ++sidecarGen
    selfHeal = noteSpawn(selfHeal, Date.now())
    const { listener, health } = yield* Effect.promise(() =>
      spawnLocalServer(hostname, port, password, {
        userDataPath: app.getPath("userData"),
        onStdout: (message) => writeLog("server", "stdout", { message }),
        onStderr: (message) => writeLog("server", "stderr", { message }, "warn"),
        onExit: (code) => handleSidecarExit(spawnGen, code),
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
  // Re-forks on the SAME host/port/password with freshly-derived state (login set ALPHA_BASE_URL +
  // ALPHA_API_KEY in main's env → fork-time syncSecretFiles refreshes the {file:} channel →
  // buildAlphaModelConfig injects provider.alpha), then reloads the renderer so it
  // reconnects (url/password unchanged → awaitInitialization stays valid) and re-fetches providers →
  // the proxy activates with zero clicks and no restart.
  const doRespawnSidecar = async () => {
    if (quittingApp) return
    try {
      logger.log("respawning sidecar (proxy activation)")
      // REQ-001:respawn 前刷新 edition 白名单缓存(登录刚建立 → 按租户 edition 收窄;8s 超时内置,
      // 失败保留 last-known/内置 snapshot,不阻断 respawn)。
      await syncLiveAllowlist(app.getPath("userData")).catch(() => {})
      markSidecarTokenSnapshot() // B2:新 fork 冻住的是当前 token —— 重新打点
      await killSidecar()
      ensureLoopbackNoProxy()
      useEnvProxy()
      const spawnGen = ++sidecarGen
      selfHeal = noteSpawn(selfHeal, Date.now())
      const { listener, health } = await spawnLocalServer(hostname, port, password, {
        userDataPath: app.getPath("userData"),
        onStdout: (message) => writeLog("server", "stdout", { message }),
        onStderr: (message) => writeLog("server", "stderr", { message }, "warn"),
        onExit: (code) => handleSidecarExit(spawnGen, code),
      })
      server = listener
      // B5 验收②:未健康不 reload —— reload 进死后端只会白屏(REQ-014 同族),留旧 renderer 状态。
      const healthy = await Promise.race([
        health.wait.then(() => true, () => false),
        new Promise<boolean>((resolve) => setTimeout(() => resolve(false), 20000)),
      ])
      if (healthy && mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.reload()
        logger.log("sidecar respawned + renderer reloaded")
      } else if (!healthy) {
        logger.error("sidecar respawned but health check failed — skipping renderer reload")
      }
    } catch (error) {
      logger.error("sidecar respawn failed", error)
    }
  }
  // B5(NEW-4):respawn 互斥 + 合并。触发面已扩大(登录/登出/enableProxy/setAuthMode/B2 tick/
  // B21 改键),并发触发会两个 fork 抢同一端口、renderer 双重 reload。单飞:在途时再触发只标记
  // 一次排队,完成后补跑一轮(拿到最新 env/密钥状态,不会丢最后一次变更)。
  let respawning: Promise<void> | null = null
  let respawnQueued = false
  const respawnSidecar = async (): Promise<void> => {
    if (respawning) {
      respawnQueued = true
      return respawning
    }
    respawning = doRespawnSidecar().finally(() => {
      respawning = null
      if (respawnQueued) {
        respawnQueued = false
        void respawnSidecar()
      }
    })
    return respawning
  }

  requestSidecarRespawn = respawnSidecar // B5:崩溃自愈复用同一互斥/合并入口
  setAuthDeps({ getWindow: () => mainWindow, respawn: respawnSidecar })
  // B21:BYOK 改键/删键即时生效 —— 持久化成功后重注 env(自有注入权威覆盖/清除,用户值不动)+
  // respawn(fork 时 A6 syncSecretFiles 把新 env 镜像进 {file:} 通道 → 新 sidecar 即用新 key)。
  setByokKeyDeps({
    onChanged: () => {
      injectByokKeysIntoEnv()
      void respawnSidecar()
    },
  })
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
