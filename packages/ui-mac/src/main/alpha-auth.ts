// alpha-code ↔ platform 授权(browser-delegated OAuth/PKCE)。全部落自有 ui-mac 包,零改 opencode
// 源码(ADR-002/005)。设计与时序见 docs/platform-integration.md §C —— web(alpha-web)是 session
// 唯一权威,app 只持 token,续期/撤销/设备管理都在 web 侧。
//
// 三道接缝:
//   ① 发起   startAuth(): 生成 PKCE(verifier+state) → shell.openExternal(<ALPHA_WEB_URL>/auth/authorize…)
//   ② 回调   handleAuthDeepLink(url): alpha-code://auth/callback?code&state → 校验 state → 换 token
//            → safeStorage 加密存(系统钥匙串,不落明文 alpha.env)。
//   ③ 消费   applyAuthEnv(): 据 token+mode 写 process.env(ALPHA_BASE_URL/ALPHA_API_KEY →
//            alpha-models.ts 的模型代理 provider;ALPHA_CLOUD_MCP_URL/ALPHA_CLOUD_TOKEN →
//            sidecar.ts 的 mcp.cloud)。env 在 sidecar fork 前算一次(server.ts 注释),所以运行时
//            切 platform-pays 需 relaunch 让新 sidecar 继承(MVP);prod 改 sidecar runtime 转发。
//
// dev:DEV_PLATFORM_TOKEN 把"已登录 + platform"静态短路,跳过 ①②(doc §A,不等 web)。

import { createHash, randomBytes, randomUUID } from "node:crypto"
import { chmodSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { safeStorage, shell, type BrowserWindow } from "electron"
import type { AuthErrorCode, AuthMode, AuthState } from "../preload/types"
import { getLogger } from "./logging"
import { ALPHA_PATHS } from "../shared/alpha-config"
import { isTokenExpired, shouldRefreshToken } from "./alpha-auth-clock"
import { resolveEndpoints, setDiscoveredEndpoints } from "./alpha-endpoints"

type StoredAuth = {
  mode: AuthMode
  accessToken?: string
  refreshToken?: string
  sessionId?: string
  expiresAt?: number
  /** access token 的签发寿命(ms)——B2 刷新提前量按它算(见 alpha-auth-clock.ts);旧凭证可缺。 */
  lifetimeMs?: number
  account?: { email?: string; plan?: string }
}

type TokenResponse = {
  access_token: string
  refresh_token?: string
  session_id?: string
  expires_in?: number
  email?: string
  plan?: string
  /** ① optional endpoint discovery — alpha-web may tell the app where the gateway/account live, so a
   *  moved backend updates clients without a release (see alpha-endpoints.ts). Producer side optional. */
  endpoints?: { web?: string; platform?: string; account?: string; cloud?: string; mcp?: string }
}

const CLIENT_ID = "alpha-code"
const REDIRECT_URI = "alpha-code://auth/callback"
const AUTH_FILE = "alpha-auth.json"

// Endpoints come from the resolver (alpha-endpoints.ts): env override > userData pin > login discovery
// > shared/alpha-config default. webBase = alpha-web (C, identity/login/token); platformBase =
// alpha-platform (B, model proxy /v1). Env overrides ALPHA_WEB_URL / ALPHA_PLATFORM_URL still win.
const webBase = () => resolveEndpoints().web
const platformBase = () => resolveEndpoints().platform

let userDataPath = ""
let getWindow: () => BrowserWindow | null = () => null
let respawnSidecar: () => void = () => {}
let stored: StoredAuth = { mode: "byok" }
let pkce: { verifier: string; state: string } | null = null

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
  const loggedIn = Boolean(stored.accessToken) || Boolean(process.env.DEV_PLATFORM_TOKEN)
  return {
    status: loggedIn ? "logged-in" : "logged-out",
    mode: stored.mode ?? "byok",
    account: stored.account,
    expiresAt: stored.expiresAt,
  }
}

function publish() {
  const win = getWindow()
  if (win && !win.isDestroyed()) win.webContents.send("auth-state", deriveState())
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
  const devToken = process.env.DEV_PLATFORM_TOKEN
  const loggedInPlatform = deriveState().status === "logged-in" && (stored.mode === "platform" || Boolean(devToken))
  const token = devToken || (loggedInPlatform ? stored.accessToken : undefined)
  const ep = resolveEndpoints()
  const base = ep.platform
  if (!token || !base) return
  if (!process.env.ALPHA_BASE_URL) process.env.ALPHA_BASE_URL = `${base}${ALPHA_PATHS.modelProxy}`
  // mcp: a discovered/pinned mcp URL wins; else derive from the CLOUD worker base (ADR-016: the MCP
  // facade lives on `alpha-cloud`, NOT the model gateway which 404s /mcp). ep.cloud always resolves
  // (has a default), so this points at alpha-cloud/mcp instead of the old gateway/mcp 404.
  if (!process.env.ALPHA_CLOUD_MCP_URL) process.env.ALPHA_CLOUD_MCP_URL = ep.mcp ?? `${ep.cloud ?? base}${ALPHA_PATHS.mcpGateway}`
  // Authoritative: the CURRENT login token always wins (fixes the stale-token-after-re-login bug).
  process.env.ALPHA_API_KEY = token
  process.env.ALPHA_CLOUD_TOKEN = token
}

// Called once at startup, AFTER preferAppEnv() and BEFORE the sidecar forks (index.ts), so the
// derived platform env is present in the sidecar's inherited environment.
export function initAuthEnv(dataPath: string) {
  userDataPath = dataPath
  load()
  applyAuthEnv()
}

// Called after the main window exists, so state pushes have a target + login can relaunch.
export function setAuthDeps(deps: { getWindow: () => BrowserWindow | null; respawn: () => void }) {
  getWindow = deps.getWindow
  respawnSidecar = deps.respawn
  publish()
}

export function getAuthState(): AuthState {
  return deriveState()
}

// Raw bearer token for direct authed reads (account-server). Mirrors applyAuthEnv's derivation —
// the dev short-circuit wins, else the stored platform access token. MAIN-ONLY: never expose this
// to the renderer; its only callers are main-process clients (alpha-account.ts).
export function getAccessToken(): string | undefined {
  return process.env.DEV_PLATFORM_TOKEN || stored.accessToken
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

// ② 回调:消费任何 alpha-code:// deep link(返回 true = 已吞,不转发给 renderer);只处理
// auth/callback。其余 alpha-code:// 也吞掉(避免误投 renderer)。
export function handleAuthDeepLink(url: string): boolean {
  let parsed: URL
  try {
    parsed = new URL(url)
  } catch {
    return false
  }
  if (parsed.protocol !== "alpha-code:") return false
  const path = `${parsed.host}${parsed.pathname}`.replace(/\/+$/, "").replace(/^\/+/, "")
  if (path === "auth/callback") {
    void completeAuth(parsed).catch((error) => {
      warn("alpha-auth: callback failed", error)
      publishAuthError("exchange_failed")
    })
  } else {
    log("alpha-auth: ignoring non-auth deep link", { path })
  }
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
  // ① learn where the platform's gateway/account live from the token response, so a moved backend
  // updates clients without a release. No-op until alpha-web adds the `endpoints` field.
  setDiscoveredEndpoints(tokens.endpoints)
  stored = {
    // The ALPHA proxy (代理节点) is the recommended path, so login opts into platform-pays BY DEFAULT
    // (ADR-016 product direction). applyAuthEnv() below writes the proxy env for the NEXT sidecar fork,
    // so subsequent launches come up with the proxy live and zero clicks; the CURRENT session activates
    // via enableProxy() (a controlled relaunch). We deliberately do NOT auto-relaunch on login: a
    // deep-link callback can cold-start the app, and ad-hoc-signed builds quit on relaunch (see ADR-017).
    mode: "platform",
    accessToken: tokens.access_token,
    refreshToken: tokens.refresh_token,
    sessionId: tokens.session_id,
    expiresAt: tokens.expires_in ? Date.now() + tokens.expires_in * 1000 : undefined,
    lifetimeMs: tokens.expires_in ? tokens.expires_in * 1000 : undefined,
    account: { email: tokens.email, plan: tokens.plan },
  }
  persist()
  applyAuthEnv()
  publish()
  log("alpha-auth: login complete", { plan: tokens.plan, mode: stored.mode })
  // Auto-activate the proxy in THIS session: respawn the sidecar in place (NOT a full app relaunch,
  // ADR-017) so the new fork inherits ALPHA_BASE_URL/ALPHA_API_KEY → provider.alpha appears with no
  // "启用代理" click and no restart. Guarded on a live window (no-op on cold-start; the next normal
  // launch already comes up with the proxy env applied by initAuthEnv).
  respawnSidecar()
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
  return (await res.json()) as TokenResponse
}

// ── B2:refresh token 续期 ─────────────────────────────────────────────────────────────────────
// alpha-web grant_type=refresh_token(需 sid + refresh_token;refresh 每次轮换)。桌面 token 寿命
// 7*24h(用户 2026-07-03 拍板;web 侧 env 可调短供测试),提前量见 alpha-auth-clock.ts。
// 失败语义(B2「失败降级」):
//   - HTTP 400(invalid_grant:会话 revoked / refresh 已被轮换)→ 凭证死了,降级登出(logout():
//     清 env + 删凭证 + respawn 停代理 + 发布 logged-out,renderer 账户面板即显示重新登录);
//   - 网络/5xx(暂时性)→ 保留现有 token 静默重试下一轮,不打断用户。
// 单飞:并发触发(整点 tick + 401 拦截同时到)只发一次请求。

let refreshing: Promise<boolean> | null = null

/** 尝试续期一次;true = access token 已更新。并发调用合并为同一在途请求。 */
export function refreshTokens(): Promise<boolean> {
  if (refreshing) return refreshing
  refreshing = doRefresh().finally(() => {
    refreshing = null
  })
  return refreshing
}

async function doRefresh(): Promise<boolean> {
  const { refreshToken, sessionId } = stored
  if (!refreshToken || !sessionId) return false
  let res: Response
  try {
    res = await fetch(`${webBase()}${ALPHA_PATHS.token}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        grant_type: "refresh_token",
        client_id: CLIENT_ID,
        refresh_token: refreshToken,
        sid: sessionId,
      }),
      signal: AbortSignal.timeout(10_000),
    })
  } catch (error) {
    warn("alpha-auth: refresh network failure — keeping current tokens", error)
    return false
  }
  if (res.status === 400 || res.status === 401) {
    // invalid_grant:会话已 revoked,或 refresh 已被别处轮换(可能被盗用)。凭证不可恢复 → 降级登出。
    warn("alpha-auth: refresh rejected (session revoked / token rotated elsewhere) — degrading to logged-out")
    await logout()
    return false
  }
  if (!res.ok) {
    warn(`alpha-auth: refresh failed HTTP ${res.status} — transient, keeping current tokens`)
    return false
  }
  let tokens: TokenResponse
  try {
    tokens = (await res.json()) as TokenResponse
  } catch {
    warn("alpha-auth: refresh response unparsable — keeping current tokens")
    return false
  }
  setDiscoveredEndpoints(tokens.endpoints)
  stored = {
    ...stored,
    accessToken: tokens.access_token,
    refreshToken: tokens.refresh_token ?? stored.refreshToken,
    sessionId: tokens.session_id ?? stored.sessionId,
    expiresAt: tokens.expires_in ? Date.now() + tokens.expires_in * 1000 : stored.expiresAt,
    lifetimeMs: tokens.expires_in ? tokens.expires_in * 1000 : stored.lifetimeMs,
  }
  persist()
  applyAuthEnv()
  publish()
  log("alpha-auth: tokens refreshed", { expiresAt: stored.expiresAt })
  return true
}

/** 到点才真的刷(提前量内);给启动路径和整点 tick 用。fork 前若已过期必须 await(死 token fork 无意义)。 */
export async function ensureFreshToken(): Promise<void> {
  if (!stored.accessToken || !stored.refreshToken) return
  if (!shouldRefreshToken(stored.expiresAt, stored.lifetimeMs, Date.now())) return
  await refreshTokens()
}

/** 存储的 access token 已过期(启动路径据此决定 fork 前是否 await 续期)。 */
export function isStoredTokenExpired(): boolean {
  return Boolean(stored.accessToken) && isTokenExpired(stored.expiresAt, Date.now())
}

export async function logout(): Promise<void> {
  stored = { mode: "byok" }
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
  log("alpha-auth: logged out")
  // Re-fork the running sidecar IN PLACE so the proxy stops immediately. respawnSidecar is NOT
  // app.relaunch() (which closed the window / quit on ad-hoc-signed builds — the reason a full relaunch
  // was ruled out); it re-forks on the same host/port + reloads the renderer, so the new fork inherits
  // the now-cleared env → provider.alpha goes dark this session, not just on the next launch.
  respawnSidecar()
}

// Switch BYOK ↔ platform-pays. platform-pays only takes effect after a relaunch (the sidecar reads
// the proxy env at fork time) — MVP "respawn sidecar" via a full relaunch.
export async function setAuthMode(mode: AuthMode): Promise<void> {
  if (mode !== "byok" && mode !== "platform") return
  if (stored.mode === mode) return
  stored.mode = mode
  persist()
  applyAuthEnv()
  publish()
  log("alpha-auth: mode changed", { mode })
  respawnSidecar()
}

// One-click "activate the ALPHA proxy in THIS running session". Login already defaults mode → platform
// and applyAuthEnv() wrote the proxy env, but the sidecar that's currently running forked BEFORE that,
// so provider.alpha only appears after a fresh fork. Force mode=platform (covers a pre-fix stored
// "byok") and relaunch so the new sidecar inherits ALPHA_BASE_URL/ALPHA_API_KEY. Later launches pick it
// up automatically (initAuthEnv runs before the fork), so this is a one-time step after the first login.
export function enableProxy() {
  if (stored.mode !== "platform") {
    stored.mode = "platform"
    persist()
  }
  applyAuthEnv()
  respawnSidecar()
}
