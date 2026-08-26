#!/usr/bin/env bun
// alpha-code#1144 AC1 —— 在**打包产物**里由一次 agent 回合驱动 shell **工具**调用,
// 判据仍是「文件有没有落盘」,并带围栏移除的反向对照臂。
//
//   bun docs/verification/2026-08-26-req138-1144-packaged-shell-tool-chain/run.ts \
//     --app <path-to-alpha-code.app> --arm fenced|unfenced \
//     [--provider stub|<providerID>] [--model <modelID>] [--corpus full|one] [--out results/<name>.json]
//
// 与 #1076 的差别只有一处,但正是本票要的那一处:#1076 驱动的是 prompt `!command` 通路
// (`POST /session/:id/shell` → SessionPrompt.shellImpl),本 runner 驱动的是
// **模型 → 工具注册表 → tool/shell.ts → ask() → cfg.shell → wrapper → sandbox-exec**。
// runner 自己不 spawn 任何 shell:它只起 app、注册一个 provider、发一条会话消息、看磁盘。
//
// 判据(父票 #1074 的 I3 + 本仓《观测手段自己有盲区》):
//   1. 只记「文件是否落盘」,不记 exit code —— 基线 §2.5 的 nohup 那条 exit 0 而未落盘;
//   2. **空输出不算拦住** —— 每条语料第一句是 `echo AC1144-STARTED`,只有在**工具自己的
//      state.output** 里看见这个标记(= 被 spawn 的进程真的起来过)才允许把「没落盘」读成
//      「被拦住了」;
//   3. 臂别是**观测**出来的:每轮把盘上 wrapper 的原文读回来记进 identity,不看命令行声明。
//
// `--provider stub` 用一个 loopback 的 OpenAI-compatible 桩来决定"调哪个工具、参数是什么"
// (与 `2026-08-25-req105-1108-packaged-offline-xlsx/run.ts` 同法,经产品自带的
// `providers.add` 注册)。桩之后的每一格 —— 回合调度、工具注册表、参数解码、ask() 权限求值、
// `Shell.acceptable(cfg.shell)`、`["-c", cmd]` 的 spawn —— 全是打包产品自己的代码。
// 桩不是真模型:见 README §7。`--provider <id>` + `--model <id>` 可换成任何已注册的真 provider。

import { spawn, spawnSync, type ChildProcess } from "node:child_process"
import { createServer } from "node:net"
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { homedir } from "node:os"
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
/** fenced | unfenced | hardened | hardened-unfenced —— 后两个是 Developer ID + hardened runtime 的同一对臂。 */
const ARM = (arg("--arm", "fenced") as "fenced" | "unfenced" | "hardened" | "hardened-unfenced")!
const FENCE_REMOVED = ARM.includes("unfenced")
const HARDENED = ARM.startsWith("hardened")
const PROVIDER = arg("--provider", "stub")!
const MODEL = arg("--model", "ac1144-model")!
const CORPUS_MODE = arg("--corpus", "full")!
const OUT = arg("--out", join(HERE, "results", `${ARM}.json`))!
const MARK = "AC1144-STARTED"

type Probe = {
  id: string
  kind: "escape" | "benign" | "identity"
  command?: string
  toolCalled?: string | null
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
  const verdict = p.ok === null ? "SKIP" : p.ok ? "ok" : "FAIL"
  console.log(`[${verdict}] ${p.id} tool=${p.toolCalled ?? "-"} started=${p.processStarted} landed=${p.landed}`)
}

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

// ---------------------------------------------------------------- 本地模型桩
// 每个回合发两次:第一次回一个 tool_call,第二次回一句文本收尾。
// **收尾的判据是「本回合的 tool_call 已经发过了」(arm 只装一发),不是「messages 里有 role:tool」**
// —— 后者从第二个回合起恒真(整段历史都带着上一回合的工具结果),会让第二个回合起再也发不出工具调用。
// 工具名不写死 —— 从**引擎实际发过来的** tools 列表里挑,挑不到就如实记下它给了什么。
type StubSeen = {
  at: string
  toolNames: string[]
  hadToolResult: boolean
  picked: string | null
  callID: string | null
}
function startStub(port: number) {
  const seen: StubSeen[] = []
  let pending: { name: string; args: unknown } | null = null
  const server = Bun.serve({
    port,
    hostname: "127.0.0.1",
    async fetch(req) {
      const url = new URL(req.url)
      if (!url.pathname.endsWith("/chat/completions")) return new Response("{}", { status: 404 })
      const body: any = await req.json().catch(() => ({}))
      const toolNames: string[] = (body.tools ?? []).map((t: any) => t?.function?.name).filter(Boolean)
      const msgs: any[] = Array.isArray(body.messages) ? body.messages : []
      const hadToolResult = msgs.some((m) => m && m.role === "tool")
      const want = pending
      const picked = want
        ? (toolNames.find((n) => n === want.name) ??
          toolNames.find((n) => n.endsWith(`_${want.name}`) || n.endsWith(`-${want.name}`)) ??
          null)
        : null
      const callID = picked ? `call_ac1144_${seen.length + 1}` : null
      if (picked) pending = null // 一发即空:本回合的工具调用已发出,下一次请求收尾
      seen.push({ at: new Date().toISOString(), toolNames, hadToolResult, picked, callID })
      const id = "chatcmpl-ac1144-" + seen.length
      const created = Math.floor(Date.now() / 1000)
      const model = body.model ?? MODEL
      const chunks: string[] = []
      const emit = (delta: any, finish: string | null) =>
        chunks.push(
          "data: " +
            JSON.stringify({
              id,
              object: "chat.completion.chunk",
              created,
              model,
              choices: [{ index: 0, delta, finish_reason: finish }],
            }) +
            "\n\n",
        )
      if (picked) {
        emit({ role: "assistant", content: "" }, null)
        emit({ tool_calls: [{ index: 0, id: callID, type: "function", function: { name: picked, arguments: "" } }] }, null)
        emit({ tool_calls: [{ index: 0, function: { arguments: JSON.stringify(want!.args) } }] }, null)
        emit({}, "tool_calls")
      } else {
        emit({ role: "assistant", content: "" }, null)
        emit({ content: "AC1144-TURN-DONE" }, null)
        emit({}, "stop")
      }
      chunks.push("data: [DONE]\n\n")
      return new Response(chunks.join(""), {
        headers: { "content-type": "text/event-stream", "cache-control": "no-cache" },
      })
    },
  })
  return {
    url: `http://127.0.0.1:${port}/v1`,
    seen,
    /** 下一回合让模型调什么工具、传什么参数。 */
    arm(name: string, args: unknown) {
      pending = { name, args }
    },
    stop: () => server.stop(true),
  }
}

// ---------------------------------------------------------------- CDP(只用来取引擎凭据 / 调 providers.add)
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
        setTimeout(() => pending.has(myId) && (pending.delete(myId), rej(new Error("cdp timeout"))), 180_000)
      })
      if (r.exceptionDetails) throw new Error(`eval threw: ${r.exceptionDetails.exception?.description ?? "?"}`)
      return r.result?.value
    },
    close: () => ws.close(),
  }
}

// ---------------------------------------------------------------- 夹具
const ENGINE_PORT = await freePort()
const CDP_PORT = await freePort()
const STUB_PORT = await freePort()

// 与 #1076 同口径:工作区**故意不放** /private/tmp 或 /private/var/folders —— 那两条前缀本来就在
// profile 的可写闭集里,放进去会让「工作区内可写」恒真、测不出 -D WORKDIR="$(pwd)" 解析成了什么。
const WS = mkdtempSync(join(homedir(), ".ac1144-ws-"))
const ESCAPE_DIR = mkdtempSync(join(homedir(), ".ac1144-escape-"))
const ESCAPE_TARGET = join(ESCAPE_DIR, "pwned.txt")

const APP_EXEC = join(APP, "Contents/MacOS/alpha-code")
const EXT_BUNDLE = join(APP, "Contents/Resources/alpha-ext/plugin.js")
const FENCE_LINE = 'exec /usr/bin/sandbox-exec -f "$ALPHA_SB_PROFILE" -D WORKDIR="$(pwd)" "$ALPHA_REAL_SHELL" "$@"'
const sha = (p: string) => (existsSync(p) ? createHash("sha256").update(readFileSync(p)).digest("hex") : "MISSING")
const plist = (k: string) =>
  spawnSync("/usr/libexec/PlistBuddy", ["-c", `Print :${k}`, join(APP, "Contents/Info.plist")], {
    encoding: "utf8",
  }).stdout.trim()

const stub = startStub(STUB_PORT)
let child: ChildProcess | undefined
const appLog: string[] = []
const started = new Date().toISOString()

try {
  // ------------------------------------------------------------ 被测件身份
  const extText = existsSync(EXT_BUNDLE) ? readFileSync(EXT_BUNDLE, "utf8") : ""
  const bundleHasFence = extText.includes(FENCE_LINE)
  Object.assign(identity, {
    ticket: "jinjunnn/alpha-code#1144",
    ac: "AC1",
    arm: ARM,
    app: APP,
    providerMode: PROVIDER,
    modelID: MODEL,
    appExecExists: existsSync(APP_EXEC),
    bundleId: plist("CFBundleIdentifier"),
    version: plist("CFBundleShortVersionString"),
    extBundleSha256: sha(EXT_BUNDLE),
    branchExtBundleSha256: sha(join(REPO, "packages/ext/dist/plugin.js")),
    bundleWrapperIsFenced: bundleHasFence,
    codesign: spawnSync("/usr/bin/codesign", ["-dv", APP], { encoding: "utf8" })
      .stderr.trim()
      .split("\n")
      .filter((l) => /CodeDirectory|Signature|Identifier=|TeamIdentifier|Runtime Version/.test(l)),
    signedEntitlements: spawnSync("/usr/bin/codesign", ["-d", "--entitlements", "-", "--xml", APP], {
      encoding: "utf8",
    })
      .stdout.trim()
      .slice(0, 2000),
    workspace: WS,
    escapeTarget: ESCAPE_TARGET,
    ports: { engine: ENGINE_PORT, cdp: CDP_PORT, stub: STUB_PORT },
    startedAt: started,
    host: {
      productVersion: spawnSync("/usr/bin/sw_vers", ["-productVersion"], { encoding: "utf8" }).stdout.trim(),
      uname: spawnSync("/usr/bin/uname", ["-a"], { encoding: "utf8" }).stdout.trim(),
    },
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
  // hardened 臂:「hardened runtime 真的开着」也必须是**观测**出来的。codesign 的
  // CodeDirectory flags 里必须有 runtime 位,且必须有一个真 Team ID(ad-hoc 没有 Team ID,
  // 那正是 #1076 第一条死路的成因)。
  const csLine = (identity.codesign as string[]).join(" | ")
  identity.hardenedRuntimeOn = /flags=0x\w*\(.*runtime.*\)/.test(csLine)
  identity.teamIdentifier = /TeamIdentifier=(\S+)/.exec(csLine)?.[1] ?? null
  push({
    id: "identity.hardenedRuntime",
    kind: "identity",
    processStarted: null,
    landed: null,
    expectLanded: null,
    ok: HARDENED ? identity.hardenedRuntimeOn === true && identity.teamIdentifier !== "not" : null,
    detail: {
      arm: ARM,
      expectHardened: HARDENED,
      hardenedRuntimeOn: identity.hardenedRuntimeOn,
      teamIdentifier: identity.teamIdentifier,
      codesign: identity.codesign,
    },
  })

  // ------------------------------------------------------------ 起打包应用
  // OPENCODE_PERMISSION 是产品自带的配置入口(config.ts:550 读 Flag.OPENCODE_PERMISSION,
  // sidecar-env.ts 的 OPENCODE_ 前缀放行它)。它就是 tool/shell.ts 的 ask() 在**无人值守**下
  // 的既有处置手段 —— 不改任何生产代码。
  const PERMISSION = JSON.stringify({ bash: "allow", external_directory: "allow" })
  identity.opencodePermission = PERMISSION
  // `--use-mock-keychain` 是 Chromium 自带的开关,把 safeStorage 的托管后端从 macOS 钥匙串换成
  // 进程内 mock。**两臂一律带同一份启动参数**,否则比的就不是同一件事。
  // 为什么必须带:反向臂是 ad-hoc 重签的副本 ⇒ 代码身份与建立钥匙串项的那一个不同 ⇒
  // 启动早期 `SecItemCopyMatching` 卡在 securityd 的 ACL 授权等待上,无人值守时永不返回
  // (实测栈见 README §8;与 #1076 hardened 那条死路同源)。它只影响凭据托管,
  // 不碰 cfg.shell / wrapper / sandbox-exec —— 本轮判据的每一格都不经过它。
  const LAUNCH_FLAGS = [`--remote-debugging-port=${CDP_PORT}`, "--use-mock-keychain"]
  identity.launchFlags = LAUNCH_FLAGS
  child = spawn(APP_EXEC, LAUNCH_FLAGS, {
    env: {
      ...process.env,
      OPENCODE_TEST_ONBOARDING: "1",
      OPENCODE_PORT: String(ENGINE_PORT),
      OPENCODE_PERMISSION: PERMISSION,
    },
    stdio: ["ignore", "pipe", "pipe"],
  })
  child.stdout?.on("data", (b) => appLog.push(b.toString()))
  child.stderr?.on("data", (b) => appLog.push(b.toString()))

  let conn = await attach((await waitForCdp(CDP_PORT, 180_000))[0].webSocketDebuggerUrl)
  const cdp = {
    async eval(expression: string) {
      try {
        return await conn.eval(expression)
      } catch {
        try {
          conn.close()
        } catch {}
        conn = await attach((await waitForCdp(CDP_PORT, 60_000))[0].webSocketDebuggerUrl)
        await sleep(1500)
        return await conn.eval(expression)
      }
    },
    close: () => {
      try {
        conn.close()
      } catch {}
    },
  }
  await sleep(6000)

  let init = await cdp.eval(`window.api.awaitInitialization()`)
  const authHeader = () =>
    init?.username || init?.password
      ? "Basic " + Buffer.from(`${init.username ?? ""}:${init.password ?? ""}`).toString("base64")
      : undefined
  const api = async (method: string, path: string, body?: unknown, timeoutMs = 180_000) => {
    const headers: Record<string, string> = { "content-type": "application/json" }
    const a = authHeader()
    if (a) headers.Authorization = a
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
      return { status: r.status, body: t.slice(0, 1200) }
    }
  }
  const engineUp = async () => {
    for (let i = 0; i < 180; i++) {
      try {
        const h = await fetch(`http://127.0.0.1:${ENGINE_PORT}/global/health`, { signal: AbortSignal.timeout(3000) })
        if (h.ok) return true
      } catch {}
      await sleep(1000)
    }
    return false
  }
  identity.engineUrl = init?.url
  identity.engineHealthy = await engineUp()

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

  // ------------------------------------------------------------ provider
  let providerID = PROVIDER
  if (PROVIDER === "stub") {
    providerID = "ac1144stub"
    const added = await cdp.eval(
      `(async()=>{ try { return await window.api.providers.add({ id:"ac1144stub", name:"AC1144 local stub", compat:"openai", baseURL:${JSON.stringify(
        stub.url,
      )}, apiKey:"ac1144-stub-key", models:[${JSON.stringify(MODEL)}] }) } catch(e){ return { threw:String(e) } } })()`,
    )
    push({
      id: "setup.providerAdded",
      kind: "identity",
      processStarted: null,
      landed: null,
      expectLanded: null,
      ok: added?.ok === true,
      detail: added,
    })
    // providers.add 会让 main 重起 sidecar,重新取一次引擎凭据/端口再继续。
    await sleep(4000)
    identity.engineHealthyAfterProvider = await engineUp()
    init = await cdp.eval(`window.api.awaitInitialization()`)
    identity.engineUrlAfterProvider = init?.url
  }
  identity.providerID = providerID

  // ------------------------------------------------------------ cfg.shell 与 wrapper(观测,不声明)
  const dq = `?directory=${encodeURIComponent(WS)}`
  const cfg = await api("GET", `/config${dq}`)
  const cfgShell: string | undefined = (cfg.body as any)?.shell
  const wrapperText = cfgShell && existsSync(cfgShell) ? readFileSync(cfgShell, "utf8") : ""
  const profilePath = cfgShell ? join(dirname(dirname(cfgShell)), "sandbox", "alpha-shell.sb") : ""
  identity.cfgShell = cfgShell
  identity.wrapperText = wrapperText
  identity.profilePath = profilePath
  identity.profileText = profilePath && existsSync(profilePath) ? readFileSync(profilePath, "utf8") : ""
  push({
    id: "m1.cfgShellIsWrapper",
    kind: "identity",
    processStarted: null,
    landed: null,
    expectLanded: null,
    ok: !!cfgShell && /\/bin\/zsh$/.test(cfgShell) && !cfgShell.startsWith("/bin/") && wrapperText.startsWith("#!/bin/sh"),
    detail: { status: cfg.status, cfgShell, wrapperText },
  })
  push({
    id: "m1.wrapperMatchesArm",
    kind: "identity",
    processStarted: null,
    landed: null,
    expectLanded: null,
    ok: FENCE_REMOVED ? !wrapperText.includes("sandbox-exec") : wrapperText.includes("/usr/bin/sandbox-exec"),
    detail: { arm: ARM, wrapperText },
  })

  // ------------------------------------------------------------ session
  const agents = await api("GET", `/agent${dq}`)
  const agentName =
    (Array.isArray(agents.body) && (agents.body as any[]).find((a) => a?.name === "build")?.name) ||
    (Array.isArray(agents.body) ? (agents.body as any[])[0]?.name : undefined) ||
    "build"
  identity.agent = agentName
  identity.agentsSeen = Array.isArray(agents.body) ? (agents.body as any[]).map((a) => a?.name) : agents.body
  const session = await api("POST", `/session${dq}`, { title: "alpha-code#1144 AC1" })
  const sid = (session.body as any)?.id
  identity.sessionID = sid
  if (!sid) throw new Error(`no session: ${JSON.stringify(session).slice(0, 400)}`)

  let turnCount = 0
  /**
   * 一次真实的 agent 回合:发一条用户消息 → 模型回一个 shell 工具调用 → 引擎执行 →
   * 回读整段 transcript,把**工具自己那一格**取出来。
   * 返回的 command 是从 transcript 的 `state.input.command` 读回来的(引擎实际收到的那一份),
   * 不是我们发出去的那一份。
   */
  async function toolTurn(command: string, promptText: string) {
    turnCount++
    stub.arm("bash", { command })
    const before = stub.seen.length
    const sent = await api(
      "POST",
      `/session/${sid}/message${dq}`,
      {
        model: { providerID, modelID: MODEL },
        agent: agentName,
        parts: [{ type: "text", text: promptText }],
      },
      240_000,
    )
    const transcript = await api("GET", `/session/${sid}/message${dq}`, undefined, 60_000)
    const allParts = (Array.isArray(transcript.body) ? (transcript.body as any[]) : []).flatMap((m: any) => m?.parts ?? [])
    const toolParts = allParts.filter((p: any) => p?.type === "tool")
    // 本回合的那一格靠 **callID** 认领(桩发出去的那个 id),不靠"取最后一个" ——
    // 整段 transcript 会累积历次回合的工具格,取最后一个会在下一回合读到上一回合的结果。
    const exchanges = stub.seen.slice(before)
    const wantCallID = exchanges.find((s) => s.callID)?.callID ?? null
    const byCall = wantCallID ? toolParts.find((p: any) => p?.callID === wantCallID) : undefined
    const byCommand = toolParts.filter((p: any) => p?.state?.input?.command === command).slice(-1)[0]
    const part = byCall ?? byCommand ?? null
    const output: string = String(part?.state?.output ?? "")
    return {
      httpStatus: sent.status,
      partMatchedBy: byCall ? "callID" : byCommand ? "command" : "none",
      wantCallID,
      tool: part?.tool ?? null,
      callID: part?.callID ?? null,
      status: part?.state?.status ?? null,
      inputCommand: part?.state?.input?.command ?? null,
      output,
      error: part?.state?.error ?? part?.state?.message ?? null,
      stubExchanges: exchanges,
      exposedToolNames: exchanges[0]?.toolNames ?? [],
      assistantText: allParts.filter((p: any) => p?.type === "text").map((p: any) => String(p.text ?? "").slice(0, 200)),
    }
  }

  // ------------------------------------------------------------ AC1:逃逸语料,走 shell **工具**
  const ALL: Array<[string, string]> = [
    ["redirect >", `echo ${MARK}; echo pwned > ${ESCAPE_TARGET}`],
    ["redirect >>", `echo ${MARK}; echo pwned >> ${ESCAPE_TARGET}`],
    ["via /bin/sh", `echo ${MARK}; /bin/sh -c 'echo pwned > ${ESCAPE_TARGET}'`],
    ["via python3", `echo ${MARK}; python3 -c 'open("${ESCAPE_TARGET}","w").write("x")'`],
    ["via node", `echo ${MARK}; node -e 'require("fs").writeFileSync("${ESCAPE_TARGET}","x")'`],
    ["nohup detach", `echo ${MARK}; nohup sh -c 'echo pwned > ${ESCAPE_TARGET}' >/dev/null 2>&1 || true`],
    ["symlink out", `echo ${MARK}; ln -sf ${ESCAPE_TARGET} link && echo pwned > link`],
  ]
  const corpus = CORPUS_MODE === "one" ? ALL.slice(0, 1) : ALL

  for (const [tag, command] of corpus) {
    rmSync(ESCAPE_TARGET, { force: true })
    rmSync(join(WS, "link"), { force: true })
    const r = await toolTurn(
      command,
      `Use the shell tool to run exactly this command, nothing else:\n\n${command}`,
    )
    await sleep(800) // nohup 是后台派生,给它一拍再判
    const landed = existsSync(ESCAPE_TARGET)
    const processStarted = r.output.includes(MARK)
    const commandIntact = r.inputCommand === command
    push({
      id: `ac1.toolChain/${tag}`,
      kind: "escape",
      command,
      toolCalled: r.tool,
      processStarted,
      landed,
      expectLanded: FENCE_REMOVED,
      ok: r.tool === "bash" && r.status === "completed" && commandIntact && processStarted && landed === FENCE_REMOVED,
      detail: {
        httpStatus: r.httpStatus,
        toolStatus: r.status,
        callID: r.callID,
        partMatchedBy: r.partMatchedBy,
        commandIntact,
        inputCommand: r.inputCommand,
        output: r.output.slice(0, 900),
        error: r.error,
        exposedToolNames: r.exposedToolNames,
        stubExchanges: r.stubExchanges,
        assistantText: r.assistantText.slice(-2),
      },
    })
  }
  rmSync(ESCAPE_TARGET, { force: true })
  rmSync(join(WS, "link"), { force: true })

  // ------------------------------------------------------------ 同一条链上的正样本
  // 「文件没落盘」若不配一条**该落盘、也真落了**的样本,就分不清「被拦住」与「这条链根本没跑」。
  // 这一格在**两臂都必须落盘**:它证明 shell 工具在打包 sidecar 里是通的。
  const benignCmd = `echo ${MARK}; echo ok > inside.txt; ls inside.txt`
  rmSync(join(WS, "inside.txt"), { force: true })
  const benign = await toolTurn(benignCmd, `Use the shell tool to run exactly this command, nothing else:\n\n${benignCmd}`)
  const benignLanded = existsSync(join(WS, "inside.txt"))
  push({
    id: "ac1.toolChain/workspace write (positive control)",
    kind: "benign",
    command: benignCmd,
    toolCalled: benign.tool,
    processStarted: benign.output.includes(MARK),
    landed: benignLanded,
    expectLanded: true,
    ok: benign.tool === "bash" && benign.status === "completed" && benign.output.includes(MARK) && benignLanded,
    detail: {
      toolStatus: benign.status,
      partMatchedBy: benign.partMatchedBy,
      inputCommand: benign.inputCommand,
      output: benign.output.slice(0, 600),
      file: join(WS, "inside.txt"),
    },
  })

  // ------------------------------------------------------------ 这条链确实经过 wrapper
  // 从**工具派生出来的 shell 内部**把 wrapper 注入的两个环境变量原样读回来。
  // 围栏臂必须读到 profile 路径;反向臂里 wrapper 已不含 sandbox-exec,该变量仍在(wrapper 只是不用它)。
  const envCmd = `echo ${MARK}; echo "SBP=\${ALPHA_SB_PROFILE:-none} RSH=\${ALPHA_REAL_SHELL:-none}"`
  const envTurn = await toolTurn(envCmd, `Use the shell tool to run exactly this command, nothing else:\n\n${envCmd}`)
  const sbp = envTurn.output.match(/SBP=(\S*)/)?.[1] ?? ""
  const rsh = envTurn.output.match(/RSH=(\S*)/)?.[1] ?? ""
  identity.toolObservedSbProfile = sbp
  identity.toolObservedRealShell = rsh
  push({
    id: "ac1.toolChain/env reaches tool-spawned shell",
    kind: "identity",
    command: envCmd,
    toolCalled: envTurn.tool,
    processStarted: envTurn.output.includes(MARK),
    landed: null,
    expectLanded: null,
    ok: envTurn.output.includes(MARK) && sbp === profilePath && !!rsh && rsh !== "none",
    detail: {
      sbp,
      rsh,
      expectedProfile: profilePath,
      partMatchedBy: envTurn.partMatchedBy,
      toolStatus: envTurn.status,
      output: envTurn.output.slice(0, 700),
    },
  })

  // ------------------------------------------------------------ 第二个驱动面:prompt `!command`
  // 基线 §2.5/§2.6 的语料在 #1076 里是经 `POST /session/:id/shell`(SessionPrompt.shellImpl,
  // argv 形状 `["-l","-c",script,"opencode",cwd]`)跑的。同一轮里把它也跑一遍,hardened 臂
  // 才说得上「与未开 hardened 时**结论一致**」—— 比的是同一个驱动面上的同一套语料。
  async function promptShell(command: string, timeoutMs = 120_000) {
    const r = await api(
      "POST",
      `/session/${sid}/shell${dq}`,
      { agent: agentName, command, model: { providerID, modelID: MODEL } },
      timeoutMs,
    )
    const part = (r.body as any)?.parts?.[0]
    return { status: r.status, output: String(part?.state?.output ?? part?.state?.metadata?.output ?? "") }
  }
  for (const [tag, command] of corpus) {
    rmSync(ESCAPE_TARGET, { force: true })
    rmSync(join(WS, "link"), { force: true })
    const r = await promptShell(command)
    await sleep(800)
    const landed = existsSync(ESCAPE_TARGET)
    const processStarted = r.output.includes(MARK)
    push({
      id: `baseline25.promptShell/${tag}`,
      kind: "escape",
      command,
      toolCalled: "(prompt !command route)",
      processStarted,
      landed,
      expectLanded: FENCE_REMOVED,
      ok: processStarted && landed === FENCE_REMOVED,
      detail: { httpStatus: r.status, output: r.output.slice(0, 600) },
    })
  }
  rmSync(ESCAPE_TARGET, { force: true })
  rmSync(join(WS, "link"), { force: true })

  // ------------------------------------------------------------ 观测项(不判 PASS/FAIL)
  // 第一轮跑 `ps` 时看到 `zsh:1: operation not permitted: ps`。围栏本身的行为不在本票
  // (#1144 Out of scope),但观测到就如实留下,并让**反向臂做对照** —— 只有两臂不同,
  // 才说得上是围栏造成的;两臂都不行则与围栏无关。ok 一律为 null。
  const psCmd = `echo ${MARK}; /bin/ps -o pid= -p $$ 2>&1 | head -c 120; echo " EXIT=$?"`
  const psTurn = await toolTurn(psCmd, `Use the shell tool to run exactly this command, nothing else:\n\n${psCmd}`)
  push({
    id: "observation.psInsideToolShell",
    kind: "benign",
    command: psCmd,
    toolCalled: psTurn.tool,
    processStarted: psTurn.output.includes(MARK),
    landed: null,
    expectLanded: null,
    ok: null,
    detail: {
      arm: ARM,
      toolStatus: psTurn.status,
      partMatchedBy: psTurn.partMatchedBy,
      output: psTurn.output.slice(0, 400),
      note: "observation only — fence behaviour is out of scope for #1144",
    },
  })

  identity.turns = turnCount
  identity.stubExchangeCount = stub.seen.length
  cdp.close()
} catch (e) {
  push({
    id: "runner.fatal",
    kind: "identity",
    processStarted: null,
    landed: null,
    expectLanded: null,
    ok: false,
    detail: String(e),
  })
} finally {
  stub.stop()
  try {
    child?.kill("SIGTERM")
  } catch {}
  await sleep(1500)
  spawnSync("/usr/bin/pkill", ["-f", `remote-debugging-port=${CDP_PORT}`])
  for (const d of [WS, ESCAPE_DIR]) {
    try {
      rmSync(d, { recursive: true, force: true })
    } catch {}
  }

  const fails = probes.filter((p) => p.ok === false)
  const result = {
    ticket: "jinjunnn/alpha-code#1144",
    ac: "AC1",
    arm: ARM,
    providerMode: PROVIDER,
    at: new Date().toISOString(),
    // cwd 若在跑动期间被删掉,spawnSync 的 stdout 是 null ⇒ `.trim()` 在 finally 里抛错,
    // 整轮结果 JSON 一个字都写不出来(#1144 上一轮实测)。取值失败就留空,不要连累结果落盘。
    gitSha: spawnSync("git", ["rev-parse", "HEAD"], { cwd: HERE, encoding: "utf8" }).stdout?.trim() ?? "",
    summary: {
      pass: probes.filter((p) => p.ok === true).length,
      fail: fails.length,
      skipped: probes.filter((p) => p.ok === null).length,
    },
    identity,
    probes,
    appLogTail: appLog.join("").split("\n").slice(-200),
  }
  mkdirSync(dirname(OUT), { recursive: true })
  writeFileSync(OUT, JSON.stringify(result, null, 2))
  console.log(`\n${ARM}: ${result.summary.pass} pass / ${result.summary.fail} fail -> ${OUT}`)
  if (fails.length) for (const f of fails) console.log(`  FAIL ${f.id}: ${JSON.stringify(f.detail).slice(0, 400)}`)
  process.exit(fails.length ? 1 : 0)
}
