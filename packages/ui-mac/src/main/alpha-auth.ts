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
import type { AuthMode, AuthState } from "../preload/types"
import { getLogger } from "./logging"
import { ALPHA_ENDPOINTS, ALPHA_PATHS } from "../shared/alpha-config"

type StoredAuth = {
  mode: AuthMode
  accessToken?: string
  refreshToken?: string
  sessionId?: string
  expiresAt?: number
  account?: { email?: string; plan?: string }
}

type TokenResponse = {
  access_token: string
  refresh_token?: string
  session_id?: string
  expires_in?: number
  email?: string
  plan?: string
}

const CLIENT_ID = "alpha-code"
const REDIRECT_URI = "alpha-code://auth/callback"
const AUTH_FILE = "alpha-auth.json"

// Endpoint defaults live in shared/alpha-config (single source of truth — change a domain THERE,
// not here). This layer only adds the env overrides for dev/staging: ALPHA_WEB_URL = alpha-web
// (C, identity authority — login/token); ALPHA_PLATFORM_URL = alpha-platform (B, model proxy /v1 +
// MCP gateway /mcp).
const webBase = () => (process.env.ALPHA_WEB_URL ?? ALPHA_ENDPOINTS.web).replace(/\/+$/, "")
const platformBase = () => (process.env.ALPHA_PLATFORM_URL ?? ALPHA_ENDPOINTS.platform).replace(/\/+$/, "")

let userDataPath = ""
let getWindow: () => BrowserWindow | null = () => null
let relaunchApp: () => void = () => {}
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
  try {
    const parsed = JSON.parse(readFileSync(authFilePath(), "utf8")) as { v: number; enc?: string; plain?: string }
    let json: string | undefined
    if (parsed.enc && safeStorage.isEncryptionAvailable()) {
      json = safeStorage.decryptString(Buffer.from(parsed.enc, "base64"))
    } else if (parsed.plain) {
      json = parsed.plain
    }
    if (json) {
      const parsed = JSON.parse(json) as StoredAuth
      stored = { ...parsed, mode: parsed.mode ?? "byok" }
    }
  } catch {
    // No stored auth yet — stay logged-out.
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

// Map the current token + mode onto the env vars the sidecar reads. Only SETS (never deletes):
// the sidecar is (re)spawned on a fresh launch whose env starts clean from preferAppEnv(), so
// logged-out / BYOK simply leaves the platform vars unset → provider.alpha + mcp.cloud stay dark.
// DEV_PLATFORM_TOKEN acts as a static platform login. Never clobbers a value the user exported.
export function applyAuthEnv() {
  const devToken = process.env.DEV_PLATFORM_TOKEN
  const loggedInPlatform = deriveState().status === "logged-in" && (stored.mode === "platform" || Boolean(devToken))
  const token = devToken || (loggedInPlatform ? stored.accessToken : undefined)
  const base = platformBase()
  if (!token || !base) return
  if (!process.env.ALPHA_BASE_URL) process.env.ALPHA_BASE_URL = `${base}${ALPHA_PATHS.modelProxy}`
  if (!process.env.ALPHA_API_KEY) process.env.ALPHA_API_KEY = token
  if (!process.env.ALPHA_CLOUD_MCP_URL) process.env.ALPHA_CLOUD_MCP_URL = `${base}${ALPHA_PATHS.mcpGateway}`
  if (!process.env.ALPHA_CLOUD_TOKEN) process.env.ALPHA_CLOUD_TOKEN = token
}

// Called once at startup, AFTER preferAppEnv() and BEFORE the sidecar forks (index.ts), so the
// derived platform env is present in the sidecar's inherited environment.
export function initAuthEnv(dataPath: string) {
  userDataPath = dataPath
  load()
  applyAuthEnv()
}

// Called after the main window exists, so state pushes have a target + login can relaunch.
export function setAuthDeps(deps: { getWindow: () => BrowserWindow | null; relaunch: () => void }) {
  getWindow = deps.getWindow
  relaunchApp = deps.relaunch
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
    void completeAuth(parsed).catch((error) => warn("alpha-auth: callback failed", error))
  } else {
    log("alpha-auth: ignoring non-auth deep link", { path })
  }
  return true
}

async function completeAuth(parsed: URL) {
  const code = parsed.searchParams.get("code")
  const state = parsed.searchParams.get("state")
  const error = parsed.searchParams.get("error")
  if (error) return warn("alpha-auth: provider returned error", { error })
  if (!code || !state) return warn("alpha-auth: callback missing code/state")
  // 内存 pkce 为空(app 被回调冷启动唤醒)时回退读落盘的 pkce。
  const active = pkce ?? loadPkce()
  if (!active || active.state !== state) return warn("alpha-auth: state mismatch — possible CSRF, ignoring")
  const verifier = active.verifier
  clearPkce()

  const tokens = await exchangeCode(code, verifier)
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
    account: { email: tokens.email, plan: tokens.plan },
  }
  persist()
  applyAuthEnv()
  publish()
  log("alpha-auth: login complete", { plan: tokens.plan, mode: stored.mode })
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

export async function logout(): Promise<void> {
  stored = { mode: "byok" }
  // deriveState() also treats DEV_PLATFORM_TOKEN as a static platform login, so while it's set an
  // explicit logout would leave the state pinned to "logged-in" (the user sees nothing happen). Drop
  // it for this session so the logged-out state actually takes effect; it re-applies on next launch.
  delete process.env.DEV_PLATFORM_TOKEN
  try {
    rmSync(authFilePath(), { force: true })
  } catch {}
  persist()
  applyAuthEnv()
  publish()
  log("alpha-auth: logged out")
  // Do NOT relaunch the app here. Logout must only clear identity + push the logged-out state — a full
  // app relaunch (app.relaunch()+exit) closed the whole window (and on ad-hoc-signed builds the relaunch
  // fails outright, so the app just quit). applyAuthEnv() has already dropped the proxy env for FUTURE
  // sidecar forks; the running sidecar keeps its forked proxy env until the next restart, and the
  // logged-out state pushed to the renderer soft-locks the alpha proxy rows so the stale proxy isn't
  // offered. (A clean "drop the proxy immediately without restarting" needs an in-place sidecar respawn
  // + renderer reconnect — tracked as a follow-up; see setAuthMode which still relaunches for switching
  // INTO platform-pays where the sidecar must pick up the proxy env at fork time.)
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
  relaunchApp()
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
  relaunchApp()
}
