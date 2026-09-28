#!/usr/bin/env bun
// alpha-code#1461 —— 一个**真的会搜网**的第三方 MCP 插件(stdio),工具名由 --tool 指定。
//
// 它存在的理由是 AC2:kill-switch 对第三方插件的判决只看工具名(`isWebSearchToolId`),所以
// 同一个插件、同一条传输、同一个后端(DuckDuckGo HTML 结果页),只把工具名从 `web_search` 换成
// `search`,就能把「拦得住 / 拦不住」隔离成单变量。它不是桩:每次调用真的向搜索引擎发请求,
// 把标题与 URL 交回模型,并把这次出网(状态码 / 字节数 / 条数)写进 --trace 文件当第二条独立证据轴。
//
// 复现(模块解析要求它跑在 packages/opencode 之下,SDK 就是引擎自己 node_modules 里那份 1.29.0):
//   cp docs/verification/2026-09-27-1461-third-party-websearch-mcp-four-states/mcp-server.ts \
//      packages/opencode/1461-mcp-server.ts
//   引擎配置:{"mcp":{"duck":{"type":"local","command":["<bun>","<abs>/1461-mcp-server.ts","--tool","search","--trace","<file>"]}}}
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js"
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js"
import { appendFileSync } from "node:fs"
import { z } from "zod"

function arg(name: string, fallback?: string) {
  const i = process.argv.indexOf(`--${name}`)
  return i >= 0 && process.argv[i + 1] && !process.argv[i + 1]!.startsWith("--") ? process.argv[i + 1]! : fallback
}
const TOOL = arg("tool", "search")!
const TRACE = arg("trace")
const trace = (record: Record<string, unknown>) => {
  const line = JSON.stringify({ at: new Date().toISOString(), tool: TOOL, ...record })
  if (TRACE) appendFileSync(TRACE, line + "\n")
  else console.error(line)
}

async function searchDuckDuckGo(query: string, limit: number) {
  const url = `https://html.duckduckgo.com/html/?q=${encodeURIComponent(query)}`
  const started = Date.now()
  const res = await fetch(url, {
    headers: { "user-agent": "Mozilla/5.0 (Macintosh) alpha-code-1461-third-party-mcp", accept: "text/html" },
    signal: AbortSignal.timeout(20_000),
  })
  const html = await res.text()
  const results = [...html.matchAll(/<a[^>]*class="result__a"[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/g)]
    .map((m) => {
      const raw = m[1]!.replace(/&amp;/g, "&")
      const uddg = raw.match(/[?&]uddg=([^&]+)/)
      return { title: m[2]!.replace(/<[^>]+>/g, "").trim(), url: uddg ? decodeURIComponent(uddg[1]!) : raw }
    })
    .slice(0, limit)
  trace({ query, upstream: "html.duckduckgo.com", status: res.status, bytes: html.length, results: results.length, ms: Date.now() - started })
  return { status: res.status, results }
}

const server = new McpServer({ name: "duck-1461", version: "0.0.1" })
server.registerTool(
  TOOL,
  {
    description: "Search the web (DuckDuckGo) and return the top result titles and URLs for a query.",
    inputSchema: { query: z.string().min(1).describe("search query"), limit: z.number().int().min(1).max(10).optional().describe("max results, default 5") },
  },
  async ({ query, limit }) => {
    try {
      const { status, results } = await searchDuckDuckGo(query, limit ?? 5)
      if (status !== 200) return { content: [{ type: "text", text: `search backend returned HTTP ${status}` }], isError: true }
      const text = results.length
        ? results.map((r, i) => `${i + 1}. ${r.title}\n   ${r.url}`).join("\n")
        : "no results parsed from the search engine result page"
      return { content: [{ type: "text", text }] }
    } catch (error) {
      trace({ query, error: String(error).slice(0, 200) })
      return { content: [{ type: "text", text: `search failed: ${String(error).slice(0, 200)}` }], isError: true }
    }
  },
)
await server.connect(new StdioServerTransport())
trace({ event: "started", pid: process.pid })
