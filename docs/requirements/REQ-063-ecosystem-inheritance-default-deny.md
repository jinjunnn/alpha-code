---
id: REQ-063
title: 外部生态继承 default-deny + 打开项目 consent 导入门(.claude/.agents skills + CLAUDE.md;ADR-024 执行载体)
type: security
priority: P1
status: ready
repo: A
created: 2026-07-08
---

## 背景(为什么)

权威决策 = [[ADR-024]](2026-07-08,用户拍板)。上游对外部生态的**静默继承**面(源码钉死,仅两类):

1. **skill**:`packages/opencode/src/skill/index.ts:21-22` —— `~/.claude/skills`、`~/.agents/skills`(全局)+ 项目目录向上走查的同名目录(项目级);继承的 skill 还会自动生成同名 command(用户的 `/graphify` 即此路)。
2. **instructions**:`packages/opencode/src/session/instruction.ts:62-66` —— `~/.claude/CLAUDE.md`(全局)+ 项目 `CLAUDE.md`。

agent/command/tool **不**从 `.claude`/`.agents` 继承。既有门控(进程级 env flag):`OPENCODE_DISABLE_EXTERNAL_SKILLS` / `OPENCODE_DISABLE_CLAUDE_CODE_SKILLS` / `OPENCODE_DISABLE_CLAUDE_CODE_PROMPT`。

三宗罪(ADR-024 §背景):①提示注入面(陌生仓库自带 CLAUDE.md/skills 未经确认直接进上下文,与 REQ-060 信任门态度不一致);②破坏 `.alpha` 单一真源心智(「技能丢了」误会的来源);③运行时依赖无账本无生命周期。附带症状:斜杠菜单里大量来路不明的 `/` 命令(继承 skill 自动生成)——本项砍来源,呈现半边(来源标注 + 治理禁用项隐藏)= [[REQ-066]]。

## 目标(做什么)

1. **T1 default-deny**:sidecar env 注入默认置 `OPENCODE_DISABLE_EXTERNAL_SKILLS=1` + `OPENCODE_DISABLE_CLAUDE_CODE_PROMPT=1`(**set-if-unset**,shell 显式值优先,B21 同款纪律);逃生 `ALPHA_ECOSYSTEM_INHERIT=1` = 不注入两 flag、整机恢复上游行为且 alpha 不再检测/弹窗。
2. **T2 项目级检测 + 信任门**:进入**无 consent 记录**的项目(`.alpha/prefs.json` 尚无本项记账,即用户说的「新项目、没有项目级 `.alpha`」态)时检测 `<项目>/.claude/`、`.agents/`、`CLAUDE.md` → 原生确认 sheet(复用 REQ-060 ext-trust-check 模式:granted/denied 都落 `.alpha/prefs.json` 版本化,「忽略」不再弹)。
3. **T3 导入转换(consent = 转换,非重开继承,ADR-023 一脉)**:
   - skill → `<项目>/.alpha/skills/` + 项目 `alpha.jsonc` 注册(REQ-060 hook 通道)+ receipts `origin: imported-claude` / `imported-agents`;
   - `CLAUDE.md` → **显式预览**后并入项目指令通道(`.alpha` 指令文件 + 注册,或指引用户转 AGENTS.md——引擎原生读它;具体形态实现时定,原则 = 预览 + 映射不到 loud,C28);
   - 产物与外部目录**脱钩**(快照语义;重导入 = 唯一更新通道)。
4. **T4 全局一次性迁移门(发布闸,不做不发)**:升级到本行为后的首启检测 `~/.claude/skills`、`~/.agents/skills`、`~/.claude/CLAUDE.md` 非空 → 一次性弹「检测到 N 项外部技能/指令,导入为 alpha 原生?」;导入 → `~/.alpha` 全局层(receipts);不导入 → **loud 明示从此不可见**(防「技能丢了」重演);记账不再弹。
5. **T5 hub 呈现**:导入产物进定制中心「已安装」(origin 徽标 + 来源/导入时间),可卸载净除。
6. **T6 系统级导入 skill(用户补充拍板,2026-07-08)**:新增出厂 skill(如 `integrate-project`,名字实现时定)作为**对话式**导入载体——进入新项目后,用户或模型可在会话内触发,skill 引导列出检测到的外部内容(`.claude`/`.agents`/CLAUDE.md)与映射预览,确认后经与 T3 同一条转换管线落 `.alpha`(双入口、一个后端);它同时是**重导入(外部目录更新后刷新快照)的唯一交互载体**。分工:T2 原生 sheet 为主通道(确定性、不依赖会话进行中);skill 为对话式补充与更新通道。

## 验收标准(可验证,逐条)

1. 打包真机:打开含 `.claude/skills` + `CLAUDE.md` 的陌生项目,consent 前 → skill 不在引擎技能列表、CLAUDE.md 不进 system(dev 抓 system 取证);
2. consent 同意 → 转换落 `.alpha` + 引擎可见(dispose 免重启链)+ receipts 正确;拒绝 → 保持不可见且不重复弹;两路径 prefs 记账各自可查;
3. **全局迁移门**:`~/.claude/skills` 有存量(本机 graphify)的机器升级首启必弹;导入后 graphify 经 `~/.alpha` 全局层可用、`/graphify` 命令仍在;选不导入 → 明示消失原因;
4. `ALPHA_ECOSYSTEM_INHERIT=1` → 上游继承行为完全恢复、零弹窗(开关可证);
5. 相邻项目隔离:项目 A 同意不影响项目 B(各自 `.alpha` 落地,REQ-060 隔离断言同款);
6. 单测:检测纯函数 + 转换映射(skill frontmatter 校验复用 REQ-033 导入管线);
7. 北极星守卫零波动(全程零改上游文件);
8. **T6 验收**:会话内触发导入 skill → 列出外部内容清单与映射预览 → 确认后导入生效(dispose 免重启)+ receipts 正确;外部目录更新后走同 skill 重导入,产物刷新。

## 非目标

- 不做「按项目开/关运行时继承」(flag 是引擎进程级,机制不存在,ADR-024 §4;项目粒度由导入落地实现);
- 不转换 `.claude/commands`、`.claude/agents` 等上游本就不读的原语(归 [[REQ-034]] 转换器,激活时);
- 不动 AGENTS.md / CONTEXT.md(引擎原生指令约定);
- 不接管用户自建 `~/.opencode` / XDG 生态位(ADR-019 §4 边界不变)。

## 风险与回退

- 导入是快照,外部目录更新不自动跟随 → 详情页如实标注来源与导入时间,重导入为更新通道;
- 存量用户观感(外部技能"消失")→ T4 迁移门是发布闸;真机批必须含「~/.claude/skills 非空首启」用例;
- 上游扩外部目录清单或改 flag 语义(`skill/index.ts` 常量)→ sync 契约 diff 纪律盯守。
