// REQ-125 C6/C8(#568) — 时间线卡片的可选交互意图(intent)通道。
//
// 行为合同:handler 缺席 → 行/pill 降级为纯展示(fail-closed,不导航、不报错)。
// openSession 由数据绑定层用 route-manifest 直接供给(子任务卡「打开子会话」);
// focusArtifact/openFile 由绑定层接 C4 SessionRailApi(#568 真接线):
// focusArtifact → rail.focusArtifact(右栏产物面板),openFile → rail.jumpToReview
// (右栏审查面板的文件卡,write/edit pill 与 diffsum 行同一通道)。
import { createContext, useContext } from "solid-js"
import type { TimelineMediaSource } from "../timeline-model"
import type { StagedAttachmentMeta } from "../../../../shared/attachment-path"

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
  url?: string
}

/**
 * descriptor id 是产物面板的匹配键;媒体源由文件查看器消费。
 */
export function artifactFocusIdOf(intent: TimelineFocusArtifactIntent): string {
  return intent.id ?? intent.name
}

/**
 * 生产绑定:保留 descriptor 的 run 身份与媒体的实际源。绑定层与组件测试
 * 用**同一个**函数 —— 否则「点第 N 行选中第 N 个」的判据锚点会是测试自己重写的一行。
 */
export function bindFocusArtifact(
  focus: (artifactId: string, runId?: string) => void,
  openMedia?: (media: TimelineMediaSource) => void,
): (intent: TimelineFocusArtifactIntent) => void {
  return (intent) => {
    if (intent.url) {
      openMedia?.({ url: intent.url, name: intent.name, mime: intent.mime!, partID: intent.partID! })
      return
    }
    focus(artifactFocusIdOf(intent), intent.runId)
  }
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
  /**
   * 空回合行「修改后再试」(REQ-160 AC3):把焦点交回输入框,让用户就地改提问重发。
   * 缺席即那一行只剩事实陈述,不出按钮(fail-closed,同中断行 —— 不给一个点不动的按钮)。
   * 返回 Promise 时,拒绝 = 失败,由该行就地提示,不得静默吞掉。
   */
  focusPrompt?: () => void | Promise<void>
  /**
   * REQ-236 `#1552`:生图卡所在项目目录(宿主 tracker 与右栏产物面板同一货币:会话身份的 directory)。
   * 缺席 = 卡片只呈现调用阶段(正在提交 / 没有开始 / 排队中),不取任务状态、不读本机产物。
   */
  cloudDirectory?: string
  /**
   * REQ-236 `#1553` AC4:附件卡「重新读取 / 请助手读取」—— 宿主在输入框里以同一个暂存附件预填一条请求读取的消息
   * (用户看得到、自己发出),不在后台悄悄重读。缺席即不出按钮。
   */
  readAttachment?: (attachment: StagedAttachmentMeta) => void
}

export const TimelineIntentsContext = createContext<TimelineIntents>({})

export function useTimelineIntents(): TimelineIntents {
  return useContext(TimelineIntentsContext)
}
