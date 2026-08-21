# #1043 — 本机装机版带上 #1045 后的云 MCP OAuth 实测

> 结论先说:**#1045 在打包端端到端验证通过** —— 一次真实的 token 刷新落在 OAuth 飞行窗口内,
> 主进程推迟了换血(连续 4 次),`authenticate` 活满 302 s 而不是被杀在第 97 s;标记清除后
> 第一次重试即正常轮换。
> 但**云 MCP OAuth 仍然拿不到 tokens** —— 因为一个**与 #1044/#1045 无关的、新发现的**阻断:
> 打包应用把云 MCP 的授权端点解析成了 `https://localhost:3000/authorize`,
> 那个地址本机没有任何东西在监听,所以授权页永远打不开,`waitForCallback` 300s 后超时。
>
> `mcp-auth.json` 的 `cloud` 因此仍然只有 `codeVerifier` / `oauthState`,**没有 `tokens`**。
> ⇒ #721 矩阵的 AC3 与计费半场**本轮无法推进**(它们的前置就是拿到 `mcp_access`)。

## 1. 被测产物(重打包后一切结论只对这份产物成立)

| 项 | 值 |
| --- | --- |
| 源 commit | `8645e2650`(`[#1044][CODE] defer token-only sidecar respawn while cloud MCP OAuth waits (#1045)`) |
| worktree | `.worktrees/ac-1043`,工作树干净(见 §6 的一条纪律) |
| 构建命令 | `OPENCODE_CHANNEL=prod bun run ship:mac`(exit 0) |
| 渠道 / appId | `prod` / `com.tide.alphacode` |
| `app.asar` mtime | 2026-08-20 21:24 |
| `sha256(app.asar)` 短指纹 | `76444c455bf2b0c0` |
| userData | `~/Library/Application Support/ai.opencode.desktop` |

**#1045 确实在这份产物里**(对 `app.asar` 直接字节扫描,不是看源码):

```
grep -a -c "cloud-mcp-oauth-inflight"      app.asar → 2   # 引擎写标记 + main 读标记
grep -a -c "deferring token-only respawn"  app.asar → 1   # main 侧 gate 的日志行
```

### ⚠️ 渠道纪律:默认 `bun run ship:mac` 会把 prod 装机版换成 dev 版

第一次 ship 没带 `OPENCODE_CHANNEL`,`install-local.ts` 的 `channel` 回落 `dev`
(`packages/ui-mac/scripts/install-local.ts`),而 dev 与 prod 的 `productName` **都是**
`alpha-code` ⇒ 两者装到**同一个** `/Applications/alpha-code.app`,但 userData 分别是
`ai.opencode.desktop.dev` 与 `ai.opencode.desktop`。

后果:装完之后应用显示**未登录**(dev userData 里没有凭证),云 MCP 因此**根本不注册**
(`opencode.jsonc` 无 `mcp` 段)——看起来像"OAuth 坏了",其实是装错了渠道。
已按 [[ADR-012]]「发布走 prod」重装。**本机验证一律带 `OPENCODE_CHANNEL=prod`。**

## 2. 前置状态(重装 prod 后,全部经 CDP 从真实运行时读)

| 检查 | 结果 |
| --- | --- |
| `window.api.auth.getState()` | `{status:"logged-in", mode:"platform", platformStatus:"ready"}` |
| 引擎 `GET /mcp` | `alpha-word/excel/powerpoint/pdf` = `connected`,**`cloud` = `needs_auth`** |
| 引擎 `GET /config` 的 `mcp.cloud` | `{"type":"remote","url":"https://alpha-cloud.tidelabs.click/mcp","enabled":true,"oauth":{"clientId":"https://auth.tidelabs.click/oauth/clients/alpha-code-mcp.json","redirectUri":"http://127.0.0.1:19876/callback"}}` |
| sidecar env `ALPHA_CLOUD_MCP_DEF` | 与上表逐字一致 |

⇒ **注入面完全正确**:URL、CIMD `clientId`、回环 `redirectUri` 三者都是对的。

## 3. #1045 的验证:两半都成立

触发用的是引擎自己的生产入口 `POST /mcp/cloud/auth/authenticate`
(与扩展中心 `needs_auth` 按钮 `use-extensions.ts:755` 调的是同一个端点)。

### 3.1 引擎侧:标记按生命周期写入并清除(打包端实测 ×3)

| 轮次 | 标记写入 | 标记清除 | 清除原因 |
| --- | --- | --- | --- |
| 21:26:32 触发 | 21:26:34 `{"mcpName":"cloud","startedAt":1787275594423}` | 21:31:34 | `waitForCallback` 300s 超时(`Effect.ensuring(clearInflight)`) |
| 21:37:10 触发 | 21:37:12 | 21:42:12 | 同上 |
| 21:44:34 触发 | 21:44:36 `{"mcpName":"cloud","startedAt":1787276676751}` | — | 见 §3.2 |

标记路径 = `~/.local/share/opencode/cloud-mcp-oauth-inflight.json`(`engineDataDir`),
权限 `0600`,内容形状与 `cloud-mcp-oauth-gate.ts` 的读侧断言一致。
**这一半此前从未在打包端验证过**;现在有了。

### 3.2 主进程侧:token-only 换血在标记存在时被推迟 —— **打包端实测通过**

这是 #1044 那条回归的正面对照。第 3 轮(21:44:34 触发)刻意排在一次 token 刷新之前,
使 OAuth 的 300s 飞行窗口与 `alpha-auth` 的 ~10 分钟刷新重叠:

```
21:44:34   触发 POST /mcp/cloud/auth/authenticate
21:44:36   引擎写 inflight 标记
21:46:11.815  alpha-auth: tokens refreshed { expiresAt: 1787277671812 }
21:46:11.817  #1044 deferring token-only respawn: cloud MCP OAuth in flight   ← 推迟,不杀 sidecar
21:47:11.820  #1044 deferring token-only respawn: cloud MCP OAuth in flight   ← latch 每 60s 重试
21:48:11.822  #1044 deferring token-only respawn: cloud MCP OAuth in flight
21:49:11.825  #1044 deferring token-only respawn: cloud MCP OAuth in flight
~21:49:36     OAuth 自身 300s 超时 → Effect.ensuring 清除标记
21:50:11.827  respawning sidecar { reason: 'token-only' }                     ← 标记一没,换血立刻恢复
21:50:13.593  sidecar token rotated without renderer reload
```

两条判据都成立:

1. **飞行期间 sidecar 没有被杀。** `authenticate` 调用活到 **302 s** 才因自身回调超时结束
   (21:44:34 → 21:49:36)。#1045 之前,它会在 21:46:11 那次换血中被中断在第 ~97 s ——
   那正是 `mcp-auth.json` 永远拿不到 `tokens` 的机制。
2. **推迟是有界的,不会冻住凭证轮换。** 标记清除后的**第一次** latch 重试(21:50:11)就正常
   换血成功。`CLOUD_MCP_OAUTH_INFLIGHT_MAX_AGE_MS`(15 min)这条兜底本轮没被用到 ——
   标记先被正常清除了。

### 3.3 顺带证实:没有误推迟

21:26:11 发生过一次 `respawning sidecar { reason: 'token-only' }`,当时**没有** OAuth 在飞,
换血照常执行(`sidecar token rotated without renderer reload`)。#1045 的 gate 不会把
正常的凭证轮换也一起卡住。

## 4. 真正的阻断:授权端点被解析成 `https://localhost:3000`

三次触发,应用打开的浏览器地址**每次都是**(已脱敏):

```
https://localhost:3000/authorize
  ?client_id=<REDACTED>
  &redirect_uri=http%3A%2F%2F127.0.0.1%3A19876%2Fcallback
  &code_challenge=<REDACTED>&code_challenge_method=S256
  &state=<REDACTED>
  &scope=cloud.dispatch+cloud.read+artifact.read
  &resource=https%3A%2F%2Falpha-cloud.tidelabs.click%2Fmcp
  &response_type=code
```

`https://localhost:3000` 本机无监听 ⇒ 页面打不开 ⇒ 用户无从授权 ⇒ 回环回调永不到达 ⇒
300s 后 `OAuth callback timeout - authorization took too long`,端点回 **HTTP 500**。
引擎日志(`~/.local/share/opencode/log/opencode.log`):

```
level=ERROR ref=err_20fd3ad5 error="Error: OAuth callback timeout - authorization took too long"
```

**回环回调服务器本身是好的**:`lsof -nP -iTCP:19876 -sTCP:LISTEN` 在飞行期间确有
`alpha-code` 在 `127.0.0.1:19876` LISTEN。坏的只有"该把用户送到哪里"这一步。

### 4.1 服务端是对的(逐跳实测)

| 跳 | 实测结果 |
| --- | --- |
| `POST https://alpha-cloud.tidelabs.click/mcp`(无凭证) | `401` + `WWW-Authenticate: ... resource_metadata="https://alpha-cloud.tidelabs.click/.well-known/oauth-protected-resource/mcp"` |
| `GET .../.well-known/oauth-protected-resource/mcp` | `authorization_servers: ["https://auth.tidelabs.click"]`,`resource: https://alpha-cloud.tidelabs.click/mcp` |
| `GET https://auth.tidelabs.click/.well-known/oauth-authorization-server` | `200`,`authorization_endpoint: https://auth.tidelabs.click/api/oauth/authorize` |
| `GET https://auth.tidelabs.click/oauth/clients/alpha-code-mcp.json`(CIMD) | `200`,`redirect_uris:["http://127.0.0.1:19876/callback"]` |

**服务端没有任何一处提到 `localhost:3000`。** 且响应不随请求头变化(plain / Chromium UA +
`Sec-Fetch-*` / 无 `Accept` 三种都返回 `["https://auth.tidelabs.click"]`),也不是 CDN 缓存
(`?cache-bust` + `Cache-Control: no-cache` 同值)。

### 4.2 同机、同 SDK、同配置的对照跑 → 得到**正确**地址

用与引擎完全相同的传输与 provider 形状(`StreamableHTTPClientTransport` + CIMD `client_id` +
同一个回环 `redirect_uri`),在同一台机器上跑真实 401 → 发现 → `redirectToAuthorization`:

```
AUTHORIZE URL: https://auth.tidelabs.click/api/oauth/authorize?...
               &scope=artifact.read+cloud.dispatch+cloud.read+model.invoke
               &resource=https%3A%2F%2Falpha-cloud.tidelabs.click%2Fmcp
```

**`@modelcontextprotocol/sdk` 1.27.1 与仓库钉的 1.29.0 都给出这个正确地址。**
⇒ 不是 SDK 版本问题,也不是本仓那份 `patches/@modelcontextprotocol%2Fsdk@1.29.0.patch`
(它只改 scope 选取与 `offline_access` 判定,不碰授权服务器解析)。

### 4.3 已排除的原因(逐条,都是实测不是推断)

| 候选 | 排除依据 |
| --- | --- |
| 注入的 MCP 定义错了 | 引擎 `GET /config` 与 sidecar env 双读,URL/clientId/redirectUri 全对(§2) |
| 装错渠道 / 未登录 | 已重装 prod 且 `logged-in / platform / ready`(§1、§2) |
| 服务端发现链错了 | 四跳全对,且无 header/缓存变化(§4.1) |
| SDK 版本或本仓 patch | 1.27.1 与 1.29.0 对照跑都正确;patch 只动 scope(§4.2) |
| 代理 / hosts 劫持 | sidecar env 无任何 proxy 指向 3000(`NO_PROXY=127.0.0.1,localhost,::1`);`/etc/hosts` 干净 |
| 应用里硬编码了该地址 | `app.asar` 全字节扫描:`https://localhost:3000` **零命中**(仅有 5 处无关的库文档/测试里的 `http://localhost:3000`) |
| 进程内存缓存 | 重启应用后**同样复现** |
| 引擎自建授权 URL | `mcp/index.ts` 的 `capturedUrl` 只来自 SDK 的 `redirectToAuthorization`;main 侧 `package-mcp-oauth.ts` 只转发不改写 |
| provider 缓存了发现状态 | 本仓 provider **没有**实现 `discoveryState()`/`saveDiscoveryState()`(全仓零命中);`mcp-auth.json` 里也只有 `codeVerifier`/`oauthState` |

### 4.4 还没定死的那一步(诚实登记)

按 SDK 代码,只有 `resourceMetadata.authorization_servers[0] === "https://localhost:3000"`
才能产出这个地址(其余分支最坏只会退到 `https://alpha-cloud.tidelabs.click/authorize`)。
但同机对照跑拿到的是 `["https://auth.tidelabs.click"]`。

一条**旁证**指向"应用侧 `resourceMetadata` 实际为空":应用发出的 `scope` 是
`cloud.dispatch cloud.read artifact.read`,既不是 401 挑战里的 scope、也不是
`resourceMetadata.scopes_supported`(那两者都含 `model.invoke`),而对照跑拿到的是含
`model.invoke` 的那一版。两个观察互相矛盾(`resource=` 又是对的),
**所以本轮不宣称已定位根因**,只把可复现的事实与已排除项留在这里。

下一步建议(未做):在引擎侧对 `discoverOAuthProtectedResourceMetadata` 的入参与返回加一次
性诊断日志,或用本机 MITM 记录 sidecar 真实发出的 well-known 请求与响应 —— 这是唯一能把
§4.4 定死的证据,不该继续靠推断。

## 5. 对 #721 / alpha-work#50 的影响

- **AC3(登录态 5 工具逐项真实调用)本轮仍不可推进**:它的前置是应用真正持有
  `mcp_access` 令牌;今天 `mcp-auth.json.cloud` 依旧只有 `codeVerifier`/`oauthState`。
- **计费半场(AC4)同样未推进**(需要 `purpose=account.read` 令牌,且要先有可用云工具)。
- `docs/verification/2026-08-20-721-cloud-mcp-capability/` 的结论**不需要修订** ——
  它记的"云 MCP 停在 `needs_auth`"今天仍然成立,只是现在知道了**为什么**它一直到不了
  `connected`:不只是 #1044 那条 sidecar 换血,还有 §4 这条授权端点解析。

## 6. 一条本机纪律(踩到了,记下来)

`bun run ship:mac` 会把 `packages/ui-mac/resources/icons/*.png` 全部改写(43 个文件),
那是打包步的副产物、不是改动。提交前必须 `git checkout -- packages/ui-mac/resources/icons`,
否则会把一堆无意义的二进制 diff 带进 PR。

## 7. 原始日志摘录

`~/Library/Application Support/ai.opencode.desktop/logs/20260821T013646/main.log`
(第 45–55 行,未改动):

```
[2026-08-20 21:46:11.815] [info]  alpha-auth: tokens refreshed { expiresAt: 1787277671812 }
[2026-08-20 21:46:11.817] [warn]  #1044 deferring token-only respawn: cloud MCP OAuth in flight
[2026-08-20 21:47:11.820] [warn]  #1044 deferring token-only respawn: cloud MCP OAuth in flight
[2026-08-20 21:48:11.822] [warn]  #1044 deferring token-only respawn: cloud MCP OAuth in flight
[2026-08-20 21:49:11.825] [warn]  #1044 deferring token-only respawn: cloud MCP OAuth in flight
[2026-08-20 21:50:11.827] [info]  respawning sidecar { reason: 'token-only' }
[2026-08-20 21:50:13.593] [info]  sidecar token rotated without renderer reload
```

`~/.local/share/opencode/log/opencode.log`(引擎侧,OAuth 的终局):

```
timestamp=2026-08-21T01:31:34.429Z level=ERROR run=3cb7e6ca message=failed ref=err_20fd3ad5
  error="Error: OAuth callback timeout - authorization took too long"
```

三轮 `authenticate` 的返回一致:`HTTP 500`
`{"name":"UnknownError","data":{"message":"Unexpected server error. Check server logs for details.","ref":"..."}}`。

**脱敏说明**:本目录不含任何 token、API key、`code`、`code_verifier`、`client_id` 明文;
授权 URL 中的 `client_id` / `code_challenge` / `state` 均以 `<REDACTED>` 替换。

## 8. 闭合(2026-08-20 晚 · alpha-web 部署后)

**根因不在桌面发现链。** `auth.tidelabs.click/api/oauth/authorize` 曾用隧道 listen 地址
`url.origin`(`https://localhost:3000`)拼同意页 `Location`。SDK 打开的 AS URL 是对的,
浏览器跟随 302 后才落到本机死链。

- 修复:[alpha-web#158](https://github.com/jinjunnn/alpha-web/issues/158) /
  [PR #159](https://github.com/jinjunnn/alpha-web/pull/159),部署 tip `615ae04`。
- 线上核对:`Location: https://auth.tidelabs.click/authorize?...`(不再 localhost)。
- 本机完成手机号 OTP 同意后:`mcp-auth.json.cloud.tokens` 出现;
  引擎 `GET /mcp` → `cloud.status=connected`;authenticate 回 `{"status":"connected"}`。
- **mcp_access 授权矩阵**(Chrome UA 直打 RS,schema-invalid / 缺 job 参数,只判授权咽喉):

| 工具 | HTTP | 含义 |
| --- | --- | --- |
| cloud_dispatch | 200 | 进入回调(校验错) |
| cloud_status | 200 | 进入回调(job not found) |
| cloud_await | 200 | 进入回调(job not found) |
| cloud_artifacts | 200 | 进入回调(job not found) |
| cloud_web_search | 200 | 进入回调(校验错) |

⇒ 原先用 `purpose=cloud.dispatch` 回落令牌看到的 status/await/artifacts **结构性 403**
在真正的 `mcp_access` 路径上**不复现**。#1043 按「OAuth 通路修复 + 授权矩阵」闭合;
回落令牌的 fail-closed 仍是正确行为,不必放宽 `ALPHA_CLOUD_TOKEN`。

#721 探针重跑片段: **P0.5 PASS**(mcp_access 在位)。A-SUM 对回落令牌仍 FAIL(预期)。
