# Timeline 全面审计 — 哪些已优化 / 哪些仍是裸样式

> 日期:2026-06-28 · 分支 `feat/ui-redesign`
> 取证方式:① CDP 连真机 dev app(`ALPHA_CDP=1`,9222)dump 活动会话的全部 `data-component/data-slot`;② 两个 Explore agent 通读 `packages/ui` + `packages/app` + `packages/opencode` 源码做构件全清单;③ 9 张真机截图;④ 通读现有 `timeline-reskin.css`(529 行)+ `timeline-inject.tsx`(324 行)。
> 配套:`timeline.html`(全面设计稿)、`tasks.md`(分期任务)。
> 关联:取代/扩展 `docs/designs/2026-06-25-composer-model-redesign/timeline.html`(旧稿只覆盖主线 + 7 缺口,远不完整)。

## 0. 结论先行

旧设计稿 + 现有实现**只覆盖了约 1/3 的时间线构件**。经真机 DOM 核对,opencode 时间线实际会渲染 **50+ 个独立构件**,其中:

- ✅ **已 alpha 化(够用)**:约 11 类(工具卡壳/触发头/类型图标、用户气泡、reasoning、bash 输出、写/编辑折叠、错误卡、用户脚注、技能 chip、目录网格、在面板打开、命令 chip)。
- 🟡 **部分(有壳无内,或缺状态)**:约 9 类。
- ❌ **完全裸样式(直接回落 opencode 原生)**:约 **22 类** —— 包括**每个会话都出现**的:**助手脚注(模型·时长)、本回合改动汇总、右侧审查面板、Markdown 表格、工具运行/完成状态、+N/−N 改动徽标、结构化文件卡头**。

下面是逐条清单。状态图例:✅ 已优化 · 🟡 部分 · ❌ 裸样式。接缝:**CSS** = 纯换肤零改源码 · **INJECT** = 复用 `timeline-inject.tsx` 的 MutationObserver 加层 · **ENGINE** = 上游重型引擎,不重写(只外壳换肤)。

---

## 1. 用户输入侧(右对齐)— 用户最关心的「斜杠命令 / 附件 / 提及」

| # | 构件 | 真机钩子(`file:line`) | 状态 | 接缝 | 缺口说明 |
|---|------|------------------------|------|------|----------|
| U1 | 用户文本气泡 | `[data-slot=user-message-body]` / `-text` (message-part.tsx:1168) | ✅ | CSS | accent 气泡 + 扁平内框已做 |
| U2 | 用户脚注(agent·model·time) | `[data-slot=user-message-meta]` `-sep` `-tail` (1177) | ✅ | CSS | 已降噪 + hover 复制 |
| U3 | **文件附件 pill** | `[data-slot=user-message-attachment][data-type=file]` `-attachment-file` `-attachment-name` (1141) | ❌ | CSS | 裸 —— 需 `YML docker-compose.yml` 样式的文件芯片(图标+名+行号) |
| U4 | **图片附件缩略图** | `[data-slot=user-message-attachment][data-type=image]` `-attachment-image` (1158) | ❌ | CSS | 裸 img —— 需固定尺寸圆角缩略图 + 点开预览 |
| U5 | **内联文件提及** | `<span data-highlight=file>` (1269) | ❌ | CSS | `@file` 引用无样式 —— 需 chip/底色 |
| U6 | **内联 agent 提及** | `<span data-highlight=agent>` (1269) | ❌ | CSS | `@agent` 引用无样式 —— 需 chip/底色 |
| U7 | **斜杠命令 chip(已发送后折叠)** | inject `.a-cmd-chip` + `[data-component=user-message][data-alpha-cmd]` | 🟡 | INJECT+CSS | 现仅 `图标+名+args`;缺设计稿的「运行命令 · init · 查看展开提示词 ›」标签层、点开看展开提示词、按类型(命令/技能/MCP)的完整文案 |

### 用户斜杠输入的完整分类(经源码核实 `slash-popover.tsx` + `command/index.ts`)

opencode 的 `/` 面板条目结构 `SlashCommand{ trigger, type:"builtin"|"custom", source?:"command"|"mcp"|"skill" }`,**关键事实:发送后用户消息上没有任何 DOM 标记表明它来自命令**(builtin 展开成 `synthetic` 文本被过滤;custom 直接显示 `/trigger arg` 原文)→ 所以 alpha 必须靠 send 时捕获(现有 inject 做法正确)。需要正确区分展示的类型:

| 类别 | 触发 | 面板徽标 | 发送后原生表现 | alpha 应展示为 |
|------|------|----------|----------------|----------------|
| **内置命令** | `/init` `/review` | 无 | 展开成 synthetic(被过滤)→ 空消息 | 「运行命令 · init」accent chip + 「查看展开提示词」 |
| **配置命令** | `/<自定义>` (.opencode/command) | 无 | 显示 `/trigger arg` 原文 | 「运行命令 · name」accent chip |
| **MCP 提示** | `/<mcp-prompt>` | `MCP` | 显示 `/trigger arg` 原文 | 「MCP · name」紫 chip |
| **技能** | `/<skill>` | `技能` | 显示 `/trigger arg` 原文 + 触发 skill 工具卡 | 「运行技能 · name」橙 chip(与执行态的技能工具卡区分,见 T13) |
| **Agent 提及** | `@agent`(**非斜杠**) | — | 内联 `data-highlight=agent` | 内联 agent chip(U6) |

> 用户原话「运行命令 init、运行技能,还有哪些 slash 命令需要正确显示」→ 答案是上表 5 类:**内置命令 / 配置命令 / MCP 提示 / 技能 / @agent 提及**。现有实现只把三类(command/skill/mcp)折叠成同一个极简 chip,**缺类型文案分层 + @agent + 展开提示词**。

---

## 2. 助手输出侧(左对齐)

| # | 构件 | 真机钩子 | 状态 | 接缝 | 缺口 |
|---|------|----------|------|------|------|
| A1 | 助手 markdown 正文 + 阅读宽度 + 内联 code | `[data-slot=session-turn-assistant-content] [data-component=text-part]` | ✅ | CSS | 已做 820px 测量 + code chip |
| A2 | 助手围栏代码块 | `… pre` / `pre code` | ✅ | CSS | 软卡 + mono 已做 |
| A3 | **Markdown 表格** | `[data-component=markdown] table/thead/tbody/th/td` | ❌ | CSS | 真机大量出现(严重性/位置/问题表)**完全裸**—— 需边框/斑马纹/表头底色 |
| A4 | markdown 列表/标题/引用/hr | `[data-component=markdown] ul/ol/h1-4/blockquote` | 🟡 | CSS | 仅 li 间距,缺标题层级/引用条/分隔线 |
| A5 | 代码块组件 + 复制按钮 | `[data-component=markdown-code]` `[data-slot=markdown-copy-button]` | 🟡 | CSS | 复制按钮 + 语言标签未换肤 |
| A6 | **助手脚注(agent·model·时长)** | `[data-slot=text-part-meta]` (1584) | ❌ | CSS | **每条助手消息都有,完全裸**—— 设计稿的富脚注(agent/model/effort/tokens/time + 复制/重试/分支)未实现 |
| A7 | 助手复制按钮 | `[data-slot=text-part-copy-wrapper]` | ❌ | CSS | 裸 |
| A8 | reasoning/思考卡 | `[data-component=reasoning-part]` (1605) | ✅ | CSS | 基础卡已做;可加折叠 + 时长 |
| A9 | 「Thinking…」流式态 | `[data-slot=session-turn-thinking]` + heading | ❌ | CSS | 裸 shimmer —— 需 alpha 工作中 pill |
| A10 | 中断态 | `[data-slot=text-part-copy-wrapper][data-interrupted]` | ❌ | CSS | 「已由你停止 · 继续生成」未做 |
| A11 | 重试态卡 | `[data-slot=session-turn-retry]` (session-turn.tsx:55) | ❌ | CSS | 裸 |

---

## 3. 工具卡(通用外壳 + 状态)

| # | 构件 | 真机钩子 | 状态 | 接缝 | 缺口 |
|---|------|----------|------|------|------|
| C1 | 工具卡壳 | `[data-component=tool-part-wrapper]` | ✅ | CSS | |
| C2 | 工具触发头 | `[data-component=tool-trigger]` `[data-slot=basic-tool-tool-title]` | ✅ | CSS | |
| C3 | 彩色类型图标 | inject `.a-tc-ico` | ✅ | INJECT | read/bash/edit/write/task/web/skill/search/mcp 色板已做 |
| C4 | **运行/完成状态** | `[data-component=tool-status-title]` `[data-slot=tool-status-swap/-done/-active/-suffix/-prefix/-tail]` (tool-status-title.tsx:92) | ❌ | CSS | 「运行中/已完成」动画态文字裸 —— 设计稿的 `运行中` spinner 徽标 + `退出0/完成` 徽标未做 |
| C5 | 折叠箭头 | `[data-slot=collapsible-arrow]` `-arrow-icon` | 🟡 | CSS | 旋转/颜色未统一 |
| C6 | 工具副标题/参数 | `[data-slot=basic-tool-tool-subtitle/-arg]` | ✅ | CSS | |

---

## 4. 具体工具

| # | 构件 | 真机钩子 | 状态 | 接缝 | 缺口 |
|---|------|----------|------|------|------|
| T1 | bash 输出体 | `[data-component=bash-output]` `[data-slot=bash-pre]` | ✅ | CSS | mono recessed 已做 |
| T2 | **bash 退出码徽标** | (原生无)`[data-slot=bash-pre]` 内容 | ❌ | INJECT | 设计稿「退出 0」绿徽 / 非 0 红徽未做 |
| T3 | bash 描述动画 | `[data-component=shell-submessage]` `-value` | ❌ | CSS | 裸 |
| T4 | read 已读文件行 | `[data-component=tool-loaded-file]` (1641) | ❌ | CSS | 裸文件行 —— 需图标 + 路径样式 |
| T5 | list 目录 → 文件网格 | inject `.a-dirgrid` + `[data-component=tool-output]` | ✅ | INJECT | `共 N 项` 网格已做(仅 list/dir) |
| T6 | **glob/grep 输出** | `[data-component=tool-output] [data-component=markdown]` | 🟡/❌ | CSS | 仅卡框;内部命中列表裸文本 |
| T7 | 编辑/写入紧凑折叠 | `[data-component=edit-tool/write-tool] [data-slot=collapsible-content]` | ✅ | CSS | 内联体已隐藏 |
| T8 | 「在面板打开」pill | inject `.a-openp` | ✅ | INJECT | |
| T9 | **结构化文件卡头** | `[data-slot=message-part-title/-title-text/-title-filename/-path/-directory/-actions]` (2005) | 🟡 | CSS | 真机仍显「嵌套文件框 + 路径行 + 单行预览」(截图)—— 需压成单行卡头 |
| T10 | **+N/−N 改动徽标** | `[data-component=diff-changes]` `[data-slot=diff-changes-additions/-deletions]` (diff-changes.tsx:96) | ❌ | CSS | 裸 —— 绿/红数字徽 |
| T11 | apply_patch 多文件 diff | `[data-component=apply-patch-file-diff]` `[data-slot=apply-patch-change]` | 🟡 | CSS | 仅顶边框 |
| T12 | todos | `[data-component=todos]` `[data-slot=message-part-todo-content][data-completed]` | 🟡 | CSS | 卡壳已做;勾选框/完成态/进行中态未精修 |
| T13 | question/answers | `[data-component=question-answers]` `[data-slot=question-text/answer-text]` | ✅ | CSS | 基础已做 |
| T14 | 技能工具卡 | `[data-component=tool-part-wrapper]:has(.agent-title)` | ✅ | CSS | 「技能 · name · 已加载 ›」chip 已做 |
| T15 | 子任务卡 | `[data-component=task-tool-card]` `task-tool-spinner/-title/-action` (1844) | 🟡 | CSS | 卡 edge 已做;spinner/标题色/箭头未做 + 运行动画缺 |
| T16 | **联网结果列表** | `[data-component=exa-tool-output]` `[data-slot=exa-tool-links/-link]` (824) | 🟡/❌ | CSS | 仅卡框;结果链接列表(favicon+标题+域名)裸 |
| T17 | webfetch | `BasicTool` hideDetails | 🟡 | CSS | 仅触发行 |
| T18 | **MCP/通用工具** | `GenericTool` (317) | 🟡 | CSS/INJECT | 紫图标兜底已做;缺「MCP · server · tool」分层文案 |
| T19 | **诊断(LSP 错误)** | `[data-component=diagnostics]` `[data-slot=diagnostic/-label/-location/-message]` (141) | ❌ | CSS | 编辑后报错裸列表 |

---

## 5. 上下文分组 / 回合级 / 结构

| # | 构件 | 真机钩子 | 状态 | 接缝 | 缺口 |
|---|------|----------|------|------|------|
| G1 | 已探索分组壳/列表/项 | `[data-component=context-tool-group-trigger]` `[data-slot=context-tool-group-list/-item]` | ✅ | CSS | |
| G2 | **分组标题/标签/汇总** | `[data-slot=context-tool-group-title/-label/-summary]` (970) | 🟡 | CSS | 「已探索 N 次读取」标题文字裸 |
| G3 | **动画计数** | `[data-component=tool-count-summary/tool-count-label/animated-number]` | 🟡 | CSS | 计数动画未换肤(可保留原生) |
| S1 | 对话列宽度 | `[data-slot=session-turn-message-container]` | ✅ | CSS | 820px 测量 |
| S2 | **本回合改动汇总** | `[data-component=session-turn-diffs-group]` `[data-slot=session-turn-diffs/-header/-label/-content/-diff-trigger/-diff-path/-diff-filename/-diff-changes/-diff-chevron]` (session-turn.tsx:438) | ❌ | CSS | **每个多文件回合都有,完全裸**(截图「1 Changed 个文件」)—— 设计稿 `.diffsum` 未实现 |
| S3 | **上下文压缩分隔** | `[data-component=compaction-part]` `[data-slot=compaction-part-divider/-line/-label]` (1465) | ❌ | CSS | 裸 |
| S4 | 回合分隔(新一轮) | (原生无专用钩子) | ❌ | INJECT(可选) | 设计稿 `.turn-div`;原生无 hook,需 inject 或放弃 |

---

## 6. 错误态

| # | 构件 | 真机钩子 | 状态 | 接缝 |
|---|------|----------|------|------|
| E1 | 工具错误卡 | `[data-kind=tool-error-card]` `tool-error-card-icon` `[data-slot=tool-error-card-content]` | ✅ | CSS |
| E2 | 消息级模型错误 | `.error-card` / `[data-component=card][data-variant=error]` | ✅ | CSS |

---

## 7. 右侧审查面板(session-review)— 整块裸,大缺口

真机截图:右栏「审查 118 · Git changes · 统一/拆分 tab · 全部展开 · 每文件 +N −0 行」**全部 opencode 原生**,与左侧 alpha 卡语言完全脱节。

| # | 构件 | 真机钩子 | 状态 | 接缝 |
|---|------|----------|------|------|
| R1 | 面板头/标题/操作 | `[data-component=session-review]` `[data-slot=session-review-header/-title/-actions]` | ❌ | CSS |
| R2 | 统一/拆分 切换 | `[data-component=radio-group]` `[data-component=tabs]` `[data-slot=tabs-trigger]` | ❌ | CSS |
| R3 | 文件行 | `[data-slot=session-review-trigger-content/-file-info/-filename/-directory/-view-button/-change-group/-diff-chevron]` `[data-component=file-icon]` | ❌ | CSS |
| R4 | 视图模式 select | `[data-component=select]` `[data-slot=select-select-trigger]` | ❌ | CSS |
| R5 | 终端 tab(ghostty) | `[data-component=terminal]` | — | ENGINE(不重写,仅外框) |

---

## 8. 统计(口径与 tasks.md 一致)

> 上一版 prose 写「~26 CSS」是分组估算,与枚举对不上。按**一处优化 = 一条任务**精确重算:

- 时间线构件总数(真机核实):**~52**
- ✅ 已优化(够用,无任务):**~12** · 需优化(= tasks.md 枚举):**40**
- 需优化的接缝拆分(与 tasks.md 表完全一致):**CSS 36 · INJECT 3 · ENGINE 1**
  - INJECT 3 = TL-05 命令 chip 分类 · TL-17 bash 退出码 · TL-34 回合分隔(可选);TL-28 MCP 拆名为可降级 inject。
  - ENGINE 1 = TL-39 终端外框(只换框)。
- 优先级:**P0 = 11 · P1 = 16 · P2 = 13**。
- 全部不碰 `packages/ui` 源码,守 ADR-016(前端接管)+ ADR-002/005(后端零改)。

> 完整性复核(2026-06-28,真机 CDP hook dump × 源码全清单 × 9 截图交叉):新补 3 项 —— TL-06 连接器/资源提及 chip、TL-09 markdown 富元素(链接/引用/标题)、TL-40 回到底部按钮。其中 TL-06/TL-40/TL-28 钩子待真机核实(见 tasks/dev-plan)。其余构件(step-start/snapshot/patch 等)经核 opencode PART_MAPPING 仅 text/reasoning/tool/compaction,无遗漏。

## 9. 优先级建议(详见 tasks.md)

- **P0(每会话可见,体验断层最大)**:A6 助手脚注 · S2 本回合改动 · R1–R4 审查面板 · A3 表格 · C4 工具状态 · T10 改动徽标 · T9 文件卡头 · T2 bash 退出码。
- **P1(常见)**:U3–U7 附件/提及/命令 chip · T16 联网结果 · T4 已读文件 · T6 grep 输出 · G2 分组标题 · S3 压缩分隔 · A9 Thinking · T19 诊断。
- **P2(打磨)**:T3 bash 描述 · T15 子任务 spinner · A10 中断 · A11 重试 · T12 todo 态 · A4/A5 markdown 细节 · S4 回合分隔。
