#!/usr/bin/env bun
// REQ-137 / alpha-code#1337 —— 出货形态下「围栏只放行看门人那扇门」的取证:六格工作负载 + 误伤语料 + 逃逸语料。
//
//   bun docs/verification/2026-09-10-req137-1337-packaged-egress/run.ts \
//     --app "<path>/Code Puppy.app" [--out results/shipped.json] [--keep]
//
// 只有一条臂:**出货的那份字节**(不打补丁、不设任何代理 env、不起外部代理)。网络行与策略代理都是生产代码 ——
// 代理在 Electron main 进程内(`#1073` 裁决三),它的结构化记录写进 main.log(`network egress {…}`),本 runner
// 从那里读「流量到底经没经那扇门」。
//
// 判据纪律(与 #1323 / #1334 同):
//   · 文件轴看「探针文件到底落没落盘」(本进程 existsSync 实读);
//   · 网络轴看「流量到底通没通」—— main.log 里代理的 allow / deny 记录、HTTP 状态码、provider 目录里到底有没有包,
//     不看「有没有报错」;
//   · 每条会派生进程的探针第一句 echo AC1337-STARTED,看不见它就不许把「没落盘 / 没读数」读成「被拦住了」;
//   · 逃逸语料每条自带进程已启动的证据(同上)与 curl / node 自己报的 errno;
//   · 内核 Sandbox 拒绝日志(log show, `deny(`)在跑完后按时间窗抓一次。
//
// 「杀掉代理」那一臂在出货形态上**到不了**:代理住在 main 进程内,main 死则 sidecar 一起死(utilityProcess)。
// AC4 的端到端判据在 packages/ui-mac/src/main/network-egress-fence.test.ts(Electron 的 node + 真 seatbelt + 真代理,关掉代理再测)。
//
// 本文件不改任何生产代码。

import { spawn, spawnSync, type ChildProcess } from "node:child_process"
import { createServer as createNetServer } from "node:net"
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
const ARM = "shipped"
const OUT = arg("--out", join(HERE, "results", `${ARM}.json`))!
const KEEP = process.argv.includes("--keep")
const INIT_TIMEOUT = Number(arg("--init-timeout", "150000"))
if (!APP || !existsSync(APP)) throw new Error(`--app missing or not found: ${APP}`)

type Probe = {
  id: string
  grid: string
  kind: "identity" | "inside" | "escape" | "obs" | "net" | "benign" | "netEscape"
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
  ticket: "alpha-code#1337",
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
    // 生产接线的字节在场(main 起代理那一行)、实验开关**不在**(不是 #1334 那份实验字节)、对照针
    "network egress policy proxy listening": asarCount("network egress policy proxy listening"),
    "ALPHA_AC1334_NETWORK(control: must be 0)": asarCount("ALPHA_AC1334_NETWORK"),
    "AC1337-NONEXISTENT-NEEDLE(control)": asarCount("AC1337-NONEXISTENT-NEEDLE"),
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
    markers["network egress policy proxy listening"] >= 1 &&
    markers["ALPHA_AC1334_NETWORK(control: must be 0)"] === 0 &&
    markers["AC1337-NONEXISTENT-NEEDLE(control)"] === 0,
  detail: { codesignApp: identity.codesignApp, codesignAddon: identity.codesignAddon, lipo: identity.lipoAddon, verifyExit: verify.status, markers },
})

// ---------------------------------------------------------------- 残留进程
const psAll = () => run("/bin/ps", ["-axo", "pid=,ppid=,command="]).stdout.split("\n").filter(Boolean)
const OUR_DIST = /\/\.worktrees\/ac-1337\/packages\/ui-mac\/dist[^ ]*\/Code Puppy\.app/
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
const ISO = realpathSync(mkdtempSync(join(REAL, `.ac1337-${ARM}-`)))
const HOME = join(ISO, "home")
const LAUNCH_TMP = join(ISO, "tmp")
const WS_A = join(ISO, "ws-a")
const WS_B = join(ISO, "ws-b")
const WS_C = join(ISO, "ws-c")
const ESC = join(ISO, "esc")
for (const d of [HOME, LAUNCH_TMP, WS_A, WS_B, WS_C, ESC]) mkdirSync(d, { recursive: true })
for (const d of [WS_A, WS_B, WS_C]) run("/usr/bin/git", ["init", "-q", d])
// 隔离 .zshrc:只把生产 TMPDIR export 回去(#1323 §2.2)。**不设任何代理 env** —— 代理变量必须由 main 改写才算数。
writeFileSync(join(HOME, ".zshrc"), `# ac#1337 fixture (see run.ts header / #1323 README §2.2)\nexport TMPDIR=${JSON.stringify(REAL_TMPDIR)}\n`)
const DEFAULT_WS = join(HOME, "code-puppy")
Object.assign(identity, { iso: ISO, home: HOME, launchTmp: LAUNCH_TMP, defaultWorkspace: DEFAULT_WS, wsA: WS_A, wsB: WS_B, wsC: WS_C, esc: ESC, realTmpdir: REAL_TMPDIR })

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

// ---------------------------------------------------------------- 起 app(不起代理:代理是产品自己的)
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
identity.launchEnvSubset = Object.fromEntries(Object.entries(env).filter(([k]) => /^(HOME|TMPDIR|HTTPS?_PROXY|NO_PROXY|OPENCODE_)/.test(k)))
const launchedAt = Date.now()
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
// 产品自己的代理记录(server.ts ensureEgressPolicyProxy 的 log 接线):main.log 里 `network egress {json}`。
type EgressRecord = { event: string; id: number; at: string; method?: string; authority?: string; host?: string; port?: number; verdict?: string; reason?: string; status?: number; detail?: string }
const egressRecords = (): EgressRecord[] =>
  grepLog(readLog("main.log"), /network egress \{/, 5000)
    .map((l) => {
      const i = l.indexOf("network egress {")
      try {
        return JSON.parse(l.slice(i + "network egress ".length)) as EgressRecord
      } catch {
        return undefined
      }
    })
    .filter((r): r is EgressRecord => !!r && r.event === "egress.connect")
const egressByTarget = (records: EgressRecord[]) =>
  Object.entries(
    records.reduce<Record<string, number>>((a, r) => {
      const k = `${r.verdict}${r.reason ? `/${r.reason}` : ""} ${r.host ?? r.authority}:${r.port ?? ""}`
      a[k] = (a[k] ?? 0) + 1
      return a
    }, {}),
  ).sort((a, b) => b[1] - a[1])

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
const MARK = "AC1337-STARTED"
const q = (p: string) => `"${p}"`
const landedList = (dir: string) => (existsSync(dir) ? readdirSync(dir).filter((f) => !f.startsWith(".")).sort() : null)
function probeFile(id: string, grid: string, path: string, expectLanded: boolean, started: boolean | null, detail: unknown = {}) {
  const landed = existsSync(path)
  push({ id, grid, kind: expectLanded ? "inside" : "escape", path, processStarted: started, landed, expectLanded, ok: (started === null || started) && landed === expectLanded, detail })
}
let agentName = "build"
async function shellIn(directory: string, command: string, timeoutMs = 120_000) {
  const s = await api("POST", "/session", directory, { title: `ac1337 ${ARM}` })
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
  identity.ports = { engine: ENGINE_PORT, cdp: CDP_PORT }

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
  identity.fenceMainLines = grepLog(mainLog0, /process fence|fence plan|injection|spawning sidecar|sidecar exited|self-heal|respawn|shell env|Loaded shell environment|network egress policy proxy/i)
  identity.fenceServerLines = grepLog(serverLog0, /process fence|sandbox_init|dlopen|fence|EPERM|not permitted|listen|EADDR/i)
  const plannedLine = (identity.fenceMainLines as string[]).find((l) => /process fence planned/.test(l)) ?? ""
  const appliedLine = (identity.fenceServerLines as string[]).find((l) => /process fence applied/.test(l)) ?? ""
  const proxyLine = (identity.fenceMainLines as string[]).find((l) => /network egress policy proxy listening on/.test(l)) ?? ""
  const proxyPort = Number(proxyLine.match(/listening on 127\.0\.0\.1:(\d+)/)?.[1] ?? 0)
  const plannedPort = Number(plannedLine.match(/egressProxyPort=(\d+)/)?.[1] ?? 0)
  identity.egressProxyPort = proxyPort
  push({
    id: "g1.proxyListening+fencePlannedWithSamePort+applied",
    grid: "g1",
    kind: "net",
    processStarted: null,
    landed: null,
    expectLanded: null,
    ok: proxyPort > 0 && plannedPort === proxyPort && /process fence applied/.test(appliedLine),
    detail: { proxyLine, planned: plannedLine, applied: appliedLine, proxyPort, plannedPort, profileBytesPlanned: plannedLine.match(/profile=(\d+)B/)?.[1] ?? null, profileBytesApplied: appliedLine.match(/profile=(\d+)B/)?.[1] ?? null },
  })

  if (!init?.url) {
    push({
      id: "g1.engineNeverInitialized",
      grid: "g1",
      kind: "obs",
      processStarted: null,
      landed: null,
      expectLanded: null,
      ok: false,
      detail: { health: await health(), mainLines: identity.fenceMainLines, serverLines: identity.fenceServerLines, appStderrTail: appLog.join("").slice(-4000) },
    })
    throw new Error(`engine never initialized within ${INIT_TIMEOUT}ms — see g1.engineNeverInitialized`)
  }
  identity.engineUrl = init.url
  auth = init.username || init.password ? "Basic " + Buffer.from(`${init.username ?? ""}:${init.password ?? ""}`).toString("base64") : undefined
  const agents = await api("GET", "/agent", DEFAULT_WS)
  agentName = (Array.isArray(agents.body) && agents.body.find((a: any) => a?.name === "build")?.name) || (Array.isArray(agents.body) ? agents.body[0]?.name : undefined) || "build"
  identity.agent = agentName

  // ---- 布局自证 + sidecar env 里的代理栈(必须是 main 改写后的那份,不是 runner 的)
  const envProbe = await shellIn(DEFAULT_WS, `echo ${MARK}; echo "HOME=$HOME"; echo "TMPDIR=$TMPDIR"; echo "XDG_CONFIG_HOME=$XDG_CONFIG_HOME"; echo "HTTPS_PROXY=$HTTPS_PROXY"; echo "HTTP_PROXY=$HTTP_PROXY"; echo "ALL_PROXY=$ALL_PROXY"; echo "NO_PROXY=$NO_PROXY"; echo "no_proxy=$no_proxy"`)
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
    detail: { root: ROOT, sidecarSees: { HOME: seen("HOME"), TMPDIR: seenTmp, XDG_CONFIG_HOME: seen("XDG_CONFIG_HOME") }, appStartingLine: identity.appStartingLine },
  })
  push({
    id: "g1.sidecarEnv.proxyStackRewrittenByMain",
    grid: "g1",
    kind: "net",
    processStarted: envProbe.output.includes(MARK),
    landed: null,
    expectLanded: null,
    ok:
      envProbe.output.includes(MARK) &&
      proxyPort > 0 &&
      seen("HTTPS_PROXY") === `http://127.0.0.1:${proxyPort}` &&
      seen("HTTP_PROXY") === `http://127.0.0.1:${proxyPort}` &&
      seen("ALL_PROXY") === `http://127.0.0.1:${proxyPort}` &&
      seen("NO_PROXY") === "127.0.0.1,localhost,::1" &&
      seen("no_proxy") === "127.0.0.1,localhost,::1",
    detail: { HTTPS_PROXY: seen("HTTPS_PROXY"), HTTP_PROXY: seen("HTTP_PROXY"), ALL_PROXY: seen("ALL_PROXY"), NO_PROXY: seen("NO_PROXY"), no_proxy: seen("no_proxy"), runnerHadNoProxyEnv: !("HTTPS_PROXY" in env) },
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

  // ---- 引擎自己的出网:provider 列表 + 模型目录缓存(观测)
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
    detail: { status: providers.status, providerCount: provList.length, providerIds: provList.map((p: any) => p?.id).filter(Boolean).slice(0, 40), modelsCacheExists: existsSync(join(XDG_CACHE, "opencode", "models.json")), egressSoFar: egressByTarget(egressRecords()) },
  })

  // ============================================================ 格 2:装一个连接器(MCP stdio)+ 两处 provider 目录(W7 静默失败路径 —— AC3 的硬判据)
  const NODE = run("/usr/bin/which", ["node"]).stdout.trim() || "node"
  const mcp = await api("POST", "/mcp", DEFAULT_WS, { name: "ac1337probe", config: { type: "local", command: [NODE, MCP_PROBE, DEFAULT_WS, ESC, ARM], enabled: true } }, 120_000)
  await sleep(2000)
  const mcpConnected = JSON.stringify(mcp.body).includes("connected")
  push({ id: "g2.mcp.connected", grid: "g2", kind: "obs", processStarted: mcpConnected, landed: null, expectLanded: null, ok: mcp.status === 200 && mcpConnected, detail: { status: mcp.status, body: mcp.body } })
  probeFile("g2.mcp.inside(W1 default ws)", "g2", join(DEFAULT_WS, `mcp-${ARM}.txt`), true, mcpConnected)
  probeFile("g2.mcp.escape", "g2", join(ESC, `mcp-${ARM}.txt`), false, mcpConnected)
  const providerDirs = [join(XDG_CONFIG, "opencode", "node_modules"), join(USER_DATA, "alpha-engine-config", "node_modules")]
  const installed = (d: string) => existsSync(join(d, "@opencode-ai", "plugin", "package.json"))
  for (let i = 0; i < 180 && !providerDirs.every(installed); i++) await sleep(1000)
  const npmFail = grepLog(readEngineLogs(), /background dependency install failed|NpmInstallFailedError|EPERM|ENOTFOUND|ECONNREFUSED|403/i, 30)
  const dirReport = providerDirs.map((d) => ({ dir: d, pluginInstalled: installed(d), topLevel: existsSync(d) ? readdirSync(d).filter((f) => !f.startsWith(".")).length : 0, sizeKB: existsSync(d) ? Number(run("/usr/bin/du", ["-sk", d]).stdout.split("\t")[0]) : 0 }))
  const npmRecords = egressRecords().filter((r) => r.host === "registry.npmjs.org")
  push({
    id: "g2.providerInstall.bothDirsPopulated(W6/W3)+npmCache(W7)+viaGate",
    grid: "g2",
    kind: "net",
    processStarted: null,
    landed: providerDirs.every(installed),
    expectLanded: true,
    // AC3 硬判据:两处目录都装出包(实读 @opencode-ai/plugin 在场 + 顶层条目数 > 0)、~/.npm/_cacache 在、且 registry.npmjs.org 的隧道记录在 main.log 里
    ok: providerDirs.every(installed) && dirReport.every((d) => d.topLevel > 0) && existsSync(join(HOME, ".npm", "_cacache")) && npmRecords.some((r) => r.verdict === "allow"),
    detail: { dirs: dirReport, npmCacache: existsSync(join(HOME, ".npm", "_cacache")), npmFailLines: npmFail, npmGateRecords: { allow: npmRecords.filter((r) => r.verdict === "allow").length, deny: npmRecords.filter((r) => r.verdict === "deny").length } },
  })

  // ============================================================ 格 3:开终端
  const ptyDefault = await api("POST", "/pty", DEFAULT_WS, { cwd: DEFAULT_WS, title: "ac1337" })
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
      ws.send(`echo ${MARK}; echo x > ${q(join(DEFAULT_WS, `pty-default-${ARM}.txt`))}; echo x > ${q(join(ESC, `pty-default-${ARM}.txt`))}; echo "PTY_HTTPS_PROXY=$HTTPS_PROXY"; echo AC1337-PTY-DONE\r`)
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
  push({ id: "g3.pty.defaultLoginShellRanACommand", grid: "g3", kind: "obs", processStarted: ptyStarted, landed: null, expectLanded: null, ok: ptyStarted && ptyOut.includes("AC1337-PTY-DONE"), detail: { output: ptyOut.slice(-1500), ptyHttpsProxy: ptyOut.match(/PTY_HTTPS_PROXY=(http\S*)/)?.[1] ?? null } })
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

  // ============================================================ 格 6:多工作区(启动时并集,经产品 store IPC + crash self-heal)—— 顺带验代理跨代同一端口
  const tabs = JSON.stringify([
    { type: "draft", draftID: "ac1337-a", server: "sidecar", directory: WS_A },
    { type: "draft", draftID: "ac1337-b", server: "sidecar", directory: WS_B },
  ])
  await cdp.eval(`window.api.storeSet("opencode.global.dat","tabs",${JSON.stringify(tabs)})`)
  await cdp.eval(`window.api.storeSet("opencode.global.dat","tabs.recent",${JSON.stringify(JSON.stringify({ key: "draft:ac1337-a" }))})`)
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
  const proxyLinesAll = grepLog(mainLog2, /network egress policy proxy listening on/)
  push({
    id: "g6.union.selfHealRespawnRePlannedThree+sameProxyPort",
    grid: "g6",
    kind: "obs",
    processStarted: gen1Pids.length > 0 && downSeen,
    landed: null,
    expectLanded: null,
    ok: gen1Pids.length > 0 && downSeen && (await health()) === 200 && /workspaces=3 \(candidates=3/.test(planned2) && applied2.length >= 2 && planned2.includes(`egressProxyPort=${proxyPort}`) && proxyLinesAll.length === 1,
    detail: { gen1Pids, plannedAll, appliedAll: applied2, profileBytesGen2: planned2.match(/profile=(\d+)B/)?.[1] ?? null, proxyListeningLines: proxyLinesAll.length },
  })
  const multiCmd = `echo ${MARK}; echo x > ${q(join(WS_B, `multi-${ARM}.txt`))}; echo x > ${q(join(WS_A, `multi-${ARM}.txt`))}; echo x > ${q(join(DEFAULT_WS, `multi-${ARM}.txt`))}; echo x > ${q(join(WS_C, `multi-${ARM}.txt`))}; echo done`
  const multiT0 = Date.now()
  let multi = await shellIn(WS_B, multiCmd)
  const multiFirstMs = Date.now() - multiT0
  if (!multi.output.includes(MARK)) {
    await sleep(5000)
    const retry = await shellIn(WS_B, multiCmd)
    push({ id: "g6.multi.firstAttemptEmpty(retried)", grid: "g6", kind: "obs", processStarted: null, landed: null, expectLanded: null, ok: null, detail: { firstStatus: multi.status, firstMs: multiFirstMs, firstRaw: JSON.stringify(multi.raw).slice(0, 700), retryStatus: retry.status, retryRaw: JSON.stringify(retry.raw).slice(0, 700) } })
    multi = retry
  }
  const multiStarted = multi.output.includes(MARK)
  probeFile("g6.union.wsB.inside", "g6", join(WS_B, `multi-${ARM}.txt`), true, multiStarted, { status: multi.status, firstAttemptMs: multiFirstMs, output: multi.output.slice(0, 400) })
  probeFile("g6.union.wsA.inside", "g6", join(WS_A, `multi-${ARM}.txt`), true, multiStarted)
  probeFile("g6.union.defaultWorkspace.inside", "g6", join(DEFAULT_WS, `multi-${ARM}.txt`), true, multiStarted)
  probeFile("g6.union.wsC.outsideStore", "g6", join(WS_C, `multi-${ARM}.txt`), false, multiStarted, { output: multi.output.slice(0, 600) })

  // ============================================================ AC3:误伤语料(文件轴 §2.8 的九条 + 本轴三条;example.com 按 #1073 裁决换成注册表里的真实开发目的地)
  const repoProbeFile = join(REPO, "package.json")
  const benign: Array<[string, string, (o: string) => { ok: boolean | null; detail: unknown }]> = [
    ["workspace write (WORKDIR)", `echo ${MARK}; echo ok > inside.txt; ls inside.txt`, (o) => ({ ok: o.includes(MARK) && existsSync(join(DEFAULT_WS, "inside.txt")), detail: {} })],
    ["/private/tmp write", `echo ${MARK}; echo ok > /private/tmp/ac1337-tmp-probe-${ARM}.txt`, (o) => ({ ok: o.includes(MARK) && existsSync(`/private/tmp/ac1337-tmp-probe-${ARM}.txt`), detail: {} })],
    [
      "git init + commit",
      `echo ${MARK}; mkdir -p fp-git && cd fp-git && git init -q . && echo hi > a.txt && git add a.txt && git -c user.email=ac1337@example.com -c user.name=ac1337 commit -q -m probe && git rev-parse HEAD`,
      (o) => ({ ok: o.includes(MARK) && existsSync(join(DEFAULT_WS, "fp-git", ".git")) && /\b[0-9a-f]{40}\b/.test(o), detail: { sha40: /\b[0-9a-f]{40}\b/.test(o) } }),
    ],
    [
      "node writes TMPDIR",
      `echo ${MARK}; node -e 'const os=require("os"),fs=require("fs"),p=os.tmpdir()+"/ac1337-node-"+process.pid+".txt";fs.writeFileSync(p,"ok");console.log("NODEWROTE="+p)'`,
      (o) => {
        const m = o.match(/NODEWROTE=(\S+)/)
        return { ok: o.includes(MARK) && !!m && existsSync(m[1]), detail: { path: m?.[1] } }
      },
    ],
    ["read repo file", `echo ${MARK}; head -c 40 ${q(repoProbeFile)}`, (o) => ({ ok: o.includes(MARK) && o.includes("{"), detail: {} })],
    [
      // #1073 裁决一:example.com 不进注册表;语料换成注册表里已有的真实开发目的地(registry.npmjs.org:443,§2.2 E13)
      "curl https://registry.npmjs.org (registered)",
      `echo ${MARK}; curl -sS -o /dev/null -m 25 -w 'CURL=%{http_code}' https://registry.npmjs.org/semver/latest; echo " curl_exit=$?"`,
      (o) => ({ ok: o.includes(MARK) && /CURL=200/.test(o), detail: { code: o.match(/CURL=(\d{3})/)?.[1] ?? "none", tail: o.slice(-300) } }),
    ],
    ["mkdir -p deep", `echo ${MARK}; mkdir -p d1/d2/d3/d4 && test -d d1/d2/d3/d4 && echo MKDIR-OK`, (o) => ({ ok: o.includes(MARK) && o.includes("MKDIR-OK") && existsSync(join(DEFAULT_WS, "d1/d2/d3/d4")), detail: {} })],
    ["grep", `echo ${MARK}; printf 'aaa\\nbbb\\n' > g.txt && grep -c bbb g.txt`, (o) => ({ ok: o.includes(MARK) && /^\s*1\s*$/m.test(o), detail: {} })],
    ["which git node", `echo ${MARK}; which git node`, (o) => ({ ok: o.includes(MARK) && /\/git/.test(o) && /node/.test(o), detail: { out: o.slice(0, 200) } })],
    ["npm view (registry)", `echo ${MARK}; npm view semver version --registry=https://registry.npmjs.org/ 2>&1 | tail -3; echo "npm_exit=$?"`, (o) => ({ ok: o.includes(MARK) && /^\s*\d+\.\d+\.\d+\s*$/m.test(o), detail: { tail: o.slice(-400) } })],
    ["git ls-remote (https github.com)", `echo ${MARK}; git ls-remote --exit-code https://github.com/git/git HEAD 2>&1 | tail -2; echo "git_exit=$?"`, (o) => ({ ok: o.includes(MARK) && /\b[0-9a-f]{40}\b/.test(o), detail: { tail: o.slice(-400) } })],
    // DNS 仍然不通(解析搬到了代理那一侧,#1334 Q3):这是预期形态,不是误伤
    ["dns only (expected ENOTFOUND)", `echo ${MARK}; node -e 'require("dns").lookup("example.com",(e,a)=>console.log("DNS="+(e?e.code:a)))'`, (o) => ({ ok: o.includes(MARK) && /DNS=(ENOTFOUND|EAI_AGAIN|EAI_NONAME)/.test(o), detail: { dns: o.match(/DNS=(\S+)/)?.[1] ?? "none" } })],
  ]
  for (const [tag, command, judge] of benign) {
    const r = await shellIn(DEFAULT_WS, command, 90_000)
    const j = judge(r.output)
    push({ id: `ac3.benign/${tag}`, grid: "ac3", kind: "benign", processStarted: r.output.includes(MARK), landed: null, expectLanded: null, ok: j.ok === null ? null : j.ok && r.output.includes(MARK), detail: { status: r.status, ...(j.detail as object), output: r.output.slice(0, 500) } })
  }

  // ============================================================ AC1 反臂:逃逸语料(每条自带进程已启动的证据;绕代理直连 / raw-IP:443 / UDP / [::1] 其它端口 / 未登记目的地)
  const closedV6Port = await freePort()
  const escapes: Array<[string, string, (o: string) => { ok: boolean; detail: unknown }]> = [
    [
      "unregistered destination via gate (curl https://example.com)",
      // curl 对 CONNECT 被 403 的报法是 `(56) CONNECT tunnel failed, response 403`,`-w %{http_code}` 那一格是 000 —— 读 curl 自己的话,不读 -w
      `echo ${MARK}; curl -sS -o /dev/null -m 25 -w 'CURL=%{http_code}' https://example.com; echo " curl_exit=$?"`,
      (o) => {
        const deny = egressRecords().filter((r) => r.host === "example.com" && r.verdict === "deny" && r.reason === "unregistered")
        // 判据 = curl 自己的错误文本 + 代理侧 deny 记录;`$?` 经引擎 shell 工具读回恒 0(两轮实测,未追根),只记不判
        return { ok: /curl: \(56\) CONNECT tunnel failed, response 403/.test(o) && !/CURL=200/.test(o) && deny.length >= 1, detail: { curlExitAsSeen: o.match(/curl_exit=(\d+)/)?.[1] ?? "none", gateDenyRecords: deny.slice(-1), tail: o.slice(-200) } }
      },
    ],
    [
      "bypass proxy, raw-IP:443 (curl --noproxy '*' https://1.1.1.1)",
      `echo ${MARK}; curl --noproxy '*' -sS -o /dev/null -m 10 -w 'CURL=%{http_code}' https://1.1.1.1/; echo " curl_exit=$?"`,
      // (7) Failed to connect … after 0 ms:内核 EPERM,不是超时
      (o) => ({ ok: /curl: \(7\) Failed to connect to 1\.1\.1\.1 port 443/.test(o) && !/CURL=200/.test(o), detail: { curlExitAsSeen: o.match(/curl_exit=(\d+)/)?.[1] ?? "none", afterMs: o.match(/after (\d+) ms/)?.[1] ?? null, tail: o.slice(-200) } }),
    ],
    [
      "bypass proxy, by name (curl --noproxy '*' https://github.com)",
      `echo ${MARK}; curl --noproxy '*' -sS -o /dev/null -m 10 -w 'CURL=%{http_code}' https://github.com/; echo " curl_exit=$?"`,
      // (6) Could not resolve host:绕开代理 ⇒ 死在 DNS 这一步(#1334 Q3),不是连上了
      (o) => ({ ok: /curl: \(6\) Could not resolve host: github\.com/.test(o) && !/CURL=200/.test(o), detail: { curlExitAsSeen: o.match(/curl_exit=(\d+)/)?.[1] ?? "none", tail: o.slice(-200) } }),
    ],
    [
      "raw TCP to 1.1.1.1:443 (node net.connect)",
      `echo ${MARK}; node -e 'const s=require("net").connect(443,"1.1.1.1");s.on("connect",()=>{console.log("TCP=CONNECTED");s.destroy()});s.on("error",e=>console.log("TCP="+e.code))'`,
      (o) => ({ ok: /TCP=EPERM/.test(o), detail: { tcp: o.match(/TCP=(\S+)/)?.[1] ?? "none" } }),
    ],
    [
      "UDP sendto 1.1.1.1:53 (node dgram)",
      `echo ${MARK}; node -e 'const s=require("dgram").createSocket("udp4");s.send(Buffer.from("x"),53,"1.1.1.1",e=>{console.log("UDP="+(e?e.code:"SENT"));s.close()})'`,
      (o) => ({ ok: /UDP=EPERM/.test(o), detail: { udp: o.match(/UDP=(\S+)/)?.[1] ?? "none" } }),
    ],
    [
      "[::1] other port (node net.connect)",
      `echo ${MARK}; node -e 'const s=require("net").connect({host:"::1",port:${closedV6Port}});s.on("connect",()=>{console.log("V6=CONNECTED");s.destroy()});s.on("error",e=>console.log("V6="+e.code))'`,
      (o) => ({ ok: /V6=EPERM/.test(o), detail: { v6: o.match(/V6=(\S+)/)?.[1] ?? "none", port: closedV6Port } }),
    ],
  ]
  for (const [tag, command, judge] of escapes) {
    const r = await shellIn(DEFAULT_WS, command, 90_000)
    const started = r.output.includes(MARK)
    const j = judge(r.output)
    push({ id: `ac1.escape/${tag}`, grid: "ac1", kind: "netEscape", processStarted: started, landed: null, expectLanded: null, ok: started && j.ok, detail: { status: r.status, ...(j.detail as object), output: r.output.slice(0, 400) } })
  }

  // ============================================================ 引擎**进程内**的出网经那扇门:远程 MCP 指向未登记的名字 ⇒ 代理 403 unregistered(不是引擎侧 ENOTFOUND)
  for (const [scheme, name] of [["http", "ac1337remotehttp"], ["https", "ac1337remotehttps"]] as const) {
    const remoteUrl = `${scheme}://ac1337-probe.invalid/mcp`
    const before = egressRecords().length
    const remote = await api("POST", "/mcp", DEFAULT_WS, { name, config: { type: "remote", url: remoteUrl, enabled: true } }, 90_000)
    await sleep(4000)
    const gateSaw = egressRecords()
      .slice(before)
      .filter((r) => r.host === "ac1337-probe.invalid")
    push({
      id: `ac1.engineFetch.remoteMcp.${scheme}.viaGate`,
      grid: "ac1",
      kind: "net",
      processStarted: null,
      landed: null,
      expectLanded: null,
      ok: gateSaw.length >= 1 && gateSaw.every((r) => r.verdict === "deny" && r.reason === "unregistered"),
      detail: { url: remoteUrl, status: remote.status, body: JSON.stringify(remote.body).slice(0, 500), gateRecords: gateSaw },
    })
  }

  // ---- 时序观测(#1334 §4 的两条,只记不判;本轮只跑一次,不构成结论)
  const timeline = grepLog(readLog("main.log"), /catalog_ready|catalog_liveness\.confirmed/, 20)
  push({ id: "obs.catalogTimeline", grid: "obs", kind: "obs", processStarted: null, landed: null, expectLanded: null, ok: null, detail: { lines: timeline, g6FirstShellMs: multiFirstMs } })
} catch (error) {
  push({ id: "runner.fatal", grid: "g0", kind: "identity", processStarted: null, landed: null, expectLanded: null, ok: false, detail: String(error) })
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
  const residual = psAll().filter((l) => OUR_DIST.test(l) || l.includes(`remote-debugging-port=${CDP_PORT}`))
  const sentinelsAfter = snap()
  console.log("REAL HOME sentinels AFTER : " + JSON.stringify(sentinelsAfter))
  // 内核 Sandbox 拒绝行(--last 而不是 --start:log show 的 --start 认本地时区,toISOString 是 UTC,#1334 踩过)
  const windowSeconds = Math.ceil((Date.now() - launchedAt) / 1000) + 60
  const denyLines = run("/usr/bin/log", ["show", "--style", "compact", "--last", `${windowSeconds}s`, "--predicate", 'eventMessage CONTAINS "deny("'])
    .stdout.split("\n")
    .filter((l) => /Sandbox:/.test(l))
    .filter((l) => !/imagent|contactsd|AddressBook|assistantd|Safari|Music|com\.apple\.dt/.test(l))
    .slice(0, 400)
  const mainLog = readLog("main.log")
  const serverLog = readLog("server.log")
  const engineLog = readEngineLogs()
  const records = egressRecords()
  push({ id: "identity.realHomeUntouched", grid: "g0", kind: "identity", processStarted: null, landed: null, expectLanded: null, ok: JSON.stringify(sentinelsBefore) === JSON.stringify(sentinelsAfter), detail: { before: sentinelsBefore, after: sentinelsAfter } })
  push({ id: "identity.zeroResidualProcesses", grid: "g0", kind: "identity", processStarted: null, landed: null, expectLanded: null, ok: residual.length === 0, detail: { residual } })
  push({ id: "gN.gateLog", grid: "gN", kind: "net", processStarted: null, landed: null, expectLanded: null, ok: null, detail: { records: records.length, byTarget: egressByTarget(records) } })
  const failed = probes.filter((p) => p.ok === false)
  const strip = (s: unknown) => JSON.parse(JSON.stringify(s).split(ISO).join("<ISO>").split(REAL).join("<REAL_HOME>"))
  const result = strip({
    ticket: "alpha-code#1337",
    arm: ARM,
    identity,
    escapeDirListing: landedList(ESC),
    launchTmpListing: landedList(LAUNCH_TMP),
    defaultWsListing: landedList(DEFAULT_WS),
    wsAListing: landedList(WS_A),
    wsBListing: landedList(WS_B),
    wsCListing: landedList(WS_C),
    gateRecords: records,
    sandboxDenyLines: denyLines,
    probes,
    summary: { total: probes.length, pass: probes.filter((p) => p.ok === true).length, fail: failed.length, observational: probes.filter((p) => p.ok === null).length },
    logs: {
      main: grepLog(mainLog, /process fence|fence plan|injection|app starting|spawning sidecar|sidecar exited|self-heal|respawn|shell env|Loaded shell environment|network egress policy proxy/i, 160),
      server: grepLog(serverLog, /process fence|sandbox|fence|EPERM|not permitted|error|proxy|listen/i, 160),
      engine: grepLog(engineLog, /dependency install|NpmInstall|EPERM|not permitted|ENOTFOUND|ECONNREFUSED|fetch failed|models\.dev|ac1337|403/i, 120),
      appStderrTail: appLog.join("").slice(-4000),
    },
    finishedAt: new Date().toISOString(),
  })
  mkdirSync(dirname(OUT), { recursive: true })
  writeFileSync(OUT, JSON.stringify(result, null, 2))
  console.log(`\n${ARM}: ${result.summary.pass} pass / ${result.summary.fail} fail / ${result.summary.observational} obs -> ${OUT}`)
  console.log(`gate records: ${records.length}; sandbox deny lines captured: ${denyLines.length}`)
  console.log(`iso tree ${KEEP ? "kept" : "removed"}: ${ISO}`)
  if (!KEEP) {
    try {
      rmSync(ISO, { recursive: true, force: true })
    } catch {}
  }
  process.exit(failed.length ? 1 : 0)
}
