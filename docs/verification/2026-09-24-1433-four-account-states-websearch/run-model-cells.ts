#!/usr/bin/env bun
// alpha-code#1433 (REQ-1414 VERIFY-1) —— ①「模型有没有真的发出 tool_calls」那一列。
//
// 复现(模块解析要求它跑在 packages/opencode 之下):
//   cp docs/verification/2026-09-24-1433-four-account-states-websearch/run-model-cells.ts \
//      packages/opencode/run-1433-cells.ts
//   cd packages/opencode && bun run run-1433-cells.ts \
//      --keys-file <abs path to KEY=VALUE file> --provider deepseek --model deepseek-flash \
//      --drive neutral --out /tmp/out.json < /dev/null
//
// 凭据卫生(与 `#1144` run-real.ts §6 同款,owner 2026-09-24 批准的边界):
//   key 只从 --keys-file 读进**本进程内存**,只出现在发往 upstream 的 `Authorization` 头里。
//   它不进引擎配置(引擎拿到的是占位串)、不进 env、不进任何结果 JSON、不打印、不落盘。
//
// 中间那一层是**透明记录代理**,不是桩:它不产生任何响应内容,只把 downstream 的请求体原样
// 转给真 upstream、把 upstream 的字节原样交回,唯一改写是 Authorization 头。两端逐字入库。
//
// 为什么这一个代理同时量到两半:
//   ① 模型发不发 tool_calls  → upstream **响应**里有没有 `tool_calls`,name 是哪个工具;
//   ② 引擎拿不拿得回结果      → **下一次请求**体里那条 `role:"tool"` 消息的 content
//                              (引擎把工具输出喂回模型的唯一形状)。
// 加一条辅助轴:引擎**请求**体里的 `tools[]` 名单 = 这一格模型手里到底有哪些工具。

import { mkdtempSync, readFileSync, rmSync, writeFileSync, mkdirSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { createServer, type IncomingMessage, type ServerResponse } from "node:http"
import { spawn } from "node:child_process"

function arg(name: string, fallback?: string) {
  const i = process.argv.indexOf(`--${name}`)
  return i >= 0 && process.argv[i + 1] && !process.argv[i + 1]!.startsWith("--") ? process.argv[i + 1]! : fallback
}

const KEYS_FILE = arg("keys-file")
const PROVIDER = arg("provider", "deepseek")!
const MODEL = arg("model", "deepseek-flash")!
const DRIVE = arg("drive", "neutral")! as "neutral" | "explicit"
const OUT = arg("out")
const ONLY = arg("cell")
if (!KEYS_FILE) throw new Error("--keys-file is required")

const UPSTREAM: Record<string, { url: string; keyEnv: string }> = {
  // 与 packages/ui-mac/src/main/alpha-models.json 的 byokProviders 逐字相同
  deepseek: { url: "https://api.deepseek.com/v1", keyEnv: "DEEPSEEK_API_KEY" },
  zhipuai: { url: "https://open.bigmodel.cn/api/paas/v4", keyEnv: "ZHIPU_API_KEY" },
}
const up = UPSTREAM[PROVIDER]
if (!up) throw new Error(`unknown provider ${PROVIDER}`)

// ── 凭据:只进内存 ────────────────────────────────────────────────────────────
const KEY = (() => {
  const text = readFileSync(KEYS_FILE, "utf8")
  for (const line of text.split("\n")) {
    const eq = line.indexOf("=")
    if (eq < 0) continue
    if (line.slice(0, eq).trim() === up.keyEnv) return line.slice(eq + 1).trim()
  }
  throw new Error(`${up.keyEnv} not found in --keys-file`)
})()
const PLACEHOLDER = "ac1433-placeholder-not-a-real-key"

type Exchange = {
  n: number
  at: string
  upstreamUrl: string
  status?: number
  // 引擎发给模型的工具名单(本轮的关键辅助轴)
  requestToolNames?: string[]
  requestMessageRoles?: string[]
  // role:"tool" 消息 = 引擎把工具输出喂回模型
  toolResultMessages?: { name?: string; bytes: number; head: string }[]
  // 模型回的 tool_calls(流式时从 SSE delta 累积)
  responseToolCalls?: { index: number; id?: string; name?: string; argsHead: string }[]
  responseAssistantTextHead?: string
  responseHeadersSample?: Record<string, string>
  requestBytes: number
  responseBytes: number
}

function parseRequest(bodyText: string, ex: Exchange) {
  try {
    const body = JSON.parse(bodyText)
    if (Array.isArray(body.tools))
      ex.requestToolNames = body.tools.map((t: any) => t?.function?.name ?? t?.name).filter(Boolean)
    if (Array.isArray(body.messages)) {
      ex.requestMessageRoles = body.messages.map((m: any) => m?.role)
      ex.toolResultMessages = body.messages
        .filter((m: any) => m?.role === "tool")
        .map((m: any) => {
          const c = typeof m.content === "string" ? m.content : JSON.stringify(m.content)
          return { name: m.name, bytes: c?.length ?? 0, head: (c ?? "").slice(0, 300) }
        })
    }
  } catch {
    /* 非 JSON:留空,不编造 */
  }
}

function parseResponse(bodyText: string, ex: Exchange) {
  const calls = new Map<number, { index: number; id?: string; name?: string; args: string }>()
  let text = ""
  const handleChoice = (choice: any) => {
    const delta = choice?.delta ?? choice?.message
    if (!delta) return
    if (typeof delta.content === "string") text += delta.content
    for (const tc of delta.tool_calls ?? []) {
      const i = tc.index ?? 0
      const cur = calls.get(i) ?? { index: i, args: "" }
      if (tc.id) cur.id = tc.id
      if (tc.function?.name) cur.name = (cur.name ?? "") + tc.function.name
      if (tc.function?.arguments) cur.args += tc.function.arguments
      calls.set(i, cur)
    }
  }
  const eat = (payload: string) => {
    try {
      const j = JSON.parse(payload)
      for (const c of j.choices ?? []) handleChoice(c)
    } catch {
      /* ignore */
    }
  }
  if (bodyText.trim().startsWith("{")) eat(bodyText)
  for (const line of bodyText.split("\n")) {
    if (!line.startsWith("data: ")) continue
    const p = line.slice(6).trim()
    if (!p || p === "[DONE]") continue
    eat(p)
  }
  ex.responseToolCalls = [...calls.values()].map((c) => ({ index: c.index, id: c.id, name: c.name, argsHead: c.args.slice(0, 300) }))
  ex.responseAssistantTextHead = text.slice(0, 400)
}

async function startProxy(exchanges: Exchange[]) {
  let n = 0
  const server = createServer(async (req: IncomingMessage, res: ServerResponse) => {
    const chunks: Buffer[] = []
    for await (const c of req) chunks.push(c as Buffer)
    const reqBody = Buffer.concat(chunks)
    const path = (req.url ?? "/").replace(/^\/v1/, "")
    const target = `${up.url}${path}`
    const ex: Exchange = { n: ++n, at: new Date().toISOString(), upstreamUrl: target, requestBytes: reqBody.byteLength, responseBytes: 0 }
    parseRequest(reqBody.toString("utf8"), ex)
    const headers: Record<string, string> = { "content-type": "application/json", accept: "application/json, text/event-stream", "accept-encoding": "identity", authorization: `Bearer ${KEY}` }
    try {
      const upRes = await fetch(target, { method: req.method ?? "POST", headers, body: reqBody.byteLength ? reqBody : undefined })
      const buf = Buffer.from(await upRes.arrayBuffer())
      ex.status = upRes.status
      ex.responseBytes = buf.byteLength
      ex.responseHeadersSample = { "cf-ray": upRes.headers.get("cf-ray") ?? "", "content-type": upRes.headers.get("content-type") ?? "", server: upRes.headers.get("server") ?? "" }
      parseResponse(buf.toString("utf8"), ex)
      exchanges.push(ex)
      res.writeHead(upRes.status, { "content-type": upRes.headers.get("content-type") ?? "application/json" })
      res.end(buf)
    } catch (e) {
      ex.status = -1
      ex.responseAssistantTextHead = `proxy transport failure: ${String(e).slice(0, 200)}`
      exchanges.push(ex)
      res.writeHead(502, { "content-type": "text/plain" })
      res.end("proxy failure")
    }
  })
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r))
  const port = (server.address() as any).port as number
  return { port, close: () => new Promise<void>((r) => server.close(() => r())) }
}

// ── 四格的引擎侧 env(来源 = #1411 / #1431 已跑成事实的那张四格工具表) ────────────
const CELLS = [
  { cell: "logged-out-byok", env: { OPENCODE_ENABLE_EXA: "1" } as Record<string, string>, unset: ["ALPHA_LOCAL_WEBSEARCH_DENY"] },
  { cell: "logged-in-with-credit", env: { OPENCODE_ENABLE_EXA: "1" }, unset: ["ALPHA_LOCAL_WEBSEARCH_DENY"] },
  { cell: "logged-in-no-credit", env: { OPENCODE_ENABLE_EXA: "1" }, unset: ["ALPHA_LOCAL_WEBSEARCH_DENY"] },
  { cell: "kill-switch", env: { OPENCODE_ENABLE_EXA: "0", ALPHA_LOCAL_WEBSEARCH_DENY: "1" }, unset: [] },
].filter((c) => !ONLY || c.cell === ONLY)

const PROMPTS = {
  // 中性驱动句:**不点名任何工具**,只问一件「一次抓取答不了、必须跨站搜索」的事。
  // 第一版写成「bun.sh 上的最新版本号」—— 那句话自带一个规范 URL,模型当场选了 `webfetch`,
  // 于是 websearch 那一格根本量不到。驱动句必须让 websearch 成为自然选择,判据一格没松。
  neutral:
    "Find three distinct web pages, on three different domains, that discuss the Bun JavaScript runtime and were published recently. For each one give the page title and its URL.",
  // 显式驱动句:只在中性句拿不到 websearch 的 tool_call 时补跑,并在证据里标明是哪一种。
  explicit:
    "Use your web search tool (not the page-fetch tool) to find recent pages about the Bun JavaScript runtime, then list three results with their titles and URLs. If you have no web search tool available, say that explicitly and do not call any other tool.",
} as const

async function runCell(cell: (typeof CELLS)[number]) {
  const root = mkdtempSync(join(tmpdir(), "ac1433-"))
  const dataHome = join(root, "data")
  const configHome = join(root, "config")
  const workspace = join(root, "ws")
  for (const d of [dataHome, configHome, workspace]) mkdirSync(d, { recursive: true })
  writeFileSync(join(workspace, "README.md"), "ac1433 probe workspace\n")

  const exchanges: Exchange[] = []
  const proxy = await startProxy(exchanges)

  const PROVIDER_ID = "ac1433probe"
  const config = {
    $schema: "https://opencode.ai/config.json",
    model: `${PROVIDER_ID}/${MODEL}`,
    provider: {
      [PROVIDER_ID]: {
        npm: "@ai-sdk/openai-compatible",
        name: "ac1433 probe",
        // 占位串:真 key 只活在代理进程内存里
        options: { baseURL: `http://127.0.0.1:${proxy.port}/v1`, apiKey: PLACEHOLDER },
        models: { [MODEL]: { name: MODEL } },
      },
    },
    permission: { websearch: "allow", webfetch: "allow", bash: "deny", edit: "deny" },
  }

  const env: Record<string, string> = {
    PATH: process.env.PATH ?? "",
    HOME: root,
    TMPDIR: join(root, "tmp"),
    XDG_DATA_HOME: dataHome,
    XDG_CONFIG_HOME: configHome,
    XDG_CACHE_HOME: join(root, "cache"),
    OPENCODE_CONFIG_CONTENT: JSON.stringify(config),
    OPENCODE_DISABLE_AUTOUPDATE: "1",
    NO_COLOR: "1",
    ...cell.env,
  }
  mkdirSync(env.TMPDIR!, { recursive: true })
  for (const k of cell.unset) delete env[k]

  const events: any[] = []
  const stdoutChunks: string[] = []
  const stderrChunks: string[] = []
  const child = spawn(process.execPath, ["run", "./src/index.ts", "run", "--format", "json", "--dir", workspace, "--model", `${PROVIDER_ID}/${MODEL}`, PROMPTS[DRIVE]], {
    cwd: process.cwd(),
    env,
    stdio: ["ignore", "pipe", "pipe"], // stdin 关掉:本仓陷阱「CLI 的 stdin 是打开不关的管道就会挂住」
  })
  child.stdout.setEncoding("utf8")
  child.stderr.setEncoding("utf8")
  child.stdout.on("data", (d) => stdoutChunks.push(d))
  child.stderr.on("data", (d) => stderrChunks.push(d))
  const timeout = setTimeout(() => child.kill("SIGKILL"), 180_000)
  const exitCode = await new Promise<number | null>((r) => child.on("close", (c) => r(c)))
  clearTimeout(timeout)

  for (const line of stdoutChunks.join("").split("\n")) {
    const t = line.trim()
    if (!t.startsWith("{")) continue
    try {
      events.push(JSON.parse(t))
    } catch {
      /* ignore */
    }
  }

  // 引擎侧的工具格(与代理侧互相独立的第二条轴)
  const toolParts: any[] = []
  const walk = (v: any) => {
    if (!v || typeof v !== "object") return
    if (v.type === "tool" && v.tool) toolParts.push({ tool: v.tool, callID: v.callID, status: v.state?.status, inputHead: JSON.stringify(v.state?.input ?? null).slice(0, 200), outputBytes: typeof v.state?.output === "string" ? v.state.output.length : 0, outputHead: typeof v.state?.output === "string" ? v.state.output.slice(0, 300) : "", errorHead: String(v.state?.error ?? "").slice(0, 300) })
    for (const k of Object.keys(v)) walk(v[k])
  }
  for (const e of events) walk(e)

  await proxy.close()
  rmSync(root, { recursive: true, force: true })

  const offeredTools = exchanges.find((e) => e.requestToolNames)?.requestToolNames ?? []
  const modelToolCalls = exchanges.flatMap((e) => (e.responseToolCalls ?? []).map((c) => ({ exchange: e.n, ...c })))
  const toolResultsFedBack = exchanges.flatMap((e) => (e.toolResultMessages ?? []).map((m) => ({ exchange: e.n, ...m })))

  return {
    cell: cell.cell,
    drive: DRIVE,
    provider: PROVIDER,
    model: MODEL,
    exitCode,
    modelCallCount: exchanges.length,
    // ① 模型有没有真的发出 tool_calls
    websearchOfferedToModel: offeredTools.includes("websearch"),
    offeredTools,
    modelEmittedToolCalls: modelToolCalls.length > 0,
    modelEmittedWebsearchCall: modelToolCalls.some((c) => c.name === "websearch"),
    modelToolCalls,
    // ② 有没有拿回结果
    toolResultsFedBack,
    engineToolParts: toolParts,
    exchanges,
    stderrTail: stderrChunks.join("").slice(-1500),
    stdoutTail: stdoutChunks.join("").slice(-800),
  }
}

const results = []
for (const c of CELLS) {
  const r = await runCell(c)
  results.push(r)
  console.log(JSON.stringify({ cell: r.cell, exitCode: r.exitCode, modelCallCount: r.modelCallCount, websearchOfferedToModel: r.websearchOfferedToModel, offeredTools: r.offeredTools.length, modelEmittedWebsearchCall: r.modelEmittedWebsearchCall, toolResults: r.toolResultsFedBack.length, engineToolParts: r.engineToolParts.length }))
}

const payload = {
  ticket: "alpha-code#1433",
  at: new Date().toISOString(),
  bun: Bun.version,
  provider: PROVIDER,
  model: MODEL,
  drive: DRIVE,
  totalModelCalls: results.reduce((a, r) => a + r.modelCallCount, 0),
  credentialHygiene: "key read from --keys-file into memory only; engine配置里是占位串;不入结果/日志/证据",
  notMeasuredHere: ["云腿(cloud_cloud_web_search):无登录铸 token,本轮未接", "打包实例", "seatbelt 围栏", "出网策略代理"],
  results,
}
if (OUT) writeFileSync(OUT, JSON.stringify(payload, null, 2))
console.log("---RESULTS-JSON---")
console.log(JSON.stringify(payload, null, 2))
