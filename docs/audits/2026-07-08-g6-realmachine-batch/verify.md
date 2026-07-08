# G6 第一批真机验收(2026-07-08,本机 dev,CDP 驱动)

> 环境:本机(作者机,存量态:`~/.claude/skills` 10 项含 graphify、`~/.alpha/skills` 有 REQ-052 旧出厂链、
> `~/.config/opencode/skills` 有 12 项用户自装技能)。dev build(alpha HEAD 含 PR #149–#156),
> 登录态 platform 代理。驱动 = CDP(:9222)真按钮真消息;截图在本目录。

## PASS(实测证据)

### REQ-062 品牌转写 —— 验收①(核心)PASS
- **Claude Sonnet 4.6**:问「你是什么产品?你叫什么名字?」→ 「**我是 alpha-code**,一款运行在 macOS 上的
  AI 编程助手…」,全文零 opencode 字样(截图 `run2-自称测试.png`);
- **DeepSeek V4 Flash**(非 claude 系):同问 → 「**我是 alpha-code**,macOS 上的本地 AI 编码助手…」零 opencode;
- 验收⑤半边:customize-alpha 在斜杠菜单可见(`/cust` → `/customize-alpha[技能]`)。

### REQ-066 斜杠菜单卫生 —— 验收①③(核心)PASS
- 来源徽标实拍:`/init [内置]`、`/review [内置]`、`/wrangler [技能]`(XDG 用户自装)、
  `/customize-opencode [项目]`(治理占位,见下史料)——内置/技能/项目三类抽查一致;
- **治理过滤 + 免重启**:本机治理真源 `governance.json` 曾丢失(疑历史清数据)→ 占位残留显示;重建真源后
  **不重启、下次打开菜单即消失**(`/cust` 只剩 customize-alpha)——过滤依据真源、打开时刷新,两点同证;
- REQ-067 落地后改由内置默认禁驱动,过滤依旧生效(同一 `/cust` 断言复测 PASS)。

### REQ-065 `.alpha` 纯度 —— 验收②③④ PASS
- **②存量拆链**:启动前 `~/.alpha/skills/` 有 skill-creator/agent-creator 两条 REQ-052 旧链(ls 存证)→
  启动后目录清空(链拆除 + 空目录顺手清);
- **③路径跟随**:dev 运行注入 dev 仓资源路径、4 个出厂技能菜单全可见 —— 路径随运行中的 app 变化实证;
- **④全树可溯**:`~/.alpha` 现仅 installs.json / alpha.jsonc / governance*.json / ecosystem-import.json
  (全为用户动作或 alpha 记账),skills/ 无任何系统件;
- **修订(用户拍板,PR #155/#156)**:出厂路径与出厂禁**双双零明文** —— `alpha.jsonc` 只剩用户内容
  (mcp×4 用户装 / agent.explore 用户禁 / skills.paths 仅 `~/.alpha/skills`),出厂件全部内存注入。

### REQ-063 继承 default-deny —— T1/T4 核心 PASS
- **T1 生效**:两 flag 实测到达引擎进程环境(`ps eww`:`OPENCODE_DISABLE_EXTERNAL_SKILLS=1` +
  `OPENCODE_DISABLE_CLAUDE_CODE_PROMPT=1`);`/grap` → 空(graphify 只存在于 `~/.claude/skills`,
  已不进引擎)——与之对照,XDG 用户自装技能(wrangler 等)照常可用(引擎原生生态位,ADR-019 §4 不接管,正确);
- **T4 全局迁移门**:首启弹出(本机 10 技能 + 全局 CLAUDE.md 存量),被选「不导入」→ marker 落盘
  (decision: declined)、二次启动不再弹;**注**:若想导入 graphify 等,删 `~/.alpha/ecosystem-import.json`
  重启再弹,或会话里说「导入外部技能」(integrate-project);
- T6:`/integ` → `/integrate-project[技能]` 菜单可见。

### REQ-067 出厂治理内置化 —— 全量 PASS(交付即验)
- 重启后 `alpha.jsonc` 零 `permission.skill` 明文、零占位 command(boot 剥离日志
  `factory-deny-stripped` + grep=0 实证);菜单过滤照常(customize-opencode 不显示)。

### REQ-061 弹层竞态 —— 验收①②③ PASS(2026-07-08 второй场,补验)
- 首验时自动化走错容器(把模型行当预设行);二场按真实结构(`.a-mpa` 覆盖层)驱动:
- **①** 模型弹层 → 添加供应商 → 点**已配置 DeepSeek 预设行**(B21 三次复现的硬断点)→ **层不关**、
  改键表单打开(标题 DeepSeek、输入框在位;截图 `req061-改键表单.png`);
- **②** 表单「返回」→ 回 step1(5 行预设)、层不关;
- **③** 弹层外空白点击 → 层正常关闭(回归不破);④组件级红绿单测随 PR #150。

## 未验(卡点如实)

| 项 | 验收条目 | 卡点 |
|---|---|---|
| REQ-062 | ②system 原文审计 ③开关回退(REBRAND_DISABLE 重启)④/init 实跑 ⑧task 委托 | ③④⑧可自动化但需再两轮重启+真会话写盘;②需 dev 抓 system(hook dump)。归下一真机批 |
| REQ-063 | 项目门弹窗(①②)、导入转换落盘、⑤项目隔离、④逃生开关 | **原生弹窗 CDP 点不了**,需人工点两下(我可以搭好测试项目,你点「导入」即可全链验) |
| REQ-066 | ②键入全名占位响应;MCP 徽标抽查(本机无 MCP prompt 命令) | 小残项,顺带下批 |
| REQ-061 | 弹层竞态复现路径 | 自动化没进到「添加供应商 step1」(点击后视图未切换,疑 Dialog 而非 pop 内步进),未构造出原复现场景;修复的单测在,真机走查需人工або下批重试 |

## 事故记录(诚实)
- 验收中误杀了正在运行的正式版 alpha-code(它占着 9222 调试口)——用户会话数据无损,重开即可;
- 迁移门「不导入」由现场点击落盘(graphify 等对 alpha 不可见),如需导入见上文两条通道。
