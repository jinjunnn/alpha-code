#!/usr/bin/env bun
// REQ-138 AC4 / alpha-code#1076 —— 在**打包后的 Electron sidecar** 里复跑基线 §2.5/§2.6 的
// 正反语料 + §2.8 误伤集 + §5 第二条(会写盘的 rc)。
//
//   bun docs/verification/2026-08-26-req138-1076-packaged-sandbox/run.ts \
//     --app <path-to-alpha-code.app> --arm fenced|unfenced|hardened [--out results/<name>.json]
//
// 判据(父票 #1074 的 I3):每条只记「**文件是否落盘**」,不记 exit code —— 基线 §2.5 实测
// nohup 那条 exit 0 而未落盘。
//
// 驱动面 = 打包产品自己的 HTTP 路由 `POST /session/:id/shell`(引擎 prompt 的 `!command` 通路,
// packages/opencode/src/session/prompt.ts:shellImpl → Shell.preferred(cfg.shell) + Shell.args)。
// 它跑在 **sidecar utilityProcess 内**,与 shell 工具共用同一个 cfg.shell / 同一份 profile /
// 同一个 sandbox-exec。整条链上没有本 runner 的代码:runner 只负责起 app、发请求、看磁盘。
//
// 三个臂:
//   fenced    —— 未改动的打包产物。
//   unfenced  —— 同一份产物的副本,只把 Contents/Resources/alpha-ext/plugin.js 里 WRAPPER_SCRIPT
//                的那一行 `exec /usr/bin/sandbox-exec ...` 换成 `exec "$ALPHA_REAL_SHELL" "$@"`
//                (= 基线 §2.6 的同一处变异)。**缺这一臂,fenced 的全绿是空转。**
//   hardened  —— 副本 + `codesign --options runtime --entitlements resources/entitlements.plist`
//                ad-hoc 重签,逼近出厂签名形态(本机 electron-builder 在无证书时不开 hardened runtime)。
//
// 逃逸目标与 rc 夹具都建在 $HOME 下的唯一临时子目录($HOME 不在 profile 的可写闭集内),跑完删除。

import { spawn, spawnSync, type ChildProcess } from "node:child_process"
import { createServer } from "node:net"
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs"
import { homedir, tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"
import { createHash } from "node:crypto"

const HERE = dirname(fileURLToPath(import.meta.url))
const REPO = join(HERE, "..", "..", "..")

function arg(name: string, fallback?: string) {
  const i = process.argv.indexOf(name)
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : fallback
}
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

const APP = arg("--app", join(REPO, "packages/ui-mac/dist/mac-arm64/alpha-code.app"))!
const ARM = (arg("--arm", "fenced") as "fenced" | "unfenced" | "hardened" | "hardened-unfenced")!
/** 这一臂的 wrapper 是不是被摘掉了围栏 —— 所有「该不该落盘」的期望值都由它一个开关决定。 */
const FENCE_REMOVED = ARM.includes("unfenced")
const OUT = arg("--out", join(HERE, "results", `${ARM}.json`))!

type Probe = {
  id: string
  kind: "escape" | "benign" | "rc" | "identity"
  command?: string
  processStarted: boolean | null
  landed: boolean | null
  expectLanded: boolean | null
  ok: boolean | null
  detail: unknown
}
const probes: Probe[] = []
const identity: Record<string, unknown> = {}

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

// ---------------------------------------------------------------- CDP (credentials only)
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
        ws.send(
          JSON.stringify({
            id: myId,
            method: "Runtime.evaluate",
            params: { expression, awaitPromise: true, returnByValue: true },
          }),
        )
        setTimeout(() => pending.has(myId) && (pending.delete(myId), rej(new Error("cdp timeout"))), 120_000)
      })
      if (r.exceptionDetails) throw new Error(`eval threw: ${r.exceptionDetails.exception?.description ?? "?"}`)
      return r.result?.value
    },
    close: () => ws.close(),
  }
}

// ---------------------------------------------------------------- fixtures
const ENGINE_PORT = await freePort()
const CDP_PORT = await freePort()

// 工作区**故意不放 /private/tmp 或 /private/var/folders** —— 那两条前缀本来就在 profile 的可写
// 闭集里,放那儿会让「工作区内可写」这一格恒真、测不出 `-D WORKDIR="$(pwd)"` 在打包态到底解析成了什么。
const WS = mkdtempSync(join(homedir(), ".ac1076-ws-"))
const ESCAPE_DIR = mkdtempSync(join(homedir(), ".ac1076-escape-"))
const ESCAPE_TARGET = join(ESCAPE_DIR, "pwned.txt")
const RC_HOME = mkdtempSync(join(homedir(), ".ac1076-rchome-"))
const RC_DUMP = join(RC_HOME, ".zcompdump")
const RC_HIST = join(RC_HOME, ".rc-history")
const RC_MARK = join(RC_HOME, ".rc-ran")

// 会写盘的 rc(基线 §5 第二条:.zcompdump / 历史文件)。三处写:compinit 的 dump、一个历史式
// 追加、一个 marker。marker 用来区分「rc 根本没跑」与「rc 跑了但写不进去」。
writeFileSync(
  join(RC_HOME, ".zshrc"),
  [
    `# ac#1076 rc fixture — a startup file that writes to disk`,
    `autoload -Uz compinit`,
    `compinit -u -d "${RC_DUMP}"`,
    `print -r -- "rc ran $(date +%s)" >> "${RC_HIST}"`,
    `print -r -- ok > "${RC_MARK}"`,
    `export AC1076_RC_SOURCED=1`,
    ``,
  ].join("\n"),
)
writeFileSync(join(RC_HOME, ".zshenv"), `export AC1076_ZSHENV_SOURCED=1\n`)

const APP_EXEC = join(APP, "Contents/MacOS/alpha-code")
const EXT_BUNDLE = join(APP, "Contents/Resources/alpha-ext/plugin.js")
const sha = (p: string) => (existsSync(p) ? createHash("sha256").update(readFileSync(p)).digest("hex") : "MISSING")
const plist = (k: string) =>
  spawnSync("/usr/libexec/PlistBuddy", ["-c", `Print :${k}`, join(APP, "Contents/Info.plist")], {
    encoding: "utf8",
  }).stdout.trim()

let child: ChildProcess | undefined
const appLog: string[] = []
const started = new Date().toISOString()

function push(p: Probe) {
  probes.push(p)
  const verdict = p.ok === null ? "SKIP" : p.ok ? "ok" : "FAIL"
  console.log(`[${verdict}] ${p.id} landed=${p.landed} started=${p.processStarted}`)
}

try {
  // ------------------------------------------------------------ 被测件身份
  const extText = existsSync(EXT_BUNDLE) ? readFileSync(EXT_BUNDLE, "utf8") : ""
  const fenceLine = 'exec /usr/bin/sandbox-exec -f "$ALPHA_SB_PROFILE" -D WORKDIR="$(pwd)" "$ALPHA_REAL_SHELL" "$@"'
  const bundleHasFence = extText.includes(fenceLine)
  const csFlags = spawnSync("/usr/bin/codesign", ["-dv", APP], { encoding: "utf8" }).stderr
  Object.assign(identity, {
    arm: ARM,
    app: APP,
    appExecExists: existsSync(APP_EXEC),
    bundleId: plist("CFBundleIdentifier"),
    version: plist("CFBundleShortVersionString"),
    extBundleSha256: sha(EXT_BUNDLE),
    bundleWrapperIsFenced: bundleHasFence,
    codesign: csFlags.trim().split("\n").filter((l) => /CodeDirectory|Signature|Identifier=/.test(l)),
    workspace: WS,
    escapeTarget: ESCAPE_TARGET,
    rcHome: RC_HOME,
    ports: { engine: ENGINE_PORT, cdp: CDP_PORT },
    startedAt: started,
  })
  push({
    id: "identity.armMatchesBundle",
    kind: "identity",
    processStarted: null,
    landed: null,
    expectLanded: null,
    ok: FENCE_REMOVED ? !bundleHasFence : bundleHasFence,
    detail: { arm: ARM, bundleWrapperIsFenced: bundleHasFence, sha: sha(EXT_BUNDLE) },
  })

  // ------------------------------------------------------------ 起打包应用
  child = spawn(APP_EXEC, [`--remote-debugging-port=${CDP_PORT}`], {
    env: {
      ...process.env,
      OPENCODE_TEST_ONBOARDING: "1",
      OPENCODE_PORT: String(ENGINE_PORT),
      // 产品自带的 A6 逃生阀(sidecar-env.ts EXACT 里就有它),用来让引擎自己的登录 shell
      // 去 source 我们那份**会写盘的** rc —— 这就是基线 §5 第二条要的那一跑。
      ALPHA_ENV_ALLOWLIST_EXTRA: "ZDOTDIR",
      ZDOTDIR: RC_HOME,
    },
    stdio: ["ignore", "pipe", "pipe"],
  })
  child.stdout?.on("data", (b) => appLog.push(b.toString()))
  child.stderr?.on("data", (b) => appLog.push(b.toString()))

  const cdp = await attach((await waitForCdp(CDP_PORT, 180_000))[0].webSocketDebuggerUrl)
  await sleep(6000)
  const init = await cdp.eval(`window.api.awaitInitialization()`)
  identity.engineUrl = init?.url
  const auth =
    init?.username || init?.password
      ? "Basic " + Buffer.from(`${init.username ?? ""}:${init.password ?? ""}`).toString("base64")
      : undefined

  const api = async (method: string, path: string, body?: unknown, timeoutMs = 120_000) => {
    const headers: Record<string, string> = { "content-type": "application/json" }
    if (auth) headers.Authorization = auth
    const r = await fetch(String(init.url) + path, {
      method,
      headers,
      signal: AbortSignal.timeout(timeoutMs),
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    })
    const t = await r.text()
    try {
      return { status: r.status, body: JSON.parse(t) }
    } catch {
      return { status: r.status, body: t.slice(0, 800) }
    }
  }

  // wait for the engine socket
  for (let i = 0; i < 120; i++) {
    try {
      const h = await fetch(`http://127.0.0.1:${ENGINE_PORT}/global/health`, { signal: AbortSignal.timeout(3000) })
      if (h.ok) break
    } catch {}
    await sleep(1000)
  }

  // 被测件身份的最后一环:主进程自己报的 app.isPackaged。dev 态的 ext bundle 走
  // out/main/../../ext/dist/plugin.js,只有 packaged 才走 Contents/Resources/alpha-ext/。
  const bootLine = appLog.join("").split("\n").find((l) => l.includes("app starting")) ?? ""
  identity.appStartingLine = bootLine
  push({
    id: "identity.appIsPackaged",
    kind: "identity",
    processStarted: null,
    landed: null,
    expectLanded: null,
    ok: /packaged:\s*true/.test(bootLine),
    detail: { line: bootLine },
  })

  // ------------------------------------------------------------ 矩阵 1:cfg.shell 指向 wrapper
  const dq = `?directory=${encodeURIComponent(WS)}`
  const cfg = await api("GET", `/config${dq}`)
  const cfgShell: string | undefined = (cfg.body as any)?.shell
  const wrapperText = cfgShell && existsSync(cfgShell) ? readFileSync(cfgShell, "utf8") : ""
  const profilePath = cfgShell ? join(dirname(dirname(cfgShell)), "sandbox", "alpha-shell.sb") : ""
  const profileText = profilePath && existsSync(profilePath) ? readFileSync(profilePath, "utf8") : ""
  identity.cfgShell = cfgShell
  identity.wrapperText = wrapperText
  identity.profilePath = profilePath
  identity.profileText = profileText
  push({
    id: "m1.cfgShellIsWrapper",
    kind: "identity",
    processStarted: null,
    landed: null,
    expectLanded: null,
    ok:
      !!cfgShell &&
      /\/bin\/zsh$/.test(cfgShell) &&
      !cfgShell.startsWith("/bin/") &&
      existsSync(cfgShell) &&
      wrapperText.startsWith("#!/bin/sh"),
    detail: { status: cfg.status, cfgShell, wrapperText, profileExists: !!profileText },
  })
  push({
    id: "m1.wrapperRunsSandboxExec",
    kind: "identity",
    processStarted: null,
    landed: null,
    expectLanded: null,
    ok: FENCE_REMOVED ? !wrapperText.includes("sandbox-exec") : wrapperText.includes("/usr/bin/sandbox-exec"),
    detail: { arm: ARM, wrapperText },
  })

  // ------------------------------------------------------------ session
  const session = await api("POST", `/session${dq}`, { title: "REQ-138 AC4 #1076" })
  const sid = (session.body as any)?.id
  identity.sessionID = sid
  const agents = await api("GET", `/agent${dq}`)
  const agentName =
    (Array.isArray(agents.body) && (agents.body as any[]).find((a) => a?.name === "build")?.name) ||
    (Array.isArray(agents.body) ? (agents.body as any[])[0]?.name : undefined) ||
    "build"
  identity.agent = agentName
  identity.agentsSeen = Array.isArray(agents.body) ? (agents.body as any[]).map((a) => a?.name) : agents.body
  if (!sid) throw new Error(`no session: ${JSON.stringify(session).slice(0, 400)}`)

  // 一条命令 = 打包 sidecar 里的一次真实 shell 派生。返回体里带 part.state.output。
  const MARK = "AC1076-STARTED"
  async function runShell(command: string, timeoutMs = 120_000) {
    const r = await api("POST", `/session/${sid}/shell${dq}`, {
      agent: agentName,
      command,
      model: { providerID: "ac1076-probe", modelID: "ac1076-probe" },
    }, timeoutMs)
    const part = (r.body as any)?.parts?.[0]
    const output: string = part?.state?.output ?? part?.state?.metadata?.output ?? ""
    return { status: r.status, output, raw: r.body }
  }

  // ------------------------------------------------------------ 矩阵 2/3:逃逸语料
  // 每条命令都先 `echo AC1076-STARTED` —— 空输出不算「拦住了」,必须证明进程真的起来过。
  const corpus: Array<[string, string]> = [
    ["redirect >", `echo ${MARK}; echo pwned > ${ESCAPE_TARGET}`],
    ["redirect >>", `echo ${MARK}; echo pwned >> ${ESCAPE_TARGET}`],
    ["via /bin/sh", `echo ${MARK}; /bin/sh -c 'echo pwned > ${ESCAPE_TARGET}'`],
    ["via python3", `echo ${MARK}; python3 -c 'open("${ESCAPE_TARGET}","w").write("x")'`],
    ["via node", `echo ${MARK}; node -e 'require("fs").writeFileSync("${ESCAPE_TARGET}","x")'`],
    ["nohup detach", `echo ${MARK}; nohup sh -c 'echo pwned > ${ESCAPE_TARGET}' >/dev/null 2>&1 || true`],
    ["symlink out", `echo ${MARK}; ln -sf ${ESCAPE_TARGET} link && echo pwned > link`],
  ]
  for (const [tag, command] of corpus) {
    rmSync(ESCAPE_TARGET, { force: true })
    rmSync(join(WS, "link"), { force: true })
    const r = await runShell(command)
    await sleep(600) // nohup 是后台派生,给它一拍再判
    const landed = existsSync(ESCAPE_TARGET)
    const processStarted = r.output.includes(MARK)
    push({
      id: `m2.escape/${tag}`,
      kind: "escape",
      command,
      processStarted,
      landed,
      expectLanded: FENCE_REMOVED,
      ok: processStarted && landed === FENCE_REMOVED,
      detail: { httpStatus: r.status, output: r.output.slice(0, 600) },
    })
  }
  rmSync(ESCAPE_TARGET, { force: true })

  // ------------------------------------------------------------ 2b:shell **工具**的 argv 形状
  // 上面那 7 条走的是 prompt `!command` 通路(基线 §2.4:`["-l","-c",script,"opencode",cwd]`)。
  // shell **工具**走的是另一个形状(基线 §2.2:`["-c", cmd]`),而它要一次真模型回合才发得动。
  // 这里退一步、但**不靠推理**:先从打包 sidecar 的 shell 里把它继承到的两个环境变量原样读出来
  // (它们本身就是「env 有没有传下去」的直接观测),再用**读到的那两个值** + 打包产物落下的
  // 那个 wrapper,以工具的 argv 形状把同一套语料跑一遍。
  // 口径:父进程是本 runner,不是 sidecar —— 这一格测的是「打包态产出的 wrapper/profile 在
  // 工具 argv 形状下成不成立」,不是「工具在 sidecar 里跑过了」。README 的未验证项写明了这条。
  const envDump = await runShell(`echo ${MARK}; echo "SBP=\${ALPHA_SB_PROFILE} RSH=\${ALPHA_REAL_SHELL}"`)
  const sbp = envDump.output.match(/SBP=(\S*)/)?.[1] ?? ""
  const rsh = envDump.output.match(/RSH=(\S*)/)?.[1] ?? ""
  identity.observedSbProfile = sbp
  identity.observedRealShell = rsh
  push({
    id: "m2b.envReachesSidecarShell",
    kind: "identity",
    command: "(read ALPHA_SB_PROFILE / ALPHA_REAL_SHELL from inside the packaged sidecar's shell)",
    processStarted: envDump.output.includes(MARK),
    landed: null,
    expectLanded: null,
    ok: sbp === profilePath && !!rsh && existsSync(rsh) && !rsh.startsWith(dirname(String(cfgShell))),
    detail: { sbp, rsh, expectedProfile: profilePath, output: envDump.output.slice(0, 400) },
  })
  if (cfgShell && sbp && rsh) {
    for (const [tag, command] of corpus) {
      rmSync(ESCAPE_TARGET, { force: true })
      rmSync(join(WS, "link"), { force: true })
      const r = spawnSync(command, [], {
        shell: cfgShell,
        cwd: WS,
        env: { ...process.env, ALPHA_SB_PROFILE: sbp, ALPHA_REAL_SHELL: rsh },
        stdio: "pipe",
        encoding: "utf8",
      })
      await sleep(600)
      const landed = existsSync(ESCAPE_TARGET)
      const out = `${r.stdout ?? ""}${r.stderr ?? ""}`
      push({
        id: `m2b.toolArgv/${tag}`,
        kind: "escape",
        command,
        processStarted: out.includes(MARK),
        landed,
        expectLanded: FENCE_REMOVED,
        ok: out.includes(MARK) && landed === FENCE_REMOVED,
        detail: { exitCode: r.status, output: out.slice(0, 600) },
      })
    }
    rmSync(ESCAPE_TARGET, { force: true })
    rmSync(join(WS, "link"), { force: true })
  }

  // ------------------------------------------------------------ 矩阵 4:误伤集(基线 §2.8)
  // 判据仍是产物,不是 exit code:能落的落了、该读到的读到了。
  const repoProbeFile = join(REPO, "package.json")
  const benign: Array<[string, string, (o: string) => { ok: boolean; landed: boolean | null; detail: unknown }]> = [
    [
      "workspace write (WORKDIR)",
      `echo ${MARK}; echo ok > inside.txt; ls inside.txt`,
      (o) => {
        const landed = existsSync(join(WS, "inside.txt"))
        return { ok: o.includes(MARK) && landed, landed, detail: { file: join(WS, "inside.txt") } }
      },
    ],
    [
      "/private/tmp write",
      `echo ${MARK}; echo ok > /private/tmp/ac1076-tmp-probe.txt`,
      (o) => {
        const landed = existsSync("/private/tmp/ac1076-tmp-probe.txt")
        return { ok: o.includes(MARK) && landed, landed, detail: {} }
      },
    ],
    [
      "git init + commit",
      `echo ${MARK}; mkdir -p fp-git && cd fp-git && git init -q . && echo hi > a.txt && git add a.txt && git -c user.email=ac1076@example.com -c user.name=ac1076 commit -q -m probe && git rev-parse HEAD`,
      (o) => {
        const landed = existsSync(join(WS, "fp-git", ".git"))
        const sha40 = /\b[0-9a-f]{40}\b/.test(o)
        return { ok: o.includes(MARK) && landed && sha40, landed, detail: { sha40 } }
      },
    ],
    [
      "node writes TMPDIR",
      `echo ${MARK}; node -e 'const os=require("os"),fs=require("fs"),p=os.tmpdir()+"/ac1076-node-"+process.pid+".txt";fs.writeFileSync(p,"ok");console.log("NODEWROTE="+p)'`,
      (o) => {
        const m = o.match(/NODEWROTE=(\S+)/)
        const landed = !!m && existsSync(m[1])
        return { ok: o.includes(MARK) && landed, landed, detail: { path: m?.[1] } }
      },
    ],
    [
      "read repo file",
      `echo ${MARK}; head -c 40 ${repoProbeFile}`,
      (o) => ({ ok: o.includes(MARK) && o.includes("{"), landed: null, detail: { file: repoProbeFile } }),
    ],
    [
      "curl",
      `echo ${MARK}; curl -sS -o /dev/null -m 20 -w 'CURL=%{http_code}' https://example.com; echo`,
      (o) => {
        const m = o.match(/CURL=(\d{3})/)
        return { ok: o.includes(MARK) && !!m && m[1] !== "000", landed: null, detail: { code: m?.[1] ?? "none" } }
      },
    ],
    [
      "mkdir -p deep",
      `echo ${MARK}; mkdir -p d1/d2/d3/d4 && test -d d1/d2/d3/d4 && echo MKDIR-OK`,
      (o) => {
        const landed = existsSync(join(WS, "d1/d2/d3/d4"))
        return { ok: o.includes(MARK) && o.includes("MKDIR-OK") && landed, landed, detail: {} }
      },
    ],
    [
      "grep",
      `echo ${MARK}; printf 'aaa\\nbbb\\n' > g.txt && grep -c bbb g.txt`,
      (o) => ({ ok: o.includes(MARK) && /^\s*1\s*$/m.test(o), landed: existsSync(join(WS, "g.txt")), detail: {} }),
    ],
    [
      "which git node",
      `echo ${MARK}; which git node`,
      (o) => ({ ok: o.includes(MARK) && /\/git/.test(o) && /node/.test(o), landed: null, detail: {} }),
    ],
  ]
  for (const [tag, command, judge] of benign) {
    const r = await runShell(command)
    const j = judge(r.output)
    push({
      id: `m4.benign/${tag}`,
      kind: "benign",
      command,
      processStarted: r.output.includes(MARK),
      landed: j.landed,
      expectLanded: j.landed === null ? null : true,
      ok: j.ok,
      detail: { httpStatus: r.status, output: r.output.slice(0, 600), ...(j.detail as object) },
    })
  }
  try {
    rmSync("/private/tmp/ac1076-tmp-probe.txt", { force: true })
  } catch {}

  // ------------------------------------------------------------ 矩阵 5:会写盘的 rc(基线 §5 第二条)
  // 引擎自己的登录 shell 会 source `${ZDOTDIR:-$HOME}/.zshrc`(Shell.args 的 zsh 分支)。
  // 我们把 ZDOTDIR 指向 RC_HOME(不在可写闭集内),rc 里三处写盘 + 一个 env marker。
  const rcBefore = readdirSync(RC_HOME).sort()
  const rc = await runShell(`echo ${MARK}; echo "RCSOURCED=\${AC1076_RC_SOURCED:-0} ZSHENV=\${AC1076_ZSHENV_SOURCED:-0}"`)
  await sleep(400)
  const rcAfter = readdirSync(RC_HOME).sort()
  const sourced = /RCSOURCED=1/.test(rc.output)
  push({
    id: "m5.rcWritingStartupFile",
    kind: "rc",
    command: "(engine's own Shell.args login script sources ${ZDOTDIR}/.zshrc)",
    processStarted: rc.output.includes(MARK),
    landed: existsSync(RC_DUMP) || existsSync(RC_HIST) || existsSync(RC_MARK),
    expectLanded: FENCE_REMOVED,
    ok:
      rc.output.includes(MARK) &&
      sourced &&
      (existsSync(RC_DUMP) || existsSync(RC_HIST) || existsSync(RC_MARK)) === FENCE_REMOVED,
    detail: {
      httpStatus: rc.status,
      output: rc.output.slice(0, 600),
      rcSourced: sourced,
      zcompdump: existsSync(RC_DUMP),
      rcHistory: existsSync(RC_HIST),
      rcMarker: existsSync(RC_MARK),
      rcHomeBefore: rcBefore,
      rcHomeAfter: rcAfter,
    },
  })
  // 同一份 rc 再 source 一次,但**不**重定向 stderr —— 引擎自己那条是
  // `source ... >/dev/null 2>&1 || true`,用户看不见任何东西;这一格记录「如果看得见,
  // 会看见什么」,以及写被拒之后 shell 还继续不继续。
  // 命令串会被 Shell.args 塞进一层双引号再 eval,`$` 会**提前一轮**在外层展开 —— 这里一个 `$` 都不写。
  const rcLoud = await runShell(
    `echo ${MARK}; source ${RC_HOME}/.zshrc 2>&1; echo RC-AFTER-SOURCE-CONTINUED`,
  )
  push({
    id: "m5.rcErrorsAsSeenByUser",
    kind: "rc",
    command: "(same writing rc, sourced again with stderr NOT suppressed)",
    processStarted: rcLoud.output.includes(MARK),
    landed: existsSync(RC_DUMP) || existsSync(RC_HIST) || existsSync(RC_MARK),
    expectLanded: FENCE_REMOVED,
    ok: null, // 观测项:记录用户会看到什么,不做通过/不通过判定
    detail: {
      httpStatus: rcLoud.status,
      output: rcLoud.output.slice(0, 1200),
      shellContinuedAfterRc: rcLoud.output.includes("RC-AFTER-SOURCE-CONTINUED"),
    },
  })
} catch (error) {
  push({
    id: "runner.fatal",
    kind: "identity",
    processStarted: null,
    landed: null,
    expectLanded: null,
    ok: false,
    detail: String(error),
  })
} finally {
  try {
    child?.kill("SIGTERM")
  } catch {}
  await sleep(1500)
  spawnSync("/usr/bin/pkill", ["-f", `remote-debugging-port=${CDP_PORT}`])
  for (const d of [WS, ESCAPE_DIR, RC_HOME]) {
    try {
      rmSync(d, { recursive: true, force: true })
    } catch {}
  }
  const failed = probes.filter((p) => p.ok === false)
  const result = {
    ticket: "alpha-code#1076",
    arm: ARM,
    identity,
    probes,
    summary: {
      total: probes.length,
      pass: probes.filter((p) => p.ok === true).length,
      fail: failed.length,
      observational: probes.filter((p) => p.ok === null).length,
    },
    appLogHead: appLog.join("").slice(0, 4000),
    appLogTail: appLog.join("").slice(-4000),
    finishedAt: new Date().toISOString(),
  }
  mkdirSync(dirname(OUT), { recursive: true })
  writeFileSync(OUT, JSON.stringify(result, null, 2))
  console.log(`\n${ARM}: ${result.summary.pass} pass / ${result.summary.fail} fail / ${result.summary.observational} obs -> ${OUT}`)
  process.exit(failed.length ? 1 : 0)
}
