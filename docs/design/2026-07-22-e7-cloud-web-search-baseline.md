---
title: E7 云优先 web search — 登录态权威选路与失败诚实
kind: design
status: active
owners:
  - alpha-code product and design maintainers
last_reviewed: 2026-07-25
review_after: 2027-01-16
---

# E7 — 云优先 web search 基线(alpha-code#223)

平台已把 `web_search` 做成 host-tool 端点族首员(key 恒在 gateway,per-call 计费
归属租户),并经 `cloud` MCP 薄壳暴露给已登录桌面端。alpha-code 已把远端工具**接进
了传输层**,但没有做三件事:①云优先选路 ②失败诚实 ③逃生开关覆盖云。本稿把这三件
补齐,并把「谁是权威」的主权判据钉死在本地。

> 单向门:**整份「云优先」设计的前提是 `cloud_web_search` 在部署实例的 `listTools`
> 里真实可见、且一次真调返回 `{query,results}`。** 这必须在动手前用运行时探针复验
> (见 §1 LIVE-PATH GATE)。REQ-097 教训:代码存在 ≠ 链路在跑。

---

## §1 只读勘破(现行真实行为)

### LIVE-PATH GATE(REQ-097 类,实现前必过)

从代码/配置**已核**(非运行时):

- 部署实例 = `alpha-cloud` worker,`main: src/cloud.ts`
  (`packages/gateway/wrangler.cloud.jsonc:4`),路由 `alpha-cloud.tidelabs.click`
  (`:7`)。`cloud.ts:81-86` 用 `createMcpHandler(buildMcpServer(...))` 挂 `/mcp`。
- `buildMcpServer` 注册 `cloud_web_search`(`cloud-mcp.ts:149-165`)→ 它**在**该
  worker 的 `listTools` 里。
- 该 worker 绑 `GATEWAY → alpha-gateway`(`wrangler.cloud.jsonc:21-22`),`cloud_web_search`
  经 `env.GATEWAY.fetch(".../v1/tools/web_search")` 转发(`cloud-mcp.ts:157`)。
- 打包默认 `cloud = https://alpha-cloud.tidelabs.click`(`alpha-config.ts:29`)、
  `mcpGateway = "/mcp"`(`:48`);`ALPHA_CLOUD_MCP_URL = ep.mcp ?? {cloud}/mcp`
  (`alpha-auth.ts:172`)→ 打包指向的正是上面这个挂了 `cloud_web_search` 的 worker。

**必须运行时探针复验(不可从代码断言)**:对**实际部署** URL 做一次 `listTools`,
确认 `cloud_web_search` 在册;再做一次真调,确认返回 `{query,results}`(即部署的
`alpha-gateway` 确有 `TAVILY_API_KEY`/`BRAVE_API_KEY` secret、且在 audit#12 之后的
代码上)。任一为假 → 本稿云优先设计作废,退回 keyless 本地并重开前提。

### 真实契约:`POST /v1/tools/web_search`(`worker.ts:752-796`)

- 挂载:`:795` `/v1/tools/web_search`(规范)+ `:796` `/v1/web/search`(别名)。
- 请求:`{ query: string, max_results?: number }`(`:759,:762`,`max_results` 缺省 5)。
- 响应:`{ query, results[] }`(`:793`)。
- 失败面(**2026-07-25 更正,见下方「勘破更正」**):`401 {error.message:"unauthorized"}`
  (无 auth);`403 {error.code:"action_forbidden"}`(`model.invoke` 未授权)与
  `403 {error.code:"job_not_enforceable"}`;`400`(坏 JSON / 缺 query);
  **`402` 两条**(per-job 超预算 / `accountPreauth` 拒绝);`502`(无 Tavily/Brave 后端);
  `503`(预算执行器不可用 / settlement capability 不可用 / `BILLING_UNREADY`)。

> **勘破更正(2026-07-25,alpha-code#223)**:本稿 2026-07-22 写的「**无 402/余额面**」与
> 「`403 scope_forbidden`」**今天都是错的**,照原文实现会漏掉真实失败态。平台侧
> (`packages/gateway/src/worker.ts` @ `2fd1984`)已变:
>
> - `/v1/tools/web_search` 已登记进 `BILLABLE_ROUTES`(`:92`,`reservePolicy:
>   "fixed-web-search-unit"`),并由启动断言 `assertRegisteredBillableRoutes(app.routes)`
>   (`:952`)与真实 router 双向核对 —— ADR-018「未登记的收费入口不得运行」对 `web_search`
>   **已满足**,`alpha-platform#37` 的 web_search 切片(AC5)已落地。
> - `webSearchHandler`(`:849-871`)**已有 preauth**:per-job 预算 precall 超额 → `402`
>   (`:863`);`accountPreauth(env, auth, "web-search", …)` 拒绝 → `402`(`:867-871`)。
> - 403 的码是 **`action_forbidden`**(`:853-854`),不是 `scope_forbidden` ——
>   `scope_forbidden` 属**另一个 worker**(`packages/gateway/src/server.ts:59`),不在这条链上。
>
> 故 E7 的失败集**必须含 402**(两条来源),且 403 的可辨性要靠 `error.code`。本稿下文
> §3b/票 3c 中一切「无 402 分支 / 402 是未来分支 / web_search 尚未入册」的表述,以本块为准。
> 交付实现见 #489(`WebSearchFailure`)与 [[ADR-035]]。
>
> **二次更正(2026-07-25,#223 对抗审计 Major 2)——客户端能消费到哪一步**:上列是**平台**
> 的失败面事实,但 alpha-code 今天只在**本地 Exa/Parallel 直连链路**上做得到分类。登录态的
> `cloud_web_search` 走 MCP 客户端(`packages/opencode/src/mcp/catalog.ts`),而平台的 cloud MCP
> 薄壳(`packages/gateway/src/cloud-mcp.ts`:`const body = await r.json(); return text(body, !r.ok)`)
> **把 `r.status` 丢掉了**,gateway 的两条 402 body 也**不带 `error.code`**(只有 `message`,
> per-job 那条多一个 `job_id`)。因此云失败是「loud + 原 body 完整,但无状态、无分类」。
> 本稿与 [[ADR-035]] 里任何「HTTP 状态在 body 透传」的说法均已作废。透传缺口归
> **alpha-platform#105**;在它落地前不得声称云侧 402 已被消费。
- 计费:per-call `WEB_SEARCH_USD_PER_CALL` 进 ledger(`:764`)+ settle(`:765-792`,
  失败入 `SETTLE_Q` 死信,非静默吞)。

### 云薄壳:`cloud_web_search`(`cloud-mcp.ts:149-165`)

- `:154-155` `authTenant` 失败 → `unauth()`(isError);`:156` 无 `GATEWAY` 绑定 →
  isError;`:162-163` `return text(body, !r.ok)` → **仅** `!ok` 时 isError,透传
  gateway body。
- 注意(`:147-148` 注释):此 facade **不**加 `cloud` scope 闸,gateway 侧以
  `models` scope 把关 → 云 web search 归模型面、与模型访问同权,和本地 keyless 共存。

### alpha-code 侧(现状缺口)

1. **无云优先选路**:本地 keyless `websearch`(**live=**`packages/opencode/src/tool/websearch.ts`,
   Exa/Parallel,`selectWebSearchProvider` `:30-37`)与云 `cloud_web_search` 并存,名字不同、
   **两个工具都对模型可见,无优先级**。(`packages/core/src/tool/websearch.ts` 的 v2 builtin
   **不被打包引擎挂载**,见缺口2。)
2. **失败不诚实(打包实为 `packages/opencode/src/tool/websearch.ts`)**:打包 sidecar 服
   `virtual:opencode-server` → `packages/opencode/dist`(`ui-mac/electron.vite.config.ts:8,:76`;
   `sidecar.ts:95`),故**活工具是 opencode 副本**,`core` v2 builtin 永不挂载。其失败面:
   `:136` `output: result ?? "No search results found…"` —— 空/nullish 结果**伪装成成功串**
   返回;`:140` `.pipe(Effect.orDie)` —— 执行分支**一切错误塌成 defect(die)**,既非可辨的
   `ToolFailure`,也**无** 4xx / 5xx / 余额 区分,调用方拿到的是**未处理 defect(工具崩溃)**。
   工具可见性由 `registry.ts:289` → `webSearchEnabled`(`:58-59`)闸。云壳只有 `isError`,
   **无处**区分 4xx / 5xx(含 `402`,见 §1 勘破更正),也无处禁「假成功」。
3. **逃生开关不覆盖云**:`ALPHA_WEBSEARCH_DISABLE` 只闸本地 `OPENCODE_ENABLE_EXA`
   (`server.ts:122`,`sidecar.ts:190`)——**完全不碰** `sidecar.ts:369-380` 注册的
   云 MCP。关了本地 web search,云 `cloud_web_search` 仍活。
4. **caps.websearch 失真**:`sidecar.ts:188-193` 的 `websearch` 事实只看本地两开关,
   **不反映**云工具是否在场(而 `cloudDispatch` 事实反映了云在场)。
5. **(2026-07-25 补勘破,#621)冷启动时序缺陷 —— 云优先在冷启动路径上从未成立**:
   force-off 的判据 `ALPHA_CLOUD_MCP_URL` 只在 `alpha-auth.ts` 的 `applyAuthEnv()` 里写,
   由 `initAuthEnv()`(`main/index.ts`,`whenReady` 之后)触发,**晚于** `preferAppEnv()`。
   故 #490 交付的 force-off 在冷启动的登录用户身上**恒不触发**,`preferAppEnv` 反把
   `OPENCODE_ENABLE_EXA` 设成 `"1"` → fork 出去的 sidecar 里本地 keyless 与
   `cloud_web_search` **双活**。原单测手工预置了 `ALPHA_CLOUD_MCP_URL`,掩盖了真实时序。
   修法 = 把闸抽成 `applyWebSearchSovereignty()`,在 `spawnLocalServer()` 里
   `syncSecretFiles` 之后、fork 之前每次重算,并做成双向幂等(登出 respawn 还原 keyless)。

远端接线本身正确:`sidecar.ts:369-380` 仅当 `ALPHA_CLOUD_MCP_URL` + `ALPHA_CLOUD_TOKEN`
密钥文件同在时注册 `cloud`(登录→云工具可见;登出/BYOK→暗),bearer 走 `{file:}` 通道
(`:377`,A6),不落进程 env。

---

## §2 选定方案 + 被否决替代

### 判据先行:让 THIS system(alpha-code)成为权威,外部无法覆盖?

**能,且无需 per-call 与 platform 同步。** 登录态由 alpha-code 本地推导
(`alpha-auth.ts §③`),选路完全是本地开关的函数。红旗 = 任何「需要 platform 回声
选路状态」的方案 —— 那是须与外部逐点同步的无底洞,坚决否决。

### 选定:登录态门控选择 + 本地工具抑制

- **已登录 / 平台付费**:`cloud_web_search` 为**权威**;**抑制本地 keyless**。模型面上
  只剩一个 web search 工具。
- **登出 / BYOK**:云暗(现有 `sidecar.ts:370` 门已保证);仅 keyless 本地。

**机制选定 = 主权 force-off,而非 set-if-unset。** 现行 `server.ts:122` 是
`OPENCODE_ENABLE_EXA: process.env.OPENCODE_ENABLE_EXA ?? "1"`(set-if-unset,且**只**碰
这一个 flag)——用户 shell 若 `export` 了 §3a 枚举的 5 个 enable flag 中**任一**,抑制/
关闭都**压不住**。故抑制必须是**显式 force-off**:把 4 个 keyless flag(`OPENCODE_ENABLE_EXA`
/ `OPENCODE_EXPERIMENTAL_EXA` / `OPENCODE_ENABLE_PARALLEL` / `OPENCODE_EXPERIMENTAL_PARALLEL`)
在 `preferAppEnv` 里**覆盖写 `"0"`**(不是 `??`),压过 shell export。`OPENCODE_EXPERIMENTAL`
(umbrella,第 5 个 flag)是唯一在 env 层压不干净的项:它单独点亮 `enableExa`,而盲目 force-0
它会连带关掉所有实验能力(见 §3a 爆炸半径),故其 web_search 路径的收口是一处**有界实现
确认**(见票 3 退出条件),不是设计决策。理由:云 MCP 是
**全有或全无的远端** server,客户端无法可靠地对远端做「改名/重排单个工具」。抑制本地是
唯一在本地、模型无法绕过、且零 platform 同步的主权点——alpha-code 拥有 `preferAppEnv`,
凭本地登录态决定,写死。

> `webSearchEnabled` 的 `providerID==="opencode"` 分支(`registry.ts:58-59`)在打包桌面端
> **不可达**:产品不发布 `opencode`/Zen provider,故该 OR 分支恒为死码。以**禁用 provider
> 棘轮**(forbidden-provider ratchet:断言打包端 provider 目录不含 `opencode`)守死,**无需**
> 为它给 `webSearchEnabled` 打 patch。

**被否决**:
- **重排/改名远端工具**:远端工具名与顺序归 platform 所有;要生效须 platform 回声 →
  红旗,否决。
- **description 引导**(在描述里劝模型优先云):靠模型自觉,可被绕过,非主权,否决。
- **platform 回声选路状态**:每次同步、外部权威压过本地 → REQ-097 式无底洞,否决。

主权注入面(`sidecar.ts:383-392` `injectDisabledOverrides`,加载序 step 6 later-wins)
是已有的「压过一切 in-scope 源」通道;本抑制若需硬压,复用它,不新建探测器。

---

## §3 安全面(class-first,枚举整类)

### (a) kill-switch 类 —— 一开关一具名能力,不误伤兄弟云工具

**现状为什么关不干净(枚举全 5 个 enable flag)**:`webSearchEnabled(providerID, flags)`
`= providerID==="opencode" || enableExa || enableParallel`(`registry.ts:58-59`),其中
`enableExa = OPENCODE_EXPERIMENTAL || OPENCODE_ENABLE_EXA || OPENCODE_EXPERIMENTAL_EXA`、
`enableParallel = OPENCODE_ENABLE_PARALLEL || OPENCODE_EXPERIMENTAL_PARALLEL`
(`runtime-flags.ts:31-39`)。现行 `ALPHA_WEBSEARCH_DISABLE=1` 仅让 `server.ts:122` **不
set-if-unset** `OPENCODE_ENABLE_EXA` —— 它**不 force-0**、**不碰**另 4 个 flag。故用户 shell
对**任一** flag 的 `export`,都能让本地 `web_search` 在「已关闭」下**复活**。两开关的 2 行表
**无法**满足不变量。(`providerID==="opencode"` 那条 OR 分支在打包端**不可达**——产品不发布
`opencode`/Zen provider——故不是复活面,以禁用 provider 棘轮守死,不 patch。)

| 关闭/抑制的执行 | 覆盖对象 | 手段 |
| --- | --- | --- |
| force-off 4 个 keyless flag | `OPENCODE_ENABLE_EXA`、`OPENCODE_EXPERIMENTAL_EXA`、`OPENCODE_ENABLE_PARALLEL`、`OPENCODE_EXPERIMENTAL_PARALLEL` | `preferAppEnv` **覆盖写 `"0"`**(压过 shell export),非 `??` |
| umbrella(不误伤兄弟实验能力) | `OPENCODE_EXPERIMENTAL`(第 5 flag) | **不可**盲目 force-0(会连带关全部实验能力)→ 有界实现确认:仅收口 web_search 的 umbrella→`enableExa` 路径(见票 3 退出条件) |
| 云 `cloud_web_search` | 远端 MCP 工具 | 逐工具过滤 / 整 server 门(见下机制难点) |

**爆炸半径**:force-off 4 个 keyless flag 只影响 Exa/Parallel 两个 keyless provider,不碰
别的能力。**但** `OPENCODE_EXPERIMENTAL` 是 umbrella(`runtime-flags.ts` 中 references /
background-subagents / lsp-tool / plan-mode / code-mode / event-system / workspaces / oxfmt
等**全部**实验能力都 `experimental || <own>`)——把它 force-0 会**连带关掉所有实验能力**,
本身**违反**「一开关只管一个具名能力」。故 web_search 的关闭**不能**靠盲目 zero umbrella:
实现时先确认 alpha 是否还有别的能力挂在 `OPENCODE_EXPERIMENTAL` 上——若**无**,把它一并
force-0 无害;若**有**,只在工具闸(`webSearchEnabled`)收口 web_search 的 umbrella→`enableExa`
那一条路径,不动其它实验能力(见票 3 退出条件)。

**不变量**:一开关只管一个具名能力(`web_search`);关闭后**不得留下任何活的
web_search**(本地或云,含 shell-export);且**不得**顺带暗掉同一 `cloud`
远端 server 的兄弟工具,也**不得**顺带关掉 umbrella 下其它实验能力。

**已知机制难点(load-bearing,落 §4 票 3 退出条件)**:(1)云 `cloud` 是单个远端
MCP server,其工具集(dispatch/status/await/artifacts/schedule×N/**web_search**)整体在
场。要**只**杀 `cloud_web_search` 而保兄弟工具,须客户端对远端工具做**逐工具过滤**(若引
擎 remote MCP config 支持 tools allow/deny),否则只能整 server 开关(会误伤兄弟)——
后者违反不变量,禁用。(2)`OPENCODE_EXPERIMENTAL` umbrella 供给 web_search 的路径不能靠
盲目 force-0(会连带关全部实验能力):实现时确认 alpha 是否还有别的能力挂在该 umbrella
上——**无**则连带 force-0 无害,**有**则只在工具闸收口 web_search 的 umbrella→`enableExa`
路径。这是**有界实现确认**,非跨仓决策。平台侧 per-tenant flag 因需同步/回声,红旗否决。
CODE 票退出条件 = 落定「引擎是否支持远端逐工具禁用」并据此实现,不支持则降级为 open
question 上报 owner、不得静默整 server 关。

### (b) failure-honesty 类 —— 失败必响,禁伪成功

- 失败 **必须 LOUD**:实现须区分平台契约的真实失败集 `401` / `403`(靠 `error.code` 分
  `action_forbidden` 与 `job_not_enforceable`)/ `400` / **`402`(preauth 拒绝、per-job
  超预算)** / `502` **及任何非 2xx / 意外状态**,分别面向模型呈现可辨错误,**替换**
  `packages/opencode/src/tool/websearch.ts:140` 的 `Effect.orDie`(现把一切错误塌成
  defect,无可辨错误、无状态区分)。**402 是 live 状态,不是未来分支**(2026-07-25 更正,
  见 §1 勘破更正块;原文的「无 402/余额面」与 `scope_forbidden` 均已作废)。
- **禁伪成功**:不得把空/nullish 结果(`websearch.ts:136` `result ?? "No search results
  found…"`)当成功串返回来掩盖失败。
- **唯一允许的回退 = 模型自带(provider 原生)web search**;**禁止**云失败时静默切
  keyless 本地来掩盖云失败(那既掩盖计费真相,又违背云优先主权)。

### (c) auth-state confusion 类 —— 云工具随登录态严格暗/亮

- 登出 / BYOK:`cloud_web_search` 必须暗(现有 `sidecar.ts:370` 门保证,勿回归)。
- token 恒在 `{file:}` 通道(`sidecar.ts:377`,A6),**永不**进本进程 env 或
  `OPENCODE_CONFIG_CONTENT`。
- **不变量**:抑制本地(§2)不得反向漏出「登出仍暗云」的状态混淆——登出既无云也须
  有 keyless 本地兜底。
- SSRF 已在平台侧治理(`lib/web.ts` `isBlockedHost`),**不在本稿范围**。

---

## §4 子票切分

> 命名 `[REQ-xxx][CODE|VERIFY|DECIDE] 动词 + 组件 + 可观察变化`。REQ 号由主 session
> 落库时分配。CODE 正文四行:负责哪些 AC / 边界 / out-of-scope / 退出条件。

1. **[REQ-xxx][CODE] 登录态门控:平台付费时 force-off 本地 keyless websearch(云优先选路)**
   - 负责 AC:已登录/平台付费 → `preferAppEnv` **覆盖写** 4 个 keyless flag 为 `"0"`
     (压过 shell export),本地 `websearch` 不注册,模型面仅存 `cloud_web_search`;
     登出/BYOK → keyless 本地照常(4 flag 回到 set-if-unset 默认)。
   - 边界:仅改 `ui-mac/src/main/server.ts:102-123` preferAppEnv 的 web-search flag 注入,
     登录态取 `alpha-auth.ts §③` 本地推导。
   - out-of-scope:不碰远端工具名/顺序;不引入 platform 回声;`OPENCODE_EXPERIMENTAL`
     umbrella 的收口确认归票 3 退出条件(有界实现确认,非本票);`providerID==="opencode"`
     Zen 分支打包端不可达、以禁用 provider 棘轮守死,不 patch。
   - 退出条件:登录快照下 `listTools` 无本地 `websearch`、有 `cloud_web_search`;登出快照
     相反;且在 shell `export OPENCODE_ENABLE_PARALLEL=1` 下登录态仍无本地 `websearch`。

2. **[REQ-xxx][CODE] web_search 失败映射诚实化(替换 orDie,禁伪成功;意外状态 LOUD)**
   - 负责 AC:`packages/opencode/src/tool/websearch.ts:133-140` 用可辨错误替换
     `Effect.orDie`,区分 `401`/`403`(带 `error.code`)/`400`/**`402`**/`502`/
     **任何非 2xx→LOUD**;`:136` 空/nullish 结果不再当成功串;云失败不静默切 keyless。
   - 边界:opencode `websearch.ts` + `mcp-websearch.ts`;`core` 副本**不动**(打包引擎不挂载
     它);`mcp/catalog.ts` / `tool/code-mode.ts` **不动**(云路径已 loud,不为分类前缀扩大收编面)。
   - out-of-scope:不改平台失败契约;不新增回退路径(除已允许的模型自带 search)。
   - 退出条件:各真实状态与意外状态均有可辨错误文本、无 defect 崩溃;无「空=成功」路径。
   - **交付(2026-07-25,#489)**:`WebSearchFailure` typed failure + [[ADR-035]] L3 接管
     (两文件 + 随源测试退出守卫 pathspec)。原「依赖 alpha-patch 机制」的前提被 owner 裁决取代。

3. **[REQ-xxx][CODE] `ALPHA_WEBSEARCH_DISABLE` force-off 全 keyless flag + 收敛云 web_search(不误伤兄弟)**
   - 负责 AC:开关置位 → `preferAppEnv` **覆盖写** 4 个 keyless flag 为 `"0"`(压过 shell
     export),`cloud_web_search` 同时消失;`cloud_dispatch` 等兄弟云工具仍在册。
   - 边界:`server.ts:122` 改 force-off;`sidecar.ts:369-380` 云 MCP 注册处逐工具过滤;
     `sidecar.ts:190` 本地 caps 门。
   - out-of-scope:不加平台侧 per-tenant flag;`providerID==="opencode"` Zen 分支打包端
     不可达、以禁用 provider 棘轮守死(不 patch);umbrella 收口确认见下方退出条件。
   - 退出条件:①落定引擎是否支持 remote MCP 逐工具禁用并据此实现,不支持则上报 owner、
     **禁**静默整 `cloud` server 关;②**umbrella 有界确认**:检查 alpha 是否还有别的能力
     挂在 `OPENCODE_EXPERIMENTAL` 上——若**无**,把它一并 force-0 无害;若**有**,**不得**盲目
     force-0(会连带关全部实验能力),改为只在工具闸(`webSearchEnabled`)收口 web_search 的
     umbrella→`enableExa` 那一条路径;置位后在 shell `export OPENCODE_EXPERIMENTAL=1` 下仍无
     活的本地 `web_search`。(`providerID==="opencode"` 打包端不可达,不在此列。)
   - **退出条件②的实际收口(2026-07-25,#223 对抗审计 Blocker)**:首轮实现只做了「不盲目
     force-0 umbrella」的前半句,**没做**后半句(「置位后 umbrella 下仍无活的本地 web_search」)——
     审计动态复现:`export OPENCODE_EXPERIMENTAL=1` 后代付态本地 + 云双活,kill-switch 下云暗
     而本地仍活。收口 = 走 [[ADR-009]] 裁决 (b) 的路 (i):注入面对本地工具 ID `websearch` 也写
     `permission: "deny"`(`cloud-web-search.ts`),并连 alpha 自己注入的三个 agent 的
     `websearch: "allow"` 一起压平(引擎 agent 级规则并在全局之后)。零改 umbrella、零改上游
     `registry.ts`。

3c. **[跨仓依赖] web_search per-call 余额门 = `alpha-platform#37`(2026-07-25 更正:已落地)**
   - 归属:per-call 余额门归 `alpha-platform#37`(AC1 单一 reserve 无绕过 + AC5 web-search
     reserve-then-settle)+ ADR-018(「未登记的收费入口不得运行」)。
   - **状态更正**:该切片**已上线**(`packages/gateway/src/worker.ts` @ `2fd1984`):
     `/v1/tools/web_search` 已入 `BILLABLE_ROUTES`(`:92`)、由启动断言
     `assertRegisteredBillableRoutes(app.routes)`(`:952`)与真实 router 双向核对,
     handler 有 `accountPreauth`(`:867-871` → `402`)与 per-job 预算 precall(`:863` → `402`)。
     本稿原文「今天无 `accountPreauth`、settle-only 退化」已作废。
   - alpha-code E7 侧:insufficient-funds decline 是**当下就存在**的 LOUD 失败状态,已由票 2
     的失败映射(`payment_required`)覆盖 —— **但仅限本地 Exa/Parallel 直连链路**。云
     `cloud_web_search` 那条链拿不到状态(平台薄壳丢弃,见 §1 二次更正),失败 loud 但不可分类;
     缺口归 alpha-platform#105。§3 失败诚实不变量不变。

4. **[REQ-xxx][CODE] `caps.websearch` 事实反映云在场**
   - AC:`sidecar.ts:188-193` 的 `websearch` 事实在云工具在场且本地被抑制时仍为真,
     且与实际可见工具一致(参照 `cloudDispatch` 事实写法)。
   - 边界:仅 `buildAlphaIdentity` 输入的 caps 计算。
   - out-of-scope:不改 identity 文案格式。
   - 退出:登录态三快照下 `caps.websearch` 与 `listTools` 实况一致。

5. **[REQ-xxx][DECIDE/DOC] 修订 ADR-009 收编云优先 + kill-switch 语义**
   - AC:ADR-009 记「登录态门控、云权威、逃生开关跨本地+云、失败 force-off 全 keyless
     flag、失败诚实、唯一回退=模型自带 search」;登记(a)远端逐工具禁用机制裁决(票3),
     (b)`OPENCODE_EXPERIMENTAL` umbrella 只收口 web_search 路径、不盲目 force-0(票3 退出
     条件),(c)`providerID==="opencode"` Zen 分支打包端不可达、以禁用 provider 棘轮守死,
     (d)host-tool 的真实失败集(**2026-07-25 更正**:402 与余额门**已上线**、403 码为
     `action_forbidden`;原「无 402/余额门为现状」表述作废,见票3c)。
   - 边界:`.claude/rules/adrs/ADR-009-websearch-default.md` + 必要时新 ADR
     (已新增 [[ADR-035]]:两文件 L3 接管)。
   - out-of-scope:不改本地 keyless 基础设施决策(仍保留作登出兜底)。
   - 退出:ADR status 更新,决策与后果反映本稿各条(含更正后的 402 事实与两条工具闸裁决)。

6. **[REQ-xxx][VERIFY] 打包真调 + keyless 兜底 + 计费/失败证据(L2/RC)**
   - AC:打包桌面端登录态下 `listTools` 探针见 `cloud_web_search` + 一次真调返回
     `{query,results}`;登出态见 keyless 本地兜底;计费(ledger/settle)与真实失败集
     (`401`/`403`/`400`/**`402`**/`502` + 意外状态 LOUD、defect 消失)留证据。
   - 边界:`docs/verification/` 下 L2 harness + RC 冒烟。
   - out-of-scope:不做平台侧单测(平台仓自证)。
   - 退出:证据落 `docs/verification/`,LIVE-PATH GATE 三项全绿。
   - **2026-07-25 更正**:原文「不采集 402/余额证据(该路径今天不产生)」作废 —— 平台侧
     preauth 已上线,402 是可采集的真实失败态,失败集证据**须含 402 项**。

---

## 与现状的关系

- **接线已在,策略未做**:`sidecar.ts:369-380` 已把 `cloud` 远端 MCP 接进传输层,
  `cloud_web_search` 对已登录端可见——本稿**不新建通道**,只在其上加①选路②诚实
  ③开关覆盖④事实四层策略,均落 alpha 自有文件、零改 upstream。
- **ADR-009 是被编辑对象**:ADR-009 现状「桌面默认对所有 provider 放开 keyless
  websearch」正是要被登录态门控**收窄**的前一稿;§16「后续自有 web search 上线用
  `ALPHA_WEBSEARCH_DISABLE=1` 避免撞车」正是本稿票3要落实的接口。keyless 基础设施
  保留,降级为**登出/BYOK 兜底**,非删除。
- **跨仓依赖(不在本稿 author)**:`web_search` 的 per-call 余额 decline 依赖
  `alpha-platform#37` 的 web_search 入册(#37 的一张 CODE 子票);本稿不 author 该切片,
  仅在其落地后消费 insufficient-funds decline(见票 3c)。
- **无向后兼容**:portfolio 无真实用户/租户,契约可直接 breaking,fail-closed;
  不为旧行为建 shim。
- **前提受制于 §1 LIVE-PATH GATE**:若运行时探针证伪云 web_search 在跑,本稿全部
  作废,退回纯 keyless 并重开需求。
