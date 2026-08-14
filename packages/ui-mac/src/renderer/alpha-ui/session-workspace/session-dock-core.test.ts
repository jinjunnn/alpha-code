// REQ-125 C7:dock 纯逻辑核 + 斜杠来源登记的契约。

import { describe, expect, test } from "bun:test"
import type { Message, ModelV2Info, QuestionInfo, Session, Todo } from "@opencode-ai/sdk/v2/client"
import { hrefFor } from "../../../shared/route-manifest"
import { projectTimelineRows } from "../session-timeline/timeline-model"
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

/** 一块可快照的「盘」;`snapshot()` 就是重启之后还留在机器上的那些字节。 */
function diskStorage(initial?: Record<string, string>) {
  const map = new Map(Object.entries(initial ?? {}))
  return {
    getItem: (key: string) => map.get(key) ?? null,
    setItem: (key: string, value: string) => void map.set(key, value),
    snapshot: () => Object.fromEntries(map) as Record<string, string>,
  }
}

describe("session-slash-origin:发送时捕获,绑完整会话身份,有界存储", () => {
  const identity = (sessionID: string) => ({ serverKey: "sidecar", directory: "/tmp/ws", sessionID })

  test("登记绑 serverKey+directory+sessionID,读取按身份过滤", () => {
    const disk = diskStorage()
    resetSessionSlashOrigins(disk)
    recordSessionSlashOrigin({ identity: identity("ses_a"), command: "review", arguments: "pr 12", assistantMessageID: "msg_9", at: 1 }, disk)
    recordSessionSlashOrigin({ identity: identity("ses_b"), command: "test", arguments: "", at: 2 }, disk)

    const forA = sessionSlashOriginsFor(identity("ses_a"), disk)
    expect(forA).toHaveLength(1)
    expect(forA[0]).toMatchObject({ command: "review", arguments: "pr 12", assistantMessageID: "msg_9" })
    expect(sessionSlashOriginsFor({ ...identity("ses_a"), serverKey: "other" }, disk)).toHaveLength(0)
  })

  test("E3/E4:登记可携带引擎声明的 source,读取原样返还;未带则诚实缺席", () => {
    const disk = diskStorage()
    resetSessionSlashOrigins(disk)
    recordSessionSlashOrigin({ identity: identity("ses_s"), command: "orbit-docs", arguments: "", source: "skill", assistantMessageID: "msg_1", at: 1 }, disk)
    recordSessionSlashOrigin({ identity: identity("ses_s"), command: "triage-notes", arguments: "", at: 2 }, disk)
    const kept = sessionSlashOriginsFor(identity("ses_s"), disk)
    expect(kept).toHaveLength(2)
    expect(kept[0]).toMatchObject({ command: "orbit-docs", source: "skill" })
    expect(kept[1]!.source).toBeUndefined()
  })

  test("单会话超限丢最旧(有界,I7)", () => {
    const disk = diskStorage()
    resetSessionSlashOrigins(disk)
    for (let index = 0; index < 20; index++) {
      recordSessionSlashOrigin({ identity: identity("ses_a"), command: `cmd-${index}`, arguments: "", at: index }, disk)
    }
    const kept = sessionSlashOriginsFor(identity("ses_a"), disk)
    expect(kept).toHaveLength(16)
    expect(kept[0]!.command).toBe("cmd-4")
    expect(kept.at(-1)!.command).toBe("cmd-19")
  })

  test("存储不可用(无 localStorage / 抛异常)时:不抛、零登记 —— 缺席即零渲染", () => {
    expect(() =>
      recordSessionSlashOrigin({ identity: identity("ses_n"), command: "review", arguments: "", at: 1 }, null),
    ).not.toThrow()
    expect(sessionSlashOriginsFor(identity("ses_n"), null)).toHaveLength(0)

    const hostile = {
      getItem: () => {
        throw new Error("SecurityError")
      },
      setItem: () => {
        throw new DOMException("QuotaExceededError", "QuotaExceededError")
      },
    }
    expect(() =>
      recordSessionSlashOrigin({ identity: identity("ses_n"), command: "review", arguments: "", at: 1 }, hostile),
    ).not.toThrow()
    expect(sessionSlashOriginsFor(identity("ses_n"), hostile)).toHaveLength(0)
  })
})

// ── `#953`:斜杠 chip 活过重启 ──────────────────────────────────────────────────
// 判据取在**用户看得见的那一行**上(时间线用户行的 `slash`),不断言内层登记的值。
//
// 「重启」在这里必须同时成立两件事,少一件判据就废:
//   ① 盘上的字节还在 —— 用上一轮写盘的快照重建一块新 storage;
//   ② **renderer 进程的内存全丢** —— 读那一半必须由一个**全新的模块实例**来做
//      (`?restart=<n>` 让 bun 重新求值该模块,实测函数标识都不同)。
// 只做 ① 是不够的,这一点是实测出来的:第一版判据只换了 storage,把生产实现改回
// `#953` 之前的形态(模块级数组持有登记、零写盘)之后,两条正向用例**照样全绿** ——
// 因为读路径拿的是同一个模块实例里那份还活着的内存。补上 ② 之后它们才转红。
describe("#953 斜杠命令 chip 活过重启:来源落盘,回放按落盘的字节重建", () => {
  const bound = { serverKey: "sidecar", directory: "/tmp/ws", sessionID: "ses_953" }

  /** 重启后的读侧:全新模块实例 + 只装着那些字节的 storage。 */
  let restartSeq = 0
  async function readAfterRestart(bytes: Record<string, string>) {
    const fresh = (await import(`${"./session-slash-origin"}.ts?restart=${++restartSeq}`)) as typeof import("./session-slash-origin")
    return fresh.sessionSlashOriginsFor(bound, diskStorage(bytes))
  }

  /** 一个只有一个回合的会话:用户消息 msg_u1(内容 = 展开后的模板文本)+ 助手回复 msg_a1。 */
  function replayedTurnSlash(slashOrigins: readonly { command: string }[]) {
    const rows = projectTimelineRows({
      messages: [
        {
          id: "msg_u1",
          sessionID: bound.sessionID,
          role: "user",
          time: { created: 1000 },
          agent: "build",
          model: { providerID: "deepseek", modelID: "deepseek-reasoner" },
        } as Message,
        {
          id: "msg_a1",
          sessionID: bound.sessionID,
          role: "assistant",
          parentID: "msg_u1",
          time: { created: 1010, completed: 1020 },
          modelID: "deepseek-reasoner",
          providerID: "deepseek",
          mode: "build",
          agent: "build",
          path: { cwd: "/tmp/ws", root: "/tmp/ws" },
          cost: 0,
          tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
        } as Message,
      ],
      partsOf: (id) =>
        id === "msg_u1"
          ? ([{ id: "prt_u1", sessionID: bound.sessionID, messageID: "msg_u1", type: "text", text: "展开后的模板正文" }] as never)
          : [],
      status: "idle",
      slashOrigins,
    })
    const user = rows.find((row) => row.kind === "user")
    if (!user || user.kind !== "user") throw new Error("expected a user row")
    return user.slash
  }

  /** 发一条斜杠命令 → 重启 → 时间线那一行上的 chip。 */
  async function chipAfterRestart(disk: ReturnType<typeof diskStorage>) {
    return replayedTurnSlash(await readAfterRestart(disk.snapshot()))
  }

  test("技能命令:重启后 chip 还在,且类型仍是 skill", async () => {
    const disk = diskStorage()
    resetSessionSlashOrigins(disk)
    recordSessionSlashOrigin(
      { identity: bound, command: "orbit-docs", arguments: "", source: "skill", assistantMessageID: "msg_a1", at: 1 },
      disk,
    )
    expect(await chipAfterRestart(disk)).toEqual({ command: "orbit-docs", source: "skill" })
  })

  test("MCP 命令:重启后 chip 还在,参数与 mcp 类型一并还原(与上一条不同字面量)", async () => {
    const disk = diskStorage()
    resetSessionSlashOrigins(disk)
    recordSessionSlashOrigin(
      {
        identity: bound,
        command: "atlas-sync",
        arguments: "prod --dry-run",
        source: "mcp",
        assistantMessageID: "msg_a1",
        at: 7,
      },
      disk,
    )
    expect(await chipAfterRestart(disk)).toEqual({
      command: "atlas-sync",
      arguments: "prod --dry-run",
      source: "mcp",
    })
  })

  test("T4 反向:落盘的登记对不上本回合的助手消息 ⇒ 重启后零 chip(不显示一个错的)", async () => {
    const disk = diskStorage()
    resetSessionSlashOrigins(disk)
    recordSessionSlashOrigin(
      { identity: bound, command: "ledger-audit", arguments: "", source: "command", assistantMessageID: "msg_a99", at: 3 },
      disk,
    )
    expect(await chipAfterRestart(disk)).toBeUndefined()
  })

  test("T4 反向:盘上是别的会话/别的 server 的登记 ⇒ 本会话重启后零 chip", async () => {
    const disk = diskStorage()
    resetSessionSlashOrigins(disk)
    recordSessionSlashOrigin(
      { identity: { ...bound, sessionID: "ses_other" }, command: "release-notes", arguments: "", assistantMessageID: "msg_a1", at: 4 },
      disk,
    )
    recordSessionSlashOrigin(
      { identity: { ...bound, serverKey: "ssh:build-box" }, command: "deploy-check", arguments: "", assistantMessageID: "msg_a1", at: 5 },
      disk,
    )
    recordSessionSlashOrigin(
      { identity: { ...bound, directory: "/tmp/elsewhere" }, command: "lint-all", arguments: "", assistantMessageID: "msg_a1", at: 6 },
      disk,
    )
    expect(await chipAfterRestart(disk)).toBeUndefined()
  })

  test("T4 反向:盘上的字节被改坏 ⇒ 重启后零 chip,且不抛", async () => {
    const KEY = "alpha-session-slash-origins-v1"
    const hostile = async (raw: string) => replayedTurnSlash(await readAfterRestart({ [KEY]: raw }))
    const aligned = { assistantMessageID: "msg_a1" }
    expect(await hostile("{ 不是 JSON")).toBeUndefined()
    expect(await hostile(JSON.stringify({ identity: bound, command: "x" }))).toBeUndefined()
    // 缺 command / arguments 不是字符串 / identity 缺一段 —— 逐条丢,不糊成空串。
    expect(await hostile(JSON.stringify([{ identity: bound, arguments: "", ...aligned }]))).toBeUndefined()
    expect(
      await hostile(JSON.stringify([{ identity: bound, command: "grep-todo", arguments: 42, ...aligned }])),
    ).toBeUndefined()
    expect(
      await hostile(
        JSON.stringify([
          { identity: { serverKey: "sidecar", sessionID: bound.sessionID }, command: "grep-todo", arguments: "", ...aligned },
        ]),
      ),
    ).toBeUndefined()
  })

  test("T4 反向:盘上写着一个不认识的 source ⇒ chip 仍在但回通用形,不猜类型", async () => {
    const KEY = "alpha-session-slash-origins-v1"
    const slash = replayedTurnSlash(
      await readAfterRestart({
        [KEY]: JSON.stringify([
          { identity: bound, command: "spellcheck", arguments: "", source: "wizard", assistantMessageID: "msg_a1", at: 8 },
        ]),
      }),
    )
    expect(slash).toEqual({ command: "spellcheck" })
  })
})
