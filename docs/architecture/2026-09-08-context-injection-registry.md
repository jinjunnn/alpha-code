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
  `maxTokens|maxLength|byteLength|truncat|budget` 抓不到的第四处。加上 ui-mac 经 `cfg.instructions`
  的第五处(`#1296`,§8)与 ui-mac 经 `cfg.agent.*` 的第六处(`#1299`,§9),六处现在全部经**同一份**
  `context-injection.ts` 登记:**44 个片段,合计 23,458 B**(2026-09-08 实测,见快照;其中 ext 33 条
  17,122 B,ui-mac 11 条 6,336 B),每条声明自己的上限,超限在**登记时抛出**,不裁剪。
- 「唯一通路」不靠散文清单,靠一条每环都可执行的派生链(§1):上游 `Hooks` 接口 → 逐键分类 →
  真插件实现集 → 每个载上下文的钩子一个咽喉 → 每个咽喉带一个已知的坏。
- 计量单位是 **UTF-8 字节**,只此一种;字节 → token 的换算与编码器有关,仓内没有分词器,**未实测**,
  库存不打印 token 数(§4)。
- ui-mac 经 `cfg.instructions` 写进的两份 `.md` 在同一份登记簿里(`#1296`,§8):登记簿直接 import ui-mac
  那两个**零依赖**的内容模块;identity 随能力探测变长,对 `AlphaCapabilities` 的每个布尔组合跑生产
  `buildAlphaIdentity` 各登记一行(4 行,327–729 B),behavior 一行(2,757 B);ui-mac 侧的咽喉跑真
  `injectAlphaConfig`。
- ui-mac 经 `cfg.agent.<name>.{prompt,description}` 写进的三个 alpha agent 的字(`#1299`,§9)同样在同一份
  登记簿里(6 行,1,427 B):同一个方向(ext import ui-mac 的零依赖内容模块 `alpha-agents.ts`),ui-mac 侧的
  咽喉跑真 `injectAlphaConfig`,把 `cfg.agent` 下每个新写入的字符串叶子分成「登记文字」「引擎动词」「点名」三类。

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

## 2. 六处注入的实读坐标(ext 四处 + ui-mac 两处)

| 写入点 | cfg 键 / hook 输出 | 引擎消费点 | 登记项 |
| --- | --- | --- | --- |
| ui-mac [`alpha-config-injection.ts`](../../packages/ui-mac/src/main/alpha-config-injection.ts) 的 `addInstruction`(主进程写引擎配置,`#1296`) | `cfg.instructions[]`(两份落盘文件 `alpha-identity.md` / `alpha-behavior.md` 的绝对路径) | `session/instruction.ts:135-150` 按路径读盘 → `Instruction.system()` 每份加一行 `Instructions from: <path>` → `llm/request.ts:63-70` 与底座 / agent prompt 拼成同一个 system 串 | 1 条 text(behavior)+ 4 条 text(identity 每种能力形状一条) |
| ui-mac [`alpha-config-injection.ts`](../../packages/ui-mac/src/main/alpha-config-injection.ts) 的三处 `config.agent = { …(config.agent ?? {}), … }`(主进程写引擎配置,`#1299`;字住 [`alpha-agents.ts`](../../packages/ui-mac/src/main/alpha-agents.ts)) | `cfg.agent.alpha-automation\|alpha-readonly\|alpha-automation-standard.{prompt,description}`(同一对象里的 `mode` / `permission` / `hidden` 是动词与布尔,不是字) | prompt:`agent/agent.ts:277-278` → `llm/request.ts:64` **整段顶替**底座(与 ext 的 `agent.general\|explore\|docs.prompt` 同一格);description:task 工具的 subagent 清单(三个都 `hidden:true`,只影响可见列表) | 3 条 text(prompt,sink=system)+ 3 条 text(description,sink=agent-description) |
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
- 七种落点(`sink`):`system` / `agent-description` / `command-template` / `command-description` /
  `tool-description` / `tool-arg-description` / `instruction`(`#1296`:ui-mac 写进 `cfg.instructions` 的文件)。
- 上限按类给天花板,每条仍显式写自己的数:rebrand ≤ 512 B,description 类 ≤ 1 KiB,prompt / template
  正文 ≤ 8 KiB,identity 说明 ≤ 1 KiB(`CAP_IDENTITY`:按设计要小、每个会话每个模型都带;最大形状
  729 B = 71%,再加一行能力事实仍在顶内)。2026-09-08 最满的是 `tool.alpha_register.description` 776 B(76%)、
  `instruction.alpha-identity+websearch+cloudDispatch` 729 B(71%)与 `command.review.template` 4,672 B(57%)。
- 文字住哪里:大段 prose 留在各自的内容模块(`alpha-prompts.ts`、`prompt-rebrand.ts` 的 `REBRAND_RULES`,
  以及 ui-mac 的 `alpha-behavior.ts` / `alpha-identity.ts` / `alpha-agents.ts`),登记簿 import 它们并声明上限;
  短的操作性文字(工具表、被禁技能占位)住在登记簿里,`plugin.ts` / `factory-deny.ts` 从登记簿取。规则:
  **登记簿只 import 内容模块,消费者只 import 登记簿**,没有环。`REBRAND_RULES` 与登记簿的 rebrand 集合 1:1
  由测试钉住(多一条少一条都红);ui-mac 那三个内容模块必须保持**零 import / require**,也由测试钉住(§8)。

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
| REQ-063:用户经导入门放进 `<alpha-root>/instructions/*.md` 的字,ui-mac 同样推进 `cfg.instructions` | 用户的字,不是 alpha 的。ui-mac 咽喉按**文件所在目录**排除,不按 pointer 放行 —— `/instructions` 若成为登记簿的 pointer 引用,ext 那边「往 instructions 塞东西即红」的已知的坏就失效 | — |
| ui-mac 写进 `cfg.agent.<name>` 的 `mode` / `permission.**` / `hidden`,以及 `applyWebSearchDenies` 往每个 agent 钉的 `websearch: "deny"`、`injectDisabledOverrides` 写的 `disable: true` | 引擎动词(`ask\|allow\|deny`、`subagent\|primary\|all`)与布尔,不是字。ui-mac agent 咽喉把它们与字分开判:动词集合与引擎源码字面量逐字锁死,槽里出现不是动词的字符串即点名(§9) | 2026-09-08 跑真 `injectAlphaConfig`(默认 env):`cfg.agent` 下 78 个叶子 = 字 6 + `mode` 3 + `permission.**` 66 + 布尔 3;动词值只有 `primary` / `allow` / `deny` |
| 项目 `.code-puppy/plugins/*.js` 与 `alpha.jsonc` 合并进的 agent/command/mcp | 用户的字,不是 alpha 的;config 咽喉只看 hook **新写入**的叶子 | — |
| ui-mac 写进 `cfg.mcp` / `cfg.provider` / `cfg.enabled_providers` / `cfg.model` / `cfg.plugin` / `cfg.permission` / `cfg.skills` 的东西(`alpha-config-injection.ts`、`mcp-default-deny.ts`、`ext-disabled-injection.ts`、`cloud-web-search.ts`、`engine-config-truth.ts`) | server 定义 / 模型菜单 / bundle 路径 / 动词 / 目录 —— 与 ext 的四类引用同性质,不带 alpha 的字;ui-mac 侧没有像 ext 那样的全 config 咽喉(§7) | 2026-09-08 `grep` ui-mac `src/main` 非测试文件里所有 `config.<key> =` 写入点,逐个实读(`#1299` 回报) |
| skills 正文、MCP 工具表 | 别人的字;alpha 只注入路径 / server 定义(§2 引用) | — |
| `experimental.session.compacting` | 分类为 context,alpha 未实现;票面 out of scope | — |

## 7. 还开着的

- ui-mac 的咽喉是**按键**的两道(`cfg.instructions`,`#1296`;`cfg.agent.*`,`#1299`),不是像 ext 那样对
  **整个** config 的一道。ui-mac 写进别的键的东西(§6 最后一行)今天实读全是 server 定义 / 模型菜单 /
  路径 / 动词,不带 alpha 的字;但「明天有人往 `cfg.command.*` 或 `cfg.mcp.*.headers` 里写一段 alpha prose」
  在 ui-mac 侧没有测试会红。要补的是一个 ui-mac 侧的全 config 咽喉(判 `injectAlphaConfig` 新写入的每个
  字符串叶子,并把 `cfg.mcp` / `cfg.provider` / `cfg.permission` 等声明成引用)—— 另一张票的事,不在
  REQ-157 三张子票的范围里。
- 只有逐片段上限,没有总量上限;库存打印总量(23,458 B)供人看。
- [`docs/runbooks/ci.md`](../runbooks/ci.md) §2 的表仍写「十关」与 `[N/10]`(`#1281` 加第 11 步时也未更新);
  `#1295` 只加了第 [12/12] 一行,`#1296` 只改了那一行的措辞,编号未整体重排。

## 8. ui-mac instructions 通路怎么进同一份登记簿(`#1296`)

**约束**:ui-mac 对 ext 没有包依赖(只在运行时加载 `dist/plugin.js`);票面明令不造第二本登记簿。

**共享方式**:方向是 **ext → ui-mac 内容模块**,不是反过来。
[`context-injection.ts`](../../packages/ext/src/context-injection.ts) 经相对路径 import
`packages/ui-mac/src/main/alpha-behavior.ts`(一个字符串)与 `alpha-identity.ts`(两个纯函数)。
两个文件**零 import / require**,所以 ext 的自包含 bundle 把它们内联进引擎侧不会拖进 main 世界
(ADR-006 的前提;`context-injection.test.ts` ③e 钉住这一点,2026-09-08 实测 `dist/plugin.js` 833,824 B,
含 behavior 标题与 identity 首句各 1 处、`electron` 0 处)。ui-mac **生产代码不 import 登记簿**,照旧写自己的
常量;ui-mac 侧的咽喉是测试文件,它像本目录其它测试一样经相对路径 import ext。
没选的两条路:给 ui-mac 加 `@alpha-code/ext` 子路径依赖(要动 `exports` / vite `externalizeDeps` / `bun.lock`,
且 ui-mac main bundle 会内联 ext 全部提示词);把两份内容模块搬进 ext(brand-guard 坐标、`alpha-behavior.test.ts`、
ADR-015 引用全要跟着搬,冲突面大)。

**identity 的形状域**:正文是 caps 的函数,登记簿不登记「函数」,登记它**能写出的每一种形状**。
域 = `AlphaCapabilities` 的键集,写成 `Record<keyof Required<AlphaCapabilities>, true>` 的常量 ——
ui-mac 加一个能力字段而这里没扩域,ext typecheck 当场红(变异实测:加 `extraCapMutation?: boolean`
⇒ `error TS2741 … required in type 'Record<keyof AlphaCapabilities, true>'`)。每个布尔组合跑一次**生产**
`buildAlphaIdentity`,各登记一条 `text`,id 后缀列出打开的能力键(`instruction.alpha-identity+websearch+cloudDispatch`)。

**咽喉**([`instruction-injection-throat.test.ts`](../../packages/ui-mac/src/main/instruction-injection-throat.test.ts)):
跑真 `injectAlphaConfig`,取 `OPENCODE_CONFIG_CONTENT.instructions[]` 里 hook **新推进**的每个路径,读盘,
正文必须逐字等于某条 `sink=instruction` 的登记文字(`explainInstructionBody`)。用户的字按**来源**排除:
继承的 instructions 不判、REQ-063 导入目录按文件所在目录放行。8 组 env(`ALPHA_WEBSEARCH_DISABLE` ×
`OPENCODE_ENABLE_EXA` × 代付)跑出的 identity 形状集合与登记簿变体集合**双向**相等、正文逐字 ——
登记簿多一条生产写不出的形状、生产写出一条没登记的形状,都红。每个判据带已知的坏:多推一个未登记文件、
路径不存在、落盘正文多一个字节。

**变异实证**(2026-09-08,每次都还原并复绿):
- 生产多加一行 `addInstruction("alpha-extra.md", …)` ⇒ 咽喉 0 pass / 6 fail,点名 `/instructions/2`
  `body not registered`;
- `ALPHA_BEHAVIOR_MD` 撑到 8,997 B ⇒ `--check` exit 1(`"instruction.alpha-behavior" is 8997 bytes, over its
  declared limit of 8192 bytes`),ext 单测与 ui-mac 咽喉都在 import 时以 `ContextBudgetError` 整文件红。

**失败语义的代价**:ui-mac 生产路径本身不量字节;某段超限时先红的是三道门(ext 单测、快照、`[12/12]`)
与 ui-mac 咽喉,出货代码到不了那个状态 —— 与 §4 对 ext 片段的论证同形。若真到了,症状是 ext 整个装不上
(围栏、websearch 主权一起缺席),不是 ui-mac 少写一份文件。

## 9. ui-mac agent 通路怎么进同一份登记簿(`#1299`)

**通路**:[`alpha-config-injection.ts`](../../packages/ui-mac/src/main/alpha-config-injection.ts) 三处
`config.agent = { …(config.agent ?? {}), "<name>": { description, hidden, mode, prompt, permission } }`
(`alpha-automation` / `alpha-readonly` / `alpha-automation-standard`;前两者受 `ALPHA_AUTOMATION_DISABLE`,
中间那个受 `ALPHA_READONLY_DISABLE`)。prompt 在 `llm/request.ts:64` **整段顶替**底座提示词 —— 与 ext 的
`agent.general|explore|docs.prompt` 同一格,description 进 subagent 清单。2026-09-08 跑真 `injectAlphaConfig`
实测 **1,427 B**:prompt 391 / 296 / 441,description 93 / 108 / 98(把字面量抽进内容模块前后各量一次,逐字节相同)。

**共享方式**:与 §8 同一个方向。六段字从 `alpha-config-injection.ts` 的内联字面量抽进零依赖的
[`alpha-agents.ts`](../../packages/ui-mac/src/main/alpha-agents.ts)(一个 `as const` 对象 `ALPHA_AGENT_TEXT`),
生产代码只取常量、不 import ext;登记簿 import 它,按名字各登记 `agent.<name>.prompt`(sink=system,8 KiB)与
`agent.<name>.description`(sink=agent-description,1 KiB)。③e 的零依赖钉子扩到第三个文件;实测 ext bundle
`dist/plugin.js` 836,505 B(`#1296` 时 833,824 B),含 agent prompt 首句 2 处、readonly 首句 1 处、`electron` 0 处、
假针 0 处、NUL 0 个(grep 没被 NUL 弄瞎)。permission / mode / hidden 仍留在 `alpha-config-injection.ts` —— 它们不是字。

**咽喉**([`agent-injection-throat.test.ts`](../../packages/ui-mac/src/main/agent-injection-throat.test.ts),7 条):
跑真 `injectAlphaConfig`,取 `OPENCODE_CONFIG_CONTENT.agent` 下 hook **新写入或改动**的每个字符串叶子
(JSON Pointer,`/` 与 `~` 按 RFC 6901 转义 —— `permission.bash["*/rm *"]` 的 pointer 是 `…/bash/*~1rm *`),分三类:

| 叶子 | 判据 | 解释不了时 |
| --- | --- | --- |
| `/agent/<name>/prompt`、`/agent/<name>/description` | `explainAgentText(field, value)`:逐字等于登记簿**对应 sink** 的一条文字(prompt ↔ `system`,description ↔ `agent-description`);把 description 的字写进 prompt、把 instruction 文件的字写进 prompt 都不解释 | `text not registered` |
| `/agent/<name>/mode`、`/agent/<name>/permission/**` | 值 ∈ 引擎动词字面量:`["subagent", "primary", "all"]`(`packages/opencode/src/agent/agent.ts:38`)、`["ask", "allow", "deny"]`(`packages/core/src/v1/config/permission.ts:5`)。集合与引擎源码**逐字锁死**(测试读源码 `toContain` 那行字面量,并先证明少一个动词的字面量找不到)—— 引擎改了字面量而这里没跟,即红 | `not an engine verb` |
| 其它任何字符串叶子 | 一律点名 —— 不是 pointer 白名单 | `unexpected string leaf` |

用户的字不判:继承的 `OPENCODE_CONFIG_CONTENT.agent` 里没被 hook 动过的叶子不看;被生产动过的(kill-switch 下
`applyWebSearchDenies` 往每个 agent 钉的 `websearch: "deny"`)走动词那条路。双向锁:生产写出的 agent 名集合 ==
`ALPHA_AGENT_TEXT` 键集(默认 env),解释出的 id 集合 == 登记簿的六条;两个逃生门各拿掉对应 agent 后仍零无解释。
每个判据带已知的坏:多一个未登记 agent(点名 prompt 与 description 两条)、已登记 agent 多一个未登记字段、登记的
prompt 多一个字节(只点那一条,其余五段照常解释)、串格、`mode` / `permission.edit` / 嵌套 `permission.bash["*/rm *"]`
里塞字(三条一起点名)。

**没选的路**:给 ui-mac 做一道全 config 咽喉(§7 第一条)—— 要把 `cfg.mcp` / `cfg.provider` / `cfg.permission` /
`cfg.skills` / `cfg.plugin` 全部声明成引用,面比本票大一圈,且 `#1299` 票面写死「发现第四条通路就停下来报告,
不自行扩大」;按键的咽喉先把已知的三条钉死。

**变异实证**(2026-09-08,每次都还原并复绿;完整输出在 `#1299` PR 正文):
- M1:生产 `alpha-config-injection.ts` 多加一处 `config.agent = { …, "alpha-sneaky": { description, hidden, mode, prompt } }`
  ⇒ 咽喉 **1 pass / 6 fail**(跑真注入的 6 条全红;drift 锁那条不跑注入,照常绿),输出里
  `"pointer": "/agent/alpha-sneaky/prompt"` ×4、`"pointer": "/agent/alpha-sneaky/description"` ×4、
  `"reason": "text not registered"` ×8;同一时刻 `--check` 仍 rc 0(登记簿没动,库存不该红 —— 抓这条的是咽喉,
  与 `#1296` 的分工相同);`git checkout --` 还原 ⇒ 7 pass / 0 fail。
- M2:`alpha-agents.ts` 把 `alpha-readonly` 的 prompt 撑到 8,296 B ⇒ `--check` rc 1:
  `context injection "agent.alpha-readonly.prompt" is 8296 bytes, over its declared limit of 8192 bytes`;
  ext 单测 0 pass / 1 fail、ui-mac agent 咽喉 0 pass / 1 fail(均在 import 时 `ContextBudgetError`);还原 ⇒ rc 0。
