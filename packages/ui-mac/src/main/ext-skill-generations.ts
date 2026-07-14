// ext-skill-generations — REQ-100 #310:把 skill 生产安装/更新路由进不可变 generation。
//
// 现状问题(审计 6/6 AC FAIL):1246 行事务引擎 runExtensionTransaction 生产零调用;planner 走
// passthroughTx + 直写 ~/.alpha/skills/<name> + 各自写 V1 receipt,更新不清旧文件、账本写失败仍
// 报成功。本模块把 skill(builtin/remote)安装收敛成:纯 staging 填充(去 receipt 化)→ 引擎事务
// (staging→verify→materialize→switch)→ commitReceipt=upsertRecordV2(写失败即事务失败 = 折入
// #336)。物理真源 = <root>/ext-store/skill--<name>/generations/<genId>,current.json 原子指针。
// 发现层由 skillGenerationLiveDirs 投影(见 config hook 注入 skills.paths)。

import * as crypto from "node:crypto"
import * as fs from "node:fs"
import * as path from "node:path"
import type { AppEnvironment } from "./alpha-environment"
import {
  extensionStorePaths,
  resolveLiveGenerationDir,
  runExtensionTransaction,
  type TxCommitRecord,
  type TxFileSpec,
  type TxHooks,
  type TxPlan,
} from "./ext-transaction"
import { upsertRecordsV2, type ScopeIdentity } from "./ext-receipt-v2"
import type { InstallReceiptOrigin } from "../preload/types"

const SAFE_NAME = /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,63}$/
const STORE_DIR = "ext-store"

/** fs-safe 扩展 key(引擎按此建 generation 目录)。 */
export function skillGenerationKey(name: string): string {
  return `skill--${name}`
}

/** 单个 skill 的载荷:POSIX 相对路径 + 内容。builtin(读 srcDir)与 remote(内存 buffer)都归一到此。 */
export type SkillPayloadFile = { path: string; data: Buffer }

/** 递归枚举 srcDir 为载荷(跳过 symlink;POSIX 相对路径)。用于 builtin skill(随包目录)。 */
export function collectSkillPayloadFromDir(srcDir: string): { ok: true; files: SkillPayloadFile[] } | { ok: false; reason: string } {
  const files: SkillPayloadFile[] = []
  const walk = (relDir: string): string | null => {
    const abs = relDir ? path.join(srcDir, relDir) : srcDir
    for (const entry of fs.readdirSync(abs, { withFileTypes: true })) {
      const rel = relDir ? `${relDir}/${entry.name}` : entry.name
      if (entry.isSymbolicLink()) return `symlink not allowed: ${rel}`
      if (entry.isDirectory()) {
        const err = walk(rel)
        if (err) return err
      } else if (entry.isFile()) {
        files.push({ path: rel, data: fs.readFileSync(path.join(srcDir, rel)) })
      } else {
        return `unsupported entry: ${rel}`
      }
    }
    return null
  }
  try {
    const err = walk("")
    if (err) return { ok: false, reason: err }
  } catch (error) {
    return { ok: false, reason: error instanceof Error ? error.message : "failed to read skill dir" }
  }
  if (files.length === 0) return { ok: false, reason: "skill payload is empty" }
  return { ok: true, files }
}

/** 从载荷派生 TxFileSpec[](引擎 verify 会精确匹配 staging 与此:缺一/多一/哈希不符均拒)。 */
function specsOf(files: SkillPayloadFile[]): TxFileSpec[] {
  return files.map((f) => ({
    path: f.path,
    sha256: crypto.createHash("sha256").update(f.data).digest("hex"),
    size: f.data.length,
  }))
}

export type SkillGenerationInstall = {
  name: string
  /** catalog entry id 或 user:<name>。 */
  id: string
  environment: AppEnvironment
  scope: ScopeIdentity
  origin: InstallReceiptOrigin
  files: SkillPayloadFile[]
  version?: string
  manifestDigest?: string
  payloadDigest?: string
  grantDigest?: string
}

export type SkillGenerationResult =
  | { ok: true; generationDir: string; files: string[] }
  | { ok: false; reason: string; stage?: string }

/**
 * 把一个 skill 装进不可变 generation。commitReceipt 写失败 → 抛错 → 引擎 rollbackAll+quarantine
 * (REQ-100 #336:账本写失败绝不谎报成功)。成功后清除同名 flat 安装(supersede,防双真源)。
 */
export async function installSkillGeneration(root: string, spec: SkillGenerationInstall): Promise<SkillGenerationResult> {
  if (!SAFE_NAME.test(spec.name)) return { ok: false, reason: `invalid skill name: ${spec.name}` }
  if (spec.files.length === 0) return { ok: false, reason: "skill payload is empty" }
  const key = skillGenerationKey(spec.name)
  const now = new Date().toISOString()

  const plan: TxPlan = {
    items: [{ key, files: specsOf(spec.files), ...(spec.manifestDigest ? { manifestDigest: spec.manifestDigest } : {}) }],
  }
  const hooks: TxHooks = {
    populate: (_item, stagingDir) => {
      for (const f of spec.files) {
        const dst = path.join(stagingDir, ...f.path.split("/"))
        fs.mkdirSync(path.dirname(dst), { recursive: true })
        fs.writeFileSync(dst, f.data)
      }
    },
    // 账本是事务的提交证据:写失败必须抛错,引擎据此 rollback+quarantine(#336),receipt 与 live 永不背离。
    // 批量单写(#311):多条 record 一次读全校验一次落盘,不留半套 receipt(单 skill 时退化为一条)。
    commitReceipt: (records: TxCommitRecord[]) => {
      const written = upsertRecordsV2(
        root,
        records.map((rec) => ({
          id: spec.id,
          name: spec.name,
          kind: "skill" as const,
          environment: spec.environment,
          scope: spec.scope,
          ...(spec.version ? { version: spec.version } : {}),
          ...(rec.manifestDigest ? { manifestDigest: rec.manifestDigest } : {}),
          ...(spec.payloadDigest ? { payloadDigest: spec.payloadDigest } : {}),
          ...(spec.grantDigest ? { grantDigest: spec.grantDigest } : {}),
          desiredState: "enabled" as const,
          origin: spec.origin,
          files: [rec.generationDir],
          transaction: { id: rec.txId, state: "committed" as const },
          installedAt: now,
        })),
      )
      if (!written.ok) throw new Error(`receipt commit failed for skill ${spec.name}: ${written.reason}`)
    },
  }

  const result = await runExtensionTransaction(root, plan, hooks)
  if (!result.ok) return { ok: false, reason: result.reason, stage: result.stage }

  // supersede:清除本 skill 的旧 flat 安装(我们上一版直写的 ~/.alpha/skills/<name>),防与 generation
  // 双真源(重名 skill 静默覆盖)。只删同名——即我们自己拥有的先前安装,不碰其它内容。best-effort。
  const flat = path.join(root, "skills", spec.name)
  try {
    if (fs.existsSync(flat)) fs.rmSync(flat, { recursive: true, force: true })
  } catch {
    /* 残留 flat 目录不影响 generation 真源;projection 以 generation 为准。 */
  }

  const live = resolveLiveGenerationDir(root, key)
  return { ok: true, generationDir: live ?? "", files: live ? [live] : [] }
}

/**
 * 枚举所有 skill generation 的 live 目录(current.json 指针解析)。发现层把这些注入 skills.paths
 * (见 ext plugin config hook),使引擎经 generation 真源发现用户装的技能。 */
export function skillGenerationLiveDirs(root: string): string[] {
  const storeRoot = path.join(root, STORE_DIR)
  let entries: fs.Dirent[]
  try {
    entries = fs.readdirSync(storeRoot, { withFileTypes: true })
  } catch {
    return [] // 无 store = 无 generation 安装
  }
  const dirs: string[] = []
  for (const entry of entries) {
    if (!entry.isDirectory() || !entry.name.startsWith("skill--")) continue
    const live = resolveLiveGenerationDir(root, entry.name)
    if (live) dirs.push(live)
  }
  return dirs.sort()
}

/** 便利:某 skill 是否已有 generation 安装(供发现层/迁移判定 flat vs generation)。 */
export function hasSkillGeneration(root: string, name: string): boolean {
  return resolveLiveGenerationDir(root, skillGenerationKey(name)) !== null
}

// 供测试/发现层派生 store 路径。
export function skillStorePaths(root: string, name: string) {
  return extensionStorePaths(root, skillGenerationKey(name))
}
