---
title: E7 打包真调 + keyless 兜底 + 计费/失败证据(L2/RC)
kind: verification
status: active
owners:
  - alpha-code maintainers
last_reviewed: 2026-07-27
review_after: 2026-10-27
---

# E7(alpha-code#643)打包版真机取证

规格来源:[`docs/design/2026-07-22-e7-cloud-web-search-baseline.md`](../../design/2026-07-22-e7-cloud-web-search-baseline.md)
票 6。被取证的实现是 PR #639(2026-07-26 合入)之后的代码 —— 前一份证据
[`docs/verification/2026-07-22-e7-deploy-probe.md`](../2026-07-22-e7-deploy-probe.md)
验的是**前提**(worker 已部署、匿名 `tools/list` 有 `cloud_web_search`、gateway 规范路径 fail-closed),
且比 #639 旧,不能支撑本票任何一条 AC。

**本目录目前完成了「取证准备 + 登出态那一半」。** 登录态那一半需要 owner 本人在真机上登录后执行
[`probe.ts`](probe.ts);未登录时探针**拒绝产出证据**并以非零退出(见 §4)。

## 1. 被测件

| 项 | 值 |
| --- | --- |
| 应用 | `/Applications/alpha-code.app`(`ship:mac` 装机版,非 `dist/` 直跑) |
| 构建时间 | 2026-07-27T21:31:42 -0400(= 2026-07-28T01:31:42Z) |
| 基线 commit | `e578e00ae`(`alpha`,工作树干净) |
| `sha256(Contents/Resources/app.asar)` | `60589c59c58e44ac0daede93fc7397a8a04365f5345eac4312e205a0d8f48e44` |
| CFBundleShortVersionString | `0.1.2` |
| 引擎版本 | `1.17.13` |
| userData | `~/Library/Application Support/ai.opencode.desktop.dev` |

`app.asar` 的 sha256 被钉进 `probe.ts`(`PINNED_ASAR_SHA256`)。探针第一件事就是重算它并比对 ——
**在错的构建上跑出来的绿是假绿**,这条判据把它挡住。重新打包后必须同时更新此处与 `probe.ts` 的常量。

### 为什么重打了一次

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

每一项都写死了**运行前就定好的判据**(结果 JSON 里的 `criterion` 字段),输出机器可读 JSON 到
[`results/`](results),带采集时刻、被验 commit、asar 指纹、应用版本。
探针自身不含任何密钥:它用的每一个凭证都是**打包应用自己签发并写进自己 secret 文件**的
(`<userData>/alpha-secrets/*`),运行时读取,写盘前经 `redact()` 抹除。

## 3. 复现步骤(owner 照敲)

**登出态那一半(⑤)已经跑完并通过**,机器现在停在:新产物已装、`ALPHA_CDP=1` 已开、应用**处于登出态**
(为跑 keyless 相位而登出;走的是应用自己的「退出登录」路径,BYOK 钥匙没动)。
所以 owner 只需要 ②③ 两步;①④⑤ 留作完整复现记录。

```bash
# ① 用本仓标准 CDP 口子重启打包应用(这是拿到 sidecar 凭证的唯一通道)
#    —— 应用此刻已在 CDP 下运行;只有当它被关掉时才需要这一步
pkill -f "/Applications/alpha-code.app" ; sleep 2
ALPHA_CDP=1 open -a /Applications/alpha-code.app

# ② 在应用里登录(平台代付模式),等模型目录出来   ← owner 从这里开始

# ③ 登录态取证 —— 一条命令跑完
cd ~/app/alpha-code && bun docs/verification/2026-07-27-e7-packaged-live/probe.ts

# ④ 在应用里登出(设置 → 退出登录)

# ⑤ 登出态 keyless 兜底取证 —— 已在 2026-07-28T01:37Z 跑过,exit 0
cd ~/app/alpha-code && bun docs/verification/2026-07-27-e7-packaged-live/probe.ts --keyless
```

退出码:`0` = 全部必需项通过 · `1` = 有必需项不通过 · `2` = 前置被挡(构建不对 / 没开 CDP / 登录态不对)。
两次运行各落一份 `results/<phase>-<UTC>.json`,并覆盖写 `results/latest-<phase>.json`。
探针**幂等**:它只新建 scratch 会话与读取状态,第二遍不依赖也不会被第一遍的残留弄坏。

## 4. 逐项判据与结果

`AC` 列对应 #643 正文三条。`结果` 列由探针填(`results/latest-<phase>.json` 是真源);
下表中已填的行来自新产物(`e578e00ae` / `60589c59c…`)上的真实运行,登录态那一半待 owner 执行。

### 登录态相位(默认)

| 项 | AC | 判据 | 结果 |
| --- | --- | --- | --- |
| P0.1 | 前置 | `sha256(app.asar)` 等于本文件钉的值 | ☑ pass(2026-07-28T01:37Z) |
| P0.2 | 前置 | CDP 端口列出 renderer page target | ☑ pass |
| P0.3 | 前置 | `GET /global/health` → `{healthy:true}` | ☑ pass |
| P0.4 | 前置 | `auth.getState()` 为 `{status:"logged-in",mode:"platform"}` **且** `alpha-secrets/ALPHA_CLOUD_TOKEN` 在位 | ☐ 待 owner(未登录时已实测 `blocked`+exit 2) |
| P1.1 | AC1 | `GET /mcp` 里 `cloud` 的 `status === "connected"` | ☐ |
| P1.2 | AC1 | `config.mcp.cloud.url` 等于应用解析出的 mcp 端点,且 `headers.Authorization` 形如 `Bearer {file:…ALPHA_CLOUD_TOKEN}`(token 不进配置) | ☐ |
| P1.3 | AC1 | **LIVE-PATH GATE ①** 用应用自己的 cloud token 对已部署端点做 `tools/list`,存在匹配 `/web[_-]?search/` 的工具 | ☐ |
| P1.4 | AC1 | 记录引擎侧真实工具 id(`sanitize("cloud")+"_"+sanitize(<远端名>)`),**不假定**是 `cloud_web_search` | ☐ |
| P1.5 | AC1 | `config.permission.websearch === "deny"`,且每个注入 agent 的 `permission.websearch === "deny"` | ☐ |
| P1.6 | AC1 | `/config/providers` 里存在网关 provider 且有 `capabilities.toolcall` 模型 | ☐ |
| P1.7 | AC1 | `GET /experimental/tool?provider&model` **不含** `websearch`(本地 keyless 被抑制) | ☐ |
| P2.1 | AC1 | **打包真调**:一次真实模型轮次产出该云工具的 tool part,`status==="completed"`,输出解析出 `{query,results}` | ☐ |
| P2.2 | AC1 | **LIVE-PATH GATE ②** 用应用自己的 token 直接 `tools/call`,返回 `{query,results}` 且 `isError !== true` | ☐ |
| P2.3 | AC3 | **计费**:两次真调前后 `account.summary()` 的 `walletUsedFen` 上升 / `balanceFen` 下降,或出现新的 usage 流水 | ☐ |
| P3.1 | AC3 | **401**:无 Authorization 打 `POST {platform}/v1/tools/web_search` → 401 | ☐ |
| P3.2 | AC3 | **400**:带真 bearer、body `{}` → 400 | ☐ |
| P3.3 | AC3 | **400**:带真 bearer、坏 JSON → 400 | ☐ |
| P3.4 | AC3 | **403** —— `not-producible`(桌面端只持有 `model.invoke` / `cloud.dispatch` 两个 route-purpose 绑定令牌,造不出 scope 不足的令牌);映射由 L1 `alpha-websearch-failure.test.ts` 覆盖 | ☐ |
| P3.5 | AC3 | **502** —— `not-producible`(需已部署 gateway 同时缺 `TAVILY_API_KEY`/`BRAVE_API_KEY`;两把钥匙都在位,拆生产配置不在探针权限内) | ☐ |
| P3.6 | AC3 | **意外状态 LOUD** —— `not-producible`(桌面端够得着的请求形态都落在 {400,401,402,403,502} 内);映射由 L1 覆盖 | ☐ |
| P3.7 | — | **402 / 余额** —— `out-of-scope`,见 §6 分歧 | ☐ |
| P3.8 | AC3 | **defect 消失**:代付态下调用被 deny 的本地 `websearch`,模型拿到的是可辨 tool error(含「denied by alpha sovereignty」或以 `Web search failed:` 开头),不是崩溃 | ☐ |
| P3.9 | AC3 | 云侧失败 loud 但**不可分类**(平台薄壳丢弃 `r.status`)—— 已登记缺口 `alpha-platform#105` | ☐ |

### 登出态相位(`--keyless`)

| 项 | AC | 判据 | 结果 |
| --- | --- | --- | --- |
| K0.4 | 前置 | `auth.getState().status === "logged-out"` 且无 `ALPHA_CLOUD_TOKEN` 文件 | ☑ pass(2026-07-28T01:37Z) |
| K1.1 | AC2 | `GET /mcp` 无 `cloud` 键(登出态云暗) | ☑ pass |
| K1.2 | AC2 | `config.mcp.cloud` 不存在,且 `config.permission.websearch !== "deny"`(keyless 还原) | ☑ pass |
| K1.3 | AC2 | 存在非网关 provider 的 `toolcall` 模型 | ☑ pass(`deepseek-byok` / `deepseek-v4-flash`) |
| K1.4 | AC2 | `GET /experimental/tool?provider&model` **含** `websearch` | ☑ pass |
| K1.5 | AC2 | **keyless 真调**:真实模型轮次产出 `websearch` tool part,`status==="completed"` 且输出非空 | ☑ **pass** —— 见 §5 |
| K1.6 | AC3 | keyless 失败也必须是可辨错误(不是匿名 defect) | ☑ pass(本次 `completed`,无失败可辨) |

登出态相位整体 **exit 0,10/10 必需项通过**。

原始记录(新产物 `e578e00ae` / `60589c59c…`):
[`results/keyless-20260728T013721Z.json`](results/keyless-20260728T013721Z.json)。
两条**反向** fail-closed 自检也在新产物上复验过:
[`results/logged-in-20260728T013713Z.json`](results/logged-in-20260728T013713Z.json)(登出态跑登录态相位 → `blocked` + exit 2)、
[`results/keyless-20260728T013532Z.json`](results/keyless-20260728T013532Z.json)(登录态跑 `--keyless` → `blocked` + exit 2)。
两者都只记了 P0.1–P0.3 的前置,**零证据产出**。

旧产物(`94a76b669` / `8706d0c4…`,缺陷发现时)的记录保留不动:
[`results/keyless-20260727T095253Z.json`](results/keyless-20260727T095253Z.json)、
[`results/logged-in-20260727T095330Z.json`](results/logged-in-20260727T095330Z.json)。

## 5. 曾经的阻断项 —— keyless 真调在 `94a76b669` 上是坏的,`e578e00ae` 上已修复

**状态:已解除。** 下面是缺陷本身的记录;修复(PR #648,commit `e578e00ae`)已在新产物上
实测转绿 —— K1.5 在 `60589c59c…` 上 `status === "completed"`,输出是真实搜索结果
(`Title: … URL: https://github.com/…`),不再是截断 JSON。

K1.5 曾在旧打包应用上稳定复现:真实 `websearch` 调用返回
`Web search failed: invalid response. Cause: {…} — SchemaError(SyntaxError: Unterminated string in JSON …)`。
上游 Exa 返回的是**成功**的搜索结果,客户端把它读**截断**了。

用引擎自身的传输写法脱机复现(同一请求,三种读法):

| 读法 | chunk 数 | 收到字节 |
| --- | --- | --- |
| `Stream.runForEachWhile`(旧 `readBoundedBody` 的写法) | 1 | 4,090 |
| `Stream.runForEach` | 3 | 18,063 |
| `response.text` | — | 18,034 字符 |

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

## 6. 需要 owner 裁决的分歧:402 采不采

- **#643 正文**(2026-07-27 写)明说 out-of-scope:「不采集 402/余额证据 —— 该路径今天不产生」,
  退出条件还写「失败集证据**无 402 项**」。
- **基线票 6 的 2026-07-25 更正**说的正相反:平台侧 `accountPreauth` 与 per-job 预算 precall 都已上线,
  402 是**可采集的真实失败态**,「失败集证据**须含** 402 项」。

探针按 **Issue 正文**执行(P3.7 记为 `out-of-scope`,并在 JSON 里同时记下这段冲突),不擅自扩范围。
若 owner 判以基线为准,402 可以用「把账户余额打到不足」或「per-job 预算压到 0」的真实路径采集,
届时给探针加一项即可。

## 7. 已知风险:云工具在引擎里的真实 id 可能不是 `cloud_web_search`

引擎给远端 MCP 工具起名是 `sanitize(<server 名>) + "_" + sanitize(<远端工具名>)`
(`packages/opencode/src/mcp/catalog.ts:117-119`)。alpha 的 server 名是 `cloud`
(`packages/ui-mac/src/main/cloud-web-search.ts`),而 [2026-07-22 的探针](../2026-07-22-e7-deploy-probe.md)
实测该 worker 的 `tools/list` 返回的**远端名已经是** `cloud_web_search`。两者相拼即
`cloud_cloud_web_search` —— 全仓 grep `cloud_cloud` 零命中,说明这条从未被观测过
(此前两次取证用的都是裸 MCP 客户端,不经引擎)。

P1.3/P1.4 就是为此设计的:探针**记录**远端真实名并**推导**引擎侧 id,不假定。若两者不一致,
P1.4 会带 `MISMATCH` note —— 那意味着所有按 `cloud_web_search` 字面量下的闸
(permission deny、ext 的 `tool.execute.before`)需要按真实 id 重核,应另开一张 CODE 票。

## 8. 边界(本目录**不**证明什么)

1. **不做平台侧单测** —— 平台仓自证(#643 out-of-scope)。
2. **不覆盖 kill-switch(`ALPHA_WEBSEARCH_DISABLE`)** —— 那是 #223 AC4,不在 #643 三条 AC 内;
   它的判据在 `packages/ext/src/cloud-websearch-kill.test.ts` 等 L1 套件里。
3. **P3.4/P3.5/P3.6 是 `not-producible`,不是 pass** —— 结果 JSON 里如实标注理由与 L1 覆盖位置。
   把造不出来的失败态记成绿色就是假闸门。
4. **单次采样不是分布** —— 本目录给的是「这条链在这个构建上真的通/不通」,不是稳定性或 P95。
