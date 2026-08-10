// REQ-125 C6/C8(#568) — 时间线卡片的可选交互意图(intent)通道。
//
// 行为合同:handler 缺席 → 行/pill 降级为纯展示(fail-closed,不导航、不报错)。
// openSession 由数据绑定层用 route-manifest 直接供给(子任务卡「打开子会话」);
// focusArtifact/openFile 由绑定层接 C4 SessionRailApi(#568 真接线):
// focusArtifact → rail.focusArtifact(右栏产物面板),openFile → rail.jumpToReview
// (右栏审查面板的文件卡,write/edit pill 与 diffsum 行同一通道)。
import { createContext, useContext } from "solid-js"

export interface TimelineFocusArtifactIntent {
  name: string
  /** 时间线内产生它的 part(媒体预览行)。 */
  partID?: string
  /** 产物所属 run(产物链接行)。 */
  runId?: string
  mime?: string
}

/** 「在面板打开」的文件目标;path 可能是绝对(工具 input)或 git 相对(diffsum)。 */
export interface TimelineOpenFileIntent {
  path: string
}

/** 用户消息「编辑重发」的现有会话回退入口；text 是该消息的原始文本。 */
export interface TimelineEditUserMessageIntent {
  sessionID: string
  messageID: string
  text: string
}

export interface TimelineIntents {
  focusArtifact?: (intent: TimelineFocusArtifactIntent) => void
  openSession?: (sessionID: string) => void
  openFile?: (intent: TimelineOpenFileIntent) => void
  /**
   * 用户消息「编辑重发」:宿主接现有 session.revert + composer 预填；缺席即不出按钮。
   * 宿主负责明确失败反馈；时间线本身不猜写入结果。
   */
  editUserMessage?: (intent: TimelineEditUserMessageIntent) => void | Promise<void>
  /**
   * 中断态「继续生成」:绑定层接现有会话发送入口(v2 session.prompt);缺席即中断行无续钮。
   * 返回 Promise 时,拒绝 = 发送失败(admission 前不产生任何 session_status 事件,typed
   * 通道呈现不了)—— 由中断行就地给出失败提示,不得静默吞掉。
   */
  continueTurn?: () => void | Promise<void>
}

export const TimelineIntentsContext = createContext<TimelineIntents>({})

export function useTimelineIntents(): TimelineIntents {
  return useContext(TimelineIntentsContext)
}
