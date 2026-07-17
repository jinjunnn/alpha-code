// REQ-100(issue #192)T2 —— capability 授权账 + 权限 diff:实现「更新新增 capability 必须
// 重新确认,不能静默继承」(REQ-100 AC3)与「Bundle 一次展示 capability diff、一次授权、
// 一次 commit」(交付②)的数据层。
//
// 机制:
//   · 每扩展一份已授权 capability 集(`<root>/ext-store/<key>/grants.json`,原子换名写,
//     与 current.json 指针同目录 = 事务拥有的路径,卸载一并清除);
//   · grants.json **只在事务 journal 达 committed 后**由 ext-transaction 落盘(提交序见
//     ext-transaction.ts):崩溃窗口的失败模式 = 下次多问一次确认(fail closed),
//     绝不可能是静默继承;失败回滚的事务不更新授权账 —— 拒绝/失败后旧版继续健康运行;
//   · diff 语义:上次 committed 授权集 vs 本次计划请求集;新增(expansion)或从无到有
//     (previous=null,含 grants.json 缺失/不可解析的 fail-closed 情形)→ 需要覆盖式确认
//     (确认必须覆盖完整新集合,不只增量 —— 展示什么确认什么,防 TOCTOU);收缩/不变 → 放行;
//   · capability 字符串对本层不透明:REQ-099 ext-manifest-v2 的 MANIFEST_CAPABILITIES 白名单
//     在 manifest 解码期把关,本层只做集合语义 + 格式守卫,避免跨 REQ 的枚举耦合。
//
// electron-free、root 参数化、零 mock.module(仓规:DI 面 + 真盘临时目录)。

import * as fs from "node:fs"
import * as path from "node:path"
import type { CapabilityDiffWire } from "../shared/ext-capability-authorization"
import { writeFileAtomicSync } from "./ext-atomic-fs"

export type CapabilityGrant = {
  v: 1
  key: string
  /** 上次 committed 事务授权的完整 capability 集(排序、去重)。 */
  capabilities: string[]
  manifestDigest?: string
  txId: string
  grantedAt: string
}

/** #348:与 IPC wire DTO 同一定义(shared 是形状真源,语义仍在本模块)——
 *  previous null = 无授权记录(全新安装 / v1 遗留 / 授权账不可读),fail closed,任何非空请求都要确认。 */
export type CapabilityDiff = CapabilityDiffWire

const SAFE_KEY = /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}$/
const CAPABILITY_RE = /^[a-z][a-z0-9:._-]{0,63}$/i

/** capability 格式守卫(语义白名单归 REQ-099 manifest 解码期;此处只挡结构性垃圾)。 */
export function isSafeCapability(cap: unknown): cap is string {
  return typeof cap === "string" && CAPABILITY_RE.test(cap)
}

/** 布局与 ext-transaction.extensionStorePaths 同根:`<root>/ext-store/<key>/grants.json`。 */
export function capabilityGrantPath(root: string, key: string): string {
  return path.join(root, "ext-store", key, "grants.json")
}

/** 读授权账。缺失 / 不可解析 / 结构非法 → null(fail closed:上层按「从未授权」要求确认)。 */
export function readCapabilityGrant(root: string, key: string): CapabilityGrant | null {
  if (!SAFE_KEY.test(key)) return null
  let parsed: CapabilityGrant
  try {
    parsed = JSON.parse(fs.readFileSync(capabilityGrantPath(root, key), "utf8")) as CapabilityGrant
  } catch {
    return null
  }
  if (!parsed || typeof parsed !== "object" || parsed.v !== 1) return null
  if (typeof parsed.key !== "string" || typeof parsed.txId !== "string") return null
  // #392 读面硬化(Codex r1 m2):grantedAt 必须是字符串(缺失/异型会带过 IPC 让详情页 .slice 崩溃);
  // 文件内 key 必须与请求 key 一致(错放的合法 grant 文件不得显示到别的扩展上)—— 均 fail closed。
  if (typeof parsed.grantedAt !== "string" || parsed.key !== key) return null
  if (!Array.isArray(parsed.capabilities) || !parsed.capabilities.every(isSafeCapability)) return null
  return parsed
}

/** 原子写授权账(仅 ext-transaction 在 committed 后调用;见文件头提交序纪律)。 */
export function writeCapabilityGrantSync(root: string, grant: CapabilityGrant): void {
  if (!SAFE_KEY.test(grant.key)) throw new Error(`invalid grant key: ${grant.key}`)
  const normalized: CapabilityGrant = { ...grant, capabilities: [...new Set(grant.capabilities)].sort() }
  writeFileAtomicSync(capabilityGrantPath(root, grant.key), JSON.stringify(normalized, null, 2) + "\n")
}

/** 幂等移除(卸载路径:grants.json 是事务拥有的路径)。 */
export function removeCapabilityGrantSync(root: string, key: string): boolean {
  if (!SAFE_KEY.test(key)) return false
  try {
    fs.unlinkSync(capabilityGrantPath(root, key))
    return true
  } catch {
    return false
  }
}

/** 纯函数 diff:previous=null(从未授权)且请求非空 → 需确认;否则仅在出现新增时需确认。 */
export function diffCapabilities(key: string, previous: string[] | null, requested: string[]): CapabilityDiff {
  const prevSet = previous === null ? null : new Set(previous)
  const reqSet = new Set(requested)
  const added = [...reqSet].filter((c) => !prevSet?.has(c)).sort()
  const removed = prevSet === null ? [] : [...prevSet].filter((c) => !reqSet.has(c)).sort()
  return {
    key,
    previous: prevSet === null ? null : [...prevSet].sort(),
    requested: [...reqSet].sort(),
    added,
    removed,
    requiresConfirmation: prevSet === null ? reqSet.size > 0 : added.length > 0,
  }
}

/** 盘上授权账 vs 请求集。 */
export function evaluateCapabilityDiff(root: string, key: string, requested: string[]): CapabilityDiff {
  const grant = readCapabilityGrant(root, key)
  return diffCapabilities(key, grant ? grant.capabilities : null, requested)
}

/** 覆盖式确认判定:requested ⊆ confirmed(确认完整新集合,不只增量)。 */
export function confirmationCovers(confirmed: string[] | undefined, requested: string[]): boolean {
  if (!confirmed) return false
  const set = new Set(confirmed)
  return requested.every((c) => set.has(c))
}

/** Bundle 级聚合(一次展示、一次授权):逐 item diff + 任一 item 需确认即整单需确认。 */
export function evaluateBundleAuthorization(
  root: string,
  items: Array<{ key: string; capabilities?: string[] }>,
): { items: CapabilityDiff[]; requiresConfirmation: boolean } {
  const diffs = items.map((it) => evaluateCapabilityDiff(root, it.key, it.capabilities ?? []))
  return { items: diffs, requiresConfirmation: diffs.some((d) => d.requiresConfirmation) }
}
