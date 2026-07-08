---
id: ADR-024
title: 外部生态继承默认拒绝(default-deny)+ 打开项目 consent 导入门(.claude/.agents/CLAUDE.md;consent = 安装期转换导入,非重开继承)
status: accepted
date: 2026-07-08
related: [ADR-023, ADR-015, ADR-019, ADR-021, REQ-034, REQ-060, REQ-063]
---

## 背景

用户方向(2026-07-08 拍板,GOALS G6「去 opencode 化」的一支):上游对 Claude Code / `.agents` 生态的**静默继承**改为默认拒绝 + 显式同意。

**上游继承面(源码钉死,2026-07-08 核查)——只有两类,并没有 agent/command/tool 继承:**

1. **skill**:`packages/opencode/src/skill/index.ts:21-22` 定义 `.claude` / `.agents` 两个外部目录;扫描 `~/.claude/skills`、`~/.agents/skills`(全局 home)+ 从项目目录向上走查到 worktree 的同名目录(项目级),按 `EXTERNAL_SKILL_PATTERN` 发现。
2. **instructions**:`packages/opencode/src/session/instruction.ts:62-66` 把 `~/.claude/CLAUDE.md`(全局)与项目 `CLAUDE.md` 并入 instruction 文件列表。

全引擎仅 3 个文件引用 `.claude`(第三处 provider.ts 是模型 ID 字符串,无关)。**但继承来的 skill 会由引擎自动生成同名 command**(command 源 `source="skill"`),观感上"命令也进来了"——2026-07-08 用户会话里 `/graphify` 即此路(`~/.claude/skills/graphify`)。

**既有门控(上游 env flag,进程级,`runtime-flags.ts`):**
- `OPENCODE_DISABLE_EXTERNAL_SKILLS` —— `.claude` + `.agents` skills 全关;
- `OPENCODE_DISABLE_CLAUDE_CODE_SKILLS` —— 仅关 `.claude` skills(`.agents` 仍继承);
- `OPENCODE_DISABLE_CLAUDE_CODE_PROMPT` —— 关 CLAUDE.md 继承(宽口 `OPENCODE_DISABLE_CLAUDE_CODE` 同关 prompt+skills)。

**静默继承的三宗罪:**
① **提示注入面**——克隆一个第三方仓库,其自带的 `CLAUDE.md` / `.claude/skills` 未经任何确认直接进入模型上下文(与 REQ-060 项目信任门对 `.alpha` 可执行物的态度不一致:自家的要 consent,外来的反而白进);
② **破坏 `.alpha` 单一真源心智**——用户看不出一个技能从哪来(「`.alpha` 是你的,`.opencode` 是引擎的」口径之外冒出第三来源;2026-07-08「技能丢了」误会正源于菜单里混着 `.claude` 继承物);
③ **运行时依赖**——外部目录内容变化 alpha 无感、无账本、无生命周期管理。

## 决策(全部 alpha 自有文件,零改上游)

1. **默认拒绝继承**:sidecar env 注入默认置 `OPENCODE_DISABLE_EXTERNAL_SKILLS=1` + `OPENCODE_DISABLE_CLAUDE_CODE_PROMPT=1`(set-if-unset,shell 显式值优先,B21 同款纪律)。逃生 `ALPHA_ECOSYSTEM_INHERIT=1` = 不注入两 flag,整机恢复上游默认继承行为。
2. **consent = 安装期转换导入,不是重开继承**(与 [[ADR-023]] 一脉):打开项目时检测项目内 `.claude/` `.agents/` `CLAUDE.md` → 原生确认 sheet(复用 REQ-060 ext-trust-check 信任门模式;结果落项目 `.alpha/prefs.json` 版本化记账,「忽略」不再弹)→ 用户选「导入」则走**安装期转换**:
   - skill → `<项目>/.alpha/skills/` + 项目 `alpha.jsonc` 条目(receipts `origin: imported-claude` / `imported-agents`);
   - `CLAUDE.md` → 显式预览后并入项目 `.alpha` 指令通道(或提示用户转 AGENTS.md——那是引擎原生约定,不在本 ADR 射程);
   - 映射不到的内容 loud 提示、不静默丢弃(C28 反 placebo 纪律;`.claude/commands`、`.claude/agents` 等上游本就不读的原语,归 [[REQ-034]] 转换器射程)。
   产物为原生条目,此后与外部目录**脱钩**——外部更新不自动跟随,重导入才更新(诚实换确定性)。
   **consent 载体 = 原生 sheet(主)+ 系统级导入 skill(对话式补充,2026-07-08 用户补充拍板)**:sheet 确定性触发不依赖会话;出厂 skill(如 `integrate-project`)供用户/模型在会话内主动触发导入与**重导入**(快照更新的唯一交互通道),两入口共用同一条转换管线。
3. **全局层一次性迁移门(硬前置,不做不发)**:首次升级到本行为的启动检测 `~/.claude/skills`、`~/.agents/skills`、`~/.claude/CLAUDE.md` 非空 → 一次性弹「检测到 N 个外部技能/指令,导入为 alpha 原生?」;选不导入则从此不可见且**明示这一点**(loud,防「技能丢了」误会重演——存量用户如作者本人的 graphify 即在此列)。
4. **粒度诚实声明**:上游 flag 是引擎进程级 → 「按项目开/关继承」机制上不存在;项目粒度由「导入落地到该项目 `.alpha`」实现,与 flag 无关。
5. **边界**:AGENTS.md / CONTEXT.md 是 opencode 原生指令约定,不禁;用户显式 `ALPHA_ECOSYSTEM_INHERIT=1` 后 alpha 不再做任何检测/弹窗(整机开关,自负来源信任)。

## 后果

- ✅ 关掉「陌生仓库自带内容静默进上下文」的注入面;与 REQ-060 项目信任门形成一致的信任模型(**凡进入上下文/进程的外来物,一律过同意门**)。
- ✅ `.alpha` 单一真源心智完整:导入产物有账本、可卸载、可更新,纳入既有生命周期(ADR-014 receipts ⨝ SDK);对标 Claude Code / codex 打开陌生仓库的信任提示,且更进一步(同意后转为原生资产而非临时放行)。
- ✅ 复用面全部现成:信任门 UI(REQ-060)、导入转换(REQ-033 agent 导入两段式)、prefs 版本化记账(ADR-021 模式)——净新增只有「检测 + 编排」。
- ⚠️ 失去「外部目录改了自动跟随」:导入是快照;重导入是唯一更新通道(UI 应在详情页如实标注来源与导入时间)。
- ⚠️ 存量用户升级即不可见外部技能 → §3 迁移门是发布闸;真机批必须含「有 ~/.claude/skills 存量的机器首启」用例。
- ⚠️ 对 `.agents` 生态同样 default-deny(上游还会继续扩外部目录清单;sync 契约 diff 纪律需盯 `skill/index.ts` 外部目录常量与 flag 语义)。
- 🔭 执行载体 [[REQ-063]];检测时机(打开项目 vs 首次会话)、CLAUDE.md 转换的具体形态随需求档定稿。
