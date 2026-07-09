// REQ-074: the connectivity probe must hit the SAME URL the runtime SDK will hit, or a passing
// test stops predicting a working session (the zhipuai regression: probe joined /v1/messages while
// "@ai-sdk/anthropic" joins /messages onto a baseURL that itself carries /v1). Convention locked
// here: baseURL includes /v1; probe appends /messages (anthropic) or /chat/completions (openai).

import { afterEach, describe, expect, test } from "bun:test"
import { testProvider } from "./provider-test"

const realFetch = globalThis.fetch

function stubFetch(status = 200) {
  const calls: { url: string; headers: Record<string, string> }[] = []
  globalThis.fetch = (async (url: any, init: any) => {
    calls.push({ url: String(url), headers: init?.headers ?? {} })
    return new Response(status === 200 ? "{}" : "err", { status })
  }) as typeof fetch
  return calls
}

afterEach(() => {
  globalThis.fetch = realFetch
})

describe("provider probe URL joining matches the runtime SDKs", () => {
  test("anthropic compat appends /messages (baseURL already carries /v1)", async () => {
    const calls = stubFetch()
    const r = await testProvider({
      compat: "anthropic",
      baseURL: "https://open.bigmodel.cn/api/anthropic/v1",
      apiKey: "sk-x",
      model: "glm-5.2",
    })
    expect(r.ok).toBe(true)
    expect(calls[0].url).toBe("https://open.bigmodel.cn/api/anthropic/v1/messages")
    expect(calls[0].headers["x-api-key"]).toBe("sk-x")
    expect(calls[0].headers["anthropic-version"]).toBeDefined()
  })

  test("openai compat appends /chat/completions", async () => {
    const calls = stubFetch()
    const r = await testProvider({
      compat: "openai",
      baseURL: "https://api.deepseek.com/v1",
      apiKey: "sk-y",
      model: "deepseek-v4-flash",
    })
    expect(r.ok).toBe(true)
    expect(calls[0].url).toBe("https://api.deepseek.com/v1/chat/completions")
    expect(calls[0].headers["authorization"]).toBe("Bearer sk-y")
  })

  test("trailing slashes on baseURL are normalized before joining", async () => {
    const calls = stubFetch()
    await testProvider({ compat: "anthropic", baseURL: "https://x.example/v1/", apiKey: "k", model: "m" })
    expect(calls[0].url).toBe("https://x.example/v1/messages")
  })

  test("a non-2xx answer surfaces status + body snippet (no silent success)", async () => {
    stubFetch(401)
    const r = await testProvider({ compat: "openai", baseURL: "https://x.example/v1", apiKey: "k", model: "m" })
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.reason).toContain("401")
  })
})
