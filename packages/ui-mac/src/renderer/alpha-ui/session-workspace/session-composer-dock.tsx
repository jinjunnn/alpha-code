// SessionComposerDock — REQ-125 C7:seam 会话页的 composer 停靠区。
//
// 职责:
// - AlphaComposer 以 mode="session" **直挂**(props 传入;零 Portal/零选择器/零收养);
// - composer 上方停靠区:审批卡(PermissionV2 typed feed,fail-closed)、提问卡(question
//   typed 通道)、任务清单卡(todo typed 通道);
// - live status / 上下文用量 / 斜杠命令捕获经 ComposerSessionDockApi 注入 composer;
// - 一切异步结果绑定 serverKey+directory+sessionID(C1 live context 原语,I8),审批回复
//   额外绑 request ID(session-permission-feed 闸死 stale)。

import { useServerSDK, useServerSync } from "@opencode-ai/app"
import type {
  createOpencodeClient,
  ModelV2Info,
  PermissionV2DecisionCommand,
  PermissionV2Request,
  QuestionRequest,
  Todo,
} from "@opencode-ai/sdk/v2/client"
import { useNavigate } from "@solidjs/router"
import { createEffect, createMemo, createSignal, For, on, onCleanup, Show } from "solid-js"
import { createStore } from "solid-js/store"
import { hrefFor } from "../../../shared/route-manifest"
import { t } from "../../i18n"
import type { AlphaProjectsApi } from "../../sidebar/use-projects"
import { AlphaComposer, type ComposerSessionDockApi, type ComposerSlashCapture } from "../alpha-composer"
import { createModelContract } from "../model-contract"
import {
  createPermissionDecisionCommand,
  permissionDecisionSubmitError,
  permissionRequestFacts,
  type PermissionDecisionSubmitError,
} from "../PermissionDialog"
import { claimSessionApprovalDock } from "./session-approval-claim"
import {
  childParentHref,
  childSessionFacts,
  contextUsagePercent,
  headPendingQuestion,
  questionAnswersComplete,
  revertDockFacts,
  todoDockVisible,
  todoDone,
} from "./session-dock-core"
import { createPermissionV2Feed, type PermissionV2Feed } from "./session-permission-feed"
import { recordSessionSlashOrigin } from "./session-slash-origin"
import type { AlphaSessionIdentity } from "./session-workspace-core"
import type { AlphaSessionLiveContext } from "./session-workspace-shell"

const identityKey = (identity: AlphaSessionIdentity | undefined) =>
  identity ? `${identity.serverKey}\u0000${identity.directory}\u0000${identity.sessionID}` : undefined

export function SessionComposerDock(props: { live: AlphaSessionLiveContext; projects: AlphaProjectsApi }) {
  const serverSDK = useServerSDK()
  const serverSync = useServerSync()
  const navigate = useNavigate()
  const identity = () => props.live.current()?.identity
  const running = () => props.live.current()?.activity === "running"
  // 目录作用域 SDK(typed 事件按类型分发;refcount 由 memo 的 onCleanup 管理)。
  const dirSDK = createMemo(() => {
    const bound = identity()
    return bound ? serverSDK().ensureDirSdkContext(bound.directory) : undefined
  })

  /* ── PermissionV2 feed:随会话身份重建;身份失效的结果一律丢弃(I8) ────────────── */
  const [feed, setFeed] = createSignal<PermissionV2Feed | undefined>(undefined)
  createEffect(
    on(
      () => identityKey(identity()),
      () => {
        setFeed(undefined)
        const bound = identity()
        const sdk = dirSDK()
        if (!bound || !sdk) return
        const accepted = () => props.live.accepts(bound)
        const nextFeed = createPermissionV2Feed({
          list: () =>
            sdk.client.v2.session.permission.list({ sessionID: bound.sessionID }).then((result) => {
              if (!accepted()) throw new Error("session identity changed during permission list")
              if (!result.data) throw new Error("Permission list response is missing data")
              return result.data.data
            }),
          reply: (requestID, command) =>
            sdk.client.v2.session.permission
              .reply({ sessionID: bound.sessionID, requestID, permissionV2DecisionCommand: command })
              .then((result) => {
                if (!result.data) throw new Error("Permission reply response is missing DecisionReceipt")
                return result.data.data
              }),
        })
        const releaseClaim = claimSessionApprovalDock(bound.sessionID)
        const stopAsked = sdk.event.on("permission.v2.asked", (event) => {
          if (event.properties.sessionID !== bound.sessionID || !accepted()) return
          nextFeed.apply({ type: "asked", request: event.properties })
        })
        const stopReplied = sdk.event.on("permission.v2.replied", (event) => {
          if (event.properties.sessionID !== bound.sessionID || !accepted()) return
          nextFeed.apply({ type: "replied", receipt: event.properties })
        })
        const stopConnected = sdk.event.on("server.connected", () => nextFeed.load())
        nextFeed.load()
        setFeed(nextFeed)
        onCleanup(() => {
          stopAsked()
          stopReplied()
          stopConnected()
          nextFeed.dispose()
          releaseClaim()
        })
      },
    ),
  )

  // fail-closed:feed 未就绪(缺席/读不到)= 无审批可呈现,亦无任何放行动作。
  const approval = createMemo(() => {
    const active = feed()
    if (!active?.state.ready) return undefined
    return active.state.requests[0]
  })

  /* ── todo / question:typed sync 通道,读当前身份对应的会话 ─────────────────────── */
  const todos = createMemo(() => {
    const bound = identity()
    return bound ? (serverSync().session.data.todo[bound.sessionID] ?? []) : []
  })
  const question = createMemo(() => {
    const bound = identity()
    return bound ? headPendingQuestion(serverSync().session.data.question[bound.sessionID]) : undefined
  })

  /* ── revert / child-session:info(± message)typed 通道,读当前身份对应会话(I8)──── */
  const revert = createMemo(() => {
    const bound = identity()
    if (!bound) return undefined
    const sessions = serverSync().session.data
    return revertDockFacts(sessions.info[bound.sessionID]?.revert, sessions.message[bound.sessionID])
  })
  const childSession = createMemo(() => {
    const bound = identity()
    if (!bound) return undefined
    const info = serverSync().session.data.info
    const session = info[bound.sessionID]
    const parentID = session?.parentID
    return childSessionFacts(session, parentID ? info[parentID] : undefined)
  })

  /* ── 上下文用量:messages(typed sync)× 模型目录(typed model contract) ─────────── */
  const modelContract = createModelContract(() => serverSDK().client)
  const [models, setModels] = createSignal<{ directory: string; models: ModelV2Info[] } | undefined>(undefined)
  createEffect(
    on(
      () => identity()?.directory,
      (directory) => {
        setModels(undefined)
        if (!directory) return
        let stale = false
        modelContract.list(directory).then(
          (listed) => {
            if (stale || identity()?.directory !== directory) return
            setModels({ directory, models: listed })
          },
          () => {
            /* 目录事实缺失 → ring 保持隐藏(不装有数据) */
          },
        )
        onCleanup(() => {
          stale = true
        })
      },
    ),
  )
  const usage = createMemo(() => {
    const bound = identity()
    const listed = models()
    if (!bound || !listed || listed.directory !== bound.directory) return null
    return contextUsagePercent(serverSync().session.data.message[bound.sessionID], listed.models)
  })

  /* ── 「始终允许」授权所需的项目身份:worktree 与会话目录精确匹配,否则不可用 ────── */
  const projectID = createMemo(() => {
    const bound = identity()
    if (!bound) return undefined
    return serverSync().data.project.find((project) => project.worktree === bound.directory)?.id
  })

  const dockApi: ComposerSessionDockApi = {
    running,
    contextUsage: usage,
    approvalPending: () => approval() !== undefined,
    onSlashCommand: (capture: ComposerSlashCapture) => {
      const bound = identity()
      if (!bound || bound.sessionID !== capture.sessionID || bound.directory !== capture.directory) return
      recordSessionSlashOrigin({
        identity: bound,
        command: capture.command,
        arguments: capture.arguments,
        ...(capture.assistantMessageID ? { assistantMessageID: capture.assistantMessageID } : {}),
        at: Date.now(),
      })
    },
  }

  return (
    <div class="a-swk-dock" data-alpha-session-dock>
      <Show when={approval()} keyed>
        {(request) => (
          <SessionApprovalCard
            request={request}
            projectID={projectID()}
            onSubmit={(command) => {
              const active = feed()
              if (!active) return Promise.reject(new Error("permission feed is not ready"))
              return active.reply(request.id, command).then(() => undefined)
            }}
          />
        )}
      </Show>
      <Show when={question()} keyed>
        {(request) => (
          <SessionQuestionCard
            request={request}
            identity={identity}
            accepts={props.live.accepts}
            client={() => dirSDK()?.client}
          />
        )}
      </Show>
      <Show when={todoDockVisible({ todos: todos(), running: running() })}>
        <SessionTodoCard todos={todos()} />
      </Show>
      <Show when={revert()} keyed>
        {(facts) => <SessionRevertCard facts={facts} />}
      </Show>
      <Show when={childSession()} keyed>
        {(facts) => (
          <SessionChildCard
            facts={facts}
            running={running}
            onJump={() => {
              const bound = identity()
              const href = bound
                ? childParentHref({
                    bound,
                    accepts: props.live.accepts,
                    parentID: facts.parentID,
                    hrefFor: hrefFor.session,
                  })
                : undefined
              if (href) navigate(href)
            }}
          />
        )}
      </Show>
      <AlphaComposer
        mode="session"
        projects={props.projects}
        directory={() => identity()?.directory}
        sessionID={() => identity()?.sessionID}
        sessionDock={dockApi}
      />
    </div>
  )
}

/* ── 审批卡(已批稿「审批请求停靠」帧;决定逻辑与 PermissionDialog 同源)──────────── */
function SessionApprovalCard(props: {
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

  // 已批稿合同:审批卡出现时焦点移入首个动作;Esc 不等价拒绝(必须显式选择)。
  createEffect(() => {
    if (facts.verified) queueMicrotask(() => onceButton?.focus())
  })
  // 事实核不实的请求不给任何放行入口,直接以拒绝落档(与 PermissionDialog onMount 同款)。
  createEffect(() => {
    if (!facts.verified) decide("reject")
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

/* ── 提问卡(question typed 通道;回答绑 sessionID+requestID)────────────────────── */
function SessionQuestionCard(props: {
  request: QuestionRequest
  identity: () => AlphaSessionIdentity | undefined
  accepts: (identity: AlphaSessionIdentity) => boolean
  client: () => ReturnType<typeof createOpencodeClient> | undefined
}) {
  const [selections, setSelections] = createSignal<string[][]>(props.request.questions.map(() => []))
  const [custom, setCustom] = createSignal<string[]>(props.request.questions.map(() => ""))
  const [submitting, setSubmitting] = createSignal(false)
  const [failed, setFailed] = createSignal(false)

  const toggle = (questionIndex: number, label: string, multiple: boolean | undefined) => {
    setSelections((previous) =>
      previous.map((picked, index) => {
        if (index !== questionIndex) return picked
        if (picked.includes(label)) return picked.filter((value) => value !== label)
        return multiple ? [...picked, label] : [label]
      }),
    )
  }

  const answers = createMemo(() =>
    props.request.questions.map((info, index) => {
      const picked = selections()[index] ?? []
      const written = info.custom ? (custom()[index] ?? "").trim() : ""
      return picked.length > 0 ? picked : written ? [written] : []
    }),
  )
  const complete = createMemo(() => questionAnswersComplete(props.request.questions, answers()))

  const submit = (kind: "reply" | "reject") => {
    if (submitting()) return
    const bound = props.identity()
    const client = props.client()
    // I8:提交绑定发起时刻的身份 + request ID;身份已切换/通道缺席的提交直接丢弃。
    if (!bound || !client || !props.accepts(bound) || props.request.sessionID !== bound.sessionID) return
    setSubmitting(true)
    setFailed(false)
    const call =
      kind === "reply"
        ? client.v2.session.question.reply({
            sessionID: bound.sessionID,
            requestID: props.request.id,
            questionV2Reply: { answers: answers() as string[][] },
          })
        : client.v2.session.question.reject({ sessionID: bound.sessionID, requestID: props.request.id })
    call.then(
      () => setSubmitting(false),
      () => {
        setSubmitting(false)
        setFailed(true)
      },
    )
  }

  return (
    <section
      class="a-swk-card a-swk-question"
      data-alpha-session-question={props.request.id}
      role="group"
      aria-label={t("alpha.session.questionTitle")}
    >
      <For each={props.request.questions}>
        {(info, index) => (
          <div class="a-swk-question-item">
            <header class="a-swk-question-head">
              <span class="a-swk-question-kicker">{info.header || t("alpha.session.questionTitle")}</span>
              <span class="a-swk-question-text">{info.question}</span>
            </header>
            <div class="a-swk-question-options" role={info.multiple ? "group" : "radiogroup"}>
              <For each={info.options}>
                {(option) => (
                  <button
                    type="button"
                    class="a-swk-option"
                    role={info.multiple ? "checkbox" : "radio"}
                    aria-checked={(selections()[index()] ?? []).includes(option.label)}
                    data-selected={(selections()[index()] ?? []).includes(option.label) ? "" : undefined}
                    title={option.description}
                    disabled={submitting()}
                    onClick={() => toggle(index(), option.label, info.multiple)}
                  >
                    {option.label}
                  </button>
                )}
              </For>
            </div>
            <Show when={info.custom}>
              <input
                class="a-swk-question-custom"
                type="text"
                placeholder={t("alpha.session.questionCustomPlaceholder")}
                value={custom()[index()] ?? ""}
                disabled={submitting()}
                onInput={(event) =>
                  setCustom((previous) =>
                    previous.map((value, valueIndex) => (valueIndex === index() ? event.currentTarget.value : value)),
                  )
                }
              />
            </Show>
          </div>
        )}
      </For>
      <div class="a-swk-question-actions">
        <button
          type="button"
          class="a-swk-btn a-swk-btn--primary"
          disabled={submitting() || !complete()}
          onClick={() => submit("reply")}
        >
          {t("alpha.session.questionSubmit")}
        </button>
        <button type="button" class="a-swk-btn" disabled={submitting()} onClick={() => submit("reject")}>
          {t("alpha.session.questionDismiss")}
        </button>
      </div>
      <Show when={failed()}>
        <p class="a-swk-approval-error" role="alert">
          {t("alpha.session.questionFailed")}
        </p>
      </Show>
    </section>
  )
}

/* ── 检查点回退条(session.revert typed 事实;纯呈现 —— 发送/清空由 composer 流程处理)── */
function SessionRevertCard(props: { facts: { messageID: string; discardCount: number } }) {
  return (
    <section
      class="a-swk-card a-swk-revert"
      data-alpha-session-revert={props.facts.messageID}
      role="status"
      aria-live="polite"
      aria-label={t("alpha.session.revertTitle")}
    >
      <svg viewBox="0 0 24 24" aria-hidden="true">
        <path d="M9 14L4 9l5-5" />
        <path d="M4 9h11a5 5 0 0 1 5 5v1" />
      </svg>
      <div class="a-swk-revert-text">
        <span class="a-swk-revert-title">{t("alpha.session.revertTitle")}</span>
        <Show when={props.facts.discardCount > 0}>
          <span class="a-swk-revert-detail">
            {t("alpha.session.revertDetail", { count: props.facts.discardCount })}
          </span>
        </Show>
      </div>
    </section>
  )
}

/* ── 子会话条(session.parentID typed 事实;运行指示 + 跳转父会话,I8 绑 accepts+serverKey)── */
function SessionChildCard(props: {
  facts: { parentID: string; parentTitle: string }
  running: () => boolean
  onJump: () => void
}) {
  return (
    <section
      class="a-swk-card a-swk-child"
      data-alpha-session-child={props.facts.parentID}
      role="group"
      aria-label={t("alpha.session.childTitle")}
    >
      <span
        class="a-swk-child-dot"
        classList={{ "a-swk-child-dot--running": props.running() }}
        data-alpha-session-child-activity={props.running() ? "running" : "idle"}
        aria-hidden="true"
      />
      <div class="a-swk-child-text">
        <span class="a-swk-child-title">{t("alpha.session.childTitle")}</span>
        <span class="a-swk-child-parent">{props.facts.parentTitle}</span>
      </div>
      <button type="button" class="a-swk-btn a-swk-child-jump" onClick={() => props.onJump()}>
        {t("alpha.session.childBackToParent")}
      </button>
    </section>
  )
}

/* ── 任务清单卡(todo typed 通道;已批稿 todos 构件语言)─────────────────────────── */
function SessionTodoCard(props: { todos: readonly Todo[] }) {
  const done = createMemo(() => props.todos.filter(todoDone).length)
  return (
    <section class="a-swk-card a-swk-todos" data-alpha-session-todos role="group" aria-label={t("alpha.session.todoTitle")}>
      <header class="a-swk-todo-head">
        <svg viewBox="0 0 24 24" aria-hidden="true">
          <path d="M9 11l3 3L22 4M21 12v7a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11" />
        </svg>
        <span>{t("alpha.session.todoTitle")}</span>
        <span class="a-swk-todo-progress">{t("alpha.session.todoProgress", { done: done(), total: props.todos.length })}</span>
      </header>
      <ul class="a-swk-todo-list">
        <For each={props.todos}>
          {(todo) => (
            <li class="a-swk-todo" data-status={todo.status}>
              <span class="a-swk-todo-box" aria-hidden="true">
                <Show when={todo.status === "completed"}>
                  <svg viewBox="0 0 24 24">
                    <path d="M20 6L9 17l-5-5" />
                  </svg>
                </Show>
              </span>
              <span class="a-swk-todo-text">{todo.content}</span>
            </li>
          )}
        </For>
      </ul>
    </section>
  )
}
