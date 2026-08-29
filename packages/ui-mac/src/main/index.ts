import { randomUUID } from "node:crypto"
import { existsSync, mkdirSync, rmSync, statSync } from "node:fs"
import * as http from "node:http"
import { createServer } from "node:net"
import { homedir, tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"
import { getCACertificates, setDefaultCACertificates } from "node:tls"
import type { Event } from "electron"
import { app, BrowserWindow, dialog, powerMonitor } from "electron"

import { Deferred, Effect } from "effect"
import contextMenu from "electron-context-menu"

import type { ServerReadyData } from "../preload/types"
import { DEEP_LINK_SCHEMES, isDeepLink } from "../shared/route-manifest"
// Deep-link ingress. The manifest DECODES here and only the decoded delivery crosses into the
// arm's-length upstream renderer, so no second URL codec can exist downstream. Queue-vs-live
// arbitration (exactly-once across cold start, live delivery, renderer reload, renderer crash,
// window close and `window.new`) lives in deep-link-queue.ts, where every timing is a unit test;
// deep-links.ts is its one Electron adapter, shared with windows.ts so that every window is wired.
import { deepLinks } from "./deep-links"
import { checkAppExists, resolveAppPath } from "./apps"
import { CHANNEL } from "./constants"
import { registerIpcHandlers, sendMenuCommand } from "./ipc"
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
import {
  exportDebugLogs,
  initCrashReporter,
  initLogging,
  serverLogRoots,
  startNetLog,
  write as writeLog,
} from "./logging"
import { getStore } from "./store"
import { GLOBAL_RENDERER_STORE, TABS_INFO_KEY, TABS_KEY, TABS_RECENT_KEY, runTabsPreclean } from "./tabs-preclean"
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
import { initialSelfHealState, noteSpawn, planSelfHeal, SELF_HEAL_MAX_DELAY_MS } from "./sidecar-self-heal"
import { ensureEngineScratchCwd } from "./engine-scratch-cwd"
import {
  ENGINE_RUNAWAY_WINDOW_MS,
  armEngineRunawayGuard,
  decideEngineRunawayGuard,
  disarmEngineRunawayGuard,
  initialEngineRunawayGuardState,
  resetEngineRunawayGuard,
} from "./engine-runaway-guard"
// #564:catalog-liveness 看门狗(决策逻辑在 catalog-liveness.ts;此处只接线)。
import {
  CATALOG_LIVENESS_PROBE_INTERVAL_MS,
  armCatalogLiveness,
  decideCatalogLiveness,
  disarmCatalogLiveness,
  initialCatalogLivenessState,
  resetCatalogLiveness,
  resolveCatalogProbeDirectory,
  probeCatalogMarker,
  startCatalogLivenessProbes,
} from "./catalog-liveness"
import { alphaUserWorkspaceDir } from "./alpha-user-workspace"
// #408:session-grant 生命周期接线(会话边界 = sidecar 运行期;栅栏语义见 ext-session-grants.ts)。
import { sessionGrantRegistry } from "./ext-session-grants"
import type { SessionGrantsEndedEventWire } from "../shared/ext-session-grant-wire"
import { initEndpoints } from "./alpha-endpoints"
import { registerEndpointsIpcHandlers } from "./endpoints-ipc"
import { registerContractHealthIpcHandlers, reportContractFailure } from "./alpha-contract-health"
import { registerCatalogHealthIpcHandlers } from "./alpha-catalog-health"
import { registerSurfaceIpc } from "./alpha-surfaces"
import { createRecoveryService, type RecoveryService } from "./recovery-service"
import { registerRecoveryIpcHandlers } from "./recovery-ipc"
import { RECOVERY_ACTIONS } from "../shared/recovery"
import { initByokKeys, injectByokKeysIntoEnv, setByokKeyDeps } from "./alpha-byok-keys"
import { reconcileEngineConfigTruth } from "./engine-config-truth-boot"
import { sweepEngineConfigDanglingUnlocked, type DanglingSweepOutcome } from "./engine-config-dangling"
import { runBootDanglingSweep } from "./boot-dangling-sweep"
import { creditDanglingSweepForSpawn } from "./dangling-sweep-latch"
import { ensureGovernedMcpConnectTimeouts, withConfigWriteLock } from "./ext-config"
import { retireCommunityExcelAfterRecovery } from "./community-excel-retirement"
import { reconcileMcpWorkspaceMarkers } from "./mcp-workspace-marker"
import { engineDataDir } from "./data-clear"
import { isCloudMcpOAuthInflight } from "./cloud-mcp-oauth-gate"
import { reconcileDesiredStateAtBoot } from "./ext-install-planner"
import { alphaGlobalRoot } from "./alpha-installs"
import { factorySkillSources, reconcileFactorySkills } from "./factory-skills"
import { runGlobalEcosystemGate } from "./ecosystem-gate"
import { effectiveFactoryDenied, readBuiltinPolicy } from "./alpha-builtin-policy"
import {
  enableProxy,
  ensureFreshToken,
  getAuthRenewalTiming,
  getAuthState,
  getTokenGeneration,
  initAuthEnv,
  isStoredTokenExpired,
  logout as authLogout,
  markTokenGenerationApplied,
  setAuthDeps,
  setAuthMode,
  startAuth,
} from "./alpha-auth"
import { errorOutcome, initStartupTimeline, markStartupTimeline } from "./startup-timeline"
import {
  awaitBootRenewalGrace,
  createAuthRenewalScheduler,
  createTokenRotationLatch,
} from "./auth-renewal"
import {
  armRespawnGenerationTerminal,
  commitForkedTokenGeneration,
  createSidecarRespawnQueue,
  shouldReloadRenderer,
  shouldRetryRespawn,
  type SidecarRespawnReason,
} from "./sidecar-lifecycle"
import { armBootGenerationTerminal, createSidecarGenerationState, type SidecarGenerationState } from "./sidecar-generation"

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
let rendererReloadCount = 0
// 「活着的 sidecar 已被健康确认携带的 token 代」——latch 的 forkedGeneration() 读它。
// R3 新 Major:只有健康确认才提交(规则在 sidecar-lifecycle.commitForkedTokenGeneration,
// boot 与 respawn 两条路共用),否则「fork 出去但从未健康」会被 latch 当成已应用。
let sidecarTokenGeneration = 0
const commitSidecarTokenGeneration = (forked: number, healthy: boolean) => {
  sidecarTokenGeneration = commitForkedTokenGeneration(sidecarTokenGeneration, forked, healthy)
}
// 「首个 fork **启动时**继承的 token 代」——只用于 boot 后那次「登录发生在 fork 之前吗」的
// 判断(它问的是继承事实,不是健康事实),与上面那个健康确认值刻意分开。
let bootForkTokenGeneration = 0
// #859:boot fork 已捕获但尚未通过 health 的 token 代。与 sidecarTokenGeneration 分离:
// 前者只阻止 latch 为同一代重复换血,后者才是可以发布 applied/ready 的健康事实。
// 它是**抑制信号**,所以释放必须有上界 —— 见 BOOT_GENERATION_TERMINAL_MS 与 boot 处的结算接线。
let pendingBootForkTokenGeneration = 0
/** boot generation 终态的上界。#577 起它是「等健康 → 发终态」的兜底;#859 起它同时是
 *  pendingBootForkTokenGeneration 的释放上界 —— 两者必须是同一个数,否则会出现
 *  「终态已判 failed,而 latch 仍被 in-flight 抑制」的空窗。 */
const BOOT_GENERATION_TERMINAL_MS = 30_000

function useEnvProxy() {
  try {
    // Electron 内置的 Node 领先于已发布的 @types/node —— setGlobalProxyFromEnv 运行时存在但类型
    // 里没有,故 cast(D10:不再写死版本号,避免注释随升级过期)。
    ;(http as any).setGlobalProxyFromEnv()
  } catch (error) {
    logger.warn("failed to load proxy environment", error)
  }
}

async function killSidecar(reason?: SidecarRespawnReason) {
  stopEngineRunawayMeter()
  stopCatalogLivenessWatchdog()
  if (!server) return
  const current = server
  server = null
  // #408:蓄意停止 = 会话结束 —— 在任何 await 之前推栅栏(endSession 先撤 active 标记再清 Map),
  // 此后一切在途 grant 授权的迟到 commit 都被拒,复活窗口闭合(Codex 裁决 Q3 竞态不变量)。
  endSessionGrants("sidecar-stop")
  await current.stop(reason === "token-only" ? "token-rotation" : "graceful")
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
let engineRunawayGuard = initialEngineRunawayGuardState()
let engineRunawayTimer: NodeJS.Timeout | null = null
// #564:catalog-liveness 看门狗状态(strikes 跨代保留,反无限 kill 循环 —— 退化代 uptime ≈
// deadline ≥ SELF_HEAL_RESET_UPTIME_MS,self-heal 阶梯每次都被重置,上界只能由这里给)。
let catalogLiveness = initialCatalogLivenessState()
let catalogLivenessTimer: NodeJS.Timeout | null = null
let catalogLivenessProbeInFlight = false
let requestSidecarRespawn: ((reason: SidecarRespawnReason) => Promise<boolean>) | null = null
let recoveryService: RecoveryService | null = null
const sidecarGeneration = createSidecarGenerationState()

// R1 Major3:发布必须是全函数(never throws)。它是终态生产者、pre-arm catch 与 latch 三条
// 路径共用的收口点,任何一次抛出都会把「恰好一个终态」变成零个,或让 latch 收到 rejected
// respawn 而不再武装重试。状态先落 store(renderer 经 getState 回读得到同一事实),
// 只有 IPC 推送这一步可能因窗口崩溃/销毁失败,失败降级为一条日志。
function publishSidecarGeneration(next: SidecarGenerationState) {
  sidecarGeneration.update(next)
  try {
    markStartupTimeline("main.sidecar.generation.emit", {
      generation: next.generation,
      phase: next.status,
      reason: next.reason,
    })
    if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send("sidecar-generation", next)
  } catch (error) {
    logger.warn("sidecar generation publish failed", error)
  }
}

const tokenRotation = createTokenRotationLatch({
  forkedGeneration: () => sidecarTokenGeneration,
  pendingForkGeneration: () => pendingBootForkTokenGeneration,
  // #600:sidecar 已死(换血的 spawn 失败后 server 为 null)恰恰是必须允许再换血的时刻 ——
  // 旧的 `server &&` 让「换血失败 ⇒ 无 sidecar」变成永久不可用:低频重试永远进不了 respawn 入口。
  canRespawn: () => Boolean(requestSidecarRespawn && !quittingApp),
  respawn: (reason) => requestSidecarRespawn?.(reason) ?? Promise.resolve(false),
  // #600 M1:换血真正落地时解除平台面的「恢复中」——低频重试成功也走这条。
  onApplied: (generation) => markTokenGenerationApplied(generation),
  mark: (result, trigger, outcome) =>
    markStartupTimeline("main.auth.rotation", {
      generation: result.generation,
      reason: trigger,
      renewal: result.outcome,
      outcome,
    }),
})

// boot fork 的 token 代结算(唯一驱动方 = boot generation 终态,见 spawn 处的接线)。
// R3 新 Major 保留:boot 也 capture-then-commit —— 只有**健康线通过**才把这一代记成
// 「活着的 sidecar 携带的代」,否则 latch 的 inEffect 路径会为一个从未健康的 fork 清掉重试
// 并发布 ready(#600 M1 的反面)。#859 只改「谁来宣布结论、多久之内必须宣布」,不放宽这条门:
// 不健康时**只**释放 in-flight 抑制并重放 latch,代照旧不提交。
function settleBootForkTokenGeneration(forked: number, healthy: boolean) {
  if (pendingBootForkTokenGeneration !== forked) return
  // fail-closed 的判定整条交给那唯一的规则(commitForkedTokenGeneration:不健康即不推进),
  // 这里不再自己分一次支 —— 分了就等于把判定搬进 index.ts,而它是本仓唯一跑不进单测的文件,
  // 判定住在这里就只剩源码锚看得见(实测:把那条规则改成忽略 healthy,竞态用例仍然全绿,
  // 只有规则自己的纯函数单测转红)。行为完全等价:不健康时规则原样返回 current。
  commitSidecarTokenGeneration(forked, healthy)
  pendingBootForkTokenGeneration = 0
  void tokenRotation.flush()
}

function recordDanglingSweep(context: "boot" | "respawn", outcome: DanglingSweepOutcome) {
  if (outcome.stripped.length > 0)
    logger.warn("[req053-dangling-sweep] confirmed-absent Alpha config references stripped", {
      context,
      stripped: outcome.stripped.length,
      files: outcome.changedFiles,
    })
  outcome.warnings.forEach((warning) => logger.warn(`[req053-dangling-sweep] ${context}: ${warning}`))
}

function handleSidecarExit(gen: number, code: number) {
  writeLog("utility", "sidecar exited", { code }, "warn")
  if (quittingApp) return
  if (gen !== sidecarGen) return
  if (!server) return
  stopEngineRunawayMeter()
  stopCatalogLivenessWatchdog()
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
          const applied = await requestSidecarRespawn?.("structural")
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
    void requestSidecarRespawn?.("structural")
  }, plan.delayMs)
}

function stopEngineRunawayMeter() {
  if (engineRunawayTimer) clearInterval(engineRunawayTimer)
  engineRunawayTimer = null
  engineRunawayGuard = disarmEngineRunawayGuard(engineRunawayGuard, Date.now())
}

// #564:sidecar 停止/退出时看门狗必须一起停(与 stopEngineRunawayMeter 同纪律),
// 否则旧代的探针会打在下一代身上、或打在一个不存在的端口上白记失败。
function stopCatalogLivenessWatchdog() {
  if (catalogLivenessTimer) clearInterval(catalogLivenessTimer)
  catalogLivenessTimer = null
  catalogLivenessProbeInFlight = false
  catalogLiveness = disarmCatalogLiveness(catalogLiveness)
}

function armEngineRunawayMeter(gen: number) {
  stopEngineRunawayMeter()
  engineRunawayGuard = armEngineRunawayGuard(engineRunawayGuard, Date.now())
  const activeLog = join(serverLogRoots()[0], "opencode.log")
  engineRunawayTimer = setInterval(() => {
    if (gen !== sidecarGen || !server) {
      stopEngineRunawayMeter()
      return
    }
    const sample = (() => {
      try {
        return { status: "available" as const, size: statSync(activeLog).size }
      } catch {
        return { status: "unavailable" as const }
      }
    })()
    const decision = decideEngineRunawayGuard(Date.now(), sample, engineRunawayGuard)
    engineRunawayGuard = decision.state
    if (decision.action === "none") return

    stopEngineRunawayMeter()
    const current = server
    if (!current) return
    if (decision.action === "kill-and-respawn") {
      writeLog(
        "utility",
        "engine log runaway detected — killing sidecar for self-heal respawn",
        { strikes: engineRunawayGuard.strikes },
        "error",
      )
      current.kill()
      return
    }

    writeLog(
      "utility",
      "engine repeatedly produced runaway logs — sidecar paused for explicit recovery",
      { strikes: engineRunawayGuard.strikes },
      "error",
    )
    server = null
    endSessionGrants("sidecar-stop")
    current.kill()
    if (!recoveryService || !mainWindow || mainWindow.isDestroyed()) return
    const plan = { action: "give-up" as const, state: selfHeal }
    const incident = recoveryService.register({
      source: { kind: "engine", plan },
      senderID: mainWindow.webContents.id,
      effects: {
        [RECOVERY_ACTIONS.retryEngine]: async () => {
          engineRunawayGuard = resetEngineRunawayGuard()
          selfHeal = initialSelfHealState()
          const applied = await requestSidecarRespawn?.("structural")
          return applied ? { applied: true } : { applied: false, retryable: true }
        },
      },
    })
    if (incident) mainWindow.webContents.send("alpha-recovery-incident", incident)
  }, ENGINE_RUNAWAY_WINDOW_MS)
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

function observeEnsureFreshToken(path: "boot" | "scheduled") {
  const started = performance.now()
  markStartupTimeline(`main.auth.${path}.ensure.start`)
  const refreshing = ensureFreshToken()
  void refreshing.then(
    (result) =>
      markStartupTimeline(`main.auth.${path}.ensure.end`, {
        durationMs: performance.now() - started,
        outcome: "ok",
        result: result.outcome,
        generation: result.generation,
      }),
    (error) =>
      markStartupTimeline(`main.auth.${path}.ensure.end`, {
        durationMs: performance.now() - started,
        outcome: errorOutcome(error),
      }),
  )
  return refreshing
}

const main = Effect.gen(function* () {
  contextMenu({ showSaveImageAs: true, showLookUpSelection: false, showSearchWithGoogle: false })

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
    applicationName: "Code Puppy",
    applicationVersion: app.getVersion(),
    copyright: "© 2025 opencode (MIT). Code Puppy fork build.",
    credits: "Built on OpenCode (MIT) — https://github.com/anomalyco/opencode",
  })
  app.setPath(
    "userData",
    onboardingTestRoot ? join(onboardingTestRoot, "desktop") : join(app.getPath("appData"), appId),
  )
  if (onboardingTestRoot) app.setPath("sessionData", join(onboardingTestRoot, "session"))
  // macOS apps can start in `/`. Keep MAIN and directory-less sidecar work in an empty app-owned
  // directory instead of HOME; if userData is unavailable this early, fail over to OS temp only.
  try {
    process.chdir(ensureEngineScratchCwd(app.getPath("userData")))
  } catch {
    process.chdir(ensureEngineScratchCwd(join(tmpdir(), "alpha-code")))
  }
  logger = initLogging()
  initStartupTimeline((record) => {
    queueMicrotask(() => {
      try {
        writeLog("startup-timeline", JSON.stringify(record))
      } catch {
        // Startup observation is intentionally best-effort.
      }
    })
  })
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
  initEndpoints(app.getPath("userData"), reportContractFailure)
  // ⚠️ initAuthEnv / initByokKeys 不能在这里调(REQ-002 联调实锤,2026-07-03):它们解密 safeStorage
  // 凭证,而 macOS 上 app ready 之前 safeStorage 不可用 → 解密静默失败 → 每次冷启动都"未登录"、
  // BYOK 钥匙库曾因此走明文兜底。已移至 whenReady 之后、sidecar fork 之前(见下)。

  // Auth callbacks contain a single-use PKCE code and CSRF state — strip the query before
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
    const urls = argv.filter(isDeepLink)
    if (urls.length) {
      logger.log("deep link received via second-instance", { urls: urls.map(redactDeepLink) })
      deepLinks.ingest(argv)
    }
    if (mainWindow) {
      mainWindow.show()
      mainWindow.focus()
    }
  })

  app.on("open-url", (event: Event, url: string) => {
    event.preventDefault()
    logger.log("deep link received via open-url", { url: redactDeepLink(url) })
    deepLinks.ingest([url])
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
  let authScheduler: ReturnType<typeof createAuthRenewalScheduler> | null = null
  let pendingAuthStructuralRespawn = false

  yield* Effect.promise(() => app.whenReady())
  markStartupTimeline("main.app.ready")

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
  // 续期换血入口必须在任何网络续期开始前安装。冷启动时 structural 变化先记账；首 fork 若已
  // 采用当前 generation 则自然消解，否则 respawn 入口建成后补一次 structural 换血。
  setAuthDeps({
    getWindow: () => mainWindow,
    respawn: () => {
      if (requestSidecarRespawn) {
        void requestSidecarRespawn("structural")
        return
      }
      pendingAuthStructuralRespawn = true
    },
    // #600 M1:返回换血 Promise —— refreshTokens 等它落定后才回报恢复,account 401 路径
    // 因此不会在 sidecar 仍握旧 token 时就把平台当成已恢复。
    onRenewed: (result) => tokenRotation.accept(result, "renewal"),
    onChanged: () => authScheduler?.rearm("auth-change"),
  })
  // Windows/Linux cold start: the OS launches the FIRST process with the link on its command
  // line. That process wins the single-instance lock, so "second-instance" never fires, and there
  // is no macOS "open-url" either — without this the link is lost outright. Deliberately AFTER
  // initAuthEnv: an `alpha-code://auth/callback` can arrive this way too (browser wakes a closed
  // app on Windows/Linux), and the PKCE exchange needs safeStorage, which is only usable now.
  {
    const urls = process.argv.filter(isDeepLink)
    if (urls.length) logger.log("deep link received via first-process argv", { urls: urls.map(redactDeepLink) })
    deepLinks.ingest(process.argv)
  }
  // A′:过期 token 在恢复存储后立即开始续期和 1.2s hard grace，和迁移、配置预检、端口分配
  // 并行。到首 fork 点只消费这个已运行的 race，绝不重新起一段宽限。
  const storedTokenExpired = isStoredTokenExpired()
  markStartupTimeline("main.auth.boot.token_check", { expired: storedTokenExpired })
  const bootRenewalRace = storedTokenExpired
    ? awaitBootRenewalGrace(observeEnsureFreshToken("boot"))
    : null
  // Load alpha's encrypted BYOK key vault (migrates any key off opencode auth.json once) and bridge
  // each stored key into its provider's keyEnv in MAIN's env BEFORE the sidecar forks — that's the
  // source syncSecretFiles mirrors into the {file:} channel that buildAlphaModelConfig (sidecar)
  // references (A6). See alpha-byok-keys.ts.
  initByokKeys(app.getPath("userData"))
  injectByokKeysIntoEnv()
  // REQ-001:异步同步 B 网关 edition 白名单缓存(fire-and-forget,不阻塞窗口/首个 fork——B1 纪律)。
  // 首启无缓存 → 本次 fork 用内置 snapshot;同步成功后 picker 立即收窄,装配随下次 fork/respawn 生效。
  // 这里的 catch 只吞 rejection;分类失败已由 syncLiveAllowlist 自己送到 alpha-catalog-health(#1084)。
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
          bootEnforcementGap = [...(bootEnforcementGap ?? []), ...ds.enforcementGap]
          logger.error(
            "[req104-395] desired-state enforcement gap — disabled extensions cannot be guaranteed; blocking sidecar",
            { gap: ds.enforcementGap },
          )
        }
      } catch (error) {
        // reconcile 自身抛错(不该发生 — 内部已捕获)= 无法确认禁用态 → fail-closed。
        bootEnforcementGap = [
          ...(bootEnforcementGap ?? []),
          `desired-state reconcile threw: ${error instanceof Error ? error.message : String(error)}`,
        ]
        logger.error("[req104-395] desired-state reconcile crashed — blocking sidecar (fail closed)", error)
      }
    }
  }
  // REQ-053 AC2: boot dangling sweep is not skipped under OPENCODE_TEST_ONBOARDING.
  // Isolation still omits REQ-059/065/104 reconcile and the global ecosystem gate.
  const danglingBoot = runBootDanglingSweep({
    userDataPath: app.getPath("userData"),
    engineDataPath: engineDataDir(process.env, homedir()),
    log: logger,
  })
  recordDanglingSweep("boot", danglingBoot.outcome)
  if (danglingBoot.enforcementGap.length > 0) {
    bootEnforcementGap = [...(bootEnforcementGap ?? []), ...danglingBoot.enforcementGap]
  } else {
    // `#982`: only a gap-free sweep credits the spawn throat latch.
    creditDanglingSweepForSpawn()
  }
  ensureGovernedMcpConnectTimeouts()
  reconcileMcpWorkspaceMarkers()
  ensureAlphaLayoutDefault()
  // Packaged builds only: on macOS this sets the user-level Launch Services handler pref to the
  // bundle the process runs from — in dev that is node_modules' bare Electron.app, which then hijacks
  // the schemes system-wide: auth callbacks cold-start a blank Electron welcome window instead of the
  // installed app (until the installed app relaunches and re-registers). Dev deep-link testing:
  // ALPHA_DEV_PROTOCOL=1, and keep the dev instance running so open-url is delivered to it.
  if (app.isPackaged || process.env.ALPHA_DEV_PROTOCOL === "1") {
    // Register every manifest-declared transport scheme; registration remains an OS/main concern.
    DEEP_LINK_SCHEMES.forEach((scheme) => app.setAsDefaultProtocolClient(scheme))
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
    sidecarGenerationState: () => sidecarGeneration.get(),
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
    consumeInitialDeepLinks: (rendererId) => deepLinks.consumeInitial(rendererId),
    acknowledgeDeepLinks: (rendererId, batchId) => deepLinks.acknowledge(rendererId, batchId),
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
    () => Effect.runPromise(Deferred.await(serverReady)),
  )
  // REQ-135 retirement is a ledger mutation, so it waits for crash recovery and then takes the
  // same global extension lock before touching config/receipts. The result is awaited pre-sidecar.
  const communityExcelRetirement = TEST_ONBOARDING
    ? Promise.resolve({ ok: true as const, configRemoved: false, receiptRemoved: false })
    : retireCommunityExcelAfterRecovery(extLedgerReady)
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
  registerContractHealthIpcHandlers(() => mainWindow)
  // #1084:平台目录刷新失败的出口(启动那次刷新跑在本行之前 —— 所以它靠 invoke 取,不靠推送)。
  registerCatalogHealthIpcHandlers(() => mainWindow)
  const recovery = recoveryService
  if (!recovery) throw new Error("Recovery service is unavailable")
  const recoveryIpc = registerRecoveryIpcHandlers(recovery)
  // REQ-084/090:surface 选择与 crash admission 共用 main-owned Recovery incident registry。
  registerSurfaceIpc(app.getPath("userData"), recovery)
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

  // #564:catalog-liveness 看门狗接线(决策与探针分类全在 catalog-liveness.ts —— index.ts
  // 跑不进单测,判定住在这里就只剩源码锚看得见)。存活性判据原本 = 「进程在 + ready IPC 已发
  // + /global/health 200」,不覆盖「引擎活着但治理目录从未收敛、model.list 持续 0」:真机
  // run 20260724T091738 该状态被动等到 t=225s 才被一次 respawn 救活。引擎 ready 终态之后,
  // main 直接对引擎问 marker 探针(目录就绪的唯一证明,docs/architecture/
  // 2026-08-10-catalog-readiness-signals.md);60s 窗口内从未 ready → kill 交给既有 self-heal
  // respawn;窗口内任一次 ready → confirmed 永久解除。30min 内 3 次裁决 → 停止自动 kill,
  // 转 Recovery incident(与 engine runaway 的 stop-and-report 同纪律,反无限 kill 循环)。
  const armCatalogLivenessWatchdog = (gen: number) => {
    stopCatalogLivenessWatchdog()
    // R2 Major:catalog 就绪是 per-directory 的(core/location.ts boundNode 按目录懒引导),
    // 固定探 ~/Alpha(空目录、全场最快收敛)= 票面自己的复现场景(多 tab + 大仓)下几秒
    // confirmed 永久解除、大仓 224s 0 模型一次都不裁决。探针目录 = 用户首屏实际目录:
    // renderer 的 tab 状态经 store-set IPC 落在 main 自己的 store(与 tabs-preclean 同契约面),
    // 每代武装时解析一次(一窗一目录,窗口内不换靶 —— 换靶会把不同目录的 404 记进同一本账)。
    // 解析不出 / 目录已不在盘上(陈旧 tab)→ 回退默认工作区(= R1 行为)。
    const userDirectory = (() => {
      try {
        const store = getStore(GLOBAL_RENDERER_STORE)
        return resolveCatalogProbeDirectory({
          tabs: store.get(TABS_KEY),
          recent: store.get(TABS_RECENT_KEY),
          info: store.get(TABS_INFO_KEY),
        })
      } catch {
        return undefined // store 读挂了不许炸 boot 路径 —— 回退默认目录
      }
    })()
    const probeDirectory = userDirectory && existsSync(userDirectory) ? userDirectory : alphaUserWorkspaceDir()
    // R1 Blocker:探针目录不存在时 marker 端点**确定性 500**(实测 8/8,永不 404/200)——观测面
    // 不可用,不武装。也绝不顺手 mkdir:REQ-071/ADR-025「绝不代建」,启动即建目录是产品行为变更。
    // (~/Alpha 是 lazy 供给;首屏目录若存在则武装在它身上,~/Alpha 缺席不再一票否决。)
    if (!existsSync(probeDirectory)) {
      markStartupTimeline("main.sidecar.catalog_liveness.skipped", {
        generation: gen,
        reason: "workspace-dir-missing",
        directory: probeDirectory,
      })
      return
    }
    catalogLiveness = armCatalogLiveness(catalogLiveness, Date.now())
    // #1098:立刻巡查一次再进周期 —— 裸 setInterval 的首触发在 t=interval,
    // 头 5 秒一次巡查都不发(deadline / strike 上界一个没动,见 catalog-liveness.ts)。
    catalogLivenessTimer = startCatalogLivenessProbes(() => {
      if (gen !== sidecarGen || !server) {
        stopCatalogLivenessWatchdog()
        return
      }
      if (catalogLivenessProbeInFlight) return
      catalogLivenessProbeInFlight = true
      void probeCatalogMarker({ url, password, directory: probeDirectory }).then((sample) => {
        catalogLivenessProbeInFlight = false
        // 探针在途期间世界可能已换代/停表 —— 迟到样本不得写进新代的账。
        if (gen !== sidecarGen || !server || !catalogLivenessTimer) return
        const decision = decideCatalogLiveness(Date.now(), sample, catalogLiveness)
        catalogLiveness = decision.state
        if (decision.action === "none") return
        if (decision.action === "confirmed") {
          stopCatalogLivenessWatchdog()
          markStartupTimeline("main.sidecar.catalog_liveness.confirmed", {
            generation: gen,
            directory: probeDirectory,
            elapsedMs: decision.elapsedMs,
            probes: decision.probes,
          })
          return
        }
        if (decision.action === "indeterminate") {
          // R1 Blocker:窗口到期但引擎的应答全在协议外(如目录不存在的确定性 500)——弃权,
          // 不 kill 不记 strike。杀引擎要凭引擎自己的 404,不凭 500。
          stopCatalogLivenessWatchdog()
          markStartupTimeline("main.sidecar.catalog_liveness.indeterminate", {
            generation: gen,
            directory: probeDirectory,
            elapsedMs: decision.elapsedMs,
            probes: decision.probes,
            engineAnsweredNotReady: decision.engineNotReady,
            engineAnsweredUnclassified: decision.engineUnclassified,
            probeFailures: decision.probeFailures,
          })
          writeLog(
            "utility",
            "catalog liveness window closed without an authoritative not-converged signal — abstaining (no kill)",
            {
              directory: probeDirectory,
              elapsedMs: decision.elapsedMs,
              probes: decision.probes,
              engineAnsweredUnclassified: decision.engineUnclassified,
              probeFailures: decision.probeFailures,
            },
            "warn",
          )
          return
        }
        const current = server
        stopCatalogLivenessWatchdog()
        if (!current) return
        markStartupTimeline("main.sidecar.catalog_liveness.degraded", {
          generation: gen,
          directory: probeDirectory,
          action: decision.action,
          elapsedMs: decision.elapsedMs,
          probes: decision.probes,
          engineAnsweredNotReady: decision.engineNotReady,
          engineAnsweredUnclassified: decision.engineUnclassified,
          probeFailures: decision.probeFailures,
          strikes: catalogLiveness.strikes,
        })
        if (decision.action === "kill-and-respawn") {
          writeLog(
            "utility",
            "engine ready but governed catalog never converged — killing sidecar for self-heal respawn",
            {
              directory: probeDirectory,
              elapsedMs: decision.elapsedMs,
              probes: decision.probes,
              engineAnsweredNotReady: decision.engineNotReady,
              probeFailures: decision.probeFailures,
              strikes: catalogLiveness.strikes,
            },
            "error",
          )
          current.kill()
          return
        }
        // stop-and-report:不再自动 kill(退化实例仍在如实 serve「正在同步」,杀而不复只会更糟),
        // 留给显式恢复。
        writeLog(
          "utility",
          "governed catalog repeatedly never converged after ready — automatic respawn paused for explicit recovery",
          { strikes: catalogLiveness.strikes },
          "error",
        )
        if (!recoveryService || !mainWindow || mainWindow.isDestroyed()) return
        const incident = recoveryService.register({
          source: { kind: "engine", plan: { action: "give-up", state: selfHeal } },
          senderID: mainWindow.webContents.id,
          effects: {
            [RECOVERY_ACTIONS.retryEngine]: async () => {
              catalogLiveness = resetCatalogLiveness()
              selfHeal = initialSelfHealState()
              const applied = await requestSidecarRespawn?.("structural")
              return applied ? { applied: true } : { applied: false, retryable: true }
            },
          },
        })
        if (incident) mainWindow.webContents.send("alpha-recovery-incident", incident)
      }).catch((error) => {
        // R2 Minor:回调体做 writeLog / markStartupTimeline / recoveryService.register /
        // webContents.send / current.kill(),任一抛出都不得变成 main 的 unhandled rejection
        // (同文件 respawn 链 `void terminal.catch` 是同一理由挂的守卫)。另一半:probeCatalogMarker
        // 自身 reject(结构上不应发生,但守卫防的就是"不应发生")会把 probeInFlight 卡死成
        // 永久 true —— 之后每个 tick 空转、永无裁决,看门狗静默失效,所以这里必须复位。
        catalogLivenessProbeInFlight = false
        try {
          writeLog(
            "utility",
            "catalog liveness probe tick failed unexpectedly",
            { message: error instanceof Error ? error.message : String(error) },
            "error",
          )
        } catch {
          // 守卫自己不许再抛
        }
      })
    }, CATALOG_LIVENESS_PROBE_INTERVAL_MS)
  }

  yield* Effect.gen(function* () {
    logger.log("sidecar connection started", { url })

    ensureLoopbackNoProxy()
    useEnvProxy()

    // 快路径拿新 token 单 fork；慢路径先让 local-dir/BYOK 起服务，续期在后台完成后只经 token
    // generation latch 请求一次换血。
    if (bootRenewalRace) {
      const race = yield* Effect.promise(() => bootRenewalRace)
      markStartupTimeline("main.auth.boot.grace", {
        outcome: race.completed ? race.result.outcome : "timeout",
      })
      if (!race.completed)
        void race.pending.then(
          (result) => tokenRotation.accept(result, "boot-grace"),
          (error) =>
            markStartupTimeline("main.auth.rotation", {
              reason: "boot-grace",
              outcome: errorOutcome(error),
            }),
        )
    }

    const communityExcel = yield* Effect.promise(() => communityExcelRetirement)
    if (!communityExcel.ok) {
      const gap = `REQ-135 community Excel retirement failed: ${communityExcel.reason}`
      bootEnforcementGap = [...(bootEnforcementGap ?? []), gap]
      logger.error("[req135-1012] community Excel retirement failed — blocking sidecar (fail closed)", {
        reason: communityExcel.reason,
      })
    } else if (communityExcel.configRemoved || communityExcel.receiptRemoved) {
      logger.log("[req135-1012] community Excel install retired", {
        configRemoved: communityExcel.configRemoved,
        receiptRemoved: communityExcel.receiptRemoved,
      })
    }

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
      // Packaged VERIFY (OPENCODE_TEST_ONBOARDING) must observe exit 1 without dismissing a modal.
      if (TEST_ONBOARDING) {
        app.exit(1)
        return
      }
      dialog.showErrorBox(
        "扩展安全状态无法确保",
        "扩展配置或历史桥接状态无法确认已经安全收敛(可能因磁盘空间、权限或配置文件损坏)。为避免旧桥或本应关闭的扩展被意外加载,已暂停启动。请检查磁盘与目录权限后重新打开应用;若持续出现,请联系支持并附上日志。",
      )
      app.exit(1)
      return
    }

    logger.log("spawning sidecar", { url })
    const spawnGen = ++sidecarGen
    publishSidecarGeneration({ status: "recovering", generation: spawnGen, reason: "boot" })
    selfHeal = noteSpawn(selfHeal, Date.now())
    const forkTokenGeneration = getTokenGeneration()
    bootForkTokenGeneration = forkTokenGeneration
    pendingBootForkTokenGeneration = forkTokenGeneration
    const { listener } = yield* Effect.promise(() => {
      const started = performance.now()
      markStartupTimeline("main.sidecar.boot.fork.start", { generation: spawnGen })
      const spawning = spawnLocalServer(hostname, port, password, {
        userDataPath: app.getPath("userData"),
        onStdout: (message) => writeLog("server", "stdout", { message }),
        onStderr: (message) => writeLog("server", "stderr", { message }, "warn"),
        onExit: (code) => handleSidecarExit(spawnGen, code),
        timelineContext: "boot",
      })
      void spawning.then(
        () =>
          markStartupTimeline("main.sidecar.boot.fork.end", {
            durationMs: performance.now() - started,
            generation: spawnGen,
            outcome: "ok",
          }),
        (error) =>
          markStartupTimeline("main.sidecar.boot.fork.end", {
            durationMs: performance.now() - started,
            generation: spawnGen,
            outcome: errorOutcome(error),
          }),
      )
      // #577:终态生产者与 spawn 同时武装。父 fiber 从 serverReady 醒来后毫秒级终止会
      // 连带杀死本被监督 fiber(forkChild auto supervision),曾把「等健康 → 发 ready」
      // 连同 30s 兜底一起杀死;spawn 在返回 health 之前失败(R1 Blocker1)则连武装的机会
      // 都没有。armBootGenerationTerminal 是与 doRespawnSidecar 同构的普通 promise 链,
      // 覆盖三条路(spawn 失败 / 健康通过 / 健康失败超时),恰好发布一个终态,
      // 本 fiber 与父 fiber 的生死不再影响它。禁止把它搬回 yield* —— 回归锁见
      // sidecar-generation.test.ts 的接线锚断言。
      void armBootGenerationTerminal({
        generation: spawnGen,
        spawning,
        timeoutMs: BOOT_GENERATION_TERMINAL_MS,
        publish: publishSidecarGeneration,
        log: (message) => logger.log(message),
        logError: (message) => logger.error(message),
      }).then(
        // #859:boot fork 的 token 代结算由**终态独家驱动**,因为终态是这条路上唯一有上界的
        // 事实源(BOOT_GENERATION_TERMINAL_MS)。不能再直接挂在 `health.wait` 上:那个 promise
        // 结构上可能永不落定 —— server.ts 的 health 只有「探到健康」或「子进程先退出」两种
        // 结束方式,而 pollUntilHealthy 是无限轮询,所以「进程活着但永远不健康」(MCP 风暴、
        // 引擎卡死)会让它一直 pending。以它作唯一结算源时 pendingBootForkTokenGeneration
        // 被永久钉住,而 latch 的 in-flight 抑制分支是**不排重试定时器**的(还会让先前
        // !canRespawn 排下的那只定时器自然消亡)⇒ 那一代永远等不到换血,正是 ③′3 禁止的
        // 无定时器终局。R3 的 fail-closed 不变:只有健康线真的通过才提交代。
        // ready 与 injection-failed 都算通过(token 随 fork 物化,{file:} 通道不经注入 ——
        // 与 respawn 侧 armRespawnGenerationTerminal 的返回值语义同构);failed(健康失败、
        // 30s 超时、spawn 在握手前失败)只释放抑制、绝不提交。
        (terminal) => {
          settleBootForkTokenGeneration(forkTokenGeneration, terminal !== "failed")
          // #564:看门狗只在干净 ready 终态时武装(injection-failed 不武装:配置整份丢失是
          // 确定性缺失,respawn 修不了,武装只会白撞 strike 上界;它已有自己的 loud 终态)。
          if (terminal === "ready" && spawnGen === sidecarGen) armCatalogLivenessWatchdog(spawnGen)
        },
        // 终态生产者自身 rejected 也必须结算,否则抑制照样永久化(它已是全函数,这里是兜底)。
        () => settleBootForkTokenGeneration(forkTokenGeneration, false),
      )
      return spawning
    })
    server = listener
    armEngineRunawayMeter(spawnGen)
    sessionGrantRegistry.beginSession(spawnGen) // #408:新会话空集起步(grant 面绑本代)
    yield* Deferred.succeed(serverReady, {
      url,
      username: "opencode",
      password,
    })

    if (process.platform === "win32") {
      void wslServers.initialize().catch((error) => logger.error("wsl server initialization failed", error))
    }
  }).pipe(forwardInitializationFailure(serverReady), Effect.forkChild)

  // A1 (window-first): open the window as soon as the sidecar has spawned (serverReady settles) rather
  // than blocking on the health probe, which can lag many seconds under a slow sidecar / MCP
  // storm. The renderer shows a splash and gates on this same serverReady via awaitInitialization;
  // the boot generation terminal (ready/failed) runs on a detached promise chain armed at spawn
  // time (armBootGenerationTerminal, #577) that survives this fiber tree ending — including a
  // spawn that fails before health exists. Awaiting serverReady (not zero-wait) keeps the forked spawn alive to
  // completion; we ignore its failure so the window still opens to surface the connection error,
  // matching the prior behavior.
  yield* Deferred.await(serverReady).pipe(Effect.catch(() => Effect.sync(() => {})))

  // Deep-link stream ownership is attached inside createMainWindow — for this window and for every
  // one the `window.new` menu action creates — so no window can exist unwired. See deep-links.ts.
  mainWindow = createMainWindow()

  // REQ-063 T4:全局存量一次性迁移门(发布闸)——default-deny 后 ~/.claude/~/.agents 存量不可见,
  // 首启必弹防「技能丢了」重演;fire-and-forget,不阻塞窗口;marker 记账不再弹。
  if (!TEST_ONBOARDING) {
    void extLedgerReady
      .then(() => runGlobalEcosystemGate(mainWindow ?? undefined, logger, ecosystemGlobalSkillInstaller))
      .catch((error) => logger.warn("[req063] global ecosystem gate failed (non-fatal)", error))
  }

  // In-place sidecar respawn — NOT a full app relaunch. Both reasons re-fork on the same
  // host/port/password and refresh fork-time {file:} materialization. Structural changes keep the
  // historical renderer reload; token-only rotation relies on generation notification + surgical
  // SDK/SSE reconnection so the renderer tree remains mounted.
  const doRespawnSidecar = async (reason: SidecarRespawnReason) => {
    if (quittingApp) return false
    // #1044:token-only 换血会杀掉正在 waitForCallback 的 MCP.authenticate(云 OAuth)。
    // 引擎在等待回环回调期间落盘 inflight 标记;此处推迟换血,latch 会按 TOKEN_ROTATION_RETRY_MS 再试。
    if (reason === "token-only" && isCloudMcpOAuthInflight(engineDataDir(process.env, homedir()))) {
      logger.warn("#1044 deferring token-only respawn: cloud MCP OAuth in flight")
      return false
    }
    // #600:发出 recovering 之后必须恰好发布一个终态。终态生产者(armRespawnGenerationTerminal)
    // 一经武装就独占发布权;它武装之前出错的路径由下面的 catch 兜住那唯一一个 failed。
    let announcedGeneration: number | null = null
    let terminal: Promise<boolean> | null = null
    try {
      logger.log("respawning sidecar", { reason })
      // REQ-001:respawn 前刷新 edition 白名单缓存(登录刚建立 → 按租户 edition 收窄;8s 超时内置,
      // 失败保留 last-known/内置 snapshot,不阻断 respawn)。
      await syncLiveAllowlist(app.getPath("userData")).catch(() => {})
      const lockedSweep = withConfigWriteLock(() => ({
        acquired: true as const,
        outcome: sweepEngineConfigDanglingUnlocked({
          phase: "respawn",
          userDataPath: app.getPath("userData"),
          engineDataPath: engineDataDir(process.env, homedir()),
        }),
      }))
      if (!("acquired" in lockedSweep)) {
        if (!shouldRetryRespawn(reason)) {
          logger.error(`[req053-dangling-sweep] token rotation sweep skipped; keeping degraded state: ${lockedSweep.reason}`)
          return false
        }
        const retryDelayMs = Math.min(1000 * 2 ** selfHeal.attempts, SELF_HEAL_MAX_DELAY_MS)
        logger.error(
          `[req053-dangling-sweep] respawn sweep skipped; retrying this spawn in ${retryDelayMs}ms: ${lockedSweep.reason}`,
        )
        if (selfHealTimer) clearTimeout(selfHealTimer)
        selfHealTimer = setTimeout(() => {
          selfHealTimer = null
          void requestSidecarRespawn?.(reason)
        }, retryDelayMs)
        return false
      }
      recordDanglingSweep("respawn", lockedSweep.outcome)
      if (lockedSweep.outcome.enforcementGap.length > 0) {
        logger.error("[req053-dangling-sweep] respawn enforcement gap — refusing this spawn", {
          gap: lockedSweep.outcome.enforcementGap,
        })
        return false
      }
      // `#982`: gap-free respawn sweep credits the next spawnLocalServer fork.
      creditDanglingSweepForSpawn()
      const spawnGen = ++sidecarGen
      // #600:「当前 sidecar 携带的 token 代」只能在健康换血成功后记账。旧接线在 fork 前就记,
      // 失败后 latch 误判该代已应用(同代永不再试),而此刻根本没有活着的 sidecar。
      const forkTokenGeneration = getTokenGeneration()
      // R1 Major3:先记账再发布 —— 反过来的话,recovering 发布自身抛出时 catch 认不出
      // 「这一代已经宣告过」,补不上那个 failed。
      announcedGeneration = spawnGen
      publishSidecarGeneration({ status: "recovering", generation: spawnGen, reason })
      await killSidecar(reason)
      ensureLoopbackNoProxy()
      useEnvProxy()
      selfHeal = noteSpawn(selfHeal, Date.now())
      const started = performance.now()
      markStartupTimeline("main.sidecar.respawn.fork.start", { generation: spawnGen, reason })
      const spawning = spawnLocalServer(hostname, port, password, {
        userDataPath: app.getPath("userData"),
        onStdout: (message) => writeLog("server", "stdout", { message }),
        onStderr: (message) => writeLog("server", "stderr", { message }, "warn"),
        onExit: (code) => handleSidecarExit(spawnGen, code),
        timelineContext: "respawn",
      })
      void spawning.then(
        () =>
          markStartupTimeline("main.sidecar.respawn.fork.end", {
            durationMs: performance.now() - started,
            generation: spawnGen,
            reason,
            outcome: "ok",
          }),
        (error) =>
          markStartupTimeline("main.sidecar.respawn.fork.end", {
            durationMs: performance.now() - started,
            generation: spawnGen,
            reason,
            outcome: errorOutcome(error),
          }),
      )
      // #600:recovering 已发出 ⇒ 终态生产者立刻武装(与 boot 的 armBootGenerationTerminal 同构),
      // spawn 在返回 health 之前失败 / 健康失败 / 20s 超时 三条路各发布恰好一个 failed,
      // 健康通过发布恰好一个 ready。旧接线只在 healthy 时发 ready,另两条路让 generation
      // 永久停在 recovering,而 renderer 探不出一个不存在的 sidecar。
      terminal = armRespawnGenerationTerminal({
        generation: spawnGen,
        reason,
        spawning,
        timeoutMs: 20000,
        publish: publishSidecarGeneration,
        logError: (message) => logger.error(message),
      })
      // R1 Major3:spawn reject 时下面的 await 直接跳到 catch,没人再 await terminal ——
      // 挂一个吞异常的守卫,任何情况下都不会留下 unhandled rejection(main 进程有退出风险)。
      void terminal.catch(() => {})
      const { listener, injectionFailure } = await spawning
      server = listener
      armEngineRunawayMeter(spawnGen)
      sessionGrantRegistry.beginSession(spawnGen) // #408:respawn = 新会话,grant 恒从空集开始
      // B5 验收②:未健康不 reload —— reload 进死后端只会白屏(REQ-014 同族),留旧 renderer 状态。
      const healthy = await terminal
      commitSidecarTokenGeneration(forkTokenGeneration, healthy)
      // #564:respawn 侧与 boot 同判据 —— 只有健康且注入完好才武装 catalog-liveness 看门狗。
      if (healthy && !injectionFailure && spawnGen === sidecarGen) armCatalogLivenessWatchdog(spawnGen)
      if (healthy && mainWindow && !mainWindow.isDestroyed()) {
        if (shouldReloadRenderer(reason)) {
          markStartupTimeline("main.renderer.reload", {
            candidate: "C",
            count: ++rendererReloadCount,
            trigger: "sidecar-respawn",
          })
          mainWindow.webContents.reload()
          logger.log("sidecar respawned + renderer reloaded")
        } else {
          markStartupTimeline("main.renderer.reload.skipped", {
            generation: spawnGen,
            reason,
            outcome: "continuity",
          })
          logger.log("sidecar token rotated without renderer reload")
        }
      }
      return healthy
    } catch (error) {
      logger.error("sidecar respawn failed", error)
      // 终态生产者已武装 ⇒ 由它发布(spawn reject 也走那条路);尚未武装但已发出 recovering ⇒
      // 这里补上那唯一一个 failed,绝不让 generation 停在 recovering。
      if (announcedGeneration !== null && !terminal)
        publishSidecarGeneration({ status: "failed", generation: announcedGeneration, reason })
      return false
    }
  }
  // 单飞 + 一轮排队合并；排队中的 token-only 遇 structural 必升级，不能把需要 reload 的
  // 配置/身份变化误吞成连续性换血。
  const respawnSidecar = createSidecarRespawnQueue(doRespawnSidecar)

  requestSidecarRespawn = respawnSidecar // B5:崩溃自愈复用同一互斥/合并入口
  if (pendingAuthStructuralRespawn && bootForkTokenGeneration !== getTokenGeneration())
    void respawnSidecar("structural")
  pendingAuthStructuralRespawn = false
  setProviderLifecycleDeps({ refreshRuntime: () => respawnSidecar("structural") })
  // B21:BYOK 改键/删键即时生效 —— 持久化成功后重注 env(自有注入权威覆盖/清除,用户值不动)+
  // respawn(fork 时 A6 syncSecretFiles 把新 env 镜像进 {file:} 通道 → 新 sidecar 即用新 key)。
  setByokKeyDeps({
    onChanged: () => {
      injectByokKeysIntoEnv()
      void respawnSidecar("structural")
    },
  })
  authScheduler = createAuthRenewalScheduler({
    timing: getAuthRenewalTiming,
    renew: () => observeEnsureFreshToken("scheduled"),
    onArm: (reason, delayMs) =>
      markStartupTimeline("main.auth.scheduler.arm", {
        reason,
        ...(delayMs === null ? { outcome: "idle" } : { delayMs, outcome: "armed" }),
      }),
    onResult: (result) =>
      markStartupTimeline("main.auth.scheduler.result", {
        generation: result.generation,
        outcome: result.outcome,
      }),
  })
  const onResume = () => authScheduler?.rearm("resume")
  powerMonitor.on("resume", onResume)
  authScheduler.rearm("startup")
  void tokenRotation.flush()
  app.once("will-quit", () => {
    powerMonitor.removeListener("resume", onResume)
    authScheduler?.stop()
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
