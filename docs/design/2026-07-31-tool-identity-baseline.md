---
title: 全来源工具 registry-derived inventory 与稳定 identity 方案基线
kind: design
status: accepted
owners:
  - alpha-code engine and contracts maintainers
last_reviewed: 2026-08-06
review_after: 2027-01-31
---

# 全来源工具 inventory 与稳定 identity — 方案基线

**Pinned commit**:`7799a5e60a75198ca8d84bfb151f2b46d784e8b4`(`alpha`,2026-07-31)。
本文所有 `file:line` 均在该提交上实读核对;换提交后行号可能漂移,但引用的符号名同时给出,
按符号名重新定位。

**决策票**:[jinjunnn/alpha-code#731](https://github.com/jinjunnn/alpha-code/issues/731)。
**消费票**:`#722`(REQ-125 展示方案)、`#724`(REQ-131 策略方案)。两票**引用**本文,
不重新定义 identity。**前置修复**:`#726`(别名碰撞 fail-closed)——本文把它从"补丁"
升级为"不变量",见 §2.4。

**状态**:`accepted`。owner 于 2026-08-06 批准本文三个裁决请求:收编 ADR、E5 纳入本轮、
I9 纳入同一 identity 校验面。接线实现仍须先落 §6.3 的收编 ADR。

---

## ① 大白话:这份文件在解决什么

今天这个产品里,一个工具在系统内部**没有名字**——它只有一个"模型看到的字符串"。
本地内置工具是 `bash` / `read`;MCP 工具是 `<服务器名>_<工具名>` 拼起来再把非法字符
换成下划线;插件工具是插件自己随便起的导出名。这三类**共用同一个字符串空间**,而且
拼接过程**不可逆**:拿到 `cloud_web_search` 这一个字符串,你无法确定它是服务器 `cloud`
的 `web_search`,还是服务器 `cloud_web` 的 `search`。

这带来三个用户能看见的坏结果:

1. **工具卡不知道自己在展示什么。** 时间线里持久化下来的工具调用记录
   (`ToolPart.tool`)只有那一个字符串,没有来源。所以卡片没法诚实地说"这是第三方
   MCP 服务器 X 提供的工具",只能按名字猜。
2. **策略会打到错的工具身上。** 权限规则也按同一个字符串键控。两个不同来源的工具
   拼出同一个字符串时,后注册的会**静默覆盖**前一个,而用户对其中一个的授权会应用
   到另一个。
3. **"永久允许"可能超授权。** 用户点"总是允许"时,系统把那个字符串**当成通配模式**
   存起来。工具名里若带 `*`,这条规则会顺带放行同服务器的一批别的工具(§2.7,本轮
   新查实)。

这份基线定一件事,并且只定这一件:**给每个工具一个由事实派生、可逆、跨全部执行路径
一致的身份**,然后让展示票和策略票都消费它,而不是各自再发明一次。

---

## ② 勘破:今天的地面真相(实读,带 `file:line`)

### 2.1 inventory 的真实来源共 **6 个**,不是 4 个

票面列了四类(内置 / Alpha Cloud MCP / 第三方 MCP / 插件动态)。实读枚举后是 6 个
**注册来源**,其中"插件动态"是两个机制不同的来源,另有一类引擎自造的伪工具:

| # | 来源 | 注册点 | 名字由什么决定 |
|---|---|---|---|
| S1 | 引擎内置(V1) | `packages/opencode/src/tool/registry.ts:204-244` | `Tool.define(<id>, …)` 的字面 id |
| S2 | 目录扫描插件工具 | `packages/opencode/src/tool/registry.ts:178-192` | `<文件基名>` 或 `<文件基名>_<导出名>` |
| S3 | Plugin 钩子工具 | `packages/opencode/src/tool/registry.ts:194-199` | **导出名原样,无任何命名空间** |
| S4 | MCP 工具(云与第三方**同一条路**) | `packages/opencode/src/mcp/index.ts:666-688` | `McpCatalog.toolName(server, name)` |
| S5 | MCP-resource 伪工具 | `packages/opencode/src/session/tools.ts:27-31, 140/222/305` | 三个硬编码常量 |
| S6 | 引擎内置(V2) | `packages/core/src/tool/registry.ts:85-105` + `packages/core/src/tool/application-tools.ts` | `register()` 的 Record 键 |

两条必须写进基线的事实:

- **"Alpha Cloud MCP"在引擎里不是一个独立来源。** 它就是一台普通的 remote MCP
  server,只是 server 名与 URL 由 alpha 在注入面自己写死并核验
  (`packages/ext/src/cloud-websearch-kill.ts:195-275`,`computeMcpOwnership`)。
  identity 层**不得**为它开特例;"是不是 alpha 治理的云"是 identity 之上的一个
  **属性**,由已存在的端点身份核验产出,不是 identity 的组成部分。
- **S3 完全没有命名空间。** 两个插件各导出一个 `search`,就是同一个 id,数组里两条
  (`registry.ts:253` 的 `[...builtin, ...custom]`),而下游写 Record 时后者覆盖前者
  (`session/tools.ts:99`)。**custom 排在 builtin 之后**,所以一个插件导出 `bash`
  会把内置 shell 从模型工具表里挤掉,静默、无日志。

### 2.2 模型可见别名今天不是一一映射

```
packages/opencode/src/mcp/catalog.ts:117  sanitize  = v => v.replace(/[^a-zA-Z0-9_-]/g, "_")
packages/opencode/src/mcp/catalog.ts:119  toolName  = (client, name) => sanitize(client) + "_" + sanitize(name)
```

`_` 既是分隔符**又在允许字符集内**,且 `sanitize` 把所有非法字符**折叠成同一个** `_`。
两个方向都不单射:

- 跨 server:`foo.bar` + `baz` 与 `foo_bar` + `baz` → 同一个 `foo_bar_baz`;
- 同 server:`srv` + `a.b` 与 `srv` + `a_b` → 同一个 `srv_a_b`。

两处消费点按该别名写 Record 且**静默覆盖**:

- `packages/opencode/src/mcp/index.ts:684` — `result[McpCatalog.toolName(clientName, def.name)] = {…}`
- `packages/opencode/src/tool/code-mode.ts:120-131` — `tree[entry.server][entry.local] = …`

**而元组在覆盖发生的那一行仍然是完整的**:`index.ts:674-685` 的循环同时握着
`clientName` 与 `def.name`。identity 必须在这里铸造,而不是事后从别名反推。

### 2.3 Code Mode 反向拆解别名 —— 手写别人文法的替身

`packages/opencode/src/tool/code-mode.ts:39-56`(`groupByServer`)拿 sanitize 后的
server 名列表,用"最长前缀 + `_`"去把已经折叠的别名拆回 `server` / `local`:

```ts
const server = byLongest.find((name) => key.startsWith(name + "_"))
  ?? (key.includes("_") ? key.slice(0, key.indexOf("_")) : key)
```

这是一个**结构性错误**,不是边界 bug:折叠已经丢了信息,任何字符串谓词都补不回来。
`packages/ext/src/cloud-websearch-kill.ts:277-297` 面对同一个问题时选择了正确的姿态——
收集**全部**候选归属、任何歧义一律 fail-closed,并在注释里明写"不谎称穷尽"。
本基线把这一姿态从"边界模块的自保"提升为"全局不变量":**任何地方都不得从别名反推来源**。

### 2.4 `#726` 是本基线的不变量,不是它的补丁

`#726` 让别名碰撞时 fail-closed。本文把它重述为一条基线不变量(**I1**,见 §7),
因为一旦 identity 存在,碰撞就从"两个工具打架"变成"别名↔身份不再是双射"——那是
展示与策略同时失真的根因,必须在装载期就红。

### 2.5 权限键空间 ≠ 工具键空间(两个空间今天被混在一起)

内置工具**不按工具 id 键控权限**,而是各自在 `execute` 里传一个硬编码权限串:

| 权限串 | 传入点 | 对应工具 |
|---|---|---|
| `read` | `tool/read.ts:256` | `read` |
| `edit` | `tool/edit.ts:103,146`、`tool/write.ts:55`、`tool/apply_patch.ts:207` | `edit` / `write` / `apply_patch` **三合一** |
| `bash` | `tool/shell.ts:284`(`ShellID.ToolID`) | `bash`(工具 id 本身也是 `bash`,见 `tool/shell/id.ts:17`) |
| `glob` / `grep` / `lsp` / `webfetch` / `websearch` / `todowrite` / `skill` | 各自工具 | 一一对应 |
| `external_directory` | `tool/external-directory.ts:36`、`tool/shell.ts:271` | **没有对应工具** |
| `doom_loop` | `session/processor.ts:373` | **没有对应工具** |
| `workflow_tool_approval` | `session/llm.ts:190` | **没有对应工具** |
| `task` | `tool/registry.ts:263`(`Permission.evaluate("task", …)`) | `task`,但 pattern 轴是**子 agent 名** |

`Permission.disabled`(`permission/index.ts:286-296`)在此之上再折一次:

```ts
const edits = ["edit", "write", "apply_patch"]
const reads = ["list_mcp_resources", "list_mcp_resource_templates", "read_mcp_resource"]
const permission = edits.includes(tool) ? "edit" : reads.includes(tool) ? "read" : tool
```

⇒ 今天**表达不了**"只禁用 `apply_patch`、保留 `edit`",也表达不了"只禁用
`read_mcp_resource`、保留 `read`"。

配置侧则完全开放:`packages/core/src/v1/config/permission.ts:17-36` 是
`StructWithRest(…, [Schema.Record(Schema.String, Rule)])` —— **任意字符串**都能当 key,
只是有 14 个已知键有类型提示。注意其中 `bash` 与工具 id 同名属巧合(`shell/id.ts:14-17`
明写"保持 `bash` 以兼容"),而 `list` 这个已声明键**今天没有任何工具或调用点使用**。

### 2.6 执行咽喉实测是 **7 处**,票面列了 5 处

用 `plugin.trigger("tool.execute.before")` 与直接 `execute(` 两条互相独立的检索轴交叉
枚举(单跑一条正则会漏——`prompt.ts` 那两处不经 `SessionTools.resolve`):

| # | 咽喉 | 位置 | 解析方式 | 权限键 |
|---|---|---|---|---|
| E1 | 内置 + 插件(模型工具表) | `session/tools.ts:92-134` | `registry.tools()` → `tools[item.id]` | 工具自己传的硬编码串 |
| E2 | 三个 MCP-resource 伪工具 | `session/tools.ts:140-385` | 各自独立 `execute` | 恒为 `"read"`,server/uri 落在 **pattern** 轴 |
| E3 | MCP 工具 | `session/tools.ts:390-490` | `mcp.tools()` 的别名 | `permission: key` = **别名** |
| E4 | Code Mode 子调用 | `tool/code-mode.ts:134-186` | `groupByServer` 反解 | `permission: entry.key` = **别名** |
| E5 | Workflow executor(DWS) | `session/llm.ts:127-153` | `prepared.tools[toolName]` | 预批名单按 `Wildcard` 匹配别名(`llm.ts:150-153`) |
| **E6** | **Subtask 直呼 task 工具** | `session/prompt.ts:255-345` | `registry.named()`,**绕过 `registry.tools()` 的可见性过滤** | 自建 `ask` |
| **E7** | **附件摄取直呼 read 工具** | `session/prompt.ts:808-828` | `registry.named()` | **`ask: () => Effect.void`**,权限整个被短路,且 `bypassCwdCheck: true` |

E6 / E7 是本轮新查实的,票面的五路枚举漏掉了它们。二者都可达:E6 由用户在 composer
里唤起子 agent 触发(`prompt.ts:1145`),E7 由用户拖入文件附件触发。

**处置(本基线的裁决)**:

- **E6 进入 identity 管辖**。它产出一条真实的 `ToolPart`(`prompt.ts:283-300`),用户在
  时间线上看得见,展示票必须能解析它。
- **E7 不进入 identity 管辖,但必须被命名。** 它不是模型发起的工具调用,不写
  `ToolPart`,是宿主为了把附件读成文本而复用了 `read` 的实现;给它加策略闸会直接
  打断附件上传(用户可观察的功能倒退),这不是本票要解决的问题。**但**它的存在意味
  着任何"我们枚举了全部 `execute` 入口"的断言都是假的——所以它以一条负向判据的形式
  固定下来(§7 的 **I6**)。

**E5 的额外事实**:`llm.ts:150-153` 用 `Wildcard.match(name, rule.permission)` 直接拿
**模型可见名**去撞权限规则,这是第 8 个把别名当权限键的地方,且它**不经过**
`Permission.ask`,而是自己算了一份"预批名单"。identity 落地时这一处必须同步,否则会
出现"策略面已收紧、workflow 面仍按旧别名预批"的假闸门。

### 2.7 `Wildcard` 的文法会吃掉工具名里的字符(本轮新查实)

`packages/core/src/util/wildcard.ts:3-14`:

```ts
const normalized = input.replaceAll("\\", "/")
let escaped = pattern.replaceAll("\\", "/")
  .replace(/[.+^${}()|[\]\\]/g, "\\$&")   // 转义正则元字符,但不含 * ? /
  .replace(/\*/g, ".*").replace(/\?/g, ".")
if (escaped.endsWith(" .*")) escaped = escaped.slice(0, -3) + "( .*)?"
return new RegExp("^" + escaped + "$", process.platform === "win32" ? "si" : "s").test(normalized)
```

三条后果,每条都直接约束 identity 的编码规则:

1. **`*` 与 `?` 在 pattern 侧是通配符。** 而"总是允许"存下来的规则里,
   `permission` 字段**就是 pattern 侧**:`permission/index.ts:228-232` 把
   `existing.info.permission` 原样存进 `approved`,`evaluate`(`:88`)再用
   `Wildcard.match(permission, rule.permission)` 拿它当模式。⇒ **一个名字里带 `*`
   的工具,一旦被"总是允许",会连带放行同前缀的一批别的工具。**

   今天的可达性(如实分级,别当成已实锤的在野漏洞):MCP 别名侥幸安全,因为
   `sanitize` 恰好把 `*` 换成了 `_`;V1 插件工具的 id **不经过任何校验**
   (`tool/registry.ts:184-199` 无 `validateName`,与 V2 的
   `core/tool/tool.ts:134-137` 形成对照),但插件工具是否把自己的 id 传给 `ask` 由
   插件自己决定(`registry.ts:120-176` 只透传 `ctx.ask`,不代调)。**真正的要害是
   前瞻的**:本方案的 canonical 会携带**未 sanitize** 的远端 server 名与工具名,
   若不转义 `*`/`?`,就是亲手把一个远端可控的通配符送进权限模式轴。转义因此不是
   防御性冗余,而是这条编码规则成立的前提。
2. **`\` 被规范成 `/`。** ⇒ `a\b` 与 `a/b` 在权限层不可区分。
3. **Windows 上是大小写不敏感**(`"si"`),macOS 上敏感。⇒ 同一份配置在两个平台上
   行为不同(alpha 出 Windows 包,ADR-026)。

### 2.8 持久化面只留别名

`packages/schema/src/v1/session.ts:315-322`:`ToolPart` 只有 `tool: Schema.String`,
没有来源字段。写入点 `session/processor.ts:241,339` 与 `session/prompt.ts:289` 写的都是
模型可见名。⇒ **展示票今天在数据层面就拿不到来源**,这不是 UI 的问题。

### 2.9 V2 侧的对照(已经做对了两件事)

- **有名字文法**:`packages/core/src/tool/tool.ts:134-137`,
  `/^[A-Za-z][A-Za-z0-9_-]{0,63}$/`,注册期拒绝非法名。
- **权限键默认等于工具名**:`packages/core/src/tool/tool.ts:148`
  `permission = (tool, name) => runtimeOf(tool).permission ?? name`。
- **同名注册是栈不是覆盖**:`packages/core/src/tool/registry.ts:93,109`(`at(-1)` 生效,
  scope 结束按 token 摘除)——比 V1 的静默覆盖好,但**仍然是"后来者赢"**,且
  `ApplicationTools.register`(`application-tools.ts:35-37`)是纯 `Map.set` 覆盖。
- 目录过滤同构:`registry.ts:112-113` + `whollyDisabled`(`:132-135`)。

结论:V2 的名字空间比 V1 干净,但**没有来源概念**,同样无法回答"这个 `search` 是谁的"。

### 2.10 明确排除:provider-hosted / provider-executed 工具(已复核)

`packages/llm/src/schema/messages.ts:224-232` 的 `ToolDefinition` 无 provider 变体;
`packages/llm/src/protocols/anthropic-messages.ts:505-522` 的 `fromRequest` 把
`request.tools` 全部经 `lowerTool` 下发为 function tool,无旁路。⇒ 票面的排除成立,
**走我们自己的代码到不了那个状态**,本基线不为它留任何结构。

---

## ③ 决定:identity 的构成与可逆反解

### 3.1 identity 是结构化元组,不是字符串

```
ToolIdentity = {
  source : "builtin" | "builtin-v2" | "plugin" | "mcp" | "host"
  origin : string     // 来源内部的出处键,见下表
  name   : string     // 该出处**原样**的名字,不 sanitize、不翻译、不折叠
}
```

| source | origin | name | 铸造点 |
|---|---|---|---|
| `builtin` | `""` | `Tool.define` 的 id(`bash`/`read`/…) | `tool/registry.ts:204-244` |
| `builtin-v2` | `""` | `ApplicationTools.register` 的 Record 键 | `core/tool/application-tools.ts:43-52` |
| `plugin` | 目录扫描:文件基名;Plugin 钩子:插件标识 | 导出名 | `tool/registry.ts:184-199` |
| `mcp` | MCP server 的**配置键原文**(未 sanitize) | 远端 `tool.name` 原文 | `mcp/index.ts:674-685` |
| `host` | `""` | `list_mcp_resources` / `list_mcp_resource_templates` / `read_mcp_resource` / `execute` | `session/tools.ts:27-31`、`tool/code-mode.ts:12` |

**三条硬性约束**(违反其一即方案失效):

1. **identity 只在元组仍然完整的那一行铸造**,即上表"铸造点"。此后只传递,不再派生。
2. **任何地方不得从模型可见别名反推 identity。** 现有的
   `code-mode.ts:39-56` 与 `cloud-websearch-kill.ts:277-297` 是两处已知的反推,前者
   由本方案删除并改为读 `entry.identity`,后者的收窄声明保持不变但改为消费 identity。
3. **展示标题、翻译、图标、`tier` 标签一律不进 identity。**

### 3.2 规范字符串形式(可逆)

需要一个字符串形式,因为权限规则、配置文件、时间线记录都是字符串通道。

```
canonical(id) = id.source + ":" + pct(id.origin) + ":" + pct(id.name)
pct(s)        = s 中的 % : * ? \ / 逐字符替换为 %25 %3A %2A %3F %5C %2F
```

**转义集为什么正好是这六个**(每一个都有实读依据,不是防御性多写):

| 字符 | 必须转义的理由 |
|---|---|
| `%` | 转义标记本身;不转义则 `pct` 不单射 |
| `:` | 字段分隔符;`mcp:a:b:c` 否则无法确定切在哪 |
| `*` `?` | `wildcard.ts:7-8` 在 pattern 侧把它们变成 `.*` / `.`,而 canonical 会被当作 pattern 存进 `approved`(§2.7 第 1 条) |
| `\` `/` | `wildcard.ts:4-5` 把 `\` 规范成 `/`,不转义则 `a\b` 与 `a/b` 同一(§2.7 第 2 条) |

**反解**:按未转义的 `:` 切成**恰好 3 段**(转义后原文里不可能再出现 `:`),逐段
`%XX` 还原。段数 ≠ 3 或出现非法 `%` 序列 ⇒ **拒绝,不猜**。

**单射性证明义务**:`pct` 是单射(转义集互不重叠且以 `%` 领起),字段数固定为 3,故
`canonical` 单射。这条**必须有测试**(§7 **I2**),不是靠这段散文。

`mcp` 的 origin 与 name **不 sanitize**,是刻意的:sanitize 是"给模型看"的投影,把它
写进身份就等于把信息丢失固化进身份。

**先例**:同样的"转义分隔符与转义标记"手法,仓内已有一处
——`mcp/catalog.ts:104-105` 的 resource key(`%` → `%25`,`:` → `%3A`)。本方案沿用
同一形态并补齐 wildcard 文法要求的四个字符。

### 3.3 别名与身份的一一映射:由**账本**保证,不由文法保证

保持 `McpCatalog.toolName` 现状(模型侧仍看到 `srv_tool` 这类短名——改模型可见名是
产品决策,不是本票的 identity 问题),但把映射**登记下来**:

```
AliasLedger = {
  byAlias    : Map<string, ToolIdentity>   // 模型可见名 → 身份
  byIdentity : Map<string, string>         // canonical → 模型可见名
}
```

- 账本在**工具表装配的同一次遍历**里构建(E1/E2/E3/E4 各自的来源循环)。
- **装配期双射校验(fail-closed)**:同一别名映射到两个不同 canonical ⇒ 整表装配失败,
  loud 报错并拒绝提供该来源的工具。这就是 `#726` 的要求,在本方案里成为不变量 **I1**。
- **附加校验**:两个 canonical 仅大小写不同 ⇒ 同样拒绝。理由在 §2.7 第 3 条:否则同
  一份配置在 Windows 与 macOS 上的策略结果不同,而这种差异不会以任何方式暴露给用户。
- 消费方**只查账本**,永不解析别名。

### 3.4 一句话总纲

> **身份由来源铸造,别名是身份的投影;投影可以有损,反向查表不得有损。**

---

## ④ 与既有 permission / 目录过滤钩子的衔接(不另起一套)

**不新建**三态、不新建 wildcard、不新建合并优先级、不新建目录过滤机制。identity 只
改变"键是什么",不改变"怎么判"。

### 4.1 权限判定引擎:零改动

`Permission.evaluate` / `merge` / `Wildcard.match`(`permission/index.ts:84-94,282-284`)
一行不动。三态 `allow|ask|deny`、`findLast` 后者优先、`ruleset.flat()` 合并顺序全部
保持。

### 4.2 权限键改为 canonical(只改传入值,不改结构)

| 咽喉 | 今天传的 `permission` | 改为 |
|---|---|---|
| E3 MCP(`session/tools.ts:408`) | 别名 `key` | `canonical(identity)` |
| E4 Code Mode(`code-mode.ts:147`) | 别名 `entry.key` | `canonical(entry.identity)` |
| E5 Workflow 预批(`llm.ts:150-153`) | 别名 | `canonical(identity)` |
| E1 内置(各工具内) | 硬编码能力串 | **不变**,见 §5 |
| E2 MCP-resource(`tools.ts:181,264,344`) | `"read"` | **不变**,见 §5 |

**免费得到的作用域能力**:因为 canonical 的第二段是 server 原文的转义形式,而
`evaluate` 的 permission 轴本来就走 wildcard,用户写
`"mcp:github:*": "deny"` 就是"禁掉整台 github server",`"mcp:*": "ask"` 就是"所有 MCP
工具都要问"。**这不需要任何新代码**,只需要 canonical 的分段是稳定的。作用域的产品
形态由 `#724` 决定,本文只保证机制存在且不需要第二套引擎。

### 4.3 目录过滤钩子:改键,不改位置

`session/llm/request.ts:208-214`(`resolveTools`)是模型目录的最终过滤钩子。它今天做
两件事:`Permission.disabled(Object.keys(tools), …)` 与 `input.user.tools?.[k] !== false`。

- `Permission.disabled` 的入参从"别名数组"变为"(别名, identity) 对",内部按 §5 的
  两轴判定;
- `user.tools`(`packages/schema/src/v1/session.ts:352`,per-request 的布尔开关表)
  **保持按模型可见名键控** —— 它是同一次请求内客户端自己发来的、与它自己刚拿到的
  工具表配对的开关,不跨会话持久化,引入 identity 只会增加一层不必要的翻译。**这是
  一条明确的已知边界**,不是遗漏。

V2 侧同构:`core/tool/registry.ts:112-113` 的 `whollyDisabled(permission(tool, name), …)`
本来就已经"权限键默认 = 工具名",改为 `permission(tool, canonical(identity))` 即可,
形状不变。

### 4.4 持久化面:`ToolPart` 加一个字段

`ToolPart`(`packages/schema/src/v1/session.ts:315-322`)新增
`identity: Schema.optional(ToolIdentitySchema)`。

- `optional` 是因为**历史消息里没有它**;
- 读取侧对缺失一律降级为"未知来源"并如实呈现,**不猜**——这与
  `tool-card-model.ts:97-98` 现有的 `kind = TOOL_CARD_KINDS.get(tool) ?? "unknown"`
  fail-closed 姿态一致;
- 本 portfolio 无真实用户、无租户,不做兼容 shim;`optional` 仅仅承认"旧行里没有",
  不是为了兼容一个需要维护的旧契约。

---

## ⑤ 内置工具的硬编码权限串与 `Permission.disabled` 的折叠

**裁决:保留能力轴,新增身份轴,两轴并存。不把能力串改写成 identity。**

理由三条,每条都对应一个"改了会坏"的实事:

1. **能力串里有三个根本不对应任何工具的动作**:`external_directory`
   (`tool/external-directory.ts:36`、`shell.ts:271`)、`doom_loop`
   (`processor.ts:373`)、`workflow_tool_approval`(`llm.ts:190`)。它们是宿主行为的
   审批点,不是工具。把权限键统一成 identity 会让这三条**无处安放**,直接丢掉三个
   现有审批闸。
2. **能力轴表达得了 identity 表达不了的东西**:`"edit": "deny"` 的语义是"任何会改
   文件的动作都禁",它天然覆盖将来新增的第四个写工具。identity 轴只能逐个点名,
   对新成员默认**放行**——按「枚举对新成员默认放行,咽喉对新成员默认拒绝」的判据,
   这里的咽喉正是能力轴,不能拆。
3. **`edit|write|apply_patch` 折成一个单位是刻意的**:`registry.ts:292-295` 决定
   `apply_patch` 与 `edit`/`write` 对同一个模型**互斥上架**。用户看到的是"编辑文件"
   这一件事的两种实现,拆开单独禁用没有可解释的产品语义。

**因此新增的表达能力**是:`Permission.disabled` 在能力串判定之外,再查一次
`canonical(identity)` 的规则;两轴任一给出 `pattern === "*" && action === "deny"` 即
隐藏。这样:

- `"edit": "deny"` → 三个写工具一起消失(**行为不变**);
- `"builtin::apply_patch": "deny"` → 只隐藏 `apply_patch`(**新增能力**);
- `"builtin::read": "allow"` 不能反向撬开 `"read": "deny"` —— 两轴是**与**关系,任一
  禁用即禁用。这是唯一安全的合成方式:允许一轴覆盖另一轴,等于给了两条互相绕过的路。

**明确记为已知限制(不在本票修)**:

- L1:`Permission.ask` 的三个 MCP-resource 伪工具仍共用 `"read"` 能力串,
  "只禁 `read_mcp_resource`"需要用身份轴写 `"host::read_mcp_resource": "deny"`;
  能力轴上仍然表达不了。
- L2:`task` 工具的 pattern 轴语义是**子 agent 名**(`registry.ts:263`),与其他工具的
  pattern 语义(路径 / `mcp:server:uri`)不同构。identity 不改变这一点。
- L3:E7(附件摄取)完全绕过权限,两轴都管不到(§2.6)。

---

## ⑥ 表面边界:哪些落在 alpha 自有面,哪些必须收编 ADR

### 6.1 `alpha-check.sh` 实测(不是推断)

在本分支上放置四个探针,跑 `bash scripts/alpha-check.sh`(worktree 已用
`scripts/worktree-link-deps.sh` 装好真依赖,非软链假红环境):

| 探针 | 结果 |
|---|---|
| 修改 `packages/opencode/src/mcp/catalog.ts` | **守卫红**,逐名列出该文件 |
| 修改 `packages/plugin/src/tool.ts` | 守卫绿(`packages/plugin` 不在 `UPSTREAM_PATHS`) |
| 修改 `packages/ext/src/register.ts` | 守卫绿(alpha 自有包) |
| **新增** `packages/opencode/src/alpha-probe-new-file.ts`(已 `git add`) | **守卫绿** |

第四条是关键:守卫谓词是 `git diff --diff-filter=DMR`
(`scripts/alpha-check.sh:74-76`,与 `.github/workflows/alpha-ci.yml` 同源),
**D/M/R 三态,不含 A**。⇒ 在受守包内**新增**文件机制上放行。这不是漏洞的发现,
而是既定设计:`alpha-check.sh:66-68` 的 ADR-035 注释明写"新增文件不触发
`--diff-filter=DMR`,无需 exclude",仓内已有 5 个先例(全部在 `packages/opencode/test/`
下,`git ls-files packages/opencode | grep alpha`)。

### 6.2 边界结论

| 改动 | 落点 | 阶梯(ADR-029) | 需要 ADR? |
|---|---|---|---|
| `ToolIdentity` 类型 + `canonical`/`parse` + 账本 + 双射校验 | **新增**文件,`packages/opencode/src/tool/alpha-tool-identity.ts` | L0(只增不改) | 否 |
| identity 的判据测试 | **新增**文件,`packages/opencode/test/tool/alpha-tool-identity*.test.ts` | L0 | 否(有 5 处先例) |
| 展示层消费(工具卡按来源分支) | `packages/ui-mac/**` | L0 | 否 |
| 云 server 归属核验改为消费 identity | `packages/ext/src/cloud-websearch-kill.ts` | L0 | 否 |
| **在 6 个铸造点写入 identity**(`mcp/index.ts:684`、`tool/registry.ts:184-244`、`session/tools.ts:27-31,99`、`core/tool/application-tools.ts`) | 修改上游文件 | **L3** | **是** |
| **7 处咽喉改权限键**(`session/tools.ts:408`、`code-mode.ts:147`、`llm.ts:150-153`、`session/prompt.ts:283-345`) | 修改上游文件 | **L3** | **是** |
| **`Permission.disabled` 加身份轴**(`permission/index.ts:286-296`) | 已是 ADR-038 接管面 | L3 **已收编** | 扩写 ADR-038 范围即可 |
| **`resolveTools` 改键**(`session/llm/request.ts:208-214`) | 修改上游文件 | **L3** | **是** |
| **`ToolPart` 加 `identity` 字段**(`packages/schema/src/v1/session.ts`) | 修改上游文件 | **L3** | **是** |
| **删除 `groupByServer` 反解**(`code-mode.ts:39-56`) | 修改上游文件 | **L3** | **是** |

### 6.3 因此:方案可实施,但必须先过一条收编 ADR

**低级别不可行的勘探证据**(ADR-029 §3 要求诉求方先给出):

- **L0 插件钩子够不够?** 不够,且是结构性的:
  - `"tool.definition"` 只在 `tool/registry.ts:313` 触发一处,**MCP 工具根本不经过它**
    (E3/E4 都不调用),所以插件面看不见 MCP 工具的定义期;
  - `"tool.execute.before"` 的入参是 `{ tool: string }`
    (`packages/plugin/src/index.ts:266-268`),**只有别名**;要从别名恢复身份,就是
    §2.3 那个已被证伪的反解;
  - `config` 钩子只能拿到 server 名,**拿不到远端工具名**(工具名要连上服务器
    `listTools` 才知道)。
  ⇒ 插件面在任何时刻都拿不到 `(source, origin, name)` 三元组的完整形态。
- **L0 新增文件够不够?** 类型、编码、账本、校验、测试都能落在新增文件里(§6.2 前四行),
  但**没有任何上游文件会 import 它** —— 装配点在上游文件内部,不改上游就接不上线。
- **L1 变换层够不够?** 不够:要改的是运行期数据结构的构造,不是产物文本。
- **HTTP 面能不能绕开?** 不能:`packages/opencode/src/server/routes/instance/httpapi/groups/`
  下 21 个 group **没有任何一个暴露工具清单**;`mcp.ts` 只暴露 server 的 status/connect,
  不含 `listTools` 结果。要新增一个 inventory 端点,同样是改上游。

**结论**:本方案的**机制部分**(§3 全部、§7 的 I1–I4)可以先在 L0 落地并被测试守住;
**接线部分**必须走一条新 ADR(建议编号 ADR-040,标题「工具身份与来源账本收编」),
逐文件枚举接管面:`mcp/index.ts`、`tool/registry.ts`、`session/tools.ts`、
`tool/code-mode.ts`、`session/llm.ts`、`session/prompt.ts`、`session/llm/request.ts`、
`schema/src/v1/session.ts`、`core/tool/registry.ts`、`core/tool/application-tools.ts`,
并载明 L3 单向门代价(这批文件此后不再白嫖上游)。**这条 ADR 是实现票的硬前置,
owner 已于 2026-08-06 批准该收编方向;**ADR 落地仍是接线实现的硬前置。**

---

## ⑦ 判据:identity 方案怎么被测试守住

判据先于实现。每条都写明"改回旧行为后哪条变红",没有反向判据的断言不算闸门。

| # | 不变量 | 测试形态 | 反向判据(把生产代码改回旧行为 ⇒ 必须红) |
|---|---|---|---|
| **I1** | 别名双射:同一别名不得映射两个 canonical | 装配两个 server(`foo.bar`+`baz` 与 `foo_bar`+`baz`)⇒ 装配 loud 失败 | 去掉双射校验 ⇒ 后者静默覆盖前者,断言"抛错"变红 |
| **I2** | `canonical` 单射且可逆 | 属性测试:随机 `(source, origin, name)` 三元组,`parse(canonical(x)) === x`;并断言两个不同三元组不产生同一字符串 | 从转义集里删掉任意一个字符(如 `:` 或 `*`)⇒ 存在反例,变红 |
| **I3** | 转义集覆盖 wildcard 文法 | 用 `Wildcard.match(canonical(A), canonical(B))`:`A ≠ B` 时恒 false,含名字带 `*` `?` `\` `/` 的用例 | 把 `*` 移出转义集 ⇒ 工具名 `foo*` 的规则会匹配 `foobar`,变红 |
| **I4** | 大小写:仅大小写不同的两个身份被拒绝 | 注册 `mcp:srv:Tool` 与 `mcp:srv:tool` ⇒ 装配失败 | 去掉大小写校验 ⇒ Windows 分支下同一规则命中两者,变红 |
| **I5** | **7 条咽喉解析到同一对象**(rebind) | 同一 identity 分别经 E1–E6 解析,断言解析结果 `===` 同一注册对象;E7 单独断言**不参与**(见 I6) | 让任一条咽喉退回按别名解析 ⇒ 构造一个别名碰撞场景,该咽喉解析到另一个对象,变红 |
| **I6** | E7 的边界是**显式**的,不是遗漏 | 断言 `prompt.ts` 的附件路径不经过 identity 解析,且该断言带注释指向本文 §2.6 | 有人把 E7 也接进 identity 而不改本文 ⇒ 断言变红,强制回来改文档 |
| **I7** | rename:远端工具改名 = 新身份,旧授权**不继承** | 同一 server 上 `search` → `search_v2`,断言旧的 `always` 规则不命中新身份 | 若 identity 退回按展示名或按序号 ⇒ 旧规则命中新工具,变红 |
| **I8** | 动态增删:运行期 `mcp.add` / `disconnect` 后账本一致 | 增一台 server → 账本含其全部工具;断开 → 全部移除,且不影响其他 server 的身份 | 把账本改成一次性快照(不随 `s.clients` 重算)⇒ 断开后仍能解析,变红 |
| **I9** | 插件工具遮蔽内置工具时**不静默** | 插件导出 `bash` ⇒ 装配 loud 失败(而不是像今天那样顶掉内置 shell) | 恢复 `[...builtin, ...custom]` 的静默后写 ⇒ 断言变红 |
| **I10** | **禁止别名反解**:仓内不存在从别名切分来源的代码 | 机械检查:`groupByServer` 一类的前缀切分谓词不得存在(按符号 + 按 `startsWith(name + "_")` 两条独立检索轴) | 把 `groupByServer` 加回来 ⇒ 检查变红 |

**落点**:I1–I4、I10 落 `packages/opencode/test/tool/alpha-tool-identity.test.ts`(L0 新增,
无需 ADR);I5–I9 需要接线后才有被测对象,随收编 ADR 的实现票落地。

**测试自身的绕过演练**(judgement discipline):每条闸门写完后,先把生产代码改回旧
行为跑一遍,确认真的红;只断言"新行为对"而旧行为也能过的测试,按本 portfolio 的判据
是空闸门,不计入交付。

---

## ⑧ 被否决的替代方案

| 替代 | 否决理由 |
|---|---|
| **A. 把别名本身变成身份**(改 `toolName` 的分隔符,如用 `.` 或空格) | 模型可见名要满足 V2 名字文法 `^[A-Za-z][A-Za-z0-9_-]{0,63}$`(`core/tool/tool.ts:134-137`),还要满足各 provider 对函数名的限制;把身份塞进这个窄空间必然再折叠一次。而且它把"给模型看"和"给策略用"两个目标绑死在一个字符串上——今天的病根正是这个绑定 |
| **B. 用哈希做身份**(`sha256(server, name)` 前 N 位) | 不可逆。展示票要显示"来自服务器 X 的工具 Y",策略票要支持 `mcp:github:*` 这类作用域,两者都需要**反解**。哈希还把碰撞从"可检测"变成"概率性" |
| **C. 用注册序号 / 自增 ID** | 跨进程、跨重启不稳定;MCP server 重连后顺序可变 ⇒ 用户的持久化授权会漂到别的工具上,这是最坏的一种失效 |
| **D. 只在展示层加来源,策略层不动** | 两票会各自再定义一次映射,正是 owner 2026-07-31 裁决要消灭的形态;且策略层的碰撞(§2.2)不修,展示再准也只是把错的策略显示得更清楚 |
| **E. 在 `packages/ext` 里做一个"影子 inventory"**,靠插件钩子拼 | 已在 §6.3 逐条证伪:插件面结构上拿不到三元组。做出来只能是第三个手写文法的替身 |
| **F. 把内置工具的能力串全部改成 identity** | §5 三条理由:会丢掉三个无对应工具的审批闸、会让能力轴对新工具默认放行、`edit/write/apply_patch` 的合并是刻意的产品语义 |

---

## ⑨ 交给消费票的接口(两票只消费,不重定义)

- **`#722`(展示,REQ-125)**:消费 `ToolPart.identity`;`source` 决定卡片的来源徽标,
  `origin` 决定"哪台服务器/哪个插件",`name` 决定展示的工具名。缺失 `identity` ⇒ 按
  `tool-card-model.ts:97-98` 现有的 `unknown` fail-closed 路径呈现,**不得**按别名猜来源。
  字段 allowlist 与 redactor 由 `#722` 自己定,identity 三段一律视为**不可信外部输入**
  (`origin`/`name` 来自远端 server)。
- **`#724`(策略,REQ-131)**:消费 `canonical(identity)` 作为权限键;三态、作用域、
  默认值、Settings 形态由 `#724` 定。本文只保证:键是稳定的、可逆的、跨 7 条咽喉一致的,
  且不需要第二套判定引擎。
- **`#726`(别名碰撞 fail-closed)**:本文把它升格为不变量 **I1**;`#726` 的实现应当
  直接产出账本的双射校验,而不是另写一份碰撞检测。

---

## ⑩ Owner 裁决(2026-08-06)

1. **批准收编 ADR(§6.3)。** 机制部分可按 §6.2 先行;任何接线实现必须先由该 ADR
   精确收编列出的上游表面。
2. **E5(workflow executor)纳入本轮。** `session/llm.ts` 的 workflow 预批名单必须改用
   canonical identity,不得留下按旧别名预批的旁路。
3. **I9 纳入本轮,不拆票。** 插件遮蔽内置工具与 I1 共用装载期双射/遮蔽校验,冲突必须
   loud 失败,不得静默覆盖。

三项均已终判,本文不再保留 owner 开放点。展示与策略消费票仍只消费本文定义,不重开
identity 设计。
