# 设计:定制中心(Extension Hub)— Skills / MCP / Plugins 可视化市场(初稿 A 步)

> 本初稿为 A 步草案;经 `/app:design-arch`(2026-06-22)产出权威设计 **`2026-06-22-arch-extension-hub.md`(v2 瘦身:MCP-first + 零自建引擎)**,以后者为准。本初稿的 §5(预设清单)与 §7(中国区适配)仍被权威设计引用,保持不删。
>
> 状态:draft → v2 权威设计已出
> 日期:2026-06-22
> 关联:[[ADR-014]](本设计配套)、[[ADR-002]](后端接缝)、[[ADR-003]](前端 AppInterface)、[[ADR-006]](ext 预 bundle)、[[ADR-008]](侧栏)、[[ADR-009]](injectAlphaConfig/preferAppEnv 注入接缝)
> 北极星对账:全程**只新增文件** + 写**用户/alpha 自有 config** + 走 **SDK**,不碰 `opencode/packages/**` → 冲突文件数 = 0 不破。

## 0. 问题与目标

**问题**:当前侧栏「插件」入口(`packages/ui-mac/src/renderer/sidebar/alpha-sidebar.tsx:494`)只触发 `command.trigger("mcp.toggle")` —— 打开的是 opencode 的 MCP 连接开关对话框,**名不副实**(写"插件",实际只开关 MCP),且不涉及 skill/agent/command/plugin。相邻的「自动化」(`:498-508`)是空 onClick 死占位。

**目标**:把它升级为一个**「定制中心」**——一个可视化的扩展市场 + 管理面,让用户浏览、一键安装、创建、导入 **技能 / 连接器(MCP) / 插件 / 套件**,并管理已安装项。对标 Claude Directory、OpenAI Codex「插件」、Tencent WorkBuddy「技能市场」,按中国区习惯本地化。

**非目标(本设计范围外)**:多租户/团队共享市场(本地产品面);云端执行(归 alpha-platform);重写 opencode 的 skill/agent 引擎。

## 1. 关键事实底座(决定一切的约束,均经源码核实)

| # | 事实 | 出处 | 设计含义 |
|---|---|---|---|
| F1 | **opencode 的 plugin 不是"伞"** —— `PluginV2` 只有 3 个 hook(`catalog.transform`/`aisdk.language`/`aisdk.sdk`),无法像 Claude Code plugin 那样打包 skill+command+agent+MCP | `packages/core/src/plugin.ts:23-48` | "套件/一包多件"**必须是 alpha 自建构造**,安装时扇出成多个原子安装 |
| F2 | **全平台没有任何内置 marketplace/registry**,也没有默认远程 skill 源 | `skill/discovery.ts`(无硬编码源)、CLI/server 路由全扫无 registry | 目录(catalog)**我们自备**;可内置进 app(离线优先) |
| F3 | MCP 的 `POST /mcp`(SDK `mcp.add`)**只在内存生效、不落盘**;只有 CLI `mcp add` 写配置 | `server/.../handlers/mcp.ts`、`cli/cmd/mcp.ts:430-443`(`addMcpToConfig` 用 jsonc `modify`) | 持久化要**自己写 user config**;实时生效用 `mcp.add`+`connect` |
| F4 | skill 无 HTTP 安装:写文件到被扫描目录,或加 path/URL 到 config `skills[]`(`string[]`);远程 = 取 `index.json`(`{skills:[{name,files[]}]}`)下载到 cache | `config.ts:89`、`skill/index.ts`、`skill/discovery.ts` | skill 安装 = 主进程写文件 / 加 config 项 |
| F5 | plugin 安装 = 写 config `plugins[]`(`string`\|`{package,options}`)+ npm/bun 装包 + **重启**;无 HTTP add | `config/plugin.ts:5-13`、`plugin/loader.ts` | plugin tab 走"写 config + 装 + 提示重启" |
| F6 | agent/command 安装 = 写 `.opencode/agent\|command/*.md` 或 config;无 HTTP add | `config/plugin/{agent,command}.ts` | 创建/导入走文件写 |
| F7 | 读取侧 SDK 齐全:`sdk.{skill,agent,command}.list`、`sdk.mcp.status`、`sdk.tool.list` | `packages/sdk/js/.../sdk.gen.ts` | 「已安装」页数据来源 |
| F8 | **已有注入接缝**:`sidecar.ts → injectAlphaConfig()` 经 `OPENCODE_CONFIG_CONTENT` **merge 注入**(不覆盖用户配置),现已注入 identity/模型/`mcp.cloud`;注释明示是"将来挂 `plugin:[...]`"的口子 | `packages/ui-mac/src/main/sidecar.ts:111-156` | **出厂预设**(默认技能目录/MCP/插件)从这里注入 |
| F9 | 互操作扫描:opencode 默认扫 `~/.claude/skills` + `~/.config/opencode/skills`(全局,与 cwd 无关);可用 `OPENCODE_DISABLE_CLAUDE_CODE_SKILLS=1` 关闭 | `skill/index.ts:21-23,185-203`、`effect/runtime-flags.ts:21,27-29` | 分发前要决定是否默认关闭"串台",避免扫到用户机上无关技能 |

**Office/PDF 调研结论**:Anthropic 的 `docx/xlsx/pptx/pdf` 技能是**源码可见、禁止再分发**(`document-skills/*/LICENSE.txt`,与 Apache-2.0 的 `example-skills` 分开),且依赖重(xlsx→LibreOffice、docx→pandoc/node、pdf→python 系)。其 `example-skills`(skill-creator/mcp-builder/canvas-design/theme-factory/brand-guidelines/doc-coauthoring 等)为 **Apache-2.0,可再分发(附 NOTICE)**。
> ⚠️ 落地前手工核实 `anthropics/skills` 的 `document-skills/docx/LICENSE.txt` 措辞(调研未能逐字节验证)。

## 2. 信息架构(IA)决策:采用 Claude 三分 + 套件 + 已安装

侧栏「插件」→ 改名 **「定制中心」**;「自动化」死占位先移除/灰掉。内部 IA:

| Tab | opencode 原语 | 含义 | 安装动作 |
|---|---|---|---|
| 推荐(落地页) | — | 精选套件 + 热门 | — |
| 技能 Skills | `skill` | 纯知识/工作流,无网络无鉴权 | 写文件(F4) |
| 连接器 MCP | `mcp` | 接外部数据/工具,带鉴权 | 写 config + 实时连(F3) |
| 插件 Plugins | opencode `plugin`(npm) | 代码级工具/hook | 写 config + npm + 重启(F5) |
| 套件 Bundles | **alpha 自建 manifest** | 一包多件 | 扇出(F1) |
| 已安装(+启停) | 全部 | 列出已装并可 toggle | F7 + `mcp.toggle` |
| ＋ 创建/导入 | skill/agent | 自建 + 外部导入 | 写文件(F6) |

**术语本地化**(中国区 + 对齐 WorkBuddy/Claude):MCP 显示为「连接器」;bundle 显示为「套件」;Installed=「已安装」;Add=「添加」。
**Agent/Command 归属**:MVP 不进顶部 tab;在「已安装」列出、在「＋创建」提供 `创建技能 / 创建 Agent`。后续若做"专家广场"再加 `智能体` tab。

## 3. 安装架构(零-fork 接缝)

**目录(catalog)**:内置一份 `catalog.json`(随 app 发布,离线优先,躲中国区 egress);可选从 alpha-web(C 后端)增量刷新。每条目 = `{type, id, name, desc, icon, source, install}`,套件含 `items[]`。

**安装引擎**:渲染层(定制中心 UI)→ 经 `window.api.ext.*`(**新增** IPC,主进程)+ SDK:

| 类型 | 实现(零改 upstream) | 重启 |
|---|---|---|
| 技能 | 主进程下载/读内置 → 写 `userData/alpha-skills/<name>/SKILL.md`;该目录经 F8 注入 config `skills[]` | 否(重扫)/软重启 |
| 连接器(MCP) | 主进程 jsonc 写用户 `opencode.jsonc` 的 `mcp[name]`(持久,复刻 `addMcpToConfig`)**+** `sdk.mcp.add`+`connect`(当场生效) | **否** ✅ |
| 插件 | 主进程写 config `plugins[]` + `bun/npm install`(镜像感知) | 是(提示) |
| 套件 | 解析 manifest → 扇出上面三种 | 视内容 |
| 创建技能/Agent | 表单 → 写 `SKILL.md` / `agent.md` 到目标目录 | 否/软重启 |
| 导入外部 | 选文件夹 / 贴 git/raw URL / npm 名 → 校验 → 对应安装 | 视类型 |

**预设/出厂自带**:经 F8 的 `injectAlphaConfig` 注入默认技能目录 + 默认 MCP/插件;`ALPHA_*_DISABLE` 逃生开关(沿 ADR-009 风格)。

## 4. create / import:做,分期

- **创建技能**(V1):表单(name/desc/正文)→ 写 SKILL.md;进阶接 Anthropic `skill-creator`(Apache-2.0)做 AI 辅助。
- **创建 Agent**(V1):表单(model/system/tools/权限)→ 写 `.opencode/agent/*.md`。
- **导入 skill**(V1):文件夹 / git·raw URL → 校验 frontmatter → 拷入 alpha-skills。
- **导入 MCP**(V1):JSON 或 command/url 表单 → 写 config + 连。
- **导入 plugin**(V2):npm 名 / 本地路径 → 写 `plugins[]` + 装 + 重启。

## 5. 预设清单 & Office/PDF 定性

**Office/PDF = 「办公套件」,以 MCP(连接器)为主,不裸搬 Anthropic 文档技能**(版权 + 重依赖 + 中国区 egress 三重原因)。

| 套件 | 内含 | 来源 / License(落地前逐个复核) |
|---|---|---|
| 办公套件 | `markitdown`(MCP,文档→MD 读取)+ openpyxl 系 Excel-MCP(写 xlsx)+ 自写一页"办公"引导技能 | microsoft/markitdown=MIT;Excel-MCP 选型核 |
| 研究套件 | 官方 `fetch`+`filesystem` MCP + deep-research 思路 | modelcontextprotocol 官方 |
| 设计套件 | Figma 连接器 + `canvas-design`/`theme-factory`/`brand-guidelines`(技能) | Apache-2.0(NOTICE) |
| 开发套件 | `git`+`github` MCP + `mcp-builder`/`skill-creator`(技能) | 官方 + Apache-2.0 |
| 中国办公套件 | 飞书(larksuite 官方 MCP)/ 钉钉(open-dingtalk 官方)/ 语雀(yuque 官方,其安装器已支持 opencode) | 各官方仓,核 license |

**可直接搬**:Apache-2.0 example-skills(全)、官方 MCP 参考服务器、markitdown(MIT)、飞书/钉钉/语雀官方 MCP。**不可搬**:Anthropic docx/xlsx/pptx/pdf。**机会缺口**:腾讯文档、WPS 无成熟 MCP → 自研差异化点。

## 6. UI 视觉(详见 design-arch 出 D2 + 可选 ui-ux-pro-max 高保真)

整页对话框:左栏分类导航(Claude Directory 式:推荐/技能/连接器/插件/套件/已安装/创建)+ 右侧卡片网格(WorkBuddy/Claude 式:icon+名+一行描述+ `+`/已装 ✓齿轮)+ 顶部搜索 + 「添加」按钮 + 来源 chip(官方/社区/自建)+ Codex 式分区(办公/沟通/数据…)。沿用现有 `sidebar.css` token,与 V2 chrome 协调。

## 7. 中国区适配

- **下载难题**:npm/pip/GitHub egress 不稳 → 凡 license 允许的**内置进 app**;其余给**镜像感知**安装(`registry.npmmirror.com`、tuna pip 源),弱网失败给镜像提示。
- **本土连接器**:飞书/钉钉/语雀(官方 MCP)、企业微信(社区)、高德/百度地图;腾讯文档/WPS 为缺口。
- **串台默认**(F9):分发前决定是否默认 `OPENCODE_DISABLE_CLAUDE_CODE_SKILLS=1`,避免扫到终端用户机上无关的 Claude Code 技能。

## 8. 分期路线图

| 阶段 | 交付 | 验收 |
|---|---|---|
| MVP | 「定制中心」骨架:推荐+已安装+**连接器(MCP)** 全链路(浏览→一键装→落盘+实时连→开关);内置 catalog(3-5 MCP) | app 内点装 markitdown 并在会话可用;`git diff opencode/packages` 空 |
| V1 | 技能 tab + 创建技能/Agent + 导入(folder/url)+ 办公/研究/设计套件扇出 | 一键装"办公套件"→ Word/Excel/PDF 任务跑通 |
| V2 | 插件 tab(npm+重启)+ 中国办公套件 + 远程 catalog 增量 + 镜像感知 | 飞书/语雀连接器可用;弱网有镜像兜底 |

## 9. 风险 & rules 对账

- ✅ 零改 upstream(北极星);不靠 `experimental.*`(NON_GOALS#4);不绕 SDK(#5);属"薄定制层"。
- ⚠️ plugin 装包要重启 + 中国区 egress(已计入内置资源 + 镜像感知);MCP 持久化要自写 config(已设计);catalog 维护成本(先内置、小而精)。
- ⚠️ 新增主进程"写文件/装包"IPC = 新攻击面 → 限定写 alpha-skills/用户 config、校验来源、装包白名单。

## 10. 待 `/app:design-arch` 深化的开放问题

1. catalog schema 的精确字段 + 套件 manifest 形状(交 data-modeler)。
2. 安装时序/状态机(下载→写→连/重启→失败回滚;权限提示)(交 flow-designer ≤5 step)。
3. 定制中心是"独立路由页"还是"全屏 Portal 对话框"?(与 ADR-008 Portal 接缝一致性)
4. 主进程安装 IPC 的安全边界(写路径白名单、npm 包白名单、来源校验)。
5. Agent/Command 是否进市场 tab(还是仅创建+已安装)。
6. 串台默认关闭与否的产品取舍(F9)。
