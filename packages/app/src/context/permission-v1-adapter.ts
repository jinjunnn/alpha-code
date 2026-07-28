// #668 半场 A —— alpha 审批面同时消费 v1 与 v2 两条审批通道。
//
// 背景(#668 实测):两套 permission 栈完全独立、零桥接。v1 引擎(ADR-036 之后会话发送真正
// 跑的那一条)发 `permission.asked`,alpha 的审批呈现面(PermissionWatcher / PermissionDialog)
// 与 composer 停靠区的审批提示只订阅 `permission.v2.asked` —— 于是 v1 的每一次 `ask` 都没有
// 任何界面呈现,回合无限期挂起。
//
// owner 2026-07-28 裁决:**A(审批面同时订阅两条通道)**,且 v2 读侧不得被破坏。
// 否决了 B(引擎侧桥接,要动上游)与 C(恢复上游 v1 呈现面,重复 UI)。
//
// 本模块是那条订阅的**唯一实现**,同时供:
//   - 独立 Permission surface 的 client(`packages/app/src/context/permission-surface.tsx`,
//     app.tsx 唯一接线点);
//   - seam 会话页 composer 停靠区的审批挂起提示(`packages/ui-mac/.../session-composer-dock.tsx`)。
// 两个消费面共用同一份适配与同一份 fail-closed 语义,不允许各写一份。
//
// 纯模块:不 import solid、不 import 路由、不建 client —— 只做形状适配与订阅编排,
// 因此可以被闸门 harness 原样加载。

import type {
  PermissionRequest as PermissionV1Request,
  PermissionV2DecisionCommand,
  PermissionV2DecisionReceipt,
  PermissionV2Request,
} from "@opencode-ai/sdk/v2/client"
import type { DirectorySDK } from "./sdk"

/**
 * v1 请求被投影进审批面时携带的 fingerprint 前缀。
 *
 * v1 wire 上**没有** fingerprint(v2 的 fingerprint 是请求事实的 sha256,用于原子决定与 409)。
 * 这里铸的不是密码学指纹,而是一个**通道标记 + 陈旧绑定**:
 *   - 通道标记:决定提交时据此路由回 v1 `/permission/{id}/reply`,不需要额外的 id 表;
 *   - 陈旧绑定:提交前校验命令里的 requestFingerprint 与当前请求一致,切会话/已决请求回错单
 *     在客户端就被拒。
 * 命名刻意不像 sha256(64 位十六进制),这样它不可能被误当成 v2 指纹送进 v2 端点。
 */
export const PERMISSION_V1_FINGERPRINT_PREFIX = "engine-v1:"

export function permissionV1Fingerprint(requestID: string): string {
  return `${PERMISSION_V1_FINGERPRINT_PREFIX}${requestID}`
}

export function isPermissionV1Fingerprint(fingerprint: string | undefined): boolean {
  return typeof fingerprint === "string" && fingerprint.startsWith(PERMISSION_V1_FINGERPRINT_PREFIX)
}

/** 会话消息的最小读形状(store 里的 v1 message 联合的子集)。 */
export type PermissionAgentSource = ReadonlyArray<{ id: string; role: string; agent?: string }> | undefined

/**
 * 还原发起审批的 agent。
 *
 * v1 的 `permission.asked` wire 上没有 agent —— 但 v2 的 `subject` 事实要求它,而
 * PermissionDialog 的严格核验(`permissionRequestFacts`)在事实核不实时会**自动拒绝**。
 * 所以必须给一个**真的**答案,不能编:v1 请求携带 `tool.messageID`,那条 assistant 消息
 * 的 `agent` 字段就是发起这次工具调用的档位本身,来自同一条 SSE 流、同一个 store。
 *
 * 兜底顺序:精确消息 → 会话内最后一条带 agent 的 assistant 消息(同一回合正在跑的档位)。
 * 两者都取不到时返回 undefined —— 呈现面据此把请求判为"核不实"并 fail-closed 拒绝,
 * 而**不是**把请求丢掉(丢掉就退回 #668 的静默挂起)。
 */
export function resolvePermissionV1Agent(messages: PermissionAgentSource, messageID?: string): string | undefined {
  if (!messages?.length) return undefined
  const named = (value: { role: string; agent?: string }) =>
    value.role === "assistant" && typeof value.agent === "string" && !!value.agent.trim()
  if (messageID) {
    const exact = messages.find((message) => message.id === messageID)
    if (exact && named(exact)) return exact.agent
  }
  for (let index = messages.length - 1; index >= 0; index--) {
    const message = messages[index]!
    if (named(message)) return message.agent
  }
  return undefined
}

/**
 * v1 请求 → 审批面消费的请求形状。
 *
 * 逐字段的真实来源(没有一项是编出来的):
 * - `action`  ← v1 `permission`(external_directory / read / bash / …),就是被请求的能力;
 * - `resources` ← v1 `patterns`,就是具体的路径/命令 glob;
 * - `scope`   ← 请求所属会话;
 * - `expiresAt` = null —— v1 请求本身不带过期,与 v2 引擎给自己请求写的值相同;
 * - `source`  ← v1 `tool`(messageID/callID),形状与 v2 的 `{type:"tool"}` 完全一致;
 * - `subject` ← 上面的 agent 还原。
 *
 * **`save` 刻意不投影**,因此对话框的「始终允许」对 v1 请求保持禁用:v1 的 `always` 只是把规则
 * 推进引擎进程内存里的 approved ruleset(重启即失),而「始终允许」在 alpha 的文案里明确承诺的是
 * "为当前项目创建永久授权(grantExpiresAt = null)"。宁可少一个按钮,也不要在授权持久性上说谎。
 * 需要长期放行请写进 permission 规则(config)。
 */
export function adaptPermissionV1Request(
  request: PermissionV1Request,
  agentID: string | undefined,
): PermissionV2Request {
  return {
    id: request.id,
    sessionID: request.sessionID,
    fingerprint: permissionV1Fingerprint(request.id),
    subject: { kind: "agent", id: agentID ?? "" },
    action: request.permission,
    resources: [...request.patterns],
    scope: { kind: "session", sessionID: request.sessionID },
    expiresAt: null,
    ...(request.metadata ? { metadata: request.metadata } : {}),
    ...(request.tool ? { source: { type: "tool" as const, ...request.tool } } : {}),
  }
}

/** v1 应答 → 审批面消费的收据形状(feed 只据 requestID / resolvedRequestIDs 收卡)。 */
export function adaptPermissionV1Receipt(input: {
  sessionID: string
  requestID: string
  reply: "once" | "always" | "reject"
  decisionID?: string
}): PermissionV2DecisionReceipt {
  return {
    requestID: input.requestID,
    sessionID: input.sessionID,
    requestFingerprint: permissionV1Fingerprint(input.requestID),
    decisionID: input.decisionID ?? `pdec_v1_${input.requestID}`,
    decision: input.reply,
    committedAt: Date.now(),
    resolvedRequestIDs: [input.requestID],
  }
}

export type PermissionChannelListeners = {
  asked: (request: PermissionV2Request) => void
  replied: (receipt: PermissionV2DecisionReceipt) => void
  connected: () => void
}

export type PermissionChannelSource = {
  /** 两条通道的挂起快照合并。**任一通道读不到就整体失败** —— feed 据此保持 not-ready(零呈现、
   *  零放行)。半边成功半边静默丢弃正是 #668 的形态,不能作为"降级"重新引入。 */
  list: () => Promise<PermissionV2Request[]>
  subscribe: (listeners: PermissionChannelListeners) => () => void
}

export type PermissionChannelDeps = {
  sessionID: () => string | undefined
  sdk: () => DirectorySDK
  /** 当前会话的消息(用于 agent 还原);拿不到就给 undefined。 */
  messages: () => PermissionAgentSource
  /** 结果落地前的身份校验(会话切走后到达的结果一律丢弃)。默认恒真。 */
  accepts?: () => boolean
}

function assertAccepted(deps: PermissionChannelDeps) {
  if (deps.accepts && !deps.accepts()) throw new Error("session identity changed during permission list")
}

/** 两条通道的合并读 + 合并订阅。决定提交不在这里(见 permission-surface.tsx)。 */
export function createPermissionChannelSource(deps: PermissionChannelDeps): PermissionChannelSource {
  const listV2 = async () => {
    const sessionID = deps.sessionID()
    if (!sessionID) return []
    const result = await deps.sdk().client.v2.session.permission.list({ sessionID })
    assertAccepted(deps)
    if (!result.data) throw new Error("Permission list response is missing data")
    return result.data.data
  }

  const listV1 = async () => {
    const sessionID = deps.sessionID()
    if (!sessionID) return []
    const result = await deps.sdk().client.permission.list()
    assertAccepted(deps)
    if (!result.data) throw new Error("Permission (v1) list response is missing data")
    const messages = deps.messages()
    return result.data
      .filter((request) => request.sessionID === sessionID)
      .map((request) => adaptPermissionV1Request(request, resolvePermissionV1Agent(messages, request.tool?.messageID)))
  }

  return {
    list: () => Promise.all([listV2(), listV1()]).then(([v2, v1]) => [...v2, ...v1]),
    subscribe: (listeners) => {
      const sdk = deps.sdk()
      const stopAskedV2 = sdk.event.on("permission.v2.asked", (event) => {
        if (event.properties.sessionID !== deps.sessionID()) return
        listeners.asked(event.properties)
      })
      const stopRepliedV2 = sdk.event.on("permission.v2.replied", (event) => {
        if (event.properties.sessionID !== deps.sessionID()) return
        listeners.replied(event.properties)
      })
      const stopAskedV1 = sdk.event.on("permission.asked", (event) => {
        if (event.properties.sessionID !== deps.sessionID()) return
        listeners.asked(
          adaptPermissionV1Request(
            event.properties,
            resolvePermissionV1Agent(deps.messages(), event.properties.tool?.messageID),
          ),
        )
      })
      const stopRepliedV1 = sdk.event.on("permission.replied", (event) => {
        if (event.properties.sessionID !== deps.sessionID()) return
        listeners.replied(adaptPermissionV1Receipt(event.properties))
      })
      const stopConnected = sdk.event.on("server.connected", listeners.connected)
      return () => {
        stopAskedV2()
        stopRepliedV2()
        stopAskedV1()
        stopRepliedV1()
        stopConnected()
      }
    },
  }
}

/** 决定提交的通道路由:v1 指纹 → v1 `/permission/{id}/reply`;其余 → v2 原路。 */
export async function replyPermissionV1(
  sdk: DirectorySDK,
  input: { sessionID: string; requestID: string; command: PermissionV2DecisionCommand },
): Promise<PermissionV2DecisionReceipt> {
  if (input.command.requestFingerprint !== permissionV1Fingerprint(input.requestID))
    throw new Error(`stale permission reply rejected: ${input.requestID}`)
  await sdk.client.permission.reply({ requestID: input.requestID, reply: input.command.decision })
  return adaptPermissionV1Receipt({
    sessionID: input.sessionID,
    requestID: input.requestID,
    reply: input.command.decision,
    decisionID: input.command.decisionID,
  })
}
