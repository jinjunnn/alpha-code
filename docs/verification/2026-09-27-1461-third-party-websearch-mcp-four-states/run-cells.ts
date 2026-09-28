#!/usr/bin/env bun
// alpha-code#1461 —— 装了**真第三方 web-search MCP** 的真引擎(bun, dev 树)+ 真 @alpha-code/ext,
// 四种账户态 × 三种第三方形状,每格记录:①模型手里有没有那个工具(引擎发给模型的 tools[] 名单)
// ②模型有没有真的调它 ③调用落在哪(拿回搜索结果 / 被 ext 的 tool.execute.before 以 kill-switch 拒)。
//
// 复现(模块解析要求它跑在 packages/ui-mac 之下;引擎从 ../opencode 起):
//   cp docs/verification/2026-09-27-1461-third-party-websearch-mcp-four-states/run-cells.ts packages/ui-mac/1461-run-cells.ts
//   cp docs/verification/2026-09-27-1461-third-party-websearch-mcp-four-states/mcp-server.ts packages/opencode/1461-mcp-server.ts
//   cd packages/ui-mac && bun run 1461-run-cells.ts --keys-file <abs KEY=VALUE> --out <abs>.json [--cell X] [--arm Y] < /dev/null
//
// 三种第三方形状(arm):
//   exa-remote      用户在配置里声明 {"mcp":{"exa":{"type":"remote","url":"https://mcp.exa.ai/mcp"}}} —— ADR-046 D6 的字面例子;
//                   Exa 今天 advertise 的工具名 web_search_exa ⇒ 引擎 id exa_web_search_exa(落进 isWebSearchToolId)
//   own-web_search  自建 stdio 插件(mcp-server.ts,真打 DuckDuckGo),工具名 web_search ⇒ duck_web_search(落进)
//   own-search      同一个插件,工具名 search ⇒ duck_search(**不落进** —— AC2 的反向臂)
//
// 四种账户态的 env 不是手编的判据,而是把生产在每一态写下的那几个变量按坐标复刻(见 STATES 的注释),
// permission 的 deny 由生产的 applyWebSearchDenies 算,云 MCP 定义由生产的 materializeCloudMcpConfig 算。
// 与 #1433 同一条诚实边界:登出 / 登录有额度 / 登录无额度 三格在第三方判决所读的信号上**逐字相同**
// (webSearchToolDenial 只读 ALPHA_LOCAL_WEBSEARCH_DENY / ALPHA_CLOUD_WEBSEARCH_DENY + 归属),额度轴从不进入它。
//
// 出网:引擎经生产的 startEgressPolicyProxy(sidecarEgressProxyEnv 注入),authorize 换成本轮白名单 ——
// 放行 mcp.exa.ai / html.duckduckgo.com / duckduckgo.com / models.opencode.ai(模型目录;拒它 ModelsDev.populate 会 orDie),**拒** registry.npmjs.org(否则引擎开机
// 那次 npm 安装会让第一个请求等满代理慢路,ac#1454 的根因)与其余一切。代理日志 = 第三方工具真出网的第二条证据轴。
//
// 凭据卫生(与 #1433 同款):模型 key 只从 --keys-file 读进本进程内存,只出现在发往 upstream 的 Authorization 头里;
// 引擎配置里是占位串;不进 env、不进结果 JSON、不打印、不落盘。
import { mkdtempSync, mkdirSync, readFileSync, realpathSync, rmSync, writeFileSync, existsSync } from "node:fs"
import { join, resolve } from "node:path"
import { createServer, type IncomingMessage, type ServerResponse } from "node:http"
import { spawn } from "node:child_process"
import { startEgressPolicyProxy, type EgressLogRecord } from "./src/main/network-egress-proxy"
import { sidecarEgressProxyEnv } from "./src/main/sidecar-env"
import {
  applyWebSearchDenies,
  CLOUD_MCP_ARM_ENV,
  CLOUD_MCP_DEF_ENV,
  CLOUD_MCP_SERVER_ENV,
  CLOUD_MCP_SERVER_NAME,
  CLOUD_WEBSEARCH_DENY_ENV,
  LOCAL_WEBSEARCH_DENY_ENV,
  WITHHELD_CLOUD_MCP,
} from "./src/main/cloud-web-search"
import { materializeCloudMcpConfig } from "./src/main/cloud-sidecar-config"

function arg(name: string, fallback?: string) {
  const i = process.argv.indexOf(`--${name}`)
  return i >= 0 && process.argv[i + 1] && !process.argv[i + 1]!.startsWith("--") ? process.argv[i + 1]! : fallback
}
const KEYS_FILE = arg("keys-file")
const PROVIDER = arg("provider", "deepseek")!
const MODEL = arg("model", "deepseek-flash")!
const OUT = arg("out")
const ONLY_CELL = arg("cell")
const ONLY_ARM = arg("arm")
const SCRATCH = arg("scratch", process.env.TMPDIR ?? "/tmp")!
// --no-auto:不给 `run --auto` —— 策略闸(第三方 MCP 默认 ask)问起来时 run 会自动拒绝并打印「permission requested … auto-rejecting」。
// 这是对照臂:证明闸在路径上,以及 --auto 等于用户在弹窗上点「允许」。
const NO_AUTO = process.argv.includes("--no-auto")
if (!KEYS_FILE) throw new Error("--keys-file is required")

const repoRoot = resolve(import.meta.dir, "../..")
const enginePkg = join(repoRoot, "packages", "opencode")
const engineEntry = join(enginePkg, "src", "index.ts")
const extBundle = join(repoRoot, "packages", "ext", "dist", "plugin.js")
const mcpServerScript = join(enginePkg, "1461-mcp-server.ts")
for (const f of [engineEntry, extBundle, mcpServerScript]) if (!existsSync(f)) throw new Error(`missing ${f} (本次测量作废)`)

const UPSTREAM: Record<string, { url: string; keyEnv: string }> = {
  deepseek: { url: "https://api.deepseek.com/v1", keyEnv: "DEEPSEEK_API_KEY" },
  zhipuai: { url: "https://open.bigmodel.cn/api/paas/v4", keyEnv: "ZHIPU_API_KEY" },
}
const up = UPSTREAM[PROVIDER]
if (!up) throw new Error(`unknown provider ${PROVIDER}`)
const KEY = (() => {
  for (const line of readFileSync(KEYS_FILE, "utf8").split("\n")) {
    const eq = line.indexOf("=")
    if (eq > 0 && line.slice(0, eq).trim() === up.keyEnv) return line.slice(eq + 1).trim()
  }
  throw new Error(`${up.keyEnv} not found in --keys-file`)
})()
const PLACEHOLDER = "ac1461-placeholder-not-a-real-key"
const PROVIDER_ID = "ac1461probe"

// ── 透明记录代理(#1433 逐字同款):不产生内容,只转发并记录两端 ───────────────────────────
type Exchange = {
  n: number
  at: string
  status?: number
  requestToolNames?: string[]
  requestMessageRoles?: string[]
  toolResultMessages?: { name?: string; bytes: number; head: string }[]
  responseToolCalls?: { index: number; id?: string; name?: string; argsHead: string }[]
  responseAssistantTextHead?: string
  requestBytes: number
  responseBytes: number
}
function parseRequest(bodyText: string, ex: Exchange) {
  try {
    const body = JSON.parse(bodyText)
    if (Array.isArray(body.tools)) ex.requestToolNames = body.tools.map((t: any) => t?.function?.name ?? t?.name).filter(Boolean)
    if (Array.isArray(body.messages)) {
      ex.requestMessageRoles = body.messages.map((m: any) => m?.role)
      ex.toolResultMessages = body.messages
        .filter((m: any) => m?.role === "tool")
        .map((m: any) => {
          const c = typeof m.content === "string" ? m.content : JSON.stringify(m.content)
          return { name: m.name, bytes: c?.length ?? 0, head: (c ?? "").slice(0, 400) }
        })
    }
  } catch {}
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
      for (const c of JSON.parse(payload).choices ?? []) handleChoice(c)
    } catch {}
  }
  if (bodyText.trim().startsWith("{")) eat(bodyText)
  for (const line of bodyText.split("\n")) {
    if (!line.startsWith("data: ")) continue
    const p = line.slice(6).trim()
    if (p && p !== "[DONE]") eat(p)
  }
  ex.responseToolCalls = [...calls.values()].map((c) => ({ index: c.index, id: c.id, name: c.name, argsHead: c.args.slice(0, 300) }))
  ex.responseAssistantTextHead = text.slice(0, 600)
}
async function startRecordingProxy(exchanges: Exchange[]) {
  let n = 0
  const server = createServer(async (req: IncomingMessage, res: ServerResponse) => {
    const chunks: Buffer[] = []
    for await (const c of req) chunks.push(c as Buffer)
    const reqBody = Buffer.concat(chunks)
    const target = `${up.url}${(req.url ?? "/").replace(/^\/v1/, "")}`
    const ex: Exchange = { n: ++n, at: new Date().toISOString(), requestBytes: reqBody.byteLength, responseBytes: 0 }
    parseRequest(reqBody.toString("utf8"), ex)
    try {
      const upRes = await fetch(target, {
        method: req.method ?? "POST",
        headers: { "content-type": "application/json", accept: "application/json, text/event-stream", "accept-encoding": "identity", authorization: `Bearer ${KEY}` },
        body: reqBody.byteLength ? reqBody : undefined,
      })
      const buf = Buffer.from(await upRes.arrayBuffer())
      ex.status = upRes.status
      ex.responseBytes = buf.byteLength
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
  return { port: (server.address() as any).port as number, close: () => new Promise<void>((r) => server.close(() => r())) }
}

// ── 四种账户态:生产在每一态写下的变量,按坐标复刻 ────────────────────────────────────────
// 本地腿四个 keyless flag(ADR-046 D1 / server.ts KEYLESS_WEBSEARCH_FLAGS)
const KEYLESS_FLAGS = ["OPENCODE_ENABLE_EXA", "OPENCODE_EXPERIMENTAL_EXA", "OPENCODE_ENABLE_PARALLEL", "OPENCODE_EXPERIMENTAL_PARALLEL"]
const CLOUD_URL = "https://alpha-cloud.tidelabs.click/mcp"
type State = { cell: string; killSwitch: boolean; loggedIn: boolean; note: string }
const STATES: State[] = [
  { cell: "logged-out-byok", killSwitch: false, loggedIn: false, note: "server.ts applyWebSearchSovereignty 非 kill-switch 分支:删两个 deny 信号、OPENCODE_ENABLE_EXA ??= 1;injection :417-420 删 ARM/DEF/SERVER,无 cloud 条目" },
  { cell: "logged-in-with-credit", killSwitch: false, loggedIn: true, note: "同上 + injection :386-391 SERVER/DEF 置位、:403-404 config.mcp.cloud = 真定义(enabled:true, {file:} 凭证);凭证文件本轮是占位串,云腿不在本票被测面(#1433 §6 已测)" },
  { cell: "logged-in-no-credit", killSwitch: false, loggedIn: true, note: "桌面侧与「有额度」不可分辨(ADR-046 D2:没有只读额度查询;webSearchToolDenial 不读任何额度轴)—— env 与上一格逐字相同,分开跑只为票面矩阵" },
  { cell: "kill-switch", killSwitch: true, loggedIn: true, note: "server.ts :358 ALPHA_CLOUD_WEBSEARCH_DENY=1、:362 四个 keyless flag=0、:367 ALPHA_LOCAL_WEBSEARCH_DENY=1;injection :401-402 config.mcp.cloud = WITHHELD、:409 ARM=cloud(ext 装载后换成真定义)" },
].filter((s) => !ONLY_CELL || s.cell === ONLY_CELL)

type Arm = { arm: string; server: string; toolName: string; kind: "remote" | "local"; expectClassified: boolean }
const ARMS: Arm[] = [
  { arm: "exa-remote", server: "exa", toolName: "web_search_exa", kind: "remote", expectClassified: true },
  { arm: "own-web_search", server: "duck", toolName: "web_search", kind: "local", expectClassified: true },
  { arm: "own-search", server: "duck", toolName: "search", kind: "local", expectClassified: false },
].filter((a) => !ONLY_ARM || a.arm === ONLY_ARM)

// 出网白名单:第三方插件的后端 + 模型目录;其余一切(含 registry.npmjs.org 与 alpha-cloud)拒
const ALLOW_HOSTS = new Set(["mcp.exa.ai", "html.duckduckgo.com", "duckduckgo.com", "models.opencode.ai"])

const promptFor = (id: string) =>
  `Use the tool named \`${id}\` to search the web for recent pages about the Bun JavaScript runtime, then list three results with their titles and URLs. ` +
  `Do not call any other tool. If \`${id}\` is not available to you, or calling it returns an error, say so explicitly, quote the error text you received, and stop.`

async function runCell(state: State, arm: Arm) {
  const engineToolId = `${arm.server}_${arm.toolName}` // McpCatalog.toolName: sanitize(server)+"_"+sanitize(tool);两边都是纯 ASCII
  const iso = realpathSync(mkdtempSync(join(SCRATCH, `ac1461-${state.cell}-${arm.arm}-`)))
  const home = join(iso, "home")
  const ws = join(iso, "ws")
  const globalRoot = join(iso, "alpha-code-state", "env", "dev")
  const secrets = join(iso, "secrets")
  const tmp = join(iso, "tmp")
  for (const d of [home, ws, globalRoot, secrets, tmp]) mkdirSync(d, { recursive: true })
  writeFileSync(join(ws, "README.md"), "ac1461 probe workspace\n")
  const tokenFile = join(secrets, "ALPHA_MCP_TOKEN")
  writeFileSync(tokenFile, "ac1461-placeholder-not-a-real-token\n")
  const trace = join(iso, "mcp-trace.jsonl")

  const exchanges: Exchange[] = []
  const rec = await startRecordingProxy(exchanges)
  const egressLog: EgressLogRecord[] = []
  const egress = await startEgressPolicyProxy({
    log: (r) => void egressLog.push(r),
    authorize: (host) => ALLOW_HOSTS.has(host),
    requestGrant: async () => "not-asked",
  })

  // ── 引擎配置(OPENCODE_CONFIG_CONTENT,与生产注入同一通道)──
  const thirdParty =
    arm.kind === "remote"
      ? { [arm.server]: { type: "remote", url: "https://mcp.exa.ai/mcp" } }
      : { [arm.server]: { type: "local", command: [process.execPath, mcpServerScript, "--tool", arm.toolName, "--trace", trace], timeout: 30000 } }
  const cloudDef = materializeCloudMcpConfig(CLOUD_URL, `{file:${tokenFile}}`)
  const mcp: Record<string, unknown> = { ...thirdParty }
  if (state.loggedIn) mcp[CLOUD_MCP_SERVER_NAME] = state.killSwitch ? { ...WITHHELD_CLOUD_MCP } : cloudDef
  const config: Record<string, any> = {
    $schema: "https://opencode.ai/config.json",
    plugin: [extBundle],
    model: `${PROVIDER_ID}/${MODEL}`,
    provider: { [PROVIDER_ID]: { npm: "@ai-sdk/openai-compatible", name: "ac1461 probe", options: { baseURL: `http://127.0.0.1:${rec.port}/v1`, apiKey: PLACEHOLDER }, models: { [MODEL]: { name: MODEL } } } },
    mcp,
    permission: { websearch: "allow", webfetch: "allow", bash: "deny", edit: "deny" },
  }
  const denyLines: string[] = []
  applyWebSearchDenies(config, { killSwitch: state.killSwitch, platformPays: state.loggedIn }, (m) => void denyLines.push(m))

  // ── 引擎 env ──
  const env: Record<string, string> = {
    PATH: process.env.PATH ?? "",
    HOME: home,
    TMPDIR: tmp,
    XDG_DATA_HOME: join(home, ".local", "share"),
    XDG_CONFIG_HOME: join(home, ".config"),
    XDG_CACHE_HOME: join(home, ".cache"),
    XDG_STATE_HOME: join(iso, "state"),
    OPENCODE_CONFIG_CONTENT: JSON.stringify(config),
    OPENCODE_DISABLE_AUTOUPDATE: "1",
    OPENCODE_DISABLE_PROJECT_CONFIG: "1",
    NO_COLOR: "1",
    ALPHA_GLOBAL_DIR: globalRoot,
    ALPHA_SECRETS_DISABLE: "1",
    ALPHA_EXT_VERBOSE: "1",
    ...sidecarEgressProxyEnv(egress.port),
  }
  if (state.killSwitch) {
    env[CLOUD_WEBSEARCH_DENY_ENV] = "1"
    for (const k of KEYLESS_FLAGS) env[k] = "0"
    env[LOCAL_WEBSEARCH_DENY_ENV] = "1"
  } else {
    env.OPENCODE_ENABLE_EXA = "1"
  }
  if (state.loggedIn) {
    env.ALPHA_CLOUD_MCP_URL = CLOUD_URL
    env[CLOUD_MCP_SERVER_ENV] = CLOUD_MCP_SERVER_NAME
    env[CLOUD_MCP_DEF_ENV] = JSON.stringify(cloudDef)
    if (state.killSwitch) env[CLOUD_MCP_ARM_ENV] = CLOUD_MCP_SERVER_NAME
  }

  const startedAt = Date.now()
  const stdoutChunks: string[] = []
  const stderrChunks: string[] = []
  const child = spawn(process.execPath, ["run", engineEntry, "run", "--format", "json", ...(NO_AUTO ? [] : ["--auto"]), "--dir", ws, "--model", `${PROVIDER_ID}/${MODEL}`, promptFor(engineToolId)], {
    cwd: enginePkg,
    env,
    stdio: ["ignore", "pipe", "pipe"],
    detached: true, // 自己的进程组:超时时整组杀,不留 MCP 子进程孤儿;不 pkill -f
  })
  child.stdout.setEncoding("utf8")
  child.stderr.setEncoding("utf8")
  child.stdout.on("data", (d) => stdoutChunks.push(d))
  child.stderr.on("data", (d) => stderrChunks.push(d))
  let timedOut = false
  const timer = setTimeout(() => {
    timedOut = true
    try {
      process.kill(-child.pid!, "SIGKILL")
    } catch {}
  }, 240_000)
  const exitCode = await new Promise<number | null>((r) => child.on("close", (c) => r(c)))
  clearTimeout(timer)
  try {
    process.kill(-child.pid!, "SIGKILL")
  } catch {}
  const wallMs = Date.now() - startedAt

  const events: any[] = []
  for (const line of stdoutChunks.join("").split("\n")) {
    const t = line.trim()
    if (!t.startsWith("{")) continue
    try {
      events.push(JSON.parse(t))
    } catch {}
  }
  const toolParts: any[] = []
  const walk = (v: any) => {
    if (!v || typeof v !== "object") return
    if (v.type === "tool" && v.tool)
      toolParts.push({
        tool: v.tool,
        callID: v.callID,
        status: v.state?.status,
        inputHead: JSON.stringify(v.state?.input ?? null).slice(0, 200),
        outputBytes: typeof v.state?.output === "string" ? v.state.output.length : 0,
        outputHead: typeof v.state?.output === "string" ? v.state.output.slice(0, 400) : "",
        errorHead: String(v.state?.error ?? "").slice(0, 500),
      })
    for (const k of Object.keys(v)) walk(v[k])
  }
  for (const e of events) walk(e)
  // 策略闸(AlphaToolPolicyGate,第三方 MCP 默认 ask —— packages/schema/src/alpha-tool-policy.ts classDefaultState)有没有真的问过:
  // `run --auto` 对 permission.asked 回 "once"(= 用户在弹窗上点「允许」),这里把问过的记下来,不然「没拦」与「没问」分不开。
  const permissionEvents = events
    .filter((e) => typeof e?.type === "string" && /permission/.test(e.type))
    .map((e) => ({ type: e.type, permission: e.properties?.permission ?? e.permission, patterns: e.properties?.patterns ?? e.patterns, tool: e.properties?.tool ?? e.tool, title: e.properties?.title ?? e.title }))
  const eventTypeHistogram: Record<string, number> = {}
  for (const e of events) if (typeof e?.type === "string") eventTypeHistogram[e.type] = (eventTypeHistogram[e.type] ?? 0) + 1
  const ownershipLine = (stdoutChunks.join("").match(/ownership[^\n]*\{"governed":[^\n]*/) ?? [""])[0].slice(-200)

  await rec.close()
  await egress.close()
  const mcpTrace = existsSync(trace)
    ? readFileSync(trace, "utf8")
        .split("\n")
        .filter(Boolean)
        .map((l) => {
          try {
            return JSON.parse(l)
          } catch {
            return { raw: l }
          }
        })
    : []
  const stderr = stderrChunks.join("")
  const stdout = stdoutChunks.join("")
  const all = stderr + "\n" + stdout
  // 引擎自己的 server log(Global.Path.log = XDG_DATA_HOME/opencode/log):删隔离树之前先把尾巴留下
  let engineServerLogTail = ""
  try {
    const { readdirSync, statSync } = await import("node:fs")
    const logDir = join(env.XDG_DATA_HOME!, "opencode", "log")
    const files = readdirSync(logDir).map((f) => join(logDir, f)).sort((a, b) => statSync(a).mtimeMs - statSync(b).mtimeMs)
    if (files.length) engineServerLogTail = readFileSync(files.at(-1)!, "utf8").slice(-6000)
  } catch {}
  rmSync(iso, { recursive: true, force: true })

  const offeredTools = exchanges.find((e) => e.requestToolNames)?.requestToolNames ?? []
  const modelToolCalls = exchanges.flatMap((e) => (e.responseToolCalls ?? []).map((c) => ({ exchange: e.n, ...c })))
  const toolResultsFedBack = exchanges.flatMap((e) => (e.toolResultMessages ?? []).map((m) => ({ exchange: e.n, ...m })))
  const thirdPartyParts = toolParts.filter((p) => p.tool === engineToolId)
  const egressConnects = egressLog
    .filter((r): r is Extract<EgressLogRecord, { event: "egress.connect" }> => r.event === "egress.connect")
    .map((r) => ({ host: r.host, port: r.port, verdict: r.verdict, reason: r.reason, status: r.status }))
  const egressSummary: Record<string, { allow: number; deny: number }> = {}
  for (const c of egressConnects) {
    const k = `${c.host}:${c.port}`
    egressSummary[k] ??= { allow: 0, deny: 0 }
    egressSummary[k][c.verdict]++
  }
  const sovereigntyHits = [...toolResultsFedBack.map((m) => m.head), ...thirdPartyParts.map((p) => p.errorHead + p.outputHead)].filter((s) => /kill switch|WebSearchSovereignty/i.test(s))

  return {
    cell: state.cell,
    arm: arm.arm,
    thirdParty: { server: arm.server, toolName: arm.toolName, engineToolId, kind: arm.kind, expectedClassifiedAsWebSearch: arm.expectClassified },
    stateNote: state.note,
    engineEnvSignals: { [LOCAL_WEBSEARCH_DENY_ENV]: env[LOCAL_WEBSEARCH_DENY_ENV] ?? null, [CLOUD_WEBSEARCH_DENY_ENV]: env[CLOUD_WEBSEARCH_DENY_ENV] ?? null, OPENCODE_ENABLE_EXA: env.OPENCODE_ENABLE_EXA ?? null, [CLOUD_MCP_SERVER_ENV]: env[CLOUD_MCP_SERVER_ENV] ?? null, [CLOUD_MCP_ARM_ENV]: env[CLOUD_MCP_ARM_ENV] ?? null, ALPHA_CLOUD_MCP_DEF_present: Boolean(env[CLOUD_MCP_DEF_ENV]) },
    configMcpServers: Object.fromEntries(Object.entries(mcp).map(([k, v]: [string, any]) => [k, { type: v.type, enabled: v.enabled ?? "(unset=on)", url: v.url ?? null }])),
    permissionDenies: Object.entries(config.permission).filter(([, v]) => v === "deny").map(([k]) => k),
    exitCode,
    timedOut,
    wallMs,
    autoApprove: !NO_AUTO,
    permissionRequestedLines: all.split("\n").filter((l) => /permission requested/.test(l)).map((l) => l.slice(0, 300)),
    extLoaded: /\[@alpha-code\/ext\] context injections/.test(all),
    extInstalledCloud: /cloud MCP server "cloud" installed/.test(all),
    modelCallCount: exchanges.length,
    // ① 模型手里有没有那个工具
    thirdPartyOfferedToModel: offeredTools.includes(engineToolId),
    websearchOfferedToModel: offeredTools.includes("websearch"),
    offeredTools,
    // ② 模型有没有真的调它
    modelCalledThirdParty: modelToolCalls.some((c) => c.name === engineToolId),
    modelToolCalls,
    // ③ 调用落在哪
    thirdPartyToolParts: thirdPartyParts,
    toolResultsFedBack,
    sovereigntyDenialSeen: sovereigntyHits.length > 0,
    sovereigntyHits: sovereigntyHits.map((s) => s.slice(0, 300)),
    permissionEvents,
    eventTypeHistogram,
    mcpOwnershipLine: ownershipLine,
    egressSummary,
    mcpTrace,
    engineToolParts: toolParts,
    assistantFinalTextHead: exchanges.at(-1)?.responseAssistantTextHead ?? "",
    exchanges,
    engineLogHead: (stderr.split("\n").filter((l) => /alpha-code|@alpha-code\/ext|mcp|MCP|plugin|error|Error|warn/.test(l)).slice(0, 40)).map((l) => l.slice(0, 300)),
    engineServerLogTail,
    stderrTail: stderr.slice(-2500),
    stdoutTail: stdout.slice(-800),
  }
}

const results: any[] = []
for (const state of STATES)
  for (const arm of ARMS) {
    const r = await runCell(state, arm)
    results.push(r)
    console.log(JSON.stringify({ cell: r.cell, arm: r.arm, id: r.thirdParty.engineToolId, exit: r.exitCode, timedOut: r.timedOut, ms: r.wallMs, ext: r.extLoaded, calls: r.modelCallCount, offered: r.thirdPartyOfferedToModel, called: r.modelCalledThirdParty, parts: r.thirdPartyToolParts.map((p: any) => p.status), denial: r.sovereigntyDenialSeen, asks: r.permissionEvents.length, own: r.mcpOwnershipLine.slice(-60), egress: r.egressSummary, trace: r.mcpTrace.length }))
    if (OUT) writeFileSync(OUT, JSON.stringify({ ticket: "alpha-code#1461", partial: true, at: new Date().toISOString(), results }, null, 2))
  }
const payload = {
  ticket: "alpha-code#1461",
  at: new Date().toISOString(),
  bun: Bun.version,
  provider: PROVIDER,
  model: MODEL,
  totalModelCalls: results.reduce((a, r) => a + r.modelCallCount, 0),
  credentialHygiene: "model key read from --keys-file into memory only; engine config carries a placeholder; ALPHA_MCP_TOKEN file is a placeholder string; nothing real lands in results/logs",
  egressPolicy: { allow: [...ALLOW_HOSTS], everythingElse: "deny (incl. registry.npmjs.org — ac#1454 root cause — and alpha-cloud.tidelabs.click: cloud leg not under test)" },
  results,
}
if (OUT) writeFileSync(OUT, JSON.stringify(payload, null, 2))
console.log("---RESULTS-JSON-WRITTEN---", OUT ?? "(stdout only)")
if (!OUT) console.log(JSON.stringify(payload, null, 2))
