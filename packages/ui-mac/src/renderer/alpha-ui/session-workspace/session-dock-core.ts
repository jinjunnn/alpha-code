// REQ-125 C7:composer dock 的纯逻辑核(typed 数据 → UI 判定,零 DOM)。

import type { Message, ModelV2Info, QuestionInfo, QuestionRequest, Todo } from "@opencode-ai/sdk/v2/client"

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

/**
 * SDK 结果按失败处理的统一判据:Promise rejection 之外,throwOnError:false 档位的
 * `{ error }` 信封同样是失败(Codex 审计 minor:4xx 不得被当作成功)。
 */
export function sdkResultFailed(result: unknown): boolean {
  if (result === undefined || result === null) return true
  if (typeof result !== "object") return false
  return "error" in result && (result as { error?: unknown }).error !== undefined
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
