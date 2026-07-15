// ext-advisory-gate — REQ-101 #315:advisory 激活闸(「允许缓存但禁止再启用」的消费端执行点)。
//
// 语义(合同 §4 R14 + 2026-07-15 裁决):
//   - advisory ≠ R11 撤销:已运行存量不强杀、不改 receipt(仅 loud);拦的是**新激活** ——
//     install(catalog/seed/bundle child)、disabled→enabled、generation rollback;
//   - 匹配授权键 = catalogId **精确相等**;记录带 sha256 时按 digestDomain 收窄:
//     aggregate-files 对 payloadDigest、file-sha256 对任一文件 digest —— 上下文缺该域 digest
//     时按 catalogId 保守拦(无法自证不是被公示内容,fail closed);name 仅展示不授权;
//     多记录命中任一 active 即拒;withdrawn 永不拦(rationale 仅留档);
//   - 新鲜度(最大 stale 窗口 = advisories doc expires):remote/cache 来源的激活要求已验
//     advisories LKG 在场且未过期,否则拦(冷启动/长期离线不得以"没有公示"放行 —— 绝不退
//     空集);bundled/seed 来源(离线基线)由随包静态 office advisory 表兜底,LKG 在场时
//     (含 stale)其命中同样拦;
//   - 每个操作**冻结一份 advisory 视图**(makeAdvisoryGate 一次读取),bundle fan-out 内
//     多子条目共享同一视图,不受操作中途的公示刷新影响。
//
// 非目标(#315 票面外,票面注记):app 启动/MCP 重连对**已启用存量**的再生效(仅告警面,
// REQ-105 UI 已示);事务 crash recovery 前滚(恢复的是已授权操作,授权时点已过闸)。

import { officeAdvisoryFor } from "../shared/office-advisories"
import {
  BUILTIN_CATALOG_PUBKEY_B64,
  readAdvisoriesLKG,
  readCachedTrust,
  type AdvisoriesDoc,
  type AdvisoryRecord,
  type ChannelClientDeps,
} from "./catalog-channels"

export type AdvisoryGateInput = {
  catalogId: string
  /** 仅展示/日志;绝不参与授权匹配。 */
  name?: string
  /** aggregate-files 域(InstallRecordV2.payloadDigest / aggregateFilesDigest)。 */
  payloadDigest?: string
  /** file-sha256 域(entry.remoteAsset.files[].sha256)。 */
  fileDigests?: string[]
  /** 内容来源:remote/cache = 签名 catalog 面(要求新鲜公示);bundled/seed = 随包离线基线。 */
  provenance: "remote" | "cache" | "bundled" | "seed"
}

export type AdvisoryGateResult =
  | { allowed: true }
  | { allowed: false; advisoryId: string; reason: string }

export type AdvisoryGate = (input: AdvisoryGateInput) => AdvisoryGateResult

function recordBlocks(r: AdvisoryRecord, input: AdvisoryGateInput): boolean {
  if (r.status !== "active") return false
  if (r.catalogId !== input.catalogId) return false
  if (r.sha256 === undefined) return true // 无 digest = 整 catalogId 面
  if (r.digestDomain === "aggregate-files") {
    // 上下文缺 payloadDigest → 无法自证非被公示内容,保守拦
    return input.payloadDigest === undefined || input.payloadDigest === r.sha256
  }
  if (r.digestDomain === "file-sha256") {
    return input.fileDigests === undefined || input.fileDigests.includes(r.sha256)
  }
  return true // 未知域(前向):保守拦
}

/**
 * 构造一次操作的冻结 advisory 视图。verified = null 表示无可验公示(冷启动/trust 不可验/
 * 缓存被拒),此时 remote/cache 激活一律拦。
 */
export function evaluateAdvisoryGate(
  verified: { doc: AdvisoriesDoc; stale: boolean } | null,
  input: AdvisoryGateInput,
): AdvisoryGateResult {
  // 随包静态基线(office 下架表,id/name 键):对一切来源生效(离线可判)。
  const officeHit = officeAdvisoryFor({ id: input.catalogId, name: input.name })
  if (officeHit) {
    return { allowed: false, advisoryId: `office:${officeHit.catalogId}`, reason: "archived office connector (REQ-105 bundled baseline)" }
  }
  if (input.provenance === "remote" || input.provenance === "cache") {
    if (!verified)
      return {
        allowed: false,
        advisoryId: "advisories-unavailable",
        reason: "no verifiable advisories (cold start / unverifiable trust) — refusing activation of signed-catalog content (fail closed, never an empty deny-list)",
      }
    if (verified.stale)
      return {
        allowed: false,
        advisoryId: "advisories-stale",
        reason: `advisories expired at ${verified.doc.expires} — past the max-stale activation window (browse stays available; refresh to activate)`,
      }
  }
  if (verified) {
    const hit = verified.doc.records.find((r) => recordBlocks(r, input))
    if (hit) return { allowed: false, advisoryId: hit.advisoryId, reason: hit.reason }
  }
  return { allowed: true }
}

/** main 组合根用:按 userDataPath 读取一次(冻结视图)并返回 gate 闭包。 */
export function makeAdvisoryGate(userDataPath: string, deps: ChannelClientDeps = {}): AdvisoryGate {
  const nowMs = (deps.now ?? Date.now)()
  const builtin = deps.builtinKeyB64 ?? BUILTIN_CATALOG_PUBKEY_B64
  const trust = readCachedTrust(userDataPath, builtin, nowMs)
  const verified = trust ? readAdvisoriesLKG(userDataPath, trust.doc, nowMs) : null
  return (input) => {
    const r = evaluateAdvisoryGate(verified, input)
    if (!r.allowed) {
      console.error(
        `[advisory-gate] activation BLOCKED for ${input.catalogId} (${r.advisoryId}): ${r.reason} [provenance=${input.provenance}]`,
      )
    }
    return r
  }
}
