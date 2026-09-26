#!/usr/bin/env bun
// alpha-code#1445(2026-09-26 补勘)—— 四种**真实**负载喂进两份生产 `parseResponse`,并列出每份的结构特征。
//
// 复现(模块解析要求它跑在 packages/opencode 之下):
//   cp docs/verification/2026-09-26-1445-exa-vendor-source-and-live-shapes/probe-parsers.ts \
//      packages/opencode/probe-1445b.ts
//   cd packages/opencode && bun run probe-1445b.ts < /dev/null
//   rm packages/opencode/probe-1445b.ts
//
// 入口是**生产自己的** `parseResponse`(两份副本各一个),不是复刻。四种负载:
//   D  票面那一种(#1433 走生产传输实抓,文本 246 字逐字;信封是被生产代码反推的最小形状)
//   Z  Exa 的零命中渲染 —— 文本与形状逐字取自 exa-mcp-server 3.1.9 / 3.4.1 的 web_search_exa 源码
//      (results/vendor-source-excerpts.txt ③),无 isError、无 _meta、无 structuredContent
//   A  今天 nokey 打 Exa 本体拿回的原始 SSE body(results/live-shapes.json)
//   P  今天 keyless 打 Parallel 拿回的原始 JSON body(同上)
import { Effect } from "effect"
import { readFileSync } from "node:fs"
import * as Legacy from "./src/tool/mcp-websearch"
import * as Core from "../core/src/tool/websearch"

const HERE = "../../docs/verification"
const ticket = JSON.parse(readFileSync(`${HERE}/2026-09-24-1445-exa-mcp-response-shapes/results/ticket-payload.json`, "utf8"))
const live = JSON.parse(readFileSync(`${HERE}/2026-09-26-1445-exa-vendor-source-and-live-shapes/results/live-shapes.json`, "utf8"))
const liveBody = (arm: string) => live.rows.find((r: any) => r.arm === arm).body as string

const ZERO_HIT = JSON.stringify({
  jsonrpc: "2.0",
  id: 1,
  result: { content: [{ type: "text", text: "No search results found. Please try a different query." }] },
})

const ARMS: [string, string][] = [
  ["D  #1445 票面的额度提示(#1433 实抓,246 字)", JSON.stringify(ticket.minimalEnvelope)],
  ["Z  Exa 零命中渲染(vendor 源码逐字)", ZERO_HIT],
  ["A  今天 nokey 真搜索(Exa,原始 SSE body)", liveBody("exa-nokey-search")],
  ["P  今天 keyless 真搜索(Parallel,原始 JSON body)", liveBody("parallel-keyless-search")],
]

/** 生产 parseResponse 会看的信封字段 + 文本层的几个结构计数(不是判据,是清点)。 */
function features(body: string) {
  const frame = body.split("\n").find((l) => l.startsWith("data: "))
  const env = JSON.parse(frame ? frame.slice(6) : body)
  const res = env.result ?? {}
  const c0 = res.content?.[0] ?? {}
  const t: string = c0.text ?? ""
  return {
    jsonrpc: env.error ? "error" : "result",
    isError: res.isError ?? "(absent)",
    structuredContent: res.structuredContent === undefined ? "(absent)" : "present",
    resultMeta: res._meta === undefined ? "(absent)" : JSON.stringify(res._meta).slice(0, 60),
    contentMeta: c0._meta === undefined ? "(absent)" : JSON.stringify(c0._meta),
    textLen: t.length,
    urlsInText: (t.match(/https?:\/\//g) ?? []).length,
    titleLines: (t.match(/^Title: /gm) ?? []).length,
    urlLines: (t.match(/^URL: /gm) ?? []).length,
    jsonText: t.trimStart().startsWith("{"),
  }
}
const show = (e: any) => {
  if (e._tag === "Success")
    return e.value === undefined
      ? "成功(undefined ⇒ core 调用方换成 NO_RESULTS)"
      : `成功 → ${JSON.stringify(String(e.value).slice(0, 60))}`
  const err: any = e.cause?.error ?? e.cause?.defect ?? e.cause
  return `失败 → ${String(err?.message ?? err).slice(0, 110)}`
}
for (const [label, body] of ARMS) {
  console.log(`\n${label}`)
  console.log(`  特征: ${JSON.stringify(features(body))}`)
  console.log(`  packages/opencode : ${show(await Effect.runPromiseExit(Legacy.parseResponse(body)))}`)
  console.log(`  packages/core     : ${show(await Effect.runPromiseExit(Core.parseResponse(body)))}`)
}
