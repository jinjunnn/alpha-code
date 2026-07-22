import { For, Show, createMemo, createSignal } from "solid-js"
import {
  RECOVERY_ACTIONS,
  type RecoveryAction,
  type RecoveryActionResult,
  type RecoveryIncidentWire,
  type RecoveryPlanView,
} from "../../shared/recovery"
import "./recovery-surface.css"
import { t } from "../i18n"

export function RecoverySurface(props: {
  incident?: RecoveryIncidentWire
  pending?: boolean
  unavailable?: boolean
  submit: (incident: string, action: RecoveryAction) => Promise<RecoveryActionResult>
  onApplied?: (result: RecoveryActionResult) => void
  presentation?: "boot" | "overlay"
}) {
  const [submitting, setSubmitting] = createSignal<RecoveryAction>()
  const [status, setStatus] = createSignal<string>()
  const content = createMemo(() => recoveryContent(props.incident?.plan))

  const submit = async (action: RecoveryAction) => {
    const incident = props.incident
    if (!incident || submitting()) return
    setSubmitting(action)
    setStatus(t("alpha.recovery.running"))
    const result = await props.submit(incident.incident, action).catch(
      (): RecoveryActionResult => ({
        ok: false,
        code: "RECOVERY_ACTION_FAILED",
        action,
        retryable: incident.plan.retryable,
      }),
    )
    setSubmitting(undefined)
    if (!result.ok) {
      setStatus(result.retryable ? t("alpha.recovery.retryable") : t("alpha.recovery.notRetryable"))
      return
    }
    setStatus(result.applied ? t("alpha.recovery.completed") : t("alpha.recovery.alreadyCompleted"))
    props.onApplied?.(result)
  }

  return (
    <section
      class="a-ui a-recovery"
      data-presentation={props.presentation ?? "overlay"}
      data-recovery-code={props.incident?.plan.code ?? "pending"}
      data-recovery-category={props.incident?.plan.category ?? "pending"}
      aria-labelledby="alpha-recovery-title"
    >
      <div class="a-recovery-shell">
        <header class="a-recovery-brand" aria-label={t("alpha.brand.product")}>
          <span class="a-recovery-mark" aria-hidden="true">
            α
          </span>
          <span>{t("alpha.brand.product")}</span>
        </header>
        <main class="a-recovery-main">
          <p class="a-recovery-kicker">{t("alpha.recovery.kicker")}</p>
          <h1 id="alpha-recovery-title">
            {props.pending ? t("alpha.recovery.preparing") : props.unavailable ? t("alpha.recovery.unavailable") : content().title}
          </h1>
          <p class="a-recovery-summary">
            {props.pending
              ? t("alpha.recovery.pendingDetail")
              : props.unavailable
                ? t("alpha.recovery.unavailableDetail")
                : content().summary}
          </p>
          <Show when={!props.pending && !props.unavailable}>
            <div class="a-recovery-card">
              <div class="a-recovery-card-heading">
                <span class="a-recovery-status-dot" aria-hidden="true" />
                <div>
                  <strong>{content().cardTitle}</strong>
                  <p>{content().detail}</p>
                </div>
              </div>
              <Show when={(props.incident?.plan.actions.length ?? 0) > 0}>
                <div class="a-recovery-actions">
                  <For each={props.incident?.plan.actions ?? []}>
                    {(action, index) => (
                      <button
                        type="button"
                        data-action={action}
                        data-emphasis={
                          index() === 0
                            ? "primary"
                            : action === RECOVERY_ACTIONS.continueStartup
                              ? "danger"
                              : "secondary"
                        }
                        disabled={!!submitting()}
                        autofocus={index() === 0}
                        onClick={() => void submit(action)}
                      >
                        {actionLabel(action)}
                      </button>
                    )}
                  </For>
                </div>
              </Show>
            </div>
          </Show>
          <p class="a-recovery-live" aria-live="polite" role="status">
            {status()}
          </p>
          <p class="a-recovery-privacy">{t("alpha.recovery.privacy")}</p>
        </main>
      </div>
    </section>
  )
}

type RecoveryContent = {
  title: string
  summary: string
  cardTitle: string
  detail: string
}

function recoveryContent(plan?: RecoveryPlanView): RecoveryContent {
  if (plan?.category === "database-corrupt") {
    return {
      title: t("alpha.recovery.dbCorruptTitle"),
      summary: t("alpha.recovery.dbCorruptSummary"),
      cardTitle: t("alpha.recovery.dbCorruptCard"),
      detail: plan.actions.includes(RECOVERY_ACTIONS.restoreLatestBackup)
        ? t("alpha.recovery.dbCorruptBackup")
        : t("alpha.recovery.dbCorruptNoBackup"),
    }
  }
  if (plan?.category === "database-too-new") {
    return {
      title: t("alpha.recovery.tooNewTitle"),
      summary: t("alpha.recovery.tooNewSummary"),
      cardTitle: t("alpha.recovery.tooNewCard"),
      detail: t("alpha.recovery.tooNewDetail"),
    }
  }
  if (plan?.category === "engine-stopped") {
    return {
      title: t("alpha.recovery.engineTitle"),
      summary: t("alpha.recovery.engineSummary"),
      cardTitle: t("alpha.recovery.engineCard"),
      detail: t("alpha.recovery.engineDetail"),
    }
  }
  if (plan?.actions.includes(RECOVERY_ACTIONS.retryFailureSave)) {
    return {
      title: t("alpha.recovery.saveTitle"),
      summary: t("alpha.recovery.saveSummary"),
      cardTitle: t("alpha.recovery.saveCard"),
      detail: t("alpha.recovery.saveDetail"),
    }
  }
  return {
    title: t("alpha.recovery.surfaceTitle"),
    summary: t("alpha.recovery.surfaceSummary"),
    cardTitle: t("alpha.recovery.surfaceCard"),
    detail: t("alpha.recovery.surfaceDetail"),
  }
}

function actionLabel(action: RecoveryAction) {
  if (action === RECOVERY_ACTIONS.restoreLatestBackup) return t("alpha.recovery.restoreBackup")
  if (action === RECOVERY_ACTIONS.exitApp) return t("alpha.recovery.exit")
  if (action === RECOVERY_ACTIONS.continueStartup) return t("alpha.recovery.continue")
  if (action === RECOVERY_ACTIONS.backupAndContinue) return t("alpha.recovery.backupContinue")
  if (action === RECOVERY_ACTIONS.retryEngine) return t("alpha.recovery.retryEngine")
  return t("alpha.recovery.retrySave")
}
