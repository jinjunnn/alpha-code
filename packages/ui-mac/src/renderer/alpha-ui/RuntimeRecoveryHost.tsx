import { Show, createSignal, onCleanup } from "solid-js"
import { RECOVERY_ACTIONS, type RecoveryActionResult, type RecoveryIncidentWire } from "../../shared/recovery"
import { RecoverySurface } from "./RecoverySurface"

const [incident, setIncident] = createSignal<RecoveryIncidentWire>()
const [pending, setPending] = createSignal(false)
const [unavailable, setUnavailable] = createSignal(false)

/** Surface boundaries admit one promise into the sole runtime Recovery mount. */
export function admitSurfaceRecovery(started: Promise<RecoveryIncidentWire>) {
  setPending(true)
  setUnavailable(false)
  setIncident(undefined)
  void started.then(
    (wire) => {
      setIncident(wire)
      setPending(false)
    },
    () => {
      setPending(false)
      setUnavailable(true)
    },
  )
}

/** The sole runtime Recovery mount. Main sends opaque incidents; the host never renders raw faults. */
export function RuntimeRecoveryHost() {
  onCleanup(
    window.api.recovery.onIncident((wire) => {
      setPending(false)
      setUnavailable(false)
      setIncident(wire)
    }),
  )

  const applied = (result: RecoveryActionResult) => {
    if (!result.ok) return
    if (result.action === RECOVERY_ACTIONS.retryFailureSave) {
      const current = incident()
      if (!current) return
      setIncident({ ...current, plan: { ...current.plan, actions: [], retryable: false } })
      return
    }
    setIncident(undefined)
  }

  return (
    <Show when={pending() || unavailable() || incident()}>
      <RecoverySurface
        pending={pending()}
        unavailable={unavailable()}
        incident={incident()}
        submit={(incident, action) => window.api.recovery.submit({ incident, action })}
        onApplied={applied}
      />
    </Show>
  )
}
