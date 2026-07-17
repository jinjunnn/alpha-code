// ext-states — REQ-103 slice 1(#195,父 #212 §2):availability / activation / health 三态分离。
//
// 三个维度**正交**,禁止互相塌缩(父 AC2:用户能分别判断「已缓存」「已安装但关闭」「已启用」
// 「运行健康」「撤销/隔离」):
//   · availability(可获得性)—— 这个扩展能从哪里获得:catalog / bundled(packaged seed,
//     REQ-102 语义:availability="bundled" 与激活态正交)/ installed(本机账本有据);
//   · activation(激活态)—— 已安装条目的期望启用状态:records.desiredState(ext-receipt-v2)
//     为真源;v1-only 存量无 desired-state 通道,如实视为 enabled(与 setDesiredStateV2 的
//     fail-closed 语义一致);未安装恒 not-installed(不是 disabled —— 不塌缩);
//   · health(健康)—— 与前两维独立的诚实信号:上游归档 advisory(office-advisories,
//     REQ-105 archived 语义:警示、禁自动更新、绝不静默删除)、账本完整性(v1-compat 降级面)、
//     事务状态(REQ-100 接缝:pending/rolled-back ≠ 健康落定)。
//
// 全部纯函数 + JSON 纯值(IPC 序列化就绪);shared 纪律:无 node/electron 依赖。

// ── availability(可获得性)────────────────────────────────────────────────────────────────────

export const AVAILABILITY_STATES = ["installed", "bundled", "catalog", "unavailable"] as const
export type AvailabilityState = (typeof AVAILABILITY_STATES)[number]

export type AvailabilityInput = {
  /** 本机账本(records/receipts)有此条目。 */
  installed: boolean
  /** packaged seed 含此资产且平台兼容(platformCompatible=false 的资产不可获得,不算 bundled)。 */
  bundledCompatible: boolean
  /** 当前已验 catalog(remote/cache/内置快照)含此条目。 */
  inCatalog: boolean
}

export type AvailabilityView = {
  /** 最贴近本机的可获得层(installed ≻ bundled ≻ catalog ≻ unavailable)。 */
  state: AvailabilityState
  /** 全部来源如实保留(不塌缩:installed 的条目仍可见其 catalog/bundled 来源)。 */
  sources: { installed: boolean; bundled: boolean; catalog: boolean }
}

export function deriveAvailability(input: AvailabilityInput): AvailabilityView {
  const state: AvailabilityState = input.installed
    ? "installed"
    : input.bundledCompatible
      ? "bundled"
      : input.inCatalog
        ? "catalog"
        : "unavailable"
  return {
    state,
    sources: { installed: input.installed, bundled: input.bundledCompatible, catalog: input.inCatalog },
  }
}

// ── activation(激活态)─────────────────────────────────────────────────────────────────────────

export const ACTIVATION_STATES = ["enabled", "disabled", "not-installed"] as const
export type ActivationState = (typeof ACTIVATION_STATES)[number]

/** 激活态输入 = 账本事实的判别联合(v2 record / v1-only receipt / 无安装)。 */
export type ActivationInput =
  | { ledger: "none" }
  | { ledger: "v1" } // v1 无 desired-state 通道 —— 如实 enabled(历史语义:装了即生效)
  | { ledger: "v2"; desiredState: "enabled" | "disabled" }

export function deriveActivation(input: ActivationInput): ActivationState {
  if (input.ledger === "none") return "not-installed"
  if (input.ledger === "v1") return "enabled"
  return input.desiredState
}

// ── health(健康)───────────────────────────────────────────────────────────────────────────────

export const HEALTH_STATES = ["ok", "degraded", "unknown"] as const
export type HealthState = (typeof HEALTH_STATES)[number]

export type HealthIssue =
  | { kind: "archived-upstream"; catalogId: string; archivedAt: string } // REQ-105:上游归档,禁自动更新
  | { kind: "ledger-v1-compat" } // 仅 v1 receipt:无 digest/generation 链,完整性不可验(如实降级)
  | { kind: "transaction-pending"; transactionId: string } // REQ-100 接缝:安装未落定
  | { kind: "transaction-rolled-back"; transactionId: string } // REQ-100 接缝:上次事务已回滚

export type HealthInput = {
  /** 本机是否有安装(未安装且无 advisory → 健康不可知,不假装 ok)。 */
  installed: boolean
  /** office-advisories 命中(archived 语义;对 catalog 浏览面同样生效 —— 与 availability 正交)。 */
  advisory?: { catalogId: string; archivedAt: string }
  /** 账本形态:v2(digest/generation 可验)或 v1-compat(完整性不可验)。未安装时省略。 */
  ledger?: "v2" | "v1"
  /** record.transaction.state(REQ-100 接缝;v1/缺省视为已落定)。 */
  transactionState?: "committed" | "pending" | "rolled-back"
  transactionId?: string
}

export type HealthView = { state: HealthState; issues: HealthIssue[] }

export function deriveHealth(input: HealthInput): HealthView {
  const issues: HealthIssue[] = []
  if (input.advisory) issues.push({ kind: "archived-upstream", catalogId: input.advisory.catalogId, archivedAt: input.advisory.archivedAt })
  if (input.installed && input.ledger === "v1") issues.push({ kind: "ledger-v1-compat" })
  if (input.installed && input.transactionState === "pending")
    issues.push({ kind: "transaction-pending", transactionId: input.transactionId ?? "" })
  if (input.installed && input.transactionState === "rolled-back")
    issues.push({ kind: "transaction-rolled-back", transactionId: input.transactionId ?? "" })
  if (issues.length > 0) return { state: "degraded", issues }
  // 未安装且无 advisory:没有可探测的本机面 —— 健康如实 unknown(不塌缩成 ok)。
  if (!input.installed) return { state: "unknown", issues }
  return { state: "ok", issues }
}
