import type { QuestionRequest } from "@opencode-ai/sdk/v2/client"
import { createSignal } from "solid-js"
import { render } from "solid-js/web"
import type { AlphaTerminalEngineChannel } from "../session-rail/terminal/terminal-rail-core"
import { SessionQuestionCard } from "./session-question-card"
import { sameSessionIdentity, type AlphaSessionLiveSnapshot } from "./session-workspace-core"
import {
  SessionWorkspaceShell,
  type AlphaSessionLiveContext,
  type SessionRailPanelRenderers,
} from "./session-workspace-shell"

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
const [reviewCount, setReviewCount] = createSignal<number | undefined>(undefined)
const [terminalRunning, setTerminalRunning] = createSignal(false)

export { render }

function liveContext(): AlphaSessionLiveContext {
  return {
    current: snapshot,
    accepts: (identity) => sameSessionIdentity(identity, snapshot()?.identity),
  }
}

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

/** All four lanes present as placeholders: exercises switching, memory, badge, dot, handoff. */
export function SessionWorkspaceHarness() {
  const panels: SessionRailPanelRenderers = {
    review: () => <div data-harness-panel="review" />,
    files: () => <div data-harness-panel="files" />,
    terminal: () => <div data-harness-panel="terminal" />,
    artifacts: () => <div data-harness-panel="artifacts" />,
  }
  return (
    <SessionWorkspaceShell
      live={liveContext()}
      // C7:composer 停靠位走与生产同一条直挂通道(props 传入);harness 用标记桩替代真实
      // SessionComposerDock(后者依赖 ServerSDK/ServerSync 上下文),直挂结构本身被真实断言。
      composer={() => <div data-alpha-session-composer-stub />}
      panels={panels}
      railMeta={{ reviewCount, terminalRunning }}
      terminalChannel={() => terminalChannel}
    />
  )
}

// C21 AC2 的提问卡取证:两道选项标签完全相同的单选题(读屏进第二组必须能听出在答哪道)
// 加一道多选题。提交通道故意缺席(client 返回 undefined)—— 这里要的是键盘与 ARIA 事实。
const option = (label: string) => ({ label, description: "" })
const questionRequest = {
  id: "que_harness",
  sessionID: initial.identity.sessionID,
  questions: [
    { header: "发布", question: "现在就发布吗?", options: [option("是"), option("否")] },
    { header: "回滚", question: "失败时自动回滚吗?", options: [option("是"), option("否")] },
    { header: "范围", question: "包含哪些包?", multiple: true, options: [option("界面"), option("内核")] },
  ],
} as unknown as QuestionRequest

export function SessionQuestionHarness() {
  return (
    <SessionQuestionCard
      request={questionRequest}
      identity={() => initial.identity}
      accepts={() => true}
      client={() => undefined}
    />
  )
}

/** Mid-state harness: only the given lanes have landed — the rest must fail closed. */
export function SessionWorkspacePartialHarness(props: { panels: SessionRailPanelRenderers }) {
  return <SessionWorkspaceShell live={liveContext()} panels={props.panels} />
}

export function setSessionWorkspaceSnapshot(next: AlphaSessionLiveSnapshot | undefined) {
  setSnapshot(next)
}

export function setSessionWorkspaceReviewCount(next: number | undefined) {
  setReviewCount(next)
}

export function setSessionWorkspaceTerminalRunning(next: boolean) {
  setTerminalRunning(next)
}

export function resetSessionWorkspaceSnapshot() {
  setSnapshot(initial)
  setReviewCount(undefined)
  setTerminalRunning(false)
  terminalChannelCalls.splice(0)
}
