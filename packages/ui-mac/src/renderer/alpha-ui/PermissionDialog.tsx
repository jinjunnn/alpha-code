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
  const [state, setState] = createStore<{
    submitting?: PermissionV2DecisionCommand
    failed?: { command: PermissionV2DecisionCommand; error: PermissionDecisionSubmitError }
  }>({})
  let errorSummary: HTMLDivElement | undefined

  const decide = (decision: PermissionV2Decision) => {
    if (state.submitting) return
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

  const canAlways = () => !!props.projectID && !!props.request.save?.length

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
          <small class="a-permission-grant-note">
            “始终允许”会为当前项目创建永久授权（grantExpiresAt = null）。
          </small>
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
                !props.projectID
                  ? "无法核实当前项目，不能创建永久授权"
                  : !props.request.save?.length
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
              disabled={!!state.submitting}
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
          <dd>{props.request.subject.id}</dd>
          <small>subject.kind = {props.request.subject.kind}</small>
        </div>
        <div class="a-permission-fact" data-permission-fact="action">
          <dt>Action / Capability</dt>
          <dd>{props.request.action}</dd>
          <small>请求执行的能力</small>
        </div>
        <div class="a-permission-fact a-permission-fact--wide" data-permission-fact="resources">
          <dt>Resources</dt>
          <dd>
            <Show when={props.request.resources.length > 0} fallback={<span>0 项资源</span>}>
              <span class="a-permission-resources">
                <For each={props.request.resources}>{(resource) => <code>{resource}</code>}</For>
              </span>
            </Show>
          </dd>
          <small>{props.request.resources.length} 项，由请求按原顺序提供</small>
        </div>
        <div class="a-permission-fact" data-permission-fact="scope">
          <dt>Scope</dt>
          <dd>{scopeLabel(props.request)}</dd>
          <small>{scopeIdentity(props.request)}</small>
        </div>
        <div class="a-permission-fact" data-permission-fact="expiry">
          <dt>Expiry</dt>
          <dd>{expiryLabel(props.request.expiresAt)}</dd>
          <small>{props.request.expiresAt === null ? "expiresAt = null" : String(props.request.expiresAt)}</small>
        </div>
      </dl>

      <Show when={state.failed}>
        {(failed) => (
          <div
            ref={errorSummary}
            class="a-permission-error"
            data-kind={failed().error.kind}
            role="alert"
            tabIndex={-1}
          >
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

function scopeLabel(request: PermissionV2Request) {
  return request.scope.kind === "session" ? "本次会话" : "当前项目"
}

function scopeIdentity(request: PermissionV2Request) {
  return request.scope.kind === "session" ? request.scope.sessionID : request.scope.projectID
}

function expiryLabel(expiresAt: PermissionV2Request["expiresAt"]) {
  if (expiresAt === null) return "不过期"
  const date = new Date(expiresAt)
  if (Number.isNaN(date.valueOf())) return String(expiresAt)
  return date.toISOString().replace("T", " ").replace(".000Z", " UTC")
}
