// REQ-125 C7:dock 纯逻辑核 + 斜杠来源登记的契约。

import { describe, expect, test } from "bun:test"
import type { Message, ModelV2Info, QuestionInfo, Session, Todo } from "@opencode-ai/sdk/v2/client"
import { hrefFor } from "../../../shared/route-manifest"
import {
  childParentHref,
  childSessionFacts,
  contextUsagePercent,
  createComposerDraftStash,
  headPendingQuestion,
  questionAnswersComplete,
  revertDockFacts,
  sdkResultFailed,
  todoDockVisible,
} from "./session-dock-core"
import {
  recordSessionSlashOrigin,
  resetSessionSlashOrigins,
  sessionSlashOriginsFor,
} from "./session-slash-origin"
import { type AlphaSessionIdentity, sameSessionIdentity } from "./session-workspace-core"

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

describe("revertDockFacts:检查点回退条,计数缺完整证据即省略(fail-closed)", () => {
  const sessionMsgs = [
    user("msg-1"),
    assistant({ id: "msg-2", providerID: "a", modelID: "m" }),
    user("msg-3"),
    assistant({ id: "msg-4", providerID: "a", modelID: "m" }),
    user("msg-5"),
  ]

  test("渲染:锚点在已加载消息中 → 锚点及其之后的用户回合计数", () => {
    // 锚点 msg-3(已加载)→ 其后用户回合 = msg-3, msg-5(assistant 不计)= 2。
    expect(revertDockFacts({ messageID: "msg-3" }, sessionMsgs)).toEqual({ messageID: "msg-3", discardCount: 2 })
  })

  test("fail-closed:revert 缺席 / 无 messageID / 畸形 → undefined(整条不渲染)", () => {
    expect(revertDockFacts(undefined, sessionMsgs)).toBeUndefined()
    expect(revertDockFacts({ messageID: "" }, sessionMsgs)).toBeUndefined()
    expect(revertDockFacts({} as Session["revert"], sessionMsgs)).toBeUndefined()
  })

  test("fail-closed:计数无完整证据即省略——消息缺失/非数组/锚点未加载 → 只给 messageID,不给可能错的数", () => {
    // 消息通道缺失 / 非数组:回退事实仍在,计数省略(不装 0)。
    expect(revertDockFacts({ messageID: "msg-3" }, undefined)).toEqual({ messageID: "msg-3" })
    expect(revertDockFacts({ messageID: "msg-3" }, null as unknown as readonly Message[])).toEqual({
      messageID: "msg-3",
    })
    // 锚点不在已加载消息(分页未覆盖 checkpoint,计数不完整):省略计数。
    expect(revertDockFacts({ messageID: "msg-3" }, [])).toEqual({ messageID: "msg-3" })
    expect(revertDockFacts({ messageID: "msg-3" }, [user("msg-1"), assistant({ id: "msg-2", providerID: "a", modelID: "m" })])).toEqual({
      messageID: "msg-3",
    })
  })

  test("I8:计数只认调用方按 sessionID 供给、且含本会话锚点的消息(不跨会话给错数)", () => {
    // 另一会话的消息(不含本会话锚点 msg-3)→ 拒绝计数,不复用旧会话、不给错数。
    const otherSessionMsgs = [user("msg-3-alt"), user("msg-4-alt")]
    expect(revertDockFacts({ messageID: "msg-3" }, otherSessionMsgs)).toEqual({ messageID: "msg-3" })
    // 本会话消息(含锚点)→ 完整计数。
    expect(revertDockFacts({ messageID: "msg-3" }, sessionMsgs)).toEqual({ messageID: "msg-3", discardCount: 2 })
  })
})

describe("childSessionFacts + childParentHref:子会话条与跳转", () => {
  const session = (input: Partial<Session>): Session => ({ id: "ses_c", title: "child", ...input }) as unknown as Session
  // 真三元组工厂:三段可各自变化,身份等价用 sameSessionIdentity 全比(非仅 sessionID)。
  const identity = (over: Partial<AlphaSessionIdentity> = {}): AlphaSessionIdentity => ({
    serverKey: "sidecar",
    directory: "/tmp/ws",
    sessionID: "ses_c",
    ...over,
  })

  test("渲染:有 parentID → 父会话跳转目标(标题取父会话,未加载则回落 parentID)", () => {
    const child = session({ parentID: "ses_parent" })
    expect(childSessionFacts(child, session({ id: "ses_parent", title: "Parent task" }))).toEqual({
      parentID: "ses_parent",
      parentTitle: "Parent task",
    })
    expect(childSessionFacts(child, undefined)).toEqual({ parentID: "ses_parent", parentTitle: "ses_parent" })
  })

  test("fail-closed:非子会话 / 会话缺席 / parentID 畸形 → undefined", () => {
    expect(childSessionFacts(session({}), undefined)).toBeUndefined()
    expect(childSessionFacts(undefined, undefined)).toBeUndefined()
    expect(childSessionFacts(session({ parentID: "" }), undefined)).toBeUndefined()
  })

  test("I8:身份等价用 sameSessionIdentity 全比,href 经真实 hrefFor.session 的 serverKey 编码", () => {
    const bound = identity()
    const accepts = (candidate: AlphaSessionIdentity) => sameSessionIdentity(candidate, bound)
    // 当前身份 → 经真实 route-manifest 编码的父会话 href(serverKey 走 server codec)。
    const expected = hrefFor.session(bound.serverKey, "ses_parent")
    expect(childParentHref({ bound, accepts, parentID: "ses_parent", hrefFor: hrefFor.session })).toBe(expected)
    // stale = 三元组任一段不同即拒绝(sameSessionIdentity 全比):sessionID 变。
    expect(
      childParentHref({ bound: identity({ sessionID: "ses_other" }), accepts, parentID: "ses_parent", hrefFor: hrefFor.session }),
    ).toBeUndefined()
    // stale:sessionID 相同但 serverKey 不同(证明非仅比 sessionID)。
    expect(
      childParentHref({ bound: identity({ serverKey: "other-server" }), accepts, parentID: "ses_parent", hrefFor: hrefFor.session }),
    ).toBeUndefined()
    // stale:sessionID/serverKey 相同但 directory 不同。
    expect(
      childParentHref({ bound: identity({ directory: "/tmp/other" }), accepts, parentID: "ses_parent", hrefFor: hrefFor.session }),
    ).toBeUndefined()
    // 无 parentID → 无跳转。
    expect(childParentHref({ bound, accepts, parentID: undefined, hrefFor: hrefFor.session })).toBeUndefined()
  })
})

describe("createComposerDraftStash:per-identity 草稿暂存,门翻转不丢草稿(I8)", () => {
  const key = (identity: AlphaSessionIdentity) => `${identity.serverKey}\u0000${identity.directory}\u0000${identity.sessionID}`
  const identity = (over: Partial<AlphaSessionIdentity> = {}): AlphaSessionIdentity => ({
    serverKey: "sidecar",
    directory: "/tmp/ws",
    sessionID: "ses_x",
    ...over,
  })

  test("门翻转:卸载捕获 → 翻回同一身份 restore 拿回草稿", () => {
    const stash = createComposerDraftStash()
    const x = key(identity())
    expect(stash.restore(x)).toBeUndefined() // 首挂:无暂存 → composer 起始为空
    stash.capture(x, "hello world") // 门翻转卸载时捕获
    expect(stash.restore(x)).toBe("hello world") // 门翻回同一身份 → 草稿仍在
  })

  test("restore 取后即删(消费):还原一次后暂存清空,不留陈旧", () => {
    const stash = createComposerDraftStash()
    const x = key(identity())
    stash.capture(x, "draft")
    expect(stash.restore(x)).toBe("draft") // 门翻回还原(消费)
    expect(stash.restore(x)).toBeUndefined() // 已删,不重复还原
  })

  test("空串清除;无 key 不写;forget 显式清理单键(身份离开)", () => {
    const stash = createComposerDraftStash()
    const x = key(identity())
    stash.capture(x, "draft")
    stash.capture(x, "") // 清空后卸载 → 清除
    expect(stash.restore(x)).toBeUndefined()
    stash.capture(undefined, "orphan") // 无身份 → 不写
    expect(stash.restore(undefined)).toBeUndefined()
    stash.capture(x, "again")
    stash.forget(x) // 身份离开 / live 换代 → 丢弃对应键
    expect(stash.restore(x)).toBeUndefined()
  })

  test("有界(I7):容量帽 LRU 淘汰最旧 + 单条文本帽截断", () => {
    const stash = createComposerDraftStash({ capacity: 3, maxTextLength: 5 })
    stash.capture("k0", "a")
    stash.capture("k1", "b")
    stash.capture("k2", "c")
    stash.capture("k3", "d") // 超容量 3 → 淘汰最旧 k0
    expect(stash.restore("k0")).toBeUndefined()
    expect(stash.restore("k3")).toBe("d")
    stash.capture("kt", "0123456789") // 超文本帽 5 → 截断
    expect(stash.restore("kt")).toBe("01234")
  })

  test("I8:草稿按身份三元组隔离,不跨会话/服务器/目录泄漏", () => {
    const stash = createComposerDraftStash()
    stash.capture(key(identity()), "draft-x")
    // 仅 sessionID 不同 → 隔离。
    expect(stash.restore(key(identity({ sessionID: "ses_y" })))).toBeUndefined()
    // 仅 serverKey 不同 → 隔离(证明非仅比 sessionID)。
    expect(stash.restore(key(identity({ serverKey: "other" })))).toBeUndefined()
    // 仅 directory 不同 → 隔离。
    expect(stash.restore(key(identity({ directory: "/tmp/other" })))).toBeUndefined()
    // 同一三元组 → 拿回。
    expect(stash.restore(key(identity()))).toBe("draft-x")
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
