// REQ-160 AC2(`#1353`)—— 词表同步器的判据。
//
// 这里守的是**「没问出来」与「问过了,是空表」不能混为一谈**:前者要留着上次那份(或者干脆
// 不拦),后者是一个结论。两者在代码里只差一个 `?? []`,而混淆之后没有任何东西会红 ——
// 本机这一层会静默关掉,用户什么都看不出来,服务端照样留证。

import { describe, expect, test } from "bun:test"
import { createModerationKeywordStore, type ModerationKeywordDeps } from "./moderation-keywords"

type Call = { url: string; headers: Record<string, string> }

function jsonResponse(body: unknown, init: { status?: number; etag?: string } = {}) {
  const headers = new Headers({ "content-type": "application/json" })
  if (init.etag) headers.set("etag", init.etag)
  return new Response(JSON.stringify(body), { status: init.status ?? 200, headers })
}

function harness(
  responses: Array<() => Response | Promise<Response>>,
  overrides: Partial<ModerationKeywordDeps> = {},
) {
  const calls: Call[] = []
  let index = 0
  const store = createModerationKeywordStore({
    webBase: () => "https://web.example/",
    token: () => "tok-1",
    fetch: (async (url: string, init?: RequestInit) => {
      calls.push({
        url: String(url),
        headers: Object.fromEntries(new Headers(init?.headers as HeadersInit).entries()),
      })
      const next = responses[Math.min(index, responses.length - 1)]
      index += 1
      if (!next) throw new Error("no response scripted")
      return next()
    }) as unknown as typeof fetch,
    ...overrides,
  })
  return { store, calls }
}

const oneWord = { keywords: [{ category_code: "contact_wechat", keyword: "微信" }] }

describe("moderation keyword sync", () => {
  test("200:存下表与 ETag,发送前用的是共享匹配器的语义", async () => {
    const { store, calls } = harness([() => jsonResponse(oneWord, { etag: '"v1"' })])
    expect(await store.refresh()).toBe("updated")
    expect(calls[0]!.url).toBe("https://web.example/api/chat-archive/keywords")
    expect(calls[0]!.headers.authorization).toBe("Bearer tok-1")
    expect(store.snapshot()).toEqual([{ categoryCode: "contact_wechat", keyword: "微信" }])
    // 子串 + 大小写折叠的语义由 shared/moderation-keywords 的语料夹具守;这里只证明接上了。
    expect(store.blocks("能加个微信吗")).toBe(true)
    expect(store.blocks("今天天气不错")).toBe(false)
  })

  test("手里没有表时不发 If-None-Match —— 发了就可能永远拿不到表", async () => {
    const { store, calls } = harness([() => new Response(null, { status: 304 })])
    expect(await store.refresh()).toBe("unavailable")
    expect("if-none-match" in calls[0]!.headers).toBe(false)
    expect(store.snapshot()).toBeUndefined()
  })

  test("有表之后带 If-None-Match;304 保留现表", async () => {
    const { store, calls } = harness([
      () => jsonResponse(oneWord, { etag: '"v1"' }),
      () => new Response(null, { status: 304, headers: { etag: '"v1"' } }),
    ])
    await store.refresh()
    expect(await store.refresh()).toBe("unchanged")
    expect(calls[1]!.headers["if-none-match"]).toBe('"v1"')
    expect(store.blocks("加微信")).toBe(true)
  })

  test("503 是服务不可用,不是「表空了」—— 手里那份留着,照样拦", async () => {
    const { store } = harness([
      () => jsonResponse(oneWord, { etag: '"v1"' }),
      () => jsonResponse({ error: "keywords_unavailable" }, { status: 503 }),
    ])
    await store.refresh()
    expect(await store.refresh()).toBe("unavailable")
    expect(store.snapshot()).toHaveLength(1)
    expect(store.blocks("加微信")).toBe(true)
  })

  test("网络错与超时同样留表", async () => {
    const { store } = harness([
      () => jsonResponse(oneWord, { etag: '"v1"' }),
      () => {
        throw new Error("ECONNRESET")
      },
    ])
    await store.refresh()
    expect(await store.refresh()).toBe("unavailable")
    expect(store.blocks("加微信")).toBe(true)
  })

  test("响应形状不合不是空表:留着上次那份,不静默关掉本机这一层", async () => {
    const { store } = harness([
      () => jsonResponse(oneWord, { etag: '"v1"' }),
      () => jsonResponse({ keywords: "nope" }),
    ])
    await store.refresh()
    expect(await store.refresh()).toBe("unavailable")
    expect(store.blocks("加微信")).toBe(true)
  })

  test("401:换人或登出了 —— 丢表,此后不拦(线契约把它与 5xx 分开)", async () => {
    const { store } = harness([
      () => jsonResponse(oneWord, { etag: '"v1"' }),
      () => jsonResponse({ error: "unauthorized" }, { status: 401 }),
    ])
    await store.refresh()
    expect(await store.refresh()).toBe("unavailable")
    expect(store.snapshot()).toBeUndefined()
    expect(store.blocks("加微信")).toBe(false)
  })

  test("token 缺席:一次请求都不发,且不继续拿着上一位登录者的表", async () => {
    let token: string | undefined = "tok-1"
    const { store, calls } = harness([() => jsonResponse(oneWord, { etag: '"v1"' })], { token: () => token })
    await store.refresh()
    expect(store.blocks("加微信")).toBe(true)
    token = undefined
    expect(await store.refresh()).toBe("unavailable")
    expect(calls).toHaveLength(1)
    expect(store.blocks("加微信")).toBe(false)
  })

  test("空表是一个结论:问到了、没有启用词 ⇒ 什么都不拦", async () => {
    const { store } = harness([() => jsonResponse({ keywords: [] }, { etag: '"v0"' })])
    expect(await store.refresh()).toBe("updated")
    expect(store.snapshot()).toEqual([])
    expect(store.blocks("加微信")).toBe(false)
  })

  test("并发 refresh 合成一次请求", async () => {
    const { store, calls } = harness([() => jsonResponse(oneWord, { etag: '"v1"' })])
    const [a, b] = await Promise.all([store.refresh(), store.refresh()])
    expect([a, b]).toEqual(["updated", "updated"])
    expect(calls).toHaveLength(1)
  })

  test("start() 立刻同步一次,stop() 之后不再有新的同步", async () => {
    const { store, calls } = harness([() => jsonResponse(oneWord, { etag: '"v1"' })])
    const stop = store.start()
    await new Promise((resolve) => setTimeout(resolve, 5))
    expect(calls).toHaveLength(1)
    expect(store.blocks("加微信")).toBe(true)
    stop()
  })
})

describe("moderation keyword fail-open", () => {
  test("从来没同步过 ⇒ 不拦(已批设计 §3「不出现」:没做过的检查不摆出做过的样子)", () => {
    const { store } = harness([() => jsonResponse(oneWord)])
    expect(store.snapshot()).toBeUndefined()
    expect(store.blocks("加微信")).toBe(false)
  })
})
