// db-safety —— DB 安全带逻辑核(C17 版本预检 + B14 备份/恢复/导出;S17 T3)。
// 设计与实证:docs/designs/2026-07-05-db-safety-belt.md(F1–F7)。
// 本文件 electron-free、依赖全注入(exec/fs/now)以便单测;对话框/菜单接线在 db-safety-boot.ts。
//
// 契约锚(上游只读,规则镜像,变更时 fail-open 不伤启动):
//   - 路径规则 ⇔ packages/core/src/database/database.ts:path()(prod/beta 无后缀 opencode.db;
//     OPENCODE_DB env 覆盖;data = $XDG_DATA_HOME || ~/.local/share + /opencode)
//   - 水位表  ⇔ packages/core/src/database/migration.ts(migration(id TEXT PRIMARY KEY);
//     applyOnly 不检查未知 id —— 本守卫存在的原因)

import { join } from "node:path"
import { sqliteBinary } from "./platform"

export const BACKUP_KEEP = 5
export const BACKUP_PREFIX = "opencode-backup-"
// 固定绝对路径,不走 PATH(防劫持):macOS 恒有(SIP 域)= /usr/bin/sqlite3;win32 无系统自带
// 可信固定路径 → null,安全带诚实不可用(fail-open + loud;REQ-076 T3 拍板捆绑方案后补齐)。
// 平台策略单点在 seam(platform/index.sqliteBinary,ADR-026)。
export const SQLITE3 = sqliteBinary()

export type ExecResult = { code: number; stdout: string; stderr: string }
export type Exec = (args: string[]) => Promise<ExecResult>

export type FsDeps = {
  exists(p: string): boolean
  mkdir(p: string): void
  readdir(p: string): string[]
  rename(from: string, to: string): void
  copy(from: string, to: string): void
  remove(p: string): void
  readText(p: string): string
}

// ── 路径镜像(F4)────────────────────────────────────────────────────────────
export function resolveDbPath(opts: {
  packaged: boolean
  env: Record<string, string | undefined>
  home: string
}): { path: string | null; reason: string } {
  // 守卫范围 = 打包态 only:dev 跑分支后缀库且 channel 是构建期常量,守错目标风险 > 收益(设计决策 1)
  if (!opts.packaged) return { path: null, reason: "dev(非打包态,分支后缀库,守卫不适用)" }
  const dataDir = join(opts.env.XDG_DATA_HOME || join(opts.home, ".local", "share"), "opencode")
  const override = opts.env.OPENCODE_DB
  if (override) {
    if (override === ":memory:") return { path: null, reason: "OPENCODE_DB=:memory:(测试态)" }
    if (override.startsWith("/")) return { path: override, reason: "OPENCODE_DB 绝对路径覆盖" }
    return { path: join(dataDir, override), reason: "OPENCODE_DB 相对路径覆盖" }
  }
  return { path: join(dataDir, "opencode.db"), reason: "packaged 默认(prod/beta 无后缀)" }
}

// ── 水位读取(F1/F6)──────────────────────────────────────────────────────────
export type WatermarkRead =
  | { ok: true; ids: string[]; legacy: boolean }
  | { ok: false; kind: "missing" | "corrupt" | "error"; detail: string }

export async function readDbMigrationIds(
  dbPath: string,
  exec: Exec,
  exists: (p: string) => boolean,
): Promise<WatermarkRead> {
  if (!exists(dbPath)) return { ok: false, kind: "missing", detail: "db file not found" }
  const res = await exec(["-readonly", dbPath, "SELECT id FROM migration ORDER BY id;"])
  if (res.code === 0) {
    const ids = res.stdout
      .split("\n")
      .map((s) => s.trim())
      .filter(Boolean)
    return { ok: true, ids, legacy: false }
  }
  const err = (res.stderr || res.stdout).trim()
  // 实证签名:损坏 = exit 26 + "file is not a database"(F6)
  if (res.code === 26 || /file is not a database/i.test(err)) return { ok: false, kind: "corrupt", detail: err }
  // 纯旧库(__drizzle_migrations 时代,applyOnly 播种前)没有 migration 表 → 视作全量 pending(F3)
  if (/no such table: migration/i.test(err)) return { ok: true, ids: [], legacy: true }
  return { ok: false, kind: "error", detail: `exit=${res.code} ${err}` }
}

// ── 判定(F2/F3)──────────────────────────────────────────────────────────────
export function diffWatermarks(appIds: string[], dbIds: string[]) {
  const app = new Set(appIds)
  const db = new Set(dbIds)
  return {
    pending: appIds.filter((id) => !db.has(id)), // 引擎本次启动将前进 → pre-migration 备份时点
    unknown: dbIds.filter((id) => !app.has(id)), // DB 超前于 app → 阻断对话框
  }
}

export type PreflightPlan =
  | { kind: "skip"; reason: string }
  | { kind: "proceed" }
  | { kind: "migrate-ahead"; pending: string[] }
  | { kind: "db-ahead"; unknown: string[]; latest: string }
  | { kind: "corrupt"; detail: string }

export function decidePlan(read: WatermarkRead, appIds: string[] | null): PreflightPlan {
  if (!read.ok) {
    if (read.kind === "missing") return { kind: "skip", reason: "fresh install(无 DB 文件)" }
    if (read.kind === "corrupt") return { kind: "corrupt", detail: read.detail }
    return { kind: "skip", reason: `水位读取失败,fail-open:${read.detail}` }
  }
  if (!appIds || appIds.length === 0) return { kind: "skip", reason: "app 支持面清单缺失,fail-open" }
  const { pending, unknown } = diffWatermarks(appIds, read.ids)
  if (unknown.length > 0) return { kind: "db-ahead", unknown, latest: unknown[unknown.length - 1]! }
  if (pending.length > 0) return { kind: "migrate-ahead", pending }
  return { kind: "proceed" }
}

// ── 支持面清单(设计决策 2:构建期生成 JSON,经 extraResources 进包)───────────
export function loadExpectedIds(opts: {
  resourcesPath: string
  exists: (p: string) => boolean
  readText: (p: string) => string
}): string[] | null {
  try {
    const p = join(opts.resourcesPath, "db-expected-migrations.json")
    if (!opts.exists(p)) return null
    const parsed = JSON.parse(opts.readText(p)) as { v?: number; ids?: unknown[] }
    if (parsed?.v !== 1 || !Array.isArray(parsed.ids)) return null
    const ids = parsed.ids.filter((x): x is string => typeof x === "string")
    return ids.length > 0 ? ids : null
  } catch {
    return null
  }
}

// ── 备份(F7:唯一可靠形态 = readonly 会话 VACUUM INTO + 必验,验不过即删)────
export function timestamp(d: Date): string {
  const p = (n: number) => String(n).padStart(2, "0")
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`
}

export function backupFileName(now: Date): string {
  return `${BACKUP_PREFIX}${timestamp(now)}.db`
}

export function listBackups(files: string[]): string[] {
  return files.filter((f) => f.startsWith(BACKUP_PREFIX) && f.endsWith(".db")).sort()
}

export function rotationVictims(backups: string[], keep = BACKUP_KEEP): string[] {
  const sorted = [...backups].sort()
  if (sorted.length <= keep) return []
  return sorted.slice(0, sorted.length - keep)
}

export function newestBackup(backups: string[]): string | null {
  const sorted = listBackups(backups)
  return sorted.length > 0 ? sorted[sorted.length - 1]! : null
}

function sqlQuote(path: string): string {
  return `'${path.replaceAll("'", "''")}'`
}

async function vacuumAndVerify(opts: {
  dbPath: string
  tmpPath: string
  exec: Exec
  fs: FsDeps
}): Promise<{ ok: true } | { ok: false; error: string }> {
  if (opts.fs.exists(opts.tmpPath)) opts.fs.remove(opts.tmpPath)
  const vac = await opts.exec(["-readonly", opts.dbPath, `VACUUM INTO ${sqlQuote(opts.tmpPath)}`])
  if (vac.code !== 0 || !opts.fs.exists(opts.tmpPath)) {
    if (opts.fs.exists(opts.tmpPath)) opts.fs.remove(opts.tmpPath)
    return { ok: false, error: `VACUUM INTO 失败:exit=${vac.code} ${(vac.stderr || vac.stdout).trim()}` }
  }
  // 反 placebo(F7 教训):快照必须可读且完整,否则删除 —— 绝不留「看似存在」的坏备份
  const verify = await opts.exec(["-readonly", opts.tmpPath, "PRAGMA integrity_check; SELECT COUNT(*) FROM migration;"])
  const firstLine = verify.stdout
    .split("\n")
    .map((s) => s.trim())
    .filter(Boolean)[0]
  if (verify.code !== 0 || firstLine !== "ok") {
    opts.fs.remove(opts.tmpPath)
    return { ok: false, error: `快照验证失败(已删除产物):exit=${verify.code} ${(verify.stderr || verify.stdout).trim()}` }
  }
  return { ok: true }
}

export async function createVerifiedBackup(opts: {
  dbPath: string
  backupDir: string
  exec: Exec
  fs: FsDeps
  now: Date
  keep?: number
}): Promise<{ ok: true; path: string; rotated: string[] } | { ok: false; error: string }> {
  try {
    opts.fs.mkdir(opts.backupDir)
    const finalPath = join(opts.backupDir, backupFileName(opts.now))
    const tmpPath = `${finalPath}.tmp`
    const result = await vacuumAndVerify({ dbPath: opts.dbPath, tmpPath, exec: opts.exec, fs: opts.fs })
    if (!result.ok) return result
    opts.fs.rename(tmpPath, finalPath)
    const victims = rotationVictims(listBackups(opts.fs.readdir(opts.backupDir)), opts.keep ?? BACKUP_KEEP)
    for (const victim of victims) opts.fs.remove(join(opts.backupDir, victim))
    return { ok: true, path: finalPath, rotated: victims }
  } catch (error) {
    return { ok: false, error: String(error) }
  }
}

export async function exportVerifiedCopy(opts: {
  dbPath: string
  targetPath: string
  exec: Exec
  fs: FsDeps
}): Promise<{ ok: true; path: string } | { ok: false; error: string }> {
  try {
    const tmpPath = `${opts.targetPath}.tmp`
    const result = await vacuumAndVerify({ dbPath: opts.dbPath, tmpPath, exec: opts.exec, fs: opts.fs })
    if (!result.ok) return result
    if (opts.fs.exists(opts.targetPath)) opts.fs.remove(opts.targetPath) // save dialog 已确认覆盖
    opts.fs.rename(tmpPath, opts.targetPath)
    return { ok: true, path: opts.targetPath }
  } catch (error) {
    return { ok: false, error: String(error) }
  }
}

// ── 恢复(设计决策 4 corrupt 分支)────────────────────────────────────────────
export function restoreFromBackup(opts: {
  dbPath: string
  backupPath: string
  fs: FsDeps
  now: Date
}): { ok: true; damagedPath: string } | { ok: false; error: string } {
  try {
    const damagedPath = `${opts.dbPath}.corrupt-${timestamp(opts.now)}`
    opts.fs.rename(opts.dbPath, damagedPath)
    // WAL 残件必须连带挪走:留下的旧 -wal/-shm 会被 sqlite 回放进恢复件,污染它(F5)
    for (const suffix of ["-wal", "-shm"]) {
      const side = `${opts.dbPath}${suffix}`
      if (opts.fs.exists(side)) opts.fs.rename(side, `${damagedPath}${suffix}`)
    }
    opts.fs.copy(opts.backupPath, opts.dbPath)
    return { ok: true, damagedPath }
  } catch (error) {
    return { ok: false, error: String(error) }
  }
}
