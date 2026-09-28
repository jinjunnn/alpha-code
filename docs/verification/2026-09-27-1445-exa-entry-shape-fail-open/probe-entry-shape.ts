#!/usr/bin/env bun
// alpha-code#1445(2026-09-27 勘破:条目形状 × fail-open)—— **生产路径版**:四种真实负载先过两份生产
// `parseResponse` 取出模型会看到的那段文本,再对那段文本跑同一条 fail-open 命题。离线版(纯 Python,不经
// 生产解析器)见同目录 entry-shape.py;两版四格结论必须一致。
//
// 复现(模块解析要求它跑在 packages/opencode 之下):
//   cp docs/verification/2026-09-27-1445-exa-entry-shape-fail-open/probe-entry-shape.ts packages/opencode/probe-1445c.ts
//   cd packages/opencode && bun run probe-1445c.ts < /dev/null
//   rm packages/opencode/probe-1445c.ts
//
// 命题(只看行首标签与 JSON 结构,不看任何词的语义):
//   E(T) = 「一行以 `Title: ` 开头、紧接的下一行以 `URL: ` 开头」的行对数
//   J(T) = T 是 JSON 对象且顶层 results 是数组时的数组长度,否则 ⊥
//   claim(T) = E≥1 ? {exa-entries,E} : J≥1 ? {json-results,J} : ∅
//   任何分支都**原样放行 T**;claim 只是附在旁路上的一句话,∅ 时什么都不附。
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
  ["D  票面限流提示(#1433 实抓,246 字)", JSON.stringify(ticket.minimalEnvelope)],
  ["Z  Exa 真零命中(vendor 源码逐字)", ZERO_HIT],
  ["A  今日 Exa 真结果(live-shapes 原始 SSE)", liveBody("exa-nokey-search")],
  ["P  今日 Parallel 真结果(live-shapes 原始 JSON)", liveBody("parallel-keyless-search")],
]

function entryShape(text: string) {
  const lines = text.split("\n")
  let exaEntries = 0
  for (let i = 0; i + 1 < lines.length; i++)
    if (lines[i].startsWith("Title: ") && lines[i + 1].startsWith("URL: ")) exaEntries++
  let jsonResults: number | "absent" = "absent"
  if (text.trimStart().startsWith("{")) {
    try {
      const obj = JSON.parse(text)
      if (obj && typeof obj === "object" && Array.isArray(obj.results)) jsonResults = obj.results.length
    } catch {}
  }
  return { exaEntries, jsonResults }
}
function claim(text: string) {
  const s = entryShape(text)
  if (s.exaEntries >= 1) return { kind: "exa-entries", entries: s.exaEntries }
  if (s.jsonResults !== "absent" && s.jsonResults >= 1) return { kind: "json-results", entries: s.jsonResults }
  return undefined
}
const textOf = (e: any) => (e._tag === "Success" ? (e.value as string | undefined) : undefined)
const show = (e: any) => {
  if (e._tag === "Success") return e.value === undefined ? "成功(undefined)" : `成功 ${String(e.value).length} 字`
  const err: any = e.cause?.error ?? e.cause?.defect ?? e.cause
  return `失败 → ${String(err?.message ?? err).slice(0, 80)}`
}
let consistent = true
for (const [label, body] of ARMS) {
  const legacy = await Effect.runPromiseExit(Legacy.parseResponse(body))
  const core = await Effect.runPromiseExit(Core.parseResponse(body))
  const tl = textOf(legacy), tc = textOf(core)
  const cl = tl === undefined ? "(无文本)" : claim(tl), cc = tc === undefined ? "(无文本)" : claim(tc)
  consistent &&= JSON.stringify(cl) === JSON.stringify(cc)
  console.log(`\n${label}`)
  console.log(`  packages/opencode parseResponse: ${show(legacy)}  → shape=${JSON.stringify(tl === undefined ? null : entryShape(tl))}  → ${cl ? "声称 " + JSON.stringify(cl) : "放行,不声称"}`)
  console.log(`  packages/core     parseResponse: ${show(core)}  → shape=${JSON.stringify(tc === undefined ? null : entryShape(tc))}  → ${cc ? "声称 " + JSON.stringify(cc) : "放行,不声称"}`)
}
console.log(`\n两份生产解析器取出的文本对四格给出相同的 claim: ${consistent}`)
