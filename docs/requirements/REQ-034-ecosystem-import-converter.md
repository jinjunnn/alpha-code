---
id: REQ-034
title: 外部生态定制内容导入转换器:Claude Code plugin 大礼包 → alpha 套件扇出 + Codex 可共享物导入(安装期转换,ADR-023)
type: feature
priority: P2
status: parked
repo: A
created: 2026-07-05
---

## 背景(为什么)

用户立项(2026-07-05):"新立 Claude Code plugin 导入转换器和 Codex plugin 导入转换器"。策略已由 [[ADR-023]] 钉死:**安装期转换器,不做运行时模拟层**。

事实口径(ADR-023 核查):
- **Claude Code plugin** = 大礼包目录(`plugin.json` + commands/agents/skills markdown + `.mcp.json` + hooks 脚本配置),声明式为主 → **可转换**,与 alpha 套件(bundle 扇出,ADR-014)天然同构;
- **Codex 无插件体系** → "Codex plugin 导入转换器"的实际对象收敛为 **Codex 可共享物**:`config.toml` 的 `mcp_servers`(→ MCP)、`AGENTS.md`(→ 指引)、`~/.codex/prompts/*.md` 自定义命令(→ opencode command);
- 异构引擎的**代码插件**(调宿主 API 的 JS 模块)不在转换范围(ADR-023 §2,不承诺、不伪装)。

## 目标(做什么)

1. **Claude Code plugin 导入**(hub「创建/导入」区新入口,folder/git 两源):解析 `plugin.json` → **扇出预览**(逐件列出:skill 直通 / command frontmatter 映射 / agent 字段映射 / `.mcp.json` → MCP 安装确认;映射不到的字段逐项标注)→ 用户确认 → 按套件机制逐项安装(receipts `origin:"imported-claudecode"`,复用账本/桥/dispose/卸载全链)。**hooks phase 1 不转换**:显式列出该插件的 hooks 清单并提示「此部分在 alpha-code 不生效」(诚实降级,不静默丢)。
2. **Codex 导入**:`config.toml` 的 `mcp_servers` → 逐条转 MCP 安装确认(密钥走 `{file:}` 通道);`prompts/*.md` → opencode command 映射;`AGENTS.md` → 不自动改写用户项目配置,给出「opencode 原生支持 AGENTS.md,直接放项目根即可」的指引(引擎本就读它,无需转换)。
3. **转换规则表文档化**:逐字段映射矩阵(直通 / 映射 / 丢弃需确认 / 不支持)进用户文档与 hub 内说明;规则表本身可单测(纯函数解析 + 映射)。

## 验收标准(可验证,逐条)

1. 导入一个真实社区 Claude Code plugin(含 command+skill+mcp)→ 预览逐件如实 → 确认后全部装入并免重启生效(dispose 链);receipts 溯源 origin 正确;卸载净除;
2. 含 hooks 的插件导入 → hooks 部分明确提示不生效,其余件正常装;无任何"假装 hooks 在工作"的表象;
3. 字段映射不到(如 Claude Code agent 的 alpha 无对应字段)→ 预览中显式标注,装入后行为与标注一致;
4. Codex `config.toml` 导入 → MCP 逐条确认安装、连接成功;prompts 转 command 可在会话内触发;
5. 转换纯函数单测覆盖(happy + 缺字段 + 恶意 frontmatter,复用 skill-creator XSS 修复的消毒纪律);
6. 既有导入通道(skill folder/git、plugin npm)回归零变化。

## 非目标

- 不做运行时模拟层(ADR-023 §2 钉死);
- 不做 hooks 语义转换(phase 2 再评,前置 = 映射矩阵证明覆盖率值得);
- 不对接 Claude Code marketplace / 不自动发现远端插件源(导入源 = 用户给的 folder/git);
- 不承诺异构引擎代码插件可用(如实文档化)。

## 方案 / 关联

- 权威策略:[[ADR-023]];执行骨架复用:套件扇出(ADR-014)、导入 UI(REQ-019 创建 tab)、`{file:}` 密钥(A6)、账本/桥/dispose(REQ-018)、frontmatter 消毒(PR #73);
- 与 [[REQ-033]](开放生态安装面)互补:REQ-033 = 任意单件入口(MCP/agent),本档 = 成包转换;与 [[REQ-035]] 互补:委托 Claude Code 执行时其生态内容原生可用,无需转换。

## 状态说明

**parked(用户 2026-07-05:暂不开发,等想清楚再启动)**;激活条件 = 用户拍板启动,届时按 ADR-023 执行。
