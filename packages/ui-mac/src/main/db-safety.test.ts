// db-safety 单测(S17 T3):纯逻辑(mock exec/fs)+ 真 /usr/bin/sqlite3 集成(skipIf 缺失)。
// 集成层直接验证设计文档 F6/F7 的实证契约(损坏签名 exit 26、VACUUM INTO + 必验、恢复往返)。
import { afterAll, describe, expect, test } from "bun:test"
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import {
  BACKUP_PREFIX,
  backupFileName,
  createVerifiedBackup,
  decidePlan,
  diffWatermarks,
  exportVerifiedCopy,
  listBackups,
  loadExpectedIds,
  newestBackup,
  readDbMigrationIds,
  resolveDbPath,
  restoreFromBackup,
  rotationVictims,
  timestamp,
  type Exec,
  type FsDeps,
} from "./db-safety"

// ── helpers ──────────────────────────────────────────────────────────────────
function memFs(initial: Record<string, string> = {}) {
  const files = new Map<string, string>(Object.entries(initial))
  const dirs = new Set<string>()
  const fs: FsDeps = {
    exists: (p) => files.has(p) || dirs.has(p),
    mkdir: (p) => void dirs.add(p),
    readdir: (p) =>
      [...files.keys()]
        .filter((f) => f.startsWith(`${p}/`))
        .map((f) => f.slice(p.length + 1))
        .filter((n) => !n.includes("/")),
    rename: (from, to) => {
      const v = files.get(from)
      if (v === undefined) throw new Error(`ENOENT ${from}`)
      files.delete(from)
      files.set(to, v)
    },
    copy: (from, to) => {
      const v = files.get(from)
      if (v === undefined) throw new Error(`ENOENT ${from}`)
      files.set(to, v)
    },
    remove: (p) => void files.delete(p),
    readText: (p) => {
      const v = files.get(p)
      if (v === undefined) throw new Error(`ENOENT ${p}`)
      return v
    },
  }
  return { fs, files, dirs }
}

const HOME = "/Users/probe"
const DEFAULT_DB = "/Users/probe/.local/share/opencode/opencode.db"

// ── resolveDbPath(路径镜像,契约锚 database.ts:path())────────────────────────
describe("resolveDbPath", () => {
  test("dev(非打包)→ null(守卫不适用)", () => {
    const r = resolveDbPath({ packaged: false, env: {}, home: HOME })
    expect(r.path).toBeNull()
  })
  test(":memory: 测试态 → null", () => {
    const r = resolveDbPath({ packaged: true, env: { OPENCODE_DB: ":memory:" }, home: HOME })
    expect(r.path).toBeNull()
  })
  test("OPENCODE_DB 绝对路径覆盖", () => {
    const r = resolveDbPath({ packaged: true, env: { OPENCODE_DB: "/tmp/x.db" }, home: HOME })
    expect(r.path).toBe("/tmp/x.db")
  })
  test("OPENCODE_DB 相对路径 → join(dataDir)", () => {
    const r = resolveDbPath({ packaged: true, env: { OPENCODE_DB: "alt.db" }, home: HOME })
    expect(r.path).toBe("/Users/probe/.local/share/opencode/alt.db")
  })
  test("XDG_DATA_HOME 覆盖 data 根", () => {
    const r = resolveDbPath({ packaged: true, env: { XDG_DATA_HOME: "/xdg" }, home: HOME })
    expect(r.path).toBe("/xdg/opencode/opencode.db")
  })
  test("packaged 默认 = ~/.local/share/opencode/opencode.db(F4)", () => {
    const r = resolveDbPath({ packaged: true, env: {}, home: HOME })
    expect(r.path).toBe(DEFAULT_DB)
  })
})

// ── diffWatermarks / decidePlan ───────────────────────────────────────────────
describe("diffWatermarks + decidePlan", () => {
  const A = "20260101000000_a"
  const B = "20260202000000_b"
  const C = "20260303000000_c"

  test("pending only(app 超前 DB)", () => {
    const d = diffWatermarks([A, B, C], [A, B])
    expect(d.pending).toEqual([C])
    expect(d.unknown).toEqual([])
  })
  test("unknown only(DB 超前 app)", () => {
    const d = diffWatermarks([A, B], [A, B, C])
    expect(d.unknown).toEqual([C])
    expect(d.pending).toEqual([])
  })
  test("相等 → proceed", () => {
    expect(decidePlan({ ok: true, ids: [A, B], legacy: false }, [A, B])).toEqual({ kind: "proceed" })
  })
  test("db-ahead:latest = 最末未知 id", () => {
    const plan = decidePlan({ ok: true, ids: [A, B, C], legacy: false }, [A])
    expect(plan.kind).toBe("db-ahead")
    if (plan.kind === "db-ahead") {
      expect(plan.unknown).toEqual([B, C])
      expect(plan.latest).toBe(C)
    }
  })
  test("migrate-ahead:pending 列表齐全", () => {
    const plan = decidePlan({ ok: true, ids: [A], legacy: false }, [A, B, C])
    expect(plan).toEqual({ kind: "migrate-ahead", pending: [B, C] })
  })
  test("legacy(无 migration 表旧库)→ 全量 pending = migrate-ahead", () => {
    const plan = decidePlan({ ok: true, ids: [], legacy: true }, [A, B])
    expect(plan).toEqual({ kind: "migrate-ahead", pending: [A, B] })
  })
  test("missing → skip(fresh install)", () => {
    const plan = decidePlan({ ok: false, kind: "missing", detail: "" }, [A])
    expect(plan.kind).toBe("skip")
  })
  test("corrupt → corrupt", () => {
    const plan = decidePlan({ ok: false, kind: "corrupt", detail: "file is not a database" }, [A])
    expect(plan.kind).toBe("corrupt")
  })
  test("读取 error → skip(fail-open,守卫不伤启动)", () => {
    const plan = decidePlan({ ok: false, kind: "error", detail: "locked" }, [A])
    expect(plan.kind).toBe("skip")
  })
  test("支持面清单缺失 → skip(fail-open)", () => {
    expect(decidePlan({ ok: true, ids: [A], legacy: false }, null).kind).toBe("skip")
    expect(decidePlan({ ok: true, ids: [A], legacy: false }, []).kind).toBe("skip")
  })
})

// ── 命名与轮转 ────────────────────────────────────────────────────────────────
describe("backup naming + rotation", () => {
  test("timestamp/backupFileName 形态(字典序即时序)", () => {
    const d = new Date(2026, 6, 5, 9, 8, 7) // 2026-07-05 09:08:07 local
    expect(timestamp(d)).toBe("20260705-090807")
    expect(backupFileName(d)).toBe(`${BACKUP_PREFIX}20260705-090807.db`)
  })
  test("listBackups 过滤 .tmp/杂物并排序", () => {
    const files = [
      `${BACKUP_PREFIX}20260702-000000.db`,
      "junk.txt",
      `${BACKUP_PREFIX}20260701-000000.db`,
      `${BACKUP_PREFIX}20260703-000000.db.tmp`,
    ]
    expect(listBackups(files)).toEqual([`${BACKUP_PREFIX}20260701-000000.db`, `${BACKUP_PREFIX}20260702-000000.db`])
  })
  test("rotationVictims:≤keep 无牺牲;超出删最旧", () => {
    const five = ["1", "2", "3", "4", "5"].map((n) => `${BACKUP_PREFIX}2026070${n}-000000.db`)
    expect(rotationVictims(five, 5)).toEqual([])
    const seven = ["1", "2", "3", "4", "5", "6", "7"].map((n) => `${BACKUP_PREFIX}2026070${n}-000000.db`)
    expect(rotationVictims(seven, 5)).toEqual([
      `${BACKUP_PREFIX}20260701-000000.db`,
      `${BACKUP_PREFIX}20260702-000000.db`,
    ])
  })
  test("newestBackup:空 → null;有 → 最新", () => {
    expect(newestBackup([])).toBeNull()
    expect(
      newestBackup([`${BACKUP_PREFIX}20260701-000000.db`, `${BACKUP_PREFIX}20260702-000000.db`, "junk"]),
    ).toBe(`${BACKUP_PREFIX}20260702-000000.db`)
  })
})

// ── loadExpectedIds ───────────────────────────────────────────────────────────
describe("loadExpectedIds", () => {
  const P = "/res/db-expected-migrations.json"
  test("缺文件 → null(fail-open 上游)", () => {
    const { fs } = memFs()
    expect(loadExpectedIds({ resourcesPath: "/res", exists: fs.exists, readText: fs.readText })).toBeNull()
  })
  test("坏 JSON / 错 schema / 空 ids → null", () => {
    for (const content of ["not json", JSON.stringify({ v: 2, ids: ["a"] }), JSON.stringify({ v: 1, ids: "x" }), JSON.stringify({ v: 1, ids: [] })]) {
      const { fs } = memFs({ [P]: content })
      expect(loadExpectedIds({ resourcesPath: "/res", exists: fs.exists, readText: fs.readText })).toBeNull()
    }
  })
  test("正常 → ids(滤掉非字符串)", () => {
    const { fs } = memFs({ [P]: JSON.stringify({ v: 1, ids: ["a", 42, "b"] }) })
    expect(loadExpectedIds({ resourcesPath: "/res", exists: fs.exists, readText: fs.readText })).toEqual(["a", "b"])
  })
})

// ── restoreFromBackup(memFs)──────────────────────────────────────────────────
describe("restoreFromBackup", () => {
  const now = new Date(2026, 6, 5, 1, 2, 3)
  test("损坏件改名保留 + WAL 残件连带挪走 + 备份复制回位", () => {
    const { fs, files } = memFs({
      "/data/opencode.db": "CORRUPT",
      "/data/opencode.db-wal": "OLDWAL",
      "/data/opencode.db-shm": "OLDSHM",
      "/bk/opencode-backup-20260704-000000.db": "GOOD",
    })
    const r = restoreFromBackup({ dbPath: "/data/opencode.db", backupPath: "/bk/opencode-backup-20260704-000000.db", fs, now })
    expect(r.ok).toBe(true)
    if (r.ok) expect(r.damagedPath).toBe("/data/opencode.db.corrupt-20260705-010203")
    expect(files.get("/data/opencode.db")).toBe("GOOD")
    expect(files.get("/data/opencode.db.corrupt-20260705-010203")).toBe("CORRUPT")
    expect(files.get("/data/opencode.db.corrupt-20260705-010203-wal")).toBe("OLDWAL")
    expect(files.has("/data/opencode.db-wal")).toBe(false)
    expect(files.has("/data/opencode.db-shm")).toBe(false)
  })
  test("rename 失败 → ok:false(不半途留摊子)", () => {
    const { fs } = memFs({}) // dbPath 不存在 → rename 抛
    const r = restoreFromBackup({ dbPath: "/data/opencode.db", backupPath: "/bk/x.db", fs, now })
    expect(r.ok).toBe(false)
  })
})

// ── createVerifiedBackup:验证失败必须删产物(反 placebo,F7)────────────────────
describe("createVerifiedBackup(mock exec)", () => {
  const now = new Date(2026, 6, 5, 1, 2, 3)
  test("integrity 非 ok → 删 tmp + 报错", async () => {
    const { fs, files } = memFs({ "/data/opencode.db": "DB" })
    const exec: Exec = async (args) => {
      if (args[2]?.startsWith("VACUUM INTO")) {
        files.set("/bk/opencode-backup-20260705-010203.db.tmp", "SNAP")
        return { code: 0, stdout: "", stderr: "" }
      }
      return { code: 0, stdout: "*** in database main ***\nPage 5 is never used\n", stderr: "" }
    }
    const r = await createVerifiedBackup({ dbPath: "/data/opencode.db", backupDir: "/bk", exec, fs, now })
    expect(r.ok).toBe(false)
    expect(files.has("/bk/opencode-backup-20260705-010203.db.tmp")).toBe(false)
    expect(files.has("/bk/opencode-backup-20260705-010203.db")).toBe(false)
  })
  test("VACUUM 声称成功但没写文件(F7 静默假成功形态)→ 报错", async () => {
    const { fs } = memFs({ "/data/opencode.db": "DB" })
    const exec: Exec = async () => ({ code: 0, stdout: "", stderr: "" })
    const r = await createVerifiedBackup({ dbPath: "/data/opencode.db", backupDir: "/bk", exec, fs, now })
    expect(r.ok).toBe(false)
  })
})

// ── 真 sqlite3 集成(macOS 本地 + GH ubuntu 均有;缺失则 skip)────────────────────
const sqlite3 = Bun.which("sqlite3")
const itSql = test.skipIf(!sqlite3)

const execReal: Exec = async (args) => {
  const proc = Bun.spawn([sqlite3!, ...args], { stdout: "pipe", stderr: "pipe" })
  const [stdout, stderr, code] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ])
  return { code, stdout, stderr }
}
const realFs: FsDeps = {
  exists: existsSync,
  mkdir: (p) => mkdirSync(p, { recursive: true }),
  readdir: (p) => readdirSync(p),
  rename: renameSync,
  copy: copyFileSync,
  remove: (p) => rmSync(p, { force: true }),
  readText: (p) => readFileSync(p, "utf8"),
}

const tmpRoot = mkdtempSync(join(tmpdir(), "db-safety-test-"))
afterAll(() => rmSync(tmpRoot, { recursive: true, force: true }))

const M1 = "20260101000000_alpha"
const M2 = "20260202000000_beta"

async function makeFixtureDb(path: string, ids: string[]) {
  const values = ids.map((id) => `('${id}', 1)`).join(",")
  const sql = `CREATE TABLE migration(id TEXT PRIMARY KEY, time_completed INTEGER NOT NULL);${
    ids.length > 0 ? ` INSERT INTO migration VALUES ${values};` : ""
  } CREATE TABLE session(id TEXT);`
  const res = await execReal([path, sql])
  if (res.code !== 0) throw new Error(`fixture failed: ${res.stderr}`)
}

describe("integration(real sqlite3)", () => {
  itSql("读水位:fixture ids 原样返回", async () => {
    const db = join(tmpRoot, "read.db")
    await makeFixtureDb(db, [M1, M2])
    const r = await readDbMigrationIds(db, execReal, existsSync)
    expect(r).toEqual({ ok: true, ids: [M1, M2], legacy: false })
  })

  itSql("无 migration 表(纯旧库)→ legacy + ids []", async () => {
    const db = join(tmpRoot, "legacy.db")
    await execReal([db, "CREATE TABLE session(id TEXT);"])
    const r = await readDbMigrationIds(db, execReal, existsSync)
    expect(r).toEqual({ ok: true, ids: [], legacy: true })
  })

  itSql("垃圾文件 → corrupt(F6 签名)", async () => {
    const db = join(tmpRoot, "garbage.db")
    writeFileSync(db, "this is not a sqlite database at all — padding to pass header sniff length")
    const r = await readDbMigrationIds(db, execReal, existsSync)
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.kind).toBe("corrupt")
  })

  itSql("文件不存在 → missing", async () => {
    const r = await readDbMigrationIds(join(tmpRoot, "nope.db"), execReal, existsSync)
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.kind).toBe("missing")
  })

  itSql("备份:VACUUM INTO + 验证 + 轮转(F7)", async () => {
    const db = join(tmpRoot, "bk-src.db")
    await makeFixtureDb(db, [M1, M2])
    const dir = join(tmpRoot, "backups")
    mkdirSync(dir, { recursive: true })
    // 预置 5 份旧备份(内容无关,轮转按名字)→ 新增 1 份后应删最旧 1 份
    for (let i = 1; i <= 5; i++) writeFileSync(join(dir, `${BACKUP_PREFIX}2026070${i}-000000.db`), "old")
    const r = await createVerifiedBackup({ dbPath: db, backupDir: dir, exec: execReal, fs: realFs, now: new Date(2026, 6, 9) })
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(existsSync(r.path)).toBe(true)
    expect(r.rotated).toEqual([`${BACKUP_PREFIX}20260701-000000.db`])
    expect(existsSync(join(dir, `${BACKUP_PREFIX}20260701-000000.db`))).toBe(false)
    // 备份可读且水位一致
    const back = await readDbMigrationIds(r.path, execReal, existsSync)
    expect(back).toEqual({ ok: true, ids: [M1, M2], legacy: false })
  })

  itSql("导出:目标可读", async () => {
    const db = join(tmpRoot, "exp-src.db")
    await makeFixtureDb(db, [M1])
    const target = join(tmpRoot, "exported.db")
    const r = await exportVerifiedCopy({ dbPath: db, targetPath: target, exec: execReal, fs: realFs })
    expect(r.ok).toBe(true)
    const back = await readDbMigrationIds(target, execReal, existsSync)
    expect(back).toEqual({ ok: true, ids: [M1], legacy: false })
  })

  itSql("恢复往返:损坏 → 从备份复原 → 水位回来;损坏件+WAL 残件保留在侧", async () => {
    const db = join(tmpRoot, "restore.db")
    await makeFixtureDb(db, [M1, M2])
    const dir = join(tmpRoot, "restore-backups")
    const bk = await createVerifiedBackup({ dbPath: db, backupDir: dir, exec: execReal, fs: realFs, now: new Date(2026, 6, 9) })
    expect(bk.ok).toBe(true)
    if (!bk.ok) return
    // 弄坏原库 + 伪造 WAL 残件
    writeFileSync(db, "garbage garbage garbage garbage garbage garbage garbage")
    writeFileSync(`${db}-wal`, "stale wal")
    const corrupt = await readDbMigrationIds(db, execReal, existsSync)
    expect(corrupt.ok).toBe(false)
    const restored = restoreFromBackup({ dbPath: db, backupPath: bk.path, fs: realFs, now: new Date(2026, 6, 10, 1, 2, 3) })
    expect(restored.ok).toBe(true)
    if (!restored.ok) return
    const after = await readDbMigrationIds(db, execReal, existsSync)
    expect(after).toEqual({ ok: true, ids: [M1, M2], legacy: false })
    expect(existsSync(restored.damagedPath)).toBe(true)
    expect(existsSync(`${restored.damagedPath}-wal`)).toBe(true)
    expect(existsSync(`${db}-wal`)).toBe(false)
  })
})
