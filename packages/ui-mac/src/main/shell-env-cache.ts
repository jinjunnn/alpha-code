// B1:登录 shell env 探测的缓存与异步刷新(electron-free,读写与形状校验单测覆盖)。
//
// 痛点:preferAppEnv 在启动关键路径上**同步** spawn 登录 shell(-il 5s 超时,失败再 -l 5s,最坏 ~10s)
// —— 用户 .zshrc 慢(nvm/brew/conda)时黑屏等待。
// 修法:上次成功探测结果缓存到 <userData>/alpha-shell-env.json;命中 → 0ms 套用 + **后台异步**真探测
// (成功后更新缓存、并按「真 export 永远赢」语义套用差异,新值下次 fork 生效);未命中(首启/换 shell)
// → 保持同步探测(fork 前没有 PATH 等 shell env,MCP 子进程会拿到 launchd 的贫瘠 PATH,宁可首启慢一次)。
// 缓存按 shell 路径键控:用户换默认 shell → 缓存失效走同步路径。

import { spawn } from "node:child_process"
import * as fs from "node:fs"
import * as path from "node:path"
import { isNushell, minimalProbeEnv, parseShellEnv } from "./shell-env"

const FILE = "alpha-shell-env.json"
const PROBE_TIMEOUT = 5_000

// REQ-047 读侧兜底:这些键重定向 alpha/引擎的数据根、开调试端口、开迁移闸 —— 从缓存套用
// 永远不是用户本意(真想用请在启动 env 里真 export,那一层「真 export 永远赢」照常生效)。
// 主修在探针侧(minimalProbeEnv,毒进不来);本 blocklist 专治**存量已毒化**的缓存文件:
// 修复版首启即剥离危险键,随后干净再探测会整份重写缓存完成自愈。
const SESSION_CONTROL_KEYS = [
  "ALPHA_GLOBAL_DIR",
  "ALPHA_ENV_BASE_DIR",
  "ALPHA_OPENCODE_HOME",
  "OPENCODE_CONFIG_DIR",
  "OPENCODE_CONFIG", // REQ-059:alpha 每 fork 设它指向当前环境 alpha.jsonc —— 不得被 shell env 缓存跨会话污染
  "OPENCODE_DB",
  "ALPHA_MIGRATE_ENABLE",
  "ALPHA_JSONC_TRUTH_DISABLE",
  "ALPHA_CDP",
  "ALPHA_LEGACY_INSTALL_ROOT",
  "OPENCODE_TEST_ONBOARDING",
] as const

/** 剥离缓存里的会话级控制键;stripped 非空时调用方应 loud 留痕(B11 反静默)。 */
export function sanitizeCachedShellEnv(env: Record<string, string>): {
  env: Record<string, string>
  stripped: string[]
} {
  const stripped = SESSION_CONTROL_KEYS.filter((k) => k in env)
  if (stripped.length === 0) return { env, stripped }
  const clean = { ...env }
  for (const k of stripped) delete clean[k]
  return { env: clean, stripped }
}

export type ShellEnvCache = { probedAt: string; shell: string; env: Record<string, string> }

export function shellEnvCachePath(userDataPath: string): string {
  return path.join(userDataPath, FILE)
}

/** 读缓存;缺失/坏 JSON/形状不对/shell 不匹配 → null(调用方回退同步探测)。 */
export function readShellEnvCache(userDataPath: string, shell: string): Record<string, string> | null {
  try {
    const parsed = JSON.parse(fs.readFileSync(shellEnvCachePath(userDataPath), "utf8")) as ShellEnvCache
    if (!parsed || typeof parsed !== "object" || parsed.shell !== shell) return null
    if (!parsed.env || typeof parsed.env !== "object" || Array.isArray(parsed.env)) return null
    if (Object.keys(parsed.env).length === 0) return null
    for (const [k, v] of Object.entries(parsed.env)) if (typeof k !== "string" || typeof v !== "string") return null
    const { env, stripped } = sanitizeCachedShellEnv(parsed.env)
    if (stripped.length > 0)
      console.log(`[server] [req047] stripped session-control keys from cached shell env: ${stripped.join(", ")}`)
    if (Object.keys(env).length === 0) return null
    return env
  } catch {
    return null
  }
}

export function writeShellEnvCache(userDataPath: string, shell: string, env: Record<string, string>): void {
  if (Object.keys(env).length === 0) return // 失败/空探测不缓存 —— 下次启动重试
  fs.mkdirSync(userDataPath, { recursive: true })
  const cache: ShellEnvCache = { probedAt: new Date().toISOString(), shell, env }
  fs.writeFileSync(shellEnvCachePath(userDataPath), JSON.stringify(cache))
}

/** 异步登录 shell 探测(镜像 shell-env.ts 的同步版:-il 优先,失败退 -l;nushell 跳过)。 */
export async function probeShellEnvAsync(shell: string): Promise<Record<string, string> | null> {
  if (isNushell(shell)) return null
  for (const mode of ["-il", "-l"] as const) {
    const env = await new Promise<Record<string, string> | null>((resolve) => {
      // REQ-047:与同步探测同款最小干净 env —— 裸继承会把 app 自身(可能已被毒缓存污染的)env
      // 回灌进缓存,构成自续毒化;干净探测使异步刷新真正具备「整份重写自愈」能力。
      const child = spawn(shell, [mode, "-c", "env -0"], {
        stdio: ["ignore", "pipe", "ignore"],
        windowsHide: true,
        env: minimalProbeEnv(process.env),
      })
      const chunks: Buffer[] = []
      const timer = setTimeout(() => {
        child.kill()
        resolve(null)
      }, PROBE_TIMEOUT)
      child.stdout.on("data", (c: Buffer) => chunks.push(c))
      child.on("error", () => {
        clearTimeout(timer)
        resolve(null)
      })
      child.on("close", (code) => {
        clearTimeout(timer)
        if (code !== 0) return resolve(null)
        const parsed = parseShellEnv(Buffer.concat(chunks))
        resolve(Object.keys(parsed).length ? parsed : null)
      })
    })
    if (env) return env
  }
  return null
}
