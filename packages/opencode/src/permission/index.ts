import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { ConfigPermissionV1 } from "@opencode-ai/core/v1/config/permission"
import { InstanceState } from "@/effect/instance-state"
import { Wildcard } from "@opencode-ai/core/util/wildcard"
import { Deferred, Effect, Layer, Context } from "effect"
import os from "os"
import { PermissionV1 } from "@opencode-ai/core/v1/permission"
import { EventV2Bridge } from "@/event-v2-bridge"
import { canonicalToolIdentity, type ToolIdentity } from "@opencode-ai/schema/tool-identity"

export const Event = PermissionV1.Event

// #668 / ADR-038 —— v1 审批请求的应答期限(alpha L3 接管面)。
//
// 上游 `Permission.ask` 在 `Deferred.await` 上**无超时**:没有任何应答者时,工具回合
// 无限期挂起、界面上没有 toast/通知/时间线条目,用户唯一的逃生口是手动中止(#668 实测)。
// 这里给它一个期限,并在期限到达时**以具名失败结束**——绝不到点自动放行:自动放行会把
// 一个可用性缺陷换成安全缺陷(owner 2026-07-28 对候选 D 的裁决)。
//
// 取值依据(300s):
// - 下界:审批对话框是阻断式模态,在场用户读完五条事实并核对路径通常以秒计;60s 一类的
//   短值会误伤"去核对一下这个路径再决定"的真实审批。
// - 上界:挂起期间整个回合冻结,期限必须短到"离开工位一趟回来就能看到结论",而不是隔天。
// - 不取更长:本期限是**兜底**——审批呈现面已在 #668 的 A 半场恢复(v1+v2 双通道订阅),
//   更长的期限只会延长静默期,换不来别的东西。
// 运维/测试可用 ALPHA_PERMISSION_ASK_TIMEOUT_MS 覆盖(正整数毫秒);非法值一律回落默认。
export const ASK_TIMEOUT_MS_DEFAULT = 300_000

function resolveAskTimeoutMs(): number {
  const raw = process.env["ALPHA_PERMISSION_ASK_TIMEOUT_MS"]
  if (raw === undefined || raw === "") return ASK_TIMEOUT_MS_DEFAULT
  const parsed = Number(raw)
  if (!Number.isFinite(parsed) || !Number.isInteger(parsed) || parsed <= 0) return ASK_TIMEOUT_MS_DEFAULT
  return parsed
}

/** 期限解析的直读入口(闸门用)。非法 env 必须回落默认,不得回落成"无期限"。 */
export const resolveAskTimeoutMsForTest = resolveAskTimeoutMs

/**
 * 期限到达且无人应答的具名失败(#668)。
 *
 * 继承 `PermissionV1.RejectedError` 是刻意的:
 * - 结局在语义上就是"没有放行"(fail-closed),与被拒绝同类;
 * - `packages/opencode/src/session/processor.ts` 按 `instanceof PermissionV1.RejectedError`
 *   把回合置为 blocked。若另起一个不相关的 tag,模型会拿着工具错误继续重试同一个需要审批
 *   的动作,把一次静默挂起变成一串静默挂起。
 * 与"被用户拒绝"的区别由 `message` 承载 —— 它会写进工具调用的 error 态(processor 的
 * `failToolCall`),因此是用户在时间线上真正读到的那句话,也是模型读到的那句话。
 */
export class UnansweredError extends PermissionV1.RejectedError {
  readonly detail: string

  constructor(input: { permission: string; patterns: ReadonlyArray<string>; timeoutMs: number }) {
    super()
    const seconds = Math.round(input.timeoutMs / 1000)
    this.detail =
      `审批请求等待 ${seconds} 秒无人应答,已按 fail-closed 结束:本次操作**没有**被放行。\n` +
      `请求:permission=${input.permission} patterns=${JSON.stringify(input.patterns)}\n` +
      `常见原因:审批对话框所在的会话页没有打开(切到了别的会话/别的页面),或审批面未连上本会话。\n` +
      `下一步:回到该会话页后重试这次操作;若这类操作应当长期放行,把它写进 permission 规则(config 里配成 allow),不要靠等待。`
  }

  override get message() {
    return this.detail
  }
}

export interface Interface {
  readonly ask: (input: PermissionV1.AskInput) => Effect.Effect<void, PermissionV1.Error>
  readonly reply: (input: PermissionV1.ReplyInput) => Effect.Effect<void, PermissionV1.NotFoundError>
  readonly list: () => Effect.Effect<ReadonlyArray<PermissionV1.Request>>
}

interface PendingEntry {
  info: PermissionV1.Request
  deferred: Deferred.Deferred<void, PermissionV1.RejectedError | PermissionV1.CorrectedError>
}

interface State {
  pending: Map<PermissionV1.ID, PendingEntry>
  approved: PermissionV1.Rule[]
}

export function evaluate(permission: string, pattern: string, ...rulesets: PermissionV1.Ruleset[]): PermissionV1.Rule {
  return (
    rulesets
      .flat()
      .findLast((rule) => Wildcard.match(permission, rule.permission) && Wildcard.match(pattern, rule.pattern)) ?? {
      action: "ask",
      permission,
      pattern: "*",
    }
  )
}

export class Service extends Context.Service<Service, Interface>()("@opencode/Permission") {}

const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const events = yield* EventV2Bridge.Service
    const state = yield* InstanceState.make<State>(
      Effect.fn("Permission.state")(function* (ctx) {
        void ctx
        const state = {
          pending: new Map<PermissionV1.ID, PendingEntry>(),
          approved: [],
        }

        yield* Effect.addFinalizer(() =>
          Effect.gen(function* () {
            for (const item of state.pending.values()) {
              yield* Deferred.fail(item.deferred, new PermissionV1.RejectedError())
            }
            state.pending.clear()
          }),
        )

        return state
      }),
    )

    const ask = Effect.fn("Permission.ask")(function* (input: PermissionV1.AskInput) {
      const { approved, pending } = yield* InstanceState.get(state)
      const { ruleset, ...request } = input
      let needsAsk = false

      for (const pattern of request.patterns) {
        const rule = evaluate(request.permission, pattern, ruleset, approved)
        yield* Effect.logInfo("evaluated", { permission: request.permission, pattern, action: rule })
        if (rule.action === "deny") {
          return yield* new PermissionV1.DeniedError({
            ruleset: ruleset.filter((rule) => Wildcard.match(request.permission, rule.permission)),
          })
        }
        if (rule.action === "allow") continue
        needsAsk = true
      }

      if (!needsAsk) return

      const id = request.id ?? PermissionV1.ID.ascending()
      const info: PermissionV1.Request = {
        id,
        sessionID: request.sessionID,
        permission: request.permission,
        patterns: request.patterns,
        metadata: request.metadata,
        always: request.always,
        tool: request.tool,
      }
      yield* Effect.logInfo("asking", { id, permission: info.permission, patterns: info.patterns })

      const deferred = yield* Deferred.make<void, PermissionV1.RejectedError | PermissionV1.CorrectedError>()
      pending.set(id, { info, deferred })
      yield* events.publish(Event.Asked, info)
      // #668:应答期限。到点 = 具名失败 + 广播一条 reject 回执(呈现面据此收回请求),
      // **不是**放行。orElse 的返回类型里没有成功分支,所以"到点自动 allow"在类型层面
      // 就不可能被顺手写出来。
      const timeoutMs = resolveAskTimeoutMs()
      return yield* Effect.ensuring(
        Effect.timeoutOrElse(Deferred.await(deferred), {
          duration: timeoutMs,
          orElse: () =>
            Effect.gen(function* () {
              yield* Effect.logWarning("permission ask unanswered — failing closed", {
                id,
                permission: info.permission,
                patterns: info.patterns,
                timeoutMs,
              })
              pending.delete(id)
              yield* events.publish(Event.Replied, {
                sessionID: info.sessionID,
                requestID: info.id,
                reply: "reject",
              })
              return yield* new UnansweredError({
                permission: info.permission,
                patterns: info.patterns,
                timeoutMs,
              })
            }),
        }),
        Effect.sync(() => {
          pending.delete(id)
        }),
      )
    })

    const reply = Effect.fn("Permission.reply")(function* (input: PermissionV1.ReplyInput) {
      const { approved, pending } = yield* InstanceState.get(state)
      const existing = pending.get(input.requestID)
      if (!existing) return yield* new PermissionV1.NotFoundError({ requestID: input.requestID })

      pending.delete(input.requestID)
      yield* events.publish(Event.Replied, {
        sessionID: existing.info.sessionID,
        requestID: existing.info.id,
        reply: input.reply,
      })

      if (input.reply === "reject") {
        yield* Deferred.fail(
          existing.deferred,
          input.message
            ? new PermissionV1.CorrectedError({ feedback: input.message })
            : new PermissionV1.RejectedError(),
        )

        for (const [id, item] of pending.entries()) {
          if (item.info.sessionID !== existing.info.sessionID) continue
          pending.delete(id)
          yield* events.publish(Event.Replied, {
            sessionID: item.info.sessionID,
            requestID: item.info.id,
            reply: "reject",
          })
          yield* Deferred.fail(item.deferred, new PermissionV1.RejectedError())
        }
        return
      }

      yield* Deferred.succeed(existing.deferred, undefined)
      if (input.reply === "once") return

      for (const pattern of existing.info.always) {
        approved.push({
          permission: existing.info.permission,
          pattern,
          action: "allow",
        })
      }

      for (const [id, item] of pending.entries()) {
        if (item.info.sessionID !== existing.info.sessionID) continue
        const ok = item.info.patterns.every(
          (pattern) => evaluate(item.info.permission, pattern, approved).action === "allow",
        )
        if (!ok) continue
        pending.delete(id)
        yield* events.publish(Event.Replied, {
          sessionID: item.info.sessionID,
          requestID: item.info.id,
          reply: "always",
        })
        yield* Deferred.succeed(item.deferred, undefined)
      }
    })

    const list = Effect.fn("Permission.list")(function* () {
      const pending = (yield* InstanceState.get(state)).pending
      return Array.from(pending.values(), (item) => item.info)
    })

    return Service.of({ ask, reply, list })
  }),
)

function expand(pattern: string): string {
  if (pattern.startsWith("~/")) return os.homedir() + pattern.slice(1)
  if (pattern === "~") return os.homedir()
  if (pattern.startsWith("$HOME/")) return os.homedir() + pattern.slice(5)
  if (pattern.startsWith("$HOME")) return os.homedir() + pattern.slice(5)
  return pattern
}

export function fromConfig(permission: ConfigPermissionV1.Info) {
  const ruleset: PermissionV1.Rule[] = []
  for (const [key, value] of Object.entries(permission)) {
    if (typeof value === "string") {
      ruleset.push({ permission: key, action: value, pattern: "*" })
      continue
    }
    ruleset.push(
      ...Object.entries(value).map(([pattern, action]) => ({ permission: key, pattern: expand(pattern), action })),
    )
  }
  return ruleset
}

export function merge(...rulesets: PermissionV1.Ruleset[]): PermissionV1.Rule[] {
  return rulesets.flat()
}

export type ToolPermissionSubject = { technicalId: string; identity: ToolIdentity }

export function disabled(
  tools: readonly (string | ToolPermissionSubject)[],
  ruleset: PermissionV1.Ruleset,
): Set<string> {
  const edits = ["edit", "write", "apply_patch"]
  const reads = ["list_mcp_resources", "list_mcp_resource_templates", "read_mcp_resource"]
  return new Set(
    tools.flatMap((subject) => {
      const tool = typeof subject === "string" ? subject : subject.technicalId
      const permission = edits.includes(tool) ? "edit" : reads.includes(tool) ? "read" : tool
      const ability = ruleset.findLast((rule) => Wildcard.match(permission, rule.permission))
      if (ability?.pattern === "*" && ability.action === "deny") return [tool]
      if (typeof subject === "string") return []
      const identity = canonicalToolIdentity(subject.identity)
      const identityRule = ruleset.findLast((rule) => Wildcard.match(identity, rule.permission))
      return identityRule?.pattern === "*" && identityRule.action === "deny" ? [tool] : []
    }),
  )
}

export function visibleTools<T>(tools: Record<string, T>, ruleset: PermissionV1.Ruleset): Record<string, T> {
  const subjects = Object.entries(tools).map(([technicalId, item]) => {
    if (!item || typeof item !== "object" || !("identity" in item) || !item.identity) return technicalId
    return { technicalId, identity: item.identity as ToolIdentity }
  })
  const hidden = disabled(subjects, ruleset)
  return Object.fromEntries(
    Object.entries(tools).filter(
      ([name, item]) =>
        !!item && typeof item === "object" && "identity" in item && !!item.identity && !hidden.has(name),
    ),
  )
}

export const node = LayerNode.make({ service: Service, layer: layer, deps: [EventV2Bridge.node] })

export * as Permission from "."
