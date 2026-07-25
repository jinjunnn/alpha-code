// alpha-code ↔ platform 授权(browser-delegated OAuth/PKCE)。全部落自有 ui-mac 包,零改 opencode
// 源码(ADR-002/005)。当前契约与时序见 docs/contracts/platform-integration.md —— web(alpha-web)是 session
// 唯一权威,app 只持 token,续期/撤销/设备管理都在 web 侧。
//
// 三道接缝:
//   ① 发起   startAuth(): 生成 PKCE(verifier+state) → shell.openExternal(<ALPHA_WEB_URL>/auth/authorize…)
//   ② 回调   handleAuthDeepLink(url): manifest auth callback + code/state → 校验 state → 换 token
//            → safeStorage 加密存(系统钥匙串,不落明文 alpha.env)。
//   ③ 消费   applyAuthEnv(): 据 purpose-keyed token bundle+mode 写 process.env(ALPHA_BASE_URL/ALPHA_API_KEY →
//            alpha-models.ts 的模型代理 provider;ALPHA_CLOUD_MCP_URL/ALPHA_CLOUD_TOKEN →
//            sidecar.ts 的 mcp.cloud)。env 在 sidecar fork 前算一次(server.ts 注释),所以运行时
//            变化通过同 host/port/password 的受控 sidecar respawn 继承。
//
// dev:DEV_PLATFORM_TOKEN 把"已登录 + platform"静态短路,跳过 ①②(doc §A,不等 web)。

import { createHash, randomBytes, randomUUID } from "node:crypto"
import { chmodSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { app, safeStorage, shell, type BrowserWindow } from "electron"
import {
  ContractIncompatibleError,
  decodeTokenClaims,
  requireTokenPurpose,
  type RoutePurpose,
} from "@alpha-code/contracts-consumer"
import type { AuthErrorCode, AuthMode, AuthState } from "../preload/types"
import { getLogger } from "./logging"
import { ALPHA_PATHS, type AlphaEndpoints } from "../shared/alpha-config"
import { deepLinkFor, matchAuthDeepLink } from "../shared/route-manifest"
import { isTokenExpired, shouldRefreshToken } from "./alpha-auth-clock"
import { decodeEndpointDiscovery, resolveEndpoints, setDiscoveredEndpoints } from "./alpha-endpoints"
import { reportContractFailure } from "./alpha-contract-health"
import { parseAccessTokenIdentity } from "./alpha-auth-identity"
import { errorOutcome, markStartupTimeline } from "./startup-timeline"

export { parseAccessTokenIdentity } from "./alpha-auth-identity"

type StoredAuth = {
  mode: AuthMode
  platformAccessTokens?: Partial<Record<RoutePurpose, string>>
  refreshToken?: string
  sessionId?: string
  expiresAt?: number
  /** access token 的签发寿命(ms)——B2 刷新提前量按它算(见 alpha-auth-clock.ts);旧凭证可缺。 */
  lifetimeMs?: number
  account?: { email?: string; plan?: string }
}

export type TokenResponse = {
  platform_access_tokens: Record<RoutePurpose, string>
  refresh_token?: string
  session_id?: string
  expires_in?: number
  email?: string
  plan?: string
  /** ① optional endpoint discovery — alpha-web may tell the app where the gateway/account live, so a
   *  moved backend updates clients without a release (see alpha-endpoints.ts). Producer side optional. */
  endpoints?: { schema_version: 1 } & AlphaEndpoints
}

// #602 M2 / #600 B3:「成功但结果不可用」必须与 refreshed 分开建模 —— 签发端返回 200 却给不出
// 可用有效期时,若当作 refreshed 提交,就会 generation++ → 换血 → expiresAt 仍未知 → 调度器
// 30 秒后再刷 → 再换血,永久重复(与 #601 同类的自激,只是触发源换成无效有效期)。
export type RenewalOutcome = "refreshed" | "still-valid" | "transient-failure" | "invalid-grant" | "unusable-response"
export type RenewalResult = {
  outcome: RenewalOutcome
  generation: number
  expiresAt?: number
  /** #600 M1:`refreshed` 时新 token 是否已被 sidecar 换血采用。false = 平台仍恢复中。 */
  applied?: boolean
}

export type PlatformAccessTokenBundleErrorReason =
  | "missing-bundle"
  | "invalid-bundle"
  | "empty-bundle"
  | "unknown-purpose"
  | "invalid-token"
  | "missing-required-purpose"
  | "purpose-key-mismatch"

export class PlatformAccessTokenBundleError extends Error {
  readonly code = "platform-access-token-bundle-invalid"

  constructor(
    readonly reason: PlatformAccessTokenBundleErrorReason,
    readonly purpose?: RoutePurpose,
  ) {
    super(`Invalid platform_access_tokens bundle: ${reason}${purpose ? ` (${purpose})` : ""}`)
    this.name = "PlatformAccessTokenBundleError"
  }
}

const ROUTE_PURPOSES = [
  "model.invoke",
  "cloud.dispatch",
  "cloud.read",
  "artifact.read",
  "account.read",
] as const satisfies readonly RoutePurpose[]
const AUTH_ENV_PURPOSES = [
  ["model.invoke", "ALPHA_API_KEY"],
  ["cloud.dispatch", "ALPHA_CLOUD_TOKEN"],
] as const satisfies ReadonlyArray<readonly [RoutePurpose, "ALPHA_API_KEY" | "ALPHA_CLOUD_TOKEN"]>

const CLIENT_ID = "alpha-code"
const REDIRECT_URI = deepLinkFor.authCallback()
const AUTH_FILE = "alpha-auth.json"

// Endpoints come from the resolver (alpha-endpoints.ts): env override > userData pin > login discovery
// > shared/alpha-config default. webBase = alpha-web (C, identity/login/token).
// Env overrides ALPHA_WEB_URL / ALPHA_PLATFORM_URL still win.
const webBase = () => resolveEndpoints().web

let userDataPath = ""
let getWindow: () => BrowserWindow | null = () => null
let respawnSidecar: (reason: "structural") => void = () => {}
let onRenewed: (result: RenewalResult) => void | Promise<unknown> = () => {}
let onAuthChanged: () => void = () => {}
let stored: StoredAuth = { mode: "byok" }
let pkce: { verifier: string; state: string } | null = null
let tokenGeneration = 0
// #601:身份代 —— 只有登入/登出推进,token 轮换不算。账户驱动刷新的 401 锁据此解锁,
// 所以「持续 401」不会因为一次普通续期就重新获得驱动 respawn 的资格。
let authIdentityEpoch = 0
// #600 M1:续期提交后、换血落定前(以及换血失败后),sidecar 仍握旧 token 或已不存在 ——
// 平台面必须保持 recovering,绝不能因为 main 手里有了新 token 就先报 ready。
let unappliedRenewalGeneration: number | null = null
/** 等换血落定的上界。超时不取消换血(它自带封顶低频重试),只是不再让调用方(account 401
 *  路径)继续悬着:如实报 applied:false,平台面维持 recovering,直到 latch 真正应用。 */
const ROTATION_WAIT_MS = 10_000

// dev-only 静态短路。R1 Major4:此前任何构建读到 DEV_PLATFORM_TOKEN 都会把一个未知/过期的
// token 标成 ready 并物化给 sidecar —— 登录 shell 里设了这个变量的**生产**构建同样中招。
// 它只是 §A 的开发短路,故只在非 packaged 构建生效;packaged 里当它不存在。
function devPlatformToken(): string | undefined {
  try {
    if (app.isPackaged) return undefined
  } catch {
    return undefined // app 不可用(非 Electron 宿主)时同样保守失效
  }
  return process.env.DEV_PLATFORM_TOKEN
}

function log(message: string, meta?: unknown) {
  try {
    getLogger().log(message, meta)
  } catch {}
}
function warn(message: string, meta?: unknown) {
  try {
    getLogger().warn(message, meta)
  } catch {}
}

function authFilePath() {
  return join(userDataPath, AUTH_FILE)
}

function persist() {
  try {
    // Credentials → owner-only perms (0o600 file, 0o700 dir). Matters most for the no-keychain
    // fallback (plaintext tokens), but apply to both so another local account can't read the file.
    mkdirSync(userDataPath, { recursive: true, mode: 0o700 })
    const json = JSON.stringify(stored)
    if (safeStorage.isEncryptionAvailable()) {
      const enc = safeStorage.encryptString(json).toString("base64")
      writeFileSync(authFilePath(), JSON.stringify({ v: 1, enc }), { encoding: "utf8", mode: 0o600 })
    } else {
      // No OS keychain (e.g. headless Linux): tokens are short-lived; flag the fallback loudly.
      warn("alpha-auth: safeStorage unavailable, persisting auth without encryption")
      writeFileSync(authFilePath(), JSON.stringify({ v: 1, plain: json }), { encoding: "utf8", mode: 0o600 })
    }
    // mode on writeFileSync only applies when CREATING the file — chmod to tighten a pre-existing one.
    chmodSync(authFilePath(), 0o600)
  } catch (error) {
    warn("alpha-auth: persist failed", error)
  }
}

function load() {
  let raw: string
  try {
    raw = readFileSync(authFilePath(), "utf8")
  } catch {
    return // No stored auth yet — stay logged-out.
  }
  // 凭证文件存在但恢复失败必须 loud(B11):曾因 pre-ready 调用 safeStorage 静默失败,
  // 表现为"每次重启都要重新登录"却无任何日志线索(REQ-002 联调实锤,2026-07-03)。
  try {
    const parsed = JSON.parse(raw) as { v: number; enc?: string; plain?: string }
    let json: string | undefined
    if (parsed.enc) {
      if (!safeStorage.isEncryptionAvailable()) {
        warn("alpha-auth: stored credentials present but safeStorage unavailable — staying logged-out")
        return
      }
      json = safeStorage.decryptString(Buffer.from(parsed.enc, "base64"))
    } else if (parsed.plain) {
      json = parsed.plain
    }
    if (json) {
      const parsedAuth = JSON.parse(json) as StoredAuth
      stored = { ...parsedAuth, mode: parsedAuth.mode ?? "byok" }
    }
  } catch (e) {
    warn("alpha-auth: failed to restore stored credentials (corrupt file or keychain change)", e)
  }
}

function deriveState(): AuthState {
  const devToken = Boolean(devPlatformToken())
  const loggedIn = hasRequiredPlatformAccessTokens(stored.platformAccessTokens) || devToken
  // #602 M2:有效期未知/已过期 ⇒ recovering(isTokenExpired 已 fail-closed)。
  // #600 M1:续期后未完成换血同样是 recovering —— sidecar 还握着旧 token。
  // devPlatformToken() 只在非 packaged 构建返回值(见该函数),是没有续期手段的静态短路,
  // 按 fail-closed 会永久停在 recovering(违反 ③′2「fail-closed 必须有有界自证路径」),
  // 故 dev 短路报 ready;生产一律按 expiresAt + 换血结果判定。
  const platformReady =
    devToken || (!isTokenExpired(stored.expiresAt, Date.now()) && unappliedRenewalGeneration === null)
  return {
    status: loggedIn ? "logged-in" : "logged-out",
    mode: stored.mode ?? "byok",
    account: stored.account,
    expiresAt: stored.expiresAt,
    ...(loggedIn ? { platformStatus: platformReady ? ("ready" as const) : ("recovering" as const) } : {}),
  }
}

// Broadcast IDENTITY changes only. doRefresh() calls publish() on every token rotation, but a
// rotation changes only expiresAt — never status/mode/account — so an unguarded broadcast made every
// auth-subscribed renderer surface (sidebar, model picker, model chain) re-fetch the account on every
// refresh. When a downstream endpoint 401s (→ triggers a refresh → publish → refetch → 401 → refresh)
// that closed into a ~50/s refresh/publish storm that flashed the whole UI. Suppress broadcasts whose
// identity signature is unchanged: fresh renderers still get current state via the `auth-get-state`
// invoke inside preload's subscribe(), so no subscriber is starved. expiresAt is intentionally NOT in
// the signature — a bare token rotation must not wake the UI.
let lastPublishedSig: string | undefined
function publish() {
  const win = getWindow()
  if (!win || win.isDestroyed()) return
  const state = deriveState()
  const sig = JSON.stringify({
    status: state.status,
    mode: state.mode,
    email: state.account?.email,
    plan: state.account?.plan,
    platformStatus: state.platformStatus,
  })
  if (sig === lastPublishedSig) return
  lastPublishedSig = sig
  win.webContents.send("auth-state", state)
}

// B11 复扫行16:登录整链失败不再只留日志 —— 推 auth-error 给 renderer(sidebar 订阅 → error toast),
// 用户从浏览器点完授权回到 app 时能看到「为什么没登录上」。main 无 i18n 设施,只送 code,文案在
// renderer 侧按 code 映射。已知边界:深链冷启动时窗口尚未建成 → 事件丢失(与登录成功路径的
// 「冷启动不 respawn」同一边界,ADR-017),用户所见 = 停留在未登录态。
function publishAuthError(code: AuthErrorCode) {
  const win = getWindow()
  if (win && !win.isDestroyed()) win.webContents.send("auth-error", { code })
}

// Map the current token + mode onto the env vars the sidecar reads. URL vars are set-if-unset (honor a
// user/dev export). TOKEN vars (ALPHA_API_KEY / ALPHA_CLOUD_TOKEN) are login-derived and written
// AUTHORITATIVELY (A8): applyAuthEnv also runs before each in-session respawn — which snapshots the
// CURRENT env, not a clean one — so the old set-if-unset left a STALE token after re-login (the proxy
// 401'd until a full quit). On logout the token vars are cleared explicitly + the sidecar respawns
// (see logout). DEV_PLATFORM_TOKEN acts as a static platform login.
export function applyAuthEnv() {
  const devToken = devPlatformToken()
  const loggedInPlatform = deriveState().status === "logged-in" && (stored.mode === "platform" || Boolean(devToken))
  const ep = resolveEndpoints()
  const base = ep.platform
  delete process.env.ALPHA_API_KEY
  delete process.env.ALPHA_CLOUD_TOKEN
  if (!loggedInPlatform || !base) return
  if (!process.env.ALPHA_BASE_URL) process.env.ALPHA_BASE_URL = `${base}${ALPHA_PATHS.modelProxy}`
  // mcp: a discovered/pinned mcp URL wins; else derive from the CLOUD worker base (ADR-016: the MCP
  // facade lives on `alpha-cloud`, NOT the model gateway which 404s /mcp). ep.cloud always resolves
  // (has a default), so this points at alpha-cloud/mcp instead of the old gateway/mcp 404.
  if (!process.env.ALPHA_CLOUD_MCP_URL)
    process.env.ALPHA_CLOUD_MCP_URL = ep.mcp ?? `${ep.cloud ?? base}${ALPHA_PATHS.mcpGateway}`
  // DEV_PLATFORM_TOKEN remains the single-token development fallback and is attempted for both
  // sidecar seams. Each attempt still requires the destination purpose, so a purpose-specific JWT
  // is never silently repurposed. Normal logins source each seam from its keyed bundle entry.
  AUTH_ENV_PURPOSES.forEach(([purpose, env]) => {
    const token = devToken ?? stored.platformAccessTokens?.[purpose]
    if (!token) return
    try {
      requireTokenPurpose(token, purpose)
      process.env[env] = token
    } catch (error) {
      reportContractFailure(error)
    }
  })
}

// Called once at startup, AFTER preferAppEnv() and BEFORE the sidecar forks (index.ts), so the
// derived platform env is present in the sidecar's inherited environment.
export function initAuthEnv(dataPath: string) {
  userDataPath = dataPath
  stored = { mode: "byok" }
  load()
  tokenGeneration++
  unappliedRenewalGeneration = null
  applyAuthEnv()
}

// Called after the main window exists, so state pushes have a target + login can respawn the sidecar.
export function setAuthDeps(deps: {
  getWindow: () => BrowserWindow | null
  respawn: (reason: "structural") => void
  /** #600 M1:返回 Promise 时 refreshTokens 会等它 —— 换血是「恢复了」的真实完成点。 */
  onRenewed?: (result: RenewalResult) => void | Promise<unknown>
  onChanged?: () => void
}) {
  getWindow = deps.getWindow
  respawnSidecar = deps.respawn
  onRenewed = deps.onRenewed ?? (() => {})
  onAuthChanged = deps.onChanged ?? (() => {})
  publish()
}

export function getAuthState(): AuthState {
  return deriveState()
}

export function getTokenGeneration(): number {
  return tokenGeneration
}

/** 外部 auth 身份代:登入/登出才推进(token 轮换不算)。#601 的账户驱动刷新锁据此解锁。 */
export function getAuthIdentityEpoch(): number {
  return authIdentityEpoch
}

export function getAuthRenewalTiming() {
  return {
    active: hasRequiredPlatformAccessTokens(stored.platformAccessTokens) && Boolean(stored.refreshToken),
    expiresAt: stored.expiresAt,
    lifetimeMs: stored.lifetimeMs,
  }
}

// Raw bearer token for direct authed reads (account-server). Mirrors applyAuthEnv's derivation —
// the dev short-circuit wins, else the stored platform access token. MAIN-ONLY: never expose this
// to the renderer; its only callers are main-process clients (alpha-account.ts).
export function getAccessToken(purpose: RoutePurpose): string | undefined {
  const token = devPlatformToken() ?? stored.platformAccessTokens?.[purpose]
  if (!token) return undefined
  try {
    requireTokenPurpose(token, purpose)
    return token
  } catch (error) {
    reportContractFailure(error)
    throw error
  }
}

export function getAccessTokenIdentity(purpose: RoutePurpose) {
  const token = getAccessToken(purpose)
  return token ? parseAccessTokenIdentity(token, purpose) : undefined
}

function base64url(buf: Buffer) {
  return buf.toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "")
}

// PKCE(verifier+state)落盘,使其跨「app 冷启动/重启」存活:授权回调若把 app 从未运行状态
// 唤醒(macOS open-url 冷启动),内存里的 pkce 为空会误判 state mismatch。文件短命、单次、用后即删。
function pkceFilePath() {
  return join(userDataPath, "alpha-pkce.json")
}
function savePkce(p: { verifier: string; state: string }) {
  try {
    mkdirSync(userDataPath, { recursive: true, mode: 0o700 })
    writeFileSync(pkceFilePath(), JSON.stringify(p), { encoding: "utf8", mode: 0o600 })
  } catch (error) {
    warn("alpha-auth: pkce persist failed", error)
  }
}
function loadPkce(): { verifier: string; state: string } | null {
  try {
    const p = JSON.parse(readFileSync(pkceFilePath(), "utf8")) as { verifier?: string; state?: string }
    if (typeof p.verifier === "string" && typeof p.state === "string") return { verifier: p.verifier, state: p.state }
  } catch {}
  return null
}
function clearPkce() {
  pkce = null
  try {
    rmSync(pkceFilePath(), { force: true })
  } catch {}
}

// ① 发起:浏览器代理授权。PKCE(S256) + state,跳到 web 授权页。
export async function startAuth(): Promise<void> {
  const verifier = base64url(randomBytes(32))
  const challenge = base64url(createHash("sha256").update(verifier).digest())
  const state = randomUUID()
  pkce = { verifier, state }
  savePkce(pkce)
  const url = new URL(`${webBase()}${ALPHA_PATHS.authorize}`)
  url.searchParams.set("response_type", "code")
  url.searchParams.set("client_id", CLIENT_ID)
  url.searchParams.set("redirect_uri", REDIRECT_URI)
  url.searchParams.set("code_challenge", challenge)
  url.searchParams.set("code_challenge_method", "S256")
  url.searchParams.set("state", state)
  url.searchParams.set("scope", "openid profile platform")
  log("alpha-auth: opening authorize url", { url: url.origin + url.pathname })
  await shell.openExternal(url.toString())
}

// ② 回调:消费 manifest auth scheme 的任何 deep link(返回 true = 已吞,不转发给 renderer);
// callback endpoint 由 manifest 匹配,其余同 scheme 链接也吞掉(避免误投 renderer)。
export function handleAuthDeepLink(url: string): boolean {
  const matched = matchAuthDeepLink(url)
  if (matched.kind === "outside") return false
  if (matched.kind === "callback") {
    void completeAuth(matched.url).catch((error) => {
      warn("alpha-auth: callback failed", error)
      publishAuthError(reportContractFailure(error) ? "contract_incompatible" : "exchange_failed")
    })
    return true
  }
  log("alpha-auth: ignoring non-auth deep link", { path: matched.path })
  return true
}

async function completeAuth(parsed: URL) {
  const code = parsed.searchParams.get("code")
  const state = parsed.searchParams.get("state")
  const error = parsed.searchParams.get("error")
  if (error) {
    warn("alpha-auth: provider returned error", { error })
    return publishAuthError("provider_error")
  }
  if (!code || !state) {
    warn("alpha-auth: callback missing code/state")
    return publishAuthError("invalid_callback")
  }
  // 内存 pkce 为空(app 被回调冷启动唤醒)时回退读落盘的 pkce。
  const active = pkce ?? loadPkce()
  if (!active || active.state !== state) {
    warn("alpha-auth: state mismatch — possible CSRF, ignoring")
    return publishAuthError("state_mismatch")
  }
  const verifier = active.verifier
  clearPkce()

  const tokens = await exchangeCode(code, verifier)
  // ① Learn gateway/account/cloud locations from alpha-web's current token response so a moved
  // backend can update clients without a desktop release.
  if (tokens.endpoints) setDiscoveredEndpoints(tokens.endpoints)
  stored = {
    // The ALPHA proxy (代理节点) is the recommended path, so login opts into platform-pays BY DEFAULT
    // (ADR-016 product direction). applyAuthEnv() below writes the proxy env for the NEXT sidecar fork,
    // so subsequent launches come up with the proxy live and zero clicks; the CURRENT session activates
    // via enableProxy() (a controlled relaunch). We deliberately do NOT auto-relaunch on login: a
    // deep-link callback can cold-start the app, and ad-hoc-signed builds quit on relaunch (see ADR-017).
    mode: "platform",
    platformAccessTokens: tokens.platform_access_tokens,
    refreshToken: tokens.refresh_token,
    sessionId: tokens.session_id,
    expiresAt: tokens.expires_in ? Date.now() + tokens.expires_in * 1000 : undefined,
    lifetimeMs: tokens.expires_in ? tokens.expires_in * 1000 : undefined,
    account: { email: tokens.email, plan: tokens.plan },
  }
  tokenGeneration++
  authIdentityEpoch++
  // 登录自带 structural respawn(下方),不走续期换血闩;清掉上一身份留下的未应用标记,
  // 否则新身份会挂在旧身份的 recovering 上。
  unappliedRenewalGeneration = null
  persist()
  applyAuthEnv()
  publish()
  onAuthChanged()
  log("alpha-auth: login complete", { plan: tokens.plan, mode: stored.mode })
  // Auto-activate the proxy in THIS session: respawn the sidecar in place (NOT a full app relaunch,
  // ADR-017) so the new fork inherits ALPHA_BASE_URL/ALPHA_API_KEY → provider.alpha appears with no
  // "启用代理" click and no restart. The composition-root callback coalesces a cold-start callback
  // with the first fork generation; a live sidecar takes the structural path below.
  respawnSidecar("structural")
}

async function exchangeCode(code: string, verifier: string): Promise<TokenResponse> {
  const res = await fetch(`${webBase()}${ALPHA_PATHS.token}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      grant_type: "authorization_code",
      client_id: CLIENT_ID,
      code,
      code_verifier: verifier,
      redirect_uri: REDIRECT_URI,
    }),
  })
  if (!res.ok) throw new Error(`token exchange failed: HTTP ${res.status}`)
  return decodeTokenResponse(await res.json())
}

export function decodeTokenResponse(value: unknown): TokenResponse {
  if (!isRecord(value)) throw invalidTokenResponse()
  const response = value
  if (response.platform_access_tokens === undefined) {
    throw new PlatformAccessTokenBundleError("missing-bundle")
  }
  if (!isRecord(response.platform_access_tokens)) {
    throw new PlatformAccessTokenBundleError("invalid-bundle")
  }
  const entries = Object.entries(response.platform_access_tokens).map(([purpose, token]) => {
    if (!isRoutePurpose(purpose)) throw new PlatformAccessTokenBundleError("unknown-purpose")
    if (typeof token !== "string" || !token) throw new PlatformAccessTokenBundleError("invalid-token", purpose)
    return [purpose, token] as const
  })
  if (entries.length === 0) throw new PlatformAccessTokenBundleError("empty-bundle")
  const purposes = new Set(entries.map(([purpose]) => purpose))
  const missing = ROUTE_PURPOSES.find((purpose) => !purposes.has(purpose))
  if (missing) throw new PlatformAccessTokenBundleError("missing-required-purpose", missing)
  const platformAccessTokens: Record<RoutePurpose, string> = {
    "model.invoke": "",
    "cloud.dispatch": "",
    "cloud.read": "",
    "artifact.read": "",
    "account.read": "",
  }
  entries.forEach(([purpose, token]) => {
    // Keep token-schema failures as ContractIncompatibleError. Only a valid token filed under the
    // wrong key becomes the distinct bundle-envelope error, so diagnostics identify the real layer.
    decodeTokenClaims(token)
    try {
      requireTokenPurpose(token, purpose)
    } catch (error) {
      if (error instanceof ContractIncompatibleError && error.failure.reason === "route-purpose-mismatch") {
        throw new PlatformAccessTokenBundleError("purpose-key-mismatch", purpose)
      }
      throw error
    }
    platformAccessTokens[purpose] = token
  })
  if (response.refresh_token !== undefined && typeof response.refresh_token !== "string") throw invalidTokenResponse()
  if (response.session_id !== undefined && typeof response.session_id !== "string") throw invalidTokenResponse()
  if (response.expires_in !== undefined && typeof response.expires_in !== "number") throw invalidTokenResponse()
  // #602 M2:有效期必须是有限正数。0 / 负数 / 非有限值不是可用寿命 —— 一律当「未知」丢弃,
  // 让下游 fail-closed 走 recovering + 续期路径,而不是把一个算不出来的期限当成可用。
  const expiresIn = usableExpiresIn(response.expires_in)
  if (response.email !== undefined && typeof response.email !== "string") throw invalidTokenResponse()
  if (response.plan !== undefined && typeof response.plan !== "string") throw invalidTokenResponse()
  const endpoints = response.endpoints !== undefined ? decodeEndpointDiscovery(response.endpoints) : undefined
  return {
    platform_access_tokens: platformAccessTokens,
    ...(response.refresh_token !== undefined ? { refresh_token: response.refresh_token } : {}),
    ...(response.session_id !== undefined ? { session_id: response.session_id } : {}),
    ...(expiresIn !== undefined ? { expires_in: expiresIn } : {}),
    ...(response.email !== undefined ? { email: response.email } : {}),
    ...(response.plan !== undefined ? { plan: response.plan } : {}),
    ...(endpoints ? { endpoints: { schema_version: 1, ...endpoints } } : {}),
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value)
}

/** 可用的签发寿命(秒):有限正数才算,其余(缺失/0/负/非有限)视为未知 → fail-closed。 */
function usableExpiresIn(value: unknown): number | undefined {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) return undefined
  return value
}

function isRoutePurpose(value: string): value is RoutePurpose {
  return ROUTE_PURPOSES.some((purpose) => purpose === value)
}

function hasRequiredPlatformAccessTokens(
  tokens: Partial<Record<RoutePurpose, string>> | undefined,
): tokens is Record<RoutePurpose, string> {
  return ROUTE_PURPOSES.every((purpose) => typeof tokens?.[purpose] === "string" && tokens[purpose].length > 0)
}

function invalidTokenResponse() {
  return new ContractIncompatibleError({
    surface: "identity",
    received_version: "missing",
    reason: "schema-validation",
  })
}

// ── B2:refresh token 续期 ─────────────────────────────────────────────────────────────────────
// alpha-web grant_type=refresh_token(refresh 每次轮换)。生产 access token TTL = 15min，提前量与
// expiresAt 驱动调度见 alpha-auth-clock.ts / auth-renewal.ts。
// 失败语义(B2「失败降级」):
//   - HTTP 400(invalid_grant:会话 revoked / refresh 已被轮换)→ 凭证死了,降级登出(logout():
//     清 env + 删凭证 + respawn 停代理 + 发布 logged-out,renderer 账户面板即显示重新登录);
//   - 网络/5xx(暂时性)→ 保留现有 token 静默重试下一轮,不打断用户。
// 单飞:并发触发(到期调度 + 401 拦截同时到)只发一次请求。

let refreshing: Promise<RenewalResult> | null = null

/** 尝试续期一次；并发调用合并为同一结果，失败分类不会坍缩成 boolean。 */
export function refreshTokens(): Promise<RenewalResult> {
  if (refreshing) return refreshing
  const started = performance.now()
  markStartupTimeline("main.auth.refresh.start")
  // 提前续期时旧 token 仍经验证且可用，不把平台误降成恢复中；只有已经过期的 token 才
  // fail-closed 呈现 recovering，直到续期成功或 invalid-grant 登出。
  publish()
  const attempt = doRefresh().then(async (outcome): Promise<RenewalResult> => {
    const result: RenewalResult = {
      outcome,
      generation: tokenGeneration,
      ...(stored.expiresAt === undefined ? {} : { expiresAt: stored.expiresAt }),
    }
    if (outcome !== "refreshed") {
      onAuthChanged()
      return result
    }
    // #600 M1:换血才是「平台恢复」的完成点。doRefresh 提交时置了 unappliedRenewalGeneration,
    // 所以此刻发布出去的是 recovering —— ready 只可能在下面换血落定之后发布。
    const applied = await awaitRotation(result)
    if (applied) markTokenGenerationApplied(result.generation)
    // 换血落定后才发布最终平台态:成功 → ready;失败/超时 → 仍 recovering(latch 低频重试中)。
    publish()
    onAuthChanged()
    return { ...result, applied }
  })
  void attempt.then(
    (result) =>
      markStartupTimeline("main.auth.refresh.end", {
        durationMs: performance.now() - started,
        outcome: "ok",
        result: result.outcome,
        generation: result.generation,
      }),
    (error) =>
      markStartupTimeline("main.auth.refresh.end", {
        durationMs: performance.now() - started,
        outcome: errorOutcome(error),
      }),
  )
  refreshing = attempt.finally(() => {
    refreshing = null
  })
  return refreshing
}

/** 等换血落定,但有界(R1 Major5:换血链最坏含 allowlist 8s + stop 6s + ready IPC 60s +
 *  health 20s ≈ 94s,让 account 401 路径悬那么久不可接受)。超时按「尚未应用」如实回报,
 *  换血本身继续跑,应用成功时经 markTokenGenerationApplied 补发 ready。 */
async function awaitRotation(result: RenewalResult): Promise<boolean> {
  let timer: ReturnType<typeof setTimeout> | undefined
  const applied = await Promise.race([
    (async () => {
      try {
        return (await onRenewed(result)) !== false
      } catch (error) {
        warn("alpha-auth: token rotation application failed", error)
        return false
      }
    })(),
    new Promise<boolean>((resolve) => {
      timer = setTimeout(() => {
        warn("alpha-auth: token rotation still pending — reporting the platform as recovering")
        resolve(false)
      }, ROTATION_WAIT_MS)
      timer.unref?.()
    }),
  ])
  clearTimeout(timer)
  return applied
}

/** 换血入口在该 generation 真正被 sidecar 采用时回调(含 latch 的低频重试路径)。
 *  这是「平台恢复中 → ready」的唯一解除点。 */
export function markTokenGenerationApplied(generation: number): void {
  if (unappliedRenewalGeneration === null || generation < unappliedRenewalGeneration) return
  unappliedRenewalGeneration = null
  publish()
}

/** #602 B4:提交/降级之前都必须确认 auth 状态没被 logout / 新账号登录改代。 */
function isStaleRefresh(startedGeneration: number, refreshToken: string): boolean {
  return tokenGeneration !== startedGeneration || stored.refreshToken !== refreshToken
}

async function doRefresh(): Promise<Exclude<RenewalOutcome, "still-valid">> {
  const refreshToken = stored.refreshToken
  if (!refreshToken) {
    publish()
    return "transient-failure"
  }
  // #602 B4:CAS 基线 —— 提交响应前必须确认 auth 状态没被 logout / 新账号登录改代。
  const startedGeneration = tokenGeneration
  let res: Response
  try {
    res = await fetch(`${webBase()}${ALPHA_PATHS.token}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      // #79 Breaking v1: refresh is keyed ONLY by the opaque rotating refresh_token.
      // The issuer rejects any refresh request carrying a `sid` (Object.hasOwn(body,"sid")
      // → invalid_request 400), so we must NOT send it. (Was sending `sid: sessionId`,
      // which 400'd every refresh → forced logout right after a successful login.)
      body: JSON.stringify({
        grant_type: "refresh_token",
        client_id: CLIENT_ID,
        refresh_token: refreshToken,
      }),
      signal: AbortSignal.timeout(10_000),
    })
  } catch (error) {
    warn("alpha-auth: refresh network failure — keeping current tokens", error)
    publish()
    return "transient-failure"
  }
  // R1 Blocker2:CAS 必须先于**任何**提交或降级 —— 成功响应受保护而拒绝响应不受时,
  // 账号 A 的迟到 400/401 会把刚登录的账号 B 直接 logout(清 env、清持久态、structural respawn)。
  if (isStaleRefresh(startedGeneration, refreshToken)) {
    warn("alpha-auth: discarding a refresh response whose auth generation changed mid-flight (logout/login)")
    return "transient-failure"
  }
  if (res.status === 400 || res.status === 401) {
    // invalid_grant:会话已 revoked,或 refresh 已被别处轮换(可能被盗用)。凭证不可恢复 → 降级登出。
    warn("alpha-auth: refresh rejected (session revoked / token rotated elsewhere) — degrading to logged-out")
    await logout()
    return "invalid-grant"
  }
  if (!res.ok) {
    warn(`alpha-auth: refresh failed HTTP ${res.status} — transient, keeping current tokens`)
    publish()
    return "transient-failure"
  }
  let tokens: TokenResponse
  try {
    tokens = decodeTokenResponse(await res.json())
  } catch (error) {
    if (error instanceof PlatformAccessTokenBundleError) {
      warn("alpha-auth: refresh response token bundle invalid — keeping the prior validated bundle", {
        reason: error.reason,
        purpose: error.purpose,
      })
      publishAuthError("exchange_failed")
      publish()
      return "transient-failure"
    }
    if (reportContractFailure(error)) {
      warn("alpha-auth: refresh response contract incompatible — keeping the prior validated token")
      publishAuthError("contract_incompatible")
      publish()
      return "transient-failure"
    }
    warn("alpha-auth: refresh response unparsable — keeping current tokens")
    publish()
    return "transient-failure"
  }
  // #602 B4:decode 期间(await res.json())状态仍可能改代 —— 提交前再 CAS 一次。整份丢弃:
  // 不发现端点、不持久化、不发布、不换血,返回既有的非 refreshed 终态。
  if (isStaleRefresh(startedGeneration, refreshToken)) {
    warn("alpha-auth: discarding a refresh response whose auth generation changed mid-flight (logout/login)")
    return "transient-failure"
  }
  // #602 M2 / R1 Blocker3:有效期不可用的 200 是「成功但结果不可用」,**不得提交** ——
  // 提交就意味着 generation++ → 换血 → expiresAt 仍未知 → 调度器 30 秒后再刷 → 再换血,
  // 永久重复(与 #601 同类的自激)。按既有「保留上一份已验证 bundle」的降级语义处理,
  // 由 unusable-response 让调度器降频续跑(auth-renewal.ts)。
  if (tokens.expires_in === undefined) {
    warn("alpha-auth: refresh response carries no usable expires_in — keeping the prior validated bundle")
    publish()
    return "unusable-response"
  }
  if (tokens.endpoints) setDiscoveredEndpoints(tokens.endpoints)
  stored = {
    ...stored,
    platformAccessTokens: tokens.platform_access_tokens,
    refreshToken: tokens.refresh_token ?? stored.refreshToken,
    sessionId: tokens.session_id ?? stored.sessionId,
    expiresAt: Date.now() + tokens.expires_in * 1000,
    lifetimeMs: tokens.expires_in * 1000,
  }
  tokenGeneration++
  // #600 M1 / R1 Blocker1:ready 不得先于换血发布。置位后 deriveState 判 recovering,
  // 所以下面这次 publish 发出的是「恢复中」;ready 只可能由 markTokenGenerationApplied
  // 或 refreshTokens 在换血落定后发出。
  unappliedRenewalGeneration = tokenGeneration
  persist()
  applyAuthEnv()
  publish()
  log("alpha-auth: tokens refreshed", { expiresAt: stored.expiresAt })
  return "refreshed"
}

/** 到点才真的刷(提前量内)；给启动宽限与 expiresAt 调度使用。 */
export async function ensureFreshToken(): Promise<RenewalResult> {
  const started = performance.now()
  markStartupTimeline("main.auth.ensure.start")
  if (!hasRequiredPlatformAccessTokens(stored.platformAccessTokens) || !stored.refreshToken) {
    markStartupTimeline("main.auth.ensure.end", {
      durationMs: performance.now() - started,
      outcome: "skipped:no-credentials",
    })
    return {
      outcome: "still-valid",
      generation: tokenGeneration,
      ...(stored.expiresAt === undefined ? {} : { expiresAt: stored.expiresAt }),
    }
  }
  if (!shouldRefreshToken(stored.expiresAt, stored.lifetimeMs, Date.now())) {
    markStartupTimeline("main.auth.ensure.end", {
      durationMs: performance.now() - started,
      outcome: "skipped:not-due",
    })
    return {
      outcome: "still-valid",
      generation: tokenGeneration,
      ...(stored.expiresAt === undefined ? {} : { expiresAt: stored.expiresAt }),
    }
  }
  try {
    const result = await refreshTokens()
    markStartupTimeline("main.auth.ensure.end", {
      durationMs: performance.now() - started,
      outcome: "ok",
      result: result.outcome,
      generation: result.generation,
    })
    return result
  } catch (error) {
    markStartupTimeline("main.auth.ensure.end", {
      durationMs: performance.now() - started,
      outcome: errorOutcome(error),
    })
    throw error
  }
}

/** 存储的 access token 已过期(启动路径据此进入有界续期宽限，而非无界阻塞 fork)。 */
export function isStoredTokenExpired(): boolean {
  return hasRequiredPlatformAccessTokens(stored.platformAccessTokens) && isTokenExpired(stored.expiresAt, Date.now())
}

export async function logout(): Promise<void> {
  stored = { mode: "byok" }
  tokenGeneration++
  authIdentityEpoch++
  unappliedRenewalGeneration = null
  // deriveState() also treats DEV_PLATFORM_TOKEN as a static platform login, so while it's set an
  // explicit logout would leave the state pinned to "logged-in" (the user sees nothing happen). Drop
  // it for this session so the logged-out state actually takes effect; it re-applies on next launch.
  delete process.env.DEV_PLATFORM_TOKEN
  // A8: explicitly drop the platform proxy credentials from THIS process's env (applyAuthEnv early-
  // returns when logged out, so it can't clear them, and set-if-unset never did). Otherwise the live
  // sidecar kept billing on the old token and a later login could bleed the prior identity.
  delete process.env.ALPHA_API_KEY
  delete process.env.ALPHA_CLOUD_TOKEN
  try {
    rmSync(authFilePath(), { force: true })
  } catch {}
  persist()
  applyAuthEnv()
  publish()
  onAuthChanged()
  log("alpha-auth: logged out")
  // Re-fork the running sidecar IN PLACE so the proxy stops immediately. respawnSidecar is NOT
  // app.relaunch() (which closed the window / quit on ad-hoc-signed builds — the reason a full relaunch
  // was ruled out); it re-forks on the same host/port + reloads the renderer, so the new fork inherits
  // the now-cleared env → provider.alpha goes dark this session, not just on the next launch.
  respawnSidecar("structural")
}

// Switch BYOK ↔ platform-pays. The sidecar reads proxy env at fork time, so this uses the structural
// in-place respawn below; structural changes intentionally retain the historical renderer reload.
export async function setAuthMode(mode: AuthMode): Promise<void> {
  if (mode !== "byok" && mode !== "platform") return
  if (stored.mode === mode) return
  stored.mode = mode
  persist()
  applyAuthEnv()
  publish()
  onAuthChanged()
  log("alpha-auth: mode changed", { mode })
  respawnSidecar("structural")
}

// One-click "activate the ALPHA proxy in THIS running session". Login already defaults mode → platform
// and applyAuthEnv() wrote the proxy env, but the sidecar that's currently running forked BEFORE that,
// so provider.alpha only appears after a fresh fork. Force mode=platform (covers a pre-fix stored
// "byok") and respawn so the new sidecar inherits ALPHA_BASE_URL/ALPHA_API_KEY. Later launches pick it
// up automatically (initAuthEnv runs before the fork), so this is a one-time step after the first login.
export function enableProxy() {
  if (stored.mode !== "platform") {
    stored.mode = "platform"
    persist()
  }
  applyAuthEnv()
  onAuthChanged()
  respawnSidecar("structural")
}
