#!/usr/bin/env bun
// #536 deterministic packaged-runtime probe.
//
// The app is real and packaged. Only the remote alpha endpoints are replaced with a loopback
// server so renewal latency/status can be controlled without a TLS MITM or a real account. Every
// run uses OPENCODE_TEST_ONBOARDING=1 and a fresh temp root; synthetic credentials are deleted when
// the run ends. The output contains timing/status facts only, never token bytes.
// macOS may still flash the app before CDP minimizes it: run only on a quiescent test desktop.

import { createHash } from "node:crypto"
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { basename, dirname, join, resolve } from "node:path"

type RefreshPlan = { delayMs: number; status: number }
type Scenario = {
  id: string
  samples: number
  auth: "expired" | "ready" | "none"
  refresh?: RefreshPlan
  waitForRefreshEnd?: boolean
  screenshot?: boolean
  hotReloads?: number
  modelSetProbe?: boolean
  activeStream?: boolean
  longSessionRotations?: number
}

type TimelineRecord = { seq: number; name: string; t: number; [key: string]: unknown }
type RunResult = {
  scenario: string
  sample: number
  startupMs?: number
  bootReadyMs?: number
  refreshDurationMs?: number
  refreshResult?: string
  grace?: string
  rotations: number
  reloads: number
  mounts: number
  auth?: unknown
  unavailableVisible?: boolean
  readyRetryMs?: number
  modelSet?: {
    firstEventCount: number | null
    firstCount: number
    firstSha256: string
    hotCount: number
    hotSha256: string
    equal: boolean
    accountRequests: number
    bearerRequests: number
  }
  interruption?: { seen: boolean; draftPreserved: boolean; sessionID?: string }
  postRotationTurn?: { status: number; credentialGeneration: string; noOldToken: boolean }
  secretHygiene: {
    authMode: number | null
    tokenInTimeline: boolean
    refreshTokenInTimeline: boolean
    tokenInProcessEnv: boolean
    tokenInAuthState: boolean
    tokenInRendererSurface: boolean
    byokKeyInTimeline: boolean
    byokKeyInAuthState: boolean
    byokKeyInRendererSurface: boolean
  }
  events: TimelineRecord[]
}

const APP_BINARY = resolve(
  process.env.ALPHA_T7_APP ??
    join(import.meta.dir, "../../../packages/ui-mac/dist/mac-arm64/alpha-code.app/Contents/MacOS/alpha-code"),
)
const APP_BUNDLE = resolve(APP_BINARY, "../../..")
const OUT_DIR = join(import.meta.dir, "results")
const RUN_ONLY = process.env.ALPHA_T7_SCENARIO?.trim()
const APPEND_RESULTS = process.env.ALPHA_T7_APPEND === "1"
const KEEP_FAILED_ROOT = process.env.ALPHA_T7_KEEP_FAILED === "1"
const CDP_PORT = 9222
const REFRESH_TOKEN = "synthetic-refresh-token"
const SYNTHETIC_BYOK_KEY = "synthetic-deepseek-key"
const DRAFT = "draft survives token rotation"
const MAX_WAIT_MS = 25_000

const scenarios: Scenario[] = [
  { id: "latency-50ms", samples: 5, auth: "expired", refresh: { delayMs: 50, status: 200 }, waitForRefreshEnd: true },
  {
    id: "latency-1500ms",
    samples: 5,
    auth: "expired",
    refresh: { delayMs: 1_500, status: 200 },
    waitForRefreshEnd: true,
    screenshot: true,
  },
  {
    id: "latency-3000ms",
    samples: 5,
    auth: "expired",
    refresh: { delayMs: 3_000, status: 200 },
    waitForRefreshEnd: true,
  },
  {
    id: "timeout-10000ms",
    samples: 3,
    auth: "expired",
    refresh: { delayMs: 10_500, status: 200 },
    waitForRefreshEnd: true,
  },
  {
    id: "http-502",
    samples: 3,
    auth: "expired",
    refresh: { delayMs: 20, status: 502 },
    waitForRefreshEnd: true,
    screenshot: true,
  },
  {
    id: "invalid-400",
    samples: 1,
    auth: "expired",
    refresh: { delayMs: 20, status: 400 },
    waitForRefreshEnd: true,
    screenshot: true,
  },
  { id: "invalid-401", samples: 1, auth: "expired", refresh: { delayMs: 20, status: 401 }, waitForRefreshEnd: true },
  { id: "byok-only", samples: 5, auth: "none", screenshot: true, modelSetProbe: true },
  { id: "hot-renderer", samples: 1, auth: "ready", hotReloads: 5 },
  {
    id: "long-session-two-ttl",
    samples: 1,
    auth: "ready",
    refresh: { delayMs: 50, status: 200 },
    longSessionRotations: 2,
  },
  {
    id: "active-stream-rotation",
    samples: 1,
    auth: "ready",
    refresh: { delayMs: 50, status: 200 },
    activeStream: true,
    screenshot: true,
  },
]

if (!existsSync(APP_BINARY) || !existsSync(APP_BUNDLE)) throw new Error(`packaged app not found: ${APP_BUNDLE}`)
mkdirSync(OUT_DIR, { recursive: true })

const catalogFixture = JSON.parse(
  readFileSync(
    join(
      import.meta.dir,
      "../../../packages/alpha-contracts-consumer/vendor/alpha-platform-model-catalog/contracts/v2/fixtures/producer/model-catalog.json",
    ),
    "utf8",
  ),
)
const catalog = catalogFixture.value
const accountFixture = JSON.parse(
  readFileSync(
    join(
      import.meta.dir,
      "../../../packages/alpha-contracts-consumer/vendor/alpha-web/contracts/web-account/fixtures/consumers/alpha-code/account-summary.json",
    ),
    "utf8",
  ),
)
const accountSummary = accountFixture.value

let current: { scenario: string; sample: number; refresh?: RefreshPlan; refreshCount: number } | undefined
const serverFacts: Array<Record<string, unknown>> = []

function credentialGeneration(request: Request) {
  const value = request.headers.get("authorization") ?? ""
  const token = value.match(/^Bearer\s+(.+)$/i)?.[1]
  if (!token) return "missing"
  try {
    const payload = JSON.parse(Buffer.from(token.split(".")[1] ?? "", "base64url").toString("utf8")) as {
      jti?: string
    }
    if (payload.jti?.startsWith("renewed-")) return "renewed"
    if (payload.jti?.startsWith("seed-")) return "seed"
  } catch {}
  return "unrecognized"
}

function jwt(purpose: string, generation: string) {
  return `${Buffer.from("{}").toString("base64url")}.${Buffer.from(
    JSON.stringify({
      schema_version: 1,
      iss: "alpha-web",
      aud: "alpha-platform-api",
      sub: "synthetic-tenant",
      token_use: "platform_access",
      purpose,
      scope: [purpose],
      iat: 1,
      exp: 4_102_444_800,
      jti: `${generation}-${purpose}`,
    }),
  ).toString("base64url")}.signature`
}

function bundle(generation: string) {
  return Object.fromEntries(
    ["model.invoke", "cloud.dispatch", "cloud.read", "artifact.read", "account.read"].map((purpose) => [
      purpose,
      jwt(purpose, generation),
    ]),
  )
}

function tokenResponse(generation: string) {
  return {
    platform_access_tokens: bundle(generation),
    refresh_token: `${REFRESH_TOKEN}-${generation}`,
    session_id: `synthetic-${generation}`,
    expires_in: current?.scenario === "long-session-two-ttl" ? 45 : 900,
    email: "synthetic@example.invalid",
    plan: "test",
  }
}

const loopback = Bun.serve({
  port: 0,
  idleTimeout: 255,
  async fetch(request) {
    const url = new URL(request.url)
    if (url.pathname === "/auth/token" && request.method === "POST") {
      const body = (await request.json().catch(() => ({}))) as Record<string, unknown>
      const refresh = body.grant_type === "refresh_token"
      const plan = refresh ? (current?.refresh ?? { delayMs: 0, status: 200 }) : { delayMs: 0, status: 200 }
      if (refresh && current) current.refreshCount++
      serverFacts.push({
        scenario: current?.scenario,
        sample: current?.sample,
        path: url.pathname,
        grant: refresh ? "refresh_token" : "authorization_code",
        delayMs: plan.delayMs,
        status: plan.status,
      })
      if (plan.delayMs) await Bun.sleep(plan.delayMs)
      if (plan.status !== 200)
        return Response.json(
          { error: plan.status === 400 || plan.status === 401 ? "invalid_grant" : "temporarily_unavailable" },
          { status: plan.status },
        )
      return Response.json(tokenResponse(`renewed-${current?.sample ?? 0}-${current?.refreshCount ?? 0}`))
    }
    if (url.pathname === "/v1/models") {
      serverFacts.push({
        scenario: current?.scenario,
        sample: current?.sample,
        request: "catalog",
        credentialGeneration: credentialGeneration(request),
      })
      return Response.json(catalog)
    }
    if (url.pathname === "/v1/account/summary") {
      serverFacts.push({
        scenario: current?.scenario,
        sample: current?.sample,
        request: "account",
        credentialGeneration: credentialGeneration(request),
      })
      return Response.json(accountSummary)
    }
    if (url.pathname.endsWith("/chat/completions") && request.method === "POST") {
      const body = (await request.json().catch(() => ({}))) as {
        messages?: Array<{ role?: string; content?: unknown }>
      }
      const text = JSON.stringify(body.messages?.at(-1)?.content ?? "")
      const match = text.match(/SCRIPT:text:(\d+):(\d+)/)
      const chunks = Number(match?.[1] ?? 2)
      const delay = Number(match?.[2] ?? 30)
      serverFacts.push({
        scenario: current?.scenario,
        sample: current?.sample,
        path: url.pathname,
        request: "chat.completions",
        script: match ? `${chunks}x${delay}ms` : "default",
        credentialGeneration: credentialGeneration(request),
        status: 200,
      })
      const encoder = new TextEncoder()
      const stream = new ReadableStream({
        async start(controller) {
          const send = (delta: Record<string, unknown>, finish: string | null = null) => {
            const packet = {
              id: "chatcmpl-alpha536",
              object: "chat.completion.chunk",
              created: Math.floor(Date.now() / 1_000),
              model: "deepseek-v4-flash",
              choices: [{ index: 0, delta, finish_reason: finish }],
            }
            controller.enqueue(encoder.encode(`data: ${JSON.stringify(packet)}\n\n`))
          }
          try {
            send({ role: "assistant" })
            for (let i = 0; i < chunks; i++) {
              send({ content: `rotation-${i} ` })
              await Bun.sleep(delay)
            }
            send({}, "stop")
            controller.enqueue(encoder.encode("data: [DONE]\n\n"))
            controller.close()
          } catch {
            try {
              controller.close()
            } catch {}
          }
        },
      })
      return new Response(stream, { headers: { "content-type": "text/event-stream", "cache-control": "no-cache" } })
    }
    return Response.json({ ok: true })
  },
})

const BASE = `http://127.0.0.1:${loopback.port}`
const sleep = (ms: number) => new Promise((done) => setTimeout(done, ms))

function authPayload(kind: "expired" | "ready") {
  const now = Date.now()
  const longSession = current?.scenario === "long-session-two-ttl"
  const expiresAt =
    kind === "expired"
      ? now - 1_000
      : now + (current?.scenario === "active-stream-rotation" || longSession ? 31_000 : 900_000)
  const lifetimeMs = current?.scenario === "active-stream-rotation" ? 60_000 : longSession ? 45_000 : 900_000
  return {
    v: 1,
    plain: JSON.stringify({
      mode: "platform",
      platformAccessTokens: bundle("seed"),
      refreshToken: REFRESH_TOKEN,
      sessionId: "synthetic-seed",
      expiresAt,
      lifetimeMs,
      account: { email: "synthetic@example.invalid", plan: "test" },
    }),
  }
}

function timelineFile(root: string) {
  const logs = join(root, "desktop", "logs")
  if (!existsSync(logs)) return undefined
  const run = readdirSync(logs).sort().at(-1)
  const file = run ? join(logs, run, "startup-timeline.log") : undefined
  return file && existsSync(file) ? file : undefined
}

function readTimeline(root: string): TimelineRecord[] {
  const file = timelineFile(root)
  if (!file) return []
  return readFileSync(file, "utf8")
    .split("\n")
    .flatMap((line) => {
      const at = line.indexOf('{"seq"')
      if (at < 0) return []
      try {
        const value = JSON.parse(line.slice(at)) as TimelineRecord
        return typeof value.name === "string" && typeof value.t === "number" ? [value] : []
      } catch {
        return []
      }
    })
}

async function waitFor<T>(read: () => T | undefined | Promise<T | undefined>, timeoutMs = MAX_WAIT_MS): Promise<T> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const value = await read()
    if (value !== undefined) return value
    await sleep(25)
  }
  throw new Error(`timeout after ${timeoutMs}ms`)
}

type Cdp = {
  eval: <T>(expression: string) => Promise<T>
  screenshot: (file: string) => Promise<void>
  minimize: () => Promise<void>
  close: () => void
}

async function connectCdp(): Promise<Cdp> {
  const target = await waitFor(async () => {
    try {
      const pages = (await (await fetch(`http://127.0.0.1:${CDP_PORT}/json`)).json()) as Array<{
        type: string
        url: string
        webSocketDebuggerUrl: string
      }>
      return (
        pages.find((page) => page.type === "page" && page.url.startsWith("oc://")) ??
        pages.find((page) => page.type === "page")
      )
    } catch {
      return undefined
    }
  }, 15_000)
  const ws = new WebSocket(target.webSocketDebuggerUrl)
  await new Promise<void>((done, fail) => {
    ws.onopen = () => done()
    ws.onerror = () => fail(new Error("CDP websocket failed"))
  })
  let seq = 0
  const pending = new Map<number, (value: any) => void>()
  ws.onmessage = (event) => {
    const value = JSON.parse(String(event.data))
    if (value.id && pending.has(value.id)) {
      pending.get(value.id)!(value)
      pending.delete(value.id)
    }
  }
  const send = (method: string, params: unknown) =>
    new Promise<any>((done) => {
      const id = ++seq
      pending.set(id, done)
      ws.send(JSON.stringify({ id, method, params }))
    })
  return {
    async eval<T>(expression: string) {
      const response = await send("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true })
      if (response.result?.exceptionDetails)
        throw new Error(JSON.stringify(response.result.exceptionDetails).slice(0, 800))
      return response.result?.result?.value as T
    },
    async screenshot(file: string) {
      const response = await send("Page.captureScreenshot", { format: "png", fromSurface: true })
      writeFileSync(file, Buffer.from(response.result.data, "base64"))
    },
    async minimize() {
      const response = await send("Browser.getWindowForTarget", {})
      if (typeof response.result?.windowId === "number")
        await send("Browser.setWindowBounds", {
          windowId: response.result.windowId,
          bounds: { windowState: "minimized" },
        })
    },
    close: () => ws.close(),
  }
}

function basic(username: string | null, password: string | null) {
  if (!username && !password) return undefined
  return `Basic ${Buffer.from(`${username ?? ""}:${password ?? ""}`).toString("base64")}`
}

async function engineCall(
  init: { url: string; username: string | null; password: string | null },
  method: string,
  path: string,
  body?: unknown,
) {
  const response = await fetch(init.url + path, {
    method,
    headers: {
      ...(basic(init.username, init.password) ? { authorization: basic(init.username, init.password)! } : {}),
      ...(body === undefined ? {} : { "content-type": "application/json" }),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  })
  const text = await response.text()
  if (!response.ok) throw new Error(`${method} ${path} -> ${response.status}: ${text.slice(0, 300)}`)
  return text ? JSON.parse(text) : undefined
}

function percentile95(values: number[]) {
  const sorted = [...values].sort((a, b) => a - b)
  return sorted[Math.max(0, Math.ceil(sorted.length * 0.95) - 1)]
}

function modelSetFingerprint(value: unknown) {
  const body = value && typeof value === "object" ? (value as { data?: unknown }).data : undefined
  const nested = body && typeof body === "object" ? (body as { data?: unknown }).data : undefined
  const models = (Array.isArray(value) ? value : Array.isArray(body) ? body : Array.isArray(nested) ? nested : []) as Array<{
    id?: unknown
    providerID?: unknown
  }>
  const identities = models.map((model) => `${String(model.providerID ?? "")}/${String(model.id ?? "")}`).sort()
  return {
    count: identities.length,
    sha256: createHash("sha256").update(JSON.stringify(identities)).digest("hex"),
  }
}

async function stopOwned(
  proc: ReturnType<typeof Bun.spawn>,
  appPid: number | undefined,
  runBase: string,
  appRoot: string,
  cdp?: Cdp,
) {
  cdp?.close()
  try {
    if (appPid) process.kill(appPid, "SIGTERM")
  } catch {}
  await Promise.race([proc.exited, sleep(5_000)])
  if (proc.exitCode === null && appPid) {
    try {
      process.kill(appPid, "SIGKILL")
    } catch {}
    await Promise.race([proc.exited.catch(() => {}), sleep(2_000)])
  }
  if (proc.exitCode === null) proc.kill("SIGKILL")
  if (KEEP_FAILED_ROOT) {
    console.error(`[diagnostic] preserved runBase=${runBase} appRoot=${appRoot || "unresolved"}`)
    return
  }
  const resolved = resolve(runBase)
  if (resolved.startsWith(resolve(tmpdir()) + "/alpha536-") && existsSync(resolved))
    rmSync(resolved, { recursive: true, force: true })
  const resolvedAppRoot = appRoot ? resolve(appRoot) : ""
  if (
    resolvedAppRoot &&
    basename(resolvedAppRoot).startsWith("opencode-onboarding-") &&
    dirname(resolvedAppRoot) === resolve(tmpdir()) &&
    existsSync(resolvedAppRoot)
  )
    rmSync(resolvedAppRoot, { recursive: true, force: true })
  await sleep(250)
}

async function runOne(scenario: Scenario, sample: number): Promise<RunResult> {
  current = { scenario: scenario.id, sample, refresh: scenario.refresh, refreshCount: 0 }
  const runBase = mkdtempSync(join(tmpdir(), "alpha536-"))
  const runTag = `alpha536-${basename(runBase)}`
  const isolatedTmp = join(runBase, "tmp")
  mkdirSync(isolatedTmp, { recursive: true })
  const existingGlobalRoots = new Set(readdirSync(tmpdir()).filter((name) => name.startsWith("opencode-onboarding-")))
  const cleanEnv = Object.fromEntries(
    Object.entries(process.env).filter(([name]) => !/(_API_KEY|_TOKEN|_SECRET|PASSWORD)$/i.test(name)),
  )
  const proc = Bun.spawn(["/usr/bin/open", "-g", "-j", "-n", "-W", APP_BUNDLE, "--args", `--${runTag}`], {
    env: {
      ...cleanEnv,
      TMPDIR: isolatedTmp,
      OPENCODE_TEST_ONBOARDING: "1",
      ALPHA_CDP: "1",
      ALPHA_WEB_URL: BASE,
      ALPHA_PLATFORM_URL: BASE,
      ALPHA_ACCOUNT_URL: BASE,
      ALPHA_CLOUD_URL: BASE,
      ALPHA_MCP_URL: `${BASE}/mcp`,
      ...(scenario.modelSetProbe ? { DEEPSEEK_API_KEY: SYNTHETIC_BYOK_KEY } : {}),
      NO_PROXY: "127.0.0.1,localhost",
      no_proxy: "127.0.0.1,localhost",
    },
    stdout: "pipe",
    stderr: "pipe",
  })
  let cdp: Cdp | undefined
  let appRoot = ""
  let appPid: number | undefined
  let failed = false
  try {
    appRoot = await waitFor(() => {
      const isolated = existsSync(isolatedTmp)
        ? readdirSync(isolatedTmp).find((name) => name.startsWith("opencode-onboarding-"))
        : undefined
      const global = readdirSync(tmpdir()).find(
        (name) => name.startsWith("opencode-onboarding-") && !existingGlobalRoots.has(name),
      )
      const root = isolated ? join(isolatedTmp, isolated) : global ? join(tmpdir(), global) : undefined
      return root && existsSync(join(root, "desktop")) ? root : undefined
    }, 10_000)
    appPid = await waitFor(() => {
      const found = Bun.spawnSync(["pgrep", "-f", "--", `--${runTag}`])
        .stdout.toString()
        .trim()
        .split("\n")
        .filter(Boolean)
      return found.length === 1 ? Number(found[0]) : undefined
    }, 5_000)
    if (scenario.auth !== "none") {
      const file = join(appRoot, "desktop", "alpha-auth.json")
      writeFileSync(file, JSON.stringify(authPayload(scenario.auth)), { encoding: "utf8", mode: 0o600 })
    }

    cdp = await connectCdp()
    await cdp.minimize()

    await waitFor(() => {
      const events = readTimeline(appRoot)
      return events.some((event) => event.name === "main.auth.boot.token_check") ? true : undefined
    })
    const ready = await waitFor(
      () => {
        const events = readTimeline(appRoot)
        return events.find((event) => event.name === "renderer.home.model_list.end" && event.outcome === "ok")
      },
      scenario.id === "timeout-10000ms" ? 18_000 : MAX_WAIT_MS,
    )

    await waitFor(async () => {
      try {
        return (
          (await cdp!.eval<boolean>("Boolean(window.api?.awaitInitialization && window.api?.auth?.getState)")) ||
          undefined
        )
      } catch {
        return undefined
      }
    })

    let modelSet: RunResult["modelSet"]
    if (scenario.modelSetProbe) {
      const init = await cdp.eval<{ url: string; username: string | null; password: string | null }>(
        "window.api.awaitInitialization()",
      )
      const first = modelSetFingerprint(await engineCall(init, "GET", "/api/model"))
      const before = readTimeline(appRoot)
      const mounts = before.filter((event) => event.name === "renderer.root.mount").length
      const modelEnds = before.filter((event) => event.name === "renderer.home.model_list.end").length
      await cdp.eval("location.reload()")
      cdp.close()
      cdp = await connectCdp()
      const hotEvents = await waitFor(() => {
        const next = readTimeline(appRoot)
        return next.filter((event) => event.name === "renderer.root.mount").length > mounts &&
          next.filter((event) => event.name === "renderer.home.model_list.end").length > modelEnds
          ? next
          : undefined
      })
      const hotInit = await cdp.eval<{ url: string; username: string | null; password: string | null }>(
        "window.api.awaitInitialization()",
      )
      const hot = modelSetFingerprint(await engineCall(hotInit, "GET", "/api/model"))
      modelSet = {
        firstEventCount:
          typeof ready.count === "number"
            ? ready.count
            : typeof hotEvents.filter((event) => event.name === "renderer.home.model_list.end").at(-1)?.count === "number"
              ? Number(hotEvents.filter((event) => event.name === "renderer.home.model_list.end").at(-1)?.count)
              : null,
        firstCount: first.count,
        firstSha256: first.sha256,
        hotCount: hot.count,
        hotSha256: hot.sha256,
        equal: first.count === hot.count && first.sha256 === hot.sha256,
        accountRequests: 0,
        bearerRequests: 0,
      }
    }

    if (scenario.waitForRefreshEnd) {
      await waitFor(
        () => {
          const events = readTimeline(appRoot)
          return events.find((event) => event.name === "main.auth.refresh.end")
        },
        scenario.id === "timeout-10000ms" ? 18_000 : MAX_WAIT_MS,
      )
    }

    let interruption: RunResult["interruption"]
    let postRotationTurn: RunResult["postRotationTurn"]
    if (scenario.activeStream) {
      const init = await cdp.eval<{ url: string; username: string | null; password: string | null }>(
        "window.api.awaitInitialization()",
      )
      const providers = (await engineCall(init, "GET", "/config/providers")) as {
        providers: Array<{ id: string; options?: { baseURL?: string }; models?: Record<string, { id?: string }> }>
      }
      const provider = providers.providers.find((item) => String(item.options?.baseURL ?? "").startsWith(`${BASE}/v1`))
      const model = Object.values(provider?.models ?? {}).find((item) => item.id)
      if (!provider || !model?.id) throw new Error("synthetic platform provider/model missing")
      const session = (await engineCall(init, "POST", "/session", { title: "#536 active stream rotation" })) as {
        id: string
      }
      const href = `/server/${Buffer.from("sidecar").toString("base64url")}/session/${encodeURIComponent(session.id)}`
      const clicked = await cdp.eval<boolean>(
        `(() => { const a = document.createElement('a'); a.href = ${JSON.stringify(href)}; a.hidden = true; document.body.append(a); a.click(); a.remove(); return true })()`,
      )
      if (!clicked) throw new Error("session link not reachable in packaged renderer")
      await waitFor(async () => {
        try {
          return (
            (await cdp!.eval<boolean>(`Boolean(document.querySelector('[data-alpha-composer="session"] textarea'))`)) ||
            undefined
          )
        } catch {
          return undefined
        }
      }, 10_000)
      await engineCall(init, "POST", `/session/${session.id}/prompt_async`, {
        model: { providerID: provider.id, modelID: model.id },
        parts: [{ type: "text", text: "SCRIPT:text:240:500" }],
      })
      await sleep(1_000)
      await cdp.eval(
        `(() => { const t = document.querySelector('[data-alpha-composer="session"] textarea'); if (!t) return false; const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set; setter.call(t, ${JSON.stringify(DRAFT)}); t.dispatchEvent(new Event('input', { bubbles: true })); return true })()`,
      )
      await waitFor(() => {
        const events = readTimeline(appRoot)
        return events.find((event) => event.name === "renderer.generation.interruption")
      }, 45_000)
      const draft = await cdp.eval<string>(
        "document.querySelector('[data-alpha-composer=\"session\"] textarea')?.value ?? ''",
      )
      interruption = { seen: true, draftPreserved: draft === DRAFT, sessionID: session.id }

      await waitFor(() => {
        const events = readTimeline(appRoot)
        const refreshEnd = events.find((event) => event.name === "main.auth.refresh.end")
        const tokenReady = events.find(
          (event) =>
            event.name === "main.sidecar.generation.emit" && event.phase === "ready" && event.reason === "token-only",
        )
        return refreshEnd && tokenReady ? { refreshEnd, tokenReady } : undefined
      }, 60_000)

      const postInit = await cdp.eval<{ url: string; username: string | null; password: string | null }>(
        "window.api.awaitInitialization()",
      )
      const postSession = (await engineCall(postInit, "POST", "/session", {
        title: "#536 first post-rotation turn",
      })) as { id: string }
      await engineCall(postInit, "POST", `/session/${postSession.id}/prompt_async`, {
        model: { providerID: provider.id, modelID: model.id },
        parts: [{ type: "text", text: "SCRIPT:text:2:30" }],
      })
      const postFact = await waitFor(
        () =>
          serverFacts.find(
            (fact) =>
              fact.scenario === scenario.id &&
              fact.sample === sample &&
              fact.request === "chat.completions" &&
              fact.script === "2x30ms",
          ),
        20_000,
      )
      const generation = String(postFact.credentialGeneration ?? "missing")
      postRotationTurn = {
        status: Number(postFact.status ?? 0),
        credentialGeneration: generation,
        noOldToken: generation === "renewed",
      }
    }

    if (scenario.longSessionRotations) {
      await waitFor(() => {
        const readyRotations = readTimeline(appRoot).filter(
          (event) =>
            event.name === "main.sidecar.generation.emit" && event.reason === "token-only" && event.phase === "ready",
        ).length
        return readyRotations >= scenario.longSessionRotations! ? true : undefined
      }, 75_000)
    }

    const hotDurations: number[] = []
    for (let i = 0; i < (scenario.hotReloads ?? 0); i++) {
      const before = readTimeline(appRoot)
      const mounts = before.filter((event) => event.name === "renderer.root.mount").length
      const modelEnds = before.filter((event) => event.name === "renderer.home.model_list.end").length
      await cdp.eval("location.reload()")
      cdp.close()
      cdp = await connectCdp()
      const events = await waitFor(() => {
        const next = readTimeline(appRoot)
        return next.filter((event) => event.name === "renderer.root.mount").length > mounts &&
          next.filter((event) => event.name === "renderer.home.model_list.end").length > modelEnds
          ? next
          : undefined
      })
      const mount = events.filter((event) => event.name === "renderer.root.mount").at(-1)!
      const end = events.filter((event) => event.name === "renderer.home.model_list.end").at(-1)!
      hotDurations.push(end.t - mount.t)
    }

    if (scenario.screenshot) await cdp.screenshot(join(OUT_DIR, `${scenario.id}-${sample}.png`))

    const auth = await cdp.eval<unknown>("window.api.auth.getState()")
    const rendererSurface = await cdp.eval<string>(
      "JSON.stringify({html: document.documentElement.outerHTML, local: {...localStorage}, session: {...sessionStorage}})",
    )
    const unavailableVisible = await cdp.eval<boolean>(
      "document.body.innerText.includes('模型列表暂不可用') || document.body.innerText.includes('Model list unavailable')",
    )
    const events = readTimeline(appRoot)
    const refreshStart = events.find((event) => event.name === "main.auth.refresh.start")
    const refreshEnd = events.find((event) => event.name === "main.auth.refresh.end")
    const readyEvents = events.filter(
      (event) => event.name === "main.sidecar.generation.emit" && event.phase === "ready",
    )
    const tokenReady = readyEvents.find((event) => event.reason === "token-only")
    const retryAfterReady = tokenReady
      ? events.find((event) => event.name === "renderer.home.model_list.start" && event.t >= tokenReady.t)
      : undefined
    const rawTimeline = timelineFile(appRoot) ? readFileSync(timelineFile(appRoot)!, "utf8") : ""
    const authFile = join(appRoot, "desktop", "alpha-auth.json")
    if (modelSet) {
      const facts = serverFacts.filter((fact) => fact.scenario === scenario.id && fact.sample === sample)
      modelSet.accountRequests = facts.filter((fact) => fact.request === "account").length
      modelSet.bearerRequests = facts.filter(
        (fact) =>
          (fact.request === "account" || fact.request === "catalog") && fact.credentialGeneration !== "missing",
      ).length
    }
    const result: RunResult = {
      scenario: scenario.id,
      sample,
      startupMs: ready.t,
      bootReadyMs: readyEvents.find((event) => event.reason === "boot")?.t,
      refreshDurationMs: refreshStart && refreshEnd ? refreshEnd.t - refreshStart.t : undefined,
      refreshResult: typeof refreshEnd?.result === "string" ? refreshEnd.result : undefined,
      grace: String(events.find((event) => event.name === "main.auth.boot.grace")?.outcome ?? "not-applicable"),
      rotations: events.filter(
        (event) =>
          event.name === "main.sidecar.generation.emit" && event.reason === "token-only" && event.phase === "ready",
      ).length,
      reloads: events.filter((event) => event.name === "main.renderer.reload.perform").length,
      mounts: events.filter((event) => event.name === "renderer.root.mount").length,
      auth,
      unavailableVisible,
      readyRetryMs: retryAfterReady && tokenReady ? retryAfterReady.t - tokenReady.t : undefined,
      modelSet,
      interruption,
      postRotationTurn,
      secretHygiene: {
        authMode: existsSync(authFile) ? statSync(authFile).mode & 0o777 : null,
        tokenInTimeline: /eyJ[A-Za-z0-9_-]{10,}\./.test(rawTimeline),
        refreshTokenInTimeline: rawTimeline.includes(REFRESH_TOKEN),
        tokenInProcessEnv: appPid
          ? [jwt("model.invoke", "seed"), REFRESH_TOKEN].some((secret) =>
              Bun.spawnSync(["ps", "eww", "-p", String(appPid)])
                .stdout.toString()
                .includes(secret),
            )
          : false,
        tokenInAuthState: [jwt("model.invoke", "seed"), REFRESH_TOKEN].some((secret) =>
          JSON.stringify(auth).includes(secret),
        ),
        tokenInRendererSurface: [jwt("model.invoke", "seed"), REFRESH_TOKEN].some((secret) =>
          rendererSurface.includes(secret),
        ),
        byokKeyInTimeline: rawTimeline.includes(SYNTHETIC_BYOK_KEY),
        byokKeyInAuthState: JSON.stringify(auth).includes(SYNTHETIC_BYOK_KEY),
        byokKeyInRendererSurface: rendererSurface.includes(SYNTHETIC_BYOK_KEY),
      },
      events: events.filter((event) =>
        [
          "main.timeline.epoch",
          "main.auth.boot.token_check",
          "main.auth.boot.grace",
          "main.auth.refresh.start",
          "main.auth.refresh.end",
          "main.auth.rotation",
          "main.sidecar.generation.emit",
          "main.renderer.reload.perform",
          "main.renderer.reload.skipped",
          "renderer.root.mount",
          "renderer.home.model_list.start",
          "renderer.home.model_list.end",
          "renderer.home.model_list.retry_tick",
          "renderer.generation.interruption",
        ].includes(event.name),
      ),
    }
    if (hotDurations.length) result.readyRetryMs = percentile95(hotDurations)
    return result
  } catch (error) {
    failed = true
    const events = appRoot ? readTimeline(appRoot) : []
    console.error(
      `[diagnostic] scenario=${scenario.id} sample=${sample} exit=${proc.exitCode ?? "running"} root=${appRoot || "unresolved"}`,
    )
    console.error(
      `[diagnostic] events=${JSON.stringify(
        events.slice(-40).map(({ seq, name, t, outcome, phase, reason }) => ({ seq, name, t, outcome, phase, reason })),
      )}`,
    )
    if (appRoot) {
      const logs = join(appRoot, "desktop", "logs")
      const run = existsSync(logs) ? readdirSync(logs).sort().at(-1) : undefined
      if (run) {
        for (const name of readdirSync(join(logs, run)).sort()) {
          const file = join(logs, run, name)
          if (!statSync(file).isFile()) continue
          const tail = readFileSync(file, "utf8")
            .split("\n")
            .slice(-80)
            .join("\n")
            .replace(/eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/g, "[REDACTED_JWT]")
            .replaceAll(REFRESH_TOKEN, "[REDACTED_REFRESH_TOKEN]")
            .replaceAll(SYNTHETIC_BYOK_KEY, "[REDACTED_SYNTHETIC_BYOK_KEY]")
          console.error(`[diagnostic] ${name}\n${tail}`)
        }
      }
    }
    throw error
  } finally {
    const keep = KEEP_FAILED_ROOT && failed
    if (!keep) await stopOwned(proc, appPid, runBase, appRoot, cdp)
    else {
      cdp?.close()
      try {
        if (appPid) process.kill(appPid, "SIGTERM")
      } catch {}
      await Promise.race([proc.exited, sleep(5_000)])
      if (proc.exitCode === null && appPid) {
        try {
          process.kill(appPid, "SIGKILL")
        } catch {}
      }
      if (proc.exitCode === null) proc.kill("SIGKILL")
      console.error(`[diagnostic] preserved runBase=${runBase} appRoot=${appRoot || "unresolved"}`)
    }
  }
}

const selected = scenarios.filter((scenario) => !RUN_ONLY || scenario.id === RUN_ONLY)
if (selected.length === 0) throw new Error(`unknown ALPHA_T7_SCENARIO=${RUN_ONLY}`)
const previous = (() => {
  const file = join(OUT_DIR, "results.json")
  if (!APPEND_RESULTS || !existsSync(file)) return undefined
  return JSON.parse(readFileSync(file, "utf8")) as {
    results?: RunResult[]
    serverFacts?: Array<Record<string, unknown>>
  }
})()
const selectedIDs = new Set(selected.map((scenario) => scenario.id))
const results: RunResult[] = (previous?.results ?? []).filter((result) => !selectedIDs.has(result.scenario))
serverFacts.unshift(...(previous?.serverFacts ?? []).filter((fact) => !selectedIDs.has(String(fact.scenario ?? ""))))
function writeResults(incomplete?: { scenario: string; sample: number; error: string }) {
  const latency = results
    .filter(
      (result) =>
        result.scenario.startsWith("latency-") ||
        result.scenario === "timeout-10000ms" ||
        result.scenario === "http-502",
    )
    .flatMap((result) => (typeof result.startupMs === "number" ? [result.startupMs] : []))
  const payload = {
    schema: "alpha-code/req109-110-t7-runtime/v1",
    issue: "alpha-code#536",
    capturedAt: new Date().toISOString(),
    commit: Bun.spawnSync(["git", "rev-parse", "HEAD"], { cwd: join(import.meta.dir, "../../..") })
      .stdout.toString()
      .trim(),
    appSha256: createHash("sha256").update(readFileSync(APP_BINARY)).digest("hex"),
    endpoint: "loopback (URL redacted; no real credential)",
    incomplete,
    latency: {
      samples: latency.length,
      p95Ms: latency.length ? percentile95(latency) : null,
      maxMs: latency.length ? Math.max(...latency) : null,
    },
    results,
    serverFacts,
  }
  writeFileSync(join(OUT_DIR, "results.json"), JSON.stringify(payload, null, 2) + "\n")
  return payload
}

let incomplete: { scenario: string; sample: number; error: string } | undefined
try {
  for (const scenario of selected) {
    for (let sample = 1; sample <= scenario.samples; sample++) {
      process.stdout.write(`[${scenario.id}] ${sample}/${scenario.samples} ... `)
      try {
        const result = await runOne(scenario, sample)
        results.push(result)
        writeResults()
        console.log(`model-ready=${result.startupMs?.toFixed(0)}ms refresh=${result.refreshResult ?? "n/a"}`)
      } catch (error) {
        incomplete = { scenario: scenario.id, sample, error: String(error) }
        writeResults(incomplete)
        throw error
      }
    }
  }
} finally {
  loopback.stop(true)
}

const payload = writeResults(incomplete)
console.log(`results: ${join(OUT_DIR, "results.json")}`)
console.log(`latency samples=${payload.latency.samples} p95=${payload.latency.p95Ms?.toFixed(0) ?? "n/a"}ms`)
