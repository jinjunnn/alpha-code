---
id: REQ-073
title: 统一装配弹窗(@/+ 合一)+ 模式收编 — 重设计 @ 弹窗、移除 build 组件、计划模式收进弹窗并以 chip 呈现(Codex 对标)
type: ux
priority: P1
repo: A
created: 2026-07-09
status: ready
source: 用户直提(2026-07-09,5 截图;同日 6 拍板点全同意 + 内置 agent 显示决策,T0 设计稿门进行中)
---

## 背景/诉求(用户,2026-07-09,截图对照)

1. **@ 弹窗简陋且与 + 割裂**:现 @ 菜单只有"引用"平铺(agent 两行英文长简介 + 文件);`+` 另有一个独立弹窗(文件与文件夹/附加终端 + 四条扩展行)。两个弹窗两套样式、键盘导航不一致(+ 弹窗无键盘支持)。用户拍板方向:**@ 和点击 + 弹出同一个弹窗**,整体重设计(Codex 参照:「添加」+「插件」分节的统一菜单)。
2. **build 组件要去掉**:composer 工具条上的 agent chip(⚙ build)信息量近零(下拉常只有 build 一行"默认");**默认即 build 模式**,不需要常驻控件。
3. **计划模式收进 @ 弹窗**(Codex 对标):弹窗「添加」节含「计划模式」行;选中 → composer 出现**可移除 chip「⊗ 计划」**+ placeholder 提示 +(Codex 有)Shift+Tab 快捷切换;再开弹窗该行变「关闭计划模式」。

## 机制现状(登记时已核,锚点)

- **@ 菜单** = `composer-autocomplete` at 模式(agents = v2 `agent.list` 过滤 `!hidden && mode!=="primary"` + files = `find.files`,选中插 mention 并记录真 prompt part);键盘/全量/滚动机制 REQ-072 刚修好,**分节/icon/尾签底座现成可复用**。
- **+ 菜单** = `alpha-composer.tsx:161` `AddButton`:文件与文件夹(`command.trigger("file.attach")`)/ 附加终端(`terminal.new`)+「扩展·定制中心」四行——**四行全部只是 `setExtHubOpen(true)`**(文档/PDF/表格/连接器点谁都一样,C28 意义上的 placebo 分身)。
- **agent chip** = `alpha-composer.tsx:258` `AgentChip`:`v2.agent.list` → `filterAgents`(滤内部档,REQ-055)→ 本地 `composerAgent` 信号 → 提交参数;**readonly 权限档联动**(perm=readonly 时 chip 禁用、固定只读档)。
- **计划 = 引擎 plan 主档**(与 build 同为引擎默认主档,治理 HARD_PROTECTED,见 GOALS G6 诚实边界):发送时带 `agent:"plan"` 即生效,**零引擎改动**;plan 是否出现在 agent.list(现 chip 未列出)实现时钉死——不影响方案,参数按名解析。
- **发送链**:home `startChat(worktree, text, parts, {agent})` / session `session.promptAsync({agent})` —— 模式 chip = agent 参数的 UX 重包装。

## 方案设计

### A. 统一装配弹窗(一个组件,两个触发器)

- **触发**:输入框敲 `@`(token 语法,续输过滤,REQ-072 同底座);点 `+`(button 打开同一组件)。
- **分节结构**(Codex 参照,alpha 语义):

| 节 | 性质 | 内容 |
|---|---|---|
| **添加** | 动作(不产 mention) | 文件和文件夹(`file.attach`,↵ 标注)· 附加终端 · **计划模式**(toggle;开启态显示「关闭计划模式」) |
| **Agent** | 引用(mention) | 子 agent(general/explore/自装),行 = 类型 icon + `@name` + 中文简介(general/explore 为 alpha 自写,映射 zh;外来原文)+ 行尾归属签(内置/个人)——REQ-072 同款排版 |
| **文件** | 引用(mention) | `find.files` 结果(输入即搜);无查询时显示提示行 |
| **扩展** | 动作 | 收敛为单行「扩展市场…」打开定制中心(砍掉 文档/PDF/表格 三条同动作分身,拍板④) |

- **交互底座全部继承 REQ-072**:键盘 ↑↓/↵/esc、选中 indigo 淡底、sticky 节标题、全量滚动、空态、页脚(语法提示改「/ 执行命令 · 技能」)。
- 动作类选中 = 执行动作并关弹窗(@ 触发时顺带清掉当前 @token);引用类选中 = 插入 mention(现语义不变)。

### B. build 组件移除 + 计划模式 chip

- **移除 `AgentChip`**;默认发送**缺省 agent 参数**(= 引擎默认 build;不显式写死名字,与 REQ-056/069 锁引擎默认语义的纪律一致)。
- **计划模式开启后**:composer 原 build 位出现 chip **「⊗ 计划」**(点 ⊗ 或再选「关闭计划模式」关闭);placeholder 附加提示;**Shift+Tab** 循环 build⇄plan(Codex 同款);发送带 `agent:"plan"`。
- **作用域 = 会话级**(推荐,Codex 同款):chip 留存至手动关闭;新会话默认 build。
- **权限档联动保留**:perm=readonly 时模式 chip 禁用(固定只读档,现 AgentChip 同语义);plan/readonly 不叠加。
- **第三方自装 primary agent**(移除 chip 后的入口):统一弹窗「添加」节动态列出为模式项(仅当存在第三方主档时出现),选中后 chip 显示该模式名、交互同计划——能力不回退(REQ-055 刚修过选择器一致性,不倒退)。

### 分期

- **T0 设计稿门(沿 REQ-072 惯例)**:HTML 设计稿(统一弹窗全状态:@ 触发/+ 触发/计划开启态/chip 交互/键盘态)→ 用户审核通过再开发;
- **T1 统一弹窗**:@/+ 合一 + 四节 + 动作/引用混合选择 + REQ-072 底座复用;
- **T2 模式收编**:去 AgentChip + 计划 chip + Shift+Tab + 会话级状态 + 权限联动 + 第三方主档动态项。

## 验收标准(草案)

1. `@` 与 `+` 打开同一弹窗,分节/键盘/滚动/空态/页脚与 `/` 菜单同族一致;
2. 「添加」节三项可用:文件选择、附加终端、计划模式 toggle;「扩展」为单行市场入口(无同动作分身);
3. Agent 节:子 agent 中文简介(alpha 自写者)+ 归属签;选中插 mention 且发送携带真 parts(既有单测语义不回归);
4. composer 不再有 build 组件;默认发送 = 引擎默认档(build);
5. 计划模式:弹窗开启 → 「⊗ 计划」chip 出现、placeholder 提示、发送带 `agent:"plan"`;⊗/再选/Shift+Tab 三路可关;会话级留存;perm=readonly 时禁用如实说明;
6. 第三方自装主档仍有入口(弹窗动态项),无第三方时不出现空节;
7. 零改上游;CDP 场景核验 + 真机截图([[visual-verify-required]])。

## 拍板(用户,2026-07-09 —— 6 点全同意 + 第 7 点设计裁定,本档翻 ready)

| # | 决策点 | 拍板 |
|---|---|---|
| 1 | GLOSSARY 语法分工 v2 | 「`/` = 执行;`@`/`+` = **装配本条消息**(引用 · 附加 · 模式)」——已修订 GLOSSARY(v1→v2,显式修订非漂移) |
| 2 | + 的实现方式 | 同一组件两触发器(+ 为 button 打开,选引用类直接插文本),不往输入框偷插 `@` |
| 3 | 计划模式作用域 | **会话级**(Codex 同款);home 新会话默认 build |
| 4 | 扩展节收敛 | 砍三条 placebo 分身,留单行「扩展市场…」 |
| 5 | 第三方 primary agent 入口 | 弹窗动态模式项(能力不回退) |
| 6 | 默认 agent 参数 | 缺省(引擎默认 build),不显式写死 |
| 7 | **内置子 agent 是否显示**(用户 2026-07-09 追问「考虑一下,请帮我设计」) | **显示但降噪**:general/explore 保留在 Agent 节——它们是所有用户唯一保底可用的子 agent(新用户零个人 agent,砍掉则 Agent 节空、"指派"语义死);治理 = 中文一句话简介(alpha 自写 prompt,有权配 zh)+ 行尾「内置」签,不再放英文长段;内部档(alpha-automation 系)绝不出现;build/plan 是模式、不入 Agent 节 |

## 非目标

- 不做 Codex「目标(Goal)」持续目标机制、不做「附加 Google Chrome」浏览器附加(另立项再议);
- 不改引擎 agent/权限语义,不动 plan/build 底座 prompt(G6 路线 B 归 REQ-064);
- `/` 命令菜单不动(REQ-072 刚定稿);权限 chip(完全访问/请求审批/只读)不动。
