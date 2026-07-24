import { ServerConnection, type MaybePreloadableComponent, useServerSDK, useServerSync } from "@opencode-ai/app"
import { useLocation } from "@solidjs/router"
import { createContext, createEffect, createMemo, untrack, type ParentProps, useContext } from "solid-js"
import { parseRoute } from "../../../shared/route-manifest"
import type { AlphaProjectsApi } from "../../sidebar/use-projects"
import { SessionRailArtifacts } from "../session-rail/artifacts/session-rail-artifacts"
import { SessionRailFiles } from "../session-rail/files/session-rail-files"
import { reviewChangeCount } from "../session-rail/review/review-core"
import { SessionRailReviewPanel } from "../session-rail/review/review-panel"
import { useAlphaTerminalEngineChannel } from "../session-rail/terminal/terminal-engine-adapter"
import { AlphaSessionTimeline } from "../session-timeline/session-timeline"
import { SurfaceBoundary } from "../surface-boundary"
import { SessionComposerDock } from "./session-composer-dock"
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
  // #554:真引擎 channel(I8 三元身份铸造)。TerminalProvider 随上游 SessionProviders 包住
  // 本叶,适配器可直接消费;引擎或会话身份缺席时为 undefined,面板 fail-closed 空态。
  const terminalChannel = useAlphaTerminalEngineChannel(current)

  // Review tab badge = changed-file count from the same typed diff channel the review panel
  // consumes (C2), through the same fail-closed narrowing (`reviewChangeCount`: non-array
  // payload = 0, never a throw into the SurfaceBoundary). Keyed by sessionID in the upstream
  // store, so a session switch swaps the count with the session (I8); undefined until the
  // diff set is known — no badge.
  const reviewCount = createMemo(() => {
    const identity = current()?.identity
    if (!identity) return undefined
    return reviewChangeCount(serverSync().session.data.session_diff[identity.sessionID])
  })
  // Idempotent badge-level load (same guard as the review panel's): the tab strip needs the
  // count even when the review panel has not been visited yet.
  createEffect(() => {
    const identity = current()?.identity
    if (!identity) return
    if (!serverSync().ready) return
    if (untrack(() => serverSync().session.data.session_diff[identity.sessionID] !== undefined)) return
    void serverSync().session.diff(identity.sessionID)
  })

  return (
    <SurfaceBoundary surface="session">
      <SessionLiveProvider value={live}>
        <SessionWorkspaceShell
          live={live}
          timeline={<AlphaSessionTimeline />}
          composer={() => <SessionComposerDock live={live} projects={props.projects} />}
          panels={{
            review: (rail) => <SessionRailReviewPanel live={live} rail={rail} />,
            files: (rail) => <SessionRailFiles live={live} rail={rail} />,
            artifacts: (rail) => <SessionRailArtifacts live={live} rail={rail} />,
          }}
          railMeta={{ reviewCount }}
          terminalChannel={terminalChannel}
        />
      </SessionLiveProvider>
    </SurfaceBoundary>
  )
}

export function alphaSessionWorkspaceSurface(projects: AlphaProjectsApi): MaybePreloadableComponent {
  return () => <AlphaSessionWorkspace projects={projects} />
}
