// alpha-code#1445 (2026-09-26) —— 今天 nokey 打 Exa 本体一次、Parallel 一次,保存**完整原始响应**(状态/头/body)。
// 请求与 packages/opencode/src/tool/mcp-websearch.ts 的 call() 同形;参数与 #1433 的探针逐字相同。
const PROD_ACCEPT = "application/json, text/event-stream"
async function post(label, url, headers, body) {
  const started = Date.now()
  const res = await fetch(url, { method: "POST", headers: { "content-type": "application/json", accept: PROD_ACCEPT, ...headers }, body: JSON.stringify(body) })
  const text = await res.text()
  return { arm: label, at: new Date().toISOString(), ms: Date.now() - started, status: res.status, headers: Object.fromEntries(res.headers.entries()), bodyLength: text.length, body: text }
}
const call = (name, args) => ({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } })
const q = "probe-1445 r1 Array.prototype.flat MDN documentation"
const rows = []
rows.push(await post("exa-nokey-search", "https://mcp.exa.ai/mcp", {}, call("web_search_exa", { query: q, type: "auto", numResults: 3, livecrawl: "fallback", contextMaxCharacters: 2000 })))
await new Promise((s) => setTimeout(s, 1200))
rows.push(await post("parallel-keyless-search", "https://search.parallel.ai/mcp", { "User-Agent": "opencode/probe-1445" }, call("web_search", { objective: q, search_queries: [q], session_id: "probe1445-live-1", model_name: "probe-1445" })))
console.log(JSON.stringify({ ticket: "alpha-code#1445", at: new Date().toISOString(), node: process.version, rows }, null, 2))
