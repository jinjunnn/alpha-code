#!/usr/bin/env bun
// E7 (#643) packaged-live evidence probe — one run collects every machine-checkable item.
//
// Form follows the house CDP harness (`packages/ui-mac/scripts/verify-picker-respawn.ts`,
// `docs/audits/2026-07-13-s48-req088-c4/harness/lib.ts`): bare WebSocket to the packaged app's
// CDP port, `window.api.awaitInitialization()` for the sidecar credential, then the engine's own
// HTTP API. Nothing is mocked and no credential is fabricated — every token this script uses is
// one the packaged app itself minted and wrote to its own secret files.
//
// Usage (see README.md):
//   bun docs/verification/2026-07-27-e7-packaged-live/probe.ts
//
// Exit codes: 0 = every required check passed · 1 = a required check failed
//             2 = preflight blocked (wrong build / no CDP / not logged in)
//
// Idempotent: it only creates fresh scratch sessions and reads state; a second run neither
// depends on nor is broken by the first run's leftovers.

import { createHash } from "node:crypto"
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs"
import { homedir } from "node:os"
import path from "node:path"

// ── constants ────────────────────────────────────────────────────────────────

const APP = process.env.ALPHA_E7_APP ?? "/Applications/alpha-code.app"
const USER_DATA =
  process.env.ALPHA_E7_USERDATA ?? path.join(homedir(), "Library/Application Support/ai.opencode.desktop.dev")
const CDP_PORT = Number(process.env.ALPHA_E7_CDP_PORT ?? 9222)
const OUT_DIR = path.join(import.meta.dir, "results")

/** The build this evidence directory was cut for: alpha @ e578e00ae, ship:mac 2026-07-28T01:31:42Z.
 *  Re-pinned from 94a76b669 / 8706d0c0… — that build predated the `readBoundedBody` fix (#648),
 *  on which K1.5 (keyless 真调) could not pass. See README §1 and §5. */
const PINNED_ASAR_SHA256 = "60589c59c58e44ac0daede93fc7397a8a04365f5345eac4312e205a0d8f48e44"
const PINNED_COMMIT = "e578e00ae"

/** `packages/ui-mac/src/main/cloud-web-search.ts` — the two ids alpha pins. */
const CLOUD_MCP_SERVER_NAME = "cloud"
const LOCAL_WEB_SEARCH_TOOL_ID = "websearch"
/** `packages/opencode/src/mcp/catalog.ts:117-119` — engine id = sanitize(server) + "_" + sanitize(remote). */
const sanitizeMcp = (v: string) => v.replace(/[^a-zA-Z0-9_-]/g, "_")
const engineToolId = (remoteName: string) => `${sanitizeMcp(CLOUD_MCP_SERVER_NAME)}_${sanitizeMcp(remoteName)}`

/** `packages/opencode/src/tool/mcp-websearch.ts` — the model-visible failure prefix ("defect 消失"). */
const FAILURE_PREFIX = "Web search failed:"
const SOVEREIGNTY_DENIED_MARK = "denied by alpha sovereignty"

// ── redaction ────────────────────────────────────────────────────────────────
// Nothing this probe writes may carry a secret. Every runtime-read secret is registered here the
// moment it is read, and `redact()` runs over every value before it reaches disk or stdout.

const SECRETS = new Set<string>()
function registerSecret(value: string | undefined) {
  if (value && value.trim().length >= 8) SECRETS.add(value.trim())
  return value
}
function redact<T>(value: T): T {
  const json = JSON.stringify(value, (_k, v) => {
    if (typeof v !== "string") return v
    let out = v
    for (const secret of SECRETS) out = out.split(secret).join("<redacted:secret>")
    out = out.replace(/\b(sk|pk|ak)-[A-Za-z0-9_-]{8,}/g, "<redacted:key>")
    out = out.replace(/Bearer\s+(?!\{file:)[A-Za-z0-9._~+/=-]{12,}/g, "Bearer <redacted:token>")
    out = out.replace(/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g, "<redacted:email>")
    return out
  })
  return JSON.parse(json) as T
}

// ── result model ─────────────────────────────────────────────────────────────

type Status = "pass" | "fail" | "blocked" | "not-producible" | "out-of-scope"
type Check = {
  id: string
  ac: string
  title: string
  status: Status
  /** Machine-readable pass criterion, stated before the run. */
  criterion: string
  observed: unknown
  at: string
  /** `false` ⇒ a non-pass does not fail the run (documented gaps, out-of-scope items). */
  required: boolean
  note?: string
}

const checks: Check[] = []
function record(c: Omit<Check, "at">) {
  const full: Check = { ...c, at: new Date().toISOString() }
  checks.push(full)
  const mark = full.status === "pass" ? "PASS" : full.status.toUpperCase()
  console.log(`[${mark.padEnd(14)}] ${full.id}  ${full.title}`)
  if (full.status !== "pass") console.log(`                 criterion: ${full.criterion}`)
  return full
}
function assertCheck(input: Omit<Check, "at" | "status" | "observed">, ok: boolean, observed: unknown) {
  return record({ ...input, status: ok ? "pass" : "fail", observed: redact(observed) })
}

// ── CDP ──────────────────────────────────────────────────────────────────────

type Cdp = { eval: <T>(expr: string) => Promise<T>; close: () => void }

async function connectCdp(): Promise<Cdp> {
  const list = (await (await fetch(`http://127.0.0.1:${CDP_PORT}/json`)).json()) as Array<{
    type: string
    url: string
    webSocketDebuggerUrl: string
  }>
  const target =
    list.find((t) => t.type === "page" && t.url.startsWith("oc://")) ?? list.find((t) => t.type === "page")
  if (!target) throw new Error("no renderer page target on the CDP port")
  const ws = new WebSocket(target.webSocketDebuggerUrl)
  await new Promise<void>((resolve, reject) => {
    ws.onopen = () => resolve()
    ws.onerror = () => reject(new Error("CDP websocket failed to open"))
  })
  let id = 0
  const pending = new Map<number, (msg: any) => void>()
  ws.onmessage = (event) => {
    const msg = JSON.parse(String(event.data))
    if (msg.id && pending.has(msg.id)) {
      pending.get(msg.id)!(msg)
      pending.delete(msg.id)
    }
  }
  const send = (method: string, params: unknown) =>
    new Promise<any>((resolve) => {
      const mine = ++id
      pending.set(mine, resolve)
      ws.send(JSON.stringify({ id: mine, method, params }))
    })
  return {
    async eval<T>(expression: string): Promise<T> {
      const res = await send("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true })
      if (res.error) throw new Error(`CDP error: ${JSON.stringify(res.error).slice(0, 400)}`)
      const details = res.result?.exceptionDetails
      if (details) throw new Error(`renderer exception: ${JSON.stringify(details).slice(0, 600)}`)
      return res.result?.result?.value as T
    },
    close: () => ws.close(),
  }
}

// ── engine HTTP (through the packaged app's own sidecar credential) ──────────

type Engine = { base: string; auth: string; get: (p: string) => Promise<any>; post: (p: string, b: unknown) => Promise<any> }

/** A model turn can run for minutes; anything longer than this is a hang, and a hung probe is
 *  worse than a failed one — the owner would sit and wait instead of reading a red line. */
const TURN_TIMEOUT_MS = Number(process.env.ALPHA_E7_TURN_TIMEOUT_MS ?? 240_000)

function makeEngine(base: string, auth: string): Engine {
  const call = async (method: string, p: string, body?: unknown) => {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), TURN_TIMEOUT_MS)
    let res: Response
    try {
      res = await fetch(base + p, {
        method,
        headers: { authorization: auth, ...(body === undefined ? {} : { "content-type": "application/json" }) },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        signal: controller.signal,
      })
    } finally {
      clearTimeout(timer)
    }
    const text = await res.text()
    if (!res.ok) throw new Error(`${method} ${p} → ${res.status}: ${text.slice(0, 300)}`)
    return text ? JSON.parse(text) : undefined
  }
  return {
    base,
    auth,
    get: (p) => call("GET", p),
    post: (p, b) => call("POST", p, b),
  }
}

// ── helpers ──────────────────────────────────────────────────────────────────

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

function secretFile(name: string) {
  return path.join(USER_DATA, "alpha-secrets", name)
}
function readSecret(name: string): string | undefined {
  const file = secretFile(name)
  if (!existsSync(file)) return undefined
  const value = readFileSync(file, "utf8").trim()
  return registerSecret(value) && value ? value : undefined
}

/** MCP Streamable-HTTP one-shot. Returns the parsed JSON-RPC envelope plus the raw HTTP status. */
async function mcpCall(url: string, bearer: string, method: string, params: unknown, timeoutMs = 45_000) {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  try {
    const res = await fetch(url, {
      method: "POST",
      headers: {
        authorization: `Bearer ${bearer}`,
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
      },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
      signal: controller.signal,
    })
    const body = await res.text()
    let envelope: any
    const line = body.startsWith("{") ? body : body.split("\n").find((l) => l.startsWith("data: "))?.slice(6)
    try {
      envelope = line ? JSON.parse(line) : undefined
    } catch {
      envelope = undefined
    }
    return { status: res.status, body, envelope }
  } finally {
    clearTimeout(timer)
  }
}

/** The tool part of an assistant message, as the model saw it. */
type ToolPart = { tool?: string; state?: { status?: string; output?: string; error?: string; metadata?: unknown } }
async function toolParts(engine: Engine, sessionID: string): Promise<ToolPart[]> {
  const messages = (await engine.get(`/session/${sessionID}/message?limit=100`)) as Array<{ parts?: any[] }>
  const out: ToolPart[] = []
  for (const message of messages ?? [])
    for (const part of message.parts ?? []) if (part.type === "tool") out.push({ tool: part.tool, state: part.state })
  return out
}

/** Drive one real turn and return the tool parts it produced. Auto-approves nothing; the probe
 *  pre-authorises via the session `tools` map so the run never blocks on a modal. */
async function realTurn(
  engine: Engine,
  model: { providerID: string; modelID: string },
  prompt: string,
  tools: Record<string, boolean>,
  system: string,
) {
  const session = (await engine.post("/session", {})) as { id: string }
  let turnError: string | undefined
  try {
    await engine.post(`/session/${session.id}/message`, {
      model,
      tools,
      system,
      parts: [{ type: "text", text: prompt }],
    })
  } catch (error) {
    turnError = String(error).slice(0, 400)
  }
  return { sessionID: session.id, turnError, parts: await toolParts(engine, session.id) }
}

/** Pick a tool-calling model. `platform` selects the paid gateway provider; `byok` selects any
 *  provider that is NOT the gateway (the logged-out keyless phase runs on the user's own key). */
async function pickModel(engine: Engine, platformBase: string, want: "platform" | "byok") {
  const raw = (await engine.get("/config/providers")) as {
    providers: Array<{ id: string; options?: { baseURL?: string }; models?: Record<string, any> }>
  }
  const isPlatform = (p: { options?: { baseURL?: string } }) =>
    Boolean(platformBase) && String(p.options?.baseURL ?? "").startsWith(platformBase)
  const candidates = raw.providers.filter((p) => (want === "platform" ? isPlatform(p) : !isPlatform(p)))
  for (const provider of candidates) {
    const model = Object.values(provider.models ?? {}).find((m: any) => m?.capabilities?.toolcall)
    // Never let a provider record (it carries plaintext BYOK keys) escape this function.
    if (model?.id) return { providerID: provider.id, modelID: model.id as string, providerIDs: raw.providers.map((p) => p.id) }
  }
  return { providerID: undefined, modelID: undefined, providerIDs: raw.providers.map((p) => p.id) }
}

// ── main ─────────────────────────────────────────────────────────────────────

/** Two phases, each fail-closed against the WRONG auth state. There is deliberately no
 *  auto-detect: a probe that silently switches phases can never report "未登录,无法取证",
 *  and a gate you cannot see fail is not a gate. */
const MODE: "logged-in" | "keyless" = process.argv.includes("--keyless") ? "keyless" : "logged-in"

const runAt = new Date().toISOString()
let cdp: Cdp | undefined

function finish(code: number, summary: Record<string, unknown>) {
  mkdirSync(OUT_DIR, { recursive: true })
  const payload = redact({
    schema: "alpha-code/e7-packaged-live/v1",
    issue: "alpha-code#643",
    phase: MODE,
    capturedAt: runAt,
    finishedAt: new Date().toISOString(),
    ...summary,
    checks,
  })
  const stamp = `${MODE}-${runAt.replace(/[-:]/g, "").replace(/\.\d+Z$/, "Z")}`
  writeFileSync(path.join(OUT_DIR, `${stamp}.json`), JSON.stringify(payload, null, 2) + "\n")
  writeFileSync(path.join(OUT_DIR, `latest-${MODE}.json`), JSON.stringify(payload, null, 2) + "\n")
  const failed = checks.filter((c) => c.required && c.status !== "pass")
  console.log("")
  console.log(`checks: ${checks.length}  required-failures: ${failed.length}`)
  console.log(`results → ${path.join(OUT_DIR, `${stamp}.json`)}`)
  cdp?.close()
  process.exit(code || (failed.length > 0 ? 1 : 0))
}

// ── P0 preflight ─────────────────────────────────────────────────────────────

const asarPath = path.join(APP, "Contents/Resources/app.asar")
if (!existsSync(asarPath)) {
  record({
    id: "P0.1",
    ac: "preflight",
    title: "packaged app present",
    status: "blocked",
    criterion: `${asarPath} exists`,
    observed: { asarPath, exists: false },
    required: true,
    note: "build it with: cd packages/ui-mac && bun run ship:mac",
  })
  finish(2, { blocked: "packaged app not installed" })
}

const asarSha = createHash("sha256").update(readFileSync(asarPath)).digest("hex")
const appMtime = statSync(asarPath).mtime.toISOString()
const buildMatches = asarSha === PINNED_ASAR_SHA256
record({
  id: "P0.1",
  ac: "preflight",
  title: "app under test is the build this evidence directory was cut for",
  status: buildMatches ? "pass" : "fail",
  criterion: `sha256(app.asar) === ${PINNED_ASAR_SHA256} (alpha @ ${PINNED_COMMIT})`,
  observed: { asarPath, asarSha, appMtime, pinnedCommit: PINNED_COMMIT },
  required: true,
  note: buildMatches ? undefined : "rebuild from the pinned commit, or re-pin PINNED_ASAR_SHA256 and say so in README",
})
if (!buildMatches) finish(2, { blocked: "app.asar fingerprint does not match the pinned build", asarSha })

try {
  cdp = await connectCdp()
} catch (error) {
  record({
    id: "P0.2",
    ac: "preflight",
    title: "CDP reachable on the packaged app",
    status: "blocked",
    criterion: `http://127.0.0.1:${CDP_PORT}/json lists a renderer page target`,
    observed: { error: String(error) },
    required: true,
    note: 'relaunch with: pkill -f "/Applications/alpha-code.app" ; ALPHA_CDP=1 open -a /Applications/alpha-code.app',
  })
  finish(2, { blocked: "no CDP — relaunch the app with ALPHA_CDP=1" })
}
record({
  id: "P0.2",
  ac: "preflight",
  title: "CDP reachable on the packaged app",
  status: "pass",
  criterion: `http://127.0.0.1:${CDP_PORT}/json lists a renderer page target`,
  observed: { port: CDP_PORT },
  required: true,
})

const init = await cdp!.eval<{ url: string; username: string | null; password: string | null }>(
  "window.api.awaitInitialization()",
)
registerSecret(init.password ?? undefined)
const engine = makeEngine(init.url, `Basic ${Buffer.from(`${init.username}:${init.password}`).toString("base64")}`)
const health = await engine.get("/global/health")
record({
  id: "P0.3",
  ac: "preflight",
  title: "sidecar engine healthy",
  status: health?.healthy ? "pass" : "fail",
  criterion: "GET /global/health → { healthy: true }",
  observed: redact({ url: init.url, health }),
  required: true,
})

const auth = await cdp!.eval<{ status: string; mode: string; platformStatus?: string }>("window.api.auth.getState()")
const endpoints = await cdp!.eval<Record<string, string>>("window.api.endpoints()")
const cloudToken = readSecret("ALPHA_CLOUD_TOKEN")
const apiKey = readSecret("ALPHA_API_KEY")
const platformPays = auth.status === "logged-in" && auth.mode === "platform" && Boolean(cloudToken)
const loggedOut = auth.status === "logged-out" && !cloudToken

const authObserved = redact({
  auth,
  cloudTokenFile: { path: secretFile("ALPHA_CLOUD_TOKEN"), present: Boolean(cloudToken) },
  apiKeyFile: { path: secretFile("ALPHA_API_KEY"), present: Boolean(apiKey) },
  endpoints,
})

if (MODE === "logged-in") {
  record({
    id: "P0.4",
    ac: "preflight",
    title: "登录态(平台代付)—— 取证的硬前提",
    status: platformPays ? "pass" : "blocked",
    criterion:
      'auth.getState() === {status:"logged-in", mode:"platform"} AND <userData>/alpha-secrets/ALPHA_CLOUD_TOKEN exists',
    observed: authObserved,
    required: true,
    note: platformPays ? undefined : "未登录,无法取证 — log in inside the app (平台代付模式), then re-run this probe",
  })
  if (!platformPays)
    finish(2, {
      blocked: "未登录,无法取证 (not logged in / no platform cloud token) — no evidence was collected",
      authObserved: redact(auth),
    })
} else {
  record({
    id: "K0.4",
    ac: "preflight",
    title: "登出态 —— keyless 兜底取证的硬前提",
    status: loggedOut ? "pass" : "blocked",
    criterion: 'auth.getState().status === "logged-out" AND <userData>/alpha-secrets/ALPHA_CLOUD_TOKEN is absent',
    observed: authObserved,
    required: true,
    note: loggedOut ? undefined : "仍处登录态,无法采集登出态证据 — log out inside the app, then re-run with --keyless",
  })
  if (!loggedOut)
    finish(2, {
      blocked: "仍处登录态,无法采集登出态 keyless 证据 (still logged in) — no evidence was collected",
      authObserved: redact(auth),
    })
}

// ── K 登出态:云暗 + keyless 本地兜底 ────────────────────────────────────────
// Runs only under `--keyless`; the gate above already exited otherwise.

if (MODE === "keyless") {
  const mcpStatusOut = (await engine.get("/mcp")) as Record<string, unknown>
  assertCheck(
    {
      id: "K1.1",
      ac: "AC2 登出态云暗",
      title: "no alpha cloud MCP server is registered while logged out",
      criterion: `GET /mcp has no "${CLOUD_MCP_SERVER_NAME}" key`,
      required: true,
    },
    !(CLOUD_MCP_SERVER_NAME in mcpStatusOut),
    mcpStatusOut,
  )

  const cfgOut = (await engine.get("/config")) as {
    mcp?: Record<string, unknown>
    permission?: Record<string, unknown>
  }
  assertCheck(
    {
      id: "K1.2",
      ac: "AC2 登出态 keyless 恢复",
      title: "the local keyless websearch is no longer denied once the platform stops paying",
      criterion: `config.mcp.${CLOUD_MCP_SERVER_NAME} absent AND config.permission.${LOCAL_WEB_SEARCH_TOOL_ID} !== "deny"`,
      required: true,
    },
    !cfgOut.mcp?.[CLOUD_MCP_SERVER_NAME] && cfgOut.permission?.[LOCAL_WEB_SEARCH_TOOL_ID] !== "deny",
    { mcpKeys: Object.keys(cfgOut.mcp ?? {}), websearchPermission: cfgOut.permission?.[LOCAL_WEB_SEARCH_TOOL_ID] },
  )

  const byok = await pickModel(engine, String(endpoints.platform ?? ""), "byok")
  record({
    id: "K1.3",
    ac: "AC2 登出态 keyless 兜底",
    title: "a BYOK tool-calling model is available to drive the keyless call",
    status: byok.modelID ? "pass" : "fail",
    criterion: "/config/providers has a non-gateway provider with at least one capabilities.toolcall model",
    observed: { providerID: byok.providerID, modelID: byok.modelID, providerIDs: byok.providerIDs },
    required: true,
  })

  if (byok.providerID && byok.modelID) {
    const toolIDs = ((await engine.get(
      `/experimental/tool?provider=${encodeURIComponent(byok.providerID)}&model=${encodeURIComponent(byok.modelID)}`,
    )) as Array<{ id: string }>).map((t) => t.id)
    assertCheck(
      {
        id: "K1.4",
        ac: "AC2 登出态 keyless 兜底",
        title: "the local keyless websearch tool is offered to the model again",
        criterion: `GET /experimental/tool?provider&model contains "${LOCAL_WEB_SEARCH_TOOL_ID}"`,
        required: true,
      },
      toolIDs.includes(LOCAL_WEB_SEARCH_TOOL_ID),
      { builtinToolIDs: toolIDs },
    )

    const keyless = await realTurn(
      engine,
      { providerID: byok.providerID, modelID: byok.modelID },
      `Call the \`${LOCAL_WEB_SEARCH_TOOL_ID}\` tool exactly once with the query "alpha-code e7 keyless fallback probe ${runAt}". Do not answer from memory and do not call any other tool.`,
      { [LOCAL_WEB_SEARCH_TOOL_ID]: true },
      "You are an evidence probe. When told to call a tool, call exactly that tool once, then stop.",
    )
    const part = keyless.parts.find((p) => p.tool === LOCAL_WEB_SEARCH_TOOL_ID)
    const message = String(part?.state?.error ?? "")

    assertCheck(
      {
        id: "K1.5",
        ac: "AC2 登出态 keyless 真调",
        title: "a real keyless web search actually returns results",
        criterion: `a real model turn produces a "${LOCAL_WEB_SEARCH_TOOL_ID}" tool part with state.status === "completed" and a non-empty output`,
        required: true,
      },
      part?.state?.status === "completed" && String(part?.state?.output ?? "").trim().length > 0,
      {
        sessionID: keyless.sessionID,
        turnError: keyless.turnError,
        toolPartsSeen: keyless.parts.map((p) => ({ tool: p.tool, status: p.state?.status })),
        status: part?.state?.status,
        outputHead: String(part?.state?.output ?? "").slice(0, 300),
        errorHead: message.slice(0, 600),
      },
    )

    // Separate claim, deliberately assessed even when K1.5 is red: whatever happened, the model
    // must have seen a discernible tool error — never an unhandled defect (#489 / ADR-035).
    record({
      id: "K1.6",
      ac: "AC3 defect 消失",
      title: "if the keyless call fails, the failure reaches the model as a discernible error",
      status: !part
        ? "fail"
        : part.state?.status === "completed"
          ? "pass"
          : message.startsWith(FAILURE_PREFIX) || message.includes(SOVEREIGNTY_DENIED_MARK)
            ? "pass"
            : "fail",
      criterion: `the tool part either completed, or carries a model-visible message starting with "${FAILURE_PREFIX}" (a typed WebSearchFailure, not an anonymous defect)`,
      observed: redact({ status: part?.state?.status, messageHead: message.slice(0, 300) }),
      required: true,
    })
  }

  finish(0, {
    build: { app: APP, asarSha256: asarSha, appMtime, pinnedCommit: PINNED_COMMIT, appVersion: health?.version },
    engine: { url: init.url, version: health?.version },
    auth: redact(auth),
    endpoints,
  })
}

// ── P1 登录态 listTools 与主权闸 ─────────────────────────────────────────────

const mcpStatus = (await engine.get("/mcp")) as Record<string, { status?: string; error?: string }>
assertCheck(
  {
    id: "P1.1",
    ac: "AC1 packaged 登录态 listTools",
    title: "engine registered the alpha cloud MCP server and it is connected",
    criterion: `GET /mcp → ["${CLOUD_MCP_SERVER_NAME}"].status === "connected"`,
    required: true,
  },
  mcpStatus?.[CLOUD_MCP_SERVER_NAME]?.status === "connected",
  mcpStatus,
)

const engineConfig = (await engine.get("/config")) as {
  mcp?: Record<string, { type?: string; url?: string; enabled?: boolean; headers?: Record<string, string> }>
  permission?: Record<string, unknown>
  agent?: Record<string, { permission?: Record<string, unknown> } | undefined>
}
const cloudDef = engineConfig.mcp?.[CLOUD_MCP_SERVER_NAME]
const expectedMcpUrl = endpoints.mcp ?? `${endpoints.cloud}/mcp`
assertCheck(
  {
    id: "P1.2",
    ac: "AC1 packaged 登录态 listTools",
    title: "cloud MCP definition points at the app-resolved URL and carries the token by {file:} reference only",
    criterion: `config.mcp.${CLOUD_MCP_SERVER_NAME}.url === "${expectedMcpUrl}" AND headers.Authorization matches /^Bearer \\{file:.*ALPHA_CLOUD_TOKEN\\}$/`,
    required: true,
  },
  cloudDef?.url === expectedMcpUrl &&
    /^Bearer \{file:.*ALPHA_CLOUD_TOKEN\}$/.test(String(cloudDef?.headers?.Authorization ?? "")),
  { expectedMcpUrl, cloudDef },
)

// LIVE-PATH GATE ①: listTools against the deployed worker, with the app's own cloud token.
const listed = await mcpCall(expectedMcpUrl, cloudToken!, "tools/list", {})
const remoteTools: Array<{ name: string }> = listed.envelope?.result?.tools ?? []
const remoteWebSearch = remoteTools.find((t) => /web[_-]?search/i.test(t.name))
assertCheck(
  {
    id: "P1.3",
    ac: "AC1 packaged 登录态 listTools",
    title: "LIVE-PATH GATE ① — deployed cloud worker lists a web-search tool for this account",
    criterion: "MCP tools/list on the app-resolved endpoint (app's own bearer) contains a tool matching /web[_-]?search/",
    required: true,
  },
  Boolean(remoteWebSearch),
  { httpStatus: listed.status, remoteToolNames: remoteTools.map((t) => t.name), matched: remoteWebSearch?.name },
)

const derivedEngineId = remoteWebSearch ? engineToolId(remoteWebSearch.name) : undefined
record({
  id: "P1.4",
  ac: "AC1 packaged 登录态 listTools",
  title: "engine-visible id for the cloud web-search tool (MCP catalog prefixes the server name)",
  status: derivedEngineId ? "pass" : "fail",
  criterion:
    'engine id = sanitize("cloud") + "_" + sanitize(<remote tool name>) per packages/opencode/src/mcp/catalog.ts:117-119 — record it, do not assume "cloud_web_search"',
  observed: { remoteName: remoteWebSearch?.name, derivedEngineId, alphaPinnedId: "cloud_web_search" },
  required: true,
  note:
    derivedEngineId && derivedEngineId !== "cloud_web_search"
      ? `MISMATCH: alpha pins "cloud_web_search" but the engine will register "${derivedEngineId}" — every alpha gate keyed on the pinned id needs re-checking (see README §已知风险)`
      : undefined,
})

const permWebsearch = engineConfig.permission?.[LOCAL_WEB_SEARCH_TOOL_ID]
const agentsMissingDeny = Object.entries(engineConfig.agent ?? {})
  .filter(([, a]) => a && a.permission?.[LOCAL_WEB_SEARCH_TOOL_ID] !== "deny")
  .map(([name]) => name)
assertCheck(
  {
    id: "P1.5",
    ac: "AC1 云优先(本地 keyless 被抑制)",
    title: "platform-pays denies the local keyless websearch globally and on every injected agent",
    criterion: `config.permission.${LOCAL_WEB_SEARCH_TOOL_ID} === "deny" AND every config.agent[*].permission.${LOCAL_WEB_SEARCH_TOOL_ID} === "deny"`,
    required: true,
  },
  permWebsearch === "deny" && agentsMissingDeny.length === 0,
  { globalPermission: permWebsearch, agentsMissingDeny, agents: Object.keys(engineConfig.agent ?? {}) },
)

// Pick a platform-gateway model with tool-calling, so the real turn below runs on the paid path.
const platform = await pickModel(engine, String(endpoints.platform ?? ""), "platform")
record({
  id: "P1.6",
  ac: "AC1 packaged 真调",
  title: "a platform-gateway model with tool-calling is available for the real call",
  status: platform.providerID && platform.modelID ? "pass" : "fail",
  criterion: `/config/providers has a provider whose options.baseURL starts with ${endpoints.platform} and at least one model with capabilities.toolcall`,
  observed: {
    platformProviderID: platform.providerID,
    platformModelID: platform.modelID,
    providerIDs: platform.providerIDs,
  },
  required: true,
})

if (platform.providerID && platform.modelID) {
  const modelTools = (await engine.get(
    `/experimental/tool?provider=${encodeURIComponent(platform.providerID)}&model=${encodeURIComponent(platform.modelID)}`,
  )) as Array<{ id: string }>
  const ids = modelTools.map((t) => t.id)
  assertCheck(
    {
      id: "P1.7",
      ac: "AC1 云优先(本地 keyless 被抑制)",
      title: "the built-in tool set offered for a platform model no longer contains the local websearch",
      criterion: `GET /experimental/tool?provider&model does NOT contain "${LOCAL_WEB_SEARCH_TOOL_ID}"`,
      required: true,
    },
    !ids.includes(LOCAL_WEB_SEARCH_TOOL_ID),
    { builtinToolIDs: ids },
  )
}

// ── P2 打包真调 + 计费 ───────────────────────────────────────────────────────

const summaryBefore = await cdp!.eval<any>("window.api.account.summary()")
const txBefore = await cdp!.eval<any>("window.api.account.transactions(50)")
const txIdsBefore = new Set<string>((txBefore?.transactions ?? []).map((t: any) => t.id))

let realCall: { sessionID: string; parts: ToolPart[] } | undefined
let cloudToolPart: ToolPart | undefined
const candidateIds = [derivedEngineId, "cloud_web_search"].filter(Boolean) as string[]

if (platform.providerID && platform.modelID) {
  for (let attempt = 1; attempt <= 3 && !cloudToolPart; attempt++) {
    const wanted = candidateIds[Math.min(attempt - 1, candidateIds.length - 1)]
    realCall = await realTurn(
      engine,
      { providerID: platform.providerID, modelID: platform.modelID },
      `Call the \`${wanted}\` tool exactly once with the query "alpha-code e7 packaged live probe ${runAt}". Do not answer from memory and do not call any other tool.`,
      Object.fromEntries(candidateIds.map((id) => [id, true])),
      "You are an evidence probe. When told to call a tool, call exactly that tool once, then stop.",
    )
    cloudToolPart = realCall.parts.find((p) => candidateIds.includes(String(p.tool)))
    if (!cloudToolPart) await sleep(1000)
  }
}

const cloudOutput = (() => {
  const raw = cloudToolPart?.state?.output
  if (!raw) return undefined
  try {
    return JSON.parse(raw)
  } catch {
    return undefined
  }
})()
const shapeOk =
  Boolean(cloudOutput) &&
  typeof cloudOutput === "object" &&
  "query" in (cloudOutput as object) &&
  "results" in (cloudOutput as object)

assertCheck(
  {
    id: "P2.1",
    ac: "AC1 packaged 真调返回 {query,results}",
    title: "the packaged app really invoked the cloud web-search tool through its own engine",
    criterion:
      'a real model turn produced a tool part whose id is the cloud web-search tool, state.status === "completed", and whose output parses to an object with `query` and `results`',
    required: true,
  },
  cloudToolPart?.state?.status === "completed" && shapeOk,
  {
    sessionID: realCall?.sessionID,
    toolPartsSeen: realCall?.parts.map((p) => ({ tool: p.tool, status: p.state?.status })),
    calledTool: cloudToolPart?.tool,
    state: cloudToolPart?.state?.status,
    error: cloudToolPart?.state?.error?.slice(0, 800),
    outputKeys: cloudOutput && typeof cloudOutput === "object" ? Object.keys(cloudOutput as object) : undefined,
    resultCount: Array.isArray((cloudOutput as any)?.results) ? (cloudOutput as any).results.length : undefined,
  },
)

// LIVE-PATH GATE ②: the same call, straight at the deployed worker with the app's own token —
// deterministic, and it isolates "the platform answers" from "the model chose to call the tool".
const directCall = remoteWebSearch
  ? await mcpCall(expectedMcpUrl, cloudToken!, "tools/call", {
      name: remoteWebSearch.name,
      arguments: { query: `alpha-code e7 live-path gate ${runAt}` },
    })
  : undefined
const directPayload = (() => {
  const text = directCall?.envelope?.result?.content?.find((c: any) => c?.type === "text")?.text
  if (!text) return undefined
  try {
    return JSON.parse(text)
  } catch {
    return undefined
  }
})()
assertCheck(
  {
    id: "P2.2",
    ac: "AC1 packaged 真调返回 {query,results}",
    title: "LIVE-PATH GATE ② — one real call on the app-resolved endpoint returns {query, results}",
    criterion:
      "MCP tools/call with the app's own cloud bearer returns isError !== true and a text payload parsing to an object with `query` and `results`",
    required: true,
  },
  directCall?.envelope?.result?.isError !== true &&
    Boolean(directPayload) &&
    typeof directPayload === "object" &&
    "query" in (directPayload as object) &&
    "results" in (directPayload as object),
  {
    httpStatus: directCall?.status,
    isError: directCall?.envelope?.result?.isError,
    payloadKeys: directPayload && typeof directPayload === "object" ? Object.keys(directPayload as object) : undefined,
    resultCount: Array.isArray((directPayload as any)?.results) ? (directPayload as any).results.length : undefined,
    rawHead: directPayload ? undefined : directCall?.body?.slice(0, 600),
  },
)

// 计费 (ledger/settle): the same two real calls above must move the account ledger.
await sleep(4000)
const summaryAfter = await cdp!.eval<any>("window.api.account.summary()")
const txAfter = await cdp!.eval<any>("window.api.account.transactions(50)")
const newTx = ((txAfter?.transactions ?? []) as any[]).filter((t) => !txIdsBefore.has(t.id))
const walletDelta = Number(summaryAfter?.walletUsedFen ?? 0) - Number(summaryBefore?.walletUsedFen ?? 0)
const balanceDelta = Number(summaryBefore?.balanceFen ?? 0) - Number(summaryAfter?.balanceFen ?? 0)
assertCheck(
  {
    id: "P2.3",
    ac: "AC3 计费(ledger/settle)证据",
    title: "the real web-search calls are billed to this tenant's ledger",
    criterion:
      "account summary walletUsedFen increased OR balanceFen decreased OR a new usage transaction appeared between the pre-call and post-call snapshots",
    required: true,
  },
  walletDelta > 0 || balanceDelta > 0 || newTx.length > 0,
  {
    walletUsedFenBefore: summaryBefore?.walletUsedFen,
    walletUsedFenAfter: summaryAfter?.walletUsedFen,
    balanceFenBefore: summaryBefore?.balanceFen,
    balanceFenAfter: summaryAfter?.balanceFen,
    walletDelta,
    balanceDelta,
    newTransactions: newTx.map((t) => ({
      id: t.id,
      type: t.type,
      title: t.title,
      amountFen: t.amountFen,
      status: t.status,
      createdAt: t.createdAt,
    })),
  },
)

// ── P3 失败集(真实、可复现的那几条)+ defect 消失 ──────────────────────────

const gateway = `${endpoints.platform}/v1/tools/web_search`
async function gatewayProbe(headers: Record<string, string>, body: string) {
  const res = await fetch(gateway, { method: "POST", headers: { "content-type": "application/json", ...headers }, body })
  return { status: res.status, body: (await res.text()).slice(0, 600) }
}

const p401 = await gatewayProbe({}, JSON.stringify({ query: "probe" }))
assertCheck(
  {
    id: "P3.1",
    ac: "AC3 真实失败集 401",
    title: "gateway web_search is fail-closed without a bearer",
    criterion: "POST /v1/tools/web_search with no Authorization → HTTP 401",
    required: true,
  },
  p401.status === 401,
  p401,
)

const bearer = apiKey ? { authorization: `Bearer ${apiKey}` } : {}
const p400missing = await gatewayProbe(bearer, JSON.stringify({}))
assertCheck(
  {
    id: "P3.2",
    ac: "AC3 真实失败集 400",
    title: "gateway web_search rejects a missing query with 400",
    criterion: "POST /v1/tools/web_search with a valid bearer and body {} → HTTP 400",
    required: true,
  },
  p400missing.status === 400,
  p400missing,
)

const p400malformed = await gatewayProbe(bearer, "{not json")
assertCheck(
  {
    id: "P3.3",
    ac: "AC3 真实失败集 400",
    title: "gateway web_search rejects malformed JSON with 400",
    criterion: "POST /v1/tools/web_search with a valid bearer and a malformed body → HTTP 400",
    required: true,
  },
  p400malformed.status === 400,
  p400malformed,
)

record({
  id: "P3.4",
  ac: "AC3 真实失败集 403",
  title: "403 (action_forbidden / job_not_enforceable)",
  status: "not-producible",
  criterion: "would require a token whose scope excludes model.invoke, or a non-enforceable job — neither is mintable from a normal desktop login",
  observed: {
    reason: "the desktop only ever holds route-purpose-bound tokens for model.invoke and cloud.dispatch",
    coveredAtL1: "packages/opencode/test/tool/alpha-websearch-failure.test.ts (403 → forbidden, error.code preserved)",
  },
  required: false,
})

record({
  id: "P3.5",
  ac: "AC3 真实失败集 502",
  title: "502 (no search backend configured)",
  status: "not-producible",
  criterion: "would require the deployed gateway to have neither TAVILY_API_KEY nor BRAVE_API_KEY",
  observed: {
    reason: "both secrets are configured on the deployed gateway (docs/verification/2026-07-22-e7-deploy-probe.md §4); removing them is a production mutation, out of bounds for a probe",
    coveredAtL1: "packages/opencode/test/tool/alpha-websearch-failure.test.ts (502 → upstream)",
  },
  required: false,
})

record({
  id: "P3.6",
  ac: "AC3 真实失败集 意外状态 LOUD",
  title: "unexpected non-2xx status maps to a loud, discernible failure",
  status: "not-producible",
  criterion: "would require the deployed gateway to emit a status outside {400,401,402,403,502} on this route",
  observed: {
    reason: "no request shape reachable from the desktop elicits one; the mapping itself is exercised at L1",
    coveredAtL1: "packages/opencode/test/tool/alpha-websearch-failure.test.ts (statusKind default → unexpected_status)",
  },
  required: false,
})

record({
  id: "P3.7",
  ac: "#643 out-of-scope",
  title: "402 / 余额证据",
  status: "out-of-scope",
  criterion: "not collected — #643 边界 explicitly excludes it",
  observed: {
    issueText: "#643 out-of-scope: 不采集 402/余额证据 —— 该路径今天不产生,402 证据归 alpha-platform#37 入册后",
    conflict:
      "docs/design/2026-07-22-e7-cloud-web-search-baseline.md 票 6 的 2026-07-25 更正说相反(402 已是可采集的真实失败态,失败集须含 402)。owner 裁决前按 Issue 正文执行。",
  },
  required: false,
})

// defect 消失: the local keyless tool is denied under platform-pays. Invoking it must yield a
// model-visible, discernible tool error — not an unhandled defect.
let denialPart: ToolPart | undefined
if (platform.providerID && platform.modelID) {
  const denial = await realTurn(
    engine,
    { providerID: platform.providerID, modelID: platform.modelID },
    `Call the \`${LOCAL_WEB_SEARCH_TOOL_ID}\` tool exactly once with the query "alpha-code e7 denial probe". Do not call any other tool.`,
    { [LOCAL_WEB_SEARCH_TOOL_ID]: true },
    "You are an evidence probe. When told to call a tool, call exactly that tool once, then stop.",
  )
  denialPart = denial.parts.find((p) => p.tool === LOCAL_WEB_SEARCH_TOOL_ID)
  const message = String(denialPart?.state?.error ?? "")
  record({
    id: "P3.8",
    ac: "AC3 defect 消失 / 主权拒绝 LOUD",
    title: "the denied local websearch surfaces a discernible tool error, not a crash",
    status: denialPart
      ? message.includes(SOVEREIGNTY_DENIED_MARK) || message.startsWith(FAILURE_PREFIX)
        ? "pass"
        : "fail"
      : "fail",
    criterion: `the tool part exists with state.status === "error" and a model-visible message containing "${SOVEREIGNTY_DENIED_MARK}" (or starting with "${FAILURE_PREFIX}") — no unhandled defect`,
    observed: redact({
      sessionID: denial.sessionID,
      toolPartsSeen: denial.parts.map((p) => ({ tool: p.tool, status: p.state?.status })),
      status: denialPart?.state?.status,
      message: message.slice(0, 600),
      metadata: denialPart?.state?.metadata,
    }),
    required: true,
    note: denialPart
      ? undefined
      : "the model declined to call the denied tool — re-run; the check needs the tool to actually be attempted",
  })
}

record({
  id: "P3.9",
  ac: "AC3 已登记缺口",
  title: "cloud-side failures are loud but not classifiable (alpha-platform#105)",
  status: "not-producible",
  criterion:
    "the cloud MCP shell drops r.status (packages/gateway/src/cloud-mcp.ts), so a cloud failure reaches the client with no HTTP status and no error.code",
  observed: {
    registeredGap: "alpha-platform#105",
    baseline: "docs/design/2026-07-22-e7-cloud-web-search-baseline.md §1 二次更正 (2026-07-25)",
  },
  required: false,
})

finish(0, {
  build: { app: APP, asarSha256: asarSha, appMtime, pinnedCommit: PINNED_COMMIT, appVersion: health?.version },
  engine: { url: init.url, version: health?.version },
  auth: redact(auth),
  endpoints,
  cloudMcpUrl: expectedMcpUrl,
  remoteWebSearchToolName: remoteWebSearch?.name,
  derivedEngineToolId: derivedEngineId,
})
