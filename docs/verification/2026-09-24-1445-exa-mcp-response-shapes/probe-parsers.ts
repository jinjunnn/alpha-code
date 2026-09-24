#!/usr/bin/env bun
// alpha-code#1445 —— 两份生产传输**现在**怎么判这三种负载(AC2 的「改前」臂)。
//
// 复现(模块解析要求它跑在 packages/opencode 之下):
//   cp docs/verification/2026-09-24-1445-exa-mcp-response-shapes/probe-parsers.ts \
//      packages/opencode/probe-1445-parsers.ts
//   cd packages/opencode && bun run probe-1445-parsers.ts < /dev/null
//   rm packages/opencode/probe-1445-parsers.ts
//
// 入口是**生产自己的** `parseResponse`(两份副本各一个),不是复刻。
import { Effect } from "effect"
import * as Legacy from "./src/tool/mcp-websearch"
import * as Core from "../core/src/tool/websearch"

// ① #1445 票面那一种。文本逐字见 results/ticket-payload.json(长度 246,与 #1433 记录的 bytes 相等);
//    envelope 是**被生产代码反推**出来的最小形状 —— 反推过程写在同一个 json 里。
const NOTICE =
  "You've hit Exa's free MCP rate limit. To continue using without limits, create your own Exa API key.\n\n" +
  "Fix: Create API key at https://dashboard.exa.ai/api-keys , and then update Exa MCP URL to this https://mcp.exa.ai/mcp?exaApiKey=YOUR_EXA_API_KEY"
const ticketPayload = JSON.stringify({ jsonrpc: "2.0", id: 1, result: { content: [{ type: "text", text: NOTICE }] } })

// ② Exa 自己的 in-band 错误,2026-09-24 实测(results/arms.json 的 inband-invalid-key 臂)。
const inbandError = JSON.stringify({
  jsonrpc: "2.0",
  id: 1,
  result: {
    content: [
      {
        type: "text",
        text: "web_search_exa error (401): Invalid API key. Provide a valid key using 'Authorization: Bearer <key>' or 'x-api-key: <key>'. Create a key at https://dashboard.exa.ai/api-keys\nTimestamp: 2026-09-24T11:37:46.789Z",
      },
    ],
    isError: true,
  },
})

// ③ 正常结果(对照臂),2026-09-24 实测的形状,含 Exa 给的 `_meta.searchTime`。
const success = JSON.stringify({
  jsonrpc: "2.0",
  id: 1,
  result: {
    content: [
      {
        type: "text",
        text: "Title: Array.prototype.flat() - JavaScript - MDN Web Docs\nURL: https://developer.mozilla.org/en-US/docs/Web/JavaScript/Reference/Global_Objects/Array/flat",
        _meta: { searchTime: 974.4 },
      },
    ],
  },
})

console.log("NOTICE bytes =", NOTICE.length, "(#1433 记录 bytes=246)")

const show = (e: any) => {
  if (e._tag === "Success")
    return e.value === undefined
      ? "成功(undefined ⇒ 调用方换成 NO_RESULTS 伪成功串)"
      : `成功 → ${JSON.stringify(String(e.value).slice(0, 70))}`
  const err: any = e.cause?.error ?? e.cause?.defect ?? e.cause
  return `失败 → ${String(err?.message ?? err).slice(0, 150)}`
}

for (const [label, body] of [
  ["① #1445 票面的额度提示", ticketPayload],
  ["② Exa in-band 错误(isError:true,今日实测)", inbandError],
  ["③ 正常结果(对照臂,今日实测)", success],
] as const) {
  const legacy = await Effect.runPromiseExit(Legacy.parseResponse(body))
  const core = await Effect.runPromiseExit(Core.parseResponse(body))
  console.log(`\n${label}`)
  console.log(`  packages/opencode : ${show(legacy)}`)
  console.log(`  packages/core     : ${show(core)}`)
}
