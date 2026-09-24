---
id: ADR-046
title: web 工具两条腿都活着 —— 账户信号只决定云腿在不在,不决定本地腿在不在;额度只由 account 的逐次 preauth 在调用那一刻回答
status: accepted
date: 2026-09-23
amended: 2026-09-24
supersedes: ADR-009
related: [ADR-002, ADR-015, ADR-029, ADR-035]
---

## 背景

owner 2026-09-23 三条裁决:**本地与云的 web 工具都要活,按账户选路**;**本地工具(含 web search、
web fetch)必须能用,不该被大面积禁掉**;**云端调用必须有额度才能调用**。第一条直接推翻
[[ADR-009]](ADR-009-websearch-default.md) 决策 B 的 B1(登录态门控 + 云优先 + 对本地腿 force-off)。

[[ADR-009]] B1 把「登录」解释成「有额度」,并据此关掉一条**我们自己完全控制**的能力。而额度住在
account 服务的钱包与会员表里,它的答案只在一次 reservation 里存在 —— 任何本地副本都是近似值,
而近似值要跟外部逐点保持同步。本 ADR 因此把两件事分开:

- **外部权威(有没有额度)**⇒ 消费它的决定(402 + 稳定 `code`),不解释、不预测、不镜像;
- **本系统权威(本地腿在不在)**⇒ 与账户状态**完全解耦**,成为一个恒定事实。

方案基线(只读勘破、被否决的替代、安全面、子票切分):
[`docs/design/2026-09-23-1414-web-tools-account-routing-baseline.md`](../../../docs/design/2026-09-23-1414-web-tools-account-routing-baseline.md)。
本 ADR 的坐标以 `origin/alpha@b03e79da1` 实读为准;alpha-platform 侧的坐标引自该基线
(`origin/main@7bd92ea`),本 ADR 未自行复测。

### 为什么是新 ADR,不是第二次就地修订

[[ADR-009]] 上一次(2026-08-03)就地修订的第一句自陈「**本条不是一次新决策** …… web search 的
默认行为、B1 的登录态门控、B2 的 kill-switch 语义一个字都没变」。**这一次改的是决策实质**,
再往同一份文件贴一段,会让同一个 id 下同时存在两条互相矛盾的 B1,而读者拿不到「哪一条是现在的」。
另三条理由:

1. B1 被推翻的是**形状**(互斥 → 并存),不是一个参数。
2. [[ADR-009]] 正文的六轮收口记录,价值恰恰是**史料**:「云优先那一版是怎么长出来的、以及它
   为什么错」。就地修订会把史料改成一份自相矛盾的现行文件。
3. 决策 A(登出/BYOK keyless 放开)的适用面**回到 2026-06-18 的原始形状**(对所有账户态成立)——
   这是「B 把 A 收窄」这个动作被撤销;supersede 一句话说清,就地修订要读者自己做三层减法。

[[ADR-009]] 正文**一字不改**,作史料保留;只把它的 `status` 改为 `superseded` 并指向本 ADR。

## 决策

### D1 选路形状:两条腿并存,账户信号只决定云腿在不在

| 轴 | 单一权威 | 什么时候算 | 谁消费 |
|---|---|---|---|
| 本地腿在不在场 | **常量真**,只有 kill-switch 能关 | —— | 四个 keyless flag(`OPENCODE_ENABLE_EXA` / `OPENCODE_EXPERIMENTAL_EXA` / `OPENCODE_ENABLE_PARALLEL` / `OPENCODE_EXPERIMENTAL_PARALLEL`)与 `localWebSearchDenied()` |
| 云腿在不在场 | `platformPays` = `ALPHA_CLOUD_MCP_URL` ∧ `ALPHA_MCP_TOKEN` 密钥文件在场 | main 进程,每次 sidecar fork 前一次 | `materializeCloudMcpConfig()` 产出的云 MCP 定义形状 |
| **这次云调用成不成** | **account 服务的 `preauth`** | **调用那一刻** | gateway 的封印付费面;拒绝 ⇒ 402 + 稳定 `code` |

- 本地 keyless `websearch` 的在场性**不再是账户状态的函数**。`applyWebSearchSovereignty`
  (`packages/ui-mac/src/main/server.ts:329`,判据在 `:334`、分支在 `:341`)里四个 flag 的
  force-off、`ALPHA_LOCAL_WEBSEARCH_DENY`,以及 `applyWebSearchDenies`
  (`packages/ui-mac/src/main/cloud-web-search.ts:173`)对本地工具 id `websearch` 的
  permission deny,**只由 kill-switch 驱动**;`platformPays` 那一半去掉。
- **云腿那一半一个字不改**:kill-switch 的云半场(`ALPHA_CLOUD_WEBSEARCH_DENY` +
  `@alpha-code/ext` 的 `tool.execute.before` 闸 + `WITHHELD_CLOUD_MCP`)逐字保留。
- 登录代付态下模型工具表里**同时**有 `websearch` 与 `cloud_cloud_web_search`,用哪条**由模型在
  工具表里自己选**。这件事不需要新机制,也不得由桌面替它选(见「拒绝的方案 D」)。
- 前置已落地:`#1415` 把两个 keyless 搜索端点登记进出网放行集合的静态半场
  (`packages/ui-mac/src/main/network-egress-registry.ts:101-102`)。没有它,「本地腿活着」
  只是名义上的 —— 工具在表里而每一次调用被我方策略代理 403。
- 承接实现:`#1411`(CODE-1)。

### D2 额度权威:account 的逐次 preauth,落在调用期;桌面不得持有第二份判据

- **唯一权威是 account 服务的逐次 `preauth`**,只在调用那一刻可得。裁决「云端调用必须有额度」
  **今天已经被结构性满足**:alpha-platform 的 `packages/gateway/src/billable-surface.ts` 三层
  (装载期用一次性 `TrieRouter` 真 match 当 oracle 拒绝未授权注册 / `mountAndSealPaidRoutes` 按
  `BILLABLE_ROUTES` 逐条生成 / handler 第一句核对 `路径 ↔ action` 绑定后才允许任何副作用),
  判据 `packages/gateway/test/billable-routes.test.ts` **从注册表全量派生**。**本决策不要求新建
  任何机制**,只要求不弄断它。
- **桌面侧不得持有第二份额度判据。** 今天桌面手里三份近似值都不是额度:`platformPays`
  (`packages/ui-mac/src/main/server.ts:334`、`packages/ui-mac/src/main/alpha-config-injection.ts:100`)
  说的是「登录了」;`summaryUsable`(`packages/ui-mac/src/renderer/alpha-ui/alpha-composer.tsx:997`)
  是 renderer 的 UI 信号;第三份(`caps.entitlement`)是死分支。三者都**不得**被升格成选路判据。
- **通道也不存在**:`packages/ui-mac/src/main/sidecar-env.ts` 的 fork 白名单里没有任何额度轴,
  而 account 契约的五条路由(`preauth` / `settle` / `keysVerify` / `tenantSuspensionStatus` /
  `unsettledReservations`)里**没有只读额度查询** —— 想在注册期判额度,只能新增一条 account 路由,
  或在一个列表动作里占一次钱包预留。两者都不在本决策范围内(见「拒绝的方案 A / B」)。
- 402 已经是响亮的:body 带稳定 `code`,经云 MCP 薄壳原样以 `isError: true` 到达模型。
  **不得为它新造翻译层。**

### D3 kill-switch:语义是关掉**我们自己提供的**两条搜网腿,并如实登记它今天的连带面

- `ALPHA_WEBSEARCH_DISABLE=1` 之后,**我们自己提供的两条搜网腿(本地 `websearch` + 云
  `cloud_cloud_web_search`)都不得有活的执行路径**;用户自带的第三方 web-search MCP 按工具名
  **尽力拦截、不是保证**(D6)。**「模型改用别的工具自己去打搜索引擎」不在这道开关的辖区内。**
  本 ADR 只撤掉 `platformPays` 对本地腿的那一半,kill-switch 半场逐字保留。
- **就地修订 · 2026-09-24(`#1448`,owner 裁决;零行为改动)**:上一条原文写的是
  「本地与云**两侧都不得有活的 web search 执行路径**」,**那句话写宽了**,上面是收窄后的实话。
  owner 原话:「我的需求一直是本地云端的搜网功能都需要可用。还有就是如果有闸门也只关注我们
  自己提供的搜网功能。」三条理由:①这个开关出自 [[ADR-009]] 决策 A 第 4 条,原文就叫
  **「逃生开关」**(`ADR-009-websearch-default.md:54`)—— 运维应急闸,不是产品能力,
  默认关闭,从未被当成功能交付;②**「什么算搜索引擎」判别不了** —— 按工具名的天花板 D6 末段
  已登记,按目的地只会更糟(域名清单永远补不完,正是「手写别人文法的替身」那类错);
  ③用户自带的第三方搜网工具归用户自己管(D6)。**判决口径本身就只看工具身份**:
  `webSearchToolDenial`(`packages/ext/src/cloud-websearch-kill.ts:274-288`)第一句是
  `if (!isWebSearchToolId(tool)) return undefined`,入参里没有任何目的地轴。
  `#1433` 的实测形状(kill-switch 态中性驱动句下模型改用 `webfetch` 打 duckduckgo / bing、
  各拿回约 12 KB 结果页;换成显式驱动句则 0 次 `tool_calls`)与证据坐标记在方案基线
  §三〈S3 的作用面〉。**本次修订只改措辞:零生产代码改动,判据一条未动。**
- **如实登记(已知不修)**:整个 cloud MCP server 被关掉时,消失的是该 server 上的**每一个**
  工具,不只 web search —— 引擎的 `ConfigMCPV1.Remote` 只有整 server 的 `enabled`
  (`packages/opencode/src/mcp/index.ts:409` 对 `enabled:false` 直接返回 `DISABLED_RESULT`)。
  按基线 §1.2 引用的勘破,今天云侧共 6 个工具,其中只有 `cloud_web_search` 有入口直接费用;
  另外四个(三个读面 + 「取消一个在跑的作业」)是零入口费用。**该清单的权威在 alpha-platform 的
  云 MCP 注册表,本 ADR 未自行枚举。**
- **到得了这个状态的两条路,说清条件**(实读 `b03e79da1`,与勘破的措辞相比多一个条件):
  1. **凭证缺席**(登出 / `ALPHA_MCP_TOKEN` 密钥文件不在 / 密钥同步失败)⇒
     `materializeCloudMcpConfig(url, undefined)` 产出 `enabled:false`
     (`packages/ui-mac/src/main/cloud-sidecar-config.ts:33-41`)⇒ 整个 server 暗掉。**无条件成立。**
  2. **kill-switch**:注入面写的是中和条目 `WITHHELD_CLOUD_MCP`
     (`packages/ui-mac/src/main/cloud-web-search.ts:75-80`,`url=http://127.0.0.1:1`、`enabled:false`),
     真定义经 `ALPHA_CLOUD_MCP_ARM` / `ALPHA_CLOUD_MCP_DEF` 交给 ext;ext 一旦装载,
     `installCloudMcp()`(`packages/ext/src/cloud-websearch-kill.ts:378`,由 `packages/ext/src/plugin.ts:118`
     的 `config` 钩子第一句无条件调用)会把它整条换成 `enabled:true` 的真定义,兄弟工具**回来**,
     只有 web search 仍被 `tool.execute.before` 拦住。**所以 kill-switch 的正常态没有误伤兄弟
     ([[ADR-009]] B2 那条不变量在正常态成立)**;连带损失只发生在**ext 未装载 / `{file:}`
     引用读不到**的降级态,代码自己把它登记为「诚实降级,连兄弟工具一起损失」。
- 本 ADR **不修**这条连带面:修它要改 `ConfigMCPV1.Remote` 的能力面或做云侧注册期过滤
  (= 「拒绝的方案 B」的同一笔账),那是独立范围。**只保证不扩大它的使用面。**
- **尚未跑过**:`ALPHA_WEBSEARCH_DISABLE=1` 下「六个工具真的全消失」在任何装载实例上都没有复验
  (勘破自陈 §9 第 6 条),上面那条条件性结论同样是读三处代码得到的。要当事实用之前先跑。

### D4 凭证手段的两处事实订正(**不是新决策**)

[[ADR-009]] 的下述两句在 `b03e79da1` 上已经与代码不符,本 ADR 就此订正;**决策实质不在这一条里**。

| [[ADR-009]] 的原话 | 代码实际 | 坐标 |
|---|---|---|
| B1 的判据是 `ALPHA_CLOUD_MCP_URL` + **`ALPHA_CLOUD_TOKEN`** 密钥文件;「`ALPHA_CLOUD_TOKEN` 仍然是 B1 的判据」 | 判据是 `ALPHA_CLOUD_MCP_URL` + **`ALPHA_MCP_TOKEN`** 密钥文件(`#1195` 换轴:凭证在场性与代付判据从此是同一件事) | `packages/ui-mac/src/main/server.ts:334`、`packages/ui-mac/src/main/alpha-config-injection.ts:100` |
| 2026-08-03 就地修订段:云 MCP 走**标准 MCP OAuth**,该 server 定义里「**没有任何凭证通道** —— 没有 `headers.Authorization`、没有 `{file:…}` 引用」 | 代付态的定义带 `headers: { Authorization: "Bearer {file:…ALPHA_MCP_TOKEN}" }` 且 `oauth: false`;凭证缺席态是无引用的 `enabled:false` + `oauth: false` | `packages/ui-mac/src/main/cloud-sidecar-config.ts:33-50` |

排障含义随之更正:云 MCP 未授权时,要看的是 `ALPHA_MCP_TOKEN` 密钥文件在不在、`{file:}` 引用解析
得开不开,**不是**去走 OAuth 授权流 —— `oauth: false` 之下该 server 结构上进不了 `needs_auth`
([[ADR-009]] 对 `oauth: false` 不是中性设置的那段分析仍然成立,且**仍是故意的**)。

### D5 webfetch:云侧没有,本地这条归出网围栏的设计问题

- **云侧今天没有 web fetch 工具**(勘破实跑 6 个工具的全集,零 web fetch;gateway 里那份
  `webFetch()` 实现有测试但**零消费者**)。要不要新增是一个独立裁决,不在本 ADR 内;若新增,
  它**必须**挂在封印付费路由上,否则上线的是一个免费的、对外可达的抓取代理。
- **本地 `webfetch` 的目的地是模型入参**,不是源码常量,所以它在出网放行集合的静态半场里
  **结构上补不了** —— 与 `websearch`(端点是源码常量,`#1415` 两行登记即可)不同类。
  处置由 `#1412` 承担,不在本 ADR 内。
- 因此:本决策让「搜网」在四种账户态下都有一条活路,**不改善「读网页」**。不要据本 ADR 声称
  模型能读网页。

### D6 用户自带的第三方 web-search MCP:归用户自己管,只有 kill-switch 关得掉

**这不是一条新裁决,是 D1 的第二处落点**。`#1411` 落地 D1 时把它一并改掉了,而当时只登记了本地腿
—— `#1443` 补登记。**本决策不改任何代码行为**,它把已经在跑的行为写成决策。

- **事实**:用户自己在配置里声明一个 remote MCP(`{"mcp":{"exa":{"type":"remote","url":"https://mcp.exa.ai/mcp"}}}`)
  产生的 `exa_web_search_exa` 一类工具,唯一的闸是 `@alpha-code/ext` 的 `tool.execute.before`
  (`packages/ext/src/cloud-websearch-kill.ts` 的 `webSearchToolDenial()`);注入面那层 permission
  deny 只点名 `websearch` 与 `cloud_cloud_web_search` 两个 id,**够不着第三方**。该判决读的是
  `ALPHA_LOCAL_WEBSEARCH_DENY` **或** `ALPHA_CLOUD_WEBSEARCH_DENY` —— 与本地腿**同一个**信号。
  D1 让代付态不再置位它,于是代付态第三方 web search 随之放行。
- **判定:这个新行为是对的。** 依据不是偏好,是 `cloud-websearch-kill.ts` 文件头 R5 那段自己写下的
  理由是一个**条件句**:「本地 keyless websearch 已因平台代付被关,若用户加一个 exa remote MCP
  就能拿回同一能力,那条主权判决就被架空」。D1 把前提撤掉了 —— 代付态本地 keyless `websearch`
  在场且可用,第三方 MCP 给不了用户一个他没有的能力,拦它护不住任何东西,只剩「对用户自己装的
  东西行使主权」。该段同时自陈「这是产品取舍,不是纯技术结论,归 owner 复核」;owner 2026-09-24
  复核:**用户自己装的工具归他自己管**,与 D1 同源。
- **kill-switch 的覆盖面没有缩小**(owner 2026-09-24 点名问的那一格):`applyWebSearchSovereignty`
  在 kill-switch 下**两个信号都置位**(`packages/ui-mac/src/main/server.ts` 的 `:362` 与 `:370`),
  而上面那条判据对两个都判 —— 所以「一键关掉所有搜网」照旧关得掉第三方插件。变的只有「登录代付」
  那一格。

| 账户态 | 第三方 web-search MCP | 为什么 |
|---|---|---|
| 登出 / BYOK | **可用** | 两个信号都不置位(`#1411` 之前也是这样,没变) |
| 登录 + 有额度 | **可用**(`#1411` 起的新行为,本条登记它) | 代付不再置位任何信号;本地腿同时活着,拦它护不住能力 |
| 登录 + 无额度 | 同上 | 桌面侧与「有额度」不可分辨(D2:没有只读额度查询) |
| kill-switch | **关** | 两个信号都置位;判据任一命中即拒 |

- **判据**(缺一这张表就只是散文):
  - 四种账户态的**合成**判据在 `packages/ui-mac/src/main/server.test.ts` 的「`#1443` 用户自带的
    第三方 web-search MCP」—— env 来自真 `forkSidecar()`,归属来自真 `injectAlphaConfig()` +
    真 `computeMcpOwnership()`,判决就是 ext 钩子首行调的那个函数,ui-mac 这边不手写等价条件。
    手段自证:把 D1 撤掉的那条边加回 `applyWebSearchSovereignty`(登录即置位本地拒绝判决),
    「登录代付:第三方 web search 可用」当场转红。
  - 单包判据在 `packages/ext/src/cloud-websearch-kill.test.ts`。`#1443` 在那里把 `PLATFORM_PAYS`
    夹具改名为 `LOCAL_DENY_ONLY`:**它建模的信号形状(本地置位、云没置位)从 `#1411` 起 main 不再
    产生**,今天它只代表信号漂移。用它的每一条断言**逐字未动**(下方「kill-switch 不得被削弱」),
    另加一条用代付今天真实形状(两个信号都缺席)的新用例。
- **不在本条范围内**(沿用 [[ADR-009]] 裁决 (b) 2026-07-26 R6 的收窄,不扩大也不收回宣称):第三方
  工具的识别只能看工具名,**做不到穷尽** —— 经 `McpCatalog.sanitize` 抹平的非 ASCII 名任何分类器
  都看不见。所以 kill-switch 对第三方是**尽力拦截**,不是保证。本条只说明「哪一态该拦、哪一态不该拦」,
  没有改变拦得住多少。

## 后果

改完之后的四种账户态:

| 账户态 | 模型工具表里有 | 搜网怎么走 | 你自己装的第三方搜网 MCP | 读网页怎么走 |
|---|---|---|---|---|
| 登出 / BYOK | `websearch` | 本地(`#1415` 已落地) | 可用(D6) | 不可用,归 `#1412` |
| 登录 + 有额度 | `websearch` + `cloud_cloud_web_search` | 模型选;云腿 preauth 放行 | 可用(D6,`#1411` 起) | 同上 |
| 登录 + 无额度 | 同上 | 云腿 402(响亮、带 `code`),本地腿**在场且可用** | 同上 | 同上 |
| kill-switch | 两个都没有 | **我们的两条腿都没有**,文案要说 kill-switch 的实话;开关管不到「模型改用别的工具自己去打搜索引擎」(D3) | 关(尽力拦截,见 D6) | 同上 |

实现不得越过的不变量:

- **计费不得被绕过**:任何走 `BILLABLE_ROUTES` 的入口,在任何副作用之前必须经过 `accountPreauth`;
  不得放宽 gateway 那三层,也不得修改从注册表全量派生的那条判据的断言。
- **出网面不得长出「模型能指定」的成员**:进静态放行半场的每一行都要指得回一个源码常量坐标。
- **kill-switch 不得被削弱**:`cloud-web-search.test.ts` 的 `killSwitch: true` 臂与
  `packages/ext/src/cloud-websearch-kill.test.ts` 必须全绿且**断言不改**。(`#1443` 在后者改了一个
  夹具的**名字**与它代表的账户态,`expect(...)` 一行未动 —— 见 D6。)
- **不得长出第二份权威**:「本地 web search 此刻在不在模型工具表里」与系统提示里那一行,
  必须在四种账户态下逐一相符(承接 `#1431`,CODE-2)。
- **文案不得把模型引向走不通的路**:`LOCAL_WEBSEARCH_DENIED_MESSAGE`
  (`packages/core/src/tool/websearch.ts:46`、`packages/opencode/src/tool/websearch.ts:45` 复用同值)
  今天无条件说「去用 `cloud_cloud_web_search`」;这条路径改完之后只在 kill-switch 下可达,
  文案必须说 kill-switch 的实话。

[[ADR-009]] 里**仍然成立**的部分:决策 A 的四条(默认放开 / 不做前端 key 入口 / `alpha.env`
秘钥落点 / 逃生开关),适用面回到对所有账户态成立;裁决 (a)–(d) 的**机制事实**(远端 MCP 只能
整 server 开关、云侧最终闸落在 ext 的 `tool.execute.before`、ARM/DEF 装载握手、两份 websearch
副本、引擎注册 id 是 `cloud_cloud_web_search`)全部继续有效 —— 本 ADR 只改「谁决定本地腿在不在」。
**从此不成立**的是:B1 的登录态门控与云优先(本地腿在代付态被 force-off)、以及把「登录」当作
「有额度」的那个推断。

尚未闭合、不要当成已知:零余额真账户的 402 wire body 从未跑过;`tool.execute.after` 在 402 结果上的
实际 hookInput 形状未跑;`packages/core` 与 `packages/opencode` 两份 websearch 副本哪一份被**执行**
未测(两份都要改)。runtime 证据由 `#1433`(VERIFY-1)承担。

## 拒绝的方案

- **A:把额度信号送进 sidecar,让桌面在调用前就不给模型云工具。** 造第二个权威(判据在 renderer,
  要进 sidecar 得在 fork 白名单上开新通道),而且**必然过期** —— fork 时算、整个会话恒定,用户
  中途充值就整个会话看不到云工具且零错误解释。失效方向是「对付费用户静默 fail-closed」,
  比多一次 402 更糟。
- **B:云侧按账户广播工具集(注册期过滤)。** 承载层可行(已实跑),且判定仍由同一个权威做;
  但要放宽云侧构造期不变量与那条等式闸(它们今天正是「工具面不会悄悄变」的保证)、要新增一条
  account 只读额度路由,而且**一样会过期**(云侧 stateless、没有 server→client 的工具表变更
  通知通道)。**如果将来要求「根本不调」,B 是正确的那条路,A 不是** —— 那是一张 alpha-platform 的票。
- **C:整 server 关当作选路手段。** 它关掉的是该 server 上的全部工具(见 D3)。本决策不扩大它的使用面。
- **D:云失败时桌面自动改调本地(静默 failover)。** 违反「云失败禁静默切 keyless」;它把一次
  计费拒绝变成一次用户不知情的降级(云搜索的 key 恒在 gateway,本地是 keyless 公共端点,
  隐私与质量属性都变了)。改由模型在工具表里自己选。
- **E:在桌面镜像 account 的额度规则(plan / wallet / allowance 三态)。** 红旗本体:我的设计
  要跟外部逐点保持同步,拒绝理由域还会继续长,镜像必然漂。

## 承接实现

`#1411`(CODE-1 选路)、`#1431`(CODE-2 系统提示一致性)、`#1432`(CODE-3 本 ADR)、
`#1433`(VERIFY-1 四种账户态的 runtime 证据);父需求 `#1414`。
`#1443` 补登记 D1 的第二处落点(D6,第三方 web-search MCP),零行为改动。
`#1448` 按 owner 2026-09-24 裁决收窄 D3 的作用面(逃生开关只管我们自己提供的两条搜网腿),零行为改动。
