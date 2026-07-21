import type {
  PermissionV2DecisionCommand,
  PermissionV2DecisionReceipt,
  PermissionV2Request,
} from "@opencode-ai/sdk/v2/client"
import { onCleanup, Show } from "solid-js"
import { createStore } from "solid-js/store"
import type { PermissionSurfaceProps } from "./providers"
import { PermissionDialog } from "./PermissionDialog"

type PermissionDelta =
  | { type: "asked"; request: PermissionV2Request }
  | { type: "replied"; receipt: PermissionV2DecisionReceipt }

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
    <Show when={state.requests[0]} keyed>
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

function reconcilePermissionRequests(
  snapshot: PermissionV2Request[],
  deltas: PermissionDelta[],
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
