// REQ-084:surface RESOLVER(main process)。renderer 挂载路由树之前,main 按
//
//   env override  >  userData pin 文件  >  发布默认(shared/alpha-surfaces.ts)
//   ALPHA_SURFACE_*    <userData>/alpha-surfaces.json
//
// 逐 surface 解析出生效模式;"auto-fallback" 态再叠一层崩溃记录:本 app 版本记录过致命渲染错误
// → legacy(crash-fallback),旧版本的记录视为陈旧忽略(新版本成功加载即自然失效)。解析只在
// 加载时进行 —— 运行中绝不热切换,任何改动下次 reload 才体现。
// 失败上报(alpha-surface-failure)落盘同一 JSON;错误文本截断 500 字符并剥离绝对路径样式片段
// (userData 内容可能进日志导出包,不落用户路径)。文件损坏/不可读 → 按空处理(留一行日志)。

import { app, ipcMain } from "electron"
import * as fs from "node:fs"
import * as path from "node:path"
import {
  SURFACE_RELEASE_STATES,
  type ResolvedSurface,
  type ResolvedSurfaces,
  type SurfaceId,
  type SurfaceReleaseState,
} from "../shared/alpha-surfaces"
import { getLogger } from "./logging"

const SURFACE_IDS = ["home", "newSession", "session"] as const
const RELEASE_STATES: readonly SurfaceReleaseState[] = ["alpha", "legacy", "auto-fallback"]
const ENV_KEYS: Record<SurfaceId, string> = {
  home: "ALPHA_SURFACE_HOME",
  newSession: "ALPHA_SURFACE_NEW_SESSION",
  session: "ALPHA_SURFACE_SESSION",
}
const FILE = "alpha-surfaces.json"
/** 错误文本上限 —— 只为 fallback 判定与排障留因,不是完整报错落盘通道。 */
const MAX_ERROR_CHARS = 500
/** 绝对路径样式片段(win 盘符前缀 / macOS-linux 家目录路径)—— 持久化前剥离。 */
const PATH_LIKE = /[A-Za-z]:\\|\/(Users|home)\/[^\s"']+/g

export type SurfaceFailure = { at: string; appVersion: string; error: string }
export type SurfaceFile = {
  pins?: Partial<Record<SurfaceId, SurfaceReleaseState>>
  failures?: Partial<Record<SurfaceId, SurfaceFailure>>
}

const isSurfaceId = (v: unknown): v is SurfaceId => typeof v === "string" && (SURFACE_IDS as readonly string[]).includes(v)
const isReleaseState = (v: unknown): v is SurfaceReleaseState =>
  typeof v === "string" && (RELEASE_STATES as readonly string[]).includes(v)

const surfaceFilePath = (userDataPath: string) => path.join(userDataPath, FILE)

// getLogger() 在单测(未 initLogging)下为 undefined —— 静默跳过,日志非契约。
const log = (level: "info" | "warn", message: string) => getLogger()?.[level](message)

/** 读 <userData>/alpha-surfaces.json 并逐项形状校验(非法 pin 值/残缺 failure 条目丢弃)。
 *  文件缺失 → 空;存在但损坏/不可读 → 空 + 一行日志(不含路径)。 */
export function readSurfaceFile(userDataPath: string): SurfaceFile {
  const file = surfaceFilePath(userDataPath)
  if (!fs.existsSync(file)) return {}
  try {
    const raw = JSON.parse(fs.readFileSync(file, "utf8")) as Record<string, unknown>
    const out: SurfaceFile = {}
    const pins = raw.pins as Record<string, unknown> | undefined
    const failures = raw.failures as Record<string, unknown> | undefined
    for (const id of SURFACE_IDS) {
      const pin = pins?.[id]
      if (isReleaseState(pin)) (out.pins ??= {})[id] = pin
      const f = failures?.[id] as Record<string, unknown> | undefined
      if (f && typeof f.at === "string" && typeof f.appVersion === "string" && typeof f.error === "string") {
        ;(out.failures ??= {})[id] = { at: f.at, appVersion: f.appVersion, error: f.error }
      }
    }
    return out
  } catch {
    log("warn", "alpha-surfaces: state file unreadable/corrupt — treating as empty")
    return {}
  }
}

/** 纯解析(可测:env / 文件内容 / app 版本全部注入)。每 surface:env > pin > 发布默认 定态;
 *  "auto-fallback" 再查崩溃记录 —— 仅当记录的 appVersion 等于当前版本才降级(旧版本记录陈旧忽略)。 */
export function resolveSurfaces(opts: {
  env: Record<string, string | undefined>
  file: SurfaceFile
  appVersion: string
}): ResolvedSurfaces {
  const resolve = (id: SurfaceId): ResolvedSurface => {
    const envValue = opts.env[ENV_KEYS[id]]
    let state: SurfaceReleaseState
    let reason: ResolvedSurface["reason"]
    if (isReleaseState(envValue)) {
      state = envValue
      reason = "env-override"
    } else if (opts.file.pins && isReleaseState(opts.file.pins[id])) {
      state = opts.file.pins[id] as SurfaceReleaseState
      reason = "pin"
    } else {
      state = SURFACE_RELEASE_STATES[id]
      reason = "release-default"
    }
    if (state === "legacy") return { mode: "legacy", reason }
    if (state === "alpha") return { mode: "alpha", reason }
    // auto-fallback:本版本记录过致命渲染错误 → legacy;否则照常上 alpha。
    const failure = opts.file.failures?.[id]
    if (failure && failure.appVersion === opts.appVersion) return { mode: "legacy", reason: "crash-fallback" }
    return { mode: "alpha", reason }
  }
  return { home: resolve("home"), newSession: resolve("newSession"), session: resolve("session") }
}

/** 记录一次 Alpha surface 的致命渲染错误(auto-fallback 态下次加载据此降 legacy)。
 *  未知 surface id 直接拒绝(throw → IPC promise reject);错误文本先剥路径再截 500。 */
export function recordSurfaceFailure(
  userDataPath: string,
  appVersion: string,
  payload: { surface: SurfaceId; error: string },
): void {
  if (!payload || !isSurfaceId(payload.surface)) throw new Error("alpha-surfaces: unknown surface id")
  const error = String(payload.error ?? "")
    .replace(PATH_LIKE, "")
    .slice(0, MAX_ERROR_CHARS)
  const current = readSurfaceFile(userDataPath)
  const next: SurfaceFile = {
    ...current,
    failures: { ...current.failures, [payload.surface]: { at: new Date().toISOString(), appVersion, error } },
  }
  try {
    fs.mkdirSync(userDataPath, { recursive: true })
    fs.writeFileSync(surfaceFilePath(userDataPath), JSON.stringify(next), { encoding: "utf8", mode: 0o600 })
  } catch {
    // 落盘失败只损失一次 fallback 机会,不阻塞 renderer 的错误路径。
    log("warn", "alpha-surfaces: failed to persist surface failure record")
  }
}

/** 注册 surface IPC(index.ts 与其他 register*IpcHandlers 同点调用)。resolve 每次 invoke 现读
 *  文件 —— renderer 每次加载恰好取一次,天然满足「改动 reload 才生效」。 */
export function registerSurfaceIpc(userDataPath: string) {
  ipcMain.handle("alpha-surfaces-resolve", () => {
    const resolved = resolveSurfaces({ env: process.env, file: readSurfaceFile(userDataPath), appVersion: app.getVersion() })
    for (const id of SURFACE_IDS) {
      const r = resolved[id]
      // 非默认命中留痕(排障:为什么这台机器是 legacy);只记 surface/模式/原因,绝不记文件路径。
      if (r.reason !== "release-default") log("info", `alpha-surfaces: ${id} → ${r.mode} (${r.reason})`)
    }
    return resolved
  })
  ipcMain.handle("alpha-surface-failure", (_event, payload: { surface: SurfaceId; error: string }) => {
    recordSurfaceFailure(userDataPath, app.getVersion(), payload)
  })
}
