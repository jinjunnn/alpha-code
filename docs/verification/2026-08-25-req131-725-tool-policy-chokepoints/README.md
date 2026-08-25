---
title: REQ-131 #725 —— 工具策略在模型目录与执行咽喉的双闸取证
kind: verification
status: active
owners:
  - alpha-code maintainers
last_reviewed: 2026-08-25
review_after: 2026-11-25
---

# alpha-code#725 · REQ-131 双咽喉取证

票:[alpha-code#725](https://github.com/jinjunnn/alpha-code/issues/725) ·
父需求:[alpha-code#723](https://github.com/jinjunnn/alpha-code/issues/723)(REQ-131) ·
已批基线:[#724 的 DECIDE 终局评论](https://github.com/jinjunnn/alpha-code/issues/724#issuecomment-5311889096) ·
identity 合同:[#731](https://github.com/jinjunnn/alpha-code/issues/731) / ADR-041

被测树:`alpha-code` 分支 `ac-725`,base `alpha` @ `c3d0d0569`。**未改任何生产代码**;
本目录只有探针说明与结果,探针本体在
[`packages/opencode/test/tool/alpha-725-policy-chokepoints.cases.ts`](../../../packages/opencode/test/tool/alpha-725-policy-chokepoints.cases.ts)。

## 0. 结论先说

**票面标题的那句话,今天只有一半成立。**

| 判定 | 内容 |
| --- | --- |
| **模型目录闸(咽喉 A)** | **真绿** —— builtin / plugin / host / MCP 四个来源,identity `deny` 都真的把工具从交给 provider 的那张表里拿掉,且只拿掉它自己;`ask` 不改目录 |
| **执行闸(咽喉 B)** | **只对 MCP 成立**。builtin / plugin / 宿主 MCP-resource 工具在执行咽喉上**完全不接 identity 轴** —— `deny` 照跑、`ask` 不问 |
| **两道闸的独立性** | **不成立**。今天目录与执行读同一张表、同一份 ruleset,E1/E2 没有第二道闸 ⇒ 目录闸一旦漏,后面没有东西接得住 |
| **`always` 的作用域与上限** | **FAIL 两条** —— 会话 A 的「总是允许」在会话 B 直接生效;先 `always` 后收紧成 `deny`,旧批条仍然赢 |

23 条判据,**15 PASS / 8 FAIL**(3 轮完全一致,失败集逐字相同)。

两张窄票,各自 `Refs alpha-code#723`:

- [#1121](https://github.com/jinjunnn/alpha-code/issues/1121) —— E1/E2 执行咽喉不接 identity 三态(B2/B3/B4/B6/B10/B11)
- [#1122](https://github.com/jinjunnn/alpha-code/issues/1122) —— `approved` 既无会话作用域也无上限概念(B9/B13)

## 1. 覆盖边界 —— 本目录**没有**证明什么

票面 Covers 写的是「REQ-131 AC1–AC8」。**本轮实际只覆盖其中四条半**,原因是
[#724](https://github.com/jinjunnn/alpha-code/issues/724) 终局决策里列出的三张 CODE 子票
(策略 resolver / 双闸接线 / Settings)**至今没有被建出来**(2026-08-25 全库检索 `REQ-131`
只有 #723/#724/#725/#726/#731)。没有 policy resolver 就没有作用域、持久化、fail-safe 默认
与 Settings 可测。

| AC | 本轮 | 说明 |
| --- | --- | --- |
| AC2 | **部分** | 三态按 canonical identity 解析:目录侧 PASS,执行侧只有 MCP PASS。rename / 别名碰撞由 #726 / #972 的既有闸门守,本轮不重复 |
| AC3 | **覆盖(FAIL)** | 双咽喉矩阵,见 §3 |
| AC4 | **部分(FAIL)** | 只覆盖 **identity 轴**的「批准前零副作用」。计费前置没测 —— 本机没有会计费的真工具 |
| AC5 | **部分(FAIL)** | 只覆盖「本地既有批准不得扩权 / cap 恒赢」这一轴。服务端 entitlement、managed/组织上限**没测**,因为它们今天还不是 policy tier |
| AC8 | **部分(FAIL)** | 只覆盖会话作用域。重启持久化、账户/工作区隔离、版本迁移与损坏恢复**测不到 —— 能力不存在** |
| AC1 / AC6 / AC7 | **未覆盖** | inventory 差异 API、动态 add/remove/rebind、Settings 都还没有实现物 |

另外三处按 #724 §6 属于本票范围、但本轮**没有在运行期量到**,只有源码级确认:

- **E4 Code Mode 子工具** —— 探针把 `experimentalCodeMode` 钉死成 `false`。翻成 `true` 之后
  `session/tools.ts:418` 在注册完宿主资源工具后就 `return tools`,MCP 那一整段不再执行,
  沿用同一份探针会从「拦住了」静默变成「压根没跑到」。源码上 E4 两道闸都在
  (`tool/code-mode.ts:214` 目录 + `:151` identity ask),**但没被本轮驱动过**。
- **E6 直连 subtask** —— `session/prompt.ts:286` 今天只有 `Permission.disabled` 的 deny,
  **没有 ask**。驱动它要起 `SessionPrompt` 与一整回合,本轮没做。
- **E7 附件读取** —— `session/prompt.ts:848` 传 `ask: () => Effect.void`。#724 把它列为
  **显式排除项并要求一条负向锁死断言**;那条断言今天不存在,本轮也没补(补它属于 CODE)。

还有一条 #724 Blocker 3 点名、**至今未修**的既有缺口,本轮只做了源码确认、没有在运行期造场景
(要写 `/Library/Application Support/opencode`,本机不做):
`packages/opencode/src/config/managed.ts:31-32` 仍是
`process.env.OPENCODE_TEST_MANAGED_CONFIG_DIR || systemManagedConfigDir()` ——
`||` 是**替换**不是合并,设一个环境变量就能让系统 managed 上限整个消失。

## 2. 怎么跑

```bash
cd packages/opencode
bun test --timeout 60000 ./test/tool/alpha-725-policy-chokepoints.cases.ts
# 预期(base c3d0d0569):Ran 23 tests across 1 file. / 15 pass / 8 fail
```

`bun test` 需要显式带 `./` 前缀:`.cases.ts` 不在 bun 的测试文件命名约定里,不带 `./`
会被当成 filter 而**一个文件都不跑**(`0 fail` 恒成立 = 假绿)。判据只有一条:
核对 `Ran 23 tests across 1 file.` 里的 23 与判据数相等。

### 探针为什么住在 `packages/opencode/test/` 而不是本目录的 `probes/`

它必须与生产共享**同一个 `effect` 模块实例** —— Effect 的 Context tag 是按模块实例做身份的。
从 `docs/` 走相对路径 import `effect` / `@opencode-ai/core` 会拿到另一份解析结果,
`yield* Permission.Service` 这类取服务会在运行期失败,或者更糟——静默拿到另一棵层图。
实测:放在 `docs/` 下时 `@modelcontextprotocol/sdk` 与 `effect` 都解析不到(bun 从文件位置
往上找 `node_modules`,`docs/` 之上没有)。

扩展名用 `.cases.ts`:**不进 `bun test`**(所以不是闸门、不登记 `scripts/gate-files.tsv`),
`packages/opencode` 也不在任何 alpha typecheck 面内。

### 测量口径

| 项 | 口径 |
| --- | --- |
| 咽喉 A 的入口 | 真的 `LLMRequestPrep.prepare()` 返回的 `tools` —— 生产里唯一交给 provider 的那张表(`session/llm.ts:242,327`)。**不**调它内部的 `resolveTools`,也**不**调 `Permission.disabled` |
| 咽喉 B 的入口 | 真的 `SessionTools.resolve()` 返回对象上的 `.execute()` —— AI SDK 与 DWS `toolExecutor`(`session/llm.ts:140-148`)真正调的那个函数 |
| 工具成员从哪来 | 真的:一台真的 streamable-HTTP MCP server(自己发布 `paid_action`/`free_action`、声明 resources capability)、一个真写进 `.opencode/tool/probe.ts` 的自定义工具、真的内置 `write`、真的宿主 `list_mcp_resources` |
| 「有没有真的执行」 | **服务器侧 / 文件系统侧的真实计数**:MCP `tools/call` 与 `resources/list` 由服务器自己计数,插件工具与 `write` 落**真文件**。不用「抛没抛异常」当判据——一个先做副作用再抛的实现能满足它 |
| 期望值来源 | 一律**手写字面量**(`"mcp:policy:paid_action"` / `"builtin::write"` / `"policy_paid_action"`),不从 `canonicalToolIdentity()` / `McpCatalog.toolName()` 导出。锚点与被测对象同源 = 自指等价链 |
| ruleset 注入 | `session.permission`,并由 **R1** 用真 `opencode.json` + 真 `Config` + 真 `Agent.Service` 证明同一形状从用户可编辑的配置文件到得了(见 §4) |
| 重复次数 | 基线 3 轮,失败集逐字相同(`results/baseline-round{1,2,3}.txt`) |
| 闸门是不是真的 | 两次摘线实验,见 §5 |

## 3. 逐条

### 咽喉 A —— 模型目录:**真绿**

| # | 判据 | 结果 |
| --- | --- | --- |
| A5 | 负向对照:无 identity 规则时五个键全部在目录里 | PASS |
| A1 | `builtin::write` deny ⇒ `write` 不在目录 | PASS |
| A2 | `plugin:probe:default` deny ⇒ `probe` 不在目录 | PASS |
| A3 | `host::list_mcp_resources` deny ⇒ 宿主资源工具不在目录 | PASS |
| A4 | `mcp:policy:paid_action` deny ⇒ 只有它消失,同 server 的 `free_action` 仍在 | PASS |
| A6 | `ask` 不改目录:四个来源设成 `ask` 之后仍全部在目录里 | PASS |

A5 与 A6 是**必须在**的负向对照:少了它们,一个「无条件清空目录」或「把 ask 也当 deny 删掉」的
实现能让 A1–A4 全绿,而用户会发现「设成询问」等于「禁用」。

### 咽喉 B —— 执行:**只对 MCP 成立**

| # | 判据 | 结果 | 观测到的真实副作用 |
| --- | --- | --- | --- |
| B0 | 负向对照:无规则时四个来源都真的跑出副作用 | PASS | `tools/call`=1、`resources/list`=1、marker 落盘 |
| B1 | `mcp:policy:paid_action` deny ⇒ 响亮拒绝且 `tools/call`=0 | PASS | — |
| **B2** | `plugin:probe:default` deny ⇒ 必须拒绝且 marker 不存在 | **FAIL** | **插件工具照跑,marker 文件真的被写出来** |
| **B3** | `builtin::write` deny ⇒ 必须拒绝且目标文件没被写出 | **FAIL** | **文件真的落盘** |
| **B4** | `host::list_mcp_resources` deny ⇒ 必须拒绝且 `resources/list`=0 | **FAIL** | **服务器真的收到 `resources/list`(计数 1)** |
| B5 | MCP `ask` ⇒ 挂起等批准、`tools/call`=0;reject 后仍为 0 | PASS | — |
| **B6** | plugin `ask` ⇒ 必须先请求批准;marker 在批准前不得出现 | **FAIL** | **不问,直接跑完并落盘** |
| B7 | MCP `ask` + `once` ⇒ 第二次必须再问一遍 | PASS | — |
| B8 | MCP `ask` + `always` ⇒ 同 session 同 identity 不再追问 | PASS | 第二次直接 `tools/call`=2 |
| **B9** | 先 `always`、后把同一 identity 收紧成 `deny` ⇒ 第二次必须被拒 | **FAIL** | **`tools/call` 从 1 涨到 2 —— 旧批条压过新 deny** |
| **B10** | `builtin::write` `ask` ⇒ 必须先请求批准 | **FAIL** | **不问,文件直接落盘** |
| **B11** | `host::list_mcp_resources` `ask` ⇒ 必须先请求批准 | **FAIL** | **不问,`resources/list` 计数 1** |
| B12 | 正向对照:ability 键 `edit=ask` ⇒ `write` 真的会先问、批准前不落盘 | PASS | — |
| **B13** | 会话 A 点 `always` ⇒ 会话 B 必须重新询问 | **FAIL** | **会话 B 不问就跑,`tools/call` 涨到 2** |

**B12 是本轮最重要的一条正向对照。** 没有它,B3/B10 会被读成「`write` 压根没有审批闸」;
真相是闸在,只是**只认 ability 键**。今天 `edit` 这一个键同时管住 `edit` / `write` /
`apply_patch` 三个工具(`permission/index.ts:293`),`read` 键同时管住三个 MCP-resource 工具
—— 正是 REQ-131 **AC12** 点名的那个既有折叠。identity 轴在 E1/E2 上完全没接线。

### E5 DWS 预批清单(**单元级,不冒充链路证据**)

| # | 判据 | 结果 |
| --- | --- | --- |
| E5a | identity=`ask` 的 MCP 工具不得进入 `sessionPreapprovedTools` | PASS |
| E5b | identity=`ask` 的 builtin 工具不得进入 `sessionPreapprovedTools` | PASS |

喂进去的是**真的** prepared 工具表(真 identity、真 ruleset),但本机没有 DWS 服务端,
整条链路跑不起来 ⇒ 这两条只证明「预批清单里没有它」,**证明不了「DWS 真的会问」**。
#724 §9 允许这一格留在 #725,但要求不当成 packaged 证据 —— 这里照办。

## 4. 第零问:这些状态,走我们自己的代码到得了吗?

**到得了,而且不需要任何还没实现的 Settings。** 判据 **R1** 用真 `opencode.json` +
真 `Config` 节点 + 真 `Agent.Service`(不 stub Config)量到:

```
opencode.json {"permission": {"builtin::write": "ask", "mcp:policy:paid_action": "deny", ...}}
  → Config.get().permission
  → Permission.fromConfig(...)                        (agent/agent.ts:138)
  → agent.permission,且 user 规则合并在**最后**       (agent/agent.ts:143)
  → 同时进 SessionTools.resolve 与 LLMRequestPrep.prepare
```

R1 PASS,并带一条负向对照(没写进 config 的 identity 仍然是 `allow`,不会凭空变 ask/deny)。

机制上:`packages/core/src/v1/config/permission.ts:18-36` 的 `InputObject` 是
`StructWithRest(..., [Record(String, Rule)])` ⇒ **接受任意键**。桌面侧已有活的同类写入方——
`packages/ui-mac/src/main/cloud-web-search.ts` 的 `applyWebSearchDenies()` / `pinDeny()`
就是往 `config.permission` 与每个 `config.agent[*].permission` 里钉工具级 deny。

那个文件的抬头还写着一句今天仍然成立的话:**「注入面的 permission deny 只是可用性
(把工具从模型工具表里滤掉),不是主权保证」**,并因此把云 web search 的最终闸做成了一个
读环境变量的 `tool.execute.before` 插件钩子(`packages/ext/src/cloud-websearch-kill.ts`)。
那是**单工具特例**,正是 #723 Context 里写明「不能扩写成所有工具的用户配置」的那个东西。
本轮的读数与它逐条吻合。

## 5. 摘线实验 —— 这两条判据是真的会红吗

两次实验各自:`git status` 干净 → 只改一处 → 跑 23 条 → 用 `shasum -a 256 -c` 逐字还原 →
复核 `git diff` 为空。两处生产文件的还原后摘要与实验前逐字相同。

| 实验 | 摘掉什么 | 新增翻红 | 未受影响 |
| --- | --- | --- | --- |
| **M-A** | `permission/index.ts:300-304` 的 identity hard-deny 分支 | **A1 A2 A3 A4** | A5/A6 与全部 B 判据不动 |
| **M-B** | `session/tools.ts:437-442` 的 `ctx.ask({permission: canonicalToolIdentity(...)})` | **B1 B5 B7 B8** | 全部 A 判据不动 |

原始输出:
[`results/mutation-MA-permission-identity-deny-removed.txt`](results/mutation-MA-permission-identity-deny-removed.txt)(12 fail)、
[`results/mutation-MB-session-tools-identity-ask-removed.txt`](results/mutation-MB-session-tools-identity-ask-removed.txt)(12 fail)、
基线 [`results/baseline-round1.txt`](results/baseline-round1.txt)(8 fail)。

⇒ 两处咽喉**各自**都有一条会翻红的判据,并且两次摘线**互不串扰** —— 摘掉目录闸不影响执行判据,
摘掉执行闸不影响目录判据。这正好也是本轮最重要的那个结构性结论的反面证明:
**今天这两道闸真的是两处独立的代码,但它们只在 MCP 上同时存在。**

## 6. 这轮里差点量错的地方

- **`.cases.ts` 不带 `./` 前缀时 bun 一个文件都不跑**,输出是
  `The following filters did not match any test files`,而 `0 fail` 恒成立。判据钉在
  `Ran 23 tests across 1 file.` 的 23 上。
- **探针最初放在 `docs/verification/.../probes/`**,`@modelcontextprotocol/sdk` 与 `effect`
  都解析不到;改成相对路径直连 `packages/opencode/node_modules/...` 能跑,但那样会引入
  **第二个 `effect` 模块实例**,Context tag 身份不再相等 —— 那不是「跑不起来」,是可能
  **静默拿到另一棵层图**。最终把探针放进包内。
- **`Effect.fork` 在 effect@4.0.0-beta.83 里不存在**(只有 `forkChild/forkIn/forkScoped/...`)。
  B5–B13 改成裸 Promise:`Effect.promise` 把 reject 当 defect,包一层就读不出「用户拒绝」
  与「崩了」的差别。
- **B9 的第一版名叫「always 不得撬开」但根本没跑 `always`** —— 它只是设了 deny 然后调用。
  那是「断言粒度比缺陷粗一格」的标准形态:改对之后(先 ask→always,再收紧成 deny)当场翻红。

## 7. 参考

- 已批基线:[#724](https://github.com/jinjunnn/alpha-code/issues/724) 的 DECIDE 终局评论
  (E1–E7 处置表在 §6,三态与默认在 §2,作用域合成在 §4)
- identity 合同:`packages/schema/src/tool-identity.ts` / `.claude/rules/adrs/ADR-041-tool-identity-ledger.md`
- 姊妹闸门(别名双射,已在仓内且是真闸门):
  `packages/opencode/test/tool/alpha-mcp-alias-collision-lock.test.ts`(#726)、
  `packages/opencode/test/tool/alpha-session-tools-alias-lock.test.ts`(#972)
