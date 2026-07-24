import { ServerConnection, type MaybePreloadableComponent, useServerSDK, useServerSync } from "@opencode-ai/app"
import { useLocation } from "@solidjs/router"
import { createContext, createMemo, type ParentProps, useContext } from "solid-js"
import { parseRoute } from "../../../shared/route-manifest"
import { SurfaceBoundary } from "../surface-boundary"
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

export function AlphaSessionWorkspace() {
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

  return (
    <SurfaceBoundary surface="session">
      <SessionLiveProvider value={live}>
        <SessionWorkspaceShell live={live} />
      </SessionLiveProvider>
    </SurfaceBoundary>
  )
}

export function alphaSessionWorkspaceSurface(): MaybePreloadableComponent {
  return () => <AlphaSessionWorkspace />
}
