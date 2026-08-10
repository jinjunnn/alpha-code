// SessionComposerDock — REQ-125 C7:seam 会话页的 composer 停靠区。
//
// 职责:
// - AlphaComposer 以 mode="session" **直挂**(props 传入;零 Portal/零选择器/零收养);
// - composer 上方停靠区:提问卡(question typed 通道)、任务清单卡(todo typed 通道)等
//   任务类停靠;**审批呈现统一走独立 Permission surface**(PermissionDialog,owner 裁决
//   2026-07-25)—— dock 不渲审批卡,只以 PermissionV2 typed feed(fail-closed)驱动
//   composer 的审批挂起提示;
// - live status / 上下文用量 / 斜杠命令捕获经 ComposerSessionDockApi 注入 composer;
// - 一切异步结果绑定 serverKey+directory+sessionID(C1 live context 原语,I8)。

import { createPermissionChannelSource, useServerSDK, useServerSync } from "@opencode-ai/app"
import type { ModelV2Info, Todo } from "@opencode-ai/sdk/v2/client"
import { useNavigate } from "@solidjs/router"
import { createEffect, createMemo, createSignal, For, on, onCleanup, Show } from "solid-js"
import { hrefFor } from "../../../shared/route-manifest"
import { t } from "../../i18n"
import type { AlphaProjectsApi } from "../../sidebar/use-projects"
import type { ComposerSessionDockApi, ComposerSlashCapture } from "../alpha-composer"
import { createModelContract } from "../model-contract"
import { SessionComposerMount, type SessionComposerEditRequest } from "./session-composer-mount"
import {
  childParentHref,
  childSessionFacts,
  contextUsagePercent,
  createComposerDraftStash,
  headPendingQuestion,
  revertDockFacts,
  sdkResultFailed,
  todoDockVisible,
  todoDone,
} from "./session-dock-core"
import { createPermissionV2Feed, type PermissionV2Feed } from "./session-permission-feed"
import { SessionQuestionCard } from "./session-question-card"
import { recordSessionSlashOrigin } from "./session-slash-origin"
import { type AlphaSessionIdentity, identityKey } from "./session-workspace-core"
import type { AlphaSessionLiveContext } from "./session-workspace-shell"

export function SessionComposerDock(props: {
  live: AlphaSessionLiveContext
  projects: AlphaProjectsApi
  editRequest?: () => SessionComposerEditRequest | undefined
}) {
  const serverSDK = useServerSDK()
  const serverSync = useServerSync()
  const navigate = useNavigate()
  const identity = () => props.live.current()?.identity
  const running = () => props.live.current()?.activity === "running"
  // per-identity 草稿暂存(I8):child-session 门翻转卸载 composer 时按身份捕获草稿,门翻回同一
  // 身份时经 initialText 注入,避免 info 迟到→门翻转丢失正在输入的草稿。
  const draftStash = createComposerDraftStash()
  // 目录作用域 SDK(typed 事件按类型分发;refcount 由 memo 的 onCleanup 管理)。
  const dirSDK = createMemo(() => {
    const bound = identity()
    return bound ? serverSDK().ensureDirSdkContext(bound.directory) : undefined
  })

  /* ── 审批 feed:随会话身份重建;身份失效的结果一律丢弃(I8)。
        审批呈现与决定提交都不在 dock(owner 裁决 2026-07-25,统一走独立 Permission
        surface);feed 只为 composer 的审批挂起提示(placeholder + 权限 chip)供事实,
        与 PermissionWatcher 同一 fail-closed 实现 —— 未就绪 = 无审批挂起。
        #668:读面是 **v1 + v2 两条通道的合并**(createPermissionChannelSource,与 Permission
        surface 同一实现)。此前只订 v2,而 ADR-036 之后真正在跑的是 v1 —— 于是 v1 的每一次
        审批请求既不弹卡也不亮 chip,回合无声挂起。dock 仍**无任何决定提交路径**。 ────────── */
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
        const channels = createPermissionChannelSource({
          sessionID: () => bound.sessionID,
          sdk: () => sdk,
          messages: () => serverSync().session.data.message[bound.sessionID],
          accepts: accepted,
        })
        const nextFeed = createPermissionV2Feed({
          list: () => channels.list(),
          // dock 无决定提交路径:审批决定只能经独立 Permission surface 提交。
          reply: () => Promise.reject(new Error("approval decisions are submitted only via the permission surface")),
        })
        const stopChannels = channels.subscribe({
          asked: (request) => {
            if (!accepted()) return
            nextFeed.apply({ type: "asked", request })
          },
          replied: (receipt) => {
            if (!accepted()) return
            nextFeed.apply({ type: "replied", receipt })
          },
          connected: () => nextFeed.load(),
        })
        nextFeed.load()
        setFeed(nextFeed)
        onCleanup(() => {
          stopChannels()
          nextFeed.dispose()
        })
      },
    ),
  )

  // fail-closed:feed 未就绪(缺席/读不到)= 无审批挂起可提示。依赖的不变量与强制手段:
  // ready 仅在「最近一次 list 成功且无新拉取在途」为 true(session-permission-feed 的
  // Blocker-1 语义,其测试锁定);提示为纯只读投影,dock 无任何放行动作可言。
  const approvalPending = createMemo(() => {
    const active = feed()
    return !!active?.state.ready && active.state.requests.length > 0
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
        // #882:目录就绪屏障不再自带 deadline,取消必须由调用方给 —— 否则每次目录切换都会留下
        // 一条自己跑到天荒地老的探针循环(`stale` 只挡住结果落地,挡不住等待本身)。
        const cancel = new AbortController()
        modelContract.list(directory, cancel.signal).then(
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
          cancel.abort(new Error("session dock directory changed"))
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

  const dockApi: ComposerSessionDockApi = {
    running,
    contextUsage: usage,
    approvalPending,
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
      {/* 子会话与可发送 composer 互斥(对齐上游子会话语义):子会话(有 parentID)只呈现
          子会话条(运行指示 + 返回父会话入口)为主体,**不挂** composer——子会话零可发送路径,
          新输入只能回到父会话。非子会话才经 SessionComposerMount 挂 composer(按身份 keyed)。 */}
      <Show
        when={childSession()}
        keyed
        fallback={
          <SessionComposerMount
            identity={identity}
            projects={props.projects}
            dock={dockApi}
            drafts={draftStash}
            editRequest={props.editRequest}
          />
        }
      >
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
    </div>
  )
}

/* ── 检查点回退条(session.revert typed 事实;纯呈现 —— 发送/清空由 composer 流程处理)──
   计数只在 revertDockFacts 拿到完整证据时给出;缺证据(消息未加载/分页未覆盖锚点)= 省略
   计数区,只呈现回退事实,绝不显示可能错的数字。 */
function SessionRevertCard(props: { facts: { messageID: string; discardCount?: number } }) {
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
        {/* keyed:计数省略(undefined)或为 0 时不渲染;>0 时 count 收窄为 number。 */}
        <Show when={props.facts.discardCount} keyed>
          {(count) => <span class="a-swk-revert-detail">{t("alpha.session.revertDetail", { count })}</span>}
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
