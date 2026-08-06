// ext-config-tx — REQ-100 #311:alpha.jsonc 配置变更的 journaled 事务适配器(bundle 原子的兄弟 action)。
//
// 背景:mcp/plugin 是共享 alpha.jsonc 的配置条目,不是文件树 generation。要让它们与 skill generation
// 在同一事务里 required 全提交或全回滚,需要一个可 journaled + 可回滚的配置动作。现有 writeKey 成功即删
// .bak,无法供 bundle 级回滚;persistMcp/removeMcp 混了 receipt/legacy 清理,removeMcp 补偿会删旧配置
// 而非恢复被覆盖的旧值 —— 都不能直接当 action。
//
// 模型(整文件 image,天然处理「同一份 alpha.jsonc 多条 edit 按序累积」):
//   prepare(target, edits[]) → 读 live 得 preImage,按序 applyEdits 得 nextImage(校验 jsonc),
//                              连同 pre/next digest 返回;多条 edit 塌缩为一次文件切换。
//   stage    → preImage/nextImage 写 staging(0600);journal 只记受控相对路径 + before/after digest,
//              绝不把可能含明文密钥的配置值写进 journal JSON。
//   apply    → writeFileAtomicSync(target, nextImage)(同 ext-transaction 的 fsync+rename 原语)。
//   restore  → 目标仍匹配 after-digest 才反向写回 preImage;否则保留证据 + fail closed(有旁路写入过)。

import * as crypto from "node:crypto"
import * as fs from "node:fs"
import * as path from "node:path"
import { applyEdits, modify, parse, type ParseError } from "jsonc-parser"
import { writeFileAtomicSync } from "./ext-atomic-fs"
import { sealEnginePluginAdditions } from "./engine-plugin-seal"

const ALLOWED_TOP_KEYS = new Set(["mcp", "plugin", "provider", "agent", "command"])

export type ConfigEdit = { keyPath: string[]; value: unknown }

/** 一次配置文件变更的 image 对(preImage=live 原样,nextImage=按序 edit 后)。 */
export type ConfigTxImage = {
  target: string
  preImage: string
  nextImage: string
  preDigest: string
  nextDigest: string
}

function digest(text: string): string {
  return crypto.createHash("sha256").update(text, "utf8").digest("hex")
}

function readTarget(target: string): { ok: true; text: string; existed: boolean } | { ok: false; reason: string } {
  try {
    if (!fs.existsSync(target)) return { ok: true, text: "{}", existed: false }
    return { ok: true, text: fs.readFileSync(target, "utf8"), existed: true }
  } catch (error) {
    return { ok: false, reason: `failed to read config: ${error instanceof Error ? error.message : String(error)}` }
  }
}

/**
 * 计算一个 image 对。多条 edit 按序应用到累积文本(不各自从 live 独立算),最终 nextImage 反映全部。
 * 任一 top key 越权或结果非法 jsonc → 拒绝(写盘前 fail-closed)。
 *
 * baseText:同一 target 多个 config action 链式累积用 —— 第 2+ 个 action 以上一个的 nextImage 为
 * 基线(而非各自从 live 独立读),否则后写会覆盖前写。缺省(第一个 action)= 从 live 读。 */
export function prepareConfigTx(
  target: string,
  edits: ConfigEdit[],
  baseText?: string,
): { ok: true; image: ConfigTxImage } | { ok: false; reason: string } {
  if (edits.length === 0) return { ok: false, reason: "config tx has no edits" }
  for (const e of edits) {
    if (!ALLOWED_TOP_KEYS.has(e.keyPath[0] ?? "")) return { ok: false, reason: `refused: unknown config key "${e.keyPath[0]}"` }
  }
  let preImage: string
  if (baseText !== undefined) {
    preImage = baseText
  } else {
    const read = readTarget(target)
    if (!read.ok) return read
    preImage = read.text
  }
  let text = preImage
  for (const e of edits) {
    // jsonc-parser 的 modify 对形状异常的父节点(如 `"agent":"mine"` 下加子键)会**抛异常**而非
    // 返回错误 —— 本适配器在引擎 bundle 锁内运行,异常必须转结构化失败,否则锁不释放
    // (REQ-102 #358 review Major 5)。
    let applied: string
    try {
      applied = applyEdits(text, modify(text, e.keyPath, e.value, { formattingOptions: { tabSize: 2, insertSpaces: true } }))
    } catch (error) {
      return { ok: false, reason: `config edit failed for ${e.keyPath.join(".")}: ${error instanceof Error ? error.message : String(error)}` }
    }
    const errors: ParseError[] = []
    parse(applied, errors)
    if (errors.length > 0) return { ok: false, reason: `resulting config is not valid jsonc after edit ${e.keyPath.join(".")}` }
    text = applied
  }
  // ADR-040 咽喉(计划期):config action 是事务侧唯一能改 `plugin[]` 的东西,判据落在 image 对上 ——
  // 「加元素」在写盘前就具名拒绝,调用方拿到的是 stage="staging" 的可读理由而不是一次半态写。
  const sealed = sealEnginePluginAdditions(target, preImage, text)
  if (!sealed.ok) return sealed
  return {
    ok: true,
    image: { target, preImage, nextImage: text, preDigest: digest(preImage), nextDigest: digest(text) },
  }
}

/** staging 里 preimage/nextimage 的落点(0600;journal 只引用相对文件名,不含配置值)。 */
export function configStagePaths(stagingDir: string, slot: number): { pre: string; next: string } {
  return { pre: path.join(stagingDir, `config-${slot}.pre`), next: path.join(stagingDir, `config-${slot}.next`) }
}

/** 把 image 对写进 staging(0600),供 apply/restore 与崩溃恢复读取。 */
export function stageConfigImage(stagingDir: string, slot: number, image: ConfigTxImage): void {
  fs.mkdirSync(stagingDir, { recursive: true })
  const { pre, next } = configStagePaths(stagingDir, slot)
  fs.writeFileSync(pre, image.preImage, { mode: 0o600 })
  fs.writeFileSync(next, image.nextImage, { mode: 0o600 })
}

/** switch 阶段:原子替换 live target 为 nextImage。返回替换前 target 的实际 digest(供部分应用判定)。 */
export function applyConfigImage(image: ConfigTxImage): void {
  // ADR-040 咽喉(写盘期终闸)。prepare 已判过一次;这一道管的是**不经过 prepare 的 image**:
  // 崩溃恢复从 staging 重建的 image(可能是旧版本 alpha 留下的)、以及任何直接构造 image 的新调用点。
  // 抛错落在事务的 switch 循环里 → rollbackAll("switch", …),不是裸崩溃。
  const sealed = sealEnginePluginAdditions(image.target, image.preImage, image.nextImage)
  if (!sealed.ok) throw new Error(sealed.reason)
  writeFileAtomicSync(image.target, image.nextImage)
}

/**
 * 回滚:仅当 target 当前内容 == nextImage(即我们的 switch 已应用且无旁路覆盖)才写回 preImage。
 * 若 target 既非 pre 也非 next(有并发旁路写)→ 保留现状 + fail-closed 报告,绝不盲目覆盖用户/旁路内容。
 *
 * **本函数刻意不过 ADR-040 咽喉**:它写回的是**这次写盘之前磁盘上就有的那份字节**,不可能引入
 * 磁盘上从未有过的 `plugin[]` 成员;而给它加闸会让「移除条目的事务回滚」被自己的闸拒掉 ——
 * 那正是卸载/禁用失败后无法恢复原状的形态。 */
export type ConfigRestoreOutcome = { ok: true; action: "restored" | "noop" } | { ok: false; reason: string }
export function restoreConfigImage(image: ConfigTxImage): ConfigRestoreOutcome {
  let current: string
  try {
    current = fs.existsSync(image.target) ? fs.readFileSync(image.target, "utf8") : "{}"
  } catch (error) {
    return { ok: false, reason: `restore: cannot read target: ${error instanceof Error ? error.message : String(error)}` }
  }
  const curDigest = digest(current)
  if (curDigest === image.preDigest) return { ok: true, action: "noop" } // 已是旧态(switch 未应用/已回滚)
  if (curDigest === image.nextDigest) {
    // #378 r2 Major:preimage 写失败(ENOSPC/EIO)必须走结果通道 —— 抛出会绕过引擎的
    // blocked/保留非终态处理与锁释放(runExtensionTransaction 直接 reject,tx.lock 悬置到
    // 陈旧锁接管)。
    try {
      writeFileAtomicSync(image.target, image.preImage)
    } catch (error) {
      return { ok: false, reason: `restore: preimage write failed: ${error instanceof Error ? error.message : String(error)}` }
    }
    return { ok: true, action: "restored" }
  }
  return { ok: false, reason: `restore: target diverged (neither pre nor next digest) — refusing to clobber ${image.target}` }
}

/** 恢复期从 staging 重建 image 对(崩溃恢复用;journal 只存 digest,内容在受保护 staging)。 */
export function readStagedConfigImage(
  stagingDir: string,
  slot: number,
  target: string,
  preDigest: string,
  nextDigest: string,
): { ok: true; image: ConfigTxImage } | { ok: false; reason: string } {
  const { pre, next } = configStagePaths(stagingDir, slot)
  try {
    const preImage = fs.readFileSync(pre, "utf8")
    const nextImage = fs.readFileSync(next, "utf8")
    if (digest(preImage) !== preDigest) return { ok: false, reason: "staged preimage digest mismatch" }
    if (digest(nextImage) !== nextDigest) return { ok: false, reason: "staged nextimage digest mismatch" }
    return { ok: true, image: { target, preImage, nextImage, preDigest, nextDigest } }
  } catch (error) {
    return { ok: false, reason: `cannot read staged config images: ${error instanceof Error ? error.message : String(error)}` }
  }
}
