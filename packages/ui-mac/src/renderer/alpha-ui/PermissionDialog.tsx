import type {
  PermissionV2Decision,
  PermissionV2DecisionCommand,
  PermissionV2DecisionReceipt,
  PermissionV2Request,
} from "@opencode-ai/sdk/v2/client"
import { createUniqueId, For, onCleanup, onMount, Show, type JSX } from "solid-js"
import { createStore } from "solid-js/store"
import { Portal } from "solid-js/web"
import { Button } from "./Button"
import { enterModal } from "./modal-presence"
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
    <PermissionPanel
      busy={!!state.submitting}
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
    </PermissionPanel>
  )
}

const COMPOSER_SELECTOR = '[data-alpha-composer="session"]'
/** 面板底边与会话输入框顶边之间的间距(px);无输入框时离窗口底边同值。 */
const PANEL_GAP = 12

/**
 * #1478(REQ-230 AC4):工具批准的呈现外壳 —— **非模态**全局浮动面板。
 *
 * 与之前的强模态 `Dialog` 相比,只换呈现手段,不换合同:
 *  - 无遮罩,不给页面其余部分写 inert / aria-hidden,不困住焦点 —— 时间线可继续翻看、可读;
 *  - 仍然关不掉:没有关闭按钮,面板内的 Esc 被吞掉(不关闭、也不冒泡去触发别的 Esc 行为);
 *  - 出现时焦点落在「允许一次」(autofocus);面板消失时若焦点还在面板里,回到会话输入框;
 *  - 固定在窗口底部居中;页面上有会话输入框时,停在它正上方;
 *  - 仍声明 modal-presence:右栏 html/pdf 预览是原生层(WebContentsView),DOM 层级管不到它,
 *    不藏起来它可能盖住批准面板 —— 「不得被遮挡」比「预览继续可见」优先。
 */
function PermissionPanel(props: { busy: boolean; footer: JSX.Element; children: JSX.Element }) {
  const titleId = createUniqueId()
  const descriptionId = createUniqueId()
  const [layout, setLayout] = createStore<{ bottom: number }>({ bottom: PANEL_GAP })
  let panel!: HTMLDivElement
  const trigger = document.activeElement

  const measure = () => {
    const composer = document.querySelector<HTMLElement>(COMPOSER_SELECTOR)
    const rect = composer?.getBoundingClientRect()
    const viewport = window.innerHeight
    const bottom =
      rect && rect.height > 0 && rect.top > 0 && rect.top < viewport ? viewport - rect.top + PANEL_GAP : PANEL_GAP
    if (bottom !== layout.bottom) setLayout("bottom", bottom)
  }

  onMount(() => {
    const releaseModal = enterModal()
    measure()
    window.addEventListener("resize", measure)
    const observer = typeof ResizeObserver === "function" ? new ResizeObserver(measure) : undefined
    observer?.observe(document.body)
    const composer = document.querySelector<HTMLElement>(COMPOSER_SELECTOR)
    if (composer) observer?.observe(composer)
    queueMicrotask(() => {
      if (!panel.isConnected) return
      const initial = Array.from(panel.querySelectorAll<HTMLButtonElement>("button")).find(
        (element) => (element.hasAttribute("autofocus") || element.autofocus) && !element.disabled,
      )
      ;(initial ?? panel).focus()
    })
    onCleanup(() => {
      releaseModal()
      window.removeEventListener("resize", measure)
      observer?.disconnect()
      const active = document.activeElement
      if (active && active !== document.body && !panel.contains(active)) return
      if (
        trigger instanceof HTMLElement &&
        trigger !== document.body &&
        trigger.isConnected &&
        !panel.contains(trigger)
      ) {
        trigger.focus()
        if (document.activeElement === trigger) return
      }
      document.querySelector<HTMLTextAreaElement>(`${COMPOSER_SELECTOR} textarea`)?.focus()
    })
  })

  return (
    <Portal>
      <div class="a-ui a-permission-layer" data-alpha-permission-panel="">
        <div
          ref={(element) => (panel = element)}
          class="a-permission-panel"
          role="dialog"
          aria-modal="false"
          aria-labelledby={titleId}
          aria-describedby={descriptionId}
          aria-busy={props.busy ? "true" : undefined}
          tabIndex={-1}
          style={{ bottom: `${layout.bottom}px` }}
          // 原生监听(非 Solid 委托):委托挂在 document 上,到那时再 stopPropagation 已来不及。
          on:keydown={(event) => {
            if (event.key !== "Escape") return
            event.preventDefault()
            event.stopPropagation()
          }}
        >
          <header class="a-permission-head">
            <span class="a-permission-icon" aria-hidden="true">
              <svg viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.5">
                <circle cx="8" cy="8" r="6.25" />
                <path d="M8 4.75V8l2.25 1.5" stroke-linecap="round" stroke-linejoin="round" />
              </svg>
            </span>
            <div class="a-permission-titles">
              <div id={titleId} class="a-permission-title">
                {t("alpha.permission.title")}
              </div>
              <div id={descriptionId} class="a-permission-description">
                {t("alpha.permission.description")}
              </div>
            </div>
          </header>
          <div class="a-permission-body">{props.children}</div>
          <footer class="a-permission-foot">{props.footer}</footer>
        </div>
      </div>
    </Portal>
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

/**
 * 严格键集核验:被核验的值必须**恰好**带着 expectedKeys,多一个字段就核不实。
 *
 * 判据域刻意取「自有可枚举字符串键」,而不是 `Reflect.ownKeys`(REQ-090 #561):被核验的值
 * 恒来自 JSON wire,`JSON.parse` 只可能产出可枚举字符串键 ⇒ 非枚举键与符号键**结构上到不了
 * 这里**,只可能由进程内代码事后盖章(solid store 的 $PROXY / $NODE、devtools 注解)。把它们
 * 计入 = 把「进程内注解」误读成「wire 上多出来的字段」,让合法请求核不实并触发静默自动拒绝。
 * 反向不放松:wire 上任何真实多出来的字段都是可枚举字符串键,照旧被这里拒掉。
 */
function exactFactRecord(value: unknown, expectedKeys: string[]) {
  const record = errorRecord(value)
  if (!record || Array.isArray(value)) return undefined
  const keys = Object.keys(record)
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
