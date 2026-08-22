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
  /**
   * `#906`:产物的稳定标识(平台 descriptor id)。产物面板的匹配键就是它(descriptor id /
   * card key 同一货币),**名字不是匹配键** —— 只递名字 = 永不命中 = 静默选中该 run 的第一个
   * 产物。产物链接行恒携带(契约输出的 artifacts 项即完整 descriptor);媒体预览行没有产物
   * 身份,故缺席。
   */
  id?: string
  /** 时间线内产生它的 part(媒体预览行)。 */
  partID?: string
  /** 产物所属 run(产物链接行)。 */
  runId?: string
  mime?: string
}

/**
 * `#906` 时间线→产物面板的**唯一**联动换算:递 descriptor id;缺 id 时退回名字,而名字对不上
 * 任何卡 ⇒ 面板打开但不改选中(artifacts-core 的 fail-closed 合同),不猜、不改选。
 */
export function artifactFocusIdOf(intent: TimelineFocusArtifactIntent): string {
  return intent.id ?? intent.name
}

/**
 * 生产绑定:把 rail 的 `focusArtifact(artifactId)` 接成时间线 intent 处理器。绑定层与组件测试
 * 用**同一个**函数 —— 否则「点第 N 行选中第 N 个」的判据锚点会是测试自己重写的一行。
 */
export function bindFocusArtifact(
  focus: (artifactId: string) => void,
): (intent: TimelineFocusArtifactIntent) => void {
  return (intent) => focus(artifactFocusIdOf(intent))
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
