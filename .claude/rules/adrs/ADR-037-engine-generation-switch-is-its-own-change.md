---
id: ADR-037
title: 引擎代次切换是一次独立变更 —— 独立票、独立决策、独立能力清点、独立行为闸;不得夹带在功能提交里
status: accepted
date: 2026-07-28
related: [ADR-029, ADR-033, ADR-035, ADR-036]
issue: https://github.com/jinjunnn/alpha-code/issues/652
---

> 本 ADR 立的是一条**类级规矩**,不是一次路径选择。哪条链走哪代引擎由各自的 ADR 裁决
> (会话发送归 [[ADR-036]]);本 ADR 只规定**任何**代次切换必须以什么形状进入仓库。
>
> 立规的代价已实测:PR#569(`5bf362ffa`)把一次代次切换夹带进一次 UI 重构,产出「每个会话
> 只能发第一条消息」并**活了四天**,期间 2526 条测试全绿、还过了 Codex 对抗审计。逐条解剖见
> [`docs/audits/2026-07-28-652-engine-generation-split-incident.md`](../../../docs/audits/2026-07-28-652-engine-generation-split-incident.md)。

## 决策 1 —— 什么算「引擎代次切换」

一次变更属于本 ADR 管辖,当且仅当:**某条产品链路在变更后到达的引擎 API 面,与变更前不是
同一代次**。三条推论都算,一条都不豁免:

- **部分链路算。** 只改一条链路、其余不动,照样是切换 —— 而且是最危险的那种(见决策 5)。
- **单个入口算。** #652 改动的就是「会话页那一个发送入口」而已 —— 那是本 ADR 的典型对象,
  不是它的例外。
- **反向也算。** 从新代次退回旧代次同样是切换(PR#666 自身即是,它按本 ADR 的形状交付)。

本仓当前已知的代次对(不是封闭枚举,新出现的对按同一判据归入):

| 能力 | 旧代次 | 新代次 |
| --- | --- | --- |
| 会话发送 | `c.session.promptAsync`(`packages/opencode`) | `c.v2.session.prompt`(`packages/core`) |
| 引擎配置信道 | `OPENCODE_CONFIG_CONTENT` / `OPENCODE_CONFIG` | `OPENCODE_CONFIG_DIR` 目录下的 `opencode.json{,c}` |
| 工具审批事件 | `permission.asked`(`packages/schema/src/v1/permission.ts:61`) | `permission.v2.asked` |
| 消息持久化 | `message` / `part` 表 | `session_message` 表 |
| 模型目录 | v1 provider 表 | `/api/model`(`catalog.model.available()`,见 `packages/ui-mac/src/main/alpha-config-injection.ts:388-389`) |

**如何检验某个 PR:** 在 diff 的**非测试**源文件里搜代次限定符号 ——
`git diff origin/alpha...HEAD -- '*.ts' '*.tsx' ':!*test*' | grep -nE '^\+.*(\.v2\.|promptAsync|permission\.v2|session_message|OPENCODE_CONFIG)'`。
命中即按本 ADR 处理,直到作者证明该行不改变链路到达的代次。举证责任在作者一侧。
该命令已对本次事故的肇事 PR 实跑校准:
`git diff 5bf362ffa^...5bf362ffa -- '*.ts' '*.tsx' ':!*test*' | grep -cE '^\+.*(\.v2\.|promptAsync|permission\.v2|session_message|OPENCODE_CONFIG)'`
→ **11**,即这条检测在 2026-07-24 当天就会把 PR#569 拦下来。

## 决策 2 —— 独立成票、独立成 PR、独立决策

代次切换**不得**作为功能提交的附带项。四项各自独立:

1. **独立 Issue。** 一张实现票,标题主语就是切换本身,并同时点名**链路**与**两个代次**。
   它不能被一张功能票的 AC 顺带覆盖。
2. **独立 PR。** 同一个 PR 里不得同时含代次切换与非机械的功能/UI 变更。
   **检验法(可机械执行):把 diff 里属于代次切换的 hunk 全部摘掉;若剩下的部分仍是一个可以
   独立发布的功能,那它们本就该是两个 PR。** PR#569 摘掉切换后剩下 7 条 bullet 的完整 UI
   交付,判违规。
3. **独立决策。** 切换落地前(或同 PR 内)必须有一条 ADR 裁决该链路的代次归属,或显式引用
   一条已 accepted 的 ADR。理由与 [[ADR-029]] 同源:代次选择是**单向门** —— 选定的那一代
   决定了这条链能挂哪些主权钩子,回退成本不对称。
4. **独立验证。** 一份钉在该 Issue 上的验证记录落 `docs/verification/`,判据按决策 4。

**如何检验某个 PR:** 只看 PR 标题与正文即可判。**代次切换如果不是标题的主语,就是违规。**
PR#569 的标题是「AlphaComposer 直挂 + 审批/任务停靠区 + v2 durable 发送与档位协议」——
切换缩在标题末尾;正文 7 条 bullet 全部以 UI 为主语,「换引擎代次」在正文里只剩第 5 条里
「发送即排队」五个字。这是从 PR 页面上一眼可判的违规,不需要读代码。

## 决策 3 —— 切换前必须清点「新代次有没有这条链路依赖的全部能力」

这是本次事故真正缺失的那一问。切换票的正文必须包含一份**能力清点表**:列出该链路**今天**
依赖的每一项能力,逐项给出该能力在**目标代次**上的存在证据,每项**必须带 `file:line` 或
可复现命令**;凭记忆、凭「应该有」、凭 schema 里有字段,一律不算证据。

最小清点轴(以下六条每一条在 #652 里都是真实漏项,故为强制项;链路另有依赖时自行加):

| 轴 | 要回答的问题 | #652 的实际答案(切换时无人问) |
| --- | --- | --- |
| 凭证面 | 目标代次读得到同一条凭证通道吗? | **读不到**。`packages/ui-mac/src/main/alpha-config-injection.ts:413` 为 v2 逐 provider 剥掉 `apiKey`,其 `:393-395` 的前提注释「推理仍走 v1」正是被这次切换作废、却没有跟改 |
| 工具运行时 | MCP 之类的运行时在目标代次里存在吗? | **不存在**。`git grep -l "@modelcontextprotocol" -- packages/core/src` 零命中;客户端只在 `packages/opencode/src/mcp/` |
| 插件钩子挂载点 | 主权层挂的钩子在目标代次的插件面有吗? | **没有**。`git grep -n "tool.execute.before\|experimental.chat.system.transform" -- packages/core/src` 只命中一份 markdown 文档;真实 trigger 全在 `packages/opencode/src/session/{tools,prompt}.ts` 与 `agent/agent.ts:381` |
| 事件/投影面 | UI 有消费目标代次事件的 reducer 吗? | **一个都没有**。`git grep -n "session\.next\." 5bf362ffa -- packages/ui-mac/src/renderer` 全仓仅 1 命中,还是 `composer-state.ts:39` 一句「不消费该事件」的注释 |
| 持久化面 | 两代写同一张表吗?不同表之间有投影吗? | **不同表且零投影**。v1 写 `message`/`part`,v2 写 `session_message`(`packages/core/src/database/migration/20260427172553_slow_nightmare.ts:9`)。用户自己发的消息已落库却永不显示,于是失败表现为「什么都没发生」 |
| 审批/权限面 | 审批面消费的事件在目标代次上发得出来吗? | 反向同样成立:回到 v1 后 alpha 的审批 dock 消费 `permission.v2.asked`,v1 引擎发 `permission.asked` —— 已登记为已知缺口([[ADR-036]] §后果) |

**缺项的唯一合法处置是不切。**「先切过去、缺的后补」不是处置:补齐之前这条链路上的每一次
用户交互都跑在一个缺了那项能力的引擎上。若判断缺项可接受,必须在切换 ADR 里点名该缺项、
写明用户可观测的后果,并由 owner 拍板 —— 沉默不等于接受。

**如何检验某个 PR:** 票面或 PR 正文里没有这张表 = 违规;表里有一格写着「应该支持」「后续
补齐」而没有 `file:line` = 该格不成立,按缺项处理。

## 决策 4 —— 判据只认端到端可观测行为

代次切换的合并闸必须**同时**满足四条,缺一不成立:

1. **跑生产代码。** 挂载生产模块本身,不是测试里重写一遍的等价物。
2. **走用户入口。** 从用户真实按的那个入口驱动(点发送按钮),不是直接调内部函数。
3. **断言可观测结果。** 渲染出来的文本、落库的行、真正发出去的那个 HTTP 请求 ——
   而不是「函数被调用了」。
4. **自己先把它绕过一遍。** 把切换改回去,该闸必须**转红**;这一步的结论写进 PR。
   没做过反向验证的闸,不能算闸。

**以下一律不是判据**(每一条在 #652 里都曾亮过绿灯):

- typecheck 绿;
- 整包测试全绿、测试总数上升(#569 当时 `bun test src` 2526 pass / 0 fail);
- 跨模型对抗审计通过(#569 过了 Codex 第 1 轮,2 Blocker + 4 Major + 2 minor 全修);
- **源码文本断言** —— `packages/ui-mac/src/renderer/alpha-ui/takeover-adapter-coexistence.test.ts:142`
  在 `5bf362ffa` 上断的是 `expect(composer).toContain('delivery: "queue"')`,断的是源码里有没有
  那段字面量,对「这条链路根本发不出去」照常通过;
- schema / 配置里字段存在(`mcp.servers` 在 v2 有 schema、无消费者);
- HTTP 200 —— #652 的 v2 链路每次都回 200 并给出 `admittedSeq`,2 毫秒后死于 provider 401。

本仓已有承载这条规矩的机制:`scripts/gate-files.tsv` 的 `delegates_to` 列。**源码棘轮登记时
必须点名它委派的行为闸**;写 `-`(无委派)只有在该棘轮自己断的就是行为时才合法。
PR#666 即按此登记:`takeover-adapter-coexistence.test.ts` 增列委派到
`session-workspace/session-second-send.test.ts`,后者连发三条并断言渲染出来的回复。

**如何检验某个 PR:** 找到该 PR 为切换新增的那个闸,读它最后一行 `expect`。
断的若是源码字符串、调用次数、状态码或类型,判违规。

## 决策 5 —— 半代次迁移禁止

同一条用户可见流程的**所有**入口必须处在同一代次。做不到全覆盖就不要开始。

#652 的机制正是这个:首页 `use-projects.startChat`
(`packages/ui-mac/src/renderer/sidebar/use-projects.ts:320`)留在 v1、会话页 composer 切到 v2,
**同一个会话第一条 v1(能用)、第二条起 v2(必失败)**。两个入口各自都「自洽」,坏的是它们
之间的落差 —— 任何只审单侧的 review 都看不见它。

**如何检验某个 PR:** 枚举进入该流程的全部入口(本例:首页新对话、会话页 composer、时间线
续钮),逐个写出它调用的代次。出现两个不同值 = 违规。

## 后果

- ➕ 代次切换从「一次 UI 重构的第 8 个 bullet」升为一张有主语的票,坏了能定位到人和决策。
- ➕ 能力清点表把「新代次有没有这个」从一句没人问的话变成一张必须逐格填 `file:line` 的表。
- ➖ 一次「顺手把它切过去」的改动从 1 个 PR 变成 2 个 PR 加一条 ADR。这个成本是本 ADR 的
  **目的**,不是它的副作用:#652 的代价是四天不可用的主交互回路。
- 🔁 本 ADR 只管形状,不管选择。选择归各链路自己的 ADR;会话发送归 [[ADR-036]],其重新迁移
  到 v2 的三条准入判据见该 ADR §决策 3。
- 🌐 组合级的同类条款(任何仓的运行时/引擎代次替换独立成票)由
  [alpha-work `governance/delivery-standard.md`](https://github.com/jinjunnn/alpha-work/blob/main/governance/delivery-standard.md)
  承载,本 ADR 是 alpha-code 侧的落地面,不复制其正文。
