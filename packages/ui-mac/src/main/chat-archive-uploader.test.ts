// REQ-160 `#1324` —— 上报器的**生产路径**判据(注入 fetch,照 alpha-web-upload-consent 那条接缝的做法)。
//
// 为什么这些用例必须驱动 `createChatArchiveUploader(...)` 而不是它下面的纯函数:
// 本仓实测过「断言内层纯函数 ⇒ 落在分流层的绕过照样绿」。429 那条尤其如此 —— 把
// `classifyArchiveResponse` 里 429 那一格删掉、让它落回「4xx 终态」,纯函数那组会红,
// 但**真正要守的东西**是「游标在 429 之后没有动」,而那句话只有跑完整条 idle 路径才看得见。
//
// 本文件不发真实网络请求:`fetch` 全程注入,engine 与 alpha-web 两个目的地都由脚本答复。
// 游标用真的文件(临时目录),因为断言的对象正是「重启之后会读到什么」。

import { afterEach, describe, expect, test } from "bun:test"
import { createHash } from "node:crypto"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { openChatArchiveCursor } from "./chat-archive-cursor"
import { createChatArchiveUploader } from "./chat-archive-uploader"

const ENGINE = "http://127.0.0.1:41999"
const WEB = "https://web.example"
const PNG = Buffer.from("89504e470d0a1a0a0000000d49484452", "hex")
const PNG_SHA256 = createHash("sha256").update(PNG).digest("hex")

const dirs: string[] = []
function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "chat-archive-uploader-"))
  dirs.push(dir)
  return dir
}
afterEach(() => {
  while (dirs.length) rmSync(dirs.pop()!, { recursive: true, force: true })
})

type Call = { url: string; init?: RequestInit }

function engineMessages(options: { attachment?: boolean; extra?: unknown[] } = {}) {
  const userParts: unknown[] = [{ type: "text", text: "你好" }]
  if (options.attachment) {
    userParts.push({
      type: "file",
      mime: "image/png",
      filename: "shot.png",
      url: `data:image/png;base64,${PNG.toString("base64")}`,
    })
  }
  return [
    ...(options.extra ?? []),
    {
      info: { id: "msg_0001", role: "user", time: { created: 4_990 }, model: { providerID: "alpha", modelID: "gpt-5" } },
      parts: userParts,
    },
    {
      info: {
        id: "msg_0002",
        role: "assistant",
        time: { created: 4_995, completed: 5_000 },
        providerID: "alpha",
        modelID: "gpt-5",
        finish: "stop",
        tokens: { output: 7 },
      },
      parts: [{ type: "text", text: "你也好" }],
    },
  ]
}

/**
 * 脚本化的 fetch,三个目的地各自可控:
 *   · `GET {engine}/session/{id}`        → `sessionInfo`(`null` = 这一读失败,走 fail-closed)
 *   · `GET {engine}/session/{id}/message` → `pages`,按 `before=cur-<i>` 取第 i 页,
 *                                           还有更旧的就带 `X-Next-Cursor`(与引擎那条路由同形)
 *   · `POST {web}/api/chat-archive/turns` → `archiveResponses` 依次答复(用尽后循环最后一个)
 * 令牌放在可变的 `tokenRef` 里,好让一条用例跑两趟 idle、中间把过期令牌换成新的。
 */
function harness(options: {
  messages?: unknown[]
  pages?: Array<{ items: unknown[] }>
  sessionInfo?: unknown
  archiveResponses: Array<() => Response>
  token?: string | undefined
  now?: number
  maxAttemptsPerTurn?: number
  messageWindow?: number
  maxMessagePages?: number
  identityEpoch?: () => number
}) {
  const calls: Call[] = []
  const archiveCalls: Call[] = []
  const slept: number[] = []
  const logs: Array<{ level: "info" | "warn"; message: string; meta?: unknown }> = []
  let archiveIndex = 0
  const dir = tempDir()
  const nowRef = { current: options.now ?? 1_000 }
  const cursor = openChatArchiveCursor({
    userDataPath: dir,
    now: () => nowRef.current,
    ...(options.identityEpoch ? { identityEpoch: options.identityEpoch } : {}),
  })
  const tokenRef = { current: "token" in options ? options.token : "archive-bearer" }
  const pagesRef = { current: options.pages ?? [{ items: options.messages ?? engineMessages() }] }

  const fetcher = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url
    calls.push({ url, init })
    if (url.startsWith(ENGINE)) {
      if (!url.includes("/message")) {
        // 会话准入这一读。
        if (options.sessionInfo === null) return new Response("nope", { status: 500 })
        return new Response(JSON.stringify(options.sessionInfo ?? { id: "ses_1", title: "t" }), { status: 200 })
      }
      const before = new URL(url).searchParams.get("before")
      const index = before ? Number(before.replace("cur-", "")) : 0
      const page = pagesRef.current[index]
      if (!page) return new Response("no such page", { status: 404 })
      const headers: Record<string, string> = { "content-type": "application/json" }
      if (index + 1 < pagesRef.current.length) headers["x-next-cursor"] = `cur-${index + 1}`
      return new Response(JSON.stringify(page.items), { status: 200, headers })
    }
    archiveCalls.push({ url, init })
    const next = options.archiveResponses[Math.min(archiveIndex, options.archiveResponses.length - 1)]!
    archiveIndex++
    return next()
  }) as unknown as typeof fetch

  const uploader = createChatArchiveUploader({
    awaitServer: async () => ({ url: ENGINE, username: "opencode", password: "secret" }),
    webBase: () => WEB,
    token: () => tokenRef.current,
    cursor,
    fetch: fetcher,
    sleep: async (ms) => {
      slept.push(ms)
    },
    log: {
      info: (message, meta) => logs.push({ level: "info", message, meta }),
      warn: (message, meta) => logs.push({ level: "warn", message, meta }),
    },
    ...(options.maxAttemptsPerTurn === undefined ? {} : { maxAttemptsPerTurn: options.maxAttemptsPerTurn }),
    ...(options.messageWindow === undefined ? {} : { messageWindow: options.messageWindow }),
    ...(options.maxMessagePages === undefined ? {} : { maxMessagePages: options.maxMessagePages }),
  })

  return { uploader, cursor, calls, archiveCalls, slept, logs, dir, tokenRef, nowRef, pagesRef }
}

const ok = () => new Response(JSON.stringify({ archived: true, messages_written: 2, attachments_written: 0 }), { status: 200 })
const refuse = (status: number, error: string, headers: Record<string, string> = {}) => () =>
  new Response(JSON.stringify({ error }), { status, headers })

describe("REQ-160 #1324 —— 上报面的请求形状", () => {
  test("一轮一次 multipart 请求:`turn` 是**字符串字段**,附件按位置叫 attachment_<i>", async () => {
    const h = harness({ messages: engineMessages({ attachment: true }), archiveResponses: [ok] })
    await h.uploader.onSessionIdle("ses_1")

    expect(h.archiveCalls).toHaveLength(1)
    expect(h.archiveCalls[0]?.url).toBe("https://web.example/api/chat-archive/turns")
    expect(h.archiveCalls[0]?.init?.headers).toEqual({ authorization: "Bearer archive-bearer" })

    const body = h.archiveCalls[0]?.init?.body
    expect(body).toBeInstanceOf(FormData)
    const form = body as FormData
    // 契约 §4:Blob 形态的 `turn` 会被服务端判 `unexpected_part` / `turn_part_missing`,而那是终态。
    expect(typeof form.get("turn")).toBe("string")
    expect(form.get("turn")).not.toBeInstanceOf(Blob)
    expect([...form.keys()].sort()).toEqual(["attachment_0", "turn"])
    expect(form.get("attachment_0")).toBeInstanceOf(Blob)

    const turn = JSON.parse(form.get("turn") as string) as Record<string, unknown>
    expect(turn.engine_session_id).toBe("ses_1")
    expect(turn.attachments).toEqual([
      {
        message_index: 0,
        kind: "image",
        mime: "image/png",
        byte_size: PNG.byteLength,
        content_hash: PNG_SHA256,
        filename: "shot.png",
      },
    ])
    // content-type 必须由 fetch 自己写(带 boundary);我们手写会把 boundary 写丢。
    expect(Object.keys(h.archiveCalls[0]?.init?.headers as Record<string, string>)).not.toContain("content-type")
  })

  test("引擎那一读是 limit 有界的消息列表,带 Basic 凭据", async () => {
    const h = harness({ archiveResponses: [ok] })
    await h.uploader.onSessionIdle("ses_1", "/repo")
    const engineCall = h.calls.find((c) => c.url.includes("/session/ses_1/message"))
    expect(engineCall?.url).toContain("/session/ses_1/message")
    expect(engineCall?.url).toContain("limit=")
    expect(engineCall?.url).toContain("directory=%2Frepo")
    expect((engineCall?.init?.headers as Record<string, string>).authorization).toBe(
      `Basic ${Buffer.from("opencode:secret").toString("base64")}`,
    )
  })

  test("没有 archive_access_token 时一条请求都不发,游标不动", async () => {
    const h = harness({ archiveResponses: [ok], token: undefined })
    await h.uploader.onSessionIdle("ses_1")
    expect(h.calls).toHaveLength(0)
    expect(h.cursor.lastReported("ses_1")).toBeUndefined()
  })
})

describe("REQ-160 #1324 —— 429 不是终态(数据丢失的那条)", () => {
  test("503 → 重试 → 429 → **游标不动** → 重发 → 200 才推进", async () => {
    const h = harness({
      archiveResponses: [
        refuse(503, "archive_unavailable"),
        refuse(429, "rate_limited", { "retry-after": "5" }),
        ok,
      ],
    })
    await h.uploader.onSessionIdle("ses_1")

    // 三次:503 的那次、429 的那次、最后成功的那次。若 429 被当终态,第三次不会发生。
    expect(h.archiveCalls).toHaveLength(3)
    // 429 之后按 Retry-After 退避(5s),不是按普通退避。
    expect(h.slept).toContain(5000)
    expect(h.cursor.lastReported("ses_1")).toBe("msg_0002")
    // 错误码原样记进日志,一码一因。
    const codes = h.logs.map((l) => (l.meta as { code?: string } | undefined)?.code).filter(Boolean)
    expect(codes).toContain("archive_unavailable")
    expect(codes).toContain("rate_limited")
  })

  test("一次 idle 内 429 没退完:游标**停在原地**,下一次 idle 重扫时同一轮还会重发", async () => {
    const h = harness({
      archiveResponses: [refuse(429, "rate_limited", { "retry-after": "1" })],
      maxAttemptsPerTurn: 2,
    })
    await h.uploader.onSessionIdle("ses_1")
    // 先断言游标 —— 这一条就是数据丢失本身:429 之后游标若动了,被推过去的那一轮永远不会再发。
    expect(h.cursor.lastReported("ses_1")).toBeUndefined()
    // 重启后读到的也必须是「没推进」—— 断言落盘的那份,不是内存里的那份。
    expect(openChatArchiveCursor({ userDataPath: h.dir, now: () => 1_000 }).lastReported("ses_1")).toBeUndefined()
    expect(h.archiveCalls).toHaveLength(2)

    const again = await (async () => {
      const second = harness({ archiveResponses: [ok] })
      await second.uploader.onSessionIdle("ses_1")
      return second
    })()
    expect(again.cursor.lastReported("ses_1")).toBe("msg_0002")
  })

  test("5xx 与网络错误同样不推进游标", async () => {
    const h = harness({ archiveResponses: [refuse(503, "archive_unavailable")], maxAttemptsPerTurn: 2 })
    await h.uploader.onSessionIdle("ses_1")
    expect(h.cursor.lastReported("ses_1")).toBeUndefined()

    const boom = harness({
      archiveResponses: [
        () => {
          throw new TypeError("fetch failed")
        },
      ],
      maxAttemptsPerTurn: 2,
    })
    await boom.uploader.onSessionIdle("ses_1")
    expect(boom.cursor.lastReported("ses_1")).toBeUndefined()
  })

  test("429 / 401 以外的 4xx 是终态:推进游标、不重发、把那个码记下来", async () => {
    for (const [status, code] of [
      [400, "invalid_turn"],
      [400, "forbidden_field"],
      [413, "message_too_large"],
      [415, "unsupported_media_type"],
      [404, "not_found"],
    ] as const) {
      const h = harness({ archiveResponses: [refuse(status, code)] })
      await h.uploader.onSessionIdle("ses_1")
      expect(h.archiveCalls).toHaveLength(1)
      expect(h.cursor.lastReported("ses_1")).toBe("msg_0002")
      expect(h.logs.map((l) => (l.meta as { code?: string } | undefined)?.code)).toContain(code)
    }
  })

  test("前一轮没拿到结论时,后一轮不得抢先把游标推过去", async () => {
    const twoTurns = [
      ...engineMessages(),
      {
        info: { id: "msg_0003", role: "user", time: { created: 5_990 }, model: { providerID: "alpha", modelID: "gpt-5" } },
        parts: [{ type: "text", text: "再问一句" }],
      },
      {
        info: {
          id: "msg_0004",
          role: "assistant",
          time: { created: 5_995, completed: 6_000 },
          providerID: "alpha",
          modelID: "gpt-5",
          tokens: { output: 3 },
        },
        parts: [{ type: "text", text: "再答一句" }],
      },
    ]
    const h = harness({
      messages: twoTurns,
      archiveResponses: [refuse(503, "archive_unavailable")],
      maxAttemptsPerTurn: 1,
    })
    await h.uploader.onSessionIdle("ses_1")
    expect(h.archiveCalls).toHaveLength(1) // 第一轮没结论就停,第二轮根本没发
    expect(h.cursor.lastReported("ses_1")).toBeUndefined()
  })
})

describe("REQ-160 #1324 —— 401 也不是终态(R1 BLOCKER)", () => {
  test("令牌在场但已过期 ⇒ 整条积压被逐条 401 ⇒ **一条都不推进游标**,换好令牌后原样重发", async () => {
    // 两轮积压。旧口径(4xx 一律终态)会把两轮都推过去,而服务端一条都没存。
    const twoTurns = [
      ...engineMessages(),
      {
        info: { id: "msg_0003", role: "user", time: { created: 5_990 }, model: { providerID: "alpha", modelID: "gpt-5" } },
        parts: [{ type: "text", text: "再问一句" }],
      },
      {
        info: {
          id: "msg_0004",
          role: "assistant",
          time: { created: 5_995, completed: 6_000 },
          providerID: "alpha",
          modelID: "gpt-5",
          tokens: { output: 3 },
        },
        parts: [{ type: "text", text: "再答一句" }],
      },
    ]
    const h = harness({ messages: twoTurns, archiveResponses: [refuse(401, "unauthorized"), ok] })

    // 第一趟:过期令牌。
    await h.uploader.onSessionIdle("ses_1")
    expect(h.cursor.lastReported("ses_1")).toBeUndefined()
    // 同一把过期钥匙不在本趟内重发 —— 只发了一次,而且第二轮根本没开始。
    expect(h.archiveCalls).toHaveLength(1)
    expect(openChatArchiveCursor({ userDataPath: h.dir, now: () => 1_000 }).lastReported("ses_1")).toBeUndefined()
    expect(h.logs.map((l) => (l.meta as { code?: string } | undefined)?.code)).toContain("unauthorized")

    // 第二趟:续期换好令牌之后的下一次 idle —— 两轮原样重发,一条都没丢。
    h.tokenRef.current = "archive-bearer-fresh"
    await h.uploader.onSessionIdle("ses_1")
    expect(h.archiveCalls).toHaveLength(3)
    expect((h.archiveCalls[1]?.init?.headers as Record<string, string>).authorization).toBe(
      "Bearer archive-bearer-fresh",
    )
    const resent = h.archiveCalls
      .slice(1)
      .map((c) => JSON.parse((c.init!.body as FormData).get("turn") as string) as { messages: Array<{ engine_message_id: string }> })
      .map((t) => t.messages[1]!.engine_message_id)
    expect(resent).toEqual(["msg_0002", "msg_0004"])
    expect(h.cursor.lastReported("ses_1")).toBe("msg_0004")
  })
})

describe("REQ-160 #1324 —— 积压超过一页时不得跳过旧轮次(R1 MAJOR)", () => {
  test("读回条数填满一页且首条仍在范围内 ⇒ 按 X-Next-Cursor 往回翻到游标为止", async () => {
    const older = [
      {
        info: { id: "msg_0001", role: "user", time: { created: 4_990 }, model: { providerID: "alpha", modelID: "gpt-5" } },
        parts: [{ type: "text", text: "旧问" }],
      },
      {
        info: {
          id: "msg_0002",
          role: "assistant",
          time: { created: 4_995, completed: 5_000 },
          providerID: "alpha",
          modelID: "gpt-5",
          tokens: { output: 1 },
        },
        parts: [{ type: "text", text: "旧答" }],
      },
    ]
    const newer = [
      {
        info: { id: "msg_0003", role: "user", time: { created: 5_990 }, model: { providerID: "alpha", modelID: "gpt-5" } },
        parts: [{ type: "text", text: "新问" }],
      },
      {
        info: {
          id: "msg_0004",
          role: "assistant",
          time: { created: 5_995, completed: 6_000 },
          providerID: "alpha",
          modelID: "gpt-5",
          tokens: { output: 2 },
        },
        parts: [{ type: "text", text: "新答" }],
      },
    ]
    // 引擎给的是**最新**那一页;窗口 = 2 条 ⇒ 第一页恰好填满 ⇒ 还有更旧的。
    const h = harness({ pages: [{ items: newer }, { items: older }], archiveResponses: [ok], messageWindow: 2 })
    await h.uploader.onSessionIdle("ses_1")

    // 先断言发出去的是哪两轮 —— 这一条就是缺陷本身:只读最新一页时,窗口外那一轮
    // (msg_0002)一次都不会发,而游标会跳到 msg_0004 把它永久盖过去。**旧的必须在前**。
    const sent = h.archiveCalls
      .map((c) => JSON.parse((c.init!.body as FormData).get("turn") as string) as { messages: Array<{ engine_message_id: string }> })
      .map((t) => t.messages[1]!.engine_message_id)
    expect(sent).toEqual(["msg_0002", "msg_0004"])
    expect(h.cursor.lastReported("ses_1")).toBe("msg_0004")
    // 两页都读了,第二页带着 before= 游标。
    const messageReads = h.calls.filter((c) => c.url.includes("/message"))
    expect(messageReads).toHaveLength(2)
    expect(messageReads[1]?.url).toContain("before=cur-1")
  })

  test("翻到游标那一页就停,不会把整条会话史都拖回来", async () => {
    const h = harness({
      pages: [{ items: engineMessages() }, { items: engineMessages() }],
      archiveResponses: [ok],
      messageWindow: 2,
    })
    h.cursor.advance("ses_1", "msg_0000") // 游标在 msg_0001 之前 ⇒ 第一页首条仍 > 游标 ⇒ 要翻
    await h.uploader.onSessionIdle("ses_1")
    expect(h.calls.filter((c) => c.url.includes("/message"))).toHaveLength(2)

    const h2 = harness({
      pages: [{ items: engineMessages() }, { items: engineMessages() }],
      archiveResponses: [ok],
      messageWindow: 2,
    })
    h2.cursor.advance("ses_1", "msg_0001") // 首条 msg_0001 已 <= 游标 ⇒ 不再往回翻
    await h2.uploader.onSessionIdle("ses_1")
    expect(h2.calls.filter((c) => c.url.includes("/message"))).toHaveLength(1)
  })

  test("翻页有上界,到顶时如实记一行(不静默丢弃)", async () => {
    const h = harness({
      pages: [{ items: engineMessages() }, { items: engineMessages() }, { items: engineMessages() }],
      archiveResponses: [ok],
      messageWindow: 2,
      maxMessagePages: 2,
    })
    await h.uploader.onSessionIdle("ses_1")
    expect(h.calls.filter((c) => c.url.includes("/message"))).toHaveLength(2)
    expect(h.logs.some((l) => l.message.includes("backfill window exhausted"))).toBe(true)
  })
})

describe("REQ-160 #1324 —— 引擎自建的子会话不是用户对话(R1 MAJOR)", () => {
  test("parentID 在场 ⇒ 整会话跳过:一条上报都不发,游标不动", async () => {
    const h = harness({
      sessionInfo: { id: "ses_child", parentID: "ses_parent", title: "写测试 (@general subagent)" },
      archiveResponses: [ok],
    })
    await h.uploader.onSessionIdle("ses_child")
    expect(h.archiveCalls).toHaveLength(0)
    // 连消息都不该去读 —— 咽喉在准入层。
    expect(h.calls.filter((c) => c.url.includes("/message"))).toHaveLength(0)
    expect(h.cursor.lastReported("ses_child")).toBeUndefined()
    expect(h.logs.some((l) => String((l.meta as { reason?: string } | undefined)?.reason).includes("parentID"))).toBe(true)
  })

  test("会话读不出来(形状不认得 / 请求失败)⇒ fail-closed:不上报、游标不动", async () => {
    const failed = harness({ sessionInfo: null, archiveResponses: [ok] })
    await failed.uploader.onSessionIdle("ses_1")
    expect(failed.archiveCalls).toHaveLength(0)
    expect(failed.cursor.lastReported("ses_1")).toBeUndefined()

    const odd = harness({ sessionInfo: ["not", "an", "object"], archiveResponses: [ok] })
    await odd.uploader.onSessionIdle("ses_1")
    expect(odd.archiveCalls).toHaveLength(0)
  })

  test("顶层会话(没有 parentID)照常上报 —— 证明这道准入不是恒拒", async () => {
    const h = harness({ sessionInfo: { id: "ses_1", title: "正常对话" }, archiveResponses: [ok] })
    await h.uploader.onSessionIdle("ses_1")
    expect(h.archiveCalls).toHaveLength(1)
    expect(h.cursor.lastReported("ses_1")).toBe("msg_0002")
  })
})

describe("REQ-160 #1324 —— 游标绑账号(R1 MAJOR)", () => {
  test("A 登出、用户用 BYOK 继续聊、B 登录 ⇒ 那些轮次**不得**用 B 的 bearer 发出去", async () => {
    // 这条路径是真的:A 登出只是把令牌清掉(上报停、游标不动),对话本身照样能继续。
    let epoch = 1 // A 已登录
    const h = harness({ archiveResponses: [ok], identityEpoch: () => epoch, now: 1_000 })

    // ① 前提自证:A 在场时这一轮确实是该上报的 —— 否则底下那句「没上报」分不清是
    //    「账号换了」还是「它本来就不在范围内」。
    await h.uploader.onSessionIdle("ses_1")
    expect(h.archiveCalls).toHaveLength(1)
    expect(h.cursor.lastReported("ses_1")).toBe("msg_0002")

    // ② A 登出之后用户用 BYOK 又聊了一轮(completed=6000),此刻没有令牌、没上报、游标不动。
    h.pagesRef.current = [
      {
        items: [
          ...engineMessages(),
          {
            info: { id: "msg_0003", role: "user", time: { created: 5_990 }, model: { providerID: "x-byok", modelID: "m" } },
            parts: [{ type: "text", text: "登出之后说的话" }],
          },
          {
            info: {
              id: "msg_0004",
              role: "assistant",
              time: { created: 5_995, completed: 6_000 },
              providerID: "x-byok",
              modelID: "m",
              tokens: { output: 2 },
            },
            parts: [{ type: "text", text: "登出之后的回答" }],
          },
        ],
      },
    ]

    // ③ B 在同一台机器登录:epoch 因登出 + 登录各推进一次;时间也往前走了。
    epoch = 3
    h.nowRef.current = 9_000

    await h.uploader.onSessionIdle("ses_1")

    // enabled_at 被重铸成「当下」(9000),于是 completed=6000 那一轮对 B 不在范围内 ⇒ 一条都不发。
    expect(h.cursor.enabledAt()).toBe(9_000)
    expect(h.archiveCalls).toHaveLength(1) // 还是第 ① 步那一次,没有新的
    // 旧账号的会话游标一并丢掉 —— 它是 A 那条线上的坐标。
    expect(h.cursor.lastReported("ses_1")).toBeUndefined()
  })

  test("账号没变时不重铸:同一身份下 enabled_at 稳定,游标照常推进", async () => {
    const h = harness({ archiveResponses: [ok], identityEpoch: () => 7, now: 1_000 })
    await h.uploader.onSessionIdle("ses_1")
    h.nowRef.current = 9_000
    expect(h.cursor.enabledAt()).toBe(1_000)
    expect(h.cursor.lastReported("ses_1")).toBe("msg_0002")
  })
})

describe("REQ-160 #1324 —— 不阻断对话 / 事件接线", () => {
  test("引擎读失败只记一行,不抛给调用方", async () => {
    const calls: Call[] = []
    const dir = tempDir()
    const logs: string[] = []
    const uploader = createChatArchiveUploader({
      awaitServer: async () => ({ url: ENGINE, username: null, password: null }),
      webBase: () => WEB,
      token: () => "archive-bearer",
      cursor: openChatArchiveCursor({ userDataPath: dir, now: () => 1 }),
      fetch: (async (input: string | URL | Request) => {
        const url = String(input)
        calls.push({ url })
        // 会话准入那一读放行(否则先卡在它上面,测不到消息列表这一读的失败路径)。
        if (url.startsWith(`${ENGINE}/session/`) && !url.includes("/message")) {
          return new Response(JSON.stringify({ id: "ses_1", title: "t" }), { status: 200 })
        }
        return new Response("nope", { status: 500 })
      }) as unknown as typeof fetch,
      sleep: async () => {},
      log: { info: (m) => logs.push(m), warn: (m) => logs.push(m) },
    })
    await expect(uploader.onSessionIdle("ses_1")).resolves.toBeUndefined()
    expect(logs.some((m) => m.includes("engine message read failed"))).toBe(true)
  })

  test("/global/event 上的 session.idle 才触发上报;心跳与别的事件不触发", async () => {
    const dir = tempDir()
    const archiveCalls: Call[] = []
    let posted: (() => void) | undefined
    const postedOnce = new Promise<void>((resolve) => {
      posted = resolve
    })
    let stop: (() => void) | undefined
    let eventStreamServed = 0

    const frames = [
      `data: ${JSON.stringify({ payload: { id: "e1", type: "server.connected", properties: {} } })}`,
      `data: ${JSON.stringify({ payload: { id: "e2", type: "server.heartbeat", properties: {} } })}`,
      `data: ${JSON.stringify({ directory: "/repo", payload: { type: "session.idle", properties: { sessionID: "ses_1" } } })}`,
    ].join("\n\n")

    const uploader = createChatArchiveUploader({
      awaitServer: async () => ({ url: ENGINE, username: "opencode", password: "secret" }),
      webBase: () => WEB,
      token: () => "archive-bearer",
      cursor: openChatArchiveCursor({ userDataPath: dir, now: () => 1_000 }),
      fetch: (async (input: string | URL | Request, init?: RequestInit) => {
        const url = String(input instanceof Request ? input.url : input)
        if (url.includes("/global/event")) {
          eventStreamServed++
          if (eventStreamServed > 1) {
            stop?.()
            return new Response(new ReadableStream<Uint8Array>({ start: (c) => c.close() }))
          }
          return new Response(
            new ReadableStream<Uint8Array>({
              start: (c) => {
                c.enqueue(new TextEncoder().encode(`${frames}\n\n`))
                c.close()
              },
            }),
          )
        }
        if (url.startsWith(`${ENGINE}/session/`) && !url.includes("/message")) {
          return new Response(JSON.stringify({ id: "ses_1", title: "t" }), { status: 200 })
        }
        if (url.startsWith(`${ENGINE}/session/`)) {
          return new Response(JSON.stringify(engineMessages()), { status: 200 })
        }
        archiveCalls.push({ url, init })
        posted?.()
        return ok()
      }) as unknown as typeof fetch,
      sleep: async () => {},
      log: { info: () => {}, warn: () => {} },
    })

    stop = uploader.start()
    await postedOnce
    stop()
    expect(archiveCalls).toHaveLength(1)
    const turn = JSON.parse((archiveCalls[0]!.init!.body as FormData).get("turn") as string) as { engine_session_id: string }
    expect(turn.engine_session_id).toBe("ses_1")
  })
})
