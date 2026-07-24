import { createSignal } from "solid-js"
import { render } from "solid-js/web"
import { sameSessionIdentity, type AlphaSessionLiveSnapshot } from "./session-workspace-core"
import { SessionWorkspaceShell, type AlphaSessionLiveContext } from "./session-workspace-shell"

const initial: AlphaSessionLiveSnapshot = {
  identity: {
    serverKey: "sidecar",
    directory: "/tmp/workspace",
    sessionID: "ses_idle",
  },
  project: "workspace",
  title: "整理架构说明",
  activity: "idle",
}

const [snapshot, setSnapshot] = createSignal<AlphaSessionLiveSnapshot | undefined>(initial)

export { render }

export function SessionWorkspaceHarness() {
  const live: AlphaSessionLiveContext = {
    current: snapshot,
    accepts: (identity) => sameSessionIdentity(identity, snapshot()?.identity),
  }
  return <SessionWorkspaceShell live={live} />
}

export function setSessionWorkspaceSnapshot(next: AlphaSessionLiveSnapshot | undefined) {
  setSnapshot(next)
}

export function resetSessionWorkspaceSnapshot() {
  setSnapshot(initial)
}
