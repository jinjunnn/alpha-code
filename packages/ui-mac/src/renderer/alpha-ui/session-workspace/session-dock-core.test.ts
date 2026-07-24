// REQ-125 C7:dock 纯逻辑核 + 斜杠来源登记的契约。

import { describe, expect, test } from "bun:test"
import type { Message, ModelV2Info, QuestionInfo, Todo } from "@opencode-ai/sdk/v2/client"
import {
  contextUsagePercent,
  headPendingQuestion,
  questionAnswersComplete,
  sdkResultFailed,
  todoDockVisible,
} from "./session-dock-core"
import {
  recordSessionSlashOrigin,
  resetSessionSlashOrigins,
  sessionSlashOriginsFor,
} from "./session-slash-origin"

const assistant = (input: {
  id: string
  providerID: string
  modelID: string
  tokens?: Partial<{ input: number; output: number; reasoning: number; read: number; write: number }>
}): Message =>
  ({
    id: input.id,
    sessionID: "ses_1",
    role: "assistant",
    providerID: input.providerID,
    modelID: input.modelID,
    tokens: {
      input: input.tokens?.input ?? 0,
      output: input.tokens?.output ?? 0,
      reasoning: input.tokens?.reasoning ?? 0,
      cache: { read: input.tokens?.read ?? 0, write: input.tokens?.write ?? 0 },
    },
  }) as unknown as Message

const user = (id: string): Message => ({ id, sessionID: "ses_1", role: "user" }) as unknown as Message

const model = (providerID: string, id: string, context: number): ModelV2Info =>
  ({ id, providerID, limit: { context, output: 8192 } }) as unknown as ModelV2Info

describe("contextUsagePercent:typed messages × model catalog,事实不足 = null", () => {
  test("最后一条带 token 的 assistant 消息按其模型上限折算百分比", () => {
    const messages = [
      user("msg-1"),
      assistant({ id: "msg-2", providerID: "alpha", modelID: "opus", tokens: { input: 90_000 } }),
      assistant({ id: "msg-3", providerID: "alpha", modelID: "opus", tokens: { input: 30_000, read: 8_000 } }),
      assistant({ id: "msg-4", providerID: "alpha", modelID: "opus" }), // 零 token,跳过
    ]
    expect(contextUsagePercent(messages, [model("alpha", "opus", 100_000)])).toBe(38)
  })

  test("无消息 / 无目录 / 模型缺上限 → null(ring 不渲染,不装有数据)", () => {
    const messages = [assistant({ id: "msg-1", providerID: "alpha", modelID: "opus", tokens: { input: 10 } })]
    expect(contextUsagePercent(undefined, [model("alpha", "opus", 1000)])).toBeNull()
    expect(contextUsagePercent(messages, [])).toBeNull()
    expect(contextUsagePercent(messages, [model("alpha", "other", 1000)])).toBeNull()
    expect(contextUsagePercent([user("msg-1")], [model("alpha", "opus", 1000)])).toBeNull()
  })

  test("超限封顶 100", () => {
    const messages = [assistant({ id: "msg-1", providerID: "a", modelID: "m", tokens: { input: 5_000 } })]
    expect(contextUsagePercent(messages, [model("a", "m", 1_000)])).toBe(100)
  })
})

describe("todoDockVisible:仅运行中且有未完成项时停靠", () => {
  const todo = (status: string): Todo => ({ content: "task", status }) as unknown as Todo

  test("空清单 / 空闲会话 / 全部完成 → 不停靠", () => {
    expect(todoDockVisible({ todos: [], running: true })).toBe(false)
    expect(todoDockVisible({ todos: [todo("pending")], running: false })).toBe(false)
    expect(todoDockVisible({ todos: [todo("completed"), todo("cancelled")], running: true })).toBe(false)
  })

  test("运行中且尚有未完成项 → 停靠", () => {
    expect(todoDockVisible({ todos: [todo("completed"), todo("in_progress")], running: true })).toBe(true)
  })
})

describe("question:头部挂起请求与回答完备性", () => {
  const info = (input: Partial<QuestionInfo>): QuestionInfo =>
    ({
      question: "How?",
      header: "How",
      options: [
        { label: "A", description: "a" },
        { label: "B", description: "b" },
      ],
      ...input,
    }) as QuestionInfo

  test("headPendingQuestion 只认带完整问题的请求", () => {
    const empty = { id: "req-0", sessionID: "ses_1", questions: [] } as never
    const real = { id: "req-1", sessionID: "ses_1", questions: [info({})] } as never
    expect(headPendingQuestion(undefined)).toBeUndefined()
    expect(headPendingQuestion([empty, real])).toBe(real)
  })

  test("单选题恰一个选项;选项必须来自 label;custom 题接受非空自由文本", () => {
    expect(questionAnswersComplete([info({})], [["A"]])).toBe(true)
    expect(questionAnswersComplete([info({})], [["A", "B"]])).toBe(false)
    expect(questionAnswersComplete([info({})], [["C"]])).toBe(false)
    expect(questionAnswersComplete([info({})], [[]])).toBe(false)
    expect(questionAnswersComplete([info({ multiple: true })], [["A", "B"]])).toBe(true)
    expect(questionAnswersComplete([info({ custom: true })], [["自由回答"]])).toBe(true)
    expect(questionAnswersComplete([info({ custom: true })], [["  "]])).toBe(false)
    expect(questionAnswersComplete([], [])).toBe(false)
  })
})

describe("sdkResultFailed:{ error } 信封与空结果一律按失败处理(审计 minor)", () => {
  test("error 信封 / undefined / null → 失败;正常信封与 204 空体 → 成功", () => {
    expect(sdkResultFailed({ error: { status: 409 } })).toBe(true)
    expect(sdkResultFailed(undefined)).toBe(true)
    expect(sdkResultFailed(null)).toBe(true)
    expect(sdkResultFailed({ data: true })).toBe(false)
    expect(sdkResultFailed({ data: undefined, error: undefined })).toBe(false)
    expect(sdkResultFailed({})).toBe(false)
  })
})

describe("session-slash-origin:发送时捕获,绑完整会话身份,有界存储", () => {
  const identity = (sessionID: string) => ({ serverKey: "sidecar", directory: "/tmp/ws", sessionID })

  test("登记绑 serverKey+directory+sessionID,读取按身份过滤", () => {
    resetSessionSlashOrigins()
    recordSessionSlashOrigin({ identity: identity("ses_a"), command: "review", arguments: "pr 12", assistantMessageID: "msg_9", at: 1 })
    recordSessionSlashOrigin({ identity: identity("ses_b"), command: "test", arguments: "", at: 2 })

    const forA = sessionSlashOriginsFor(identity("ses_a"))
    expect(forA).toHaveLength(1)
    expect(forA[0]).toMatchObject({ command: "review", arguments: "pr 12", assistantMessageID: "msg_9" })
    expect(sessionSlashOriginsFor({ ...identity("ses_a"), serverKey: "other" })).toHaveLength(0)
  })

  test("单会话超限丢最旧(有界,I7)", () => {
    resetSessionSlashOrigins()
    for (let index = 0; index < 20; index++) {
      recordSessionSlashOrigin({ identity: identity("ses_a"), command: `cmd-${index}`, arguments: "", at: index })
    }
    const kept = sessionSlashOriginsFor(identity("ses_a"))
    expect(kept).toHaveLength(16)
    expect(kept[0]!.command).toBe("cmd-4")
    expect(kept.at(-1)!.command).toBe("cmd-19")
  })
})
