#!/usr/bin/env bun
// REQ-159 U3 / alpha-code#1323 —— 出货形态(打包 + Developer ID 签名 + hardened runtime + utilityProcess 的 node)
// 下装上 §8.2 全量可写集,引擎还活着吗。六格 × 两臂,判据是**探针文件到底落没落盘**(本进程 existsSync 实读),
// 不是 HTTP 状态码、不是有没有报错。
//
//   bun docs/verification/2026-09-10-req159-1323-packaged-fence/run.ts \
//     --app "<path>/Code Puppy.app" --arm fenced|unfenced [--out results/<name>.json] [--keep]
//
// 两臂:
//   fenced   —— 未改动的打包产物(围栏在 sidecar import 引擎之前 sandbox_init)。
//   unfenced —— 只存在于实验分支的一条补丁(fixture/unfenced-arm.patch:installProcessFence 顶部 warn + return)
//               打出的**同样签名**的对照包。缺这一臂,fenced 的「0 落盘」是空转。**先跑它**。
//
// 布局(README §2 有实测理由;一句话:HOME 覆盖会被产品自己的 shell-env 缓存合并覆盖掉,Electron 的
// userData/appData 又不看 $HOME,所以根只能靠产品自己的 OPENCODE_TEST_ONBOARDING 改道;它把根放在
// os.tmpdir() 之下,而生产的 $TMPDIR 在可写集 W12 里 —— 于是启动时把 TMPDIR 指到真 HOME 之下,让根落在
// W11/W12 之外,再用隔离 HOME 里的 .zshrc 把生产的 TMPDIR export 回去,sidecar 看到的 $TMPDIR 仍是出货的那个):
//   <iso>/home  = 给 app 的 HOME(~/code-puppy = W1 默认工作区、~/.npm = W7、~/.zsh_history = W8 都从它派生)
//   <iso>/tmp   = 启动时 TMPDIR ⇒ onboarding 根 <iso>/tmp/opencode-onboarding-<uuid>/{desktop(W3), alpha-code-state/env/prod(W2), data(W4), cache(W5), config(W6)}
//   <iso>/ws-a, <iso>/ws-b = 两个工作区(格 6:经产品 store IPC 写成 draft tab,再让产品的 crash self-heal 重新计划并集)
//   <iso>/ws-c  = 盘上存在、不在 store 里的第三个目录(集合外)
//   <iso>/esc   = escape 目录;另有 <iso>/tmp/outside-root-*.txt(onboarding 根的兄弟)证明 W2/W3 不是靠 W12 放行的
//
// 本文件不改任何生产代码;runner 只负责起 app、发请求、看磁盘。

import { spawn, spawnSync, type ChildProcess } from "node:child_process"
import { createServer } from "node:net"
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
const ARM = arg("--arm", "fenced") as "fenced" | "unfenced"
const FENCED = ARM === "fenced"
const OUT = arg("--out", join(HERE, "results", `${ARM}.json`))!
const KEEP = process.argv.includes("--keep")
if (!APP || !existsSync(APP)) throw new Error(`--app missing or not found: ${APP}`)

type Probe = {
  id: string
  grid: 0 | 1 | 2 | 3 | 4 | 5 | 6
  kind: "identity" | "inside" | "escape" | "obs"
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
  console.log(`[${verdict}] g${p.grid} ${p.id} landed=${p.landed} started=${p.processStarted}${p.path ? ` ${p.path}` : ""}`)
}
const sha = (p: string) => (existsSync(p) ? createHash("sha256").update(readFileSync(p)).digest("hex") : "MISSING")
const run = (cmd: string, args: string[]) => spawnSync(cmd, args, { encoding: "utf8" })

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

// ---------------------------------------------------------------- 被测件身份(先证明它是出货形态)
const APP_EXEC = join(APP, "Contents/MacOS/Code Puppy")
const ADDON = join(APP, "Contents/Resources/alpha-fence/alpha_fence.node")
const ASAR = join(APP, "Contents/Resources/app.asar")
const EXT = join(APP, "Contents/Resources/alpha-ext/plugin.js")
const csLines = (p: string) =>
  run("/usr/bin/codesign", ["-dv", "--verbose=2", p])
    .stderr.split("\n")
    .filter((l) => /^(Identifier|CodeDirectory|TeamIdentifier|Authority=Developer|Timestamp)/.test(l))
const asarCount = (needle: string) => Number(run("/usr/bin/grep", ["-a", "-c", needle, ASAR]).stdout.trim() || 0)
const verify = run("/usr/bin/codesign", ["--verify", "--deep", "--strict", "--verbose=1", APP])
const plist = (k: string) => run("/usr/libexec/PlistBuddy", ["-c", `Print :${k}`, join(APP, "Contents/Info.plist")]).stdout.trim()
Object.assign(identity, {
  ticket: "alpha-code#1323",
  arm: ARM,
  app: APP,
  bundleId: plist("CFBundleIdentifier"),
  version: plist("CFBundleShortVersionString"),
  codesignApp: csLines(APP),
  codesignAddon: csLines(ADDON),
  lipoAddon: run("/usr/bin/lipo", ["-archs", ADDON]).stdout.trim(),
  verifyDeepStrictExit: verify.status,
  verifyDeepStrictOut: (verify.stderr + verify.stdout).trim().split("\n"),
  addonBuildId: [...new Set(run("/usr/bin/grep", ["-a", "-o", "fence-[0-9TZ]*", ADDON]).stdout.match(/fence-[0-9TZ]+/g) ?? [])],
  addonSha256: sha(ADDON),
  extSha256: sha(EXT),
  asarMarkers: {
    "process fence applied": asarCount("process fence applied"),
    "process fence plan FAILED": asarCount("process fence plan FAILED"),
    "AC1323-UNFENCED": asarCount("AC1323-UNFENCED"),
    "AC1323-NONEXISTENT-NEEDLE(control)": asarCount("AC1323-NONEXISTENT-NEEDLE"),
  },
})
const csApp = (identity.codesignApp as string[]).join("\n")
const csAddon = (identity.codesignAddon as string[]).join("\n")
push({
  id: "identity.shippingForm",
  grid: 0,
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
    verify.status === 0,
  detail: { codesignApp: identity.codesignApp, codesignAddon: identity.codesignAddon, lipo: identity.lipoAddon, verifyExit: verify.status },
})
const markers = identity.asarMarkers as Record<string, number>
push({
  id: "identity.armMatchesBundle",
  grid: 0,
  kind: "identity",
  processStarted: null,
  landed: null,
  expectLanded: null,
  // unfenced 包里 `process fence applied` 是 0:打包器把实验补丁 `return` 之后的死代码整段删掉了(实测),所以那一臂只认 AC1323-UNFENCED。
  ok:
    markers["AC1323-NONEXISTENT-NEEDLE(control)"] === 0 &&
    (FENCED ? markers["process fence applied"] >= 1 && markers["AC1323-UNFENCED"] === 0 : markers["AC1323-UNFENCED"] >= 1),
  detail: markers,
})

// ---------------------------------------------------------------- 开跑前:同类残留进程(按 app 路径 + CDP 端口两条轴);owner 的 /Applications 实例不碰
const psAll = () => run("/bin/ps", ["-axo", "pid=,ppid=,command="]).stdout.split("\n").filter(Boolean)
const OUR_DIST = /\/\.worktrees\/ac-1323\/packages\/ui-mac\/dist[^ ]*\/Code Puppy\.app/
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

// ---------------------------------------------------------------- 隔离布局(真 HOME 之下)
const REAL = homedir()
const REAL_TMPDIR = process.env.TMPDIR ?? "/tmp"
const ISO = realpathSync(mkdtempSync(join(REAL, `.ac1323-${ARM}-`)))
const HOME = join(ISO, "home")
const LAUNCH_TMP = join(ISO, "tmp")
const WS_A = join(ISO, "ws-a")
const WS_B = join(ISO, "ws-b")
const WS_C = join(ISO, "ws-c")
const ESC = join(ISO, "esc")
for (const d of [HOME, LAUNCH_TMP, WS_A, WS_B, WS_C, ESC]) mkdirSync(d, { recursive: true })
for (const d of [WS_A, WS_B, WS_C]) run("/usr/bin/git", ["init", "-q", d])
// 隔离 HOME 的 rc:①有 rc 文件,交互式 zsh 才不起 zsh-newuser-install 向导(它会吃掉 PTY 里发的命令);
// ②把生产的 TMPDIR export 回去 —— 产品 preferAppEnv 会把登录 shell 的 env 合并进 process.env(「真 export 赢」),
//   于是 sidecar 拿到的 $TMPDIR 仍是 /private/var/folders 下的那个(W12),与出货一致;启动时的 TMPDIR 只用来把
//   OPENCODE_TEST_ONBOARDING 的根挪出 W11/W12。
writeFileSync(join(HOME, ".zshrc"), `# ac#1323 fixture (see run.ts header)\nexport TMPDIR=${JSON.stringify(REAL_TMPDIR)}\n`)
const DEFAULT_WS = join(HOME, "code-puppy") // 产品自己 lazy 代建(ensureUserWorkspaceDir),这里不建
Object.assign(identity, { iso: ISO, home: HOME, launchTmp: LAUNCH_TMP, defaultWorkspace: DEFAULT_WS, wsA: WS_A, wsB: WS_B, wsC: WS_C, esc: ESC, realTmpdir: REAL_TMPDIR })

// 真 HOME 的哨兵:布局若没被产品吃下去,会写到这几处 —— 前后各读一次(第一版布局就是这样被抓到的)
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

// ---------------------------------------------------------------- 起打包应用
const ENGINE_PORT = await freePort()
const CDP_PORT = await freePort()
const env: Record<string, string> = {}
for (const [k, v] of Object.entries(process.env)) {
  if (v === undefined) continue
  if (/^(XDG_|ALPHA_|OPENCODE_|VIRTUAL_ENV|ZDOTDIR|HOME$|TMPDIR$)/.test(k)) continue
  env[k] = v
}
env.HOME = HOME
env.TMPDIR = LAUNCH_TMP
env.OPENCODE_TEST_ONBOARDING = "1"
env.OPENCODE_PORT = String(ENGINE_PORT)
const launchedAt = Date.now()
const appLog: string[] = []
let child: ChildProcess | undefined
let cdp: { eval: (e: string) => Promise<any>; close: () => void } | undefined
let ROOT = ""
let USER_DATA = ""
let ALPHA_GLOBAL_ROOT = ""
let XDG_CONFIG = ""
let XDG_DATA = ""

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
        setTimeout(() => pending.has(myId) && (pending.delete(myId), rej(new Error("cdp timeout"))), 150_000)
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
const grepLog = (text: string, re: RegExp, cap = 80) => text.split("\n").filter((l) => re.test(l)).slice(0, cap)
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
  const r = await fetch(url, { method, headers, signal: AbortSignal.timeout(timeoutMs), ...(body === undefined ? {} : { body: JSON.stringify(body) }) })
  const t = await r.text()
  try {
    return { status: r.status, body: JSON.parse(t) as any }
  } catch {
    return { status: r.status, body: t.slice(0, 800) as any }
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
const MARK = "AC1323-STARTED"
const q = (p: string) => `"${p}"`
const landedList = (dir: string) => (existsSync(dir) ? readdirSync(dir).filter((f) => !f.startsWith(".")).sort() : null)
/** 一条探针记录:path 的落盘由本进程 existsSync 实读。 */
function probeFile(id: string, grid: Probe["grid"], path: string, expectLanded: boolean, started: boolean | null, detail: unknown = {}) {
  const landed = existsSync(path)
  push({ id, grid, kind: expectLanded ? "inside" : "escape", path, processStarted: started, landed, expectLanded, ok: (started === null || started) && landed === expectLanded, detail })
}
let agentName = "build"
async function shellIn(directory: string, command: string) {
  const s = await api("POST", "/session", directory, { title: `ac1323 ${ARM}` })
  const sid = s.body?.id
  if (!sid) return { status: s.status, output: "", raw: s.body, sid }
  const r = await api("POST", `/session/${sid}/shell`, directory, { agent: agentName, model: { providerID: "opencode", modelID: "big-pickle" }, command })
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

  // onboarding 根由产品在 <TMPDIR>/opencode-onboarding-<uuid> 创建(index.ts:479-497);从它派生所有落点。
  for (let i = 0; i < 120 && !ROOT; i++) {
    const found = readdirSync(LAUNCH_TMP).filter((f) => f.startsWith("opencode-onboarding-"))
    if (found.length === 1) ROOT = join(LAUNCH_TMP, found[0])
    else await sleep(250)
  }
  if (!ROOT) throw new Error(`onboarding root never appeared under ${LAUNCH_TMP}`)
  USER_DATA = join(ROOT, "desktop")
  ALPHA_GLOBAL_ROOT = join(ROOT, "alpha-code-state", "env", "prod")
  XDG_CONFIG = join(ROOT, "config")
  XDG_DATA = join(ROOT, "data")
  Object.assign(identity, { onboardingRoot: ROOT, userData: USER_DATA, alphaGlobalRoot: ALPHA_GLOBAL_ROOT, xdgConfig: XDG_CONFIG, xdgData: XDG_DATA })

  const pages = await waitForCdp(CDP_PORT, 180_000)
  cdp = await attach(pages[0].webSocketDebuggerUrl)
  for (let i = 0; i < 120; i++) {
    const t = await cdp.eval(`typeof window.api`).catch(() => "error")
    if (t === "object") break
    await sleep(500)
  }
  identity.userAgent = await cdp.eval(`navigator.userAgent`).catch(() => null)
  // awaitInitialization 只在 sidecar 健康后 resolve;fenced 拒起时它永不 resolve —— 用超时兜住,再去读日志点名原因。
  init = await Promise.race([cdp.eval(`window.api.awaitInitialization()`), sleep(150_000).then(() => undefined)])
  const mainLog0 = readLog("main.log")
  const serverLog0 = readLog("server.log")
  identity.logRun = latestRun()
  identity.appStartingLine = grepLog(mainLog0, /app starting/)[0] ?? ""
  identity.fenceMainLines = grepLog(mainLog0, /process fence|fence plan|injection|spawning sidecar|req014-preclean|shell env|Loaded shell environment/i)
  identity.fenceServerLines = grepLog(serverLog0, /process fence|AC1323|sandbox_init|dlopen|fence/i)
  if (!init?.url) {
    throw new Error(`engine never initialized (sidecar refused or died). main: ${JSON.stringify(identity.fenceMainLines)} server: ${JSON.stringify(identity.fenceServerLines)}`)
  }
  identity.engineUrl = init.url
  auth = init.username || init.password ? "Basic " + Buffer.from(`${init.username ?? ""}:${init.password ?? ""}`).toString("base64") : undefined
  const agents = await api("GET", "/agent", DEFAULT_WS)
  agentName = (Array.isArray(agents.body) && agents.body.find((a: any) => a?.name === "build")?.name) || (Array.isArray(agents.body) ? agents.body[0]?.name : undefined) || "build"
  identity.agent = agentName

  // ---- 布局自证:根在真 HOME 之下且不在 W11/W12 之下;sidecar 看到的 HOME/TMPDIR 是预期的那两个;默认工作区由产品建在隔离 HOME 里
  const envProbe = await shellIn(DEFAULT_WS, `echo ${MARK}; echo "HOME=$HOME"; echo "TMPDIR=$TMPDIR"; echo "XDG_CONFIG_HOME=$XDG_CONFIG_HOME"`)
  const seenHome = envProbe.output.match(/^HOME=(.*)$/m)?.[1] ?? ""
  const seenTmp = envProbe.output.match(/^TMPDIR=(.*)$/m)?.[1] ?? ""
  const seenXdgConfig = envProbe.output.match(/^XDG_CONFIG_HOME=(.*)$/m)?.[1] ?? ""
  const realTmpResolved = realpathSync(REAL_TMPDIR)
  push({
    id: "layout.rootsOutsideW11W12+sidecarEnv",
    grid: 0,
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
      seenHome === HOME &&
      (seenTmp.replace(/\/$/, "") === REAL_TMPDIR.replace(/\/$/, "") || (seenTmp && realpathSync(seenTmp) === realTmpResolved)) &&
      seenXdgConfig === XDG_CONFIG &&
      /packaged:\s*true/.test(String(identity.appStartingLine)),
    detail: { root: ROOT, isolatedLogs: existsSync(logsDir()), defaultWorkspaceCreatedByProduct: existsSync(DEFAULT_WS), sidecarSees: { HOME: seenHome, TMPDIR: seenTmp, XDG_CONFIG_HOME: seenXdgConfig }, appStartingLine: identity.appStartingLine },
  })

  // ============================================================ 格 1:冷启动
  let h = 0
  for (let i = 0; i < 60 && h !== 200; i++) {
    h = await health()
    if (h !== 200) await sleep(1000)
  }
  const planned = (identity.fenceMainLines as string[]).find((l) => /process fence planned/.test(l)) ?? ""
  const applied = (identity.fenceServerLines as string[]).find((l) => /process fence applied/.test(l)) ?? ""
  const unfencedLine = (identity.fenceServerLines as string[]).find((l) => /AC1323-UNFENCED/.test(l)) ?? ""
  const planFailed = (identity.fenceMainLines as string[]).find((l) => /process fence plan FAILED/.test(l)) ?? ""
  push({ id: "g1.coldStart.health200", grid: 1, kind: "obs", processStarted: null, landed: null, expectLanded: null, ok: h === 200 && !planFailed, detail: { health: h, planned, planFailed } })
  push({
    id: "g1.coldStart.fenceInstalledInSidecar",
    grid: 1,
    kind: "obs",
    processStarted: null,
    landed: null,
    expectLanded: null,
    ok: FENCED ? /process fence applied: addon=fence-\S+ libsandbox=\S+ profile=\d+B/.test(applied) : !!unfencedLine && !applied,
    detail: { applied, unfencedLine, workspacesPlanned: planned.match(/workspaces=(\d+)/)?.[1], profileBytes: planned.match(/profile=(\d+)B/)?.[1] },
  })
  const cfg = await api("GET", "/config", DEFAULT_WS)
  push({
    id: "g1.coldStart.cfgShellNotReq138Wrapper",
    grid: 1,
    kind: "obs",
    processStarted: null,
    landed: null,
    expectLanded: null,
    ok: cfg.status === 200 && !String(cfg.body?.shell ?? "").includes(join(ALPHA_GLOBAL_ROOT, "bin")),
    detail: { status: cfg.status, shell: cfg.body?.shell ?? null },
  })

  // ============================================================ 格 2:装一个连接器(MCP stdio)+ 两处 provider 目录
  const NODE = run("/usr/bin/which", ["node"]).stdout.trim() || "node"
  const mcp = await api("POST", "/mcp", DEFAULT_WS, { name: "ac1323probe", config: { type: "local", command: [NODE, MCP_PROBE, DEFAULT_WS, ESC, ARM], enabled: true } })
  await sleep(2000)
  const mcpConnected = JSON.stringify(mcp.body).includes("connected")
  push({ id: "g2.mcp.connected", grid: 2, kind: "obs", processStarted: mcpConnected, landed: null, expectLanded: null, ok: mcp.status === 200 && mcpConnected, detail: { status: mcp.status, body: mcp.body } })
  probeFile("g2.mcp.inside(W1 default ws)", 2, join(DEFAULT_WS, `mcp-${ARM}.txt`), true, mcpConnected)
  probeFile("g2.mcp.escape", 2, join(ESC, `mcp-${ARM}.txt`), !FENCED, mcpConnected)
  // W7 那一格是静默的:health 200 而 provider 装不上。两处 node_modules 都要实读有没有真装出东西(轮询,后台安装要网络)。
  const providerDirs = [join(XDG_CONFIG, "opencode", "node_modules"), join(USER_DATA, "alpha-engine-config", "node_modules")]
  const installed = (d: string) => existsSync(join(d, "@opencode-ai", "plugin", "package.json"))
  for (let i = 0; i < 150 && !providerDirs.every(installed); i++) await sleep(1000)
  const npmFail = grepLog(readEngineLogs(), /background dependency install failed|NpmInstallFailedError/, 20)
  const dirReport = providerDirs.map((d) => ({ dir: d, pluginInstalled: installed(d), topLevel: existsSync(d) ? readdirSync(d).filter((f) => !f.startsWith(".")).length : 0, sizeKB: existsSync(d) ? Number(run("/usr/bin/du", ["-sk", d]).stdout.split("\t")[0]) : 0 }))
  push({
    id: "g2.providerInstall.bothDirsPopulated(W6/W3)+npmCache(W7)",
    grid: 2,
    kind: "inside",
    processStarted: null,
    landed: providerDirs.every(installed),
    expectLanded: true,
    ok: providerDirs.every(installed) && npmFail.length === 0 && existsSync(join(HOME, ".npm", "_cacache")),
    detail: { dirs: dirReport, npmCacache: existsSync(join(HOME, ".npm", "_cacache")), npmFailLines: npmFail },
  })

  // ============================================================ 格 3:开终端
  const ptyDefault = await api("POST", "/pty", DEFAULT_WS, { cwd: DEFAULT_WS, title: "ac1323" })
  const ptyID = ptyDefault.body?.id
  push({ id: "g3.pty.default200(W15)", grid: 3, kind: "obs", processStarted: null, landed: null, expectLanded: null, ok: ptyDefault.status === 200 && !!ptyID, detail: { status: ptyDefault.status, body: ptyDefault.body } })
  let ptyOut = ""
  let ptyTicket: { status: number; body: any } | undefined
  if (ptyID) {
    ptyTicket = await api("POST", `/pty/${ptyID}/connect-token`, DEFAULT_WS, undefined, 30_000, { "x-opencode-ticket": "1" })
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
      await sleep(2500) // 让登录 shell 把 prompt 打出来
      ws.send(`echo ${MARK}; echo x > ${q(join(DEFAULT_WS, `pty-default-${ARM}.txt`))}; echo x > ${q(join(ESC, `pty-default-${ARM}.txt`))}; echo AC1323-PTY-DONE\r`)
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
  push({ id: "g3.pty.defaultLoginShellRanACommand", grid: 3, kind: "obs", processStarted: ptyStarted, landed: null, expectLanded: null, ok: ptyStarted && ptyOut.includes("AC1323-PTY-DONE"), detail: { ticketStatus: ptyTicket?.status, output: ptyOut.slice(-1500) } })
  probeFile("g3.pty.default.inside", 3, join(DEFAULT_WS, `pty-default-${ARM}.txt`), true, ptyStarted)
  probeFile("g3.pty.default.escape", 3, join(ESC, `pty-default-${ARM}.txt`), !FENCED, ptyStarted)
  push({
    id: "g3.pty.loginShellHistory(W8 obs)",
    grid: 3,
    kind: "obs",
    processStarted: ptyStarted,
    landed: existsSync(join(HOME, ".zsh_history")),
    expectLanded: null,
    ok: null,
    detail: { zshHistory: existsSync(join(HOME, ".zsh_history")), lockingFailedOrEperm: /locking failed|operation not permitted.*zsh_history/i.test(ptyOut), homeEntries: readdirSync(HOME).sort() },
  })
  const ptyCmd = await api("POST", "/pty", DEFAULT_WS, { command: "/bin/sh", args: ["-c", `echo x > ${q(join(DEFAULT_WS, `pty-cmd-${ARM}.txt`))}; echo x > ${q(join(ESC, `pty-cmd-${ARM}.txt`))}; exit 0`], cwd: DEFAULT_WS })
  await sleep(2000)
  push({ id: "g3.pty.withCommand200", grid: 3, kind: "obs", processStarted: null, landed: null, expectLanded: null, ok: ptyCmd.status === 200, detail: { status: ptyCmd.status, body: ptyCmd.body } })
  probeFile("g3.pty.command.inside", 3, join(DEFAULT_WS, `pty-cmd-${ARM}.txt`), true, ptyCmd.status === 200)
  probeFile("g3.pty.command.escape", 3, join(ESC, `pty-cmd-${ARM}.txt`), !FENCED, ptyCmd.status === 200)

  // ============================================================ 格 4:shell 工具(POST /session/:id/shell;显式 model 绕开 provider 解析;shellImpl 不发 LLM 请求)
  const sh = await shellIn(
    DEFAULT_WS,
    `echo ${MARK}; echo x > ${q(join(DEFAULT_WS, `shelltool-${ARM}.txt`))}; echo x > ${q(join(ESC, `shelltool-${ARM}.txt`))}; echo x > ${q(join(LAUNCH_TMP, `outside-root-${ARM}.txt`))}; echo done`,
  )
  const shStarted = sh.output.includes(MARK)
  push({
    id: "g4.shellTool.ranToCompletion(AC2: zsh's own EPERM, not sandbox_apply exit 71)",
    grid: 4,
    kind: "obs",
    processStarted: shStarted,
    landed: null,
    expectLanded: null,
    ok: sh.status === 200 && shStarted && sh.output.includes("done") && !sh.output.includes("sandbox_apply") && (FENCED ? /operation not permitted/i.test(sh.output) : !/not permitted/i.test(sh.output)),
    detail: { status: sh.status, output: sh.output.slice(0, 800) },
  })
  probeFile("g4.shellTool.inside(W1)", 4, join(DEFAULT_WS, `shelltool-${ARM}.txt`), true, shStarted)
  probeFile("g4.shellTool.escape", 4, join(ESC, `shelltool-${ARM}.txt`), !FENCED, shStarted)
  probeFile("g4.shellTool.escape.siblingOfOnboardingRoot(W2/W3 not via W12)", 4, join(LAUNCH_TMP, `outside-root-${ARM}.txt`), !FENCED, shStarted)

  // ============================================================ 格 5:写项目配置(W2 注入 + W3 引擎配置 + W1 .code-puppy)
  const alphaJsonc = join(ALPHA_GLOBAL_ROOT, "alpha.jsonc")
  const engineCfgDir = join(USER_DATA, "alpha-engine-config")
  const injectionLines = grepLog(readLog("main.log"), /injection/i)
  push({
    id: "g5.injection.alphaGlobalRoot(W2)+engineConfig(W3)",
    grid: 5,
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
  push({ id: "g5.extLoadedInSidecar(alpha_register present)", grid: 5, kind: "obs", processStarted: null, landed: null, expectLanded: null, ok: toolIds.status === 200 && ids.includes("alpha_register"), detail: { status: toolIds.status, alphaTools: ids.filter((i) => i.startsWith("alpha_")) } })
  const cp = await shellIn(DEFAULT_WS, `echo ${MARK}; mkdir -p .code-puppy && echo '{"ac1323":"${ARM}"}' > ${q(join(DEFAULT_WS, ".code-puppy", `ac1323-${ARM}.json`))}; echo done`)
  probeFile("g5.workspaceDotCodePuppy(W1, via shell tool — not alpha_register)", 5, join(DEFAULT_WS, ".code-puppy", `ac1323-${ARM}.json`), true, cp.output.includes(MARK), { output: cp.output.slice(0, 300) })

  // ============================================================ 格 6:多工作区(启动时并集)
  // 第一代的并集只有 ~/code-puppy(store 是新的)。走产品自己的两条路把两个工作区送进并集:
  //   ① renderer 的 store IPC(window.api.storeSet → opencode.global.dat 的 tabs / tabs.recent,与真 tab 栏落盘同一条路);
  //   ② 杀掉 sidecar(SIGKILL utilityProcess)⇒ main 的 crash self-heal 1 s 后 respawn ⇒ spawnLocalServer 重新计划(读 store)⇒ 并集 = 3。
  const tabs = JSON.stringify([
    { type: "draft", draftID: "ac1323-a", server: "sidecar", directory: WS_A },
    { type: "draft", draftID: "ac1323-b", server: "sidecar", directory: WS_B },
  ])
  await cdp.eval(`window.api.storeSet("opencode.global.dat","tabs",${JSON.stringify(tabs)})`)
  await cdp.eval(`window.api.storeSet("opencode.global.dat","tabs.recent",${JSON.stringify(JSON.stringify({ key: "draft:ac1323-a" }))})`)
  const tabsRead = await cdp.eval(`window.api.storeGet("opencode.global.dat","tabs")`).catch((e: Error) => `error:${e.message}`)
  const gen1Pids = sidecarPids()
  for (const pid of gen1Pids) {
    try {
      process.kill(pid, "SIGKILL")
    } catch {}
  }
  let downSeen = false
  for (let i = 0; i < 40; i++) {
    const s = await health()
    if (s !== 200) downSeen = true
    if (downSeen && s === 200) break
    await sleep(500)
  }
  await sleep(2000) // 让 ready / prewarm 落定
  const mainLog2 = readLog("main.log")
  const plannedAll = grepLog(mainLog2, /process fence planned/)
  const planned2 = plannedAll[1] ?? ""
  const respawnLines = grepLog(mainLog2, /sidecar exited|self-heal|respawn|process fence planned|spawning sidecar/i)
  const applied2 = grepLog(readLog("server.log"), /process fence applied|AC1323-UNFENCED/)
  push({
    id: "g6.union.selfHealRespawnRePlannedThree",
    grid: 6,
    kind: "obs",
    processStarted: gen1Pids.length > 0 && downSeen,
    landed: null,
    expectLanded: null,
    ok: gen1Pids.length > 0 && downSeen && (await health()) === 200 && /workspaces=3 \(candidates=3/.test(planned2) && (FENCED ? applied2.filter((l) => /applied/.test(l)).length >= 2 : applied2.length >= 2),
    detail: { gen1Pids, tabsReadBack: tabsRead, plannedAll, respawnLines, fenceLinesAfter: applied2 },
  })
  const multi = await shellIn(WS_B, `echo ${MARK}; echo x > ${q(join(WS_B, `multi-${ARM}.txt`))}; echo x > ${q(join(WS_A, `multi-${ARM}.txt`))}; echo x > ${q(join(DEFAULT_WS, `multi-${ARM}.txt`))}; echo x > ${q(join(WS_C, `multi-${ARM}.txt`))}; echo done`)
  const multiStarted = multi.output.includes(MARK)
  probeFile("g6.union.wsB.inside", 6, join(WS_B, `multi-${ARM}.txt`), true, multiStarted)
  probeFile("g6.union.wsA.inside", 6, join(WS_A, `multi-${ARM}.txt`), true, multiStarted)
  probeFile("g6.union.defaultWorkspace.inside", 6, join(DEFAULT_WS, `multi-${ARM}.txt`), true, multiStarted)
  probeFile("g6.union.wsC.outsideStore", 6, join(WS_C, `multi-${ARM}.txt`), !FENCED, multiStarted, { status: multi.status, output: multi.output.slice(0, 600) })
  const cwdC = await shellIn(WS_C, `echo ${MARK}; echo x > ./multi-cwd-${ARM}.txt; echo done`)
  probeFile("g6.union.wsC.asSessionCwd", 6, join(WS_C, `multi-cwd-${ARM}.txt`), !FENCED, cwdC.output.includes(MARK), { status: cwdC.status, output: cwdC.output.slice(0, 400) })
} catch (error) {
  push({ id: "runner.fatal", grid: 0, kind: "identity", processStarted: null, landed: null, expectLanded: null, ok: false, detail: String(error) })
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
  const mainLog = readLog("main.log")
  const serverLog = readLog("server.log")
  const engineLog = readEngineLogs()
  push({ id: "identity.realHomeUntouched", grid: 0, kind: "identity", processStarted: null, landed: null, expectLanded: null, ok: JSON.stringify(sentinelsBefore) === JSON.stringify(sentinelsAfter), detail: { before: sentinelsBefore, after: sentinelsAfter } })
  push({ id: "identity.zeroResidualProcesses", grid: 0, kind: "identity", processStarted: null, landed: null, expectLanded: null, ok: residual.length === 0, detail: { residual } })
  const failed = probes.filter((p) => p.ok === false)
  const strip = (s: unknown) => JSON.parse(JSON.stringify(s).split(ISO).join("<ISO>").split(REAL).join("<REAL_HOME>"))
  const result = strip({
    ticket: "alpha-code#1323",
    arm: ARM,
    identity,
    escapeDirListing: landedList(ESC),
    launchTmpListing: landedList(LAUNCH_TMP),
    defaultWsListing: landedList(DEFAULT_WS),
    wsAListing: landedList(WS_A),
    wsBListing: landedList(WS_B),
    wsCListing: landedList(WS_C),
    probes,
    summary: { total: probes.length, pass: probes.filter((p) => p.ok === true).length, fail: failed.length, observational: probes.filter((p) => p.ok === null).length },
    logs: {
      main: grepLog(mainLog, /process fence|fence plan|injection|app starting|spawning sidecar|req014-preclean|alpha-ext|sidecar exited|self-heal|respawn|shell env|Loaded shell environment/i, 120),
      server: grepLog(serverLog, /process fence|AC1323|sandbox|fence|EPERM|not permitted|error/i, 120),
      engine: grepLog(engineLog, /dependency install|NpmInstall|EPERM|not permitted|ac1323/i, 60),
      appStderrTail: appLog.join("").slice(-3000),
    },
    finishedAt: new Date().toISOString(),
  })
  mkdirSync(dirname(OUT), { recursive: true })
  writeFileSync(OUT, JSON.stringify(result, null, 2))
  console.log(`\n${ARM}: ${result.summary.pass} pass / ${result.summary.fail} fail / ${result.summary.observational} obs -> ${OUT}`)
  console.log(`iso tree ${KEEP ? "kept" : "removed"}: ${ISO}`)
  if (!KEEP) {
    try {
      rmSync(ISO, { recursive: true, force: true })
    } catch {}
  }
  process.exit(failed.length ? 1 : 0)
}
