# 运行权限档位的地面真相(`alpha-code#1413` 勘破)

被测树:`alpha` @ `f56748c4f`(2026-09-23)。本文只记**跑出来的**事实与读出来的坐标,
不含方案取舍。票面自陈「零勘破」并列了动手前三问,三问原文与逐条回答在 §1。

> 纪律:全称命题一律实跑。本文每一条「实测」都给得出复跑命令;探针源码在 §7,
> 原始输出在 §6,自证(正样本 / 反样本 / 变异臂)在 §5.3。

## 1. 票面三问的原样回答

> **1. 今天到底有几档、叫什么、在哪定义**:权限模型在引擎侧是 `"ask" | "allow" | "deny"` 三值
> (`packages/sdk/js/src/gen/types.gen.ts` 里 `webfetch` / `bash` 等逐工具都是这三值),
> 而 UI 上只暴露了两档 —— **先确认这是 UI 没暴露 `allow`,还是引擎侧真的少一档**。
> 这两种的修法完全不同;

**答:两种都不是。**引擎侧三值齐全(`packages/core/src/v1/config/permission.ts:5`),
UI 只暴露两档(`alpha-composer.tsx:292-309`)—— 但**缺的那一档不是 `allow`**:
引擎默认档 `build` 的规则集**已经**对 `edit` / `bash` 求值为 `allow`
(`agent/agent.ts:119-152`,实测 §5.1),而 composer 的「请求审批」档**恰好就是不带 agent
发出去、落到 `build` 上**(`composer-state.ts:303-323`)。
所以今天真实的两档是 **「默认全放行(标着『请求审批 · 逐次询问』)」+「只读」**,
而不是「请求审批 + 只读」。**「完全访问」这一档在行为上已经是默认档,缺的是诚实的标签**;
要补的那档若定义成「所有工具 allow」,发出的请求会与今天的「请求审批」**逐字节相同** ——
正是 REQ-126 退休掉的那个假档的形态(`composer-state.ts:23-27`)。

> **2. 「完全访问」应该等于什么**:是「所有工具一律 allow」,还是「除了某几类仍要问」?
> 这是产品决策,要 owner 拍 —— 别自己定义完再实现;

**答:本轮不定义**(按票面,这是 owner 的决定)。但勘破给它补了两条地面事实,
少了这两条这个决策会做在假前提上:

- 今天默认档**仍然会问**的只有三类(实测 §5.1 / §5.2):`external_directory`(工作区之外的路径)、
  `doom_loop`、`read` 命中 `*.env` / `*.env.*`;外加文档轴对**非 builtin** 工具(第三方 MCP /
  插件 / Alpha Cloud)的默认 `ask`(`packages/schema/src/alpha-tool-policy.ts:157-159`)。
- 因此「完全访问 = 所有工具一律 allow」相对今天的默认档,**净增量只有上面这几类**;
  若定义成「除某几类仍要问」,则与今天的默认档**可能一格差别都没有**。

> **3. 和 alpha 主权判决的关系**:有些拒绝是**最终闸**,permission 覆盖不了
> (`ALPHA_LOCAL_WEBSEARCH_DENY` 就是这样:工具 `execute` 首行直接拒,
> agent wildcard / session permission / approved 三条都顶不掉,
> 见 `packages/ui-mac/src/main/cloud-web-search.ts` 的头注)。
> ⇒ **「完全访问」不能承诺它覆盖这些** —— 否则就是对用户说假话。

**答:票面这一条属实,坐标已核。**`packages/opencode/src/tool/websearch.ts:132-152` 的
`execute` 首行 `if (localWebSearchDenied()) return yield* Effect.die(...)`,该分支**不查任何
ruleset**;头注(`packages/ui-mac/src/main/cloud-web-search.ts:33-39`)逐条列出被它顶掉的三条路。
云侧同形闸在 `packages/ext/src/cloud-websearch-kill.ts`(`tool.execute.before` 钩子,
在 `ctx.ask` 之前)。

本轮**额外**确认的一件与三问同源、但票面没写的:`websearch.ts:132-137` 的注释本身就写着
「agent 的 `"*": "allow"`」是**已知**会顶掉 deny 的路径之一 —— 也就是说
「默认档是全放行」这件事**仓内早就写下来了**,只是没人把它和 composer 那个「逐次询问」标签对上。

## 2. 今天有几档、标识符、默认值、定义点、消费点

### 2.1 composer 运行权限(用户看得见的那个 chip)

| | 标识符 | 定义 | 默认 | 提交时发生什么 |
|---|---|---|---|---|
| 请求审批 / Ask for approval | `"ask"` | `composer-state.ts:28` | **是**(`composer-state.ts:53`、`:190`) | 请求**不带** `agent` 字段 ⇒ 落到引擎默认 agent |
| 只读 / Read-only | `"readonly"` | 同上 | 否 | `agent = "alpha-readonly"`,**压过**手选档位(`composer-state.ts:320`) |

- 类型是**两值联合**:`export type PermMode = "ask" | "readonly"`(`composer-state.ts:28`)。
- 档位**不落盘**:模块级 signal(`composer-state.ts:53`)+ 按会话身份键登记的内存 Map
  (`composer-state.ts:170`,`rememberScopedPerm` / `adoptComposerPermScope` / `seedComposerPermScope`,
  `composer-state.ts:176-205`)。重启即回默认。
- 文案:`alpha.composer.permAsk` = 「请求审批」/「逐次询问」(`i18n/zh.ts:1197-1198`、
  `i18n/en.ts:1229-1230`);`permReadonly` = 「只读」/「不能改文件/执行命令」(`zh.ts:1199-1200`)。
- 菜单只有两个 `menuitemradio`:`alpha-composer.tsx:292-300`(ask)与 `:301-309`(readonly)。

### 2.2 引擎侧的档位真源

- 三值 `Action = "ask" | "allow" | "deny"`:`packages/core/src/v1/config/permission.ts:5`。
- 规则求值 `evaluate`:`packages/opencode/src/permission/index.ts:105-115` —— `findLast` 命中,
  **无规则命中时兜底 `ask`**。
- agent 规则集:`packages/opencode/src/agent/agent.ts:119-136` 的 `defaults` 是
  **`"*": "allow"`** + `doom_loop: ask` + `external_directory: {"*": ask, <白名单>: allow}` +
  `question/plan_enter/plan_exit: deny` + `read: {"*": allow, "*.env": ask, "*.env.*": ask}`;
  `build` = `defaults` + `question/plan_enter: allow` + 用户 `cfg.permission`(`:141-155`)。
- 默认 agent 的选法:`agent/agent.ts:328-340` —— 无 `cfg.default_agent` 时取第一个
  非 subagent、非 hidden 的 primary ⇒ **`build`**(三个 alpha 注入 agent 都是 `hidden: true`)。
- alpha 注入的三个 agent:`packages/ui-mac/src/main/alpha-config-injection.ts`
  —— `alpha-automation`(`:176-198`)、`alpha-readonly`(`:205-228`)、
  `alpha-automation-standard`(`:233-…`)。**注入面不写任何顶层 `permission` 键**
  (实测:`INJECTED_TOP_LEVEL_PERMISSION null`,§6)。
- 执行时真正生效的规则集 = `Permission.merge(agent.permission, session.permission ?? [])`
  (`packages/opencode/src/session/tools.ts:111` 与 `:157`)—— **session 规则排在 agent 之后,
  `findLast` 下压过 agent**。
- 第二条正交轴(REQ-131 文档轴):`AlphaToolPolicy.resolve`
  (`packages/opencode/src/permission/alpha-tool-policy.ts:114-171`),四类默认
  **builtin = enabled,其余 = ask**(`packages/schema/src/alpha-tool-policy.ts:132-159`);
  合成入口 `gateToolExecution`(`permission/alpha-tool-policy-gate.ts:162-190`):
  `deny` ⇒ 具名拒绝;`ask` ⇒ 往本次 ruleset 末尾**追加**一条 exact-canonical 的 ask;
  `enabled` ⇒ **什么都不加**,交回 ruleset 轴裁决。

## 3. 每一档实际拦住了什么(实测,不是文档说的)

两个口径都测了:①`Permission.evaluate` 对该 agent 规则集的裁决;
②`Permission.disabled`(`permission/index.ts:369-388`)—— 它决定**哪些工具根本不进模型的工具表**
(`edit`/`write`/`apply_patch` 三个工具共用 `edit` 这一把权限键,`:373`+`:381`)。

| agent(档位) | `edit` | `bash` | `external_directory` | `read *.env` | 从工具表里**消失**的内置工具 |
|---|---|---|---|---|---|
| `build`(= composer「请求审批」) | **allow** | **allow** | ask | ask | `plan_exit` |
| `plan`(计划模式) | deny | allow | ask | ask | (无) |
| `alpha-readonly`(= composer「只读」) | deny | deny | deny | deny | `apply_patch` `bash` `edit` `plan_exit` `question` `write` |
| `alpha-automation-standard`(自动化可写档,UI 不可选) | allow | allow(`rm *` 等模式 deny) | deny | deny | `plan_exit` `question` `task` |
| `alpha-automation`(自动化只读档,UI 不可选) | deny | deny | deny | deny | `apply_patch` `bash` `edit` `plan_exit` `question` `task` `write` |

运行时口径(真 `Permission.Service.ask`,§5.2):

```
ASK build bash "rm -rf node_modules && bun install" -> PASSED-THROUGH (no prompt)
ASK build edit "src/index.ts"                       -> PASSED-THROUGH (no prompt)
ASK build external_directory "/Users/nobody/Downloads/x"
      -> PermissionRejectedError: 审批请求等待 0 秒无人应答,已按 fail-closed 结束…   ← 正样本
ASK alpha-readonly bash "ls" -> PermissionDeniedError: …                              ← 反样本
```

**结论:出厂默认下,「请求审批」这一档对改文件与跑命令不弹审批。**
标签(「逐次询问」/「Ask each time」)与行为不符。

三条必须一起说的边界,否则上面这句会被过度解读:

1. 上表是**出厂默认**(用户 `cfg.permission` 为空、Settings→工具 无记录、无 session 规则)。
   用户在 `alpha.jsonc` / `opencode.jsonc` 写了 `permission`,或在 Settings→工具
   (`settings.tsx:738` → `settings-tools.tsx`)把某个工具设成「每次询问」,就会问。
2. **非 builtin 的工具默认就问**:第三方 MCP / 插件 / Alpha Cloud 三类的文档轴默认是 `ask`
   (`schema/alpha-tool-policy.ts:157-159`;已有生产断言
   `packages/opencode/test/permission/alpha-tool-policy.test.ts:83-86`)。
3. 今天默认档**仍然会问**的三类:`external_directory`(工作区之外)、`doom_loop`、`read` 命中
   `*.env`。用户实际看到的审批弹窗,今天多半来自这几类而不是 `bash`/`edit`。

顺带一条与代码注释矛盾的实测:`alpha-config-injection.ts:201-203` 的注释写
「交互场景有人在场 → question/task 允许」,而 `alpha-readonly` 实测
`question = deny`、`question` 工具**不在工具表里** —— 因为 `agent.ts:126` 的 `defaults`
本来就是 `question: "deny"`,而注入的 agent 配置没有覆盖它。`task` 确实是 `allow`。
**注释的一半是错的**,不是行为坏了(建议随本票或另开小票订正注释,不要照注释设计)。

## 4. 加第三档会经过哪些判定点(哪些是非此即彼的二元结构)

`composerPerm` 的全部消费点(两条检索轴:标识符 `composerPerm` / `PermMode`,已交叉):

| 坐标 | 结构 | 加第三值会怎样 |
|---|---|---|
| `composer-state.ts:320` `if (input.perm === "readonly") … else if (input.agent) …` | **二元** | 第三档落进 `else` ⇒ 与 `ask` 产出**逐字节相同**的请求。**这正是 REQ-126 退休的那个假档的形态**(`composer-state.ts:23-27`) |
| `composer-state.ts:176-182` `if (value === "ask") delete else set` | 二元(判「是不是默认」) | 第三档会被登记(语义上对),但「默认」概念仍钉死在 `"ask"` |
| `composer-state.ts:190` `?? "ask"` / `:53` 初值 | 单点默认 | 新会话默认档若要改成「完全访问」,改这两处;**注意它同时改掉今天所有用户的开局行为** |
| `alpha-composer.tsx:260` `mode === "ask" ? permAsk : permReadonly` | **二元三目** | 第三档会被**标成「只读」** |
| `alpha-composer.tsx:281-285` `<Switch fallback={<ShieldAsk/>}><Match when={=== "readonly"}>` | **二元 fallback** | 第三档拿到「请求审批」的盾牌图标 |
| `alpha-composer.tsx:292-309` 两个 `menuitemradio` | 列表 | 加一项即可 |
| `alpha-composer.tsx:325-330` PlanChip `data-disabled` / title 按 `=== "readonly"` | 二元 | 第三档下计划 chip 保持可用(大概率是想要的,但**是默认落下来的,不是选出来的**) |
| `alpha-composer.tsx:1644` Shift+Tab:`if (composerPerm() !== "readonly") 切 plan` | 二元 | 第三档下可切 plan;但若第三档也要压过 agent,这里会与 `:320` 打架 |
| `composer-autocomplete.tsx:277` `readonly: composerPerm() === "readonly"` | 二元 | 第三档按「非只读」处理 |
| `alpha-composer.css:209-211` 只有 `[data-mode="readonly"]` 有配色 | 二元 | 第三档无专属视觉 |

引擎侧可承载第三档的**已存在**接缝(都不是新能力,坐标已核):

- **换 agent**:与只读档同形 —— 注入一个 `permission` 全 allow 的 hidden agent,提交时带上。
  现成同类:`alpha-automation-standard`(`alpha-config-injection.ts:233-…`,`edit: allow`),
  但它同时 deny 了 `question`/`task`/`doom_loop`/`external_directory`,**不是**「完全访问」。
- **session 规则集**:`PATCH /session/{id}` 的 `UpdatePayload.permission`
  (`server/routes/instance/httpapi/groups/session.ts:49-58`)→ `Session.setPermission`
  → 在 `session/tools.ts:111` 被 merge 在 agent **之后**(压得过 agent)。**会持久化**。
- **逐条消息的 `tools` 映射**:`session/prompt.ts:1102-1109` 把 `PromptInput.tools` 的
  `true/false` 编成 `allow`/`deny` 并**写进 session permission**(此后一直有效,
  不是「只这一条消息」)。

**没有一处需要改结构才放得下第三个枚举值** —— 真正的结构性问题是反过来的:
`:320` 那个二元分支会让第三档**什么都不做**,而 UI 上它看起来生效了。

## 5. 怎么测的

### 5.1 规则集与工具表(探针 A)

真 `injectAlphaConfig`(生产注入) → 真 `Agent.Service` → 真 `Permission.evaluate` /
`Permission.disabled`。零 mock;`ALPHA_GLOBAL_DIR` / `XDG_*` 全部钉进临时目录,
不读宿主机真实配置。

### 5.2 运行时是否真的弹审批(探针 B)

真 `Permission.Service.ask`(与 `session/tools.ts` 给工具的那条 `ctx.ask` 是同一个服务、
同一个方法),`ALPHA_PERMISSION_ASK_TIMEOUT_MS=300` 让「真的在等人批」在 300 ms 内
以具名失败落地,而不是挂住。

### 5.3 自证(先证明手段测得出已知的坏)

- **正样本**:`build` + `external_directory`「/Users/nobody/Downloads/x」⇒
  `PermissionRejectedError`(真的问了、没人答、fail-closed)。若探针连这一格都读成
  “PASSED-THROUGH”,整轮作废。
- **反样本**:`alpha-readonly` + `bash` ⇒ `PermissionDeniedError`,错误体里带出真实 ruleset。
- **既有生产断言对齐**:`packages/opencode/test/agent/agent.test.ts:61-68` 早已断言
  `build` 的 `edit`/`bash` 都是 `allow` —— 本勘破与它一致,不是新发现的孤证。
- **变异臂**(证明探针读的是**真注入**而不是常量):把
  `alpha-config-injection.ts:222` 的 `edit: "deny"` 临时改成 `"allow"` 再跑,
  `alpha-readonly` 那一行当场从
  `["apply_patch","bash","edit","plan_exit","question","write"]` 变成
  `["bash","plan_exit","question"]`;跑完已还原(`git status` 干净)。

### 5.4 复跑

```bash
bash scripts/worktree-bootstrap.sh 1413-probe --detach
# 把 §7 的两份探针写进 .worktrees/1413-probe/packages/opencode/test/agent/
cd .worktrees/1413-probe/packages/opencode
bun test test/agent/alpha-1413-probe.test.ts test/agent/alpha-1413-ask-probe.test.ts
```

(`bun test` 必须在 `packages/opencode` 里跑;仓根的 `bunfig` 把根测试根指向
`do-not-run-tests-from-root`。)

## 6. 原始输出(2026-09-23,`f56748c4f`)

```
INJECT_RESULT {"ok":true}
INJECTED_AGENTS ["alpha-automation","alpha-readonly","alpha-automation-standard"]
INJECTED_TOP_LEVEL_PERMISSION null
AGENT_NAMES ["build","alpha-automation","alpha-automation-standard","alpha-readonly","compaction","explore","general","plan","summary","title"]
ROW build {"read":"allow","edit":"allow","write":"allow","glob":"allow","grep":"allow","list":"allow","bash":"allow","task":"allow","external_directory":"ask","todowrite":"allow","question":"allow","webfetch":"allow","websearch":"allow","lsp":"allow","doom_loop":"ask","skill":"allow","patch":"allow","apply_patch":"allow","some_unknown_tool_xyz":"allow"}
SPOT build read:.env=ask
SPOT build bash:rm -rf /=allow
SPOT build ext_dir:/tmp/x=ask
HIDDEN build ["plan_exit"]
ROW plan {"read":"allow","edit":"deny","write":"allow","glob":"allow","grep":"allow","list":"allow","bash":"allow","task":"allow","external_directory":"ask","todowrite":"allow","question":"allow","webfetch":"allow","websearch":"allow","lsp":"allow","doom_loop":"ask","skill":"allow","patch":"allow","apply_patch":"allow","some_unknown_tool_xyz":"allow"}
HIDDEN plan []
ROW alpha-readonly {"read":"allow","edit":"deny","write":"allow","glob":"allow","grep":"allow","list":"allow","bash":"deny","task":"allow","external_directory":"deny","todowrite":"allow","question":"deny","webfetch":"allow","websearch":"allow","lsp":"allow","doom_loop":"ask","skill":"allow","patch":"allow","apply_patch":"allow","some_unknown_tool_xyz":"allow"}
SPOT alpha-readonly read:.env=deny
SPOT alpha-readonly bash:rm -rf /=deny
SPOT alpha-readonly ext_dir:/tmp/x=deny
HIDDEN alpha-readonly ["apply_patch","bash","edit","plan_exit","question","write"]
ROW alpha-automation-standard {"read":"allow","edit":"allow","write":"allow","glob":"allow","grep":"allow","list":"allow","bash":"allow","task":"deny","external_directory":"deny","todowrite":"allow","question":"deny","webfetch":"allow","websearch":"allow","lsp":"allow","doom_loop":"deny","skill":"allow","patch":"allow","apply_patch":"allow","some_unknown_tool_xyz":"allow"}
HIDDEN alpha-automation-standard ["plan_exit","question","task"]
ROW alpha-automation {"read":"allow","edit":"deny","write":"allow","glob":"allow","grep":"allow","list":"allow","bash":"deny","task":"deny","external_directory":"deny","todowrite":"allow","question":"deny","webfetch":"allow","websearch":"allow","lsp":"allow","doom_loop":"deny","skill":"allow","patch":"allow","apply_patch":"allow","some_unknown_tool_xyz":"allow"}
HIDDEN alpha-automation ["apply_patch","bash","edit","plan_exit","question","task","write"]
ALL_BUILTIN_TOOL_IDS ["apply_patch","edit","glob","grep","lsp","plan_exit","question","read","bash","skill","task","todowrite","webfetch","websearch","write"]

ASK build bash "rm -rf node_modules && bun install" -> PASSED-THROUGH (no prompt)
ASK build edit "src/index.ts" -> PASSED-THROUGH (no prompt)
ASK build external_directory "/Users/nobody/Downloads/x" -> PermissionRejectedError: 审批请求等待 0 秒无人应答,已按 fail-closed 结束:本次操作**没有**被放行。
ASK alpha-readonly bash "ls" -> PermissionDeniedError: The user has specified a rule which prevents you from using this specific tool call. Here are some of the relevant rules [{"permission":"*","action":"allow","pattern":"*"},{"permission":"bash","action":"deny","pattern":"*"}]

2 pass / 0 fail
```

`ROW` = `Permission.evaluate(<key>, "*", agent.permission).action`;
`HIDDEN` = `Permission.disabled(<全部内置工具 id>, agent.permission)`;
`ALL_BUILTIN_TOOL_IDS` 取自各工具模块导出的 `.id`(生产值,非手写清单)。

## 7. 探针源码

两份探针**刻意不进 `main`**:它们是勘破仪器,不是闸门(闸门该长什么样由本票的实现轮决定)。
原样贴在这里以便复跑。落点:`packages/opencode/test/agent/`。

<details><summary>探针 A:<code>alpha-1413-probe.test.ts</code></summary>

```ts
// 勘破探针(ac#1413)—— 不进 main。跑真 injectAlphaConfig + 真 Agent 服务,
// 打印每个 agent 对每条 permission 的**实际**裁决。
import { afterEach, expect, beforeAll } from "bun:test"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { Effect } from "effect"
import * as fs from "node:fs"
import * as os from "node:os"
import * as path from "node:path"
import { disposeAllInstances } from "../fixture/fixture"
import { testEffect } from "../lib/effect"
import { Agent } from "../../src/agent/agent"
import { Auth } from "../../src/auth"
import { Config } from "../../src/config/config"
import { RuntimeFlags } from "../../src/effect/runtime-flags"
import { Permission } from "../../src/permission"
import { Plugin } from "../../src/plugin"
import { Provider } from "../../src/provider/provider"
import { Skill } from "../../src/skill"
import { injectAlphaConfig } from "../../../ui-mac/src/main/alpha-config-injection"
import { ApplyPatchTool } from "../../src/tool/apply_patch"
import { EditTool } from "../../src/tool/edit"
import { GlobTool } from "../../src/tool/glob"
import { GrepTool } from "../../src/tool/grep"
import { LspTool } from "../../src/tool/lsp"
import { PlanExitTool } from "../../src/tool/plan"
import { QuestionTool } from "../../src/tool/question"
import { ReadTool } from "../../src/tool/read"
import { ShellTool } from "../../src/tool/shell"
import { SkillTool } from "../../src/tool/skill"
import { TaskTool } from "../../src/tool/task"
import { TodoWriteTool } from "../../src/tool/todo"
import { WebFetchTool } from "../../src/tool/webfetch"
import { WebSearchTool } from "../../src/tool/websearch"
import { WriteTool } from "../../src/tool/write"

const BUILTIN_TOOL_IDS = [
  ApplyPatchTool, EditTool, GlobTool, GrepTool, LspTool, PlanExitTool, QuestionTool,
  ReadTool, ShellTool, SkillTool, TaskTool, TodoWriteTool, WebFetchTool, WebSearchTool, WriteTool,
].map((t) => t.id)

const agentLayer = (flags: Partial<RuntimeFlags.Info> = {}) =>
  LayerNode.compile(
    LayerNode.group([Agent.node, Plugin.node, Provider.node, Auth.node, Config.node, Skill.node, RuntimeFlags.node]),
    [[RuntimeFlags.node, RuntimeFlags.layer(flags)]],
  )

const it = testEffect(agentLayer())

function load<A>(fn: (svc: Agent.Interface) => Effect.Effect<A>) {
  return Agent.Service.use(fn)
}

beforeAll(() => {
  const tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "alpha-1413-")))
  process.env.ALPHA_GLOBAL_DIR = path.join(tmp, "alpha-code-state", "env", "dev")
  fs.mkdirSync(process.env.ALPHA_GLOBAL_DIR, { recursive: true })
  process.env.XDG_CONFIG_HOME = path.join(tmp, "xdg")
  process.env.ALPHA_OPENCODE_HOME = path.join(tmp, "opencode-home")
  process.env.XDG_DATA_HOME = path.join(tmp, "xdg-data")
  for (const d of [process.env.XDG_CONFIG_HOME, process.env.ALPHA_OPENCODE_HOME, process.env.XDG_DATA_HOME])
    fs.mkdirSync(d, { recursive: true })
  const userData = path.join(tmp, "userdata")
  fs.mkdirSync(userData, { recursive: true })
  const res = injectAlphaConfig(userData)
  // eslint-disable-next-line no-console
  console.log("INJECT_RESULT", JSON.stringify(res))
  const parsed = JSON.parse(process.env.OPENCODE_CONFIG_CONTENT!)
  console.log("INJECTED_AGENTS", JSON.stringify(Object.keys(parsed.agent ?? {})))
  console.log("INJECTED_TOP_LEVEL_PERMISSION", JSON.stringify(parsed.permission ?? null))
})

afterEach(async () => {
  await disposeAllInstances()
})

const KEYS = [
  "read",
  "edit",
  "write",
  "glob",
  "grep",
  "list",
  "bash",
  "task",
  "external_directory",
  "todowrite",
  "question",
  "webfetch",
  "websearch",
  "lsp",
  "doom_loop",
  "skill",
  "patch",
  "apply_patch",
  "some_unknown_tool_xyz",
]

it.instance("MATRIX", () =>
  Effect.gen(function* () {
    const agents = yield* load((svc) => svc.list())
    console.log("AGENT_NAMES", JSON.stringify(agents.map((a) => a.name)))
    for (const name of ["build", "plan", "alpha-readonly", "alpha-automation-standard", "alpha-automation"]) {
      const a = yield* load((svc) => svc.get(name))
      if (!a) {
        console.log(`ROW ${name} <MISSING>`)
        continue
      }
      const row: Record<string, string> = {}
      for (const k of KEYS) row[k] = Permission.evaluate(k, "*", a.permission).action
      console.log(`ROW ${name} ${JSON.stringify(row)}`)
      console.log(`SPOT ${name} read:.env=${Permission.evaluate("read", "foo/.env", a.permission).action}`)
      console.log(`SPOT ${name} bash:rm -rf /=${Permission.evaluate("bash", "rm -rf /", a.permission).action}`)
      console.log(`SPOT ${name} ext_dir:/tmp/x=${Permission.evaluate("external_directory", "/tmp/x", a.permission).action}`)
      const hidden = Permission.disabled(BUILTIN_TOOL_IDS, a.permission)
      console.log(`HIDDEN ${name} ${JSON.stringify([...hidden].sort())}`)
    }
    console.log("ALL_BUILTIN_TOOL_IDS", JSON.stringify(BUILTIN_TOOL_IDS))
    // 自证:探针能测出已知的坏 —— plan 的 edit 必须是 deny(已有生产测试断言过)。
    const plan = yield* load((svc) => svc.get("plan"))
    expect(Permission.evaluate("edit", "*", plan!.permission).action).toBe("deny")
  }),
)
```

</details>

<details><summary>探针 B:<code>alpha-1413-ask-probe.test.ts</code></summary>

```ts
// 勘破探针 2(ac#1413)—— 不进 main。真 Permission.Service.ask + 真 agent ruleset:
// 「请求审批」这一档到底会不会为 bash / edit 弹审批。
import { AppNodeBuilder } from "@opencode-ai/core/effect/app-node-builder"
import { CrossSpawnSpawner } from "@opencode-ai/core/cross-spawn-spawner"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { expect } from "bun:test"
import { Cause, Effect, Exit, Layer } from "effect"
import * as fs from "node:fs"
import * as os from "node:os"
import * as path from "node:path"
import { EventV2Bridge } from "../../src/event-v2-bridge"
import { Permission } from "../../src/permission"
import { InstanceBootstrap } from "../../src/project/bootstrap"
import { InstanceStore } from "../../src/project/instance-store"
import { SessionID } from "../../src/session/schema"
import { testEffect } from "../lib/effect"
import { Agent } from "../../src/agent/agent"
import { Auth } from "../../src/auth"
import { Config } from "../../src/config/config"
import { RuntimeFlags } from "../../src/effect/runtime-flags"
import { Plugin } from "../../src/plugin"
import { Provider } from "../../src/provider/provider"
import { Skill } from "../../src/skill"
import { injectAlphaConfig } from "../../../ui-mac/src/main/alpha-config-injection"

// 期限压到 300ms:被测的是「会不会挂起等人批」,不是「300 秒有多长」。
process.env["ALPHA_PERMISSION_ASK_TIMEOUT_MS"] = "300"

const tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "alpha-1413b-")))
process.env.ALPHA_GLOBAL_DIR = path.join(tmp, "alpha-code-state", "env", "dev")
fs.mkdirSync(process.env.ALPHA_GLOBAL_DIR, { recursive: true })
process.env.XDG_CONFIG_HOME = path.join(tmp, "xdg")
process.env.ALPHA_OPENCODE_HOME = path.join(tmp, "opencode-home")
process.env.XDG_DATA_HOME = path.join(tmp, "xdg-data")
for (const d of [process.env.XDG_CONFIG_HOME, process.env.ALPHA_OPENCODE_HOME, process.env.XDG_DATA_HOME])
  fs.mkdirSync(d, { recursive: true })
const userData = path.join(tmp, "userdata")
fs.mkdirSync(userData, { recursive: true })
console.log("INJECT", JSON.stringify(injectAlphaConfig(userData)))

const noopBootstrap = Layer.succeed(InstanceBootstrap.Service, InstanceBootstrap.Service.of({ run: Effect.void }))
const env = AppNodeBuilder.build(
  LayerNode.group([
    Permission.node,
    EventV2Bridge.node,
    CrossSpawnSpawner.node,
    InstanceStore.node,
    Agent.node,
    Plugin.node,
    Provider.node,
    Auth.node,
    Config.node,
    Skill.node,
    RuntimeFlags.node,
  ]),
  [[InstanceStore.bootstrapNode, noopBootstrap]],
)
const it = testEffect(env)

const rulesetOf = (name: string) =>
  Effect.gen(function* () {
    const agents = yield* Agent.Service
    const a = yield* agents.get(name)
    return a!.permission
  })

const tryAsk = (agentName: string, permission: string, pattern: string, sid: string) =>
  Effect.gen(function* () {
    const ruleset = yield* rulesetOf(agentName)
    const perm = yield* Permission.Service
    const exit = yield* perm
      .ask({
        sessionID: SessionID.make(sid),
        permission,
        patterns: [pattern],
        metadata: {},
        always: [pattern],
        ruleset,
      })
      .pipe(Effect.exit)
    const verdict = Exit.isSuccess(exit) ? "PASSED-THROUGH (no prompt)" : Cause.pretty(exit.cause).split("\n")[0]
    console.log(`ASK ${agentName} ${permission} "${pattern}" -> ${verdict}`)
    return verdict
  })

it.instance("真 Permission.ask:build(=「请求审批」档)对 bash/edit 是否弹审批", () =>
  Effect.gen(function* () {
    const bash = yield* tryAsk("build", "bash", "rm -rf node_modules && bun install", "ses_probe_1")
    const edit = yield* tryAsk("build", "edit", "src/index.ts", "ses_probe_2")
    // 正样本(证明本探针测得出「真的在问」):external_directory 在 defaults 里就是 ask。
    const ext = yield* tryAsk("build", "external_directory", "/Users/nobody/Downloads/x", "ses_probe_3")
    // 反样本(证明本探针测得出「真的被拒」)。
    const ro = yield* tryAsk("alpha-readonly", "bash", "ls", "ses_probe_4")
    expect(ext).not.toBe("PASSED-THROUGH (no prompt)")
    expect(ro).not.toBe("PASSED-THROUGH (no prompt)")
    void bash
    void edit
  }),
)
```

</details>

## 8. 已经在替用户做同一个决定的其它地方

1. **Settings → 「自动批准权限」总闸**(`settings.tsx:561-577`,默认 **关**:
   `shared/settings-adapters.ts:73`)。它**不是**死开关 —— 读点在
   `packages/app/src/context/permission.tsx:333-337` `autoApproveAllowed()`,
   纯判定在 `packages/app/src/context/permission-auto-respond.ts:58-69`(关 ⇒ 一律不自动放行)。
   但**能往 `autoAccept` 里写记录的入口(`toggleAutoAccept` / `toggleAutoAcceptDirectory` /
   `enableAutoAccept`)在 `packages/ui-mac/src` 下零调用点**(实测枚举:全部调用点都在
   `packages/app/src` 的上游叶 —— `components/settings-general.tsx`、
   `components/settings-v2/general-controllers.ts`、`components/prompt-input*.tsx`、
   `pages/session/use-session-commands.tsx`,而这些叶在 alpha 里被自有面替换,
   `pages/session.tsx` 是它们唯一的挂载者)。唯一还能写进去的是
   `enableConfiguredDirectory`(`permission.tsx:205-218`),条件是引擎报 v1 **且**该目录的
   config `permission === "allow"`。
   ⇒ **今天在 alpha 里打开这个开关基本没有可命中的记录**;它与本票要加的档位**语义重叠**,
   两个开关同时存在会让用户无从判断谁说了算。
2. **Settings → 工具(REQ-131 / `#1130`)**:逐工具 enabled/ask/disabled 的第二条轴,
   已上线(`settings.tsx:738` → `alpha-ui/settings-tools.tsx`),与档位轴汇进同一个引擎
   (`alpha-tool-policy-gate.ts:5-20`:deny 是上限、ask 挂起、allow 才放行)。
3. **composer 自己**:只读档**压过**用户手选的 agent(`composer-state.ts:320`,
   `alpha-composer.tsx:318` 的注释如实说明)。
4. **主权闸(permission 覆盖不了的)**:本机 websearch(`tool/websearch.ts:145`)、
   云 websearch(`packages/ext/src/cloud-websearch-kill.ts`)、MCP 默认 deny
   (`main/mcp-default-deny.ts`)、进程围栏 / 出网围栏(见
   [`2026-09-09-req159-process-fence.md`](2026-09-09-req159-process-fence.md)、
   [`2026-09-10-network-egress-on-process-fence.md`](2026-09-10-network-egress-on-process-fence.md))、发送前关键词拦截
   (`main/moderation-keywords.ts`)。
5. **`INTERNAL_AGENTS`**(`composer-state.ts:35`):三个 alpha agent 对选择器永久隐藏,
   所以用户今天**选不到**那个已经存在的可写档 `alpha-automation-standard`。

## 9. 与活稿的关系(读出来的,不是推的)

`docs/design/current/composer/design.html:406-426` 与 `:487-491` 写着**三档**:
「完全访问(默认选中)/ 请求审批 / 只读」,并把映射写成
「完全访问 → `permission:"allow"`;请求审批 → 规则式 `ask`」,结论原话
「能力真实存在,我们补的是 UI,不是造功能」。

- `git log -S"完全访问" -- docs/design/current/composer/design.html` ⇒ **只有一条**
  (`18a76b5f1`,该文件的最初提交)⇒ 这三档自落稿起从未被改过。
  (该文件本身被改过 4 次,但都没动这段。)
- **但活稿对「请求审批」的描述同样与实测不符**:它说那档是「规则式 `ask`」,
  而实测默认档是 `"*": "allow"`。⇒ 活稿与现实脱节的**不止**缺的那一档。

## 10. 本轮**没有**测到的(不要当成已知)

- 打包版真机上的端到端:从 renderer 点选档位 → IPC → sidecar → 模型回合 → 是否弹框,
  **未跑**。本文测的是引擎层(真注入 + 真 Agent + 真 Permission 服务)。
  `req.agent === undefined` 真的落成 `PromptInput.agent === undefined`,是**读**出来的
  (`composer-state.ts:303-323`),不是量出来的。
- 用户机上已有的 `alpha.jsonc` / `opencode.jsonc` 里有没有 `permission` 键 —— 未读 owner 的真实
  配置(探针把配置根钉进了临时目录)。owner 机器上若有,实际行为会与本表不同。
- Settings → 工具里 owner 现有的记录 —— 未读。
- `doom_loop` 在真实回合里多久触发一次 —— 未测。
