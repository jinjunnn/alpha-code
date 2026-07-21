import { randomUUID } from "node:crypto"
import { mkdirSync, rmSync } from "node:fs"
import * as http from "node:http"
import { createServer } from "node:net"
import { homedir, tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"
import { getCACertificates, setDefaultCACertificates } from "node:tls"
import type { Event } from "electron"
import { app, BrowserWindow, dialog } from "electron"

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
import { initializeArtifactQuotaEnvironment } from "./artifact-service"
import { registerHtmlPreviewIpcHandlers } from "./html-preview-host"
import { registerAutomationIpcHandlers } from "./automation-ipc"
import { startAutomationScheduler } from "./automation-scheduler"
import { initAutomationLlm } from "./automation-llm"
import { pullCloudScheduleRuns } from "./alpha-cloud-schedules"
import { registerModelsIpcHandlers } from "./models-ipc"
import { syncLiveAllowlist } from "./alpha-platform-models"
import { registerProviderIpcHandlers } from "./provider-ipc"
import { setProviderLifecycleDeps } from "./provider-lifecycle"
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
  isRecoveryWebContents,
  registerRendererProtocol,
  setRelaunchHandler,
  setBackgroundColor,
  setDockIcon,
} from "./windows"
import { createWslServersController } from "./wsl/servers"
import { registerWslIpcHandlers } from "./wsl/ipc"
import { spawnWslSidecar } from "./wsl/sidecar"
import { migrate } from "./migrate"
import { catalogRegistryChannel, initAlphaEnvironment } from "./alpha-environment"
import { productionCasGcConfig, startCasGcScheduler } from "./ext-cas-gc-scheduler"
import { registerSettingsIpcHandlers } from "./settings-ipc"
import { ensureAlphaLayoutDefault } from "./alpha-defaults"
import { initialSelfHealState, noteSpawn, planSelfHeal } from "./sidecar-self-heal"
// #408:session-grant 生命周期接线(会话边界 = sidecar 运行期;栅栏语义见 ext-session-grants.ts)。
import { sessionGrantRegistry } from "./ext-session-grants"
import type { SessionGrantsEndedEventWire } from "../shared/ext-session-grant-wire"
import { initEndpoints } from "./alpha-endpoints"
import { registerEndpointsIpcHandlers } from "./endpoints-ipc"
import { registerSurfaceIpc } from "./alpha-surfaces"
import { createRecoveryService, type RecoveryService } from "./recovery-service"
import { registerRecoveryIpcHandlers } from "./recovery-ipc"
import { RECOVERY_ACTIONS } from "../shared/recovery"
import { initByokKeys, injectByokKeysIntoEnv, setByokKeyDeps } from "./alpha-byok-keys"
import { reconcileEngineConfigTruth } from "./engine-config-truth-boot"
import { reconcileDesiredStateAtBoot } from "./ext-install-planner"
import { alphaGlobalRoot } from "./alpha-installs"
import { factorySkillSources, reconcileFactorySkills } from "./factory-skills"
import { runGlobalEcosystemGate } from "./ecosystem-gate"
import { effectiveFactoryDenied, readBuiltinPolicy } from "./alpha-builtin-policy"
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
  // #408:蓄意停止 = 会话结束 —— 在任何 await 之前推栅栏(endSession 先撤 active 标记再清 Map),
  // 此后一切在途 grant 授权的迟到 commit 都被拒,复活窗口闭合(Codex 裁决 Q3 竞态不变量)。
  endSessionGrants("sidecar-stop")
  await current.stop()
}

// #408:会话结束的统一收口(蓄意 kill = "sidecar-stop";崩溃 = "sidecar-exit")。幂等:无活跃
// 会话(endedGen=null,如 respawn 里 killSidecar 已收口后的迟到 exit)不重复发事件。事件 =
// renderer 把全部会话开关归位的权威信号(respawn 后的 renderer reload 会重查到空集,双保险)。
function endSessionGrants(reason: SessionGrantsEndedEventWire["reason"]) {
  const ended = sessionGrantRegistry.endSession()
  if (ended.endedGen === null) return
  if (ended.grants.length > 0)
    writeLog("utility", "session grants ended with the engine session", { reason, count: ended.grants.length })
  if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send("ext-session-grants-ended", { reason })
}

// B5 crash self-heal(wiring;决策逻辑在 sidecar-self-heal.ts)。gen 区分「本代 child 崩了」与
// 「上一代 child 的迟到 exit」;蓄意 kill 的信号 = killSidecar 先把 `server` 置 null 再 stop。
let quittingApp = false
let sidecarGen = 0
// #395/#428:startup reconcile 发现「本应禁用的扩展无法保证从引擎配置移除」或退休桥无法确认
// 已断链时置位 —— 首个 sidecar fork 前 fail-closed 阻断,绝不让引擎依赖未收敛的旧桥/配置启动。
let bootEnforcementGap: string[] | null = null
let selfHeal = initialSelfHealState()
let selfHealTimer: NodeJS.Timeout | null = null
let requestSidecarRespawn: (() => Promise<boolean>) | null = null
let recoveryService: RecoveryService | null = null

function handleSidecarExit(gen: number, code: number) {
  writeLog("utility", "sidecar exited", { code }, "warn")
  if (quittingApp) return
  if (gen !== sidecarGen) return
  if (!server) return
  // #408:崩溃 = 会话结束(栅栏先行;respawn 后新会话从空集开始,grant 无从复活)。
  endSessionGrants("sidecar-exit")
  const plan = planSelfHeal(selfHeal, Date.now())
  selfHeal = plan.state
  if (plan.action === "give-up") {
    writeLog(
      "utility",
      "sidecar crash-loop — self-heal gave up; login/proxy toggles still respawn manually",
      { attempts: selfHeal.attempts },
      "error",
    )
    if (!recoveryService || !mainWindow || mainWindow.isDestroyed()) return
    const incident = recoveryService.register({
      source: { kind: "engine", plan },
      senderID: mainWindow.webContents.id,
      effects: {
        [RECOVERY_ACTIONS.retryEngine]: async () => {
          selfHeal = initialSelfHealState()
          const applied = await requestSidecarRespawn?.()
          return applied ? { applied: true } : { applied: false, retryable: true }
        },
      },
    })
    if (incident) mainWindow.webContents.send("alpha-recovery-incident", incident)
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
    // 安装真源与引擎桥根不在 XDG 下 → 测试态显式改道,
    // 否则隔离 test build 的定制中心安装会写进真实 home(os.homedir() 不吃 env 重定向)。
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
  recoveryService = createRecoveryService({
    log: (event, detail) => writeLog("recovery", event, detail, event === "recovery-action-failed" ? "warn" : "info"),
  })

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
  // REQ-098/#428:在任何 root 消费方前冻结 canonical 新根。packaged onboarding 只把内部生成
  // 的临时 base 作为函数参数传入；环境变量 override 不能授权 packaged 状态落点。
  const alphaEnv = (() => {
    try {
      return initAlphaEnvironment({
        isPackaged: app.isPackaged,
        channel: CHANNEL,
        appDataDir: app.getPath("appData"),
        ...(onboardingTestRoot ? { baseRoot: join(onboardingTestRoot, "alpha-code-state") } : {}),
      })
    } catch {
      logger.error("alpha environment initialization refused (external override or root identity is invalid)")
      app.exit(1)
      return null
    }
  })()
  if (!alphaEnv) return
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
    if (isRecoveryWebContents(webContents)) return
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

  const artifactQuotaEnvironment = yield* Effect.promise(() =>
    initializeArtifactQuotaEnvironment(app.getPath("userData")),
  )
  if (!artifactQuotaEnvironment.ok)
    writeLog("utility", "artifact quota environment unavailable", { error: artifactQuotaEnvironment.error }, "warn")

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
  // REQ-059:存量引擎配置(~/.opencode/opencode.jsonc + XDG provider 域)迁进当前环境 alpha.jsonc
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
      process.env.ALPHA_FACTORY_DENY_SKILLS = JSON.stringify(effectiveFactoryDenied(readBuiltinPolicy()))
      if (factory.removed.length)
        logger.log(
          "[req065] factory-skills: stale .alpha links dismantled (factory content now served from app resources)",
          {
            removed: factory.removed,
          },
        )
      if (factory.migrated.length)
        logger.log("[req065] factory-skills: legacy ~/.opencode/skill direct links removed", {
          migrated: factory.migrated,
        })
      for (const s of factory.skipped) logger.warn(`[req065] factory-skills: SKIPPED ${s.name} — ${s.reason}`)
    } catch (error) {
      logger.warn("[req065] factory-skills reconcile failed (non-fatal; skills.paths group left untouched)", error)
    }
    try {
      const outcome = reconcileEngineConfigTruth(logger, { factorySkillDirs: stripFactory })
      if (!outcome.skipped && outcome.bailedOut)
        logger.warn("[req059] engine config reconcile bailed out (kept legacy in place)", { reason: outcome.bailedOut })
    } catch (error) {
      bootEnforcementGap = [`engine config reconcile failed: ${error instanceof Error ? error.message : String(error)}`]
      logger.error("[req059] engine config reconcile failed — blocking sidecar (fail closed)", error)
    }
    // #395:startup reconcile —— 账本 desiredState 权威重投影回 alpha.jsonc(REQ-059 truth reconcile
    // 之后、首个 sidecar fork 读 config 之前;双向)。消除「账本 disabled / config enabled」崩溃残留
    // 与旁路写入的复活面(引擎 import 插件早于任何 config-hook,持久化 config 是唯一权威生效面)。
    // 失败/跳过一律 loud 且不阻断启动(config 保持原样;fail-closed 细则在函数内)。escape hatch 与
    // REQ-059 同口径:legacy 模式下 alpha.jsonc 非引擎读取目标,不投影。
    if (process.env.ALPHA_JSONC_TRUTH_DISABLE !== "1" && process.env.ALPHA_LEGACY_INSTALL_ROOT !== "1") {
      try {
        // #397:userDataPath/channel 供 session-grant 强制面(已验 catalog 同步读)使用。
        const ds = reconcileDesiredStateAtBoot(alphaGlobalRoot(), {
          userDataPath: app.getPath("userData"),
          channel: catalogRegistryChannel(),
        })
        if (ds.skipped) logger.warn("[req104-395] desired-state reconcile skipped", { reason: ds.skipped })
        if (ds.applied.length > 0)
          logger.log("[req104-395] desired-state residue reprojected into alpha.jsonc", { applied: ds.applied })
        for (const w of ds.warnings) logger.warn(`[req104-395] desired-state reconcile: ${w}`)
        // r6 B2/B3:有未能保证的禁用项 → 置 fail-closed 位(spawn 前阻断引擎)。
        if (ds.enforcementGap && ds.enforcementGap.length > 0) {
          bootEnforcementGap = ds.enforcementGap
          logger.error(
            "[req104-395] desired-state enforcement gap — disabled extensions cannot be guaranteed; blocking sidecar",
            { gap: ds.enforcementGap },
          )
        }
      } catch (error) {
        // reconcile 自身抛错(不该发生 — 内部已捕获)= 无法确认禁用态 → fail-closed。
        bootEnforcementGap = [
          `desired-state reconcile threw: ${error instanceof Error ? error.message : String(error)}`,
        ]
        logger.error("[req104-395] desired-state reconcile crashed — blocking sidecar (fail closed)", error)
      }
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
  // REQ-098 #302:catalog 读取通道经唯一权威取值点(catalogRegistryChannel = 冻结快照
  // registryChannel,prod→stable/beta→preview/dev→dev,已单测钉死映射),composition root
  // 一次注入,IPC/planner/预热同一份。
  const registryChannel = catalogRegistryChannel()
  // #390:解构出恢复-gate 包装的 global 技能安装器,传给首启 ecosystem gate(不绕恢复准入)。
  const { ledgerReady: extLedgerReady, ecosystemGlobalSkillInstaller } = registerExtIpcHandlers(
    app.getPath("userData"),
    registryChannel,
  )
  // REQ-032:启动预热远端 catalog(ETag 缓存;失败静默回退,进 hub 时再刷)
  void refreshRemoteCatalog(app.getPath("userData"), registryChannel).catch(() => {})
  // REQ-102 #318:CAS GC 生产触发(5min 首跑 + 24h 链式周期;锁忙/mark 根损坏 = 本轮跳过等下轮)。
  // 配置经唯一权威取值点 productionCasGcConfig(冻结共享 CAS 根 + 三环境根 + 无条件 seed lock +
  // 显式非零 grace,已单测钉死)。
  const casGcConfig = productionCasGcConfig()
  const casGc = startCasGcScheduler(casGcConfig)
  app.once("will-quit", () => casGc.stop())
  registerSettingsIpcHandlers(casGcConfig)
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
  const recovery = recoveryService
  if (!recovery) throw new Error("Recovery service is unavailable")
  const recoveryIpc = registerRecoveryIpcHandlers(recovery)
  // REQ-084/090:surface 选择与 crash admission 共用 main-owned Recovery incident registry。
  registerSurfaceIpc(app.getPath("userData"), recovery)
  void updater.start()
  const updateTimer = setInterval(() => void updater.check(), 10 * 60 * 1000)
  updateTimer.unref()
  app.once("will-quit", () => clearInterval(updateTimer))

  // B2:token 保活 tick(每小时)。到提前量(7d token 提前 24h,见 alpha-auth-clock.ts)就轮换刷新;
  // 备胎:运行中 sidecar 在 fork 时冻住的 token 快死(<30min,即 app 连续跑满一个 token 寿命)时,
  // 续期 + 静默 respawn 换血——7d 寿命下极少发生,发生时接受一次界面重载并留日志。
  const authTimer = setInterval(
    () => {
      void (async () => {
        await ensureFreshToken().catch(() => {})
        if (sidecarTokenExpiresAt && sidecarTokenExpiresAt - Date.now() < 30 * 60 * 1000) {
          logger.log("B2: sidecar's fork-time token near expiry — quiet respawn to rotate")
          await respawnSidecar()
        }
      })()
    },
    60 * 60 * 1000,
  )
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
    // 运行中水位不会倒退)；Recovery 接线自身故障 fail-closed，不能绕过安全选择继续启动。
    const dbPreflight = yield* Effect.promise(() =>
      runDbPreflightBoot({
        userDataPath: app.getPath("userData"),
        recovery,
        presentRecovery: recoveryIpc.presentBoot,
      }).catch((error) => {
        logger.error("db-safety preflight crashed — fail-closed", error)
        return { proceed: false as const }
      }),
    )
    if (!dbPreflight.proceed) {
      logger.log("db-safety: preflight stopped startup")
      app.exit(0)
      return
    }

    // #395/#428:startup reconcile 判定配置禁用面或退休桥断链无法保证 → fail-closed 拒绝
    // spawn 引擎。gap 细节已 error 记日志；只 gate 首次 spawn(respawn 不重跑 reconcile)。
    if (bootEnforcementGap) {
      logger.error("[req104-395] refusing to spawn sidecar — extension disable state cannot be guaranteed", {
        gap: bootEnforcementGap,
      })
      dialog.showErrorBox(
        "扩展安全状态无法确保",
        "扩展配置或历史桥接状态无法确认已经安全收敛(可能因磁盘空间、权限或配置文件损坏)。为避免旧桥或本应关闭的扩展被意外加载,已暂停启动。请检查磁盘与目录权限后重新打开应用;若持续出现,请联系支持并附上日志。",
      )
      app.exit(1)
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
    sessionGrantRegistry.beginSession(spawnGen) // #408:新会话空集起步(grant 面绑本代)
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
      .then(() => runGlobalEcosystemGate(mainWindow ?? undefined, logger, ecosystemGlobalSkillInstaller))
      .catch((error) => logger.warn("[req063] global ecosystem gate failed (non-fatal)", error))
  }

  // In-place sidecar respawn — NOT a full app relaunch (ad-hoc-signed builds quit on relaunch, ADR-017).
  // Re-forks on the SAME host/port/password with freshly-derived state (login set ALPHA_BASE_URL +
  // ALPHA_API_KEY in main's env → fork-time syncSecretFiles refreshes the {file:} channel →
  // buildAlphaModelConfig injects provider.alpha), then reloads the renderer so it
  // reconnects (url/password unchanged → awaitInitialization stays valid) and re-fetches providers →
  // the proxy activates with zero clicks and no restart.
  const doRespawnSidecar = async () => {
    if (quittingApp) return false
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
      sessionGrantRegistry.beginSession(spawnGen) // #408:respawn = 新会话,grant 恒从空集开始
      // B5 验收②:未健康不 reload —— reload 进死后端只会白屏(REQ-014 同族),留旧 renderer 状态。
      const healthy = await Promise.race([
        health.wait.then(
          () => true,
          () => false,
        ),
        new Promise<boolean>((resolve) => setTimeout(() => resolve(false), 20000)),
      ])
      if (healthy && mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.reload()
        logger.log("sidecar respawned + renderer reloaded")
      } else if (!healthy) {
        logger.error("sidecar respawned but health check failed — skipping renderer reload")
      }
      return healthy
    } catch (error) {
      logger.error("sidecar respawn failed", error)
      return false
    }
  }
  // B5(NEW-4):respawn 互斥 + 合并。触发面已扩大(登录/登出/enableProxy/setAuthMode/B2 tick/
  // B21 改键),并发触发会两个 fork 抢同一端口、renderer 双重 reload。单飞:在途时再触发只标记
  // 一次排队；共享 Promise 覆盖补跑轮次(拿到最新 env/密钥/provider 状态,不会丢最后一次变更)。
  let respawning: Promise<boolean> | null = null
  let respawnQueued = false
  const drainRespawns = async (): Promise<boolean> => {
    respawnQueued = false
    const healthy = await doRespawnSidecar()
    if (!respawnQueued) return healthy
    return drainRespawns()
  }
  const respawnSidecar = (): Promise<boolean> => {
    if (respawning) {
      respawnQueued = true
      return respawning
    }
    respawning = drainRespawns().finally(() => (respawning = null))
    return respawning
  }

  requestSidecarRespawn = respawnSidecar // B5:崩溃自愈复用同一互斥/合并入口
  setAuthDeps({ getWindow: () => mainWindow, respawn: respawnSidecar })
  setProviderLifecycleDeps({ refreshRuntime: respawnSidecar })
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
