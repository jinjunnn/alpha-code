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
  listGenerations,
  readGenerationReceiptSnapshot,
  resolveLiveGenerationDir,
  rollbackGenerationTransaction,
  runExtensionTransaction,
  type HealthProbe,
  type TxAuthorizationDecision,
  type TxCommitRecord,
  type TxFileSpec,
  type TxHooks,
  type TxPlan,
  type TxStage,
} from "./ext-transaction"
import type { CapabilityDiff } from "./ext-capability-grants"
import { populateFromCas } from "./ext-cas"
import { findRecordV2, upsertRecordsV2, upsertRecordV2, type ScopeIdentity, type UpsertInput } from "./ext-receipt-v2"
import { parseSkillFrontmatter } from "./ext-import-validate"
import type { InstallReceiptOrigin } from "../preload/types"

const SAFE_NAME = /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,63}$/
const STORE_DIR = "ext-store"

/** fs-safe 扩展 key(引擎按此建 generation 目录)。 */
export function skillGenerationKey(name: string): string {
  return `skill--${name}`
}

/** 类型化 skill 健康探测(REQ-100 #312):generation 目录里 SKILL.md 必须可发现且 frontmatter name
 *  与 key 匹配(防 shadowing)。pre-switch 失败 → abort+隔离;post-switch/recovery 失败 → 回滚+隔离。 */
export const skillGenerationProbe: HealthProbe = (input) => {
  if (input.action !== "generation") return { healthy: true } // 非 generation 由各自路径管
  const name = input.key.startsWith("skill--") ? input.key.slice("skill--".length) : input.key
  let text: string
  try {
    text = fs.readFileSync(path.join(input.generationDir, "SKILL.md"), "utf8")
  } catch {
    return { healthy: false, reason: `skill "${name}": SKILL.md not discoverable in generation ${input.genId}` }
  }
  const fm = parseSkillFrontmatter(text)
  if (!fm.ok) return { healthy: false, reason: `skill "${name}": ${fm.reason}` }
  if (fm.name !== name) return { healthy: false, reason: `skill frontmatter name "${fm.name}" ≠ key "${name}" (shadowing guard)` }
  return { healthy: true }
}

/** 列出某 skill 的物理 generation + 快照元数据(REQ-100 #313:两版离线回滚候选。current+保留代)。
 *  eligible = 有可读快照(能复原 receipt)。dir 不外泄(IPC 层只透安全元数据)。 */
export type SkillGenerationEntry = { genId: string; current: boolean; version?: string; manifestDigest?: string; installedAt?: string; eligible: boolean }
export function listSkillGenerations(root: string, name: string): SkillGenerationEntry[] {
  const key = skillGenerationKey(name)
  return listGenerations(root, key).map((g) => {
    const snap = readGenerationReceiptSnapshot(root, key, g.genId)
    const r = snap?.receipt as Partial<UpsertInput> | undefined
    return {
      genId: g.genId,
      current: g.current,
      ...(r?.version ? { version: r.version } : {}),
      ...(r?.manifestDigest ? { manifestDigest: r.manifestDigest } : {}),
      ...(r?.installedAt ? { installedAt: r.installedAt } : {}),
      eligible: snap !== null,
    }
  })
}

/**
 * 两版离线回滚(REQ-100 #313):把某 skill 的 live generation 翻回目标物理 gen。probe 验目标健康 +
 * 读目标快照构造新 receipt 修订(逻辑 generation 递增、previousDigest 指回滚前、desiredState 用当前策略,
 * 不被旧快照 clobber)→ 锁内翻指针 + 落新修订。任一前置失败零变更;崩溃恢复从 journal receipt 前滚。 */
export async function rollbackSkillGeneration(
  root: string,
  name: string,
  targetGenId: string,
): Promise<{ ok: true; previous: string | null } | { ok: false; reason: string }> {
  if (!SAFE_NAME.test(name)) return { ok: false, reason: `invalid skill name: ${name}` }
  const key = skillGenerationKey(name)
  return rollbackGenerationTransaction(root, key, targetGenId, {
    probe: skillGenerationProbe,
    resolveReceipt: (target) => {
      const snap = readGenerationReceiptSnapshot(root, key, target)
      if (!snap) return null
      const base = snap.receipt as UpsertInput
      const current = findRecordV2(root, "skill", name)
      return {
        ...base,
        generation: (current?.generation ?? base.generation ?? 0) + 1, // 逻辑号递增,不倒退
        ...(current?.manifestDigest ? { previousDigest: current.manifestDigest } : {}),
        desiredState: current?.desiredState ?? base.desiredState, // 当前策略优先(旧快照不覆盖)
      } satisfies UpsertInput
    },
    commitReceipt: (rec) => {
      const w = upsertRecordV2(root, commitInputFromRecord(rec))
      if (!w.ok) throw new Error(w.reason)
    },
  })
}

/** 从 commit record 的 receipt 模板重建 upsert 输入(forward 与 crash-recovery 前滚同源,REQ-100 #312)。 */
export function commitInputFromRecord(rec: TxCommitRecord): UpsertInput {
  const template = (rec.receipt ?? {}) as UpsertInput
  return {
    ...template,
    ...(rec.generationDir ? { files: [rec.generationDir] } : {}),
    transaction: { id: rec.txId, state: "committed" },
  }
}

/** 单个 skill 的载荷:POSIX 相对路径 + 内容。builtin(读 srcDir)与 remote(内存 buffer)都归一到此。 */
export type SkillPayloadFile = { path: string; data: Buffer }

/** 递归枚举 srcDir 为载荷(跳过 symlink;POSIX 相对路径)。用于 builtin skill(随包目录)。 */
export function collectSkillPayloadFromDir(
  srcDir: string,
  // #378 r17(Major):读取**前**按 fstat.size 执行的帽 —— 全树读入内存后再拒,结构化拒绝
  // 之前 main 进程可能已被超大载荷拖垮。缺省不设帽(既有 skill 调用方语义不变)。
  caps?: { maxFileBytes: number; maxTotalBytes: number },
): { ok: true; files: SkillPayloadFile[] } | { ok: false; reason: string } {
  const files: SkillPayloadFile[] = []
  let total = 0
  // r18:定长读 + 增长探测 —— fstat 后 inode 仍可增长,readFileSync(fd) 按当前大小分配会绕过
  // 已执行的帽;只读 fstat 时的字节数,读毕再探 1 字节,有余量 = 文件在变,拒。
  const readFdBounded = (fd: number, size: number): Buffer | null => {
    const buf = Buffer.alloc(size)
    let off = 0
    while (off < size) {
      const n = fs.readSync(fd, buf, off, size - off, off)
      if (n <= 0) return null
      off += n
    }
    const probe = Buffer.alloc(1)
    return fs.readSync(fd, probe, 0, 1, size) > 0 ? null : buf
  }
  const walk = (relDir: string): string | null => {
    const abs = relDir ? path.join(srcDir, relDir) : srcDir
    for (const entry of fs.readdirSync(abs, { withFileTypes: true })) {
      const rel = relDir ? `${relDir}/${entry.name}` : entry.name
      if (entry.isSymbolicLink()) return `symlink not allowed: ${rel}`
      if (entry.isDirectory()) {
        const err = walk(rel)
        if (err) return err
      } else if (entry.isFile()) {
        // r17(Major):Dirent 判定与按路径 readFileSync 之间可被换成 symlink —— O_NOFOLLOW fd
        // 绑定身份后 fstat 复验 + 从同一 fd 读取,绝不追随检查后换入的链接。
        let fd: number
        try {
          fd = fs.openSync(path.join(srcDir, rel), fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW)
        } catch {
          return `unreadable file (symlink swap?): ${rel}`
        }
        try {
          const st = fs.fstatSync(fd)
          if (!st.isFile()) return `unsupported entry: ${rel}`
          if (caps && st.size > caps.maxFileBytes) return `payload file "${rel}" exceeds ${caps.maxFileBytes} bytes — refused`
          if (caps && total + st.size > caps.maxTotalBytes) return `payload exceeds ${caps.maxTotalBytes} bytes total — refused`
          total += st.size
          const data = readFdBounded(fd, st.size)
          if (data === null) return `file changed while reading: ${rel}`
          files.push({ path: rel, data })
        } finally {
          fs.closeSync(fd)
        }
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
export type SkillGenerationInstall = {
  name: string
  /** catalog entry id 或 user:<name>。 */
  id: string
  environment: AppEnvironment
  scope: ScopeIdentity
  origin: InstallReceiptOrigin
  /** 唯一内容源(REQ-098 #303 收紧 CAS-only,Codex 裁决 C:buffer 直填旁路永久移除):调用方先把
   *  载荷提升进验证共享 CAS,staging 由 populateFromCas 物化(读取重验)。journal 只存 TxFileSpec,
   *  与来源无关 —— buffer 时代 journal 的恢复语义不受影响(恢复不重 populate)。 */
  casFiles: { specs: TxFileSpec[]; casBaseRoot: string }
  /** #348:进入事务引擎的能力集(已验 manifest.capabilities)。**必填** —— 可选字段被安静遗漏
   *  正是本票修的缺口(Codex 裁决 A1);真正无能力也要显式传 []。空集 = authorize 闸静默通过。 */
  capabilities: string[]
  /** #348:authorize 重驱决定(main 打戳 decidedAt 后透传引擎 plan.authorization)。 */
  authorization?: TxAuthorizationDecision
  version?: string
  manifestDigest?: string
  payloadDigest?: string
  grantDigest?: string
  /** 锁内业务前置(透传引擎 TxHooks.precondition):持 Bundle 锁后、写盘前执行(REQ-102 #317
   *  downgrade 门在此重读账本判定,封死锁外 TOCTOU)。 */
  precondition?: () => { ok: true } | { ok: false; reason: string }
}

export type SkillGenerationResult =
  | { ok: true; generationDir: string; files: string[] }
  /** #348:authorize 暂停不是失败 —— 零权威副作用,携带逐 item diff 等确认重驱(Codex 裁决 C1:
   *  判别分支强制携带 diff,不允许 stage 折叠成裸字符串丢数据)。 */
  | { ok: false; stage: "authorize"; reason: string; authorization: CapabilityDiff[] }
  | { ok: false; reason: string; stage?: Exclude<TxStage, "authorize"> }

/**
 * 把一个 skill 装进不可变 generation。commitReceipt 写失败 → 抛错 → 引擎 rollbackAll+quarantine
 * (REQ-100 #336:账本写失败绝不谎报成功)。成功后清除同名 flat 安装(supersede,防双真源)。
 */
export async function installSkillGeneration(root: string, spec: SkillGenerationInstall): Promise<SkillGenerationResult> {
  if (!SAFE_NAME.test(spec.name)) return { ok: false, reason: `invalid skill name: ${spec.name}` }
  // 唯一内容源 = 验证共享 CAS(REQ-098 #303);casFiles 畸形(null / specs 非数组 / casBaseRoot
  // 非法)= 结构化拒绝,不抛未捕获异常。
  const cas = spec.casFiles as unknown
  if (
    !cas ||
    typeof cas !== "object" ||
    !Array.isArray((cas as { specs?: unknown }).specs) ||
    typeof (cas as { casBaseRoot?: unknown }).casBaseRoot !== "string" ||
    !path.isAbsolute((cas as { casBaseRoot: string }).casBaseRoot)
  )
    return { ok: false, reason: "invalid casFiles content source (specs array + absolute casBaseRoot required)" }
  const txFiles: TxFileSpec[] = spec.casFiles.specs
  if (txFiles.length === 0) return { ok: false, reason: "skill payload is empty" }
  const key = skillGenerationKey(spec.name)
  const now = new Date().toISOString()

  // receipt 模板持久化进 plan/journal(REQ-100 #312):forward 与 crash-recovery 前滚同源落账。
  const receiptTemplate: UpsertInput = {
    id: spec.id,
    name: spec.name,
    kind: "skill",
    environment: spec.environment,
    scope: spec.scope,
    ...(spec.version ? { version: spec.version } : {}),
    ...(spec.manifestDigest ? { manifestDigest: spec.manifestDigest } : {}),
    ...(spec.payloadDigest ? { payloadDigest: spec.payloadDigest } : {}),
    ...(spec.grantDigest ? { grantDigest: spec.grantDigest } : {}),
    desiredState: "enabled",
    origin: spec.origin,
    installedAt: now,
  }
  const plan: TxPlan = {
    // #348:capabilities 进 plan item → 引擎 authorize 闸在锁内评估 diff;authorization 是重驱
    // 决定(引擎按 requested ⊆ confirmed[key] 整集覆盖判定,journal 持久化供崩溃前滚落收据)。
    items: [
      {
        key,
        files: txFiles,
        receipt: receiptTemplate,
        capabilities: spec.capabilities,
        ...(spec.manifestDigest ? { manifestDigest: spec.manifestDigest } : {}),
      },
    ],
    ...(spec.authorization ? { authorization: spec.authorization } : {}),
  }
  // staging 由 populateFromCas 物化(读取重验 digest,缺失/篡改抛错 = 事务 abort);
  // 引擎 verify 随后对 staging 做结构精确校验(纵深)。
  const casPopulate = populateFromCas(spec.casFiles.casBaseRoot)
  const hooks: TxHooks = {
    ...(spec.precondition ? { precondition: spec.precondition } : {}),
    populate: (_item, stagingDir) => casPopulate({ files: txFiles }, stagingDir),
    // 类型化健康探测(REQ-100 #312):generation 落地后、切换前后验 SKILL.md 可发现 + frontmatter name 匹配。
    probe: skillGenerationProbe,
    // 账本是事务的提交证据:写失败必须抛错,引擎据此 rollback+quarantine(#336)。批量单写(#311),
    // 从 rec.receipt 模板重建(与恢复前滚同源,#312):补 files(generationDir)+ committed 事务标记。
    commitReceipt: (records: TxCommitRecord[]) => {
      const written = upsertRecordsV2(root, records.map((rec) => commitInputFromRecord(rec)))
      if (!written.ok) throw new Error(`receipt commit failed for skill ${spec.name}: ${written.reason}`)
    },
  }

  const result = await runExtensionTransaction(root, plan, hooks)
  if (!result.ok) {
    // #348:authorize 判别分支必须带 diff(此前折叠丢弃正是本票缺陷);其余 stage 原样透传。
    if (result.stage === "authorize") {
      if (result.authorization) return { ok: false, stage: "authorize", reason: result.reason, authorization: result.authorization }
      return { ok: false, reason: result.reason } // 引擎契约保证带 diff;缺失时诚实降级,不谎标 stage
    }
    return { ok: false, reason: result.reason, stage: result.stage }
  }

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
