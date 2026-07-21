// REQ-084:surface RESOLVER(main process)。renderer 挂载路由树之前,main 按
//
//   env override  >  userData pin 文件  >  发布默认(shared/alpha-surfaces.ts)
//   ALPHA_SURFACE_*    <userData>/alpha-surfaces.json
//
// 逐 surface 解析出生效模式。REQ-090 裁决 C 后，崩溃记录只作脱敏诊断事实，绝不改变 composition
// 或把 Alpha surface 降到 legacy。解析只在加载时进行，运行中不热切换。
// 失败上报(alpha-surface-failure)落盘同一 JSON:原子写(同目录 tmp + fsync + rename,
// ext-atomic-fs 原语)且 fail-closed；写入失败由 Recovery adapter 映射为可重试的安全动作。
// Renderer 不上传原始错误文本；诊断记录只落稳定码，路径/secret 不进入 IPC 或状态文件。
// 文件损坏/不可读 → 按空处理(留一行日志)。

import { app, ipcMain } from "electron"
import { existsSync, readFileSync } from "node:fs"
import { join } from "node:path"
import { writeFileAtomicSync } from "./ext-atomic-fs"
import {
  SURFACE_RELEASE_STATES,
  type ResolvedSurface,
  type ResolvedSurfaces,
  type SurfaceId,
  type SurfaceReleaseState,
} from "../shared/alpha-surfaces"
import { getLogger } from "./logging"
import { RECOVERY_CODES } from "../shared/recovery"
import type { RecoveryService, SurfaceRecoveryRequest } from "./recovery-service"

const SURFACE_IDS = ["home", "newSession", "session"] as const
const RELEASE_STATES: readonly SurfaceReleaseState[] = ["alpha", "legacy"]
const ENV_KEYS: Record<SurfaceId, string> = {
  home: "ALPHA_SURFACE_HOME",
  newSession: "ALPHA_SURFACE_NEW_SESSION",
  session: "ALPHA_SURFACE_SESSION",
}
const FILE = "alpha-surfaces.json"
export type SurfaceFailure = { at: string; appVersion: string; error: string }
export type SurfaceFile = {
  pins?: Partial<Record<SurfaceId, SurfaceReleaseState>>
  failures?: Partial<Record<SurfaceId, SurfaceFailure>>
}

const isSurfaceId = (v: unknown): v is SurfaceId =>
  typeof v === "string" && (SURFACE_IDS as readonly string[]).includes(v)
const isReleaseState = (v: unknown): v is SurfaceReleaseState =>
  typeof v === "string" && (RELEASE_STATES as readonly string[]).includes(v)

const surfaceFilePath = (userDataPath: string) => join(userDataPath, FILE)

// getLogger() 在单测(未 initLogging)下为 undefined —— 静默跳过,日志非契约。
const log = (level: "info" | "warn", message: string) => getLogger()?.[level](message)

/** 读 <userData>/alpha-surfaces.json 并逐项形状校验(非法 pin 值/残缺 failure 条目丢弃)。
 *  文件缺失 → 空;存在但损坏/不可读 → 空 + 一行日志(不含路径)。 */
export function readSurfaceFile(userDataPath: string): SurfaceFile {
  const file = surfaceFilePath(userDataPath)
  if (!existsSync(file)) return {}
  try {
    const raw = JSON.parse(readFileSync(file, "utf8")) as Record<string, unknown>
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

/** 纯解析(可测:env / 文件内容 / app 版本全部注入)。每 surface:env > pin > 发布默认定态。
 *  file 中的 failure 记录不参与 composition；Alpha 崩溃必须留在 Alpha Recovery surface。 */
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
    return { mode: "alpha", reason }
  }
  return { home: resolve("home"), newSession: resolve("newSession"), session: resolve("session") }
}

/** 记录一次 Alpha surface 的致命渲染错误(仅作脱敏诊断，不参与 composition)。
 *  未知 surface id 直接拒绝(throw → IPC promise reject)；只落稳定码，不接收 renderer 错误文本。
 *  #334 r1:写入走 writeFileAtomicSync(同目录 tmp + fsync + rename——覆盖中断不会留半截文件)
 *  且 fail-closed:落盘失败同样 throw(重抛干净错误,不带文件路径)，由 Recovery 呈现保存失败动作。 */
export function recordSurfaceFailure(userDataPath: string, appVersion: string, payload: { surface: SurfaceId }): void {
  if (!payload || !isSurfaceId(payload.surface)) throw new Error("alpha-surfaces: unknown surface id")
  const current = readSurfaceFile(userDataPath)
  const next: SurfaceFile = {
    ...current,
    failures: {
      ...current.failures,
      [payload.surface]: { at: new Date().toISOString(), appVersion, error: RECOVERY_CODES.surfaceCrashed },
    },
  }
  try {
    writeFileAtomicSync(surfaceFilePath(userDataPath), JSON.stringify(next), { mode: 0o600 })
  } catch {
    log("warn", "alpha-surfaces: failed to persist surface failure record")
    throw new Error("alpha-surfaces: failed to persist surface failure record")
  }
}

/** 注册 surface IPC(index.ts 与其他 register*IpcHandlers 同点调用)。resolve 每次 invoke 现读
 *  文件 —— renderer 每次加载恰好取一次,天然满足「改动 reload 才生效」。 */
export function registerSurfaceIpc(userDataPath: string, recovery: RecoveryService) {
  ipcMain.handle("alpha-surfaces-resolve", () => {
    const resolved = resolveSurfaces({
      env: process.env,
      file: readSurfaceFile(userDataPath),
      appVersion: app.getVersion(),
    })
    for (const id of SURFACE_IDS) {
      const r = resolved[id]
      // 非默认命中留痕(排障:为什么这台机器是 legacy);只记 surface/模式/原因,绝不记文件路径。
      if (r.reason !== "release-default") log("info", `alpha-surfaces: ${id} → ${r.mode} (${r.reason})`)
    }
    return resolved
  })
  ipcMain.handle("alpha-surface-failure", (event, payload: SurfaceRecoveryRequest) =>
    recovery.startSurface(payload, event.sender.id, (failure) =>
      recordSurfaceFailure(userDataPath, app.getVersion(), failure),
    ),
  )
}
