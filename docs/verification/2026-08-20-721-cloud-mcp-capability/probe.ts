#!/usr/bin/env bun
// #721 (REQ-129) Cloud MCP capability matrix — read-only evidence probe.
//
// It drives the DEPLOYED `/mcp` resource with the credential the packaged app minted for itself
// (`<userData>/alpha-secrets/ALPHA_CLOUD_TOKEN`), the same discipline as
// `docs/verification/2026-07-27-e7-packaged-live/probe.ts`: nothing is mocked, no credential is
// fabricated except the two deliberately-invalid ones used as negative transport inputs, and every
// value is redacted before it reaches disk or stdout.
//
// Usage:
//   bun docs/verification/2026-08-20-721-cloud-mcp-capability/probe.ts            # no paid calls
//   bun docs/verification/2026-08-20-721-cloud-mcp-capability/probe.ts --paid     # + real billed calls
//   bun docs/verification/2026-08-20-721-cloud-mcp-capability/probe.ts --paid --skip-t4
//
// When `mcp-auth.json` holds cloud OAuth tokens (P0.5), LIVE_AUTH prefers that `mcp_access`
// JWT for AC3/AC4 rows. ALPHA_CLOUD_TOKEN remains the transport negative + A-FALLBACK control.

import { createHash } from "node:crypto"
import { execFileSync } from "node:child_process"
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs"
import { homedir } from "node:os"
import path from "node:path"

const APP = process.env.ALPHA_721_APP ?? "/Applications/alpha-code.app"
const USER_DATA = process.env.ALPHA_721_USERDATA ?? path.join(homedir(), "Library/Application Support/ai.opencode.desktop")
const ENGINE_DATA = process.env.ALPHA_721_ENGINE_DATA ?? path.join(homedir(), ".local/share/opencode")
const CDP_PORT = Number(process.env.ALPHA_721_CDP_PORT ?? 9222)
const MCP_URL = process.env.ALPHA_721_MCP_URL ?? "https://alpha-cloud.tidelabs.click/mcp"
const PAID = process.argv.includes("--paid")
/** Skip the multi-minute wait for the snapshotted ALPHA_CLOUD_TOKEN to expire (T4). */
const SKIP_T4 = process.argv.includes("--skip-t4")
const OUT_DIR = path.join(import.meta.dir, "results")

/** The five columns owner narrowed #721 to on 2026-07-31 (alpha-platform#175). */
const APPROVED_FIVE = ["cloud_dispatch", "cloud_status", "cloud_await", "cloud_artifacts", "cloud_web_search"] as const
/** Removed from the MCP surface by alpha-platform#175 — must not appear and must not execute. */
const REMOVED_SCHEDULE = ["cloud_schedule_create", "cloud_schedule_list", "cloud_schedule_delete"] as const
/** Match the #1043 mcp_access matrix (Chrome UA). */
const CHROME_UA =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36"

/** `alpha-platform/docs/contracts/public-cloud-mcp.md` §5 — the full challenge parameter set. */
const CHALLENGE_401 = {
  error: "invalid_token",
  error_description: "Missing or invalid access token for the alpha-cloud MCP resource",
  scope: "artifact.read cloud.dispatch cloud.read model.invoke",
  resource_metadata: "https://alpha-cloud.tidelabs.click/.well-known/oauth-protected-resource/mcp",
}
/** Registry authority copy (`public-cloud-mcp.md` §6). The probe asserts the server's own
 *  `scope=` challenge parameter against this, so a server-side registry change shows up here. */
const REQUIRED_ACTION: Record<string, string> = {
  cloud_dispatch: "cloud.dispatch",
  cloud_status: "cloud.read",
  cloud_await: "cloud.read",
  cloud_artifacts: "artifact.read",
  cloud_cancel: "cloud.dispatch",
  cloud_web_search: "cloud.dispatch model.invoke",
}

// ── redaction ────────────────────────────────────────────────────────────────

const SECRETS = new Set<string>()
function registerSecret(value: string | undefined) {
  if (value && value.trim().length >= 8) SECRETS.add(value.trim())
  return value
}
function redact<T>(value: T): T {
  return JSON.parse(
    JSON.stringify(value, (_k, v) => {
      if (typeof v !== "string") return v
      let out = v
      for (const secret of SECRETS) out = out.split(secret).join("<redacted:secret>")
      out = out.replace(/\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{4,}/g, "<redacted:jwt>")
      out = out.replace(/\b(sk|pk|ak)-[A-Za-z0-9_-]{8,}/g, "<redacted:key>")
      out = out.replace(/Bearer\s+[A-Za-z0-9._~+/=-]{12,}/g, "Bearer <redacted:token>")
      out = out.replace(/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g, "<redacted:email>")
      return out
    }),
  ) as T
}
const pseudo = (v: unknown) => "pseudo:" + createHash("sha256").update(String(v)).digest("hex").slice(0, 12)

// ── result model ─────────────────────────────────────────────────────────────

type Status = "pass" | "fail" | "blocked" | "not-producible"
type Check = {
  id: string
  ac: string
  title: string
  status: Status
  /** Machine-readable pass criterion, fixed before the run. */
  criterion: string
  observed: unknown
  at: string
  /** `false` ⇒ a non-pass does not fail the run. */
  required: boolean
  note?: string
}
const checks: Check[] = []
function record(c: Omit<Check, "at">) {
  const full: Check = { ...c, observed: redact(c.observed), at: new Date().toISOString() }
  checks.push(full)
  console.log(`[${full.status.toUpperCase().padEnd(14)}] ${full.id}  ${full.title}`)
  if (full.status !== "pass") console.log(`                 criterion: ${full.criterion}`)
  return full
}
const assertCheck = (
  input: Omit<Check, "at" | "status" | "observed">,
  ok: boolean,
  observed: unknown,
) => record({ ...input, status: ok ? "pass" : "fail", observed })

function finish(exitCode: number, phase: string) {
  mkdirSync(OUT_DIR, { recursive: true })
  const stamp = new Date().toISOString().replace(/[-:]/g, "").replace(/\..+/, "Z")
  const payload = redact({
    probe: "alpha-code#721 cloud MCP capability matrix",
    phase,
    paid: PAID,
    mcpUrl: MCP_URL,
    collectedAt: new Date().toISOString(),
    build,
    exitCode,
    summary: {
      pass: checks.filter((c) => c.status === "pass").length,
      fail: checks.filter((c) => c.status === "fail").length,
      blocked: checks.filter((c) => c.status === "blocked").length,
      notProducible: checks.filter((c) => c.status === "not-producible").length,
      requiredFailures: checks.filter((c) => c.required && c.status !== "pass").map((c) => c.id),
    },
    checks,
  })
  writeFileSync(path.join(OUT_DIR, `${phase}-${stamp}.json`), JSON.stringify(payload, null, 2))
  writeFileSync(path.join(OUT_DIR, `latest-${phase}.json`), JSON.stringify(payload, null, 2))
  console.log(`\n${phase}: ${payload.summary.pass} pass · ${payload.summary.fail} fail · ${payload.summary.blocked} blocked · exit ${exitCode}`)
  process.exit(exitCode)
}

// ── MCP transport ────────────────────────────────────────────────────────────

type McpReply = { http: number; challenge: Record<string, string> | null; body: unknown; raw: string }

/** One JSON-RPC POST. Returns the HTTP status, the parsed `WWW-Authenticate` parameters and the
 *  decoded payload — the three axes the contract makes claims about. SSE and plain JSON are both
 *  accepted because the server picks the framing. */
async function mcp(method: string, params: unknown, auth?: string): Promise<McpReply> {
  const res = await fetch(MCP_URL, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
      "user-agent": CHROME_UA,
      ...(auth ? { authorization: auth } : {}),
    },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
    signal: AbortSignal.timeout(60_000),
  })
  const raw = await res.text()
  const header = res.headers.get("www-authenticate")
  const challenge = header
    ? Object.fromEntries([...header.matchAll(/(\w+)="([^"]*)"/g)].map((m) => [m[1]!, m[2]!]))
    : null
  let body: unknown = undefined
  for (const line of raw.split("\n")) {
    const text = line.startsWith("data: ") ? line.slice(6) : line
    if (!text.trim().startsWith("{")) continue
    try {
      body = JSON.parse(text)
    } catch {}
  }
  return { http: res.status, challenge, body, raw }
}

/** Raw POST with a caller-supplied body — used only for the JSON-RPC batch negative. */
async function mcpRaw(body: string, auth?: string) {
  const res = await fetch(MCP_URL, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
      "user-agent": CHROME_UA,
      ...(auth ? { authorization: auth } : {}),
    },
    body,
    signal: AbortSignal.timeout(30_000),
  })
  return { http: res.status, raw: await res.text() }
}

const toolResult = (reply: McpReply) => (reply.body as any)?.result
const rpcError = (reply: McpReply) => (reply.body as any)?.error
function toolPayload(reply: McpReply) {
  const text = toolResult(reply)?.content?.[0]?.text
  if (typeof text !== "string") return undefined
  try {
    return JSON.parse(text)
  } catch {
    return text
  }
}

/** T4 — an expired but otherwise real credential. The snapshot taken at the start of the run is
 *  used after its own `exp`; nothing is forged and nothing is written down. Runs LAST so the rest
 *  of the matrix does not sit behind the credential's remaining lifetime. */
async function checkExpiredCredential(snapshotAuth: string, exp: number) {
  const waitMs = (exp + 5) * 1000 - Date.now()
  if (waitMs > 0 && waitMs < 20 * 60_000) {
    console.log(`   …waiting ${Math.ceil(waitMs / 1000)}s for the snapshotted credential to expire (T4)`)
    await new Promise((r) => setTimeout(r, waitMs))
  }
  if (Date.now() / 1000 <= exp) {
    record({ id: "T4", ac: "AC1", title: "过期凭证 → 401", status: "blocked", required: false, criterion: "call after the snapshotted credential's own exp", observed: { expAt: new Date(exp * 1000).toISOString(), waitMs } })
    return
  }
  const expired = await mcp("tools/list", {}, snapshotAuth)
  assertCheck(
    { id: "T4", ac: "AC1", title: "过期凭证 → 401 + challenge(不是 200 + isError)", required: true, criterion: "HTTP 401 ∧ challenge.error === invalid_token, using the same credential after its own exp" },
    expired.http === 401 && expired.challenge?.error === "invalid_token",
    { http: expired.http, challenge: expired.challenge, expAt: new Date(exp * 1000).toISOString(), testedAt: new Date().toISOString() },
  )
}

// ── preflight ────────────────────────────────────────────────────────────────

const build: Record<string, unknown> = {}

function readJwtClaims(token: string) {
  const [h, p] = token.split(".")
  const dec = (s: string) => JSON.parse(Buffer.from(s.replace(/-/g, "+").replace(/_/g, "/"), "base64").toString())
  const header = dec(h!)
  const claims = dec(p!)
  return {
    alg: header.alg,
    kid: header.kid,
    iss: claims.iss,
    aud: claims.aud,
    token_use: claims.token_use,
    purpose: claims.purpose,
    scope: claims.scope,
    iat: claims.iat,
    exp: claims.exp,
    sub: pseudo(claims.sub),
    jti: pseudo(claims.jti),
  }
}

async function main() {
  // P0.1 — build identity. This build embeds no commit, so provenance is recorded, not pinned.
  const asar = path.join(APP, "Contents/Resources/app.asar")
  if (!existsSync(asar)) {
    record({ id: "P0.1", ac: "evidence", title: "packaged app present", status: "blocked", required: true, criterion: `${asar} exists`, observed: { asar } })
    finish(2, PAID ? "paid" : "readonly")
  }
  const sha = createHash("sha256").update(readFileSync(asar)).digest("hex")
  const plist = (key: string) =>
    execFileSync("/usr/libexec/PlistBuddy", ["-c", `Print :${key}`, path.join(APP, "Contents/Info.plist")], { encoding: "utf8" }).trim()
  Object.assign(build, {
    app: APP,
    asarSha256: sha,
    asarBuiltAt: statSync(asar).mtime.toISOString(),
    shortVersion: plist("CFBundleShortVersionString"),
    bundleId: plist("CFBundleIdentifier"),
    userData: USER_DATA,
  })
  record({ id: "P0.1", ac: "evidence", title: "被测构建身份已记录(sha256 + 版本 + 构建时刻)", status: "pass", required: true, criterion: "app.asar sha256 / CFBundleShortVersionString / mtime all readable", observed: build })

  // P0.2 — source commit. Evidence rules ask for it; the artifact does not carry it.
  record({
    id: "P0.2",
    ac: "evidence",
    title: "被测 commit 可从产物机械恢复",
    status: "blocked",
    required: false,
    criterion: "app.asar or Info.plist carries the source commit sha",
    observed: { embeddedCommitMarkers: 0, note: "provenance is inferential only — see README §1" },
    note: "本 build 不含 commit 标记;E7 的做法(干净提交 → ship:mac → 把 sha256 钉进探针)未在本 build 上执行",
  })

  // P0.3 — login identity type.
  const secret = (name: string) => {
    const file = path.join(USER_DATA, "alpha-secrets", name)
    if (!existsSync(file)) return undefined
    const value = readFileSync(file, "utf8").trim()
    registerSecret(value)
    return value
  }
  const cloudToken = secret("ALPHA_CLOUD_TOKEN")
  if (!cloudToken) {
    record({ id: "P0.3", ac: "AC1", title: "登录态凭证在位", status: "blocked", required: true, criterion: "alpha-secrets/ALPHA_CLOUD_TOKEN exists", observed: {} })
    finish(2, PAID ? "paid" : "readonly")
  }
  const claims = readJwtClaims(cloudToken!)
  record({
    id: "P0.3",
    ac: "AC1",
    title: "登录身份类型 = 订阅登录(platform_access JWT),非 Cloud API key",
    status: "pass",
    required: true,
    criterion: "ALPHA_CLOUD_TOKEN decodes to token_use=platform_access with a single purpose",
    observed: { claims, lifetimeSec: claims.exp - claims.iat },
  })

  // P0.4 — the API-key arm of the matrix needs an `sk-alpha-*` key. There is none on this machine.
  const apiKeyLike = ["ALPHA_API_KEY", "ALPHA_CLOUD_API_KEY"]
    .map((n) => ({ name: n, value: secret(n) }))
    .filter((e) => e.value?.startsWith("sk-alpha-"))
  record({
    id: "P0.4",
    ac: "AC3",
    title: "Cloud API key(sk-alpha-*)可用",
    status: apiKeyLike.length > 0 ? "pass" : "blocked",
    required: false,
    criterion: "a secret file holds an sk-alpha-* Cloud API key",
    observed: { found: apiKeyLike.map((e) => e.name), alphaApiKeyIsJwtNotKey: Boolean(secret("ALPHA_API_KEY")?.startsWith("eyJ")) },
    note: "本机 ALPHA_API_KEY 是 purpose=model.invoke 的 platform_access JWT,不是 sk-alpha-* API key",
  })

  // P0.5 — the credential the desktop is SUPPOSED to use for cloud MCP since ADR-009 (2026-08-03).
  const mcpAuthFile = path.join(ENGINE_DATA, "mcp-auth.json")
  const mcpAuth = existsSync(mcpAuthFile) ? JSON.parse(readFileSync(mcpAuthFile, "utf8")) : {}
  const cloudEntry = mcpAuth["cloud"]
  const authorized = Boolean(cloudEntry?.tokens?.accessToken)
  record({
    id: "P0.5",
    ac: "AC3",
    title: "云 MCP 的 OAuth 授权已完成(mcp_access 令牌在位)",
    status: authorized ? "pass" : "blocked",
    required: false,
    criterion: "mcp-auth.json entry `cloud` holds tokens.accessToken",
    observed: {
      file: mcpAuthFile,
      entryPresent: Boolean(cloudEntry),
      fields: cloudEntry ? Object.keys(cloudEntry) : [],
      hasAccessToken: authorized,
      hasRefreshToken: Boolean(cloudEntry?.tokens?.refreshToken),
      scope: cloudEntry?.tokens?.scope,
      mtime: existsSync(mcpAuthFile) ? statSync(mcpAuthFile).mtime.toISOString() : null,
    },
    note: authorized ? undefined : "只有 codeVerifier/oauthState —— 授权流被发起过但从未完成,该 server 处于 needs_auth",
  })

  // P0.6 — the sidecar's live sovereignty facts (readable from its own process env).
  let sidecarEnv: Record<string, string> = {}
  try {
    const pid = execFileSync("/bin/sh", ["-c", `pgrep -f 'utility-sub-type=node.mojom.NodeService' | head -1`], { encoding: "utf8" }).trim()
    if (pid) {
      const dump = execFileSync("/bin/ps", ["eww", pid], { encoding: "utf8" })
      for (const m of dump.matchAll(/\b(ALPHA_[A-Z_]+|OPENCODE_[A-Z_]+)=(\S*)/g)) sidecarEnv[m[1]!] = m[2]!
    }
  } catch {}
  const sovereign = sidecarEnv.ALPHA_LOCAL_WEBSEARCH_DENY === "1" && sidecarEnv.OPENCODE_ENABLE_EXA === "0"
  record({
    id: "P0.6",
    ac: "AC1",
    title: "sidecar 主权事实 = 平台代付(本地 keyless websearch 被压制)",
    status: sovereign ? "pass" : "blocked",
    required: false,
    criterion: "sidecar env has ALPHA_LOCAL_WEBSEARCH_DENY=1 and OPENCODE_ENABLE_EXA=0",
    observed: {
      ALPHA_CLOUD_MCP_URL: sidecarEnv.ALPHA_CLOUD_MCP_URL,
      ALPHA_LOCAL_WEBSEARCH_DENY: sidecarEnv.ALPHA_LOCAL_WEBSEARCH_DENY,
      OPENCODE_ENABLE_EXA: sidecarEnv.OPENCODE_ENABLE_EXA,
      OPENCODE_ENABLE_PARALLEL: sidecarEnv.OPENCODE_ENABLE_PARALLEL,
      note: "`ps eww` 在 macOS 上会截断,未出现的变量名不构成缺席证据",
    },
  })

  // P0.7 — CDP. Its absence is what blocks every engine-side (client) row.
  let cdp = false
  try {
    cdp = (await fetch(`http://127.0.0.1:${CDP_PORT}/json/version`, { signal: AbortSignal.timeout(3000) })).ok
  } catch {}
  record({
    id: "P0.7",
    ac: "AC6",
    title: "CDP 可用(引擎侧观测的唯一通道)",
    status: cdp ? "pass" : "blocked",
    required: false,
    criterion: `http://127.0.0.1:${CDP_PORT}/json/version responds`,
    observed: { port: CDP_PORT, reachable: cdp },
    note: cdp ? undefined : "应用未以 ALPHA_CDP=1 启动 ⇒ 引擎 /mcp 状态、模型工具表、账本差分不可观测",
  })

  const AUTH = `Bearer ${cloudToken}`

  // ── T · transport authentication (AC1) ────────────────────────────────────

  const noAuth = await mcp("tools/list", {})
  const challengeExact =
    noAuth.http === 401 &&
    JSON.stringify(noAuth.challenge ?? {}) === JSON.stringify(CHALLENGE_401)
  const leaksToolName = APPROVED_FIVE.some((n) => noAuth.raw.includes(n))
  assertCheck(
    { id: "T1", ac: "AC1", title: "无 Authorization 的 tools/list → 401 + 完整 challenge,且不泄露任何工具名", required: true, criterion: "HTTP 401 ∧ WWW-Authenticate params === contract §5 401 row ∧ no approved tool name in body" },
    challengeExact && !leaksToolName,
    { http: noAuth.http, challenge: noAuth.challenge, leaksToolName, body: noAuth.body },
  )

  const garbage = await mcp("tools/list", {}, "Bearer not-a-token-at-all")
  assertCheck(
    { id: "T2", ac: "AC1", title: "语法非法的 bearer → 401 + challenge", required: true, criterion: "HTTP 401 ∧ challenge.error === invalid_token" },
    garbage.http === 401 && garbage.challenge?.error === "invalid_token",
    { http: garbage.http, challenge: garbage.challenge },
  )

  // A structurally well-formed JWT whose signature is garbage. Constructed here, never a real
  // credential — it exists only to prove a bad signature is rejected at the transport.
  const forgedClaims = { ...JSON.parse(Buffer.from(cloudToken!.split(".")[1]!.replace(/-/g, "+").replace(/_/g, "/"), "base64").toString()), scope: ["cloud.read", "artifact.read"], purpose: "cloud.read" }
  const b64 = (o: unknown) => Buffer.from(JSON.stringify(o)).toString("base64url")
  const forged = `${b64({ alg: "ES256", kid: "alpha-web-platform-access-2026-07-23" })}.${b64(forgedClaims)}.${"A".repeat(86)}`
  const badSig = await mcp("tools/list", {}, `Bearer ${forged}`)
  assertCheck(
    { id: "T3", ac: "AC1", title: "签名伪造(声称 cloud.read+artifact.read)→ 401,不因 claims 好看而放行", required: true, criterion: "HTTP 401 ∧ challenge.error === invalid_token" },
    badSig.http === 401 && badSig.challenge?.error === "invalid_token",
    { http: badSig.http, challenge: badSig.challenge, forgedPurpose: forgedClaims.purpose },
  )

  // AC3 / paid rows use the OAuth `mcp_access` token the desktop actually presents to /mcp
  // (ADR-009). ALPHA_CLOUD_TOKEN remains the transport/fail-closed control (single purpose).
  const mcpAccess = authorized ? String(cloudEntry.tokens.accessToken) : undefined
  if (mcpAccess) registerSecret(mcpAccess)
  const liveFallback = secret("ALPHA_CLOUD_TOKEN")!
  const live = mcpAccess ?? liveFallback
  const LIVE_AUTH = `Bearer ${live}`
  const liveClaims = readJwtClaims(live)
  const liveCredentialKind = mcpAccess ? "mcp_access" : "ALPHA_CLOUD_TOKEN_fallback"

  // ── T5/T6 · registry surface (AC2 / AC10) ─────────────────────────────────

  const list = await mcp("tools/list", {}, LIVE_AUTH)
  const names: string[] = (toolResult(list)?.tools ?? []).map((t: any) => t.name)
  assertCheck(
    { id: "T5", ac: "AC10", title: "cloud_schedule_* 不出现在 tools/list", required: true, criterion: "no name in tools/list matches cloud_schedule_*" },
    names.length > 0 && !names.some((n) => n.startsWith("cloud_schedule_")),
    { names },
  )
  const missingApproved = APPROVED_FIVE.filter((n) => !names.includes(n))
  const extra = names.filter((n) => !APPROVED_FIVE.includes(n as any))
  assertCheck(
    { id: "T6", ac: "AC2", title: "批准的 5 个工具全部在册", required: true, criterion: "every approved tool name appears in tools/list" },
    missingApproved.length === 0,
    { missingApproved, extraBeyondApprovedFive: extra, total: names.length },
  )
  record({
    id: "T7",
    ac: "AC10",
    title: "工具集合精确等于批准的 5 个",
    status: extra.length === 0 ? "pass" : "fail",
    required: false,
    criterion: "tools/list set === the five approved names",
    observed: { extraBeyondApprovedFive: extra },
    note: extra.length === 0 ? undefined : "本面已由平台按各自裁决增列;#721 的 5 列基线是 2026-07-31 快照,不再等于当前注册权威",
  })

  const batch = await mcpRaw('[{"jsonrpc":"2.0","id":1,"method":"tools/list","params":{}}]', LIVE_AUTH)
  assertCheck(
    { id: "T8", ac: "AC5", title: "JSON-RPC batch → 400 batch_not_supported(不是 200)", required: false, criterion: "HTTP 400 ∧ body.code === batch_not_supported" },
    batch.http === 400 && batch.raw.includes("batch_not_supported"),
    { http: batch.http, body: batch.raw.slice(0, 200) },
  )

  // ── A · per-tool authorization chokepoint (AC2 / AC3) ─────────────────────
  //
  // Schema-invalid arguments on purpose: the authorization decision happens BEFORE the callback,
  // so a 403 proves denial and a 200 + validation error proves the credential was authorized —
  // with zero side effect and zero cost either way.

  const ARGS: Record<string, unknown> = {
    cloud_dispatch: {},
    cloud_status: { job_id: "job_probe_absent" },
    cloud_await: { job_id: "job_probe_absent" },
    cloud_artifacts: { job_id: "job_probe_absent" },
    cloud_cancel: { job_id: "job_probe_absent" },
    cloud_web_search: {},
  }
  const authzOutcome: Record<string, { http: number; scope?: string }> = {}
  for (const tool of names) {
    const reply = await mcp("tools/call", { name: tool, arguments: ARGS[tool] ?? {} }, LIVE_AUTH)
    authzOutcome[tool] = { http: reply.http, scope: reply.challenge?.scope }
    const denied = reply.http === 403
    const expectedScope = REQUIRED_ACTION[tool]
    // A denial must name exactly the tool's own requiredAction; an allow must reach the callback.
    const consistent = denied
      ? reply.challenge?.error === "insufficient_scope" && reply.challenge?.scope === expectedScope
      : reply.http === 200 && toolResult(reply) !== undefined
    record({
      id: `A-${tool}`,
      ac: "AC2",
      title: `${tool}:授权咽喉判决可辨(HTTP ${reply.http}${denied ? `,scope=${reply.challenge?.scope}` : ""})`,
      status: consistent ? "pass" : "fail",
      required: true,
      criterion: denied
        ? `HTTP 403 ∧ error=insufficient_scope ∧ scope === registry requiredAction (${expectedScope})`
        : "HTTP 200 ∧ the callback ran (a result object came back)",
      observed: { http: reply.http, challenge: reply.challenge, registryRequiredAction: expectedScope, payload: toolPayload(reply) },
      note: denied ? "以本机登录凭证(purpose=cloud.dispatch 单值)恒被拒 —— 这是 REQ-129 要消除的结构性 forbidden" : undefined,
    })
  }

  const structurallyForbidden = Object.entries(authzOutcome).filter(([n, o]) => APPROVED_FIVE.includes(n as any) && o.http === 403).map(([n]) => n)
  record({
    id: "A-SUM",
    ac: "AC3",
    title: "订阅登录凭证可调通批准的 5 个工具",
    status: structurallyForbidden.length === 0 ? "pass" : "fail",
    required: true,
    criterion: "none of the five approved tools answers 403 with the desktop's own logged-in credential",
    observed: {
      credentialKind: liveCredentialKind,
      credentialPurpose: liveClaims.purpose,
      credentialScope: liveClaims.scope,
      structurallyForbidden,
      perTool: authzOutcome,
    },
    note: mcpAccess
      ? "LIVE_AUTH = mcp-auth.json cloud.tokens.accessToken (mcp_access; scopes cloud.dispatch/read + artifact.read)."
      : "P0.5 未授权 ⇒ 回落 ALPHA_CLOUD_TOKEN(purpose=cloud.dispatch)。该回落对 read/artifact 工具的 403 是正确 fail-closed,不是 AC3 PASS。",
  })

  // Control: single-purpose fallback must still fail closed on read/artifact tools.
  if (mcpAccess) {
    const fallbackAuth = `Bearer ${liveFallback}`
    const fallbackForbidden: string[] = []
    for (const tool of ["cloud_status", "cloud_await", "cloud_artifacts"] as const) {
      const reply = await mcp("tools/call", { name: tool, arguments: ARGS[tool] ?? {} }, fallbackAuth)
      if (reply.http === 403) fallbackForbidden.push(tool)
    }
    record({
      id: "A-FALLBACK",
      ac: "AC3",
      title: "回落 ALPHA_CLOUD_TOKEN(purpose=cloud.dispatch)对 read/artifact 仍 403(fail-closed)",
      status: fallbackForbidden.length === 3 ? "pass" : "fail",
      required: false,
      criterion: "cloud_status/await/artifacts each HTTP 403 with the dispatch-only secret",
      observed: { fallbackForbidden },
    })
  }

  // ── N · removed tool names (AC10) ─────────────────────────────────────────

  for (const tool of REMOVED_SCHEDULE) {
    const reply = await mcp("tools/call", { name: tool, arguments: {} }, LIVE_AUTH)
    const err = rpcError(reply)
    assertCheck(
      { id: `N-${tool}`, ac: "AC10", title: `${tool}:按未注册工具拒绝且无副作用`, required: true, criterion: "JSON-RPC error -32602 `Tool <name> not found` ∧ no result payload" },
      err?.code === -32602 && String(err?.message ?? "").includes(tool) && toolResult(reply) === undefined,
      { http: reply.http, rpcError: err },
    )
  }
  const unknownNoAuth = await mcp("tools/call", { name: "alpha_probe_unknown_tool", arguments: {} })
  assertCheck(
    { id: "N-ORDER", ac: "AC1", title: "未注册工具 + 无凭证 → 401(认证排在注册表之前)", required: true, criterion: "HTTP 401 ∧ challenge.error === invalid_token" },
    unknownNoAuth.http === 401 && unknownNoAuth.challenge?.error === "invalid_token",
    { http: unknownNoAuth.http, challenge: unknownNoAuth.challenge },
  )
  const unknownAuthed = await mcp("tools/call", { name: "alpha_probe_unknown_tool", arguments: {} }, LIVE_AUTH)
  record({
    id: "N-NOACTION",
    ac: "AC2",
    title: "已认证 + 未注册工具名(无 requiredAction 可解析)→ 403",
    status: unknownAuthed.http === 403 ? "pass" : "fail",
    required: false,
    criterion: "HTTP 403 — #721 2026-07-31 增补:「缺 requiredAction 断言 HTTP 403」",
    observed: { http: unknownAuthed.http, challenge: unknownAuthed.challenge, rpcError: rpcError(unknownAuthed) },
    note:
      unknownAuthed.http === 403
        ? undefined
        : "实测:已认证 + 未注册名走 SDK 的未注册分支(200 + -32602),传输闸不 403。平台契约(public-cloud-mcp.md §3)本就把未注册名定为 -32602,#721 增补那句针对的是**已注册但解析不出 action**的情形 —— 两份文字对同一格给出不同断言。无 handler 执行 ⇒ 不是可达的授权绕过,只是判据措辞需收敛。",
  })

  // ── H · schedule HTTP surface (AC10 addendum: 剔除 MCP 工具后 HTTP 面不回归) ──
  //
  // The automation panel talks to `/v1/cloud/schedules` over HTTP, not MCP. `cloud.read` is what
  // GET wants and this run only holds `cloud.dispatch`, so the positive signal is "403, not 404" —
  // and it is only worth anything next to a control on a route that really does not exist.

  const httpGet = async (p: string, auth?: string) => {
    const res = await fetch(`https://alpha-cloud.tidelabs.click${p}`, {
      headers: auth ? { authorization: auth } : {},
      signal: AbortSignal.timeout(30_000),
    })
    return { http: res.status, body: (await res.text()).slice(0, 200) }
  }
  // Schedule HTTP face accepts platform_access JWTs, not the MCP OAuth access token.
  const sched = await httpGet("/v1/cloud/schedules", `Bearer ${liveFallback}`)
  const control = await httpGet("/v1/cloud/alpha-probe-definitely-not-a-route", `Bearer ${liveFallback}`)
  assertCheck(
    { id: "H1", ac: "AC10", title: "schedule 的 HTTP 面在 MCP 剔除后仍在(403 授权拒绝,不是 404 路由消失)", required: true, criterion: "GET /v1/cloud/schedules → 403 while a bogus sibling route under the same prefix → 404 (using ALPHA_CLOUD_TOKEN)" },
    sched.http === 403 && control.http === 404,
    { schedules: sched, controlRoute: control, auth: "ALPHA_CLOUD_TOKEN" },
  )
  const schedNoAuth = await httpGet("/v1/cloud/schedules")
  record({
    id: "H2",
    ac: "AC5",
    title: "cloud-jobs HTTP 面的拒绝形状(与 MCP 面对照)",
    status: schedNoAuth.http === 401 ? "pass" : "fail",
    required: false,
    criterion: "GET /v1/cloud/schedules without credential → HTTP 401",
    observed: { noAuth: schedNoAuth, mcpFaceEmitsChallenge: true, httpFaceEmitsChallenge: false },
    note: "HTTP 面回裸 {\"error\":\"unauthorized\"} 且不带 WWW-Authenticate;MCP 面带完整 challenge。两面状态码一致、challenge 不一致,如实登记。",
  })

  // ── L · client-side credential hygiene + engine lifecycle (AC9 partial) ───

  const logRoot = path.join(USER_DATA, "logs")
  const credentialShapes = [
    /eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{5,}/g,
    /Bearer\s+[A-Za-z0-9._~+/=-]{12,}/g,
    /\b(?:sk|pk|ak)-[A-Za-z0-9_-]{8,}/g,
  ]
  let scannedFiles = 0
  const hits: string[] = []
  const walk = (dir: string) => {
    for (const entry of require("node:fs").readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name)
      if (entry.isDirectory()) walk(full)
      else if (entry.isFile()) {
        scannedFiles++
        const text = readFileSync(full, "utf8")
        for (const re of credentialShapes) if (re.test(text)) hits.push(path.relative(logRoot, full))
      }
    }
  }
  if (existsSync(logRoot)) walk(logRoot)
  assertCheck(
    { id: "L1", ac: "AC9", title: "桌面端日志不含凭证形状(JWT / Bearer / sk-*)", required: true, criterion: "no credential-shaped string in any file under <userData>/logs" },
    hits.length === 0 && scannedFiles > 0,
    { logRoot, scannedFiles, filesWithHits: [...new Set(hits)] },
  )

  // Engine lifecycle: the secret sync rewrites the purpose-bound tokens and respawns the sidecar.
  // A cloud job outlives that; an in-flight local turn does not (ADR-036 后果, separate defect).
  const serverLogs = existsSync(logRoot)
    ? require("node:fs")
        .readdirSync(logRoot)
        .map((d: string) => path.join(logRoot, d, "server.log"))
        .filter((f: string) => existsSync(f))
    : []
  const newest = serverLogs.sort((a: string, b: string) => statSync(b).mtimeMs - statSync(a).mtimeMs)[0]
  const respawnStamps = newest
    ? [...readFileSync(newest, "utf8").matchAll(/^\[([\d-]+ [\d:.]+)\].*governed catalog location prewarmed/gm)].map((m) => m[1]!)
    : []
  record({
    id: "L2",
    ac: "AC4",
    title: "sidecar 重生节奏(长任务读取的客户端前提)",
    status: respawnStamps.length > 0 ? "pass" : "blocked",
    required: false,
    criterion: "count engine (re)starts in the newest server.log — informational",
    observed: { log: newest ? path.relative(USER_DATA, newest) : null, engineStarts: respawnStamps.length, stamps: respawnStamps },
    note: "每次 alpha-secrets sync(约 10 分钟)重写 purpose-bound 令牌并重生 sidecar;云作业在平台侧不受影响,本地在途回合会被打断(ADR-036 后果,另有窄票)",
  })

  // ── E · items a client structurally cannot produce ────────────────────────

  for (const [id, title, owner] of [
    ["E1", "alpha-cloud → AGENT 的 dispatch/status 不逐字下传调用方 Authorization", "alpha-platform#171 / #54"],
    ["E2", "web search provider 429/timeout/5xx/no-backend:无成功外观、无 settle、余额不减", "alpha-platform#105(AC8)"],
    ["E3", "同一 reservation 的 direct/Queue 结算重放幂等", "alpha-platform#90/#103/#104"],
  ] as const) {
    record({
      id,
      ac: "AC8/AC9",
      title,
      status: "not-producible",
      required: false,
      criterion: "requires observing Worker-internal hops or injecting provider failures",
      observed: { evidenceOwner: owner },
      note: "客户端不在这条链上,任何从桌面端「取证」都只是猜测;判据归平台仓的确定性测试",
    })
  }

  // ── R · real, billed invocations (only with --paid) ───────────────────────

  if (!PAID) {
    for (const id of ["R1", "R2", "R3", "R4"]) {
      record({ id, ac: "AC3/AC4", title: "真实计费调用", status: "blocked", required: false, criterion: "run with --paid", observed: { paid: false } })
    }
    if (SKIP_T4) {
      record({
        id: "T4",
        ac: "AC1",
        title: "过期凭证 → 401",
        status: "blocked",
        required: false,
        criterion: "call after the snapshotted credential's own exp",
        observed: { skipped: true, flag: "--skip-t4" },
      })
    } else {
      await checkExpiredCredential(AUTH, claims.exp)
    }
    finish(checks.some((c) => c.required && c.status !== "pass") ? 1 : 0, "readonly")
  }

  const search = await mcp("tools/call", { name: "cloud_web_search", arguments: { query: "alpha-code REQ-129 cloud mcp verification probe", max_results: 3 } }, LIVE_AUTH)
  const searchPayload = toolPayload(search) as any
  const results = searchPayload?.results
  const resultsText = typeof results === "string" ? results : Array.isArray(results) ? JSON.stringify(results) : ""
  // `results` is whatever the gateway's `webSearch()` produced. A provider failure lands in the
  // SAME slot as a success (alpha-platform D2), so "non-empty" alone is not a success criterion —
  // the known failure signatures have to be excluded explicitly.
  const providerFailureShape = /(search error:|no search backend configured)/i.test(resultsText)
  assertCheck(
    { id: "R1", ac: "AC4", title: "cloud_web_search 真调:返回真实搜索结果", required: true, criterion: "HTTP 200 ∧ isError !== true ∧ payload.results non-empty ∧ does not match a known provider-failure signature" },
    search.http === 200 && toolResult(search)?.isError !== true && resultsText.length > 0 && !providerFailureShape,
    {
      http: search.http,
      isError: toolResult(search)?.isError,
      query: searchPayload?.query,
      resultsType: Array.isArray(results) ? "array" : typeof results,
      resultsLength: resultsText.length,
      providerPrefix: typeof results === "string" ? (results.match(/^\[[a-z]+\]/i)?.[0] ?? null) : null,
      matchedProviderFailureShape: providerFailureShape,
      sample: resultsText.slice(0, 240),
    },
  )
  record({
    id: "R6",
    ac: "AC5",
    title: "cloud_web_search 的成功载荷形状(客户端可分类性)",
    status: typeof results === "string" ? "fail" : "pass",
    required: false,
    criterion: "payload.results is structured (array of result objects), so a client can tell results from an error string",
    observed: { resultsType: Array.isArray(results) ? "array" : typeof results, providerPrefix: typeof results === "string" ? (results.match(/^\[[a-z]+\]/i)?.[0] ?? null) : null },
    note: "实测 results 是一整段带 provider 前缀的**文本**。同一个槽位也是 provider 失败串的落点(平台 D2),客户端因此无法结构化区分「搜到了」与「上游报错」——只能靠字符串特征猜。",
  })

  // Dispatch is retried: a first run of this probe hit a transient `job_ledger_unavailable`, and
  // recording one transient refusal as the tool's verdict would be as wrong as hiding it. Every
  // attempt is kept.
  const attempts: Array<{ attempt: number; http: number; isError: unknown; payload: unknown }> = []
  let jobId: string | undefined
  for (let attempt = 1; attempt <= 3 && !jobId; attempt++) {
    if (attempt > 1) await new Promise((r) => setTimeout(r, 5000))
    const dispatch = await mcp(
      "tools/call",
      {
        name: "cloud_dispatch",
        arguments: {
          schema_version: 1,
          idempotency_key: `req129probe-${Date.now()}-${attempt}`,
          autonomy: "bounded-agent",
          objective: "REQ-129 #721 capability probe — dispatch is cancelled immediately; produce nothing.",
          capabilities: [],
          budget: { max_iter: 1, max_tokens: 1000, max_wall_clock_sec: 10 },
        },
      },
      LIVE_AUTH,
    )
    const payload = toolPayload(dispatch) as any
    attempts.push({ attempt, http: dispatch.http, isError: toolResult(dispatch)?.isError, payload: payload?.job_id ? { ...payload, job_id: pseudo(payload.job_id), urls: "<omitted>" } : payload })
    if (typeof payload?.job_id === "string") jobId = payload.job_id
  }
  assertCheck(
    { id: "R2", ac: "AC3", title: "cloud_dispatch 真调:作业被受理并返回 job_id", required: true, criterion: "HTTP 200 ∧ isError !== true ∧ payload.job_id is a string (≤3 attempts)" },
    Boolean(jobId),
    { attempts, acceptedOnAttempt: jobId ? attempts.length : null },
  )

  if (jobId) {
    // R3 — the same credential that CREATED the job cannot read it back. This is the long-task
    // consequence of the single-purpose bearer, observed on the job this run just dispatched.
    const status = await mcp("tools/call", { name: "cloud_status", arguments: { job_id: jobId } }, LIVE_AUTH)
    record({
      id: "R3",
      ac: "AC3",
      title: "派发者可读回自己刚派出的作业状态",
      status: status.http === 200 ? "pass" : "fail",
      required: true,
      criterion: "cloud_status on the job this run dispatched answers HTTP 200",
      observed: { http: status.http, challenge: status.challenge, jobId: pseudo(jobId) },
      note: status.http === 403 ? "同一凭证派得出、读不回 —— 长任务后续读取在本凭证形态下结构上不可能" : undefined,
    })

    const cancel = await mcp("tools/call", { name: "cloud_cancel", arguments: { job_id: jobId } }, LIVE_AUTH)
    const cancelPayload = toolPayload(cancel) as any
    assertCheck(
      { id: "R4", ac: "AC4", title: "cloud_cancel 收回本次派发(止损,避免探针留下跑着的付费作业)", required: true, criterion: "HTTP 200 ∧ payload carries {job_id, status, accepted}" },
      cancel.http === 200 && cancelPayload && "accepted" in cancelPayload,
      { http: cancel.http, accepted: cancelPayload?.accepted, status: cancelPayload?.status, jobId: pseudo(jobId) },
    )
  }

  record({
    id: "R5",
    ac: "AC4",
    title: "计费前后账本差分(reserve → provider → settle)",
    status: "blocked",
    required: false,
    criterion: "read the account ledger before/after the billed calls",
    observed: { reason: "本机无 purpose=account.read 凭证落盘;账本差分需 E7 runbook / 账户面板人工核对" },
  })

  if (SKIP_T4) {
    record({
      id: "T4",
      ac: "AC1",
      title: "过期凭证 → 401",
      status: "blocked",
      required: false,
      criterion: "call after the snapshotted credential's own exp",
      observed: { skipped: true, flag: "--skip-t4" },
    })
  } else {
    await checkExpiredCredential(AUTH, claims.exp)
  }
  finish(checks.some((c) => c.required && c.status !== "pass") ? 1 : 0, "paid")
}

main().catch((err) => {
  record({ id: "FATAL", ac: "-", title: "probe crashed", status: "fail", required: true, criterion: "probe runs to completion", observed: { error: String(err).slice(0, 500) } })
  finish(1, PAID ? "paid" : "readonly")
})
