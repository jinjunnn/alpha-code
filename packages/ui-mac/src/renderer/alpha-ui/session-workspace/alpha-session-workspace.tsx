import { ServerConnection, type MaybePreloadableComponent, useServerSDK, useServerSync } from "@opencode-ai/app"
import { useLocation } from "@solidjs/router"
import { createContext, createEffect, createMemo, createSignal, onCleanup, untrack, type ParentProps, useContext } from "solid-js"
import { parseRoute } from "../../../shared/route-manifest"
import { t } from "../../i18n"
import type { AlphaProjectsApi } from "../../sidebar/use-projects"
import { pushToast } from "../Toast"
import { SessionRailArtifacts } from "../session-rail/artifacts/session-rail-artifacts"
import { SessionRailFiles } from "../session-rail/files/session-rail-files"
import { reviewChangeCount } from "../session-rail/review/review-core"
import { turnDiffsOf } from "../session-rail/review/review-turn-diffs"
import { SessionRailReviewPanel } from "../session-rail/review/review-panel"
import { useAlphaTerminalEngineChannel } from "../session-rail/terminal/terminal-engine-adapter"
import { AlphaSessionTimeline } from "../session-timeline/session-timeline"
import type { TimelineTurnWait } from "../session-timeline/timeline-model"
import { publishActiveSessionIdentity } from "../active-session-directory"
import { sandboxApplied } from "../sandbox-state"
import { SurfaceBoundary } from "../surface-boundary"
import { useWorkspaceWritable } from "../workspace-writable"
import { SessionComposerDock } from "./session-composer-dock"
import type { SessionComposerEditRequest } from "./session-composer-mount"
import {
  canEditUserMessageForSession,
  createSessionEditUserMessageHandler,
  discardStaleEditRequest,
} from "./session-edit-user-message"
import { sessionSlashOriginsFor } from "./session-slash-origin"
import { sameSessionIdentity, sessionLiveSnapshotOf } from "./session-workspace-core"
import { type AlphaSessionLiveContext, SessionWorkspaceShell } from "./session-workspace-shell"
import "./session-workspace.css"

const SessionLiveContext = createContext<AlphaSessionLiveContext>()

export function useAlphaSessionLiveContext(): AlphaSessionLiveContext {
  const context = useContext(SessionLiveContext)
  if (!context) throw new Error("AlphaSessionLiveContext is unavailable")
  return context
}

function SessionLiveProvider(props: ParentProps<{ value: AlphaSessionLiveContext }>) {
  return <SessionLiveContext.Provider value={props.value}>{props.children}</SessionLiveContext.Provider>
}

export function AlphaSessionWorkspace(props: { projects: AlphaProjectsApi }) {
  const location = useLocation()
  const serverSDK = useServerSDK()
  const serverSync = useServerSync()
  const current = createMemo(() => {
    const route = parseRoute(location.pathname, location.search)
    const session = route.kind === "session" && route.id ? serverSync().session.data.info[route.id] : undefined
    return sessionLiveSnapshotOf({
      route,
      providerServerKey: ServerConnection.key(serverSDK().server),
      session,
      status: route.kind === "session" && route.id ? serverSync().session.data.session_status[route.id] : undefined,
    })
  })
  const live: AlphaSessionLiveContext = {
    current,
    accepts: (identity) => sameSessionIdentity(identity, current()?.identity),
  }
  const [editRequest, setEditRequest] = createSignal<SessionComposerEditRequest | undefined>(undefined)
  // `#1399`:活跃回合「在等你」(审批 / 提问)—— dock 发布(它是审批 feed 与 question 投影的唯一真相源),
  // 时间线的回合脚行消费。审批卡本身仍只在独立 Permission surface(2026-07-26 裁决),这里传的只是一个词。
  const [turnWait, setTurnWait] = createSignal<TimelineTurnWait | undefined>(undefined)
  // 编辑预填只属于发起时的 I8 身份；一旦离开该会话就销毁，返回时不得再次覆盖草稿。
  createEffect(() => discardStaleEditRequest(editRequest(), current()?.identity, () => setEditRequest(undefined)))
  const canEditUserMessage = createMemo(() => {
    const identity = current()?.identity
    const info = identity ? serverSync().session.data.info[identity.sessionID] : undefined
    return canEditUserMessageForSession(identity, info)
  })
  const editUserMessage = createSessionEditUserMessageHandler({
    current,
    accepts: live.accepts,
    canEdit: (identity) => canEditUserMessageForSession(identity, serverSync().session.data.info[identity.sessionID]),
    session: () => serverSDK().client.session,
    apply: setEditRequest,
    reject: (error) => {
      console.warn("[alpha] edit resend revert failed", error)
      pushToast({ kind: "error", title: t("alpha.timeline.editResendFailed") })
    },
  })
  // #554:真引擎 channel(I8 三元身份铸造)。TerminalProvider 随上游 SessionProviders 包住
  // 本叶,适配器可直接消费;引擎或会话身份缺席时为 undefined,面板 fail-closed 空态。
  const terminalChannel = useAlphaTerminalEngineChannel(current)
  // REQ-159 `#1322`:「这个目录成为当前工作区」在会话页的唯一咽喉 = live 身份里的 directory(deep link /
  // 侧栏 draft 晋升 / 直接导航都落在这里)。探针由被围栏的引擎执行;只有它明确回报写被拒才为 true。
  const workspaceReadonly = useWorkspaceWritable(() => current()?.identity.directory)

  // Review tab badge = changed-file count from the same turn-level projection the review
  // panel consumes (REQ-142: `turnDiffsOf` over the synced message store), through the same
  // fail-closed narrowing (`reviewChangeCount`: non-array payload = 0, never a throw into
  // the SurfaceBoundary). Keyed by sessionID in the upstream store, so a session switch
  // swaps the count with the session (I8); undefined until the messages are known — no badge.
  const reviewCount = createMemo(() => {
    const identity = current()?.identity
    if (!identity) return undefined
    return reviewChangeCount(turnDiffsOf(serverSync().session.data.message[identity.sessionID]))
  })
  // Idempotent badge-level load (same guard as the review panel's): the tab strip needs the
  // count even when the review panel has not been visited yet.
  createEffect(() => {
    const identity = current()?.identity
    if (!identity) return
    if (!serverSync().ready) return
    if (untrack(() => serverSync().session.data.message[identity.sessionID] !== undefined)) return
    void serverSync().session.sync(identity.sessionID)
  })
  // `#1361`:把此刻解出的身份登记到壳层活会话通道。设置页「工具」节挂在 `AppInterface` 的 children 上,
  // 在 `ServerSyncProvider` **之外** —— 它读不到上面这份 session info,只能读被 worktree-filter 过滤过的
  // 侧栏清单,于是归档 / 家目录为根的会话在那一节里解不出项目。登记的就是本页自己在用的那个目录,
  // 两个面因此同源;离开会话页注销 ⇒ 设置页回到 fail-closed 的「先打开一个项目」。
  createEffect(() => publishActiveSessionIdentity(current()?.identity))
  onCleanup(() => publishActiveSessionIdentity(undefined))

  return (
    <SurfaceBoundary surface="session">
      <SessionLiveProvider value={live}>
        <SessionWorkspaceShell
          live={live}
          timeline={(rail) => (
            <AlphaSessionTimeline
              rail={rail}
              slashOriginsFor={sessionSlashOriginsFor}
              onEditUserMessage={canEditUserMessage() ? editUserMessage : undefined}
              turnWait={turnWait}
            />
          )}
          composer={() => (
            <SessionComposerDock
              live={live}
              projects={props.projects}
              editRequest={editRequest}
              publishTurnWait={setTurnWait}
            />
          )}
          panels={{
            review: (rail) => <SessionRailReviewPanel live={live} rail={rail} />,
            files: (rail) => <SessionRailFiles live={live} rail={rail} />,
            artifacts: (rail) => <SessionRailArtifacts live={live} rail={rail} />,
          }}
          railMeta={{ reviewCount }}
          terminalChannel={terminalChannel}
          sandbox={sandboxApplied}
          workspaceReadonly={workspaceReadonly}
          relaunch={() => window.api.relaunch()}
        />
      </SessionLiveProvider>
    </SurfaceBoundary>
  )
}

export function alphaSessionWorkspaceSurface(projects: AlphaProjectsApi): MaybePreloadableComponent {
  const Surface: MaybePreloadableComponent = () => <AlphaSessionWorkspace projects={projects} />
  // #574 单一顶栏:工作区 46px 顶栏是会话页唯一 header(自带窗口拖拽区,见
  // session-workspace.css)。静态声明后,上游 NewLayout 在 session 路由不再渲染窗口
  // Titlebar;home/newSession 等其余路由与未注入模式保持上游 Titlebar 原样。
  Surface.ownsTitlebar = true
  return Surface
}
