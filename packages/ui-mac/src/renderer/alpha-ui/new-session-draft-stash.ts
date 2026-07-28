// 新对话页 composer 的跨重挂暂存(REQ-126 CODE-D / 基线 §3 不变量 6「不吞内容」)。
//
// 为什么必须存在:draft 叶在上游以 `server\0directory` keyed
// (`packages/app/src/app.tsx` 的 `createDraftRoute`),**切目录 = 整叶重挂** —— 连
// AlphaNewSession 自己都被卸载重建,而 composer 的文本/mention/附件都是组件本地信号。没有叶
// **之外**的暂存,用户在新对话页输了一半再换项目 = 无声清空。
//
// 为什么按 draftID keyed:draftID 跨目录切换稳定(`updateDraft` 只改 directory),而
// `server\0directory` 正是被切掉的那把钥匙。
//
// 为什么是**写穿**(每次变更即存)而不是会话页那种「卸载时捕获」
// (`session-workspace/session-dock-core.ts` 的 createComposerDraftStash):会话页的重挂由 alpha
// 自己的 `<Show keyed>` 驱动,卸载先于挂载成立;这里的重挂由**上游**在 `startTransition` 里改
// store 触发,新旧实例的 dispose/mount 次序不是我们能保证的事实。写穿 + 取回不消费 ⇒ 两种次序
// 下结果相同,不押注一个没验过的时序。
//
// 取回不消费的代价是条目会留下:容量 LRU 上限收着;draft 晋升成会话后该 draftID 不再出现,
// 陈旧条目自然被淘汰。

import type { ComposerAttachment } from "./composer-attachments-core"
import type { MentionPart } from "./composer-autocomplete-core"

export type ComposerDraftSnapshot = {
  text: string
  mentions: readonly MentionPart[]
  attachments: readonly ComposerAttachment[]
}

const CAPACITY = 8
const MAX_TEXT_LENGTH = 20_000

function isEmpty(draft: ComposerDraftSnapshot) {
  return draft.text.length === 0 && draft.mentions.length === 0 && draft.attachments.length === 0
}

const drafts = new Map<string, ComposerDraftSnapshot>()

export const newSessionDraftStash = {
  /** 变更即写;空快照 = 清除该 draft 的暂存(用户自己清空了,不该在重挂后复活)。 */
  capture(draftID: string, draft: ComposerDraftSnapshot) {
    if (!draftID) return
    drafts.delete(draftID) // 重插到队尾:Map 保持插入序 → 队首=最旧,用作 LRU
    if (isEmpty(draft)) return
    drafts.set(draftID, {
      text: draft.text.length > MAX_TEXT_LENGTH ? draft.text.slice(0, MAX_TEXT_LENGTH) : draft.text,
      mentions: [...draft.mentions],
      attachments: [...draft.attachments],
    })
    while (drafts.size > CAPACITY) {
      const oldest = drafts.keys().next().value
      if (oldest === undefined) break
      drafts.delete(oldest)
    }
  },
  /** 取回**不消费**:新实例可能先于旧实例的 dispose 挂载,消费会让后来的 dispose 无从写回。 */
  restore(draftID: string): ComposerDraftSnapshot | undefined {
    return draftID ? drafts.get(draftID) : undefined
  },
  /** 测试隔离用;生产无调用点(容量 LRU 负责回收)。 */
  resetForTests() {
    drafts.clear()
  },
}
