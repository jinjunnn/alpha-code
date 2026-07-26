// 单一审批面运行时闸门 harness(#619 R1 Blocker 复审)。
//
// 同一棵 Solid 树里**真实**挂载生产 PermissionWatcher(独立 Permission surface)与生产
// SessionComposerDock(内含生产 AlphaComposer),复现「同一审批请求同时到达两个消费面」
// 的生产相位。dock 侧 @opencode-ai/app 与 @solidjs/router 由 vite alias 换成录音替身
// (single-surface-app-stub / single-surface-router-stub);dock、composer、watcher 的
// 生产源码零改动 —— 被测的就是它们本体的运行时行为。

import { createOpencodeClient } from "@opencode-ai/sdk/v2/client"
import type {
  PermissionV2DecisionCommand,
  PermissionV2DecisionReceipt,
  PermissionV2Request,
} from "@opencode-ai/sdk/v2/client"
import { render } from "solid-js/web"
import type { AlphaProjectsApi } from "../../sidebar/use-projects"
import { PermissionWatcher } from "../permission-watcher"
import { SessionComposerDock } from "./session-composer-dock"
import { dockClientCalls, emitDockPermissionAsked, emitDockPermissionReplied, recordingClient, resetSingleSurfaceStub } from "./single-surface-app-stub"
import type { AlphaSessionIdentity, AlphaSessionLiveSnapshot } from "./session-workspace-core"

export { render, dockClientCalls }

export const HARNESS_IDENTITY: AlphaSessionIdentity = {
  serverKey: "sidecar",
  directory: "/tmp/workspace",
  sessionID: "ses_ui_1",
}

const snapshot: AlphaSessionLiveSnapshot = {
  identity: HARNESS_IDENTITY,
  project: "workspace",
  title: "整理架构说明",
  activity: "idle",
}

type SurfaceListeners = {
  asked: (request: PermissionV2Request) => void
  replied: (receipt: PermissionV2DecisionReceipt) => void
  connected: () => void
}

/** Permission surface client 收到的决定提交(唯一合法出口)。 */
export const surfaceReplyCalls: Array<{ requestID: string; command: PermissionV2DecisionCommand }> = []
/** surface client 对每次提交铸出的收据(供测试按生产 SSE 相位扇出)。 */
export const surfaceReceipts: PermissionV2DecisionReceipt[] = []
let surfaceListeners: SurfaceListeners | undefined

export function resetSingleSurfaceHarness() {
  surfaceReplyCalls.splice(0)
  surfaceReceipts.splice(0)
  surfaceListeners = undefined
  resetSingleSurfaceStub()
}

function receiptFor(requestID: string, command: PermissionV2DecisionCommand): PermissionV2DecisionReceipt {
  return {
    requestID,
    sessionID: HARNESS_IDENTITY.sessionID,
    requestFingerprint: command.requestFingerprint,
    decisionID: command.decisionID,
    decision: command.decision,
    ...(command.decision === "always"
      ? { grantScope: command.grantScope, grantExpiresAt: command.grantExpiresAt }
      : {}),
    committedAt: 1_893_456_000_001,
    resolvedRequestIDs: [requestID],
  }
}

/** 生产相位注入:同一请求经 watcher 订阅与 dock 的 dir 事件通道同时到达两个消费面。 */
export function injectPermissionAsked(request: PermissionV2Request) {
  surfaceListeners?.asked(request)
  emitDockPermissionAsked(request)
}

/** 决定收据按生产 SSE 相位双投递(watcher 在提交路径已本地 apply,双投递幂等)。 */
export function injectPermissionReplied(receipt: PermissionV2DecisionReceipt) {
  surfaceListeners?.replied(receipt)
  emitDockPermissionReplied(receipt)
}

/** R2 对抗探针:逐字复刻 Codex R2 打穿闸门的那种等义改写 —— **不新增任何 DOM**、
 *  在 dock 链路里**另建一个真实 SDK client**、再用方括号取值提交决定。
 *  探针走的是与生产代码完全相同的 import(`createOpencodeClient` from `@opencode-ai/sdk/v2/client`),
 *  因此它测的就是 harness 的 alias 是否真的把「新建 client」收进录音面:
 *  alias 在 → 调用记入 dockClientCalls,闸③红;alias 一旦被撤 → 变成真实 client 直发
 *  `POST /api/session/<id>/permission/<id>/reply`,零记录,回归测试立刻红。 */
export function submitDecisionViaFreshClient(requestID: string, fingerprint: string) {
  const fresh = createOpencodeClient({ baseUrl: "http://127.0.0.1:39117" }) as any
  const submitted = fresh["v2"]["session"]["permission"]["reply"]({
    sessionID: HARNESS_IDENTITY.sessionID,
    requestID,
    permissionV2DecisionCommand: {
      decision: "once",
      decisionID: "dec_fresh_client_probe",
      requestFingerprint: fingerprint,
    },
  })
  if (submitted && typeof submitted.catch === "function") submitted.catch(() => {})
}

function PermissionSurfaceMount() {
  return (
    <div data-harness-permission-surface>
      <PermissionWatcher
        sessionID={HARNESS_IDENTITY.sessionID}
        projectID="prj_alpha"
        client={{
          list: () => Promise.resolve([]),
          reply: (requestID, command) => {
            surfaceReplyCalls.push({ requestID, command })
            const receipt = receiptFor(requestID, command)
            surfaceReceipts.push(receipt)
            return Promise.resolve(receipt)
          },
          subscribe: (listeners) => {
            surfaceListeners = listeners
            return () => {
              surfaceListeners = undefined
            }
          },
        }}
      />
    </div>
  )
}

/** 参考渲染(#619 残余路径 2 闸门):**只**挂生产 Permission surface、不挂 dock。同一请求
 *  下它 portal 出的子树,就是「Permission surface 自身」的唯一定义 —— 主场景的 overlay 必须
 *  与之逐字节相等。dock 谱系的任何搭车节点不可能出现在这份参照里(参照场里根本没有 dock),
 *  因此不存在任何「按名字识别审批节点」的环节。 */
export function PermissionSurfaceReference() {
  return <PermissionSurfaceMount />
}

export function SingleSurfaceHarness() {
  const live = {
    current: () => snapshot,
    accepts: (identity: AlphaSessionIdentity) =>
      identity.serverKey === HARNESS_IDENTITY.serverKey &&
      identity.directory === HARNESS_IDENTITY.directory &&
      identity.sessionID === HARNESS_IDENTITY.sessionID,
  }
  const projects = { sdk: () => recordingClient } as unknown as AlphaProjectsApi
  return (
    <div data-harness-single-surface>
      <PermissionSurfaceMount />
      <div data-harness-dock>
        <SessionComposerDock live={live} projects={projects} />
      </div>
    </div>
  )
}
