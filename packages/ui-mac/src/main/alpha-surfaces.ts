// Surface 失败诊断(main process)。REQ-089 硬切之后**没有 surface 解析器**:每个路由恒组合
// 它唯一的 Alpha 叶,不存在 legacy 发布态、`ALPHA_SURFACE_*` env 覆盖、userData pin,也不存在
// 崩溃回退 —— 致命渲染错误进 Alpha Recovery(AC4),绝不改变 composition。
// 本模块只剩一件事:把一次 Alpha surface 的致命渲染错误落成脱敏诊断记录。
// 失败上报(alpha-surface-failure)落盘 <userData>/alpha-surfaces.json:原子写(同目录 tmp +
// fsync + rename,ext-atomic-fs 原语)且 fail-closed；写入失败由 Recovery adapter 映射为可重试的
// 安全动作。Renderer 不上传原始错误文本；诊断记录只落稳定码，路径/secret 不进入 IPC 或状态文件。
// 文件损坏/不可读 → 按空处理(留一行日志)。

import { app, ipcMain } from "electron"
import { existsSync, readFileSync } from "node:fs"
import { join } from "node:path"
import { writeFileAtomicSync } from "./ext-atomic-fs"
import { type SurfaceId } from "../shared/alpha-surfaces"
import { getLogger } from "./logging"
import { RECOVERY_CODES } from "../shared/recovery"
import type { RecoveryService, SurfaceRecoveryRequest } from "./recovery-service"

const SURFACE_IDS = ["home", "newSession", "session"] as const
const FILE = "alpha-surfaces.json"
export type SurfaceFailure = { at: string; appVersion: string; error: string }
export type SurfaceFile = {
  failures?: Partial<Record<SurfaceId, SurfaceFailure>>
}

const isSurfaceId = (v: unknown): v is SurfaceId =>
  typeof v === "string" && (SURFACE_IDS as readonly string[]).includes(v)

const surfaceFilePath = (userDataPath: string) => join(userDataPath, FILE)

// getLogger() 在单测(未 initLogging)下为 undefined —— 静默跳过,日志非契约。
const log = (level: "info" | "warn", message: string) => getLogger()?.[level](message)

/** 读 <userData>/alpha-surfaces.json 并逐项形状校验(残缺 failure 条目丢弃;任何遗留的发布态
 *  pin 字段一律忽略 —— 它不再有语义)。
 *  文件缺失 → 空;存在但损坏/不可读 → 空 + 一行日志(不含路径)。 */
export function readSurfaceFile(userDataPath: string): SurfaceFile {
  const file = surfaceFilePath(userDataPath)
  if (!existsSync(file)) return {}
  try {
    const raw = JSON.parse(readFileSync(file, "utf8")) as Record<string, unknown>
    const out: SurfaceFile = {}
    const failures = raw.failures as Record<string, unknown> | undefined
    for (const id of SURFACE_IDS) {
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

/** 注册 surface IPC(index.ts 与其他 register*IpcHandlers 同点调用)。 */
export function registerSurfaceIpc(userDataPath: string, recovery: RecoveryService) {
  ipcMain.handle("alpha-surface-failure", (event, payload: SurfaceRecoveryRequest) =>
    recovery.startSurface(payload, event.sender.id, (failure) =>
      recordSurfaceFailure(userDataPath, app.getVersion(), failure),
    ),
  )
}
