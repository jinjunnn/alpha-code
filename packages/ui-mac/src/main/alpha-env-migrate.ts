// REQ-098 T3:旧 `~/.alpha` 单根布局 → 当前环境 mutable root 的版本化兼容迁移(issue #190),
// 及迁移后的 rollback 期状态对账(issue #304)。
//
// 语义(AC#3/#4 契约):
//   - 只读导入:source(旧布局)只读,绝不修改/删除用户文件;唯一 additive 写入 = rollback 标记
//     (新文件,read-modify-write + 原子替换;仅初次迁移写,对账轮绝不碰旧根);
//   - 幂等:receipt 在场且身份匹配(environment/sourceRoot/targetRoot)→ 走对账;receipt 缺失/
//     损坏/身份不匹配 → 重跑迁移,已就位条目逐条 already-present 跳过(不重复复制、不丢状态);
//   - crash 可重试:每条目 copy 进 `<name>.alpha-migrating` 临时名后原子 rename;中途崩溃只留
//     tmp 残骸,重跑先清 tmp 再补拷;receipt 最后原子落盘(fsync)—— receipt 即「全部完成」凭证;
//   - 路径再归属:导入的 alpha.jsonc / installs.json 里凡指向旧根的绝对路径(plugin[]、skills.paths、
//     receipts.files[] 等)一律改写到环境根 —— 环境内绝不引用另一环境/旧根的可变内容;
//   - symlink 拒绝(#304):同一"不引用旧根"契约的文件系统通道。仅保留「相对形式 + 词法与
//     canonical 双圈禁在本次复制子树内」的 symlink;绝对链、逃逸链、broken 链及 FIFO/socket 等
//     非常规类型一律拒绝(跳过不拷 + receipt 记账;source 只读故无破坏)。顶层条目本身是链 →
//     rejected-symlink,不再放倒整次迁移;
//   - rollback 期对账(#304,AC#4):receipt 携带 reconcile 状态块 —— baseline(首个可信观察,
//     不可变)/ lastObserved(增量锚,每轮更新)。每次启动对账旧根:相对 lastObserved 新出现、
//     且环境根同名不存在(lstat,broken link 也算存在)的目录子条目 → 按迁移同款纪律导入(随机
//     私有 staging + symlink 守卫 + 不覆盖);每成功导入一个子条目即原子提交一次 receipt,把
//     resurrection 窗口收束到单个子条目。曾观察过的名字永久定序(settled)—— 环境侧删除不会被
//     复活;被拒条目记录指纹,源形态变化后重新评估。存量 receipt(无 reconcile 块)bootstrap
//     只建基线 + 报告(legacyOnly),不自动导入(无法区分 rollback 新增 vs 环境侧删除);
//   - 配置漂移只检测不合并:alpha.jsonc / installs.json 相对 baseline 的变化记 unresolvedDrift
//     (loud 留痕,状态未变时不重复告警),环境文件不动 —— 检测 ≠ 解决,基线永不被漂移覆盖。
//
// electron-free(root/userData 全注入),AC#5:路径比较对空格/Unicode 天然安全(不做字符串猜测),
// Windows 盘符/反斜杠由 normalizeForCompare 归一(纯字符串逻辑,darwin 上可测)。
// 契约文档:docs/contracts/env-migration-rollback-reconcile.md

import * as crypto from "node:crypto"
import * as fs from "node:fs"
import * as path from "node:path"
import { applyEdits, modify, parse } from "jsonc-parser"
import { writeMcpSecret } from "./alpha-mcp-secrets"
import { fsyncDirTreeSync, fsyncFileSync, renameAtomicSync, writeFileAtomicSync } from "./ext-atomic-fs"

export const ENV_MIGRATION_VERSION = 1
export const ENV_MIGRATION_RECEIPT_FILE = "env-migration-receipt.json"
export const ENV_ROLLBACK_MARKER_FILE = ".alpha-env-rollback.json"
const MIGRATING_SUFFIX = ".alpha-migrating"
const RECONCILE_STAGING_DIR = ".alpha-env-migrating"

/** 旧布局里参与导入的条目(REQ-098 目标③点名的五件)。 */
export const ENV_MIGRATION_ITEMS = ["alpha.jsonc", "installs.json", "skills", "agents", "plugins"] as const
export type EnvMigrationItem = (typeof ENV_MIGRATION_ITEMS)[number]
const ENV_MIGRATION_DIR_ITEMS = ["skills", "agents", "plugins"] as const satisfies readonly EnvMigrationItem[]
const ENV_MIGRATION_FILE_ITEMS = ["alpha.jsonc", "installs.json"] as const satisfies readonly EnvMigrationItem[]

export type SourceInventoryEntry = {
  name: EnvMigrationItem
  kind: "file" | "dir" | "absent" | "symlink" | "special"
  bytes?: number
  entries?: number
}

export type ItemOutcome = {
  name: EnvMigrationItem
  outcome: "imported" | "already-present" | "absent" | "rejected-symlink" | "rejected-special"
}

export type SecretRefRecord = { server: string; key: string }
export type SecretRefDropped = SecretRefRecord & { reason: string }

// ── #304 对账状态(receipt 内嵌;非历史数组,只承载当前基线 + 当前未解决状态)────────────────

export type ChildKind = "file" | "dir" | "symlink" | "special"
export type ChildObservation = { name: string; kind: ChildKind; fp: string }
export type ItemObservation =
  | { kind: "absent" }
  | { kind: "file"; sha256: string }
  | { kind: "dir"; children: ChildObservation[] }
  | { kind: "symlink" }
  | { kind: "special" }

export type ReconcileIssue = { item: EnvMigrationItem; name: string }
export type RejectedRef = { item: EnvMigrationItem; name: string; kind: ChildKind; reason: string; fp: string }
export type ConfigDrift = { item: EnvMigrationItem; baseline: ItemObservation; observed: ItemObservation }

export type EnvReconcileState = {
  /** 首个可信观察(不可变)。bootstrap=true = 基线建立在既有 receipt 之上,基线前差异只报告。 */
  baselineAt: string
  bootstrap: boolean
  baseline: Record<EnvMigrationItem, ItemObservation>
  /** 最近一次旧根观察 —— 增量判定锚:曾出现于此的名字永久定序,不再自动导入(防复活)。 */
  lastObserved: Record<EnvMigrationItem, ItemObservation>
  lastReconcile: { at: string; appVersion: string; imported: string[] }
  /** 当前状态报告:旧根有、环境根无(bootstrap 前差异/环境侧删除/别名碰撞;不自动导入)。 */
  legacyOnly: ReconcileIssue[]
  /** 当前状态报告:两侧同名且指纹不同(env wins,不覆盖)。 */
  conflicts: ReconcileIssue[]
  /** 被拒引用(symlink/special),带指纹;源形态变化后重新评估。 */
  rejected: RejectedRef[]
  /** 配置文件相对 baseline 的未处理漂移(检测 ≠ 解决;基线不被覆盖)。 */
  unresolvedDrift: ConfigDrift[]
}

export type EnvMigrationReceipt = {
  v: typeof ENV_MIGRATION_VERSION
  environment: string
  appVersion: string
  migratedAt: string
  sourceRoot: string
  targetRoot: string
  source: SourceInventoryEntry[]
  results: ItemOutcome[]
  secretRefs: { rederived: SecretRefRecord[]; dropped: SecretRefDropped[] }
  pathsRewritten: number
  warnings: string[]
  /** #304:对账状态块。旧版 receipt 缺失 → 首轮 bootstrap(只报告不导入)。 */
  reconcile?: EnvReconcileState
}

export type EnvReconcileOutcome =
  | { status: "clean" }
  | {
      status: "reconciled"
      imported: string[]
      legacyOnly: number
      conflicts: number
      rejected: number
      drift: number
      bootstrap: boolean
    }
  /** 迁移本身有效(receipt 在场),仅本轮对账失败 —— 下次启动重试,不得误报为迁移失败。 */
  | { status: "reconcile-failed"; reason: string }

export type EnvMigrationOutcome =
  | { status: "skipped-same-root" }
  | { status: "already-migrated"; receipt: EnvMigrationReceipt; reconcile: EnvReconcileOutcome }
  | { status: "migrated"; receipt: EnvMigrationReceipt }
  | { status: "failed"; reason: string; warnings: string[] }

// ── 路径比较/改写(AC#5:跨平台分隔符 + Windows 盘符大小写)────────────────────────────────

function normalizeForCompare(p: string): string {
  let n = p.replace(/\\/g, "/")
  if (/^[a-zA-Z]:\//.test(n) || /^[a-zA-Z]:$/.test(n)) n = n[0].toLowerCase() + n.slice(1)
  return n.length > 1 ? n.replace(/\/+$/, "") : n
}

export function isPathUnder(child: string, root: string): boolean {
  const c = normalizeForCompare(child)
  const r = normalizeForCompare(root)
  return c === r || c.startsWith(r + "/")
}

function isSamePath(a: string, b: string): boolean {
  return isPathUnder(a, b) && isPathUnder(b, a)
}

/** 指向 sourceRoot 内的绝对路径 → 对应 targetRoot 路径;不在 sourceRoot 内 → null(不动)。 */
export function rewriteUnderRoot(p: string, sourceRoot: string, targetRoot: string): string | null {
  if (!isPathUnder(p, sourceRoot)) return null
  const rest = normalizeForCompare(p).slice(normalizeForCompare(sourceRoot).length)
  const segs = rest.split("/").filter(Boolean)
  return segs.length ? path.join(targetRoot, ...segs) : targetRoot
}

// ── alpha.jsonc 变换(jsonc modify:保注释/保格式)────────────────────────────────────────

type JsonPath = (string | number)[]

function collectStringRewrites(
  node: unknown,
  at: JsonPath,
  sourceRoot: string,
  targetRoot: string,
  out: { path: JsonPath; value: string }[],
): void {
  if (typeof node === "string") {
    const rewritten = rewriteUnderRoot(node, sourceRoot, targetRoot)
    if (rewritten !== null && rewritten !== node) out.push({ path: at, value: rewritten })
    return
  }
  if (Array.isArray(node)) {
    node.forEach((v, i) => collectStringRewrites(v, [...at, i], sourceRoot, targetRoot, out))
    return
  }
  if (node && typeof node === "object") {
    for (const [k, v] of Object.entries(node as Record<string, unknown>)) {
      collectStringRewrites(v, [...at, k], sourceRoot, targetRoot, out)
    }
  }
}

const FILE_REF_RE = /\{file:([^}]*)\}/g
const SAFE_SERVER = /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,63}$/

function applyModify(text: string, jsonPath: JsonPath, value: unknown): string {
  return applyEdits(text, modify(text, jsonPath, value, { formattingOptions: { tabSize: 2, insertSpaces: true } }))
}

export type JsoncTransformResult = {
  text: string
  pathsRewritten: number
  rederived: SecretRefRecord[]
  dropped: SecretRefDropped[]
  warnings: string[]
}

/**
 * 导入用 alpha.jsonc 变换:① 旧根绝对路径 → 环境根;② mcp 条目 environment/headers 里的外域
 * `{file:}` secret 引用重新派生进当前环境(不可读/不可派生 → 整键摘除,fail-closed)。
 */
export function transformAlphaJsoncForEnv(
  text: string,
  opts: { sourceRoot: string; targetRoot: string; userDataPath: string },
): JsoncTransformResult {
  const warnings: string[] = []
  const rederived: SecretRefRecord[] = []
  const dropped: SecretRefDropped[] = []
  let pathsRewritten = 0

  let parsed = parse(text) as unknown
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    // 不可解析/非对象:原样导入(绝不丢用户数据),loud 留痕。
    if (text.trim().length > 0 && parsed === undefined) warnings.push("alpha.jsonc unparseable — imported verbatim")
    return { text, pathsRewritten, rederived, dropped, warnings }
  }

  // ① 旧根路径改写
  const rewrites: { path: JsonPath; value: string }[] = []
  collectStringRewrites(parsed, [], opts.sourceRoot, opts.targetRoot, rewrites)
  for (const r of rewrites) {
    text = applyModify(text, r.path, r.value)
    pathsRewritten += 1
  }

  // ② secret 引用再派生(基于改写后的文本重新 parse)
  parsed = parse(text) as unknown
  const obj = parsed && typeof parsed === "object" && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : undefined
  const mcp = obj?.mcp
  if (mcp && typeof mcp === "object" && !Array.isArray(mcp)) {
    for (const [server, entryRaw] of Object.entries(mcp as Record<string, unknown>)) {
      if (!entryRaw || typeof entryRaw !== "object" || Array.isArray(entryRaw)) continue
      for (const section of ["environment", "headers"] as const) {
        const sec = (entryRaw as Record<string, unknown>)[section]
        if (!sec || typeof sec !== "object" || Array.isArray(sec)) continue
        for (const [key, value] of Object.entries(sec as Record<string, unknown>)) {
          if (typeof value !== "string") continue
          const refs = [...value.matchAll(FILE_REF_RE)]
          if (refs.length === 0) continue
          let next = value
          let dropKey = false
          for (const m of refs) {
            const refPath = m[1]
            // 当前 userData / 环境根内的引用 = 本环境自有,保留。
            if (isPathUnder(refPath, opts.userDataPath) || isPathUnder(refPath, opts.targetRoot)) continue
            // 外域引用(另一环境的 userData 等)→ 再派生或摘除。
            if (!SAFE_SERVER.test(server)) {
              dropKey = true
              dropped.push({ server, key: `${section}.${key}`, reason: "unsafe server name" })
              break
            }
            let secretValue: string | undefined
            try {
              secretValue = fs.readFileSync(refPath, "utf8")
            } catch {
              secretValue = undefined
            }
            if (secretValue === undefined || secretValue.length === 0) {
              dropKey = true
              dropped.push({ server, key: `${section}.${key}`, reason: "foreign secret file unreadable" })
              break
            }
            const varName = (section === "headers" ? `HDR_${key}` : key).replace(/[^A-Za-z0-9_]/g, "_")
            const written = writeMcpSecret(opts.userDataPath, server, varName, secretValue)
            if (!written.ok) {
              dropKey = true
              dropped.push({ server, key: `${section}.${key}`, reason: `re-derive failed: ${written.reason}` })
              break
            }
            next = next.replace(m[0], written.ref)
            rederived.push({ server, key: `${section}.${key}` })
          }
          if (dropKey) {
            text = applyModify(text, ["mcp", server, section, key], undefined)
          } else if (next !== value) {
            text = applyModify(text, ["mcp", server, section, key], next)
          }
        }
      }
    }
  }

  return { text, pathsRewritten, rederived, dropped, warnings }
}

/** installs.json 导入变换:receipts[].files[] 中旧根绝对路径 → 环境根(卸载/更新只指环境内副本)。 */
export function transformInstallsJsonForEnv(
  text: string,
  opts: { sourceRoot: string; targetRoot: string },
): { text: string; pathsRewritten: number; warnings: string[] } {
  try {
    const parsed = JSON.parse(text) as { receipts?: unknown }
    if (!parsed || typeof parsed !== "object" || !Array.isArray(parsed.receipts)) {
      return { text, pathsRewritten: 0, warnings: [] }
    }
    let pathsRewritten = 0
    for (const receipt of parsed.receipts) {
      if (!receipt || typeof receipt !== "object") continue
      const files = (receipt as { files?: unknown }).files
      if (!Array.isArray(files)) continue
      for (let i = 0; i < files.length; i++) {
        if (typeof files[i] !== "string") continue
        const rewritten = rewriteUnderRoot(files[i] as string, opts.sourceRoot, opts.targetRoot)
        if (rewritten !== null && rewritten !== files[i]) {
          files[i] = rewritten
          pathsRewritten += 1
        }
      }
    }
    return { text: JSON.stringify(parsed, null, 2) + "\n", pathsRewritten, warnings: [] }
  } catch {
    // 坏账本原样导入(readLedger 有自己的 quarantine 纪律),loud 留痕。
    return { text, pathsRewritten: 0, warnings: ["installs.json unparseable — imported verbatim"] }
  }
}

// ── 指纹/观察(#304:目录基线 = 名字 + 类型 + 内容指纹,symlink-aware、确定性)────────────────

function sha256Hex(data: string | Buffer): string {
  return crypto.createHash("sha256").update(data).digest("hex")
}

function childKindOf(st: fs.Stats): ChildKind {
  if (st.isSymbolicLink()) return "symlink"
  if (st.isDirectory()) return "dir"
  if (st.isFile()) return "file"
  return "special"
}

/** 树指纹:排序遍历,每行 `rel␀kind␀叶指纹`;symlink 记原始 target,不可读记稳定标记。 */
function fingerprintTree(p: string): string {
  const lines: string[] = []
  const walk = (cur: string, rel: string) => {
    let st: fs.Stats
    try {
      st = fs.lstatSync(cur)
    } catch {
      lines.push(`${rel}\0unreadable\0`)
      return
    }
    const kind = childKindOf(st)
    if (kind === "symlink") {
      let target = ""
      try {
        target = fs.readlinkSync(cur)
      } catch {
        target = "\0unreadable"
      }
      lines.push(`${rel}\0symlink\0${target}`)
      return
    }
    if (kind === "dir") {
      lines.push(`${rel}\0dir\0`)
      let entries: string[] = []
      try {
        entries = fs.readdirSync(cur).sort()
      } catch {
        lines.push(`${rel}\0unreadable\0`)
        return
      }
      for (const e of entries) walk(path.join(cur, e), rel ? `${rel}/${e}` : e)
      return
    }
    if (kind === "file") {
      let fp = "unreadable"
      try {
        fp = sha256Hex(fs.readFileSync(cur))
      } catch {
        /* 稳定标记 */
      }
      lines.push(`${rel}\0file\0${fp}`)
      return
    }
    lines.push(`${rel}\0special\0`)
  }
  walk(p, "")
  return sha256Hex(lines.join("\n"))
}

function observeChild(dir: string, name: string): ChildObservation {
  return { name, kind: childKindOfPath(path.join(dir, name)), fp: fingerprintTree(path.join(dir, name)) }
}

function childKindOfPath(p: string): ChildKind {
  try {
    return childKindOf(fs.lstatSync(p))
  } catch {
    return "special"
  }
}

/** 对旧根单个条目的观察(配置文件 = 内容哈希;目录 = 子条目名+类型+指纹;可表示 absent)。 */
function observeItem(sourceRoot: string, name: EnvMigrationItem): ItemObservation {
  const p = path.join(sourceRoot, name)
  let st: fs.Stats
  try {
    st = fs.lstatSync(p)
  } catch {
    return { kind: "absent" }
  }
  if (st.isSymbolicLink()) return { kind: "symlink" }
  if (st.isDirectory()) {
    let entries: string[] = []
    try {
      entries = fs.readdirSync(p).sort()
    } catch {
      /* 不可读目录按空 children 观察 */
    }
    return { kind: "dir", children: entries.map((e) => observeChild(p, e)) }
  }
  if (st.isFile()) {
    try {
      return { kind: "file", sha256: sha256Hex(fs.readFileSync(p)) }
    } catch {
      return { kind: "special" }
    }
  }
  return { kind: "special" }
}

function observeAllItems(sourceRoot: string): Record<EnvMigrationItem, ItemObservation> {
  const out = {} as Record<EnvMigrationItem, ItemObservation>
  for (const name of ENV_MIGRATION_ITEMS) out[name] = observeItem(sourceRoot, name)
  return out
}

// ── 拷贝(#304 symlink 守卫:相对 + 词法/canonical 双圈禁于本次复制子树,余者拒;非常规类型拒)──

type RejectSink = (rel: string, kind: ChildKind, reason: string) => void

/**
 * 守卫拷贝:root 双形态圈禁(lexRoot = 本次复制子树的原路径,realRoot = 其 realpath)。
 * symlink 仅当「相对形式 && 词法解析留在 lexRoot 内 && canonical 解析留在 realRoot 内」原样保留
 * (拷贝后在目标树内自洽解析);其余(绝对/逃逸/broken)拒。FIFO/socket/device 等非常规类型拒。
 */
function copyTreeGuarded(src: string, dst: string, lexRoot: string, realRoot: string, rel: string, reject: RejectSink): void {
  const st = fs.lstatSync(src)
  if (st.isSymbolicLink()) {
    const raw = fs.readlinkSync(src)
    if (path.isAbsolute(raw)) {
      reject(rel, "symlink", "absolute symlink")
      return
    }
    const lexTarget = path.resolve(path.dirname(src), raw)
    if (!isPathUnder(lexTarget, lexRoot)) {
      reject(rel, "symlink", "symlink escapes copied subtree (lexical)")
      return
    }
    let realTarget: string
    try {
      realTarget = fs.realpathSync(lexTarget)
    } catch {
      reject(rel, "symlink", "broken symlink")
      return
    }
    if (!isPathUnder(realTarget, realRoot)) {
      reject(rel, "symlink", "symlink escapes copied subtree (canonical)")
      return
    }
    fs.symlinkSync(raw, dst)
    return
  }
  if (st.isDirectory()) {
    fs.mkdirSync(dst, { recursive: true })
    for (const entry of fs.readdirSync(src)) {
      copyTreeGuarded(path.join(src, entry), path.join(dst, entry), lexRoot, realRoot, rel ? `${rel}/${entry}` : entry, reject)
    }
    return
  }
  if (!st.isFile()) {
    reject(rel, "special", "not a regular file/dir/symlink")
    return
  }
  fs.copyFileSync(src, dst)
  try {
    fs.chmodSync(dst, st.mode)
  } catch {
    /* 模式位尽力保留 */
  }
}

function inventoryOf(sourceRoot: string, name: EnvMigrationItem): SourceInventoryEntry {
  const p = path.join(sourceRoot, name)
  let st: fs.Stats
  try {
    st = fs.lstatSync(p)
  } catch {
    return { name, kind: "absent" }
  }
  if (st.isSymbolicLink()) return { name, kind: "symlink" }
  if (st.isDirectory()) {
    let entries = 0
    try {
      entries = fs.readdirSync(p).length
    } catch {
      /* 不可读目录按 0 计 */
    }
    return { name, kind: "dir", entries }
  }
  if (st.isFile()) return { name, kind: "file", bytes: st.size }
  return { name, kind: "special" }
}

export function envMigrationReceiptPath(targetRoot: string): string {
  return path.join(targetRoot, ENV_MIGRATION_RECEIPT_FILE)
}

/** 读 receipt(结构校验:版本 + 关键字段;身份匹配由 runEnvMigration 追加校验)。 */
export function readEnvMigrationReceipt(targetRoot: string): EnvMigrationReceipt | null {
  try {
    const parsed = JSON.parse(fs.readFileSync(envMigrationReceiptPath(targetRoot), "utf8")) as EnvMigrationReceipt
    if (!parsed || typeof parsed !== "object" || parsed.v !== ENV_MIGRATION_VERSION) return null
    if (typeof parsed.environment !== "string" || typeof parsed.sourceRoot !== "string" || typeof parsed.targetRoot !== "string") {
      return null
    }
    if (!Array.isArray(parsed.results) || !Array.isArray(parsed.source)) return null
    return parsed
  } catch {
    return null
  }
}

/**
 * 旧根 rollback 标记是否证明「本环境此前已迁移到此根」—— receipt 丢失/损坏/身份不匹配的恢复
 * 路径用它判别:有此证据 → 不得做首迁 child 级合并(定序史已失,合并会复活环境侧删除),
 * 转报告式(后续 bootstrap 对账只报告);无此证据 → 视作真·首次迁移,child 级合并合法。
 */
function markerShowsPriorMigration(sourceRoot: string, environment: string, targetRoot: string): boolean {
  try {
    const parsed = JSON.parse(fs.readFileSync(path.join(sourceRoot, ENV_ROLLBACK_MARKER_FILE), "utf8")) as {
      environments?: Record<string, { targetRoot?: unknown }>
    }
    const rec = parsed?.environments?.[environment]
    return !!rec && typeof rec.targetRoot === "string" && isSamePath(rec.targetRoot, targetRoot)
  } catch {
    return false
  }
}

/** rollback 标记(旧根内 additive 新文件):告知旧布局仍是降级版本的真源;read-modify-write + 原子替换。 */
function writeRollbackMarker(sourceRoot: string, environment: string, receipt: EnvMigrationReceipt, warnings: string[]): void {
  const file = path.join(sourceRoot, ENV_ROLLBACK_MARKER_FILE)
  let existing: Record<string, unknown> = {}
  try {
    if (fs.existsSync(file)) {
      const parsed = JSON.parse(fs.readFileSync(file, "utf8")) as Record<string, unknown>
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) existing = parsed
    }
  } catch {
    /* 坏标记整份重写(标记非用户数据) */
  }
  const environments =
    existing.environments && typeof existing.environments === "object" && !Array.isArray(existing.environments)
      ? (existing.environments as Record<string, unknown>)
      : {}
  environments[environment] = {
    migratedAt: receipt.migratedAt,
    appVersion: receipt.appVersion,
    targetRoot: receipt.targetRoot,
  }
  const marker = {
    v: ENV_MIGRATION_VERSION,
    note: "REQ-098: this legacy single-root layout was READ-ONLY imported into per-environment roots. It remains untouched and stays authoritative for pre-isolation app versions (rollback-safe).",
    environments,
  }
  try {
    writeFileAtomicSync(file, JSON.stringify(marker, null, 2) + "\n")
  } catch (error) {
    warnings.push(`rollback marker write failed (non-fatal): ${error instanceof Error ? error.message : String(error)}`)
  }
}

export type RunEnvMigrationInput = {
  sourceRoot: string
  targetRoot: string
  userDataPath: string
  environment: string
  appVersion: string
  /** 注入以便单测固定时间戳。 */
  now?: () => Date
}

// ── #304 对账实现 ────────────────────────────────────────────────────────────────────────

/** 环境根同名存在性:lstat(broken symlink 也算存在 —— 绝不 rename 覆盖用户对象)。 */
function envHas(targetRoot: string, item: EnvMigrationItem, name: string): boolean {
  try {
    fs.lstatSync(path.join(targetRoot, item, name))
    return true
  } catch {
    return false
  }
}

/** 别名归一(大小写不敏感文件系统 + Unicode NFC/NFD):仅用于碰撞检测,不改真实名字。 */
function aliasKey(name: string): string {
  return name.normalize("NFC").toLowerCase()
}

function listEnvChildren(targetRoot: string, item: EnvMigrationItem): { names: Set<string>; aliases: Set<string> } | null {
  const dir = path.join(targetRoot, item)
  let st: fs.Stats
  try {
    st = fs.lstatSync(dir)
  } catch {
    return { names: new Set(), aliases: new Set() } // 目录不存在:可导入(mkdir 后落子)
  }
  if (!st.isDirectory()) return null // 环境侧同名非目录:类型冲突,整项跳过
  const names = new Set<string>()
  const aliases = new Set<string>()
  try {
    for (const e of fs.readdirSync(dir)) {
      names.add(e)
      aliases.add(aliasKey(e))
    }
  } catch {
    return null
  }
  return { names, aliases }
}

/** 稳定错误码(reason 进 receipt state,禁止携带随机 staging 路径等易变文本 —— 防每轮启动重写 receipt)。 */
function stableErrCode(error: unknown): string {
  const code = (error as NodeJS.ErrnoException | undefined)?.code
  return typeof code === "string" && code.length > 0 ? code : "unknown"
}

/**
 * staged 树发布前重验 + 落盘:每个节点必须是 file/dir,或「相对 + 词法/canonical 双圈禁于
 * stage 内」的 symlink(守卫拷贝只会产出这些;不符 = staging 被篡改/竞态,fail-closed 拒发布);
 * 文件逐个 fsync(receipt 的持久化绝不允许跑在载荷持久化前面)。
 */
function revalidateAndSyncStaged(stage: string): void {
  const walk = (cur: string) => {
    const st = fs.lstatSync(cur)
    if (st.isSymbolicLink()) {
      const raw = fs.readlinkSync(cur)
      const lexTarget = path.resolve(path.dirname(cur), raw)
      if (path.isAbsolute(raw) || !isPathUnder(lexTarget, stage)) throw new Error("staged tree tampered: escaping symlink")
      return
    }
    if (st.isDirectory()) {
      for (const e of fs.readdirSync(cur)) walk(path.join(cur, e))
      return
    }
    if (!st.isFile()) throw new Error("staged tree tampered: non-regular entry")
    fsyncFileSync(cur)
  }
  walk(stage)
  const rootSt = fs.lstatSync(stage)
  if (rootSt.isDirectory()) fsyncDirTreeSync(stage)
}

/**
 * 随机私有 staging 下守卫拷贝单个子条目 → 发布前重验 + fsync → lstat 复核 → 原子 rename
 * (fsync 目的父目录)。子树内的嵌套拒绝(链/非常规类型)只进 warnings(导入本体照常落位;
 * 下轮 state 重算只看顶层子条目,嵌套记录若进 state 会造成 receipt 两轮抖动)。
 */
function importChildGuarded(
  sourceRoot: string,
  targetRoot: string,
  item: EnvMigrationItem,
  name: string,
  nestedWarnings: string[],
): { ok: boolean; reason?: string } {
  const src = path.join(sourceRoot, item, name)
  let realRoot: string
  try {
    realRoot = fs.realpathSync(src)
  } catch (error) {
    return { ok: false, reason: `source unreadable (${stableErrCode(error)})` }
  }
  const stagingBase = path.join(targetRoot, RECONCILE_STAGING_DIR)
  const stage = path.join(stagingBase, crypto.randomBytes(8).toString("hex"))
  try {
    fs.mkdirSync(stagingBase, { recursive: true })
    copyTreeGuarded(src, stage, src, realRoot, name, (rel, kind, reason) => {
      nestedWarnings.push(`"${item}/${rel}" rejected during import: ${reason} (${kind})`)
    })
    if (!isLstatPresent(stage)) {
      // 顶层即被拒(理论上调用方已过滤 symlink/special;防御性兜底)
      return { ok: false, reason: "rejected at top level" }
    }
    revalidateAndSyncStaged(stage)
    fs.mkdirSync(path.join(targetRoot, item), { recursive: true })
    const final = path.join(targetRoot, item, name)
    if (isLstatPresent(final)) {
      fs.rmSync(stage, { recursive: true, force: true })
      return { ok: false, reason: "target appeared during import (not overwriting)" }
    }
    renameAtomicSync(stage, final)
    return { ok: true }
  } catch (error) {
    try {
      fs.rmSync(stage, { recursive: true, force: true })
    } catch {
      /* staging 残骸由下轮 pass 起始清理 */
    }
    return { ok: false, reason: `import failed (${stableErrCode(error)})` }
  }
}

function isLstatPresent(p: string): boolean {
  try {
    fs.lstatSync(p)
    return true
  } catch {
    return false
  }
}

/** 当前状态报告重算:legacyOnly = 旧根有(file/dir)、环境根无;conflicts = 两侧同名且指纹不同。 */
function computeReports(
  observed: Record<EnvMigrationItem, ItemObservation>,
  targetRoot: string,
): { legacyOnly: ReconcileIssue[]; conflicts: ReconcileIssue[] } {
  const legacyOnly: ReconcileIssue[] = []
  const conflicts: ReconcileIssue[] = []
  for (const item of ENV_MIGRATION_DIR_ITEMS) {
    const obs = observed[item]
    if (obs.kind !== "dir") continue
    for (const child of obs.children) {
      if (child.kind === "symlink" || child.kind === "special") continue // rejected 单列
      if (!envHas(targetRoot, item, child.name)) {
        legacyOnly.push({ item, name: child.name })
        continue
      }
      const envFp = fingerprintTree(path.join(targetRoot, item, child.name))
      if (envFp !== child.fp) conflicts.push({ item, name: child.name })
    }
  }
  return { legacyOnly, conflicts }
}

function collectRejectedFromObservation(observed: Record<EnvMigrationItem, ItemObservation>): RejectedRef[] {
  const out: RejectedRef[] = []
  for (const item of ENV_MIGRATION_DIR_ITEMS) {
    const obs = observed[item]
    if (obs.kind !== "dir") continue
    for (const child of obs.children) {
      if (child.kind === "symlink" || child.kind === "special") {
        out.push({ item, name: child.name, kind: child.kind, reason: `top-level child is ${child.kind}`, fp: child.fp })
      }
    }
  }
  return out
}

function computeDrift(
  baseline: Record<EnvMigrationItem, ItemObservation>,
  observed: Record<EnvMigrationItem, ItemObservation>,
): ConfigDrift[] {
  const out: ConfigDrift[] = []
  for (const item of ENV_MIGRATION_FILE_ITEMS) {
    if (JSON.stringify(baseline[item]) !== JSON.stringify(observed[item])) {
      out.push({ item, baseline: baseline[item], observed: observed[item] })
    }
  }
  return out
}

function statesEqual(a: EnvReconcileState, b: EnvReconcileState | undefined): boolean {
  return b !== undefined && JSON.stringify(a) === JSON.stringify(b)
}

// ── reconcile 块结构校验(可解析但残缺的块若被采信,会造成永久 reconcile-failed 循环)────────

function isItemObservation(v: unknown): v is ItemObservation {
  if (!v || typeof v !== "object") return false
  const kind = (v as { kind?: unknown }).kind
  if (kind === "absent" || kind === "symlink" || kind === "special") return true
  if (kind === "file") return typeof (v as { sha256?: unknown }).sha256 === "string"
  if (kind === "dir") {
    const children = (v as { children?: unknown }).children
    return (
      Array.isArray(children) &&
      children.every(
        (c) =>
          c &&
          typeof c === "object" &&
          typeof (c as ChildObservation).name === "string" &&
          typeof (c as ChildObservation).kind === "string" &&
          typeof (c as ChildObservation).fp === "string",
      )
    )
  }
  return false
}

/** 无效(缺字段/残缺观察)→ undefined:走 bootstrap 报告式自愈重建,绝不进永久失败循环。 */
function validReconcileState(v: EnvReconcileState | undefined): EnvReconcileState | undefined {
  if (!v || typeof v !== "object") return undefined
  if (typeof v.baselineAt !== "string" || typeof v.bootstrap !== "boolean") return undefined
  const obsOk = (rec: unknown) =>
    !!rec && typeof rec === "object" && ENV_MIGRATION_ITEMS.every((n) => isItemObservation((rec as Record<string, unknown>)[n]))
  if (!obsOk(v.baseline) || !obsOk(v.lastObserved)) return undefined
  if (!Array.isArray(v.legacyOnly) || !Array.isArray(v.conflicts) || !Array.isArray(v.unresolvedDrift)) return undefined
  if (!Array.isArray(v.rejected) || !v.rejected.every((r) => r && typeof r.item === "string" && typeof r.name === "string" && typeof r.fp === "string")) {
    return undefined
  }
  if (!v.lastReconcile || typeof v.lastReconcile !== "object" || !Array.isArray(v.lastReconcile.imported)) return undefined
  return v
}

/**
 * 单调 anchor(防「定序名消失一轮→重现」复活):当前观察为主;曾定序但本轮缺席的子条目
 * 带旧条目沿列;目录项在旧根整体消失时保留旧定序集不缩水。合并后按名排序保证确定性。
 */
function mergeMonotonicAnchor(
  prior: Record<EnvMigrationItem, ItemObservation>,
  current: Record<EnvMigrationItem, ItemObservation>,
): Record<EnvMigrationItem, ItemObservation> {
  const out = {} as Record<EnvMigrationItem, ItemObservation>
  for (const name of ENV_MIGRATION_ITEMS) {
    const cur = current[name]
    const old = prior[name]
    if (old?.kind !== "dir") {
      out[name] = cur
      continue
    }
    if (cur.kind !== "dir") {
      out[name] = old // 旧根整项缺席:定序记忆保留
      continue
    }
    const curNames = new Set(cur.children.map((c) => c.name))
    const carried = old.children.filter((c) => !curNames.has(c.name))
    out[name] = {
      kind: "dir",
      children: [...cur.children, ...carried].sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0)),
    }
  }
  return out
}

function writeReceiptAtomic(targetRoot: string, receipt: EnvMigrationReceipt): void {
  writeFileAtomicSync(envMigrationReceiptPath(targetRoot), JSON.stringify(receipt, null, 2) + "\n")
}

/**
 * rollback 期对账(receipt 在场且身份匹配时,每次启动执行):
 * 相对 lastObserved 新出现、环境根无同名/别名的目录子条目 → 守卫导入(每成功一个即提交 receipt);
 * 曾观察过的名字永久定序(不复活环境侧删除);被拒项源形态变化后重评;配置漂移相对 baseline 检测。
 * 无 reconcile 块(存量 receipt)→ bootstrap:只建基线 + 报告,不导入。
 */
function reconcileRollbackEra(receipt: EnvMigrationReceipt, input: RunEnvMigrationInput): EnvReconcileOutcome {
  const { sourceRoot, targetRoot } = input
  const at = (input.now ?? (() => new Date()))().toISOString()
  try {
    fs.rmSync(path.join(targetRoot, RECONCILE_STAGING_DIR), { recursive: true, force: true })
    const observed = observeAllItems(sourceRoot)
    const prior = validReconcileState(receipt.reconcile)

    if (!prior) {
      // bootstrap(裁决①):无可信基线(缺块或块残缺),无法区分「rollback 新增」vs「环境侧
      // 删除」→ 只报告不导入,并原子重建有效状态块(残缺块自愈,不进永久失败循环)。
      const { legacyOnly, conflicts } = computeReports(observed, targetRoot)
      const state: EnvReconcileState = {
        baselineAt: at,
        bootstrap: true,
        baseline: observed,
        lastObserved: observed,
        lastReconcile: { at, appVersion: input.appVersion, imported: [] },
        legacyOnly,
        conflicts,
        rejected: collectRejectedFromObservation(observed),
        unresolvedDrift: [], // 基线 = 当前观察,首轮无漂移可言
      }
      writeReceiptAtomic(targetRoot, { ...receipt, reconcile: state })
      if (legacyOnly.length === 0 && conflicts.length === 0 && state.rejected.length === 0) return { status: "clean" }
      return {
        status: "reconciled",
        imported: [],
        legacyOnly: legacyOnly.length,
        conflicts: conflicts.length,
        rejected: state.rejected.length,
        drift: 0,
        bootstrap: true,
      }
    }

    const imported: string[] = []
    const failedImports: RejectedRef[] = []
    const nestedWarnings: string[] = []
    // 增量导入:每成功一个子条目,把它补进 anchor、剔除其既往 rejection(自洽 checkpoint,
    // crash 后不会把「已进位的前被拒项」再评估)并提交 receipt(resurrection 窗口 = 单个子条目)。
    const workingAnchor = JSON.parse(JSON.stringify(prior.lastObserved)) as Record<EnvMigrationItem, ItemObservation>
    const commitProgress = () => {
      const importedKeys = new Set(imported)
      writeReceiptAtomic(targetRoot, {
        ...receipt,
        warnings: [...receipt.warnings, ...nestedWarnings],
        reconcile: {
          ...prior,
          lastObserved: workingAnchor,
          rejected: prior.rejected.filter((r) => !importedKeys.has(`${r.item}/${r.name}`)),
          lastReconcile: { at, appVersion: input.appVersion, imported },
        },
      })
    }

    for (const item of ENV_MIGRATION_DIR_ITEMS) {
      const obs = observed[item]
      if (obs.kind !== "dir") continue
      const anchor = prior.lastObserved[item]
      const anchorChildren = new Map<string, ChildObservation>(
        anchor?.kind === "dir" ? anchor.children.map((c) => [c.name, c]) : [],
      )
      const priorRejected = new Map(prior.rejected.filter((r) => r.item === item).map((r) => [r.name, r]))
      const env = listEnvChildren(targetRoot, item)
      if (env === null) continue // 环境侧类型冲突/不可读:本项跳过(computeReports 仍会留痕)

      for (const child of obs.children) {
        const anc = anchorChildren.get(child.name)
        const rej = priorRejected.get(child.name)
        // 定序规则:曾观察过 → 不再评估(防复活环境侧删除)。唯一例外 = 被拒项形态已变,且
        // anchor 仍停留在被拒时的形态(anc.fp === rej.fp;若 anchor 已推进说明该形态已定序,
        // 残留的旧 rejection 不得再触发导入 —— crash checkpoint 防护)。
        if (anc && !(rej && rej.fp !== child.fp && anc.fp === rej.fp)) continue
        if (child.kind === "symlink" || child.kind === "special") continue // state 重算时统一进 rejected
        if (env.names.has(child.name) || env.aliases.has(aliasKey(child.name))) continue // 同名/别名占用:env wins
        const r = importChildGuarded(sourceRoot, targetRoot, item, child.name, nestedWarnings)
        if (r.ok) {
          imported.push(`${item}/${child.name}`)
          env.names.add(child.name)
          env.aliases.add(aliasKey(child.name))
          const wa = workingAnchor[item]
          if (wa?.kind === "dir") wa.children.push(child)
          else workingAnchor[item] = { kind: "dir", children: [child] }
          commitProgress()
        } else {
          // 失败不定序:从本轮 lastObserved 剔除该子条目,下次启动重试(记账留痕)。
          failedImports.push({ item, name: child.name, kind: child.kind, reason: r.reason ?? "import failed", fp: child.fp })
        }
      }
    }

    const { legacyOnly, conflicts } = computeReports(observed, targetRoot)
    // anchor 单调合并(缺席名沿列防复活),再剔除导入失败的子条目 → 它们下一轮仍是「新出现」
    // 候选(可重试),且失败态本身稳定(同样的失败 → 同样的 state → clean 不重写 receipt)。
    const settled = mergeMonotonicAnchor(prior.lastObserved, observed)
    for (const f of failedImports) {
      const it = settled[f.item]
      if (it.kind === "dir") it.children = it.children.filter((c) => c.name !== f.name)
    }
    // rejected 同样沿列:本轮旧根观察不到的既往被拒名保留旧记录(重现时凭 fp 记忆重评)。
    const currentNames = (item: EnvMigrationItem) => {
      const o = observed[item]
      return new Set(o.kind === "dir" ? o.children.map((c) => c.name) : [])
    }
    const rejected = [
      ...failedImports,
      ...collectRejectedFromObservation(observed),
      ...prior.rejected.filter((r) => !currentNames(r.item).has(r.name)),
    ].filter((r, i, all) => all.findIndex((x) => x.item === r.item && x.name === r.name) === i)
    const state: EnvReconcileState = {
      baselineAt: prior.baselineAt,
      bootstrap: prior.bootstrap,
      baseline: prior.baseline, // 不可变(裁决⑤:漂移检测 ≠ 解决,基线不被覆盖)
      lastObserved: settled,
      lastReconcile: imported.length > 0 ? { at, appVersion: input.appVersion, imported } : prior.lastReconcile,
      legacyOnly,
      conflicts,
      rejected,
      unresolvedDrift: computeDrift(prior.baseline, observed),
    }
    if (statesEqual(state, prior)) return { status: "clean" }
    writeReceiptAtomic(targetRoot, { ...receipt, warnings: [...receipt.warnings, ...nestedWarnings], reconcile: state })
    return {
      status: "reconciled",
      imported,
      legacyOnly: legacyOnly.length,
      conflicts: conflicts.length,
      rejected: state.rejected.length,
      drift: state.unresolvedDrift.length,
      bootstrap: false,
    }
  } catch (error) {
    // 迁移本身有效;对账失败只降级本轮(下次启动重试),绝不误报迁移失败。
    return { status: "reconcile-failed", reason: error instanceof Error ? error.message : String(error) }
  } finally {
    try {
      fs.rmSync(path.join(targetRoot, RECONCILE_STAGING_DIR), { recursive: true, force: true })
    } catch {
      /* 残骸下轮清 */
    }
  }
}

/**
 * 执行(或跳过)一次环境导入。receipt 是「全部完成」的唯一凭证:任何条目失败都不写 receipt,
 * 下次启动整体重试(已就位条目逐条 already-present 跳过)。receipt 在场且身份匹配 → 转入
 * rollback 期对账(#304);身份不匹配/结构损坏 → 按缺失处理,重跑自愈。
 */
export function runEnvMigration(input: RunEnvMigrationInput): EnvMigrationOutcome {
  const { sourceRoot, targetRoot, userDataPath } = input
  if (isPathUnder(targetRoot, sourceRoot) && isPathUnder(sourceRoot, targetRoot)) {
    return { status: "skipped-same-root" } // dev/覆盖态:环境根 = 旧根,无需导入
  }
  const existing = readEnvMigrationReceipt(targetRoot)
  if (
    existing &&
    existing.environment === input.environment &&
    isSamePath(existing.sourceRoot, sourceRoot) &&
    isSamePath(existing.targetRoot, targetRoot)
  ) {
    return { status: "already-migrated", receipt: existing, reconcile: reconcileRollbackEra(existing, input) }
  }

  const warnings: string[] = []
  if (existing) {
    warnings.push(
      `receipt identity mismatch (env "${existing.environment}" → "${input.environment}") — re-running migration (already-present self-heal)`,
    )
  }
  // receipt 缺失/无效/身份不匹配,但旧根标记证明本环境此前迁移过 → 恢复路径禁用 child 级合并。
  const priorMigrationEvidence = markerShowsPriorMigration(sourceRoot, input.environment, targetRoot)
  if (priorMigrationEvidence) {
    warnings.push("prior migration evidenced by rollback marker — child-level merge disabled (report-only recovery)")
  }
  const source: SourceInventoryEntry[] = []
  const results: ItemOutcome[] = []
  const rederived: SecretRefRecord[] = []
  const dropped: SecretRefDropped[] = []
  const mergeFailed: RejectedRef[] = []
  const mergedChildren: string[] = []
  let pathsRewritten = 0
  let importedAny = false

  try {
    fs.mkdirSync(targetRoot, { recursive: true })
  } catch (error) {
    return { status: "failed", reason: `cannot create environment root: ${String(error)}`, warnings }
  }

  for (const name of ENV_MIGRATION_ITEMS) {
    const inv = inventoryOf(sourceRoot, name)
    source.push(inv)
    if (inv.kind === "absent") {
      results.push({ name, outcome: "absent" })
      continue
    }
    // #304:顶层条目本身是 symlink/非常规类型 → 按策略拒绝(记账),不再放倒整次迁移。
    if (inv.kind === "symlink" || inv.kind === "special") {
      results.push({ name, outcome: inv.kind === "symlink" ? "rejected-symlink" : "rejected-special" })
      warnings.push(`"${name}" rejected: top-level item is a ${inv.kind} (legacy-root references are not imported)`)
      continue
    }
    const final = path.join(targetRoot, name)
    const tmp = final + MIGRATING_SUFFIX
    if (isLstatPresent(final)) {
      // 上次 rename 之后崩溃(或用户先建)→ 不覆盖(用户/既有内容红线),记 already-present。
      // #304:目标目录已存在时做 child 级不覆盖合并 —— 旧根独有子条目不再静默漏掉。
      results.push({ name, outcome: "already-present" })
      if (priorMigrationEvidence) {
        // receipt 丢失/身份不匹配但标记证明此前迁移过:定序史已失,child 级合并会复活环境侧
        // 删除 —— 跳过合并,旧根独有子条目交给后续 bootstrap 对账只报告(防复活优先)。
        continue
      }
      if (inv.kind === "dir" && (ENV_MIGRATION_DIR_ITEMS as readonly string[]).includes(name)) {
        const env = listEnvChildren(targetRoot, name)
        if (env !== null) {
          let entries: string[] = []
          try {
            entries = fs.readdirSync(path.join(sourceRoot, name)).sort()
          } catch {
            /* 不可读:跳过合并 */
          }
          for (const childName of entries) {
            if (env.names.has(childName) || env.aliases.has(aliasKey(childName))) continue
            const kind = childKindOfPath(path.join(sourceRoot, name, childName))
            if (kind === "symlink" || kind === "special") continue // state 重算时统一进 rejected
            const r = importChildGuarded(sourceRoot, targetRoot, name, childName, warnings)
            if (r.ok) {
              mergedChildren.push(`${name}/${childName}`)
              env.names.add(childName)
              env.aliases.add(aliasKey(childName))
              importedAny = true
            } else {
              // 失败不定序:从基线 lastObserved 剔除,下次启动对账重试。
              mergeFailed.push({
                item: name,
                name: childName,
                kind,
                reason: r.reason ?? "import failed",
                fp: fingerprintTree(path.join(sourceRoot, name, childName)),
              })
              warnings.push(`merge of "${name}/${childName}" failed (will retry on next launch): ${r.reason}`)
            }
          }
        }
      }
      continue
    }
    try {
      fs.rmSync(tmp, { recursive: true, force: true }) // 上次崩溃残留的半成品:重拷
      if (inv.kind === "file") {
        const raw = fs.readFileSync(path.join(sourceRoot, name), "utf8")
        let text = raw
        if (name === "alpha.jsonc") {
          const t = transformAlphaJsoncForEnv(raw, { sourceRoot, targetRoot, userDataPath })
          text = t.text
          pathsRewritten += t.pathsRewritten
          rederived.push(...t.rederived)
          dropped.push(...t.dropped)
          warnings.push(...t.warnings)
        } else if (name === "installs.json") {
          const t = transformInstallsJsonForEnv(raw, { sourceRoot, targetRoot })
          text = t.text
          pathsRewritten += t.pathsRewritten
          warnings.push(...t.warnings)
        }
        fs.writeFileSync(tmp, text, "utf8")
        fsyncFileSync(tmp)
      } else {
        const src = path.join(sourceRoot, name)
        copyTreeGuarded(src, tmp, src, fs.realpathSync(src), name, (rel, kind, reason) => {
          warnings.push(`"${name}/${rel}" rejected: ${reason} (${kind})`)
        })
        revalidateAndSyncStaged(tmp)
      }
      renameAtomicSync(tmp, final)
      results.push({ name, outcome: "imported" })
      importedAny = true
    } catch (error) {
      // 单项失败 → 不写 receipt(下次整体重试);tmp 残骸留给下次清理。
      return {
        status: "failed",
        reason: `import of "${name}" failed: ${error instanceof Error ? error.message : String(error)}`,
        warnings,
      }
    }
  }

  const migratedAt = (input.now ?? (() => new Date()))().toISOString()
  // #304:迁移即建立对账基线(观察 source;copy 不改 source,任何时点观察等价)。
  const observed = observeAllItems(sourceRoot)
  const { legacyOnly, conflicts } = computeReports(observed, targetRoot)
  // 合并失败的子条目不定序(从 lastObserved 剔除)→ 下次启动对账重试。
  const settled = JSON.parse(JSON.stringify(observed)) as Record<EnvMigrationItem, ItemObservation>
  for (const f of mergeFailed) {
    const it = settled[f.item]
    if (it.kind === "dir") it.children = it.children.filter((c) => c.name !== f.name)
  }
  const reconcileState: EnvReconcileState = {
    baselineAt: migratedAt,
    bootstrap: false,
    baseline: observed,
    lastObserved: settled,
    lastReconcile: { at: migratedAt, appVersion: input.appVersion, imported: mergedChildren },
    legacyOnly,
    conflicts,
    rejected: [...mergeFailed, ...collectRejectedFromObservation(observed)],
    unresolvedDrift: [],
  }
  const receipt: EnvMigrationReceipt = {
    v: ENV_MIGRATION_VERSION,
    environment: input.environment,
    appVersion: input.appVersion,
    migratedAt,
    sourceRoot,
    targetRoot,
    source,
    results,
    secretRefs: { rederived, dropped },
    pathsRewritten,
    warnings,
    reconcile: reconcileState,
  }

  if (importedAny) writeRollbackMarker(sourceRoot, input.environment, receipt, warnings)

  try {
    writeReceiptAtomic(targetRoot, receipt)
  } catch (error) {
    return { status: "failed", reason: `receipt write failed: ${String(error)}`, warnings }
  }
  return { status: "migrated", receipt }
}
