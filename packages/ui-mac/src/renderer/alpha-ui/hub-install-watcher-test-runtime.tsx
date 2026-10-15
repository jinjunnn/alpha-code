// REQ-234 `#1531`:hub-install-watcher.test.ts 的运行时 —— 生产 PermissionWatcher 挂一个可驱动的 surface client,
// 审批请求从它的 subscribe 进来,回复记在 replyCalls(唯一合法出口,与生产 permission-surface 同形)。
import type { PermissionV2DecisionCommand, PermissionV2DecisionReceipt, PermissionV2Request } from "@opencode-ai/sdk/v2/client"
import { render } from "solid-js/web"
import { PermissionWatcher } from "./permission-watcher"
import { setPathname } from "./hub-install-watcher-stub"

export { render, setPathname }

type Listeners = {
  asked: (request: PermissionV2Request) => void
  replied: (receipt: PermissionV2DecisionReceipt) => void
  connected: () => void
}

export const replyCalls: Array<{ requestID: string; command: PermissionV2DecisionCommand }> = []
/** 审计 R1 Minor 5:阶段**完成**(测试的 IPC 桩写)与**真实**回复(这里写)排进同一条时间线,顺序由事件发生的先后决定。 */
export const timeline: string[] = []
let listeners: Listeners | undefined

export function resetHarness() {
  replyCalls.splice(0)
  timeline.splice(0)
  listeners = undefined
}

export function ask(request: PermissionV2Request) {
  listeners?.asked(request)
}

export function Harness() {
  return (
    <PermissionWatcher
      sessionID="ses_hub_1"
      projectID="prj_alpha"
      server={() => ({ baseUrl: "http://127.0.0.1:1", name: "sidecar" }) as never}
      client={{
        list: () => Promise.resolve([]),
        reply: (requestID, command) => {
          replyCalls.push({ requestID, command })
          timeline.push(`reply:${command.decision}`)
          return Promise.resolve({
            requestID,
            sessionID: "ses_hub_1",
            requestFingerprint: command.requestFingerprint,
            decisionID: command.decisionID,
            decision: command.decision,
            committedAt: 1,
            resolvedRequestIDs: [requestID],
          } as PermissionV2DecisionReceipt)
        },
        subscribe: (next) => {
          listeners = next
          return () => {
            listeners = undefined
          }
        },
      }}
    />
  )
}
