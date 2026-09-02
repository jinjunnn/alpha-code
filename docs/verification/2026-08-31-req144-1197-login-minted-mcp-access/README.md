# REQ-144 / alpha-code#1197 — 登录一次零交互完成云 MCP tools/call:运行期取证(T4)

Verification evidence for `#1188` **AC1/AC2/AC3** 的运行期证据与 `alpha-platform#226` 的准入判别子。
方案基线:`docs/design/req-144-login-minted-mcp-access.md` §4 T4(矩阵四格逐字自基线)。
父票 `#1188`;本票不含 AC4(悬置,基线 §5)。

Base: worktree `t1197-verify`, HEAD `e35410e6c`(= origin/alpha,含 T2 `#1200`、T3 `#1203`、
v0.1.6 发版 commit `2f115997e`)。生产代码零改动;本票只产测量与证据。


## 终判矩阵(证据等级逐格如实标注)

| 格 | 判定 | 证据等级/来源 |
| --- | --- | --- |
| ①-a `tools/call cloud_web_search` | **PASS(协议层);app 内端到端被 `#1214` 阻断** | 协议层=编排者 CDP 外直连实测(含 401 负对照);app 内阻断根因是桌面端未呈现 `mcp:cloud:*` 审批(`#1214`,非 REQ-144 欠账) |
| ①-b `mcp-auth.json` 无 cloud tokens | **PASS** | 本 lane 仪器测量(校准过的检查器 + lsof 钉数据路径) |
| ② 所用 token `aud=…/mcp` | **PASS** | 进程内解码,只出布尔;以 2026-09-01 21:42(0.1.8 登录)新铸 token 的复验为准 |
| ③ 第三方 MCP OAuth 回归 | **PASS** | T3 diff 结构性论证(编排者独立复核)+ 隔离实例 fixture 运行时(含负对照) |
| ④ `ap#226` 准入判别子 | **前置 PASS;运行期未取得** | 发布件本体钉扎当时为 v0.1.7(已被 0.1.8 替换,作废);D1 `job_admissions` 0 行(该表只由真实 dispatch 写,本轮未触发 dispatch)。后续归 `ap#226` 或另开窄票 |

## 前置测量 1 — 部署 provenance(票面点名的唯一未钉前提)

票面已知风险:「线上 `alpha-cloud`/gateway 部署 = 含 `ap#228` 受理面的 HEAD」若为假,
①格失败形态是 `cloud_web_search` 单工具 401/403,长得像 T2 改坏了。执行①格前先钉死:

```
npx wrangler deployments list --name alpha-cloud   --json   # results/deploy-alpha-cloud.json
npx wrangler deployments list --name alpha-gateway --json   # results/deploy-alpha-gateway.json
git merge-base --is-ancestor cefb281 11176caf09fae424a3f33389883fc4eab42f2c5d ; echo $?  # → 0
```

| Worker | 最新部署 provenance | percentage | created_on |
| --- | --- | --- | --- |
| `alpha-cloud` | `git:11176caf09fae424a3f33389883fc4eab42f2c5d` | 100 | 2026-08-28T05:30:18Z |
| `alpha-gateway` | `git:11176caf09fae424a3f33389883fc4eab42f2c5d` | 100 | 2026-08-28T02:42:08Z |

`cefb281`(= `[#228] gateway 那一跳接受 mcp_access`,PR alpha-platform#230)是已部署 sha 的
**祖先**(`merge-base --is-ancestor` rc=0),且已部署 sha = alpha-platform 当时的 origin/main HEAD。
**判定:前提为真。** ①格若红,不能归因部署陈旧,要往 T1(信封形状)/ T2 方向查界。

## 前置测量 2 — ④格发布件本体钉扎(v0.1.7,三方一致 + 标记检索)

> **2026-09-01 起本节钉扎作废**:owner 已发布并装机 **0.1.8**,v0.1.7 不再是当前发布件。
> 方法与结论(三方哈希 + 标记检索 + 负针)仍是④格重跑时的模板;④运行期证据本轮**未取得**(见终判矩阵)。

基线要求④格必须跑在**当前发布件本体**(release asset,`sha256(app.asar)` 与发布资产核对相符)。
owner 于 2026-08-31 发布并装机 **v0.1.7**(替换 0.1.6),故④格以 v0.1.7 为准:

1. `gh release download v0.1.7 -p alpha-code-mac-arm64.zip -p alpha-release-manifest.json`;
   `sha256(zip) = fc5155a58f2b7b42cfd6257e499a84fe202e99a82346f4427403ef8fd5aa7a0f`,
   与下载的 `alpha-release-manifest.json`(version 0.1.7)中该资产登记逐字相符
   (manifest 另载 signed/notarized/stapled = true,identity = Developer ID `RQX6X6A635`)。
2. 从该 zip 解出 `Code Puppy.app/Contents/Resources/app.asar`:
   `sha256 = 9eb62dae42924472fb9f0911922c35e2f0a5de49d715d4f65412e58c75e21b74`。
   `/Applications/Code Puppy.app`(owner 已装,CFBundleShortVersionString = 0.1.7)的 `app.asar`
   sha256 与发布件逐字相同 —— 装机件 = 发布件。
3. 标记检索(asar 含大量字面 NUL,一律 `grep -a`;负针自证不幻觉):
   - T2 标记 `ALPHA_MCP_TOKEN` → **8 命中**
   - T3 标记 `sweepLegacyCloudMcpAuthEntry` → **2 命中**;`engineMcpAuthPath` → **2 命中**
   - 负针 `zzz-t1197-nonexistent-needle-8f2a` → **0 命中**(rc=1)

依《本机验证陷阱》:asar 哈希不等 ≠ 代码不同(嵌构建期绝对路径),但**哈希相等 = 字节相同**,
叠加标记检索证明发布件确含 T2/T3 代码。**判定:④格的被测件已钉死为 v0.1.7 发布件本体。**

（历史:上一轮以 v0.1.6 钉扎，其 asar sha256 = `aa5e344d…`；0.1.6 已被 0.1.7 替换，不再是当前发布件，此值不作 0.1.7 的对照。）

## 隔离与观测纪律(运行期取证的场地)

- 隔离 = `OPENCODE_TEST_ONBOARDING=1` + `--use-mock-keychain`:每轮先以 canary 校准快照工具
  (证明可测出已知的坏),再取基线;5 观测目标(prod userData / dev userData / 共享引擎数据
  `~/.local/share/opencode` / `~/code-puppy` / `~/.opencode`)跑后逐项 diff。
  本轮隔离证明:throwaway boot 后 `added=0 removed=0 changed=0`,逐声称单独验证
  (XDG 四项、userData、sessionData、`OPENCODE_DB=:memory:`、`ALPHA_OPENCODE_HOME` 真实落点未被写)。
- 深链投递 = `open -a <确切 Electron.app 路径> "alpha-code://auth/callback?..."`(GURL Apple
  Event → 运行中实例的 `open-url`)。不动全局 scheme 注册(LS 默认 handler 与基线 diff 一致);
  实证投递落在自己的实例(pid 不变、handler 触发、state 校验生效)。
  (second-instance argv 在 onboarding 隔离下结构性不可用:状态根每次 `randomUUID()`,
  userData 每次唯一 ⇒ 单实例锁不碰撞 ⇒ argv 不转发。)
- 凭证纪律:token / auth code / PKCE verifier+state 不落报告、不打日志;②格只输出断言布尔。

## 运行期矩阵(①–④)

### ③(AC3)第三方 MCP server 授权流程回归 —— **PASS**

**回归面(T3 diff `42e47e670`)**:该 commit 从引擎 `authenticate` 删除的 OAuth 相关代码
全部位于 `if (inflightPath)` 内,而 `inflightPath = mcpName === "cloud" ? … : undefined` ——
对任何**第三方**(非 cloud)server,`inflightPath` 改动前后恒为 `undefined`,交互式 OAuth
代码路径**逐字不变**。故 T3 结构上不可能影响第三方 OAuth。

**运行期证据(隔离实例,onboarding + mock-keychain;非 owner 环境)**:
- 起本地 fixture 第三方 MCP server(401 + RFC 9728 protected-resource + RFC 8414 AS metadata
  + RFC 7591 动态注册),先校准四端点(401/200/200/201)证明 fixture 可用;
- 经引擎 `POST /mcp`(真实 add+connect)加入该 remote server ⇒ 状态 **`needs_auth`**
  (对照:同一 401 但**不**广告 OAuth 时得到 `failed` —— 已实测,证明 `needs_auth` 不是假阳);
- 经引擎 `POST /mcp/:name/auth`(startAuth)⇒ 返回**非空 authorizationUrl**:
  `response_type=code`、`code_challenge_method=S256`、含 `code_challenge`、
  `redirect_uri=http://127.0.0.1:19876/mcp/oauth/callback`、含 `state`/`oauthState`/`client_id`;
  且 loopback 回调服务 **127.0.0.1:19876 LISTEN**(lsof 归属隔离实例)。
- 证据形状:`results/cell3-thirdparty-oauth.json`(只存布尔/形状,无凭证)。

**判定:第三方 MCP 仍走交互式 OAuth(needs_auth → 交互 authorize URL + loopback),T3 未回归。**
（引擎凭证经 CDP 观测自有实例流量取得,只用于本地驱动,用后即焚;fixture 与隔离实例已清理,零残留。）

### ②(AC2)进程内解出所用 token 断言 `aud` —— **PASS**

> **以 2026-09-01 21:42 的复验为准**(owner 在 0.1.8 上重新登录,`ALPHA_MCP_TOKEN` 同刻新铸;
> 编排者进程内解码,只出布尔):`alg ES256`、`aud` 逐字为云 MCP 资源且**标量**、`exp` 在未来、
> scope `{cloud.dispatch, cloud.read, artifact.read}` —— **PASS**。下表为本 lane 2026-08-31 对上一代
> token(0.1.7 登录所铸,现已轮换)的原始测量,结论相同,留作方法与历史记录。

owner 于 0.1.7 重新登录后,引擎经 `{file:}` 通道消费的 `mcp_access` 落为明文秘密文件
`<userData>/alpha-secrets/ALPHA_MCP_TOKEN`(T2,`alpha-secret-files.ts:34`)。在**一次性解码
脚本内**(`/private/tmp` 私有,token 值/完整 claim 体绝不打印/落盘/入报告)断言其形状:

| 断言 | 结果 |
| --- | --- |
| 是 3 段 JWT | true |
| `alg` | ES256 |
| `aud === https://alpha-cloud.tidelabs.click/mcp`(标量,非数组) | **true** |
| `iss === https://auth.tidelabs.click` | true |
| `exp` 存在且未过期 | true(观测时余 ~493s,合 15min TTL) |
| `scope` | `{artifact.read, cloud.dispatch, cloud.read}`(基线所述覆盖全 6 工具的集合) |

**判定:所用 token 的受众正是云 MCP resource。** 只出布尔与形状,`ALPHA_CLOUD_TOKEN`
(platform_access)与 `ALPHA_API_KEY` 未读。

### ①-b(AC1 下半)`mcp-auth.json` 无 cloud tokens —— **PASS**

云 MCP 键名 = `"cloud"`(`cloud-web-search.ts:2`)。**先校准**:构造含 `{"cloud":{…}}` 的样本,
检查器报 `has_cloud_key: true`(证明能测出已知的坏);再判真文件。
owner 运行中的引擎(Helper pid 27890)持有 `~/.local/share/opencode/`(lsof 实证其数据路径),
其 `mcp-auth.json`(全盘唯一)`has_cloud_key: false`、`keys: []`,且 mtime 早于 owner 05:11 登录
⇒ owner 本次会话未写任何 cloud entry。**判定:云 MCP 未走交互式 OAuth(oauth:false,静态 header)。**

### ①-a(AC1 上半)`tools/call cloud_web_search` —— **PASS(协议层);app 内端到端被 `#1214` 阻断**

两半分开写,证据等级不同:

**协议层(证据来源:编排者 CDP 外直连,非本 lane 仪器,亦非 app 内取证)** —— 用登录铸的同一把
`mcp_access` 直连云 MCP surface:`initialize` 200/0.93s、`tools/list` 200/1.22s(六工具齐)、
**`tools/call cloud_web_search` 200/6.6s 返回真实 tavily 结果**;负对照:无效 token → **401
`invalid_token`**,证明探针打到了应用层而非被边缘拦截。⇒ 登录铸的 `mcp_access` 完成
`tools/call cloud_web_search`,零交互授权。

**app 内端到端 —— 走不通,根因与 REQ-144 无关**:引擎发出 `asking permission=
mcp:cloud:cloud_web_search`,桌面端从未呈现该审批,5 分钟后 `unanswered — failing closed`
(复现 ×2)。已立 `#1214`(「通道建好、消费端是空的」同型第四例),实现已派。
**此为独立缺陷,不是本 REQ 的欠账;端到端复验归 `#1214` 收口后的回归。**

**观测边界(如实声明)**:本轮桌面 app 内无器械级观测通道(prod 正常启动无 CDP;协议层直连
是编排者后来以 `ALPHA_CDP=1` 环境取得的)。app 内器械级取证需要独立的可观测性能力,那是一张
独立票的范畴,本票不留"待补证据"尾巴。

### ④(`ap#226` 准入)—— **前置 PASS;运行期未取得**

- 前置(被测件钉扎)当时以 v0.1.7 完成三方一致 + 标记检索(见前置测量 2);0.1.8 发布后该钉扎作废。
- D1 `job_admissions WHERE surface='mcp' AND caller_ref='mcp:access'` 至今 **0 行**(查询手段有
  正样本对照:`alpha-schedules.scheduler_runtime` 3 行、表清单可得 ⇒ 0 是真空)。勘破结论:该表
  **只由真实 cloud dispatch 写**(`admitJob`,`cloud-core.ts:298`),`cloud_status`/同步搜索不写;
  owner 本轮未触发 dispatch ⇒ 判别子无从产生。
- **不以协议层直连证据顶替此格**:D1 分不出「发布件发的」与「持 token 直连发的」,顶替 = 向准入
  判别子注入不可证伪的假记录(正是本票理由段点名的形态)。
- 后续处置(转 `ap#226` 或另开窄票)由编排者决定;重跑模板 = 前置测量 2 的钉扎方法 + owner 在
  当前发布件内触发一次真实 dispatch + 本节的 D1 查询。

## 观测陷阱(本轮新增,留给后来人)

- **Cloudflare 客户端指纹拦截会让探针得到与应用层无关的 403。** 编排者第一次用 Python 直探云 MCP
  端点:有效 token / 带协议头 / 无效 token **三臂全部 403**,body 是 `Cloudflare Error 1010` ——
  按客户端指纹在边缘拦截,**根本没到应用层**。若无「无效 token 应得 401」这条负对照,结论会写成
  「服务端拒绝 mcp_access」。换 bun/undici 后:有效 token 200、无效 token 401,真相立现。
  **判据:直探任何经 CDN 的面,负对照臂(已知应得的另一种错误码)是必备件,三臂同码 = 你还没
  到应用层。**(与本仓《同 IP 对照臂》《先证明手段能测出已知的坏》同源。)
- **`job_admissions` 由谁写,决定了让 owner 做什么动作。** 本轮勘破:该表只由 `admitJob`(真实
  dispatch)写;若未勘破这层,就会请 owner 点一个根本不留证据的动作,然后在空表面前重新诊断。


