// REQ-125 C7:composer dock 的纯逻辑核(typed 数据 → UI 判定,零 DOM)。

import type { Message, ModelV2Info, QuestionInfo, QuestionRequest, Session, Todo } from "@opencode-ai/sdk/v2/client"

/**
 * 上下文用量百分比:最后一条带 token 的 assistant 消息的 token 总量 / 该消息模型的
 * context 上限(与上游 session-context-metrics 同一口径,alpha 自持实现)。
 * 任一事实缺失(无消息 / 模型不在目录 / 无上限)→ null,ring 不渲染 —— 不装有数据。
 */
export function contextUsagePercent(
  messages: readonly Message[] | undefined,
  models: readonly ModelV2Info[] | undefined,
): number | null {
  if (!messages?.length || !models?.length) return null
  for (let index = messages.length - 1; index >= 0; index--) {
    const message = messages[index]!
    if (message.role !== "assistant") continue
    const total =
      message.tokens.input +
      message.tokens.output +
      message.tokens.reasoning +
      message.tokens.cache.read +
      message.tokens.cache.write
    if (total <= 0) continue
    const limit = models.find(
      (model) => model.providerID === message.providerID && model.id === message.modelID,
    )?.limit.context
    if (!limit || limit <= 0) return null
    return Math.max(0, Math.min(100, Math.round((total / limit) * 100)))
  }
  return null
}

export function todoDone(todo: Todo): boolean {
  return todo.status === "completed" || todo.status === "cancelled"
}

/**
 * 任务清单 dock 可见性:仅在会话进行中且尚有未完成项时停靠(空清单 / 全部完成 / 空闲
 * 会话的陈旧清单一律不停靠)。
 */
export function todoDockVisible(input: { todos: readonly Todo[]; running: boolean }): boolean {
  if (!input.running || input.todos.length === 0) return false
  return input.todos.some((todo) => !todoDone(todo))
}

/** 头部挂起提问:只认携带至少一条完整问题的请求。 */
export function headPendingQuestion(requests: readonly QuestionRequest[] | undefined): QuestionRequest | undefined {
  return requests?.find((request) => Array.isArray(request.questions) && request.questions.length > 0)
}

/**
 * 回答是否可提交:按题序逐题校验 —— 每题至少一个选择;非 custom 题的选择必须来自选项
 * label;非 multiple 题至多一个选择。
 */
export function questionAnswersComplete(questions: readonly QuestionInfo[], answers: readonly (readonly string[])[]) {
  if (questions.length === 0 || answers.length !== questions.length) return false
  return questions.every((question, index) => {
    const picked = answers[index] ?? []
    if (picked.length === 0) return false
    if (!question.multiple && picked.length > 1) return false
    if (question.custom) return picked.every((value) => value.trim().length > 0)
    const labels = new Set(question.options.map((option) => option.label))
    return picked.every((value) => labels.has(value))
  })
}

/**
 * 检查点回退条(REQ-125 #558):会话暂存的 `revert` 状态 → 紧凑投影。
 * fail-closed(整条):`revert` 缺席 / 畸形(无字符串 `messageID`)= undefined,不渲染。
 * fail-closed(计数):`discardCount` 只在**有完整证据**时给出——消息通道是数组且已加载到
 * 锚点(checkpoint 消息在数组中,证明其后的尾部消息也已加载)时,才计锚点及其之后的
 * **用户回合**数(与上游 rolled() 同口径)。消息缺失/非数组/锚点不在已加载消息(分页未
 * 覆盖 checkpoint)一律省略 `discardCount`——回退事实仍呈现,但绝不给可能错的数字。
 * 消息数组由调用方按 `sessionID` 供给(I8)。
 */
export function revertDockFacts(
  revert: Session["revert"] | undefined,
  messages: readonly Message[] | undefined,
): { messageID: string; discardCount?: number } | undefined {
  if (!revert || typeof revert.messageID !== "string" || revert.messageID.length === 0) return undefined
  const anchor = revert.messageID
  // 计数须有完整证据:非数组,或锚点不在已加载消息中 → 只给回退事实,不给计数。
  if (!Array.isArray(messages) || !messages.some((message) => message.id === anchor)) {
    return { messageID: anchor }
  }
  const discardCount = messages.reduce(
    (count, message) => (message.role === "user" && message.id >= anchor ? count + 1 : count),
    0,
  )
  return { messageID: anchor, discardCount }
}

/**
 * 子会话条(REQ-125 #558):当前会话的父级 linkage → 跳转投影。
 * fail-closed:无字符串 `parentID`(即非子会话)= undefined,不渲染。父会话标题未加载时
 * 回落 `parentID`,跳转仍可用。
 */
export function childSessionFacts(
  session: Session | undefined,
  parent: Session | undefined,
): { parentID: string; parentTitle: string } | undefined {
  const parentID = session?.parentID
  if (typeof parentID !== "string" || parentID.length === 0) return undefined
  const title = parent?.title?.trim()
  return { parentID, parentTitle: title && title.length > 0 ? title : parentID }
}

/**
 * 子会话跳转目标(I8):仅当发起身份仍是当前会话(`accepts`)时给出父会话 href,并绑
 * 该身份的 `serverKey`;身份已切换或无 `parentID` = undefined,拒绝 stale 跳转。
 */
export function childParentHref<Identity extends { serverKey: string }>(input: {
  bound: Identity
  accepts: (identity: Identity) => boolean
  parentID: string | undefined
  hrefFor: (serverKey: string, sessionID: string) => string
}): string | undefined {
  if (!input.parentID || input.parentID.length === 0) return undefined
  if (!input.accepts(input.bound)) return undefined
  return input.hrefFor(input.bound.serverKey, input.parentID)
}

/**
 * per-identity composer 草稿暂存(REQ-125 #558,I8)。
 *
 * child-session 门翻转会**卸载** AlphaComposer(保持子会话零可发送路径);若 `info` 迟到——
 * 先挂 composer、`parentID` 到达后门翻转——正在输入的草稿会随卸载丢失。此暂存按会话身份
 * 三元组 key 在卸载时捕获草稿、门翻回同一身份时注入初值,使卸载不再等于不可恢复的丢失。
 * 空串即清除(已发送/清空的会话不残留陈旧草稿)。key 由调用方以身份三元组算出(I8)。
 */
export function createComposerDraftStash() {
  const drafts = new Map<string, string>()
  return {
    /** 卸载时按身份捕获草稿;无 key(无身份)不写,空串清除该身份的暂存。 */
    capture(key: string | undefined, draft: string) {
      if (!key) return
      if (draft.length > 0) drafts.set(key, draft)
      else drafts.delete(key)
    },
    /** 门翻回时按身份取回暂存草稿(无则 undefined,composer 起始为空)。 */
    restore(key: string | undefined): string | undefined {
      return key ? drafts.get(key) : undefined
    },
  }
}
