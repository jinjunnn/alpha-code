import type {
  PermissionV2Decision,
  PermissionV2DecisionCommand,
  PermissionV2DecisionReceipt,
  PermissionV2Request,
} from "@opencode-ai/sdk/v2/client"
import { For, onMount, Show } from "solid-js"
import { createStore } from "solid-js/store"
import { Button } from "./Button"
import { Dialog } from "./Dialog"
import { t } from "../i18n"
import "./permission-dialog.css"

export type PermissionDecisionSubmitError = {
  kind: "conflict" | "failed"
  message: string
}

export function createPermissionDecisionCommand(
  request: PermissionV2Request,
  decision: PermissionV2Decision,
  projectID?: string,
  decisionID = `pdec_${crypto.randomUUID()}`,
): PermissionV2DecisionCommand {
  if (decision !== "always") {
    return {
      requestFingerprint: request.fingerprint,
      decisionID,
      decision,
    }
  }
  if (!projectID) throw new Error("Always permission requires the active project ID")
  return {
    requestFingerprint: request.fingerprint,
    decisionID,
    decision,
    grantScope: { kind: "project", projectID },
    grantExpiresAt: null,
  }
}

export function PermissionDialog(props: {
  request: PermissionV2Request
  projectID?: string
  onSubmit: (command: PermissionV2DecisionCommand) => Promise<PermissionV2DecisionReceipt>
  onResolved?: (receipt: PermissionV2DecisionReceipt) => void
}) {
  const facts = permissionRequestFacts(props.request)
  const [state, setState] = createStore<{
    submitting?: PermissionV2DecisionCommand
    failed?: { command: PermissionV2DecisionCommand; error: PermissionDecisionSubmitError }
  }>({})
  let errorSummary: HTMLDivElement | undefined

  const canAlways = () =>
    facts.verified &&
    typeof props.projectID === "string" &&
    !!props.projectID.trim() &&
    Array.isArray(props.request.save) &&
    props.request.save.length > 0 &&
    props.request.save.every((resource) => typeof resource === "string")

  const decide = (decision: PermissionV2Decision) => {
    if (state.submitting) return
    const safeDecision = facts.verified ? decision : "reject"
    if (safeDecision === "always" && !canAlways()) return
    const command =
      state.failed?.command.decision === safeDecision
        ? state.failed.command
        : createPermissionDecisionCommand(props.request, safeDecision, props.projectID)

    setState({ submitting: command, failed: undefined })
    props.onSubmit(command).then(
      (receipt) => {
        setState("submitting", undefined)
        props.onResolved?.(receipt)
      },
      (error) => {
        setState({ submitting: undefined, failed: { command, error: permissionDecisionSubmitError(error) } })
        queueMicrotask(() => errorSummary?.focus())
      },
    )
  }

  onMount(() => {
    if (!facts.verified) decide("reject")
  })

  const actionLabel = (decision: PermissionV2Decision) => {
    const label = decision === "once" ? t("alpha.permission.once") : decision === "always" ? t("alpha.permission.always") : t("alpha.permission.reject")
    if (state.submitting?.decision === decision) return t("alpha.permission.submitting")
    return state.failed?.command.decision === decision ? t("alpha.permission.retryDecision", { label }) : label
  }

  return (
    <Dialog
      open
      title={t("alpha.permission.title")}
      description={<span>{t("alpha.permission.description")}</span>}
      size="md"
      dismissible={false}
      busy={!!state.submitting}
      restoreFocus={() => document.querySelector<HTMLTextAreaElement>('[data-alpha-composer="session"] textarea')}
      onClose={() => {}}
      footer={
        <div class="a-permission-footer">
          <small class="a-permission-grant-note">{t("alpha.permission.alwaysNote")}</small>
          <div class="a-permission-actions">
            <Button
              type="button"
              variant="danger"
              disabled={!!state.submitting}
              onClick={() => decide("reject")}
              data-permission-decision="reject"
            >
              {actionLabel("reject")}
            </Button>
            <Button
              type="button"
              variant="secondary"
              disabled={!!state.submitting || !canAlways()}
              title={
                !facts.verified
                  ? t("alpha.permission.unverified")
                  : !props.projectID?.trim()
                    ? t("alpha.permission.projectUnverified")
                    : !Array.isArray(props.request.save) || !props.request.save.length
                      ? t("alpha.permission.noSavedResources")
                      : undefined
              }
              onClick={() => decide("always")}
              data-permission-decision="always"
            >
              {actionLabel("always")}
            </Button>
            <Button
              type="button"
              variant="primary"
              autofocus
              disabled={!!state.submitting || !facts.verified}
              title={!facts.verified ? t("alpha.permission.unverified") : undefined}
              onClick={() => decide("once")}
              data-permission-decision="once"
            >
              {actionLabel("once")}
            </Button>
          </div>
        </div>
      }
    >
      <dl class="a-permission-facts" aria-label={t("alpha.permission.facts") }>
        <div class="a-permission-fact" data-permission-fact="subject">
          <dt>{t("alpha.permission.subject")}</dt>
          <Show
            when={facts.subject}
            fallback={
              <>
                <dd>{t("alpha.permission.cannotVerify")}</dd>
                <small>{t("alpha.permission.subjectMissing")}</small>
              </>
            }
          >
            {(subject) => (
              <>
                <dd>{subject().id}</dd>
                <small>subject.kind = {subject().kind}</small>
              </>
            )}
          </Show>
        </div>
        <div class="a-permission-fact" data-permission-fact="action">
          <dt>{t("alpha.permission.action")}</dt>
          <Show
            when={facts.action}
            fallback={
              <>
                <dd>{t("alpha.permission.cannotVerify")}</dd>
                <small>{t("alpha.permission.actionMissing")}</small>
              </>
            }
          >
            {(action) => (
              <>
                <dd>{action()}</dd>
                <small>{t("alpha.permission.actionHint")}</small>
              </>
            )}
          </Show>
        </div>
        <div class="a-permission-fact a-permission-fact--wide" data-permission-fact="resources">
          <dt>{t("alpha.permission.resources")}</dt>
          <Show
            when={facts.resources}
            fallback={
              <>
                <dd>{t("alpha.permission.cannotVerify")}</dd>
                <small>{t("alpha.permission.resourcesMissing")}</small>
              </>
            }
          >
            {(resources) => (
              <>
                <dd>
                  <Show when={resources().length > 0} fallback={<span>{t("alpha.permission.resourceCount", { count: 0 })}</span>}>
                    <span class="a-permission-resources">
                      <For each={resources()}>{(resource) => <code>{resource}</code>}</For>
                    </span>
                  </Show>
                </dd>
                <small>{t("alpha.permission.resourcesProvided", { count: resources().length })}</small>
              </>
            )}
          </Show>
        </div>
        <div class="a-permission-fact" data-permission-fact="scope">
          <dt>{t("alpha.permission.scope")}</dt>
          <Show
            when={facts.scope}
            fallback={
              <>
                <dd>{t("alpha.permission.cannotVerify")}</dd>
                <small>{t("alpha.permission.scopeMissing")}</small>
              </>
            }
          >
            {(scope) => (
              <>
                <dd>{scopeLabel(scope())}</dd>
                <small>{scopeIdentity(scope())}</small>
              </>
            )}
          </Show>
        </div>
        <div class="a-permission-fact" data-permission-fact="expiry">
          <dt>{t("alpha.permission.expiry")}</dt>
          <Show
            when={facts.expiry}
            fallback={
              <>
                <dd>{t("alpha.permission.cannotVerify")}</dd>
                <small>{t("alpha.permission.expiryMissing")}</small>
              </>
            }
          >
            {(expiry) => (
              <>
                <dd>{expiryLabel(expiry().value)}</dd>
                <small>{expiry().value === null ? "expiresAt = null" : String(expiry().value)}</small>
              </>
            )}
          </Show>
        </div>
      </dl>

      <Show when={state.failed}>
        {(failed) => (
          <div ref={errorSummary} class="a-permission-error" data-kind={failed().error.kind} role="alert" tabIndex={-1}>
            <strong>{failed().error.kind === "conflict" ? t("alpha.permission.conflictTitle") : t("alpha.permission.failedTitle")}</strong>
            <span>
              {failed().error.kind === "conflict"
                ? t("alpha.permission.conflictDetail")
                : t("alpha.permission.failedDetail")}
            </span>
            <small>{failed().error.message}</small>
          </div>
        )}
      </Show>
    </Dialog>
  )
}

export function permissionDecisionSubmitError(error: unknown): PermissionDecisionSubmitError {
  const value = errorRecord(error)
  const cause = errorRecord(value?.cause)
  const conflict = [value, cause].some(
    (item) => item?.kind === "conflict" || item?._tag === "ConflictError" || item?.status === 409,
  )
  const kind = conflict ? "conflict" : "failed"
  const message = [value?.message, cause?.message].find(
    (item): item is string => typeof item === "string" && !!item.trim(),
  )
  if (message) return { kind, message }
  if (typeof error === "string" && error.trim()) return { kind: "failed", message: error }
  return { kind, message: conflict ? t("alpha.permission.conflictFallback") : t("alpha.permission.failedFallback") }
}

function errorRecord(value: unknown) {
  if (typeof value !== "object" || value === null) return undefined
  return value as Record<string, unknown>
}

/** 请求事实的严格核验(REQ-125 C7 起同时供会话审批 dock 复用 —— 单一安全逻辑源)。 */
export function permissionRequestFacts(request: PermissionV2Request) {
  const subjectValue = exactFactRecord(request.subject, ["kind", "id"])
  const subject =
    subjectValue?.kind === "agent" && typeof subjectValue.id === "string" && !!subjectValue.id.trim()
      ? { kind: "agent" as const, id: subjectValue.id }
      : undefined
  const action = typeof request.action === "string" && !!request.action.trim() ? request.action : undefined
  const resources =
    Array.isArray(request.resources) && request.resources.every((resource) => typeof resource === "string")
      ? request.resources
      : undefined
  const scopeValue = exactFactRecord(request.scope, [
    "kind",
    request.scope?.kind === "project" ? "projectID" : "sessionID",
  ])
  const scope =
    scopeValue?.kind === "session" &&
    typeof scopeValue.sessionID === "string" &&
    scopeValue.sessionID.startsWith("ses")
      ? { kind: "session" as const, sessionID: scopeValue.sessionID }
      : scopeValue?.kind === "project" && typeof scopeValue.projectID === "string" && !!scopeValue.projectID.trim()
        ? { kind: "project" as const, projectID: scopeValue.projectID }
        : undefined
  const expiry =
    request.expiresAt === null ||
    (typeof request.expiresAt === "number" && Number.isInteger(request.expiresAt) && request.expiresAt >= 0)
      ? { value: request.expiresAt }
      : undefined
  return {
    subject,
    action,
    resources,
    scope,
    expiry,
    verified: !!subject && !!action && !!resources && !!scope && !!expiry,
  }
}

function exactFactRecord(value: unknown, expectedKeys: string[]) {
  const record = errorRecord(value)
  if (!record || Array.isArray(value)) return undefined
  const keys = Reflect.ownKeys(record)
  if (keys.length !== expectedKeys.length || expectedKeys.some((key) => !Object.hasOwn(record, key))) return undefined
  return record
}

function scopeLabel(scope: PermissionV2Request["scope"]) {
  return scope.kind === "session" ? t("alpha.permission.scopeSession") : t("alpha.permission.scopeProject")
}

function scopeIdentity(scope: PermissionV2Request["scope"]) {
  return scope.kind === "session" ? scope.sessionID : scope.projectID
}

function expiryLabel(expiresAt: PermissionV2Request["expiresAt"]) {
  if (expiresAt === null) return t("alpha.permission.neverExpires")
  const date = new Date(expiresAt)
  if (Number.isNaN(date.valueOf())) return String(expiresAt)
  return date.toISOString().replace("T", " ").replace(".000Z", " UTC")
}
