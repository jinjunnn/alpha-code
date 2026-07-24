// SessionApprovalCard — REQ-125 C7:composer 停靠区的审批卡(已批稿「审批请求停靠」帧)。
//
// 决定逻辑与 PermissionDialog 单一同源(permissionRequestFacts 核验 / DecisionCommand
// 构造 / 提交失败分级);事实核不实 = 只能拒绝,且自动拒绝是**一次性 onMount 语义**
// (Codex 审计 2026-07-24 Major:禁止经追踪 submitting/failed 的 effect 形成无退避自动
// 网络重试)——失败后留在卡面等显式重试,与 PermissionDialog 同款。
// Esc 不等价拒绝(必须显式选择);出现时焦点移入首个动作;读屏经 aria-live(assertive)。

import type { PermissionV2DecisionCommand, PermissionV2Request } from "@opencode-ai/sdk/v2/client"
import { createStore } from "solid-js/store"
import { For, onMount, Show } from "solid-js"
import { t } from "../../i18n"
import {
  createPermissionDecisionCommand,
  permissionDecisionSubmitError,
  permissionRequestFacts,
  type PermissionDecisionSubmitError,
} from "../PermissionDialog"

export function SessionApprovalCard(props: {
  request: PermissionV2Request
  projectID?: string
  onSubmit: (command: PermissionV2DecisionCommand) => Promise<void>
}) {
  const facts = permissionRequestFacts(props.request)
  const [state, setState] = createStore<{
    submitting?: PermissionV2DecisionCommand
    failed?: { command: PermissionV2DecisionCommand; error: PermissionDecisionSubmitError }
  }>({})
  let onceButton: HTMLButtonElement | undefined

  const canAlways = () =>
    facts.verified &&
    typeof props.projectID === "string" &&
    !!props.projectID.trim() &&
    Array.isArray(props.request.save) &&
    props.request.save.length > 0 &&
    props.request.save.every((resource) => typeof resource === "string")

  const decide = (decision: "once" | "always" | "reject") => {
    if (state.submitting) return
    // 事实核不实 = 只能拒绝(与 PermissionDialog 同一 fail-closed 语义)。
    const safeDecision = facts.verified ? decision : "reject"
    if (safeDecision === "always" && !canAlways()) return
    const command =
      state.failed?.command.decision === safeDecision
        ? state.failed.command
        : createPermissionDecisionCommand(props.request, safeDecision, props.projectID)
    setState({ submitting: command, failed: undefined })
    props.onSubmit(command).then(
      () => setState("submitting", undefined),
      (error) => setState({ submitting: undefined, failed: { command, error: permissionDecisionSubmitError(error) } }),
    )
  }

  // 一次性挂载语义(与 PermissionDialog onMount 同款):核不实 → 单次自动拒绝落档,
  // 失败留在卡面(role=alert)等显式操作;核实 → 焦点移入「允许一次」。
  onMount(() => {
    if (!facts.verified) {
      decide("reject")
      return
    }
    queueMicrotask(() => onceButton?.focus())
  })

  return (
    <section
      class="a-swk-card a-swk-approval"
      data-alpha-session-approval={props.request.id}
      role="group"
      aria-live="assertive"
      aria-label={t("alpha.session.approvalTitle")}
    >
      <header class="a-swk-approval-head">
        <svg viewBox="0 0 24 24" aria-hidden="true">
          <path d="M12 2l8 4v6c0 5-3.5 8-8 10-4.5-2-8-5-8-10V6z" />
        </svg>
        <span>{t("alpha.session.approvalTitle")}</span>
        <Show when={facts.action}>{(action) => <code>{action()}</code>}</Show>
      </header>
      <Show when={facts.resources?.length}>
        <p class="a-swk-approval-body">
          <For each={facts.resources}>{(resource) => <code>{resource}</code>}</For>
        </p>
      </Show>
      <div class="a-swk-approval-actions">
        <button
          ref={onceButton}
          type="button"
          class="a-swk-btn a-swk-btn--primary"
          disabled={!!state.submitting || !facts.verified}
          onClick={() => decide("once")}
          data-permission-decision="once"
        >
          {t("alpha.permission.once")}
        </button>
        <button
          type="button"
          class="a-swk-btn"
          disabled={!!state.submitting || !canAlways()}
          title={!canAlways() ? t("alpha.permission.projectUnverified") : undefined}
          onClick={() => decide("always")}
          data-permission-decision="always"
        >
          {t("alpha.permission.always")}
        </button>
        <button
          type="button"
          class="a-swk-btn"
          disabled={!!state.submitting}
          onClick={() => decide("reject")}
          data-permission-decision="reject"
        >
          {t("alpha.permission.reject")}
        </button>
      </div>
      <Show when={state.failed}>
        {(failed) => (
          <p class="a-swk-approval-error" role="alert">
            {failed().error.kind === "conflict" ? t("alpha.permission.conflictTitle") : t("alpha.permission.failedTitle")}
          </p>
        )}
      </Show>
    </section>
  )
}
