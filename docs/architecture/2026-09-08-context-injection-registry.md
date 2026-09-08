---
title: Alpha 注入模型上下文的登记簿与咽喉(REQ-157)
kind: architecture
status: active
owners:
  - alpha-code maintainers
last_reviewed: 2026-09-08
review_after: 2027-03-08
---

# Alpha 注入模型上下文的登记簿与咽喉(REQ-157)

来源:[`alpha-code#1284`](https://github.com/jinjunnn/alpha-code/issues/1284)。判据本体:
[`packages/ext/src/context-injection.ts`](../../packages/ext/src/context-injection.ts) 与
[`packages/ext/src/context-injection.test.ts`](../../packages/ext/src/context-injection.test.ts);
库存快照:[`packages/ext/src/context-injection-inventory.snapshot.txt`](../../packages/ext/src/context-injection-inventory.snapshot.txt)。

## 结论

- `packages/ext` 往模型上下文送 alpha 自己写的字,通路有**四处**,不是票面实读时说的三处 ——
  `factory-deny.ts` 的占位 command(description + 含技能名的 template)是 grep
  `maxTokens|maxLength|byteLength|truncat|budget` 抓不到的第四处。四处现在全部经
  `context-injection.ts` 登记:**33 个片段,合计 17,122 B**(2026-09-08 实测,见快照),每条
  声明自己的上限,超限在**登记时抛出**,不裁剪。
- 「唯一通路」不靠散文清单,靠一条每环都可执行的派生链(§1):上游 `Hooks` 接口 → 逐键分类 →
  真插件实现集 → 每个载上下文的钩子一个咽喉 → 每个咽喉带一个已知的坏。
- 计量单位是 **UTF-8 字节**,只此一种;字节 → token 的换算与编码器有关,仓内没有分词器,**未实测**,
  库存不打印 token 数(§4)。
- 边界外还有一条 alpha 自己的注入:ui-mac 经 `cfg.instructions` 写进的两份 `.md`(§6),不在本登记簿里。

## 1. 通路枚举:单一权威与派生链

插件能碰引擎的**全部**方式是 [`packages/plugin/src/index.ts`](../../packages/plugin/src/index.ts)
的 `export interface Hooks`(21 个键)。登记簿的 `HOOK_CONTEXT_CLASS` 给每个键分类;测试从源码解析
接口键集与分类键集比对(上游新增钩子、这边没分类 ⇒ 红),再取真 `AlphaExt` 返回的钩子对象,要求
「实现了 ∧ 分类为 context」的集合逐字等于本文件设了咽喉的集合。

| Hooks 键 | 分类 | alpha 实现? | 咽喉 |
| --- | --- | --- | --- |
| `config` | context | 是 | cfg 跑完 hook 之后**新出现**的每个字符串叶子都必须由登记簿解释(逐字等于登记文字 / 模板渲染实例 / 声明过的引用前缀);用户 cfg 里已有的字不算 |
| `experimental.chat.system.transform` | context | 是 | 输出逐段 == 输入 + 登记过的替换;段数变化或多一个字都点名;14 份上游底座 `.txt` 全部过 |
| `tool` | context | 是 | 每个工具的 description 与每个参数的 describe() 都是登记项;登记项也不许多出实际没有的工具 |
| `tool.execute.after` | context | 是 | 非云工具的结果原样回去,alpha 不加字(`validateCloudToolOutput` 只校验,不改写) |
| `chat.message` / `command.execute.before` / `experimental.chat.messages.transform` / `experimental.session.compacting` / `experimental.text.complete` / `tool.definition` | context | 否 | alpha 哪天实现其中任何一个,§1 第二条断言当场红,直到写出对应咽喉 |
| `chat.params` | no-context | 是 | 温度 / `maxOutputTokens` / provider options —— 参数,不是内容(REQ-153/156 的输出上限住这里,与本票无关) |
| `tool.execute.before` | no-context | 是 | 改的是模型 → 工具方向的 args;模型看到的调用已经发出 |
| 其余 10 个(`dispose` `event` `auth` `provider` `chat.headers` `permission.ask` `shell.env` `experimental.provider.small_model` `experimental.compaction.autocontinue`) | no-context | 部分 | 不载内容 |

每个咽喉在同一测试文件里都先用一个**已知的坏**证明判官看得见:绕过登记簿写 `cfg.agent.rogue.prompt`、
往登记簿从没声明过的 `cfg.instructions` 塞一条(证明判官不是 pointer 白名单)、把登记文字改一个字节、
往 system 多推一段、多接几个字、多一个未登记的工具、改一个 description、登记簿多一条陈旧项。

## 2. 四处注入的实读坐标

| 写入点 | cfg 键 / hook 输出 | 引擎消费点 | 登记项 |
| --- | --- | --- | --- |
| [`alpha-prompts.ts`](../../packages/ext/src/alpha-prompts.ts) `applyPromptTakeover` | `cfg.command.init|review.{template,description}`、`cfg.agent.general|explore|docs.prompt`、`cfg.agent.docs.description` | `command/index.ts:98`(template 成为用户回合);`agent/agent.ts:277-278` → `llm/request.ts:64`(agent prompt **整段顶替**底座);task 工具的 subagent 清单读 description | 8 条 text |
| [`prompt-rebrand.ts`](../../packages/ext/src/prompt-rebrand.ts) `rebrandSystem`,经 `plugin.ts` 的 `experimental.chat.system.transform` | `output.system[]` 子串替换 | `llm/request.ts:62-70`(底座 + environment + instructions 已 join 成一串再触发本钩子) | 12 条 rebrand(量 `to`,`from` 是上游原文不计) |
| [`factory-deny.ts`](../../packages/ext/src/factory-deny.ts) `applyFactoryDeny` | `cfg.command[<被禁技能>].{description,template}` | 同 command | 1 条 text + 1 条 template(`{name}` 单占位符) |
| [`plugin.ts`](../../packages/ext/src/plugin.ts) 四个 `tool()` | `hooks.tool.*.description` + 每个参数的 `describe()` | `tool/registry.ts:161`(逐字进每次请求的工具表) | 11 条 text |

四处之外,config hook 还写四类**引用**:`cfg.shell`(REQ-138 wrapper 路径)、`cfg.skills.paths`(出厂技能
目录 + skill generation live 目录)、`cfg.permission.skill.*`(REQ-067 的 `"deny"` 动词)、`cfg.mcp.*`(云 MCP
server 定义,main 经 env 交来)。它们让引擎去别处装东西,装进来的内容是用户 / 出厂技能 / 远端 server 的,
预算归上游;但它们必须在登记簿里**声明**,否则 config 咽喉会把它们当成解释不了的叶子拦下。

## 3. 登记簿的形状

- 四种条目:`text`(定长文字)、`template`(恰好一个 `{name}` 占位符,上限约束渲染结果)、`rebrand`
  (from/to,只量 to)、`reference`(JSON Pointer 前缀,无 alpha 文字,不计入字节)。
- 六种落点(`sink`):`system` / `agent-description` / `command-template` / `command-description` /
  `tool-description` / `tool-arg-description`。
- 上限按类给天花板,每条仍显式写自己的数:rebrand ≤ 512 B,description 类 ≤ 1 KiB,prompt / template
  正文 ≤ 8 KiB。2026-09-08 最大的是 `command.review.template` 4,672 B(57%)与
  `tool.alpha_register.description` 776 B(76%)。
- 文字住哪里:大段 prose 留在各自的内容模块(`alpha-prompts.ts`、`prompt-rebrand.ts` 的 `REBRAND_RULES`),
  登记簿 import 它们并声明上限;短的操作性文字(工具表、被禁技能占位)住在登记簿里,`plugin.ts` /
  `factory-deny.ts` 从登记簿取。规则:**登记簿只 import 内容模块,消费者只 import 登记簿**,没有环。
  `REBRAND_RULES` 与登记簿的 rebrand 集合 1:1 由测试钉住(多一条少一条都红)。

## 4. 上限与失败语义

- `defineText / defineTemplate / defineRebrand` 在模块装载时量字节,超过 `maxBytes` 抛 `ContextBudgetError`
  (消息含 id / 实测 / 上限)。`plugin.ts` import 登记簿 ⇒ 超限片段让整个 ext 装不上;上游
  `packages/opencode/src/plugin/index.ts:237` 记 `failed to load plugin` 后继续。这是响亮的,但也意味着
  沙箱围栏、websearch 主权闸一起缺席 —— 所以这个状态在出货代码里**到不了**:ext 单测(AC2 边界用例 +
  「每条都在上限内」)、库存快照测试、alpha-check 第 [12/12] 步三道门都先红。
- 模板的渲染结果超限在 `renderTemplate` 处抛,落在 config hook 里 ⇒ `plugin.ts` 外层 `catch` loud 记录、
  `merged=false`、MCP 归属倒向 `UNVERIFIED`(fail-closed),不裁剪。
- 单位:UTF-8 字节(`TextEncoder().encode(s).byteLength`),测试钉了 64/65 边界与「中中」= 6 B ≠ 2 字符。
  不引入分词器;字节 → token 因编码器与语言而异,**未实测**,不写换算数字。

## 5. 库存(AC3)

`bun packages/ext/scripts/context-injection-inventory.ts --check` 打印全部片段(id / kind / sink / 实测字节 /
上限 / 利用率)、总量、引用清单、载上下文的钩子清单,并与仓内快照逐字节比对;不一致 exit 1 并打逐行 diff。
alpha-check 第 [12/12] 步跑它(本地专属,不进 `CI_STEPS`;判据在 CI 由 `bun test (ext)` 的快照测试承担)。
改了任何片段或上限 ⇒ `--write` 重生快照 ⇒ 评审在 PR diff 里看到哪一段变了多少字节 —— 票面要杀的
「事后没人分得清是哪一次加的」就靠这条棘轮。

## 6. 明确不在登记簿里的

| 通路 | 为什么不在 | 实测 |
| --- | --- | --- |
| ui-mac `alpha-config-injection.ts:108-131` 写 `alpha-identity.md` / `alpha-behavior.md` 进 `cfg.instructions` | 另一个包、另一条通路;票面边界是 `packages/ext/src`,且 ui-mac 对 ext **没有包依赖**(只在运行时加载 dist bundle) | `ALPHA_BEHAVIOR_MD` 2,757 B;identity 327 B(默认)至 729 B(能力全开) |
| 项目 `.code-puppy/plugins/*.js` 与 `alpha.jsonc` 合并进的 agent/command/mcp | 用户的字,不是 alpha 的;config 咽喉只看 hook **新写入**的叶子 | — |
| skills 正文、MCP 工具表 | 别人的字;alpha 只注入路径 / server 定义(§2 引用) | — |
| `experimental.session.compacting` | 分类为 context,alpha 未实现;票面 out of scope | — |

## 7. 还开着的

- 产品级的「唯一通路」目前只对 `packages/ext` 成立:§6 第一行是 alpha 自己的字、经另一条通路到达
  同一个 system 段。要不要把它也纳入(ui-mac 需要新增对 ext 的依赖,或把登记簿抽到两者都能 import 的
  位置),是另一张票的事。
- 只有逐片段上限,没有总量上限;库存打印总量(17,122 B)供人看。
- [`docs/runbooks/ci.md`](../runbooks/ci.md) §2 的表仍写「十关」与 `[N/10]`(`#1281` 加第 11 步时也未更新);
  本次只加了第 [12/12] 一行,编号未整体重排。
