import type {
  PermissionV2DecisionCommand,
  PermissionV2DecisionReceipt,
  PermissionV2Request,
} from "@opencode-ai/sdk/v2/client"
import { onCleanup, Show } from "solid-js"
import { createStore } from "solid-js/store"
import type { PermissionSurfaceProps } from "./providers"
import { PermissionDialog } from "./PermissionDialog"
import { sessionApprovalDockClaimed } from "./session-workspace/session-approval-claim"
import { reconcilePermissionRequests, type PermissionFeedDelta } from "./session-workspace/session-permission-feed"

type PermissionDelta = PermissionFeedDelta

export function PermissionWatcher(props: PermissionSurfaceProps) {
  const [state, setState] = createStore({ requests: [] as PermissionV2Request[] })
  const resolved = new Set<string>()
  let buffered: PermissionDelta[] | undefined
  let reconcileQueued = false
  let retryTimer: ReturnType<typeof setTimeout> | undefined
  let disposed = false

  const apply = (delta: PermissionDelta) => {
    if (buffered) {
      buffered.push(delta)
      return
    }
    setState("requests", (requests) => reconcilePermissionRequests(requests, [delta], resolved))
  }

  const add = (request: PermissionV2Request) => {
    if (resolved.has(request.id)) return
    apply({ type: "asked", request })
  }

  const resolve = (receipt: PermissionV2DecisionReceipt) => {
    const ids = new Set([receipt.requestID, ...receipt.resolvedRequestIDs])
    ids.forEach((id) => resolved.add(id))
    apply({ type: "replied", receipt })
  }

  const load = () => {
    if (disposed) return
    if (retryTimer) clearTimeout(retryTimer)
    retryTimer = undefined
    if (buffered) {
      reconcileQueued = true
      return
    }
    buffered = []
    props.client.list().then(
      (requests) => {
        if (disposed) return
        const deltas = buffered ?? []
        buffered = undefined
        setState("requests", reconcilePermissionRequests(requests, deltas, resolved))
        if (!reconcileQueued) return
        reconcileQueued = false
        void load()
      },
      () => {
        if (disposed) return
        const deltas = buffered ?? []
        buffered = undefined
        setState("requests", (requests) => reconcilePermissionRequests(requests, deltas, resolved))
        if (reconcileQueued) {
          reconcileQueued = false
          void load()
          return
        }
        retryTimer = setTimeout(() => void load(), 1_000)
      },
    )
  }

  const unsubscribe = props.client.subscribe({ asked: add, replied: resolve, connected: load })
  void load()
  onCleanup(() => {
    disposed = true
    unsubscribe()
    if (retryTimer) clearTimeout(retryTimer)
  })

  const reply = (request: PermissionV2Request, command: PermissionV2DecisionCommand) =>
    props.client.reply(request.id, command)

  return (
    // REQ-125 C7:seam 会话页的 composer dock 接管当前会话的审批呈现时,watcher 让位
    // (进程内 claim,零 DOM 协调);dock 卸载即恢复兜底 —— 不呈现 = 不放行,fail-closed 不变。
    <Show when={!sessionApprovalDockClaimed(props.sessionID) && state.requests[0]} keyed>
      {(request) => (
        <PermissionDialog
          request={request}
          projectID={request.scope?.kind === "project" ? request.scope.projectID : props.projectID}
          onSubmit={(command) => reply(request, command)}
          onResolved={resolve}
        />
      )}
    </Show>
  )
}
