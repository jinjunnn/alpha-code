---
id: ADR-009
title: web search 默认策略 —— 登出/BYOK keyless 放开;登录态云优先权威 + 逃生开关跨本地/云
status: amended
date: 2026-06-18
amended: 2026-07-25
related: [ADR-002, ADR-005, ADR-006, ADR-018, ADR-029, ADR-035]
supersedes_premise: "2026-06-18 的『桌面默认对所有 provider 放开 keyless websearch』现被登录态门控收窄为登出/BYOK 兜底"
---

## 背景
opencode `websearch`(Exa/Parallel)默认只给官方 `opencode`(Zen)provider(`packages/opencode/src/tool/registry.ts` 的 `webSearchEnabled()` 闸门)。第三方 provider(DeepSeek 等)只有 `webfetch`。该工具由 sidecar **直连** Exa/Parallel、不带 opencode 鉴权,key 为可选(仅避公共端点限流)。

2026-07 平台把 `web_search` 做成 host-tool 端点族首员(key 恒在 gateway,per-call 计费归租户),并经 `cloud` MCP 薄壳暴露给已登录桌面端。E7(alpha-code#223)据此把 web search 主权从「一律 keyless 放开」收窄为「登录态门控 + 云优先」。本 ADR 因此从**单一决策**扩为**两态决策**,并登记 kill-switch 与失败诚实的类语义。E7 的完整勘破与替代否决见 `docs/design/2026-07-22-e7-cloud-web-search-baseline.md`。

## 决策 A(2026-06-18,原始,现降级为登出/BYOK 兜底)

> 全部落 alpha 自有文件,零改 upstream。以下四条**仍成立**,但其适用面被决策 B 收窄到**登出 / BYOK** 一态。

1. **默认放开(登出/BYOK 态)**:`ui-mac/src/main/server.ts` 的 `preferAppEnv()` 注入 `OPENCODE_ENABLE_EXA`(默认 `"1"`,set-if-unset)→ 经 sidecar env 继承 → 对**任意 provider** 放开。**不改 `registry.ts` 闸门**。
2. **不做前端 key 入口**:终端用户默认拿 keyless + 限流的 websearch。
3. **秘钥基础设施**:`alpha-secrets.ts` 启动把 `alpha.env`(`KEY=VALUE`)灌进 `process.env`,**不覆盖已有**(shell 优先);`alpha.env` 已 gitignore。
4. **逃生开关**:`ALPHA_WEBSEARCH_DISABLE=1`(语义见决策 B §B2)。

## 决策 B(2026-07-22,E7 收编:登录态云优先 + kill-switch 语义)

已交付实现:cloud-first 选路 **#488**(PR#504)、kill-switch force-off + 云收敛 **#490**(PR#507)、caps 事实 **#491**(PR#510)、失败诚实 **#489**(2026-07-25,经 [[ADR-035]] L3 接管解锁)、冷启动时序修复 **#621**(2026-07-25)。

### B1. 登录态门控选择(云优先),抑制靠本地主权 force-off

- **已登录 / 平台付费**(`ALPHA_CLOUD_MCP_URL` + `ALPHA_CLOUD_TOKEN` 密钥文件同在):`cloud_web_search` 为**权威**;`applyWebSearchSovereignty()` **覆盖写 `"0"`**(非 `??`,压过用户 shell export)到 4 个 keyless flag —— `OPENCODE_ENABLE_EXA` / `OPENCODE_EXPERIMENTAL_EXA` / `OPENCODE_ENABLE_PARALLEL` / `OPENCODE_EXPERIMENTAL_PARALLEL`。模型面上只剩一个 web search 工具。**该闸在每次 sidecar fork 前重算**(`spawnLocalServer`,`syncSecretFiles` 之后),不是只在 `preferAppEnv` 里算一次 —— 两个判据在 `preferAppEnv` 时都还不成立(见「后果 · #621」)。**env force-off 之外还有两道闸**(2026-07-25 补,#223):注入面把本地工具 ID `websearch` 也写 `permission: "deny"`(`cloud-web-search.ts`,负责把工具从模型工具表滤掉),以及**不可覆盖的最终闸** `ALPHA_LOCAL_WEBSEARCH_DENY` —— 同一函数两个方向都写(置位/删除),经 `sidecar-env.ts` 白名单进 sidecar,由 `tool/websearch.ts` 在 `execute` 首行消费 —— 见裁决 (b)。
- **主权基线的取点**(2026-07-25 补,#223):force-off 是覆盖写,会销毁用户真值,登出 respawn 要还原,故必须留底。基线必须在**登录 shell env 合入之后**、首次主权计算之前截取;取早了会把「用户 rc 里 `export OPENCODE_ENABLE_PARALLEL=1`」这类真值丢掉,首次已登出启动就换错 provider。
- **密钥同步失败 = 拒绝 fork**(2026-07-25 补,#223):`syncSecretFiles` 失败时不得继续 fork —— 登出删不掉旧 token 文件的话主权闸仍判 `platformPays=true`,新 sidecar 会带着已作废的 token 注册云工具;反向地登录写失败会静默回落 keyless。fail closed。
- **登出 / BYOK**:云暗(`sidecar.ts` 云 MCP 仅在上述密钥齐备时注册);仅 keyless 本地(决策 A 照常,4 flag 回到 set-if-unset 默认)。
- **权威判据**:登录态由 alpha-code **本地推导**(`alpha-auth.ts §③`),选路是本地开关的函数。**否决**任何「需 platform 回声选路状态」的方案(REQ-097 式跨仓无底洞)、以及「重排/改名远端工具」「description 引导」等非主权手段。

### B2. `ALPHA_WEBSEARCH_DISABLE` = 一开关一具名能力(web_search),跨本地 + 云,不误伤兄弟

- 置位 → 与登录态无关,同样 `applyWebSearchSovereignty()` 覆盖写 4 个 keyless flag 为 `"0"`(压过 shell export),**并**把本地工具 ID `websearch` 写 `permission: "deny"` + 置位 `ALPHA_LOCAL_WEBSEARCH_DENY`(裁决 (b),2026-07-25)。
- 同时收敛云 `cloud_web_search`(见裁决 (a)),但**保留**兄弟云工具(`cloud_dispatch` / `status` / `await` / `artifacts` / `schedule*`)。
- **不变量**:关闭后**不得留下任何活的 web_search**(本地或云);且**不得**顺带暗掉同一 `cloud` server 的兄弟工具,也**不得**顺带关掉 `OPENCODE_EXPERIMENTAL` umbrella 下的其它实验能力。

### 登记的裁决与残留

- **(a) 远端逐工具禁用机制裁决(#490)**:引擎 `ConfigMCPV1.Remote` 只支持**整 server** enable/disable,**不支持** remote MCP 的逐工具 allow/deny。选定实现 = 不动上游、不整 server 关(会误伤兄弟),改用引擎**全局 permission 层**按工具 ID 过滤:`cloud-web-search.ts` 在 `OPENCODE_CONFIG_CONTENT` 注入 `permission["cloud_web_search"] = "deny"`,把该 ID 从普通 + code-mode 模型工具集剔除,**保留** cloud server 与兄弟工具。**残留(loud,已留 TODO)**:远端 catalog 的 `listTools` **仍列**该工具,仅模型工具集不含它;真正的 remote-MCP 逐工具 deny 待引擎暴露该能力后替换。**禁**静默整 `cloud` server 关。
- **(b) `OPENCODE_EXPERIMENTAL` umbrella 只收口 web_search 路径、不盲目 force-0(#490)**:umbrella 是 references / background-subagents / lsp-tool / plan-mode / code-mode / event-system / workspaces / oxfmt 等**全部**实验能力的总开关,盲目 force-0 会连带关掉它们(违反「一开关一具名能力」)。故交付实现**只** force-0 上列 4 个 keyless 专用 flag,**不碰** umbrella。**残留(open)**:`webSearchEnabled = providerID==="opencode" || enableExa || enableParallel`,其中 `enableExa = OPENCODE_EXPERIMENTAL || OPENCODE_ENABLE_EXA || OPENCODE_EXPERIMENTAL_EXA`——用户若显式 `export OPENCODE_EXPERIMENTAL=1`,该 OR 项在 env 层**压不掉**,本地 web_search 仍可复活。该闸(`registry.ts`)在 `UPSTREAM_PATHS`(north-star 守卫),**alpha 不可直接 patch**。收口该残留的两条路:**(i) alpha 可达**——对本地 web_search 工具 ID 也走 permission 层 `deny`(镜像 (a) 的云做法,零改上游);**(ii) 需 alpha-patch 机制**——patch `webSearchEnabled` 的 umbrella→enableExa 路径。
  **2026-07-25 收口(#223 对抗审计 Blocker,原「接受该残留」作废)**:审计动态复现出该绕过不是理论自陷,而是**当下就破 B1/B2 不变量**——`export OPENCODE_EXPERIMENTAL=1` 下代付态本地 + 云双活,kill-switch 下云暗而本地仍活;E7 的 AC 与基线退出条件明确要求该场景也收口,ADR 不能靠声明把不变量降级。选定 **(i)**:`cloud-web-search.ts` 在 kill-switch **或**平台代付时把 `permission["websearch"] = "deny"` 注入 `OPENCODE_CONFIG_CONTENT`,零改 umbrella、零改上游 registry。**必须连 alpha 自己注入的三个 agent 一起压平**(`alpha-automation` / `alpha-readonly` / `alpha-automation-standard` 各写着 `websearch: "allow"`)——引擎的 agent 级规则并在全局规则**之后**(`agent/agent.ts` 的 merge 序 + `Permission.evaluate` 的 `findLast`),不压平的话全局 deny 对这三个 agent 无效。
  **2026-07-25 二次收口(#223 R2 对抗审计 Blocker 1;上一段「已收口」的声明**不成立**,作废)**:R2 用动态探针实测,注入的 `permission["websearch"]="deny"` **仍可被三条后置规则覆盖**,`configOnly=deny` 但加入 session allow 或 approved 后**均变 allow**——① 别的 config 源后加载的 agent 写 `"*": "allow"`(`agent/agent.ts:293` 把 agent 规则并在全局之后,`Permission.evaluate` 取 `findLast`;注入面只够得着 alpha 自己的三个 agent);② `PromptInput.tools.websearch=true` 被 `setPermission` **持久化**进 session(`session/prompt.ts:1060`),`session/tools.ts:87` 再把它并在 agent 规则之后,sidecar respawn 也带得回来;③ `approved` 排在整个 ruleset 之后(`permission/index.ts:73`)。**permission 注入因此不是主权保证**。
  **最终规则改放在工具自身**:`applyWebSearchSovereignty()` 每次 fork 前把判决写进 `ALPHA_LOCAL_WEBSEARCH_DENY`(`sidecar-env.ts` 白名单放行),ADR-035 已接管的 `packages/opencode/src/tool/websearch.ts` 在 `execute` 的**第一行**读它并直接以 `ToolFailure` 拒绝——它不查 ruleset,故没有任何 permission 规则能覆盖。这是最窄的解:零新增上游接管(该文件已在 ADR-035 的 exclude 清单内),不碰 `permission/index.ts` 的求值序,也不碰 `registry.ts` 的注册闸。注入面的 permission deny **保留**,但降级为**可用性**手段(把工具从模型工具表滤掉),不再被当作主权保证。三条绕过各有一条反向测试(`test/tool/alpha-websearch-failure.test.ts`,走真实 `Tool.init` → `execute` 路径:先断言该绕过在 permission 层**真的**判 allow,再断言工具仍拒绝且传输层零命中)。
  **事实更正**:上一段称「deny 只靠 `ctx.ask` 拦下、工具名仍可见」——**不准确**。正常 deny 在请求准备阶段就把工具从模型工具表滤掉(`tool/registry.ts:286` + `session/llm/request.ts:208` 的 `Permission.disabled`),模型根本看不到它;`ctx.ask` 是同一条 deny 的第二道。
  **残留(缩小后)**:被绕过的规则集下模型**看得见** `websearch` 工具名(`Permission.disabled` 只看 ruleset 的最后一条,后置 allow 会让它重新可见),调用则一律被工具级最终闸拒绝并返回一条「不要重试」的 `ToolFailure`——能力真关,可见性是 cosmetic。
- **(c) `providerID==="opencode"` Zen 分支打包端不可达**:产品不发布 `opencode`/Zen provider,`webSearchEnabled` 的该 OR 分支恒为死码。以**禁用 provider 棘轮**(forbidden-provider ratchet:断言打包端 provider 目录不含 `opencode`)守死,**无需**为它 patch 上游闸。
- **(d) host-tool 的真实失败集(2026-07-25 更正:402 与余额门**已上线**)**:本条 2026-07-22 的原始表述——「`POST /v1/tools/web_search` 无 `accountPreauth`、计费仅事后 settle,故该路径无 402/余额面」——**今天是错的**,照它实现会漏掉真实失败态。`alpha-platform#37` 的 web_search 切片已落地(`packages/gateway/src/worker.ts` @ `2fd1984`):路由已登记进 `BILLABLE_ROUTES`(`:92`,`reservePolicy: "fixed-web-search-unit"`)且由启动断言 `assertRegisteredBillableRoutes(app.routes)`(`:952`)双向核对,ADR-018「未登记的收费入口不得运行」对 `web_search` 已满足。`webSearchHandler`(`:849-871`)今天的失败集:
  - `401` 无 auth;
  - `403` **`error.code = "action_forbidden"`**(`:853-854`,`model.invoke` 未授权)—— 原稿写的 `scope_forbidden` 是**另一个 worker**(`packages/gateway/src/server.ts:59`)的码,不在这条链上;另有 `403 job_not_enforceable`(`:864`,per-job 预算不可强制);
  - `400` 坏 JSON / 缺 query;
  - **`402` 两条**:per-job 超预算(`:863`)与 `accountPreauth` 拒绝(`:867-871`,预授权失败即拒、不调后端);
  - `502` 无 Tavily/Brave 后端;`503` 预算执行器不可用(fail-closed)/ settlement capability 不可用。

  E7 侧据此消费:**402 是一条真实的 LOUD 失败状态**,不是待来的假想分支;`403` 的可辨性靠 `error.code`。计费仍以 settle 收口(失败入 `SETTLE_Q` 死信,非静默吞),但那已在 reserve 之后。

  > **消费面的边界(2026-07-25 补,#223 对抗审计 Major 2)**:上列状态是**平台契约**的事实;alpha-code 今天真正**能分类**的只有本地 Exa/Parallel 直连链路。登录态的 `cloud_web_search` 走 MCP 客户端(`mcp/catalog.ts`),而平台的 cloud MCP 薄壳(`packages/gateway/src/cloud-mcp.ts` 的 `text(body, !r.ok)`)**丢弃了 HTTP 状态**,gateway 的两条 402 body 也不带 `error.code` —— 云失败因此是「loud + 原 body 完整,但无状态、无分类」。不得声称云侧 402 已被映射成 `payment_required`。透传缺口归 **alpha-platform#105**;回归基线由 `packages/opencode/test/tool/alpha-websearch-failure.test.ts` 走真实 `McpCatalog.convertTool` 链路钉住。**到期条件(2026-07-25 二轮补,R2 B 项)**:那条反向断言是**硬编码的现状 fixture**,#105 落地后**不会自动变红** —— 届时必须改成 status/code 的正向断言,并同步更新本段与 [[ADR-035]] §1,否则它会从事实基线变成误导性基线。

### B3. caps 事实(#491)
`sidecar.ts` / `buildAlphaCapabilities` 的 `websearch` 事实在「云工具在场且本地被抑制」时仍为真,与实际可见工具一致(参照 `cloudDispatch` 事实写法)。修正了「登录 + force-off keyless → 误报 websearch=false」的旧 bug。

## 后果

- ✅ **登出/BYOK**:第三方 provider 开箱即有 keyless websearch,零配置;零改 upstream(决策 A 保留为兜底,**非删除**)。
- ✅ **登录/平台付费**:`cloud_web_search` 为唯一权威 web search,本地 keyless 被主权 force-off 抑制,计费经 gateway 归租户;主权点全在本地(`preferAppEnv` + permission 注入),外部无法覆盖、零 platform 回声。
- ✅ **kill-switch**:`ALPHA_WEBSEARCH_DISABLE=1` 跨本地 + 云关掉 web_search,保留兄弟云工具与其它实验能力;override 压过 shell export。
- ⚠️ **残留(a)**:云工具 catalog `listTools` 仍列 `cloud_web_search`,仅模型工具集不含——待引擎 remote 逐工具 deny。
- ✅ **残留(b)已收口(2026-07-25 二轮,#223)**:`export OPENCODE_EXPERIMENTAL=1` 的 env 层绕过由两层堵死 —— permission 注入(把工具从模型工具表滤掉)+ **工具自身的最终闸**(`ALPHA_LOCAL_WEBSEARCH_DENY`)。**只有第二层是主权保证**:R2 动态复现,单靠 permission 注入会被 agent wildcard / 持久 session permission / approved 三条后置规则覆盖(见裁决 (b) 的二次收口段)。不碰 umbrella、不改上游 registry、不新增上游接管。缩小后的残留:被绕过的规则集下工具名仍可见,调用一律被拒。
- ✅ **#489 失败诚实(2026-07-25 交付,取代原「暂缓」条目)**:`packages/opencode/src/tool/websearch.ts` 的伪成功串(`output: result ?? "No search results found…"`)与 `Effect.orDie`(一切错误塌成匿名 defect)已删除,换成单一可辨类型 `WebSearchFailure`(`mcp-websearch.ts`),再转成 canonical 的 `ToolFailure` 结算。**适用范围 = 本地 Exa/Parallel 直连链路**(`websearch` 工具),失败集覆盖 `401` / `403`(带 `error.code`,`action_forbidden` 与 `job_not_enforceable` 可区分)/ `400` / `402`(preauth 拒绝、per-job 超预算)/ `502` / 其余非 2xx 一律 `unexpected_status`,另加 timeout / transport / provider_error(HTTP 200 但 MCP `isError`,或 200 且负载是结构化 `{error:…}`)/ empty_result(带原 body)/ invalid_response;零命中按 `structuredContent.results: []` 判为**合法成功**,不再被误报成失败。**`error.code` 到得了模型面**(2026-07-25 二轮更正,R2 Major 5):`WebSearchFailure.message` 以前只在**有 HTTP status 时**才拼 code,而工具边界只把 `message` 交给模型 —— 200 结构化错误的码于是停在字段上、模型永远看不到;现在 status 与 code 各自独立出现,断言从最终 `ToolFailure` 面取。传输侧 headers + body 同一 timeout;body **硬限** 2 MiB(2026-07-25 二轮更正,R2 Major 6:初版先整块 `push` 再判越界,单个 3 MiB chunk 实收 3,145,728 字节 —— 现在最后一块只保留剩余可读字节)。不再用 `HttpClient.filterStatusOk`(它把每个非 2xx 压成同一个 StatusError,状态与 body 都拿不回来)。原「依赖 alpha-patch 机制」的判断被 owner 裁决取代:走 **[[ADR-035]] 的 ADR-029 L3 文件级接管**(两文件 + 随源测试从守卫 pathspec 移出),不建 L2 机器。E7 失败诚实三不变量(禁伪成功、唯一回退=模型自带 search、云失败禁静默切 keyless)**已机械化**。
- ⚠️ **已修 · #621(冷启动时序缺陷,2026-07-25)**:B1 的 `forceOffKeylessWebSearch()` 判据依赖 `ALPHA_CLOUD_MCP_URL`,而它只在 `alpha-auth.ts` 的 `applyAuthEnv()` 里写、由 `initAuthEnv()`(`main/index.ts`,`whenReady` 之后)触发——**晚于** `preferAppEnv()`。故冷启动的登录用户 force-off 恒不触发,`preferAppEnv` 反把 `OPENCODE_ENABLE_EXA` 设成 `"1"`,fork 出去的 sidecar 里本地 keyless 与 `cloud_web_search` **双活**,B1「模型面上只剩一个 web search 工具」在冷启动路径上从未成立。修法:闸抽成导出的 `applyWebSearchSovereignty()`,在 `spawnLocalServer()` 里 `syncSecretFiles` 之后、fork 之前**每次**重算(与 A6 同纪律),并做成幂等的**双向**函数——登出 respawn 还原 keyless 基线,否则一次登录会把 keyless 哑到重启为止。
- 🔭 **前提受制于 LIVE-PATH GATE**:整份云优先设计以「`cloud_web_search` 在部署实例 `listTools` 真实可见 + 一次真调返回 `{query,results}`」为前提,须运行时探针复验(REQ-097 教训:代码存在 ≠ 链路在跑)。证伪则本决策 B 作废、退回纯 keyless。
- **无向后兼容**:portfolio 无真实用户/租户,契约可直接 breaking,fail-closed;不为旧行为建 shim。
