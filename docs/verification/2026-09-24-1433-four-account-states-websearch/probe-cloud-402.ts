#!/usr/bin/env bun
// alpha-code#1433 (REQ-1414 VERIFY-1) —— 「登录无额度」那一格:云腿 402 的**实际 wire body**。
//
//   bun docs/verification/2026-09-24-1433-four-account-states-websearch/probe-cloud-402.ts \
//     --code <auth code> --verifier <pkce verifier> --out results/cloud-402.json
//
// 基线 §九 第 5 条:「本轮没有一个零余额真账户,402 的实际 wire body 从未跑过」。本探针补它。
//
// 账号来历:owner 2026-09-24 批准「直接写一行」。alpha-web 生产库里 INSERT 了**两行、零 UPDATE**:
//   users(id='u_00000001433', phone='00000001433', uid='u_0000000c1433')  ← 一眼可辨不是真人
//   oauth_codes(...)  ← 一张 PKCE 授权码,用完即被 consumeAuthCode DELETE 掉
// 账本(alpha-platform account 服务)**一个字节都没写**:租户由 `getTenant` 首次使用时 `seed(id)`
// 自动生出,钱包余额是 `ledger_facts` 的 SUM 折叠 ⇒ 天然为 0。
//
// 凭据卫生:换来的 token 只活在本进程内存,不落盘、不进结果 JSON。结果里只留
// 「拿到了 / 长度 / sub / exp」这类不可用于冒充的元信息,外加 402 的 body 原文。
//
// **判据**:必须是 **402**。401 = 没真正登录成功(凭证面),不许拿它充数 —— 本探针对 401 直接判本格未测。

import { writeFileSync } from "node:fs"

function arg(n: string, d?: string) {
  const i = process.argv.indexOf(`--${n}`)
  return i >= 0 && process.argv[i + 1] && !process.argv[i + 1]!.startsWith("--") ? process.argv[i + 1]! : d
}
const CODE = arg("code")!
const VERIFIER = arg("verifier")!
const OUT = arg("out")
const WEB = arg("web", "https://codepuppy.cn")!
const MCP = arg("mcp", "https://alpha-cloud.tidelabs.click/mcp")!

const out: Record<string, unknown> = { ticket: "alpha-code#1433", at: new Date().toISOString(), web: WEB, mcp: MCP }

// ── 1. PKCE 授权码 → 桌面信封(resource='' ⇒ desktopBundleResponse ⇒ 带 mcp_access_token) ──
const tokenPaths = ["/auth/token", "/api/oauth/token"]
let bundle: any = null
const tokenAttempts: unknown[] = []
for (const p of tokenPaths) {
  const r = await fetch(`${WEB}${p}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      grant_type: "authorization_code",
      code: CODE,
      code_verifier: VERIFIER,
      client_id: "alpha-code",
      redirect_uri: "code-puppy://auth/callback",
      device_label: "ac1433 verification runner",
    }),
  })
  const text = await r.text()
  let json: any = null
  try { json = JSON.parse(text) } catch {}
  tokenAttempts.push({ path: p, status: r.status, bodyHead: json?.mcp_access_token ? "(ok, redacted)" : text.slice(0, 300) })
  if (r.ok && json?.mcp_access_token) { bundle = json; break }
}
out.tokenAttempts = tokenAttempts

if (!bundle) {
  out.verdict = "NOT-MEASURED — token exchange failed; no login-minted mcp_access token"
  if (OUT) writeFileSync(OUT, JSON.stringify(out, null, 2))
  console.log(JSON.stringify(out, null, 2))
  process.exit(1)
}

const token: string = bundle.mcp_access_token
const claims = JSON.parse(Buffer.from(token.split(".")[1]!, "base64url").toString("utf8"))
// 只留不可用于冒充的元信息
out.tokenMeta = { sub: claims.sub, iss: claims.iss, aud: claims.aud, scope: claims.scope, ttlSeconds: claims.exp - claims.iat, len: token.length }
out.scopeGranted = bundle.scope
out.sessionId = bundle.session_id

const mcp = async (body: unknown) => {
  const r = await fetch(MCP, {
    method: "POST",
    headers: { "content-type": "application/json", accept: "application/json, text/event-stream", authorization: `Bearer ${token}` },
    body: JSON.stringify(body),
  })
  const text = await r.text()
  return { status: r.status, contentType: r.headers.get("content-type"), body: text.slice(0, 4000) }
}

// ── 2. 先证明这张 token 真的是通的(否则下面的拒绝分不清是凭证面还是额度面) ──
out.toolsList = await mcp({ jsonrpc: "2.0", id: 1, method: "tools/list", params: {} })

// ── 3. 真调一次云搜索 ──
out.cloudWebSearch = await mcp({
  jsonrpc: "2.0", id: 2, method: "tools/call",
  params: { name: "cloud_web_search", arguments: { query: "alpha-code 1433 zero balance probe" } },
})

// ── 4. 直接打 gateway 的封印付费路由，拿 **HTTP 402 本体**。
//    MCP 那一层看不到 402：cloud-mcp.ts:261 的 `text(body, !r.ok)` 把它转成了
//    MCP 200 + `isError:true`（这正是 AC2 说的那条路）。两层都要入库。
const GATEWAY = arg("gateway", "https://alpha-gateway.tidelabs.click")!
const purposeTokens = (bundle.platform_access_tokens ?? {}) as Record<string, string>
out.platformPurposes = Object.keys(purposeTokens)
const gatewayCalls: unknown[] = []
for (const purpose of ["model.invoke", "cloud.dispatch"]) {
  const t = purposeTokens[purpose]
  if (!t) { gatewayCalls.push({ purpose, skipped: "purpose absent from bundle" }); continue }
  const r = await fetch(`${GATEWAY}/v1/tools/web_search`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${t}` },
    body: JSON.stringify({ query: "alpha-code 1433 zero balance probe" }),
  })
  const text = await r.text()
  gatewayCalls.push({ purpose, status: r.status, contentType: r.headers.get("content-type"), body: text.slice(0, 2000) })
}
out.gatewayWebSearch = gatewayCalls

const s = String(JSON.stringify(out.cloudWebSearch))
const sawWalletCode = /account_wallet_insufficient|account_allowance_exhausted/.test((out.cloudWebSearch as any).body ?? "")
const saw402 = (gatewayCalls as any[]).some((c) => c?.status === 402)
out.verdict =
  (out.toolsList as any).status === 401
    ? "NOT-MEASURED \u2014 401 (credential face); the account never logged in"
    : saw402 && sawWalletCode
      ? "MEASURED \u2014 gateway HTTP 402 + MCP isError with a registered FailureCode"
      : sawWalletCode
        ? "PARTIAL \u2014 MCP isError + stable code observed; gateway HTTP status see gatewayWebSearch"
        : "see body"

if (OUT) writeFileSync(OUT, JSON.stringify(out, null, 2))
console.log(JSON.stringify(out, null, 2))
