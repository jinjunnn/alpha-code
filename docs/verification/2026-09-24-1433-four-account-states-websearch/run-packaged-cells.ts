#!/usr/bin/env bun
// alpha-code#1433 (REQ-1414 VERIFY-1) —— **打包实例**上我自己跑得到的两格:登出/BYOK 与 kill-switch。
//
//   bun docs/verification/2026-09-24-1433-four-account-states-websearch/run-packaged-cells.ts \
//     --app <path>/Code\ Puppy.app --cell logged-out-byok|kill-switch \
//     --keys-file <abs> --provider deepseek --model deepseek-flash --out results/<name>.json
//
// 两个登录格**不在这个 runner 的能力范围内**:隔离实例必须带 `--use-mock-keychain`(否则会去动
// owner 真钥匙串),而 mock keychain 下拿不到登录凭证 ⇒ 打包隔离实例里只存在这两态。
//
// 本 runner 派生自 docs/verification/2026-08-27-req138-1144-real-model-chain/run-real.ts,
// 沿用它的四件:①孤儿进程枚举 + CDP 端口归属断言;②透明记录代理(真 key 只在代理内存里);
// ③产品自带的 `window.api.providers.add` 注册入口(未改生产代码);④隔离配方(#1323 §2.1–2.3)。
//
// **隔离硬闸**:boot 日志里读不到 `onboardingTest: true` ⇒ 立刻杀进程并中止。owner 的正式实例
// 此刻可能正在跑,而 `#1323` 的教训是取证实例会把 owner 的配置重锚到一个临时目录。

import { spawn, spawnSync, type ChildProcess } from "node:child_process"
import { createServer as createNetServer } from "node:net"
import { createServer as createHttpServer } from "node:http"
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs"
import { homedir } from "node:os"
import { join } from "node:path"

function arg(name: string, fallback?: string) {
  const i = process.argv.indexOf(`--${name}`)
  return i >= 0 && process.argv[i + 1] && !process.argv[i + 1]!.startsWith("--") ? process.argv[i + 1]! : fallback
}
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

const APP = arg("app")!
const CELL = arg("cell", "logged-out-byok")!
const KEYS_FILE = arg("keys-file")!
const PROVIDER = arg("provider", "deepseek")!
const MODEL = arg("model", "deepseek-flash")!
const OUT = arg("out")
if (!APP || !KEYS_FILE) throw new Error("--app and --keys-file are required")

const UPSTREAM: Record<string, { url: string; keyEnv: string }> = {
  deepseek: { url: "https://api.deepseek.com/v1", keyEnv: "DEEPSEEK_API_KEY" },
  zhipuai: { url: "https://open.bigmodel.cn/api/paas/v4", keyEnv: "ZHIPU_API_KEY" },
}
const up = UPSTREAM[PROVIDER]!
const KEY = (() => {
  for (const line of readFileSync(KEYS_FILE, "utf8").split("\n")) {
    const eq = line.indexOf("=")
    if (eq > 0 && line.slice(0, eq).trim() === up.keyEnv) return line.slice(eq + 1).trim()
  }
  throw new Error(`${up.keyEnv} not in keys file`)
})()
const PLACEHOLDER = "ac1433-placeholder-not-a-real-key"

const PROMPT =
  "Find three distinct web pages, on three different domains, that discuss the Bun JavaScript runtime and were published recently. For each one give the page title and its URL."

// ── 进程枚举 ─────────────────────────────────────────────────────────────────
function psTable() {
  const out = spawnSync("/bin/ps", ["-Ao", "pid=,ppid=,command="], { encoding: "utf8" }).stdout ?? ""
  return out.split("\n").map((l) => l.trim()).filter(Boolean).map((l) => {
    const m = /^(\d+)\s+(\d+)\s+(.*)$/.exec(l)
    return m ? { pid: Number(m[1]), ppid: Number(m[2]), cmd: m[3]! } : null
  }).filter(Boolean) as Array<{ pid: number; ppid: number; cmd: string }>
}
const ourAppProcesses = () => psTable().filter((p) => p.cmd.includes(`${APP}/Contents/MacOS/`))
function descendants(root: number) {
  const rows = psTable()
  const set = new Set([root])
  for (let grew = true; grew; ) {
    grew = false
    for (const r of rows) if (set.has(r.ppid) && !set.has(r.pid)) (set.add(r.pid), (grew = true))
  }
  return set
}
const listenersOn = (port: number) =>
  ((spawnSync("/usr/sbin/lsof", ["-nP", `-iTCP:${port}`, "-sTCP:LISTEN", "-t"], { encoding: "utf8" }).stdout) ?? "")
    .split("\n").map((s) => s.trim()).filter(Boolean).map(Number)

async function freePort(): Promise<number> {
  return new Promise((res) => {
    const s = createNetServer()
    s.listen(0, "127.0.0.1", () => {
      const p = (s.address() as any).port
      s.close(() => res(p))
    })
  })
}

// ── 透明记录代理 ─────────────────────────────────────────────────────────────
type Exchange = { n: number; status?: number; requestToolNames?: string[]; toolResultMessages?: { bytes: number; head: string }[]; responseToolCalls?: { name?: string; argsHead: string; id?: string }[]; responseTextHead?: string }
function startProxy(port: number) {
  const calls: Exchange[] = []
  let n = 0
  const server = createHttpServer(async (req, res) => {
    const chunks: Buffer[] = []
    for await (const c of req) chunks.push(c as Buffer)
    const body = Buffer.concat(chunks)
    const ex: Exchange = { n: ++n }
    try {
      const j = JSON.parse(body.toString("utf8"))
      if (Array.isArray(j.tools)) ex.requestToolNames = j.tools.map((t: any) => t?.function?.name ?? t?.name).filter(Boolean)
      if (Array.isArray(j.messages))
        ex.toolResultMessages = j.messages.filter((m: any) => m?.role === "tool").map((m: any) => {
          const c = typeof m.content === "string" ? m.content : JSON.stringify(m.content)
          return { bytes: c?.length ?? 0, head: (c ?? "").slice(0, 300) }
        })
    } catch {}
    try {
      const r = await fetch(`${up.url}${(req.url ?? "/").replace(/^\/v1/, "")}`, {
        method: req.method ?? "POST",
        headers: { "content-type": "application/json", accept: "application/json, text/event-stream", "accept-encoding": "identity", authorization: `Bearer ${KEY}` },
        body: body.byteLength ? body : undefined,
      })
      const buf = Buffer.from(await r.arrayBuffer())
      ex.status = r.status
      const calls2 = new Map<number, { id?: string; name?: string; args: string }>()
      let text = ""
      const eat = (p: string) => {
        try {
          const j = JSON.parse(p)
          for (const ch of j.choices ?? []) {
            const d = ch?.delta ?? ch?.message
            if (!d) continue
            if (typeof d.content === "string") text += d.content
            for (const tc of d.tool_calls ?? []) {
              const i = tc.index ?? 0
              const cur = calls2.get(i) ?? { args: "" }
              if (tc.id) cur.id = tc.id
              if (tc.function?.name) cur.name = (cur.name ?? "") + tc.function.name
              if (tc.function?.arguments) cur.args += tc.function.arguments
              calls2.set(i, cur)
            }
          }
        } catch {}
      }
      const t = buf.toString("utf8")
      if (t.trim().startsWith("{")) eat(t)
      for (const line of t.split("\n")) if (line.startsWith("data: ")) { const p = line.slice(6).trim(); if (p && p !== "[DONE]") eat(p) }
      ex.responseToolCalls = [...calls2.values()].map((c) => ({ id: c.id, name: c.name, argsHead: c.args.slice(0, 200) }))
      ex.responseTextHead = text.slice(0, 400)
      calls.push(ex)
      res.writeHead(r.status, { "content-type": r.headers.get("content-type") ?? "application/json" })
      res.end(buf)
    } catch (e) {
      ex.status = -1
      calls.push(ex)
      res.writeHead(502); res.end("proxy failure")
    }
  })
  server.listen(port, "127.0.0.1")
  return { calls, url: `http://127.0.0.1:${port}/v1`, close: () => server.close() }
}

// ── CDP ──────────────────────────────────────────────────────────────────────
async function waitForCdp(port: number, timeoutMs: number) {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    try {
      const r = await fetch(`http://127.0.0.1:${port}/json/list`, { signal: AbortSignal.timeout(2000) })
      if (r.ok) {
        const pages = ((await r.json()) as any[]).filter((t) => t.type === "page" && t.webSocketDebuggerUrl)
        if (pages.length) return pages
      }
    } catch {}
    if (Date.now() > deadline) throw new Error(`no CDP page on :${port}`)
    await sleep(500)
  }
}
async function attach(wsUrl: string) {
  const ws = new WebSocket(wsUrl)
  await new Promise<void>((res, rej) => { ws.onopen = () => res(); ws.onerror = () => rej(new Error("cdp ws error")) })
  let id = 0
  const pending = new Map<number, { res: (v: any) => void; rej: (e: any) => void }>()
  ws.onmessage = (ev) => {
    const msg = JSON.parse(String(ev.data))
    const p = msg.id && pending.get(msg.id)
    if (!p) return
    pending.delete(msg.id)
    msg.error ? p.rej(new Error(JSON.stringify(msg.error))) : p.res(msg.result)
  }
  return {
    async eval(expression: string) {
      const myId = ++id
      const r = await new Promise<any>((res, rej) => {
        pending.set(myId, { res, rej })
        ws.send(JSON.stringify({ id: myId, method: "Runtime.evaluate", params: { expression, awaitPromise: true, returnByValue: true } }))
        setTimeout(() => pending.has(myId) && (pending.delete(myId), rej(new Error("cdp timeout"))), 300_000)
      })
      if (r.exceptionDetails) throw new Error(`eval threw: ${r.exceptionDetails.exception?.description ?? "?"}`)
      return r.result?.value
    },
    close: () => ws.close(),
  }
}

// ── 真 HOME 六哨兵(#1323 §2.3) ──────────────────────────────────────────────
const SENTINELS = [
  join(homedir(), "Library/Application Support/ai.opencode.desktop"),
  join(homedir(), "Library/Application Support/alpha-code-state/env/prod"),
  join(homedir(), ".npm"),
  join(homedir(), ".config/opencode"),
  join(homedir(), ".local/share/opencode"),
  join(homedir(), "code-puppy"),
]
const sentinelMtimes = () => Object.fromEntries(SENTINELS.map((p) => [p, existsSync(p) ? statSync(p).mtimeMs : null]))

// ── 开跑 ─────────────────────────────────────────────────────────────────────
const identity: Record<string, unknown> = { ticket: "alpha-code#1433", cell: CELL, app: APP, at: new Date().toISOString() }
const probes: { id: string; ok: boolean; detail: unknown }[] = []
const push = (id: string, ok: boolean, detail: unknown) => probes.push({ id, ok, detail })

// 孤儿清理:跨轮次存活的打包实例会让你连到另一个二进制(本仓陷阱)
const orphansBefore = ourAppProcesses()
for (const p of orphansBefore) { try { process.kill(p.pid, "SIGKILL") } catch {} }
push("identity.orphansKilledBeforeRun", true, { orphansBefore })

const CDP_PORT = await freePort()
const PROXY_PORT = await freePort()
const proxy = startProxy(PROXY_PORT)

const ISO = mkdtempSync(join(homedir(), `.ac1433-${CELL}-`))
const ISO_HOME = join(ISO, "home")
const ISO_TMP = join(ISO, "tmp")
mkdirSync(ISO_HOME, { recursive: true }); mkdirSync(ISO_TMP, { recursive: true })
// #1323 §2.2 的两条必须一起做，缺一个就起不来：
//   · 启动 env 的 TMPDIR=<ISO>/tmp 让 **onboarding 根**落在真 HOME 之下（os.tmpdir() 读它）；
//   · 隔离 HOME 的 .zshrc 导出**生产的那个** /var/folders/…/T/ —— preferAppEnv 会同步探测登录
//     shell 并按「真 export 赢」合并，于是 **sidecar 看到的 $TMPDIR 仍是围栏 W12 那个路径**。
// 实测（本轮第一版只写了个空 .zshrc）：sidecar 在 mkdir $TMPDIR/opencode 上 **EPERM**（围栏拒），
// sidecar spawn failed before health handshake，主窗口从不创建 ⇒ CDP /json/list 恒 []。
// 那个症状看起来像「ad-hoc 签名把 app 弄坏了」，实际上是隔离配方少了一行。
// 文件本身仍必须存在（#1323 陷阱 6：空 HOME 会起 zsh-newuser-install 向导等键盘）。
const REAL_TMPDIR = (spawnSync("/usr/bin/getconf", ["DARWIN_USER_TEMP_DIR"], { encoding: "utf8" }).stdout ?? "").trim()
if (!REAL_TMPDIR) throw new Error("cannot resolve the production TMPDIR (getconf DARWIN_USER_TEMP_DIR)")
writeFileSync(join(ISO_HOME, ".zshrc"), `export TMPDIR="${REAL_TMPDIR}"\n`)
const WS = join(ISO, "ws"); mkdirSync(WS, { recursive: true })
writeFileSync(join(WS, "README.md"), "ac1433 packaged probe workspace\n")

identity.sentinelsBefore = sentinelMtimes()
identity.isoRoot = ISO
identity.realTmpdirExportedInZshrc = REAL_TMPDIR

const cellEnv: Record<string, string> = CELL === "kill-switch" ? { ALPHA_WEBSEARCH_DISABLE: "1" } : {}
identity.cellEnv = cellEnv

const APP_EXEC = join(APP, "Contents/MacOS/Code Puppy")
const launchFlags = [`--remote-debugging-port=${CDP_PORT}`, "--use-mock-keychain"]
identity.launchFlags = launchFlags
const appLog: string[] = []
let child: ChildProcess | undefined
let result: Record<string, unknown> = {}

try {
  child = spawn(APP_EXEC, launchFlags, {
    env: { PATH: process.env.PATH ?? "", HOME: ISO_HOME, TMPDIR: ISO_TMP, OPENCODE_TEST_ONBOARDING: "1", OPENCODE_CHANNEL: "prod", NO_COLOR: "1", ...cellEnv },
    stdio: ["ignore", "pipe", "pipe"],
  })
  child.stdout?.setEncoding("utf8"); child.stderr?.setEncoding("utf8")
  child.stdout?.on("data", (d) => appLog.push(d))
  child.stderr?.on("data", (d) => appLog.push(d))

  const pages = await waitForCdp(CDP_PORT, 120_000)
  const cdp = await attach(pages[0].webSocketDebuggerUrl)
  await sleep(4000)

  // 隔离硬闸:读不到 onboardingTest:true 就中止(owner 的正式实例可能正在跑)
  const bootLine = appLog.join("").split("\n").find((l) => l.includes("app starting")) ?? ""
  identity.appStartingLine = bootLine
  const isolated = /onboardingTest:\s*true/.test(bootLine)
  const packaged = /packaged:\s*true/.test(bootLine)
  push("identity.isolationActive", isolated, { bootLine })
  push("identity.appIsPackaged", packaged, { bootLine })
  if (!isolated) throw new Error(`ISOLATION GUARD: onboardingTest:true not observed in boot log — aborting before touching anything. line=${JSON.stringify(bootLine)}`)

  const cdpPids = listenersOn(CDP_PORT)
  const kin = descendants(child.pid!)
  push("identity.cdpPortOwnedByOurApp", cdpPids.length > 0 && cdpPids.every((p) => kin.has(p)), { cdpPids, ourPid: child.pid, appProcesses: ourAppProcesses() })

  let init = await cdp.eval(`window.api.awaitInitialization()`)
  const authHeader = () => (init?.username || init?.password ? "Basic " + Buffer.from(`${init.username ?? ""}:${init.password ?? ""}`).toString("base64") : undefined)
  const api = async (method: string, path: string, body?: unknown, timeoutMs = 300_000) => {
    const headers: Record<string, string> = { "content-type": "application/json" }
    const a = authHeader(); if (a) headers.Authorization = a
    const r = await fetch(String(init.url) + path, { method, headers, signal: AbortSignal.timeout(timeoutMs), ...(body === undefined ? {} : { body: JSON.stringify(body) }) })
    const t = await r.text()
    try { return { status: r.status, body: JSON.parse(t) } } catch { return { status: r.status, body: t.slice(0, 1200) } }
  }
  identity.engineUrl = init?.url

  const providerID = "ac1433probe"
  const added = await cdp.eval(`(async()=>{ try { return await window.api.providers.add({ id:${JSON.stringify(providerID)}, name:"AC1433 probe (recorded)", compat:"openai", baseURL:${JSON.stringify(proxy.url)}, apiKey:${JSON.stringify(PLACEHOLDER)}, models:[${JSON.stringify(MODEL)}] }) } catch(e){ return { threw:String(e) } } })()`)
  push("setup.providerAdded", added?.ok === true, { added, proxyUrl: proxy.url, model: MODEL })
  await sleep(5000)
  init = await cdp.eval(`window.api.awaitInitialization()`)

  const dq = `?directory=${encodeURIComponent(WS)}`

  // 模型无关的那一半：**这一格的引擎真的把哪些工具交给模型**。
  // 它不需要模型凭证、不花钱，而且量的是**打包实例**里由真 `applyWebSearchSovereignty`
  // + 真注入 + 真围栏算出来的那张表（#1411/#1431 是在单测里算的）。
  const toolIDs = await api("GET", `/experimental/tool/ids${dq}`)
  const toolListProbe: Record<string, unknown> = {}
  for (const pm of [["deepseek", "deepseek-flash"], ["alpha", "deepseek-v4-flash"], ["alpha", "claude-sonnet-5"], ["opencode", "claude-sonnet-4-5"], ["ac1433probe", MODEL]] as const) {
    const r = await api("GET", `/experimental/tool?directory=${encodeURIComponent(WS)}&provider=${encodeURIComponent(pm[0])}&model=${encodeURIComponent(pm[1])}`)
    toolListProbe[`${pm[0]}/${pm[1]}`] = {
      status: r.status,
      names: Array.isArray(r.body) ? (r.body as any[]).map((t) => t?.id ?? t?.name).filter(Boolean) : undefined,
      bodyHead: Array.isArray(r.body) ? undefined : JSON.stringify(r.body).slice(0, 300),
    }
  }
  identity.toolIDs = { status: toolIDs.status, ids: toolIDs.body }
  identity.toolListByProviderModel = toolListProbe

  if (added?.ok !== true) {
    // 没有 provider 就跑不了模型回合。这不是“没测到”，是**测出了一件事**：见 README §7。
    result = {
      cell: CELL,
      blocked: "providers.add rejected the recording proxy base URL",
      providerAddRejection: added,
      toolIDs: identity.toolIDs,
      toolListByProviderModel: toolListProbe,
      modelCallCount: 0,
    }
    cdp.close()
    throw new Error("__EARLY_DONE__")
  }
  const agents = await api("GET", `/agent${dq}`)
  const agentName = (Array.isArray(agents.body) && (agents.body as any[]).find((a) => a?.name === "build")?.name) || (Array.isArray(agents.body) ? (agents.body as any[])[0]?.name : undefined) || "build"
  const session = await api("POST", `/session${dq}`, { title: `alpha-code#1433 ${CELL}` })
  const sid = (session.body as any)?.id
  if (!sid) throw new Error(`no session: ${JSON.stringify(session).slice(0, 400)}`)
  identity.sessionID = sid

  const sent = await api("POST", `/session/${sid}/message${dq}`, { model: { providerID, modelID: MODEL }, agent: agentName, parts: [{ type: "text", text: PROMPT }] }, 300_000)
  const transcript = await api("GET", `/session/${sid}/message${dq}`, undefined, 60_000)

  const toolParts: any[] = []
  const walk = (v: any) => {
    if (!v || typeof v !== "object") return
    if (v.type === "tool" && v.tool) toolParts.push({ tool: v.tool, callID: v.callID, status: v.state?.status, inputHead: JSON.stringify(v.state?.input ?? null).slice(0, 200), outputBytes: typeof v.state?.output === "string" ? v.state.output.length : 0, outputHead: typeof v.state?.output === "string" ? v.state.output.slice(0, 300) : "", errorHead: String(v.state?.error ?? "").slice(0, 400) })
    for (const k of Object.keys(v)) walk(v[k])
  }
  walk(transcript.body)

  const offeredTools = proxy.calls.find((e) => e.requestToolNames)?.requestToolNames ?? []
  const modelToolCalls = proxy.calls.flatMap((e) => (e.responseToolCalls ?? []).map((c) => ({ exchange: e.n, ...c })))
  result = {
    cell: CELL,
    sentStatus: sent.status,
    modelCallCount: proxy.calls.length,
    offeredTools,
    websearchOfferedToModel: offeredTools.includes("websearch"),
    modelEmittedWebsearchCall: modelToolCalls.some((c) => c.name === "websearch"),
    modelToolCalls,
    toolResultsFedBack: proxy.calls.flatMap((e) => (e.toolResultMessages ?? []).map((m) => ({ exchange: e.n, ...m }))),
    engineToolParts: toolParts,
    exchanges: proxy.calls,
    finalAssistantTextHead: proxy.calls[proxy.calls.length - 1]?.responseTextHead ?? "",
  }
  cdp.close()
} catch (e) {
  if (!String(e).includes("__EARLY_DONE__")) result = { cell: CELL, fatal: String(e).slice(0, 800), ...(result as object) }
} finally {
  identity.appLogTail = appLog.join("").slice(-4000)
  if (child?.pid) { try { for (const p of descendants(child.pid)) process.kill(p, "SIGKILL") } catch {} }
  await sleep(1500)
  proxy.close()
  identity.orphansAfter = ourAppProcesses()
  identity.sentinelsAfter = sentinelMtimes()
  identity.sentinelsUnchanged = JSON.stringify(identity.sentinelsBefore) === JSON.stringify(identity.sentinelsAfter)
  // owner 正式配置有没有被重锚(#1323 的那条规矩)
  const ownerCfg = join(homedir(), "Library/Application Support/alpha-code-state/env/prod/alpha.jsonc")
  identity.ownerConfigWorktreeHits = existsSync(ownerCfg) ? (readFileSync(ownerCfg, "utf8").match(/worktrees/g) ?? []).length : "no-file"
  try { rmSync(ISO, { recursive: true, force: true }) } catch {}
}

const payload = { ...identity, probes, result }
if (OUT) writeFileSync(OUT, JSON.stringify(payload, null, 2))
console.log(JSON.stringify({ cell: CELL, probes: probes.map((p) => [p.id, p.ok]), summary: { fatal: (result as any).fatal, modelCalls: (result as any).modelCallCount, offered: (result as any).offeredTools?.length, websearchOffered: (result as any).websearchOfferedToModel, websearchCalled: (result as any).modelEmittedWebsearchCall, toolParts: (result as any).engineToolParts?.length }, sentinelsUnchanged: identity.sentinelsUnchanged, ownerConfigWorktreeHits: identity.ownerConfigWorktreeHits }))
console.log("---RESULTS-JSON---")
console.log(JSON.stringify(payload, null, 2))
