// alpha 自有文件(basename `alpha-*`;ADR-043 谓词因子②)。
//
// REQ-131 / #1129(reopen)—— 策略**文档轴**抵达目录与执行咽喉的共享入口(#724 §3/§4/§6)。
//
// ── 两条轴与合成次序(#724 §4「deny 是上限,ask 是待裁决态」;不自创)────────────
// · **ruleset 轴**:config/agent/session 的 Permission ruleset(#1121/#1135 已接进咽喉的
//   identity 规则)。它对某个 exact canonical 的 **deny** 按 §4 第 1 步折进 cap
//   (`hardDeny: ["permission-ruleset"]`)—— deny 是上限,任何文档轴 enabled、任何
//   session grant 都撬不开;它的 ask/allow 留在 `Permission.ask` 原地生效(既有闸保留)。
// · **文档轴**:`AlphaToolPolicy.resolve`(#1128)—— caps(managed/entitlement/hard-deny)→
//   用户 selector(tool > service > class,binding guard)→ 四类默认(§2 表:本地 enabled,
//   其余 ask)。
// · 合成结果只有三种,全部编译进**同一个** Permission 引擎调用(§2:不另造第二个审批引擎):
//     deny  ⇒ 具名响亮拒绝(`PermissionV1.DeniedError`,载明 canonical 与 reason),
//             零 hook / 零副作用;session grant 结构性接触不到它。
//     ask   ⇒ 在这一次 `Permission.ask` 的 ruleset 末尾追加一条 exact-canonical 的 ask
//             (findLast 语义下压过默认 allow 底)⇒ 挂起等批准;once/always 的会话语义
//             原样是 #1128 的 grants。ruleset 轴自己的 ask 同样在这一问里生效 ——
//             **一次调用恰好一问**(§6 E3 的去重不回潮)。
//     allow ⇒ 文档轴不加 identity prompt;ruleset 轴与工具自身 ability 闸原样保留(§6)。
//
// ── snapshot vs 每次重读(§6)─────────────────────────────────────────────────
// 目录(catalog / DWS 预批清单 / inventory)可用**当轮 snapshot**(`snapshotEffective*`);
// **executor 必须在调用时重读**(`gateToolExecution` 每次调用走 `resolve()`,它重读
// managed cap 与用户文档;MCP 的当前 binding 也在调用时重新派生)—— Settings/managed/
// kill-switch 在模型拿到旧 catalog 后收紧,缓存的工具对象也执行不了。
//
// ── 为什么 gate 收**服务句柄**而不是 yield 服务 ───────────────────────────────
// code-mode 的子工具闸跑在 ToolRegistry 自己 materialize 的工具里 —— 若本模块 yield*
// ToolRegistry.Service,类型上就是 registry 依赖自己(层图自环)。调用方把自己作用域里
// 已有的句柄递进来,subject 的派生(mcp / plugin / builtin)也由调用方用自己的句柄完成。
import { Effect } from "effect"
import { PermissionV1 } from "@opencode-ai/core/v1/permission"
import { canonicalToolIdentity, type ToolAuthority, type ToolIdentity } from "@opencode-ai/schema/tool-identity"
import type { ToolPolicySubject } from "@opencode-ai/schema/alpha-tool-policy"
import { Permission } from "./index"
import {
  AlphaToolPolicy,
  resolveToolPolicy,
  type EffectiveToolPolicy,
  type ToolPolicyCaps,
  type ToolPolicyUserLayer,
} from "./alpha-tool-policy"
import { canonicalJsonDigest } from "./alpha-tool-policy-store"
import type { ManagedPolicyResult } from "./alpha-managed-policy"

/** ruleset 轴 deny 折进 cap 时的来源名(出现在 `cap-hard-deny.sources` 与 Settings 原因里)。 */
export const RULESET_HARD_DENY_SOURCE = "permission-ruleset"

/**
 * builtin / host / builtin-v2 的 binding(§5):它们随应用本体一起装载,没有独立的
 * rebind 生命周期 —— 常量证据 ⇒ service/tool 层的 enabled 记录不因版本升级失效。
 */
export const APP_BUILTIN_BINDING_DIGEST = canonicalJsonDigest({ kind: "alpha-app-builtin" })

export function builtinSubject(identity: ToolIdentity, authority: ToolAuthority): ToolPolicySubject {
  return { identity, authority, bindingDigest: APP_BUILTIN_BINDING_DIGEST }
}

/**
 * ruleset 轴对 exact canonical 的判定 —— 用**引擎自己的** `Permission.evaluate`
 * (identity ask 的 patterns 恒为 `["*"]`,与执行时同一形参),不手写第二个匹配器。
 */
export function rulesetIdentityAction(canonical: string, ruleset: PermissionV1.Ruleset): PermissionV1.Action {
  return Permission.evaluate(canonical, "*", ruleset).action
}

function foldRulesetCap(
  subject: ToolPolicySubject,
  ruleset: PermissionV1.Ruleset,
): { hardDeny: readonly string[] } {
  let canonical: string
  try {
    canonical = canonicalToolIdentity(subject.identity)
  } catch {
    // identity 铸不出 canonical ⇒ resolver 自己会判 invalid-identity/disabled,无需折 cap。
    return { hardDeny: [] }
  }
  return rulesetIdentityAction(canonical, ruleset) === "deny" ? { hardDeny: [RULESET_HARD_DENY_SOURCE] } : { hardDeny: [] }
}

/** 文档轴 + ruleset-deny cap 的合成判定(executor 侧:调用方每次调用重新进入,`resolve` 重读)。 */
export const effectiveToolPolicyNow = (
  policy: AlphaToolPolicy.Interface,
  subject: ToolPolicySubject,
  ruleset: PermissionV1.Ruleset,
): Effect.Effect<EffectiveToolPolicy> => policy.resolve(subject, foldRulesetCap(subject, ruleset))

/** 同一合成,但对**已取好的 snapshot** 求值(目录 / 预批 / inventory;§6 允许当轮 snapshot)。 */
export function effectiveFromSnapshot(
  snapshot: { managed: ManagedPolicyResult; user: ToolPolicyUserLayer },
  subject: ToolPolicySubject,
  ruleset: PermissionV1.Ruleset,
): EffectiveToolPolicy {
  const caps: ToolPolicyCaps = { managed: snapshot.managed, hardDeny: foldRulesetCap(subject, ruleset).hardDeny }
  return resolveToolPolicy({ subject, caps, user: snapshot.user })
}

function describeIdentity(identity: ToolIdentity): string {
  try {
    return canonicalToolIdentity(identity)
  } catch {
    return `${identity.source}:${identity.origin}:${identity.name}`
  }
}

function namedDeny(identity: ToolIdentity, effective: EffectiveToolPolicy): PermissionV1.DeniedError {
  // `ruleset` 载荷是 Schema.Any:这里放一条自述来源的记录,让 DeniedError.message
  // (JSON.stringify(ruleset))**点名 canonical 与拒绝原因** —— 用户与模型读到的是同一句话。
  return new PermissionV1.DeniedError({
    ruleset: [
      {
        permission: describeIdentity(identity),
        pattern: "*",
        action: "deny",
        source: "alpha-tool-policy",
        reason: effective.reason.kind,
      },
    ],
  })
}

export interface GateInput<R> {
  readonly policy: AlphaToolPolicy.Interface
  readonly permission: Permission.Interface
  /** 调用方派生的**当前**主体(mcp 当前 entry digest / plugin loader digest / builtin 常量)。 */
  readonly subject: Effect.Effect<ToolPolicySubject, never, R>
  readonly ruleset: PermissionV1.Ruleset
  readonly sessionID: PermissionV1.AskInput["sessionID"]
  readonly tool?: { messageID: string; callID: string }
  readonly metadata?: Record<string, unknown>
}

/**
 * 执行咽喉的统一闸(E1/E2/E3 经 `SessionTools.register`、E4 code-mode child、E6 direct
 * subtask 共用)。每次调用重读文档轴与当前 binding;deny 早于任何 hook/副作用。
 */
export const gateToolExecution = <R>(input: GateInput<R>): Effect.Effect<void, PermissionV1.Error, R> =>
  Effect.gen(function* () {
    const subject = yield* input.subject
    const effective = yield* effectiveToolPolicyNow(input.policy, subject, input.ruleset)
    if (effective.action === "deny") return yield* namedDeny(subject.identity, effective)
    // 到这里 identity 一定铸得出 canonical(否则上面已按 invalid-identity deny)。
    const canonical = canonicalToolIdentity(subject.identity)
    const askRuleset: PermissionV1.Ruleset =
      effective.action === "ask"
        ? [...input.ruleset, { permission: canonical, pattern: "*", action: "ask" }]
        : input.ruleset
    yield* input.permission.ask({
      permission: canonical,
      sessionID: input.sessionID,
      metadata: input.metadata ?? {},
      patterns: ["*"],
      always: ["*"],
      tool: input.tool,
      ruleset: askRuleset,
    })
  })

export interface CatalogSubject {
  readonly technicalId: string
  readonly identity: ToolIdentity
  readonly authority: ToolAuthority
}

/**
 * 目录侧(snapshot):这些工具按文档轴是 **deny** ⇒ 不广告(§6:「disabled:目录不广告」;
 * ask 照旧广告)。binding digest 刻意不参与 —— binding guard 只把 enabled 降级成 ask,
 * 从不产生 deny,而目录只关心 deny。`host::StructuredOutput` 按 §6 internal sentinel 免疫
 * (exact canonical;缺 identity 不享豁免)。
 */
export const snapshotCatalogDenied = (
  policy: AlphaToolPolicy.Interface,
  subjects: readonly CatalogSubject[],
  ruleset: PermissionV1.Ruleset,
): Effect.Effect<Set<string>> =>
  Effect.gen(function* () {
    const snap = yield* policy.snapshot()
    const denied = new Set<string>()
    for (const item of subjects) {
      if (Permission.isInternalSentinelIdentity(item.identity)) continue
      const effective = effectiveFromSnapshot(snap, { identity: item.identity, authority: item.authority }, ruleset)
      if (effective.action === "deny") denied.add(item.technicalId)
    }
    return denied
  })

/**
 * DWS 预批清单侧(snapshot;§6 E5「preapproved 只收 effective enabled」):按文档轴给出
 * 每个工具的动作。**刻意不带 binding digest** —— service/tool 层的 enabled 记录在缺 digest
 * 时按 binding-changed 降级为 ask ⇒ 不预批。方向是 fail-closed(至多多问,绝不少问);
 * executor 侧仍会带着真 digest 二次重读,不多拦一次真实调用。
 */
export const snapshotDocActions = (
  policy: AlphaToolPolicy.Interface,
  subjects: readonly CatalogSubject[],
  ruleset: PermissionV1.Ruleset,
): Effect.Effect<ReadonlyMap<string, PermissionV1.Action>> =>
  Effect.gen(function* () {
    const snap = yield* policy.snapshot()
    const actions = new Map<string, PermissionV1.Action>()
    for (const item of subjects) {
      const effective = effectiveFromSnapshot(snap, { identity: item.identity, authority: item.authority }, ruleset)
      actions.set(item.technicalId, effective.action)
    }
    return actions
  })

export * as AlphaToolPolicyGate from "./alpha-tool-policy-gate"
