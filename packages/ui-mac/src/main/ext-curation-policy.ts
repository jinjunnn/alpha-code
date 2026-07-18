// ext-curation-policy — REQ-104 #397(Codex 裁决必改① + r1-4):session-grant 条目的**持久投影强制面**。
//
// 合同 §7.2:activationPolicy=session-grant 的启用只对当前会话生效 —— 持久账本里
// desiredState=enabled 的 session-grant 记录本身非法(历史安装/旁路写入/损坏)。在一切
// **持久投影面**(startup reconcile 的账本归位 + alpha.jsonc 重投影、sidecar
// OPENCODE_CONFIG_CONTENT 主权注入)必须按 disabled 处理;会话级启用机制本体 = #408。
//
// r1-4(fail-closed):**「无法判定」≠「确定空集」**。判定真源分两级:
//   · 已验远端知识 = channel LKG(signed channel metadata,离线重验)或 v1 缓存(重验签 +
//     R11 撤销可验)。两者其一可读 → ok:true;该已验视图对「其包含的条目」权威,随包快照
//     只补充**不在其中**的条目(seed-only 面)—— 已验视图对同 id 的裁决永远赢,旧随包数据
//     不得翻案。
//   · 两者皆不可用 → ok:false(远端策展状态未知),携带 partialIds = 随包快照可识别的部分集
//     (调用方仍可用它强制,但**不得当作完整**;boot reconcile 对「存在已启用 catalog 记录」
//     的不可判定态必须 fail-closed 置 enforcementGap 阻断 sidecar,见 ext-install-planner)。

import bundledCatalogJson from "../renderer/extensions/alpha-catalog.json"
import { decodeEntryCuration, type CurationEntryLike } from "../shared/catalog-curation"
import { readCachedTrust, readChannelLastKnownGood, readRevokedTargets, BUILTIN_CATALOG_PUBKEY_B64, type ChannelName } from "./catalog-channels"
import { readCachedCatalog } from "./remote-catalog"

/** 纯判定:已验 entries 里 curation 有效且 activationPolicy=session-grant 的 catalog id 集。
 *  未策展/校验失败(fail-closed)不进集合 —— 它们走 #395 保守面,与 session-grant 无涉。 */
export function sessionGrantIdsFromEntries(entries: unknown[]): Set<string> {
  const ids = new Set<string>()
  for (const e of entries) {
    if (!e || typeof e !== "object") continue
    const entry = e as CurationEntryLike
    if (entry.curation === undefined || typeof entry.id !== "string") continue
    const status = decodeEntryCuration(entry)
    if (status.kind === "curated" && status.curation.activationPolicy === "session-grant") ids.add(entry.id)
  }
  return ids
}

export type SessionGrantOracle =
  | { ok: true; ids: Set<string> }
  | {
      ok: false
      reason: string
      /** 随包快照可识别的部分集(仍可用于强制;完整性不可判定,不得当作全集)。 */
      partialIds: Set<string>
    }

const entryIdsOf = (entries: unknown[]): Set<string> => {
  const out = new Set<string>()
  for (const e of entries) {
    const id = (e as { id?: unknown } | null)?.id
    if (typeof id === "string") out.add(id)
  }
  return out
}

/** 已验视图 + 随包补充(仅补已验视图**不含**的 id —— 已验视图对同 id 的裁决永远赢:
 *  旧随包快照把某 id 标 session-grant 而当前已验目录改为 default-disabled 时,不得再强制)。 */
function mergeWithBundled(verifiedEntries: unknown[], bundledEntries: unknown[]): Set<string> {
  const ids = sessionGrantIdsFromEntries(verifiedEntries)
  const verifiedIds = entryIdsOf(verifiedEntries)
  for (const id of sessionGrantIdsFromEntries(bundledEntries)) if (!verifiedIds.has(id)) ids.add(id)
  return ids
}

/** 同步读取当前可验证 catalog 的 session-grant id 集(投影面专用;不打网络)。 */
export function readSessionGrantIdsSync(userDataPath: string, channel: ChannelName): SessionGrantOracle {
  const nowMs = Date.now()
  const bundledEntries = (bundledCatalogJson as { entries: unknown[] }).entries
  try {
    // 1) channel LKG(与安装面同一 channel-first 采信序)。
    const trust = readCachedTrust(userDataPath, BUILTIN_CATALOG_PUBKEY_B64, nowMs)
    if (trust) {
      const lkg = readChannelLastKnownGood(userDataPath, channel, trust.doc, nowMs)
      if (lkg) return { ok: true, ids: mergeWithBundled(lkg.catalog.entries, bundledEntries) }
    }
    // 2) v1 缓存(重验签;R11 撤销集不可验 → 整面弃用,#314 语义)。
    const revoked = readRevokedTargets(userDataPath)
    if (revoked !== null) {
      const cached = readCachedCatalog(userDataPath, { revoked })
      if (cached) return { ok: true, ids: mergeWithBundled((cached.catalog as { entries?: unknown[] }).entries ?? [], bundledEntries) }
    }
    return {
      ok: false,
      reason: "no verified channel LKG and no verified v1 catalog cache — remote curation state is unknown",
      partialIds: sessionGrantIdsFromEntries(bundledEntries),
    }
  } catch (error) {
    return {
      ok: false,
      reason: `verified catalog read failed: ${error instanceof Error ? error.message : String(error)}`,
      partialIds: sessionGrantIdsFromEntries(bundledEntries),
    }
  }
}
