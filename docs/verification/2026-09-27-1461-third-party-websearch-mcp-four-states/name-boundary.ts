#!/usr/bin/env bun
// alpha-code#1461 —— 离线:生产分类器 `isWebSearchToolId` 对若干工具 id 形状的判决。
// 这不是取证的主体(主体是真引擎 + 真插件的四格),它只回答一件事:本轮要构造的正向臂与反向臂
// 的名字,**在跑任何模型调用之前**就被生产函数判在两边 —— 否则反向臂「没被拦」可能只是名字碰巧。
import { isWebSearchToolId, mcpEngineToolId, webSearchToolDenial, computeMcpOwnership } from "./src/cloud-websearch-kill"

const KILL = { ALPHA_LOCAL_WEBSEARCH_DENY: "1", ALPHA_CLOUD_WEBSEARCH_DENY: "1" }
const OPEN: Record<string, string> = {}
// 用户在配置里给 server 起的键 × vendor 给工具起的名 —— 引擎 id = sanitize(server) + "_" + sanitize(tool)
const shapes: { server: string; tool: string; note: string }[] = [
  { server: "exa", tool: "web_search_exa", note: "Exa 远端 MCP 今天真 advertise 的名字(本轮 tools/list 实读),ADR-046 D6 的字面例子" },
  { server: "exa", tool: "web_fetch_exa", note: "Exa 的另一个工具(抓取,不是搜索)—— 应当不命中" },
  { server: "duck", tool: "web_search", note: "本轮正向臂:自建 stdio 插件,工具名 web_search" },
  { server: "duck", tool: "search", note: "本轮反向臂:同一自建插件,工具名 search(最常见的搜索工具名)" },
  { server: "ddg", tool: "search", note: "同一个工具,用户把 server 键起成 ddg —— 词表里有 ddg" },
  { server: "duckduckgo", tool: "search", note: "同一个工具,server 键 duckduckgo —— 词表里有 duckduckgo" },
  { server: "google", tool: "search", note: "server 键 google —— google 刻意不在词表(AC4 防误杀 gdrive_search)" },
  { server: "g", tool: "google_search", note: "工具名 google_search" },
  { server: "b", tool: "bing_search", note: "工具名 bing_search" },
  { server: "s", tool: "search_the_internet", note: "search 与 internet 不相邻" },
  { server: "s", tool: "internet_search", note: "search 与 internet 相邻" },
  { server: "t", tool: "tavily_search", note: "search 与 tavily 相邻" },
  { server: "p", tool: "perplexity_ask", note: "无 search 词" },
  { server: "s", tool: "query", note: "无 search 词" },
  { server: "s", tool: "lookup", note: "无 search 词" },
  { server: "s", tool: "研究", note: "非 ASCII 名,sanitize 后只剩下划线(D6 已登记的漏洞)" },
]
const ownership = computeMcpOwnership({ mcp: Object.fromEntries(shapes.map((s) => [s.server, { type: "local", command: ["x"] }])) }, OPEN)
const rows = shapes.map((s) => {
  const id = mcpEngineToolId(s.server, s.tool)
  return {
    server: s.server,
    tool: s.tool,
    engineToolId: id,
    isWebSearchToolId: isWebSearchToolId(id),
    denialUnderKillSwitch: webSearchToolDenial(id, KILL, ownership) ?? null,
    denialWhenOpen: webSearchToolDenial(id, OPEN, ownership) ?? null,
    note: s.note,
  }
})
const out = { ticket: "alpha-code#1461", at: new Date().toISOString(), classifier: "packages/ext/src/cloud-websearch-kill.ts isWebSearchToolId / webSearchToolDenial (production, imported)", rows }
console.log(JSON.stringify(out, null, 2))
