// REQ-125 C6 — 时间线卡片的可选交互意图(intent)通道。
//
// C5/C6 基座没有右栏 SessionRail api(C2–C4 与本票并行),媒体预览行与产物链接行
// 的「聚焦产物」因此以可选 intent 回调发出:handler 缺席 → 行降级为纯展示
// (fail-closed,不导航、不报错);接线归 C8 收口。openSession 由数据绑定层用
// route-manifest 直接供给(子任务卡「打开子会话」)。
import { createContext, useContext } from "solid-js"

export interface TimelineFocusArtifactIntent {
  name: string
  /** 时间线内产生它的 part(媒体预览行)。 */
  partID?: string
  /** 产物所属 run(产物链接行)。 */
  runId?: string
  mime?: string
}

export interface TimelineIntents {
  focusArtifact?: (intent: TimelineFocusArtifactIntent) => void
  openSession?: (sessionID: string) => void
}

export const TimelineIntentsContext = createContext<TimelineIntents>({})

export function useTimelineIntents(): TimelineIntents {
  return useContext(TimelineIntentsContext)
}
