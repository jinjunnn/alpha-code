#!/usr/bin/env bun
// REQ-137 / alpha-code#1334 —— 网络轴在**新接缝**(整进程围栏)上的重勘破取证。
//
//   bun docs/verification/2026-09-10-req159-1334-packaged-network-fence/run.ts \
//     --app "<path>/Code Puppy.app" --arm open|deny|choke|sec5 [--out results/<name>.json] [--keep]
//
// 四臂,同一份签名包(网络行由 fixture/network-arm.patch 按 env 追加;env 不设 = 出货形状,一个字节不变):
//   open  —— 不追加任何网络行(= 今天出货的形状)。控制臂:证明这套仪器在网络全通时读得到「通」,
//            且 CONNECT 代理日志为空(不会幻觉命中)。
//   deny  —— (deny network*) + loopback bind/inbound + 只放行 <chokePort> 出网,**不设任何代理 env**。
//            回答 Q1:装上「只连授权目的地」的强制汇流层而没有策略层时,引擎哪一格还活着。
//   choke —— 同 deny,再把 HTTP(S)_PROXY 指向 runner 起在 <chokePort> 上的 CONNECT 代理。
//            回答 Q4:打包产物里 useEnvProxy() 到底把哪些流量汇过来了(读代理日志,不读报错)。
//   sec5  —— 勘破 2026-08-25 §5 的那两行**逐字**((deny network*) + 只放行 chokePort 出网,不放 bind/inbound)。
//            回答「照老勘破的裁决原样立闸会怎样」。
//
// 判据纪律(与 #1323 同):
//   · 文件轴仍看「探针文件到底落没落盘」(本进程 existsSync 实读);
//   · 网络轴看「流量到底通没通」—— 代理日志里的 CONNECT 行、HTTP 状态码、provider 目录里到底有没有包,
//     不看「有没有报错」;
//   · 每条会派生进程的探针第一句 echo AC1334-STARTED,看不见它就不许把「没落盘 / 没读数」读成「被拦住了」;
//   · 内核 Sandbox 拒绝日志(log show, `deny(`)在跑完后按时间窗抓一次 —— 这是 Q2 的枚举手段,
//     它的正样本在 README §2(nc -U /var/run/syslog 在 deny-all 下 EPERM 且落日志)。
//
// 本文件不改任何生产代码。

import { spawn, spawnSync, type ChildProcess } from "node:child_process"
import { createServer as createNetServer, connect as netConnect, type Socket } from "node:net"
import { createServer as createHttpServer } from "node:http"
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, statSync, writeFileSync } from "node:fs"
import { homedir } from "node:os"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"
import { createHash } from "node:crypto"

const HERE = dirname(fileURLToPath(import.meta.url))
const REPO = join(HERE, "..", "..", "..")
const MCP_PROBE = join(REPO, "packages/ui-mac/test-fixtures/process-fence/mcp-probe.mjs")

function arg(name: string, fallback?: string) {
  const i = process.argv.indexOf(name)
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : fallback
}
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

const APP = arg("--app")!
const ARM = arg("--arm", "open") as "open" | "deny" | "choke" | "sec5"
const OUT = arg("--out", join(HERE, "results", `${ARM}.json`))!
const KEEP = process.argv.includes("--keep")
const INIT_TIMEOUT = Number(arg("--init-timeout", ARM === "sec5" ? "70000" : "150000"))
if (!APP || !existsSync(APP)) throw new Error(`--app missing or not found: ${APP}`)
const FENCED_NET = ARM !== "open"

type Probe = {
  id: string
  grid: string
  kind: "identity" | "inside" | "escape" | "obs" | "net" | "benign"
  path?: string
  processStarted: boolean | null
  landed: boolean | null
  expectLanded: boolean | null
  ok: boolean | null
  detail: unknown
}
const probes: Probe[] = []
const identity: Record<string, unknown> = {}
function push(p: Probe) {
  probes.push(p)
  const verdict = p.ok === null ? "obs " : p.ok ? "ok  " : "FAIL"
  console.log(`[${verdict}] ${p.grid} ${p.id} landed=${p.landed} started=${p.processStarted}${p.path ? ` ${p.path}` : ""}`)
}
const sha = (p: string) => (existsSync(p) ? createHash("sha256").update(readFileSync(p)).digest("hex") : "MISSING")
const run = (cmd: string, args: string[]) => spawnSync(cmd, args, { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 })

async function freePort(): Promise<number> {
  return new Promise((res, rej) => {
    const s = createNetServer()
    s.on("error", rej)
    s.listen(0, "127.0.0.1", () => {
      const a = s.address()
      if (typeof a !== "object" || !a) return rej(new Error("no port"))
      const p = a.port
      s.close(() => res(p))
    })
  })
}

// ---------------------------------------------------------------- loopback CONNECT 代理(策略点的取证替身)
// 它**不是**本票要实现的东西 —— 只是一个会把每一条 CONNECT / 绝对 URI 请求记下来的观测点。
// tunnel:真转发(于是「装得上 / 拉得到」这些格能恢复,可判);deny-list 的域答 403 并带可识别正文。
type ProxyEvent = { t: number; kind: "connect" | "http"; target: string; outcome: string }
const proxyLog: ProxyEvent[] = []
const PROXY_DENY_MARK = "AC1334-PROXY-DENY"
async function startChokeProxy(port: number) {
  const server = createHttpServer((req, res) => {
    const target = String(req.url)
    proxyLog.push({ t: Date.now(), kind: "http", target, outcome: "403" })
    res.writeHead(403, { "content-type": "text/plain" })
    res.end(PROXY_DENY_MARK)
  })
  server.on("connect", (req, clientSocket: Socket, head: Buffer) => {
    const target = String(req.url)
    const [host, portStr] = target.split(":")
    const upstream = netConnect({ host, port: Number(portStr || 443) }, () => {
      proxyLog.push({ t: Date.now(), kind: "connect", target, outcome: "tunnelled" })
      clientSocket.write("HTTP/1.1 200 Connection Established\r\n\r\n")
      if (head?.length) upstream.write(head)
      upstream.pipe(clientSocket)
      clientSocket.pipe(upstream)
    })
    upstream.on("error", (e: NodeJS.ErrnoException) => {
      proxyLog.push({ t: Date.now(), kind: "connect", target, outcome: `upstream ${e.code ?? e.message}` })
      try {
        clientSocket.end(`HTTP/1.1 502 ${PROXY_DENY_MARK}\r\n\r\n`)
      } catch {}
    })
    clientSocket.on("error", () => {
      try {
        upstream.destroy()
      } catch {}
    })
  })
  await new Promise<void>((res) => server.listen(port, "127.0.0.1", () => res()))
  return server
}

// ---------------------------------------------------------------- 被测件身份
const APP_EXEC = join(APP, "Contents/MacOS/Code Puppy")
const ADDON = join(APP, "Contents/Resources/alpha-fence/alpha_fence.node")
const ASAR = join(APP, "Contents/Resources/app.asar")
const csLines = (p: string) =>
  run("/usr/bin/codesign", ["-dv", "--verbose=2", p])
    .stderr.split("\n")
    .filter((l) => /^(Identifier|CodeDirectory|TeamIdentifier|Authority=Developer)/.test(l))
const asarCount = (needle: string) => Number(run("/usr/bin/grep", ["-a", "-c", needle, ASAR]).stdout.trim() || 0)
const verify = run("/usr/bin/codesign", ["--verify", "--deep", "--strict", "--verbose=1", APP])
const plist = (k: string) => run("/usr/libexec/PlistBuddy", ["-c", `Print :${k}`, join(APP, "Contents/Info.plist")]).stdout.trim()
Object.assign(identity, {
  ticket: "alpha-code#1334",
  arm: ARM,
  app: APP,
  bundleId: plist("CFBundleIdentifier"),
  version: plist("CFBundleShortVersionString"),
  codesignApp: csLines(APP),
  codesignAddon: csLines(ADDON),
  lipoAddon: run("/usr/bin/lipo", ["-archs", ADDON]).stdout.trim(),
  verifyDeepStrictExit: verify.status,
  addonBuildId: [...new Set(run("/usr/bin/grep", ["-a", "-o", "fence-[0-9TZ]*", ADDON]).stdout.match(/fence-[0-9TZ]+/g) ?? [])],
  addonSha256: sha(ADDON),
  asarMarkers: {
    "ALPHA_AC1334_NETWORK": asarCount("ALPHA_AC1334_NETWORK"),
    "process fence applied": asarCount("process fence applied"),
    "AC1334-NONEXISTENT-NEEDLE(control)": asarCount("AC1334-NONEXISTENT-NEEDLE"),
  },
})
const csApp = (identity.codesignApp as string[]).join("\n")
const csAddon = (identity.codesignAddon as string[]).join("\n")
const markers = identity.asarMarkers as Record<string, number>
push({
  id: "identity.shippingForm",
  grid: "g0",
  kind: "identity",
  processStarted: null,
  landed: null,
  expectLanded: null,
  ok:
    /flags=0x10000\(runtime\)/.test(csApp) &&
    /TeamIdentifier=RQX6X6A635/.test(csApp) &&
    /flags=0x10000\(runtime\)/.test(csAddon) &&
    /TeamIdentifier=RQX6X6A635/.test(csAddon) &&
    /arm64/.test(String(identity.lipoAddon)) &&
    /x86_64/.test(String(identity.lipoAddon)) &&
    verify.status === 0 &&
    markers["ALPHA_AC1334_NETWORK"] >= 1 &&
    markers["AC1334-NONEXISTENT-NEEDLE(control)"] === 0,
  detail: { codesignApp: identity.codesignApp, codesignAddon: identity.codesignAddon, lipo: identity.lipoAddon, verifyExit: verify.status, markers },
})

// ---------------------------------------------------------------- 残留进程
const psAll = () => run("/bin/ps", ["-axo", "pid=,ppid=,command="]).stdout.split("\n").filter(Boolean)
const OUR_DIST = /\/\.worktrees\/ac-1334\/packages\/ui-mac\/dist[^ ]*\/Code Puppy\.app/
const orphansBefore = psAll().filter((l) => OUR_DIST.test(l))
identity.orphansBefore = orphansBefore
for (const l of orphansBefore) {
  const pid = Number(l.trim().split(/\s+/)[0])
  if (pid) {
    try {
      process.kill(pid, "SIGKILL")
    } catch {}
  }
}
identity.ownerAppPidsUntouched = psAll()
  .filter((l) => l.includes("/Applications/Code Puppy.app/Contents/MacOS/Code Puppy"))
  .map((l) => Number(l.trim().split(/\s+/)[0]))

// ---------------------------------------------------------------- 隔离布局(#1323 README §2.1–2.3 逐条照做)
const REAL = homedir()
const REAL_TMPDIR = process.env.TMPDIR ?? "/tmp"
const ISO = realpathSync(mkdtempSync(join(REAL, `.ac1334-${ARM}-`)))
const HOME = join(ISO, "home")
const LAUNCH_TMP = join(ISO, "tmp")
const WS_A = join(ISO, "ws-a")
const WS_B = join(ISO, "ws-b")
const WS_C = join(ISO, "ws-c")
const ESC = join(ISO, "esc")
for (const d of [HOME, LAUNCH_TMP, WS_A, WS_B, WS_C, ESC]) mkdirSync(d, { recursive: true })
for (const d of [WS_A, WS_B, WS_C]) run("/usr/bin/git", ["init", "-q", d])
const CHOKE_PORT = await freePort()
const PROXY_ENV = ARM === "choke" ? `export HTTPS_PROXY=http://127.0.0.1:${CHOKE_PORT}\nexport HTTP_PROXY=http://127.0.0.1:${CHOKE_PORT}\n` : ""
writeFileSync(join(HOME, ".zshrc"), `# ac#1334 fixture (see run.ts header / #1323 README §2.2)\nexport TMPDIR=${JSON.stringify(REAL_TMPDIR)}\n${PROXY_ENV}`)
const DEFAULT_WS = join(HOME, "code-puppy")
Object.assign(identity, { iso: ISO, home: HOME, launchTmp: LAUNCH_TMP, defaultWorkspace: DEFAULT_WS, wsA: WS_A, wsB: WS_B, wsC: WS_C, esc: ESC, realTmpdir: REAL_TMPDIR, chokePort: CHOKE_PORT })

const sentinels = [
  join(REAL, "Library/Application Support/ai.opencode.desktop"),
  join(REAL, "Library/Application Support/alpha-code-state/env/prod"),
  join(REAL, ".npm"),
  join(REAL, ".config/opencode"),
  join(REAL, ".local/share/opencode"),
  join(REAL, "code-puppy"),
]
const snap = () => Object.fromEntries(sentinels.map((p) => [p.replace(REAL, "<REAL_HOME>"), existsSync(p) ? statSync(p).mtimeMs : null]))
const sentinelsBefore = snap()
console.log("REAL HOME sentinels BEFORE: " + JSON.stringify(sentinelsBefore))

// ---------------------------------------------------------------- 起代理 + 起 app
const proxy = await startChokeProxy(CHOKE_PORT)
const ENGINE_PORT = await freePort()
const CDP_PORT = await freePort()
const env: Record<string, string> = {}
for (const [k, v] of Object.entries(process.env)) {
  if (v === undefined) continue
  if (/^(XDG_|ALPHA_|OPENCODE_|VIRTUAL_ENV|ZDOTDIR|HOME$|TMPDIR$|HTTPS?_PROXY$|https?_proxy$|ALL_PROXY$|all_proxy$|NO_PROXY$|no_proxy$)/.test(k)) continue
  env[k] = v
}
env.HOME = HOME
env.TMPDIR = LAUNCH_TMP
env.OPENCODE_TEST_ONBOARDING = "1"
env.OPENCODE_PORT = String(ENGINE_PORT)
if (ARM !== "open") {
  env.ALPHA_AC1334_NETWORK = ARM === "sec5" ? "sec5-min" : "loopback"
  env.ALPHA_AC1334_CHOKE_PORT = String(CHOKE_PORT)
}
if (ARM === "choke") {
  env.HTTPS_PROXY = `http://127.0.0.1:${CHOKE_PORT}`
  env.HTTP_PROXY = `http://127.0.0.1:${CHOKE_PORT}`
}
identity.launchEnvSubset = Object.fromEntries(Object.entries(env).filter(([k]) => /^(HOME|TMPDIR|ALPHA_AC1334|HTTPS?_PROXY|OPENCODE_)/.test(k)))
const launchedAt = Date.now()
const logWindowStart = new Date().toISOString() // 记录用,时间窗见 finally 里的 --last
const appLog: string[] = []
let child: ChildProcess | undefined
let cdp: { eval: (e: string) => Promise<any>; close: () => void } | undefined
let ROOT = ""
let USER_DATA = ""
let ALPHA_GLOBAL_ROOT = ""
let XDG_CONFIG = ""
let XDG_DATA = ""
let XDG_CACHE = ""

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
    if (child?.exitCode !== null && child?.exitCode !== undefined) throw new Error(`app exited ${child.exitCode} before CDP came up`)
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
        setTimeout(() => pending.has(myId) && (pending.delete(myId), rej(new Error("cdp timeout"))), 200_000)
      })
      if (r.exceptionDetails) throw new Error(`eval threw: ${r.exceptionDetails.exception?.description ?? "?"}`)
      return r.result?.value
    },
    close: () => ws.close(),
  }
}

const logsDir = () => join(USER_DATA, "logs")
const latestRun = () => (USER_DATA && existsSync(logsDir()) ? readdirSync(logsDir()).sort().at(-1) : undefined)
const readLog = (name: string) => {
  const r = latestRun()
  const p = r ? join(logsDir(), r, name) : ""
  return p && existsSync(p) ? readFileSync(p, "utf8") : ""
}
const grepLog = (text: string, re: RegExp, cap = 120) => text.split("\n").filter((l) => re.test(l)).slice(0, cap)
const readEngineLogs = () => {
  const dir = join(XDG_DATA, "opencode", "log")
  return existsSync(dir)
    ? readdirSync(dir)
        .filter((f) => f.endsWith(".log"))
        .map((f) => readFileSync(join(dir, f), "utf8"))
        .join("\n")
    : ""
}

let init: { url?: string; username?: string; password?: string } | undefined
let auth: string | undefined
const api = async (method: string, path: string, directory: string, body?: unknown, timeoutMs = 120_000, extraHeaders: Record<string, string> = {}) => {
  const url = new URL(String(init!.url) + path)
  url.searchParams.set("directory", directory)
  const headers: Record<string, string> = { "content-type": "application/json", "x-opencode-directory": directory, ...extraHeaders }
  if (auth) headers.Authorization = auth
  try {
    const r = await fetch(url, { method, headers, signal: AbortSignal.timeout(timeoutMs), ...(body === undefined ? {} : { body: JSON.stringify(body) }) })
    const t = await r.text()
    try {
      return { status: r.status, body: JSON.parse(t) as any }
    } catch {
      return { status: r.status, body: t.slice(0, 800) as any }
    }
  } catch (e) {
    return { status: 0, body: `FETCH-FAILED ${String(e)}` as any }
  }
}
const health = async () => {
  try {
    const h = await fetch(`http://127.0.0.1:${ENGINE_PORT}/global/health`, { headers: auth ? { Authorization: auth } : {}, signal: AbortSignal.timeout(3000) })
    return h.status
  } catch {
    return 0
  }
}
const MARK = "AC1334-STARTED"
const q = (p: string) => `"${p}"`
const landedList = (dir: string) => (existsSync(dir) ? readdirSync(dir).filter((f) => !f.startsWith(".")).sort() : null)
function probeFile(id: string, grid: string, path: string, expectLanded: boolean, started: boolean | null, detail: unknown = {}) {
  const landed = existsSync(path)
  push({ id, grid, kind: expectLanded ? "inside" : "escape", path, processStarted: started, landed, expectLanded, ok: (started === null || started) && landed === expectLanded, detail })
}
let agentName = "build"
async function shellIn(directory: string, command: string, timeoutMs = 120_000) {
  const s = await api("POST", "/session", directory, { title: `ac1334 ${ARM}` })
  const sid = s.body?.id
  if (!sid) return { status: s.status, output: "", raw: s.body, sid }
  const r = await api("POST", `/session/${sid}/shell`, directory, { agent: agentName, model: { providerID: "opencode", modelID: "big-pickle" }, command }, timeoutMs)
  const parts: any[] = Array.isArray(r.body?.parts) ? r.body.parts : []
  const tool = parts.find((p) => p?.type === "tool") ?? parts[0]
  const output: string = tool?.state?.output ?? tool?.state?.metadata?.output ?? ""
  return { status: r.status, output, raw: r.body, sid }
}
const sidecarPids = () =>
  psAll()
    .filter((l) => {
      const [, ppid] = l.trim().split(/\s+/)
      return Number(ppid) === child?.pid && /utility-sub-type=node\.mojom\.NodeService/.test(l)
    })
    .map((l) => Number(l.trim().split(/\s+/)[0]))

try {
  child = spawn(APP_EXEC, [`--remote-debugging-port=${CDP_PORT}`, "--use-mock-keychain"], { env, stdio: ["ignore", "pipe", "pipe"] })
  child.stdout?.on("data", (b) => appLog.push(b.toString()))
  child.stderr?.on("data", (b) => appLog.push(b.toString()))
  identity.appPid = child.pid
  identity.ports = { engine: ENGINE_PORT, cdp: CDP_PORT, choke: CHOKE_PORT }

  for (let i = 0; i < 160 && !ROOT; i++) {
    const found = readdirSync(LAUNCH_TMP).filter((f) => f.startsWith("opencode-onboarding-"))
    if (found.length === 1) ROOT = join(LAUNCH_TMP, found[0])
    else await sleep(250)
  }
  if (!ROOT) throw new Error(`onboarding root never appeared under ${LAUNCH_TMP}`)
  USER_DATA = join(ROOT, "desktop")
  ALPHA_GLOBAL_ROOT = join(ROOT, "alpha-code-state", "env", "prod")
  XDG_CONFIG = join(ROOT, "config")
  XDG_DATA = join(ROOT, "data")
  XDG_CACHE = join(ROOT, "cache")
  Object.assign(identity, { onboardingRoot: ROOT, userData: USER_DATA, alphaGlobalRoot: ALPHA_GLOBAL_ROOT, xdgConfig: XDG_CONFIG, xdgData: XDG_DATA, xdgCache: XDG_CACHE })

  const pages = await waitForCdp(CDP_PORT, 180_000)
  cdp = await attach(pages[0].webSocketDebuggerUrl)
  for (let i = 0; i < 120; i++) {
    const t = await cdp.eval(`typeof window.api`).catch(() => "error")
    if (t === "object") break
    await sleep(500)
  }
  identity.userAgent = await cdp.eval(`navigator.userAgent`).catch(() => null)
  init = await Promise.race([cdp.eval(`window.api.awaitInitialization()`).catch(() => undefined), sleep(INIT_TIMEOUT).then(() => undefined)])
  const mainLog0 = readLog("main.log")
  const serverLog0 = readLog("server.log")
  identity.logRun = latestRun()
  identity.appStartingLine = grepLog(mainLog0, /app starting/)[0] ?? ""
  identity.fenceMainLines = grepLog(mainLog0, /process fence|fence plan|injection|spawning sidecar|sidecar exited|self-heal|respawn|shell env|Loaded shell environment/i)
  identity.fenceServerLines = grepLog(serverLog0, /process fence|sandbox_init|dlopen|fence|EPERM|not permitted|listen|EADDR/i)
  const plannedLine = (identity.fenceMainLines as string[]).find((l) => /process fence planned/.test(l)) ?? ""
  const appliedLine = (identity.fenceServerLines as string[]).find((l) => /process fence applied/.test(l)) ?? ""
  push({
    id: "g1.fencePlannedAndApplied",
    grid: "g1",
    kind: "obs",
    processStarted: null,
    landed: null,
    expectLanded: null,
    ok: null,
    detail: { planned: plannedLine, applied: appliedLine, profileBytesPlanned: plannedLine.match(/profile=(\d+)B/)?.[1] ?? null, profileBytesApplied: appliedLine.match(/profile=(\d+)B/)?.[1] ?? null },
  })

  if (!init?.url) {
    // 引擎没起来本身就是一个读数(sec5 臂预期如此)。把原因点名后收工。
    push({
      id: "g1.engineNeverInitialized",
      grid: "g1",
      kind: "obs",
      processStarted: null,
      landed: null,
      expectLanded: null,
      ok: null,
      detail: {
        health: await health(),
        mainLines: identity.fenceMainLines,
        serverLines: identity.fenceServerLines,
        appStderrTail: appLog.join("").slice(-4000),
      },
    })
    throw new Error(`engine never initialized within ${INIT_TIMEOUT}ms (arm=${ARM}) — see g1.engineNeverInitialized`)
  }
  identity.engineUrl = init.url
  auth = init.username || init.password ? "Basic " + Buffer.from(`${init.username ?? ""}:${init.password ?? ""}`).toString("base64") : undefined
  const agents = await api("GET", "/agent", DEFAULT_WS)
  agentName = (Array.isArray(agents.body) && agents.body.find((a: any) => a?.name === "build")?.name) || (Array.isArray(agents.body) ? agents.body[0]?.name : undefined) || "build"
  identity.agent = agentName

  // ---- 布局自证
  const envProbe = await shellIn(DEFAULT_WS, `echo ${MARK}; echo "HOME=$HOME"; echo "TMPDIR=$TMPDIR"; echo "XDG_CONFIG_HOME=$XDG_CONFIG_HOME"; echo "HTTPS_PROXY=$HTTPS_PROXY"; echo "NO_PROXY=$NO_PROXY"`)
  const seen = (k: string) => envProbe.output.match(new RegExp(`^${k}=(.*)$`, "m"))?.[1] ?? ""
  const realTmpResolved = realpathSync(REAL_TMPDIR)
  const seenTmp = seen("TMPDIR")
  push({
    id: "layout.rootsOutsideW11W12+sidecarEnv",
    grid: "g0",
    kind: "identity",
    processStarted: envProbe.output.includes(MARK),
    landed: null,
    expectLanded: null,
    ok:
      ROOT.startsWith(ISO) &&
      !ROOT.startsWith("/private/var/folders") &&
      !ROOT.startsWith("/private/tmp") &&
      existsSync(logsDir()) &&
      existsSync(DEFAULT_WS) &&
      seen("HOME") === HOME &&
      (seenTmp.replace(/\/$/, "") === REAL_TMPDIR.replace(/\/$/, "") || (!!seenTmp && realpathSync(seenTmp) === realTmpResolved)) &&
      seen("XDG_CONFIG_HOME") === XDG_CONFIG &&
      /packaged:\s*true/.test(String(identity.appStartingLine)),
    detail: { root: ROOT, sidecarSees: { HOME: seen("HOME"), TMPDIR: seenTmp, XDG_CONFIG_HOME: seen("XDG_CONFIG_HOME"), HTTPS_PROXY: seen("HTTPS_PROXY"), NO_PROXY: seen("NO_PROXY") }, appStartingLine: identity.appStartingLine },
  })

  // ============================================================ 格 1:冷启动
  let h = 0
  for (let i = 0; i < 60 && h !== 200; i++) {
    h = await health()
    if (h !== 200) await sleep(1000)
  }
  push({ id: "g1.coldStart.health200", grid: "g1", kind: "obs", processStarted: null, landed: null, expectLanded: null, ok: h === 200, detail: { health: h } })
  const cfg = await api("GET", "/config", DEFAULT_WS)
  push({ id: "g1.coldStart.configReadable", grid: "g1", kind: "obs", processStarted: null, landed: null, expectLanded: null, ok: cfg.status === 200, detail: { status: cfg.status, shell: cfg.body?.shell ?? null } })

  // ---- 引擎自己的出网:模型目录(models.dev)与 provider 列表
  const providers = await api("GET", "/config/providers", DEFAULT_WS, undefined, 90_000)
  const provList: any[] = Array.isArray(providers.body?.providers) ? providers.body.providers : Array.isArray(providers.body) ? providers.body : []
  push({
    id: "gN.modelsDev.providerListSize",
    grid: "gN",
    kind: "net",
    processStarted: null,
    landed: null,
    expectLanded: null,
    ok: null,
    detail: { status: providers.status, bodySnippet: JSON.stringify(providers.body).slice(0, 400), providerCount: provList.length, providerIds: provList.map((p: any) => p?.id).filter(Boolean).slice(0, 40), modelsCacheFile: join(XDG_CACHE, "opencode", "models.json"), modelsCacheExists: existsSync(join(XDG_CACHE, "opencode", "models.json")), modelsCacheBytes: existsSync(join(XDG_CACHE, "opencode", "models.json")) ? statSync(join(XDG_CACHE, "opencode", "models.json")).size : 0 },
  })

  // ============================================================ 格 2:装一个连接器(MCP stdio)+ 两处 provider 目录(W7 静默失败路径)
  const NODE = run("/usr/bin/which", ["node"]).stdout.trim() || "node"
  const mcp = await api("POST", "/mcp", DEFAULT_WS, { name: "ac1334probe", config: { type: "local", command: [NODE, MCP_PROBE, DEFAULT_WS, ESC, ARM], enabled: true } }, 120_000)
  await sleep(2000)
  const mcpConnected = JSON.stringify(mcp.body).includes("connected")
  push({ id: "g2.mcp.connected", grid: "g2", kind: "obs", processStarted: mcpConnected, landed: null, expectLanded: null, ok: mcp.status === 200 && mcpConnected, detail: { status: mcp.status, body: mcp.body } })
  probeFile("g2.mcp.inside(W1 default ws)", "g2", join(DEFAULT_WS, `mcp-${ARM}.txt`), true, mcpConnected)
  probeFile("g2.mcp.escape", "g2", join(ESC, `mcp-${ARM}.txt`), false, mcpConnected)
  const providerDirs = [join(XDG_CONFIG, "opencode", "node_modules"), join(USER_DATA, "alpha-engine-config", "node_modules")]
  const installed = (d: string) => existsSync(join(d, "@opencode-ai", "plugin", "package.json"))
  for (let i = 0; i < 150 && !providerDirs.every(installed); i++) await sleep(1000)
  const npmFail = grepLog(readEngineLogs(), /background dependency install failed|NpmInstallFailedError|EPERM|ENOTFOUND|ECONNREFUSED/i, 30)
  const dirReport = providerDirs.map((d) => ({ dir: d, pluginInstalled: installed(d), topLevel: existsSync(d) ? readdirSync(d).filter((f) => !f.startsWith(".")).length : 0, sizeKB: existsSync(d) ? Number(run("/usr/bin/du", ["-sk", d]).stdout.split("\t")[0]) : 0 }))
  push({
    id: "g2.providerInstall.bothDirsPopulated(W6/W3)+npmCache(W7)",
    grid: "g2",
    kind: "net",
    processStarted: null,
    landed: providerDirs.every(installed),
    expectLanded: null,
    ok: null,
    detail: { dirs: dirReport, npmCacache: existsSync(join(HOME, ".npm", "_cacache")), npmFailLines: npmFail },
  })

  // ============================================================ 格 3:开终端
  const ptyDefault = await api("POST", "/pty", DEFAULT_WS, { cwd: DEFAULT_WS, title: "ac1334" })
  const ptyID = ptyDefault.body?.id
  push({ id: "g3.pty.default200(W15)", grid: "g3", kind: "obs", processStarted: null, landed: null, expectLanded: null, ok: ptyDefault.status === 200 && !!ptyID, detail: { status: ptyDefault.status, body: ptyDefault.body } })
  let ptyOut = ""
  if (ptyID) {
    const ptyTicket = await api("POST", `/pty/${ptyID}/connect-token`, DEFAULT_WS, undefined, 30_000, { "x-opencode-ticket": "1" })
    const ticket = ptyTicket.body?.ticket
    if (ticket) {
      const wsUrl = new URL(String(init.url).replace(/^http/, "ws") + `/pty/${ptyID}/connect`)
      wsUrl.searchParams.set("directory", DEFAULT_WS)
      wsUrl.searchParams.set("ticket", ticket)
      const ws = new WebSocket(wsUrl)
      ws.binaryType = "arraybuffer"
      const chunks: string[] = []
      ws.onmessage = (ev) => {
        const d = ev.data
        if (typeof d === "string") chunks.push(d)
        else if (d instanceof ArrayBuffer) {
          const u = new Uint8Array(d)
          chunks.push(u[0] === 0 ? `<meta ${new TextDecoder().decode(u.slice(1))}>` : new TextDecoder().decode(u))
        }
      }
      await new Promise<void>((res, rej) => {
        ws.onopen = () => res()
        ws.onerror = () => rej(new Error("pty ws error"))
        setTimeout(() => rej(new Error("pty ws open timeout")), 15_000)
      }).catch((e) => chunks.push(`<ws-error ${e.message}>`))
      await sleep(2500)
      ws.send(`echo ${MARK}; echo x > ${q(join(DEFAULT_WS, `pty-default-${ARM}.txt`))}; echo x > ${q(join(ESC, `pty-default-${ARM}.txt`))}; echo AC1334-PTY-DONE\r`)
      await sleep(3500)
      ws.send(`exit\r`)
      await sleep(1500)
      ptyOut = chunks.join("")
      try {
        ws.close()
      } catch {}
    }
    await api("DELETE", `/pty/${ptyID}`, DEFAULT_WS, undefined, 15_000).catch(() => undefined)
  }
  const ptyStarted = ptyOut.includes(MARK)
  push({ id: "g3.pty.defaultLoginShellRanACommand", grid: "g3", kind: "obs", processStarted: ptyStarted, landed: null, expectLanded: null, ok: ptyStarted && ptyOut.includes("AC1334-PTY-DONE"), detail: { output: ptyOut.slice(-1500) } })
  probeFile("g3.pty.default.inside", "g3", join(DEFAULT_WS, `pty-default-${ARM}.txt`), true, ptyStarted)
  probeFile("g3.pty.default.escape", "g3", join(ESC, `pty-default-${ARM}.txt`), false, ptyStarted)

  // ============================================================ 格 4:shell 工具
  const sh = await shellIn(
    DEFAULT_WS,
    `echo ${MARK}; echo x > ${q(join(DEFAULT_WS, `shelltool-${ARM}.txt`))}; echo x > ${q(join(ESC, `shelltool-${ARM}.txt`))}; echo x > ${q(join(LAUNCH_TMP, `outside-root-${ARM}.txt`))}; echo done`,
  )
  const shStarted = sh.output.includes(MARK)
  push({ id: "g4.shellTool.ranToCompletion", grid: "g4", kind: "obs", processStarted: shStarted, landed: null, expectLanded: null, ok: sh.status === 200 && shStarted && sh.output.includes("done") && !sh.output.includes("sandbox_apply"), detail: { status: sh.status, output: sh.output.slice(0, 800) } })
  probeFile("g4.shellTool.inside(W1)", "g4", join(DEFAULT_WS, `shelltool-${ARM}.txt`), true, shStarted)
  probeFile("g4.shellTool.escape", "g4", join(ESC, `shelltool-${ARM}.txt`), false, shStarted)
  probeFile("g4.shellTool.escape.siblingOfOnboardingRoot", "g4", join(LAUNCH_TMP, `outside-root-${ARM}.txt`), false, shStarted)

  // ============================================================ 格 5:写项目配置
  const alphaJsonc = join(ALPHA_GLOBAL_ROOT, "alpha.jsonc")
  const engineCfgDir = join(USER_DATA, "alpha-engine-config")
  const injectionLines = grepLog(readLog("main.log"), /injection/i)
  push({
    id: "g5.injection.alphaGlobalRoot(W2)+engineConfig(W3)",
    grid: "g5",
    kind: "inside",
    path: alphaJsonc,
    processStarted: null,
    landed: existsSync(alphaJsonc),
    expectLanded: true,
    ok: existsSync(alphaJsonc) && existsSync(engineCfgDir) && !injectionLines.some((l) => /fail|EPERM/i.test(l)),
    detail: { alphaJsoncMtimeAfterLaunch: existsSync(alphaJsonc) ? statSync(alphaJsonc).mtimeMs >= launchedAt : null, engineConfigEntries: existsSync(engineCfgDir) ? readdirSync(engineCfgDir).sort() : null, injectionLines },
  })
  const toolIds = await api("GET", "/experimental/tool/ids", DEFAULT_WS)
  const ids: string[] = Array.isArray(toolIds.body) ? toolIds.body : []
  push({ id: "g5.extLoadedInSidecar(alpha_register present)", grid: "g5", kind: "obs", processStarted: null, landed: null, expectLanded: null, ok: toolIds.status === 200 && ids.includes("alpha_register"), detail: { status: toolIds.status, alphaTools: ids.filter((i) => i.startsWith("alpha_")) } })

  // ============================================================ 格 6:多工作区(启动时并集,经产品 store IPC + crash self-heal)
  const tabs = JSON.stringify([
    { type: "draft", draftID: "ac1334-a", server: "sidecar", directory: WS_A },
    { type: "draft", draftID: "ac1334-b", server: "sidecar", directory: WS_B },
  ])
  await cdp.eval(`window.api.storeSet("opencode.global.dat","tabs",${JSON.stringify(tabs)})`)
  await cdp.eval(`window.api.storeSet("opencode.global.dat","tabs.recent",${JSON.stringify(JSON.stringify({ key: "draft:ac1334-a" }))})`)
  const gen1Pids = sidecarPids()
  for (const pid of gen1Pids) {
    try {
      process.kill(pid, "SIGKILL")
    } catch {}
  }
  let downSeen = false
  for (let i = 0; i < 60; i++) {
    const s = await health()
    if (s !== 200) downSeen = true
    if (downSeen && s === 200) break
    await sleep(500)
  }
  await sleep(2500)
  const mainLog2 = readLog("main.log")
  const plannedAll = grepLog(mainLog2, /process fence planned/)
  const planned2 = plannedAll[1] ?? ""
  const applied2 = grepLog(readLog("server.log"), /process fence applied/)
  push({
    id: "g6.union.selfHealRespawnRePlannedThree",
    grid: "g6",
    kind: "obs",
    processStarted: gen1Pids.length > 0 && downSeen,
    landed: null,
    expectLanded: null,
    ok: gen1Pids.length > 0 && downSeen && (await health()) === 200 && /workspaces=3 \(candidates=3/.test(planned2) && applied2.length >= 2,
    detail: { gen1Pids, plannedAll, appliedAll: applied2, profileBytesGen2: planned2.match(/profile=(\d+)B/)?.[1] ?? null },
  })
  const multiCmd = `echo ${MARK}; echo x > ${q(join(WS_B, `multi-${ARM}.txt`))}; echo x > ${q(join(WS_A, `multi-${ARM}.txt`))}; echo x > ${q(join(DEFAULT_WS, `multi-${ARM}.txt`))}; echo x > ${q(join(WS_C, `multi-${ARM}.txt`))}; echo done`
  let multi = await shellIn(WS_B, multiCmd)
  if (!multi.output.includes(MARK)) {
    await sleep(5000)
    const retry = await shellIn(WS_B, multiCmd)
    push({ id: "g6.multi.firstAttemptEmpty(retried)", grid: "g6", kind: "obs", processStarted: null, landed: null, expectLanded: null, ok: null, detail: { firstStatus: multi.status, firstRaw: JSON.stringify(multi.raw).slice(0, 700), retryStatus: retry.status, retryRaw: JSON.stringify(retry.raw).slice(0, 700) } })
    multi = retry
  }
  const multiStarted = multi.output.includes(MARK)
  probeFile("g6.union.wsB.inside", "g6", join(WS_B, `multi-${ARM}.txt`), true, multiStarted, { status: multi.status, output: multi.output.slice(0, 400), raw: JSON.stringify(multi.raw).slice(0, 500) })
  probeFile("g6.union.wsA.inside", "g6", join(WS_A, `multi-${ARM}.txt`), true, multiStarted)
  probeFile("g6.union.defaultWorkspace.inside", "g6", join(DEFAULT_WS, `multi-${ARM}.txt`), true, multiStarted)
  probeFile("g6.union.wsC.outsideStore", "g6", join(WS_C, `multi-${ARM}.txt`), false, multiStarted, { output: multi.output.slice(0, 600) })

  // ============================================================ Q3:误伤语料(文件轴 §2.8 的九条,逐字照 #1076 run.ts)+ 三条本轴新增
  const repoProbeFile = join(REPO, "package.json")
  const benign: Array<[string, string, (o: string) => { ok: boolean | null; detail: unknown }]> = [
    ["workspace write (WORKDIR)", `echo ${MARK}; echo ok > inside.txt; ls inside.txt`, (o) => ({ ok: o.includes(MARK) && existsSync(join(DEFAULT_WS, "inside.txt")), detail: {} })],
    ["/private/tmp write", `echo ${MARK}; echo ok > /private/tmp/ac1334-tmp-probe-${ARM}.txt`, (o) => ({ ok: o.includes(MARK) && existsSync(`/private/tmp/ac1334-tmp-probe-${ARM}.txt`), detail: {} })],
    [
      "git init + commit",
      `echo ${MARK}; mkdir -p fp-git && cd fp-git && git init -q . && echo hi > a.txt && git add a.txt && git -c user.email=ac1334@example.com -c user.name=ac1334 commit -q -m probe && git rev-parse HEAD`,
      (o) => ({ ok: o.includes(MARK) && existsSync(join(DEFAULT_WS, "fp-git", ".git")) && /\b[0-9a-f]{40}\b/.test(o), detail: { sha40: /\b[0-9a-f]{40}\b/.test(o) } }),
    ],
    [
      "node writes TMPDIR",
      `echo ${MARK}; node -e 'const os=require("os"),fs=require("fs"),p=os.tmpdir()+"/ac1334-node-"+process.pid+".txt";fs.writeFileSync(p,"ok");console.log("NODEWROTE="+p)'`,
      (o) => {
        const m = o.match(/NODEWROTE=(\S+)/)
        return { ok: o.includes(MARK) && !!m && existsSync(m[1]), detail: { path: m?.[1] } }
      },
    ],
    ["read repo file", `echo ${MARK}; head -c 40 ${q(repoProbeFile)}`, (o) => ({ ok: o.includes(MARK) && o.includes("{"), detail: {} })],
    [
      "curl https://example.com",
      `echo ${MARK}; curl -sS -o /dev/null -m 25 -w 'CURL=%{http_code}' https://example.com; echo; echo "curl_exit=$?"`,
      (o) => ({ ok: null, detail: { code: o.match(/CURL=(\d{3})/)?.[1] ?? "none", tail: o.slice(-300) } }),
    ],
    ["mkdir -p deep", `echo ${MARK}; mkdir -p d1/d2/d3/d4 && test -d d1/d2/d3/d4 && echo MKDIR-OK`, (o) => ({ ok: o.includes(MARK) && o.includes("MKDIR-OK") && existsSync(join(DEFAULT_WS, "d1/d2/d3/d4")), detail: {} })],
    ["grep", `echo ${MARK}; printf 'aaa\\nbbb\\n' > g.txt && grep -c bbb g.txt`, (o) => ({ ok: o.includes(MARK) && /^\s*1\s*$/m.test(o), detail: {} })],
    ["which git node", `echo ${MARK}; which git node`, (o) => ({ ok: o.includes(MARK) && /\/git/.test(o) && /node/.test(o), detail: { out: o.slice(0, 200) } })],
    // 本轴新增(票面点名 npm / bun,§2.8 原表没有):
    ["npm view (registry)", `echo ${MARK}; npm view semver version --registry=https://registry.npmjs.org/ 2>&1 | tail -3; echo "npm_exit=$?"`, (o) => ({ ok: null, detail: { tail: o.slice(-400) } })],
    ["git ls-remote (https)", `echo ${MARK}; git ls-remote --exit-code https://github.com/git/git HEAD 2>&1 | tail -2; echo "git_exit=$?"`, (o) => ({ ok: null, detail: { tail: o.slice(-400) } })],
    ["dns only (getent-ish)", `echo ${MARK}; node -e 'require("dns").lookup("example.com",(e,a)=>console.log("DNS="+(e?e.code:a)))'`, (o) => ({ ok: null, detail: { dns: o.match(/DNS=(\S+)/)?.[1] ?? "none" } })],
  ]
  for (const [tag, command, judge] of benign) {
    const r = await shellIn(DEFAULT_WS, command, 90_000)
    const j = judge(r.output)
    push({ id: `q3.benign/${tag}`, grid: "q3", kind: "benign", processStarted: r.output.includes(MARK), landed: null, expectLanded: null, ok: j.ok === null ? null : j.ok && r.output.includes(MARK), detail: { status: r.status, ...(j.detail as object), output: r.output.slice(0, 500) } })
  }

  // ============================================================ Q4:引擎**进程内**的出网从哪走
  // 远程 MCP 指向一个结构上无法解析的主机:走代理 ⇒ 代理日志里出现它;不走代理 ⇒ 引擎侧自己 DNS 失败。
  for (const [scheme, name] of [["http", "ac1334remotehttp"], ["https", "ac1334remotehttps"]] as const) {
    const remoteUrl = `${scheme}://ac1334-probe.invalid/mcp`
    const beforeRemote = proxyLog.length
    const remote = await api("POST", "/mcp", DEFAULT_WS, { name, config: { type: "remote", url: remoteUrl, enabled: true } }, 90_000)
    await sleep(4000)
    const proxySawRemote = proxyLog.slice(beforeRemote).filter((e) => e.target.includes("ac1334-probe.invalid"))
    push({
      id: `q4.remoteMcp.${scheme}.viaEnvProxy`,
      grid: "q4",
      kind: "net",
      processStarted: null,
      landed: null,
      expectLanded: null,
      ok: null,
      detail: { url: remoteUrl, status: remote.status, body: JSON.stringify(remote.body).slice(0, 700), proxyEventsForTarget: proxySawRemote, proxyEventsTotalSince: proxyLog.length - beforeRemote },
    })
  }
} catch (error) {
  push({ id: "runner.fatal", grid: "g0", kind: "identity", processStarted: null, landed: null, expectLanded: null, ok: ARM === "sec5" ? null : false, detail: String(error) })
} finally {
  try {
    cdp?.close()
  } catch {}
  try {
    child?.kill("SIGTERM")
  } catch {}
  for (let i = 0; i < 20 && child && child.exitCode === null; i++) await sleep(250)
  if (child && child.exitCode === null) {
    try {
      child.kill("SIGKILL")
    } catch {}
  }
  spawnSync("/usr/bin/pkill", ["-9", "-f", `remote-debugging-port=${CDP_PORT}`])
  await sleep(1500)
  try {
    proxy.close()
  } catch {}
  const residual = psAll().filter((l) => OUR_DIST.test(l) || l.includes(`remote-debugging-port=${CDP_PORT}`))
  const sentinelsAfter = snap()
  console.log("REAL HOME sentinels AFTER : " + JSON.stringify(sentinelsAfter))
  // Q2 的枚举手段:本次时间窗内的内核 Sandbox 拒绝行(正样本见 README §2)。
  // 时间窗用 --last <秒> 而不是 --start <时间戳>:log show 的 --start 认本地时区,
  // 而 toISOString() 是 UTC —— 用它会把窗口整体推到未来,读数恒空(空输出不是结论)。
  const windowSeconds = Math.ceil((Date.now() - launchedAt) / 1000) + 60
  const denyLines = run("/usr/bin/log", ["show", "--style", "compact", "--last", `${windowSeconds}s`, "--predicate", 'eventMessage CONTAINS "deny("'])
    .stdout.split("\n")
    .filter((l) => /Sandbox:/.test(l))
    .filter((l) => !/imagent|contactsd|AddressBook|assistantd|Safari|Music|com\.apple\.dt/.test(l))
    .slice(0, 400)
  const mainLog = readLog("main.log")
  const serverLog = readLog("server.log")
  const engineLog = readEngineLogs()
  push({ id: "identity.realHomeUntouched", grid: "g0", kind: "identity", processStarted: null, landed: null, expectLanded: null, ok: JSON.stringify(sentinelsBefore) === JSON.stringify(sentinelsAfter), detail: { before: sentinelsBefore, after: sentinelsAfter } })
  push({ id: "identity.zeroResidualProcesses", grid: "g0", kind: "identity", processStarted: null, landed: null, expectLanded: null, ok: residual.length === 0, detail: { residual } })
  push({ id: "gN.chokeProxyLog", grid: "gN", kind: "net", processStarted: null, landed: null, expectLanded: null, ok: null, detail: { events: proxyLog.length, byTarget: Object.entries(proxyLog.reduce<Record<string, number>>((a, e) => ((a[`${e.kind} ${e.target}`] = (a[`${e.kind} ${e.target}`] ?? 0) + 1), a), {})).sort((a, b) => b[1] - a[1]) } })
  const failed = probes.filter((p) => p.ok === false)
  const strip = (s: unknown) => JSON.parse(JSON.stringify(s).split(ISO).join("<ISO>").split(REAL).join("<REAL_HOME>"))
  const result = strip({
    ticket: "alpha-code#1334",
    arm: ARM,
    identity,
    escapeDirListing: landedList(ESC),
    launchTmpListing: landedList(LAUNCH_TMP),
    defaultWsListing: landedList(DEFAULT_WS),
    wsAListing: landedList(WS_A),
    wsBListing: landedList(WS_B),
    wsCListing: landedList(WS_C),
    proxyLog,
    sandboxDenyLines: denyLines,
    probes,
    summary: { total: probes.length, pass: probes.filter((p) => p.ok === true).length, fail: failed.length, observational: probes.filter((p) => p.ok === null).length },
    logs: {
      main: grepLog(mainLog, /process fence|fence plan|injection|app starting|spawning sidecar|sidecar exited|self-heal|respawn|shell env|Loaded shell environment|proxy/i, 160),
      server: grepLog(serverLog, /process fence|sandbox|fence|EPERM|not permitted|error|proxy|listen/i, 160),
      engine: grepLog(engineLog, /dependency install|NpmInstall|EPERM|not permitted|ENOTFOUND|ECONNREFUSED|fetch failed|models\.dev|ac1334/i, 120),
      appStderrTail: appLog.join("").slice(-4000),
    },
    finishedAt: new Date().toISOString(),
  })
  mkdirSync(dirname(OUT), { recursive: true })
  writeFileSync(OUT, JSON.stringify(result, null, 2))
  console.log(`\n${ARM}: ${result.summary.pass} pass / ${result.summary.fail} fail / ${result.summary.observational} obs -> ${OUT}`)
  console.log(`proxy events: ${proxyLog.length}; sandbox deny lines captured: ${denyLines.length}`)
  console.log(`iso tree ${KEEP ? "kept" : "removed"}: ${ISO}`)
  if (!KEEP) {
    try {
      rmSync(ISO, { recursive: true, force: true })
    } catch {}
  }
  process.exit(failed.length ? 1 : 0)
}
