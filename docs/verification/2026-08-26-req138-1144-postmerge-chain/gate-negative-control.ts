#!/usr/bin/env bun
// alpha-code#1144 —— **负向控制**:证明这条链是可以被关掉的。
//
//   bun docs/verification/2026-08-26-req138-1144-postmerge-chain/gate-negative-control.ts \
//     --app <path-to-alpha-code.app> [--out results/gate-negative-control.json]
//
// 为什么需要它。本轮的主结论是「post-#1147,消息 → tool_call → 注册表 → tool/shell.ts →
// 闸 → wrapper → sandbox-exec 这条链仍然通」。而 `#1147` 恰好换掉了链上的那一格:
// `session/tools.ts` 里原来的 `permission.ask({ permission: canonicalToolIdentity(...) })`
// 变成了 `AlphaToolPolicyGate.gateToolExecution(...)`(ruleset 轴 + 策略文档轴的合成)。
// 「链是通的」若不配一条**该被关掉、也真的被关掉**的样本,就分不清两件事:
//   (a) 新闸在打包产物里真的在这条路径上,判过之后放行;
//   (b) 新闸根本没接上/没进包,于是「通」是因为没有任何东西在判。
// 本仓《观测手段自己有盲区》的判据:**先证明这个手段能测出已知的坏,再用它判未知的好。**
//
// 手段:**只动产品自带的配置入口**,不改任何生产代码。
//   `OPENCODE_PERMISSION` → `config.ts` 的 `Flag.OPENCODE_PERMISSION` → `cfg.permission`
//   → `agent/agent.ts:138` 的 `Permission.fromConfig(cfg.permission)`(merge 的**最后**一位,
//   `evaluate` 是 findLast ⇒ 用户规则压过 defaults)。
//   `packages/core/src/v1/config/permission.ts` 的 `InputObject` 是
//   `StructWithRest(..., [Record(String, Rule)])` ⇒ 接受任意键,包括 canonical identity。
//   builtin 工具的 canonical 由 `tool/registry.ts:271-275` 铸成 `builtin::<id>`,
//   shell 工具的 id 是 `bash`(`ShellID.ToolID`)⇒ **`builtin::bash`**。
//
// 两臂只差这一个键:
//   allow 臂(控制组):{"bash":"allow","external_directory":"allow"}                    —— 与主轮逐字相同
//   deny  臂:         {..., "builtin::bash":"deny"}
// 判据:allow 臂工具跑到 completed 且输出里有 AC1144-STARTED;deny 臂**不执行**
// (逃逸文件与工作区文件都不落盘),且拒绝是**具名的** —— 要么 bash 根本不在引擎下发的
// tools 里(#1147 §6「deny:目录不广告」),要么工具那一格是 error 且载荷点名
// `alpha-tool-policy`。两种形态都只存在于 post-#1147。

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
const OUT = arg("--out", join(HERE, "results", "gate-negative-control.json"))!
const MODEL = "ac1144-model"
const MARK = "AC1144-STARTED"
const CANONICAL = "builtin::bash"

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

function startStub(port: number) {
  const seen: Array<{ at: string; toolNames: string[]; picked: string | null; callID: string | null }> = []
  let pending: { name: string; args: unknown } | null = null
  const server = Bun.serve({
    port,
    hostname: "127.0.0.1",
    async fetch(req) {
      const url = new URL(req.url)
      if (!url.pathname.endsWith("/chat/completions")) return new Response("{}", { status: 404 })
      const body: any = await req.json().catch(() => ({}))
      const toolNames: string[] = (body.tools ?? []).map((t: any) => t?.function?.name).filter(Boolean)
      const want = pending
      const picked = want ? (toolNames.find((n) => n === want.name) ?? null) : null
      const callID = picked ? `call_negctl_${seen.length + 1}` : null
      if (picked) pending = null
      seen.push({ at: new Date().toISOString(), toolNames, picked, callID })
      const id = "chatcmpl-negctl-" + seen.length
      const created = Math.floor(Date.now() / 1000)
      const chunks: string[] = []
      const emit = (delta: any, finish: string | null) =>
        chunks.push(
          "data: " +
            JSON.stringify({
              id,
              object: "chat.completion.chunk",
              created,
              model: body.model ?? MODEL,
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
        emit({ content: "NEGCTL-TURN-DONE" }, null)
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
    arm(name: string, args: unknown) {
      pending = { name, args }
    },
    stop: () => server.stop(true),
  }
}

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
          JSON.stringify({ id: myId, method: "Runtime.evaluate", params: { expression, awaitPromise: true, returnByValue: true } }),
        )
        setTimeout(() => pending.has(myId) && (pending.delete(myId), rej(new Error("cdp timeout"))), 180_000)
      })
      if (r.exceptionDetails) throw new Error(`eval threw: ${r.exceptionDetails.exception?.description ?? "?"}`)
      return r.result?.value
    },
    close: () => ws.close(),
  }
}

type ArmResult = Record<string, unknown>

/** 跑一个臂:起一次 app,注册桩,发一个要求调 bash 的回合,回读 transcript 与磁盘。 */
async function runArm(label: string, permission: string): Promise<ArmResult> {
  const ENGINE_PORT = await freePort()
  const CDP_PORT = await freePort()
  const STUB_PORT = await freePort()
  const WS = mkdtempSync(join(homedir(), ".ac1144-negctl-ws-"))
  const ESCAPE_DIR = mkdtempSync(join(homedir(), ".ac1144-negctl-escape-"))
  const ESCAPE_TARGET = join(ESCAPE_DIR, "pwned.txt")
  const stub = startStub(STUB_PORT)
  const appLog: string[] = []
  let child: ChildProcess | undefined
  const out: ArmResult = { label, permission, workspace: WS, escapeTarget: ESCAPE_TARGET }
  try {
    const LAUNCH_FLAGS = [`--remote-debugging-port=${CDP_PORT}`, "--use-mock-keychain"]
    out.launchFlags = LAUNCH_FLAGS
    child = spawn(join(APP, "Contents/MacOS/alpha-code"), LAUNCH_FLAGS, {
      env: {
        ...process.env,
        OPENCODE_TEST_ONBOARDING: "1",
        OPENCODE_PORT: String(ENGINE_PORT),
        OPENCODE_PERMISSION: permission,
      },
      stdio: ["ignore", "pipe", "pipe"],
    })
    child.stdout?.on("data", (b) => appLog.push(b.toString()))
    child.stderr?.on("data", (b) => appLog.push(b.toString()))

    let conn = await attach((await waitForCdp(CDP_PORT, 180_000))[0].webSocketDebuggerUrl)
    const cdp = {
      async eval(e: string) {
        try {
          return await conn.eval(e)
        } catch {
          try {
            conn.close()
          } catch {}
          conn = await attach((await waitForCdp(CDP_PORT, 60_000))[0].webSocketDebuggerUrl)
          await sleep(1500)
          return await conn.eval(e)
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
    const api = async (method: string, path: string, body?: unknown, timeoutMs = 180_000) => {
      const headers: Record<string, string> = { "content-type": "application/json" }
      if (init?.username || init?.password)
        headers.Authorization = "Basic " + Buffer.from(`${init.username ?? ""}:${init.password ?? ""}`).toString("base64")
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
    const added = await cdp.eval(
      `(async()=>{ try { return await window.api.providers.add({ id:"negctlstub", name:"AC1144 negctl stub", compat:"openai", baseURL:${JSON.stringify(
        stub.url,
      )}, apiKey:"negctl-key", models:[${JSON.stringify(MODEL)}] }) } catch(e){ return { threw:String(e) } } })()`,
    )
    out.providerAdded = added?.ok === true
    await sleep(4000)
    init = await cdp.eval(`window.api.awaitInitialization()`)

    const dq = `?directory=${encodeURIComponent(WS)}`
    const session = await api("POST", `/session${dq}`, { title: `#1144 negative control (${label})` })
    const sid = (session.body as any)?.id
    if (!sid) throw new Error(`no session: ${JSON.stringify(session).slice(0, 300)}`)
    out.sessionID = sid

    const command = `echo ${MARK}; echo ok > inside.txt; echo pwned > ${ESCAPE_TARGET}`
    out.command = command
    stub.arm("bash", { command })
    const before = stub.seen.length
    const sent = await api(
      "POST",
      `/session/${sid}/message${dq}`,
      { model: { providerID: "negctlstub", modelID: MODEL }, agent: "build", parts: [{ type: "text", text: `Use the shell tool to run exactly this command, nothing else:\n\n${command}` }] },
      240_000,
    )
    const transcript = await api("GET", `/session/${sid}/message${dq}`, undefined, 60_000)
    const allParts = (Array.isArray(transcript.body) ? (transcript.body as any[]) : []).flatMap((m: any) => m?.parts ?? [])
    const toolParts = allParts.filter((p: any) => p?.type === "tool")
    const exchanges = stub.seen.slice(before)
    const wantCallID = exchanges.find((s) => s.callID)?.callID ?? null
    const part = (wantCallID ? toolParts.find((p: any) => p?.callID === wantCallID) : undefined) ?? null
    await sleep(1200)

    const exposed = exchanges[0]?.toolNames ?? []
    const output = String(part?.state?.output ?? "")
    const errText = JSON.stringify(part?.state?.error ?? part?.state?.message ?? null)
    Object.assign(out, {
      httpStatus: sent.status,
      exposedToolNames: exposed,
      bashAdvertised: exposed.includes("bash"),
      stubExchanges: exchanges,
      stubPicked: exchanges.map((e) => e.picked),
      toolPartFound: !!part,
      toolStatus: part?.state?.status ?? null,
      toolOutput: output.slice(0, 800),
      toolError: errText.slice(0, 1200),
      processStarted: output.includes(MARK),
      escapeLanded: existsSync(ESCAPE_TARGET),
      workspaceFileLanded: existsSync(join(WS, "inside.txt")),
      assistantText: allParts.filter((p: any) => p?.type === "text").map((p: any) => String(p.text ?? "").slice(0, 160)).slice(-2),
      namesAlphaToolPolicy: /alpha-tool-policy/.test(errText),
      appStartingLine: appLog.join("").split("\n").find((l) => l.includes("app starting")) ?? "",
    })
    cdp.close()
  } catch (e) {
    out.fatal = String(e)
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
  }
  return out
}

const ALLOW = JSON.stringify({ bash: "allow", external_directory: "allow" })
const DENY = JSON.stringify({ bash: "allow", external_directory: "allow", [CANONICAL]: "deny" })

const allowArm = await runArm("allow (control)", ALLOW)
console.log(
  `[allow ] advertised=${allowArm.bashAdvertised} status=${allowArm.toolStatus} started=${allowArm.processStarted} wsFile=${allowArm.workspaceFileLanded} escape=${allowArm.escapeLanded}`,
)
const denyArm = await runArm("deny builtin::bash", DENY)
console.log(
  `[deny  ] advertised=${denyArm.bashAdvertised} status=${denyArm.toolStatus} started=${denyArm.processStarted} wsFile=${denyArm.workspaceFileLanded} escape=${denyArm.escapeLanded} namesPolicy=${denyArm.namesAlphaToolPolicy}`,
)

// 判据(每一条都必须自己成立,不允许「差不多」):
//  1. 控制组必须真的跑起来 —— 否则 deny 臂的「没跑」什么也证明不了;
//  2. deny 臂**一个字节都不能落盘**(工作区文件与逃逸文件都不存在);
//  3. deny 臂的拒绝必须是**具名的**:要么 bash 不在下发的 tools 里(目录不广告),
//     要么工具那一格是 error 且载荷点名 alpha-tool-policy。
const checks = [
  { id: "control.bashAdvertised", ok: allowArm.bashAdvertised === true, detail: allowArm.exposedToolNames },
  { id: "control.toolCompleted", ok: allowArm.toolStatus === "completed", detail: allowArm.toolStatus },
  { id: "control.processStarted", ok: allowArm.processStarted === true, detail: allowArm.toolOutput },
  { id: "control.workspaceFileLanded", ok: allowArm.workspaceFileLanded === true, detail: allowArm.workspaceFileLanded },
  { id: "deny.nothingExecuted", ok: denyArm.processStarted === false, detail: denyArm.toolOutput },
  { id: "deny.workspaceFileNotLanded", ok: denyArm.workspaceFileLanded === false, detail: denyArm.workspaceFileLanded },
  { id: "deny.escapeNotLanded", ok: denyArm.escapeLanded === false, detail: denyArm.escapeLanded },
  {
    id: "deny.refusalIsNamed",
    ok: denyArm.bashAdvertised === false || denyArm.namesAlphaToolPolicy === true,
    detail: { bashAdvertised: denyArm.bashAdvertised, toolError: denyArm.toolError, exposed: denyArm.exposedToolNames },
  },
]
for (const c of checks) console.log(`[${c.ok ? "ok" : "FAIL"}] ${c.id}`)
const fails = checks.filter((c) => !c.ok)
const result = {
  ticket: "jinjunnn/alpha-code#1144",
  purpose: "negative control: the post-#1147 tool-execution gate can close this chain",
  at: new Date().toISOString(),
  app: APP,
  gitSha: spawnSync("git", ["rev-parse", "HEAD"], { cwd: HERE, encoding: "utf8" }).stdout?.trim() ?? "",
  extBundleSha256: existsSync(join(APP, "Contents/Resources/alpha-ext/plugin.js"))
    ? createHash("sha256").update(readFileSync(join(APP, "Contents/Resources/alpha-ext/plugin.js"))).digest("hex")
    : "MISSING",
  canonicalUnderTest: CANONICAL,
  summary: { pass: checks.length - fails.length, fail: fails.length },
  checks,
  arms: { allow: allowArm, deny: denyArm },
}
mkdirSync(dirname(OUT), { recursive: true })
writeFileSync(OUT, JSON.stringify(result, null, 2))
console.log(`\nnegative-control: ${result.summary.pass} pass / ${result.summary.fail} fail -> ${OUT}`)
process.exit(fails.length ? 1 : 0)
