// db-safety-boot —— DB 安全带的 electron 接线层(S17 T3;逻辑核在 db-safety.ts,本层只做 IO 组装)。
// 预检对话框在主窗口创建前弹出(无 parent,app-modal);菜单动作供 menu.ts「数据」子菜单调用。
// 文案中文硬编码:main 无 i18n 设施(ADR-022 先例,随后续 main-i18n 统一)。

import { spawn } from "node:child_process"
import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync } from "node:fs"
import { homedir } from "node:os"
import { join } from "node:path"
import { app, dialog, Notification, shell, type BrowserWindow } from "electron"

import { getLogger } from "./logging"
import * as DbSafety from "./db-safety"

// spawn + 固定绝对路径 + 参数数组(无 shell)—— 无注入面;SQL 内路径由 db-safety.sqlQuote 转义
const exec: DbSafety.Exec = (args) =>
  new Promise((resolve) => {
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
export async function runDbPreflightBoot(opts: { userDataPath: string }): Promise<{ proceed: boolean }> {
  const log = getLogger()
  if (!existsSync(DbSafety.SQLITE3)) {
    log?.warn("db-safety: /usr/bin/sqlite3 missing — fail-open skip")
    return { proceed: true }
  }
  const target = resolveTarget()
  if (!target.path) {
    log?.log(`db-safety: skip — ${target.reason}`)
    return { proceed: true }
  }
  const read = await DbSafety.readDbMigrationIds(target.path, exec, existsSync)
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
        dbPath: target.path,
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
      const { response } = await dialog.showMessageBox({
        type: "warning",
        title: "迁移前备份失败",
        message: "本次启动将升级会话数据库,但迁移前备份失败了。",
        detail: `继续升级后将没有可回退的快照。\n\n${res.error}`,
        buttons: ["仍要继续", "退出"],
        defaultId: 0,
        cancelId: 0,
      })
      return { proceed: response !== 1 }
    }

    case "db-ahead": {
      // C17①:旧 app × 新 DB —— 不静默继续,继续权显式交用户
      log?.error(`db-safety: DB AHEAD of app — ${plan.unknown.length} unknown migrations (latest ${plan.latest})`)
      const { response } = await dialog.showMessageBox({
        type: "warning",
        title: "会话数据库版本过新",
        message: "此会话数据库由更新版本的 alpha-code 创建。",
        detail: `检测到 ${plan.unknown.length} 个本版本不认识的迁移(最新:${plan.latest})。\n继续运行可能损坏数据,建议升级 alpha-code 后再打开。`,
        buttons: ["退出(推荐)", "备份后继续", "直接继续"],
        defaultId: 0,
        cancelId: 0,
      })
      if (response === 0) return { proceed: false }
      if (response === 1) {
        const res = await DbSafety.createVerifiedBackup({
          dbPath: target.path,
          backupDir,
          exec,
          fs: fsDeps,
          now: new Date(),
        })
        if (res.ok) {
          log?.log(`db-safety: backup before risky continue → ${res.path}`)
        } else {
          const second = await dialog.showMessageBox({
            type: "error",
            title: "备份失败",
            message: "备份失败,未能创建快照。",
            detail: res.error,
            buttons: ["退出", "仍要继续"],
            defaultId: 0,
            cancelId: 0,
          })
          if (second.response === 0) return { proceed: false }
        }
      }
      log?.warn("db-safety: user chose to continue with DB ahead of app — data risk accepted")
      return { proceed: true }
    }

    case "corrupt": {
      // B14③:损坏 → 指向最近备份的恢复路径,而非裸「服务启动失败」
      log?.error(`db-safety: database corrupt — ${plan.detail}`)
      fsDeps.mkdir(backupDir)
      const newest = DbSafety.newestBackup(fsDeps.readdir(backupDir))
      const buttons = newest ? ["从最近备份恢复", "退出", "仍要启动"] : ["退出", "仍要启动"]
      const { response } = await dialog.showMessageBox({
        type: "error",
        title: "会话数据库已损坏",
        message: "会话数据库无法读取(file is not a database)。",
        detail: newest
          ? `可从最近的备份恢复:${newest}\n损坏文件将改名保留,不会被删除。`
          : `没有可用备份(${backupDir} 为空)。\n可退出后手工处理,或仍要启动(引擎可能启动失败)。`,
        buttons,
        defaultId: 0,
        cancelId: newest ? 1 : 0,
      })
      if (newest && response === 0) {
        const restored = DbSafety.restoreFromBackup({
          dbPath: target.path,
          backupPath: join(backupDir, newest),
          fs: fsDeps,
          now: new Date(),
        })
        if (restored.ok) {
          log?.log(`db-safety: restored from ${newest}; damaged kept as ${restored.damagedPath}`)
          await dialog.showMessageBox({
            type: "info",
            title: "已恢复",
            message: `已从备份恢复:${newest}`,
            detail: `损坏文件保留为:\n${restored.damagedPath}`,
            buttons: ["继续启动"],
          })
          return { proceed: true }
        }
        await dialog.showMessageBox({
          type: "error",
          title: "恢复失败",
          message: "从备份恢复失败。",
          detail: restored.error,
          buttons: ["退出"],
        })
        return { proceed: false }
      }
      const continueAnyway = (newest && response === 2) || (!newest && response === 1)
      if (continueAnyway) {
        log?.warn("db-safety: starting with corrupt DB by user choice")
        return { proceed: true }
      }
      return { proceed: false }
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
  // dev 置灰:分支后缀库 + channel 为构建期常量,备错目标风险 > 收益(设计决策 1/6)
  const enabled = app.isPackaged && existsSync(DbSafety.SQLITE3)

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
