# REQ-236 T20:联网方式、网页读取/搜索路径与分层网络诊断(方案基线)

- 父需求:alpha-work#118 REQ-236 的 T20(父 AC7 的网络部分;运行时证据进 AC8 / T23)。
- 源码基线:alpha-code 0.1.22 = `393a35c2a`(本 worktree 只比它多三份文档提交,
  `git diff --stat 393a35c2a HEAD` = `docs/README.md` + `docs/design/codepuppy-runtime-authority.md`);
  alpha-platform `1bcfe09`。owner 机器只读日志:`~/Library/Application Support/ai.opencode.desktop/logs/`、
  `~/.local/share/opencode/log/opencode.log`。
- `docs/architecture/constraints.md` 不存在(`git ls-files | grep -i constraints` 无输出,exit=1),
  没有可对照的「已知偏离」;本方案不新增偏离。
- 冻结输入:目录与模型方案 `req236-catalog-and-model.md`(renderer↔引擎 loopback 排队 = 它的 V1/C3b);
  引擎生命周期方案 `req236-engine-lifecycle.md`(MCP 逐服务启动、各阶段预算、具名失败 = 它的 #2);
  权限与来源方案(出网围栏的权限面)。本文只在接口处写明假设。

## 0. 结论先行

1. **范围结论:窄修,一张 CODE 票。** 旧票的网页/搜索能力在 0.1.22 的代码里都已落地(§1.1),但 `#1414` 的
   AC1 与 AC2 **都没有完整证据**(AC2 的「响亮拒绝并落到本地腿」从未在真实登录、双腿在场的状态下跑过),缺的格归 T23
   并回写 `#1414`;真正的新缺陷只有一类:**联网失败今天说不出是哪一层坏了**,而 owner 自己的日志里已经有
   「隧道开了、上游零回应」被当成普通超时的实例(§1.5)。这张票含一个对出网代理的**主动断连**(§2.2 N2 第 4 条),
   碰安全设施,按尺寸规则计 **L**、独立 PR;去掉主动断连可回到 M(Codex R1 OPTIONAL,未采纳,见 §2.4)。
2. 选定:让本机出网代理把它**唯一知道**的那几层(策略、域名解析、连接)用 undici 丢不掉的状态码交出来;在**信息丢失
   之前的结算边界**取层(引擎的工具/回合结算、main 的各请求出口),一路带到最终上屏的那句话(§2)。
3. 对生命周期 #2 的接口依赖:远端 MCP 的失败码按本文分层、网络类失败由 #2 有界后台恢复(编排器已并入 #2,
   本文只写接口,§1.6、§2.3)。
4. 本版按 Codex 方案审 R1(唯一一轮)修订:F1–F7 与 Q1–Q5 的落点见文末「方案审 R1 处置」。

## 1. 只读勘破

### 1.1 三张旧票逐条核(0.1.22 代码)

票面由 `gh issue view <n> -R jinjunnn/alpha-code --json title,state,closedAt,body,comments` 导出后逐条读。

| 票 | 原 AC / 原承诺 | 0.1.22 是否成立 | 坐标 / 证据 | 处置(原票身份) |
| --- | --- | --- | --- | --- |
| `#1414`(OPEN)本地与云都能读网页、搜网,按账户选路 | AC1 有额度与无额度账户都能读到网页、搜到结果 | **代码路径都在,运行时只证了一半** | 本地搜网不再随登录被关:`packages/ui-mac/src/main/server.ts:366`(`applyWebSearchSovereignty`,注释写明 `#1411` 删掉了 `platformPays` 那一半);两个本地搜网端点已登记:`network-egress-registry.ts:117-118`;本地读网页走「用户当场批准目的地」:`network-egress-proxy.ts:211-238` + `egress-approval-dialog.ts`(`#1412`);云端读网页已上线:alpha-platform `1bcfe09:packages/gateway/src/cloud-mcp.ts:320-323`(`cloud_web_fetch`,ap#486 CLOSED 2026-09-24),云端搜网 `:289-290` | 不新开需求。缺的格进 T23(§4 表二),结果贴 `#1414`,由 owner 按 AC 关 |
| 同上 | AC2 无额度时,到达云 web 工具的通路在单一咽喉点**响亮拒绝并落到本地腿**,不是静默失败(票面原文) | **一半有证据:拒绝那一半成立,「落到本地腿」未证** | 402 原文已取到(`docs/verification/2026-09-24-1433-four-account-states-websearch/README.md` §6);本地腿在场由 `server.ts:366` 保证。但同一 README `:28-29` 明写:登录两格的模型回合用的是「本地腿在场、**云腿不在场**」的工具表,真实登录态会多一个 `cloud_cloud_web_search`,模型可能先选它 —— 「先撞 402、再改走本地腿、拿回内容」从未跑过 | 不新增桌面选路器,不重开 `#1433`;T23 补「登录 + 零余额 + 双腿在场」格(§4 表二),结果贴 `#1414` |
| 同上 | AC3 ADR-009 显式 supersede,决策文件与代码一致 | 成立 | `.claude/rules/adrs/ADR-009-websearch-default.md` frontmatter `status: superseded` / `superseded-by: ADR-046`;`ADR-046-web-tools-two-legs-account-routing.md` 存在;`websearch-copies.test.ts` 在 | 无动作 |
| `#1433`(CLOSED)四种账户态下搜不搜得到 | 矩阵 {登出, 有额度, 无额度, kill-switch} × 搜网 | 三格真绿;**「登录有额度·云腿」未测**;打包实例上的真模型回合未测 | 票面收口评论(2026-09-24T13:03)原文 | VERIFY 票已按「未测如实写」关闭,不重开;未测格并入 `#1414` 的 T23 格 |
| `#1500`(CLOSED)代理节点模型清单短暂超时后自愈 | AC1 首试超时后后台补试一次且不拖住首轮 | 成立 | `alpha-platform-models.ts:160-165`(仅 `timeout` 且 `current()` 才在 1 s 后补试一次) | 无动作 |
| 同上 | AC2 连续超时最多 2 次 GET,旧缓存与 BYOK 可用 | 成立 | 补试只排一次(`:161-165`);失败不写 LKG(`:128-131`);BYOK 段不读平台失败态(`:173-185`) | 无动作 |
| 同上 | AC3 timeout 明确标为 timeout,有安全完成记录 | 成立,**但只到 timeout 为止** | `:99` `TimeoutError → "timeout"`,其余一律 `"network"`;`:100-111` 只记 `error.name`(DNS、拒连、握手失败全都记成 `TypeError`) | 原票刻意只做 timeout(其 AC3 原文「不能为了做分类而伪造未知 DNS/TLS 样本」);分层分类是本基线 §2 的新范围,不回写 `#1500` |
| 同上 | AC4 旧补试不覆盖新状态 | 成立 | `:119-121` 序号 + 身份标签,`:124` 旧轮不上报 | 无动作。注意目录 lane C1 会把这段搬进 `catalog-refresher.ts` 并「沿用 `:160-165`」 |

另:`#1414` 的四张子票 `#1411/#1431/#1432/#1433` 全部 CLOSED(`gh issue list --search "REQ-1414 in:title" --state all`),父票仍 OPEN,因为 AC1 与 AC2 的证据都没齐。

### 1.2 App 怎么联网:三个进程三条路,没有「在线」判断

**没有任何「联网/在线」判断。** `grep -rn -E "navigator\.onLine|net\.isOnline|\"online\"|addEventListener\(\"offline|isOnline\(" --include='*.ts' --include='*.tsx' packages/ui-mac/src packages/ext/src packages/plugin/src`
唯一命中是 `packages/ext/src/cloud-websearch-kill.ts:161`(搜索引擎词表里的单词 "online")。每个请求各自发现失败。

| 进程 | 出网怎么走 | 走不走系统代理 | 坐标 |
| --- | --- | --- | --- |
| renderer(Chromium 网络栈) | 只连本机引擎 `127.0.0.1:<port>`,另有少量远端资源 | 走 macOS 系统代理设置。`<-loopback>` 的含义是**撤销** Chromium 对 loopback 的隐式绕过规则([Chromium 代理说明 · overriding the implicit bypass rules](https://chromium.googlesource.com/chromium/src/+/main/net/docs/proxy.md#overriding-the-implicit-bypass-rules)):在适用的手工/PAC 系统代理配置下,发往 `127.0.0.1` 的请求**可以**进入代理。owner 机器系统代理全关(下方 `scutil`),所以此刻不适用,但不能据此推广 | `main/index.ts:583` `proxy-bypass-list <-loopback>` |
| main(Electron 内置 Node 的 `fetch`) | 目录、账户、云任务、产物下载等直接 `fetch` | **只认进程环境变量** `HTTP(S)_PROXY`(`http.setGlobalProxyFromEnv()`;Codex R1 读 Electron 42.3.3 内嵌源码确认它同时设置 fetch 的全局 dispatcher),不读 macOS 系统代理设置;从 Finder/Dock 启动时通常没有这些变量 ⇒ 直连 | `main/index.ts:209-216, 581-582, 1265-1266, 1501-1502` |
| 引擎 sidecar 及其全部子进程 | 进程围栏只放行本机出网代理一个端口,代理变量被**整份改写**为该代理 | 用户自己的代理变量被丢弃(注释原文举例「本机 7897 的系统代理」) | `sidecar-env.ts:268-296`;`sidecar.ts:145-147, 264-270` |
| 本机出网代理(main 内) | 对每条 `CONNECT host:port` 查授权 → `net.connect({host, port, autoSelectFamily:true})` **直接拨号**;DNS 只在这里发生 | **不走**任何代理(既不读环境变量也不读系统设置) | `network-egress-proxy.ts:142-145, 240-277` |

本机拓扑实测(只读):

```
$ scutil --proxy                → HTTPEnable 0 / HTTPSEnable 0 / SOCKSEnable 0 / ProxyAutoConfigEnable 0
$ dscacheutil -q host -a name …
  alpha-gateway.tidelabs.click → 104.21.25.115 172.67.134.49      (真实 Cloudflare 地址,直连规则)
  alpha-cloud.tidelabs.click   → 172.67.134.49 104.21.25.115      (同上)
  mcp.exa.ai                   → 198.18.12.178                    (fake-IP)
  search.parallel.ai           → 198.18.12.179                    (fake-IP)
  api.deepseek.com             → 198.18.11.229                    (fake-IP)
$ ifconfig | grep ^utun        → utun0…utun5 均 UP
```

即 owner 这台机器是「系统代理关、TUN 接管、按规则分直连与 fake-IP」。所以 main 与出网代理的「直连」实际上
被 TUN 按规则接走。**这是本机结论,不搬到生产。** 另一种拓扑(只开系统 HTTP 代理、不开 TUN)下,renderer 走代理而
main 与引擎直连,两边看到的网络不一样;今天没有承受者(除 owner 本机外零租户),本方案不为它设计,只记为事实。

### 1.3 网页读取与搜索:本地与云端各走哪条路,按账户态怎么选

alpha-platform#552(2026-10-27,owner「网页也只走本地」)停用的是**云端生成网页**(`html-generate`)与云端 Office,
不是读网页/搜网:`1bcfe09` 的 `cloud-mcp.ts` 仍挂着 `cloud_web_search`(`:289-290`)与 `cloud_web_fetch`(`:320-323`)。

| 能力 | 本地腿 | 云腿 | 选路 |
| --- | --- | --- | --- |
| 搜网 | 引擎 `websearch` → `mcp-websearch.ts`(Exa / Parallel 远端 MCP,预算 `websearch.ts:98,115` 的 25 s)→ 出网代理(两个端点已登记) | `cloud_cloud_web_search` → 网关 → account 逐次 preauth(无额度 402) | 本地腿恒在,只有 kill-switch 能关(`server.ts:366`);云腿在不在 = `platformPays`(`alpha-config-injection.ts:102`,`ALPHA_CLOUD_MCP_URL` + `ALPHA_MCP_TOKEN` 文件);随包技能要求「先用本机,本机不可用才用云」(`resources/factory-skills/cloud-capabilities/SKILL.md:19`) |
| 读网页 | 引擎 `webfetch`(默认 30 s,上限 120 s,`opencode/src/tool/webfetch.ts:10-11,50`)→ 出网代理:目的地不在名单 ⇒ 原生对话框问用户 ⇒ 允许才拨号(`network-egress-proxy.ts:211-238`) | `cloud_cloud_web_fetch`(按次计费,SSRF 闸) | 同上;登出/BYOK 只有本地腿 |

证据状态(这是 T20「验证本地和云端读取网页/搜索路径」今天的真实位置):

| 格 | 现有证据 |
| --- | --- |
| 本地搜网 | `#1433`:传输 18/18、真模型三格;**非打包实例** |
| 云搜网·无额度 | `#1433`:402 原文入库(传输层);模型回合在「云腿不在场」的工具表上跑,**双腿在场时撞 402 后是否落到本地腿未测** |
| 云搜网·有额度 | **未测** |
| 本地读网页(批准对话框) | `docs/verification/` 下无记录(`ls docs/verification \| grep -E "1412\|webfetch"` 无输出) |
| 云读网页 | 桌面仓无验证记录;平台侧未核 |

owner 近五天的实际使用:`for d in $(ls logs); do grep -c "mcp.exa.ai\|search.parallel.ai" …; grep -c egress.grant …; done`
对 20261026T115613 … 20261030T030353 共 8 个会话全部为 0 —— 这五天里本地搜网与本地读网页**一次都没有出过网**,
所以日志给不出它们今天能不能用的证据,只能靠 T23 实跑。

### 1.4 分层现状:每层在哪被捕获、归成什么、用户看到什么

| 层 | 发起方 | 预算 / 重试 | 捕获点 | 归成什么 | 用户看到 |
| --- | --- | --- | --- | --- | --- |
| loopback renderer→引擎 | renderer `model-contract` 等 | 屏障单探针 1 s、列表 10 s、恢复 1/2/4/8 s 无上限 | 目录 lane §1.1 | `ModelContractError` | 「正在同步…」(目录 lane C3a 改) |
| 本机出网代理:策略 | 引擎任意客户端 | — | `network-egress-proxy.ts:211-238` | 403 `unregistered`,正文带理由 | **正文被 undici 丢掉**,引擎只拿到 `Proxy response (403) !== 200 when HTTP Tunneling`(`docs/architecture/2026-09-23-webfetch-egress-decision-chain.md` §4) |
| 本机出网代理:DNS | 同上 | 无单独预算 | `:272-277` | 502 `dial-failed` detail=`ENOTFOUND` | 引擎只拿到 `Proxy response (502)`,与拒连、拨号超时**同一个码** |
| 本机出网代理:TCP | 同上 | 拨号 10 s(`:181, 244-246`) | `:244-277` | 502 `dial-failed` detail=`ECONNREFUSED`/`ETIMEDOUT` | 同上 |
| TLS(隧道内,端到端) | 引擎客户端 | 目标 TLS connector 10 s(Codex R1 读 Electron 42.3.3 内嵌 undici 7.24.4:CONNECT 应答由 headers timeout 管、默认 300 s;**只有 200 之后**才启动目标 TLS connector,用连接期限 10 s;两者不共用倒计时,与代理拨号 10 s 也不赛跑);**代理侧无任何约束** | 只有客户端知道 | undici `Connect Timeout Error` / `ECONNRESET`;代理侧只记一条 `allow 200`,关隧道时记 `bytesDown` | 远端 MCP:`failed` 带原文;**界面只剩 `cloud MCP failed`**(`hub-view.ts:289`,`ext-mcp-activation.ts:216-221` 丢掉 error 串) |
| HTTP | 各客户端 | 各自 | 各自 | main:`httpErrorCode`(`platform-error-code.ts`);MCP SDK:HTTP 错误原文 | 视调用方 |
| MCP initialize | 引擎 `mcp/index.ts` | 每次 30 s(`:41, 335`),StreamableHTTP 3 次(0 / 0.5 s / 1 s)只对传输错误重试,再 SSE 1 次;最坏 121.5 s | `:341-397`(`#1547`) | `failed` + `describeError` 原文;认作传输错误的只有 `UND_ERR_CONNECT_TIMEOUT`/`UND_ERR_SOCKET`/`ECONNRESET` 与自身超时(`:42-56`) | 同上 |
| MCP tools/list | 引擎 `mcp/catalog.ts:4-5` | 30 s,**失败被吞成空**(`Effect.catch(() => Effect.void)`)→ `Failed to get tools` | `mcp/index.ts:456-459` | `failed: Failed to get tools` | 同上 |
| MCP 工具调用 | 引擎 | `requestTimeout`(配置 / `experimental.mcp_timeout`) | `mcp/index.ts:732-769` | 工具错误 | 工具卡原文 |
| main 直连 fetch | 目录 / 云任务 / 账户 / 日程 / 产物下载 | 8 s / 15 s / … | `alpha-platform-models.ts:99`、`alpha-cloud-jobs.ts:109,167`、`alpha-account-request.ts:74`、`alpha-cloud-schedules.ts:60`、`alpha-artifact-download.ts:338,417,419` | **一律 `"network"`**(产物下载另带脱敏 detail) | `alpha.ext.cloudErrNetwork`(`renderer/extensions/cloud-job-lifecycle.ts:39`、`renderer/automations/schedule-refusal-copy.ts:56`)。即使 catch 处多带一个字段,今天也到不了屏幕:日程的三个拒绝出口重新组装对象(`alpha-cloud-schedules.ts:102,114,121` 只留 `reason`/`code`)、IPC 再组装一次(`automation-ipc.ts:42`)、面板只传 `r.code`(`automation-panel.tsx:301`);云任务派发只把 `result.error` 交给文案(`cloud-form-box.tsx:75`) |
| 模型请求 / 工具传输错误 | 引擎 | provider `timeoutFetch`(`provider/provider.ts:96-121`);`webfetch` 经 Effect HTTP | **工具**:`webfetch` 收到代理拒绝后,Effect `FetchHttpClient` 把 undici 错误包成 `HttpClientError`(原错误挂在 `reason.cause`),`message` 只剩 `Transport error (GET …)`;`session/processor.ts:200-214` 的 `failToolCall` 再用 `errorMessage(error)`(`tui/src/util/error.ts:136-140`)**只存顶层 message** —— cause 在这里丢失。**回合**:`processor.ts:131-135` 经 `MessageV2.fromError` 结算进 `AssistantMessage.error` | 回合级只认得出策略拒绝,且只认**正文**(`shared/egress-denial.ts:51-66`)——出货引擎跑在 Node 上,正文到不了 | 「Transport error …」与「那个网站打不开」同形;回合错误卡 `tool-cards.tsx:788-800`、工具卡 `tool-card-model.ts:962-967` |

读法:**出网代理是唯一同时知道「授权了没有、域名解没解出来、TCP 通没通、对端回没回过一个字节」的地方**,
而它今天交给引擎的只有一个状态码,其中三种完全不同的失败共用 502。

### 1.5 实测:「CONNECT 200」不是成功

**(a) 一个不存在的域名,DNS 与 TCP 都「成功」。** 公共解析确认它没有 A 记录:
`curl -H 'accept: application/dns-json' 'https://dns.alidns.com/resolve?name=nx-req236-probe-7f3a.example.com&type=1'` → `"Status":3`(NXDOMAIN);
dns.google 返回 `Status 0` 且无 Answer。本机:

```
$ curl --noproxy '*' -w "ip=%{remote_ip} dns=%{time_namelookup}s tcp=%{time_connect}s tls=%{time_appconnect}s http=%{http_code}" https://nx-req236-probe-7f3a.example.com/
curl: (35) LibreSSL SSL_connect: SSL_ERROR_SYSCALL
ip=198.18.12.180 dns=0.003370s tcp=0.003810s tls=0.000000s http=000
```

**(b) 照出网代理的拨号方式重放**(`net.connect({host, port, autoSelectFamily:true})`,再在同一 socket 上 `tls.connect`;
脚本见附录 A1,node v22.22.3):

```
## nx-req236-probe-7f3a.example.com
dns   7.4ms 198.18.12.180 (fake-IP range 198.18.0.0/15)
tcp   connected 11.5ms remote=198.18.12.180  <- 代理此刻写出 "200 Connection Established"
tls   error 172.2ms code=ECONNRESET msg=Client network socket disconnected before secure TLS connection was established
## mcp.exa.ai
tcp   connected 13.3ms remote=198.18.12.178  …  tls ok 192.2ms authorized=true
## alpha-cloud.tidelabs.click
tcp   connected 15.1ms remote=2606:4700:3034::ac43:8631  …  tls ok 641.1ms authorized=true
```

所以在 fake-IP 下,代理写出 200 只证明「本机 TUN 接了 TCP」;第一份**真的来自远端**的证据是 TLS 握手完成。

**(c) owner 生产日志里,直连的 Cloudflare 也会「200 之后零回应」。** 对 `main.log` 的 `network egress` 记录聚合
(按每次 respawn 分代配对 `egress.connect allow` 与 `egress.tunnel-closed`;脚本见附录 A2):

```
20261030T021718  alpha-cloud.tidelabs.click  allow200=127  bytesDown=0 关闭=6   (中位 15.0 s 才关)
                 github.com                  allow200=57   bytesDown=0 关闭=3
                 pypi.org                    allow200=100  bytesDown=0 关闭=3;另有 deny dial-failed 502 ENOTFOUND ×1
20261028T033016  alpha-cloud.tidelabs.click  allow200=700  bytesDown=0 关闭=29  (中位 16.0 s)
                 pypi.org                    allow200=558  bytesDown=0 关闭=34
```

其中一条 `alpha-cloud` 隧道(`main.log:368,542`,id=60)`03:10:24.667Z` 打开(bytesUp=517)、`03:22:32.875Z` 才关、
`bytesDown=0` —— **一条上游零回应的隧道挂了 12 分钟**,时刻正落在目录 lane 样本 A 的窗口里。它属于哪个客户端**无法归属**:
代理记录没有客户端/请求关联字段;Codex R1 核过的候选(MCP SDK 1.29.0 的 SSE、EventSource 3.0.7、`ext/src/cloud-vision.ts:141-148`、
引擎 Effect HTTP)全都走 fetch,不能据此断定是哪一个、也不能断定它们没有握手期限。本文把它当作「**未归属的静默隧道**」处理。

**(d) 云连接器每一次「连接超时」,代理那一侧都只有 `allow 200`。** `opencode.log` 里 0.1.22 之后带原因的 5 次云 MCP 失败
(`#1547` 之前的 74 次 `server unavailable` 不带 error 字段,无法归因):

```
4 × failed "fetch failed: Connect Timeout Error (attempted address: alpha-cloud.tidelabs.click:443, timeout: 10000ms)"
1 × failed "Operation timed out after 30000ms"
```

把每次失败前 40 s 内的 `alpha-cloud` 代理记录对齐:5 次全部只有 `egress.connect … allow 200`,**零条 deny、零条 502**。
结合 undici 的计时分工(§1.4 TLS 行:目标 TLS connector 只在 CONNECT 200 之后启动),这 4 次 `Connect Timeout` 是
「代理已回 200、目标 TLS 10 s 内没完成」;`Operation timed out after 30000ms` 只说明整个 `client.connect()` 预算耗尽
(`mcp/index.ts:281`,含 CONNECT 前可能的审批等待),**不能**据此断言已进入 initialize。今天的日志结构做不到把哪条隧道属于哪个客户端对上
(同一主机有云 MCP、云识图 `cloud vision: provider list unavailable (fetch failed)`(`server.log:26,34`)、云任务等多个客户端)。

### 1.6 与兄弟方案的预算对账

- **生命周期 #2 的失败码**:`workspace_missing | dependency_missing | spawn_failed | handshake_timeout | tools_list_failed | transport | auth`
  (其 §2.2 第 1 条)。远端的 `transport` 把「本机策略拒绝 / 解析不了 / 连不上 / 握手无回应」合成一个码 ——
  正是 T20 禁止的泛化归类。**对不上** ⇒ 接口依赖:#2 的远端失败码按 §2.2 的分层表产出(由本票的分类模块给出)。
- **生命周期 #2 的预算**:连接 + initialize = `mcp.timeout ?? 30s`、tools/list = 现有 catalog 超时、调用 = `requestTimeout`。
  与实际嵌套对得上,外面还有两层:目标 TLS connector 10 s(CONNECT 200 之后才起算)与出网代理拨号 10 s,两者不赛跑
  (§1.4)。`Operation timed out after 30000ms` 只证明整个 `client.connect()` 预算耗尽,其中可能含 CONNECT 前的审批等待,
  所以它归「连接/初始化预算耗尽」(§2.2 的 `timeout`),有阶段证据时才进一步细分;本文不再把它等同于「TLS 已完成、initialize 没回」。
- **生命周期 #2 的恢复**:远端传输错误「沿用 `#1547` 的连接内重试,之后同样停在 `failed`,直到配置变化、用户重试或实例重建」。
  今天这句话的实际效果靠每 10 分钟一次的 token-only 换代兜底(换代 = 实例重建 = 重连);renderer 只在云条目
  `disabled` 时补发连接(`renderer/extensions/use-extensions.ts:645-660`),`failed` 时不发。生命周期 #1 去掉续期换代之后,
  一次网络抖动造成的云连接器失败**缺少自动恢复**(出口只剩配置变化、用户手动连接、结构性实例重建)。编排器已把有界后台恢复
  并入 #2;本文只写接口依赖(§2.3)。
- **目录 lane 的 H3「loopback 代理/围栏」不能在代码层排除。** `<-loopback>` 撤销的是隐式 loopback 绕过(§1.2 renderer 行),
  在适用的系统代理配置下 renderer 对引擎的请求可能进代理;owner 当前 TUN 样本不能推广。H3 留给目录 lane V1,用实际代理解析
  事件 / netlog 判定。能确定的只有:引擎侧 `NO_PROXY` 固定含三个 loopback 名(`sidecar-env.ts:280`),本机出网代理不在
  renderer↔引擎路径上。
- **给目录 lane V1 的现成开关**:打包版已有 Chromium netlog,环境变量 `ALPHA_NETLOG=1` 打开,落在本次 run 目录的
  `network.netlog`(`main/logging.ts:51-57`),其中包含代理解析事件,可直接回答 H3。

### 1.7 架构稿(`codepuppy-runtime-authority.md`)本范围断言复核

| 位置 | 断言 | 复核 |
| --- | --- | --- |
| §1 表「目录刷新」行 | `alpha-platform-models.ts:121` 有序号与身份仲裁、一次后台超时补试;`:64` 单次 8 s | **对**(仲裁在 `:119-121`,8 s 在 `:65`,补试 `:160-165`) |
| §3 表「网络与重试」行 | loopback、远端 DNS/TCP/TLS/HTTP、MCP 协议阶段分别归因;超时取消底层请求;不能把 CONNECT 200 当完整成功 | 方向**对**;「超时取消底层请求」今天至少有一个反例:§1.5(c) 的 12 分钟未归属静默隧道(哪个客户端没取消,无法归属) |
| §2.3 | 分别设定准备、握手、tools/list、调用预算 | **对**;补充:tools/list 失败今天被吞成空再报 `Failed to get tools`(`mcp/catalog.ts:5`),原因丢失 |

## 2. 选定方案与被否决的替代

### 2.1 先回答反问:能否让本系统成为权威、让外部无从覆盖?

**能,而且权威已经在我们手里:本机出网代理。** 引擎的全部出网都被围栏逼到它这里,DNS 只在它里面发生,
TCP 由它拨,隧道里每一个字节它都经手。所以「策略 / 域名解析 / 连接」三件事,**代理的判定就是事实本身**,
不需要任何客户端去猜;「上游回没回过字节」它也知道,但那只说明有字节(TLS Alert 也算),不等于握手成功。
TLS 握手与 HTTP 回应是端到端的,只有发起它的客户端知道 —— 这一层**消费客户端自己的报错**,不解释、不预测。

红旗检查:要跟外部「保持一致」的只有两样形状 —— undici 对隧道失败的报错原文(`Proxy response (NNN) !== 200 when HTTP Tunneling`、
`Connect Timeout Error (attempted address: …)`)与 Effect HTTP 把原错误挂在哪里(`HttpClientError.reason.cause`)。这不是手写替身:
分类与结算的测试从**真工具入口经真出网代理走到持久化的 ToolPart**(§4 证据列),装着的版本改了形状,测试当场红。

### 2.2 选定:一个分类模块,三处产出,在信息丢失前结算,一路带到屏幕

**N1 分类模块(单一权威)。** 新文件 `packages/plugin/src/alpha-net-failure.ts`,在 `packages/plugin/package.json` 的 `exports`
加一行 `"./alpha-net-failure"`。先例是同包的 `./alpha-cloud-authority`(提交 `19bdae9ff` 同样只加一个文件与一行 export;
引擎 `opencode/src/mcp/index.ts:38` 与 `packages/ext` 都从这里 import)。模块零运行期依赖(不 import 任何 node 模块),
renderer 只 import 它的类型与文案键。**不放 `packages/schema`**:该包只承载可序列化的线上/存储合同(`packages/schema/AGENTS.md:3`)。导出:

- `NetFailureLayer = "policy" | "dns" | "tcp" | "connect-timeout" | "tls-silent" | "tls-failed" | "tls-cert" | "http" | "timeout"`;
- `EGRESS_DIAL_FAILURE_STATUS`:出网代理拨号失败按层用的状态码 —— 域名解析 `503`、拒连/不可达 `502`、拨号超时 `504`;策略 `403` 不变;
- `classifyNetFailure(error: unknown, path: { via: "egress-proxy"; proxyOrigin: string } | { via: "other" }): { layer; code } | undefined`
  —— 纯函数,沿 `cause` 与 `reason.cause` 链最多走 5 层,只读 `name`、`message`、`code` 与 undici 原文里的状态码/尝试地址;
  返回的 `code` 只是错误码(`ENOTFOUND`、`UND_ERR_CONNECT_TIMEOUT`、`CERT_HAS_EXPIRED`、`503`…),从不含 URL 查询、头或正文。
  引擎侧调用方传 `{via:"egress-proxy", proxyOrigin}`(sidecar 的代理变量恒为出网代理,`sidecar-env.ts:283-296`;目标是 loopback 时按 `other`);
  main 侧传 `{via:"other"}`。

映射(实现照此表,测试逐行覆盖;**没有阶段证据就不声称阶段**):

| 输入(真栈实测形状) | 经出网代理 | 其它路径(main 直连 / 环境代理) |
| --- | --- | --- |
| `Proxy response (403)` | `policy` | — |
| `Proxy response (503)`;`ENOTFOUND` / `EAI_AGAIN` / `EAI_NONAME` | `dns` | `dns` |
| `Proxy response (502)` / `(504)`;`ECONNREFUSED` / `EHOSTUNREACH` / `ENETUNREACH` | `tcp` | `tcp` |
| `UND_ERR_CONNECT_TIMEOUT` 且尝试地址是目标主机 | `tls-silent`(目标 TLS connector 只在 CONNECT 200 之后启动,§1.4) | `connect-timeout`(TCP 与 TLS 共用这个计时器,不断言 TCP 已通) |
| `UND_ERR_CONNECT_TIMEOUT` 且尝试地址是代理本身 | `connect-timeout` | — |
| `ECONNRESET` 且消息含 `before secure TLS connection`;`ERR_SSL_*` | `tls-failed` | `tls-failed` |
| `CERT_*`、`ERR_TLS_CERT_ALTNAME_INVALID`、`UNABLE_TO_VERIFY_LEAF_SIGNATURE`、`*SELF_SIGNED*` | `tls-cert` | `tls-cert` |
| 有 HTTP 状态的应答(调用方已有 `httpErrorCode` 的照旧) | `http` | `http` |
| `TimeoutError`(`AbortSignal.timeout` 整体预算到期)、MCP `Operation timed out after Nms` | `timeout`(整体预算耗尽,不断言停在哪一阶段) | `timeout` |
| 认不出 | `undefined` —— 调用方保持原文案,不下归因 | 同左 |

**N2 出网代理交出它知道的层**(`packages/ui-mac/src/main/network-egress-proxy.ts`,本票唯一碰围栏的文件):

1. `:272-277` 拨号失败按 `err.code` 选 `EGRESS_DIAL_FAILURE_STATUS`(DNS 503 / 拒连 502 / 超时 504),`reason` 仍是
   `dial-failed`、`detail` 仍是错误码;正文格式不变(`shared/egress-denial.ts` 的 `reason=unregistered` 判据不受影响)。
   undici 丢掉正文之后,**状态码本身**就把 DNS 与 TCP 分开了。拨号期限 10 s 不变(不与目标 TLS connector 赛跑,§1.4)。
2. `:248-252` 放行记录加 `remote`(`upstream.remoteAddress`)与 `fakeIp: true`(地址落在 `198.18.0.0/15`),
   日志自己说明「这个 200 只是本机 TUN 接了 TCP」。
3. `:253-270` `egress.tunnel-closed` 加 `firstDownMs`(200 之后第一个上游字节的时刻;没有就不写)与 `durationMs`。
   `firstDownMs` 只证明上游回过字节(TLS Alert 也算),**不是**握手成功的证据。
4. **静默隧道兜底(产品期限)**:把 `head` 与之后的客户端 `data` 当作一条连续字节流,前两个字节为 TLS 记录头
   `0x16 0x03`(允许两字节跨块到达,不假设第一段至少两字节),而上游在 `tlsSilentMs`(默认 15 s)内一个字节都没回 ⇒
   关掉两端,记 `{event:"egress.tunnel-silent", host, port, remote, fakeIp, bytesUp}`。计时器在第一个上游字节、任一端关闭或报错时清掉。
   它是**产品期限**:15 s 比 undici 目标 TLS connector 的 10 s 长,有期限的客户端先报自己的错;它兜住 §1.5(c) 那类
   **未归属的静默隧道**,不声称所有客户端都没有期限,也不声称绝不截断超过 15 s 的合法慢握手。非 TLS 隧道(首字节不是 TLS 记录头)不受影响。

**N3 main 的请求出口取层,并带到屏幕**(契约码 `error: "network"` 不变,另加可选 `netLayer`,不动任何既有判定):

- 目录 `alpha-platform-models.ts:92-110`:完成记录在 `exception` 旁加 `layer`/`code`;返回值仍是 `"timeout" | "network"`
  (`#1500` 契约与目录 lane C1 的搬迁不受影响;上屏归目录 lane C3a,可直接用本模块文案)。
- 账户 `alpha-account-request.ts:72-74`:warn 日志加 `layer`/`code`(本票不加上屏)。
- 日程:`alpha-cloud-schedules.ts:58-60` 的 catch 结果加 `netLayer`;`CloudScheduleRefusal`(`:78`)加可选 `netLayer`,三个拒绝出口
  `:102,114,121` 带上它;`automation-ipc.ts:42,51,60,73,88` 五处转交;`automation-panel.tsx:301,321,501` 三处改为
  `scheduleRefusalCopy(r.code, r.netLayer)`;`schedule-refusal-copy.ts:56` 在 `code === "network"` 且有 `netLayer` 时用分层文案。
- 云任务派发:`alpha-cloud-jobs.ts:95-110,160-168` 的请求出口结果加 `netLayer`;`cloud-form-box.tsx:75` 改为
  `dispatchError(result.error, result.netLayer)`;`cloud-job-lifecycle.ts:35-39` 的 `dispatchError` 在 `network` 且有层时用分层文案。
- 产物下载**不在本票**:它的失败合同 `failure: { scope, artifactId?, code }` 归 delivery lane(`req236-results-and-attachments.md` §R1 与其
  `cloud-run-state` 广播),接口要求是该合同附带同一模块产出的可选 `netLayer`;本票不改 `alpha-artifact-download.ts`。

**N4 引擎在 cause 丢失之前结算层**(两处结算点都在已接管文件 `session/processor.ts`,north-star 例外 `scripts/north-star-guard.sh:170`):

- 工具:`processor.ts:200-214` 的 `failToolCall` 在 `errorMessage(error)` 把错误压成顶层 message **之前**,对原 `error` 跑
  `classifyNetFailure`,结果写进该 ToolPart 已有的 `metadata`(`alphaNetFailure: { layer, code }`;`:210` 本来就保留运行期 metadata,
  不改持久化 schema)。若真栈测试显示原错误到 `:402/:432` 时 cause 已丢,改在已接管的工具执行包装 `session/tools.ts`
  (ADR-041 文件级接管)抛出处取层 —— 二者择一,由第一条先红的测试决定,不两处都做。
- 回合:`processor.ts:131-135` 的 `parse` 在 `MessageV2.fromError` 返回 `APIError` 时把 `alphaNetLayer`/`alphaNetCode` 写进它已有的
  `metadata`(`Record<string,string>`,`packages/schema/src/v1/session.ts:70`);其它错误类型(如无 metadata 的 `UnknownError`)不带层,文案不变。
- renderer:`timeline-model.ts:882-899`(`turnErrorOf`)读 `data.metadata.alphaNetLayer`;`:1213-1222` 的回合错误行带上 `netLayer`
  (并入 `rev`);`tool-cards.tsx:788-800` 在非策略拒绝且有 `netLayer` 时换成分层文案;工具卡 `tool-card-model.ts:962-967` 读
  `part.state.metadata.alphaNetFailure`,错误 body 增 `netLayer`,其 JSX 在原错误文字之上加一行分层文案。

**文案(下一步)表**,键归 N3/N4 同一组,措辞交 T19 文案评审,不改任何布局:

| layer | 说什么 | 下一步 |
| --- | --- | --- |
| `policy` | 本机网络策略没有放行 `<host>` | 读网页:按提示批准该地址;其它:说明是本机设置,不是对方网站坏了 |
| `dns` | 解析不了 `<host>` | 检查网络或代理软件后重试 |
| `tcp` | 连不上 `<host>` | 对方暂不可达或线路受限,稍后重试 |
| `connect-timeout` | 与 `<host>` 的连接建立超时 | 稍后重试;反复出现时检查网络或代理软件 |
| `tls-silent` | 连上了本机代理,但 `<host>` 的加密握手没有回应 | 多见于代理节点或线路问题,切换网络/节点后重试 |
| `tls-failed` | 与 `<host>` 的加密握手失败 | 切换网络/节点后重试 |
| `tls-cert` | `<host>` 的证书校验失败 | 不要继续;检查系统时间或网络是否被劫持 |
| `http` | `<host>` 返回 `<status>` | 按调用方既有文案 |
| `timeout` | 等待 `<host>` 超过 N 秒 | 重试 |

loopback(本机引擎不应答)的文案归目录 lane C3a;远端 MCP 的状态呈现归生命周期 #2,二者都可以直接用本模块文案。

### 2.3 超时、重试、恢复各自的预算(本票只改加粗一项)

| 层 | 超时 | 重试 | 恢复 |
| --- | --- | --- | --- |
| 出网代理拨号(DNS+TCP) | 10 s(不变) | 不重试(由客户端决定) | — |
| 隧道内 TLS | 客户端自己的(undici 目标 TLS connector 10 s,CONNECT 200 后起算);**代理侧静默兜底 15 s(产品期限)** | 客户端自己的 | 连接关闭后客户端可重试 |
| main 目录 | 8 s | timeout 后补试 1 次(不变) | 下一个触发点(目录 lane C1) |
| 远端 MCP 连接+initialize | 30 s/次(不变) | StreamableHTTP 3 次 + SSE(不变) | **归生命周期 #2(编排器已并入)**。本文的接口要求:网络类层(`dns`/`tcp`/`connect-timeout`/`tls-silent`/`tls-failed`/`timeout`)在实例存活期内持续退避 30 s → 封顶 10 min(间隔有界、总次数无界),每服务单飞,实例销毁/换代即取消;`policy`、`http` 4xx、`auth`、`tls-cert` 不重连;不重放任何工具调用 |
| MCP tools/list | 30 s | 不重试 | 同上 |
| 网页读取 / 搜网 | 30 s / 25 s(不变) | 不重试 | 模型可自行重试;读网页的批准对话框慢于 30 s 时批准已落账,下一次直接通 |

### 2.4 被否决的替代

| 替代 | 一句理由 |
| --- | --- |
| 加一个全局「在线/离线」判断与横幅 | `navigator.onLine` 与 TCP 探测在 fake-IP 下恒为真(§1.5(a)),会给出一个看起来权威的假答案 |
| 失败时主动跑一遍 DNS→TCP→TLS→HTTP 探针并做成「网络诊断」页 | 要新 UI 与新 IPC;探针走的路不一定是失败请求走的路(main 直连 vs 引擎经代理);被动分类已覆盖所需。列为 OPTIONAL |
| 代理改为收到上游第一个字节后才回 200 | TLS 是客户端先说话,隧道没开就收不到 ServerHello,结构上做不到 |
| 让出网代理本身走系统代理 / 用户代理 | 改变围栏的出网拓扑,属权限与来源 lane;且 owner 机器的接管方式是 TUN,不需要 |
| 把代理拒绝理由写进 HTTP 原因短语或自定义头 | undici 只保留状态码(§1.4 引用的实测),短语和头同样到不了引擎 |
| 拉长各处超时 | 只把「说不出原因」变成「更久才说不出原因」;12 分钟隧道已经说明长等待不等于会好 |
| 只在引擎里按错误串分类、不改代理 | 引擎拿到的三种拨号失败是同一个 502,DNS 与 TCP 在引擎侧无从区分 |
| `UND_ERR_CONNECT_TIMEOUT` 一律判握手无回应 | main 直连 TCP 黑洞也产生同一个码(undici 的连接计时器同时覆盖 TCP 与 TLS),会制造错误归因 |
| 压缩出网代理拨号期限以免与客户端赛跑 | 不存在赛跑:CONNECT 应答与目标 TLS 是两个计时器(§1.4) |
| 分类模块放 `packages/schema` | 该包只放可序列化合同,运行期解析逻辑留在运行期共享层(`packages/schema/AGENTS.md:3`) |
| 去掉 15 s 主动断连,本票退回纯诊断(M) | owner 日志里已有没被任何客户端期限收掉的 12 分钟静默隧道;保留并给出一键关闭(`tlsSilentMs = 0`) |
| 在显示层用 renderer 解析工具卡里的错误串 | 串在 `processor.ts` 已被压成 `Transport error (…)`,cause 不在了,解析什么都认不出 |
| 在桌面侧给云 MCP 单独做重连 | 会在生命周期 #2 的状态机之外再造一个恢复所有者 |

## 3. 安全面与不变量

整类边界:出网围栏是安全设施,本票只改代理**对已决定结果的表达**与一个只会更早关闭的期限,不改任何放行判定。

- **I1 放行判定逐字不变**:授权、批准对话框、准入形状判据、「未获批的名字一次 DNS 都不发」(`network-egress-proxy.ts:15-21`)
  一行不动;`network-egress-proxy.test.ts` 里「未登记零拨号」「换成恒答允许的替身判据会红」两组断言原样保留。
- **I2 静默兜底只能关、不能开**:只在「客户端字节流以 TLS 记录头开始且上游零字节」时关闭隧道,永不新建连接、永不改变授权;
  它是产品期限,可能截断超过 15 s 的合法慢握手,`tlsSilentMs = 0` 即撤销。
- **I3 分类不泄密**:分类输出只有层名与错误码;日志与界面不出现 URL 查询、请求头、令牌、正文
  (延续 `alpha-platform-models.ts:101` 的纪律);主机名可出现(今天的代理记录已经记主机名)。
- **I4 认不出就不归因**:分类返回 `undefined` 时一切保持原文案(与 `egressPolicyDenialOf` 的 fail-closed 同形);
  `dial-failed` 永远不被说成策略拒绝。
- **I5 证据分级**:CONNECT 200 = 策略放行 + 代理到上游的 TCP;`firstDownMs` = 上游回过字节(可能是 TLS Alert);
  握手成功只认客户端的握手完成或 HTTP 应答。任何验证、日志读法、界面状态不得用前两者宣称远端可达。
- **I6 没有阶段证据就不声称阶段**:非出网代理路径的连接超时说「连接建立超时」,不说 TCP 已通;MCP 整体预算耗尽说「超时」,不说已进入 initialize。
- **I7 契约码不变**:main 各处返回的 `error` 码集合不变,`netLayer` 只是附加字段;`#1500` 与目录 lane 依赖的
  `"timeout" | "network"` 判定不受影响。
- **I8 确定性失败不重连**:`policy`、`http` 4xx、`auth`、`tls-cert` 不进入任何自动重连(对生命周期 #2 的接口要求同此)。

## 4. 子票切分

默认不拆:一张 CODE 票到底;运行时证据进共享 RC 回归 T23,不另开 VERIFY 票。

**表一:CODE 票**

| 项 | 内容 |
| --- | --- |
| 标题 · 仓 | `[REQ-236][CODE] 联网失败按层说出原因:本机拦截、解析不了、连不上、握手无回应、服务端拒绝各自可辨` · alpha-code |
| 覆盖 | 父 AC7(T20:分层诊断、不以 CONNECT 200 或泛化网络错误代替握手证据)。不覆盖 AC2 的「正在同步」(目录 lane) |
| 边界 | 新 `packages/plugin/src/alpha-net-failure.ts` + `packages/plugin/package.json` 一行 export;`packages/ui-mac/src/main/network-egress-proxy.ts`;`packages/opencode/src/session/processor.ts:131-135,200-214`(或其替代落点 `session/tools.ts`,二选一);main:`alpha-platform-models.ts:92-110`、`alpha-account-request.ts:72-74`、`alpha-cloud-schedules.ts:58-60,78,102,114,121`、`automation-ipc.ts:42,51,60,73,88`、`alpha-cloud-jobs.ts:95-110,160-168`;renderer:`automations/automation-panel.tsx:301,321,501`、`automations/schedule-refusal-copy.ts:56`、`extensions/cloud-form-box.tsx:75`、`extensions/cloud-job-lifecycle.ts:35-39`、`alpha-ui/session-timeline/timeline-model.ts:882-899,1213-1222`、`cards/tool-cards.tsx:788-800`、`cards/tool-card-model.ts:962-967` 及其错误 body JSX、`i18n/{zh,en}.ts`;`scripts/gate-files.tsv` 登记真栈用例 |
| out-of-scope | `packages/opencode/src/mcp/index.ts`(生命周期 #2 的文件,它消费本模块);`alpha-artifact-download.ts` 与云运行交付合同(delivery lane);放行判定与名单;目录刷新器;状态行(目录 C3a);「网络诊断」页 |
| 退出条件 | §2.2 N1–N4 落地;§3 I1–I8 各有测试;`bun test src` 对 base 失败集不新增;north-star 守卫绿(`packages/plugin/package.json` 一行 export 的先例为 `19bdae9ff`,合并前以守卫实跑为准) |
| 尺寸 · 难度 | L(主动断连碰出网围栏 = 安全面)· 难(要用真栈钉住 undici 与 Effect HTTP 的错误形状,静默兜底要证明不误伤非 TLS 隧道) |
| 依赖 | 无前置。生命周期 #2 的「远端失败码按层拆」与 delivery lane 的 `netLayer` 是**它们消费本票**,由编排器在那两张票上连依赖 |
| 独立 PR | 是(碰出网围栏 = 安全面) |
| 将来拿什么证明 | `network-egress-proxy.test.ts` 两条现断言 502 的用例**先红**:`:303-308`(`.invalid` ENOTFOUND ⇒ 改为 503)与 `:312-316`(黑洞 ETIMEDOUT ⇒ 改为 504);拒连三处(`:195-207`、`:293-300`、`:334-342`,ECONNREFUSED)仍断言 502,作不变对照。静默兜底四臂(上限设 50 ms 跑):TLS 头 + 黑洞上游 ⇒ `tunnel-silent` 并关闭;TLS 头两字节分两段到达仍触发;有回音的上游永不触发;明文首包慢回应不触发。新 `packages/plugin/test/alpha-net-failure.test.ts` 逐行覆盖映射表(含两列路径差异)。新 `packages/ui-mac/src/main/net-failure-real-stack.test.ts`:Electron 内嵌 Node(与 `#1412` 勘破 §3.3 同一接线:`sidecarEgressProxyEnv` + `setGlobalProxyFromEnv`)经真出网代理对 403 / `.invalid` / 拒连 / 黑洞 / TLS 静默五种靶,**从真 `webfetch` 工具入口走到持久化 ToolPart**,断言 `metadata.alphaNetFailure.layer` 分别为 `policy/dns/tcp/tcp/tls-silent`;同一文件对 main 直连 TCP 黑洞断言 `connect-timeout`(不是 `tls-silent`)。该文件登记进 `scripts/gate-files.tsv`,`[平台:darwin]`:**darwin 上缺 Electron 运行时即 throw「本次测量作废」**(同 `network-egress-fence.test.ts:100`),只有非 darwin 才自报 skip;它由 alpha-code 本机 `gate run` 的 `bun test src`(ui-mac)必跑。可见文案:`automation-refusal-test-runtime.tsx` 渲染面板断言 `network` + `netLayer:"dns"` 显示「解析不了」;`cloud-form-box` 组件测试断言派发失败显示分层文案;`timeline-model` / `tool-cards` 渲染断言回合错误卡与工具卡出现分层文案,认不出的错误文案逐字不变 |
| UI 稿 | 否 —— 只在既有错误位置换文字或在原错误文字上加一行;文案表(§2.2)交 T19 文案评审 |

**表二:T23 共享 RC 回归里要加的格**(不另开票;网页/搜索格的结果回写 `#1414`)

| 格 | 判 PASS 的证据(分别记「模型有没有真发调用」与「拿没拿回内容」) |
| --- | --- |
| 本地搜网 · 登出/BYOK | 打包版真模型回合:`websearch` 调用 + 结果;代理记录 `mcp.exa.ai` 或 `search.parallel.ai` 有 `firstDownMs` |
| 本地读网页 · 任一账户态 | 弹出批准框 → 允许 → 取回正文;代理记录 `egress.grant granted` 与该主机 `firstDownMs` |
| **登录 + 零余额 + 双腿在场**(`#1414` AC2) | 真实登录态工具表**同时**含 `websearch` 与 `cloud_cloud_web_search`;记录模型的每一次调用:云腿若被调用,结果为带稳定 `code` 的 402 且响亮到达模型;随后是否改调本地腿、本地腿是否拿回内容。只记录与判定,不新增桌面选路器 |
| 云搜网 · 登录有额度(`#1433` 未测格) | `cloud_cloud_web_search` 返回结果;费用按 T23 的总上限事先报 |
| 云读网页 · 登录有额度 | `cloud_cloud_web_fetch` 返回 `{status, content}` |
| 解析失败(受控输入) | 先在测试机上证明输入真的解析失败:`node -e 'require("dns").lookup("<name>.invalid",…)'` 得 `ENOTFOUND`,并以一个 fake-IP 能解出的名字作正对照(本机 2026-10-30 实测两者分别为 `ENOTFOUND` 与 `198.18.12.180`)。再让模型 `webfetch https://<name>.invalid/` 并批准 ⇒ 代理记 503、工具卡显示「解析不了」 |
| 握手静默 · 客户端先超时 | 本机非 loopback 网卡地址上起一个只收不回的 TCP 监听,`webfetch` 它并批准 ⇒ undici 目标 TLS connector 10 s 先到:工具卡显示「握手没有回应」;代理记 `tunnel-closed bytesDown=0`,**没有** `tunnel-silent` |
| 握手静默 · 无客户端期限、代理兜底 | 同一监听,经 agent 的 `bash` 用 `curl https://<该地址>:<端口>/`(走代理变量,curl 连接期限远大于 15 s)并批准 ⇒ 约 15 s 时代理记 `tunnel-silent` 并关闭,curl 以握手阶段断开失败 |
| 远端 MCP 抖动后恢复(依赖生命周期 #2) | 云连接器一次网络类失败后,不重启 App,在 #2 的退避上限内回到 `connected` |

## 待 Codex 征询

无新增。R1(唯一一轮)的五问已有答复并已并入正文(落点见下节「方案审 R1 处置」);仍没有答案的部分
(uv / git / curl 对 CONNECT 5xx 的重试分支、12 分钟隧道归属)列入「仍是推断」,不再开轮。

## 待 owner 裁决

无。以下为可回滚的默认值,自己定:

- 静默隧道兜底 15 s(产品期限)。撤法:`tlsSilentMs` 设 0 即关闭,其余改动不受影响。
- 远端 MCP 网络类失败的后台恢复节奏 30 s → 封顶 10 min(归生命周期 #2 实施)。撤法:去掉恢复,回到「停在 failed 等用户重试」。
- 文案只换字或加一行,不换位置;措辞以 T19 文案评审为准。

## 仍是推断、没跑过的断言

- 4 次 `Connect Timeout` 是「代理已回 200、目标 TLS 未完成」—— 由 5/5 日志对齐 + Codex R1 读内嵌 undici 的计时分工推出,未在本机用真代理复现(真栈用例会复现)。
- `webfetch` 的原错误到 `processor.ts:402/432` 时 cause 是否仍在 —— 未跑;N4 已给出两处择一的落点,由真栈用例决定。
- Effect `HttpClientError.reason.cause` 的形状 —— 只在主检出的 `effect@4.0.0-beta.83` 源码读到(`unstable/http/FetchHttpClient.ts`),未核对 0.1.22 锁定的版本;真栈用例钉住。
- 12 分钟零回应隧道属于哪个客户端 —— 无法归属(代理记录无关联字段)。
- `bytesDown=0` 的 `alpha-cloud` 隧道是线路对 Cloudflare 的 TLS 干扰还是 Cloudflare 侧丢包 —— 只知道 TCP 通、首段字节已发、零回应。
- 状态码拆分后 undici 报错原文仍是 `Proxy response (503|504) !== 200 when HTTP Tunneling` —— 只实测过 403 与 502(`docs/verification/2026-09-10-req137-1337-packaged-egress/`、`2026-09-10-req159-1334-packaged-network-fence/`)。
- 拨号失败改用 503/504 对子进程客户端重试行为的影响:Codex R1 读到 npm 10.9.8(`https-proxy-agent` 7.0.6 / `make-fetch-happen` 14.0.3)与一个 pip 26.0 对所有非 200 CONNECT 走同一分支;**uv 0.10.10、git、curl 未读**,不保证它们的重试行为不变。
- 本地读网页、云读网页、云搜网·有额度、登录零余额双腿回退四格今天能用 —— 代码路径在,未实跑(T23 承担)。
- 「只开系统代理」拓扑下 renderer 与引擎看到不同网络、以及 `<-loopback>` 让 loopback 进代理 —— 由代码与 Chromium 文档推出,未在任何机器实测(目录 lane V1 用 netlog 判定)。
- 本机日志与 curl/node 探测的时延全部经本机 TUN,不代表生产网络。

## 方案审 R1 处置(Codex,唯一一轮;编排器裁决 F1–F7、Q1–Q5 全部接受)

| 条目 | 改在哪 |
| --- | --- |
| F1 cause 在结算处丢失 | §1.4「模型请求 / 工具传输错误」行;§2.2 N4(在 `processor.ts` 压平前取层,写进已有 `metadata`;替代落点 `session/tools.ts`);§2.4 新增否决「renderer 解析错误串」;§4 证据列(从真工具入口到持久化 ToolPart) |
| F2 `netLayer` 传播与显示不全 | §1.4「main 直连 fetch」行;§2.2 N3(日程 / IPC / 面板 / 派发 / 回合行 / 回合错误卡 / 工具卡全部点名;产物下载交 delivery 合同);§4 边界与可见文案断言 |
| F3 连接超时误判为握手 | §2.2 N1 映射表按路径分两列,新增 `connect-timeout` 与 `tls-failed`;文案表;§2.4 新增否决;§3 I6 |
| F4 `<-loopback>` 含义写反 | §1.2 renderer 行;§1.6 H3 改为不排除、交 V1 用 netlog 判定;「仍是推断」 |
| F5 `#1414` AC2 被改窄 | §0 第 1 条;§1.1 AC2 行与脚注;§1.3 证据表;§4 表二新增「登录 + 零余额 + 双腿在场」格 |
| F6 真栈门可跳过 | §4 证据列(darwin 缺运行时即 throw、登记 `gate-files.tsv`、由 `gate run` 必跑) |
| F7 T23 故障格不确定 | §4 表二:解析失败用 `.invalid` 受控输入 + 正对照;握手静默拆「客户端先超时」与「代理兜底」两臂 |
| Q1 计时分工 | §1.4 TLS 行;§1.5(d);§1.6 预算条;§2.2 N2 第 1 条(拨号期限不变);§2.4 新增否决 |
| Q2 15 s 是产品期限 | §2.2 N2 第 3、4 条;§3 I2、I5;「待 owner 裁决」 |
| Q3 12 分钟隧道 | §1.5(c) 改为「未归属的静默隧道」;§1.7;「仍是推断」 |
| Q4 恢复放生命周期 #2 | §0 第 3 条;§1.6 恢复条(「缺少自动恢复」);§2.3 恢复列(间隔有界、总次数无界、单飞、取消、`tls-cert` 不重连);§4 依赖列 |
| Q5 状态码与子进程重试 | §2.2 N2 第 1 条保留;「仍是推断」写明已读与未读的客户端 |
| ARCH-NOTE 分类模块落点 | §2.2 N1 改放 `packages/plugin`;§2.4 新增否决 |

## 附录:本文用到的两段只读探测

**A1 拨号后握手**(`node dial_then_tls.mjs <host> 443`;与 `network-egress-proxy.ts:142-145` 同一拨号参数):

```js
import net from "node:net"; import tls from "node:tls"; import dns from "node:dns/promises"
const [host, port = "443"] = process.argv.slice(2)
const t0 = performance.now(); const ms = () => (performance.now() - t0).toFixed(1)
const addrs = await dns.lookup(host, { all: true }).catch((e) => [{ address: `ERR ${e.code}` }])
console.log(`dns ${ms()}ms`, addrs.map((a) => a.address).join(","), addrs.some((a) => /^198\.1[89]\./.test(a.address)) ? "(fake-IP)" : "")
const sock = net.connect({ host, port: Number(port), autoSelectFamily: true })
sock.setTimeout(12000, () => { console.log(`idle timeout ${ms()}ms`); sock.destroy() })
sock.once("error", (e) => console.log(`tcp error ${ms()}ms ${e.code}`))
sock.once("connect", () => {
  console.log(`tcp connected ${ms()}ms remote=${sock.remoteAddress}`) // 出网代理在这一刻写 200
  const s = tls.connect({ socket: sock, servername: host })
  s.once("secureConnect", () => { console.log(`tls ok ${ms()}ms authorized=${s.authorized}`); s.end() })
  s.once("error", (e) => console.log(`tls error ${ms()}ms code=${e.code} msg=${e.message}`))
})
```

**A2 出网代理记录聚合**(`python3 -I egress_stats.py <main.log>…`;只输出主机名与计数):

```python
import sys, json, collections, datetime
iso = lambda s: datetime.datetime.fromisoformat(s.replace("Z", "+00:00"))
for path in sys.argv[1:]:
    gen, conn = 0, {}
    allow, z, nz, deny, dur = (collections.Counter(), collections.Counter(), collections.Counter(),
                               collections.Counter(), collections.defaultdict(list))
    for line in open(path, errors="replace"):
        if "respawning sidecar" in line or "sidecar connection started" in line: gen += 1
        i = line.find("network egress {")
        if i < 0: continue
        r = json.loads(line[i + 15:]); key = (gen, r.get("id"))
        if r["event"] == "egress.connect":
            if r["verdict"] == "allow": allow[r["host"]] += 1; conn[key] = r["at"]
            else: deny[(r.get("host") or r.get("authority"), r.get("reason"), r.get("status"), r.get("detail"))] += 1
        elif r["event"] == "egress.tunnel-closed":
            if r["bytesDown"] == 0:
                z[r["host"]] += 1
                if key in conn: dur[r["host"]].append((iso(r["at"]) - iso(conn[key])).total_seconds())
            else: nz[r["host"]] += 1
    print("==", path)
    for h in sorted(set(allow) | set(z)):
        d = sorted(dur[h]); print(h, "allow200", allow[h], "bytesDown0", z[h], "bytesDown>0", nz[h], "median_s", d[len(d) // 2] if d else None)
    for k, v in deny.most_common(): print("DENY", k, v)
```
