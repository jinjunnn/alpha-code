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
      info: { id: "msg_0001", role: "user", time: { created: 10 }, model: { providerID: "alpha", modelID: "gpt-5" } },
      parts: userParts,
    },
    {
      info: {
        id: "msg_0002",
        role: "assistant",
        time: { created: 11, completed: 5_000 },
        providerID: "alpha",
        modelID: "gpt-5",
        finish: "stop",
        tokens: { output: 7 },
      },
      parts: [{ type: "text", text: "你也好" }],
    },
  ]
}

/** 脚本化的 fetch:engine 的消息列表恒定,上报面按 `archiveResponses` 依次答复(用尽后循环最后一个)。 */
function harness(options: {
  messages?: unknown[]
  archiveResponses: Array<() => Response>
  token?: string | undefined
  now?: number
  maxAttemptsPerTurn?: number
}) {
  const calls: Call[] = []
  const archiveCalls: Call[] = []
  const slept: number[] = []
  const logs: Array<{ level: "info" | "warn"; message: string; meta?: unknown }> = []
  let archiveIndex = 0
  const dir = tempDir()
  const cursor = openChatArchiveCursor({ userDataPath: dir, now: () => options.now ?? 1_000 })

  const fetcher = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url
    calls.push({ url, init })
    if (url.startsWith(ENGINE)) {
      return new Response(JSON.stringify(options.messages ?? engineMessages()), {
        status: 200,
        headers: { "content-type": "application/json" },
      })
    }
    archiveCalls.push({ url, init })
    const next = options.archiveResponses[Math.min(archiveIndex, options.archiveResponses.length - 1)]!
    archiveIndex++
    return next()
  }) as unknown as typeof fetch

  const uploader = createChatArchiveUploader({
    awaitServer: async () => ({ url: ENGINE, username: "opencode", password: "secret" }),
    webBase: () => WEB,
    token: () => ("token" in options ? options.token : "archive-bearer"),
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
  })

  return { uploader, cursor, calls, archiveCalls, slept, logs, dir }
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
    const engineCall = h.calls.find((c) => c.url.startsWith(ENGINE))
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

  test("429 以外的 4xx 是终态:推进游标、不重发、把那个码记下来", async () => {
    for (const [status, code] of [
      [400, "invalid_turn"],
      [400, "forbidden_field"],
      [413, "message_too_large"],
      [415, "unsupported_media_type"],
      [401, "unauthorized"],
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
        info: { id: "msg_0003", role: "user", time: { created: 20 }, model: { providerID: "alpha", modelID: "gpt-5" } },
        parts: [{ type: "text", text: "再问一句" }],
      },
      {
        info: {
          id: "msg_0004",
          role: "assistant",
          time: { created: 21, completed: 6_000 },
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
        calls.push({ url: String(input) })
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
