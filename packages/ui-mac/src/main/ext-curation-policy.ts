// ext-curation-policy — REQ-104 #397(Codex 裁决必改①):session-grant 条目的**持久投影强制面**。
//
// 合同 §7.2:activationPolicy=session-grant 的启用只对当前会话生效 —— 持久账本里
// desiredState=enabled 的 session-grant 记录本身非法(历史安装/旁路写入/损坏)。在一切
// **持久投影面**(startup reconcile 的 alpha.jsonc 重投影、sidecar OPENCODE_CONFIG_CONTENT
// 主权注入)必须按 disabled 处理;会话级启用机制本体 = #408。
//
// 判定真源 = 已验证 catalog 的 curation(decodeEntryCuration fail-closed 采信):
//   channel LKG(signed channel metadata,离线重验)→ v1 缓存(重验签 + R11 撤销)→ 随包
//   bundled 快照。三者都是**已验字节**;取第一可用(与 refreshRemoteCatalog 的采信序同向)。
//   全部不可用时退空集 —— 此时无从识别 session-grant,如实按现账本投影(启用面新增
//   session-grant enabled 已被 setInstallStateByKey 闸死,见 ext-install-planner)。

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

/** 同步读取当前可验证 catalog 的 session-grant id 集(投影面专用;不打网络)。 */
export function readSessionGrantIdsSync(userDataPath: string, channel: ChannelName): Set<string> {
  const nowMs = Date.now()
  try {
    // 1) channel LKG(与安装面同一 channel-first 采信序)。
    const trust = readCachedTrust(userDataPath, BUILTIN_CATALOG_PUBKEY_B64, nowMs)
    if (trust) {
      const lkg = readChannelLastKnownGood(userDataPath, channel, trust.doc, nowMs)
      if (lkg) return sessionGrantIdsFromEntries(lkg.catalog.entries)
    }
    // 2) v1 缓存(重验签;R11 撤销集不可验 → 整面弃用,#314 语义)。
    const revoked = readRevokedTargets(userDataPath)
    if (revoked !== null) {
      const cached = readCachedCatalog(userDataPath, { revoked })
      if (cached) return sessionGrantIdsFromEntries((cached.catalog as { entries?: unknown[] }).entries ?? [])
    }
  } catch (error) {
    console.error("[req104-397] session-grant oracle: verified cache read failed — falling back to bundled snapshot", error)
  }
  // 3) 随包快照(app 签名背书;当前随包目录无 curation → 空集,如实)。
  return sessionGrantIdsFromEntries((bundledCatalogJson as { entries: unknown[] }).entries)
}
