---
title: 托管层与「失败即中止」—— 两样都已经在跑,缺的是租户身份;托管 hook 暂不做
kind: architecture
status: active
owners:
  - alpha-code desktop maintainers
last_reviewed: 2026-09-08
review_after: 2026-12-08
---

# 托管层与「失败即中止」的裁决

*2026-09-08 · 票 [`alpha-code#1291`](https://github.com/jinjunnn/alpha-code/issues/1291) ·
被测树 `alpha-code@d5d2b493c`(worktree `.worktrees/ac-1291`,base `origin/alpha`)*

## 0. 先说结论

**暂不做「托管层 hook」。** 但这个结论的形状与票面设想的不一样 —— 票面把它当成
「一件我们没有的能力,被 ADR-040 挡住了」,而实读之后是三件独立的事:

| 票面当成一件事的 | 今天的真实状态 |
| --- | --- |
| ①「管理员的规则压过成员自己的设置」 | **已经在跑**,而且是声明式的、非代码的。`managed` cap(REQ-131 `#1128`/`#1129`)—— 任何用户层 enabled、任何会话 `always` 都撬不开它 |
| ②「规则执行失败则整个动作中止,而不是当没发生」 | **已经在跑**,而且是引擎里**唯一**的钩子失败通道。本文 §1.3 有实跑探针 |
| ③「托管的规则本身可以是客户提供的可执行 hook」 | **没有,今天也不该做** —— 见 §2.4 |

**净裁决:不新建任何机制。** ①②已有;③的价值全部来自「客户要写我们预置不了的规则」,
而今天**零团队客户**(owner 2026-08-31 确认:除本机外零租户),
并且③在做之前还压着两道与 hook 无关的前置(租户身份、下发通道),
以及一道 ADR-040 明写的、**引擎侧尚未闭合**的事件面前置(§2.4)。

**真正的缺口只有一个,而且不在 hook 上:我们没有「谁是管理员」这个概念。**
策略分区的 account 在生产里恒为字符串 `"anonymous"`
(`packages/opencode/src/permission/alpha-tool-policy.ts:233`),
`entitlement` cap 在生产里**没有任何供数方**(§2.3)。
第一个团队客户到来时要补的是这个,不是 hook。

重开条件与代价在 §4 / §5。

---

## 1. 票面三条坐标的复核

票面的现状坐标标注为「2026-09-08 实读」。逐条复核:**两条成立,一条不成立。**

### 1.1 ✅ 成立:签名信封里没有 hooks 的表达位

```
$ python3 -c "import json;d=json.load(open('alpha-package-envelope-v1.schema.json'));..."
.prelude.packageId  .prelude.version  .presentation.displayName  .presentation.description
.root  .components[].{id,profileId,profileVersion,payloadRef,capabilities,dependencies,required}
.capabilities  .schema
```

`hooks` / `hook` / `command`(作为**载荷字段**)在
`packages/ui-mac/src/shared/host-extension-package-contract/alpha-package-envelope-v1.schema.json`
里各零命中。注册表 `host-extension-package.registry.v1.json` 今天有 **5 个 profile**
(`agent` / `command` / `mcp-local` / `mcp-remote` / `skill`),`limits.maxComponents = 32`
——`command` 是 [`#840`](https://github.com/jinjunnn/alpha-code/issues/840) 按 ADR-040 判据③
新增的(理由不涉及 provider),不是本文要处理的偏差。

### 1.2 ✅ 成立,但 ADR-040 已经给 hooks 留了门

`CONTRACT.md:73` 与 `:272` 的措辞是「**payload 是引擎在自己进程里求值的代码**」的 profile 被禁。
这条对**签名包**成立。

但 [ADR-040](../../.claude/rules/adrs/ADR-040-extension-package-taxonomy.md) 的
**2026-08-03 owner 补充裁决**把判据①明确收紧过,原文:

> 它问的**不是**「要不要执行第三方代码」。`hooks`(Alpha 起的子进程、边界由我们定)
> **不落在这一问里** —— owner 已裁决后续支持它,届时它按判据③走「新种类」的路。

⇒ **「ADR-040 挡住了托管 hook」这个前提本身要修正。** 挡住的是
「引擎进程内 / 引擎权限 / 上游加载器」这一种执行形态;子进程形态的 hook 从 2026-08-03 起
就是**已批准的方向**,只是被一道前置卡着(§2.4)。本票因此**不是**一道解禁裁决。

### 1.3 ❌ 不成立:「hook 失败当前不中止动作」

票面写「`packages/plugin/src/index.ts` 无 `FailedAbort` 一类的失败语义(hook 失败当前不中止动作)」。
**前半句对,后半句反了。**

`Hooks` 接口里每个命名钩子的返回类型都是 `Promise<void>` —— 确实**没有结构化的结果通道**,
所以没有 `FailedAbort` 这个**名字**。但正因如此,**抛出是唯一的失败通道,而它不被吞**:

```ts
// packages/opencode/src/plugin/index.ts:291-304
const trigger = Effect.fn("Plugin.trigger")(function* (name, input, output) {
  for (const { value: hook } of s.hooks) {
    const fn = hook[name] as any
    if (!fn) continue
    yield* Effect.promise(async () => fn(input, output))   // ← 未捕获
  }
  return output
})
```

**实跑探针**(临时测试文件,跑完即删,未提交;装两个插件、第一个抛错):

```
$ cd packages/opencode && bun test test/plugin/zz-probe-1291.test.ts
PROBE exit._tag   = Failure
PROBE cause       = {"_id":"Cause","failures":[{"_tag":"Die","defect":{}}]}
PROBE out.system  = ["first-ran"]          ← 第二个插件的同名钩子一次都没跑
1 pass / 0 fail
```

⇒ **钩子抛出 ⇒ `Die`(defect)上抛 ⇒ 本次 trigger 链当场终止、后续钩子不执行、
调用点拿不到 output。这正是「失败即中止」,而且是 14 个活钩子的每一个都有的行为,不是某个钩子的特性。**

这不是理论推导:它是**已上线的产品特性所依赖的机制**。
`packages/ext/src/cloud-websearch-kill.ts` 的主权 kill-switch 就是靠
「在 `tool.execute.before` 里抛错」把远端 MCP 工具拒死的 —— 而
`packages/ext/src/cloud-websearch-kill.test.ts:387` 有一条源码级判据钉住
「`Plugin.trigger` 体内不得出现 `Effect.ignore` / `catchAll` / `Effect.orElse` / `Effect.either`」,
一旦上游把它改成吞错,那条测试立刻红。

**这条更正很重要,因为它改变了本票的题目**:我们要的不是「造一个中止语义」,
而是「决定要不要给这个已有的中止语义再加一个**由外部提供规则**的入口」。

### 1.4 ⚠️ 顺带查出的一条,直接影响 `#1285`

`"permission.ask"` 钩子**声明了但永远不会被触发**。这不是新发现 ——
[`architecture/engine-command-and-event-surface.md` §2.1](engine-command-and-event-surface.md)
(2026-08-04)已经登记。本轮用两条独立轴复跑确认它在 `d5d2b493c` 上仍然成立:

```
$ grep -n '"permission.ask"' packages/plugin/src/index.ts
261:  "permission.ask"?: (input: Permission, output: { status: "ask" | "deny" | "allow" }) => ...

$ grep -rh -A2 'plugin\.trigger(' --include="*.ts" packages/ | grep -o '"[a-z][a-z.]*"' | sort -u
"chat.headers" "chat.message" "chat.params" "command.execute.before"
"experimental.chat.messages.transform" "experimental.chat.system.transform"
"experimental.compaction.autocontinue" "experimental.session.compacting"
"experimental.text.complete" "shell.env" "tool.definition"
"tool.execute.after" "tool.execute.before"
```

第二条轴的**负向控制**:它确实抓得到活钩子(13 个;第 14 个
`experimental.provider.small_model` 用泛型写法 `plugin.trigger<"...">(`,
在 `provider.ts:1923`)。`permission.ask` 在两条轴上都只有那一处**声明**,零触发点。

⇒ [`#1285`](https://github.com/jinjunnn/alpha-code/issues/1285)(REQ-158)票面写的
「`permission.ask` hook ⋯ **接缝是现成的**」**不成立**。
一个实现它的插件类型检查会过、一次都不会被调用。REQ-158 的分类结论必须挂在别处 —— 见 §2.2。

---

## 2. 四问的回答

### 2.1 Q1 — 在 ADR-040 之下,托管规则能不能表达成非代码的声明?

**能,而且已经在生产里跑了三周,不需要新造。**

`packages/opencode/src/permission/alpha-managed-policy.ts`(alpha 自有文件,ADR-043 谓词因子②)
读三个来源,合成一层**不可突破的 cap**:

| 优先级(低→高) | 来源 | 谁写得了 |
| --- | --- | --- |
| 1 | `OPENCODE_TEST_MANAGED_CONFIG_DIR`(**additive**,只能加规则,压不掉系统规则) | 任何人;仅测试便利 |
| 2 | 系统 managed 目录(`darwin: /Library/Application Support/opencode`、`win32: %ProgramData%\opencode`、其余 `/etc/opencode`)的 `opencode.json` / `opencode.jsonc` | **root / 管理员** |
| 3 | macOS MDM 托管偏好(`ai.opencode.managed.plist`) | **MDM 管理员** |

它比上游同名机制严一格,而且是刻意的:上游 `config/managed.ts:31` 是
`process.env.OPENCODE_TEST_MANAGED_CONFIG_DIR || systemManagedConfigDir()` ——
**一个进程环境变量就能把系统目录整个换掉**。alpha 的读取器**无条件读系统目录**,
env 只当最低优先的 additive 补充。

合成语义(`alpha-tool-policy.ts:133-141`,纯函数、无 IO):

```
cap 命中 ⇒ disabled,任何下层(用户 enabled、会话 always/approved)都撬不开
  · managed.status === "unreadable"  ⇒ disabled(坏输入方向是 fail-closed)
  · managedCapDenies(canonical, ruleset)
  · entitlement === "deny" | "missing"
  · hardDeny.length > 0
```

**表达力的诚实边界。** 今天 managed 层能说的**只有一句话**:

> 「canonical tool identity 匹配这个 pattern 的工具,**禁用**。」

判据是 `managedCapDenies`:`ruleset.findLast(Wildcard.match(canonical, rule.permission))`
命中的那条规则,`pattern === "*"` 且 `action === "deny"` 才算 cap deny。
**managed 的 `allow` 只表示「上限不阻止」,不给下层扩权。**

拿真实场景试(不停在概念层):

| 一个团队管理员会想说的话 | 今天的 managed 声明表达得了吗 |
| --- | --- |
| 「全公司禁用 web search」 | ✅ 一条 deny(主权 kill-switch 已在跑同一条路) |
| 「禁止调用某个第三方 MCP server 的全部工具」 | ✅ `Wildcard` pattern 覆盖该 server 的 canonical 前缀 |
| 「只允许白名单里的工具,其余一律禁」 | ⚠️ **表达不了**:`findLast` + 「只有 deny 构成 cap」意味着这是一张**黑名单**文法。`allow` 不扩权,所以写不出「默认拒 + 点名放行」 |
| 「写文件到 `/etc` 一律拒,写到工作区放行」 | ❌ **表达不了**:cap 的粒度是**工具身份**,不看**参数**。参数轴在 `tool.execute.before`,那是另一层 |
| 「往公司域名之外发数据要二次确认」 | ❌ **表达不了**:managed 层只有 deny,没有 ask;destination 也不是 identity |
| 「每天 18:00 之后禁止 shell」 | ❌ **表达不了**,而且不该表达 —— 见下 |

⇒ **Q1 的答案分两半**:
**「托管规则可以是非代码声明」——是,已实现。**
**「表达力够不够」——够今天要的,不够上表后三行。** 而后三行里的前两行
(参数轴、destination 轴)恰好是 REQ-158(`#1285`)的题目,第三行是我们
**不应该**去满足的那类需求(把托管层做成通用规则引擎 = 把窄票升级成通用框架)。

### 2.2 Q2 —「失败即中止」落在哪一层?它与 `#1285` 是同一层还是两层?

**两层。而且今天已经有两层,不是一层。**

一次工具调用的真实顺序(`session/tools.ts:98-118`、`tool/code-mode.ts:157-176`):

```
① AlphaToolPolicyGate.gateToolExecution(...)        ← 策略咽喉(alpha 自有)
   ├ resolve():每次调用重读 managed cap + 用户文档
   ├ deny ⇒ namedDeny() ⇒ PermissionV1.DeniedError,调用点 .pipe(Effect.orDie)
   │        ⇒ 具名、响亮、零 hook、零副作用
   └ ask  ⇒ 在本次 ruleset 末尾追加一条 exact-canonical 的 ask
② permission.ask(...)                                ← 审批(引擎的 Permission 引擎)
③ plugin.trigger("tool.execute.before", ...)         ← 插件钩子;抛出即 Die(§1.3)
④ 工具真正执行
```

- **「失败即中止」的语义落在 ① 和 ③,两处都已成立。**
  ① 是**声明轴**的中止(规则说不行 ⇒ 具名拒绝);
  ③ 是**代码轴**的中止(钩子抛出 ⇒ defect)。
  两者都在 ④ 之前,都**结构上够不着** `approved` / 会话 `always` / 后加载 agent 的 wildcard allow。

- **`#1285`(REQ-158)不是这一层。** 它要的是「到达授权提示的每个动作携带一个分类结论」——
  那是**给 ② 提供信息**,让用户看到的那一句话有依据;它不产生中止。
  分类是**输入**,cap 是**上限**,审批是**待裁决态**。三者混成一层会重演
  `#724 §4` 已经处理过的错误(「deny 是上限,ask 是待裁决态」)。

- ⚠️ **但 `#1285` 的落点必须改。** §1.4 已证明它票面写的
  `permission.ask` 钩子**永不触发**。REQ-158 的分类若挂在那里,是一条**假闸**:
  类型检查过、测试可以过、生产零调用。**唯一在 `Permission.ask` 之前必经、
  且今天真的在跑的 alpha 自有咽喉是 `gateToolExecution`**
  (`packages/opencode/src/permission/alpha-tool-policy-gate.ts:138`,`alpha-*` 基名 ⇒ ADR-043 alpha 自有)。
  这条更正**属于 `#1285`,不属于本票**,已在 §6 登记为要回写的票面事实。

### 2.3 Q3 — 托管层的下发与信任从哪来?撤销怎么走?

三条候选通道,逐条实读:

| 通道 | 信任根 | 撤销 | 今天能不能用 |
| --- | --- | --- | --- |
| **A. 系统 managed 目录 / MDM**(已实现) | root / MDM 描述文件 —— **操作系统级**,不需要我们发明任何东西 | 删文件 / 撤 MDM profile。**下一次工具调用即生效**:`resolve()` 每次调用重读盘,零缓存(`alpha-tool-policy.ts:249-259`) | ✅ **能**,但只对**真的部署了 MDM 或有 IT 管理机器的客户**成立 |
| **B. 平台侧租户策略**(`alpha-platform` 下发) | 我们自己的账户体系 | 平台改一次,客户端下次取到 | ❌ **不能** —— 见下 |
| **C. 签名包携带托管规则** | 包签名 + admission | 卸载 / catalog 撤下 | ❌ **不该** —— 见下 |

**A 的两条已知边界(诚实登记)**:

1. **目录名是上游品牌。** `systemManagedPolicyDir()` 与上游 `config/managed.ts` 一样写死
   `opencode` / `ai.opencode.managed`,而产品面早已改名 code-puppy(REQ-139 `#1191`)。
   ⇒ 团队管理员要给 Alpha 下策略,写的是一个叫 `opencode` 的目录;
   反过来,一份为 opencode 部署的 MDM 描述文件**也会作用到 Alpha**。
   两者都需要 root,不在用户威胁模型内,但**做团队交付时这是要说清楚的一句话**。
   本机实测:`/Library/Application Support/opencode` 与 `/Library/Managed Preferences/`
   **均不存在**(`ls` 各一次,No such file or directory)⇒ 这条通道在开发机上是**零占用**的。
2. **它是黑名单文法**(§2.1),且**只有 deny**。

**B 为什么今天不能用 —— 这才是真缺口。**

- 策略文档的分区是 `{account, workspace}`,而 `account` 在生产里是
  `options?.account ?? Effect.succeed("anonymous")`(`alpha-tool-policy.ts:233`),
  源码注释自陈:「生产默认 anonymous —— 引擎侧今天没有账户权威,`#1129`/`#1130` 接线」。
  **⇒ 引擎不知道「你是谁」,更不知道「谁是你的管理员」。**
- `entitlement` cap 的类型位存在(`"allow" | "deny" | "missing"`),
  但**生产里没有任何供数方**:两个 `gateToolExecution` 调用点
  (`session/tools.ts:106`、`tool/code-mode.ts:157`)都不传 `caps`,
  `foldRulesetCap` 只填 `hardDeny`(来自 permission ruleset),`entitlement` 恒 `undefined`。
  这个位是 `#724` 为服务端判定**预留**的,不是已接的线。
- 上游**确实有**一条 org 配置通道(`config/config.ts:486-518`:
  `activeAccount.active_org_id` ⇒ `GET ${url}/api/config` ⇒ 以 `global` 优先级并入),
  但它指向 **opencode console 的账户体系**,不是 alpha 的。
  **不要把它当成我们的租户通道** —— 那等于把公司策略的信任根交给第三方。

**C 为什么不该用。** 签名包携带的是**载荷**,由**用户自己**决定装不装、装哪个;
托管策略的定义是**用户撤不掉**。让一个用户可卸载的东西承载「用户撤不掉的规则」,
在语义上就是坏的;而要让它撤不掉,就得再造一套「必装包」机制 ——
那是 A 的功能,用一条更贵、更绕的路重做一遍。
⇒ **明确否决:托管策略不走签名包。**(这条与 ADR-040 无关,是分发语义,不是执行形态。)

### 2.4 ③ 可执行的托管 hook 本身:为什么今天不做

即使 ADR-040 已经给它留了门(§1.2),它今天仍然压着**三道各自独立的前置**:

1. **ADR-040 自己设的事件面前置尚未闭合。** ADR-040 原文:
   「在这次勘破落地之前,**任何 hooks 实现票不得升 Ready**」。
   那次勘破的引擎侧与语料侧已由
   [`engine-command-and-event-surface.md`](engine-command-and-event-surface.md) 完成,
   **结论是缺口仍在**(该文 §5.2):引擎缺**真正的 `Stop`**、**真正的 `SessionEnd`**、
   **覆盖失败结果的 PostTool 契约**,并且**没有结构化否决/决策通道 —— 只能抛错**。
   Claude 官方 hook 文法还有**两处未验证**(退出码是否另有拦截语义、stdin 的完整字段表)。
   ⇒ 现在动手,就是在**别人文法的替身**上再写一版 —— 本 portfolio 记录在案最贵的返工形态。
2. **hook ABI 的归属未定。** [`#818`](https://github.com/jinjunnn/alpha-code/issues/818)
   (`[DECIDE][P1]`,至今 OPEN):`packages/plugin` 既不在 `UPSTREAM_PATHS`
   的收编白名单里也不是 alpha 自有,而它**就是插件 ABI 的权威来源**。
   在它裁完之前,任何「我们自己定义 hook 契约」的实现都可能落在一块产权不清的地上。
3. **没有客户。** owner 2026-08-31 确认:除本机外零租户。
   ③ 的全部价值来自「客户要写我们预置不了的规则」——
   而我们连**一个真实的团队规则样本**都没有。照没有样本的需求设计规则语言,
   必然是「预防性抽象 + 把窄票升级成通用框架」。

**参考物(codex)的读法。** 本机实测 `codex-cli 0.144.1`
(`strings` 读 `node_modules/@openai/codex-darwin-arm64/vendor/aarch64-apple-darwin/bin/codex`):

- `allow_managed_hooks_only` / `allowManagedHooksOnly` 确实存在,
  但它**不是 hook 的字段** —— 它是 `ConfigRequirementsToml`(24 个字段)/
  `ConfigRequirements`(16 个字段)里的一项,与 `allowed_approval_policies`、
  `allowed_sandbox_modes`、`allowed_permission_profiles` 并列。
  即:codex 的托管层是一整套**「企业 requirements」声明**,「只许跑托管 hook」只是其中一个开关。
- 托管 hook 本体是 `hooks.managed_dir` / `hooks.windows_managed_dir` 指向的目录里的
  `hooks.json`,handler 形态是 `ConfiguredHookHandler::Command`(5 个字段),
  带 `eventName` / `matcher` / `timeoutSec` / `isManaged` / `currentHash` / `trustStatus`。
  ⇒ **它是「admin 目录里的可执行命令 + 哈希 + 信任态」,不是「包里的代码」。**
- 配置层来源枚举:`system` / `project` / `mdm` / `session_flags` / `plugin` /
  `cloud_requirements` / `cloud_managed_config` / `legacy_managed_config_file` /
  `legacy_managed_config_mdm`,并有一条断言字符串
  `config layers are not in correct precedence order`。
- ⚠️ **`HookResult::FailedAbort` 这个名字在 0.144.1 的二进制里零命中**
  (`strings | grep -i 'failedabort\|failed_abort'` 空)。
  命中的是执行结果枚举 `spawn_error` / `stdin_error` / `completed` / `wait_error` / `timeout`。
  ⇒ 票面引用的那个符号**未经本地实读证实**,可能是内部 Rust enum(不序列化就不出现在 strings 里)
  或已改名。**本文不据它做任何设计推论。**

**从中借什么、不借什么:**
借 —— 「托管层 = 声明式 requirements + admin 拥有的目录 + 精确的层优先级」这个**形状判断**,
它与我们 §2.1/§2.3-A 的现状同构,说明方向是对的。
**不借** —— 它的 `hooks.json` 文法、事件名、`trustStatus` 状态机。
我们的包模型与它不同(治理层我们更严:准入/事务/账本/grant digest),
照抄它的形状就是《勘破先于闸门设计》点名的那个错。

---

## 3. 被否决的做法

| | 做法 | 判决 |
| --- | --- | --- |
| **A** | 现在就给信封加 `hooks` 载荷位 | ❌ 撞 ADR-040 判据①(签名包里的可执行载荷),且 §2.4 的三道前置一道未过 |
| **B** | 现在就造「托管 hook = 我们起的子进程」 | ❌ ADR-040 允许这个**形态**,但它自己设的事件面前置未闭合(§2.4 第 1 条);且零客户 ⇒ 无样本 |
| **C** | 托管策略走签名包下发 | ❌ 语义相反:用户可卸载的载体承载不了「用户撤不掉的规则」(§2.3-C) |
| **D** | 复用上游 org 配置通道(`GET ${url}/api/config`) | ❌ 信任根是 opencode console,不是我们的租户体系(§2.3-B) |
| **E** | 把 managed 层从黑名单文法改成「默认拒 + 白名单」 | ❌ 今天没有需求驱动它;而且它会改变**每一个存量用户**的默认可用面。真需要时是一张独立的、带迁移的票 |
| **F** | **不动**(本文采纳) | ✅ ①②已在跑;③无客户无样本;真缺口(租户身份)与 hook 正交,应当在有客户时**先做身份、后谈 hook** |

---

## 4. 重开条件

**任一条命中即重开 `#1291`(或按它拆出的实现票),不要等四条齐。**

1. **第一个团队/公司客户签约**,或进入 POC 且把「管理员能压过成员设置」
   写进合同、安全问卷或采购清单。
   ⇒ 重开时**先做租户身份与下发(§5 的 T1/T2),不要先做 hook**。
2. **出现一条我们预置不了的托管规则** —— 即客户要表达的东西
   `managedCapDenies` 的黑名单文法说不出来,且 REQ-158 的分类轴也接不住。
   **这才是③(可执行 hook)第一次有真实样本。** 在此之前,托管规则一律走声明。
3. **§2.4 第 1 条的事件面缺口被填** —— 上游补上真 `Stop` / 真 `SessionEnd` /
   覆盖失败结果的 PostTool 契约,或给出结构化否决通道,或把 `permission.ask` 接上触发点。
   ⇒ 只影响③那一半,与①②无关。判据:重跑本文 §1.4 的两条轴 + 该文档 §5.2 的三项。
4. **ADR-040 判据①被改动**,或 [`#818`](https://github.com/jinjunnn/alpha-code/issues/818)
   裁决了 `packages/plugin` 的归属。

---

## 5. 今天不做,第一个团队客户来时要补什么

**先说不用补的**(这三样已经在跑,不因为等待而腐坏):

- 「压过用户设置」的合成语义与它的负向判据(`test/permission/alpha-tool-policy.test.ts`
  有「env 存在时系统 managed deny 仍生效」的负向闸);
- 执行咽喉的 fail-closed 与「deny 早于任何 hook / 任何副作用」;
- 坏输入的方向(managed 读不出 ⇒ 全部 disabled)。

**要补的,按依赖顺序**(写成票的形状,不写工期 —— 没有依据的工期是编的):

| | 内容 | 为什么现在做不了 |
| --- | --- | --- |
| **T1** | **租户身份进引擎**:把 `alpha-tool-policy` 的 partition account 从字面量 `"anonymous"` 换成真实账户/组织标识 | 引擎侧今天没有账户权威(源码自陈,`#1130` 承接一半) |
| **T2** | **平台侧租户策略的存储、下发与撤销**(`alpha-platform`),以及 `entitlement` cap 的**供数方**(今天类型位在、生产零来源) | 依赖 T1;且 `alpha-platform` 侧今天没有 tenant policy 概念 |
| **T3** | **管理员面**(`alpha-web`):规则的编辑、下发、审计与撤销 | 依赖 T2 |
| **T4** | 表达力扩档(若 §4 第 2 条命中):要么把 managed 文法从「只有 deny」扩到能说 ask,要么才谈可执行 hook | 依赖一个**真实规则样本** |
| **T5** | 若走可执行 hook:先补 §2.4 第 1 条点名的引擎事件面,再谈契约 | ADR-040 明写的准入条件 |

**代价的诚实形状:** T1–T3 是「从零到一」的三张跨仓票,**与 hook 无关**,
今天做或那天做**成本基本一样**(没有会随时间变贵的部分,因为要接的两端今天都不存在)。
T4/T5 才是会被「早做」浪费掉的部分 —— 没有样本就设计,大概率重做。
⇒ **等待的净代价接近零;提前做的净代价是 T4/T5 整个重来。** 这是本文推荐「暂不做」的算术依据。

**一条不能拖的例外:** §1.4 的 `permission.ask` 假接缝会**立刻**让 `#1285` 走错路。
它不属于本票的范围,但必须在 `#1285` 动笔前回写票面 —— 已在 §6 登记。

---

## 6. 本文对其它票面的影响(要回写的事实)

- [`#1285`](https://github.com/jinjunnn/alpha-code/issues/1285)(REQ-158):
  票面「`packages/plugin/src/index.ts:261` 已有 `permission.ask` hook ⋯ **接缝是现成的**」
  **不成立**(§1.4 两条轴实测)。分类结论应挂在
  `packages/opencode/src/permission/alpha-tool-policy-gate.ts` 的 `gateToolExecution`
  ——`Permission.ask` 之前唯一必经且真的在跑的 alpha 自有咽喉。
- [`docs/architecture/2026-08-23-codex-harness-comparison.md`](2026-08-23-codex-harness-comparison.md)
  §6 最后一条写「⇒ 托管 hook 是**裁决题**而非实现题(`#1291`)」——
  裁决已由本文给出;那条的前半句(信封无 `hooks` 表达位)仍然成立。
- 本文**不修改** ADR-040,也不解禁任何东西。ADR-040 的 hooks 之门在
  2026-08-03 就已由 owner 开着,本文只是登记「门开着,但门后的路今天不该走」。

## 来源

`#1291` 票面四问。全部坐标为 2026-09-08 在 `alpha-code@d5d2b493c` 上实读或实跑;
codex 侧读数来自本机安装的 `codex-cli 0.144.1` 二进制,凡未命中的一律标「未证实」。
