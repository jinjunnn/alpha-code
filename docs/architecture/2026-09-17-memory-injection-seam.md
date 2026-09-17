---
title: 长期记忆怎样进入对话:v1 引擎上的注入接缝勘破(alpha-code#427)
kind: architecture
status: active
owners:
  - alpha-code maintainers
last_reviewed: 2026-09-17
review_after: 2027-03-17
---

# 长期记忆怎样进入对话:v1 引擎上的注入接缝勘破(alpha-code#427)

来源:[`alpha-code#427`](https://github.com/jinjunnn/alpha-code/issues/427)(REQ-121 的先行决策票,
父需求 [`alpha-work#24`](https://github.com/jinjunnn/alpha-work/issues/24) 2026-09-17 收窄为本机版)。
裁决落在 [ADR-045](../../.claude/rules/adrs/ADR-045-memory-injection-seam.md);本文只放**地面真相**:
在 `origin/alpha` `8eb092b73`(2026-09-11)这棵树上,装着的这一版引擎给插件留了哪些能把文本送进
模型 system 段的口子、各自今天的真实行为、以及一份把前提钉在仓里的探针
([`packages/opencode/test/session/alpha-427-memory-seam-probe.test.ts`](../../packages/opencode/test/session/alpha-427-memory-seam-probe.test.ts),
登记在 `scripts/gate-files.tsv`,精确 3 条)。

## 结论

- **票面的前提是对的,但问错了引擎。** 票面与 ADR-031 §5 初稿争论的是「能不能把 Memory 注册成
  `packages/core` 的 `SystemContext.Source`」。那套 Registry / Context Epoch 只有一个消费者 ——
  `packages/core/src/session/runner/llm.ts:168-217`(v2 会话 runner)—— 而 [[ADR-036]]（2026-07-28,accepted）
  已裁定**会话发送在任何入口都只走 v1 `session.promptAsync`**,v2 迁移要等三条准入判据(MCP 运行时 /
  插件钩子挂载点 / 凭证面)齐备再由一条新 ADR 提案。所以「L0 接不进 Registry」今天不阻塞任何用户可见
  行为;为它升 L2/L3 接管 `location-services.ts` 换不来任何东西。
- **v1 上有一条稳定(非 experimental)的 L0 接缝,今天就能把一段文本按项目送进 system 段**:插件的
  `config` 钩子按**实例**(= 目录)运行,可以往本实例的 `cfg.instructions[]` 推一条绝对路径;
  `Instruction.system()` 在**每一步**(`prompt.ts:1303`)重读那份文件,以 `Instructions from: <path>\n<body>`
  的形状进入 system 段。删掉文件 ⇒ 下一步就不在(探针实测,§4)。这是 AC6/AC8「删除后立即不再进入对话」
  在引擎侧的物理基础。
- **`experimental.chat.system.transform` 仍在、仍好用**(探针 ②),但它是 experimental:NON_GOALS#4 与
  ARCHITECTURE 禁区都禁止把核心后端行为长期压在它上面。它今天承载的是 REQ-062 的品牌转写(最坏退化 =
  外观级),不该再多承载一项「记忆不进对话」这种功能级退化。ADR-045 把它登记为**退路**,不是主路。
- 六个能碰到模型上下文的钩子里,只有这两条能把**alpha 决定的文本**放进 system 段;`chat.message` 能放进
  用户回合但会**永久落进历史**(§3),与「删除后不再进入对话」正面相撞。

## 1. 哪一代引擎在服务对话(先问这个,再谈接缝)

| 事实 | 坐标 |
| --- | --- |
| 会话发送只走 v1 `session.promptAsync`;v2 durable 队列退役;迁移准入三条 | [[ADR-036]] §决策 1、3(owner 2026-07-28 拍板) |
| v2 `SystemContextRegistry` 的消费者 | `grep -rln SystemContextRegistry packages --exclude-dir=node_modules \| grep -v test` → 5 个文件,全在 `packages/core/src/`:`instruction-context.ts`、`location-services.ts`、`session/runner/llm.ts`、`system-context/{builtins,registry}.ts`。**`packages/opencode` 零命中** |
| v2 runner 把 registry 的 baseline 拼进 system 的那一行 | `packages/core/src/session/runner/llm.ts:215-217`:`system: [agent.info?.system, system.baseline]…map(SystemPart.make)` |
| 插件面对 system context 零命中(票面事实 4,2026-09-17 复核仍成立) | `grep -rn -E "systemContext\|SystemContextRegistry\|SystemContext\b" packages/plugin/src packages/sdk/js/src packages/protocol/src` → **0** |
| Registry 注册者静态编入 Layer 图(票面事实 2,仍成立) | `packages/core/src/location-services.ts:42-79` `locationServices = LayerNode.group([… SystemContextRegistry.node, SystemContextBuiltIns.node …])`;`buildLocationServiceMap(replacements)` 的语义是「替换既有节点」(`:85-95`),不是追加 |
| `packages/core` 的 `system-context` 子路径**有**导出(`package.json:22`),但导出的是 `index.ts`(`Source`/`make`/`combine`),**不含** `registry.ts` | 即便走 v2,插件也拿不到 `register` |

⇒ 今天讨论「Memory 怎么进对话」,对象是 **v1 的 system 段装配链**,不是 v2 的 Registry。

## 2. v1 system 段的装配链(逐行)

```
prompt.ts:1298   plugin.trigger("experimental.chat.messages.transform", {}, { messages })   ← 改历史,不改 system
prompt.ts:1300   [skills, env, instructions, mcpInstructions, modelMsgs] = Effect.all([
prompt.ts:1303       instruction.system()                                                  ← 每一步都调,不缓存
prompt.ts:1307   system = [...env, ...instructions, ...(mcp), ...(skills)]
request.ts:62    system = [[agent.prompt ?? SystemPrompt.provider(model), ...input.system, user.system].join("\n")]
request.ts:73    plugin.trigger("experimental.chat.system.transform", { sessionID, model }, { system })
request.ts:78    if (system.length > 2 && system[0] === header) 折回两段:header + rest.join("\n")
request.ts:109   system.map → ModelMessage{ role:"system" }                                   ← 交给 provider
```

`Instruction.system()`(`packages/opencode/src/session/instruction.ts:155-168`,路径集合来自 `systemPaths()` `:110-152`)的读法:

- `config.instructions[]` 逐条(`:135-150`):`http(s)://` 走 fetch;`~/` 展开到 home;**绝对路径** → 按 basename glob
  该目录(`:140-141`);相对模式 → `fs.globUp(pattern, ctx.directory, ctx.worktree)` 从**本实例目录**向上找
  (`:79-87`;`OPENCODE_DISABLE_PROJECT_CONFIG` 下改为从全局 config 目录找)。
- 每一条命中的文件**每次调用都 `readFileString`**(`:91-92`,`system()` 在 `:162` 逐条调它),读失败静默成空串、在 `:166` 被丢弃。
  **没有缓存**——所以「删了就不在」不需要任何失效机制,也意味着「文件不见了」引擎**不会报错**
  (这一格要 alpha 自己盯,见 ADR-045 §守卫)。
- 形状:`Instructions from: ${path}\n${body}`(`:166`)。这行前缀是上游的字,alpha 改不了;Memory 的
  正文要自己说明「这是记忆,不是指令」。

`config` 钩子怎么落到这条链上(`packages/opencode/src/plugin/index.ts`):

- 插件按**实例**装载(`:141` 的 `InstanceState.make`,键 = `ctx.directory`;`:160-176` 的 `PluginInput.directory/project/worktree`
  都是本实例的);
- 装载完毕后「Notify plugins of current config」(`:251-260`):把 `config.get()` 返回的**那个对象**递给每个
  插件的 `config` 钩子。`Config.get`(`config/config.ts:611-613`)是 `InstanceState.use(state, s => s.config)`
  —— 同一实例内返回同一引用,所以钩子的就地改写对后来的 `Instruction.system()`(它也 `cfg.get()`)可见。
  这不是推断:`packages/ext/src/plugin.ts` 的 `config` 钩子今天就在往同一个对象写 `cfg.mcp` /
  `cfg.skills.paths` / `cfg.agent.*` / `cfg.command.*`,引擎照常消费。探针 ① 又把 `cfg.instructions` 这一格
  单独证了一遍。

## 3. 插件面 21 个钩子键里,能碰到模型上下文的六条逐条判

键集从 `packages/plugin/src/index.ts` 的 `export interface Hooks` 解析(21 个,与
[`2026-09-08-context-injection-registry.md`](2026-09-08-context-injection-registry.md) §1 的分类同源)。
只列分类为 context 且**能把 alpha 决定的文本放进模型可见位置**的:

| 键 | 稳定性 | 落点 | 对 Memory 的判定 |
| --- | --- | --- | --- |
| `config` → `cfg.instructions[]` | **稳定**(公开 config 字段;`instruction.ts` 90 天 1 次上游改动,且只是 `chore: generate`) | system 段,`Instructions from: <path>` 一段一文件,**每步重读** | **主路**。按实例推路径 ⇒ 天然按项目;正文由 alpha 渲染 ⇒ 数量/长度上限、来源清单都在 alpha 手里;删文件即失效 |
| `config` → `cfg.agent.<name>.prompt` | 稳定 | **整段顶替**底座(`request.ts:64`:`agent.prompt ? [agent.prompt] : SystemPrompt.provider(model)`) | 否。它替换的是底座提示词,不是追加上下文 |
| `experimental.chat.system.transform` | **experimental**(NON_GOALS#4;签名 90 天 0 次变动,自 2026-07-03 `chore: generate` 后未动) | system 段末尾,带 `sessionID`;插件按实例 ⇒ 也天然按项目 | **退路**。能力上够(探针 ②),纪律上不许长期承载核心行为;今天已承载品牌转写并有 REQ-157 咽喉 |
| `chat.message` | 稳定 | 用户回合的 `parts[]`(`prompt.ts:1041`),**随后在同一函数里逐条落库**(`:1073` 起的 `parts.entries()` 循环) | 否。一旦落进历史就永久跟着会话走:删除记忆后旧回合仍带着它,还会被 compaction 摘要;与 AC6/AC8 正面相撞 |
| `experimental.chat.messages.transform` | experimental | 改整段历史(`prompt.ts:1298`、`compaction.ts:379`) | 否。既是 experimental,又是「改历史」而非「加上下文」 |
| `experimental.session.compacting` | experimental | compaction 提示词 | 否(与本题无关;登记簿把它列为 out of scope) |

`tool` / `tool.definition` / `command.execute.before` 也分类为 context,但它们进的是工具表 / 命令模板,
不是「随每次请求带上的记忆」,不列。

**两条被否决的 L0 变体**(都能跑,但各撞一条不变量):

- 让 `cfg.instructions` 直接指向 `~/code-puppy/Memory/<project>/*.md`(不渲染):每步会把该目录**全部**
  文件原样带进去,没有任何地方能执行 AC4 的「数量与长度有上限」—— 上游 `Instruction.system()` 不设上限,
  唯一能设上限的是**alpha 写文件的那一刻**,而 Memory 的写手不只 alpha(用户在 Finder 里、模型经
  `alpha-workspace` 技能都能写)。
- 用相对模式让引擎从工作区向上 `globUp`(例如 `.code-puppy/memory-context.md`):派生物会落进**用户的项目
  目录**,且 `OPENCODE_DISABLE_PROJECT_CONFIG` 一开就改从全局目录找。按实例推**绝对路径**没有这两条代价。

## 4. 探针实测

`packages/opencode/test/session/alpha-427-memory-seam-probe.test.ts`(alpha 自有,`north-star:alpha-owned`;
形状照上游 `test/plugin/trigger.test.ts`:真 `Config`、真 `Plugin` 装载、`file://` 插件、临时 instance;
**不 mock Config** —— mock 了就测不出「钩子改的和 Instruction 读的是不是同一个对象」)。

```
$ cd packages/opencode && bun test test/session/alpha-427-memory-seam-probe.test.ts
bun test v1.3.14 (0d9b296a)
 3 pass
 0 fail
 7 expect() calls
Ran 3 tests across 1 file. [2.72s]
```

| 条 | 断言 | 它测出什么 |
| --- | --- | --- |
| ① 稳定接缝 | 插件 `config` 钩子把 `<instance>/alpha-memory-context/project-a.md` 推进 `cfg.instructions`;`plugin.init()` 后 `Instruction.system()` 恰好 1 段含针,且以 `Instructions from: <path>\n` 开头;假针 0 命中;`rm` 文件后再调 ⇒ 0 段;写回后再调 ⇒ 又是 1 段 | 钩子与 Instruction 读同一份 cfg;每次调用重读;删即失效不需要任何失效机制 |
| ① 对照(已知的坏) | 同一份文件、插件**没有** `config` 钩子 ⇒ 0 段含针 | 接缝是钩子,不是文件名 / 目录位置;判官看得见「没接」 |
| ② 退路 | 插件实现 `experimental.chat.system.transform`,`plugin.trigger(hook, { sessionID, model }, { system:["base prompt"] })` ⇒ `["base prompt", <针>, "seen-session:ses_alpha427probe"]` | 钩子在装着的版本里仍在;input 仍带 `sessionID`(形参与 `request.ts:74` 逐字同形,上游拿掉它先在 typecheck 红);改写落地 |

上游自己的 `test/plugin/trigger.test.ts`(同一棵树、同一命令)`2 pass / 0 fail / Ran 2 tests across 1 file [3.33s]`,
与探针 ② 互为对照。

同一机制的登记闸:`bash scripts/bun-test-floor.sh "=3" packages/opencode test/session/alpha-427-memory-seam-probe.test.ts`
→ `bun exit=0 · 实际通过 3 条 · 登记精确条数 3`。全量 `packages/opencode` 测试**不在** alpha 门里
(`alpha-ci.yml:306`),所以这个文件只有登记进 `scripts/gate-files.tsv` 才真的会被跑 —— 已登记。

**没测的**(如实):探针停在 `Instruction.system()` 的返回值,没有往下走到 `request.ts` 的 join 与
provider 请求 —— 那一段是 `#425` wiring test 的对象(父需求 AC4 证据表已把它派给 `#425`);没测子代理
会话(instructions 按实例注入,子代理与主会话同实例 ⇒ 同样带上,`#425` 决定要不要按 `parentID` 去掉);
没量 token(仓内无分词器,同 REQ-157 的口径)。

## 5. 上游漂移面(`origin/dev` 2026-08-21 `e11dbd020`,回看 90 天)

```
packages/plugin/src/index.ts            1 commit  (2026-07-03 chore: generate)   ← Hooks 契约本体
packages/opencode/src/session/llm/request.ts        1 commit  (同上)              ← 钩子触发点
packages/opencode/src/session/instruction.ts        1 commit  (同上)              ← 稳定接缝的读端
packages/core/src/location-services.ts              2 commits (最近 2026-07-03)  ← v2 Layer 图
packages/core/src/system-context/registry.ts        1 commit  (同上)
packages/opencode/src/session/prompt.ts             3 commits (最近 2026-08-07)  ← 装配链所在的大文件
$ git log origin/dev -S'experimental.chat.system.transform' -- packages/plugin/src/index.ts   → 1(2026-07-03)
$ git log origin/dev -S'config.instructions'              -- packages/opencode/src/session/instruction.ts → 1(2026-07-03)
```

两条接缝在可观测窗口内都没动过。这不改变 NON_GOALS#4 的分类(experimental 是名字上的承诺,不是
历史统计),但说明「退路会不会突然消失」今天没有证据支持。

## 6. 与 REQ-157 登记簿 / 咽喉的关系

[`2026-09-08-context-injection-registry.md`](2026-09-08-context-injection-registry.md) 的两道咽喉都会碰到 Memory:

- **ext config 咽喉**:「cfg 跑完 hook 之后**新出现**的每个字符串叶子都必须由登记簿解释」,并且已经有一条
  已知的坏是「往登记簿从没声明过的 `cfg.instructions` 塞一条 ⇒ 红」。Memory 走 `cfg.instructions` 时,
  推进去的是**用户的字的路径**,不是 alpha 的字 —— 处置方式与 ui-mac 那边 REQ-063 导入目录相同:
  **按来源(目录)放行,不按 pointer 放行**,登记簿里声明这一个目录前缀。那条已知的坏必须**继续红**
  (塞一条不在该目录下的路径仍然点名)。
- **`experimental.chat.system.transform` 咽喉**:「输出逐段 == 输入 + 登记过的替换;段数变化或多一个字都
  点名」。Memory 不走这条钩子 ⇒ 咽喉一字不改。这也是选主路时的一条隐性收益:退路一旦启用,这道咽喉
  必须先学会区分「alpha 的替换」与「用户的记忆段」。

两处改动都归 `#425`(接线票),本文只登记约束。

## 7. 未覆盖面(诚实登记)

- `Instructions from: <path>` 这行前缀会把 `<alphaGlobalRoot>` 下的绝对路径暴露给模型。先例已存在
  (`alpha-identity.md` / `alpha-behavior.md` 住在 userData,路径同样进 system),不算新面。
- v2 迁移之后(ADR-036 §3 三条齐备并另立 ADR)本文 §2 整段失效,Memory 的落点应改为 `SystemContext.Source`
  (那时才重新面对 Registry 的 L0/L2/L3 问题)。ADR-045 把那一格写成 proposed。
- [[ADR-002]] 后果第 3 条「上下文注入目前只有 `experimental.chat.{system,messages}.transform`」自本文起
  **不完整**(`cfg.instructions` 是第三条,且是稳定的)。ADR-002 是受保护规则资产,本票未获授权改它,
  只在这里登记差异。
