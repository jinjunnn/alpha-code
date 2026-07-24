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
  // composer 停靠位走与生产同一条直挂通道(props 传入);harness 用标记桩替代真实
  // SessionComposerDock(后者依赖 ServerSDK/ServerSync 上下文),直挂结构本身被真实断言。
  return <SessionWorkspaceShell live={live} composer={() => <div data-alpha-session-composer-stub />} />
}

export function setSessionWorkspaceSnapshot(next: AlphaSessionLiveSnapshot | undefined) {
  setSnapshot(next)
}

export function resetSessionWorkspaceSnapshot() {
  setSnapshot(initial)
}
