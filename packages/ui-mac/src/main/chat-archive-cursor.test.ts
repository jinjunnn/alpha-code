// REQ-160 `#1324` —— 游标文件与响应归类的判据。
//
// 归类那组的期望值逐条写死成字面量(不从被测模块 import),因为它就是线契约
// (alpha-web `docs/contracts/chat-archive-upload.md` §Responses)那张表的转写。
// **端到端那条**(503 → 重试 → 429 → 游标不动)在 chat-archive-uploader.test.ts:
// 只断言这里的纯函数会漏掉分流层 —— 本仓已实测过「断言内层纯函数 ⇒ 落在分流层的绕过照样绿」。

import { afterEach, describe, expect, test } from "bun:test"
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { classifyArchiveResponse, openChatArchiveCursor, retryAfterMs } from "./chat-archive-cursor"

const dirs: string[] = []
function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "chat-archive-cursor-"))
  dirs.push(dir)
  return dir
}
afterEach(() => {
  while (dirs.length) rmSync(dirs.pop()!, { recursive: true, force: true })
})

const headers = (value?: string) => new Headers(value === undefined ? {} : { "retry-after": value })

describe("REQ-160 #1324 —— 响应归类:429 不是终态", () => {
  test("2xx 推进游标", () => {
    expect(classifyArchiveResponse(200, headers())).toEqual({ kind: "advance", outcome: "stored" })
  })

  test("429 / 401 以外的 4xx 是终态:推进游标、不重发", () => {
    for (const status of [400, 411, 413, 415, 404, 422]) {
      expect(classifyArchiveResponse(status, headers())).toEqual({ kind: "advance", outcome: "terminal" })
    }
  })

  test("401 也不是终态(R1 BLOCKER):令牌过期的原因不在这一轮里 —— 游标不动", () => {
    // 与线契约表「401 → terminal」那一行**有意**相左(编排器 2026-09-18 裁决:游标是纯客户端状态)。
    expect(classifyArchiveResponse(401, headers())).toEqual({ kind: "retry", outcome: "unauthorized" })
    // 不给退避时长:同一把过期钥匙在本趟内重发没有意义,处置是「立刻停下这一趟」。
    expect(classifyArchiveResponse(401, headers()).backoffMs).toBeUndefined()
  })

  test("429 退避重发,**不**推进游标,退避按 Retry-After", () => {
    expect(classifyArchiveResponse(429, headers("7"))).toEqual({
      kind: "retry",
      outcome: "rate-limited",
      backoffMs: 7000,
    })
    // 没给 Retry-After 也不能当终态。
    expect(classifyArchiveResponse(429, headers()).kind).toBe("retry")
  })

  test("5xx 与任何契约没列的状态都按可重试处理 —— 推进游标是不可逆的丢弃", () => {
    for (const status of [500, 502, 503, 504, 100, 302]) {
      expect(classifyArchiveResponse(status, headers()).kind).toBe("retry")
    }
  })

  test("Retry-After 解析:缺席/非法 → 默认 60s;超上限截到 300s;下限 1s", () => {
    expect(retryAfterMs(null)).toBe(60_000)
    expect(retryAfterMs("not-a-number")).toBe(60_000)
    expect(retryAfterMs("-5")).toBe(60_000)
    expect(retryAfterMs("0")).toBe(1000)
    expect(retryAfterMs("12")).toBe(12_000)
    expect(retryAfterMs("99999")).toBe(300_000)
  })
})

describe("REQ-160 #1324 —— 游标文件", () => {
  test("首次打开即把 enabled_at 落盘:进程重启不会把「当下」往后挪", () => {
    const dir = tempDir()
    const first = openChatArchiveCursor({ userDataPath: dir, now: () => 1_000 })
    expect(first.enabledAt()).toBe(1_000)
    const onDisk = JSON.parse(readFileSync(join(dir, "chat-archive-cursor.json"), "utf8")) as Record<string, unknown>
    expect(onDisk).toEqual({ schema_version: 1, enabled_at: 1_000, sessions: {} })

    const second = openChatArchiveCursor({ userDataPath: dir, now: () => 9_999 })
    expect(second.enabledAt()).toBe(1_000)
  })

  test("advance 落盘,重开读得回来,且只向前走", () => {
    const dir = tempDir()
    const cursor = openChatArchiveCursor({ userDataPath: dir, now: () => 1 })
    expect(cursor.lastReported("ses_1")).toBeUndefined()
    cursor.advance("ses_1", "msg_0002")
    cursor.advance("ses_2", "msg_0100")
    cursor.advance("ses_1", "msg_0001") // 回退:忽略
    expect(cursor.lastReported("ses_1")).toBe("msg_0002")

    const reopened = openChatArchiveCursor({ userDataPath: dir, now: () => 2 })
    expect(reopened.lastReported("ses_1")).toBe("msg_0002")
    expect(reopened.lastReported("ses_2")).toBe("msg_0100")
  })

  test("文件坏了/形状不认得 ⇒ 当「现在启用」重铸,而不是当空游标去回填全部历史", () => {
    const dir = tempDir()
    writeFileSync(join(dir, "chat-archive-cursor.json"), "{not json", "utf8")
    expect(openChatArchiveCursor({ userDataPath: dir, now: () => 4_242 }).enabledAt()).toBe(4_242)

    writeFileSync(join(dir, "chat-archive-cursor.json"), JSON.stringify({ schema_version: 2, enabled_at: 1 }), "utf8")
    const next = openChatArchiveCursor({ userDataPath: dir, now: () => 5_555 })
    expect(next.enabledAt()).toBe(5_555)
    expect(next.snapshot().sessions).toEqual({})
  })

  test("同一进程内换账号:重铸 enabled_at、丢掉旧账号的会话游标,并把新 tag 落盘(R1 MAJOR)", () => {
    const dir = tempDir()
    let tag: string | undefined = "acct-A"
    let now = 1_000
    const cursor = openChatArchiveCursor({ userDataPath: dir, now: () => now, identityTag: () => tag })
    cursor.advance("ses_1", "msg_0002")
    expect(cursor.enabledAt()).toBe(1_000)

    tag = "acct-B"
    now = 9_000
    expect(cursor.enabledAt()).toBe(9_000)
    expect(cursor.lastReported("ses_1")).toBeUndefined()
    // 落盘的那份带着新 tag —— 下一次冷启动才比得出来。
    const onDisk = JSON.parse(readFileSync(join(dir, "chat-archive-cursor.json"), "utf8")) as Record<string, unknown>
    expect(onDisk).toEqual({ schema_version: 1, enabled_at: 9_000, sessions: {}, identity_tag: "acct-B" })
  })

  test("**跨重启**也认得出换账号:开文件时就比盘上那个 tag(R2 MAJOR)", () => {
    // 这是 R1 那版漏掉的整类窗口:B 登录之后这个进程里一次可归档 idle 都没发生过,
    // 应用就退出/自动更新/崩溃了 —— 进程内计数器什么都没记下,盘上那份仍属于 A。
    const dir = tempDir()
    writeFileSync(
      join(dir, "chat-archive-cursor.json"),
      JSON.stringify({ schema_version: 1, enabled_at: 1_000, sessions: { ses_1: "msg_0002" }, identity_tag: "acct-A" }),
      "utf8",
    )
    const asB = openChatArchiveCursor({ userDataPath: dir, now: () => 9_000, identityTag: () => "acct-B" })
    expect(asB.enabledAt()).toBe(9_000)
    expect(asB.lastReported("ses_1")).toBeUndefined()

    // 同一个账号回来则原样接手(否则每次冷启动都把本账号的积压丢一次)。
    const againAsB = openChatArchiveCursor({ userDataPath: dir, now: () => 20_000, identityTag: () => "acct-B" })
    expect(againAsB.enabledAt()).toBe(9_000)
  })

  test("登出(tag 为 undefined)不是换账号:不重铸,也不抹掉已记的 tag", () => {
    // 重铸会把本账号**还没上报的积压**静默丢掉,而那正是上报面故障期最需要它活着的时刻。
    const dir = tempDir()
    let tag: string | undefined = "acct-A"
    let now = 1_000
    const cursor = openChatArchiveCursor({ userDataPath: dir, now: () => now, identityTag: () => tag })
    cursor.advance("ses_1", "msg_0002")

    tag = undefined // 登出
    now = 9_000
    expect(cursor.enabledAt()).toBe(1_000)
    expect(cursor.lastReported("ses_1")).toBe("msg_0002")

    // 登出期间重启,仍然不重铸;A 回来时也不该被当成换号。
    const restartedLoggedOut = openChatArchiveCursor({ userDataPath: dir, now: () => 9_000, identityTag: () => undefined })
    expect(restartedLoggedOut.enabledAt()).toBe(1_000)
    const backAsA = openChatArchiveCursor({ userDataPath: dir, now: () => 9_000, identityTag: () => "acct-A" })
    expect(backAsA.enabledAt()).toBe(1_000)
    expect(backAsA.lastReported("ses_1")).toBe("msg_0002")
  })

  test("落盘失败不抛给调用方(上报是旁路,不阻断对话)", () => {
    // 不可写的 userData:把一个**普通文件**当作目录的父级 —— mkdirSync 必 ENOTDIR。
    // 刻意不拿字面 NUL 构造坏路径:那会让整个文件对默认 grep 隐身(`#760`,alpha-check 第 [3/14] 步会红)。
    const root = tempDir()
    writeFileSync(join(root, "not-a-dir"), "x", "utf8")
    const errors: unknown[] = []
    const cursor = openChatArchiveCursor({
      userDataPath: join(root, "not-a-dir", "nested"),
      now: () => 1,
      onWriteError: (error) => errors.push(error),
    })
    expect(() => cursor.advance("ses_1", "msg_1")).not.toThrow()
    expect(errors.length).toBeGreaterThan(0)
  })
})
