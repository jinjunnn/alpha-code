---
title: "#1414 方案基线:本地腿与云腿都活着,账户信号只决定云腿在不在"
kind: design
status: proposed
owners:
  - alpha-code desktop maintainers
last_reviewed: 2026-09-23
review_after: 2026-12-23
---

# `#1414` 方案基线 —— 两条腿都活着,额度只在调用那一刻由账户服务回答

票面 `alpha-code#1414`(L 级)。本基线是它**升 Ready 的门**;`requirement-management`
要求的四段(只读勘破 / 选定方案与被否决的替代 / 安全面 / 子票切分)在下面第一至第四、第七节。

**读法**:alpha-code 坐标以 `origin/alpha@f56748c4f` 为准,alpha-platform 坐标以
`origin/main@7bd92ea`(`12cccbf` 的后代,两个提交都不碰本文引用的面)为准,写作 `文件:行`。
第一节只陈述**读过、跑过**的事实;设计从第二节起。

## 〇、约束(owner 裁决,不是选项)

| # | 裁决 | 日期 |
| --- | --- | --- |
| 1 | **本地与云的 web 工具都要活,按账户选路** —— 推翻 ADR-009 决策 B 的 B1(登录态门控、云优先)与 B2(kill-switch 语义) | 2026-09-23 |
| 2 | **本地工具(含 web search、web fetch)必须能用**,不该被大面积禁掉 | 2026-09-23 |
| 3 | **云端调用必须有额度才能调用** | 2026-09-23 |

裁决 3 落在哪一层(注册期 / 调用期 / 两者)是本基线要回答的,见 §五。

## 一、只读勘破

两份地面真相已由独立 lane 跑完,**本基线引用不重做**。两份都还没合进 `alpha`,
所以给分支 + commit 而不是相对链接(链接会让 docs 闸真红):

| 文档 | 在哪 | 本基线用它的哪几条 |
| --- | --- | --- |
| `docs/architecture/2026-09-23-web-tools-account-routing-recon.md`(六条勘破,517 行) | `docs/1414-web-tools-routing-recon` @ `70e2a48ab` | 云侧 6 工具零 web fetch · per-tool 过滤两侧结论相反 · 额度权威 · 整 server 关的连带面 · 9 处替用户做决定 · ADR-009 已漂两处 |
| `docs/architecture/2026-09-23-native-tool-gate-inventory.md`(17 个原生工具全表,725 行) | `docs/1414-native-tool-gate-inventory` @ `e4ca2716d` | 「资源由模型临时生成」那一列 · `websearch` 端点是源码常量 · `bash` 出网面与 `webfetch` 同类 |
| `docs/architecture/2026-09-23-webfetch-egress-decision-chain.md`(`#1412`) | `feat/1412-egress-recon` @ `dfca0be4e` | webfetch 被拒是**设计**问题,补域名结构上无解 |
| `docs/architecture/2026-09-23-runtime-permission-tiers.md`(`#1413`) | `docs/1413-permission-tiers-recon` @ `3f4afcdbd` | 出厂权限档 |

### 1.1 本基线自己补测的四条(上面四份没有的)

**(a) 云侧「有额度才能调用」今天已经是一个咽喉点,而且已经有派生判据。**
付费面不是挂完再审计,是**从注册表生成**:`packages/gateway/src/billable-surface.ts` 三层 ——
L1 装载期替换 `app.router`,用一次性 `TrieRouter` 真 match 当 oracle,拒绝任何「能服务注册付费
路径」的未授权注册(`add` 包装 `:109-131`,判据 `:123`,拒绝 `:126-131`);L2 `mountAndSealPaidRoutes` 按 `BILLABLE_ROUTES` 逐条生成;
L3(承重层)`billableHandlerFactory` 的产物第一句核对 `BILLABLE_ROUTES[c.req.path] === actionId`,
不符即在**任何副作用之前**拒(`:46-58`)。注册表本体 `contracts/v1/billing-actions.ts:70-75` 四行,
`cloud_web_search` 经 `CLOUD_MCP_WEB_SEARCH_ROUTE`(`:86`)落在 `/v1/tools/web_search`。
判据 `packages/gateway/test/billable-routes.test.ts:182-243`:**从 `BILLABLE_ROUTES` 全量派生**,
逐条断言账户拒绝 ⇒ 402、整个请求期**第一次也是唯一一次**出站是 `/v1/preauth`、载荷 `action_id`
恰是注册表给这条路径登记的那个;新增付费路由而不登记请求工厂 ⇒ 当场红。

**(b) account 契约里没有只读额度查询。** `packages/gateway/src/lib/account-routes.ts:34-65`
是 account 路由的单一权威,五条:`preauth`(POST,**写 reservation**)、`settle`、`keysVerify`、
`tenantSuspensionStatus`、`unsettledReservations`。**没有任何「只问不占」的额度/余额查询。**
⇒ 想在 `tools/list` 那一刻判额度,只有两条路:新增一条 account 路由(新契约 + 新闸),
或拿 `preauth` 去占一次预留(在一个列表动作里占钱包腿,不可接受)。勘破 §8.2 把注册期过滤的
代价只算到 gateway 侧的两条不变量,**这一条是它没算到的那半**。

**(c) MCP 工具的执行链是两条,两条都触发 ext 的 before/after 钩子。** 实读:
`packages/opencode/src/session/tools.ts:500` / `:520`(普通 MCP)与
`packages/opencode/src/tool/code-mode.ts:178` / `:216`(code-mode);`session/tools.ts:478`
的 `if (flags.experimentalCodeMode) return tools` 正是两条链分叉的地方。
`packages/ext/src/plugin.ts:74` 的 `tool.execute.before` 与 `:85` 的 `tool.execute.after`
因此是**两条链的共同钳制点** —— ADR-009 裁决 (b) 六轮收口已经把 `before` 这一侧论证完,
`after` 是同一个 hooks 对象上的同一个次序事实(`validateCloudToolOutput` 就挂在那)。

**(d) 会被本方案判红的现有测试(子票要改的就是它们,不是别的)。**
`packages/ui-mac/src/main/cloud-web-search.test.ts:65`
(`platform pays denies the local websearch tool and leaves the cloud tool authoritative`)
及同文件 `:71 / :82 / :115 / :248` 的 `platformPays: true` 臂。
`websearch-copies.test.ts`(ADR-035 普查闸,主 checkout 实测 12 pass)**不应该**变红 ——
它查的是副本集合,不是选路;它若红,说明子票动了不该动的面。

### 1.2 三个必须一起读的事实

1. **额度的唯一权威是 account 服务的逐次 preauth,只在调用那一刻可得**(勘破 §4.1)。
   桌面有三份互不相同的近似值:A `platformPays`(`server.ts:327` / `alpha-config-injection.ts:100`,
   它说的是「登录了」)、B `summaryUsable`(`alpha-composer.tsx:997-1001`,在 **renderer**)、
   C `caps.entitlement`(`alpha-tool-policy.ts:100-101`,**死分支** —— `foldRulesetCap` 只产 `hardDeny`)。
   `sidecar-env.ts:30-95` 的白名单里**没有任何额度通道**。
2. **本地 `websearch` 的目的地是源码常量**(`mcp-websearch.ts:147-150`),
   而 `webfetch` 的目的地是模型入参。前者补两行登记就好(`#1415`),后者**结构上**补不了(`#1412`)。
3. **关掉 cloud MCP server = 关掉全部 6 个**(含四个零入口费用的工具 —— 三个读面 `cloud_status`/`cloud_await`/`cloud_artifacts` 加上「取消一个在跑的作业」`cloud_cancel`),
   而今天有两条路会这么做(登出/缺 `ALPHA_MCP_TOKEN`、kill-switch)。

## 二、选定方案与被否决的替代

### 先回答那个反问:能否让本系统成为权威、让外部无从覆盖?

**在「有没有额度」这件事上:不能,也不该。** 额度住在 account 服务的钱包与会员表里,
而且它的答案**只在一次 reservation 里存在**。任何本地副本都是近似值,而近似值要跟外部
逐点保持同步 —— 那是红旗,是无底洞(拒绝理由域今天已有 6 个 code,`failure-codes.ts:16-23`,
而且还会长)。

**能让本系统成为权威的是另一件事:本地腿在不在。** 那 100% 由我们决定,外部无从覆盖。
所以设计把两件事分开:

- 外部权威(额度)⇒ **消费它的决定**(402 + 稳定 `code`),不解释、不预测、不镜像;
- 本系统权威(本地腿可用性)⇒ **与账户状态完全解耦**,让它成为一个恒定事实。

这正是 `CLAUDE.md`《勘破先于闸门设计》第 2 条的形状:**要么消费对方的决定,要么直接拒绝该输入,
不要解释它。** 今天的缺陷恰恰是第三种 —— ADR-009 B1 把「登录」解释成了「有额度」,
并据此关掉了一条我们自己完全控制的能力。

### 选定:两条腿并存;账户信号只决定云腿在不在,不决定本地腿在不在

| 轴 | 单一权威 | 什么时候算 | 谁消费 |
| --- | --- | --- | --- |
| 本地腿在不在场 | **常量真**,只有 kill-switch 能关 | —— | `webSearchEnabled()` 的 exa/parallel flag;`localWebSearchDenied()` |
| 云腿在不在场 | `platformPays`(`ALPHA_CLOUD_MCP_URL` + `ALPHA_MCP_TOKEN` 密钥文件) | main,每次 fork 前**一次** | 云 MCP 定义的形状(`cloud-sidecar-config.ts:33-50`) |
| **这次云调用成不成** | **account 的 `preauth`** | **调用那一刻** | gateway `worker.ts:2500`,拒绝 ⇒ 402 + 稳定 `code` |

落地方向(行号级实施方案归子票,这里只定形状):

1. **切断 `platformPays → 本地腿` 那条边。** `applyWebSearchSovereignty`
   (`packages/ui-mac/src/main/server.ts:322-350`)(`:334` 的 `if (killSwitch || platformPays)`)的
   `platformPays` 那一半删掉:四个 keyless flag 的 force-off 与 `ALPHA_LOCAL_WEBSEARCH_DENY`
   **只由 kill-switch 驱动**。`applyWebSearchDenies`(`cloud-web-search.ts:180`)同理 ——
   本地 `websearch` 不再因为「登录了」进 permission deny 表。
2. **云腿那一半一个字不改。** kill-switch 的云半场(`ALPHA_CLOUD_WEBSEARCH_DENY` + ext 的
   `tool.execute.before` 闸 + `WITHHELD_CLOUD_MCP`)原样保留。
3. **改掉那句把模型引向死路的文案。** `LOCAL_WEBSEARCH_DENIED_MESSAGE`
   (`packages/core/src/tool/websearch.ts:46-47`)今天无条件说「Use `cloud_cloud_web_search`
   if it is present」。改完之后这条路径只在 kill-switch 下可达,文案要说 kill-switch 的实话。
4. **本地腿必须真的出得了网。** `#1415`(登记 `mcp.exa.ai:443` / `search.parallel.ai:443`)
   是本方案的**硬前置**:没有它,「本地腿活着」只是名义上的 —— 工具在表里、每一次调用 403。

改完之后的四种账户态:

| 账户态 | 模型工具表里有 | 搜网怎么走 | 读网页怎么走 |
| --- | --- | --- | --- |
| 登出 / BYOK | `websearch` | 本地(`#1415` 之后可用) | **不可用**,归 `#1412` |
| 登录 + 有额度 | `websearch` + `cloud_cloud_web_search` | 模型选;云腿 preauth 放行 | **不可用**,归 `#1412` 或 §八的裁决 |
| 登录 + 无额度 | 同上 | 云腿 402(响亮、带 code),本地腿**在场且可用** | 同上 |
| kill-switch | 两个都没有 | 都没有,文案说实话 | 同上 |

### 被否决的替代

**否决 A:把额度信号送进 sidecar,让桌面在调用前就不给模型云工具(= `#1411` 写的形状)。**
- 它造**第二个权威**:判据 B 住在 renderer,是个 UI 信号;要进 sidecar 得在
  `sidecar-env.ts` 白名单上开一个新通道。
- 它**必然过期**:fork 时算、整个会话恒定。用户中途充值 ⇒ 整个会话都看不到云工具,
  而且**没有任何错误解释为什么**。失效方向是「对付费用户静默 fail-closed」,比多一次 402 更糟。
- 它买到的只有「少一次注定失败的调用」—— 而在本地腿活着之后,那一次失败自带出路。
- 判据:`sidecar-env.ts:30-95` 今天没有任何额度通道;`caps.entitlement` 是死分支。

**否决 B:云侧按账户广播工具集(注册期过滤)。**
- 可行性**已实跑**(勘破 §2.2:`McpServerFactory` 可 async、`ctx.requestInfo` 拿得到
  `Authorization`,同一 handler 对两个账户广播了不同工具集)。
- 它比 A 强的地方:判定由**同一个权威**(account)做,不造第二个权威。
- 代价三条:①要放宽 `cloud-mcp.ts:268` 的构造期不变量与
  `test/mcp-tool-registry-187.test.ts:176-183` 的等式闸 —— 它们今天正是「工具面不会悄悄变」
  的保证,放宽就要换一条等价强度的判据;②**account 契约里没有只读额度查询**(§1.1(b)),
  要么新增一条 account 路由,要么在列表动作里占一次钱包预留;③一样会过期,而且
  过期方向和 A 相同(付费用户看不到工具)。
- ⇒ **如果 owner 坚持「根本不调」,B 是正确的那条路,A 不是。** 但它是一张独立的
  alpha-platform 票,不是本票的一部分。

**否决 C:整 server 关(`enabled:false` / `WITHHELD_CLOUD_MCP`)当作选路手段。**
- 今天就在这么做,而它关掉的是 6 个工具 —— 含四个零入口费用的工具(三个读面 + `cloud_cancel`「取消一个在跑的作业」);
  唯一有入口直接费用的只有 `cloud_web_search`。
  本方案**不扩大**它的使用面。

**否决 D:云失败时桌面自动改调本地(静默 failover)。**
- 违反 E7 三不变量的「云失败禁静默切 keyless」;而且它把一次计费拒绝变成一次用户不知情的
  降级 —— 云搜索的 key 恒在 gateway,本地是 keyless 公共端点,隐私与质量属性都变了。
  改由**模型在工具表里自己选**:两个工具同时在场,这件事不需要新机制。

**否决 E:在桌面镜像 account 的额度规则(plan / wallet / allowance 三态)。**
- 红旗本体:我的设计要跟外部逐点保持同步。`failure-codes.ts` 的成员会长,镜像必然漂。

## 三、安全面:整类边界与实现必须守住的不变量

本方案**放宽**一道主权闸(登录态下本地 keyless websearch 重新可用),所以边界要按类前置,
不留给 review 逐实例修。

| # | 整类风险 | 不变量 | 判据落在哪 |
| --- | --- | --- | --- |
| S1 | 计费绕过 —— 有人不付钱用掉平台的云能力 | **任何走 `BILLABLE_ROUTES` 的入口,在任何副作用之前必须经过 `accountPreauth`**;本票不得放宽 L1/L2/L3 任何一层 | 已有:`gateway/test/billable-routes.test.ts:182-243`(全量派生)。子票不得修改它的断言 |
| S2 | 出网面扩大 —— 放行集合长出一个「模型能指定」的成员 | **进静态半场的每一行必须指得回一个源码常量坐标**;`#1415` 必须消费 `mcp-websearch.ts:147-150` 那两个常量**本体**,不得抄字面量 | `network-egress-registry.ts` 每行的 `source` 字段;`#1415` 的 AC |
| S3 | kill-switch 被削弱 | **`ALPHA_WEBSEARCH_DISABLE=1` 之后,本地与云两侧都不得有活的 web search 执行路径**。本票只删 `platformPays` 那一半,kill-switch 半场逐字保留 | `cloud-web-search.test.ts` 的 `killSwitch: true` 臂 + `ext/src/cloud-websearch-kill.test.ts` 必须全绿且**断言不改** |
| S4 | 第二份权威悄悄长出来 —— 系统提示说「有」而真闸说「没有」 | **「本地 web search 此刻在不在模型工具表里」与「系统提示里那一行」必须在四种账户态下逐一相符** | 新增一条四格测试,驱动 `buildAlphaCapabilities`(`alpha-identity.ts:17-26`)与真闸的同一组输入 |
| S5 | 文案把模型引向走不通的路 | **任何「此路不通」的工具文案,只能指向一条在同一时刻确实在模型工具表里的替代;指不出就说「没有,直接回答并说明」** | `LOCAL_WEBSEARCH_DENIED_MESSAGE` 的内容断言 |
| S6 | (条件性,仅当 §八裁决新增云 web fetch)SSRF / 我方基础设施变成对外可达的抓取代理 | 若新增,`webFetch` **必须**挂在封印付费路由上(否则它是一个免费的对外抓取代理);`isBlockedHost` 的每一类都要有一个**已知该被拦**的正样本;`lib/web.ts:4-5` 自陈防不了 DNS rebinding,这条要如实登记为残留 | `gateway/test/web.test.ts` + 新路由进 `BILLABLE_ROUTES` 后由 S1 那条派生测试自动接管 |

**已知不修(留痕)**:kill-switch 在云腿上会连带关掉另外五个工具(勘破 §5)。它与 ADR-009 B2
「一开关一具名能力」直接冲突,但它是**既有缺陷**,不是本方案引入的;本票**不修**,只保证不扩大,
并由 §六的新 ADR 如实登记。理由:修它要改 `ConfigMCPV1.Remote` 的能力面或云侧注册期过滤
(= 否决 B 的同一笔账),那是独立范围。

## 四、AC 重写与咽喉点指名

票面 AC 是草案,缺的正是咽喉点。基线据此重写(方案基线是 AC 的合法来源;本节随基线一同批准才生效):

**AC1**(不变)有额度账户与无额度账户,模型都能真的搜到结果;走的是哪条腿由账户信号决定。

> **单一权威**:「云腿在不在场」= `platformPays`,计算点唯一(main,每次 fork 前),
> 消费点是云 MCP 定义的形状;「本地腿在不在场」= 常量真,只有 kill-switch 能改。
>
> **诚实边界**:AC1 的**「读到网页」那一半在本票范围内不可达** —— 云侧没有 web fetch(勘破 §1,
> 已跑),本地 webfetch 是出网围栏的设计问题(`#1412`)。要么 `#1412` 先落地,要么 owner 批准
> §八的新增。**不改 AC1 的措辞就升 Ready = 超卖。** 本基线的建议:AC1 收窄为「搜到结果」,
> 「读到网页」由 `#1412` 承担或随 §八的裁决另立。

**AC2**(重写)无额度时,云 web 工具的拒绝**由唯一一处产生**,并以模型可动作的形式到达模型;
同一时刻本地腿**确实在**模型的工具表里。

> **咽喉点(拒绝的权威)= gateway 的封印付费面**:`BILLABLE_ROUTES`
> (`contracts/v1/billing-actions.ts:70-75`)是唯一权威,`mountAndSealPaidRoutes` 按它生成挂载,
> `billableHandlerFactory` 的产物在任何副作用之前核对路径↔action 绑定,
> `worker.ts:2500` 的 `accountPreauth` 是每条付费入口的第一次出站。
>
> **为什么它是唯一通路**(有限判据,不是「你还能找到别的绕法吗」):
> ①**装载期**——L1 守卫用一次性 `TrieRouter` 真 match 当 oracle,任何「能服务注册付费路径」的
> 未授权注册在 `router.add`(matcher 被改写之前)抛;②**请求期**——L3 在 handler 第一句核对
> `BILLABLE_ROUTES[c.req.path] === actionId`,wrapper 改不了 `c.req.path`;③**覆盖面**——判据
> 从注册表**全量派生**,新增付费路由而不登记 ⇒ 测试当场红(名单对新成员默认放行,派生对新成员
> 默认失败)。`billable-surface.ts:17-18` 自陈的不设防三条(从零重写收费逻辑的新 handler /
> 装载后改写注册表导出对象 / 白名单中间件自身行为不当)照抄进本基线,不粉饰。
>
> **咽喉点(到达模型)= `@alpha-code/ext` 的 `tool.execute.after`**(`packages/ext/src/plugin.ts:85`)。
> 为什么是唯一通路:引擎里 MCP 工具只有两条执行链(`session/tools.ts:520`、`code-mode.ts:216`),
> **两条都触发这个钩子**(§1.1(c) 实读);`Plugin.trigger` 用 `Effect.promise` 且不捕获,
> 钩子抛出即终止;钩子**不查任何 permission ruleset**,所以没有任何授权能覆盖它。
> 这与 ADR-009 裁决 (b) 六轮收口给 `before` 的论证是同一个次序事实。
>
> **本票在这个咽喉点上做什么**:今天 402 的 body 已经带稳定 `code` 并经
> `cloud-mcp.ts:261` 的 `text(body, !r.ok)` 原样到达模型(`isError: true`),**已经是响亮的**。
> 所以本票在这里**不加任何新机制** —— AC2 的证据是「这条路还在、没被本次改动弄断」,
> 加上「同一时刻本地腿在场」。**为 AC2 新造一个翻译层是过度工程,基线明确否决。**

**AC3**(不变)ADR-009 被显式修订或 supersede,决策文件与代码说同一件事;
`websearch-copies.test.ts` 那条普查闸对新的选路信号仍然成立。处置见 §六。

## 五、owner 裁决 3 落在哪一层 —— 推荐:调用期,且今天已经成立

| 层 | 今天的状态 | 要做的事 | 失效方向 |
| --- | --- | --- | --- |
| **调用期(402)** | **已经是咽喉点,已经有全量派生判据**(§1.1(a)) | **零** —— 只要不弄断它 | 过期?不会。每次调用都问一次真权威 |
| 注册期(云侧按账户广播工具集) | 承载层可行(已实跑),但被我们自己的两条不变量挡着,且 account 契约缺只读额度查询 | 放宽两条不变量 + 换等价强度判据 + 新增一条 account 路由 + 新增一条闸 | **会过期,且方向更糟** —— 刚充完值的用户整个会话看不到云工具,零错误解释 |
| 注册期(桌面侧,`#1411` 的形状) | 通道不存在(`sidecar-env.ts` 白名单无额度轴),判据 C 是死分支 | 开新通道 + 造第二个权威 | 同上,外加「第二个权威」这一笔 |

**推荐:只落在调用期。** 三条理由:

1. 裁决 3 的字面要求(「云端调用必须有额度才能调用」)**今天已经被结构性满足** ——
   不是靠约定,是靠 L1/L2/L3 三层加一条从注册表全量派生的测试。没有东西要建。
2. 注册期过滤的失效方向**对付费用户 fail-closed 且静默**,比「多一次带 code 的 402」贵得多。
   而 402 的代价在本地腿活着之后只剩一次可见的、自带出路的失败。
3. 「工具表中途随额度变化」这一格**没有通道**:云侧 stateless、`maxSubscriptions: 0`,
   勘破 §2.3 没测出任何 server→client 的 notification 路径。所以注册期过滤在**同一个会话内**
   就会和真相分叉 —— 它不是一个更早的权威,是一个更旧的快照。

**这条推荐与 `#1411` 的退出条件冲突**(那张票要求「根本不调」),处置见 §八。

## 六、ADR-009 的处置 —— supersede,不是就地修订

**判据(实读,不是印象)**:ADR-009 `status: amended`,2026-08-03 那次就地修订的第一句
逐字写着「**本条不是一次新决策**……web search 的默认行为、B1 的登录态门控、B2 的 kill-switch
语义一个字都没变」。**这一次改的是决策实质**,再往同一份文件贴一段,会让同一个 id 下同时
存在两条互相矛盾的 B1,而读者拿不到「哪一条是现在的」。

四条理由:

1. B1 被推翻的是**形状**(互斥 → 并存),不是一个参数。
2. ADR-009 的正文有六轮收口记录,它的价值恰恰是**史料**:「云优先那一版是怎么长出来的、
   以及它为什么错」。就地修订会把史料改成一份自相矛盾的现行文件。
3. B2 在云腿上不成立(关掉六个工具)是一个**未修的缺陷**。写进「已修订」会让人以为随本次
   一起修好了;写进新 ADR 的「如实登记」才是真的。
4. 决策 A(登出/BYOK keyless 放开)的适用面**回到 2026-06-18 的原始形状**(对所有账户态成立)。
   这是「B 把 A 收窄」这个动作被撤销 —— supersede 一句话说清,就地修订要读者自己做三层减法。

**新 ADR 必须回答的五条**(编号与内容由子票落,这里定它的范围):

- **D1 选路形状**:两条腿并存;账户信号只决定云腿在不在,不决定本地腿在不在。
- **D2 额度权威**:account 的逐次 preauth 是唯一权威,**落在调用期**;桌面不得持有第二份判据。
- **D3 kill-switch**:语义 = 关掉两侧的 web search;**如实登记**它今天在云腿上会连带关掉另外
  五个工具(已知不修 + 承接票号)。
- **D4 凭证手段(改正 ADR-009 已漂的两处事实,不是新决策)**:B1 的判据是 `ALPHA_MCP_TOKEN`
  不是 `ALPHA_CLOUD_TOKEN`(`server.ts:327`、`alpha-config-injection.ts:100`);云 MCP 定义
  今天带 `headers.Authorization: "Bearer {file:…}"` + `oauth: false`
  (`cloud-sidecar-config.ts:44-48`),不是「没有任何凭证通道的标准 MCP OAuth」。
- **D5 webfetch**:云侧无 web fetch;本地 webfetch 在出网围栏下结构性不可用,归 `#1412`。

ADR-009 本体:`status` 改 `superseded`,加 `superseded_by` 指向新 ADR,正文一字不改
(它是史料)。`.claude/rules/adrs/` 是**受保护的执行资产**,改它只在 AC3 的子票里做,
本 PR 不碰。

## 七、子票切分(本基线批准后才切)

**前置,不属于本票**:`alpha-code#1415`(S,已存在)—— 登记两个 websearch 端点。
没有它,本方案的「本地腿活着」只是名义上的。**先合 `#1415`,再开 CODE-1。**

| 子票 | 负责 | 边界(具体文件) | out-of-scope | 退出条件 |
| --- | --- | --- | --- | --- |
| **CODE-1** `[REQ-1414][CODE] 让本地搜网在登录之后仍然留在模型工具表里` · M | AC1 的「搜到结果」、AC2 的「本地腿在场」 | `packages/ui-mac/src/main/server.ts`(`applyWebSearchSovereignty`)、`cloud-web-search.ts`(`applyWebSearchDenies`)、`packages/core/src/tool/websearch.ts` 与 `packages/opencode/src/tool/websearch.ts`(仅 `LOCAL_WEBSEARCH_DENIED_MESSAGE`) | 云腿的任何一处;kill-switch 半场;出网围栏 | 登录代付态下模型工具表**同时**含 `websearch` 与 `cloud_cloud_web_search`;kill-switch 态四种断言逐字不变;`cloud-web-search.test.ts` 的 `platformPays` 臂改成新语义并说明为什么 |
| **CODE-2** `[REQ-1414][CODE] 让系统提示里的「能搜网」与模型手里真有的工具一致` · S | S4 不变量 | `packages/ui-mac/src/main/alpha-identity.ts`、`alpha-config-injection.ts:128-135` | 不新建抽象层;不动 `buildAlphaIdentity` 的文案骨架 | 一条四格测试(登出 / 登录有额度 / 登录无额度 / kill-switch),断言提示里那一行与工具表的在场性相符 |
| **CODE-3** `[REQ-1414][CODE] 让决策文件和代码说同一件事` · S | AC3 | 新 ADR 文件 + `ADR-009` 的 frontmatter(`status` / `superseded_by`)+ `architecture-decision-registry` 一行 | 不改 ADR-009 正文 | 新 ADR 含 D1–D5 五条;`websearch-copies.test.ts` 仍绿 |
| **VERIFY-1** `[REQ-1414][VERIFY] 四种账户态下模型到底搜不搜得到` · —— | AC1 / AC2 的 runtime 证据 | 打包实例;矩阵 = {登出/BYOK, 登录有额度, 登录无额度, kill-switch} × {搜网} | 读网页(归 `#1412` 或 §八) | 每格记「模型有没有真发 `tool_calls`」与「拿没拿到结果」两件事分开(本机陷阱:模型自己的策略层会先于被测接缝生效) |

**VERIFY-1 的前置缺口**:勘破 §9 第 5 条 —— 本轮**没有**一个零余额的真账户,402 的实际 wire body
从未跑过。这一格要么 owner 提供一个零余额账号,要么在 VERIFY 票里写成「未取到样本」,
**不得推导成绿**。

**不建的票**:不为「翻译 402」建票(§四已否决);不为「kill-switch 关六个」建票
(已知不修,由新 ADR 登记 + 现有 `#1411`/独立票承接)。

## 八、留给 owner 的裁决(摆代价,不替他选)

### 8.1 云侧要不要新增 web fetch

**不新增的代价**:「读网页」这件事在本票范围内**完全不修**。它全押在 `#1412`,
而 `#1412` 的结论是必须改出网围栏的**设计**(不是补配置)。也就是说:
批了本基线也不代表「模型能读网页」会变好。

**新增的真实清单(勘破测出来的,不是估算)**:①`packages/gateway/src/lib/web.ts:46-77`
的 `webFetch()` 已存在,带 SSRF 闸(`isBlockedHost` 挡内网/云元数据/我方域名)、手动跟 4 跳
重定向**每跳重验**、15s 超时、4000 字符截断,有测试(`test/web.test.ts` 14 处断言),
**今天零消费者**(三条独立检索轴);②新增一条封印付费路由(`BILLABLE_ROUTES` + account 单价);
③`MCP_TOOL_REGISTRY` 加一行;④`cloud-mcp.ts` 加一个 `mount`。
**不涉及**出网围栏 —— 云侧抓取发生在 Worker 上,`#1412` 那条链根本不在路径上。

**不可逆的那一半**:抓取源 IP 变成**我方基础设施**。`lib/web.ts:4-5` 自陈防不了
DNS rebinding。上线之后关掉容易,**期间被滥用的记录不可回收**。
另加一条基线的要求:它**必须**挂在封印付费路由上,否则我们上线的是一个免费的、
对外可达的抓取代理(见 S6)。

### 8.2 `#1411` 的处置

`#1414` 票面把这件事交给基线判。基线的判断:**`#1411` 写的形状(桌面持有额度判据)是错的**
—— 理由在 §二否决 A 与 §五。如果要「根本不调」,正确的形状是**云侧注册期过滤**(否决 B),
那是一张 alpha-platform 的票,代价是新 account 路由 + 放宽两条不变量。

**但这条与 owner 在 `#1411` 里亲口写的那句冲突**(「没有订阅也没有余额时,就不该让模型去调
云端搜索」),所以基线**不自行关票**,递上来请裁:

- **选项 1(推荐)**:`#1411` 关为 not planned,理由写进票:本地腿活起来之后,那一次 402
  自带出路;要消灭它得付「第二个权威 + 会过期的快照」的代价。
- **选项 2**:`#1411` 改写成 alpha-platform 的注册期过滤票(否决 B 的形状),复杂度 L,
  依赖新 account 只读额度路由。
- **选项 3(不动)**:`#1411` 原样保留 ⇒ 它会造出第二个权威,并与本基线 D2 直接冲突 ——
  两份文件会再次说不同的话,正是本票要消灭的那个毛病。

## 九、本基线**没有**跑过的(不要当成已知)

1. **线上 gateway 与 `7bd92ea` 是否同一份** —— 未跑 `wrangler deployments list`(会碰生产凭证)。
   §1.1(a) 的三层守卫是读 HEAD 源码 + 读它自己的测试,不是对线上实例的测量。
2. **零余额真账户的 402 wire body** —— 沿用勘破 §9 第 5 条的缺口,本轮没有补上。
3. **改完之后登录态真的会同时出现两个 web search 工具** —— 这是从
   `applyWebSearchSovereignty` 的两个分支 + 勘破 §1.3 的自证臂(`enableExa` 翻面 ⇒ `websearch`
   进出工具表)推出来的**推论**,不是跑出来的。CODE-1 的退出条件就是把它跑成事实。
4. **`tool.execute.after` 在 402 结果上的实际 hookInput 形状** —— 只读了两条链的触发点,
   没有跑一次真的 402 穿过它。AC2 既然不新增机制,这一格由 VERIFY-1 承担。
5. **`packages/core` 与 `packages/opencode` 两份 websearch 副本哪一份被执行** ——
   勘破 §3.3 第 2 点标为未测,本基线沿用;CODE-1 改文案时两份都要改(与今天的做法一致)。
