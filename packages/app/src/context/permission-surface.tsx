// 审批呈现面的**唯一接线点**(#619 R3 Blocker-2 白名单登记面;#668 起同时喂两条通道)。
//
// 从 app.tsx 抽出来的原因不是整洁,是**可被闸门执行**:审批决定提交的接线点只有这一处,
// 而闸门要能在真实 DOM 里挂载它、点真的按钮、看真的 SDK 出口(ADR-037 决策 4)。抽成模块后
// `packages/ui-mac/src/renderer/alpha-ui/permission-dual-channel.test.ts` 挂的就是这份生产代码,
// 而不是测试里重写一遍的等价物。app.tsx 只保留一行 `createPermissionSurfaceMount(...)` 调用。
//
// #668:list / subscribe 走 permission-v1-adapter 的合并源(v1 `permission.asked` +
// v2 `permission.v2.asked`);reply 按请求 fingerprint 路由回各自的通道。v2 读侧的形状、
// fail-closed 语义与错误文案一字未动。

import { useParams } from "@solidjs/router"
import type {
  PermissionV2DecisionCommand,
  PermissionV2DecisionReceipt,
  PermissionV2Request,
} from "@opencode-ai/sdk/v2/client"
import { type Component, Show } from "solid-js"
import { Dynamic } from "solid-js/web"
import { useSDK } from "@/context/sdk"
import { useSync } from "@/context/sync"
import {
  createPermissionChannelSource,
  isPermissionV1Fingerprint,
  replyPermissionV1,
  type PermissionChannelListeners,
} from "@/context/permission-v1-adapter"

export interface PermissionSurfaceClient {
  list: () => Promise<PermissionV2Request[]>
  reply: (requestID: string, command: PermissionV2DecisionCommand) => Promise<PermissionV2DecisionReceipt>
  subscribe: (listeners: PermissionChannelListeners) => () => void
}

export interface PermissionSurfaceProps {
  sessionID: string
  projectID?: string
  client: PermissionSurfaceClient
}

export type PermissionSurfaceComponent = Component<PermissionSurfaceProps>

export function createPermissionSurfaceMount(PermissionSurface?: PermissionSurfaceComponent) {
  return function PermissionSurfaceMount() {
    const params = useParams()
    const sdk = useSDK()
    const sync = useSync()
    const channels = createPermissionChannelSource({
      sessionID: () => params.id,
      sdk: () => sdk(),
      messages: () => (params.id ? sync().data.message[params.id] : undefined),
    })
    const permissionClient: PermissionSurfaceClient = {
      list: () => channels.list(),
      reply: (requestID, command) => {
        // 通道路由:v1 投影出来的请求带 engine-v1 指纹,决定回 v1 `/permission/{id}/reply`;
        // 其余照旧走 v2 typed 端点(v2 读写两侧一字未改)。
        if (isPermissionV1Fingerprint(command.requestFingerprint))
          return replyPermissionV1(sdk(), { sessionID: params.id!, requestID, command })
        return sdk()
          .client.v2.session.permission.reply({
            sessionID: params.id!,
            requestID,
            permissionV2DecisionCommand: command,
          })
          .then((result) => {
            if (!result.data) throw new Error("Permission reply response is missing DecisionReceipt")
            return result.data.data
          })
      },
      subscribe: (listeners) => channels.subscribe(listeners),
    }

    return (
      <Show when={PermissionSurface && params.id} keyed>
        {(sessionID) => (
          <Dynamic
            component={PermissionSurface}
            sessionID={sessionID}
            projectID={sync().project?.id}
            client={permissionClient}
          />
        )}
      </Show>
    )
  }
}
