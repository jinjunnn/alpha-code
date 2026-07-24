import { existsSync } from "node:fs"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"
import { app, utilityProcess } from "electron"
import type { Details } from "electron"
import { resolveExtPluginPath } from "./alpha-ext-plugin"
import { tryGetAlphaEnvironment } from "./alpha-environment"
import { applyEcosystemDefaultDeny } from "./ecosystem-import"
import { hasSecretFile, syncSecretFiles } from "./alpha-secret-files"
import { loadAlphaSecrets } from "./alpha-secrets"
import { posixModesEffective } from "./platform"
import { pollUntilHealthy } from "./health-poll"
import { getLogger, rotateServerLogs, write } from "./logging"
import { createSidecarEnv } from "./sidecar-env"
import { getUserShell, loadShellEnv } from "./shell-env"
import { probeShellEnvAsync, readShellEnvCache, sanitizeCachedShellEnv, writeShellEnvCache } from "./shell-env-cache"
import { getStore } from "./store"
import { DEFAULT_SERVER_URL_KEY } from "./store-keys"
import { isEphemeralLocalServerUrl } from "../shared/ephemeral-server-url"
import { ensureEngineScratchCwd } from "./engine-scratch-cwd"
import { markStartupTimeline } from "./startup-timeline"

export type HealthCheck = { wait: Promise<void> }

type SidecarMessage =
  | { type: "ready" }
  | { type: "stopped" }
  | { type: "error"; error: { message: string; stack?: string } }

export type SidecarListener = { stop: () => Promise<void>; kill: () => void }

const SIDECAR_SERVICE_NAME = "opencode server"
const SIDECAR_START_STALL_TIMEOUT = 60_000
const SIDECAR_STOP_TIMEOUT = 6_000

type SpawnLocalServerOptions = {
  userDataPath: string
  onStdout?: (message: string) => void
  onStderr?: (message: string) => void
  onExit?: (code: number) => void
  healthCheck?: typeof checkHealth
  fork?: typeof utilityProcess.fork
  timelineContext?: "boot" | "respawn"
}

export function getDefaultServerUrl(): string | null {
  const value = getStore().get(DEFAULT_SERVER_URL_KEY)
  const url = typeof value === "string" ? value : null
  if (url && isEphemeralLocalServerUrl(url)) {
    // REQ-042(REQ-040 收尾):陈旧「具体端口本地 URL」默认的丢弃必须留痕(反静默,B11 纪律)且删键——
    // 否则该键永留 store、每次开机重判。set-default 写入时不拦(彼时 URL 真活),只在冷启动读取处治理。
    getLogger().log(
      `[server] discarding stale local default server url (${url}) — embedded sidecar port is random per launch; falling back to live sidecar (stale key removed)`,
    )
    getStore().delete(DEFAULT_SERVER_URL_KEY)
    return null
  }
  return url
}

export function setDefaultServerUrl(url: string | null) {
  if (url) {
    getStore().set(DEFAULT_SERVER_URL_KEY, url)
    return
  }

  getStore().delete(DEFAULT_SERVER_URL_KEY)
}

export function preferAppEnv(userDataPath: string) {
  const logger = getLogger()
  const logShellEnvCache = (message: string, extra?: Record<string, unknown>) => write("main", message, extra)
  const forceOffKeylessWebSearch = () => {
    if (
      !process.env.ALPHA_WEBSEARCH_DISABLE &&
      (!process.env.ALPHA_CLOUD_MCP_URL || !hasSecretFile(userDataPath, "ALPHA_CLOUD_TOKEN"))
    )
      return
    Object.assign(process.env, {
      OPENCODE_ENABLE_EXA: "0",
      OPENCODE_EXPERIMENTAL_EXA: "0",
      OPENCODE_ENABLE_PARALLEL: "0",
      OPENCODE_EXPERIMENTAL_PARALLEL: "0",
    })
  }
  const shell = process.platform === "win32" ? null : getUserShell()
  // 1. Login-shell env first -- a real `export` wins over the secrets file and ordinary defaults;
  //    the websearch capability controls below are explicit local sovereignty overrides.
  // B1:缓存命中 → 0ms 套用 + 后台异步真探测(成功即更新缓存、按「真 export 赢」套差异,新值下次
  // fork 生效);未命中(首启/换 shell)→ 同步探测一次(fork 前必须有 PATH 等,宁可首启慢一次)。
  if (shell) {
    const cached = readShellEnvCache(userDataPath, shell, logShellEnvCache)
    if (cached) {
      Object.assign(process.env, cached)
      logger.log(`[server] Shell env from cache (${Object.keys(cached).length} vars) — refreshing in background`)
      void probeShellEnvAsync(shell)
        .then((fresh) => {
          if (!fresh) return
          // REQ-098 #301:新鲜异步探测结果同样要剥离会话级控制键(ALPHA_GLOBAL_DIR / OPENCODE_CONFIG_DIR
          // / ALPHA_OPENCODE_HOME…),否则用户 rc 里的显式 export 会在环境冻结后覆盖 process.env,让根漂移
          // 并随 fork 传进 sidecar。此前仅缓存读路径净化,fresh 路径漏网(与冻结快照形成双真源)。
          const { env: cleanFresh, stripped } = sanitizeCachedShellEnv(fresh)
          if (stripped.length > 0)
            logger.log(
              `[server] [req301] stripped session-control keys from refreshed shell env: ${stripped.join(", ")}`,
            )
          writeShellEnvCache(userDataPath, shell, cleanFresh, logShellEnvCache)
          Object.assign(process.env, cleanFresh)
          forceOffKeylessWebSearch()
          logger.log(`[server] Shell env refreshed in background (${Object.keys(cleanFresh).length} vars)`)
        })
        .catch(() => {})
    } else {
      const probed = loadShellEnv(shell, logger)
      Object.assign(process.env, probed ?? {})
      if (probed) writeShellEnvCache(userDataPath, shell, probed, logShellEnvCache)
    }
  }
  // 2. Fill missing API keys (EXA_API_KEY, *_API_KEY, ...) from the alpha.env secrets file, so app
  //    users never have to touch ~/.zshrc. Never overrides anything already set in step 1.
  loadAlphaSecrets(userDataPath, logger)
  // 3. Desktop defaults. Logged-out/BYOK keeps keyless websearch available to every provider;
  //    platform-pays makes cloud_web_search authoritative, while ALPHA_WEBSEARCH_DISABLE is a
  //    capability kill switch in every auth state. Both force-disable every specific Exa/Parallel
  //    flag, including values imported from the user's login shell.
  // B12 拍板(2026-07-05,S17 T5):实验 flag 改 set-if-unset —— 默认开(filewatcher 供「外部变更
  // 感知」:外部编辑/外部 git 的文件树/分支刷新;agent 自身修改由工具主动发事件、不受影响),但尊重
  // 用户显式 export(=false 可关;此前 Object.assign 硬覆盖,与上方「真 export 赢」注释矛盾)。
  // watcher 内存压力主治 = B4 数据层减 Instance;上游本体(无 TTL/LRU)接受(R2)。
  process.env.OPENCODE_EXPERIMENTAL_ICON_DISCOVERY ??= "true"
  process.env.OPENCODE_EXPERIMENTAL_FILEWATCHER ??= "true"
  // REQ-063(ADR-024):外部生态继承 default-deny —— `.claude`/`.agents` skills 与 CLAUDE.md 不再
  // 静默进上下文(提示注入面 + 破坏 .alpha 单一真源心智)。set-if-unset:shell 显式 export 优先
  // (B21 同款纪律);ALPHA_ECOSYSTEM_INHERIT=1 = 不注入两 flag,整机恢复上游继承且 alpha 不再
  // 检测/弹窗(ADR-024 §5)。同意后的进入通道 = 安装期转换导入 .alpha(ecosystem-import.ts),非重开继承。
  applyEcosystemDefaultDeny(process.env)
  Object.assign(process.env, {
    OPENCODE_CLIENT: "desktop",
    XDG_STATE_HOME: process.env.XDG_STATE_HOME ?? userDataPath,
    // models.dev refresh times out / logs ERROR on CN networks; the bundled snapshot suffices. Default
    // off, env-overridable (set OPENCODE_DISABLE_MODELS_FETCH=0 to re-enable). (T1.7 / C4)
    OPENCODE_DISABLE_MODELS_FETCH: process.env.OPENCODE_DISABLE_MODELS_FETCH ?? "1",
    ...(process.env.ALPHA_WEBSEARCH_DISABLE ? {} : { OPENCODE_ENABLE_EXA: process.env.OPENCODE_ENABLE_EXA ?? "1" }),
  })
  forceOffKeylessWebSearch()
}

export async function spawnLocalServer(
  hostname: string,
  port: number,
  password: string,
  options: SpawnLocalServerOptions,
) {
  // A6: mirror the secret env vars into the {file:} channel on EVERY fork (login/logout/key changes
  // respawn the sidecar through here, so the files always track the current auth/BYOK state), then
  // fork with the allowlisted env — secrets never enter the sidecar's process.env. Loud on failure:
  // without the files, the platform/BYOK providers silently vanish from the picker (anti-B11).
  try {
    const sync = syncSecretFiles(options.userDataPath)
    getLogger()?.log(`alpha-secrets sync: wrote [${sync.written.join(", ")}] removed [${sync.removed.join(", ")}]`)
    // REQ-076 T2(ADR-026 §5,C28 反 placebo):0600/0700 在 NTFS 近乎 no-op —— 密钥文件的
    // owner-only 保证在 Windows 缺位(icacls ACL 待 T3 拍板)。loud,不静默装样子。
    if (!posixModesEffective())
      getLogger()?.warn(
        "alpha-secrets: POSIX 0600/0700 权限位在 Windows(NTFS)不生效 —— 密钥文件暂无 owner-only 保证(icacls ACL 待 REQ-076 T3 拍板)",
      )
  } catch (error) {
    getLogger()?.error("alpha-secrets sync FAILED — platform/BYOK providers will be missing", error)
  }

  // B6(=G1):解析 @alpha-code/ext bundle 路径,经 StartCommand 传 sidecar(不走 env,免动 A6 白名单)。
  // 缺文件 loud warn(anti-B11:否则表现为「alpha_ping 工具静默不在」);ALPHA_EXT_DISABLE=1 静默跳过。
  const ext = resolveExtPluginPath({
    packaged: app.isPackaged,
    resourcesPath: process.resourcesPath,
    moduleDir: dirname(fileURLToPath(import.meta.url)),
    disabled: process.env.ALPHA_EXT_DISABLE === "1",
    exists: existsSync,
  })
  if (ext.path) getLogger()?.log("alpha-ext: loading plugin bundle", { path: ext.path })
  else if (ext.reason?.includes("ALPHA_EXT_DISABLE")) getLogger()?.log("alpha-ext: disabled by ALPHA_EXT_DISABLE")
  else getLogger()?.warn(`alpha-ext: NOT loaded — ${ext.reason}`)

  // REQ-065:出厂技能 reconcile 已上移至 boot(index.ts,truth reconcile 之前)—— skills.paths
  // 直指 app 资源、.alpha 不再落出厂链;fork 前无需重复(app 路径仅跨重启变化)。

  const sidecar = join(dirname(fileURLToPath(import.meta.url)), "sidecar.js")
  rotateServerLogs()
  const child = (options.fork ?? utilityProcess.fork)(sidecar, [], {
    cwd: ensureEngineScratchCwd(options.userDataPath),
    env: createSidecarEnv(),
    serviceName: SIDECAR_SERVICE_NAME,
    stdio: "pipe",
  })
  let exited = false
  const exit = defer<number>()

  const onProcessGone = (_event: unknown, details: Details) => {
    if (details.type !== "Utility" || details.name !== SIDECAR_SERVICE_NAME) return
    options.onStderr?.(`utility process gone reason=${details.reason} exitCode=${details.exitCode}`)
  }

  app.on("child-process-gone", onProcessGone)
  child.once("exit", (code) => {
    exited = true
    app.off("child-process-gone", onProcessGone)
    options.onExit?.(code)
    exit.resolve(code)
  })
  child.on("error", (error) => options.onStderr?.(`utility process error: ${serializeError(error).message}`))

  child.stdout?.on("data", (chunk: Buffer) => options.onStdout?.(chunk.toString("utf8").trimEnd()))
  child.stderr?.on("data", (chunk: Buffer) => options.onStderr?.(chunk.toString("utf8").trimEnd()))

  await new Promise<void>((resolve, reject) => {
    let done = false
    let timeout: NodeJS.Timeout

    const fail = (error: Error) => {
      if (done) return
      done = true
      cleanup()
      reject(error)
    }

    const refreshTimeout = () => {
      clearTimeout(timeout)
      timeout = setTimeout(() => {
        fail(new Error(`Sidecar did not become ready within ${SIDECAR_START_STALL_TIMEOUT}ms: ${sidecar}`))
      }, SIDECAR_START_STALL_TIMEOUT)
    }

    const onMessage = (message: SidecarMessage) => {
      if (message.type === "ready") {
        if (done) return
        markStartupTimeline("main.sidecar.ready_ipc", {
          context: options.timelineContext ?? "other",
        })
        done = true
        cleanup()
        resolve()
        return
      }
      if (message.type === "error") {
        fail(Object.assign(new Error(message.error.message), { stack: message.error.stack }))
      }
    }
    const onExit = (code: number) => {
      fail(new Error(`Sidecar exited before ready with code ${code}`))
    }
    const cleanup = () => {
      clearTimeout(timeout)
      child.off("message", onMessage)
      child.off("exit", onExit)
    }

    child.on("message", onMessage)
    child.on("exit", onExit)
    refreshTimeout()
    // #397:override 注入的 catalog 通道在 MAIN 侧从冻结快照取好随命令传入 —— sidecar 进程从不
    // initAlphaEnvironment,自取必抛且曾整体炸掉 alpha 配置注入(2026-07-23)。boot 序保证 spawn 前
    // 已 init;tryGet 仅为纯单测兜底(缺省 → sidecar loud 跳过 override 注入,boot reconcile 兜 fail-closed)。
    const registryChannel = tryGetAlphaEnvironment()?.registryChannel
    if (!registryChannel)
      getLogger()?.warn("alpha environment not initialized at sidecar spawn — disabled-override injection will be skipped")
    child.postMessage({
      type: "start",
      hostname,
      port,
      password,
      userDataPath: options.userDataPath,
      extPluginPath: ext.path,
      registryChannel,
    })
  }).catch((error) => {
    if (!exited) child.kill()
    throw error
  })

  const wait = (async () => {
    const url = `http://${hostname}:${port}`
    let healthy = false
    const gone = exit.promise.then((code) => {
      if (healthy) return
      throw new Error(`Sidecar exited before health check passed with code ${code}`)
    })

    const ready = async () => {
      // D1: probe immediately, then back off ~100ms only after a failed check (was sleep-first,
      // costing every startup an upfront ~100ms). Mirrors wsl/startup.ts `pollWslHealth` ordering.
      await pollUntilHealthy(() => (options.healthCheck ?? checkHealth)(url, password), 100)
      healthy = true
    }

    await Promise.race([ready(), gone])
  })()

  let stopping: Promise<void> | undefined

  return {
    listener: {
      kill: () => {
        if (!exited) child.kill()
      },
      stop: () => {
        if (stopping) return stopping
        if (exited) return Promise.resolve()
        child.postMessage({ type: "stop" })
        stopping = Promise.race([
          exit.promise.then(() => undefined),
          delay(SIDECAR_STOP_TIMEOUT).then(() => {
            if (!exited) child.kill()
          }),
        ])
        return stopping
      },
    },
    health: { wait },
  }
}

export async function checkHealth(url: string, password?: string | null): Promise<boolean> {
  let healthUrl: URL
  try {
    healthUrl = new URL("/global/health", url)
  } catch {
    return false
  }

  const headers = new Headers()
  if (password) {
    const auth = Buffer.from(`opencode:${password}`).toString("base64")
    headers.set("authorization", `Basic ${auth}`)
  }

  try {
    const res = await fetch(healthUrl, {
      method: "GET",
      headers,
      signal: AbortSignal.timeout(3000),
    })
    return res.ok
  } catch {
    return false
  }
}

// createSidecarEnv moved to sidecar-env.ts (A6: allowlist, unit-testable without electron). The
// OPENCODE_* prefix passes through wholesale, which keeps the channel-suffixed DB behavior intact
// (`opencode-${InstallationChannel}.db` shared across dev + packaged — see the "lost on restart"
// note in that file's history / opencode-channel-db-persistence).

function delay(ms: number) {
  return new Promise<void>((resolve) => setTimeout(resolve, ms))
}

function serializeError(error: unknown) {
  if (error instanceof Error) return { message: error.message, stack: error.stack }
  return { message: String(error) }
}

function defer<T>() {
  let resolve!: (value: T) => void
  let reject!: (error: Error) => void
  const promise = new Promise<T>((res, rej) => {
    resolve = res
    reject = rej
  })
  return { promise, resolve, reject }
}
