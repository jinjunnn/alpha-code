# Exa MCP 的失败信号 —— 实读(2026-09-24)

本地搜网的出厂默认路径是无 key 的 Exa 免费额度。`alpha-code#1445` 的问题是:
**额度用尽时,Exa 那句「去申请自己的 key」以「成功的搜索结果」的形状交给了模型。**

修这个 bug 之前只有一个问题要答:**「这是一段错误提示」有没有结构化信号可以消费?**
按内容关键字匹配(`"rate limit"` / `"create your own API key"`)是本仓明令禁止的
「手写别人文法的替身」,所以先实读端点本体,再谈修法。

本文是那次实读的结论。它是下一轮 review 的对照物,不是方案。

## 怎么量的

探针在 [`../verification/2026-09-24-1445-exa-mcp-response-shapes/probe-exa-shapes.mjs`](../verification/2026-09-24-1445-exa-mcp-response-shapes/probe-exa-shapes.mjs),
打的是 `https://mcp.exa.ai/mcp` **本体**,不经任何包装器 —— 包装器正是被测对象。
请求与 `packages/opencode/src/tool/mcp-websearch.ts` 的 `call()` 逐字同形:同 `tools/call`、
同工具名 `web_search_exa`、同 `accept: application/json, text/event-stream`、同参数形状
(`SearchArgs`)。所以这里量到的就是生产那条路上会拿到的东西。

原始输出在 [`../verification/2026-09-24-1445-exa-mcp-response-shapes/results/`](../verification/2026-09-24-1445-exa-mcp-response-shapes/results/)。

## 量到了四种形状

| # | 触发 | HTTP | JSON-RPC | `isError` | `content[0]._meta` | 生产现在怎么判 |
| --- | --- | --- | --- | --- | --- | --- |
| A | 正常搜索 | 200 `text/event-stream` | `result` | 缺省 | **`{searchTime: <number>}`** | 成功(对) |
| B | Exa 自己的 in-band 错误(无效 key / 未知工具 / 参数不合法) | 200 `text/event-stream` | `result` | **`true`** | **无** | `provider_error`,响亮(对) |
| C | 免费额度用尽(**今天**) | **429** `application/json` | **`error` `-32000`** | — | — | `unexpected_status`,响亮(对) |
| D | 免费额度用尽(**`#1433` 于 06:39Z 实测到的那一次**) | 2xx | `result` | **非 true** | **未知** | **成功 —— 这就是 `#1445`** |

样本量(2026-09-24 11:34–11:46Z,同一出网 IP):

- A:27/27 次 200 响应**全部**带 `content[0]._meta.searchTime`
  ([`results/success-arm-sample.log`](../verification/2026-09-24-1445-exa-mcp-response-shapes/results/success-arm-sample.log));
- B:4/4 臂(`web_search_exa` 401、`web_fetch_exa` 401、未知工具 `-32602`、参数不合法 `-32602`)
  **全部** `isError: true` 且 `content[0]` 只有 `["type","text"]` —— **没有 `_meta`**;
- C:43 次 429,含 5 种 `accept` 头变体(`json,sse` / 仅 sse / 仅 json / 不带 / 带 `MCP-Protocol-Version`),
  **无一例外**都是 429 + JSON-RPC `error`,带 `retry-after`、`x-ratelimit-limit: 0`、
  `x-ratelimit-remaining: 0`、`x-ratelimit-reset`;
- D:**本轮 0 次**。

D 与 C 的文案**不是同一串**。共同前缀到 `… at https://dashboard.exa.ai/api-keys , ` 为止,之后:

- D(`#1433`,06:39Z):`and then update Exa MCP URL to this https://mcp.exa.ai/mcp?exaApiKey=YOUR_EXA_API_KEY`
- C(本轮,11:35Z 起):`then either:` + `- Set the header: Authorization: Bearer …` + `- Or use the URL: …`

另一处旁证:实读 `tools/list`,`web_search_exa` 当前的 `inputSchema` 是**必填 `objective`** 且
`additionalProperties: false`,而两份生产副本发的是 `type` / `livecrawl` / `contextMaxCharacters`
且不带 `objective` —— 服务端今天仍宽松接受。**我没有旧 schema 的快照**,所以「Exa 在 `#1433` 与
本次实读之间发过版」只是最省事的解释,不是实读结论。

**D 没复现 ≠ D 不存在。** 它的负载有记录:`#1433`(VERIFY-1)2026-09-24T06:39:30Z 那一轮的
`logged-out-byok` 格 exa 臂,`outcome=result` / `ms=521` / `bytes=246` / `head` 240 字。
那条 lane 的取证文件**当时还没提交**,只在它自己的 worktree 里,所以这里不跨 worktree 建链接 ——
负载已逐字复制进
[`../verification/2026-09-24-1445-exa-mcp-response-shapes/results/ticket-payload.json`](../verification/2026-09-24-1445-exa-mcp-response-shapes/results/ticket-payload.json),
同一文件里写着 envelope 的每一格是**怎么反推出来的**、哪一格反推不出来。

补全方式可检查:记录的 `head` 被截到 240 字而 `bytes` 是 246 ⇒ 缺的 6 字是 `PI_KEY`
(⇒ `YOUR_EXA_API_KEY`);补全后长度**逐字等于 246**,前 240 字与记录的 `head` 逐字相同。

## 结构化信号的清点

对 **D 这一种**响应,能消费的结构化信号逐个点名:

| 候选 | 实读结果 | 能不能用 |
| --- | --- | --- |
| `isError` | **非 true** —— `#1433` 的探针走的就是生产传输 `McpWebSearch.call` 且拿到 Success,而 `mcp-websearch.ts:204` 在 `isError` 为真时必然失败 ⇒ 反推得证 | **不能** |
| JSON-RPC `error` | D 是 `result` 不是 `error`(否则 schema 解码失败 ⇒ `invalid_response`) | **不能** |
| HTTP 状态码 | 2xx(否则走 `statusKind()` ⇒ 早就响亮了)。这正是 `#489`/E7 那条收口管不到 D 的原因 | **不能** |
| `structuredContent` | 两个工具在 `tools/list` 里**都没有声明 `outputSchema`** ⇒ MCP 不要求成功时给 `structuredContent`,A 臂实测也一个都没有 | **不能** |
| 限流类 HTTP 头 | A 臂不带、C 臂才带;D 带不带**未知** | **未知** |
| `content[0]._meta` | A 臂 27/27 带 `{searchTime}`,B 臂 4/4 不带。**D 带不带未知** | **见下** |

**结论:对票面那一种响应,没有一个可以被证明的结构化信号。**

> **2026-09-26 订正**:下一段「判据的失败臂没被观测过」把两件事混了 —— 没观测到的是 D 的**信封元数据**,
> **文本**是实抓的。按订正后的前提重做的逐条排除见文末《2026-09-26 补勘》;结论没变,理由换了。

`_meta` 是唯一还站着的候选,但它有两处站不住:

1. **判据的失败臂没被观测过。** 要拿它当闸,就得先假设 D 不带 `_meta`;而 AC2 要求
   「拿原始负载当输入,改前成功、改后失败」—— `#1433` 记下的是**文本**,envelope 要我自己拼。
   我拼一个不带 `_meta` 的 envelope,再用「没有 `_meta` 即失败」去判它,**期望值与被测对象同源**,
   这条测试证明不了任何事。
2. **它把一个全称命题变成致命前提。** `searchTime` 不在 Exa 的工具声明里,是个无契约的
   vendor 字段。「Exa 永远给真结果带 `_meta`」这句话今天是 27/27,明天由 Exa 决定 ——
   而它一旦不成立,闸门**拒载的是真实结果**,整条本地搜网对用户直接断掉。
   本仓 `REQ-127` 已经为「一条没跑过的全称事实同时决定选型和一道致命闸门」付过一次账。

## 票面那份负载,两份传输现在都判它成功

把 `results/ticket-payload.json` 的最小 envelope 喂进**生产自己的** `parseResponse`
(两份副本各一个),实测
([`../verification/2026-09-24-1445-exa-mcp-response-shapes/results/parsers-before.txt`](../verification/2026-09-24-1445-exa-mcp-response-shapes/results/parsers-before.txt)):

| 负载 | `packages/opencode` | `packages/core` |
| --- | --- | --- |
| 票面的额度提示 | **成功** | **成功** |
| Exa in-band 错误(`isError: true`,今日实测) | 失败(`provider_error`) | **成功** |
| 正常结果(对照臂) | 成功 | 成功 |

第一行就是 `#1445`:两条腿都把那句提示当搜索结果交给模型。
第二行是**另一件事**,见文末第 1 条。

> 2026-09-26 补:第二行 `packages/core` 那一格已由 `alpha-code#1449` 收口 —— `packages/core/src/tool/websearch.ts`
> 现在读 `isError`、非 2xx 走状态映射而不是 `filterStatusOk`,判据在
> `packages/core/test/alpha-websearch-failure.test.ts`(负载就是本目录的 `results/arms.json`)。
> 第一行(D 那一种)不变:仍无结构化信号,仍归 `#1445`。

## 已经是对的那两半

- `packages/opencode/src/tool/mcp-websearch.ts` 对 **B** 与 **C** 都响亮:
  `:204` 消费 `isError`、`:212` 消费结构化 `{error:…}`、`call()` 里非 2xx 走 `statusKind()`。
- 所以 **C(今天的额度用尽)在这条腿上已经是一次明确的失败**,模型看到的是
  `Web search failed: unexpected HTTP status (HTTP 429). Cause: …`。

## 复现代价

**Exa 的免费额度按出网 IP 计,而且跑满一次要等约 12 小时**
(实测 `retry-after: 44333`,`x-ratelimit-reset` 指向次日 00:00Z)。
本次实读把本机的额度跑满了 —— **额度重置之前,本机无 key 的本地搜网会一直拿 429**。
它**是响亮失败**,不是静默,但功能在这段时间里是不可用的。

要再量一次 A 臂,先确认额度已重置,不要为了「再看一眼」重跑整套。

## 顺带量到的、不属于本轮的

1. `packages/core/src/tool/websearch.ts` 那份 V2 副本**完全没有 E7 的那层收口**:
   它的 `McpResult`(`:148`)不含 `isError`,`parseResponse`(`:171`)读不出就返回 `undefined`,
   调用方(`:312`)把 `undefined` 换成 `NO_RESULTS`(`:68`,一句编造的「没有结果」),
   出网用的是 `HttpClient.filterStatusOk`(`:229`,把所有非 2xx 压成一个不可辨的错误)。
   **实测**:把今天抓到的 B 臂真实负载(`isError: true` 的 401)喂进去,
   `packages/opencode` 判失败,`packages/core` 判**成功**,并把那句 401 原文当搜索结果交给模型。
   这是同一个「伪成功」类的另一个实例,触发条件与 `#1445` 不同,归属由主 session 定。
   → 已拆成 `alpha-code#1449` 并收口(见上文 2026-09-26 补记)。
2. Exa 当前的 `web_search_exa` `inputSchema` 必填 `objective`,而两份生产副本都不发它。
   今天服务端仍宽松接受;哪天不接受了,两条腿会同时坏。

## 2026-09-26 补勘:坏负载在手上之后,判据仍然不存在 —— 逐条点名

**前提订正。** 上文「失败臂从没被观测过」把两件事混了:没观测到的是 D 的**信封元数据**(`_meta`、
响应头),**文本**是 `#1433` 走生产 `McpWebSearch.call` 实抓的(246 字,补回被截的 6 字后与记录的
`bytes` 逐字相等,见 `results/ticket-payload.json`)。所以两条臂都立得起来:D 必须判失败;真实结果与
真实零命中必须照旧放行。本轮按这个前提重做。结论仍然是**没有一条站得住的结构性判据**,但这次是
逐个点名排除,不是没找到。证据在
[`../verification/2026-09-26-1445-exa-vendor-source-and-live-shapes/`](../verification/2026-09-26-1445-exa-vendor-source-and-live-shapes/README.md)。

### 新量到的事实

1. **vendor 源码:每一个发过版的 exa-mcp-server 都给这句提示置 `isError: true`。** npm 上 3.1.9(2026-03-06)/
   3.2.1(04-23)/ 3.4.0(08-01)/ 3.4.1(08-18)四个版本的构建产物里,`FREE_MCP_RATE_LIMIT_MESSAGE` 文本与 D
   **逐字相同**,而返回它的那一支永远是 `{content:[{type:"text",text:MSG}],isError:true}`(仅当上游 429 且无用户
   key)。⇒ D(非 `isError`)**不是这份开源代码发出来的**:`mcp.exa.ai` 托管端是另一个构建(它的 `tools/list`
   inputSchema 也与任一 npm 版不同),D 是托管端自己那一层的产物,源码拿不到。
2. **Exa 的真实零命中就是一段散文。** 同一份源码里 `web_search_exa` 对空结果返回
   `{content:[{type:"text",text:"No search results found. Please try a different query."}]}` —— 无 `isError`、
   无 `_meta`、无 `structuredContent`,四个版本一致。它与 D 的信封**逐格相同**;文本层唯一的差别是 D 里有两个
   URL、它一个都没有。(顺带:这句正是 `#489` 从我们自己代码里删掉的那句「伪成功串」—— 今天它是 vendor 自己的
   真零命中,经文本路到达模型,这是对的。)
3. **成功渲染在半年内换过一次,`_meta` 也不是一直有。** 3.1.9 的 `web_search_exa` 直出 Exa API `/context`
   端点的整段字符串(无 `Title:`/`URL:` 行、**无 `_meta`**);3.2.1 起改为逐条 `Title:/URL:/Published:/Author:/
   Highlights:` 用 `\n\n---\n\n` 拼接,并在 `content[0]._meta.searchTime` 带耗时。托管端今天是后一种。
4. **今天的活体形状(04:27Z,额度已重置)。** nokey 打 `web_search_exa`:200 `text/event-stream`,3 条
   (`Title:` 3 / `URL:` 3 / 分隔符 2,`_meta.searchTime` 910.2)。Parallel keyless:200 `application/json`,
   `isError:false` + `structuredContent` + `result._meta["parallel/usage"]`,文本是 JSON(`results[]`,13 个
   URL,**零** `Title:`/`URL:` 行)。原始 body 在 `results/live-shapes.json`。
5. **四种真实负载喂进两份生产 `parseResponse`**(`results/parsers-now.txt`):D / 零命中 / 今日 Exa / 今日
   Parallel —— 两份副本**全部判成功**。D 与零命中的信封特征向量逐格相同。

### 候选判据逐条排除(每条都带上面的实测)

| 候选 | 对 D | 对真结果 / 零命中 | 为什么不合格 |
| --- | --- | --- | --- |
| `isError` / JSON-RPC `error` / HTTP 状态 / 结构化 `{error}` | 全部缺席(这就是 D 的定义) | — | 契约信号只有这几条,`:204` / `:212` / `statusKind()` 已全部消费;D 一条都不带 |
| `structuredContent` 在场 ⇒ 成功 | 缺席 | Exa 真结果**也缺席**(无 outputSchema,3.x 全版本) | 分不开 D 与 A |
| `content[0]._meta` 缺席 ⇒ 失败 | 缺席(信封未观测,是推断) | 零命中缺席 ⇒ 误判失败;**3.1.9 的真结果无 `_meta`** ⇒ 那时会拒载全部真结果 | 押在无契约字段上,致命方向已有发行版实证 |
| 文本关键字(`rate limit` / `API key`) | 命中 | — | 本仓明令禁止;Exa 改一个字即瞎(C 臂文案已与 D 不同) |
| 文本里有 URL ⇒ 成功 | **有 2 个** | 零命中 **0 个** | 方向反了 |
| 条目形状识别(Exa `Title:`+`URL:` 行 / Parallel `results[]` JSON) | 0/0 ⇒ 判失败 ✓ | 今日 Exa 3/3 ✓;Parallel 要第二套识别器;**零命中 0/0 ⇒ 判失败 ✗**;3.1.9 渲染 0/0 ⇒ 那时拒载全部 | 手写 vendor 渲染文法;渲染半年内实换过一次;失败方向 = 本地搜网整条断掉 |
| 文本长度阈值 | 246 | 零命中 54;`numResults:1` + 小 `contextMaxCharacters` 的真结果可短于 246 | 任何拦得住 D 的阈值同时拦零命中与小真结果 |
| 文本回显我们自己的端点(`EXA_URL` 的 origin+path) | 命中(`https://mcp.exa.ai/mcp?exaApiKey=…`) | 零命中 / 今日真结果不命中;但 exa-mcp-server 的 README 里 `mcp.exa.ai/mcp` 出现 8 次 ⇒ 搜「怎么配 Exa MCP」的真结果 highlights 会命中 ⇒ 拒载 | 最接近的一条(值取自我们自己的常量、失效方向是漏不是拒),但仍是对一段文案里一个字面量的匹配,且对一族真实查询是拒载 |
| 跨查询字节相同(限流文案与查询无关) | 第二次起可辨 | 近似查询的真结果可能字节相同 | 有状态;第一次 D 照样到模型,AC1 不满足 |
| 限流响应头 | D 未观测 | A 不带,C 带 | 无从建立 |

### 为什么这是「不存在」而不是「没找到」

对只能看文本的判据,D 落在「没有可识别条目的散文」这一等价类里;同一类里还有:Exa 的真实零命中(源码
实证)、3.1.9 时代的真实结果(源码实证)、以及托管端下一次换渲染后的真实结果。任何把 D 判失败的
结构性判据都把整类判失败;类内唯一能把 D 单独挑出来的特征是**文案内容**,那就是关键字匹配。所以
「不押无契约字段 + 不匹配文案 + 拒 D + 放零命中」四条约束在结构上互斥,不是搜索不够。

### 什么条件下判据会出现

- 托管端也像开源版一样给这句置 `isError: true` —— 那 D 就变成 B 臂,`:204` 已经判得出。今天(09-24 11:35Z 起)
  托管端的限流走 429 + JSON-RPC `error`(C 臂),同样已经判得出。**D 今天是不可达的**(本轮 09-26 nokey 实抓为 A),
  它是托管端 09-24 上午那一版的产物。
- 若 owner 愿意放弃「零命中放行」并接受「渲染变更 ⇒ 本地搜网断到下一次发版」的代价,条目形状识别(表中第 6 行,
  外加一个关闸的 env 逃生口)是唯一能同时拒 D、放 A/P 的做法 —— 这是偏好裁决,本轮不替它做。
- 上一轮建议的「只记录、不判决」的信封诊断(2xx + `result` 时记 `isError` / `structuredContent` / `_meta` 键名 /
  限流头,不含正文)仍然成立:D 若再出现,它补的正是今天缺的那一格信封。

### 两条传输的判据该一致

`packages/core` 那份(`#1449`)收的是 `isError` 与非 2xx;本文结论下 `packages/opencode` 这份不新增任何判据。
两边一致 = **都只消费契约信号**(HTTP 状态 / JSON-RPC `error` / `isError` / 结构化 `{error}`),谁也不多一条文本判据。
