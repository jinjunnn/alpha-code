---
title: 引擎的 command 与事件面（勘破）
kind: architecture
status: active
owners:
  - alpha-code extension maintainers
last_reviewed: 2026-08-04
review_after: 2026-11-04
---

# 引擎的 `command` 与事件面

ADR-040 把扩展安装的唯一形态定为 Bundle，于是两件事成了地基：
**签名扩展包能不能表达 `command`**（`alpha-code#840`），以及
**将来支持 hooks 需要引擎有什么**（ADR-040 明写这是一次勘破，不是安全裁决 ——
在它落地之前，任何 hooks 实现票不得升 Ready）。

这份文档回答那两件事。**每条断言都来自实读或实跑**，凡未验证的一律标「未验证」。

> **实现状态（`#840`，2026-08-05）**：§1.4 的“没有安装路径”和 §1.5 的四-profile
> 对比记录的是本票开工前的勘破基线。A checkpoint 已选择 §1.5(b)：host 注册第五个
> `command` profile，模板按签名字节取回并严格 UTF-8 解码，事务写
> `alpha.jsonc.command.<name>`，更新/整包卸载删除同一叶；真实引擎 `GET /command`
> 验证安装可见、卸载不可见。旧 catalog 与本地导入仍不新增 command 路径。
> 跨仓发布必须继续经过 `alpha-web#147` 与 `alpha-code#853` 的固定 artifact pin；在
> re-vendor 前 consumer byte-identity 红灯是预期依赖门。

> 本仓记录在案最贵的返工形态是「**手写一个别人文法的替身**」——
> 手写别人的路由谓词、手写别人的 CLI 参数解析，连轮补丁都补不完，
> 直到照着**装着的那个版本的源码**重写才一次关掉全部反例。
> 所以下面凡涉及上游或第三方行为，读的都是本机装着的那份，不是官网、不是记忆。

## 0. 测量基准与口径

| | |
| --- | --- |
| 仓 | `alpha-code@8f411e77` |
| 上游插件接口 | `packages/plugin`（`@opencode-ai/plugin` 是指向它的软链，版本 `1.18.4`） |
| 真实插件语料 | `~/.claude/plugins/marketplaces/`，**62 个**含 `.claude-plugin/plugin.json` 的目录 |
| 语料夹具 | `packages/ui-mac/test-fixtures/claude-plugin-corpus.json`（⚠️ 只对 `SKILL.md` / `plugin.json` / `.mcp.json` 逐字保留，**其余文件是按 size/mode 还原的占位字节**） |

**夹具的盲区决定了本文的分工**：路径、扩展名、mode、数量可以从夹具证明；
**正文与文法必须从真实目录读**。下面 §3 的 hooks 契约全部来自真实目录。

---

## 1. 引擎的 `command`

### 1.1 配置形状

顶层是可选的字符串键 Record（`packages/core/src/v1/config/config.ts:41`）：

```ts
command: Schema.optional(Schema.Record(Schema.String, ConfigCommandV1.Info))
```

单条命令逐字字段（`packages/core/src/v1/config/command.ts:5`）：

```ts
{ template: string; description?: string; agent?: string; model?: string; variant?: string; subtask?: boolean }
```

⚠️ **`variant` 在 schema 里，但运行时不生效。**
`Command` 服务把配置转成运行时命令时只复制 `agent/model/description/template/subtask`，
**没有复制 `variant`**（`packages/opencode/src/command/index.ts:90`）。
`session.command` 请求本身另有一个 `variant` 字段（`packages/opencode/src/session/prompt.ts:1536`），
那是另一回事。⇒ **「配置里的 `variant` 会生效」今天没有源码支持。**
给 command 造 profile 时**不要把它写进合同**，否则我们会对外承诺一个上游不兑现的字段。

### 1.2 谁读、何时读、要不要重启

```text
ConfigPaths.directories → Config.loadInstanceState → ConfigCommand.load(dir)
  → Config InstanceState cache → Command.init → config.get() → Command InstanceState cache
```

- 搜索目录：全局 config、项目/祖先 `.opencode`、home `.opencode`、`OPENCODE_CONFIG_DIR`
  （`packages/opencode/src/config/paths.ts:23`）。
- 每个目录调用 `ConfigCommand.load(dir)`（`config/config.ts:416`、`:459`）。
- Config 按 instance directory 缓存（`config/config.ts:600`）；
  Command 首次 `get/list` 时初始化再按 directory 缓存（`command/index.ts:65`、`:159`）。

**既不是「每次会话读」，也不是「进程启动只读一次」**：每个 instance directory 第一次需要时懒加载并缓存，多个会话共享。

**直接改盘上文件不会触发重读。** 不需要重启整个 app，但必须 dispose/reload instance：
配置 API 更新后登记 dispose（`httpapi/handlers/config.ts:18`）、
显式 instance dispose（`handlers/instance.ts:24`）、
response 后真正 teardown（`httpapi/lifecycle.ts:43`）、
dispose 删缓存下次重建（`project/instance-store.ts:94`、`:108`）。

### 1.3 载荷位置：两种形态都支持

1. **JSON/JSONC 里的 `command.<name>`**，内容在 `template` 字段。
2. **盘上 Markdown** —— 加载器逐字扫描（`packages/opencode/src/config/command.ts:13`）：

```ts
Glob.scan("{command,commands}/**/*.md", { symlink: true })
...
template: md.content.trim()
```

命名规则是「去目录前缀、去扩展名」（`config/entry-name.ts:15`）：

```text
.opencode/command/hello.md         → command "hello"
.opencode/command/nested/child.md  → command "nested/child"
```

⚠️ **它不是 `SKILL.md` 那种「一命令一目录」，是一命令一个 `.md` 文件。**
frontmatter 由**安装版本的 `gray-matter`** 解析，失败时才跑上游自己的 colon sanitizer
（`packages/core/src/config/markdown.ts:3`）：

```ts
try { return matter(content) } catch { return matter(sanitize(content)) }
```

### 1.4 今天有没有「能装 command」的活路径

**必须拆成两个答案。这一节是 `#840` 范围的决定性依据。**

#### 有：项目级 `alpha_register`（让一条命令对用户可用）

```text
桌面解析 @alpha-code/ext bundle → 注入 OPENCODE_CONFIG_CONTENT.plugin[]
  → 上游 PluginLoader import() → 插件 tool map 暴露 alpha_register
  → 模型调用 alpha_register(type="command") → applyRegister 写 .alpha/alpha.jsonc 的 command.<name>
  → session.idle 后 instance.dispose() → 新 instance 的 config hook 读项目 alpha.jsonc
  → mergeProjectConfig 合入 cfg.command → Command.init 建表
  → command.list 出现在斜杠菜单 → session.command → SessionPrompt.command → prompt
```

逐跳证据：`main/alpha-ext-plugin.ts:28`、`main/server.ts:247`、
`main/alpha-config-injection.ts:96` 与 `:386`、
`opencode/src/plugin/loader.ts:76`/`:135`、`plugin/index.ts:177`、`tool/registry.ts:194`、
`ext/src/plugin.ts:210`、`ext/src/register.ts:15`(白名单，同样**没有 `variant`**)与 `:55`、
`ext/src/plugin.ts:226`(原子写)与 `:323`(idle 后 dispose)与 `:80`(重建时读项目文件)、
`ext/src/project-config.ts:117`/`:144`(`agent`/`command` 恒合入)、
`opencode/src/command/index.ts:90`、
`renderer/alpha-ui/composer-autocomplete.tsx:123`、`alpha-composer.tsx:1302`、
`httpapi/groups/session.ts:343` → `handlers/session.ts:331`、
`session/prompt.ts:1356`(展开 `$1`/`$ARGUMENTS`、shell 插值、选 agent/model)与 `:1460`。

#### 勘破基线（`#840` 之前）：签名 package / 旧 catalog / 本地导入都没有

| 入口 | 断点 |
| --- | --- |
| 签名 host package | registry 只有四个 profile（`host-extension-package.registry.v1.json:3`、`registry.ts:3`） |
| package 解码 | payload union 只有 skill/agent/mcp-local/mcp-remote（`decoder.ts:62`、`:187`） |
| package 路由 | profile→kind 表只有四项，未知 profile 具名拒绝（`ext-package-lifecycle.ts:55`）；admission 在此停止（`package-admission.ts:517`） |
| package builder | 分派只有 skill/agent/plugin-refusal/mcp（`package-admission.ts:708`） |
| 旧 catalog | `CatalogType` 与 `ManifestKind` 都无 command（`catalog-types.ts:8`、`ext-manifest-v2.ts:19`）；receipt 更**明确拒绝** catalog-origin command（`ext-receipt-v2.ts:224`） |
| 本地 Claude 插件导入 | `commands` 被列为 unsupported 并向用户显示「本版本不安装」（`claude-plugin-intake.ts:56`、`:128`、`:529`）；安装器只装预览里的 skill（`claude-plugin-install.ts`） |
| 文件夹 / git / agent 导入 | 生产接线只落到 `installUncuratedSkillImport` 或 `installUncuratedAgentImport`，无 command 分派（`ext-ipc.ts:1102`） |
| 旧 bridge | `alpha-bridge.ts:50` 的类型含 `commands`，但生产里只有 `unbridgeItem` 调用、**没有 `bridgeItem` 调用** ⇒ 不是活路径 |

⇒ **`ext-install-planner.ts:231` 的 `RECEIPT_TYPES` 含 `"command"`、`:2657` 有 `record.kind === "command"` 分支
这两条是弱证据，不构成安装路径。**（`plugin` 也曾同时出现在这两处，而它的安装路径已被具名拒绝，见 `:1113`。）

### 1.5 基线四个 profile 里谁最接近，以及 `#840` 采用的边界

物理载荷最接近 **`agent`**（`profiles/agent.v1.schema.json:15`）：`{targetDir, asset{sha256,bytes,mediaType,url}}`。
`skill` 信封结构相同但安装语义是目录/generation；两个 `mcp-*` 是纯结构化配置。

`#840` 采用的改动边界（四条，第 3、4 条是这次勘破真正的产出）：

1. **合同层**：以 agent 的 Markdown asset 信封为模板，改 schema 常量与 `targetDir` 语义；
   更新 registry、TS payload union、decoder 行为键与 profile 集合。
2. **admission / 账本层**：新增**真实的** `command` child kind、tx key、receipt/probe/uninstall/冲突判定
   与完整 builder 分支。**不能只让它落进已有的那个 `"command"` receipt token。**
3. **生效层选择 (b)**：
   - **未采用 (a)**：存原始 `.md`，放进引擎真的会扫的 `{command,commands}` 目录，
     让**安装版本的** `ConfigCommand.load → gray-matter` 解析；
   - **采用 (b)**：profile 直接携带结构化 `ConfigCommandV1.Info`，builder 写 `alpha.jsonc` 的 `command.<name>`，
     **完全不解析 Markdown**。
4. ⚠️ **不要复用 agent 的 frontmatter 转换器。** 它明说只认 Alpha 自有的受限文法
   （`main/agent-md-entry.ts:1`），**不是上游 command 的文法**。
   照它改 = 造第三套解析器 = 本仓最贵的那个形态。

---

## 2. 引擎的事件与钩子面

两条互相独立的检索轴：①安装版本的 `Hooks` 接口（`packages/plugin/src/index.ts:222`）；
②所有 `plugin.trigger(...)` 调用点。交叉之后 —— **声明 15 个命名钩子，其中 14 个有运行时触发点。**

### 2.1 ⚠️ `permission.ask` 声明了但永远不会被触发

`packages/plugin/src/index.ts:261` 声明了 `permission.ask: Permission → {status: ask|deny|allow}`，
**字面名在全仓另一条轴上只命中这一处声明，没有任何 `trigger` 调用点。**

⇒ **一个插件可以实现它、类型检查通过、而它一次都不会被调用。**
这是本仓登记在案的假闸形态在上游的实例：**「我留了个绊线」和「那个绊线会绊到人」是两件事。**
任何依赖它做权限决策的设计**当场作废**。

### 2.2 生命周期与派发语义

| 面 | 时机 | 运行语义 |
| --- | --- | --- |
| `config(cfg)` | 全部插件加载后（`plugin/index.ts:240`） | 可原地改 cfg；异常记录后忽略 |
| `event({event})` | EventV2 的 `location.directory` 等于当前 instance 时（`plugin/index.ts:251`） | **实收仅 `{id,type,properties:data}`**；不含 location/durable/metadata；**`void` 调用，不 await、不能否决** |
| `dispose()` | instance scope finalizer（`plugin/index.ts:261`） | await；错误记录后忽略 |
| `tool` | 建工具表时读取（`tool/registry.ts:194`） | 可增加自定义工具 |
| `auth` / `provider` | Provider OAuth / models（`provider/auth.ts:114`、`provider/provider.ts:1392`） | **只有上游 loader 拿得到（对象形，非函数）** |

命名 `trigger` **串行、共享可变 output**；异常会中止当前链/调用（`plugin/index.ts:280`）。

### 2.3 14 个活钩子

| 钩子 | 触发时机 | 关键载荷 / 能力 |
| --- | --- | --- |
| `chat.message` | 用户 parts 已解析、写入消息前（`prompt.ts:995`） | out `{message,parts}` —— **可改** |
| `chat.params` | 每次 LLM 请求准备参数时（`llm/request.ts:114`） | out temperature/topP/topK/maxOutputTokens/options |
| `chat.headers` | 同请求、header 发送前（`llm/request.ts:134`） | out `{headers}` |
| `command.execute.before` | 模板/参数/shell/agent/model/parts **全部解析后**、调 prompt 前（`prompt.ts:1460`） | in `{command,sessionID,arguments}`；out `{parts}` |
| `tool.execute.before` | 工具执行前；MCP 路径中**早于** permission ask（`session/tools.ts:402`） | out `{args}` —— 可改 args，**只能靠抛错否决** |
| `tool.execute.after` | 工具**成功返回后**（`session/tools.ts:121`） | out `{title,output,metadata}`；**失败路径不调用** |
| `shell.env` | shell/tool/PTY 创建进程前（`tool/shell.ts:416`） | out `{env}` |
| `experimental.chat.messages.transform` | 历史转模型消息前（`prompt.ts:1255`、`compaction.ts:350`） | out `{messages}` |
| `experimental.chat.system.transform` | system prompt 装入请求前（`llm/request.ts:68`） | out `{system}` |
| `experimental.provider.small_model` | 无 `small_model` 时选 fallback（`provider.ts:1883`） | out `{model?}` |
| `experimental.session.compacting` | compaction prompt 建立前（`compaction.ts:342`） | out `{context,prompt?}` |
| `experimental.compaction.autocontinue` | compaction 成功后、合成 continue 前（`compaction.ts:451`） | out `{enabled}` |
| `experimental.text.complete` | 每个 assistant text part 完成、持久化前（`processor.ts:512`） | out `{text}` |
| `tool.definition` | 本 turn 工具定义送给模型前（`tool/registry.ts:305`） | out `{description,parameters}` |

### 2.4 上游 loader 与 Alpha 项目 fan-out 的差别

- **上游 loader**：从 config origin resolve/install/entry/compatibility 后 `import()`
  （`plugin/loader.ts:76`、`:203`），能返回完整 `Hooks`。
- **Alpha 项目 fan-out**（`packages/ext/src/plugin-fanout.ts`）：只加载经 consent 的
  `<project>/.alpha/plugins/*.js`，**原始 TS 拒绝**（`:52`）；同一个 `PluginInput` 调用（`:81`）；
  `tool` 浅合并且 **Alpha 自有工具优先**，其余**函数型**键按 own→project 串行（`:18`、`:26`）；
  最终仍只返回一个合并后的 Hooks 给上游（`ext/src/plugin.ts:355`）。
  ⇒ 项目插件拿得到 `config`/`event`/`dispose` 与全部 14 个活钩子，也能加工具；
  **拿不到对象形的 `auth` / `provider`**。

### 2.5 EventV2：88 个注册事件，但插件看到的是删减版

公共原始形状是 `{id, type, data, durable?, location?, metadata?}`（`packages/schema/src/event.ts:29`），
而**插件的 `event` 钩子只收到 `{id, type, properties=data}`**。

分组：Session V1 **10** 个、Session Next **32** 个、其余 **46** 个（catalog/models-dev/integration/
file/permission/plugin/project/pty/question/todo/installation/lsp/tui/mcp/command/session-status/
vcs/workspace/worktree/server）。完整清单与逐条 `properties` 见本次勘破的原始记录。

**可达性边界（三条，设计时会咬人）**：
1. 插件 `event` **只收 `event.location.directory === current directory` 的 EventV2**（`plugin/index.ts:251`）。
2. `project.updated`、workspace/worktree、installation、server/global 等今天主要由 `GlobalBus` 或 SSE 直接发，
   **不经过这个插件 listener**。
3. `server.heartbeat` 与 `server.instance.disposed` 是**活的 transport 事件但不在那 88 个里**，
   同样不是插件 hook 事件。

---

## 3. Claude 的 hooks：真实语料实测

⚠️ **§1–§2 可以从仓内读出来，这一节不行** —— 语料夹具里 hooks 的内容是占位字节，
仓内也没有 Claude 的 hooks 实现源码。**本节全部来自 `~/.claude/plugins/marketplaces/` 的真实文件。**

### 3.1 规模：ADR-040 写的「12/62」要修正

| | |
| --- | --- |
| 有 `hooks/` 目录的插件 | **12 / 62** |
| **真正声明了 hook 的插件** | **7 / 62** |
| 另外 5 个 | `claude-for-financial-services` 那批，目录里各有 1 个文件但**没有任何声明** |

⇒ 谈影响面时用 **7**，不是 12。

### 3.2 事件名：实际用到 7 个，ADR-040 漏了一个

| 事件名 | 用它的插件数 |
| --- | ---: |
| `SessionStart` | 4 |
| `Stop` | 4 |
| `PostToolUse` | 2 |
| **`UserPromptSubmit`** | **2** |
| `UserPromptExpansion` | 1 |
| `PreToolUse` | 1 |
| `SessionEnd` | 1 |

⚠️ **ADR-040 列的六个名字里没有 `UserPromptSubmit`，而它在真实语料里比 `UserPromptExpansion` 还常用。**
凭记忆列别人的事件名，就会漏掉这种。

### 3.3 声明文法（实读，20 个 hook 条目）

落点是 `<plugin>/hooks/hooks.json`，形状：

```jsonc
{ "description": "...",
  "hooks": {
    "<EventName>": [
      { "matcher": "Edit|Write|MultiEdit|NotebookEdit",      // 可选，工具名的正则/或串
        "hooks": [
          { "type": "command",                                 // 实测 20/20 都是 "command"
            "command": "python3 \"${CLAUDE_PLUGIN_ROOT}/hooks/pretooluse.py\"",
            "timeout": 10,                                     // 秒
            "if": "Bash(git commit:*)",                        // 可选
            "asyncRewake": true, "rewakeMessage": "...", "rewakeSummary": "..." } ] } ] } }
```

实测到的键与出现次数：`type` 20、`command` 20、`timeout` **8**、
**`asyncRewake` 6、`rewakeMessage` 6、`rewakeSummary` 6**、`if` **5**、`matcher` 3。

**三条会让替身实现当场翻车的事实：**

1. **`if` 用的是 Claude 的权限规则文法**，不是布尔表达式 ——
   实测值:`Bash(git commit:*)` / `Bash(git push:*)` / `Bash(gt create:*)` / `Bash(gt modify:*)` / `Bash(gt submit:*)`。
2. **`asyncRewake` / `rewakeMessage` / `rewakeSummary` 是真实在用的键**（各 6 次）。
   一个照「基础文档」写的实现会**静默忽略**它们。
3. **`timeout` 的实测跨度是 180 倍**：`5` / `10` / `180` / **`900`**（codex 插件的 `Stop`）。
   **钉一个固定超时会直接打死真实插件。**

`matcher` 实测三种：`'Edit|Write|MultiEdit|NotebookEdit'`、`'Bash'`、`'^claude-security:claude-security$'`
—— 是**正则**，且能匹配带命名空间的工具名。

### 3.4 运行时契约（实读 hook 脚本）

| 项 | 实测 |
| --- | --- |
| 调用形态 | 由 shell 启动的外部进程。命令头分布：`bash` 12 / `python3` 4 / `node` 3 / `sh` 1 |
| `${CLAUDE_PLUGIN_ROOT}` | **命令串里唯一出现的环境变量**（29 次），且脚本内也用 `os.environ.get('CLAUDE_PLUGIN_ROOT')` 读它 ⇒ **它既被宿主展开进命令串，也作为环境变量传入** |
| **stdin** | **JSON 对象**。实测 `json.load(sys.stdin)`，字段含 `tool_name` 等 |
| **stdout** | **JSON 对象**。实测键 `systemMessage`；决策也走 stdout，不走退出码 |
| 退出码 | 实测样本（hookify 四个脚本）**恒 `sys.exit(0)`**，注释明写「never block operations due to hook errors」⇒ **该样本把退出码当作「我跑完了」，不当作决策通道**。<br>⚠️ **Claude Code 是否另有「exit code 2 = 拦截」这样的语义,本次未验证** —— 语料里没有反例可证 |
| 可执行位 | **入口脚本 755，被 import 的辅助模块 644**（如 `security-guidance/hooks/_base.py`） |
| 其它被读取的环境变量 | `CLAUDE_PROJECT_DIR`、`CLAUDE_CONFIG_DIR`、大量 `CLAUDE_CODE_*`（`security-guidance` 会机会性读取宿主内部变量）。**这些不是 hook 契约的一部分，是插件在窥探宿主** |

### 3.5 双峰影响（ADR-040 已登记，这里给实测归类）

- **整个存在意义就是 hooks**：`hookify`（`PreToolUse`/`PostToolUse`/`Stop`/`UserPromptSubmit`）、
  `ralph-loop`（`Stop`）—— 不支持 = **装了等于没装**。
- **配件级**：`codex`（`SessionStart`/`SessionEnd` + 一个 900s 的 `Stop` review gate）、
  `claude-security`（一个横幅）、两个 output-style（`SessionStart`）——
  损失是化妆品级到功能降级之间。
- **`security-guidance`** 介于两者之间：12 个文件、四个事件，主体价值在 hooks。

---

## 4. Claude 六（七）个事件名的诚实映射

**不为了凑齐而勉强配对** —— 勉强配对正是「手写别人文法的替身」。

| Claude 名 | 判定 | 引擎对应与差异 |
| --- | --- | --- |
| `PreToolUse` | **有强近似，非逐字等价** | `tool.execute.before`。在执行前、MCP 权限询问前，可改 args；**没有结构化 allow/deny，只能抛错中止**；只有 tool/session/callID 与 args |
| `PostToolUse` | **部分映射** | `tool.execute.after`。**只在成功返回后调用**；副作用已发生；**失败/取消没有对应 hook** |
| `Stop` | ❌ **没有** | `session.idle` / `session.status:idle` 只是事后观察事件，fire-and-forget，**不能阻止停止或要求继续**；`experimental.text.complete` 只是单个 text part 完成 |
| `SessionStart` | **只有窄观察类比** | `session.created` 在持久 Session 创建后发 `{sessionID,info}`；**不是每次打开/恢复的 start hook，不能修改或否决** |
| `SessionEnd` | ❌ **没有** | `session.deleted` 是显式删除；`session.idle` 是暂时空闲；`dispose` 是整个 directory instance 的生命周期。**三者都不是「会话运行结束」** |
| `UserPromptSubmit` | **部分映射** | 通用入口是 `chat.message`（parts 已解析、保存前，可改 message/parts）。**载荷/控制契约未经比对，未验证** |
| `UserPromptExpansion` | **部分映射** | 同上；斜杠命令另有 `command.execute.before`，但它发生在模板/参数/shell **全部展开之后**，且只覆盖 command |

---

## 5. 结论

### 5.1 `alpha-code#840`（command profile）的实施结论

**不是只补合同。** A checkpoint 已同时落下 profile/registry/decoder、command child/tx
identity、事务 builder、V3 账本、更新/整包卸载，以及真实引擎可见性门。生效层取
§1.5(b)：发布端负责 provider 语义映射，host 只把严格 payload 与经摘要验证、严格 UTF-8
的模板组成引擎 config 叶；**不复用 agent frontmatter 转换器**，**`variant` 不进合同**。

三个保守边界也已钉死：`init` / `review` / `customize-opencode` 在下载资产前拒绝；
未登记 live command 叶不认领不覆盖（锁内再查封 TOCTOU）；command 没有 disable 投影，
所以 `connection.unavailable` 导致的 disabled receipt 让整包具名 fail-closed。旧 catalog、
本地导入、bridge、migration、dual-read 与通用 profile framework 均不在本票内。

### 5.2 hooks 离「能诚实映射」还差什么

**引擎侧缺三样**：真正的 `Stop`（能阻止停止/要求继续）、真正的 `SessionEnd`（会话运行结束）、
以及**覆盖失败结果的 PostTool 契约**。此外**没有结构化否决/决策通道**（只能抛错）。
`permission.ask` 更是**声明了却永不触发**。

**契约侧已验证**：stdin JSON / stdout JSON / `${CLAUDE_PLUGIN_ROOT}` / `timeout` 秒且跨度 180 倍 /
`type` 恒为 `command` / `matcher` 是正则 / `if` 是权限规则文法 /
`asyncRewake` 三兄弟真实在用。**未验证**:退出码是否另有拦截语义、stdin 的完整字段表。

⇒ **ADR-040 要求的那次「事件面勘破」，本文档完成了引擎侧与语料侧;
「Claude 官方 hook 契约的完整文法」仍有两处未验证,写实现票前需补。**

### 5.3 最大的替身风险

**照 Claude 的 `commands/*.md` 自写 frontmatter/参数语法。**
夹具正文是占位字节、Alpha 的 agent parser 又是自有受限文法 ——
应当让**安装版本的** `ConfigCommand.load / gray-matter` 解析原文件，
或者定义**纯结构化** profile。**不要造第三套解析器。**

同样的风险在 hooks 上是：照六个事件名和「基础文档」写一个执行器，
而真实语料里有第七个事件名、有 `if` 的权限规则文法、有 `asyncRewake` 三兄弟、有 900 秒的超时。
