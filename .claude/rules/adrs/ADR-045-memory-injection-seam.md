---
id: ADR-045
title: 长期记忆进入对话的接缝 —— v1 引擎上走 L0 稳定接缝(插件 config 钩子 → 本实例 cfg.instructions),不接管上游、不压 experimental 钩子;v2 SystemContext.Source 形态留作迁移后的 proposed
status: accepted
date: 2026-09-17
kind: adr
owners:
  - alpha-code maintainers
last_reviewed: 2026-09-17
review_after: 2027-03-17
related: [ADR-002, ADR-015, ADR-025, ADR-029, ADR-031, ADR-036, ADR-037, ADR-043, ADR-044, "alpha-work:REQ-121", "alpha-code:#427", "alpha-code:#424", "alpha-code:#425"]
issue: https://github.com/jinjunnn/alpha-code/issues/427
---

> **状态:accepted(owner 2026-09-17 批准;§5 仍为 proposed)。** 本 ADR 是 [[ADR-029]] §3 要求的**逐案主权 ADR**,回答
> [#427](https://github.com/jinjunnn/alpha-code/issues/427):长期记忆怎样自动进入对话,而不改上游核心代码。
> 结论是**不需要接管任何上游文件**(L0),所以它不开单向门、不放弃任何白嫖面 —— 拍板的代价是可回滚的。
> 唯一 owner 级的部分是 §5(v2 迁移后的形态),那里只写 proposed,不自行 accepted。
> 地面真相与探针输出在
> [`docs/architecture/2026-09-17-memory-injection-seam.md`](../../../docs/architecture/2026-09-17-memory-injection-seam.md)。

## 触发需求

[[ADR-031]] §5 初稿断言 Memory「作为新的 System Context source 接入现有 Registry/Context Epoch」。
2026-07-19 勘破证明该路径在现行宪法下走不了 L0(Registry 注册者静态编入
`packages/core/src/location-services.ts:42-79`,插件面对 system context 零命中),owner 同日裁决
§5 改为「接入方式待逐案裁决」并登记 #427。父需求 REQ-121 于 2026-09-17 收窄为本机版,
AC4「对话只带入当前项目范围内的记忆,数量与长度有上限,并可见本次用了哪几条」与 AC6/AC8
「删除后立即不再进入对话」仍在,接线票 #425 被 #427 阻塞。

## 勘探证据(§3 要件一:先跑,再写)

**1. 票面争论的 Registry 不在今天的对话路径上。** [[ADR-036]]（accepted）裁定会话发送在任何入口
都只走 v1 `session.promptAsync`;v2 `SystemContextRegistry` 的全部消费者在 `packages/core/src/`
(5 个文件),`packages/opencode` 零命中;把它的 baseline 拼进 system 的唯一一行是
`packages/core/src/session/runner/llm.ts:215-217`,属于不服务对话的 v2 runner。
⇒ 「L0 接不进 Registry」今天不阻塞任何用户可见行为;为它把 `location-services.ts` 升 L2/L3,
换不来一个字进模型。

**2. v1 上存在一条稳定的 L0 接缝。** 插件 `config` 钩子按实例运行
(`packages/opencode/src/plugin/index.ts:141`、`:251-260`,递进去的是 `Config.get` 返回的同一引用,
`config/config.ts:611-613`);往本实例 `cfg.instructions[]` 推一条绝对路径,`Instruction.system()`
(`session/instruction.ts:155-168`)在**每一步**(`session/prompt.ts:1303`)重读那份文件,以
`Instructions from: <path>\n<body>` 进入 system 段(`prompt.ts:1307` → `llm/request.ts:62-109`)。
`instructions` 是公开 config 字段,不是 experimental。

**3. 探针实测**(`packages/opencode/test/session/alpha-427-memory-seam-probe.test.ts`,真 Config、真
插件装载、不 mock):

```
bun test test/session/alpha-427-memory-seam-probe.test.ts
 3 pass / 0 fail / 7 expect() calls · Ran 3 tests across 1 file. [2.72s]
```

① 钩子推的文件恰好 1 段进 `system()`,`rm` 后再调 ⇒ 0 段,写回 ⇒ 1 段(每次调用重读,删即失效);
① 对照:没有钩子 ⇒ 同一文件 0 段(判官看得见「没接」);② `experimental.chat.system.transform`
仍在、仍接 `{ sessionID, model }`、`output.system` 改写落地。

**4. 上游漂移面。** `origin/dev`(2026-08-21)回看 90 天:`plugin/src/index.ts`、`llm/request.ts`、
`session/instruction.ts` 各 1 次提交(同一条 `chore: generate`),两条接缝的签名 0 次变动。

## 决策

### 1. 级别:L0(接缝叠加),不接管任何上游文件

Memory 进入对话的接缝 = **插件 `config` 钩子(稳定)→ 本实例 `cfg.instructions[]` → 一份由 alpha
渲染的、按项目一份的记忆上下文文件**。三方分工:

| 谁 | 做什么 | 落点 |
| --- | --- | --- |
| ui-mac main(Memory 文件的管理面,#424/#425) | 从 `~/code-puppy/Memory/*.md`(真源)按项目选条目、按数量/字节上限渲染成**一份**文件;记忆被增删改(桌面或外部编辑,#424 的 watcher)时**同步**重渲;把「这份文件里有哪几条」作为「本次带入」展示给用户 | `<alphaGlobalRoot>/memory-context/<projectKey>.md` |
| `packages/ext` config 钩子 | 按 `input.directory` 算 `projectKey`(与 ui-mac 同一个纯函数),把上面那条**绝对路径**推进本实例 `cfg.instructions[]`;文件不存在时不推(引擎对缺文件静默,`instruction.ts:92`) | `packages/ext/src/plugin.ts` config 钩子 |
| 引擎(上游,一字不改) | 每一步重读该文件进 system 段 | `instruction.ts:155-168` / `prompt.ts:1303` |

为什么是这一条而不是别的 L0 口子(详表见勘破文档 §3):

- `experimental.chat.system.transform` 能力上够(探针 ②),但 NON_GOALS#4 与 ARCHITECTURE 禁区禁止
  把核心后端行为长期压在 `experimental.*` 上;它今天承载的品牌转写最坏退化是外观级([[ADR-015]]),
  Memory 走它的最坏退化是**记忆静默不进对话**,不是同一档。
- `chat.message` 是稳定的,但注进用户回合的 part 会**永久落进历史**(`prompt.ts:1041` 触发后同函数落库):
  删除记忆后旧回合仍带着它、还会被 compaction 摘要 —— 与 AC6/AC8 正面相撞。
- 让 `cfg.instructions` 直接指向 Memory 目录(不渲染):上游 `Instruction.system()` 不设上限,AC4 的
  「数量与长度有上限」没有任何执行点(Memory 的写手不只 alpha)。
- 相对模式 `globUp` 进用户项目目录:派生物落进用户仓,且 `OPENCODE_DISABLE_PROJECT_CONFIG` 一开就换根。

### 2. 语义(替换 ADR-031 §5 初稿的「沿用 System Context 的 baseline/update/removal」)

v1 上**没有** epoch:每一步重读、当前集合即事实,没有「自上一轮以来的增量」,也没有引擎侧的持久审计。
因此:

- 「本次用了哪几条」的权威是 **alpha 自己渲染时的记录**(ui-mac 知道它写进文件的每一条),不是引擎。
- 「删除后立即不再进入」= 文件重渲后的**下一步**起不在;渲染必须在删除路径上**同步**完成,不能异步
  —— 否则「删了」和「不进对话了」之间有一段 alpha 自己制造的窗口。
- Memory 段正文自带一行说明它是**上下文不是指令**(ADR-031 §5b);上游那行 `Instructions from:` 前缀
  改不了,只能在正文里压过它。
- `cfg.instructions` 按实例注入 ⇒ 同实例的子代理会话也带上;是否按 `parentID` 去掉,归 #425。

### 3. 守卫 / tripwire(§3 要件三)

| 层 | 判据 | 已到位? |
| --- | --- | --- |
| 前提 | `alpha-427-memory-seam-probe.test.ts` 登记进 `scripts/gate-files.tsv`(精确 3 条):接缝 ① 消失、每步重读语义变了、退路 ② 签名变了,任一条先红 | 本 ADR 同 PR |
| 登记簿(REQ-157) | ext config 咽喉:「往登记簿从没声明过的 `cfg.instructions` 塞一条 ⇒ 红」这条已知的坏**必须继续红**;Memory 的路径按**目录前缀**(`<alphaGlobalRoot>/memory-context/`)声明为引用,不按 pointer 放行 —— 与 ui-mac 对 REQ-063 导入目录的判法同形 | 归 #425 |
| 端到端 | 从真实会话入口(`session.promptAsync`)断言:当前项目的记忆被有界带入 `request.ts` 的 system、展示所用条目、删除后下一步不再带入、提示注入样本未经确认不成为记忆 —— 父需求 AC4/AC6/AC8 的证据面 | 归 #425(票面 exit condition 已写) |
| 缺文件 | 引擎对缺文件**静默**(`instruction.ts:92` 吞错)。ui-mac 在会话发送前核对本项目的上下文文件在位且与真源一致;不在位 ⇒ 响亮(用户可见),不是安静地不带记忆 | 归 #425 |

### 4. 回退(§3 要件四)

- **产品级**:Memory 文件是真源,管理面(查看/修改/删除)不依赖注入;接缝失效只影响「自动带入」。
- **接缝级**:若上游改掉 `cfg.instructions` 的读法(探针 ① 先红),退路是把同一份渲染文件的正文经
  `experimental.chat.system.transform` 推进 `output.system[]`(探针 ② 钉着它还在)—— 那是一次
  **标注风险的过渡**(NON_GOALS#4 原文允许的用法),必须同时给 REQ-157 那道「输出逐段 == 输入 + 登记
  替换」的咽喉加一个「用户记忆段」的来源类,并在 DECISIONS 登记风险与再退路。
- **一键关**:`ALPHA_MEMORY_INJECT_DISABLE=1` 让 ext 不推路径(与 `ALPHA_PROMPT_REBRAND_DISABLE` 同形),
  归 #425 实现。

### 5. v2 迁移后的形态(proposed;owner 级,本 ADR 不裁决)

[[ADR-036]] §3 三条准入齐备、并按 [[ADR-037]] 以独立 ADR 切换会话发送到 v2 之后,本 ADR §1 的接缝
随 v1 一起退场,Memory 应成为一个 `SystemContext.Source`(`packages/core/src/system-context/index.ts`
的 `Source<A>`:`key / codec / load / baseline / update / removed`),这时才真正面对 Registry 的接入问题:

| 路 | 形态 | 代价 |
| --- | --- | --- |
| 上游接缝(优先) | 给上游提 PR:让 `PluginContext`(`@opencode-ai/plugin/v2/effect`)拿到 `SystemContextRegistry.register`,或让 `buildLocationServiceMap` 接受「追加节点」 | 零接管;取决于上游 |
| L2 补丁 | 构建期往 `location-services.ts:42-79` 的 `LayerNode.group([...])` 机械插入一个 alpha 节点,失效 loud-fail | 每次上游动那张表都要修补丁 |
| L3 冻结 | `location-services.ts` 退出同步集 | 单向门,放弃该文件白嫖 —— 上游每加一个服务都得手工搬 |

无论哪条,§5b 的约束不变:Memory source 的 `load` **不得**返回 `unavailable`(任一 source unavailable ⇒
`InitializationBlocked`,新会话开不起来),读不到就返回空集。**在 v2 切换的 ADR 落笔之前,这一节
不产生任何动作。**

## 对 #424 方案段的输入(本 ADR 只提要求,不替它裁决)

- **条目身份**:稳定、与文件名解耦的 id(文件被改名/移动后仍是同一条),外加 revision/digest 供冲突检测;
  id 要能出现在渲染文件的每条记忆头上,让「本次用了哪几条」能回指到真源。
- **项目归属**:`projectKey` 必须是 ui-mac 与 ext **各自从目录算出来的同一个值**(纯函数、零依赖模块,
  与 REQ-157 §8 的共享方式同形);归属信息住在条目的元数据里,不靠目录层级(用户可以自由摆放文件)。
  未标归属的条目默认**不**带入任何项目(fail-closed),不是「带进所有项目」。
- **删除语义**:删真源文件 = 该条立即不再进入渲染文件;渲染是**同步**副作用;外部删除由 watcher 触发同一条
  重渲路径。不做 tombstone(本机版没有云端召回要阻断)。
- **不进渲染文件的**:任何来源为网页/连接器/工具/compaction 且未经用户确认的候选(AC5/AC8),以及
  Secret/OAuth/API key(ADR-031 §4)。

## 被否决的方案

- **L2/L3 接管 `packages/opencode/src/session/llm/request.ts` 或 `prompt.ts`,给 Memory 一个一等槽位**:
  v1 在 `request.ts:74` 已经把同一位置以钩子形式开出来了,接管只是把「experimental」改成「我们的」,
  代价是一个 90 天内被上游动过的大文件从此单向门。
- **今天就为 Registry 接管 `location-services.ts`**:v2 不服务对话(ADR-036),接管后没有任何一条链路
  会消费那个 source。
- **让 Memory 走 `experimental.chat.system.transform` 作主路**:见决策 1;它是退路。
- **让 Memory 成为 skill**:skill 是模型按需加载的,不是随每次请求带上的上下文,与 AC4 的「自动带入」不符。

## 后果

- ✅ 零改上游、零 experimental 依赖、零单向门;#425 可以开工,接线面收敛到 ext 一个钩子 + ui-mac 一个
  渲染器。
- ✅ 「删除后立即不再进入对话」不需要发明失效机制 —— 引擎每步重读是上游既有语义,探针钉着它。
- ⚠️ 渲染文件是一份**派生物**(ADR-031 §1 允许):它与真源之间的一致性由 ui-mac 的同步重渲保证,
  AC3 的 watcher 是同一条路;渲染没跟上的窗口里模型看到的是旧集合。
- ⚠️ `Instructions from: <path>` 前缀由上游决定,记忆段只能在正文里声明自己是上下文;路径会把
  `<alphaGlobalRoot>` 暴露给模型(先例:`alpha-identity.md` / `alpha-behavior.md`)。
- ⚠️ 引擎对缺文件静默;响亮由 ui-mac 补(决策 3)。
- 🔭 [[ADR-002]] 后果第 3 条「上下文注入目前只有 `experimental.chat.{system,messages}.transform`」自本 ADR
  起不完整(`cfg.instructions` 是稳定的第三条);ADR-002 是受保护规则资产,已于 2026-09-17 经 owner 授权订正。
- 🔭 v2 迁移时本 ADR §1–4 随 v1 退场,§5 升格为那时的逐案 ADR。
