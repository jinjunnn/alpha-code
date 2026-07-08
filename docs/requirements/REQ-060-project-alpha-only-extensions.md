---
id: REQ-060
title: 项目级扩展物 `.alpha`-only —— 五类(skill/command/agent/mcp/plugin)生成与安装全落 `<项目>/.alpha`,项目不产生 `.opencode`
type: feature
priority: P1
status: shipped
repo: A
created: 2026-07-07
source: 用户拍板(2026-07-07):「项目中生成的 skill command agent mcp 和 plugin 都应该落到 .alpha」「不希望每个项目出现 .alpha .opencode 两个目录」
related: [REQ-059, ADR-019, ADR-002, ADR-006, ADR-021, ADR-014, REQ-036, REQ-033]
design: ../designs/2026-07-07-project-alpha-only-extensions.md
---

# REQ-060 — 项目级扩展物 `.alpha`-only(项目唯一目录)

## 需求(用户拍板)

用户在项目中生成/安装的 **skill / command / agent / mcp / plugin 五类全部落 `<项目>/.alpha`**;项目里**不产生 `.opencode`**(连指针都没有)——项目唯一的 alpha 目录 = `.alpha`,且懒创建(没用过扩展/云/自动化的项目连 `.alpha` 都不出现)。权威方案 = `designs/2026-07-07-project-alpha-only-extensions.md`(v3)。

## 现状(2026-07-07 核查,为什么这是真需求)

- **主通道方向相反**:REQ-036 的 agent-creator **明文默认写 `<proj>/.opencode/agent/`**(其目标3);skill-creator(Anthropic 原稿)无落点规范;
- command / mcp / plugin **三类无任何项目级 alpha 通道**(mcp 恒全局,hub 的 workspace 参数只是 `{workspace}` 占位符替换);
- hub 项目 scope 底座在 main 侧存在(`ext-fs-installer.ts:69`)但 **UI 从不传 InstallTarget**(休眠),且形态是 `.opencode` 目录桥;
- 模型按上游惯例写 `.opencode/plugin/*.ts` 的路 = 桌面运行时必崩雷(ADR-006 生 TS)。

## 方案(要点,细节见设计 v3)

1. **布局**:`<proj>/.alpha/{alpha.jsonc, skills/, agents/, commands/, plugins/}`(+既有 installs/prefs/runs);plugins 只收自包含 JS(生 TS 拒收 loud)。
2. **引擎可见通道 = `@alpha-code/ext` 新插件 `alpha-project-bridge` 的 `config` hook**(per-instance,PluginInput 带 directory;dispose 重建即重注入):读 `<dir>/.alpha/alpha.jsonc` 合并 mcp / agent(prompt=读 agents/*.md)/ command(template 同理)/ skills 路径;**plugin 经 host fan-out**(动态 import `.alpha/plugins/*.js` 并转发全部 hook,解「插件列表先于 hook 已定」的鸡生蛋)。
3. **信任门(安全红线,必做)**:项目自带 mcp/plugin = 打开陌生仓库即加载可执行物 → 首次发现时 per-project 确认(ADR-021 consent 模式,`.alpha/prefs.json` 落 `extensionsConsent`,版本化);拒绝则该项目仅生效 skill/agent/command 文本类。
4. **创建流改造(主缺口)**:agent-creator 落点改 `<proj>/.alpha/agents/` + 登记条目(**REQ-036 目标3/验收5 需修订**,免弹窗性质不变);skill-creator 加 alpha 落点引导段;command 纳入轻量指导;**注册手段 = `alpha_register` ext 工具**(与 alpha_reload 同族:校验 SAFE_NAME/字段白名单 → 原子写 alpha.jsonc → dispose 一条龙,模型不手改 config)。
5. **hub/导入**:fs-installer 项目分支从目录桥改「`.alpha` + 条目」;mcp/plugin 增 target 走项目 alpha.jsonc;「安装到当前项目」UI 入口可分期(底座先改对)。
6. **边界**:用户自建的 `.opencode` 内容不迁移不接管(ADR-019 §4);用户显式要求模型写 `.opencode` 是用户自由,不拦。

## 验收标准

1. 会话内「给这个项目建个 skill / agent / command」→ 产物全在 `<proj>/.alpha/`,项目里**不存在 `.opencode`**,dispose 后下一条消息可用(真机);
2. 项目级 mcp / plugin 登记 → 条目在 `<proj>/.alpha/alpha.jsonc`,**仅该项目可见**(相邻项目隔离断言);首次加载过信任门,拒绝路径 = 仅文本类生效且 loud;
3. 未用扩展的项目**零目录新增**;用过的项目仅 `.alpha` 一个;
4. 生 TS plugin 拒收 loud(ADR-006 雷就此关闭);
5. 存量共存:用户自建 `.opencode/` 的项目 → alpha 零触碰、新建物仍走 `.alpha`、loud 注记;既有 alpha 项目桥(如有)reconcile 迁 config 通道并拆自有链(isAlpha 判定,REQ-052 同款);
6. REQ-036 验收 2/3(创建 → 发现 → 免重启)在新落点复测通过;
7. 零改上游;`alpha-check` 三关绿。

## 任务拆解

- **T0(与 REQ-059 共享)**:通道判定 spike —— hook 四路(mcp/skill/agent/command)变异可见性 + plugin host fan-out + 相邻项目隔离 + dispose 重注入;
- **T1** `alpha-project-bridge` ext 插件(hook 注入 + fan-out + 信任门);
- **T2** `alpha_register` ext 工具(+单测);
- **T3** 创建技能改稿(agent-creator / skill-creator / command 指导)+ **REQ-036 修订**;
- **T4** fs-installer 项目分支 config 化 + mcp/plugin target(UI 入口可分期);
- **T5** 真机批(验收 1-6)。

## 非目标

- 不迁移/不接管用户自建 `.opencode`;不做 `.mcp.json`;不做项目根 `opencode.jsonc` 方案(更显眼且撞用户文件);
- 原生 opencode CLI 对项目级扩展的可见性不提供(ADR-019 修订补充已记为接受的损失);
- 全局层(真源/provider/清理)归 [[REQ-059]]。

## 风险与边界

- hook "Notify" 语义 = T0 闸门;任何路由需回退 symlink → 停,回用户拍板;
- 信任门是新增同意面,文案与 B16/ADR-021 口径对齐(告知加载可执行物的含义);
- 项目移动/重命名:内容与 config 同在项目树内,相对完整迁移;alpha.jsonc 内绝对路径条目(plugin)由 reconcile/注册器修复(T0 后定相对 or 绝对+自愈)。
