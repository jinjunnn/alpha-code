// REQ-098 T3:旧 `~/.alpha` 单根布局 → 当前环境 mutable root 的版本化兼容迁移(issue #190)。
//
// 语义(AC#3/#4 契约):
//   - 只读导入:source(旧布局)只读,绝不修改/删除用户文件;唯一 additive 写入 = rollback 标记
//     (新文件,read-modify-write + 原子替换);
//   - 幂等:receipt 在场 → 整体 no-op;receipt 缺失但条目已就位 → 逐条 already-present 跳过
//     (回滚→再升级不重复复制、不丢状态);
//   - crash 可重试:每条目 copy 进 `<name>.alpha-migrating` 临时名后原子 rename;中途崩溃只留
//     tmp 残骸,重跑先清 tmp 再补拷;receipt 最后原子落盘 —— receipt 即「全部完成」的唯一凭证;
//   - 路径再归属:导入的 alpha.jsonc / installs.json 里凡指向旧根的绝对路径(plugin[]、skills.paths、
//     receipts.files[] 等)一律改写到环境根 —— 环境内绝不引用另一环境/旧根的可变内容;
//   - 旧 MCP secret 绝对路径(REQ-098 交付⑤):`{file:}` 引用若指向当前 userData/环境根之外
//     (= 另一环境的 userData),读出原值重新派生进当前环境的 alpha-mcp-secrets;不可读则整键
//     摘除并记账(fail-closed:宁可缺配置,不可跨环境引用)。
//
// electron-free(root/userData 全注入),AC#5:路径比较对空格/Unicode 天然安全(不做字符串猜测),
// Windows 盘符/反斜杠由 normalizeForCompare 归一(纯字符串逻辑,darwin 上可测)。

import * as fs from "node:fs"
import * as path from "node:path"
import { applyEdits, modify, parse } from "jsonc-parser"
import { writeMcpSecret } from "./alpha-mcp-secrets"

export const ENV_MIGRATION_VERSION = 1
export const ENV_MIGRATION_RECEIPT_FILE = "env-migration-receipt.json"
export const ENV_ROLLBACK_MARKER_FILE = ".alpha-env-rollback.json"
const MIGRATING_SUFFIX = ".alpha-migrating"

/** 旧布局里参与导入的条目(REQ-098 目标③点名的五件)。 */
export const ENV_MIGRATION_ITEMS = ["alpha.jsonc", "installs.json", "skills", "agents", "plugins"] as const
export type EnvMigrationItem = (typeof ENV_MIGRATION_ITEMS)[number]

export type SourceInventoryEntry = {
  name: EnvMigrationItem
  kind: "file" | "dir" | "absent"
  bytes?: number
  entries?: number
}

export type ItemOutcome = { name: EnvMigrationItem; outcome: "imported" | "already-present" | "absent" }

export type SecretRefRecord = { server: string; key: string }
export type SecretRefDropped = SecretRefRecord & { reason: string }

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
}

export type EnvMigrationOutcome =
  | { status: "skipped-same-root" }
  | { status: "already-migrated"; receipt: EnvMigrationReceipt }
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

// ── 拷贝(symlink 原样保留,不解引用;模式位保留)──────────────────────────────────────────

function copyTree(src: string, dst: string): void {
  const st = fs.lstatSync(src)
  if (st.isSymbolicLink()) {
    fs.symlinkSync(fs.readlinkSync(src), dst)
    return
  }
  if (st.isDirectory()) {
    fs.mkdirSync(dst, { recursive: true })
    for (const entry of fs.readdirSync(src)) copyTree(path.join(src, entry), path.join(dst, entry))
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
  if (st.isDirectory()) {
    let entries = 0
    try {
      entries = fs.readdirSync(p).length
    } catch {
      /* 不可读目录按 0 计 */
    }
    return { name, kind: "dir", entries }
  }
  return { name, kind: "file", bytes: st.size }
}

function writeFileAtomic(file: string, data: string): void {
  const tmp = `${file}.tmp-${process.pid}`
  fs.writeFileSync(tmp, data, "utf8")
  fs.renameSync(tmp, file)
}

export function envMigrationReceiptPath(targetRoot: string): string {
  return path.join(targetRoot, ENV_MIGRATION_RECEIPT_FILE)
}

export function readEnvMigrationReceipt(targetRoot: string): EnvMigrationReceipt | null {
  try {
    const parsed = JSON.parse(fs.readFileSync(envMigrationReceiptPath(targetRoot), "utf8")) as EnvMigrationReceipt
    if (parsed && typeof parsed === "object" && parsed.v === ENV_MIGRATION_VERSION) return parsed
    return null
  } catch {
    return null
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
    writeFileAtomic(file, JSON.stringify(marker, null, 2) + "\n")
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

/**
 * 执行(或跳过)一次环境导入。receipt 是「全部完成」的唯一凭证:任何条目失败都不写 receipt,
 * 下次启动整体重试(已就位条目逐条 already-present 跳过)。
 */
export function runEnvMigration(input: RunEnvMigrationInput): EnvMigrationOutcome {
  const { sourceRoot, targetRoot, userDataPath } = input
  if (isPathUnder(targetRoot, sourceRoot) && isPathUnder(sourceRoot, targetRoot)) {
    return { status: "skipped-same-root" } // dev/覆盖态:环境根 = 旧根,无需导入
  }
  const existing = readEnvMigrationReceipt(targetRoot)
  if (existing) return { status: "already-migrated", receipt: existing }

  const warnings: string[] = []
  const source: SourceInventoryEntry[] = []
  const results: ItemOutcome[] = []
  const rederived: SecretRefRecord[] = []
  const dropped: SecretRefDropped[] = []
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
    const final = path.join(targetRoot, name)
    const tmp = final + MIGRATING_SUFFIX
    if (fs.existsSync(final)) {
      // 上次 rename 之后崩溃(或用户先建)→ 不覆盖(用户/既有内容红线),记 already-present。
      results.push({ name, outcome: "already-present" })
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
      } else {
        copyTree(path.join(sourceRoot, name), tmp)
      }
      fs.renameSync(tmp, final)
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

  const receipt: EnvMigrationReceipt = {
    v: ENV_MIGRATION_VERSION,
    environment: input.environment,
    appVersion: input.appVersion,
    migratedAt: (input.now ?? (() => new Date()))().toISOString(),
    sourceRoot,
    targetRoot,
    source,
    results,
    secretRefs: { rederived, dropped },
    pathsRewritten,
    warnings,
  }

  if (importedAny) writeRollbackMarker(sourceRoot, input.environment, receipt, warnings)

  try {
    writeFileAtomic(envMigrationReceiptPath(targetRoot), JSON.stringify(receipt, null, 2) + "\n")
  } catch (error) {
    return { status: "failed", reason: `receipt write failed: ${String(error)}`, warnings }
  }
  return { status: "migrated", receipt }
}
