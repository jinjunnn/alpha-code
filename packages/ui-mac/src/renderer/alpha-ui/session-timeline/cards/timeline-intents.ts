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

export interface TimelineIntents {
  focusArtifact?: (intent: TimelineFocusArtifactIntent) => void
  openSession?: (sessionID: string) => void
  openFile?: (intent: TimelineOpenFileIntent) => void
  /** 中断态「继续生成」:绑定层接现有会话发送入口(v2 session.prompt);缺席即中断行无续钮。 */
  continueTurn?: () => void
}

export const TimelineIntentsContext = createContext<TimelineIntents>({})

export function useTimelineIntents(): TimelineIntents {
  return useContext(TimelineIntentsContext)
}
