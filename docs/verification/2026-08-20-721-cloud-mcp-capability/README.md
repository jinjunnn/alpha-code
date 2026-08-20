---
title: REQ-129 #721 —— 登录态 Cloud MCP 能力矩阵(5 列)
kind: verification
status: active
owners:
  - alpha-code maintainers
last_reviewed: 2026-08-20
review_after: 2026-11-20
---

# alpha-code#721 · Cloud MCP 能力矩阵取证

票:[alpha-code#721](https://github.com/jinjunnn/alpha-code/issues/721) ·
父需求:[alpha-work#50](https://github.com/jinjunnn/alpha-work/issues/50)(REQ-129)

矩阵按 owner 2026-07-31 的范围校正收敛为 **5 列**:`cloud_dispatch` · `cloud_status` ·
`cloud_await` · `cloud_artifacts` · `cloud_web_search`,外加两条负例(`cloud_schedule_*`
不在 `tools/list`、调用已剔除的名字按未注册拒绝)。

**结论先说:矩阵不是 5/5。** 逐格结果在 §4;三条最重要的:

1. **应用今天一个云工具也够不着** —— 云 MCP 自 [ADR-009](../../../.claude/rules/adrs/ADR-009-websearch-default.md) 2026-08-03 就地修订起走标准
   MCP OAuth,而本机该 server 停在 `needs_auth`(从未拿到 `mcp_access` 令牌),且每次
   sidecar 重生都会重新发起、重新失败。见 P0.5 / §5.1。
2. **回落凭证形态下 3/5 结构性 403** —— 用应用自己持有的 `purpose=cloud.dispatch`
   platform_access 令牌,`cloud_status` / `cloud_await` / `cloud_artifacts` 恒 403
   `insufficient_scope`。这正是 REQ-129 AC3 要消除的那件事,今天仍然可复现(A-SUM / R3)。
3. **计费半场取不到证据** —— 账本读取需要 `purpose=account.read` 令牌,它只在应用的加密
   凭证包里;应用未开 CDP ⇒ 无法读取。AC4 的账务对账在本轮为 BLOCKED,不是 PASS。

---

## 1. 被测件

| 项 | 值 |
| --- | --- |
| 应用 | `/Applications/alpha-code.app`(`ship:mac` 装机版) |
| `sha256(Contents/Resources/app.asar)` | `80c1022dbeaac2a921f292e4490d38058c11f0addf771395fa9996949655a9c8` |
| 构建时刻 | `2026-08-17T10:40:16Z`(本地 2026-08-17 06:40:16 -0400) |
| CFBundleShortVersionString | `0.1.2` |
| CFBundleIdentifier | `com.tide.alphacode` |
| userData | `~/Library/Application Support/ai.opencode.desktop` |
| 被测远端 | `https://alpha-cloud.tidelabs.click/mcp`(= 应用 sidecar 的 `ALPHA_CLOUD_MCP_URL`) |
| 取证分支 | `feat/721-cloud-mcp-capability-verify` @ `672c566e3`(仅承载证据,不改产品代码) |

### ⚠️ 被测 commit 只能推断,不能机械恢复(P0.2 = BLOCKED)

票的 Evidence rules 要求「记录被测 commit/版本」。**这份产物里没有 commit 标记** ——
`app.asar` 与 `Info.plist` 都不带源 sha —— 把 `origin/alpha` 最近 12 条提交的短 sha
逐个在产物里搜过,**一条都不命中**。可写下的只有推断:

- 构建时刻 `2026-08-17T10:40:16Z`,`origin/alpha` 上紧邻它之前的提交是
  `ab6c851be`(`2026-08-17T10:39:02Z`,相隔 74 秒),其后的下一条提交在 2026-08-19。
- 因此**若构建时工作树干净**,源码 = `ab6c851be`。这一条**未被证实**,只是最可能的解释。

两条必须一起读的事实:

- 被测包比本次取证时的分支 tip(`672c566e3`)落后 **30 余个提交 / 3 天**;
- [E7 的做法](../2026-07-27-e7-packaged-live/README.md#1-被测件)(从干净提交 `ship:mac`
  → 把 `app.asar` 的 sha256 钉进探针 → 探针开跑先比对)**在这个 build 上没有执行过**。

⇒ 本目录的所有结论只对 `80c1022d…` 这一份产物成立。重打包后必须重跑。

---

## 2. 登录身份

| 项 | 值 |
| --- | --- |
| 身份类型 | **订阅登录**(browser-delegated OAuth → `platform_access` JWT bundle) |
| 不是 | Cloud API key(`sk-alpha-*`)—— 本机没有,见 §5.2 |
| 令牌形态 | `iss=alpha-web` · `aud=alpha-platform-api` · `token_use=platform_access` · **单值 `purpose`** · 寿命 900s |
| 租户 | `pseudo:5d6953ec453b`(sha256 前 12 位;真值不入证据) |
| 落盘的两支 | `alpha-secrets/ALPHA_CLOUD_TOKEN`(`purpose=cloud.dispatch`)、`alpha-secrets/ALPHA_API_KEY`(`purpose=model.invoke`) |
| 只在内存/加密存储的三支 | `cloud.read` · `artifact.read` · `account.read`(`alpha-auth.json` 经 safeStorage 加密) |

**这一节决定了本轮能测到什么、测不到什么。** 探针只用应用自己铸出来并写进自己密钥文件的
凭证(与 E7 同一纪律);`cloud.read` / `artifact.read` / `account.read` 三支拿不到,所以
「用最小权限逐项调通」与「账本差分」两条只能记 BLOCKED,不能靠伪造令牌凑绿。

---

## 3. 复现步骤

```bash
# 只读相位(零计费):传输鉴权 + 注册表 + 逐工具授权判决 + 负例
bun docs/verification/2026-08-20-721-cloud-mcp-capability/probe.ts

# 计费相位:上面全部 + 一次真 web search + 一次真 dispatch(随即取消)
bun docs/verification/2026-08-20-721-cloud-mcp-capability/probe.ts --paid
```

退出码:`0` 全部必需项通过 · `1` 有必需项不通过 · `2` 前置被挡(没有装机版 / 没有登录凭证)。
每次运行落一份 `results/<phase>-<UTC>.json` 并覆盖写 `results/latest-<phase>.json`。

探针**不写任何本地应用状态**;`--paid` 的两次真调各产生一次真实计费,dispatch 出去的作业
在同一次运行里被 `cloud_cancel` 收回。

**T4(过期凭证)会让运行停在末尾等待**:它把开跑时的凭证快照留到它自己的 `exp` 之后再用
—— 这是拿到「真过期凭证」的唯一诚实办法(不伪造签名、不改系统时钟)。900s 寿命 ⇒ 最多等
约 15 分钟。

**证据里没有 token。** 探针把读到的每个凭证登记进 redaction 表,写盘前对 JWT / `Bearer …` /
`sk-*` / email 逐一抹除;`job_id` 与租户 `sub`/`jti` 只以 `pseudo:<sha256 前 12 位>` 出现。

---

## 4. 矩阵

`结果` 列由探针填,真源 = [`results/latest-paid.json`](results/latest-paid.json)
(2026-08-20T09:51:08Z,exit 1)。该次运行:**27 pass · 5 fail · 5 blocked · 3 not-producible**,
其中**必需项失败两条** —— `A-SUM` 与 `R3`,都是同一件事(见 §4.1 与 §5)。

### 4.1 逐工具(5 列 + 观察到的第 6 个)

| 工具 | 在 `tools/list` | requiredAction(远端 challenge 自报) | 回落凭证的授权判决 | 真实调用 | 入口直接计费 |
| --- | --- | --- | --- | --- | --- |
| `cloud_dispatch` | ☑ PASS | `cloud.dispatch` | ☑ 放行(HTTP 200) | ☑ **PASS** — 受理并返回 job_id(R2) | 无(沿 job 逐 token) |
| `cloud_status` | ☑ PASS | `cloud.read` | ☒ **403 `insufficient_scope`** | ☒ **FAIL** — 读不回自己刚派出的作业(R3) | 无 |
| `cloud_await` | ☑ PASS | `cloud.read` | ☒ **403 `insufficient_scope`** | ☒ **FAIL** — 同一凭证在 callback 之前即被拒(A-cloud_await) | 无 |
| `cloud_artifacts` | ☑ PASS | `artifact.read` | ☒ **403 `insufficient_scope`** | ☒ **FAIL** — 同上(A-cloud_artifacts) | 无 |
| `cloud_web_search` | ☑ PASS | `cloud.dispatch` (any-of `model.invoke`) | ☑ 放行(HTTP 200) | ☑ **PASS** — 真实结果(R1) | 有(reserve→provider→settle,**未取到账本证据**) |
| `cloud_cancel` *(不在 5 列内)* | 观察到 | `cloud.dispatch` | ☑ 放行 | ☑ PASS — `accepted:true` / `status:"cancelling"`(R4) | 无 |

**每一格的 403 都自报了那个工具自己的 `requiredAction`**(`scope=cloud.read` /
`scope=artifact.read`),与平台注册权威
(`alpha-platform/docs/contracts/public-cloud-mcp.md` §6)逐字一致 ⇒ **AC2 的「唯一解析」
成立**;不成立的是 AC3 的「不因凭证形态恒 forbidden」。

### 4.2 逐矩阵条目(#721 正文 + 2026-07-31 增补)

| # | 矩阵条目 | 结果 | 证据 |
| --- | --- | --- | --- |
| 1 | `/mcp` transport:无 token / 坏 token / 过期 token 在工具数据与 callback 前拒绝 | **PASS** | T1(无凭证 `tools/list` → 401,challenge 四参数逐字相符,响应体里不含批准的 5 个工具名中的任何一个)· T2(语法非法 bearer → 401)· T3(**签名伪造且 claims 自称 `cloud.read`+`artifact.read`** → 401)· T4(真过期凭证 → 401)· N-ORDER(未注册工具 + 无凭证 → 401,认证排在注册表之前) |
| 2 | 订阅登录态 5 个工具逐项真实调用 | **FAIL** | A-SUM:3/5 恒 403。**应用真正呈给 `/mcp` 的凭证今天不存在**(P0.5),故连这 3 个 403 都是「回落凭证」的结果而非应用实际行为 —— 见 §5.1 |
| 3 | Cloud API key 逐项验证 | **BLOCKED** | P0.4:本机无 `sk-alpha-*`;`ALPHA_API_KEY` 是 `purpose=model.invoke` 的 JWT,不是 API key。见 §5.2 |
| 4 | 公共授权咽喉:唯一 `requiredAction`,未知工具/缺 action/缺 capability 默认拒绝 | **PASS(带一条措辞分歧)** | A-*(六个工具各自的判决与注册表一致)· N-cloud_schedule_*(-32602,零副作用)· N-ORDER。分歧见 §5.5 |
| 5 | 内部 hop 按 #171 trust table 取证 | **NOT-PRODUCIBLE(本仓)** | E1:Worker 内部 hop 从客户端结构上观测不到,判据归 alpha-platform#171 / #54 |
| 6 | 外部 bearer / API key 不被原样转发到下游、结果或日志 | **部分 PASS** | L1:桌面端全部日志目录零命中 JWT / `Bearer …` / `sk-*`(扫描 34 个文件)。下游转发那一半 = E1,归平台仓 |
| 7 | 长任务:dispatch 可超过登录令牌寿命;刷新/重连后 status/await/artifacts 继续工作 | **FAIL** | R3:同一凭证派得出、读不回 —— 后续读取在本凭证形态下**结构上不可能**,与令牌寿命无关。另记 L2:sidecar 每约 10 分钟随密钥同步重生(6 次/50 分钟),云作业在平台侧不受影响,本地在途回合会被打断([ADR-036](../../../.claude/rules/adrs/ADR-036-single-engine-generation-for-session-send.md) 后果,另有窄票) |
| 8 | web search:真实结果、provider 前 reserve、同一 reservation 幂等 settle/cancel、失败不双扣 | **PASS(真实结果)/ BLOCKED(账务)/ NOT-PRODUCIBLE(失败矩阵)** | R1 真实结果;R5 账本差分取不到(§5.3);E2/E3 需要注入 provider 故障与观察 Queue 重放,归 alpha-platform#105 / #90 / #103 / #104 |
| 9 | dispatch 计费复核;status/await/artifacts/schedule CRUD 无未声明直接费 | **BLOCKED** | R5 同上。注册表侧的 `billingPolicy` 已记录在 §4.1,但「实际没扣钱」需要账本 |
| 10 | 错误投影:401 / 402 / 403 / 429 / 其它 4xx / 5xx 可区分 | **部分 PASS** | 401(T1–T4)、403(A-*)、400(T8 batch → `batch_not_supported`)三档实测可辨且带稳定码。402/429/5xx 本轮未产生(账户有余额、未触发限流、上游健康)。**一条实测缺口见 R6 / §5.4** |
| 11 | 身份归属来自已验证身份或受信内部 context,不由工具参数自报 | **部分 PASS** | T3 是它的直接反例测试:一支**自称** `cloud.read`+`artifact.read` 的伪造 JWT 被 401 拒绝 ⇒ 授权取的是验签后的身份,不是自报 claims。跨租户 `job_id` 越权的负例需要第二个租户,本轮不具备 |
| 12 | `cloud_schedule_*` 不在 `tools/list`;调用已剔除的名字按未注册拒绝、无副作用 | **PASS** | T5(集合无 `cloud_schedule_` 前缀)· N-cloud_schedule_{create,list,delete}(全部 `-32602 Tool <name> not found`,无 result 载荷) |
| 13 | schedule 的 HTTP 面(自动化面板链路)剔除后不回归 | **PASS(带边界)** | H1:`GET /v1/cloud/schedules` → **403**(授权拒绝),同前缀下的假路由 → **404** —— 有对照,所以 403 证明的是「路由还在」而不是「什么都 403」。边界:面板真正的 GET 用 `cloud.read`,本轮拿不到那支令牌,故端到端未走通 |

### 4.3 两条与基线的偏差(不是缺陷,但基线已过期)

| 项 | 结果 | 说明 |
| --- | --- | --- |
| 工具集合**精确**等于批准的 5 个 | **FAIL(T7)** | 实测 6 个,多出 `cloud_cancel`。它是 alpha-platform#258(CLOSED)按自己的裁决增列的(注册表行 + 契约文档 §6 + `mcp-tool-surface.test.ts` 精确集合断言都在),**不是漏网的 schedule 工具**。⇒ #721 的「5 列」是 2026-07-31 的快照,已不等于当前注册权威;父票 AC10 的「集合等于批准的 5 个」需要按 `ap#258` 更新措辞 |
| 已认证 + 未注册工具名 → 403 | **FAIL(N-NOACTION)** | 实测 **200 + `-32602 Tool not found`**。平台契约(§3)本就把未注册名定为 `-32602`;#721 2026-07-31 增补那句「缺 `requiredAction` 断言 HTTP 403」指的是**已注册但解析不出 action**的情形。两份文字对同一格给出不同断言。**没有 handler 执行 ⇒ 不是可达的授权绕过**,要收敛的是判据措辞 |

---

## 5. FAIL / BLOCKED 逐条,以及建议开的窄票

### 5.1 应用对云 MCP 停在 `needs_auth`,且每次 sidecar 重生都重来一遍(P0.5)

事实(全部只读观测):

- `packages/ui-mac/src/main/cloud-sidecar-config.ts` 的 `materializeCloudMcpConfig()`
  **只声明 OAuth 客户端,没有任何凭证通道** —— 静态 bearer 随 [ADR-009](../../../.claude/rules/adrs/ADR-009-websearch-default.md) 2026-08-03
  就地修订一起删掉了。
- 引擎的 OAuth store `~/.local/share/opencode/mcp-auth.json` 里,`cloud` 条目只有
  `codeVerifier` 与 `oauthState`,**没有 `tokens`**。
- 该文件的 mtime 紧跟每一次 sidecar 重生(实测 09:26:04Z、09:36:12Z,对应
  `server.log` 的 09:25:56、09:35:5x 两次引擎启动)—— 授权流被反复发起、从未完成。

⇒ **今天这台机器上,应用自己调不动任何一个云工具**;矩阵第 2 行因此连「以应用的真实凭证
逐项调用」都没能开始。完成授权需要用户在扩展中心走 `needs_auth` → 浏览器授权
([ADR-009](../../../.claude/rules/adrs/ADR-009-websearch-default.md) 顶部就地修订段明写:此时轮换 `ALPHA_CLOUD_TOKEN` 没有用)。

**建议开窄票(CODE/VERIFY 二选一,由 owner 判)**:云 MCP 的 OAuth 授权在桌面端从未完成,
且失败是静默的 —— 全部日志目录里 `oauth` / `needs_auth` 零命中,`utility.log` 只有一行行
`sidecar exited { code: 0 }`(每约 10 分钟一次)。至少要回答:失败在哪一步、
`needs_auth` 有没有在产品面可见、每 10 分钟重发一次授权请求是否是预期行为。

### 5.2 本机没有 Cloud API key(P0.4)

`ALPHA_API_KEY` 这个名字有误导性:它是 `purpose=model.invoke` 的 `platform_access` JWT,
不是 `sk-alpha-*`。矩阵第 3 行(API-key 臂)因此 BLOCKED,不是 FAIL —— 它需要一把用户
自助创建的 key(alpha-platform#177 是这条的前提票)。

### 5.3 计费半场取不到证据(R5)

账本读取要 `purpose=account.read` 令牌,它不落盘、只在 `alpha-auth.json`(safeStorage
加密)与主进程内存里。E7 是经 **CDP** 拿到 sidecar 凭证再读的;本次应用**没有以
`ALPHA_CDP=1` 启动**(P0.7),而探针不会为了取证去重启 owner 正在用的应用。

⇒ AC4 的「reserve → provider → settle 归属调用租户」「只读工具不产生新直接费」在本轮是
**BLOCKED**。要补齐,owner 照 E7 runbook 敲一次即可:

```bash
pkill -f "/Applications/alpha-code.app" ; sleep 2
ALPHA_CDP=1 open -a /Applications/alpha-code.app
```

### 5.4 `cloud_web_search` 的成功载荷是一段不可结构化分类的文本(R6)

实测 `results` 是**字符串**,形如 `[tavily] <query>\n- <标题> (<url>)\n  <摘要>…`,
不是结果对象数组。而按 alpha-platform 已登记的 D2,provider 失败串(`brave search
error: 429`、`no search backend configured`)落在**同一个槽位**。

⇒ 客户端没有结构化办法区分「搜到了」与「上游报错」,只能靠字符串特征猜。探针的 R1 因此
显式排除了两个已知失败特征,而不是只断言「非空」——**只断言非空的判据在 provider 报错时
照样绿**。

这条与 AC5(稳定类别)/ AC8(故障不具成功外观)直接相关。alpha-platform#105 已 CLOSED,
但**客户端可分类性这一面在本轮实测下不成立**。建议在平台仓开一条窄票或复核 #105 的关闭范围。

### 5.5 一次真实的瞬时 dispatch 拒绝,值得单独记一笔

第一次 `--paid` 运行的 `cloud_dispatch` 拿到
`200 + isError:true + {"error":"job admission ledger unavailable","code":"job_ledger_unavailable"}`;
而最终一轮的同一调用在第 1 次尝试就被受理。原始记录保留在
[`results/paid-20260820T094107Z.json`](results/paid-20260820T094107Z.json) 不改动;
最终运行的探针改成最多重试 3 次并**保留每一次尝试**。

两点:①**这是一条带稳定 `code` 的拒绝**,对 AC5 是正面证据;② 它同时说明单次采样会把一个
瞬时故障记成工具的判决 —— 把它写下来比让它消失有用。

---

## 6. 支撑用的确定性证据(L1,非真机)

本轮顺带跑了与矩阵相关的仓内测试,作为**支撑**而非替代(它们不证明部署面的行为):

| 套件 | 结果 | 覆盖 |
| --- | --- | --- |
| `packages/ui-mac/src/main/alpha-cloud-jobs.cases.ts` | 11 pass / 0 fail | #727:产物列表用 `artifact.read` 而不是 `cloud.read`;status/cancel 各守自己的 action;字节下载走独立传输契约 |
| `packages/ui-mac/src/main/cloud-web-search.test.ts` | 13 pass / 0 fail | 云工具 id 由 `McpCatalog.toolName` 同义拼法推导(#650),kill-switch 注入面 |
| `packages/ext/src/cloud-websearch-kill.test.ts` | 43 pass / 0 fail | `tool.execute.before` 主权闸、治理豁免绑端点身份、跨实例隔离 |

`alpha-cloud-jobs.cases.ts` 那 11 条是 #721 增补里「artifact list 必须证明 alpha-code
使用 `artifact.read`」的**客户端**一半;**服务端**一半(只有 `cloud.read` 的负例仍为 403)
本轮由 A-cloud_artifacts 的 `scope=artifact.read` challenge 实测坐实。

---

## 7. 本目录**不**证明什么

1. **不证明应用能用云工具。** 应用的云 MCP 停在 `needs_auth`(§5.1);本轮所有 `tools/call`
   用的是应用**另外持有**的 `cloud.dispatch` 令牌,那不是应用会呈给 `/mcp` 的凭证。
2. **不证明计费正确。** 账本一次都没读到(§5.3)。
3. **不做平台侧单测**,也不假装能观测 Worker 内部 hop(E1/E2/E3)。
4. **单次采样不是分布。** §5.5 的瞬时拒绝就是它的注脚。
5. **只对 `80c1022d…` 这一份产物成立**,而这份产物比取证时的分支 tip 落后 3 天(§1)。
