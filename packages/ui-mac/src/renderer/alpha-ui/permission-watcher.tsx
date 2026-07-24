// PermissionWatcher — 独立 Permission surface(REQ-090)。
//
// REQ-125 C7 / Codex 审计 Blocker-2:兜底面与 dock 共用同一 PermissionV2 feed 实现,
// 因此持有同一 fail-closed 标准 —— list 失败或拉取在途 = 不呈现、不放行(不保留旧请求
// 呈现,SSE 增量在 not-ready 期只并入本地列表,不单独成为可信来源);回复绑 request ID,
// stale/在途期回复在客户端即被拒绝。
// seam 会话页的 composer dock 接管当前会话的审批呈现时(进程内 claim,零 DOM 协调),
// watcher 让位;dock 卸载/降级即恢复兜底 —— 不呈现 = 不放行,fail-closed 不变。

import { onCleanup, Show } from "solid-js"
import { unwrap } from "solid-js/store"
import type { PermissionSurfaceProps } from "./providers"
import { PermissionDialog } from "./PermissionDialog"
import { sessionApprovalDockClaimed } from "./session-workspace/session-approval-claim"
import { createPermissionV2Feed } from "./session-workspace/session-permission-feed"

export function PermissionWatcher(props: PermissionSurfaceProps) {
  const feed = createPermissionV2Feed({
    list: () => props.client.list(),
    reply: (requestID, command) => props.client.reply(requestID, command),
  })
  const unsubscribe = props.client.subscribe({
    asked: (request) => feed.apply({ type: "asked", request }),
    replied: (receipt) => feed.apply({ type: "replied", receipt }),
    connected: () => feed.load(),
  })
  feed.load()
  onCleanup(() => {
    unsubscribe()
    feed.dispose()
  })

  return (
    <Show when={feed.state.ready && !sessionApprovalDockClaimed(props.sessionID) && feed.state.requests[0]} keyed>
      {(request) => {
        // 呈现前必须还原 raw 对象:solid store 代理会把 $PROXY 等符号注入 Reflect.ownKeys,
        // 而 permissionRequestFacts 的 exactFactRecord 是严格键集核验 —— 经代理传入会把
        // 一切合法请求误判为「核不实」并触发自动拒绝(2026-07-24 审计修复轮实测)。
        const raw = unwrap(request)
        return (
          <PermissionDialog
            request={raw}
            projectID={raw.scope?.kind === "project" ? raw.scope.projectID : props.projectID}
            onSubmit={(command) => feed.reply(raw.id, command)}
            onResolved={(receipt) => feed.apply({ type: "replied", receipt })}
          />
        )
      }}
    </Show>
  )
}
