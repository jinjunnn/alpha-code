---
id: REQ-033
title: 开放生态安装面:任意 MCP 手动添加 + agent 导入/转换 + 生态兼容性边界诚实文档化(catalog 外内容)
type: feature
priority: P1
status: archived
repo: A
created: 2026-07-05
---

## 背景(为什么)

用户诉求(2026-07-05):REQ-032(远程 catalog)落地后,"各平台通用的定制内容都应该可以被 alpha-code 识别和安装"——例如一个 Codex 的开源插件能否直接装,因为"平台不可能全部插件都自己收录"。

**核心澄清:catalog(无论本地/远程)只是精选推荐层;「万物可装」取决于格式/契约的通用性,与 catalog 无关。** 逐类型现实(2026-07-05 源码核查):

| 类型 | 跨生态通用性 | alpha-code 现状 |
|---|---|---|
| **MCP 连接器** | ✅ **业界通用标准**(Claude Code / Codex / Cursor 等各家共同消费同一 MCP server 生态)| 引擎支持任意 `mcp.servers` 配置,但 **hub 无「手动添加任意 MCP」UI**——只能装 catalog 内 8 条(`addMcpEntry` 仅接 CatalogEntry),catalog 外只能手编 opencode.jsonc |
| **技能 skill** | ✅ 事实标准(SKILL.md + frontmatter,Claude Code 与 opencode 同构;Codex 无此概念)| **已通**:创建 tab 的文件夹/git 导入(`importSkillFolder/importSkillGit`,frontmatter 校验,REQ-019)|
| **Agent** | ◐ 半通用(md+frontmatter 形似,字段 host 特定:opencode `mode/permission/model` vs Claude Code `tools/description`)| **无导入**,只有表单创建;社区 agent 文件需手工改写 |
| **插件 plugin** | ❌ **引擎 API 绑定,不通用**——opencode 插件 = 面向 `@opencode-ai/plugin` hook 契约的 JS 模块;异构引擎的**代码插件**互不可运行(运行时契约差异,任何 catalog/分发机制都改变不了)。**口径修正(2026-07-05,ADR-023)**:Claude Code "plugin" 实为声明式大礼包 → **可安装期转换**([[REQ-034]]);Codex **无插件体系**(可共享物 = MCP/AGENTS.md/prompts,天生通用) | opencode 生态插件**已通**:创建 tab npm 导入(`importNpmPlugin` 接任意包名)|
| **套件 bundle** | — alpha 自有概念(组合清单扇出),不存在跨生态问题 | catalog 内 |

**结论**:「平台不必收录全部」的正解 = **MCP 是跨生态主通道**(Codex 生态的能力几乎都有对应 MCP server,装 MCP 即得),辅以 skill/agent 导入;Codex **插件**本体永远不能直装(等价能力走其 MCP 版或社区 opencode 移植)。当前真正的缺口只有两个:任意 MCP 添加 UI、agent 导入。

## 目标(做什么)

1. **任意 MCP 手动添加**(最高价值,补齐跨生态主通道):hub 内新增「添加自定义连接器」入口——local(command,如 `npx -y <pkg>` / `uvx <pkg>`)与 remote(url/sse)两型表单 + 可选 env 密钥(密文采集,复用 `{file:}` 通道 A6/ADR-014 v3)→ 复用既有 `persistMcp`(C2 值校验、命令/URL 白名单照旧)+ `mcp.add` 免重启;receipts 记 `origin:"custom"`,已安装 tab 可启停/卸载。
2. **Agent 导入 + 轻转换**:文件/文件夹导入 `.md` agent;识别 Claude Code 格式 frontmatter(`tools/description`)时做**显式**字段映射预览(用户确认后写入,不静默改写,C28 反 placebo 纪律),opencode 原生格式直入;复用既有 `installBuiltinAgent` 落盘 + 桥 + dispose 链路。
3. **兼容性边界诚实文档化**:hub「创建/导入」区与用户文档写明上表——什么能直接装(MCP/skill/opencode 插件)、什么要转换(agent)、什么装不了及为什么(异构引擎插件如 Codex 插件),并指引替代路径(找同能力 MCP)。不做能力上的虚假承诺。

## 验收标准(可验证,逐条)

1. 从任意来源(如 MCP 官方 registry / README 一条 `npx` 命令)手动添加一个 catalog 外 MCP → 连接成功、会话内工具可用、已安装 tab 可管理、卸载净除(config+receipts);
2. 密钥型自定义 MCP:env 密文采集 → `{file:}` 引用落 config,jsonc 无明文(A6 同标准);
3. 白名单外命令/非 https URL 被拒(C2/ADR-014 §8 守卫不因自定义入口而放宽),错误行内可见;
4. 导入一个 Claude Code 格式 agent → 字段映射预览 → 确认后装入,引擎 agent 列表出现且可用;不兼容字段有显式提示而非静默丢弃;
5. hub 导入区可见兼容性说明;文档含逐类型边界表;
6. 既有 catalog 安装/skill 导入/plugin npm 导入回归零变化。

## 非目标

- 不做异构引擎代码插件的运行时兼容层(**已钉死为 [[ADR-023]]**:安装期转换是唯一适配形态;成包转换归 [[REQ-034]]);
- 不做 agent 格式的全自动无损转换承诺(语义差异如 permission 档,映射不到就留空并提示);
- 不做 MCP server 的市场化收录审核(自定义添加 = 用户自担来源信任,与手编 jsonc 同责任边界;catalog 精选层照旧);
- 不做 command 类型单列(维持 ADR-014 O2:command 随 skill/MCP 生成)。

## 方案 / 关联

- 与 [[REQ-032]] 正交互补:REQ-032 = 官方精选清单脱离发版;本档 = 清单之外的开放世界入口。二者合起来才完整回答「平台不必收录全部」;
- 复用面:`persistMcp`(+C2 校验)、`{file:}` 密钥通道(A6)、`installBuiltinAgent`/桥/dispose(REQ-018)、导入 UI 骨架(REQ-019 创建 tab);
- 关联:ADR-014(§8 IPC 安全边界,自定义入口沿用)、E2/E6(国产 MCP 条目——自定义入口落地后此类"催收录"压力自然下降)。
