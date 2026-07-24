import { createSignal } from "solid-js"
import { render } from "solid-js/web"
import type { AlphaTerminalEngineChannel } from "../session-rail/terminal/terminal-rail-core"
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

// #554 焦点交接的 shell 半场取证:假 channel 只记录调用(身份 = 初始快照,过 I8 闸)。
export const terminalChannelCalls: string[] = []

const terminalChannel: AlphaTerminalEngineChannel = {
  identity: initial.identity,
  ready: () => true,
  instances: () => [{ id: "pty_1", title: "终端 1", running: false }],
  activeID: () => "pty_1",
  open: (id) => void terminalChannelCalls.push(`open:${id}`),
  close: (id) => void terminalChannelCalls.push(`close:${id}`),
  create: () => void terminalChannelCalls.push("create"),
  requestFocus: (id) => void terminalChannelCalls.push(`requestFocus:${id ?? "active"}`),
  cancelFocus: () => void terminalChannelCalls.push("cancelFocus"),
  footStatus: () => ({ running: false }),
  EngineOutput: (props) => <div data-alpha-terminal-engine-output={props.instanceID} />,
}

export function SessionWorkspaceHarness() {
  const live: AlphaSessionLiveContext = {
    current: snapshot,
    accepts: (identity) => sameSessionIdentity(identity, snapshot()?.identity),
  }
  return <SessionWorkspaceShell live={live} terminalChannel={() => terminalChannel} />
}

export function setSessionWorkspaceSnapshot(next: AlphaSessionLiveSnapshot | undefined) {
  setSnapshot(next)
}

export function resetSessionWorkspaceSnapshot() {
  setSnapshot(initial)
  terminalChannelCalls.splice(0)
}
