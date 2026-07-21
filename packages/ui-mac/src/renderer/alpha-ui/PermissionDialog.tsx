import type {
  PermissionV2Decision,
  PermissionV2DecisionCommand,
  PermissionV2DecisionReceipt,
  PermissionV2Request,
} from "@opencode-ai/sdk/v2/client"
import { For, Show } from "solid-js"
import { createStore } from "solid-js/store"
import { Button } from "./Button"
import { Dialog } from "./Dialog"
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
    if (decision !== "reject" && !facts.verified) return
    if (decision === "always" && !canAlways()) return
    const command =
      state.failed?.command.decision === decision
        ? state.failed.command
        : createPermissionDecisionCommand(props.request, decision, props.projectID)

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

  const actionLabel = (decision: PermissionV2Decision) => {
    const label = decision === "once" ? "允许一次" : decision === "always" ? "始终允许" : "拒绝"
    if (state.submitting?.decision === decision) return "正在提交…"
    return state.failed?.command.decision === decision ? `重试“${label}”` : label
  }

  return (
    <Dialog
      open
      title="允许这次操作吗？"
      description={<span>请核对下面的真实请求事实。作出决定前，工具保持暂停。</span>}
      size="md"
      dismissible={false}
      busy={!!state.submitting}
      restoreFocus={() => document.querySelector<HTMLTextAreaElement>('[data-alpha-composer="session"] textarea')}
      onClose={() => {}}
      footer={
        <div class="a-permission-footer">
          <small class="a-permission-grant-note">“始终允许”会为当前项目创建永久授权（grantExpiresAt = null）。</small>
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
                  ? "请求事实无法核实，不能授权"
                  : !props.projectID?.trim()
                    ? "无法核实当前项目，不能创建永久授权"
                    : !Array.isArray(props.request.save) || !props.request.save.length
                      ? "请求未提供可保存资源，不能创建永久授权"
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
              title={!facts.verified ? "请求事实无法核实，不能授权" : undefined}
              onClick={() => decide("once")}
              data-permission-decision="once"
            >
              {actionLabel("once")}
            </Button>
          </div>
        </div>
      }
    >
      <dl class="a-permission-facts" aria-label="权限请求事实">
        <div class="a-permission-fact" data-permission-fact="subject">
          <dt>主体 / 执行 Agent</dt>
          <Show
            when={facts.subject}
            fallback={
              <>
                <dd>无法核实</dd>
                <small>请求未提供完整主体事实</small>
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
          <dt>Action / Capability</dt>
          <Show
            when={facts.action}
            fallback={
              <>
                <dd>无法核实</dd>
                <small>请求未提供有效 action</small>
              </>
            }
          >
            {(action) => (
              <>
                <dd>{action()}</dd>
                <small>请求执行的能力</small>
              </>
            )}
          </Show>
        </div>
        <div class="a-permission-fact a-permission-fact--wide" data-permission-fact="resources">
          <dt>Resources</dt>
          <Show
            when={facts.resources}
            fallback={
              <>
                <dd>无法核实</dd>
                <small>请求未提供有效 resources</small>
              </>
            }
          >
            {(resources) => (
              <>
                <dd>
                  <Show when={resources().length > 0} fallback={<span>0 项资源</span>}>
                    <span class="a-permission-resources">
                      <For each={resources()}>{(resource) => <code>{resource}</code>}</For>
                    </span>
                  </Show>
                </dd>
                <small>{resources().length} 项，由请求按原顺序提供</small>
              </>
            )}
          </Show>
        </div>
        <div class="a-permission-fact" data-permission-fact="scope">
          <dt>Scope</dt>
          <Show
            when={facts.scope}
            fallback={
              <>
                <dd>无法核实</dd>
                <small>请求未提供有效 scope</small>
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
          <dt>Expiry</dt>
          <Show
            when={facts.expiry}
            fallback={
              <>
                <dd>无法核实</dd>
                <small>请求未提供有效 expiresAt</small>
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
            <strong>{failed().error.kind === "conflict" ? "这次选择与已提交决定冲突" : "未能提交你的选择"}</strong>
            <span>
              {failed().error.kind === "conflict"
                ? "服务器保留了先提交的原子决定，本界面没有覆盖它。"
                : "没有收到授权收据；本界面不会假定操作已经获准。"}
            </span>
            <small>{failed().error.message}</small>
          </div>
        )}
      </Show>
    </Dialog>
  )
}

function permissionDecisionSubmitError(error: unknown): PermissionDecisionSubmitError {
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
  return { kind, message: conflict ? "Permission decision conflict" : "Permission decision failed" }
}

function errorRecord(value: unknown) {
  if (typeof value !== "object" || value === null) return undefined
  return value as Record<string, unknown>
}

function permissionRequestFacts(request: PermissionV2Request) {
  const subjectValue = errorRecord(request.subject)
  const subject =
    subjectValue?.kind === "agent" && typeof subjectValue.id === "string" && !!subjectValue.id.trim()
      ? { kind: "agent" as const, id: subjectValue.id }
      : undefined
  const action = typeof request.action === "string" && !!request.action.trim() ? request.action : undefined
  const resources =
    Array.isArray(request.resources) && request.resources.every((resource) => typeof resource === "string")
      ? request.resources
      : undefined
  const scopeValue = errorRecord(request.scope)
  const scope =
    scopeValue?.kind === "session" && typeof scopeValue.sessionID === "string" && !!scopeValue.sessionID.trim()
      ? { kind: "session" as const, sessionID: scopeValue.sessionID }
      : scopeValue?.kind === "project" && typeof scopeValue.projectID === "string" && !!scopeValue.projectID.trim()
        ? { kind: "project" as const, projectID: scopeValue.projectID }
        : undefined
  const expiry =
    request.expiresAt === null || (typeof request.expiresAt === "number" && Number.isFinite(request.expiresAt))
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

function scopeLabel(scope: PermissionV2Request["scope"]) {
  return scope.kind === "session" ? "本次会话" : "当前项目"
}

function scopeIdentity(scope: PermissionV2Request["scope"]) {
  return scope.kind === "session" ? scope.sessionID : scope.projectID
}

function expiryLabel(expiresAt: PermissionV2Request["expiresAt"]) {
  if (expiresAt === null) return "不过期"
  const date = new Date(expiresAt)
  if (Number.isNaN(date.valueOf())) return String(expiresAt)
  return date.toISOString().replace("T", " ").replace(".000Z", " UTC")
}
