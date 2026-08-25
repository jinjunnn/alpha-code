#!/usr/bin/env bun
// REQ-105 AC4 / alpha-code#1108 —— packaged 离线态经真实产品入口创建并复读 xlsx。
//
//   bun docs/verification/2026-08-25-req105-1108-packaged-offline-xlsx/run.ts \
//     --app <path-to-alpha-code.app> --mode offline|online [--out results/<name>.json]
//
// 三格:
//   C1 创建  —— packaged 构建 + 真实产品入口(main 的 MCP 写盘策略闸 → 引擎 local stdio
//               spawn → 真 agent 回合执行 write_xlsx),不是单测桩、不是直接调 MCP 二进制。
//   C2 复读  —— 由 read-xlsx-independent.py(stdlib zipfile+XML,**不用 openpyxl**)重开
//               断言单元格值/类型/结构;期望值来自 fixture/xlsx-contract.json 这份独立锚点。
//   C3 离线  —— 整个 app 进程树跑在 sandbox-exec 网络白名单里(只放行三个 loopback 端口),
//               同一 profile 里的对照探针必须证明外网(直连与本机代理两条路)都到不了。
//
// 唯一不是产品自己的部件:模型。离线态没有可用模型,所以本 runner 起一个 loopback 的
// OpenAI-compatible 桩,并经**产品自带的自定义模型服务入口**(providers.add,其校验器
// 明确放行 loopback http)注册。桩只负责"决定调哪个工具";从 agent 回合、工具注册表、
// MCP 客户端、stdio spawn 到 workspace 策略,全部是打包产品自己的代码。

import { spawn, spawnSync, type ChildProcess } from "node:child_process"
import { createServer } from "node:net"
import { existsSync, lstatSync, mkdtempSync, readFileSync, writeFileSync, mkdirSync } from "node:fs"
import { homedir, tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"
import { createHash } from "node:crypto"

const HERE = dirname(fileURLToPath(import.meta.url))
const CONTRACT_PATH = join(HERE, "fixture", "xlsx-contract.json")
const READER = join(HERE, "read-xlsx-independent.py")
const PROXY_PROBE = "http://127.0.0.1:7897" // machine-wide Clash Verge proxy (scutil --proxy)

type Check = { id: string; ok: boolean | null; detail: string }
const checks: Check[] = []
const record = (id: string, ok: boolean | null, detail: unknown) =>
  checks.push({ id, ok, detail: typeof detail === "string" ? detail : JSON.stringify(detail) })

function arg(name: string, fallback?: string) {
  const i = process.argv.indexOf(name)
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : fallback
}
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

const APP = arg("--app", join(HERE, "../../../packages/ui-mac/dist/mac-arm64/alpha-code.app"))!
const MODE = (arg("--mode", "offline") as "offline" | "online")!
const OUT = arg("--out", join(HERE, "results", `${MODE}.json`))!

async function freePort(): Promise<number> {
  return new Promise((res, rej) => {
    const s = createServer()
    s.on("error", rej)
    s.listen(0, "127.0.0.1", () => {
      const a = s.address()
      if (typeof a !== "object" || !a) return rej(new Error("no port"))
      const p = a.port
      s.close(() => res(p))
    })
  })
}

// ---------------------------------------------------------------- local model stub
function startStub(toolName: string, toolArguments: unknown, port: number) {
  const seen: any[] = []
  const server = Bun.serve({
    port,
    hostname: "127.0.0.1",
    async fetch(req) {
      const url = new URL(req.url)
      if (!url.pathname.endsWith("/chat/completions")) return new Response("{}", { status: 404 })
      const body: any = await req.json().catch(() => ({}))
      seen.push({
        at: new Date().toISOString(),
        toolNames: (body.tools ?? []).map((t: any) => t?.function?.name),
      })
      const msgs: any[] = Array.isArray(body.messages) ? body.messages : []
      const alreadyCalled = msgs.some((m) => m && m.role === "tool")
      const id = "chatcmpl-ac4-" + seen.length
      const created = Math.floor(Date.now() / 1000)
      const model = body.model ?? "ac4-model"
      const chunks: string[] = []
      const push = (delta: any, finish: string | null) =>
        chunks.push(
          "data: " +
            JSON.stringify({ id, object: "chat.completion.chunk", created, model, choices: [{ index: 0, delta, finish_reason: finish }] }) +
            "\n\n",
        )
      if (!alreadyCalled) {
        push({ role: "assistant", content: "" }, null)
        push({ tool_calls: [{ index: 0, id: "call_ac4", type: "function", function: { name: toolName, arguments: "" } }] }, null)
        push({ tool_calls: [{ index: 0, function: { arguments: JSON.stringify(toolArguments) } }] }, null)
        push({}, "tool_calls")
      } else {
        push({ role: "assistant", content: "" }, null)
        push({ content: "REQ105-AC4-DONE" }, null)
        push({}, "stop")
      }
      chunks.push("data: [DONE]\n\n")
      return new Response(chunks.join(""), { headers: { "content-type": "text/event-stream", "cache-control": "no-cache" } })
    },
  })
  return { url: `http://127.0.0.1:${port}/v1`, seen, stop: () => server.stop(true) }
}

// ---------------------------------------------------------------- CDP
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
  await new Promise<void>((res, rej) => {
    ws.onopen = () => res()
    ws.onerror = () => rej(new Error("cdp ws error"))
  })
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
        setTimeout(() => pending.has(myId) && (pending.delete(myId), rej(new Error("cdp timeout"))), 180_000)
      })
      if (r.exceptionDetails) throw new Error(`eval threw: ${r.exceptionDetails.exception?.description ?? "?"}`)
      return r.result?.value
    },
    close: () => ws.close(),
  }
}

// ---------------------------------------------------------------- main
const ENGINE_PORT = await freePort()
const CDP_PORT = await freePort()
const STUB_PORT = await freePort()

const contract = JSON.parse(readFileSync(CONTRACT_PATH, "utf8"))
const WS = mkdtempSync(join(tmpdir(), "req105-ac4-ws-"))
const XLSX = join(WS, contract.workbookFileName)
const stub = startStub(
  "alpha-excel_write_xlsx",
  { path: XLSX, sheets: contract.sheets },
  STUB_PORT,
)

// The profile is port-specific, so it is generated per run into $TMPDIR (never the repo);
// the exact text used is embedded verbatim in the run's results JSON.
const sandboxDir = mkdtempSync(join(tmpdir(), "req105-ac4-sbx-"))
const sandboxProfile = join(sandboxDir, "offline.sb")
writeFileSync(
  sandboxProfile,
  [
    "(version 1)",
    "(allow default)",
    ";; REQ-105 AC4: deny every network operation, then re-allow exactly three loopback ports",
    ";; (packaged engine / CDP / local model stub). Unix-domain sockets stay allowed because",
    ";; Chromium's process singleton needs one. This machine sends ALL egress through a loopback",
    ";; proxy (Clash Verge 127.0.0.1:7897), and macOS SBPL cannot deny a single loopback port,",
    ";; so a blanket loopback allow would hand the public internet straight back — hence the",
    ";; explicit per-port allow list, and the in-sandbox control probes below.",
    "(deny network*)",
    '(allow network* (local unix-socket))',
    '(allow network* (remote unix-socket))',
    '(allow network-bind (local ip "localhost:*"))',
    '(allow network-inbound (local ip "localhost:*"))',
    `(allow network-outbound (remote ip "localhost:${ENGINE_PORT}"))`,
    `(allow network-outbound (remote ip "localhost:${CDP_PORT}"))`,
    `(allow network-outbound (remote ip "localhost:${STUB_PORT}"))`,
    "",
  ].join("\n"),
)

function homeSnapshot() {
  const out: Record<string, unknown> = {}
  for (const p of [join(homedir(), ".alpha"), join(homedir(), ".config", "opencode"), join(homedir(), "Library", "Application Support", "com.tide.alphacode")]) {
    try {
      const st = lstatSync(p)
      out[p] = { exists: true, ino: st.ino, mtimeMs: st.mtimeMs }
    } catch {
      out[p] = { exists: false }
    }
  }
  return out
}

/** Same sandbox + same env as the app: does anything outside loopback answer? */
function egressProbe(label: string, extraArgs: string[]) {
  const base = ["/usr/bin/curl", "-sS", "--max-time", "10", "-o", "/dev/null", "-w", "%{http_code}", ...extraArgs]
  const argv = MODE === "offline" ? ["sandbox-exec", "-f", sandboxProfile, ...base] : base
  const r = spawnSync(argv[0], argv.slice(1), { encoding: "utf8" })
  return { label, code: (r.stdout || "").trim() || "000", stderr: (r.stderr || "").trim().slice(0, 160) }
}

const appExec = join(APP, "Contents/MacOS/alpha-code")
const serverPy = join(APP, "Contents/Resources/office-mcp/server.py")
const branchServerPy = join(HERE, "../../../packages/ui-mac/resources/office-mcp/server.py")
const sha = (p: string) => (existsSync(p) ? createHash("sha256").update(readFileSync(p)).digest("hex") : "MISSING")

const beforeHome = homeSnapshot()
let child: ChildProcess | undefined
const appLog: string[] = []

try {
  // ---- 被测件身份 ----
  record("packaged.executable", existsSync(appExec), appExec)
  record(
    "packaged.serverPyMatchesBranch",
    sha(serverPy) !== "MISSING" && sha(serverPy) === sha(branchServerPy),
    { packaged: sha(serverPy), branch: sha(branchServerPy) },
  )
  const plist = (k: string) =>
    spawnSync("/usr/libexec/PlistBuddy", ["-c", `Print :${k}`, join(APP, "Contents/Info.plist")], { encoding: "utf8" }).stdout.trim()
  record("packaged.bundle", plist("CFBundleIdentifier") === "com.tide.alphacode", {
    id: plist("CFBundleIdentifier"),
    version: plist("CFBundleShortVersionString"),
  })

  // ---- C3 对照探针:先证明这个手段能测出已知的坏 ----
  const direct = egressProbe("direct", ["https://pypi.org/simple/"])
  const viaProxy = egressProbe("system-proxy", ["-x", PROXY_PROBE, "https://pypi.org/simple/"])
  const catalogHost = egressProbe("catalog-host", ["https://alphacodeone.com/catalog/v1/channels/trust.json"])
  const blocked = direct.code === "000" && viaProxy.code === "000"
  record(
    MODE === "offline" ? "c3.egressBlocked" : "c3.egressReachable(control arm)",
    MODE === "offline" ? blocked : null,
    { direct, viaProxy, catalogHost, mode: MODE },
  )

  // ---- 启动打包应用 ----
  const launchArgs = [`--remote-debugging-port=${CDP_PORT}`, ...(MODE === "offline" ? ["--no-sandbox", "--disable-gpu"] : [])]
  const argv = MODE === "offline" ? ["sandbox-exec", "-f", sandboxProfile, appExec, ...launchArgs] : [appExec, ...launchArgs]
  child = spawn(argv[0], argv.slice(1), {
    env: { ...process.env, OPENCODE_TEST_ONBOARDING: "1", OPENCODE_PORT: String(ENGINE_PORT) },
    stdio: ["ignore", "pipe", "pipe"],
  })
  child.stdout?.on("data", (b) => appLog.push(b.toString()))
  child.stderr?.on("data", (b) => appLog.push(b.toString()))

  let cdpConn = await attach((await waitForCdp(CDP_PORT, 120_000))[0].webSocketDebuggerUrl)
  // `POST /global/dispose` is the product's own MCP reload step, and it makes the renderer
  // remount — which silently invalidates the attached execution context. Every eval therefore
  // re-attaches once on failure instead of reporting a bare "cdp timeout".
  const cdp = {
    async eval(expression: string) {
      try {
        return await cdpConn.eval(expression)
      } catch (first) {
        try { cdpConn.close() } catch {}
        cdpConn = await attach((await waitForCdp(CDP_PORT, 60_000))[0].webSocketDebuggerUrl)
        await sleep(1500)
        return await cdpConn.eval(expression)
      }
    },
    close: () => { try { cdpConn.close() } catch {} },
  }
  await sleep(8000)

  const onboardingRoot = (appLog.join("").match(/\/[\w./-]*opencode-onboarding-[0-9a-f-]+/) || [""])[0]
  const alphaJsonc = onboardingRoot ? join(onboardingRoot, "alpha-code-state/env/prod/alpha.jsonc") : ""
  record("isolation.onboardingRoot", !!onboardingRoot && onboardingRoot.includes("opencode-onboarding-"), onboardingRoot || "NOT FOUND")

  // Every engine call carries its own in-page timeout: a hung fetch inside the renderer would
  // otherwise burn the whole CDP budget and be reported as "cdp timeout" instead of as the
  // engine call that actually stalled.
  const api = (method: string, path: string, body?: unknown, timeoutMs = 60_000) => `(async () => {
    const init = await window.api.awaitInitialization()
    const h = { "content-type": "application/json" }
    if (init.username || init.password) h.Authorization = "Basic " + btoa((init.username||"") + ":" + (init.password||""))
    try {
      const r = await fetch(init.url + ${JSON.stringify(path)}, { method: ${JSON.stringify(method)}, headers: h, signal: AbortSignal.timeout(${timeoutMs})${body === undefined ? "" : `, body: ${JSON.stringify(JSON.stringify(body))}`} })
      const t = await r.text()
      try { return { status: r.status, body: JSON.parse(t) } } catch { return { status: r.status, body: t.slice(0, 600) } }
    } catch (e) { return { status: 0, body: null, error: String(e) } }
  })()`

  const init = await cdp.eval(`window.api.awaitInitialization()`)
  record("engine.portPinned", String(init?.url ?? "").endsWith(`:${ENGINE_PORT}`), init?.url)

  // ---- 产品入口 A:签名 catalog 安装(离线态按设计 fail-closed) ----
  const catalogInstall = await cdp.eval(
    `(async()=>{ try { return await window.api.ext.installCatalog({ catalogId:"mcp:alpha-excel", scope:{ scope:"global" } }) } catch(e){ return { threw:String(e) } } })()`,
  )
  record("entry.installCatalog", null, catalogInstall)

  // ---- 产品入口 B:main 侧 MCP 写盘策略闸(ext-persist-mcp → persistMcpWithPolicy) ----
  const persist = await cdp.eval(
    `(async()=>{ try { return await window.api.ext.persistMcp("alpha-excel", { type:"local", command:["uv","run","--no-project","--with","openpyxl==3.1.5","{alphaResources}/office-mcp/server.py","excel","{workspace}"], enabled:true }, []) } catch(e){ return { threw:String(e) } } })()`,
  )
  record("entry.persistMcp", persist?.ok === true, persist)

  // ---- 落盘身份断言:{alphaResources} 必须解析到**这一个** .app,{workspace} 必须原样保留 ----
  let durable: any = null
  if (alphaJsonc && existsSync(alphaJsonc)) {
    durable = JSON.parse(readFileSync(alphaJsonc, "utf8").replace(/,(\s*[}\]])/g, "$1"))
  }
  const cmd: string[] = durable?.mcp?.["alpha-excel"]?.command ?? []
  const expectedCmd = ["uv", "run", "--no-project", "--with", "openpyxl==3.1.5", serverPy, "excel", "{workspace}"]
  record("durable.commandExact", JSON.stringify(cmd) === JSON.stringify(expectedCmd), { got: cmd, want: expectedCmd })
  record("durable.workspaceMarkerKept", cmd[cmd.length - 1] === "{workspace}", cmd[cmd.length - 1])
  record("durable.resourcesUnderThisApp", cmd.some((a) => a === serverPy), serverPy)

  // ---- 引擎按 local stdio 真起进程 ----
  // Reload the engine the way the product itself does on a config change: `providers.add`
  // drives main's shared sidecar respawn, and the fresh fork reads the durable MCP config.
  // (`POST /global/dispose` — reloadInstalledMcp's route — remounts the renderer under this
  // harness and was not usable here; see README "未验证项".)
  const addProvider = await cdp.eval(
    `(async()=>{ try { return await window.api.providers.add({ id:"ac4stub", name:"AC4 offline stub", compat:"openai", baseURL:${JSON.stringify(stub.url)}, apiKey:"ac4-stub-key", models:["ac4-model"] }) } catch(e){ return { threw:String(e) } } })()`,
  )
  record("model.providerAdded", addProvider?.ok === true, addProvider)

  // The connect itself runs `uv run --with openpyxl==3.1.5` for real, so poll rather than
  // assume a fixed settle time. Engine liveness is probed straight from the harness so a
  // stalled renderer cannot be misreported as a stalled engine.
  const engineHealth = async () => {
    try {
      const r = await fetch(`http://127.0.0.1:${ENGINE_PORT}/global/health`, { signal: AbortSignal.timeout(5000) })
      return String(r.status)
    } catch (e) {
      return `ERR ${String(e).slice(0, 60)}`
    }
  }
  // The MCP child is short-lived-invisible if you only sample once at the end, so sample the
  // process table on every poll and keep every sighting.
  const sightings: string[] = []
  const samplePs = () => {
    const ps = spawnSync("/bin/ps", ["-Ao", "pid,command"], { encoding: "utf8" }).stdout ?? ""
    for (const line of ps.split("\n")) {
      if (line.includes("office-mcp/server.py") && line.includes(APP)) {
        const t = line.trim()
        if (!sightings.includes(t)) sightings.push(t)
      }
    }
  }
  const waitConnected = async (budgetMs: number) => {
    const deadline = Date.now() + budgetMs
    let last: any = null
    for (;;) {
      samplePs()
      last = await cdp.eval(api("GET", `/mcp?directory=${encodeURIComponent(WS)}`, undefined, 25_000))
      samplePs()
      if (last?.body?.["alpha-excel"]?.status === "connected") return { ok: true, last, health: await engineHealth() }
      if (Date.now() > deadline) return { ok: false, last, health: await engineHealth() }
      await sleep(5000)
    }
  }
  const conn1 = await waitConnected(240_000)
  record("engine.mcpConnected", conn1.ok, { status: conn1.last?.body ?? conn1.last, engineHealth: conn1.health })
  record("engine.spawnedPackagedServer", sightings.length > 0, sightings.slice(0, 3))

  // ---- C1:真实会话回合执行 write_xlsx ----
  const session = await cdp.eval(api("POST", `/session?directory=${encodeURIComponent(WS)}`, { title: "REQ-105 AC4" }))
  const sid = session?.body?.id
  record("session.created", !!sid, { id: sid, directory: session?.body?.directory })
  let prompt: any = null
  if (sid) {
    prompt = await cdp.eval(
      api(
        "POST",
        `/session/${sid}/message?directory=${encodeURIComponent(WS)}`,
        {
          model: { providerID: "ac4stub", modelID: "ac4-model" },
          agent: "build",
          parts: [{ type: "text", text: "Create the REQ-105 AC4 workbook with the Alpha Excel connector." }],
        },
        180_000,
      ),
    )
  }
  // The prompt response carries only the LAST assistant message; the tool step lives in the
  // previous one. Read the whole transcript back from the engine instead of asserting on the
  // reply that happens to be in hand.
  const transcript = sid ? await cdp.eval(api("GET", `/session/${sid}/message?directory=${encodeURIComponent(WS)}`, undefined, 30_000)) : null
  const allParts = (Array.isArray(transcript?.body) ? transcript.body : []).flatMap((m: any) => m?.parts ?? []) as any[]
  record("session.promptParts", null, allParts.map((p: any) => ({ type: p.type, tool: p.tool, status: p.state?.status })))
  const toolParts = allParts.filter((p: any) => p.type === "tool")
  record("c1.toolExposedToModel", stub.seen.some((s) => (s.toolNames ?? []).includes("alpha-excel_write_xlsx")), stub.seen[0]?.toolNames?.filter?.((n: string) => n.startsWith("alpha-")) ?? [])
  const writePart = toolParts.find((p: any) => p.tool === "alpha-excel_write_xlsx")
  record(
    "c1.toolExecuted",
    !!writePart && writePart.state?.status === "completed" && JSON.stringify(writePart.state?.output ?? writePart.state ?? "").includes("sheetsUpdated"),
    { tool: writePart?.tool, status: writePart?.state?.status, output: JSON.stringify(writePart?.state?.output ?? "").slice(0, 300), error: writePart?.state?.error },
  )
  record("c1.toolInputWorkspaceScoped", !!writePart && String(JSON.stringify(writePart.state?.input ?? "")).includes(WS), JSON.stringify(writePart?.state?.input ?? "").slice(0, 260))
  record("c1.xlsxCreatedInWorkspace", existsSync(XLSX), { path: XLSX, workspace: WS })

  // ---- C2:独立读取路径 ----
  const readerOut = join(HERE, "results", `${MODE}-independent-read.json`)
  const reader = spawnSync("python3", [READER, "--xlsx", XLSX, "--contract", CONTRACT_PATH, "--json-out", readerOut], { encoding: "utf8" })
  const readerJson = (() => { try { return JSON.parse(reader.stdout) } catch { return { ok: false, checks: [], raw: reader.stdout.slice(0, 400) } } })()
  record("c2.independentReadBack", reader.status === 0 && readerJson.ok === true, {
    exit: reader.status,
    red: (readerJson.checks ?? []).filter((c: any) => !c.ok).map((c: any) => `${c.id}: ${c.detail}`),
    checkCount: (readerJson.checks ?? []).length,
  })

  record("isolation.realHomeUntouched", JSON.stringify(homeSnapshot()) === JSON.stringify(beforeHome), { before: beforeHome, after: homeSnapshot() })
  cdp.close()
} catch (e) {
  record("runner.fatal", false, String(e))
} finally {
  stub.stop()
  try { child?.kill("SIGTERM") } catch {}
  await sleep(1500)
  spawnSync("/usr/bin/pkill", ["-f", `remote-debugging-port=${CDP_PORT}`])

  const result = {
    ticket: "jinjunnn/alpha-code#1108",
    ac: "alpha-work#7 AC4",
    mode: MODE,
    at: new Date().toISOString(),
    gitSha: spawnSync("git", ["rev-parse", "HEAD"], { cwd: HERE, encoding: "utf8" }).stdout.trim(),
    app: APP,
    workspace: WS,
    xlsx: XLSX,
    ports: { engine: ENGINE_PORT, cdp: CDP_PORT, stub: STUB_PORT },
    sandboxProfile: MODE === "offline" ? readFileSync(sandboxProfile, "utf8") : null,
    stubRequests: stub.seen.length,
    checks,
    appLogTail: appLog.join("").split("\n").slice(-250),
  }
  mkdirSync(dirname(OUT), { recursive: true })
  writeFileSync(OUT, JSON.stringify(result, null, 2) + "\n")
  const red = checks.filter((c) => c.ok === false)
  const info = checks.filter((c) => c.ok === null)
  for (const c of checks) console.log(`${c.ok === null ? "INFO" : c.ok ? "PASS" : "FAIL"}  ${c.id}  ${c.detail.slice(0, 220)}`)
  console.log(`\n=> ${checks.length - red.length - info.length} pass / ${red.length} fail / ${info.length} info  -> ${OUT}`)
  process.exit(red.length ? 1 : 0)
}
