import { createResource, Show } from "solid-js"
import { render } from "solid-js/web"
import type { RecoveryAction, RecoveryActionResult, RecoveryIncidentWire } from "../shared/recovery"
import { RecoverySurface } from "./alpha-ui/RecoverySurface"

declare global {
  interface Window {
    recovery: {
      current: () => Promise<RecoveryIncidentWire>
      submit: (incident: string, action: RecoveryAction) => Promise<RecoveryActionResult>
    }
  }
}

const root = document.getElementById("root")
if (!root) throw new Error("Recovery root is unavailable")

render(() => {
  const [incident] = createResource(() => window.recovery.current())
  return (
    <Show when={incident()} fallback={<RecoverySurface pending presentation="boot" submit={window.recovery.submit} />}>
      {(current) => <RecoverySurface incident={current()} presentation="boot" submit={window.recovery.submit} />}
    </Show>
  )
}, root)
