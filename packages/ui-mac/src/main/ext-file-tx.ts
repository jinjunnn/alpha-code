// ext-file-tx — REQ-102 #358:单文件落盘的 journaled 事务适配器(config action 的兄弟 action)。
//
// 背景:agent 是「单 md 文件 + alpha.jsonc `agent.<name>` 条目」的组合,不是文件树 generation
// (无 current.json 指针/代数语义),也不是纯配置叶。要让 md 写盘与 config 叶在同一事务里全提交
// 或全回滚,需要一个与 ext-config-tx 同构、但以**字节 + 缺席态**为前像的单文件动作。
//
// 模型(整文件 image 对;与 config 适配器的关键差异 = 前像必须区分「目标缺席」与「存在但零字节」,
// Codex 裁决 #358 B):
//   prepare(target, next) → lstat 读 live 前像(symlink/非常规文件 fail-closed),连同
//                           preAbsent + pre/next digest 返回;
//   stage    → pre(仅存在时)/next 字节写 staging(0600);journal 只记 relTarget/slot/digest/
//              preAbsent,不落内容;
//   apply    → writeFileAtomicSync(target, next)(mkdir + fsync + rename 原语);
//   restore  → 目标当前态(缺席|digest)== next 态才反向恢复(preAbsent → unlink,否则写回 pre);
//              既非 pre 也非 next → 保留证据 + fail closed(有旁路写入过,绝不盲目覆盖)。

import { createHash } from "node:crypto"
import { existsSync, lstatSync, mkdirSync, readFileSync, unlinkSync, writeFileSync, type Stats } from "node:fs"
import { join } from "node:path"
import { writeFileAtomicSync } from "./ext-atomic-fs"

/** 一次单文件变更的 image 对(preAbsent=true 时 preContent 恒为空 buffer,只作占位)。 */
export type FileTxImage = {
  target: string
  preAbsent: boolean
  preContent: Buffer
  nextContent: Buffer
  preDigest: string
  nextDigest: string
}

function digest(data: Buffer): string {
  return createHash("sha256").update(data).digest("hex")
}

/** 无断言的 errno 提取(cast-free:oxlint no-unsafe-type-assertion)。 */
function errnoCode(error: unknown): string | undefined {
  if (typeof error !== "object" || error === null || !("code" in error)) return undefined
  return typeof error.code === "string" ? error.code : undefined
}

/**
 * root 圈禁(#358 review Blocker 2):词法 isSafeRelPath 不够 —— 若 relTarget 的任一**已存在**
 * 前缀段(如 `<root>/agents`)是 symlink,写入会逃逸 root。逐段 lstat 拒 symlink(与
 * verifySeedAsset S6 同纪律);不存在的尾段由 apply 时 mkdir 创建,天然无 symlink。
 */
export function confineFileTarget(root: string, relTarget: string): { ok: true } | { ok: false; reason: string } {
  let cursor = root
  const segments = relTarget.split("/")
  for (const [i, seg] of segments.entries()) {
    cursor = join(cursor, seg)
    let st: Stats
    try {
      st = lstatSync(cursor)
    } catch (error) {
      if (errnoCode(error) === "ENOENT") return { ok: true } // 余段将由 apply mkdir 创建
      return { ok: false, reason: `file target confinement: cannot stat ${cursor}` }
    }
    if (st.isSymbolicLink()) return { ok: false, reason: `file target confinement: symlink in path (refusing): ${cursor}` }
    if (i < segments.length - 1 && !st.isDirectory())
      return { ok: false, reason: `file target confinement: non-directory ancestor (refusing): ${cursor}` }
  }
  return { ok: true }
}

/** 目标当前态:缺席(与零字节文件判然有别)| 内容 digest。读失败 = null(调用方 fail-closed)。 */
function currentState(target: string): { absent: true } | { absent: false; digest: string } | null {
  let st: Stats
  try {
    st = lstatSync(target)
  } catch (error) {
    if (errnoCode(error) === "ENOENT") return { absent: true }
    return null
  }
  if (st.isSymbolicLink() || !st.isFile()) return null
  try {
    return { absent: false, digest: digest(readFileSync(target)) }
  } catch {
    return null
  }
}

/** 计算 image 对。live 前像经 lstat 门(symlink/非常规文件写盘前 fail-closed)。 */
export function prepareFileTx(target: string, next: Buffer): { ok: true; image: FileTxImage } | { ok: false; reason: string } {
  let preAbsent = false
  let preContent = Buffer.alloc(0)
  let st: Stats | null = null
  try {
    st = lstatSync(target)
  } catch (error) {
    if (errnoCode(error) !== "ENOENT")
      return { ok: false, reason: `file tx: cannot stat target: ${error instanceof Error ? error.message : String(error)}` }
    preAbsent = true
  }
  if (st) {
    if (st.isSymbolicLink() || !st.isFile()) return { ok: false, reason: `file tx: target is not a regular file (refusing): ${target}` }
    try {
      preContent = readFileSync(target)
    } catch (error) {
      return { ok: false, reason: `file tx: cannot read target preimage: ${error instanceof Error ? error.message : String(error)}` }
    }
  }
  return {
    ok: true,
    image: { target, preAbsent, preContent, nextContent: next, preDigest: digest(preContent), nextDigest: digest(next) },
  }
}

/** staging 里 pre/next 字节的落点(0600;journal 只引用受控相对文件名 + digest,不含内容)。 */
export function fileStagePaths(stagingDir: string, slot: number): { pre: string; next: string } {
  return { pre: join(stagingDir, `file-${slot}.pre`), next: join(stagingDir, `file-${slot}.next`) }
}

/** 把 image 对写进 staging(preAbsent 时不落 .pre —— 缺席态由 journal preAbsent 标记权威)。 */
export function stageFileImage(stagingDir: string, slot: number, image: FileTxImage): void {
  mkdirSync(stagingDir, { recursive: true })
  const { pre, next } = fileStagePaths(stagingDir, slot)
  if (!image.preAbsent) writeFileSync(pre, image.preContent, { mode: 0o600 })
  writeFileSync(next, image.nextContent, { mode: 0o600 })
}

/** switch 阶段:原子落 next(mkdir + fsync + rename;live 要么旧态要么新态,无半写)。 */
export function applyFileImage(image: FileTxImage): void {
  writeFileAtomicSync(image.target, image.nextContent)
}

/**
 * 回滚:仅当目标当前态 == next 态(我们的 switch 已应用且无旁路覆盖)才恢复前像 ——
 * preAbsent → unlink(恢复缺席态),否则写回 pre 字节。目标态不可判 / 既非 pre 也非 next
 * (并发旁路写)→ 保留现状 + fail-closed 报告,绝不盲目覆盖。 */
export type FileRestoreOutcome = { ok: true; action: "restored" | "noop" } | { ok: false; reason: string }
export function restoreFileImage(image: FileTxImage): FileRestoreOutcome {
  const cur = currentState(image.target)
  if (!cur) return { ok: false, reason: `restore: cannot read target state: ${image.target}` }
  const isPre = image.preAbsent ? cur.absent : !cur.absent && cur.digest === image.preDigest
  if (isPre) return { ok: true, action: "noop" } // 已是旧态(switch 未应用/已回滚)
  if (!cur.absent && cur.digest === image.nextDigest) {
    if (image.preAbsent) {
      try {
        unlinkSync(image.target)
      } catch (error) {
        if (errnoCode(error) !== "ENOENT")
          return { ok: false, reason: `restore: unlink failed: ${error instanceof Error ? error.message : String(error)}` }
      }
    } else {
      writeFileAtomicSync(image.target, image.preContent)
    }
    return { ok: true, action: "restored" }
  }
  return { ok: false, reason: `restore: target diverged (neither pre nor next state) — refusing to clobber ${image.target}` }
}

/** 恢复期从 staging 重建 image 对(崩溃恢复用;journal 只存 digest + preAbsent,内容在受保护 staging)。 */
export function readStagedFileImage(
  stagingDir: string,
  slot: number,
  target: string,
  preDigest: string,
  nextDigest: string,
  preAbsent: boolean,
): { ok: true; image: FileTxImage } | { ok: false; reason: string } {
  const { pre, next } = fileStagePaths(stagingDir, slot)
  try {
    const nextContent = readFileSync(next)
    if (digest(nextContent) !== nextDigest) return { ok: false, reason: "staged file nextimage digest mismatch" }
    let preContent = Buffer.alloc(0)
    if (preAbsent) {
      // journal 说前像缺席 → staging 里必须没有 .pre(在场即 journal/staging 相互矛盾,fail-closed)。
      if (existsSync(pre)) return { ok: false, reason: "staged file preimage present but journal marks preAbsent" }
    } else {
      preContent = readFileSync(pre)
    }
    if (digest(preContent) !== preDigest) return { ok: false, reason: "staged file preimage digest mismatch" }
    return { ok: true, image: { target, preAbsent, preContent, nextContent, preDigest, nextDigest } }
  } catch (error) {
    return { ok: false, reason: `cannot read staged file images: ${error instanceof Error ? error.message : String(error)}` }
  }
}
