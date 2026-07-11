---
id: REQ-034
title: 外部生态定制内容导入转换器:Claude Code plugin 大礼包 → alpha 套件扇出 + Codex 可共享物导入(安装期转换,ADR-023)
type: feature
github_issue: https://github.com/jinjunnn/alpha-code/issues/215
repo: A
created: 2026-07-05
---

## 背景(为什么)

用户立项(2026-07-05):"新立 Claude Code plugin 导入转换器和 Codex plugin 导入转换器"。策略已由 [[ADR-023]] 钉死:**安装期转换器,不做运行时模拟层**。2026-07-10 用户确认将两份产品能力/扩展所有权文档拆成可独立开发 REQ；实施前必须先完成 Extension v2 信任底座。当前状态只读关联 GitHub Issue。

事实口径(ADR-023 核查):
- **Claude Code plugin** = 分发容器(`plugin.json` + skills/agents + flat Markdown commands + `.mcp.json` + hooks/LSP/monitor/bin/settings),不是 Alpha/OpenCode engine plugin。可兼容部分应规范化为 Alpha Pack 子项，不支持部分必须隔离并出报告;
- **Codex 无插件体系** → "Codex plugin 导入转换器"的实际对象收敛为 **Codex 可共享物**:`config.toml` 的 `mcp_servers`(→ MCP)、`AGENTS.md`(→ 指引)、`~/.codex/prompts/*.md` 自定义命令(→ opencode command);
- 异构引擎的**代码插件**(调宿主 API 的 JS 模块)不在转换范围(ADR-023 §2,不承诺、不伪装)。

## 目标(做什么)

1. **Claude Code plugin 导入**(hub「创建/导入」区新入口,folder/git 两源):解析 `plugin.json` → **扇出预览**(逐件列出:Agent Skills 标准校验 / flat command Markdown → 显式调用 Skill / agent 字段映射 / `.mcp.json` → MCP 安装确认;映射不到的字段逐项标注)→ 用户确认 → 由 main-only planner 按 Alpha Pack/Bundle 事务安装。receipts 记录 parent manifest digest、converter version、字段映射结果与 `origin:"imported-claudecode"`。
2. **不支持内容隔离**:hooks、bin、monitor、settings、LSP 默认不执行、不复制进可执行路径,生成 unsupported/quarantine 报告。只有重新实现、独立审计并打包为 Alpha capability/engine plugin 后才可运行。
3. **Agent 字段语义**:`memory` 作为正式 Claude Agent 字段进入映射预览；对 plugin-shipped agent 本身不支持的 `hooks`/`mcpServers`/`permissionMode` 标为 source invalid/unsupported；model/tools 等不能精确映射时 loud，不静默丢弃。
4. **Codex 导入**:`config.toml` 的 `mcp_servers` → 逐条转 MCP 安装确认(密钥走 `{file:}` 通道);`prompts/*.md` → 显式调用 Skill;`AGENTS.md` → 不自动改写用户项目配置,给出引擎原生支持指引。
5. **转换规则表文档化**:逐字段映射矩阵(直通 / 映射 / 拒绝 / 不支持)进用户文档与 hub 内说明;规则表本身可单测。

## 验收标准(可验证,逐条)

1. 导入一个固定 commit、许可证允许的真实 Claude Code plugin(含 command+skill+mcp)→ 预览逐件如实 → 确认后以一个原子事务装入；receipts 溯源、parent digest、converter version 正确；卸载净除；
2. 含 hooks 的插件导入 → hooks 部分明确提示不生效,其余件正常装;无任何"假装 hooks 在工作"的表象;
3. 字段映射不到(如 Claude Code agent 的 alpha 无对应字段)→ 预览中显式标注,装入后行为与标注一致;
4. Codex `config.toml` 导入 → MCP 逐条确认安装、连接成功;prompts 转显式调用 Skill 可在会话内触发;
5. 转换纯函数单测覆盖(happy + 缺字段 + 恶意 frontmatter,复用 skill-creator XSS 修复的消毒纪律);
6. 既有导入通道(skill folder/git、plugin npm)回归零变化。

## 非目标

- 不做运行时模拟层(ADR-023 §2 钉死);
- 不做 hooks 语义转换(phase 2 再评,前置 = 映射矩阵证明覆盖率值得);
- 不对接 Claude Code marketplace / 不自动发现远端插件源(导入源 = 用户给的 folder/git);
- 不承诺异构引擎代码插件可用(如实文档化)。
- 不把 Claude plugin hooks 转成 Alpha engine plugin；不允许导入件注册 Alpha 顶级路由。

## 方案 / 关联

- 权威策略:[[ADR-023]];执行骨架复用:Alpha Pack/套件扇出(ADR-014)、导入 UI、`{file:}` 密钥(A6)、frontmatter 消毒(PR #73);本地导入的信任与生命周期硬依赖 REQ-099/100/103,远程来源进入 stable 再依赖 REQ-101/104;
- 与 [[REQ-033]](开放生态安装面)互补:REQ-033 = 任意单件入口(MCP/agent),本档 = 成包转换;与 [[REQ-035]] 互补:委托 Claude Code 执行时其生态内容原生可用,无需转换。

## 实施前置

实施前置 = REQ-099(main-only manifest/receipt v2)+REQ-100(原子事务)+REQ-103(所有权/贡献槽)完成,并完成逐字段映射设计评审；远程来源进入 stable 还依赖 REQ-101/104。不得提前实现执行型 hooks/bin/monitor/LSP。排期和状态只在关联 GitHub Issue 与 Alpha Delivery 维护。
