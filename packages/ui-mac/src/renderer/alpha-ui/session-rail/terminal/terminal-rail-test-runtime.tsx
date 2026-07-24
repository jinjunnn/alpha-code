// REQ-125 C3-term(#550)—— 组件测试 runtime:假引擎通道驱动面板(形态同
// session-workspace-test-runtime)。假通道只实现 seam 形状,行为与上游语义对齐:
// open 切激活、close 移除并回落激活、create 追加并激活。
// I8:channel 投影铸造时盖三元身份;accepts 用真 sameSessionIdentity 对当前 live
// 身份校验 —— 同 workspace 切会话即拒收旧投影,重投影后恢复。
import { createSignal } from "solid-js"
import { render } from "solid-js/web"
import { sameSessionIdentity, type AlphaSessionIdentity } from "../../session-workspace/session-workspace-core"
import {
  type AlphaTerminalEngineChannel,
  type AlphaTerminalFootStatus,
  type AlphaTerminalInstance,
} from "./terminal-rail-core"
import { TerminalRailPanel } from "./terminal-rail-panel"

export { render }

interface FakeInstance extends AlphaTerminalInstance {
  foot: AlphaTerminalFootStatus
}

const WORKSPACE = { serverKey: "sidecar", directory: "/tmp/workspace" }

const identityOf = (sessionID: string): AlphaSessionIdentity => ({ ...WORKSPACE, sessionID })

const initialInstances: FakeInstance[] = [
  {
    id: "pty_1",
    title: "终端 1",
    running: true,
    foot: { running: true, shell: "zsh", cols: 80, rows: 24 },
  },
  {
    id: "pty_2",
    title: "终端 2",
    running: false,
    foot: { running: false, shell: "zsh", cols: 80, rows: 24 },
  },
]

const [instances, setInstances] = createSignal<FakeInstance[]>(initialInstances)
const [activeID, setActiveID] = createSignal<string | undefined>("pty_1")
const [ready, setReady] = createSignal(true)
const [liveIdentity, setLiveIdentity] = createSignal<AlphaSessionIdentity>(identityOf("ses_a"))
// #554 焦点交接:未消费的聚焦请求(id undefined = 聚焦即将激活者),假 EngineOutput 挂载时
// 一次性消费 —— 与真适配器的 autoFocus/onAutoFocus 粘合同语义(上游 Terminal 挂载时消费)。
const [focusRequest, setFocusRequest] = createSignal<{ id?: string } | undefined>(undefined)

export const channelCalls: string[] = []

let nextCreated = 3

function makeChannel(identity: AlphaSessionIdentity): AlphaTerminalEngineChannel {
  return {
    identity,
    ready,
    instances,
    activeID,
    open(id) {
      // 对齐真适配器 channel.open 语义(#554):先发聚焦请求再切激活,请求在重挂前就位。
      channelCalls.push(`requestFocus:${id}`)
      setFocusRequest({ id })
      channelCalls.push(`open:${id}`)
      setActiveID(id)
    },
    close(id) {
      channelCalls.push(`close:${id}`)
      setInstances((all) => all.filter((instance) => instance.id !== id))
      setActiveID((current) => (current === id ? instances()[0]?.id : current))
    },
    create() {
      channelCalls.push("create")
      const id = `pty_${nextCreated}`
      nextCreated += 1
      const created: FakeInstance = {
        id,
        title: `终端 ${nextCreated - 1}`,
        running: false,
        foot: { running: false, shell: "zsh", cols: 80, rows: 24 },
      }
      setInstances((all) => [...all, created])
      setActiveID(id)
    },
    requestFocus(id) {
      channelCalls.push(`requestFocus:${id ?? "active"}`)
      setFocusRequest({ id })
    },
    cancelFocus() {
      channelCalls.push("cancelFocus")
      setFocusRequest(undefined)
    },
    footStatus(id) {
      return instances().find((instance) => instance.id === id)?.foot ?? { running: false }
    },
    EngineOutput: (props) => {
      // 一次性消费(上游 Terminal 语义):挂载时有匹配的未消费请求即消费并清除。
      const request = focusRequest()
      const consumed = request !== undefined && (request.id === undefined || request.id === props.instanceID)
      if (consumed) {
        channelCalls.push(`focusConsumed:${props.instanceID}`)
        setFocusRequest(undefined)
      }
      return (
        <div
          data-alpha-terminal-engine-output={props.instanceID}
          data-alpha-terminal-focus-consumed={consumed ? "true" : undefined}
        />
      )
    },
  }
}

const [channel, setChannel] = createSignal<AlphaTerminalEngineChannel>(makeChannel(identityOf("ses_a")))

const accepts = (identity: AlphaSessionIdentity) => sameSessionIdentity(identity, liveIdentity())

export function TerminalRailHarness() {
  return <TerminalRailPanel channel={channel()} accepts={accepts} />
}

export function TerminalRailHarnessWithoutEngine() {
  return <TerminalRailPanel accepts={accepts} />
}

/** 同 workspace 切会话:只换 live 三元组的 sessionID(serverKey+directory 不变)。 */
export function setTerminalLiveSession(sessionID: string) {
  setLiveIdentity(identityOf(sessionID))
}

/** 适配器语义:按给定会话身份重投影 channel(共享同一 workspace 级 PTY 状态)。 */
export function projectTerminalChannel(sessionID: string) {
  setChannel(makeChannel(identityOf(sessionID)))
}

export function setTerminalInstances(next: FakeInstance[]) {
  setInstances(next)
}

export function setTerminalActiveID(next: string | undefined) {
  setActiveID(next)
}

export function setTerminalChannelReady(next: boolean) {
  setReady(next)
}

export function resetTerminalRailHarness() {
  setInstances(initialInstances)
  setActiveID("pty_1")
  setReady(true)
  setLiveIdentity(identityOf("ses_a"))
  setFocusRequest(undefined)
  setChannel(makeChannel(identityOf("ses_a")))
  nextCreated = 3
  channelCalls.splice(0)
}
