#!/usr/bin/env bun
// alpha-code#1433 (REQ-1414 VERIFY-1) —— 本地腿「拿回结果」那一半。
//
// 复现(模块解析要求它跑在 packages/opencode 之下):
//   cp docs/verification/2026-09-24-1433-four-account-states-websearch/probe-local-transport.ts \
//      packages/opencode/probe-1433-local.ts
//   cd packages/opencode && bun run probe-1433-local.ts < /dev/null
//
// 入口是**生产自己的传输** `McpWebSearch.call`(参数与 `tool/websearch.ts` 的 `callProvider`
// 逐字同形),所以主权闸(`call()` 首行的 `localWebSearchDenied()`)在路径上。
//
// 本探针**不含**:模型(「有没有发 tool_calls」那一半)、出网策略代理、seatbelt 围栏、
// `ctx.ask` 权限求值。它只回答一个问题:**这一格的引擎 env 下,如果工具被调用,拿不拿得回结果。**
//
// 反向臂 = kill-switch 那一格:同一条命令必须变成 `sovereignty_denied`,否则本次测量作废。
import { Effect, Layer } from "effect"
import { FetchHttpClient, HttpClient } from "effect/unstable/http"
import * as McpWebSearch from "./src/tool/mcp-websearch"

type Provider = "exa" | "parallel"
const ROUNDS = Number(process.env.PROBE_ROUNDS ?? "3")

// 四格的**引擎侧 env**。取值不是本探针测出来的 —— 它来自 `#1411`(PR #1442)与 `#1431`(PR #1441)
// 已跑成事实的那张四格工具表,本探针把它当输入,不重跑那条链。
const CELLS: { cell: string; env: Record<string, string | undefined>; expect: "result" | "sovereignty_denied" }[] = [
  { cell: "logged-out-byok",       env: { ALPHA_LOCAL_WEBSEARCH_DENY: undefined, OPENCODE_ENABLE_EXA: "1" }, expect: "result" },
  { cell: "logged-in-with-credit", env: { ALPHA_LOCAL_WEBSEARCH_DENY: undefined, OPENCODE_ENABLE_EXA: "1" }, expect: "result" },
  { cell: "logged-in-no-credit",   env: { ALPHA_LOCAL_WEBSEARCH_DENY: undefined, OPENCODE_ENABLE_EXA: "1" }, expect: "result" },
  { cell: "kill-switch",           env: { ALPHA_LOCAL_WEBSEARCH_DENY: "1",       OPENCODE_ENABLE_EXA: "0" }, expect: "sovereignty_denied" },
]

function applyEnv(env: Record<string, string | undefined>) {
  for (const [k, v] of Object.entries(env)) {
    if (v === undefined) delete process.env[k]
    else process.env[k] = v
  }
}

const provide = <A, E>(eff: Effect.Effect<A, E, HttpClient.HttpClient>) =>
  Effect.provide(eff, FetchHttpClient.layer as Layer.Layer<HttpClient.HttpClient>)

async function one(provider: Provider, query: string, session: string) {
  const started = Date.now()
  const eff = Effect.gen(function* () {
    const http = yield* HttpClient.HttpClient
    if (provider === "parallel")
      return yield* McpWebSearch.call(http, McpWebSearch.PARALLEL_URL, "web_search", McpWebSearch.ParallelSearchArgs,
        { objective: query, search_queries: [query], session_id: session, model_name: "probe-1433" },
        "25 seconds", { "User-Agent": "opencode/probe-1433" })
    return yield* McpWebSearch.call(http, McpWebSearch.EXA_URL, "web_search_exa", McpWebSearch.SearchArgs,
      { query, type: "auto", numResults: 3, livecrawl: "fallback", contextMaxCharacters: 2000 }, "25 seconds")
  })
  const exit = await Effect.runPromiseExit(provide(eff))
  const ms = Date.now() - started
  if (exit._tag === "Success") {
    const text = typeof exit.value === "string" ? exit.value : JSON.stringify(exit.value)
    return {
      provider, outcome: "result" as const, ms, bytes: text?.length ?? 0,
      // ⚠️ 这一条是本轮的发现:Exa 免费额度用尽时**以成功串**的形状回来。
      looksLikeRateLimitNotice: /rate limit/i.test(text ?? ""),
      head: (text ?? "").slice(0, 200),
    }
  }
  const err: any = (exit as any).cause?.error ?? (exit as any).cause
  const message = String(err?.message ?? err)
  return {
    provider, outcome: "failure" as const, ms,
    sovereigntyDenied: message.includes("kill switch (ADR-009 B2)"),
    message: message.slice(0, 400),
  }
}

const out: unknown[] = []
for (const c of CELLS) {
  applyEnv(c.env)
  for (let r = 1; r <= ROUNDS; r++) {
    for (const p of ["exa", "parallel"] as const) {
      const res = await one(p, `probe-1433 r${r} Array.prototype.flat MDN documentation`, `probe1433-${c.cell}-${r}`)
      const row = { cell: c.cell, round: r, expect: c.expect, denyEnvSeen: process.env.ALPHA_LOCAL_WEBSEARCH_DENY ?? null, ...res }
      out.push(row)
      console.log(JSON.stringify(row))
      await new Promise((s) => setTimeout(s, 1200))
    }
  }
}
console.log("---RESULTS-JSON---")
console.log(JSON.stringify({
  ticket: "alpha-code#1433",
  at: new Date().toISOString(),
  bun: Bun.version,
  rounds: ROUNDS,
  notMeasuredHere: ["model tool_calls", "egress policy proxy", "seatbelt process fence", "ctx.ask permission"],
  rows: out,
}, null, 2))
