// PermissionWatcher — 独立 Permission surface(REQ-090)。
//
// 审批呈现的**唯一路径**(owner 裁决 2026-07-25):seam 会话页 dock 不再挂审批卡,
// 也不存在呈现权让位/接管机制 —— 出现审批请求时恰好呈现一个 PermissionDialog。
// Codex 审计 Blocker-2 的 fail-closed 标准不变:list 失败或拉取在途 = 不呈现、不放行
// (不保留旧请求呈现,SSE 增量在 not-ready 期只并入本地列表,不单独成为可信来源);
// 回复绑 request ID,stale/在途期回复在客户端即被拒绝。
//
// REQ-234 `#1531`:按 `metadata.alphaHub` 分流 —— agent 经 hub_install 发来的安装请求由 HubInstallWatcher 接手,弹定制中心
// **自己的**安装确认框(确认之后由那个框发起安装);通用 PermissionDialog 不呈现它,于是同一个请求只有一个框。
// 两条分支都经**同一个** feed.reply 回审批(提交入口不变,仍只有这一处)。

import { onCleanup, Show, type Accessor } from "solid-js"
import { unwrap } from "solid-js/store"
import type { PermissionSurfaceProps } from "./providers"
import { createPermissionDecisionCommand, PermissionDialog } from "./PermissionDialog"
import { alphaHubRequestOf, HubInstallWatcher } from "./hub-install-watcher"
import { createPermissionV2Feed } from "./session-workspace/session-permission-feed"
import type { ServerInfo } from "../sidebar/use-projects"

export function PermissionWatcher(props: PermissionSurfaceProps & { server?: Accessor<ServerInfo | undefined> }) {
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
    <Show when={feed.state.ready && feed.state.requests[0]} keyed>
      {(request) => {
        // 呈现前还原 raw 对象。这是**纵深防御,不是承重判据**(REQ-090 #561 更正):承重的是
        // exactFactRecord 自己的判据域(自有可枚举字符串键)。unwrap 只把顶层换回 raw —— solid
        // 的 wrap() 把 $PROXY 盖在**原始对象自身**且 configurable:false,任何一处消费者只要先
        // 经代理读过 .subject/.scope,污染就永久刻在共享对象上,unwrap 当场失效且不报错。
        // 保留它的另一个理由:避免对话框对 store 建立反应性订阅。
        const raw = unwrap(request)
        const hub = alphaHubRequestOf(raw)
        if (hub)
          return (
            <HubInstallWatcher
              hub={hub}
              server={props.server ?? (() => undefined)}
              reply={(decision) => feed.reply(raw.id, createPermissionDecisionCommand(raw, decision))}
            />
          )
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
