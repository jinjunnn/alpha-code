# REQ-144 方案基线:登录一次即可用一方云能力(含云 MCP),无需第二次交互式授权

- 需求票:`jinjunnn/alpha-code#1188`(L 级,跨仓契约 + 安全面)
- 状态:方案基线(升 Ready 的门)。按 L 级流程,开发前对抗咨询 ≤1 轮后回写本文档。
- 勘破输入:2026-08-30 跨仓只读勘破(alpha-code `req144-recon`,alpha-platform `11176caf0`,
  alpha-web `9b1ea4b71`);本基线撰写时(2026-08-30,alpha-code `e244fa18c`)对所有承重坐标
  逐条复核,并补测了勘破未覆盖的四处(§1.2、§1.3、§1.4、§1.7)。全程只读,零凭证接触。
- 涉及仓:alpha-web(铸 token)、alpha-code(消费)、alpha-platform(只读对照,本 REQ 零改动)。

## 0. 一句话方案

**登录信封多带一支顶层 `mcp_access_token`(受众 = 云 MCP resource,15 分钟,随既有
~10 分钟换血自然轮换);桌面把云 MCP 定义从「交互式 OAuth」改回「静态 `Authorization`
header」——但装的不再是错受众的 `platform_access`,而是这支登录铸的 `mcp_access`,经
既有 `{file:}` 秘密文件通道进引擎。引擎(`packages/opencode`/`packages/core`)零改动;
第三方 MCP 路径零改动。**

云 MCP 的交互式 OAuth(loopback 等待被换血杀掉的那条路,`ac#721`/`ac#1044`)从「必经之路」
降级为「不存在的路」——不是修它,是绕开它。

## 1. 只读勘破(地面真相;全称事实均已实跑)

### 1.1 铸造侧现状(alpha-web)

- 登录铸 5 支 purpose-bound `platform_access`(`aud: "alpha-platform-api"`),清单权威是手写
  字面量 `DESKTOP_BUNDLE_PURPOSES`(`lib/token-claims.ts:34-41`),注释明令「加 wire 词表
  ≠ 加 bundle 键」。
- **`mcp_access` 已存在**:schema 第 6 支(alpha-platform `packages/gateway/src/contracts/v1/identity.ts:96-101`,
  `aud = https://alpha-cloud.tidelabs.click/mcp`,`iss = https://auth.tidelabs.click`,授权向量
  是 scope 数组而非 purpose);签发函数 `issueMcpAccess`(alpha-web `lib/jwt.ts:192-206`)已存在,
  TTL 硬连到 `MCP_ACCESS_TTL_SECONDS = 5 分钟`(`lib/credential-ttl.ts:19`,注释:这个数**就是
  第三方撤销窗口**,并写进了公开契约 `docs/contracts/public-oauth-as.md`)。
- `/api/oauth/token` 按 **grant 上的 `resource`** 二选一分流(`route.ts:88-93`
  `session.resource ? mcpAccessResponse : desktopBundleResponse`):**要么** 5 支 bundle,
  **要么**一支 RFC 6749 形状的 `mcp_access`,结构上拿不到两者。
- refresh **双向禁改 `resource`**(`lib/sessions.ts:243-247` "Compared exactly, in BOTH
  directions: a desktop family may not acquire a resource");desktop family 的 `resource`
  恒为 `""`(`sessions.ts:20-22`)。⇒ 事后用 refresh「再瞄准」到 MCP 受众是被设计禁止的。
- 桌面 client `alpha-code` 预注册 scope = `["openid","profile","platform"]`(`lib/oauth.ts:23`);
  `platform` 是私有 grant(「整个五 purpose bundle」,`lib/oauth.ts:101-104`),**不在**
  token scope 词表里 ⇒ `checkMcpScope("openid profile platform")` 会拒
  (`lib/oauth-scope-projection.ts:93-101`:`platform` 落进 `unknown` ⇒ `invalid_scope`)。
  **桌面今天的 consented scope 无法经投影产出 `mcp_access`** —— 投影是给第三方 OAuth 词表用的,
  一方政策要另立(§2.3)。
- token scope 词表(`TOKEN_SCOPE_VOCABULARY`,`lib/token-claims.ts:169-180`,从 vendored schema
  实 dump)= 9 值,含 `cloud.dispatch`/`cloud.read`/`artifact.read`/`model.invoke`。

### 1.2 「服务端先加键 = 弄断已装客户端」的精确边界(2026-08-30 实测,本基线的关键修正)

勘破给出的顺序约束原文是「bundle 里出现未知键,旧桌面当场抛 `unknown-purpose`
(`alpha-auth.ts:527`)⇒ 服务端先加第 6 个 bundle 键 = 弄断全部已装客户端」。**实测把它的
作用域钉窄了一格,而这一格正好决定方案形状:**

- fail-loud 只作用于 **`platform_access_tokens` map 内部的键**(`decodeTokenResponse`:
  `isRoutePurpose(purpose)` 不认识 ⇒ `unknown-purpose`;缺必需键 ⇒ `missing-required-purpose`)。
- **信封顶层的未知字段被逐字忽略**:`decodeTokenResponse` 只读取具名字段,未知顶层键不进入
  任何判定。**已对 `v0.1.3`、`v0.1.4`、HEAD 三个版本 diff,函数逐字节相同**
  (`git show <tag>:packages/ui-mac/src/main/alpha-auth.ts`,三份 `decodeTokenResponse` 两两 diff 为空)。
- v0.1.2 及更早读的是单 `access_token` 形状(`v0.1.2` 的 `alpha-auth.ts:38,308`),而现行
  `/api/oauth/token` 是 breaking v1(`route.ts:139-142` "No legacy single access_token"),
  **它们今天本来就登不进**,不构成兼容约束(且 `ap#226` 实测该人口 ≈ 0)。
- alpha-web `route.ts:30-37` 那句 "Exactly these eight keys, forever … Adding a top-level key
  … becomes a login outage" 的**前提对每一个能登录的已发布版本都不成立**(上两条)。
  按 maintain-repository-docs 的规矩,T1 落地时同步更正该注释(警告保留给 map 内部键,那半边是真的)。

⇒ **顺序约束的真实形状**:禁止的是「往 `platform_access_tokens` map 里加第 6 个键」;
「在信封顶层加兄弟字段」对全部存活客户端无感。本方案只做后者(§2.2)。

### 1.3 TTL 与轮换时钟(「5 分钟够不够」——跑过,不够,且是结构性的)

- 客户端刷新时钟:`refreshDueAt = expiresAt − min(5min, lifetime/3)`
  (`alpha-auth-clock.ts:7-8,25-26`)。bundle `expires_in = 15 分钟` ⇒ 每 **~10 分钟**一次
  `grant=refresh_token` 重铸整个信封,随后 **token-only sidecar respawn**(`auth-renewal.ts` →
  `index.ts:1347-1353`)。
- 凭证进引擎的形态(选定通道,§2.4)是**装载期一次性**的:`headers` 作为静态 `requestInit`
  传给两个 transport(engine `mcp/index.ts:307-320`),`{file:}` 替换发生在 config 装载时
  (`packages/opencode/src/config/variable.ts:33-70`)。⇒ token 的可用寿命必须覆盖**整个
  respawn 周期**:进程活 ~10 分钟,token 装载时刚铸(age≈0),到下次 respawn 时 age≈10 分钟。
- **5 分钟 TTL ⇒ 每个周期的第 5–10 分钟 token 已过期,云 MCP 调用全 401** —— 不是偶发,
  是每个周期的后一半。15 分钟 TTL ⇒ 全周期有效且恒有 ≥5 分钟余量。
- 连接形态补充:MCP 的 SSE 流是长连接,但每次 `tools/call` 是独立 HTTP POST,各自带
  `requestInit.headers` —— 所以「进程存活期内 token 有效」就是充分条件,不需要中途热更新。

### 1.4 消费侧现状(alpha-code;含引擎通道与主权约束)

- 云 MCP 定义今天是 `oauth: { clientId: CIMD, redirectUri }` 零凭证形状
  (`cloud-sidecar-config.ts:80-93`,签名里那个被删掉的第二参数**从前正是**
  `{file:…ALPHA_CLOUD_TOKEN}` 的静态 bearer —— `ac#733` 删它删对了,因为里面装的是错受众的
  `platform_access`;本方案恢复的是**通道**,不是那份凭证)。
- 引擎对 remote MCP:`headers` ⇒ 静态注入每个请求;`oauth: false` ⇒ 完全不构造
  OAuth provider、不碰 `mcp-auth.json`、不开 loopback(`mcp/index.ts:276-320`)。
  **一方/第三方的分化判据(config 形状)在引擎里已经存在,不需要为本方案新增任何引擎分支。**
- 秘密通道(A6,`alpha-secret-files.ts` 头注):main 在**每次** fork/respawn 前把秘密 env var
  镜像成 `<userData>/alpha-secrets/<VAR>`(0600)文件,config 只携带 `{file:<路径>}` 引用,
  值不进 env、不进 `OPENCODE_CONFIG_CONTENT` 字面量。现有成员:`ALPHA_API_KEY`、
  `ALPHA_CLOUD_TOKEN`、BYOK 键(`secretEnvVars()`)。
- 北极星约束:`packages/opencode`/`packages/core` 等在 `UPSTREAM_PATHS`
  (`scripts/north-star-guard.sh:39`);`mcp/index.ts` 虽已被 ADR-041 接管,但**本方案不需要
  动它** —— 分叉点因此只能也只应落在 alpha 全资的 ui-mac 注入层。
- 平台代付判据:`platformPays = ALPHA_CLOUD_MCP_URL 存在 && ALPHA_CLOUD_TOKEN 文件存在`
  (`alpha-config-injection.ts:96`);doomed-connect 判据镜像引擎 `mcp-auth.json`
  (`cloud-mcp-doomed-connect.ts:37-60`)⇒ 凭证源变更后两者都要换轴(§4 T2)。

### 1.5 MCP 面与授权矩阵(alpha-platform,本 REQ 零改动,只作契约对照)

- MCP 面受理 `mcp_access`:`tenant-auth.ts:144-175`(`jwtVerify` 钉
  `iss = https://auth.tidelabs.click`、`aud = https://alpha-cloud.tidelabs.click/mcp`),
  scope 与 `MCP_SUPPORTED_SCOPES` 求交,交集空 ⇒ 什么都授权不了(fail-closed)。
- 工具注册表 `requiredAction`(any-of,`mcp-tool-registry.ts:70-117`,2026-08-30 逐行实读):
  `cloud_dispatch`/`cloud_cancel` 要 `cloud.dispatch`,`cloud_status`/`cloud_await` 要
  `cloud.read`,`cloud_artifacts` 要 `artifact.read`,`cloud_web_search` 要
  `cloud.dispatch | model.invoke`。⇒ **`{cloud.dispatch, cloud.read, artifact.read}` 三值
  覆盖全部 6 个工具**,`model.invoke` 对一方桌面不必要(它在集合里只为第三方直用客户端,
  `:110-117` 注释)。
- 双接受(MCP 面同时收 `platform_access`)是 `ap#226` 要收掉的;gateway
  `/v1/tools/web_search` 已 route-local 受理 `mcp_access`(`ap#228` 已合,PR #230)。

### 1.6 今天第二次授权为什么必然被打断(引 `#1188` 票面与 `ac#721`/`ac#1044`)

引擎在自身进程内开 loopback 等回调(`mcp/oauth-callback.ts`),而 main 每 ~10 分钟
token-only respawn 杀掉该进程;`ac#1044` 的推迟闸只罩 `reason==="token-only"` 且有 15 分钟
上限,structural respawn / 退出重启不罩。owner 机器上留下的 `codeVerifier/oauthState` 有、
`tokens` 无的中间态即此形态。本方案落地后这条路对云 MCP 不再存在(第三方不变)。

### 1.7 复核手段自检

- 负针:`grep -c "zzz-req144-baseline-nonexistent"` 于 `route.ts`/`alpha-auth.ts` ⇒ 0(rc=1);
  正样本 `grep -c "platform_access_tokens"` 于 `alpha-auth.ts` ⇒ 命中。
- decoder 跨版本等同用 `diff` 判(空 diff × 2),不是散文断言;scope enum 用
  `python3 json.load` 直 dump(9 值);registry `requiredAction` 逐行读原文,非转述。

## 2. 选定方案与被否决的替代

### 2.0 权威问句

**本系统(alpha-web AS)对自己的预注册客户端拥有全部签发政策权,方案不与任何外部系统逐点
同步**:不引入新协议面、不新增 schema 分支(`mcp_access` 已在 wire 契约里)、不改两个下游
vendored lock(schema 零字节变化)、引擎零改动(分化判据是 config 形状,引擎既有语义)。
外部无从覆盖:信封形状由 `route.ts` 的预注册判定决定,CIMD/DCR 客户端结构上到不了
(`route.ts:207-217`:非预注册且无 resource ⇒ 401)。

### 2.1 选定方案(两仓各一个动作)

**alpha-web(先落、先部署)**

1. `desktopBundleResponse`(`route.ts:39-56`)新增**顶层**字段
   `mcp_access_token: string` —— 与 5 支 bundle 并列,**不进** `platform_access_tokens` map。
   code grant 与 refresh grant 共用该函数,轮换自动覆盖。
2. 铸造用一方政策常量 `DESKTOP_MCP_SCOPES = ["cloud.dispatch","cloud.read","artifact.read"]`
   (落 `lib/token-claims.ts`,与 `DESKTOP_BUNDLE_PURPOSES` 同款手写字面量 + 装载期
   `⊆ TOKEN_SCOPE_VOCABULARY` 断言;**不做** OAuth scope 投影 —— `platform` 私有 grant 本身
   就是「一方全量凭证集」的政策把手,§1.1 已证投影结构上走不通)。三值覆盖全部 6 个工具且
   排除 `model.invoke`(§1.5,最小权限)。
3. `issueMcpAccess` 增加显式 `ttlSeconds` 参数;桌面路径传
   `PLATFORM_ACCESS_TTL_SECONDS`(15 分钟,**同一个常量**,不铸第二个数字 —— 刷新时钟由它
   驱动,TTL 与周期的耦合从此是恒等式而非约定);RFC 信封路径维持
   `MCP_ACCESS_TTL_SECONDS = 5 分钟`不变(公开契约的第三方撤销窗口不动)。

**alpha-code(后发版)**

4. `decodeTokenResponse` 增加**可选**顶层字段 `mcp_access_token`(缺席合法;存在则要求
   非空字符串,余下当不透明凭证 —— 不经 `decodeTokenClaims`,那个 decoder 钉死
   `platform_access`/`alpha-platform-api`,对本 token 结构性不适用;真伪由 RS 验)。
5. 凭证沿既有 A6 通道下行:`applyAuthEnv` 写 `ALPHA_MCP_TOKEN` env → `secretEnvVars()`
   纳入该名 → `syncSecretFiles` 每次 respawn 前镜像成 0600 文件。
6. `materializeCloudMcpConfig` 改为:
   `{ type:"remote", url, enabled:true, headers:{ Authorization: "Bearer {file:…/ALPHA_MCP_TOKEN}" }, oauth:false }`。
   `oauth:false` 同时关掉 OAuth 自动探测(引擎既有语义,§1.4)。
7. 注入判据换轴:`ALPHA_MCP_TOKEN` 文件缺席 ⇒ 该定义写 `enabled:false`(诚实停用,沿用
   doomed-connect 的既有停用形态);`platformPays` 判据同步换到新文件。
   **缺席时不回退**到 `platform_access` header 或交互式 OAuth(fail-closed,无 legacy shim)。

**发布顺序**:alpha-web 先部署(对存活客户端不可见,§1.2);alpha-code 后发版(新字段缺席时
客户端自己 fail-closed,所以合并顺序自由、**生效顺序**由部署序保证)。

### 2.2 核心取舍:bundle 要不要加第 6 格 —— 不加

| | 第 6 个 bundle 键(否决) | 顶层兄弟字段(选定) |
| --- | --- | --- |
| 已装客户端 | `alpha-auth.ts:527` 当场抛 `unknown-purpose`,登录全断;只能客户端先发版、服务端后部署,窗口期内新客户端又缺 MCP 格 | 全部存活版本逐字节验证过忽略未知顶层键(§1.2),服务端先行零感知 |
| 语义 | map 的键是 **platform_access 的 purpose**(`aud=alpha-platform-api`);塞进一支 `token_use=mcp_access`、`aud=…/mcp` 的 token 是在 purpose-keyed 容器里放异类,`DESKTOP_BUNDLE_PURPOSES` 的权威注释明令禁止 | `mcp_access` 保持独立形状,与 `route.ts` 既有立场一致(它只在错误的前提上把「顶层」也划进了禁区) |
| 客户端解码 | `requireTokenPurpose`/`decodeTokenClaims` 全套要开洞 | 不透明字段,零 decoder 改动 |

### 2.3 「`resource` 参数怎么带」—— 不带(否决理由)

桌面在 authorize+token 带 `resource` 是勘破指认的「结构上拿到 `mcp_access` 的唯一现路」,
但作为方案被否决:

- 信封**二选一**(`route.ts:88-93`):带了 `resource` 就丢了 bundle。要两者兼得必须新开
  「预注册 + resource ⇒ 合并信封」第三分支,改动面横跨 authorize 路由、consent、
  `createSession`、refresh 路径,并且**推翻** `sessions.ts` 「desktop family 恒无 resource、
  refresh 双向禁改」两条既有不变量 —— 为同一结果付三倍面积。
- `route.ts` 自己的原则是「信封由用户批准的东西决定,不由请求当下声称的决定」。选定方案里
  信封由**注册客户端身份 + 已同意的 `platform` 私有 grant** 决定,与该原则同构;`resource`
  是给「陌生客户端声明受众」用的把手,一方政策不需要它。
- 同理否决 **refresh 再瞄准**(违反 §1.1 双向禁改的既有安全不变量)与
  **RFC 8693 token exchange**(仓内零存在——票面两条检索轴已证;为一个一方场景新建
  「token 换 token」的公开转换面,正是 purpose-bound 姿态要避免的)。

### 2.4 其余被否决替代

- **静默第二次 OAuth**(复用浏览器侧 AS 会话自动放行):仍要拉浏览器、仍走 loopback 等待
  (被换血打断的 `#721`/`#1044` 整类失败原样保留)、cookie 在场性无保证 ⇒ 「零额外交互」
  不可承诺。
- **main 把 tokens 注入引擎 `mcp-auth.json`**:该文件是引擎全资(flock + 0600,ui-mac 现状
  只读/删),改成双写者引入跨进程竞态;且引擎的 OAuth provider 会拿注入的 refresh token 去
  AS 自刷 ⇒ 同一 refresh family 出现第二个轮换者,rotate-only-narrow 之下互为重放,
  触发 revoke 杀会话。refresh token 必须不离开 main(§3 I3)。
- **全局把 `MCP_ACCESS_TTL_SECONDS` 提到 15 分钟**:第三方撤销窗口是写进公开契约的数字
  (§1.1),为一方便利放宽三倍;per-issuance TTL 参数一行解决。
- **分叉点放引擎**(`connectRemote` 特判 cloud / `McpAuth.getForUrl` 换源):在
  `UPSTREAM_PATHS` 治理下扩大接管面,而 config 形状分化(`headers+oauth:false` vs `oauth` 对象)
  是引擎既有语义,零改动可得。三个候选分叉点里选 **ui-mac 注入层**,即此理由。
- **什么都不做,长期靠双接受**:`ap#226` 落地即断,且 MCP 面的 audience 绑定永远立不起来 ——
  本 REQ 存在的理由。

## 3. 安全面:攻击/边界类枚举与实现必须守住的不变量

以下各类均过了第零问(走本系统自己的代码与 runbook 可达);不可达的类
(如「非预注册客户端骗取桌面信封」——`route.ts:207-217` 既有 401,本方案不动它)不列。

- **I1(信封完整性)**:`platform_access_tokens` 的键集**恒等于** `DESKTOP_BUNDLE_PURPOSES`
  五值;`mcp_access_token` 永不进入该 map。守法:客户端 `unknown-purpose` fail-loud(既有)+
  alpha-web 信封形状测试断言 map 键集与顶层新字段并存。
- **I2(信封可达性)**:新字段只在 `desktopBundleResponse` 产出;RFC `mcp_access` 信封
  (第三方路径)逐字节不变。第三方经任何路径可得的 scope 仍 ⊆ `PUBLIC_CLIENT_SCOPES`
  (`model.invoke` 依旧结构上拿不到)。守法:alpha-web 测试双断言(桌面信封含新字段 /
  RFC 信封响应键集回归)。
- **I3(凭证保管)**:refresh token 永不离开 main 进程;引擎只经 0600 秘密文件拿到
  **access** token;token 值不落 env、不落 `OPENCODE_CONFIG_CONTENT` 字面量、不落日志
  (A6 既有姿态,§1.4)。守法:注入测试断言 config 里该 header 值形如 `{file:…}` 且不含
  JWT 形状字面量。残余风险沿用 A6 已接受项:同 UID 进程主动读文件可得(与
  `ALPHA_CLOUD_TOKEN` 同级,未加宽)。
- **I4(受众隔离)**:桌面 MCP 凭证 `aud = https://alpha-cloud.tidelabs.click/mcp`、
  `token_use = mcp_access`、scope 恰为 `DESKTOP_MCP_SCOPES` 三值(无 `model.invoke`);其唯一
  消费点是云 MCP 定义的 header,不得进入 gateway `/v1` 模型面、account 面的任何请求路径。
  反向混用(`platform_access` 打 MCP 面)是 `ap#226` 的收口面,本方案使一方不再依赖它。
  守法:alpha-web 铸造测试断言 claims 三元组;alpha-code 注入测试断言仅 cloud 定义携带该文件引用。
- **I5(TTL 耦合)**:桌面路径 mcp token 的寿命与驱动刷新时钟的常量是**同一个**
  `PLATFORM_ACCESS_TTL_SECONDS`,不允许出现第二个数字(否则 §1.3 的死窗以常量漂移的方式回归)。
  守法:alpha-web 测试断言桌面路径 token 的 `exp − iat === PLATFORM_ACCESS_TTL_SECONDS`。
- **I6(缺席 fail-closed)**:信封无该字段 / 秘密文件缺席 / 值为空 ⇒ 云 MCP 定义
  `enabled:false`,**不回退**到任何其它凭证或交互式 OAuth。守法:注入测试的缺席分支断言。
- **I7(词表越界)**:`DESKTOP_MCP_SCOPES` 任一成员不在 vendored `TOKEN_SCOPE_VOCABULARY`
  ⇒ alpha-web 装载期抛(与 `DESKTOP_BUNDLE_PURPOSES` 同款,`token-claims.ts:159-166` 形态),
  失败落在启动闸而不是第一个登录用户身上。

## 4. 子票切分(跨仓;顺序约束见各票)

### T1 `[REQ-144][CODE]` alpha-web:桌面登录信封新增顶层 `mcp_access_token`(M)

- 负责 AC:`#1188` AC1 的签发半边、AC2。
- 边界:`app/api/oauth/token/route.ts`(`desktopBundleResponse` + 顶层注释前提更正,§1.2)、
  `lib/jwt.ts`(`issueMcpAccess` ttl 参数)、`lib/token-claims.ts`(`DESKTOP_MCP_SCOPES` +
  装载期断言)、`docs/contracts/desktop-oauth.md`(信封契约更新)、对应测试。
- out-of-scope:客户端消费;wire schema 与两个 vendored lock(零字节变化);RFC `mcp_access`
  信封与 5 分钟 TTL(不动);consent 页文案(建议项,见 §6)。
- 退出条件:①桌面信封(code + refresh 两条 grant)含非空 `mcp_access_token`,解出
  `token_use=mcp_access`、`aud=…/mcp`、scope 恰三值、`exp−iat = PLATFORM_ACCESS_TTL_SECONDS`;
  ②RFC 信封响应键集回归不变;③`platform_access_tokens` 键集回归不变(I1)。
  判据自检:全部是既有测试基建上的信封/claims 断言,今天就能写,错误实现(复用 5 分钟 TTL、
  塞进 map、投影桌面 scope)分别在 ①③ 上当场红。
- **顺序:先落、先部署**(部署对存活客户端不可见,§1.2)。

### T2 `[REQ-144][CODE]` alpha-code:云 MCP 凭证改走登录铸 token 的 `{file:}` header 通道(M)

- 负责 AC:AC1 的消费半边、AC3。
- 边界:`packages/ui-mac/src/main/alpha-auth.ts`(可选字段解码 + 存储 + `applyAuthEnv`
  写 `ALPHA_MCP_TOKEN`)、`alpha-secret-files.ts`(`secretEnvVars` 纳入)、
  `cloud-sidecar-config.ts`(`materializeCloudMcpConfig` → `headers` + `oauth:false`)、
  `alpha-config-injection.ts`(`platformPays`/enabled 判据换轴)、
  `cloud-mcp-doomed-connect.ts`(判据换轴或就地退役)、`data-clear.ts`(清除项覆盖新文件)、
  对应测试。
- out-of-scope:`packages/opencode`/`packages/core` 零改动;`#1044` 闸与 CIMD client 的退役
  (T3);第三方 MCP 定义来源(catalog/用户配置/extension package)零触碰。
- 退出条件:①注入的 cloud 定义为 `headers.Authorization = "Bearer {file:…ALPHA_MCP_TOKEN}"`
  + `oauth:false`,且 `OPENCODE_CONFIG_CONTENT` 不含 token 字面量(I3);②字段/文件缺席 ⇒
  `enabled:false` 且无任何回退(I6);③第三方定义注入路径回归逐项不变(AC3 的静态半边);
  ④仅 cloud 定义携带该文件引用(I4)。
  判据自检:①—④ 全是既有注入测试(`alpha-config-injection` 一族)的同型断言;错误实现
  (回退到 ALPHA_CLOUD_TOKEN、忘关 oauth、把 header 写成字面量)各自当场红。
- 顺序:代码可与 T1 并行评审,**发版必须在 T1 部署之后**(否则新客户端恒 `enabled:false`,
  虽 fail-closed 但功能不成立)。

### T3 `[REQ-144][CODE]` alpha-code:退役云 MCP 交互式 OAuth 残留(S)

- 负责 AC:无(纯清理;AC3 的「第三方不受影响」由 T2/T4 承载)。
- 边界:`cloud-mcp-oauth-gate.ts` 及其在 `index.ts:1350`、`mcp/index.ts:975-984` 的接线
  (后者在 ADR-041 已接管文件内,删除即可,不扩接管面)、`cloud-sidecar-config.ts` 里
  CIMD `CLOUD_MCP_OAUTH_CLIENT_ID`/`REDIRECT_URI` 常量、引擎 `mcp-auth.json` 里遗留 cloud
  entry 的一次性清扫(沿 `data-clear.ts` 形态)。
- out-of-scope:`use-extensions.ts` 通用 authenticate UI 与 loopback 机制(第三方仍用);
  alpha-web 侧 `oauth/clients/alpha-code-mcp.json` CIMD 文档的存废(owner 裁,§6)。
- 退出条件:cloud 路径上对 `MCP.authenticate`/inflight 闸零引用(两条检索轴:符号名 +
  文件名);第三方 authenticate 路径测试回归绿。
  判据自检:删除类,证据 = 检索零命中 + 既有回归;无法「错误实现却满足」。
- 顺序:依赖 T2 合并。

### T4 `[REQ-144][VERIFY]` 运行期证据:登录一次 → 零交互 tools/call(L1/L3)

- 负责 AC:AC1、AC2、AC3 的运行期证据;同时产出 `ap#226` 的准入判别子。
- 矩阵(一格一 AC,证据不与 T1/T2 的单测重复):
  ①(AC1)真实登录一次 → 不点任何授权 → 云 MCP `tools/call cloud_web_search` 成功的运行期
  记录,同时 `mcp-auth.json` 无 cloud tokens(证明没走交互路);
  ②(AC2)进程内解出所用 token 断言 `aud=…/mcp`(token 不落盘不落日志,沿 `#1188` 探针纪律);
  ③(AC3)一个第三方 MCP server 的授权流程回归(仍走交互式 OAuth);
  ④(`ap#226` 准入)`cloud_status` 判别调用:`platform_access` 对它恒 403(`ac#721` 矩阵),
  一次非 401/非 403 完成即同时证明「tools/call 完成」与「凭证是 `mcp_access`」,零计费;
  服务端持久判别子 = D1 `job_admissions` `surface='mcp' AND caller_ref='mcp:access'`。
- out-of-scope:AC4(依赖 `ap#226` 收紧步落地,见 §5);打包 RC smoke(L3 随发布节奏)。
- 顺序:T1 部署 + T2 发版(或 dev 构建)之后。

## 5. 与 `alpha-platform#226` 的关系

- 本方案落地后,**一方桌面不再依赖 MCP 面对 `platform_access` 的双接受**(桌面发往 `/mcp`
  的凭证恒为 `mcp_access`)。`ap#226` 准入原文「已发布的桌面版实际以 `mcp_access` 完成过一次
  `tools/call`」由 T4-④ 直接产出,且此后每次正常使用都在 D1 留下
  `caller_ref='mcp:access'` 的持久证据 —— 准入从「等 owner 点一次授权」变成「发版后的日常事实」。
- `ap#226` 票面「只改 tenant-auth 受理 platform_access 那条分支」的前提有误(勘破:该分支同
  时服务 `/v1/*`、account、模型面,`VerifyOpts` 无 MCP-only 关闭旋钮,`tenant-auth.ts:53-60`)
  —— 那是 `#226` 自己的实现问题,本 REQ 不代做;本基线只保证收紧那天一方侧无断裂面。
- `#1188` AC4(收紧后 AC1 仍成立)的证据 = `#226` 落地后重跑 T4-①,一次廉价复测;在此之前
  AC4 悬置不挡本 REQ 其余子票(「验证不挡开发」)。

## 6. 建议(非 AC,不进票面判据)

- consent 页对 `platform` 私有 grant 的文案可顺带提及「云能力(含云 MCP)」——T1 实现方核对
  现文案后自行判断,纯文案不开审计轮。
- alpha-web 侧 CIMD 文档 `oauth/clients/alpha-code-mcp.json` 在 T3 后失去一方消费者;存废
  (对已装 v0.1.3/v0.1.4 的旧交互路是否保留服务)由 owner 裁,人口 ≈ 0(`ap#226` §2),
  倾向退役。
- `credential-ttl.ts` 的 5 分钟注释在 T1 后应点明「桌面路径经参数走 15 分钟,窗口与
  `platform_access` 同级」,公开契约文档同步。
