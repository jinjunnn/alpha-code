// #408(REQ-104):labs(activationPolicy=session-grant)条目的会话级启用 —— main 侧 grant 登记面。
//
// Codex 方案裁决(2026-07-18,Design A 通过):
//   · 时间边界 = 当前 embedded sidecar 的一次连续运行;exit / 主动 kill / respawn / 崩溃均结束
//     全部 grant。存放面 = **纯 main 内存**(拒绝落盘会话戳):崩溃即失 = 「崩溃不复活」零证明
//     负担;持久账本(installs.json)/ alpha.jsonc / 注入 env(OPENCODE_CONFIG_CONTENT)全程零写
//     —— #397 三闸(enable 闸拒 session-grant-persistent-enable、写点例外恒 disabled、boot
//     reconcile 归位)与注入面「session-grant 恒 disabled」不变量原样保持,本模块不开任何例外。
//   · **generation 失效栅栏**(裁决 Q3 竞态不变量):会话结束处理必须先撤 active 标记、再清 Map;
//     grant 授权是异步的(resolveEntry 打已验 catalog),提交 Map 前重新确认捕获的 generation
//     仍 active —— 否则「结束清空 → 迟到授权复写」存在复活窗口。
//   · **directory 维度**(裁决必改):引擎 MCP 热状态属 per-directory InstanceState(HTTP
//     connect/disconnect 走 workspace routing)。grant 记录携 directory;撤销按 (id, directory)
//     精确撤 —— 同一条目在多个 directory 激活即多条记录,枚举可得全部激活面,不存在「只断
//     当前实例」的残留。
//   · 生效/失效的运行面在 renderer(与 #395 liveAddAndConnect 同信任边界):ok 后对同 directory
//     调引擎 /mcp/:name/connect;引擎 global.disposed 后经本通道 re-assert(重校验失败 = 同 key
//     旧 grant 就地撤下 + 开关回落,绝不静默保持)。
//   · 校验复用 #397 enable 闸的权威序与口径:kind 面 → advisory(优先于 curation/复审拒绝)→
//     身份四元组(id/kind/name/version vs 已验 entry)→ curation 解码(必须 curated 且
//     activationPolicy=session-grant)→ 复审过期显式确认。任一不可证 = fail-closed 拒。

import * as path from "node:path"
import { decodeEntryCuration, isReviewExpired, type CurationEntryLike } from "../shared/catalog-curation"
import type {
  SessionGrantRefusalCode,
  SessionGrantResultWire,
  SessionGrantWire,
} from "../shared/ext-session-grant-wire"
import type { AdvisoryGate } from "./ext-advisory-gate"
import type { VerifiedCatalogEntry } from "./ext-install-planner"
import { readLedgerV2 } from "./ext-receipt-v2"

// ── 内存登记处(generation 栅栏)──────────────────────────────────────────────────────────────

export type SessionGrantRegistry = {
  /** sidecar spawn 成功后调用:登记本代为 active,grant 集从空开始(新会话零继承)。 */
  beginSession(gen: number): void
  /** 会话结束(exit/kill/respawn/崩溃):**先撤 active 标记再清 Map**(顺序不可倒 —— 撤标后任何
   *  在途授权的迟到 commit 都被栅栏拒,复活窗口闭合)。返回被结束的代与 grant 快照(日志/事件用);
   *  无活跃会话时幂等(endedGen=null,调用方据此跳过事件)。 */
  endSession(): { endedGen: number | null; grants: SessionGrantWire[] }
  activeGeneration(): number | null
  /** 授权完成落 Map 的唯一入口:capturedGen(授权**开始前**捕获)必须仍是 active 代,否则拒
   *  (false)—— 会话在异步授权期间结束的 grant 绝不回写。 */
  commit(capturedGen: number, grant: SessionGrantWire): boolean
  /** 按 (id, directory) 撤下(幂等;撤销与「re-assert 失败清除」共用)。 */
  remove(id: string, directory: string): void
  list(): SessionGrantWire[]
}

export function createSessionGrantRegistry(): SessionGrantRegistry {
  let activeGen: number | null = null
  const grants = new Map<string, SessionGrantWire>()
  const keyOf = (id: string, directory: string) => `${id}\u0000${directory}` // NUL 不合法于两侧，键无歧义
  return {
    beginSession(gen) {
      activeGen = gen
      grants.clear() // 双保险:endSession 已清;新会话无论调用序恒从空集开始
    },
    endSession() {
      const endedGen = activeGen
      activeGen = null // ① 先推栅栏(此后 commit 一律拒)
      const ended = [...grants.values()]
      grants.clear() // ② 再清 Map
      return { endedGen, grants: ended }
    },
    activeGeneration: () => activeGen,
    commit(capturedGen, grant) {
      if (activeGen === null || capturedGen !== activeGen) return false
      grants.set(keyOf(grant.id, grant.directory), grant)
      return true
    },
    remove(id, directory) {
      grants.delete(keyOf(id, directory))
    },
    list: () => [...grants.values()],
  }
}

/** 生产单例(index.ts 接线 sidecar 生命周期;ext-ipc.ts 接线三通道)。测试用工厂。 */
export const sessionGrantRegistry = createSessionGrantRegistry()

// ── 授予(异步校验 + 栅栏提交)─────────────────────────────────────────────────────────────────

export type SessionGrantDeps = {
  registry: SessionGrantRegistry
  globalRoot(): string
  /** 已验 catalog 条目解析(ext-ipc plannerDeps —— 自带 #314/#315 security browse-only 语义)。 */
  resolveEntry(catalogId: string): Promise<VerifiedCatalogEntry | null>
  /** #315 advisory 激活闸(每操作冻结视图;必填 —— 可选缺省 = fail-open 陷阱)。 */
  advisoryGate: AdvisoryGate
  now?(): string
}

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v)

type GrantInput = { catalogId: string; directory: string; confirmExpiredReview?: boolean }

function decodeGrantInput(input: unknown): { ok: true; intent: GrantInput } | { ok: false; reason: string } {
  if (!isObj(input)) return { ok: false, reason: "session-grant: input must be an object" }
  const { catalogId, directory, confirmExpiredReview, ...rest } = input
  const unknown = Object.keys(rest)
  if (unknown.length > 0) return { ok: false, reason: `session-grant: unknown key(s) ${unknown.join(", ")}` }
  if (typeof catalogId !== "string" || !catalogId) return { ok: false, reason: "session-grant: catalogId must be a non-empty string" }
  if (typeof directory !== "string" || !path.isAbsolute(directory))
    return { ok: false, reason: "session-grant: directory must be an absolute path (the engine instance space the grant applies to)" }
  if (confirmExpiredReview !== undefined && typeof confirmExpiredReview !== "boolean")
    return { ok: false, reason: "session-grant: confirmExpiredReview must be a boolean" }
  return { ok: true, intent: { catalogId, directory, ...(confirmExpiredReview !== undefined ? { confirmExpiredReview } : {}) } }
}

/** 会话级授予(亦是 dispose 后 re-assert 的重校验入口)。任何 fail-closed 拒绝都**就地撤下**同
 *  (catalogId, directory) 的既有 grant —— 资格不再可证的条目不得静默保持「已启用」(re-assert
 *  失败即开关回落的 main 半场)。持久面零写:本函数只读账本(readLedgerV2 读路径无副作用)。 */
export async function grantSessionGrant(rawInput: unknown, deps: SessionGrantDeps): Promise<SessionGrantResultWire> {
  const decoded = decodeGrantInput(rawInput)
  if (!decoded.ok) return { ok: false, reason: decoded.reason, code: "session-grant-refused" }
  const { catalogId, directory, confirmExpiredReview } = decoded.intent

  const refuse = (reason: string, code: SessionGrantRefusalCode = "session-grant-refused"): SessionGrantResultWire => {
    deps.registry.remove(catalogId, directory) // 拒绝 = 同 key 旧 grant 一并失效(fail-closed)
    return { ok: false, reason, code }
  }

  // 栅栏捕获点:一切异步校验之前。会话未启动/已结束 → 无授予面。
  const capturedGen = deps.registry.activeGeneration()
  if (capturedGen === null)
    return refuse("no active engine session — session grants exist only while the sidecar is running")

  const ledger = readLedgerV2(deps.globalRoot())
  const matches = ledger.records.filter((r) => r.scope.kind === "global" && r.origin === "catalog" && r.id === catalogId)
  if (matches.length === 0)
    return refuse(`no installed global catalog record for ${catalogId} — install first (fail closed; session grants never install)`)
  if (matches.length > 1)
    return refuse(`${matches.length} global catalog records share id ${catalogId} — ambiguous, refusing (fail closed)`)
  const record = matches[0]!

  // kind 面(#397 enable 闸同序:生效面判定先于 advisory)。引擎唯一的瞬态激活面 = mcp 热连;
  // agent/skill/plugin 无「零持久写 + 不破注入不变量」的现成通道 —— 如实拒绝,不假生效。
  if (record.kind !== "mcp")
    return refuse(
      `${record.kind} "${record.name}": session activation is only supported for mcp entries in this build — the engine has no transient activation surface for ${record.kind} (fail closed, no fake toggle)`,
      "session-grant-kind-unsupported",
    )

  // advisory 闸(权威序:advisory 拒绝优先于 curation/复审拒绝;输入与 enable 闸同形)。
  const adv = deps.advisoryGate({
    catalogId: record.id,
    name: record.name,
    payloadDigest: record.payloadDigest,
    provenance: "cache",
  })
  if (!adv.allowed) return refuse(`advisory ${adv.advisoryId}: ${adv.reason} — session grant refused (R14)`)

  // 身份四元组(#397 r1-5 同口径):record 无 version = 无法自证身份;已验 entry 解析不到 =
  // 下架/离线/security browse-only,一律拒,绝不降格放行。
  if (record.version === undefined)
    return refuse(`mcp ${record.name}: install record has no version — cannot prove identity against the verified catalog (fail closed)`)
  const verified = await deps.resolveEntry(catalogId)
  if (!verified)
    return refuse(
      `mcp ${record.name}: cannot verify curation — the entry is not resolvable from the verified catalog (delisted/offline/security state); session grant refused (fail closed)`,
    )
  const entry = verified.entry as { id?: unknown; type?: unknown; name?: unknown; version?: unknown }
  const entryVersion = typeof entry.version === "string" && entry.version ? entry.version : verified.catalogVersion
  if (entry.id !== record.id || entry.type !== record.kind || entry.name !== record.name || entryVersion !== record.version)
    return refuse(
      `mcp ${record.name}: verified catalog entry identity does not match this install (installed ${record.version} vs catalog ${entryVersion}) — refusing to apply its curation; update or reinstall first (fail closed)`,
    )

  // curation 采信:唯一入口 decodeEntryCuration(fail-closed)。session-grant 之外的条目不走本
  // 通道(default-* 政策 = 持久启停面 setInstallState 的业务,两通道不得互相顶替)。
  const status = decodeEntryCuration(verified.entry as CurationEntryLike)
  if (status.kind === "invalid")
    return refuse(`mcp ${record.name}: curation FAILED validation (${status.reason}) — session grant refused (fail closed)`)
  if (status.kind === "uncurated")
    return refuse(`mcp ${record.name}: entry is not curated — it has no session-grant policy (use the regular enable channel)`)
  if (status.curation.activationPolicy !== "session-grant")
    return refuse(
      `mcp ${record.name}: activationPolicy is "${status.curation.activationPolicy}" — not a session-grant entry (use the regular enable channel)`,
    )

  // 复审过期(合同 §7.2:一切 enable 路径需显式确认 —— 会话启用不是例外;消费端时钟仅用于本比较)。
  const nowIso = deps.now ? deps.now() : new Date().toISOString()
  if (isReviewExpired(status.curation, nowIso) && confirmExpiredReview !== true)
    return refuse(
      `mcp ${record.name}: security review expired at ${status.curation.review.reviewBefore} — session grant requires explicit user confirmation (contract §7.2)`,
      "expired-review-confirmation-required",
    )

  const grant: SessionGrantWire = {
    id: record.id,
    kind: "mcp",
    name: record.name,
    version: record.version,
    directory,
    grantedAt: nowIso,
  }
  // 栅栏提交:授权期间会话结束(endSession 已撤标 + 清 Map)→ 绝不回写(复活窗口闭合)。
  if (!deps.registry.commit(capturedGen, grant))
    return {
      ok: false,
      reason: "the engine session ended while the grant was being authorized — grant not applied (grants never survive a session boundary)",
      code: "session-grant-refused",
    }
  return { ok: true, grant }
}

// ── 撤销(幂等,directory 维度)────────────────────────────────────────────────────────────────

export function revokeSessionGrant(
  rawInput: unknown,
  deps: Pick<SessionGrantDeps, "registry">,
): { ok: true } | { ok: false; reason: string; code: "session-grant-refused" } {
  if (!isObj(rawInput)) return { ok: false, reason: "session-grant revoke: input must be an object", code: "session-grant-refused" }
  const { catalogId, directory, ...rest } = rawInput
  const unknown = Object.keys(rest)
  if (unknown.length > 0)
    return { ok: false, reason: `session-grant revoke: unknown key(s) ${unknown.join(", ")}`, code: "session-grant-refused" }
  if (typeof catalogId !== "string" || !catalogId)
    return { ok: false, reason: "session-grant revoke: catalogId must be a non-empty string", code: "session-grant-refused" }
  if (typeof directory !== "string" || !path.isAbsolute(directory))
    return { ok: false, reason: "session-grant revoke: directory must be an absolute path", code: "session-grant-refused" }
  // 幂等:不存在(含会话已结束、Map 已清)= 无可撤,同样 ok —— 撤销的目标状态已达成。
  deps.registry.remove(catalogId, directory)
  return { ok: true }
}
