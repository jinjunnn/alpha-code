import { spawnSync } from "node:child_process"
import { userInfo } from "node:os"
import { basename } from "node:path"

const TIMEOUT = 5_000

type Probe = { type: "Loaded"; value: Record<string, string> } | { type: "Timeout" } | { type: "Unavailable" }
type ShellEnvLogger = {
  log: (message: string) => void
}

export function resolveUserShell(envShell: string | undefined, loginShell: string | null | undefined) {
  const resolvedLoginShell = loginShell && loginShell !== "unknown" ? loginShell : undefined
  return envShell || resolvedLoginShell || "/bin/sh"
}

export function getUserShell() {
  try {
    return resolveUserShell(process.env.SHELL, userInfo().shell)
  } catch {
    return resolveUserShell(process.env.SHELL, undefined)
  }
}

export function parseShellEnv(out: Buffer) {
  const env: Record<string, string> = {}
  for (const line of out.toString("utf8").split("\0")) {
    if (!line) continue
    const ix = line.indexOf("=")
    if (ix <= 0) continue
    env[line.slice(0, ix)] = line.slice(ix + 1)
  }
  return env
}

// REQ-047:探测子 shell 只给最小干净 env —— 裸继承 app 自身 env 时,登录 shell 会把继承值随
// `env -0` 原样回吐,被当成「用户 shell 导出的环境」写进缓存并在此后每次启动(含 Finder)套用;
// 批测/终端启动带的会话级隔离与调试变量(ALPHA_GLOBAL_DIR / OPENCODE_CONFIG_DIR / ALPHA_CDP…)
// 就此永久腌入,且异步刷新同样继承 → 毒化自续、永不自愈。最小集使缓存语义回归
// 「登录 shell 自己导出什么」;PATH 给系统底座,登录 shell 自会经 /etc/paths + rc 重建。
export function minimalProbeEnv(source: Record<string, string | undefined>): Record<string, string> {
  const env: Record<string, string> = { PATH: "/usr/bin:/bin:/usr/sbin:/sbin" }
  for (const key of ["HOME", "USER", "LOGNAME", "SHELL", "LANG", "LC_ALL", "TERM", "TMPDIR"]) {
    const v = source[key]
    if (typeof v === "string" && v) env[key] = v
  }
  return env
}

function probe(shell: string, mode: "-il" | "-l"): Probe {
  const out = spawnSync(shell, [mode, "-c", "env -0"], {
    stdio: ["ignore", "pipe", "ignore"],
    timeout: TIMEOUT,
    windowsHide: true,
    env: minimalProbeEnv(process.env),
  })

  const err = out.error as NodeJS.ErrnoException | undefined
  if (err) {
    if (err.code === "ETIMEDOUT") return { type: "Timeout" }
    console.log(`[server] Shell env probe failed for ${shell} ${mode}: ${err.message}`)
    return { type: "Unavailable" }
  }

  if (out.status !== 0) {
    console.log(`[server] Shell env probe exited with non-zero status for ${shell} ${mode}`)
    return { type: "Unavailable" }
  }

  const env = parseShellEnv(out.stdout)
  if (Object.keys(env).length === 0) {
    console.log(`[server] Shell env probe returned empty env for ${shell} ${mode}`)
    return { type: "Unavailable" }
  }

  return { type: "Loaded", value: env }
}

export function isNushell(shell: string) {
  const name = basename(shell).toLowerCase()
  const raw = shell.toLowerCase()
  return name === "nu" || name === "nu.exe" || raw.endsWith("\\nu.exe")
}

export function loadShellEnv(shell: string, logger: ShellEnvLogger) {
  if (isNushell(shell)) {
    logger.log(`[server] Skipping shell env probe for nushell: ${shell}`)
    return null
  }

  const interactive = probe(shell, "-il")
  if (interactive.type === "Loaded") {
    logger.log(`[server] Loaded shell environment with -il (${Object.keys(interactive.value).length} vars)`)
    return interactive.value
  }
  if (interactive.type === "Timeout") {
    logger.log(`[server] Interactive shell env probe timed out: ${shell}`)
    return null
  }

  const login = probe(shell, "-l")
  if (login.type === "Loaded") {
    logger.log(`[server] Loaded shell environment with -l (${Object.keys(login.value).length} vars)`)
    return login.value
  }

  logger.log(`[server] Falling back to app environment: ${shell}`)
  return null
}

export function mergeShellEnv(shell: Record<string, string> | null, env: Record<string, string>) {
  return {
    ...shell,
    ...env,
  }
}
