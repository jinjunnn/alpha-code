# Exa 条目形状 × fail-open —— 认得出才说一句,认不出一律放行(2026-09-27)

`alpha-code#1445` 的第三轮勘破。前两轮(见 [`2026-09-24-exa-mcp-failure-signal-recon.md`](2026-09-24-exa-mcp-failure-signal-recon.md))
的结论是:对「限流提示被伪装成搜索结果」那一种响应(下称 **D**),不存在一条**拒它而放行真结果与真零命中**的结构性判据。
那两轮留下一条未裁的候选 —— **条目形状**(Exa 渲染的 `Title:` / `URL:` 行、Parallel 渲染的 `results[]` JSON),
并把它当成 **fail-closed** 闸(认不出 ⇒ 判失败)递给 owner 做偏好裁决,理由是「拒它必然拒真零命中,托管端换渲染即本地搜网整条断掉」。

本轮把前提换成 **fail-open**(认不出 ⇒ 放行,只是不声称「已确认是搜索结果」),重新回答四问。**只产结论,不落闸,不改任何生产代码。**

## 一句话结论

命题**成立且自洽**;四格**可分**(D / Z 放行不声称,今日 Exa / Parallel 各声称);渲染在 21 个月 49 个发行版里只换过
**两次**,上一版那句「无底洞」**是错的**。但它对**模型这条通道是惰性的** —— 放行分支交给模型的字节与今天逐字相同,
D 到模型面的结果不变;它有意义的消费者只剩 UI 与日志。而在传输文件里它就是一条对响应正文的匹配,与在途 AC3 的源码普查闸
正面冲突。**推荐:不做。** 若 owner 想要渲染漂移的可观测性,本文末尾写了唯一值得的形状与其 AC。

## 怎么量的

三条手段,全部离线,**不打 Exa 端点、不耗免费额度**。证据与复现在
[`../verification/2026-09-27-1445-exa-entry-shape-fail-open/`](../verification/2026-09-27-1445-exa-entry-shape-fail-open/README.md)。

| 手段 | 输入 | 回答 |
| --- | --- | --- |
| `entry-shape.py`(离线) | 仓里四种真实负载:D(`ticket-payload.json`,`#1433` 走生产传输实抓)/ Z(vendor 源码逐字的零命中)/ A(09-26 `live-shapes.json` 的 Exa 原始 SSE)/ P(同文件 Parallel 原始 JSON) | Q2 四格 + 六条变异臂 |
| `probe-entry-shape.ts`(生产路径) | 同四种负载,**先经两份生产 `parseResponse`**(`packages/opencode/src/tool/mcp-websearch.ts:226`、`packages/core/src/tool/websearch.ts`)取出模型会看到的文本,再跑同一命题 | Q2 的生产路径对照;两份解析器取出的文本给出相同结论 |
| `vendor-all-versions.py` + `vendor-websearch-window.py` | npm 上 `exa-mcp-server` **全部 49 个**发行版的 tarball(2024-12-17 `0.1.0` → 2026-08-18 `3.4.1`),整包聚合一遍、再精确到 `web_search` 处理函数的 9000 字窗口一遍 | Q3 渲染变更的版本 / 日期 / 时长 |

先证明手段能测出已知的坏:变异臂里「A 去掉 `Title:` 行」「A 去掉 `URL:` 行」「A 的标签不在行首」「P 的 `results` 置空」
「P 的 `results` 不是数组」五条必须翻成「不声称」,「D 前面包一对 `Title:/URL:` 行」必须翻成「声称」—— 六条全部符合
(`results/entry-shape-offline.txt`)。第一次跑时「标签不在行首」那条没翻,是变异本身漏了第一行(`replace("\nTitle: ")` 碰不到
偏移 0 的那一行),不是识别器的问题;改成按行首正则变异后翻了。

## Q1 —— fail-open 的形式化,以及它在哪条通道上是空话

### 命题

记 **T** 为生产 `parseResponse` 交给叶子的文本 —— 它是模型能看到的**唯一**通道:

- legacy 叶子 `packages/opencode/src/tool/websearch.ts:186` 返回 `output: result`,`title` / `metadata`(`:187-188`)只进 part 状态与 UI;
  `packages/opencode/src/session/message-v2.ts:299` 把 `part.state.output` 送进模型消息,别的字段不送;
- V2 叶子 `packages/core/src/tool/websearch.ts:407` `toModelOutput: ({ output }) => [{ type: "text", text: output.text }]`,同样只有文本。

定义两个**只看结构、不看任何词义**的识别器:

- **E(T)** = 「第 i 行以 `Title: ` 开头、且第 i+1 行以 `URL: ` 开头」的行对数;
- **J(T)** = T 是一个 JSON 对象且顶层 `results` 是数组时,该数组的长度;否则 ⊥。

**claim(T)** = E ≥ 1 ? `{kind: exa-entries, n: E}` : (J ≥ 1 ? `{kind: json-results, n: J}` : ∅)。

行为:**任何分支都原样放行 T**,不改写、不拒绝;claim ≠ ∅ 时把它附在旁路(工具 `metadata` → UI;或 AC2 的信封记录)上,
claim = ∅ 时**什么都不附**。这就是「当且仅当看到 X 才可以声称这是搜索结果;其余一律放行且不声称」的可执行写法。

### 它自洽吗

作为**传输命题**,自洽:没有任何输入被拒,所以「渲染变更 ⇒ 本地搜网整条断掉」这个代价**结构上不存在**;渲染变了只会让
claim 退回 ∅,即少说一句话。E 与 J 两个识别器互不依赖,任一个失效不影响另一个。

但要把「下游只要放行就必然当成结果用」这句话检查到底,答案是**对模型这条通道,是的**:

1. 模型只看 T;两个分支的 T **逐字节相同**。所以对模型而言,「放行且不声称」≡ 今天的行为。D 今天怎么到模型面,fail-open 之后
   还是怎么到 —— **本票要修的那个用户可观察结果,在这条通道上一个字都不会变**。
2. 要让模型对「∅」有反应,只有一条路:把「缺席的含义」写进工具描述(例如「输出前没有条目计数时,把正文当供应商说明而不是
   搜索结果」)。这不是 fail-open,这是**把 fail-closed 搬进了提示词**:Z(真零命中)与任何未识别的渲染(见 Q3 第二代)都会被
   模型按「不可信」处理 —— 前一版反对 fail-closed 的那两条代价原样回来,只是从「拒载」软化成「模型自行打折」,且打不打折
   由模型的策略层决定,本仓已实测那一层同句同模型 1 从 1 拒(`governance/local-verification-traps.md`《用真模型驱动安全类取证》)。

所以 Q1 的答案分两半:**命题成立**;**它的价值不在模型面**。剩下能区分「声称 / 不声称」的消费者只有两个 —— UI(`metadata`)
与日志(AC2 的信封记录)。Q4 只在这两个消费者上定价。

## Q2 —— 四格(离线版与生产路径版结论逐格相同)

| 负载 | 文本长度 | E(T) | J(T) | claim | 判定 |
| --- | --- | --- | --- | --- | --- |
| **D** 票面限流提示(`#1433` 实抓,246 字) | 246 | 0 | ⊥ | ∅ | **放行,不声称** —— 对 |
| **Z** Exa 真零命中(vendor 源码逐字) | 54 | 0 | ⊥ | ∅ | 放行,不声称 —— **对,不是误判**(fail-open 下零命中本来就不该被声称) |
| **A** 今日 Exa 真结果(09-26 原始 SSE) | 5310 | **3** | ⊥ | `{exa-entries, 3}` | 声称 —— 对(3 条 `Title:`+`URL:` 行对,分隔符 `\n\n---\n\n` × 2,标签集 `Author / Highlights / Published / Title / URL`) |
| **P** 今日 Parallel 真结果(09-26 原始 JSON) | 19341 | 0 | **10** | `{json-results, 10}` | 声称 —— 对(`results[]` 10 项;上一版记的「13 个 URL」是正文里的 URL 计数,不是条目数) |

**D 与 A 可分,D 与 Z 不可分** —— 后者正是 fail-open 接受的那一格。生产路径版(`results/probe-entry-shape.txt`)里
`packages/opencode` 与 `packages/core` 两份 `parseResponse` 对四种负载都判成功、取出的文本长度逐格相同(246 / 54 / 5310 / 19341),
对四格给出的 claim 逐格相同。

失败方向只有一个:**漏**。若托管端哪天把限流提示包成一对 `Title:/URL:` 行(变异臂第六条),它会被声称 —— 这是 fail-open 的
既定代价,与 fail-closed 的「拒真结果」不是一个量级。

## Q3 —— 渲染变更的真实频率:49 版、三代、两次

上一版只比了 `3.1.9` 与 `3.2.1`,据此写「半年内换过一次」并推出「无底洞」。这次把 npm 上**全部 49 个**发行版拉下来,
精确到 `web_search` 处理函数的窗口判(`results/vendor-websearch-window.txt`;整包聚合版在 `results/vendor-all-versions.txt`,
两者对三代的边界逐版一致):

| 代 | 成功渲染 | 首版(日期) | 末版(日期) | 版本数 | 持续 | fail-open 下 |
| --- | --- | --- | --- | --- | --- | --- |
| 1 | `text: JSON.stringify(response.data, null, 2)` —— Exa `/search` 的整个响应对象,先检查 `response.data.results` 非空 | `0.1.0`(2024-12-17) | `3.0.7`(2025-10-23) | 33 | **324 天** | **J 认得出**(顶层 `results[]`) |
| 2 | `text: response.data.context` —— `/context` 端点整段字符串,无任何行结构 | `3.0.8`(2025-11-06) | `3.1.9`(2026-03-06) | 12 | **141 天** | E、J 都认不出 ⇒ 放行、不声称 |
| 3 | 逐条 `Title: / URL: / Published: / Author: / (Highlights: \| Text:)`,以 `\n\n---\n\n` 拼接,`content[0]._meta.searchTime` | `3.2.0`(2026-03-27) | `3.4.1`(2026-08-18,`latest`) | 4 | **184 天,仍在** | **E 认得出** |

顺带钉住的几个首现:零命中文案 `No search results found. Please try a different query.` 自 `0.2.0`(2025-03-19)起三代不变、始终无
`isError`;限流提示自 `3.1.8`(2026-02-09)起出现且**从第一版就带 `isError: true`**;`_meta.searchTime` 自 `3.2.0` 起;工具名
`search`(0.1–0.2)→ `web_search`(0.3.0–0.3.6)→ `web_search_exa`(0.3.7 起)。

**订正**:「半年内换过一次」是对的(那一次在 `3.2.0`,2026-03-27),但由它推出的「无底洞」不成立 —— 全史 609 天里换了两次,
平均间隔约 232 天;当前这一代已稳定 184 天、4 个发行版,而且**它就是托管端今天的渲染**(A 的标签集、分隔符、`_meta.searchTime`
与第三代模板逐项对上)。在 fail-open 下,每一次渲染变更的代价上限是「Exa 那一路从此不再被声称,直到有人更新识别器」,**不是**停机。

**这份历史是代理量,不是本体**:`mcp.exa.ai` 不是 npm 包 —— 前两轮已证 D 不是任何一个 npm 版本发出的(四版都给限流提示置
`isError`),它的 `tools/list` inputSchema 也与任一 npm 版不同。托管端自己的发版史无从拉取;npm 史是能拿到的最好代理,
且今天两者的成功渲染逐项一致。

## Q4 —— 拿这份信息做什么才值得

Q1 已经把模型面排除;三个候选只在 UI 与日志两个消费者上定价。

### ① 喂给 AC2 的信封记录,作为另一个结构字段

在途的 `feat/1445-no-silent-degrade` 给两份传输各加了 `envelopeShape(tool, status, headers, body)` → `Effect.logInfo("websearch envelope", …)`,
字段是状态码 / JSON-RPC 类型 / `isError` / `structuredContent` / `content[0]._meta` 键名 / `result._meta` 键名 / 文本长度 / 四个限流头,
**不含正文**。往里加一格 `textShape: { exaEntries, jsonResults }` 是十几行纯函数,只记录不判决,关掉开关输出逐字节不变。

它换来的是:①D 若再现,记录里多一格 `exaEntries: 0`(但 `textLength: 246` 已经是 D 的指纹,这一格不增加分辨力);
②**渲染漂移可观测** —— 托管端换到新一代时,所有真结果的 `exaEntries` 会同时归 0 而 `textLength` 仍大,这是今天没有的信号。

代价不在行数,在**它与 AC3 的普查闸正面冲突**。在途分支的 AC3 判据原文:「两份传输文件里唯一的正则字面量是 `detailOf` 的 `/\s+/g`,
零 `includes/indexOf/match/search/test`,`startsWith` 只认 `"{"` 与 `"data: "`;普查自检往源码里塞一行
`text.includes("rate limit")` 必须抓到」。E 的实现是 `startsWith("Title: ")` / `startsWith("URL: ")`,J 是 `JSON.parse` + `Array.isArray(obj.results)`
—— **按那张普查网的字面,它就是被禁的形态**。派发书里「判行结构与判词义是两件事,但边界很容易糊」说的正是这里:普查闸是源码级
grep,它分不出「行首标签」与「文案关键字」,要放行 E 就得给闸开一个按函数名的白名单,而白名单本身就是那条边界开始糊的地方。
把识别器挪出传输文件(放进叶子)能绕开普查网的**字面**,绕不开它的**意图**。

### ② 用户面加一句「这次的返回不像搜索结果」

叶子的 `metadata: { provider }` 多带一个 `entries?: number`,UI 在缺席时显示一句提示。它会在 D 上亮(对),在 Z 上亮(是真话但多余:
正文已经写着没有结果),在托管端下一次换渲染后对**每一条真结果**都亮(误报,直到识别器更新)。用户读的是模型的回答,不是工具卡片;
而在途 AC1 的表已经实测 D 到模型面的是 vendor 自己那句限流原文,模型不会说「我查了没查到」。这一句提示的边际价值很小,
且识别器无论住在传输还是叶子,都带着 ①同样的 AC3 张力。

### ③ 什么都不做

今天的地面真相:托管端的限流走 429 + JSON-RPC `error`(09-24 43/43),两份传输都响亮;D 的历史观测 = 1 次(09-24 06:39Z),
43 次 429 窗口 0 次,09-26 实抓 0 次;在途 AC2 的信封记录会在它再现时留下结构字段。条目形状信息今天**不会改变任何一个决定**:
它不改模型面(Q1),不改判决(fail-open),只在日志里多一格,而那一格的两个用途 —— D 指纹已有、渲染漂移今天没发生。

### 推荐:③

理由按重要性排:
1. **在唯一会被骗的通道上它是空话**(Q1)。#1445 的伤害在模型面,fail-open 的条目形状在那里一个字节都不改。
2. **它与 AC3 的普查闸互斥**,而那道闸是为了防下一轮绕回文案匹配立的。为一格日志给闸开口子,是拿一个真闸换一个今天用不上的信号。
3. 渲染确实不常变(Q3),但「不常变」是它**可以做**的理由,不是**值得做**的理由。

### 若 owner 仍要 ①,AC 该长这样

只在 AC2 的信封记录已被证明有人在读之后再开票;开票时 AC 写成:

- **AC-a** `envelopeShape` 多一格 `textShape: { exaEntries: number, jsonResults: number | "absent" }`,由一个具名纯函数 `entryShape(text)` 算出;
  D → `{0, "absent"}`,Z → `{0, "absent"}`,A → `{3, "absent"}`,P → `{0, 10}`;`call()` / `callMcp()` 里没有分支读它;开关关闭时模型面输出逐字节不变。
- **AC-b** AC3 的源码普查改为**按函数名白名单**:只放行 `entryShape` 内的 `"Title: "` / `"URL: "` 两个 `startsWith` 字面量与 `Array.isArray(*.results)`;
  自检仍须抓到任何其它对正文的 `includes/indexOf/match/search/test`,变异「往 `entryShape` 里加 `includes("rate limit")`」必须红。
- **AC-c** 变异臂进闸:A 去掉 `Title:` 行 ⇒ `exaEntries: 0` 且输出不变;P 的 `results: []` ⇒ `jsonResults: 0` 且输出不变;D 前包一对 `Title:/URL:` ⇒ `exaEntries: 1` 且输出不变(漏是既定代价,记录下来即可)。

## 主动没做的、没测到的

- **没改任何 `.ts` 生产代码**,没动 kill-switch / 出网围栏 / 参数形状;本轮产物只有本文与证据目录。
- **没打 Exa 端点**(免费额度前几轮跑满过一次);Q2 的四种负载全部取自仓内实抓件,Q3 只访问 registry.npmjs.org。
- **托管端 `mcp.exa.ai` 的发版史无法测量**,Q3 是 npm 代理量(上文已标)。
- **没做模型行为实验**:「只在认出时给模型加一行正向前缀,看它在缺席时会不会更谨慎」是一个可想的第四候选,但它的判据落在模型策略层,
  本仓已实测那一层不可复现(同句同模型 1 从 1 拒),本轮不为它开臂。
- **没碰重写后的 AC1/AC2/AC3**,那归 `feat/1445-no-silent-degrade` 那条 lane;本文引用它的判据原文只为给 ① 定价。
