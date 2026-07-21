import type {
  PermissionV2DecisionCommand,
  PermissionV2DecisionReceipt,
  PermissionV2Request,
} from "@opencode-ai/sdk/v2/client"
import { onCleanup, Show } from "solid-js"
import { createStore } from "solid-js/store"
import type { PermissionSurfaceProps } from "./providers"
import { PermissionDialog } from "./PermissionDialog"

export function PermissionWatcher(props: PermissionSurfaceProps) {
  const [state, setState] = createStore({ requests: [] as PermissionV2Request[] })
  const resolved = new Set<string>()
  let retryTimer: ReturnType<typeof setTimeout> | undefined
  let disposed = false

  const add = (request: PermissionV2Request) => {
    if (resolved.has(request.id)) return
    setState("requests", (requests) => {
      const index = requests.findIndex((item) => item.id === request.id)
      if (index < 0) return [...requests, request]
      return requests.map((item, itemIndex) => (itemIndex === index ? request : item))
    })
  }

  const resolve = (receipt: PermissionV2DecisionReceipt) => {
    const ids = new Set([receipt.requestID, ...receipt.resolvedRequestIDs])
    ids.forEach((id) => resolved.add(id))
    setState("requests", (requests) => requests.filter((request) => !ids.has(request.id)))
  }

  const load = () =>
    props.client.list().then(
      (requests) => {
        if (disposed) return
        setState(
          "requests",
          requests.filter((request) => !resolved.has(request.id)),
        )
      },
      () => {
        if (disposed) return
        retryTimer = setTimeout(() => void load(), 1_000)
      },
    )

  const unsubscribe = props.client.subscribe({ asked: add, replied: resolve })
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
          projectID={request.scope.kind === "project" ? request.scope.projectID : props.projectID}
          onSubmit={(command) => reply(request, command)}
          onResolved={resolve}
        />
      )}
    </Show>
  )
}
