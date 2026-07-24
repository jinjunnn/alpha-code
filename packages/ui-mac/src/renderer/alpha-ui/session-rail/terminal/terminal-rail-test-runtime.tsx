// REQ-125 C3-term(#550)—— 组件测试 runtime:假引擎通道驱动面板(形态同
// session-workspace-test-runtime)。假通道只实现 seam 形状,行为与上游语义对齐:
// open 切激活、close 移除并回落激活、create 追加并激活。
import { createSignal } from "solid-js"
import { render } from "solid-js/web"
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

export const channelCalls: string[] = []

let nextCreated = 3

const fakeChannel: AlphaTerminalEngineChannel = {
  ready,
  instances,
  activeID,
  open(id) {
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
  footStatus(id) {
    return instances().find((instance) => instance.id === id)?.foot ?? { running: false }
  },
  EngineOutput: (props) => <div data-alpha-terminal-engine-output={props.instanceID} />,
}

export function TerminalRailHarness() {
  return <TerminalRailPanel channel={fakeChannel} />
}

export function TerminalRailHarnessWithoutEngine() {
  return <TerminalRailPanel />
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
  nextCreated = 3
  channelCalls.splice(0)
}
