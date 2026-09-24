#!/usr/bin/env node
// alpha-code#1445 —— Exa MCP 响应形状的实读探针。
//
//   node docs/verification/2026-09-24-1445-exa-mcp-response-shapes/probe-exa-shapes.mjs > results/arms.json
//
// 问题只有一个:**「这是一段错误提示」有没有结构化信号可消费?**
// 探的是 `https://mcp.exa.ai/mcp` 本体,请求体与 `packages/opencode/src/tool/mcp-websearch.ts`
// 的 `call()` 逐字同形(同 method / 同 tool 名 / 同 accept 头 / 同参数形状),所以这里量到的
// 就是生产那条路上会拿到的东西。不经任何包装器 —— 包装器正是被测对象。
//
// 四条臂:
//   list        tools/list —— 有没有 outputSchema(有 ⇒ structuredContent 可当成功判据)
//   ok          正常搜索 —— 成功长什么样
//   inband-err  带一个无效 key ⇒ Exa 自己的 in-band 错误结果
//   nokey       不带 key ⇒ 免费额度那条路(额度未尽=正常结果,已尽=429)
//
// ⚠️ 免费额度是**按出网 IP** 计的,跑满会让本机 12 小时内的无 key 搜索全部 429
//    (实测 `retry-after: 44333`)。别为了「再看一眼」重复整跑。
const BASE = "https://mcp.exa.ai/mcp"
const PROD_ACCEPT = "application/json, text/event-stream"

// 与 tool/mcp-websearch.ts 的 SearchArgs 逐字同形。
const SEARCH_ARGS = {
  query: "probe-1445 Array.prototype.flat MDN documentation",
  type: "auto",
  numResults: 2,
  livecrawl: "fallback",
  contextMaxCharacters: 500,
}

async function post(label, url, headers, body) {
  const started = Date.now()
  const res = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json", accept: PROD_ACCEPT, ...headers },
    body: JSON.stringify(body),
  })
  const text = await res.text()
  const frame = text.split("\n").find((l) => l.startsWith("data: "))
  let envelope = null
  try {
    envelope = JSON.parse(frame ? frame.slice(6) : text)
  } catch {}
  const result = envelope?.result
  return {
    arm: label,
    ms: Date.now() - started,
    status: res.status,
    contentType: res.headers.get("content-type"),
    rateLimitHeaders: {
      "retry-after": res.headers.get("retry-after"),
      "x-ratelimit-limit": res.headers.get("x-ratelimit-limit"),
      "x-ratelimit-remaining": res.headers.get("x-ratelimit-remaining"),
      "x-ratelimit-reset": res.headers.get("x-ratelimit-reset"),
    },
    jsonrpc: envelope ? (envelope.error ? "error" : envelope.result ? "result" : "other") : "unparsed",
    jsonrpcErrorCode: envelope?.error?.code ?? null,
    // ── 判据字段:生产的 parseResponse 只看这几样 ──────────────────────────────
    isError: result?.isError ?? null,
    structuredContent: result?.structuredContent === undefined ? null : "present",
    resultMeta: result?._meta ?? null,
    contentBlocks: (result?.content ?? []).map((c) => ({
      keys: Object.keys(c),
      type: c.type,
      textLength: c.text?.length ?? 0,
      meta: c._meta ?? null,
    })),
    textHead: (result?.content?.[0]?.text ?? envelope?.error?.message ?? text).slice(0, 260),
  }
}

const call = (name, args) => ({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } })
const rows = []
const gap = () => new Promise((s) => setTimeout(s, 1200))

// ① tools/list —— 每个 tool 有没有 outputSchema(有 ⇒ structuredContent 可当成功判据)
{
  const res = await fetch(BASE, {
    method: "POST",
    headers: { "content-type": "application/json", accept: PROD_ACCEPT },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list", params: {} }),
  })
  const text = await res.text()
  const frame = text.split("\n").find((l) => l.startsWith("data: "))
  let tools = []
  try {
    tools = JSON.parse(frame ? frame.slice(6) : text)?.result?.tools ?? []
  } catch {}
  rows.push({
    arm: "list-outputSchema",
    status: res.status,
    tools: tools.map((t) => ({ name: t.name, hasOutputSchema: Object.hasOwn(t, "outputSchema") })),
  })
  await gap()
}
// ② 正常结果 / 免费额度那条路(同一条命令,额度未尽 ⇒ ok,已尽 ⇒ 429)
rows.push(await post("nokey-search", BASE, {}, call("web_search_exa", SEARCH_ARGS)))
await gap()
// ③ Exa 自己的 in-band 错误(无效 key 走的是鉴权面,不消耗免费额度)
const BADKEY = { authorization: "Bearer not-a-real-key-1445" }
rows.push(await post("inband-invalid-key", BASE, BADKEY, call("web_search_exa", SEARCH_ARGS)))
await gap()
rows.push(await post("inband-unknown-tool", BASE, BADKEY, call("no_such_tool_1445", {})))
await gap()
rows.push(await post("inband-invalid-args", BASE, BADKEY, call("web_search_exa", {})))

console.log(JSON.stringify({ ticket: "alpha-code#1445", endpoint: BASE, at: new Date().toISOString(), node: process.version, rows }, null, 2))
