---
title: "alpha-code#1461 —— 装了真第三方 web-search MCP 的机器上,ADR-046 D6 四格到底怎样"
kind: verification
status: active
owners:
  - alpha-code maintainers
last_reviewed: 2026-09-27
---

# `alpha-code#1461` · 第三方搜网插件 × 四种账户态

票:[`alpha-code#1461`](https://github.com/jinjunnn/alpha-code/issues/1461)(ADR-046 D6 的 VERIFY)·
被测断言:[`ADR-046`](../../../.claude/rules/adrs/ADR-046-web-tools-two-legs-account-routing.md) **D6** ·
前作:[`#1433`](../2026-09-24-1433-four-account-states-websearch/README.md)(只覆盖我们自己的两条腿)

> D6 那张四格表在本票之前是**从代码读出来的推断**。本票把它放到一台装了真插件的引擎上跑,
> 每一格都把三件事分开记:①模型手里**有没有**那个工具(引擎发给模型的 `tools[]` 名单);
> ②模型**有没有真的调它**(upstream 响应里的 `tool_calls`);③调用**落在哪**(拿回搜索结果,
> 还是被 ext 的 `tool.execute.before` 以 kill-switch 拒)。**跑不到的格标「未测」,不用推导补齐。**

## 0. 一页结论

三种第三方形状(下称「臂」),同一套引擎、同一套 env、同一句驱动句:

| 臂 | 第三方是什么 | 引擎里的工具 id | 生产分类器 `isWebSearchToolId` |
| --- | --- | --- | --- |
| `exa-remote` | 用户在配置里声明 `{"mcp":{"exa":{"type":"remote","url":"https://mcp.exa.ai/mcp"}}}` —— **D6 的字面例子**;Exa 今天 advertise 的工具名 `web_search_exa`(本轮 `tools/list` 实读) | `exa_web_search_exa` | **命中** |
| `own-web_search` | 自建 stdio 插件([`mcp-server.ts`](mcp-server.ts)),**真打 DuckDuckGo** 结果页;工具名 `web_search` | `duck_web_search` | **命中** |
| `own-search` | **同一个插件、同一条传输、同一个后端**,只把工具名换成 `search` | `duck_search` | **不命中** ← AC2 反向臂 |

四格 × 三臂,**两轮各 12 格,24 格结论逐格相同**([`results/matrix-round1.json`](results/matrix-round1.json) ·
[`results/matrix-round2.json`](results/matrix-round2.json)):

| 账户态 | ① 工具在不在模型表里 | ② 模型调没调 | ③ 落在哪(`exa-remote` / `own-web_search`) | ③ 落在哪(`own-search`,反向臂) |
| --- | --- | --- | --- | --- |
| 登出 / BYOK | 三臂都**在**(`websearch` 同在) | 三臂都调了 | **拿回结果**(Exa 18,258 B / DDG 510 B 喂回模型) | **拿回结果**(517 B) |
| 登录 + 有额度 | 同上 | 同上 | **拿回结果**(12,884 B / 460 B) | **拿回结果**(516 B) |
| 登录 + 无额度 | 同上(env 与上一格逐字相同,见 §2.3) | 同上 | **拿回结果**(3,815 B / 649 B) | **拿回结果**(624 B) |
| **kill-switch** | 三臂**都还在表里**;`websearch` 不在了 | 三臂都调了 | **执行前被拒**:引擎工具格 `status: "error"`,模型收到 `WebSearchSovereigntyError` 原文(§3.4) | **拿回结果**(1,181 B;出网代理 `html.duckduckgo.com:443 allow`,插件 trace HTTP 200 / 34,053 B / 10 条) |

**三句话:**

1. **AC1** 三种非 kill-switch 态下,第三方搜网插件在表里、调得动、真的搜到东西 —— 与 D6 一致。
2. **AC2 反向臂拿到了**:kill-switch 下,工具名不落进 `isWebSearchToolId` 的第三方搜网插件**确实没被拦住**
   —— 而且用的是最常见的名字 `search`,不是刁钻构造。同一个插件只把名字改成 `web_search` 就被拦。
   离线用同一生产函数判 `google_search` / `bing_search` / `search_the_internet` 也**不命中**(§4.2)。
3. **AC3** D6 的方向对(尽力、不保证),两处措辞与实测不符,已就地修订:
   ①kill-switch 那格原写「关」,实测是**工具仍在表里、调用时被拒**;②「做不到穷尽」原只举非 ASCII 名,
   实测纯 ASCII 的常见名就漏。ADR 改动零行为(§5)。

**本轮真模型调用总数 78 次**,全部打向 `https://api.deepseek.com/v1/chat/completions`(`deepseek-flash`):
1 次冒烟 3 次 + 两轮矩阵 36 + 37 次 + 对照臂 2 次(第一次冒烟引擎起不来,0 次调用,§2.4)。
**0 分钱云腿费用**(云 server 在本轮被出网代理拒,见 §2.3)。

## 1. 被测件与凭据卫生

| 项 | 值 |
| --- | --- |
| 树 | `.worktrees/1461-thirdparty-websearch` @ **`7df68c8c7`**(= `origin/alpha`,含 `#1462` 那条「拒绝理由只点名 kill-switch」的文案改动) |
| 生产代码改动 | **零**(本目录 + `docs/README.md` 一行索引 + ADR-046 措辞) |
| 引擎 | `packages/opencode/src/index.ts run --format json`,bun 1.3.14(dev 树,非打包) |
| ext | `packages/ext/dist/plugin.js` 本树现编;每格用 `ALPHA_EXT_VERBOSE=1` 的装载回执 `[@alpha-code/ext] context injections` 证明它真装上了(`extLoaded` 24/24 = true) |
| 第三方插件 | Exa 远端(真 vendor,`mcp.exa.ai`);自建 stdio 插件用引擎自己 `node_modules` 里的 `@modelcontextprotocol/sdk@1.29.0` + `zod@4.1.8` |
| 宿主 | macOS 26.3.1 / Darwin 25.3.0 arm64 |

**凭据卫生**(沿用 `#1433` owner 批准的边界):模型 key 从会话临时目录的 `KEY=VALUE` 文件读进 runner
进程内存,只出现在发往 upstream 的 `Authorization` 头里;引擎配置里是占位串 `ac1461-placeholder-not-a-real-key`;
登录态的 `ALPHA_MCP_TOKEN` 文件是占位串 `ac1461-placeholder-not-a-real-token`。Exa 走 keyless,本轮没有任何
第三方 key。

**扫描是跑过的闸,不是声明**:收尾对本目录每个文件逐字节找 key 的**完整值、前 12 字节、后 12 字节**三种片段,
并用一根一定在的针(`alpha-code#1461`)证明扫描真的读到了文件。脚本自检时先种一段片段确认它会报 HIT。
结果:

```
scanning 8 files under docs/verification/2026-09-27-1461-third-party-websearch-mcp-four-states
positive-control needle 'alpha-code#1461': 8 file(s) hit
fragments checked: 6 ; hits: 0
SCAN CLEAN
```

## 2. 手段 —— 每一半都先证明它能测出已知的坏

### 2.1 引擎怎么装上真第三方插件

引擎配置经 `OPENCODE_CONFIG_CONTENT`(与生产注入同一通道)给三样东西:`plugin: [<ext bundle>]`、
一个指向记录代理的 `@ai-sdk/openai-compatible` provider、以及第三方 `mcp` 条目。远端臂就是 D6 那行 JSON;
自建臂是 `{"type":"local","command":["<bun>","<abs>/1461-mcp-server.ts","--tool","<name>","--trace","<file>"]}`。
引擎给它们起的 id 是 `McpCatalog.toolName` 的 `sanitize(server)_sanitize(tool)`。

自建插件不是桩:每次调用真向 `https://html.duckduckgo.com/html/?q=…` 发请求、解析 `result__a` 链接、
把标题 + URL 交回模型,并把这次出网(状态码 / 字节数 / 条数)写进 `--trace` 文件。先用 SDK 自己的
`Client` 单独跑通(`tools/list` → `["search"]`,`tools/call` → 3 条真结果,trace `200 / 32,485 B`),再交给引擎。

### 2.2 出网:生产的策略代理,白名单换成本轮的

引擎经 `sidecarEgressProxyEnv()` 注入的 `HTTP(S)_PROXY` 走**生产的** `startEgressPolicyProxy`,
`authorize` 换成白名单 `{mcp.exa.ai, html.duckduckgo.com, duckduckgo.com, models.opencode.ai}`,其余一切拒 ——
**包括 `registry.npmjs.org`**:引擎开机会为 config 里的 plugin 跑一次 npm 安装并让第一个请求等它
(`ac#1454` 根因),拒掉它这次安装当场 403 收场,每格 5–12 s 而不是卡 60 s+。
先证明 bun 的 fetch 真吃这组 env:`HTTPS_PROXY=http://127.0.0.1:9` 下 `fetch("https://example.com")` 报
`ConnectionRefused`,去掉后 200。

代理日志因此成了**第二条独立证据轴**:第三方工具真出网了没有,不看模型说什么,看 `CONNECT` 记录。
每格都记到 `registry.npmjs.org:443 deny 1`(证明代理在路径上且拒得掉),自建臂记到
`html.duckduckgo.com:443 allow 1`,Exa 臂记到 `mcp.exa.ai:443 allow 2`。

### 2.3 四种账户态:复刻生产在每一态写下的变量,不手编判据

| 账户态 | env(坐标) | `config.mcp` |
| --- | --- | --- |
| 登出 / BYOK | 两个 deny 信号不置位、`OPENCODE_ENABLE_EXA=1`(`server.ts` `applyWebSearchSovereignty` 非 kill-switch 分支);ARM / DEF / SERVER 都删(`alpha-config-injection.ts:417-420`) | 只有第三方 |
| 登录 + 有额度 | 同上 + `ALPHA_CLOUD_MCP_URL`、`ALPHA_CLOUD_MCP_SERVER=cloud`、`ALPHA_CLOUD_MCP_DEF=materializeCloudMcpConfig(url, "{file:…ALPHA_MCP_TOKEN}")`(`:386-391`) | 第三方 + `cloud`(真定义,`enabled:true`,`:403-404`) |
| 登录 + 无额度 | **与上一格逐字相同** —— 桌面侧没有额度轴(ADR-046 D2),`webSearchToolDenial` 的入参只有工具名 / env / 归属 | 同上 |
| kill-switch | `ALPHA_CLOUD_WEBSEARCH_DENY=1`(`server.ts:358`)、四个 keyless flag = `"0"`(`:362`)、`ALPHA_LOCAL_WEBSEARCH_DENY=1`(`:367`);`ALPHA_CLOUD_MCP_ARM=cloud`(`injection :409`) | 第三方 + `cloud` = `WITHHELD_CLOUD_MCP`(`:401-402`) |

permission 的 deny 由生产的 `applyWebSearchDenies(config, {killSwitch, platformPays})` 算(kill-switch 下加
`websearch` 与 `cloud_cloud_web_search` 两条,其余格零条 —— 结果里逐格入库)。

**登录两格的诚实边界**:`ALPHA_MCP_TOKEN` 是占位串,而且 `alpha-cloud.tidelabs.click` 不在白名单里
(每格记到 `deny 2`),所以云 server 在本轮**没连上**、`cloud_*` 工具不在模型表里。这两格复刻的是**桌面侧的
形状**(cloud 定义在配置里、ext 的归属快照里 `governed:["cloud"]` —— 24 格逐格入库),不是云腿本身;
云腿的 402 / 凭证面 `#1433` §6 已经测过,而且第三方判决不读它。

### 2.4 一个代理同时量到三半,外加两处「先证明手段」

- ①在不在表 = 引擎**请求**体里的 `tools[]`;②调没调 = upstream **响应**里的 `tool_calls`;
  ③落在哪 = **下一次请求**体里那条 `role:"tool"` 消息 + 引擎自己的工具格(`status` / `error`)。
  记录代理与 `#1433` 逐字同款,不产生内容,只转发并记录。
- **第一次冒烟引擎起不来**(exit 1,2.2 s,0 次模型调用):白名单初版写的是 `models.dev`,而引擎的模型目录
  host 是 `models.opencode.ai`(`packages/core/src/models-dev.ts:160`),隔离 HOME 里没缓存 ⇒
  `ModelsDev.populate` 的 `Effect.orDie` 把整个 session 打死。**那次的 `offered=false` 不是结论,是仪器坏了**
  —— 认出来靠的是代理日志里 `models.opencode.ai:443 deny 2`。放进白名单后同一格 6 s 跑通。
- **驱动句是显式的**(点名工具 id,「不可用或报错就明说并停下」):本票要答的是「调它会发生什么」,
  不是「模型会不会自己选它」。中性驱动句下模型选本地 `websearch` 还是第三方,归 §7 未测。

## 3. AC1 —— 四格逐格

### 3.1 工具表(①)

登出 / 登录两格三臂的 `tools[]`(以 `exa-remote` 为例,其余臂只差第三方那几个 id):

```
alpha_echo alpha_ping alpha_register alpha_reload exa_web_fetch_exa exa_web_search_exa glob grep
list_mcp_resource_templates list_mcp_resources read read_mcp_resource skill task todowrite webfetch websearch
```

kill-switch 同一臂:**只少了 `websearch`**,`exa_web_search_exa` 原地不动。自建臂同理:`duck_web_search` /
`duck_search` 在四格里都在。⇒ **第三方工具从不被滤出工具表**,注入面的 permission deny 只点名我们两个 id
(`applyWebSearchDenies`),D6 那格的「关」指的只能是执行期。

### 3.2 模型调没调(②)

24 格里模型都发了对第三方工具的 `tool_calls`,原文如 `exa_web_search_exa {"query": "recent articles and release
notes about the Bun JavaScript runtime", "objective": …}`、`duck_search {"query": "Bun JavaScript runtime recent news",
"limit": 10}`;引擎工具格的 `callID` 与模型 `tool_calls[].id` 同一个 —— 是模型认领的,不是 runner 注入的。

### 3.3 三个非 kill-switch 态:落在「拿回结果」

喂回模型的 `role:"tool"` 消息开头(第一轮):

- Exa(登出):`Title: Bun v1.4.2 | Bun Blog / URL: https://bun.com/blog/bun-v1.4.2 / Published: 2026-09-05…`,18,258 B
- 自建 `web_search`(登录有额度):`1. Bun — A fast all-in-one JavaScript runtime / https://bun.sh/ / 2. Blog | Bun …`,460 B
- 自建 `search`(登录无额度):`1. Bun vs Node.js: 3x Faster, But Is It Ready? [2026] / https://tech-insider.org/…`,624 B

模型随后各交出三条带 URL 的答案(`assistantFinalTextHead` 逐格入库)。

### 3.4 kill-switch:名字被认出的两臂 —— 在表里,调用时被拒

引擎工具格 `status: "error"`,`error` 原文(两臂只差工具 id):

> `exa_web_search_exa is unavailable: the alpha web search kill switch (ADR-009 B2) is set, and it turns off every
> web search tool — the local keyless one, the platform-hosted one, and this one alike. This is not a transient
> failure and no permission grant can lift it; do not retry. Answer without web search and say so.`

这就是 `7df68c8c7`(`#1462`)之后的文案 —— 只点名 kill-switch,不再提「平台代付」。喂回模型 318 B,
模型原样引用并停下:*「`exa_web_search_exa` is not available. The error text I received was: … Per your
instructions, I'm stopping without listing results.」* 出网代理里 Exa 臂仍有 `mcp.exa.ai:443 allow 2`
(那是 server 连接与 `tools/list`,不是搜索);自建 `web_search` 臂 **`html.duckduckgo.com` 零记录**、
插件 trace 只有 `started` —— 拒在调用之前,插件根本没被叫到。

## 4. AC2 —— 反向臂:名字认不出的第三方搜网插件,kill-switch 拦不住

### 4.1 实跑(两轮相同)

kill-switch × `own-search`:env 与 §3.4 逐字相同(两个 deny 信号都置位、ext 已装载、归属 `governed:["cloud"]
foreign:["duck"]`),唯一差别是工具名 `search` 而不是 `web_search`。结果:

| 轴 | 实测 |
| --- | --- |
| ① `duck_search` 在表里 | 是 |
| ② 模型发了 `duck_search {"query": "Bun JavaScript runtime recent news", "limit": 10}` | 是 |
| ③ 引擎工具格 | `status: "completed"`,输出 `1. Bun — A fast all-in-one JavaScript runtime / https://bun.sh/ …` |
| 喂回模型 | 1,181 B 的搜索结果 |
| 出网代理 | `html.duckduckgo.com:443 allow 1` |
| 插件 trace | `{"upstream":"html.duckduckgo.com","status":200,"bytes":34053,"results":10,"ms":1018}` |
| 模型最终答案 | 三条真 URL(`bun.sh`、`bun.com/blog/bun-joins-anthropic`、`infoq.com/…`) |

**同一个插件、同一格 env,只换名字就翻转**(`web_search` 被拒 → `search` 放行),所以这不是「这一个插件恰好
被拦住了」,而是判决只读名字这件事本身。

### 4.2 名字的边界(离线,生产函数)

[`name-boundary.ts`](name-boundary.ts) 直接 import `packages/ext/src/cloud-websearch-kill.ts` 的
`isWebSearchToolId` / `webSearchToolDenial` / `mcpEngineToolId` 判一组形状
([`results/name-boundary.json`](results/name-boundary.json)):

| 引擎 id(server 键 + 工具名) | 命中 | kill-switch 下 |
| --- | --- | --- |
| `exa_web_search_exa`、`duck_web_search`、`ddg_search`、`duckduckgo_search`、`s_internet_search`、`t_tavily_search` | 是 | 拒 |
| `duck_search`、`google_search`、`b_bing_search`、`s_search_the_internet`、`p_perplexity_ask`、`s_query`、`s_lookup`、`exa_web_fetch_exa`、非 ASCII 名 | **否** | **放行** |

两条值得写进 D6 的事实:**①最常见的搜索工具名 `search` 拦不住,`google` / `bing` 这两个词刻意不在词表里
(AC4 防误杀 `gdrive_search`),于是 `google_search` / `bing_search` 也拦不住;②server 键是用户起的** ——
同一个 `search` 工具挂在 `ddg` 下命中、挂在 `duck` 下不命中,拦不拦取决于用户给 server 起了什么名。
本表只判 id 形状,不宣称任何 vendor 实际用了哪个名(Exa 的两个名是本轮 `tools/list` 实读,其余是形状)。

## 5. 策略闸在 kill-switch 闸的前面 —— 对照臂

生产里第三方 MCP 工具的执行顺序是:`AlphaToolPolicyGate`(`session/tools.ts:99-110`,第三方 MCP 默认
`ask`,`packages/schema/src/alpha-tool-policy.ts` `classDefaultState`)→ ext 的 `tool.execute.before`
(kill-switch)→ MCP 调用。runner 给引擎 `run --auto`,= 用户在弹窗上点「允许」。**它不是可有可无的假设,
是跑出来的**([`results/control-no-auto-kill-switch-own-search.json`](results/control-no-auto-kill-switch-own-search.json)):
同一格去掉 `--auto`,引擎打印 `permission requested: mcp:duck:search (*); auto-rejecting`,工具格
`error: The user rejected permission to use this specific tool call.`,出网代理**零** DuckDuckGo 记录,插件 trace
只有 `started`。

⇒ 在打包产品里,kill-switch 下用户装的 `search` 类插件会**先弹一次审批**;点了允许,搜索照常发生,
kill-switch 对它没有发言权。这与 `#1433` §4.1 记的「`webfetch` 打搜索引擎撞出网批准」同形:
一道能力闸降级成一次用户点击。

## 6. AC3 —— 与 D6 逐条对照,改了什么

| D6 原措辞 | 实测 | 判定 |
| --- | --- | --- |
| 登出 / BYOK:可用 | 三臂在表里、调得动、拿回结果 | 一致 → 补实测背书 |
| 登录 + 有额度:可用 | 同上 | 一致 → 补背书 |
| 登录 + 无额度:同上 | 同上(env 与有额度格逐字相同) | 一致 → 补背书,并写明第三方判决不读额度轴 |
| kill-switch:**关** | 工具**仍在表里**;名字被认出的调用时被拒;认不出的**照常搜到** | **措辞不符** → 改成「在表里、调用被拒 —— 仅当工具名被认出;认不出的照常可用」 |
| 「做不到穷尽 —— 非 ASCII 名任何分类器都看不见」 | 纯 ASCII 的 `search` / `google_search` / `bing_search` 同样认不出 | **例子太窄** → 补上实测的常见名与「server 键是用户起的」 |
| 后果表 kill-switch 列「关(尽力拦截,见 D6)」 | 同上 | 改成「名字被认出的:仍在表里、调用被拒;认不出的:照常可用」 |

ADR-046 的改动照 D3 `#1448` 的先例**就地修订、带日期、零行为改动**,front matter `amended` 推到
2026-09-27。没改 kill-switch 判决逻辑、没动 `isWebSearchToolId` 的成员、没动出网围栏、没动我们自己的两条腿。

**顺带一条不在本票范围的观察(只报告,不修)**:拒绝文案说 kill-switch「turns off **every** web search tool
— … and this one alike」。§4 表明它关不掉名字认不出的那些;这句话直接进模型上下文,是否要收窄成
「every web search tool it can recognise」归 ext 那边另裁。

## 7. 明确未测

| 未测项 | 为什么到不了 |
| --- | --- |
| 登录两格的**真云腿**(真登录铸 token、`cloud_*` 在表里时模型选谁) | 本轮 token 是占位串、云 host 被代理拒;`#1433` §6 已用零余额真账户测过 402,而第三方判决不读云腿 |
| **打包实例**上的四格 | `providers.add` 拒收回环 base URL(`#1433` §7.1),打包真模型取证配方结构上已失效;本轮是 bun dev 树 + 真 ext |
| 打包产品里第三方 `local` 插件的出网是否被 seatbelt 强制走代理 | 归 `#1334` / `#1337`;本轮自建插件是自愿吃 env 代理 |
| **中性驱动句**下模型在 `websearch` 与第三方之间选谁 | 本轮驱动句显式点名第三方工具(§2.4) |
| 策略闸弹窗的人工路径(用户真的点「允许」) | 用 `run --auto` 替代,并用 `--no-auto` 对照臂证明闸在路径上(§5) |
| 非 ASCII 工具名的活体反向臂 | 离线已证不命中(§4.2),与 R6 结论相同,没再花模型调用 |

## 8. 复现

```bash
# 离线:生产分类器对若干 id 形状的判决(不花钱)
cp docs/verification/2026-09-27-1461-third-party-websearch-mcp-four-states/name-boundary.ts packages/ext/1461-name-boundary.ts
cd packages/ext && bun run 1461-name-boundary.ts

# 先编 ext 与自建插件的单机自证
bun run --cwd packages/ext build
cp docs/verification/2026-09-27-1461-third-party-websearch-mcp-four-states/mcp-server.ts packages/opencode/1461-mcp-server.ts

# 四格 × 三臂(需要一份 KEY=VALUE 的 key 文件;key 不入任何产物)
cp docs/verification/2026-09-27-1461-third-party-websearch-mcp-four-states/run-cells.ts packages/ui-mac/1461-run-cells.ts
cd packages/ui-mac && bun run 1461-run-cells.ts --keys-file <abs> --out <abs>.json --scratch <abs dir> < /dev/null
#   单格:--cell kill-switch --arm own-search ;对照臂:再加 --no-auto
```

两个 `.ts` 必须先 `cp` 进对应的包:runner 要 ui-mac 的生产模块(`network-egress-proxy` / `sidecar-env` /
`cloud-web-search` / `cloud-sidecar-config`),插件要 opencode 的 `@modelcontextprotocol/sdk`。跑完把两个
`1461-*.ts` 删掉,别留在树上。`< /dev/null` 是本仓「CLI 的 stdin 是打开不关的管道就会挂住」那条陷阱。
