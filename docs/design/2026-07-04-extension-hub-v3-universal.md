---
type: design
slug: extension-hub-v3-universal
date: 2026-07-04
status: approved-direction # 2026-07-04 用户拍板 D1–D5(见 §9);REQ-018~022 已登记 BACKLOG,实现分期按需求档推进
relates: ADR-014, ADR-019, ADR-021, ADR-002, ADR-005, ADR-006, ADR-015, ADR-018
---

# 定制中心 v3:全类型通用化 · `.alpha` 落盘 · 云集成 · 自动化 —— 全面体检与优化方案

> **一句话结论**:定制中心的骨架(catalog、MCP 全链路、创建表单、安装确认)是好的,但「通用性」只对 MCP 成立——skill/agent/plugin 装完**不可见、不可管、且多数场景下引擎根本没装载**(实例缓存无重扫);安装落点全部写进与原生 opencode 共享的 `~/.config/opencode`,与 ADR-019 的 `.alpha` 战略脱节;详情页不存在;云能力对定制中心完全不可见;「自动化」只有两个孤儿 i18n key。本方案给出:统一安装账本 + `.alpha` 双层真源 + 「重载引擎」生效机制 + 逐类型详情页 + 云集成 + 自动化(定时任务)MVP,分 4 期落地。

---

## 0. 体检总表(现状 vs 目标)

| 能力 | MCP 连接器 | Skill | Agent | Plugin | 套件 | 云能力 | 定时任务 |
|---|---|---|---|---|---|---|---|
| 浏览(catalog) | ✅ 8 条 | ⚠️ 6 条(4 条内容未打包) | ❌ 无 tab | ✅ 1 条 | ✅ 5 条 | ❌ 不可见 | ❌ 无 |
| 安装 | ✅ 全链路 | ⚠️ 仅 builtin 2 条真能装 | ❌(只能创建) | ✅ 写 config | ⚠️ 扇出无明细 | — | — |
| **装完引擎真的能用** | ✅ 即时(mcp.add) | ❌ 实例缓存,不重启不生效 | ❌ 同左 | ⚠️ 提示重启但无一键 | ⚠️ 混合 | — | — |
| 已安装可见 | ✅ mcp.status | ❌ 永远显示「添加」 | ❌ | ❌ | ❌ | — | — |
| 卸载/启停 | ✅ | ❌ | ❌ | ❌ | ❌ | — | — |
| 更新 | ❌ | ❌ | ❌ | ❌ | ❌ | — | — |
| 详情/介绍页 | ❌(仅确认弹窗) | ❌ | ❌ | ❌ | ❌ | ❌ | — |
| 密钥安全 | ❌ 明文进 jsonc | — | — | — | — | ✅({file:}) | — |
| 落盘位置 | `~/.config/opencode`(共享根) | 同左 | 同左 | 同左 | 同左 | — | — |

---

## 1. 现状事实基线(2026-07-04 勘探,file:line 为证据锚)

### 1.1 UI / IA
- 单文件组件 `renderer/extensions/extension-hub.tsx`(881 行),Portal 覆盖内容区(`extension-hub.css:15-28`),7 个 tab:推荐/连接器/技能/插件/套件/已安装/创建(`extension-hub.tsx:28-38`)。**没有 Agent tab**,Agent 只存在于「创建」表单。
- catalog = 打包静态 `alpha-catalog.json`(20 条:MCP×8、skill×6、plugin×1、bundle×5),图标/配色硬编码在组件(`extension-hub.tsx:43-83`),无任何远程刷新(`remoteIndexUrl` 类型存在、零消费)。
- **已安装真相源只有 `mcp.status`**:`isInstalled` 对 skill/plugin/bundle 永远 false(`use-extensions.ts:212-215`)→ 卡片永远「添加」、已安装 tab 永不列出、无法卸载。
- 详情页不存在:卡片主体不可点,唯一信息面 = 安装确认 Dialog(`extension-hub.tsx:809-876`)。
- 导入(文件夹/Git/npm)三卡全是 `comingSoon` 占位(`extension-hub.tsx:773,780,792`)。
- 错误呈现基本走 Toast(瞬态);Banner 只用于 mcp.status 整表加载失败(`extension-hub.tsx:513-520`)。
- 侧栏只有 3 项导航;「自动化」是**孤儿 i18n key**(`zh.ts:42-43`,零组件引用)。

### 1.2 落盘与安装链路(主进程)
- 三个写盘根:**根 A** = XDG opencode 全局配置(`OPENCODE_CONFIG_DIR` > `XDG_CONFIG_HOME/opencode` > `~/.config/opencode`;`ext-config.ts:50-58`、`ext-fs-installer.ts:18-25`,REQ-017 已统一);**根 B** = Electron userData;**根 C** = 项目 `.alpha/`(仅云 run 回流,`alpha-workdir.ts`)。
- 定制中心所有安装**全部写根 A**:MCP/plugin/provider → `opencode.jsonc`;skill → `skills/<name>/SKILL.md`;agent → `agent/<name>.md`。**没有任何一处写 `.alpha`**;项目根 `.opencode/` 是上游维护者自用内容,与安装无关(用户此前印象有误)。
- **MCP 的 `environment`/`headers` 值明文写进 opencode.jsonc**(`ext-config.ts:106-122`),不入钥匙串、不走 `{file:}`;而渲染层文案宣称「密钥入钥匙串」且写错路径为 `~/.opencode`(`zh.ts:82`)——双重失实。
- REQ-004 的 symlink 桥**只有 spike 证据,无生产代码**(全 main/preload/shared 零 symlink 生产调用)。
- 安全守卫齐全:safeResolve/realpath、ALLOWED_TOP_KEYS(mcp/plugin/provider)、命令头白名单、URL https-only、DANGEROUS_ENV、EVAL_FLAGS(`ext-config.ts:20-48,129-142`)。

### 1.3 引擎接缝(上游只读事实,决定「装完能不能用」)
- **无文件监听**:六类原语全部装在 `InstanceState`(按 directory 缓存,`instance-state.ts:26-45`),首次访问物化一次;**丢文件进磁盘 ≠ 生效**,需实例 reload 或 server 重启。`PATCH /config` 会 `markInstanceForDisposal`(`handlers/config.ts:18-22`),但会写出 `config.json` 副作用文件,不宜借用。
- skill:扫 `.claude/.agents` 外部目录 + 各 config 目录 `{skill,skills}/**/SKill.md` + **`skills.paths[]`(绝对路径已核实支持,`skill/index.ts:210-220`)**;经系统提示 `<available_skills>` + `skill` 工具暴露;按 agent permission 过滤。
- agent:各 config 目录 glob `{agent,agents}/**/*.md`(**`symlink:true`**,`config/agent.ts:11-32`);**config `agent` 键存在**且字段齐全(model/prompt/permission/mode/hidden,`v1/config/agent.ts:12-41`);`{file:}`/`{env:}` 是**整份 config 文本级替换**(`config/variable.ts:33-91`)→ 注入的 agent 可用 `prompt:"{file:绝对路径}"`。内置 agent(build/plan/general/explore)硬编码于引擎,无 md 文件。
- command:glob `{command,commands}/**/*.md`;config `command` 键存在;**MCP prompt 与 skill 会自动变成 command**(`command/index.ts:105-152`)。
- plugin:config `plugin[]` 接受 npm 包名 / 绝对路径 / file:// URL(`config/plugin.ts:42-60`),npm 包引擎后台自装(`config.ts:437-456`);每实例装一次,无热重载。
- MCP:config shape = `mcp: Record<name, Local|Remote>`(Local:`command:string[]`+`environment`;Remote:`url`+`headers`+`oauth`);SDK 有 `status/add/connect/disconnect/auth`;`mcp.add` 内存即时生效不落盘;首次访问时**并发连接全部 enabled server(无上限)**(`mcp/index.ts:491-528`,启动风暴根因之一)。**没有任何路由/SDK 方法能列出某 server 的 tools**(`MCP.instructions()` 有 tools 数组但只喂系统提示,未暴露 HTTP)。
- 配置装载:`OPENCODE_CONFIG_CONTENT` 按 V1 schema 以 local 源参与 merge(`config.ts:467-475`);V1 顶层未知键 hard-fail(`parse.ts:41-53`)。**home 级 `~/.opencode/` 也是原生扫描根**(`config/paths.ts:23-41`)——这是全局 symlink 桥的天然挂点。
- permission 可静态配死(ask 全部可消除):`read/edit/bash/webfetch/doom_loop/external_directory` 等均可 `allow|deny`(`v1/config/permission.ts`,agent 级合并 `agent/agent.ts:277-293`)→ **无人值守运行可行**。
- 上游几乎不自带可安装内容:1 条内嵌 skill(customize-opencode)、内置 agent 硬编码、command 只有 init/review。**"从 opencode 搬内容"不成立;能搬的是生态内容(经 catalog 供给)**。上游另有引擎内 MCP registry(`mcp/index.ts:703 McpCatalog.fetch`),可作 V2 目录补充源(需核实其稳定性)。

### 1.4 云接缝
- A 侧:`dispatchCloudJob` 是薄透传(`alpha-cloud-jobs.ts:47-48`);**ADR-021 §2 三项硬校验(1MB 帽/secrets 扫描/denied_paths 默认注入)未实现**(ADR-021:32 白纸黑字,随 B3 记账)。`mcp.cloud` 经 `injectAlphaConfig` 注入(仅 platform 模式 + token `{file:}`,`sidecar.ts:201-213`);回流 `cloud-save-run` → `.alpha/runs/` 完整可用。
- B 侧:MCP 四工具 `cloud_dispatch/status/await/artifacts`(`gateway/src/cloud.ts:333-416`);envelope = `pipeline{kind,input}` | `bounded-agent{objective,capabilities}` + budget(≤50 iter/≤500k tok/≤1800s)+ constraints(`cloud-contract.ts`);pipeline live:research / **code-review(PA-22)** / docs;Tier-2/3 走 CF Sandbox。
- **两侧都没有任何定时/调度设施**(无 wrangler crons、无 QStash;CF Workflows 是按 job 的 durable 执行)。
- 定制中心与登录态**零耦合**(hub 全文无 `window.api.auth` 引用);远程 catalog 零实现(E10 registered,阻塞 C 仓端点)。

### 1.5 既有账目(勿重复登记)
- REQ-006(ADR-014 转正 + O1–O4 拍板)ready;D4(skill 已安装态)ready;D5(playwright 内核实测)ready;E11(目录筛选)ready;E2/E5/E6/E8/E10 registered;B16(consent)parked;REQ-011(composer 预留位)待拍板。BACKLOG next-REQ = **REQ-018**。
- 本方案吸收 D4、E11、REQ-006 的 O2(Agent/Command 进 tab)并给出裁决建议;不与其冲突。

---

## 2. 纰漏清单(按严重度;— 为本方案修复所在期)

**P0(伪装可用 / 安全)**
1. **装完不生效且无提示**:skill/agent/command 写盘后引擎实例缓存不重扫 → 「创建成功」toast 后实际不可用(时灵时不灵:仅当实例尚未物化时才碰巧生效)。违反反 placebo 纪律(C28 精神)。— M1
2. **MCP 密钥明文进 jsonc** + 文案谎称入钥匙串 + 路径写错(`~/.opencode`)。— M1
3. **已安装真相只覆盖 MCP**:skill/plugin/bundle/agent 装完即失管(无已装态/卸载/更新);无安装账本,fs 类卸载无据可依。— M1
4. **落盘根与战略脱节**:全部写共享 `~/.config/opencode`,污染用户原生 opencode 环境;`.alpha`(ADR-019)完全未接;无项目级安装 scope。— M1

**P1(产品能力缺口,对应你的目标 1/2/4/5)**
5. Agent 无 tab、无 catalog、无列表:创建后不可见;composer 侧 agent 选择器是否存在待核。— M1
6. 详情/介绍页不存在;无数据边界披露(哪个连接器会把什么发到哪)。— M2
7. catalog 6 条 skill 中 4 条(Anthropic 官方)内容未随包 → 「诚实失败」但目录承诺>兑现。— M1
8. 无更新机制(catalog 钉版本 bump 后存量安装成孤儿;T1.5 旧账)。— M2
9. plugin「需重启」全靠用户手动重启 app,无一键;plugin 已装态不检测(config 数组未解析)。— M1
10. 导入(文件夹/Git/npm)占位。— M2
11. 云不可见:mcp.cloud 连接器不在 hub、无登录态引导、pipeline(code-review 等)无入口;ADR-021 §2 校验缺位。— M3
12. 自动化/定时任务从 0 到无(本地、云两侧均无调度设施)。— M4

**P2(打磨/债)**
13. catalog 纯静态;E10 远程刷新无签名方案。— M3
14. MCP tools 清单引擎无路由可查(需 catalog 元数据 + 主进程按需探测)。— M2
15. 图标/配色硬编码在组件;搜索切 tab 即清空;hub 开合态不持久;bundle 扇出失败只报计数无逐项重试。— M2
16. `_verify` 未核项(playwright 内核=D5、github/feishu/yuque/notify)。— 随 M1 验收
17. 大量 enabled MCP 会在首访问时无上限并发连接(启动风暴已有前科)。— M1 文案+默认策略缓解
18. (顺带观察,非 hub)userData 仍用 `ai.opencode.desktop.*`,与 bundle id `com.tide.alphacode` 不一致——支持文档/排障心智负担,另行立项。

---

## 3. 你提出的五个问题——直接回答

1. **通用性**:目前只有 MCP 是真通用。根因两个:①「已安装/卸载」只有 MCP 有真相源;②引擎按实例缓存、无重扫——fs 类(skill/agent/command/plugin)装完必须**重载引擎**才生效,而 UI 既不重载也不告知。方案 = 安装账本(receipts)+ 统一生效矩阵 +「重载引擎」一键(见 §4.1/4.3)。
2. **介绍页**:应该有,且**每类都要**(§5.3)。你说的「plugin 由哪些 skill/agent/连接器组成」——在 opencode 语义里那是**套件(bundle)**,不是 plugin(引擎 plugin = hooks+tools 的 JS 模块,装不了 skill/agent);套件详情页列组合清单,plugin 详情页列 hooks/工具/重启要求。MCP 详情页列 tools:引擎没有查询路由(事实 §1.3),用「catalog 精选元数据为主 + 主进程按需真连探测为辅」两级方案。
3. **安装目录**:现状是 `~/.config/opencode`(XDG 全局),**不是**项目根 `.opencode`(那是上游维护者自用)。目标 = **`.alpha` 双层真源**:项目级 `<项目>/.alpha/*` + `.opencode` symlink 桥(REQ-004 已实证);全局级新增 `~/.alpha/*` + 桥(两种桥法二选一,§9-D1)。**opencode 自带内容基本没有可搬的**(引擎只有 1 条内嵌 skill、硬编码 agent、2 条内置 command;仓库根 `.opencode` 是生 TS 维护工具,桌面态会崩,ADR-006)——内容供给靠 catalog:Anthropic Apache-2.0 skills(补打包)、官方 MCP、社区 plugin(甄别+钉版本)、alpha 自研。
4. **云集成**:云连接器(mcp.cloud 四工具)与云 pipeline(research/code-review/docs,B 侧已 live)进 hub 成为一等公民条目,登录态门控 + 数据边界披露;远程 catalog(E10)与 ADR-021 §2 硬校验随之落地(§6)。
5. **定时任务**:做,叫「自动化」,入口在侧栏定制中心下方(i18n key 已备好)。本地调度器 MVP(应用运行时执行、只读权限档、结果落 `.alpha/runs/`、通知+历史);真·离线云端定时是 B 仓工作(CF Workers cron triggers,当前无),列为后续(§7)。

---

## 4. 目标架构

### 4.1 统一实体与安装账本(receipts)
- `ExtensionItem = { id, type: mcp|skill|agent|command|plugin|bundle|cloud, scope: global|project, version, source, license }`。
- **新增安装账本**:`~/.alpha/installs.json`(全局)与 `<项目>/.alpha/installs.json`(项目),每条 receipt = `{ id, type, scope, version, installedAt, files[]|configKey, origin: catalog|created|imported }`。
  - 用途:fs 类卸载依据、更新对比(receipt.version vs catalog.version)、「已安装」补全(plugin/skill/agent)、迁移审计。
  - **引擎可见性真相仍以 SDK 为准**(mcp.status / app.skills / app.agents / command.list):receipts 说「装了什么」,SDK 说「引擎认了什么」,两者差集 = 「待重载」状态——这正是 P0-1 的可视化。

### 4.2 落盘方案:`.alpha` 双层真源 + 双桥(零改上游)
| 类型 | 项目级(scope=project) | 全局级(scope=global,默认) |
|---|---|---|
| skill/agent/command | `<项目>/.alpha/{skills,agents,commands}/` + `<项目>/.opencode/<类>/` 内 symlink(REQ-004 实证 6/6;目录链可用,tool 需逐文件链) | `~/.alpha/{skills,agents,commands}/` + 桥(D1 拍板:推荐 `~/.opencode/<类>` symlink——引擎原生扫描根,与项目级同构;备选 config 注入 `skills.paths[]`/`agent`/`command` 键) |
| plugin(自包含 JS) | `.alpha/plugins/` + config 注入绝对路径(项目级少见,可后置) | `~/.alpha/plugins/<name>/index.js` + 注入 `plugin[]` 绝对路径(生产已验证的通道);npm 型 plugin 保留包名进 `plugin[]`(引擎自装) |
| MCP | 写 `<项目>/.opencode/opencode.jsonc`(引擎原生、进项目 git 由用户定;密钥一律 `{file:}` 引用不落明文) | **(T2 实现修订 2026-07-04)**写 `~/.opencode/opencode.jsonc`(文件通道,实例 reload 可见)+ receipts 记 provenance;**不设 `~/.alpha/connectors.json`**(jsonc 即持久层,再加一份=双真相漂移面);运行时仍用 `mcp.add` 即时生效 |
| tool | 不单独开放安装(ADR-006:必须预 bundle;能力经 plugin/ext 供给) | 同左 |
- **迁移**:首次升级检测根 A 中 alpha 写入的存量(receipts 反推 + catalog 名单匹配),一次性弹「迁移到 .alpha」清单确认;`ALPHA_LEGACY_INSTALL_ROOT=1` 逃生保持旧行为。
- 不动用户自建的 `.opencode` 内容(ADR-019 §4);目录已存在时桥退化为逐文件 symlink。

### 4.3 生效矩阵:免重启、装完即用(2026-07-04 修订,应用户「免重启」要求)

**新事实(已核)**:上游暴露公开端点 **`POST /instance/dispose`**(SDK `sdk.gen.ts:1927-1950`,handler `handlers/instance.ts:25` 调 `markInstanceForDisposal`,响应发出后释放实例)与 **`POST /global/dispose`**(`sdk.gen.ts:1344-1350`,释放全部实例);实例释放后**下一个请求自动重建**(InstanceStore 惰性物化)→ 重扫 skill/agent/command/plugin/tool 并重读全部 config **文件**。会话在 SQLite 不受影响;系统提示与工具集**每条消息重组**(`system.ts:96-106`、`session/tools.ts:385`)→ 重建后当前会话的下一条消息即可用。**「重载引擎」(sidecar respawn)从主机制降级为兜底。**

| 类型 | 生效 | 机制 | UI 承诺 |
|---|---|---|---|
| MCP | ✅ 即时(当前会话下一条消息) | `mcp.add`+`connect`(内存,现状已是) | 「已连接,立即可用」 |
| skill / agent / command | ✅ 下一条消息 | 写盘 → 安装动作自动调 `instance.dispose`(项目级)/`global.dispose`(全局级)→ 下次请求重建重扫 | 「已安装,立即可用」;无 badge、无重启 |
| plugin(本地自包含 JS) | ✅ 下一条消息 | 文件 + config 文件通道 → dispose 重建时挂载 hooks | 同上 |
| plugin(npm 型) | ⚠️ 半即时 | dispose 后引擎后台 npm install(`config.ts:437-456`),首次生效等下载(国内走 mirror) | 诚实进度:「安装中,首次启用需下载依赖」 |
| 套件 | 逐项按上表 | 全部落盘后一次 dispose | 明细逐项状态 |

**配套约束(免重启成立的前提)**:
1. **持久化必须走「文件通道」而非 env 注入**:`OPENCODE_CONFIG_CONTENT` 在 sidecar fork 时冻结,reload 读不到新增——因此**全局 MCP/plugin 的引擎侧持久化改写 `~/.opencode/opencode.jsonc`**(home `.opencode` 本就是引擎 config 源,`config/paths.ts:23-41`;`~/.alpha/connectors.json` 仍为真源,write-through)。injectAlphaConfig 仅保留 identity/behavior/ext bundle/mcp.cloud 等 alpha 系统件。
2. **dispose 守卫**:目标实例有进行中的流式回复/云任务时延后触发(打断风险);全局安装若多项目开着,用 `global.dispose` 一次刷全。
3. **respawn 兜底仅剩三种场景**:ext bundle 更新、secrets/注入内容变更、dispose 路径失效(逃生)。**禁止**借 `PATCH /config` 触发(副作用写 `config.json`,已核 `config.ts:623-630`)。
4. **待实测(REQ-018 T2 spike 子项)**:dispose→重建耗时;对活跃 PTY 终端/SSE 的影响面;MCP 重连风暴(重建首访问并发连全部 enabled server,`mcp/index.ts:491-528`)→ 保持精简启用集(修 P2-17)。

### 4.4 密钥处理(修 P0-2)
- MCP `requiredEnvVars` 在详情页/安装页用密文输入,值写 `userData/alpha-secrets/<VAR>`(0600,既有通道)——config 里只落 `environment: { VAR: "{file:...}" }`(整文本替换引擎已生产验证)。项目级 jsonc 同样只落 `{file:}` 引用,**任何 config 文件不再出现明文密钥**。
- 文案修正:删「入钥匙串」误导、改 `~/.opencode` 为实际路径、注明「密钥保存在本机 alpha 安全存储」。

### 4.5 术语澄清(进 GLOSSARY)
- **插件(plugin)** = opencode 引擎插件(hooks + 自定义工具),不能包含 skill/agent;详情页展示 hooks/工具/重启要求。
- **套件(bundle)** = alpha 的组合安装清单(可含 MCP+skill+plugin+agent);详情页展示组合与逐项状态。UI 在两处 tab 副标题各加一行说明,消除与 Claude Code「plugin=大礼包」的心智冲突。

## 5. UX/UI 交互规范(alpha-ui 设计系统,`--a-*`)

### 5.1 IA 重构:hub 内左侧竖栏(替代 8+ 横向 tab)
```
┌────────────┬──────────────────────────────────────────────┐
│ 浏览        │  [搜索框(全局持久,不随分区清空)] [筛选:分类|来源|许可证]│
│  ◦ 推荐     │                                              │
│  ◦ 连接器   │   卡片网格 / 列表                              │
│  ◦ 技能     │   (点击卡片主体 → 右侧滑入详情二级页)            │
│  ◦ Agent   │                                              │
│  ◦ 插件     │                                              │
│  ◦ 套件     │                                              │
│ 管理        │                                              │
│  ◦ 已安装(n)│                                              │
│  ◦ 有更新(n)│                                              │
│ 构建        │                                              │
│  ◦ 创建     │                                              │
│  ◦ 导入     │                                              │
│ 云          │                                              │
│  ◦ 云能力   │  (登录态门控)                                 │
└────────────┴──────────────────────────────────────────────┘
```
- 保持 Portal 覆盖内容区(ADR-014 既定);Esc 逐级返回(详情→列表→关闭);hub 记住上次分区(session 内)。
- E11(分类/许可证筛选)在此实现;搜索跨全部类型,结果按类型分组。

### 5.2 卡片与安装状态机
- 卡片 = 图标 + 名称 + 一句话 + 来源 chip(官方/社区/alpha)+ 类型 pill + 状态区。
- **状态机(卡片与详情页共享)**:
  `未安装 →(添加)→ 依赖检查中 → 安装中(spinner)→ ①已安装·已生效(✓绿) / ②已安装·待重载(琥珀,附[重载引擎]) / ③失败(红,行内错误+[重试],不再只弹 toast)`
- 成功用 toast(瞬态即可);失败一律**行内呈现**(卡片错误 chip / 详情页 Banner),对齐 B11 反静默纪律。
- 已装条目的「添加」变「打开详情」;套件卡片显示「n/m 已装」。

### 5.3 详情页规范(点击卡片 → hub 内二级页,顶部返回)
**通用头部**:图标·名称·来源·许可证·版本(catalog 钉版)·verified 标记(`_verify` 未核项显示「待核实」而非隐藏)。
**通用区块**:简介(markdown)→ 类型专属区(下表)→ **数据边界**(该条目会把什么数据发往哪里:remote MCP 列 host;本地命令型标「仅本机」;云条目引 ADR-021)→ 运行时依赖(**详情页内实时 which 检测**,缺失显示安装指引,不再等到点添加才发现)→ 所需密钥(密文输入,存 alpha-secrets)→ 操作区(安装/卸载/更新/启停/重载)。

| 类型 | 专属区块 |
|---|---|
| MCP | **提供的工具列表**(M2 起 catalog 精选元数据 `tools[]`;V2 增「实时探测」按钮=主进程 MCP client 真连拉 tools/list);transport(local 命令 / remote URL);启用范围(全局/本项目) |
| Skill | SKILL.md 全文渲染;触发说明(description);安装目标目录 |
| Agent | 系统提示预览(折叠);model/variant;权限档摘要(读/写/bash/网络);mode(primary/subagent) |
| Plugin | 注册的 hooks 清单、贡献的工具(catalog 元数据);npm 包名@版本;「需重载引擎」徽标;风险说明(运行于引擎进程) |
| 套件 | 组合清单(逐项:类型图标+名称+状态+optional 勾选);安装顺序;部分失败时逐项重试按钮 |
| 云能力 | 见 §6(输入契约/预算默认值/tier/上行数据说明) |

### 5.4 已安装(统一管理面,全类型)
- 列表列:类型 pill · 名称 · scope(全局/项目名)· 版本 · 状态点(已生效/待重载/连接失败/已停用)· 操作(启停[MCP]/更新[有新版]/卸载/详情)。
- 数据源 = receipts ⨝ SDK 真相(mcp.status / app.skills / app.agents / command.list),差集显示「待重载」;顶部常驻[重载引擎]按钮(有待重载项时高亮)。
- 「有更新」分区 = receipts.version < catalog.version 的条目,支持逐条/全部更新(更新 = 重装同 id 新钉版,fs 类按 receipt.files 精确替换)。
- 卸载确认弹窗列出将删除的文件/config 键(来自 receipt),防误删。

### 5.5 创建 / 导入
- 创建保留现有 skill/agent 表单,增加:落点选择(全局/本项目)、agent 权限档预设(只读/标准)、创建成功后直接跳该条目详情页(取代裸 toast),并触发生效引导(重载)。
- 导入(M2):文件夹(校验 SKILL.md/frontmatter → 复制进 `.alpha`)、Git URL(浅克隆到临时目录 → 同校验)、均产 receipt;npm 导入并入 plugin 流。

### 5.6 反馈体系与文案修正
- 层级:**行内状态**(卡片/详情,持久)> **Banner**(hub 顶部,聚合类错误如 status 加载失败/config 健康)> **Toast**(仅成功/次要提示)。
- 修正:`zh.ts:82`/`en.ts:83` 的 `~/.opencode` 错误路径与「钥匙串」误导;plugin「重启后生效」→「重载引擎后生效(约 2 秒)」。
- 空态:每分区给 1 句场景引导 + 1 个推荐动作;骨架屏用于 catalog/状态加载。

### 5.7 自动化页面(侧栏「定制中心」下方新入口,复活既有 i18n key)
```
自动化
┌──────────────────────────────────────────────┐
│ [＋ 新建自动化]                    [全部暂停 ⏸] │
│ ┌──────────────────────────────────────────┐ │
│ │ ● 每天 09:00 · 项目 alpha-code            │ │
│ │   「总结昨日新提交并生成日报」              │ │
│ │   下次 07-05 09:00 · 上次 ✓ 成功 · [开关]  │ │──点击→任务详情(编辑/历史)
│ └──────────────────────────────────────────┘ │
│ 空态:示例引导「试试:每天 9 点检查 …」          │
└──────────────────────────────────────────────┘
```
- **新建 = 一句话输入**:「每天早上 9 点,检查本项目未处理的 TODO 并生成清单」→ 解析预览卡(周期 · 时间 · 项目 · 执行内容 · 权限档 · 预算),各字段可改 → 保存。解析 MVP 用确定性规则(每天/每周 X/每 N 小时/工作日 + HH:mm,中英),LLM 辅助解析 V1.1。
- 任务详情页:定义(可编辑)+ 运行历史(时间 · 结果 · 摘要;点一条 → 打开对应会话原文/run 产物)。
- 运行反馈:系统通知 + 侧栏「自动化」badge;失败历史行内展开错误。

## 6. 云集成设计(M3)

1. **云连接器一等公民**:hub「云能力」分区固定展示 `cloud` 连接器卡(即注入的 mcp.cloud):
   - 未登录/BYOK 模式 → 卡片可见但灰,状态行诚实说明「需登录平台账户」,CTA 走既有登录流(`window.api.auth.start`);
   - platform 模式 → 显示连接状态(mcp.status.cloud)+ 详情页列 4 个工具(cloud_dispatch/status/await/artifacts)与数据边界说明(ADR-021:diff-only 优先、denied_paths、1MB 帽)。
2. **云 pipeline 条目**(catalog 新类型 `cloud`):research / code-review / docs(B 侧已 live)。详情页 = 输入契约(kind/input 或 objective)、预算默认(25 iter/300k tok/600s)与上限、执行层(Tier-1/沙箱)、**上行数据明细**。「安装」语义 = 加入本机可用云能力列表(receipt),供会话与自动化选用;不写引擎 config。
3. **ADR-021 §2 硬校验落地**(与 B3 验收⑦合账,自动化上线前置):`dispatchCloudJob` 前置 1MB 序列化帽、secrets 模式扫描(命中拒发并指出字段)、denied_paths 默认注入(`.env* / *.pem / .alpha/ / .git/`)。自动化的云档位(§7)会放大此必要性——无人值守派发绝不能裸奔。
4. **远程 catalog(E10)**:alpha-web 提供签名的增量 catalog(条目级 minisign/ed25519 签名,客户端离线验签,失败回退内置);仍离线优先。C 仓端点未建前不阻塞 M1/M2。
5. **暂不做**:租户级安装漫游(B 侧存储)、hub 内计费展示——登记 roadmap 即可。

## 7. 自动化(定时任务)设计(M4,新 ADR-022)

**实体**(存 `~/.alpha/automations/<id>.json`;运行记录写目标项目 `.alpha/runs/auto-<id>-<ts>/`,复用 ADR-019 schema 与守卫):
```jsonc
{ "id","name","nlText",
  "schedule": { "kind":"cron|interval|once", "expr":"0 9 * * *", "tz":"Asia/Shanghai" },
  "target":   { "projectDir":"...", "agent":"alpha-automation", "model":null },
  "prompt":   "任务指令(由 nlText 提炼,可编辑)",
  "execution":"local",                     // "cloud" 档位 V2
  "permissionProfile":"readonly|standard",
  "budget":   { "maxDurationMin":15, "dailyRunCap":8 },
  "overlapPolicy":"skip", "catchUpPolicy":"skip",
  "notify":   { "system":true }, "enabled":true }
```
**调度器(Electron 主进程)**:每任务单 timer(计算下次触发→setTimeout→执行→重排);`powerMonitor` resume 时重算,错过的按 catchUpPolicy 默认跳过;应用未运行不执行(UI 明示 + 「登录时启动」设置项);全局并发 1,overlap skip。
**执行**:SDK `session.create({ directory })` → `session.prompt`(agent=alpha-automation);会话即审计原文,标题前缀「⏱ 自动化 · <name>」。完成判定订阅 SSE session idle;超 maxDurationMin 调 abort。产出:最终回复存 `report.md` + `status.json` 落 runs;系统通知。
**权限档(引擎静态配死,无人值守不弹 ask)**:
- `readonly`(默认):read/glob/grep/list/webfetch/websearch/skill=allow;edit/bash/external_directory=deny;doom_loop=deny;read 对 `*.env*` 保持 deny。
- `standard`(显式选择,带警告):等同 build 权限但 bash 危险类仍 deny;V2 再谈写盘+分支保护。
- `alpha-automation` agent 以 config 注入下发(prompt `{file:}`),detail 页可见。
**成本护栏**:platform-pays 模式下新建/启用时展示「将消耗平台额度」提示;dailyRunCap 全局兜底(默认 24 次/日,可调);历史页显示每次运行时长。
**云档位(V2,B 仓)**:B 侧 CF Workers cron triggers(现无)+ 服务器端 schedule 注册 → 离线也执行 → 结果开 app 时经 cloud_status/artifacts 拉回 `.alpha/runs/`。前置:ADR-021 §2 已落地、B16 consent 重启评估。

## 8. 分期路线与验收(每期真机核验,[[visual-verify-required]])

| 期 | 内容 | 验收(节选) |
|---|---|---|
| **M1 通用性地基**(≈1.5 周) | receipts 账本;全类型已安装/卸载;「重载引擎」+待重载 badge;`.alpha` 双层落盘+桥+一次性迁移;MCP 密钥 `{file:}` 化;**Agent tab**;补打包 4 条官方 skill;文案修正;composer agent 选择器核实(缺则补) | 四类各过「装→亮(引擎列表可见)→用(会话实调)→卸(文件/配置净除)」四步真机录证;`~/.config/opencode` 零新增写入;jsonc 中零明文密钥 |
| **M2 详情页+生命周期**(≈1 周) | 左栏 IA;逐类型详情页(含数据边界/实时依赖检测);更新通道;导入 folder/git;E11 筛选;catalog 元数据补 tools[]/hooks[] | 每类型详情页截图核验;更新一条 MCP 钉版走通;导入一个本地 skill 走通 |
| **M3 云集成**(≈1 周 A 侧) | 云分区+登录门控;pipeline 条目(code-review 首发);**ADR-021 §2 三校验落地**;E10 客户端(C 端点就绪后开) | BYOK/未登录态灰显文案正确;dispatch 超 1MB/含密钥被拒且指明字段;code-review 从 hub 入口端到端一次 |
| **M4 自动化 MVP**(≈1.5 周) | 侧栏入口+列表/新建/详情;确定性 NL 解析+预览;调度器;readonly 权限档 agent;runs 落盘+通知+历史 | 「每天 HH:mm」任务在真机触发并产出 run;权限档实测不弹 ask、不越权写;overlap/catch-up 按策略;历史可回跳会话 |

依赖顺序:M1 是一切前提(没有账本与生效机制,详情页和自动化都是空中楼阁);M3 的 §2 校验是 M4 云档位的硬前置。

## 9. 拍板记录(2026-07-04,用户)

- **D1 全局桥法:✅ 采纳推荐**——`~/.alpha` 真源 + `~/.opencode/<类>` symlink 桥(与项目级同构;原生 CLI 也可见)。
- **D2 存量迁移:✅ 一次性迁移弹窗**(清单确认、可跳过、`ALPHA_LEGACY_INSTALL_ROOT=1` 逃生)。
- **D3 自动化:✅ 只读档先行**;并要求**先制定完整需求、按优先级分步实现**——完整分期需求已落 [REQ-021](https://github.com/jinjunnn/alpha-code/blob/3024732c1e8cbc541df67abeea1f5d7693867023/docs/requirements/REQ-021-automations.md)(A1 只读 MVP → A2 增强 → A3 云档位)。
- **D4 术语(用户委托代决)→ 定为「插件」保名**:详情页/tab 副标题加一行澄清 + GLOSSARY 补「插件 vs 套件」。理由:改名收益小(引擎语义如此),牵动 i18n 与 ADR-014 措辞;澄清成本更低。
- **D5 云端定时:✅ 立项 B 仓**——B 侧计划已写入 alpha-platform `docs/design/2026-07-04-cloud-scheduled-automations.md`(DECISIONS 记 PA-28 proposed);A 侧契约档 [REQ-022](https://github.com/jinjunnn/alpha-code/blob/3024732c1e8cbc541df67abeea1f5d7693867023/docs/requirements/REQ-022-cloud-schedules-platform.md)。**执行原则(用户):先计划后实现,当前阶段只审计+制定 A/B 两端完整方案,不开工实现。**

## 10. BACKLOG 登记(✅ 已于 2026-07-04 完成,计数器 → REQ-023)

- **REQ-018**(P1)v3-M1 通用化地基 → [requirements/REQ-018](https://github.com/jinjunnn/alpha-code/blob/3024732c1e8cbc541df67abeea1f5d7693867023/docs/requirements/REQ-018-ext-hub-universality.md)
- **REQ-019**(P2)v3-M2 详情页+生命周期+IA → [requirements/REQ-019](https://github.com/jinjunnn/alpha-code/blob/3024732c1e8cbc541df67abeea1f5d7693867023/docs/requirements/REQ-019-ext-hub-detail-lifecycle.md)
- **REQ-020**(P2,仓 X)v3-M3 云集成 + ADR-021 §2 落地 → [requirements/REQ-020](https://github.com/jinjunnn/alpha-code/blob/3024732c1e8cbc541df67abeea1f5d7693867023/docs/requirements/REQ-020-ext-hub-cloud.md)
- **REQ-021**(P2)自动化完整需求(A1/A2/A3 分期)→ [requirements/REQ-021](https://github.com/jinjunnn/alpha-code/blob/3024732c1e8cbc541df67abeea1f5d7693867023/docs/requirements/REQ-021-automations.md)
- **REQ-022**(P2,仓 B)云端定时执行契约 → [requirements/REQ-022](https://github.com/jinjunnn/alpha-code/blob/3024732c1e8cbc541df67abeea1f5d7693867023/docs/requirements/REQ-022-cloud-schedules-platform.md)

既有条目处置(已在 BACKLOG 执行):D3、D4 → dup 并入 REQ-018;E11 → dup 并入 REQ-019;B8 备注指向 REQ-018/019 为实现路径;REQ-006 的 O2 方向已定(Agent 进 tab、Command 不单列),随 REQ-006 转正写入 ADR-014 修订。

## 11. ADR 影响

- **ADR-014 修订(→ v3)**:IA 从「三分法+7 tab」改左栏分区;安装真相源从「仅 SDK」扩为「receipts ⨝ SDK」;写盘根从 `~/.config/opencode` 改 `.alpha` 双层;补「生效矩阵/重载引擎」条款。
- **ADR-019 修订**:新增**全局层 `~/.alpha`**(installs.json/skills/agents/commands/plugins/connectors.json/automations),原「全局产物留 userData」限定为 identity/behavior/secrets 等 alpha 内部产物;补全局桥接法(D1 拍板结果)。
- **新 ADR-022(自动化)**:实体/调度/权限档/护栏/云档位边界(§7)。
- **ADR-021**:§2 三校验由 M3 落地销账(其 ⚠️ 待实现条转 ✅)。
- GLOSSARY 增补:插件 vs 套件、重载引擎、安装账本(receipts)、自动化。
