---
title: "alpha-code#1433 —— 四种账户态下模型到底搜不搜得到"
kind: verification
status: active
owners:
  - alpha-code maintainers
last_reviewed: 2026-09-24
review_after: 2026-12-24
---

# `alpha-code#1433` · 四格 × 搜网

票:[`alpha-code#1433`](https://github.com/jinjunnn/alpha-code/issues/1433)(`[REQ-1414][VERIFY-1]`)·
基线:[`docs/design/2026-09-23-1414-web-tools-account-routing-baseline.md`](../../design/2026-09-23-1414-web-tools-account-routing-baseline.md) §七 / §九

> 票面要求每一格**把两件事分开记**:①模型有没有**真的发出** `tool_calls`;②有没有**拿回结果**。
> 下表每一格都按这两半分开;**跑不到的格标「未测」,不用推导补齐。**

## 0. 一页结论

| 格 | ① 模型发不发 `tool_calls` | ② 本地腿拿不拿得回结果 | ② 云腿 |
| --- | --- | --- | --- |
| 登出 / BYOK | **PASS** —— 真模型发了 `websearch`,原文见 §3 | **PASS** 6/6(§2) | 该态云腿不在场(`#1411` 已定) |
| 登录 + 有额度 | **PASS**(同一驱动句,同一形状) | **PASS** 6/6 | **未测** —— 无有额度账户的登录铸 token(§6.3) |
| 登录 + 无额度 | **PASS** | **PASS** 6/6 | **PASS —— 402 的 wire body 第一次跑出来了**(§6) |
| kill-switch | **反向臂 PASS** —— `websearch` 根本不在工具表里(8 → 7),模型发不出这一发 | **反向臂 PASS** 6/6 全部 `sovereignty_denied`,零出网 | 该态云腿不在场 |

**注**:①那一列在登录两格是用「本地腿在场、云腿不在场」的工具表跑出来的 —— 真实登录态还会**多一个**
`cloud_cloud_web_search`,模型有可能优先选它。这一点在 §8 如实登记,**不当成已测**。

本轮另外抓到四件事,每件都带坐标:

| # | 事实 | 判定 |
| --- | --- | --- |
| A | **kill-switch 打开后,模型改用 `webfetch` 去打 DuckDuckGo / Bing 的结果页,并真的拿回了搜索结果** | **真** —— 在本 runner 里 kill switch 被绕过;在打包版里那两个域撞出网策略代理 `deny/unregistered 403` ⇒ 降级成「用户点一下就能开」。见 §4 |
| B | **Exa 免费 MCP 额度用尽时,拒绝以「成功的搜索结果串」的形状到达模型** | **真** —— 已由主 session 开票 `alpha-code#1445` |
| C | **`#1415` 登记的两个 websearch 端点,第一次被真的出网策略代理判成 `allow`**(反向臂 `example.com` `deny/403`) | **真绿**,见 §5 |
| D | kill-switch 下 `/experimental/tool` 对 provider id **`opencode`** 仍列出 `websearch`(`registry.ts:65` 的无条件析取项) | **判为不可达,不开票** —— 见 §7.2 |

**真模型调用总次数:17 次**,全部打向 `https://api.deepseek.com/v1/chat/completions`
(`deepseek-flash`):3 次废弃的冒烟(驱动句不对,模型选了 `webfetch`)+ 13 次四格中性臂 + 1 次
kill-switch 显式臂。打包实例那两轮 **0 次**(provider 没注册上,见 §7.1)。
云腿那一格 **0 次模型调用**(直接打 MCP / gateway),**0 分钱被扣**(preauth 就被拒了)。

## 1. 被测件与凭据卫生

| 项 | 值 |
| --- | --- |
| 树 | `.worktrees/1433-verify` @ **`aad2f4abb1e4dfbd3dd7991edd76a3796e4ceb7d`**(= `origin/alpha`,含 `#1411`/PR #1442、`#1431`/PR #1441) |
| 生产代码改动 | **零**(`git status` 只有本目录 + `docs/README.md` 一行索引) |
| 打包产物 | `OPENCODE_CHANNEL=prod MODELS_DEV_API_JSON=<abs fixture> bun run --cwd packages/ui-mac build` → **EXIT=0**,`grep -c "built in"` = **3**;`package:mac` → **EXIT=0** → `dist/mac-arm64/Code Puppy.app`(`0.1.16`,`com.tide.alphacode`) |
| 宿主 | macOS 26.3.1 / Darwin 25.3.0 arm64;bun 1.3.14 |

**凭据卫生**(owner 2026-09-24 批准的边界):模型 key 从会话临时目录的 `KEY=VALUE` 文件读进
**runner 进程内存**,只出现在发往 upstream 的 `Authorization` 头里。引擎/app 拿到的是占位串
`ac1433-placeholder-not-a-real-key`。测试账号换来的 token 同样只活在进程内存,结果 JSON 里只留
`sub / aud / scope / ttl / len` 这类不可用于冒充的元信息。

**这条不是声明,是跑过的闸**:收尾脚本对本目录每个文件做逐字节扫描,断言 key 的**完整值、前 12
字节、后 12 字节**三种片段都零命中,并用一根**一定在**的针(`alpha-code#1433`)证明扫描真的读到了
文件 —— 空结果不算通过。

基线对照(四个相关门在本树上真绿):

```
cd packages/ui-mac && bun test src/main/server.test.ts src/main/cloud-web-search.test.ts \
  src/main/websearch-prompt-tool-parity.test.ts src/main/websearch-copies.test.ts
→ 62 pass / 0 fail / 281 expect() / Ran 62 tests across 4 files   EXIT=0
```

（`across 4 files` 的 4 与枚举的 4 相等 —— 本仓「zsh 不分词会静默跑 0 个文件」那条陷阱的核对项。）

## 2. ② 本地腿「拿不拿得回结果」—— 四格 × 3 轮 × 2 provider

[`probe-local-transport.ts`](probe-local-transport.ts) → [`results/local-transport.json`](results/local-transport.json)

入口是**生产自己的传输** `McpWebSearch.call`(`packages/opencode/src/tool/mcp-websearch.ts:330`),
参数与工具叶子 `tool/websearch.ts` 的 `callProvider` 逐字同形,所以主权闸(`call()` 第一句的
`localWebSearchDenied()`)在路径上。

| 格 | 期望 | 实测 |
| --- | --- | --- |
| 登出/BYOK · 登录有额度 · 登录无额度 | 拿到结果 | **18/18 `outcome=result`**(exa 5.1–5.5 KB / parallel 12–16 KB) |
| kill-switch(**反向臂**) | 主权拒绝 | **6/6 `sovereigntyDenied=true`**,`ms ≤ 1`(构造请求**之前**就拒 ⇒ 零出网) |

**反向臂在这里就是判据本身**:前三格全绿证明不了这条探针测得出坏的;kill-switch 在同一条命令上翻红
才使那 18 个绿可读。诚实边界:`#1411` 之后前三格的引擎 env **逐字相同**,所以在本地腿上它们是同一个
测量跑了三遍 —— 逐格列出只因为票面矩阵是按账户态切的。

## 3. ① 模型有没有真的发出 `tool_calls`

[`run-model-cells.ts`](run-model-cells.ts) →
[`results/model-cells-neutral.json`](results/model-cells-neutral.json) ·
[`results/model-cells-explicit-killswitch.json`](results/model-cells-explicit-killswitch.json)

中间那一层是**透明记录代理**,不是桩:它不产生任何响应内容,只把 downstream 的请求体原样转给
`https://api.deepseek.com/v1`、把响应字节原样交回,唯一改写是 `Authorization` 头。

**一个代理同时量到两半,这是本轮的手段设计**:

- ① = upstream **响应**里有没有 `tool_calls`、name 是哪个工具;
- ② = **下一次请求**体里那条 `role:"tool"` 消息的 content(引擎把工具输出喂回模型的唯一形状);
- 辅助轴 = 引擎**请求**体里的 `tools[]` 名单(这一格模型手里到底有哪些工具)。

| 格 | 工具表 | 模型发的 `tool_calls`(原文 `arguments`) | 喂回模型的工具输出 |
| --- | --- | --- | --- |
| 登出/BYOK | 8 个,含 `websearch` | `websearch {"query":"Bun JavaScript runtime 2026","numResults":10}` 与 `{"query":"Bun runtime latest release news","numResults":10}` | 21,146 B / 28,740 B,`Title: Bun v1.4.2 \| Bun Blog URL: https://bun.com/blog/bun-v1.4.2 …` |
| 登录有额度 | 同上 | `websearch` ×2 | 28,740 B / 33,964 B |
| 登录无额度 | 同上 | `websearch` ×2(其中带 `"type":"deep"`) | 28,740 B / 21,712 B |
| **kill-switch** | **7 个,`websearch` 不在其中** | **一发 `websearch` 都没有**(见 §4) | —— |

三格的引擎侧 `engineToolParts` 都是 `tool: "websearch", status: "completed"`,`callID` 与模型
`tool_calls[].id` 同一个 —— 所以那一格是**模型认领的**,不是 runner 注入的。

### 3.1 驱动句被改过一次 —— 改了什么、为什么这不是凑绿

第一版中性句是「bun.sh 上现在的最新稳定版号是多少」。它自带一个**规范 URL**,模型当场选了
`webfetch`(`{"url":"https://bun.sh","format":"markdown"}`,拿回 24,105 B),于是 `websearch`
那一格**根本量不到**。改成「找三个**不同域名**上最近讨论 Bun 的页面」之后 websearch 成了自然选择。

**改的是驱动句,判据一格没松**:判据仍然是「upstream 响应里有没有 name=`websearch` 的 `tool_calls`」
+「下一次请求里有没有 `role:"tool"` 的搜索结果」。那三次废弃的冒烟调用照样计入 §0 的 17 次总数。

## 4. kill-switch 之下,模型自己找到了另一条搜网的路

这是本轮**唯一一条落在「已批基线的不变量」上**的观察。基线 §三 S3 写的是:

> `ALPHA_WEBSEARCH_DISABLE=1` 之后,本地与云两侧都不得有活的 web search 执行路径。

中性驱动句下,kill-switch 那一格模型的五发 `tool_calls` 全是 `webfetch`,**头两发是搜索引擎**:

```
webfetch {"url": "https://duckduckgo.com/html/?q=Bun+JavaScript+runtime+news", "format": "markdown"}
webfetch {"url": "https://www.bing.com/search?q=Bun+JavaScript+runtime+news",  "format": "markdown"}
```

两发都 `status: "completed"`,分别拿回 12,295 B / 12,323 B 的**搜索结果页**,随后它按结果里的链接
`webfetch` 了三篇文章并交出了答案。**在这个 runner 里,web search 这件事完全绕过了 kill switch。**

### 4.1 但在打包版里它撞在哪 —— 实测,不是推断

同一批目的地过**生产的**出网策略代理(§5 同一次运行):

| 目的地 | 代理判决 |
| --- | --- |
| `duckduckgo.com:443` | **`deny / unregistered / 403`** |
| `www.bing.com:443` | **`deny / unregistered / 403`** |

而 `#1412`(PR #1426,已合)给未登记目的地接了**用户当场批准**那条出口。所以打包版里这条路的真实形状是:

> kill switch 关掉的是 `websearch` **工具**;`webfetch` 仍在表里,模型会用它去打搜索引擎;
> 那一步会弹出出网批准询问 —— **用户点「允许」,kill switch 就被绕过了**。

这**不是**「闸门无效」,也**不是**「闸门有效」。它是一道能力闸被降级成一次用户点击。
**本票不修**(VERIFY 只测),判定与处置交主 session。

### 4.2 显式驱动句下模型是诚实的(第二臂)

同一格换成「用你的 web search 工具…**如果你没有 web search 工具就明说**,不要调别的工具」:
模型 **1 次调用、0 个 tool_calls**,回答逐字是

> `I don't have a web search tool available—only a page-fetch (webfetch) tool, which you explicitly excluded. So I can't provide search results.`

⇒ 这一格的行为**由驱动句决定**,而用户现实里说的是中性那句。两臂都入库,只留一臂就是在骗自己。

## 5. `#1415` 的登记第一次被真代理判了一次

[`probe-egress-proxy.ts`](probe-egress-proxy.ts) → [`results/egress-proxy.json`](results/egress-proxy.json)

起的是生产的 `startEgressPolicyProxy`,`authorize` / `requestGrant` / `dial` **一个都没覆盖**
(默认 = `isEgressAuthorizedForSidecar`);端口注入 env 用生产的 `sidecarEgressProxyEnv`。

| 目的地 | 期望 | 代理判决 | 客户端 |
| --- | --- | --- | --- |
| `mcp.exa.ai:443` | allow | `allow / 200`,隧道 682 B ↑ / 5,732 B ↓ | `http=200` |
| `search.parallel.ai:443` | allow | `allow / 200`,隧道 696 B ↑ / 17,130 B ↓ | `http=200` |
| **`example.com:443`(反向臂)** | deny | **`deny / unregistered / 403`** | `curl: (56) CONNECT tunnel failed, response 403` |
| `alpha-cloud.tidelabs.click:443` | allow | `allow / 200` | `http=401`(无凭证,§6.2) |
| `duckduckgo.com:443` / `www.bing.com:443` | deny | **`deny / unregistered / 403`** ×2 | 同反向臂 |

`#1415`(PR #1427)只加了登记表行与派生测试;基线 §九 也没把这一格列为已跑。**现在它是跑出来的。**

**测量手段自己先坏过一次,记在这里**:第一版用 `Bun.spawnSync` 发 curl —— 它阻塞 JS 线程,http
服务器一个连接都 accept 不到,于是**四个目的地全部 20 s 超时、代理日志 0 条**。那组输出长得像
「代理把一切都拦了」。判据是「代理日志为空 = 本次测量作废」,不是「拦住了」。改成异步
`Bun.spawn` 才拿到上表。

## 6. 云腿 · 登录无额度 —— 402 的实际 wire body(基线 §九 第 5 条,已闭合)

[`probe-cloud-402.ts`](probe-cloud-402.ts) → [`results/cloud-402-zero-balance.json`](results/cloud-402-zero-balance.json)

基线原话:「本轮**没有**一个零余额真账户,402 的实际 wire body 从未跑过。」**现在跑过了。**

### 6.1 先证明这个账户真的登录成功了(否则 401 与 402 分不清)

| 判据 | 实测 |
| --- | --- |
| 授权码换令牌 | `POST https://codepuppy.cn/auth/token` → **200**,拿到桌面信封 |
| 令牌身份 | `sub = u_0000000c1433`,`iss = https://auth.tidelabs.click`,`aud = https://alpha-cloud.tidelabs.click/mcp`,`scope = [cloud.dispatch, cloud.read, artifact.read]`,`ttl = 900s` |
| 信封里的 purpose 键 | `model.invoke` · `cloud.dispatch` · `cloud.read` · `artifact.read` · `account.read`(= `DESKTOP_BUNDLE_PURPOSES` 全集) |
| **凭证面是通的** | 同一张 token 打 `tools/list` → **HTTP 200**,拿回六个云工具的完整定义 |

⇒ **这不是 401**。同一个端点在无 token / 假 token / 空 token 下一律 401(§6.2),这里 200 ⇒
后面的拒绝只可能来自额度面。

### 6.2 402 的两层 wire body,两层都入库

**gateway 封印付费路由**(`POST https://alpha-gateway.tidelabs.click/v1/tools/web_search`,
`model.invoke` 与 `cloud.dispatch` 两个 purpose 各打一次,**两次都是 402、body 逐字相同**):

```
HTTP/1.1 402   content-type: application/json
{"error":{"message":"预授权拒绝: 额度不足:本次最大责任 15 fen(会员窗可承接 0),钱包可用余额不够钱包腿 15 fen(含在途预留)","code":"account_wallet_insufficient"}}
```

**到达模型的那一层**(`POST https://alpha-cloud.tidelabs.click/mcp`,`tools/call cloud_web_search`):

```
HTTP/1.1 200   content-type: text/event-stream
event: message
data: {"result":{"content":[{"type":"text","text":"{\"error\":{\"message\":\"预授权拒绝: 额度不足:本次最大责任 15 fen(会员窗可承接 0),钱包可用余额不够钱包腿 15 fen(含在途预留)\",\"code\":\"account_wallet_insufficient\"}}"}],"isError":true},"jsonrpc":"2.0","id":2}
```

**这一格证实了 AC2 的核心断言,而且订正了一个容易读错的地方**:

- `code = account_wallet_insufficient` 是 `contracts/v1/failure-codes.ts` 里**注册过的** `FailureCode`
  —— 基线 AC2 说的「402 的 body 带稳定 `code`」成立,现在是实测;
- **MCP 那一层的 HTTP 状态是 200,不是 402。** 402 只活在 gateway↔cloud-mcp 那一跳;
  `cloud-mcp.ts:261` 的 `text(body, !r.ok)` 把它转成 MCP `isError: true` 的内容块。
  **模型看到的是一条 `isError` 的工具结果,里面原样带着 402 的 body** —— 基线说的「已经是响亮的」
  就是这条路,现在两层都有原文。
- 拒绝里连**责任上界(15 fen)与会员窗(可承接 0)**都说了出来,不是一句泛化的「余额不足」。

### 6.3 这个账户是怎么来的,以及它在生产上留下了什么

owner 2026-09-24 裁决:「你只要写进去一个账号就可以了,它只是一个测试账号而已。」
所以**没有走短信 + Turnstile**,直接在 alpha-web 生产 Postgres 里 INSERT。

**只 INSERT,零 UPDATE,零 DELETE,没碰 owner 的 `u_a3b0aadfe01e`**:

| 写入 | 内容 |
| --- | --- |
| `users` ×1 | `id='u_00000001433'`,`phone='00000001433'`(11 位但以 0 开头 ⇒ 结构上不可能是真手机号),`uid='u_0000000c1433'` |
| `oauth_codes` ×2(**先后两张,用完即被产品自己 DELETE**) | PKCE S256,`client_id='alpha-code'`,`redirect_uri='code-puppy://auth/callback'`,`scope='openid profile platform'`,`resource=''` |

**收工后实读生产库**(两个库各一次):

| 断言 | 实测 |
| --- | --- |
| `users` 总数 | 3 → **4**(只多我这一行) |
| `oauth_codes` 总数 | 13 → **13**(两张授权码都被 `consumeAuthCode` 删掉了,产品自己的单次语义) |
| `device_sessions` for `u_0000000c1433` | **2**(两次 token 交换各建一条,产品自己的 `createSession`) |
| **account 账本 `ledger_facts` for `u_0000000c1433`** | **0**(总数 1361 未变)—— **「被拒的 preauth 零副作用」现在是实测的,不是读注释** |
| account `tenants` for `u_0000000c1433` | **1** —— `getTenant` 查不到就 `seed(id)`,与勘破一致 |
| `payment_orders` for 该用户 | **0** ⇒ 对账 / 收入统计一格不受影响 |

**一处必须订正我自己上一版写错的事**:上一版写「`mcp_access` TTL 是 5 分钟 ⇒ 把 token 交给别人
不可行」。**那句话只对第三方 RFC 路径成立。** 桌面信封走的是
`PLATFORM_ACCESS_TTL_SECONDS`,实测 `ttlSeconds = 900`(15 分钟)——
`app/api/oauth/token/route.ts:60-66` 的注释逐字写了这件事,而我当时没读到那一段就下了结论。

## 7. 打包实例:两格里「工具表」那一半拿到了,「模型回合」那一半被产品自己拦住

[`run-packaged-cells.ts`](run-packaged-cells.ts) →
[`results/packaged-logged-out-byok.json`](results/packaged-logged-out-byok.json) ·
[`results/packaged-kill-switch.json`](results/packaged-kill-switch.json)

隔离与身份(逐轮入库):`onboardingTest: true` + `packaged: true` 自报;CDP 端口监听者∈本轮 spawn
的进程树;开跑前先杀同类残留;真 HOME 六哨兵 mtime **前后逐字相同**;
`alpha-code-state/env/prod/alpha.jsonc` 里 `worktrees` 命中 **0**;收工后同类进程 **0**。

**模型无关的那一半(零凭证、零花费)**:`GET /experimental/tool?provider=…&model=…`,量的是
**打包产物**里由真 `applyWebSearchSovereignty` + 真注入 + 真围栏算出来的工具表。

| provider/model | 登出/BYOK | kill-switch |
| --- | --- | --- |
| `alpha/deepseek-v4-flash`(**真平台 provider**) | `websearch` **在** | **不在** |
| `alpha/claude-sonnet-5` | **在** | **不在** |
| `deepseek/deepseek-flash`(BYOK 预设) | **在** | **不在** |
| `ac1433probe/deepseek-flash`(自定义 id) | **在** | **不在** |
| `opencode/claude-sonnet-4-5` | **在** | **仍然在** ← §7.2 |

⇒ `#1411` 的四格表在**打包产物**上复现(此前只有单测证据)。

### 7.1 `providers.add` 拒收本地回环 base URL ⇒ `#1144` 那套打包取证配方已经失效

两轮都停在同一处,原文:

```json
{"ok": false, "code": "loopback",
 "reason": "the base URL points at this machine (localhost / 127.0.0.1); local services are not supported"}
```

坐标:`packages/ui-mac/src/main/network-egress-derived.ts:96` —— `isLoopbackHost(host)` 判在
scheme **之前**,来自 **owner 2026-09-21 裁决「不再支持本地模型」**。这是**产品的正确行为**,
不是缺陷;但它同时意味着:

> `docs/verification/2026-08-27-req138-1144-real-model-chain/run-real.ts` 用的「注册一个指向
> `http://127.0.0.1:<port>` 的透明记录代理」这条**打包版真模型取证配方,从 `#1381` 之后结构上不可用了**。

所以打包实例上的①那一半**本轮未测**。下一轮要跑它,必须先裁一个形状(三条都不是 VERIFY 票能自己定的):
① 在隔离实例里注册**真** upstream + 真 key(key 会落进隔离树的 `alpha-secrets/`,与本轮的凭据边界冲突,
且丢掉 wire 原文);② 给记录代理配一个**非回环的 https 名字 + 可信证书**;③ 给产品加一个取证用开关
(= 改生产代码,不在本票范围)。

### 7.2 kill-switch 下 `opencode` 那一格仍列出 `websearch` —— 判为不可达,不开票

`packages/opencode/src/tool/registry.ts:63-71`:

```ts
export function webSearchEnabled(providerID: ProviderV2.ID, flags = { exa: false, parallel: false }) {
  return providerID === ProviderV2.ID.opencode || providerID === ProviderV2.ID.make("opencode-go")
    || flags.exa || flags.parallel
}
```

前两个析取项**无条件为真**,而 kill switch 的手段是把 `OPENCODE_ENABLE_EXA` 覆盖写 `"0"`(杀
`flags.exa`)—— 它到不了这两项。实测正是如此:kill-switch 下唯一还列着 `websearch` 的就是
`opencode/claude-sonnet-4-5`。

**过第零问(走我们自己的代码和 runbook,到得了吗?):到不了。** `opencode` 是**上游 Zen** 的
provider id;本产品的模型治理注入的是 `alpha`(`alpha-models.json` 的 `platformProvider.id`)
加 BYOK 预设 `deepseek/zhipuai/alibaba/moonshot` 加用户自定义 id。实测的 `alpha/*` 两行在
kill-switch 下都**不在**。⇒ **不开票**,只把坐标留在这里:哪天 `enabled_providers` 真的收进了
`opencode`,这一行就是活的,而它此刻是死的。

（还有一层纵深没被这一格绕过:`mcp-websearch.ts:343` 的 `localWebSearchDenied()` 在**执行时**拒。
所以即便工具进了表,它也搜不出东西 —— 代价是模型被告知有这个能力然后撞一个错,即 S4 的提示/工具表
同源性,而不是主权破口。**这一句是读代码得出的,本轮没在 `opencode` 那一格上跑过。**)

## 8. 明确未测

| 未测项 | 为什么到不了 |
| --- | --- |
| **② 云腿 · 登录有额度** | 需要一个**有余额**账户的登录铸 token;本轮建的是零余额账户,而给它充值会真的动钱。**注意**:这一格与「无额度」不是同一个判据 —— 它要证明的是放行,不是拒绝 |
| **打包实例上的①(真模型回合)** | `providers.add` 拒收回环 base URL(§7.1) |
| 打包实例上的两个登录格 | 隔离实例必须 `--use-mock-keychain` ⇒ 拿不到登录凭证 |
| 登录态真实工具表下的①(多一个 `cloud_cloud_web_search` 时模型选谁) | 需要登录态的打包/引擎实例,同上 |
| seatbelt 围栏是否强制只能走代理 | 归 `#1334`/`#1337`,不重跑 |
| 打包 sidecar 的 `useEnvProxy()`(`sidecar.ts:145`)是否真生效 | §2 是 bun + 直连,§5 是真代理 + curl;两段都真,但**没有在同一个进程里接起来** |
| `ctx.ask` 会不会拦 websearch | 注入面四个 alpha agent 都写 `websearch: "allow"`(`alpha-config-injection.ts:214/246/279/304`)—— **读代码得出,本轮没跑** |

## 9. 复现

```bash
# ② 本地腿传输(四格 × 3 轮 × 2 provider)
cp docs/verification/2026-09-24-1433-four-account-states-websearch/probe-local-transport.ts \
   packages/opencode/probe-1433-local.ts
cd packages/opencode && bun run probe-1433-local.ts < /dev/null

# ① 真模型四格(需要一份 KEY=VALUE 的 key 文件;key 不入任何产物)
cp docs/verification/2026-09-24-1433-four-account-states-websearch/run-model-cells.ts \
   packages/opencode/run-1433-cells.ts
cd packages/opencode && bun run run-1433-cells.ts --keys-file <abs> \
   --provider deepseek --model deepseek-flash --drive neutral --out <abs>.json < /dev/null

# ③ 出网策略代理判决(含反向臂)
cp docs/verification/2026-09-24-1433-four-account-states-websearch/probe-egress-proxy.ts \
   packages/ui-mac/probe-1433-egress.ts
cd packages/ui-mac && bun run probe-1433-egress.ts < /dev/null

# ④ 云腿凭证面(无需任何凭证)
bash docs/verification/2026-09-24-1433-four-account-states-websearch/probe-cloud-auth.sh

# ⑤ 云腿 402(需要一张给零余额账户的 PKCE 授权码,见 §6.3)
bun docs/verification/2026-09-24-1433-four-account-states-websearch/probe-cloud-402.ts \
   --code <code> --verifier <verifier> --out <abs>.json

# ⑥ 打包实例两格(先 build + package:mac,然后**必须** ad-hoc 重签,见下)
codesign --force --deep --sign - "packages/ui-mac/dist/mac-arm64/Code Puppy.app"
bun docs/verification/2026-09-24-1433-four-account-states-websearch/run-packaged-cells.ts \
   --app "$PWD/packages/ui-mac/dist/mac-arm64/Code Puppy.app" --cell kill-switch --keys-file <abs>
```

两个 `.ts` 探针必须先 `cp` 进对应的包:`effect` 与 ui-mac 的模块只在各自 `packages/*/node_modules`
下,从 `docs/` 直接跑会 `Cannot find package 'effect'`。`run-packaged-cells.ts` 与
`probe-cloud-402.ts` 只用 node 内置模块,可以原地跑。

### 9.1 打包取证踩的两个坑(下一轮直接照抄)

1. **`package:mac` 产出的 `.app` 签名是坏的,直接起会被内核 `Killed: 9`。** 实读:
   `codesign -dv` 给 `Identifier=Electron`、`flags=0x20002(adhoc,linker-signed)`,
   `codesign --verify` 报 *code has no resources but signature indicates they must be present*
   —— electron-builder 没有重签 bundle。`codesign --force --deep --sign -` 之后变成
   `Identifier=com.tide.alphacode` / `flags=0x2(adhoc)`,与 `#1144` 记录的形状一致,才起得来。
2. **隔离 HOME 的 `.zshrc` 必须导出生产的那个 `TMPDIR`,不能是空文件。** 少这一行的症状是:
   app 起得来、`onboardingTest: true`、CDP 端口在听,但 `/json/list` **恒 `[]`**(没有 page),
   日志里是 `EPERM: mkdir '<ISO>/tmp/opencode'` → `sidecar spawn failed before health handshake`。
   那个 EPERM 是**围栏在拒**(`$TMPDIR/opencode` 不在可写集里),而症状看起来像「ad-hoc 签名把 app
   弄坏了」。`#1323` §2.2 早写了这一行,照抄就行:`export TMPDIR="$(getconf DARWIN_USER_TEMP_DIR)"`。
