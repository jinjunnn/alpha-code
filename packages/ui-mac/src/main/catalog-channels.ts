// catalog-channels — signed channel metadata 消费端验证机器(REQ-101 A 侧,issue #193;#314 snapshot)。
//
// 合同:alpha-web `contracts/catalog-channels/CONTRACT.md` @ 6a11567(§4 拒绝矩阵 R1–R13,§5 校验顺序)。
// 端点:`{base}/channels/{stable,preview,dev}.json`(+.sig)、`{base}/channels/trust.json`(+.sig)、
// `{base}/channels/snapshot.json`(+.sig,#314 集合一致性)、payload = `target.url`(+`target.sigUrl`,
// digest 是唯一权威,url 只是传输提示)。
//
// 校验顺序(§5,fail closed,任一不过 → 拒用回退 last-known-good,loud;失败分 security /
// availability 两类,security 绝不借道更弱回退面 —— 见 FailureClass):
//   1. trust.json 验字节(内置公钥或缓存 trust 链上 active 钥)→ schema → R4/R5;
//   2. snapshot.json 以 trust 钥验字节(R10/R1)→ schema → R4/R5 → R13(必须钉住本轮采信
//      trust 的精确字节+sequence;**缺失(404)= security**);
//   3. <channel>.json:R13 entry 先行(缺失=拒)→ 以 trust 中 doc.keyId 对应钥验字节(R10)
//      → schema(R2)→ R3/R4 → R13 钉合(精确字节+sequence)→ R5;
//   4. payload 按 target.url 取 → R8(sha256+bytes)/R9(版本绑定)→ payload 验签(R1);
//   5. R6/R7 对照本地 last-known;R11 对照 trust 撤销列表(**含已缓存内容,离线生效**);
//   6. 全过 → doc/payload/snapshot 作 coherent set 一次原子落缓存(per-channel;绝不先落
//      snapshot 再验成员 —— 防基线投毒;缓存读取时重验签 + R13-on-cache)。
//
// 信任根与轮换(§6):信任根 = 内置公钥;trust.json 引入的 active/retiring 钥(轮换窗口
// [notBefore, notAfter))可验后续文档;revoked 钥签的一切文档(含缓存)失效;单级链(§8):
// 缓存 trust 仅接受内置钥重验,新 trust 可经"内置钥 or 缓存 trust 的可用钥"验证。
//
// main 进程测试纪律:无 mock.module;fetch/now/信任根全部参数 DI,缓存走真盘临时目录。

import { createHash, createPublicKey, verify as edVerify } from "node:crypto"
import * as fs from "node:fs"
import * as path from "node:path"

export const CHANNEL_BASE_URL = "https://alphacodeone.com/catalog/v1"
/** 桌面端内置信任根(与 remote-catalog 现行 v1 验签公钥同源;spki der base64)。 */
export const BUILTIN_CATALOG_PUBKEY_B64 = "MCowBQYDK2VwAyEAqBBmG0mbZ3tZF7Vt8VEWhgm1RQdF2boFU5uUTSmsgHI="

const FETCH_TIMEOUT_MS = 8000
const MAX_DOC_BYTES = 512 * 1024 // trust/channel 指针文档上限(现 <2KB;防呆)
const MAX_SIG_BYTES = 8 * 1024
const MAX_PAYLOAD_BYTES = 2 * 1024 * 1024 // 与 remote-catalog MAX_CATALOG_BYTES 一致

export type ChannelName = "stable" | "preview" | "dev"

export type TrustKey = {
  keyId: string
  publicKey: string
  status: "active" | "retiring" | "revoked"
  notBefore: string
  notAfter?: string
}
export type RevokedTarget = { sha256: string; reason: string; revokedAt: string }
export type TrustDoc = {
  schema: "alpha.catalog.trust.v1"
  sequence: number
  publishedAt: string
  expires: string
  keyId: string
  keys: TrustKey[]
  revokedTargets: RevokedTarget[]
}
export type ChannelTarget = { catalogVersion: string; sha256: string; bytes: number; url: string; sigUrl: string }
export type ChannelDoc = {
  schema: "alpha.catalog.channel-metadata.v1"
  channel: ChannelName
  sequence: number
  publishedAt: string
  expires: string
  keyId: string
  target: ChannelTarget
}
/** #314(R13):集合一致性快照 —— 钉住 trust/channel 文档的精确文件字节 + sequence。 */
export type SnapshotEntry = { sequence: number; sha256: string }
export type SnapshotDoc = {
  schema: "alpha.catalog.snapshot.v1"
  sequence: number
  publishedAt: string
  expires: string
  keyId: string
  /** trust 必有;channel 成员在场才有 entry;advisories 为 #36/W2 前向兼容位。 */
  entries: { trust: SnapshotEntry } & Partial<Record<ChannelName | "advisories", SnapshotEntry>>
}

/** #315(R14):advisory 公示 —— 允许缓存但禁止再启用;记录 append-only、rationale 保留。 */
export type AdvisoryRecord = {
  advisoryId: string
  catalogId: string
  name?: string
  sha256?: string
  digestDomain?: "file-sha256" | "aggregate-files"
  reason: string
  publishedAt: string
  status: "active" | "withdrawn"
  withdrawnAt?: string
  supersededBy?: string
}
export type AdvisoriesDoc = {
  schema: "alpha.catalog.advisories.v1"
  sequence: number
  publishedAt: string
  expires: string
  keyId: string
  records: AdvisoryRecord[]
}

/**
 * 失败类(#314 裁决):security = R1-R14/撤销/过期/无可验 trust/snapshot 缺失 —— 选择性阻断
 * 不可与部署偏斜区分,绝不借道更弱回退面;availability = 纯网络失败(超时/断网/5xx)。
 */
export type FailureClass = "availability" | "security"

export type ChannelClientDeps = {
  fetchImpl?: typeof fetch
  /** epoch ms(测试注入;默认 Date.now)。 */
  now?: () => number
  baseUrl?: string
  builtinKeyB64?: string
}

export type ChannelCatalogResult =
  | {
      source: "remote" | "cache"
      channel: ChannelName
      catalog: unknown
      version: string
      sha256: string
      fetchedAt: string
      error?: string
      /** source="cache" 时:本轮落到 LKG 的失败类(#314;remote 成功分支无此字段)。 */
      reasonClass?: FailureClass
    }
  | { source: "none"; channel: ChannelName; error: string; reasonClass: FailureClass }

// ── 基础密码学 ────────────────────────────────────────────────────────────────────────────────

export const sha256Hex = (data: Buffer | string): string => createHash("sha256").update(data).digest("hex")

/** keyId = 公钥 SPKI DER 字节的 sha256 hex(合同 §2)。 */
export const keyIdOfSpkiDerB64 = (pubB64: string): string => sha256Hex(Buffer.from(pubB64, "base64"))

/** ed25519 over 精确字节(合同 §2:无 canonical-JSON;.sig 允许尾随空白,trim 后 base64)。 */
export function verifyEd25519(body: Buffer, sigB64: string, pubB64: string): boolean {
  try {
    const pub = createPublicKey({ key: Buffer.from(pubB64, "base64"), format: "der", type: "spki" })
    return edVerify(null, body, pub, Buffer.from(sigB64.trim(), "base64"))
  } catch {
    return false
  }
}

// codex M2 同款:catalog 版本单调比较(段内数值感知:"2026-07-05.10" > "2026-07-05.9")。
// 合同 §4 注:与 B 侧 catalog-channels-core.mjs#versionLess 逐字一致;remote-catalog re-export 本实现。
export function catalogVersionLess(a: string, b: string): boolean {
  const pa = a.split(/[.\-]/),
    pb = b.split(/[.\-]/)
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const x = pa[i] ?? "",
      y = pb[i] ?? ""
    const nx = Number(x),
      ny = Number(y)
    if (Number.isFinite(nx) && Number.isFinite(ny) && x !== "" && y !== "") {
      if (nx !== ny) return nx < ny
    } else if (x !== y) return x < y
  }
  return false
}

// ── schema 校验(R2:严格形状,未知顶层键拒绝;与 *.v1.schema.json 逐条对应)────────────────────

const HEX64 = /^[0-9a-f]{64}$/
const B64_RE = /^[A-Za-z0-9+/]+={0,2}$/
const VERSION_RE = /^[0-9A-Za-z][0-9A-Za-z._-]{0,63}$/
const CHANNELS: readonly ChannelName[] = ["stable", "preview", "dev"]

const isDateTime = (v: unknown): v is string => typeof v === "string" && Number.isFinite(Date.parse(v))
const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v)
const onlyKeys = (o: Record<string, unknown>, allowed: string[]): string | null => {
  const extra = Object.keys(o).filter((k) => !allowed.includes(k))
  return extra.length ? `unknown keys: ${extra.join(",")}` : null
}

export function validateTrustDoc(v: unknown): { ok: true; doc: TrustDoc } | { ok: false; error: string } {
  const bad = (error: string): { ok: false; error: string } => ({ ok: false, error: `R2 trust schema: ${error}` })
  if (!isObj(v)) return bad("not an object")
  const extra = onlyKeys(v, ["schema", "sequence", "publishedAt", "expires", "keyId", "keys", "revokedTargets"])
  if (extra) return bad(extra)
  if (v.schema !== "alpha.catalog.trust.v1") return bad(`schema=${String(v.schema)}`)
  if (typeof v.sequence !== "number" || !Number.isInteger(v.sequence) || v.sequence < 1) return bad("sequence")
  if (!isDateTime(v.publishedAt)) return bad("publishedAt")
  if (!isDateTime(v.expires)) return bad("expires")
  if (typeof v.keyId !== "string" || !HEX64.test(v.keyId)) return bad("keyId")
  if (!Array.isArray(v.keys) || v.keys.length < 1) return bad("keys")
  for (const k of v.keys) {
    if (!isObj(k)) return bad("keys[] not object")
    const e = onlyKeys(k, ["keyId", "publicKey", "status", "notBefore", "notAfter"])
    if (e) return bad(`keys[] ${e}`)
    if (typeof k.keyId !== "string" || !HEX64.test(k.keyId)) return bad("keys[].keyId")
    if (typeof k.publicKey !== "string" || !B64_RE.test(k.publicKey) || k.publicKey.length < 40 || k.publicKey.length > 120)
      return bad("keys[].publicKey")
    if (k.status !== "active" && k.status !== "retiring" && k.status !== "revoked") return bad("keys[].status")
    if (!isDateTime(k.notBefore)) return bad("keys[].notBefore")
    if (k.notAfter !== undefined && !isDateTime(k.notAfter)) return bad("keys[].notAfter")
  }
  if (!Array.isArray(v.revokedTargets)) return bad("revokedTargets")
  for (const r of v.revokedTargets) {
    if (!isObj(r)) return bad("revokedTargets[] not object")
    const e = onlyKeys(r, ["sha256", "reason", "revokedAt"])
    if (e) return bad(`revokedTargets[] ${e}`)
    if (typeof r.sha256 !== "string" || !HEX64.test(r.sha256)) return bad("revokedTargets[].sha256")
    if (typeof r.reason !== "string" || r.reason.length < 1 || r.reason.length > 500) return bad("revokedTargets[].reason")
    if (!isDateTime(r.revokedAt)) return bad("revokedTargets[].revokedAt")
  }
  return { ok: true, doc: v as unknown as TrustDoc }
}

export function validateChannelDoc(v: unknown): { ok: true; doc: ChannelDoc } | { ok: false; error: string } {
  const bad = (error: string): { ok: false; error: string } => ({ ok: false, error: `R2 channel schema: ${error}` })
  if (!isObj(v)) return bad("not an object")
  const extra = onlyKeys(v, ["schema", "channel", "sequence", "publishedAt", "expires", "keyId", "target"])
  if (extra) return bad(extra)
  if (v.schema !== "alpha.catalog.channel-metadata.v1") return bad(`schema=${String(v.schema)}`)
  if (!CHANNELS.includes(v.channel as ChannelName)) return bad("channel")
  if (typeof v.sequence !== "number" || !Number.isInteger(v.sequence) || v.sequence < 1) return bad("sequence")
  if (!isDateTime(v.publishedAt)) return bad("publishedAt")
  if (!isDateTime(v.expires)) return bad("expires")
  if (typeof v.keyId !== "string" || !HEX64.test(v.keyId)) return bad("keyId")
  const t = v.target
  if (!isObj(t)) return bad("target")
  const te = onlyKeys(t, ["catalogVersion", "sha256", "bytes", "url", "sigUrl"])
  if (te) return bad(`target ${te}`)
  if (typeof t.catalogVersion !== "string" || !VERSION_RE.test(t.catalogVersion)) return bad("target.catalogVersion")
  if (typeof t.sha256 !== "string" || !HEX64.test(t.sha256)) return bad("target.sha256")
  if (typeof t.bytes !== "number" || !Number.isInteger(t.bytes) || t.bytes < 1) return bad("target.bytes")
  if (typeof t.url !== "string" || !t.url.startsWith("https://")) return bad("target.url")
  if (typeof t.sigUrl !== "string" || !t.sigUrl.startsWith("https://")) return bad("target.sigUrl")
  return { ok: true, doc: v as unknown as ChannelDoc }
}

export function validateSnapshotDoc(v: unknown): { ok: true; doc: SnapshotDoc } | { ok: false; error: string } {
  const bad = (error: string): { ok: false; error: string } => ({ ok: false, error: `R2 snapshot schema: ${error}` })
  if (!isObj(v)) return bad("not an object")
  const extra = onlyKeys(v, ["schema", "sequence", "publishedAt", "expires", "keyId", "entries"])
  if (extra) return bad(extra)
  if (v.schema !== "alpha.catalog.snapshot.v1") return bad(`schema=${String(v.schema)}`)
  if (typeof v.sequence !== "number" || !Number.isInteger(v.sequence) || v.sequence < 1) return bad("sequence")
  if (!isDateTime(v.publishedAt)) return bad("publishedAt")
  if (!isDateTime(v.expires)) return bad("expires")
  if (typeof v.keyId !== "string" || !HEX64.test(v.keyId)) return bad("keyId")
  const entries = v.entries
  if (!isObj(entries)) return bad("entries")
  const ee = onlyKeys(entries, ["trust", "stable", "preview", "dev", "advisories"])
  if (ee) return bad(`entries ${ee}`)
  if (!isObj(entries.trust)) return bad("entries.trust required")
  // #315:advisories 是强制成员(#36 起;缺 entry = 删除公示面的绕过路径,R13/R2 拒)
  if (!isObj(entries.advisories)) return bad("entries.advisories required (mandatory since #36)")
  for (const [name, entry] of Object.entries(entries)) {
    if (!isObj(entry)) return bad(`entries.${name} not object`)
    const ke = onlyKeys(entry, ["sequence", "sha256"])
    if (ke) return bad(`entries.${name} ${ke}`)
    if (typeof entry.sequence !== "number" || !Number.isInteger(entry.sequence) || entry.sequence < 1) return bad(`entries.${name}.sequence`)
    if (typeof entry.sha256 !== "string" || !HEX64.test(entry.sha256)) return bad(`entries.${name}.sha256`)
  }
  return { ok: true, doc: v as unknown as SnapshotDoc }
}

// ── key registry(R10:unknown / revoked / 窗口外拒绝;keyId↔publicKey 绑定在取用时强制)────────

type KeyPolicy = { requireWindow: boolean }

/** 取用某 keyId 的验签钥;revoked 永远拒;requireWindow 时强制 [notBefore, notAfter)。 */
export function lookupSigningKey(
  trust: TrustDoc,
  keyId: string,
  nowMs: number,
  policy: KeyPolicy,
): { ok: true; key: TrustKey } | { ok: false; error: string } {
  const key = trust.keys.find((k) => k.keyId === keyId)
  if (!key) return { ok: false, error: `R10 unknown keyId ${keyId.slice(0, 12)}…` }
  if (key.status === "revoked") return { ok: false, error: `R10 keyId ${keyId.slice(0, 12)}… is REVOKED` }
  if (policy.requireWindow) {
    const nb = Date.parse(key.notBefore)
    const na = key.notAfter === undefined ? Infinity : Date.parse(key.notAfter)
    if (!(nb <= nowMs && nowMs < na)) return { ok: false, error: `R10 keyId ${keyId.slice(0, 12)}… outside [notBefore, notAfter) window` }
  }
  // keyId 是索引不是证据:取用前强制 keyId == sha256(spki der),防登记表内 keyId 冒名。
  if (keyIdOfSpkiDerB64(key.publicKey) !== key.keyId)
    return { ok: false, error: `R10 keyId ${keyId.slice(0, 12)}… does not match its publicKey (binding mismatch)` }
  return { ok: true, key }
}

/** 当前可用于验签的钥集合(active|retiring;revoked 排除;requireWindow 时窗口内)。 */
export function usableTrustKeys(trust: TrustDoc, nowMs: number, policy: KeyPolicy): TrustKey[] {
  return trust.keys.filter((k) => lookupSigningKey(trust, k.keyId, nowMs, policy).ok)
}

/** R11:payload digest 是否在撤销列表(含已缓存/已装内容,离线生效)。 */
export function revokedTargetEntry(trust: TrustDoc | null, sha256: string): RevokedTarget | null {
  if (!trust) return null
  return trust.revokedTargets.find((r) => r.sha256 === sha256) ?? null
}

// ── 文档级验证(签名 → schema → 自述,fail closed)────────────────────────────────────────────

type DocPolicy = { requireUnexpired: boolean; requireWindow: boolean }

/** trust 文档:候选钥验字节(R1)→ schema(R2)→ signer 自述一致 → 自身登记且未撤销(R10)→ R4。 */
export function verifyTrustBytes(
  body: Buffer,
  sig: string,
  candidates: Array<{ keyId: string; publicKey: string }>,
  nowMs: number,
  policy: DocPolicy,
): { ok: true; doc: TrustDoc; signerKeyId: string } | { ok: false; error: string } {
  let signer: { keyId: string; publicKey: string } | undefined
  for (const c of candidates) {
    if (keyIdOfSpkiDerB64(c.publicKey) !== c.keyId) continue // 绑定不符的候选不参与验签
    if (verifyEd25519(body, sig, c.publicKey)) {
      signer = c
      break
    }
  }
  if (!signer) return { ok: false, error: "R1 trust signature INVALID (no trusted key verifies these bytes)" }
  let parsed: unknown
  try {
    parsed = JSON.parse(body.toString("utf8"))
  } catch {
    return { ok: false, error: "R2 trust is not valid JSON" }
  }
  const v = validateTrustDoc(parsed)
  if (!v.ok) return v
  const doc = v.doc
  if (doc.keyId !== signer.keyId)
    return { ok: false, error: `R1 trust doc.keyId ${doc.keyId.slice(0, 12)}… != verifying key ${signer.keyId.slice(0, 12)}…` }
  // 自锁:trust 自身签名钥必须在登记表且未撤销(撤销自身 = 拒,合同 §6);fresh 时还须在窗口内。
  const self = lookupSigningKey(doc, doc.keyId, nowMs, { requireWindow: policy.requireWindow })
  if (!self.ok) return { ok: false, error: `trust self-key: ${self.error}` }
  if (policy.requireUnexpired && Date.parse(doc.expires) <= nowMs)
    return { ok: false, error: `R4 trust EXPIRED at ${doc.expires}` }
  return { ok: true, doc, signerKeyId: signer.keyId }
}

/** channel 指针文档:keyId 路由(R10)→ 验字节(R1)→ schema(R2)→ R3 自述 → R4 过期。 */
export function verifyChannelBytes(
  body: Buffer,
  sig: string,
  channel: ChannelName,
  trust: TrustDoc,
  nowMs: number,
  policy: DocPolicy,
): { ok: true; doc: ChannelDoc } | { ok: false; error: string } {
  let parsed: unknown
  try {
    parsed = JSON.parse(body.toString("utf8"))
  } catch {
    return { ok: false, error: "R2 channel doc is not valid JSON" }
  }
  const claimedKeyId = isObj(parsed) && typeof parsed.keyId === "string" ? parsed.keyId : ""
  const key = lookupSigningKey(trust, claimedKeyId, nowMs, { requireWindow: policy.requireWindow })
  if (!key.ok) return key
  if (!verifyEd25519(body, sig, key.key.publicKey))
    return { ok: false, error: `R1 channel doc signature INVALID (keyId ${claimedKeyId.slice(0, 12)}…)` }
  const v = validateChannelDoc(parsed)
  if (!v.ok) return v
  const doc = v.doc
  if (doc.channel !== channel)
    return { ok: false, error: `R3 mix-and-match: doc.channel=${doc.channel} != requested ${channel}` }
  if (policy.requireUnexpired && Date.parse(doc.expires) <= nowMs)
    return { ok: false, error: `R4 channel doc EXPIRED at ${doc.expires}` }
  return { ok: true, doc }
}

/** snapshot 文档(#314):keyId 路由(R10)→ 验字节(R1)→ schema(R2)→ R4 过期。 */
export function verifySnapshotBytes(
  body: Buffer,
  sig: string,
  trust: TrustDoc,
  nowMs: number,
  policy: DocPolicy,
): { ok: true; doc: SnapshotDoc } | { ok: false; error: string } {
  let parsed: unknown
  try {
    parsed = JSON.parse(body.toString("utf8"))
  } catch {
    return { ok: false, error: "R2 snapshot doc is not valid JSON" }
  }
  const claimedKeyId = isObj(parsed) && typeof parsed.keyId === "string" ? parsed.keyId : ""
  const key = lookupSigningKey(trust, claimedKeyId, nowMs, { requireWindow: policy.requireWindow })
  if (!key.ok) return key
  if (!verifyEd25519(body, sig, key.key.publicKey))
    return { ok: false, error: `R1 snapshot signature INVALID (keyId ${claimedKeyId.slice(0, 12)}…)` }
  const v = validateSnapshotDoc(parsed)
  if (!v.ok) return v
  if (policy.requireUnexpired && Date.parse(v.doc.expires) <= nowMs)
    return { ok: false, error: `R4 snapshot doc EXPIRED at ${v.doc.expires}` }
  return { ok: true, doc: v.doc }
}

const ADVISORY_ID_RE = /^adv-[0-9a-z][0-9a-z-]{0,63}$/
const ENTRY_ID_RE = /^(mcp|skill|plugin|bundle|agent|cloud):[a-z0-9][a-z0-9-]*$/

export function validateAdvisoriesDoc(v: unknown): { ok: true; doc: AdvisoriesDoc } | { ok: false; error: string } {
  const bad = (error: string): { ok: false; error: string } => ({ ok: false, error: `R2 advisories schema: ${error}` })
  if (!isObj(v)) return bad("not an object")
  const extra = onlyKeys(v, ["schema", "sequence", "publishedAt", "expires", "keyId", "records"])
  if (extra) return bad(extra)
  if (v.schema !== "alpha.catalog.advisories.v1") return bad(`schema=${String(v.schema)}`)
  if (typeof v.sequence !== "number" || !Number.isInteger(v.sequence) || v.sequence < 1) return bad("sequence")
  if (!isDateTime(v.publishedAt)) return bad("publishedAt")
  if (!isDateTime(v.expires)) return bad("expires")
  if (typeof v.keyId !== "string" || !HEX64.test(v.keyId)) return bad("keyId")
  if (!Array.isArray(v.records)) return bad("records")
  for (const r of v.records) {
    if (!isObj(r)) return bad("records[] not object")
    const e = onlyKeys(r, ["advisoryId", "catalogId", "name", "sha256", "digestDomain", "reason", "publishedAt", "status", "withdrawnAt", "supersededBy"])
    if (e) return bad(`records[] ${e}`)
    if (typeof r.advisoryId !== "string" || !ADVISORY_ID_RE.test(r.advisoryId)) return bad("records[].advisoryId")
    if (typeof r.catalogId !== "string" || !ENTRY_ID_RE.test(r.catalogId)) return bad("records[].catalogId")
    if (r.name !== undefined && (typeof r.name !== "string" || r.name.length < 1 || r.name.length > 200)) return bad("records[].name")
    if (r.sha256 !== undefined && (typeof r.sha256 !== "string" || !HEX64.test(r.sha256))) return bad("records[].sha256")
    if (r.digestDomain !== undefined && r.digestDomain !== "file-sha256" && r.digestDomain !== "aggregate-files") return bad("records[].digestDomain")
    if (typeof r.reason !== "string" || r.reason.length < 1 || r.reason.length > 500) return bad("records[].reason")
    if (!isDateTime(r.publishedAt)) return bad("records[].publishedAt")
    if (r.status !== "active" && r.status !== "withdrawn") return bad("records[].status")
    if (r.withdrawnAt !== undefined && !isDateTime(r.withdrawnAt)) return bad("records[].withdrawnAt")
    if (r.supersededBy !== undefined && (typeof r.supersededBy !== "string" || !ADVISORY_ID_RE.test(r.supersededBy))) return bad("records[].supersededBy")
  }
  return { ok: true, doc: v as unknown as AdvisoriesDoc }
}

/** R14 内部一致性(与 B 侧 assertAdvisoriesInternallyConsistent 同规则);违反 → 整份拒。 */
export function advisoriesConsistencyError(doc: AdvisoriesDoc): string | null {
  const ids = new Set<string>()
  for (const r of doc.records) {
    if (ids.has(r.advisoryId)) return `R14 duplicate advisoryId ${r.advisoryId}`
    ids.add(r.advisoryId)
    if (r.status === "active" && r.withdrawnAt !== undefined) return `R14 ${r.advisoryId} active with withdrawnAt`
    if (r.status === "withdrawn" && r.withdrawnAt === undefined) return `R14 ${r.advisoryId} withdrawn without withdrawnAt`
    if (r.sha256 !== undefined && r.digestDomain === undefined) return `R14 ${r.advisoryId} sha256 without digestDomain`
  }
  for (const r of doc.records) {
    if (r.supersededBy !== undefined && !ids.has(r.supersededBy)) return `R14 ${r.advisoryId} supersededBy unknown ${r.supersededBy}`
  }
  return null
}

/** advisories 文档(#315):keyId 路由(R10)→ 验字节(R1)→ schema(R2)→ R4 → R14 一致性。 */
export function verifyAdvisoriesBytes(
  body: Buffer,
  sig: string,
  trust: TrustDoc,
  nowMs: number,
  policy: DocPolicy,
): { ok: true; doc: AdvisoriesDoc } | { ok: false; error: string } {
  let parsed: unknown
  try {
    parsed = JSON.parse(body.toString("utf8"))
  } catch {
    return { ok: false, error: "R2 advisories doc is not valid JSON" }
  }
  const claimedKeyId = isObj(parsed) && typeof parsed.keyId === "string" ? parsed.keyId : ""
  const key = lookupSigningKey(trust, claimedKeyId, nowMs, { requireWindow: policy.requireWindow })
  if (!key.ok) return key
  if (!verifyEd25519(body, sig, key.key.publicKey))
    return { ok: false, error: `R1 advisories signature INVALID (keyId ${claimedKeyId.slice(0, 12)}…)` }
  const v = validateAdvisoriesDoc(parsed)
  if (!v.ok) return v
  const inconsistent = advisoriesConsistencyError(v.doc)
  if (inconsistent) return { ok: false, error: inconsistent }
  if (policy.requireUnexpired && Date.parse(v.doc.expires) <= nowMs)
    return { ok: false, error: `R4 advisories doc EXPIRED at ${v.doc.expires}` }
  return { ok: true, doc: v.doc }
}

const saneCatalog = (parsed: unknown): parsed is { version: string; entries: unknown[] } => {
  const c = parsed as { version?: unknown; entries?: unknown }
  return !!c && typeof c.version === "string" && Array.isArray(c.entries) && c.entries.length > 0
}

/** payload:R8(sha256+bytes 钉死)→ 形状 → R9(版本绑定)→ R1(可用钥验签)→ R11(撤销)。 */
export function verifyPayloadBytes(
  body: Buffer,
  sig: string,
  target: ChannelTarget,
  trust: TrustDoc,
  nowMs: number,
  policy: DocPolicy,
): { ok: true; catalog: { version: string; entries: unknown[] } } | { ok: false; error: string } {
  const digest = sha256Hex(body)
  if (digest !== target.sha256)
    return { ok: false, error: `R8 payload sha256 MISMATCH (expected ${target.sha256.slice(0, 12)}…, got ${digest.slice(0, 12)}…)` }
  if (body.length !== target.bytes) return { ok: false, error: `R8 payload bytes MISMATCH (expected ${target.bytes}, got ${body.length})` }
  let parsed: unknown
  try {
    parsed = JSON.parse(body.toString("utf8"))
  } catch {
    return { ok: false, error: "payload is not valid JSON" }
  }
  if (!saneCatalog(parsed)) return { ok: false, error: "payload catalog shape invalid" }
  if (parsed.version !== target.catalogVersion)
    return { ok: false, error: `R9 payload version ${parsed.version} != target.catalogVersion ${target.catalogVersion}` }
  const keys = usableTrustKeys(trust, nowMs, { requireWindow: policy.requireWindow })
  if (!keys.some((k) => verifyEd25519(body, sig, k.publicKey)))
    return { ok: false, error: "R1 payload signature INVALID (no usable trust key verifies)" }
  const revoked = revokedTargetEntry(trust, digest)
  if (revoked) return { ok: false, error: `R11 payload digest REVOKED (${revoked.reason})` }
  return { ok: true, catalog: parsed }
}

// ── 缓存(真盘 userData;读取时全量重验签,同 remote-catalog 纪律)──────────────────────────────

type PersistedDoc = { body: string; sig: string }
/**
 * #314:snapshot 随本 channel 的 doc/payload 同一次原子写(coherent set;绝不先于成员验证
 * 单独落盘 —— 防基线投毒)。per-channel 存放:两个 channel 各自刷新节奏不同,全局单槽会让
 * 先刷新者的新 snapshot 错杀后者的合法旧 LKG。缺席 = pre-#314 存量 state。
 */
type ChannelStateEntry = { doc: PersistedDoc; payload: PersistedDoc; snapshot?: PersistedDoc; fetchedAt: string }
type StateFile = {
  /**
   * #314 review M1:R13 高水位。首次成功写入 coherent set 时置 2 且**永不回退** ——
   * stateVersion>=2 后,任何 channel entry 缺 snapshot 位 = 篡改/撕裂(拒),不再享受
   * pre-#314 grandfather;删除 snapshot 字段伪装 legacy state 的降级路径被封死。
   */
  stateVersion?: number
  /** 最新已验 trust(可能是链上钥签的,§6 轮换中)。 */
  trust?: PersistedDoc & { fetchedAt?: string }
  /** 锚:最近一份**内置钥直验**的 trust;重启后经它单级链重验 state.trust(撤销离线持久)。 */
  trustAnchor?: PersistedDoc & { fetchedAt?: string }
  /** #315:最新已验 advisories(全局;deny-list 安全前移 —— 验证通过即持久,不等 channel 结果)。 */
  advisories?: PersistedDoc & { fetchedAt?: string }
  channels?: Partial<Record<ChannelName, ChannelStateEntry>>
}

export const channelStatePath = (userDataPath: string): string => path.join(userDataPath, "catalog-channel-state.json")

function readStateFile(userDataPath: string): StateFile {
  try {
    const raw = JSON.parse(fs.readFileSync(channelStatePath(userDataPath), "utf8")) as unknown
    if (isObj(raw)) return raw as StateFile
  } catch {
    /* no state */
  }
  return {}
}

const persistedDocOk = (d: unknown): d is PersistedDoc =>
  isObj(d) && typeof d.body === "string" && typeof d.sig === "string"

export type CachedTrust = { doc: TrustDoc; body: string; sig: string }

/**
 * 缓存 trust 重验(缓存文件可被本地篡改;自签 trust 不构成信任):
 * 1)锚 = 内置钥直验的 trustAnchor(或 trust 本身);2)state.trust 经"内置钥 or 锚的登记钥"
 * 单级链重验(§8)。重验放宽钥窗口(离线持久性;revoked 仍硬拒),不要求未过期
 * (能否锚定**新**状态由调用方按 expires 决定,R4)。任何一级验不过 → 丢弃,loud。
 */
export function readCachedTrust(userDataPath: string, builtinKeyB64: string, nowMs: number): CachedTrust | null {
  const st = readStateFile(userDataPath)
  const builtin = { keyId: keyIdOfSpkiDerB64(builtinKeyB64), publicKey: builtinKeyB64 }
  const relaxed: DocPolicy = { requireUnexpired: false, requireWindow: false }
  const verifyPersisted = (d: PersistedDoc, candidates: Array<{ keyId: string; publicKey: string }>) =>
    verifyTrustBytes(Buffer.from(d.body, "utf8"), d.sig, candidates, nowMs, relaxed)

  let anchor: { doc: TrustDoc; persisted: PersistedDoc } | null = null
  for (const d of [st.trustAnchor, st.trust]) {
    if (!persistedDocOk(d)) continue
    const v = verifyPersisted(d, [builtin])
    if (v.ok) {
      anchor = { doc: v.doc, persisted: d }
      break
    }
  }
  if (!anchor) {
    if (persistedDocOk(st.trust) || persistedDocOk(st.trustAnchor))
      console.error("[catalog-channels] cached trust FAILED built-in-key re-verification — discarding (possible local tampering)")
    return null
  }
  if (persistedDocOk(st.trust) && st.trust.body !== anchor.persisted.body) {
    const chain = verifyPersisted(st.trust, [builtin, ...usableTrustKeys(anchor.doc, nowMs, { requireWindow: false })])
    if (chain.ok) return { doc: chain.doc, body: st.trust.body, sig: st.trust.sig }
    console.error(`[catalog-channels] cached trust FAILED chain re-verification — falling back to anchor (${chain.error})`)
  }
  return { doc: anchor.doc, body: anchor.persisted.body, sig: anchor.persisted.sig }
}

/**
 * #314:本 channel 缓存 snapshot 重验(签名/schema 相对 trust;R4/窗口放宽同 LKG 纪律)
 * → R5 基线 + R13-on-cache。三态(review M1):absent(无 snapshot 位)≠ invalid(在场但
 * 验签/schema 失败 = 篡改)—— invalid 必须拒 LKG,absent 仅在 stateVersion<2 时 grandfather。
 */
export type CachedSnapshot =
  | { status: "valid"; doc: SnapshotDoc; body: string }
  | { status: "absent" }
  | { status: "invalid" }
export function readCachedSnapshot(userDataPath: string, channel: ChannelName, trust: TrustDoc, nowMs: number): CachedSnapshot {
  const st = readStateFile(userDataPath)
  const persisted = st.channels?.[channel]?.snapshot
  if (persisted === undefined) return { status: "absent" }
  if (!persistedDocOk(persisted)) return { status: "invalid" }
  const v = verifySnapshotBytes(Buffer.from(persisted.body, "utf8"), persisted.sig, trust, nowMs, {
    requireUnexpired: false,
    requireWindow: false,
  })
  if (!v.ok) {
    console.error(`[catalog-channels] cached ${channel} snapshot FAILED re-verification — INVALID (${v.error})`)
    return { status: "invalid" }
  }
  return { status: "valid", doc: v.doc, body: persisted.body }
}

/**
 * #315:缓存 advisories 重验(签名/schema/R14 相对 trust;R4 放宽但回报 stale —— 激活策略
 * 对 stale 的处置见 ext-advisory-gate:过期即阻断新激活,绝不退空集)。invalid → null(loud)。
 */
export function readAdvisoriesLKG(
  userDataPath: string,
  trust: TrustDoc,
  nowMs: number,
): { doc: AdvisoriesDoc; stale: boolean } | null {
  const st = readStateFile(userDataPath)
  if (!persistedDocOk(st.advisories)) return null
  const v = verifyAdvisoriesBytes(Buffer.from(st.advisories.body, "utf8"), st.advisories.sig, trust, nowMs, {
    requireUnexpired: false,
    requireWindow: false,
  })
  if (!v.ok) {
    console.error(`[catalog-channels] cached advisories FAILED re-verification — discarding (${v.error})`)
    return null
  }
  return { doc: v.doc, stale: Date.parse(v.doc.expires) <= nowMs }
}

/** stateVersion 高水位读取(缺省 1 = pre-#314)。 */
export function channelStateVersion(userDataPath: string): number {
  const v = readStateFile(userDataPath).stateVersion
  return Number.isInteger(v) && (v as number) >= 1 ? (v as number) : 1
}

export type ChannelLastKnownGood = {
  doc: ChannelDoc
  catalog: { version: string; entries: unknown[] }
  docBody: string
  docSig: string
  payloadBody: string
  payloadSig: string
  fetchedAt: string
  /** doc.expires 已过(LKG 容忍过期但必须 loud)。 */
  stale: boolean
}

/**
 * last-known-good 重验(离线纪律):签名/schema/R3/R8/R9/R11 全部重跑;
 * **revoked 钥签的缓存文档、revokedTargets 命中的缓存 payload 一律失效**(R10/R11 对缓存生效);
 * 仅 R4(doc 过期)与钥窗口放宽 —— LKG 的意义是可用性,放宽处 loud 标记 stale。
 */
export function readChannelLastKnownGood(
  userDataPath: string,
  channel: ChannelName,
  trust: TrustDoc,
  nowMs: number,
): ChannelLastKnownGood | null {
  const st = readStateFile(userDataPath)
  const entry = st.channels?.[channel]
  if (!entry || !persistedDocOk(entry.doc) || !persistedDocOk(entry.payload)) return null
  const relaxed: DocPolicy = { requireUnexpired: false, requireWindow: false }
  const docV = verifyChannelBytes(Buffer.from(entry.doc.body, "utf8"), entry.doc.sig, channel, trust, nowMs, relaxed)
  if (!docV.ok) {
    console.error(`[catalog-channels] cached ${channel} doc FAILED re-verification — discarding (${docV.error})`)
    return null
  }
  const payloadV = verifyPayloadBytes(Buffer.from(entry.payload.body, "utf8"), entry.payload.sig, docV.doc.target, trust, nowMs, relaxed)
  if (!payloadV.ok) {
    console.error(`[catalog-channels] cached ${channel} payload FAILED re-verification — discarding (${payloadV.error})`)
    return null
  }
  // #314 R13-on-cache(review M1 三态):valid → doc 必须命中 entry;invalid(在场但坏)→ 拒;
  // absent → 仅 stateVersion<2(真 pre-#314 存量)grandfather,高水位已达 2 则 absent = 篡改/撕裂,拒。
  const cachedSnap = readCachedSnapshot(userDataPath, channel, trust, nowMs)
  if (cachedSnap.status === "invalid") {
    console.error(`[catalog-channels] cached ${channel} snapshot INVALID — discarding LKG (local tampering or torn state)`)
    return null
  }
  if (cachedSnap.status === "absent" && channelStateVersion(userDataPath) >= 2) {
    console.error(`[catalog-channels] cached ${channel} entry lacks snapshot but stateVersion>=2 — discarding LKG (R13 high-water)`)
    return null
  }
  if (cachedSnap.status === "valid") {
    const pin = cachedSnap.doc.entries[channel]
    if (!pin || pin.sha256 !== sha256Hex(Buffer.from(entry.doc.body, "utf8")) || pin.sequence !== docV.doc.sequence) {
      console.error(`[catalog-channels] cached ${channel} doc FAILS R13 against cached snapshot — discarding (local tampering or torn state)`)
      return null
    }
  }
  return {
    doc: docV.doc,
    catalog: payloadV.catalog,
    docBody: entry.doc.body,
    docSig: entry.doc.sig,
    payloadBody: entry.payload.body,
    payloadSig: entry.payload.sig,
    fetchedAt: typeof entry.fetchedAt === "string" ? entry.fetchedAt : "",
    stale: Date.parse(docV.doc.expires) <= nowMs,
  }
}

function writeState(userDataPath: string, mutate: (st: StateFile) => void): void {
  try {
    const st = readStateFile(userDataPath)
    mutate(st)
    fs.mkdirSync(userDataPath, { recursive: true })
    const target = channelStatePath(userDataPath)
    const tmp = `${target}.tmp-${process.pid}`
    fs.writeFileSync(tmp, JSON.stringify(st))
    fs.renameSync(tmp, target) // 原子替换:中断不留截断 state(coherent set 可用性)
  } catch {
    /* 缓存写失败不阻断本次使用(同 remote-catalog) */
  }
}

// ── 网络(注入 fetch;https 重定向终点强制;体积帽)────────────────────────────────────────────

/**
 * 结构化取数错误(#314 review:失败分类不得依赖错误字符串)。
 * 分类契约:availability = 纯网络故障(超时/断网/5xx);security = 4xx(含 404/403,被钉
 * 资源缺失与选择性阻断不可区分)、HTTPS 降级重定向、体积违规 —— 服务端"在但不给对的东西"。
 */
export class FetchFailure extends Error {
  readonly reasonClass: FailureClass
  constructor(message: string, reasonClass: FailureClass) {
    super(message)
    this.reasonClass = reasonClass
  }
}
export const failureClassOf = (e: unknown): FailureClass => (e instanceof FetchFailure ? e.reasonClass : "availability")

async function fetchBytes(fetchImpl: typeof fetch, url: string, maxBytes: number): Promise<Buffer> {
  const ctl = new AbortController()
  const timer = setTimeout(() => ctl.abort(), FETCH_TIMEOUT_MS)
  try {
    let resp: Response
    try {
      resp = await fetchImpl(url, { signal: ctl.signal, redirect: "follow" })
    } catch (e) {
      throw new FetchFailure(`fetch failed: ${e instanceof Error ? e.message : e}: ${url}`, "availability")
    }
    if (resp.url && !resp.url.startsWith("https://")) throw new FetchFailure(`redirected to non-https: ${resp.url}`, "security")
    if (!resp.ok) throw new FetchFailure(`HTTP ${resp.status}: ${url}`, resp.status >= 500 ? "availability" : "security")
    const ab = await resp.arrayBuffer().catch((e) => {
      throw new FetchFailure(`read failed: ${e instanceof Error ? e.message : e}: ${url}`, "availability")
    })
    if (ab.byteLength > maxBytes) throw new FetchFailure(`too large (${ab.byteLength}B > ${maxBytes}B): ${url}`, "security")
    return Buffer.from(ab)
  } finally {
    clearTimeout(timer)
  }
}

/** body 与 .sig 并行取;任一失败按**最严分类**聚合(security 优先),不受响应时序影响。 */
async function fetchDocPair(fetchImpl: typeof fetch, url: string, sigUrl: string, maxBytes: number): Promise<{ body: Buffer; sig: string }> {
  const [b, g] = await Promise.allSettled([fetchBytes(fetchImpl, url, maxBytes), fetchBytes(fetchImpl, sigUrl, MAX_SIG_BYTES)])
  if (b.status === "rejected" || g.status === "rejected") {
    const errs = [b, g].filter((r): r is PromiseRejectedResult => r.status === "rejected").map((r) => r.reason as unknown)
    const cls: FailureClass = errs.some((e) => failureClassOf(e) === "security") ? "security" : "availability"
    const msg = errs.map((e) => (e instanceof Error ? e.message : String(e))).join("; ")
    throw new FetchFailure(msg, cls)
  }
  return { body: b.value, sig: g.value.toString("utf8") }
}

// ── 编排:refreshChannelCatalog ───────────────────────────────────────────────────────────────

/**
 * 按合同 §5 校验顺序拉取并验证一个 channel;任一环节不过 → loud → 回退 last-known-good(缓存),
 * 无可用缓存 → `{ source: "none" }`(fail closed,绝不采信未验证内容)。
 */
export async function refreshChannelCatalog(
  userDataPath: string,
  channel: ChannelName,
  deps: ChannelClientDeps = {},
): Promise<ChannelCatalogResult> {
  const fetchImpl = deps.fetchImpl ?? fetch
  const nowMs = (deps.now ?? Date.now)()
  const baseUrl = (deps.baseUrl ?? CHANNEL_BASE_URL).replace(/\/+$/, "")
  const builtinKeyB64 = deps.builtinKeyB64 ?? BUILTIN_CATALOG_PUBKEY_B64
  const builtin = { keyId: keyIdOfSpkiDerB64(builtinKeyB64), publicKey: builtinKeyB64 }
  const loud = (msg: string) => console.error(`[catalog-channels] ${channel}: ${msg}`)
  const notices: string[] = []

  // 1) trust:缓存重验(内置钥)→ 拉新(内置钥 or 缓存链上可用钥)→ R2/R4/R5。
  const cachedTrust = readCachedTrust(userDataPath, builtinKeyB64, nowMs)
  let trust: TrustDoc | null = cachedTrust?.doc ?? null
  let trustBodyUsed: Buffer = Buffer.from(cachedTrust?.body ?? "", "utf8")
  try {
    const pair = await fetchDocPair(fetchImpl, `${baseUrl}/channels/trust.json`, `${baseUrl}/channels/trust.json.sig`, MAX_DOC_BYTES)
    const candidates = [builtin, ...(cachedTrust ? usableTrustKeys(cachedTrust.doc, nowMs, { requireWindow: true }) : [])]
    const v = verifyTrustBytes(pair.body, pair.sig, candidates, nowMs, { requireUnexpired: true, requireWindow: true })
    if (!v.ok) {
      notices.push(`trust refresh rejected: ${v.error}`)
      loud(`trust refresh rejected — keeping cached trust (${v.error})`)
    } else if (cachedTrust && v.doc.sequence <= cachedTrust.doc.sequence && pair.body.toString("utf8") !== cachedTrust.body) {
      notices.push(`R5 trust sequence regression: ${v.doc.sequence} <= ${cachedTrust.doc.sequence}`)
      loud(`R5 trust sequence regression (${v.doc.sequence} <= ${cachedTrust.doc.sequence}) — keeping cached trust`)
    } else {
      trust = v.doc
      trustBodyUsed = pair.body
      // 立即持久化(不等 channel 结果):撤销/轮换必须离线生效(R10/R11),即便本轮 channel 被拒。
      // (#314 裁决:trust 安全前移 ≠ snapshot 前移 —— snapshot 只随 coherent set 提交。)
      const persist = { body: pair.body.toString("utf8"), sig: pair.sig.trim(), fetchedAt: new Date(nowMs).toISOString() }
      writeState(userDataPath, (st) => {
        st.trust = persist
        if (v.signerKeyId === builtin.keyId) st.trustAnchor = persist // 锚只收内置钥直验的 trust
      })
    }
  } catch (e) {
    notices.push(`trust fetch failed: ${e instanceof Error ? e.message : e}`)
  }
  if (!trust) {
    const error = `no verifiable trust (${notices.join("; ") || "no cache, no network"}) — fail closed`
    loud(error)
    return { source: "none", channel, error, reasonClass: "security" }
  }
  // trust 的精确字节(R13 entries.trust 绑定用):优先本轮新验的,否则缓存的。
  const trustBody = trustBodyUsed

  // last-known-good(对照基线 + 回退目标;读取即全量重验,revoked 钥/撤销 digest 的缓存已被剔除)。
  const lkg = readChannelLastKnownGood(userDataPath, channel, trust, nowMs)
  const fallback = (error: string, reasonClass: FailureClass): ChannelCatalogResult => {
    loud(`${error} [${reasonClass}] — ${lkg ? "falling back to last-known-good" : "NO last-known-good available"}`)
    if (!lkg) return { source: "none", channel, error, reasonClass }
    return {
      source: "cache",
      channel,
      catalog: lkg.catalog,
      version: lkg.doc.target.catalogVersion,
      sha256: lkg.doc.target.sha256,
      fetchedAt: lkg.fetchedAt,
      error: `${error}${lkg.stale ? " (WARNING: last-known-good is past its expires — stale)" : ""}`,
      reasonClass,
    }
  }

  // 采信新状态需要未过期的 trust(R4 防冻结,security:冻结攻击面);过期 trust 只够撑 LKG。
  if (Date.parse(trust.expires) <= nowMs)
    return fallback(`R4 trust EXPIRED at ${trust.expires} — cannot anchor new channel state`, "security")

  // 2) snapshot(#314,R13):缺失(404)= security(选择性阻断不可与部署偏斜区分,合同 §5)。
  let snapBody: Buffer
  let snapSig: string
  try {
    const pair = await fetchDocPair(fetchImpl, `${baseUrl}/channels/snapshot.json`, `${baseUrl}/channels/snapshot.json.sig`, MAX_DOC_BYTES)
    snapBody = pair.body
    snapSig = pair.sig
  } catch (e) {
    // 结构化分类:4xx(含 404 = 半发布/选择性阻断)/降级/超限 → security;纯网络故障 → availability。
    return fallback(`R13 snapshot fetch failed: ${e instanceof Error ? e.message : e}`, failureClassOf(e))
  }
  const snapV = verifySnapshotBytes(snapBody, snapSig, trust, nowMs, { requireUnexpired: true, requireWindow: true })
  if (!snapV.ok) return fallback(snapV.error, "security")
  const snap = snapV.doc
  // R5(snapshot 自身序列,对本 channel 的缓存基线;等序比**精确字节**,review M4):
  const cachedSnap = readCachedSnapshot(userDataPath, channel, trust, nowMs)
  if (cachedSnap.status === "valid") {
    if (snap.sequence < cachedSnap.doc.sequence)
      return fallback(`R5 snapshot sequence regression: ${snap.sequence} < cached ${cachedSnap.doc.sequence}`, "security")
    if (snap.sequence === cachedSnap.doc.sequence && !snapBody.equals(Buffer.from(cachedSnap.body, "utf8")))
      return fallback(`R5 snapshot replaced at same sequence ${snap.sequence} (replay/replacement)`, "security")
  }
  // R13:snapshot 必须钉住**本轮采信的 trust 的精确字节 + sequence**(trust/snapshot 偏斜 = 拒)。
  if (snap.entries.trust.sha256 !== sha256Hex(trustBody) || snap.entries.trust.sequence !== trust.sequence)
    return fallback(`R13 snapshot does not pin the trusted trust doc (trust/snapshot skew)`, "security")

  // 2b) advisories(#315):强制成员(validateSnapshotDoc 已保证 entry 在场)。取 → 验
  //    (R10/R1/R2/R4/R14)→ R13 钉合 → R5(全局缓存基线;等序异字节拒)→ **立即持久化**
  //    (deny-list 安全前移,同 trust 纪律;不等 channel 结果)。失败 = 集合不完整 → security。
  {
    let advBody: Buffer
    let advSig: string
    try {
      const pair = await fetchDocPair(fetchImpl, `${baseUrl}/channels/advisories.json`, `${baseUrl}/channels/advisories.json.sig`, MAX_DOC_BYTES)
      advBody = pair.body
      advSig = pair.sig
    } catch (e) {
      return fallback(`R14 advisories fetch failed (pinned by snapshot): ${e instanceof Error ? e.message : e}`, "security")
    }
    const advV = verifyAdvisoriesBytes(advBody, advSig, trust, nowMs, { requireUnexpired: true, requireWindow: true })
    if (!advV.ok) return fallback(advV.error, "security")
    const advPin = snap.entries.advisories
    if (!advPin || advPin.sha256 !== sha256Hex(advBody) || advPin.sequence !== advV.doc.sequence)
      return fallback(`R13 advisories doc does not match snapshot entry`, "security")
    const cachedAdv = readAdvisoriesLKG(userDataPath, trust, nowMs)
    if (cachedAdv) {
      if (advV.doc.sequence < cachedAdv.doc.sequence)
        return fallback(`R5 advisories sequence regression: ${advV.doc.sequence} < cached ${cachedAdv.doc.sequence}`, "security")
      const cachedBody = readStateFile(userDataPath).advisories
      if (advV.doc.sequence === cachedAdv.doc.sequence && cachedBody && !advBody.equals(Buffer.from(cachedBody.body, "utf8")))
        return fallback(`R5 advisories replaced at same sequence ${advV.doc.sequence}`, "security")
    }
    writeState(userDataPath, (st) => {
      st.advisories = { body: advBody.toString("utf8"), sig: advSig.trim(), fetchedAt: new Date(nowMs).toISOString() }
    })
  }

  // 3) channel 指针文档:R13 entry 先行(entry 缺失 = 拒,免拉取)→ R10 → R1 → R2 → R3 → R4
  //    → R13 钉合 → R5 → R6/R7 → R11。被 snapshot 钉住的成员拉取失败 = 半发布/选择性阻断
  //    (与 snapshot 一致性互斥),归 security。
  const pin = snap.entries[channel]
  if (!pin) return fallback(`R13 snapshot has no entry for channel "${channel}"`, "security")
  let docBody: Buffer
  let docSig: string
  try {
    const pair = await fetchDocPair(fetchImpl, `${baseUrl}/channels/${channel}.json`, `${baseUrl}/channels/${channel}.json.sig`, MAX_DOC_BYTES)
    docBody = pair.body
    docSig = pair.sig
  } catch (e) {
    return fallback(`channel doc fetch failed (pinned by snapshot): ${e instanceof Error ? e.message : e}`, "security")
  }
  const docV = verifyChannelBytes(docBody, docSig, channel, trust, nowMs, { requireUnexpired: true, requireWindow: true })
  if (!docV.ok) return fallback(docV.error, "security")
  const doc = docV.doc
  // R13:channel 文档必须命中 snapshot entry(精确字节 + sequence)。
  if (pin.sha256 !== sha256Hex(docBody) || pin.sequence !== doc.sequence)
    return fallback(`R13 channel doc does not match snapshot entry (seq ${doc.sequence} vs pinned ${pin.sequence})`, "security")
  const sameBytesAsLkg = !!lkg && docBody.toString("utf8") === lkg.docBody
  if (lkg && !sameBytesAsLkg) {
    if (doc.sequence <= lkg.doc.sequence)
      return fallback(`R5 sequence regression/replay: ${doc.sequence} <= last-known ${lkg.doc.sequence}`, "security")
    if (catalogVersionLess(doc.target.catalogVersion, lkg.doc.target.catalogVersion))
      return fallback(`R6 ROLLBACK: target ${doc.target.catalogVersion} older than last-known ${lkg.doc.target.catalogVersion}`, "security")
    if (doc.target.catalogVersion === lkg.doc.target.catalogVersion && doc.target.sha256 !== lkg.doc.target.sha256)
      return fallback(`R7 content REPLACED for ${doc.target.catalogVersion} (sha256 ${lkg.doc.target.sha256.slice(0, 12)}… -> ${doc.target.sha256.slice(0, 12)}…)`, "security")
  }
  const revoked = revokedTargetEntry(trust, doc.target.sha256)
  if (revoked) return fallback(`R11 target digest REVOKED (${revoked.reason})`, "security")

  // 3) payload:digest 命中 LKG 且旧签名仍可验 → 免拉;否则按 target.url 取(digest 是唯一权威)。
  let payloadBody: Buffer
  let payloadSig: string
  const reuse =
    lkg &&
    lkg.doc.target.sha256 === doc.target.sha256 &&
    verifyPayloadBytes(Buffer.from(lkg.payloadBody, "utf8"), lkg.payloadSig, doc.target, trust, nowMs, {
      requireUnexpired: true,
      requireWindow: true,
    })
  if (reuse && reuse.ok) {
    payloadBody = Buffer.from(lkg!.payloadBody, "utf8")
    payloadSig = lkg!.payloadSig
  } else {
    try {
      const pair = await fetchDocPair(fetchImpl, doc.target.url, doc.target.sigUrl, MAX_PAYLOAD_BYTES)
      payloadBody = pair.body
      payloadSig = pair.sig
    } catch (e) {
      return fallback(`payload fetch failed: ${e instanceof Error ? e.message : e}`, failureClassOf(e))
    }
  }
  const payloadV = verifyPayloadBytes(payloadBody, payloadSig, doc.target, trust, nowMs, { requireUnexpired: true, requireWindow: true })
  if (!payloadV.ok) return fallback(payloadV.error, "security")

  // 5) 全过 → coherent set 一次原子落缓存(doc/payload/snapshot 同写;trust 已先行持久化)。
  const fetchedAt = new Date(nowMs).toISOString()
  writeState(userDataPath, (st) => {
    st.stateVersion = Math.max(st.stateVersion ?? 1, 2) // R13 高水位:只升不降(review M1)
    st.channels = st.channels ?? {}
    st.channels[channel] = {
      doc: { body: docBody.toString("utf8"), sig: docSig.trim() },
      payload: { body: payloadBody.toString("utf8"), sig: payloadSig.trim() },
      snapshot: { body: snapBody.toString("utf8"), sig: snapSig.trim() },
      fetchedAt,
    }
  })
  return {
    source: "remote",
    channel,
    catalog: payloadV.catalog,
    version: doc.target.catalogVersion,
    sha256: doc.target.sha256,
    fetchedAt,
    ...(notices.length ? { error: notices.join("; ") } : {}),
  }
}

/**
 * 给 v1 兼容路径用的撤销视图(R11 对已缓存内容离线生效):从缓存 trust(内置钥重验)读
 * revokedTargets。#314:无可验 trust → **null(撤销状态未知)**,调用方必须拒用 v1 ——
 * 不可采信从不可验 trust 派生的空撤销集(审计 AC2 缺口)。
 */
export function readRevokedTargets(userDataPath: string, deps: ChannelClientDeps = {}): Map<string, string> | null {
  const nowMs = (deps.now ?? Date.now)()
  const builtinKeyB64 = deps.builtinKeyB64 ?? BUILTIN_CATALOG_PUBKEY_B64
  const cached = readCachedTrust(userDataPath, builtinKeyB64, nowMs)
  if (!cached) return null
  const out = new Map<string, string>()
  for (const r of cached.doc.revokedTargets) out.set(r.sha256, r.reason)
  return out
}
