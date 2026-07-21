// db-safety-boot —— DB 安全带的 electron 接线层(S17 T3;逻辑核在 db-safety.ts,本层只做 IO 组装)。
// 启动预检经 renderer-safe Recovery host 在产品窗口创建前呈现；菜单动作仍供 menu.ts「数据」
// 子菜单调用，不属于启动恢复面。

import { spawn } from "node:child_process"
import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync } from "node:fs"
import { homedir } from "node:os"
import { join } from "node:path"
import { app, dialog, Notification, shell, type BrowserWindow } from "electron"

import { RECOVERY_ACTIONS, type RecoveryAction, type RecoveryIncidentWire } from "../shared/recovery"
import { getLogger } from "./logging"
import * as DbSafety from "./db-safety"
import type { RecoveryService } from "./recovery-service"

// spawn + 固定绝对路径 + 参数数组(无 shell)—— 无注入面;SQL 内路径由 db-safety.sqlQuote 转义
const exec: DbSafety.Exec = (args) =>
  new Promise((resolve) => {
    if (!DbSafety.SQLITE3) {
      // win32:sqlite 二进制不可用(REQ-076 T3 前),所有调用点已被 preflight/enabled 闸住,此为兜底
      resolve({ code: 127, stdout: "", stderr: "sqlite3 unavailable on this platform" })
      return
    }
    const child = spawn(DbSafety.SQLITE3, args, { stdio: ["ignore", "pipe", "pipe"] })
    let stdout = ""
    let stderr = ""
    child.stdout.on("data", (chunk) => (stdout += chunk))
    child.stderr.on("data", (chunk) => (stderr += chunk))
    child.on("error", (error) => resolve({ code: -1, stdout, stderr: String(error) }))
    child.on("close", (code) => resolve({ code: code ?? -1, stdout, stderr }))
  })

const fsDeps: DbSafety.FsDeps = {
  exists: existsSync,
  mkdir: (p) => mkdirSync(p, { recursive: true }),
  readdir: (p) => readdirSync(p),
  rename: renameSync,
  copy: copyFileSync,
  remove: (p) => rmSync(p, { force: true }),
  readText: (p) => readFileSync(p, "utf8"),
}

function backupDirOf(userDataPath: string) {
  return join(userDataPath, "alpha-db-backups")
}

function resolveTarget() {
  return DbSafety.resolveDbPath({ packaged: app.isPackaged, env: process.env, home: homedir() })
}

// ── 启动预检(index.ts 初次 spawn sidecar 前调用;respawn 不重跑)────────────
export async function runDbPreflightBoot(opts: {
  userDataPath: string
  recovery: RecoveryService
  presentRecovery: (incident: RecoveryIncidentWire) => Promise<RecoveryAction>
}): Promise<{ proceed: boolean }> {
  const log = getLogger()
  if (!DbSafety.SQLITE3 || !existsSync(DbSafety.SQLITE3)) {
    // fail-open 但必须 loud(审计适配级):win32 = 平台策略性不可用(非异常);posix 缺文件 = 异常态
    log?.warn(
      DbSafety.SQLITE3
        ? "db-safety: /usr/bin/sqlite3 missing — fail-open skip"
        : "db-safety: Windows 暂无可信 sqlite3(REQ-076 T3 捆绑方案待拍板)—— DB 安全带 fail-open 跳过,备份/水位拦截不可用",
    )
    return { proceed: true }
  }
  const target = resolveTarget()
  if (!target.path) {
    log?.log(`db-safety: skip — ${target.reason}`)
    return { proceed: true }
  }
  const dbPath = target.path
  const read = await DbSafety.readDbMigrationIds(dbPath, exec, existsSync)
  const expected = DbSafety.loadExpectedIds({
    resourcesPath: process.resourcesPath,
    exists: existsSync,
    readText: fsDeps.readText,
  })
  const plan = DbSafety.decidePlan(read, expected)
  const backupDir = backupDirOf(opts.userDataPath)

  switch (plan.kind) {
    case "skip":
      log?.log(`db-safety: skip — ${plan.reason}`)
      return { proceed: true }

    case "proceed":
      log?.log("db-safety: watermark equal — proceed")
      return { proceed: true }

    case "migrate-ahead": {
      // 引擎本次启动将前进迁移 → 最高价值备份时点(降级逃生快照,B14① 自动触发)
      log?.log(`db-safety: engine will migrate forward (${plan.pending.length} pending) — pre-migration backup`)
      const res = await DbSafety.createVerifiedBackup({
        dbPath,
        backupDir,
        exec,
        fs: fsDeps,
        now: new Date(),
      })
      if (res.ok) {
        log?.log(`db-safety: pre-migration backup ok → ${res.path}`)
        return { proceed: true }
      }
      log?.error(`db-safety: pre-migration backup FAILED — ${res.error}`)
      // #434 does not define a truthful action for pre-migration backup failure. Without a safe
      // renderer contract, fail closed instead of reopening the removed native prompt.
      return { proceed: false }
    }

    case "db-ahead": {
      // C17①:旧 app × 新 DB —— 不静默继续,继续权显式交用户
      log?.error(`db-safety: DB AHEAD of app — ${plan.unknown.length} unknown migrations (latest ${plan.latest})`)
      const incident = opts.recovery.register({
        source: { kind: "database", plan, backupAvailable: false },
        senderID: 0,
        effects: {
          [RECOVERY_ACTIONS.exitApp]: () => ({ applied: true }),
          [RECOVERY_ACTIONS.continueStartup]: () => ({ applied: true }),
          [RECOVERY_ACTIONS.backupAndContinue]: async () => {
            const result = await DbSafety.createVerifiedBackup({
              dbPath,
              backupDir,
              exec,
              fs: fsDeps,
              now: new Date(),
            })
            if (!result.ok) {
              log?.error(`db-safety: backup before risky continue FAILED — ${result.error}`)
              return { applied: false, retryable: false }
            }
            log?.log(`db-safety: backup before risky continue → ${result.path}`)
            return { applied: true }
          },
        },
      })
      if (!incident) return { proceed: false }
      const action = await opts.presentRecovery(incident)
      if (action === RECOVERY_ACTIONS.exitApp) return { proceed: false }
      log?.warn("db-safety: user chose to continue with DB ahead of app — data risk accepted")
      return { proceed: true }
    }

    case "corrupt": {
      // B14③:损坏 → 指向最近备份的恢复路径,而非裸「服务启动失败」
      log?.error(`db-safety: database corrupt — ${plan.detail}`)
      fsDeps.mkdir(backupDir)
      const newest = DbSafety.newestBackup(fsDeps.readdir(backupDir))
      const incident = opts.recovery.register({
        source: { kind: "database", plan, backupAvailable: !!newest },
        senderID: 0,
        effects: {
          [RECOVERY_ACTIONS.exitApp]: () => ({ applied: true }),
          [RECOVERY_ACTIONS.continueStartup]: () => ({ applied: true }),
          ...(newest
            ? {
                [RECOVERY_ACTIONS.restoreLatestBackup]: () => {
                  const restored = DbSafety.restoreFromBackup({
                    dbPath,
                    backupPath: join(backupDir, newest),
                    fs: fsDeps,
                    now: new Date(),
                  })
                  if (!restored.ok) {
                    log?.error(`db-safety: restore from backup FAILED — ${restored.error}`)
                    return { applied: false as const, retryable: false }
                  }
                  log?.log(`db-safety: restored from ${newest}; damaged kept as ${restored.damagedPath}`)
                  return { applied: true as const }
                },
              }
            : {}),
        },
      })
      if (!incident) return { proceed: false }
      const action = await opts.presentRecovery(incident)
      if (action === RECOVERY_ACTIONS.exitApp) return { proceed: false }
      if (action === RECOVERY_ACTIONS.continueStartup) log?.warn("db-safety: starting with corrupt DB by user choice")
      return { proceed: true }
    }
  }
}

// ── 菜单动作(menu.ts「数据」子菜单;B14①② 手动备份/导出入口)────────────────
export type DbMenuActions = {
  enabled: boolean
  backupNow(): void
  exportDb(): void
  openBackups(): void
}

export function createDbMenuActions(opts: {
  userDataPath: string
  getWindow: () => BrowserWindow | null
}): DbMenuActions {
  const backupDir = backupDirOf(opts.userDataPath)
  // dev 置灰:分支后缀库 + channel 为构建期常量,备错目标风险 > 收益(设计决策 1/6);
  // win32 置灰:sqlite 不可用(SQLITE3 = null,REQ-076 T3 前诚实禁用而非假可用)
  const enabled = app.isPackaged && !!DbSafety.SQLITE3 && existsSync(DbSafety.SQLITE3)

  const noDbDialog = async (reason: string) => {
    await dialog.showMessageBox({
      type: "info",
      title: "未找到会话数据库",
      message: "当前没有可操作的会话数据库。",
      detail: reason,
      buttons: ["好"],
    })
  }

  return {
    enabled,
    backupNow: () => {
      void (async () => {
        const target = resolveTarget()
        if (!target.path || !existsSync(target.path)) return noDbDialog(target.reason)
        const res = await DbSafety.createVerifiedBackup({
          dbPath: target.path,
          backupDir,
          exec,
          fs: fsDeps,
          now: new Date(),
        })
        if (res.ok) {
          getLogger()?.log(`db-safety: manual backup → ${res.path}`)
          try {
            new Notification({ title: "备份完成", body: res.path }).show()
          } catch {
            // 通知失败不影响备份结果
          }
        } else {
          getLogger()?.error(`db-safety: manual backup failed — ${res.error}`)
          await dialog.showMessageBox({
            type: "error",
            title: "备份失败",
            message: "备份失败(验证机制拒绝了不完整快照)。",
            detail: res.error,
            buttons: ["好"],
          })
        }
      })()
    },
    exportDb: () => {
      void (async () => {
        const target = resolveTarget()
        if (!target.path || !existsSync(target.path)) return noDbDialog(target.reason)
        const win = opts.getWindow()
        const saveOptions = {
          title: "导出会话数据库",
          defaultPath: join(app.getPath("downloads"), `opencode-export-${DbSafety.timestamp(new Date())}.db`),
        }
        const picked = win ? await dialog.showSaveDialog(win, saveOptions) : await dialog.showSaveDialog(saveOptions)
        if (picked.canceled || !picked.filePath) return
        const res = await DbSafety.exportVerifiedCopy({
          dbPath: target.path,
          targetPath: picked.filePath,
          exec,
          fs: fsDeps,
        })
        if (res.ok) {
          getLogger()?.log(`db-safety: exported → ${res.path}`)
          shell.showItemInFolder(res.path)
        } else {
          getLogger()?.error(`db-safety: export failed — ${res.error}`)
          await dialog.showMessageBox({
            type: "error",
            title: "导出失败",
            message: "导出失败(验证机制拒绝了不完整快照)。",
            detail: res.error,
            buttons: ["好"],
          })
        }
      })()
    },
    openBackups: () => {
      fsDeps.mkdir(backupDir)
      void shell.openPath(backupDir)
    },
  }
}
