// alpha 自有文件(basename `alpha-*`;ADR-043 谓词因子②)。
//
// REQ-131 / #1128 —— 分层工具策略的**三态 resolver**(#724 CLOSE_DECIDE §2/§3/§4/§5)。
//
// 合成顺序(§4,第一版的 `deny > ask > allow` 排序已被否决,这里是终局语义):
//   1. 先解析**不可突破的 cap**:managed deny、服务端 entitlement 缺失/deny、
//      现有 sovereignty/kill-switch deny。任一命中即 disabled。
//   2. 再解析当前账户+工作区的**用户 selector**(exact tool > service > class)。
//      用户 disabled 不可被 session grant 撬开;用户 enabled 可以替换 class 默认 ask,
//      但不能覆盖第 1 步 cap。service/tool 的 enabled 还要过 binding guard ——
//      binding 变了(rebind / 重装)回到 ask,不沿用旧授权。
//   3. 无 deny 时,仍适用的 ask 表示「本次调用待批准」,交给现有 Permission 引擎。
//   4. `once` / `always` 的会话语义在 Permission 引擎里(`./index.ts`):always 仅在
//      当前 sessionID 内保存,只能 discharge ask,永远压不过任何 deny。
//
// 本 resolver 是 #1129(目录与执行咽喉)与 #1130(Settings)要消费的那份 API;
// 本票不接线咽喉,也不建 UI。
import path from "path"
import { Global } from "@opencode-ai/core/global"
import type { ConfigMCPV1 } from "@opencode-ai/core/v1/config/mcp"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { Context, Effect, Layer, Schema } from "effect"
import { canonicalToolIdentity } from "@opencode-ai/schema/tool-identity"
import {
  classDefaultState,
  classifyTool,
  selectorKey,
  selectorMatches,
  selectorSpecificity,
  toPermissionAction,
  type ToolClass,
  type ToolPolicyPartition,
  type ToolPolicyRecord,
  type ToolPolicySelector,
  type ToolPolicyState,
  type ToolPolicySubject,
} from "@opencode-ai/schema/alpha-tool-policy"
import { InstanceState } from "@/effect/instance-state"
import { managedCapDenies, readManagedPolicy, type ManagedPolicyResult } from "./alpha-managed-policy"
import {
  canonicalJsonDigest,
  loadPolicyDocument,
  policyFilePath,
  resetPolicyDocument,
  savePolicyDocument,
  type PolicyLoadResult,
} from "./alpha-tool-policy-store"

// ── binding digest 派生(§5)────────────────────────────────────────────────────
// Alpha Cloud:直接复用 verified `authority.evidenceDigest`,不再派生第二个。
// 第三方 MCP:对**去秘密后的**有效 server definition 派生 —— headers / environment /
// oauth 里住着 token/secret,既不该进 digest 也不该因轮换而判 rebind;
// enabled/timeout 是运维参数,不是 binding。url(remote)/ command+cwd(local)
// 变了才是 rebind,旧的 service/tool enabled 必须失效回 ask。
export function mcpBindingEvidence(name: string, entry: ConfigMCPV1.Info): unknown {
  if (entry.type === "remote") return { kind: "mcp-remote", name, url: entry.url }
  return { kind: "mcp-local", name, command: entry.command, cwd: entry.cwd ?? null }
}

export function mcpBindingDigest(name: string, entry: ConfigMCPV1.Info): string {
  return canonicalJsonDigest(mcpBindingEvidence(name, entry))
}

/** plugin / 其它宿主派生 binding 证据的通用入口(安装 receipt / manifest / loader generation)。 */
export function deriveBindingDigest(evidence: unknown): string {
  return canonicalJsonDigest(evidence)
}

/** 主体当前 binding:Alpha Cloud 用 authority 证据,其余用调用方派生的 digest。 */
export function subjectBindingDigest(subject: ToolPolicySubject): string | undefined {
  if (subject.authority.kind === "alpha-cloud") return subject.authority.evidenceDigest
  return subject.bindingDigest
}

// ── effective policy ─────────────────────────────────────────────────────────
export type EffectiveToolPolicyReason =
  | { kind: "invalid-identity"; detail: string }
  | { kind: "cap-managed" }
  | { kind: "cap-managed-unreadable"; detail: string }
  | { kind: "cap-entitlement"; verdict: "deny" | "missing" }
  | { kind: "cap-hard-deny"; sources: readonly string[] }
  | { kind: "quarantine"; detail: string }
  | { kind: "user"; level: "class" | "service" | "tool" }
  | { kind: "binding-changed"; level: "service" | "tool" }
  | { kind: "default"; class: ToolClass }

export interface EffectiveToolPolicy {
  readonly state: ToolPolicyState
  /** 编译到现有 Permission 引擎的动作(§2:不另造第二个审批引擎)。 */
  readonly action: "allow" | "ask" | "deny"
  readonly reason: EffectiveToolPolicyReason
}

function effective(state: ToolPolicyState, reason: EffectiveToolPolicyReason): EffectiveToolPolicy {
  return { state, action: toPermissionAction(state), reason }
}

export interface ToolPolicyCaps {
  readonly managed: ManagedPolicyResult
  /** 服务端 entitlement 判定(§4 cap;由调用方在可得时传入 —— 本地永远造不出服务端 allow)。 */
  readonly entitlement?: "allow" | "deny" | "missing"
  /** 现有 sovereignty / kill-switch deny 的来源名单;非空即 cap 命中(只取交集,不替换)。 */
  readonly hardDeny?: readonly string[]
}

export type ToolPolicyUserLayer =
  | { status: "ok"; records: readonly ToolPolicyRecord[] }
  | { status: "absent" }
  | { status: "quarantined"; reason: string }

/**
 * 纯合成核(§4)。输入即全部事实,无 IO —— 让「一个错误实现能不能满足断言」
 * 在每一层都可单独证伪。
 */
export function resolveToolPolicy(input: {
  readonly subject: ToolPolicySubject
  readonly caps: ToolPolicyCaps
  readonly user: ToolPolicyUserLayer
}): EffectiveToolPolicy {
  // 0. identity 缺失/非法/分类矛盾 ⇒ disabled,不广告、loud fail(§2 第五行)。
  let canonical: string
  try {
    canonical = canonicalToolIdentity(input.subject.identity)
  } catch (error) {
    return effective("disabled", {
      kind: "invalid-identity",
      detail: error instanceof Error ? error.message : String(error),
    })
  }
  const cls = classifyTool(input.subject)
  if (cls === undefined) return effective("disabled", { kind: "invalid-identity", detail: "unclassifiable subject" })

  // 1. cap:任一命中即 disabled,任何下层(用户 enabled、session always)都撬不开。
  if (input.caps.managed.status === "unreadable")
    return effective("disabled", { kind: "cap-managed-unreadable", detail: input.caps.managed.reason })
  if (managedCapDenies(canonical, input.caps.managed.ruleset)) return effective("disabled", { kind: "cap-managed" })
  if (input.caps.entitlement === "deny" || input.caps.entitlement === "missing")
    return effective("disabled", { kind: "cap-entitlement", verdict: input.caps.entitlement })
  if (input.caps.hardDeny !== undefined && input.caps.hardDeny.length > 0)
    return effective("disabled", { kind: "cap-hard-deny", sources: input.caps.hardDeny })

  // 2. 用户层。quarantine ⇒ 所有用户可配置工具 disabled(保留上面的 cap 判定)。
  if (input.user.status === "quarantined")
    return effective("disabled", { kind: "quarantine", detail: input.user.reason })
  if (input.user.status === "ok") {
    const matches = input.user.records.filter((record) => selectorMatches(record.selector, input.subject))
    if (matches.length > 0) {
      const best = Math.max(...matches.map((record) => selectorSpecificity(record.selector)))
      const chosen = matches.filter((record) => selectorSpecificity(record.selector) === best)
      // 同层撞出两条都匹配的记录 ⇒ 它们必然是同一 selector 的重复(class/service/tool 对
      // 单一主体各自最多命中一条)—— 与 store 的唯一性闸同一条纪律:冲突即坏,fail-closed。
      if (chosen.length > 1)
        return effective("disabled", {
          kind: "quarantine",
          detail: `conflicting policy records for ${selectorKey(chosen[0]!.selector)}`,
        })
      const record = chosen[0]!
      const level = record.selector.level
      if (record.state === "disabled") return effective("disabled", { kind: "user", level })
      if (record.state === "ask") return effective("ask", { kind: "user", level })
      // enabled:class 是 broad intent(§3),service/tool 必须过 binding guard(§5)。
      if (level === "class") return effective("enabled", { kind: "user", level })
      const current = subjectBindingDigest(input.subject)
      if (current === undefined || current !== record.bindingDigest)
        return effective("ask", { kind: "binding-changed", level })
      return effective("enabled", { kind: "user", level })
    }
  }

  // 3. 四类默认(§2):本地 enabled,其余 ask;「新发现」工具吃默认。
  return effective(classDefaultState(cls), { kind: "default", class: cls })
}

// ── Effect service(#1129/#1130 消费的 API)────────────────────────────────────
export class ToolPolicyWriteError extends Schema.TaggedErrorClass<ToolPolicyWriteError>()(
  "ToolPolicyWriteError",
  { message: Schema.String },
) {}

export interface ResolveCapsInput {
  readonly entitlement?: "allow" | "deny" | "missing"
  readonly hardDeny?: readonly string[]
}

export interface Interface {
  /** 每次调用重读当前 cap 与用户文档(§6:executor 必须在调用时重读,不缓存旧对象)。 */
  readonly resolve: (
    subject: ToolPolicySubject,
    caps?: ResolveCapsInput,
  ) => Effect.Effect<EffectiveToolPolicy>
  readonly inspect: () => Effect.Effect<{ partition: ToolPolicyPartition; user: PolicyLoadResult }>
  readonly setRecord: (record: ToolPolicyRecord) => Effect.Effect<void, ToolPolicyWriteError>
  readonly removeRecord: (selector: ToolPolicySelector) => Effect.Effect<void, ToolPolicyWriteError>
  readonly reset: () => Effect.Effect<{ backup?: string }>
}

export class Service extends Context.Service<Service, Interface>()("@opencode/AlphaToolPolicy") {}

export interface LayerOptions {
  /** 测试注入口(生产零参):策略文档根目录。 */
  readonly baseDir?: string
  /** 测试注入口:账户 subject。生产默认 anonymous —— 引擎侧今天没有账户权威,#1129/#1130 接线。 */
  readonly account?: Effect.Effect<string>
  /** 测试注入口:managed cap 读取(生产 = `readManagedPolicy()`,系统目录不可被 env 替换)。 */
  readonly managed?: () => Promise<ManagedPolicyResult>
}

export const layer = (options?: LayerOptions) =>
  Layer.effect(
    Service,
    Effect.gen(function* () {
      const baseDir = options?.baseDir ?? path.join(Global.Path.data, "alpha-tool-policy")
      const accountEffect = options?.account ?? Effect.succeed("anonymous")
      const managedRead = options?.managed ?? (() => readManagedPolicy())

      const partition = Effect.gen(function* () {
        const account = yield* accountEffect
        const ctx = yield* InstanceState.context
        return { account, workspace: String(ctx.project.id) }
      })

      const resolve = Effect.fn("AlphaToolPolicy.resolve")(function* (
        subject: ToolPolicySubject,
        caps?: ResolveCapsInput,
      ) {
        const managed = yield* Effect.promise(managedRead)
        const part = yield* partition
        const loaded = loadPolicyDocument(baseDir, part)
        const user: ToolPolicyUserLayer =
          loaded.status === "ok"
            ? { status: "ok", records: loaded.doc.records }
            : loaded.status === "absent"
              ? { status: "absent" }
              : { status: "quarantined", reason: loaded.reason }
        return resolveToolPolicy({
          subject,
          caps: { managed, entitlement: caps?.entitlement, hardDeny: caps?.hardDeny },
          user,
        })
      })

      const inspect = Effect.fn("AlphaToolPolicy.inspect")(function* () {
        const part = yield* partition
        return { partition: part, user: loadPolicyDocument(baseDir, part) }
      })

      const mutate = (
        description: string,
        change: (records: readonly ToolPolicyRecord[]) => readonly ToolPolicyRecord[],
      ) =>
        Effect.gen(function* () {
          const part = yield* partition
          const loaded = loadPolicyDocument(baseDir, part)
          if (loaded.status === "quarantined")
            return yield* new ToolPolicyWriteError({
              message: `refusing to ${description}: policy document is quarantined (${loaded.reason}); reset to defaults first`,
            })
          const records = loaded.status === "ok" ? loaded.doc.records : []
          yield* Effect.try({
            try: () => savePolicyDocument(baseDir, part, change(records)),
            catch: (error) =>
              new ToolPolicyWriteError({
                message: error instanceof Error ? error.message : String(error),
              }),
          })
        })

      const setRecord = Effect.fn("AlphaToolPolicy.setRecord")(function* (record: ToolPolicyRecord) {
        yield* mutate("write a record", (records) => [
          ...records.filter((item) => selectorKey(item.selector) !== selectorKey(record.selector)),
          record,
        ])
      })

      const removeRecord = Effect.fn("AlphaToolPolicy.removeRecord")(function* (selector: ToolPolicySelector) {
        yield* mutate("remove a record", (records) =>
          records.filter((item) => selectorKey(item.selector) !== selectorKey(selector)),
        )
      })

      const reset = Effect.fn("AlphaToolPolicy.reset")(function* () {
        const part = yield* partition
        return resetPolicyDocument(baseDir, part)
      })

      return Service.of({ resolve, inspect, setRecord, removeRecord, reset })
    }),
  )

export const node = LayerNode.make({ service: Service, layer: layer(), deps: [] })

export { policyFilePath, type PolicyLoadResult, type ManagedPolicyResult }

export * as AlphaToolPolicy from "./alpha-tool-policy"
