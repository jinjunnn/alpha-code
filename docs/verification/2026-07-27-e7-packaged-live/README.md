---
title: E7 打包真调 + keyless 兜底 + 计费/失败证据(L2/RC)
kind: verification
status: active
owners:
  - alpha-code maintainers
last_reviewed: 2026-07-30
review_after: 2026-10-27
---

# E7(alpha-code#643)打包版真机取证

规格来源:[`docs/design/2026-07-22-e7-cloud-web-search-baseline.md`](../../design/2026-07-22-e7-cloud-web-search-baseline.md)
票 6。被取证的实现是 PR #639(2026-07-26 合入)之后的代码 —— 前一份证据
[`docs/verification/2026-07-22-e7-deploy-probe.md`](../2026-07-22-e7-deploy-probe.md)
验的是**前提**(worker 已部署、匿名 `tools/list` 有 `cloud_web_search`、gateway 规范路径 fail-closed),
且比 #639 旧,不能支撑本票任何一条 AC。

**本目录的登录态与登出态取证均已完成。** 2026-07-31 在重钉产物上用真实登录态执行
[`probe.ts`](probe.ts),23 项、0 个必需失败;此前同一套探针的登出态相位为 10/10。
探针仍对错误登录态 fail-closed:前置不满足时拒绝产出证据并以非零退出(见 §4)。

## 1. 被测件

| 项                                    | 值                                                                 |
| ------------------------------------- | ------------------------------------------------------------------ |
| 应用                                  | `/Applications/alpha-code.app`(`ship:mac` 装机版,非 `dist/` 直跑)  |
| 构建时间                              | 2026-07-30T22:12:02 -0400(= 2026-07-31T02:12:02Z)                  |
| 基线 commit                           | `b8f030e0c`(`e7-probe-refresh`,工作树干净)                         |
| `sha256(Contents/Resources/app.asar)` | `dded6b38f023e2bbaba3c152032a857f80221d280949c6838374741aea6f42b9` |
| CFBundleShortVersionString            | `0.1.2`                                                            |
| 引擎版本                              | `1.17.13`                                                          |
| userData                              | `~/Library/Application Support/ai.opencode.desktop.dev`            |

`app.asar` 的 sha256 被钉进 `probe.ts`(`PINNED_ASAR_SHA256`)。探针第一件事就是重算它并比对 ——
**在错的构建上跑出来的绿是假绿**,这条判据把它挡住。重新打包后必须同时更新此处与 `probe.ts` 的常量。

### 2026-07-30 为什么再次重钉

`alpha-code#651` 修正了登录态探针的四个错误观测点,本次又发现旧 P2.3 仍按 Ledger V1
硬切前的 `transaction.id` 做差分,因此永远看不到新流水。先在干净提交 `b8f030e0c`
完成判据修正、自测、类型检查与文档校验,再从该提交执行标准 `ship:mac`;
`/Applications/alpha-code.app` 的新指纹为 `dded6b38…` 且通过 `codesign --verify --deep --strict`。
产品源码相对 `origin/alpha` 没有额外修改,但被测包与判据现在共同指向一个可追踪提交。
旧结果及其旧指纹均保留不改。

### 2026-07-27 为什么重打了一次

上一份装机产物是 `94a76b669` / `8706d0c4…`(2026-07-27T05:29:35 -0400),**早于**
`e578e00ae`(PR #648,`readBoundedBody` 读全响应体)。在那份产物上登出态 keyless 真调
必然被截断的 JSON 打红(见 §5),**AC2 不可能转绿** —— 所以不是「重跑一次试试」,
是被测件本身不合格。本目录的指纹与 `probe.ts` 的两个常量已同步换成新产物;
旧产物的原始记录保留在 `results/*20260727T0952*.json`,作为缺陷发现时的证据不改动。

真机启动已验(新产物,2026-07-27T21:32):`ALPHA_CDP=1 open -a` 后
主进程 / renderer / GPU / NetworkService / NodeService(sidecar)五个进程齐备,
CDP 列出 `oc://renderer/index.html` 的 page target(窗口真的打开),
`logs/20260728T013220/main.log` 有 `server ready { url: 'http://127.0.0.1:50360' }`,
同目录 `crash.log` 只有 `crash reporter started`、无崩溃。
(本仓两个打包坑 —— source-only `contracts-consumer` 被 externalize 后 asar 里留原始 `.ts`、
eager ajv `new Function` 撞 renderer CSP —— 本次均未复现:`renderer.log` 只有既有的
`connect-src` 源列表告警,无 eval 被拒;启动无崩溃。)

## 2. 探针覆盖了什么

`probe.ts` 分**两个相位**,每一相位都对**错误的登录态 fail-closed**。故意不做自动识别:
一个会自己切相位的探针永远报不出「未登录,无法取证」,而看不见失败的闸门不是闸门。

- 默认(无参数)= **登录态**相位:未登录即 `blocked` + exit 2。
- `--keyless` = **登出态**相位:仍在登录态即 `blocked` + exit 2。
- `--self-test` = **判据反向闸**:不连应用、不发网络请求,逐条证明 #651 修正后的
  P1.2/P1.3/P1.5/P3.8 与 Ledger V1 计费判据在对应绕过下会变红。

每一项都写死了**运行前就定好的判据**(结果 JSON 里的 `criterion` 字段),输出机器可读 JSON 到
[`results/`](results),带采集时刻、被验 commit、asar 指纹、应用版本。
探针自身不含任何密钥:它用的每一个凭证都是**打包应用自己签发并写进自己 secret 文件**的
(`<userData>/alpha-secrets/*`),运行时读取,写盘前经 `redact()` 抹除。

## 3. 复现步骤(owner 照敲)

**两相位均已有通过证据。** 机器现在停在:重钉产物已装、`ALPHA_CDP=1` 已开、应用处于
真实登录态。①–⑤ 留作完整复现记录;再次执行默认相位会产生真实 web-search 调用与计费。

```bash
# ① 用本仓标准 CDP 口子重启打包应用(这是拿到 sidecar 凭证的唯一通道)
#    —— 应用此刻已在 CDP 下运行;只有当它被关掉时才需要这一步
pkill -f "/Applications/alpha-code.app" ; sleep 2
ALPHA_CDP=1 open -a /Applications/alpha-code.app

# ② 在应用里登录(平台代付模式),等模型目录出来

# ③ 登录态取证 —— 一条命令跑完
cd ~/app/alpha-code && bun docs/verification/2026-07-27-e7-packaged-live/probe.ts

# ④ 在应用里登出(设置 → 退出登录)

# ⑤ 登出态 keyless 兜底取证 —— 已在 2026-07-28 跑过,exit 0
cd ~/app/alpha-code && bun docs/verification/2026-07-27-e7-packaged-live/probe.ts --keyless
```

退出码:`0` = 全部必需项通过 · `1` = 有必需项不通过 · `2` = 前置被挡(构建不对 / 没开 CDP / 登录态不对)。
两次运行各落一份 `results/<phase>-<UTC>.json`,并覆盖写 `results/latest-<phase>.json`。
探针**幂等**:它只新建 scratch 会话与读取状态,第二遍不依赖也不会被第一遍的残留弄坏。

## 4. 逐项判据与结果

`AC` 列对应 #643 正文三条。`结果` 列由探针填(`results/latest-<phase>.json` 是真源);
登录态结果来自重钉产物 `b8f030e0c` / `dded6b38…` 的
[`logged-in-20260731T022038Z.json`](results/logged-in-20260731T022038Z.json)。

### 登录态相位(默认)

| 项   | AC   | 判据                                                                                                                                                                             | 结果                                     |
| ---- | ---- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------- |
| P0.1 | 前置 | `sha256(app.asar)` 等于本文件钉的值                                                                                                                                              | ☑ pass(2026-07-31T02:20Z)               |
| P0.2 | 前置 | CDP 端口列出 renderer page target                                                                                                                                                | ☑ pass                                  |
| P0.3 | 前置 | `GET /global/health` → `{healthy:true}`                                                                                                                                          | ☑ pass                                  |
| P0.4 | 前置 | `auth.getState()` 为 `{status:"logged-in",mode:"platform"}` **且** `alpha-secrets/ALPHA_CLOUD_TOKEN` 在位                                                                        | ☑ pass                                  |
| P1.1 | AC1  | `GET /mcp` 里 `cloud` 的 `status === "connected"`                                                                                                                                | ☑ pass                                  |
| P1.2 | AC1  | 由打包引擎创建短命 PTY 子进程,从继承的原始 `OPENCODE_CONFIG_CONTENT` 只输出布尔断言 URL + `Bearer {file:…ALPHA_CLOUD_TOKEN}`;`GET /config` 另证替换后 URL/值与密钥文件一致       | ☑ pass                                  |
| P1.3 | AC1  | **LIVE-PATH catalog gate**:已部署端点的匿名 `tools/list` 存在匹配 `/web[_-]?search/` 的工具;本项不再冒充账户授权证据,账户绑定由 P2.2 证明                                        | ☑ pass                                  |
| P1.4 | AC1  | 记录引擎侧真实工具 id(`sanitize("cloud")+"_"+sanitize(<远端名>)`),**不假定**是 `cloud_web_search`                                                                                | ☑ pass:`cloud_cloud_web_search`(`#650`) |
| P1.5 | AC1  | 对 `GET /agent` 每个运行时 agent 按引擎 `Wildcard.match + findLast` 语义计算 `websearch` 有效判决,要求全部为 `deny`;后置用户 agent allow 会使本项变红                            | ☑ pass                                  |
| P1.6 | AC1  | `/config/providers` 里存在网关 provider 且有 `capabilities.toolcall` 模型                                                                                                        | ☑ pass                                  |
| P1.7 | AC1  | `GET /experimental/tool?provider&model` **不含** `websearch`(本地 keyless 被抑制)                                                                                                | ☑ pass                                  |
| P2.1 | AC1  | **打包真调**:一次真实模型轮次产出该云工具的 tool part,`status==="completed"`,输出解析出 `{query,results}`                                                                        | ☑ pass                                  |
| P2.2 | AC1  | **LIVE-PATH GATE ②** 用应用自己的 token 直接 `tools/call`,返回 `{query,results}` 且 `isError !== true`                                                                           | ☑ pass:HTTP 200                         |
| P2.3 | AC3  | **计费**:有界轮询 `waitUntil` 后台结算,要求 Ledger V1 新增 `reservation_created(actionId=tool.web_search) → usage_settled → reservation_settled`,三者共享新 `reservationId`      | ☑ pass:2 笔各 15 分,总差分 30 分        |
| P3.1 | AC3  | **401**:无 Authorization 打 `POST {platform}/v1/tools/web_search` → 401                                                                                                          | ☑ pass                                  |
| P3.2 | AC3  | **400**:带真 bearer、body `{}` → 400                                                                                                                                             | ☑ pass                                  |
| P3.3 | AC3  | **400**:带真 bearer、坏 JSON → 400                                                                                                                                               | ☑ pass                                  |
| P3.4 | AC3  | **403** —— `not-producible`(桌面端只持有 `model.invoke` / `cloud.dispatch` 两个 route-purpose 绑定令牌,造不出 scope 不足的令牌);映射由 L1 `alpha-websearch-failure.test.ts` 覆盖 | ◇ not-producible                         |
| P3.5 | AC3  | **502** —— `not-producible`(需已部署 gateway 同时缺 `TAVILY_API_KEY`/`BRAVE_API_KEY`;两把钥匙都在位,拆生产配置不在探针权限内)                                                    | ◇ not-producible                         |
| P3.6 | AC3  | **意外状态 LOUD** —— `not-producible`(桌面端够得着的请求形态都落在 {400,401,402,403,502} 内);映射由 L1 覆盖                                                                      | ◇ not-producible                         |
| P3.7 | AC3  | **402 / 余额**:带真 bearer 打 `/v1/tools/web_search` → 402(账户额度+余额双空时);200 ⇒ 账户被预授权通过 = 今天产生不了,记 `not-producible`;其它状态 LOUD。见 §6                   | ◇ not-producible:当前账户有余额,HTTP 200 |
| P3.8 | AC3  | **defect 消失**:平台模型工具表不含本地 `websearch`,所以模型不可能尝试它;直接拒绝的可辨文案留给既有 L1 `alpha-websearch-failure.test.ts`                                          | ☑ pass                                  |
| P3.9 | AC3  | 云侧失败 loud 但**不可分类**(平台薄壳丢弃 `r.status`)—— 已登记缺口 `alpha-platform#105`                                                                                          | ◇ not-producible / 已登记 `#105`         |

### 登出态相位(`--keyless`)

| 项   | AC   | 判据                                                                                      | 结果                                           |
| ---- | ---- | ----------------------------------------------------------------------------------------- | ---------------------------------------------- |
| K0.4 | 前置 | `auth.getState().status === "logged-out"` 且无 `ALPHA_CLOUD_TOKEN` 文件                   | ☑ pass(2026-07-28T01:37Z)                     |
| K1.1 | AC2  | `GET /mcp` 无 `cloud` 键(登出态云暗)                                                      | ☑ pass                                        |
| K1.2 | AC2  | `config.mcp.cloud` 不存在,且 `config.permission.websearch !== "deny"`(keyless 还原)       | ☑ pass                                        |
| K1.3 | AC2  | 存在非网关 provider 的 `toolcall` 模型                                                    | ☑ pass(`deepseek-byok` / `deepseek-v4-flash`) |
| K1.4 | AC2  | `GET /experimental/tool?provider&model` **含** `websearch`                                | ☑ pass                                        |
| K1.5 | AC2  | **keyless 真调**:真实模型轮次产出 `websearch` tool part,`status==="completed"` 且输出非空 | ☑ **pass** —— 见 §5                           |
| K1.6 | AC3  | keyless 失败也必须是可辨错误(不是匿名 defect)                                             | ☑ pass(本次 `completed`,无失败可辨)           |

登出态相位整体 **exit 0,10/10 必需项通过**,且在新产物上**独立跑了两遍**都是 10/10
(K1.5 不是一次侥幸):
[`results/keyless-20260728T013721Z.json`](results/keyless-20260728T013721Z.json)、
[`results/keyless-20260728T015424Z.json`](results/keyless-20260728T015424Z.json)(后者由**本次提交的**探针跑出)。

两条**反向** fail-closed 自检也在新产物上复验过:
[`results/logged-in-20260728T015416Z.json`](results/logged-in-20260728T015416Z.json)(登出态跑登录态相位 → `blocked` + exit 2)、
[`results/keyless-20260728T013532Z.json`](results/keyless-20260728T013532Z.json)(登录态跑 `--keyless` → `blocked` + exit 2)。
两者都只记了 P0.1–P0.3 的前置,**零证据产出**。

旧产物(`94a76b669` / `8706d0c4…`,缺陷发现时)的记录保留不动:
[`results/keyless-20260727T095253Z.json`](results/keyless-20260727T095253Z.json)、
[`results/logged-in-20260727T095330Z.json`](results/logged-in-20260727T095330Z.json)。

### 2026-07-30 判据校正(#651)

2026-07-28 的登录态结果暴露出三条假红与一条空绿。此次只修探针和判读文档,不改产品代码,
也不改任何旧 `results/` 原始证据:

1. P1.2 不再在已经完成 `{file:}` 替换的 `GET /config` 上找引用。打包引擎经自己的 PTY API
   创建短命子进程;该进程继承引擎运行时的原始 `OPENCODE_CONFIG_CONTENT`,但只输出 URL/文件引用
   是否匹配的布尔值,不输出配置或令牌。`GET /config` 只另证替换后的 URL 与密钥文件一致。
2. P1.5 不再要求每份配置对象都显式带 deny,改按 `/agent` 的最终 ruleset 算有效判决。
3. P1.3 明确是匿名 catalog 可用性,不再写“for this account”;P2.2 的真 `tools/call`
   才是账户绑定的 LIVE-PATH gate。
4. P3.8 不再要求模型调用一项已被 P1.7 从工具表移除的工具;它与 P1.7 共用可观察事实,
   可辨拒绝文案由 L1 负责。
5. 计费差分同步适配 Ledger V1:`id` 已不存在,以 `seq` 判断新事实,并轮询等待 Workers
   `waitUntil` 结算出现 `reservation_created(actionId=tool.web_search)` 及同一
   `reservationId` 下的 `usage_settled`、`reservation_settled`。`actionId` 属于预留事实,
   结算事实不重复携带它;探针不再错误要求该字段。

第一次真实登录态运行
[`logged-in-20260731T021405Z.json`](results/logged-in-20260731T021405Z.json)
被原探针自身打出 P1.2/P2.3 两条假红,但同一份记录已经显示:
替换后配置命中密钥文件,且两笔 web-search 都有完整结算链、余额合计扣 30 分。
该失败记录保留不改,用于证明判据为何必须修正。修正后的
[`logged-in-20260731T022038Z.json`](results/logged-in-20260731T022038Z.json)
在同一 `app.asar` 上 23 项、0 个必需失败;两次调用继续产生两笔各 15 分的精确结算。
P3.7 为证明有余额账户真实返回 200,会在 P2.3 测量窗口之后再调用一次,因此每次完整相位
实际为 3 笔 / 45 分。保留的假红运行与最终运行合计 6 笔 / 90 分;最终只读账户摘要为
`walletUsedFen=90`、`balanceFen=99910`(运行前为 100000)。P2.3 表中的 30 分是它刻意圈定的
两条 AC 路径差分,不是整轮总费用。

本次生产被测端点对应部署版本:

- `alpha-gateway`: `8c42c99b-c8d7-4414-b63f-f197e042c36f`
- `alpha-cloud`: `06b278d4-a7e3-4d32-bca4-4520010dbdd8`

## 5. 曾经的阻断项 —— keyless 真调在 `94a76b669` 上是坏的,`e578e00ae` 上已修复

**状态:已解除。** 下面是缺陷本身的记录;修复(PR #648,commit `e578e00ae`)已在新产物上
实测转绿 —— K1.5 在 `60589c59c…` 上 `status === "completed"`,输出是真实搜索结果
(`Title: … URL: https://github.com/…`),不再是截断 JSON。

K1.5 曾在旧打包应用上稳定复现:真实 `websearch` 调用返回
`Web search failed: invalid response. Cause: {…} — SchemaError(SyntaxError: Unterminated string in JSON …)`。
上游 Exa 返回的是**成功**的搜索结果,客户端把它读**截断**了。

用引擎自身的传输写法脱机复现(同一请求,三种读法):

| 读法                                                  | chunk 数 | 收到字节    |
| ----------------------------------------------------- | -------- | ----------- |
| `Stream.runForEachWhile`(旧 `readBoundedBody` 的写法) | 1        | 4,090       |
| `Stream.runForEach`                                   | 3        | 18,063      |
| `response.text`                                       | —        | 18,034 字符 |

`Stream.runForEachWhile` 在谓词恒为 `true` 时仍在第一个 chunk 后停止 ——
`packages/opencode/src/tool/mcp-websearch.ts` 的 `readBoundedBody` 因此把**任何超过一个 chunk 的
搜索响应截断**,JSON 解析必然失败,落成 `invalid_response`。#639 之前该处是
`const body = yield* response.text`(读全量),所以这是 #639(#489 有界读取那一刀)带进来的回归。

本仓其实**已经记过这个 API 的雷**:`packages/opencode/src/tool/read.ts:143-145`
——「we also avoid `Stream.runForEachWhile` (it currently swallows the final unterminated line …)」。

处置:没有在本票(VERIFY)里改源码。修复走了独立的 CODE 票 —— `alpha-code#647` / PR #648,
commit `e578e00ae`:`readBoundedBody` 换成 `Stream.runForEach` 读全 + `BodyCapReached` tagged error
在触限那一刻中止上游流,`MAX_BODY_BYTES` 这条 DoS 硬限与 `truncated` 语义都不变
(同构于 `packages/opencode/src/tool/read.ts:146` 早就记过的写法)。

**修复在打包版里生效已被两条独立判据确认**,不是「源码合了就假定」:

1. 解包 `app.asar` 后,`out/main/chunks/node-*.js` 里的 `McpWebSearch.readBoundedBody`
   确为 `Stream.runForEach` + `catchTag("BodyCapReached")` —— 打进去的是修好的那份。
2. 真机跑 `--keyless`:K1.5 `completed`,拿到完整的多 chunk 搜索结果。

副作用(当时的判断,仍成立):登录态相位的 P2.1 走的是云 MCP 客户端(`mcp/catalog.ts`),
**不经**这条传输;P3.8 的本地 deny 路径同样不经它(闸在请求构造之前)。

## 6. 402 / 余额 —— 裁决「采」,以及它今天能不能产生

**冲突已消。** #643 正文原写 out-of-scope(「不采集 402/余额证据」,退出条件「失败集证据无 402 项」),
与基线票 6 的 2026-07-25 更正(「须含 402 项」)相反。owner 2026-07-27 在 #643 上**裁定:采** ——
理由是多采一项证据没有害处,漏采则要再叫 owner 一次。**#643 正文已按裁决改写**,不再留这处矛盾。

探针的 P3.7 因此变成一条**真打**的判据(不再是 `out-of-scope` 跳过),并且**不预设结论**:
它发一次带真 bearer 的 `POST /v1/tools/web_search`,看它真的回什么。

### 平台侧只有两条臂能出 402

依据 alpha-platform `packages/gateway/src/worker.ts` 的 `webSearchHandler`:

| 臂                                                       | 触发条件                                                                                                           | 桌面端可达?                                                                                                                                                                           |
| -------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **A. per-job 预算耗尽**(`perJobPrecall` → `kind:"over"`) | `auth.via === "job"`,即一枚 `JOB_TOKEN_SECRET` 签发、claims 带 `job_id` 的 job token(`lib/tenant-auth.ts:114-123`) | **不可达**。桌面端登录拿到的是 route-purpose 绑定的 JWT(`via:"jwt"`),`auth.jobId` 恒空 ⇒ `perJobPrecall` 直接 `{kind:"pass",enforced:false}`。与 P3.4 同源:桌面端铸不出那个形状的凭证 |
| **B. `accountPreauth` 拒绝**                             | 账户服务回 `{ok:false}`(「超出会员额度且钱包余额不足」,`worker.ts:243`)                                            | **仅当账户余额与会员额度双空**。预估价是路由常量(`BILLABLE_ROUTES[…].estimatedCostUsd`),请求体只有 `{query,max_results}`,客户端**没有任何调价/调额杠杆**                              |

### 判读规则(写在探针里,运行前定好)

| 观测         | 记法                          | 含义                                                                                                                                                  |
| ------------ | ----------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------- |
| HTTP **402** | ☑ `pass`(required)           | 真拿到了 402 证据                                                                                                                                     |
| HTTP **200** | `not-producible`(非 required) | 账户被预授权通过 —— **这本身就是「今天产生不了 402」的可观测证据**,不是绿、也不是静默跳过。JSON 里带实测 `balanceFen`/`walletUsedFen`/`plan` 作为理由 |
| 其它状态     | ☒ `fail`(required)            | 意外状态必须 LOUD,先查清再接受这一轮                                                                                                                  |

**为什么不主动把账户打空去凑 402**:那是对 owner 计费状态的破坏性变更,而且会连带让同一轮的
P2.1/P2.2(真调)与 P2.3(计费)一起失败 —— 402 证据与 AC1/计费证据**不可能在同一个账户形态下同时取到**。
所以 owner **不需要**为 402 做任何额外操作;探针会照实记录当天的账户形态。
映射本身(两条臂 → `payment_required`)由 L1 覆盖:
`packages/opencode/test/tool/alpha-websearch-failure.test.ts`。

## 7. 已知风险:云工具在引擎里的真实 id 可能不是 `cloud_web_search`

引擎给远端 MCP 工具起名是 `sanitize(<server 名>) + "_" + sanitize(<远端工具名>)`
(`packages/opencode/src/mcp/catalog.ts:117-119`)。alpha 的 server 名是 `cloud`
(`packages/ui-mac/src/main/cloud-web-search.ts`),而 [2026-07-22 的探针](../2026-07-22-e7-deploy-probe.md)
实测该 worker 的 `tools/list` 返回的**远端名已经是** `cloud_web_search`。两者相拼即
`cloud_cloud_web_search` —— 全仓 grep `cloud_cloud` 零命中,说明这条从未被观测过
(此前两次取证用的都是裸 MCP 客户端,不经引擎)。

P1.3/P1.4 就是为此设计的:探针**记录**远端真实名并**推导**引擎侧 id,不假定。

### 看到 `MISMATCH` 之后该做什么(判读方法)

P1.4 的 `observed` 里有三个字段:`remoteName`(worker 实测返回的远端工具名)、
`derivedEngineId`(按上面的拼名规则推导出的引擎侧 id)、`alphaPinnedId`(alpha 全仓钉的字面量
`cloud_web_search`);不一致时 `note` 以 `MISMATCH:` 开头。

- **没有 `MISMATCH`** ⇒ 引擎侧 id 与全仓字面量一致,下面这些闸不需要动。
- **出现 `MISMATCH`** ⇒ 说明**所有按 `cloud_web_search` 字面量下的闸都下错了位置**,
  它们盯的是一个引擎里并不存在的工具名 —— 也就是说这些闸**当前是空闸门**(闸在,但永不命中)。
  必须按 `derivedEngineToolId` 逐个重核,**另开一张 CODE 票**,不要在本 VERIFY 票里改源码:

  | 要重核的闸                                | 位置                                                                                     | 下错了会怎样                                    |
  | ----------------------------------------- | ---------------------------------------------------------------------------------------- | ----------------------------------------------- |
  | permission deny(云优先时抑制本地 keyless) | `packages/ui-mac/src/main/cloud-web-search.ts` 注入的 `permission.websearch` / 云工具 id | 抑制不生效或误伤,P1.5/P1.7 的绿变成假绿         |
  | ext 的 `tool.execute.before` 钩子         | `packages/ext/src/`(云 websearch kill-switch 与主权闸)                                   | kill-switch(#223 AC4)拦不住真实工具名 = 关不掉  |
  | 引擎侧工具枚举/展示                       | `packages/opencode/src/mcp/catalog.ts:117-119` 的拼名                                    | 名字对不上,模型看到的工具与闸盯的工具不是同一个 |

  重核判据不是「grep 到字面量」,而是**用真实 id 跑一遍这三个闸并确认它们真的命中**
  —— 本仓的教训是「闸门是假的」比逻辑错更常见(见 `AGENTS.md` / 闸门四形态)。

## 8. 边界(本目录**不**证明什么)

1. **不做平台侧单测** —— 平台仓自证(#643 out-of-scope)。
2. **不覆盖 kill-switch(`ALPHA_WEBSEARCH_DISABLE`)** —— 那是 #223 AC4,不在 #643 三条 AC 内;
   它的判据在 `packages/ext/src/cloud-websearch-kill.test.ts` 等 L1 套件里。
3. **P3.4/P3.5/P3.6 是 `not-producible`,不是 pass**;**P3.7 在账户有额度时同样记 `not-producible`**
   —— 结果 JSON 里如实标注理由与 L1 覆盖位置。把造不出来的失败态记成绿色就是假闸门。
4. **单次采样不是分布** —— 本目录给的是「这条链在这个构建上真的通/不通」,不是稳定性或 P95。
