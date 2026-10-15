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
/** 引擎那边还挂着的请求(快照 list 读它;回复后移除)—— SSE 重连时 feed 重读快照,读到的就是这些。 */
const pending = new Map<string, PermissionV2Request>()
/** 快照读悬置(SSE 重连期间 feed 不就绪的那段窗口);undefined = 照常 10 ms 后读回。 */
let listGate: Promise<void> | undefined
/** 引擎侧回复失败(client.reply 抛)—— 与「feed 不就绪时 feed 自己拒绝」是两种失败,后者到不了 client。 */
let replyFails = false

export function resetHarness() {
  replyCalls.splice(0)
  timeline.splice(0)
  pending.clear()
  listGate = undefined
  replyFails = false
  listeners = undefined
}

export function holdList(): () => void {
  let release = () => {}
  listGate = new Promise<void>((resolve) => (release = resolve))
  return () => {
    listGate = undefined
    release()
  }
}

export function setReplyFails(next: boolean) {
  replyFails = next
}

export function ask(request: PermissionV2Request) {
  pending.set(request.id, request)
  listeners?.asked(request)
}

/** 审计 R1 Major 3:SSE 重连 —— 生产 feed 收到 connected 就重读快照,期间不就绪(审批面卸载),读回来同一个请求再挂载。 */
export function reconnect() {
  listeners?.connected()
}

export function Harness() {
  return (
    <PermissionWatcher
      sessionID="ses_hub_1"
      projectID="prj_alpha"
      server={() => ({ baseUrl: "http://127.0.0.1:1", name: "sidecar" }) as never}
      client={{
        list: async () => {
          await listGate
          await new Promise((resolve) => setTimeout(resolve, 10))
          return [...pending.values()]
        },
        reply: (requestID, command) => {
          if (replyFails) {
            timeline.push(`reply-failed:${command.decision}`)
            return Promise.reject(new Error("engine refused the reply"))
          }
          pending.delete(requestID)
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
