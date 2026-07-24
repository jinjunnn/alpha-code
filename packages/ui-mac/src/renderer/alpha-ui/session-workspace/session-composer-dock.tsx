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
import type { createOpencodeClient, ModelV2Info, QuestionRequest, Todo } from "@opencode-ai/sdk/v2/client"
import { createEffect, createMemo, createSignal, For, on, onCleanup, Show } from "solid-js"
import { unwrap } from "solid-js/store"
import { t } from "../../i18n"
import type { AlphaProjectsApi } from "../../sidebar/use-projects"
import { AlphaComposer, type ComposerSessionDockApi, type ComposerSlashCapture } from "../alpha-composer"
import { observeSessionAgent } from "../composer-state"
import { createModelContract } from "../model-contract"
import { SessionApprovalHost } from "./session-approval-card"
import {
  contextUsagePercent,
  headPendingQuestion,
  questionAnswersComplete,
  sdkResultFailed,
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
        })
      },
    ),
  )

  // 呈现权先立后破 + 唯一 owner(审计第 2/3 轮):claim 与审批卡渲染封装在
  // SessionApprovalHost —— 仅 feed 就绪才持 claim;多 dock 并存时按登记序恰一个 owner
  // 渲染审批卡;list 在途/失败期间不夺权,watcher 凭自身通道继续兜底。

  // fail-closed:feed 未就绪(缺席/读不到)= 无审批可呈现,亦无任何放行动作。
  // unwrap:store 代理的 $PROXY 符号会破坏 permissionRequestFacts 的严格键集核验,
  // 必须以 raw 对象交给审批卡(与 PermissionWatcher 同一处置)。
  const approval = createMemo(() => {
    const active = feed()
    if (!active?.state.ready) return undefined
    const head = active.state.requests[0]
    return head ? unwrap(head) : undefined
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

  /* ── 档位账本漂移侦听(审计第 3 轮 Major):持续观测 typed session info 的会话档,
        composer 推送的档一经他处改写立即放弃所有权 —— 用户此后手动切回同名档不会被
        误判为 composer 的旧写入(确认/漂移语义见 composer-state.observeSessionAgent)── */
  createEffect(() => {
    const bound = identity()
    if (!bound) return
    observeSessionAgent(bound.sessionID, serverSync().session.data.info[bound.sessionID]?.agent)
  })

  /* ── 「始终允许」授权所需的项目身份:取会话自身的精确 projectID(typed session info,
        与独立 Permission surface 的当前项目同源;sandbox 会话因此同样可用)────────────── */
  const projectID = createMemo(() => {
    const bound = identity()
    if (!bound) return undefined
    return serverSync().session.data.info[bound.sessionID]?.projectID
  })

  const dockApi: ComposerSessionDockApi = {
    running,
    contextUsage: usage,
    approvalPending: () => approval() !== undefined,
    // 档位协议的比对基准:typed session info 的会话当前档(undefined = 引擎默认)。
    sessionAgent: () => {
      const bound = identity()
      return bound ? serverSync().session.data.info[bound.sessionID]?.agent : undefined
    },
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
      <SessionApprovalHost
        sessionID={() => identity()?.sessionID}
        ready={() => feed()?.state.ready ?? false}
        approval={approval}
        projectID={projectID}
        onSubmit={(requestID, command) => {
          const active = feed()
          if (!active) return Promise.reject(new Error("permission feed is not ready"))
          return active.reply(requestID, command).then(() => undefined)
        }}
      />
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
      (result) => {
        // throwOnError:false 档位的 { error } 信封同样是失败(审计 minor:4xx 不装成功)。
        if (sdkResultFailed(result)) {
          setSubmitting(false)
          setFailed(true)
          return
        }
        setSubmitting(false)
      },
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
