import { randomUUID } from "node:crypto"
import { mkdirSync, rmSync } from "node:fs"
import * as http from "node:http"
import { createServer } from "node:net"
import { homedir, tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"
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
import { refreshRemoteCatalog } from "./remote-catalog"
import { registerAccountIpcHandlers } from "./account-ipc"
import { registerCloudIpcHandlers } from "./cloud-ipc"
import { registerArtifactIpcHandlers } from "./artifact-ipc"
import { registerHtmlPreviewIpcHandlers } from "./html-preview-host"
import { registerAutomationIpcHandlers } from "./automation-ipc"
import { startAutomationScheduler } from "./automation-scheduler"
import { initAutomationLlm } from "./automation-llm"
import { pullCloudScheduleRuns } from "./alpha-cloud-schedules"
import { registerModelsIpcHandlers } from "./models-ipc"
import { syncLiveAllowlist } from "./alpha-platform-models"
import { registerProviderIpcHandlers } from "./provider-ipc"
import { forwardInitializationFailure } from "./initialization"
import { exportDebugLogs, initCrashReporter, initLogging, startNetLog, write as writeLog } from "./logging"
import { getStore } from "./store"
import { GLOBAL_RENDERER_STORE, runTabsPreclean } from "./tabs-preclean"
import { checkSessionExistsViaFetch } from "./tabs-preclean-io"
import { parseMarkdown } from "./markdown"
import { createDbMenuActions, runDbPreflightBoot } from "./db-safety-boot"
import { createDataClearAction } from "./data-clear-boot"
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
import { initAlphaEnvironment } from "./alpha-environment"
import { runEnvMigration } from "./alpha-env-migrate"
import { ensureAlphaLayoutDefault } from "./alpha-defaults"
import { initialSelfHealState, noteSpawn, planSelfHeal } from "./sidecar-self-heal"
import { initEndpoints } from "./alpha-endpoints"
import { registerEndpointsIpcHandlers } from "./endpoints-ipc"
import { registerSurfaceIpc } from "./alpha-surfaces"
import { initByokKeys, injectByokKeysIntoEnv, setByokKeyDeps } from "./alpha-byok-keys"
import { reconcileEngineConfigTruth } from "./engine-config-truth-boot"
import { factorySkillSources, reconcileFactorySkills } from "./factory-skills"
import { runGlobalEcosystemGate } from "./ecosystem-gate"
import { effectiveFactoryDenied, readGovernance } from "./alpha-governance"
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
    // Electron 内置的 Node 领先于已发布的 @types/node —— setGlobalProxyFromEnv 运行时存在但类型
    // 里没有,故 cast(D10:不再写死版本号,避免注释随升级过期)。
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
    // B11 复扫行11:停手不再只留日志 —— 推给 renderer(侧栏持久 banner + toast;重试走 sidecar-retry)。
    if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send("sidecar-fatal", { attempts: selfHeal.attempts })
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
  // REQ-098:唯一环境映射(prod/beta/dev → mutable root / registry channel / updater feed)在任何
  // alphaGlobalRoot() 消费方(reconcile / 安装 / sidecar fork)之前落定。ALPHA_GLOBAL_DIR 预置
  // (测试隔离 / 开发者显式 export,含 preferAppEnv 应用的真实 shell export)= 覆盖,不改写。
  const alphaEnv = initAlphaEnvironment({ isPackaged: app.isPackaged, channel: CHANNEL })
  logger.log("alpha environment resolved", {
    environment: alphaEnv.environment,
    registryChannel: alphaEnv.registryChannel,
    mutableRoot: alphaEnv.mutableRoot,
    rootOverridden: alphaEnv.rootOverridden,
  })
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
  // REQ-098 T3:旧 `~/.alpha` 单根布局 → 当前环境 mutable root 的一次性只读导入(copy-don't-touch,
  // 幂等 + crash 可重试,receipt = <envRoot>/env-migration-receipt.json,旧根留 rollback 标记)。
  // dev 环境 root = 旧根 → 天然 skipped-same-root。置于 REQ-059 reconcile 之前:首次 reconcile
  // 即读到导入后的 alpha.jsonc。失败非致命(环境以空状态启动,旧布局原样,下次启动重试)。
  if (!TEST_ONBOARDING) {
    try {
      const envImport = runEnvMigration({
        sourceRoot: alphaEnv.legacyRoot,
        targetRoot: alphaEnv.mutableRoot,
        userDataPath: app.getPath("userData"),
        environment: alphaEnv.environment,
        appVersion: app.getVersion(),
      })
      if (envImport.status === "migrated") {
        logger.log("[req098] legacy ~/.alpha imported into environment root", {
          environment: alphaEnv.environment,
          results: envImport.receipt.results,
          secretRefs: envImport.receipt.secretRefs,
          pathsRewritten: envImport.receipt.pathsRewritten,
          warnings: envImport.receipt.warnings,
        })
      } else if (envImport.status === "failed") {
        logger.error("[req098] environment import FAILED (legacy layout untouched; retry next launch)", {
          reason: envImport.reason,
          warnings: envImport.warnings,
        })
      }
    } catch (error) {
      logger.error("[req098] environment import crashed (legacy layout untouched; retry next launch)", error)
    }
  }
  // REQ-059:存量引擎配置(~/.opencode/opencode.jsonc + XDG provider 域)迁进真源 ~/.alpha/alpha.jsonc
  // (copy-don't-delete,幂等,所有权判定 bail-out loud)。在 migrate() 之后(REQ-018 先把散落迁 ~/.opencode)、
  // 首个 sidecar fork 之前,使第一次 fork 即读到迁移后配置。~/.opencode 清理(拆桥+删目录)属 T3。
  // REQ-065(修订,用户拍板 2026-07-08):出厂技能先行 reconcile(拆存量 .alpha 出厂链 + 计算注入组);
  // 注入组**不落盘** —— 经 ALPHA_FACTORY_SKILL_DIRS(env,fork 继承)传引擎,由 @alpha-code/ext
  // config hook 内存注入 skills.paths。alpha.jsonc 只承载用户自己的内容:truth reconcile 传 []
  // 剥离历史版本写入的出厂条目(布局+名单判定,用户自加路径不动)。anti-B11:结果落日志。
  if (!TEST_ONBOARDING) {
    let stripFactory: string[] | undefined
    try {
      const factory = reconcileFactorySkills(
        factorySkillSources({
          packaged: app.isPackaged,
          resourcesPath: process.resourcesPath,
          moduleDir: dirname(fileURLToPath(import.meta.url)),
        }),
      )
      process.env.ALPHA_FACTORY_SKILL_DIRS = JSON.stringify(factory.paths)
      stripFactory = [] // reconcile 成功 → 剥离 alpha.jsonc 里的存量出厂条目(它们改由内存注入)
      // REQ-067:出厂默认禁项(− 用户治理解禁)同走 env → ext hook 内存注入,用户配置零明文
      process.env.ALPHA_FACTORY_DENY_SKILLS = JSON.stringify(effectiveFactoryDenied(readGovernance()))
      if (factory.removed.length)
        logger.log("[req065] factory-skills: stale .alpha links dismantled (factory content now served from app resources)", {
          removed: factory.removed,
        })
      if (factory.migrated.length) logger.log("[req065] factory-skills: legacy ~/.opencode/skill direct links removed", { migrated: factory.migrated })
      for (const s of factory.skipped) logger.warn(`[req065] factory-skills: SKIPPED ${s.name} — ${s.reason}`)
    } catch (error) {
      logger.warn("[req065] factory-skills reconcile failed (non-fatal; skills.paths group left untouched)", error)
    }
    try {
      const outcome = reconcileEngineConfigTruth(logger, { factorySkillDirs: stripFactory })
      if (!outcome.skipped && outcome.bailedOut)
        logger.warn("[req059] engine config reconcile bailed out (kept legacy in place)", { reason: outcome.bailedOut })
    } catch (error) {
      logger.warn("[req059] engine config reconcile failed (non-fatal)", error)
    }
  }
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
  // REQ-014:冷启动 tabs 毒键预清 —— tier-1 格式级同步执行(此刻窗口未建,写回零竞态);tier-2 存在性
  // 校验等 serverReady(时限 fail-open)。renderer 对 tabs 两键的首读经 store-get gate 等 done(ipc.ts),
  // 故窗口照常先开(A1 window-first),只有 tabs 路由恢复数据最多晚数秒。
  const tabsPreclean = runTabsPreclean({
    getValue: (key) => getStore(GLOBAL_RENDERER_STORE).get(key),
    setValue: (key, value) => getStore(GLOBAL_RENDERER_STORE).set(key, value),
    log: (line) => logger.log(line),
    awaitServer: () => Effect.runPromise(Deferred.await(serverReady)).catch(() => null),
    checkSession: checkSessionExistsViaFetch,
  })
  registerIpcHandlers({
    tabsPrecleanDone: tabsPreclean.done,
    killSidecar: () => killSidecar(),
    // B11 复扫行11:停手 banner 的「重试」—— 用户显式动作,阶梯清零重新给满自愈机会;respawn 走
    // 既有互斥/合并入口(requestSidecarRespawn 在窗口建成时赋值;此前调用为 no-op)。
    retrySidecar: () => {
      selfHeal = initialSelfHealState()
      return requestSidecarRespawn?.() ?? Promise.resolve()
    },
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
  // #309:extLedgerReady = recovery→v1→v2 迁移 barrier;启动期账本写方(ecosystem gate)在其后。
  // REQ-098 #302:catalog 读取通道 = 冻结环境快照的 registryChannel(prod→stable/beta→preview/
  // dev→dev),composition root 一次注入,IPC/planner/预热同一份。
  const registryChannel = alphaEnv.registryChannel
  const extLedgerReady = registerExtIpcHandlers(app.getPath("userData"), registryChannel)
  // REQ-032:启动预热远端 catalog(ETag 缓存;失败静默回退,进 hub 时再刷)
  void refreshRemoteCatalog(app.getPath("userData"), registryChannel).catch(() => {})
  registerAccountIpcHandlers()
  registerCloudIpcHandlers()
  // REQ-093(#185):run artifact manifest 只读查询面(artifacts.json + 磁盘 reconcile)。
  registerArtifactIpcHandlers()
  // REQ-096(#188):隔离 HTML preview 控制通道(main-owned 一次性静态 host,html-preview-host.ts)。
  registerHtmlPreviewIpcHandlers()
  // 自动化(REQ-021 A1/ADR-022):IPC + 主进程调度器。执行链等 serverReady(与 renderer 同一
  // Deferred;respawn 后 url/password 不变故一次 await 长期有效)。应用未运行不执行(诚实边界)。
  registerAutomationIpcHandlers()
  startAutomationScheduler({ awaitServer: () => Effect.runPromise(Deferred.await(serverReady)) })
  initAutomationLlm({ awaitServer: () => Effect.runPromise(Deferred.await(serverReady)) })
  // A3(REQ-025):开机拉回错过的云 schedule run(登录态才有 token;失败静默,面板刷新再拉)
  setTimeout(() => void pullCloudScheduleRuns().catch(() => {}), 8000)
  registerModelsIpcHandlers(app.getPath("userData"))
  registerProviderIpcHandlers()
  registerEndpointsIpcHandlers()
  // REQ-084:启动期 surface 选择(env > pin > 发布默认 + 崩溃降级);renderer 挂载路由树前读一次。
  registerSurfaceIpc(app.getPath("userData"))
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

    // S17 T3(C17+B14)DB 安全带预检:水位比对 → DB 超前阻断 / 将前进先备份 / 损坏走恢复
    // The DB safety belt runs only on the initial spawn (not respawn: startup already verified,
    // 运行中水位不会倒退);守卫自身故障一律 fail-open 只 log,绝不把启动搞得更糟。
    const dbPreflight = yield* Effect.promise(() =>
      runDbPreflightBoot({ userDataPath: app.getPath("userData") }).catch((error) => {
        logger.error("db-safety preflight crashed — fail-open", error)
        return { proceed: true as const }
      }),
    )
    if (!dbPreflight.proceed) {
      logger.log("db-safety: user chose quit at preflight")
      app.exit(0)
      return
    }

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

  // REQ-063 T4:全局存量一次性迁移门(发布闸)——default-deny 后 ~/.claude/~/.agents 存量不可见,
  // 首启必弹防「技能丢了」重演;fire-and-forget,不阻塞窗口;marker 记账不再弹。
  if (!TEST_ONBOARDING) {
    void extLedgerReady
      .then(() => runGlobalEcosystemGate(mainWindow ?? undefined, logger))
      .catch((error) => logger.warn("[req063] global ecosystem gate failed (non-fatal)", error))
  }

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
      // S17 T3(B14①②):「数据」菜单 —— DB 手动备份/导出/打开备份文件夹
      data: createDbMenuActions({ userDataPath: app.getPath("userData"), getWindow: () => mainWindow }),
      // S23(C16):清除数据(分级:仅凭证 / 全部数据)—— B14 同屏(验收④)
      dataClear: createDataClearAction({ userDataPath: app.getPath("userData"), stopSidecars }),
    })
  }
})

Effect.runFork(main)
