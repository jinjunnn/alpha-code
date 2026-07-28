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
// 形制 = 会话页那份 `session-workspace/session-dock-core.ts` 的 remount stash:**卸载时捕获、
// 取回即消费**。Solid 1.9.10(本仓锁定版本)上 keyed `Show` 的次序经独立探针确认为
// 「旧 cleanup → 新实例 create → 新实例 mount」,`startTransition` 只影响旧 DOM 何时不再可见,
// 不会让新实例先于旧 cleanup 取暂存 —— 所以这条次序可以依赖。
//
// **这里刻意没有任何容量帽和长度帽**:两者都是「静默丢用户内容」,正是本票要消灭的东西。
// 生命周期改由**存在性**收敛:取回即消费 + 晋升即 `forget()` + 每次读写按「tabs 里还活着的
// draftID」`prune()`。上游关闭 draft 的路径只清 tabs/persisted draft、不通知这里
// (`packages/app/src/context/tabs.tsx` 的 `removeTab`,上游只读不改),所以剪枝是唯一能让
// 「建 draft → 输入 → 关掉」重复做不至于无界堆积(单条还可能挂着附件 dataURL)的收口点。
// 剪掉的只可能是**已经不存在的 draft**,不是还活着的用户内容 —— 与被否掉的静默 LRU 不同。

import type { ComposerAttachment } from "./composer-attachments-core"
import type { MentionPart } from "./composer-autocomplete-core"

export type ComposerDraftSnapshot = {
  text: string
  mentions: readonly MentionPart[]
  attachments: readonly ComposerAttachment[]
}

const drafts = new Map<string, ComposerDraftSnapshot>()

const isEmpty = (draft: ComposerDraftSnapshot) =>
  draft.text.length === 0 && draft.mentions.length === 0 && draft.attachments.length === 0

export const newSessionDraftStash = {
  /** 卸载时捕获;空快照 = 清除(用户自己清空了,不该在重挂后复活)。不截断、不淘汰。 */
  capture(draftID: string, draft: ComposerDraftSnapshot) {
    if (!draftID) return
    if (isEmpty(draft)) {
      drafts.delete(draftID)
      return
    }
    drafts.set(draftID, { text: draft.text, mentions: [...draft.mentions], attachments: [...draft.attachments] })
  },
  /** 取回即消费(与会话页 stash 同语义):重挂后新实例拿走,不留副本。 */
  restore(draftID: string): ComposerDraftSnapshot | undefined {
    if (!draftID) return undefined
    const draft = drafts.get(draftID)
    if (draft !== undefined) drafts.delete(draftID)
    return draft
  },
  /** draft 晋升成会话(或显式丢弃)时清理 —— 内容已经发出去了,没有回访可言。 */
  forget(draftID: string) {
    if (draftID) drafts.delete(draftID)
  },
  /** 丢掉 tabs 里已不存在的 draft 的暂存(关掉的 draft 永远不会再回访)。 */
  prune(liveDraftIDs: Iterable<string>) {
    const live = new Set(liveDraftIDs)
    for (const draftID of [...drafts.keys()]) if (!live.has(draftID)) drafts.delete(draftID)
  },
  /** 测试隔离用。 */
  resetForTests() {
    drafts.clear()
  },
}
