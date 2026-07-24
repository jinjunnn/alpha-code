// REQ-125 C7:会话审批 dock 的 PermissionV2 typed feed。
//
// 语义(基线 §③.4 / I3 / I8):
// - fail-closed:`ready` 只在一次成功 list 之后为 true;读不到(list 失败/尚未返回)= 不呈现
//   任何可放行的审批 UI,事件增量只缓冲/合并,绝不单独把 feed 视为可信。
// - 回复绑 request ID:reply() 只接受「当前 ready 快照里仍然挂起」的请求,stale/重复回复在
//   客户端就被拒绝,不发往引擎(切会话/已决请求回错单的整类事故在此闸死)。
// - 与 PermissionWatcher(独立 Permission surface)共用同一 reconcile 语义;watcher 保持
//   全局兜底,seam 会话页经 session-approval-claim 声明接管时才停渲对话框。

import type {
  PermissionV2DecisionCommand,
  PermissionV2DecisionReceipt,
  PermissionV2Request,
} from "@opencode-ai/sdk/v2/client"
import { createStore, type Store } from "solid-js/store"

export type PermissionFeedDelta =
  | { type: "asked"; request: PermissionV2Request }
  | { type: "replied"; receipt: PermissionV2DecisionReceipt }

/** 快照 + 增量 → 当前挂起请求列表(与 PermissionWatcher 单一同源的纯函数)。 */
export function reconcilePermissionRequests(
  snapshot: PermissionV2Request[],
  deltas: PermissionFeedDelta[],
  resolved: Set<string>,
) {
  return [...snapshot.map((request) => ({ type: "asked", request }) as const), ...deltas].reduce<PermissionV2Request[]>(
    (requests, delta) => {
      if (delta.type === "replied") {
        const ids = new Set([delta.receipt.requestID, ...delta.receipt.resolvedRequestIDs])
        return requests.filter((request) => !ids.has(request.id))
      }
      if (resolved.has(delta.request.id)) return requests
      const index = requests.findIndex((request) => request.id === delta.request.id)
      if (index < 0) return [...requests, delta.request]
      return requests.map((request, itemIndex) => (itemIndex === index ? delta.request : request))
    },
    [],
  )
}

export type PermissionFeedClient = {
  list: () => Promise<PermissionV2Request[]>
  reply: (requestID: string, command: PermissionV2DecisionCommand) => Promise<PermissionV2DecisionReceipt>
}

export type PermissionFeedState = {
  /** true 仅当最近一次 list 成功且尚未失效;false 时 UI 不得呈现任何可放行动作。 */
  ready: boolean
  requests: PermissionV2Request[]
}

export type PermissionV2Feed = {
  state: Store<PermissionFeedState>
  /** SSE 事件入口(asked/replied);list 未落地时缓冲,落地后按序合并。 */
  apply: (delta: PermissionFeedDelta) => void
  /** (重新)拉取快照;失败按 retryMs 有界重试,期间 ready 保持 false。 */
  load: () => void
  /**
   * 决定提交。仅接受 ready 快照中仍挂起的 requestID;stale(已决/未知/feed 未就绪)直接
   * reject,不发网络请求。成功收据在本地立即 resolve 对应请求。
   */
  reply: (requestID: string, command: PermissionV2DecisionCommand) => Promise<PermissionV2DecisionReceipt>
  dispose: () => void
}

export function createPermissionV2Feed(client: PermissionFeedClient, options?: { retryMs?: number }): PermissionV2Feed {
  const retryMs = options?.retryMs ?? 1_000
  const [state, setState] = createStore<PermissionFeedState>({ ready: false, requests: [] })
  const resolved = new Set<string>()
  let buffered: PermissionFeedDelta[] | undefined
  let reloadQueued = false
  let retryTimer: ReturnType<typeof setTimeout> | undefined
  let disposed = false

  const apply = (delta: PermissionFeedDelta) => {
    if (disposed) return
    if (delta.type === "replied") {
      const ids = new Set([delta.receipt.requestID, ...delta.receipt.resolvedRequestIDs])
      ids.forEach((id) => resolved.add(id))
    } else if (resolved.has(delta.request.id)) {
      return
    }
    if (buffered) {
      buffered.push(delta)
      return
    }
    setState("requests", (requests) => reconcilePermissionRequests(requests, [delta], resolved))
  }

  const load = () => {
    if (disposed) return
    if (retryTimer) clearTimeout(retryTimer)
    retryTimer = undefined
    if (buffered) {
      reloadQueued = true
      return
    }
    buffered = []
    client.list().then(
      (requests) => {
        if (disposed) return
        const deltas = buffered ?? []
        buffered = undefined
        setState({ ready: true, requests: reconcilePermissionRequests(requests, deltas, resolved) })
        if (!reloadQueued) return
        reloadQueued = false
        load()
      },
      () => {
        if (disposed) return
        const deltas = buffered ?? []
        buffered = undefined
        // fail-closed:快照读不到 → 不就绪;增量仍并入本地列表以便快照恢复后无缝接上。
        setState("ready", false)
        setState("requests", (requests) => reconcilePermissionRequests(requests, deltas, resolved))
        if (reloadQueued) {
          reloadQueued = false
          load()
          return
        }
        retryTimer = setTimeout(load, retryMs)
      },
    )
  }

  const reply = (requestID: string, command: PermissionV2DecisionCommand) => {
    if (disposed) return Promise.reject(new Error("permission feed is disposed"))
    if (!state.ready) return Promise.reject(new Error("permission feed is not ready"))
    if (resolved.has(requestID) || !state.requests.some((request) => request.id === requestID)) {
      return Promise.reject(new Error(`stale permission reply rejected: ${requestID}`))
    }
    return client.reply(requestID, command).then((receipt) => {
      apply({ type: "replied", receipt })
      return receipt
    })
  }

  return {
    state,
    apply,
    load,
    reply,
    dispose: () => {
      disposed = true
      if (retryTimer) clearTimeout(retryTimer)
      retryTimer = undefined
      buffered = undefined
    },
  }
}
