# Timeline 全面优化 — 原子任务清单(1 任务 = 1 优化点)

> [!CAUTION]
> **冻结的历史任务分解(2026-07-11 cutover)。** 本文件不再回勾、排优先级
> 或驱动执行；当前 characterization 与验收尾项由
> [alpha-code#214](https://github.com/jinjunnn/alpha-code/issues/214) 和
> [Alpha Delivery](https://github.com/users/jinjunnn/projects/2) 承载。

> 配套:`audit.md`(逐条审计)、`timeline.html`(设计稿)、`dev-plan.md`(历史执行手册)。
> **关于数量**:旧稿 prose 写「~26 项 CSS」是分组估算,与枚举对不上 —— 本表改为**一处优化 = 一条任务**,共 **40 条**,口径与下方枚举**完全一致**:
>
> | 接缝 | 数量 | 说明 |
> |------|------|------|
> | **CSS** | **36** | 纯换肤,零改 opencode 源码 |
> | **INJECT** | **3** | 复用 `timeline-inject.tsx` 的 MutationObserver(TL-05/17/34) |
> | **ENGINE** | **1** | 上游引擎只换外框不重写(TL-39 终端) |
> | **合计** | **40** | |
>
> 优先级:**P0 = 11**(每会话可见的断层)· **P1 = 16**(常见)· **P2 = 13**(打磨/可选)。
> 落点(**已采方案 P · 2026-06-28**):CSS → 写进对应 `alpha-ui/timeline/<area>.css` 分文件(入口 `timeline-reskin.css` 已 `@import` 全部 partial,并行安全);共享原语放 `tools.css`;INJECT → `timeline-inject.tsx`。
> 每条字段:**钩子**(真机选择器)· **改动**(精确一句)· **验收**(可观察判据)· **依赖**(无 = 可独立开发)。
> 纪律:改完跑 `bun --cwd packages/ui-mac run typecheck` + CDP 真机截图([[visual-verify-required]]),禁止 grep 宣称完成。

---

## A. 用户输入侧(6 条)

### TL-01 · 文件附件 pill `CSS` `P1`
- 钩子:`[data-slot=user-message-attachment][data-type=file]` `-attachment-file` `-attachment-name` + `[data-component=file-icon]`
- 改动:做成「[类型徽] 文件名 · 行号」芯片(白底/边框/圆角),右对齐随气泡。
- 验收:带文件附件的用户消息上方显示文件芯片,非裸文件名。
- 依赖:无。⚠️ 注意现有 CSS 仅有 `[data-alpha-cmd] user-message-attachments{display:none}` 的隐藏规则,**不是**附件样式 —— 本条是新增样式。

### TL-02 · 图片附件缩略图 `CSS` `P1`
- 钩子:`[data-slot=user-message-attachment][data-type=image]` `-attachment-image` `[data-clickable=true]`
- 改动:固定 52px 圆角缩略图,`object-fit:cover`,hover `cursor:zoom-in`(原生点开预览保留)。
- 验收:图片附件为统一缩略图,不撑破气泡行。
- 依赖:无。

### TL-03 · 内联文件提及 `CSS` `P1`
- 钩子:`[data-component=user-message] span[data-highlight=file]`
- 改动:内联文件 chip(中性底 + mono + 文件图标),不换行截断。
- 验收:`@file` 引用呈 chip,与正文区分。
- 依赖:无。

### TL-04 · 内联 agent 提及 `CSS` `P1`
- 钩子:`[data-component=user-message] span[data-highlight=agent]`
- 改动:agent chip(accent 底 + 人形图标)。
- 验收:`@agent` 引用呈 accent chip。
- 依赖:无。

### TL-05 · 斜杠命令 chip 分类 `INJECT` `P1`
- 钩子:`.a-cmd-chip[data-kind]`(inject 建)+ `slashTypeMap`(从 `[data-slash-id]` 学类型)
- 改动:按类型输出文案分层 —— 命令「运行命令 · name」(accent)/技能「运行技能 · name」(橙)/MCP「MCP · name」(紫);name 后接**用户自己输入的提示词**(args,如「运行命令 · review pr 12」)。**不做「查看展开提示词」/ 不显示命令 .md 模板**(2026-06-30 用户明确否决,见 [[slash-chip-spec]];设计稿里的 查看展开 是错的)。CSS 变体配色在 `.a-cmd-chip[data-kind=command|skill|mcp]`。
- 验收:三类斜杠发送后折叠成对应配色+文案的 chip,后接用户自己的 args;**chip 上无「查看展开提示词」**。
- 依赖:无(独立于其它,但属 inject 文件,见 dev-plan 并行说明)。
- ⚠️ 已知限:冷加载的历史消息(本 session 之前发的)无法回溯命令类型 → 退化为普通命令 chip。可接受。

### TL-06 · 连接器/资源提及 chip `CSS` `P1` `_verify`
- 钩子:**待真机核实**(截图「GH GitHub」连接器 —— 可能是 `data-highlight` 的子类、附件、或 MCP 资源 mention)
- 改动:连接器 chip(图标方块 + 名)。
- 验收:连接器提及呈统一 chip。
- 依赖:无。⚠️ **开发前必须先真机复现确认钩子**(见 dev-plan §5「需先核实」),否则选择器无处下手。

---

## B. 助手输出侧(8 条)

### TL-07 · 助手脚注(模型·时长·tokens + 操作) `CSS` `P0`
- 钩子:`[data-slot=text-part-meta]` + `[data-slot=text-part-copy-wrapper]`(含 `[data-component=provider-icon]`)
- 改动:一行克制脚注 —— provider 图标 + agent + model + effort + 时长 + tokens(dot 分隔,tertiary);复制/重试/分支按钮 hover 显现(对齐用户脚注交互)。
- 验收:每条助手消息底部有脚注;hover 出操作按钮。
- 依赖:无。**P0 —— 每条助手消息都有,现完全裸。**

### TL-08 · Markdown 表格 `CSS` `P0`
- 钩子:`[data-slot=session-turn-assistant-content] [data-component=markdown] table/thead/tbody/th/td`
- 改动:外边框 + 圆角 + 表头底色 + 行分隔 + 偶行斑马;窄列横向滚动不撑破 820px。
- 验收:助手表格有边框斑马,不再裸排。
- 依赖:无。**P0 —— 真机大量出现(严重性/位置/问题表)现全裸。**

### TL-09 · Markdown 富元素(列表/标题/引用/分隔/链接) `CSS` `P1`
- 钩子:`[data-component=markdown] ul/ol/li/h1-h4/blockquote/hr/a`
- 改动:标题层级字号、引用左条、hr 细线、链接 accent 下划线、列表缩进对齐。
- 验收:长回答的结构化排版清晰。
- 依赖:无。

### TL-10 · 代码块复制按钮 + 语言标签 `CSS` `P1`
- 钩子:`[data-component=markdown-code]` `[data-slot=markdown-copy-button][data-copied]`
- 改动:代码块头条(语言标签 + 右侧复制按钮),复制态反馈;正文 pre 卡已做,这里补头/钮。
- 验收:代码块有语言标签 + 可见复制按钮。
- 依赖:无(与 TL-09 同属 markdown,但选择器不同,可独立)。

### TL-11 · Thinking 流式态 `CSS` `P1`
- 钩子:`[data-slot=session-turn-thinking]` + `.session-turn-thinking-heading`
- 改动:alpha「工作中」pill + shimmer 文字 + 三点动画。
- 验收:思考中显示 alpha pill,非裸 shimmer。
- 依赖:无。

### TL-12 · 中断态 `CSS` `P2`
- 钩子:`[data-slot=text-part-copy-wrapper][data-interrupted]`
- 改动:「已由你停止 · 继续生成」行(warning 方块图标 + accent 继续链接)。
- 验收:停止的回答下方显示中断行。
- 依赖:无(与 TL-07 同 wrapper,但靠 `[data-interrupted]` 选择器区分,独立)。

### TL-13 · 重试态卡 `CSS` `P2`
- 钩子:`[data-slot=session-turn-retry]`
- 改动:warning 底卡 + spinner +「网关 429,N 秒后重试」。
- 验收:自动重试时显示该卡。
- 依赖:无。

### TL-14 · reasoning 折叠 + 时长精修 `CSS` `P2`
- 钩子:`[data-component=reasoning-part]`(基础卡已做)
- 改动:补「思考 · Ns · 摘要」头 + chevron 折叠态(若上游已折叠则仅补时长/摘要样式)。
- 验收:reasoning 有时长 + 可折叠观感。
- 依赖:无。

---

## C. 工具卡通用外壳(2 条)

### TL-15 · 工具运行/完成状态 `CSS` `P0`
- 钩子:`[data-component=tool-status-title]` `[data-slot=tool-status-swap/-done/-active/-suffix/-prefix/-tail]` `[data-active]`
- 改动:运行中 → accent + spinner 徽;完成 → 成功/中性徽;swap/suffix 动画沿用原生,只换色与徽形。
- 验收:工具卡有明确「运行中/完成」状态徽。
- 依赖:无。**P0 —— 每个工具卡都有状态,现裸。**

### TL-16 · 折叠箭头统一 `CSS` `P2`
- 钩子:`[data-slot=collapsible-arrow]` `-arrow-icon`
- 改动:chevron 颜色/尺寸/旋转过渡统一到 alpha 规范。
- 验收:所有可折叠卡的箭头一致。
- 依赖:无。

---

## D. 具体工具(13 条)

### TL-17 · bash 退出码徽标 `INJECT` `P0`
- 钩子:`[data-component=bash-output] [data-slot=bash-pre]`(原生无退出码 → inject 解析尾部 exit)
- 改动:解析退出码 → `退出 0` 绿徽 / 非 0 红徽,注入 `tool-trigger` 右侧(同 `.a-openp` 注入先例)。
- 验收:bash 卡头显示退出码徽。
- 依赖:无。

### TL-18 · bash 描述行 `CSS` `P1`
- 钩子:`[data-component=shell-submessage]` `[data-slot=shell-submessage-value/-width]`
- 改动:命令下方描述行 tertiary 小字,缩进对齐图标。
- 验收:bash 描述不再裸排。
- 依赖:无。

### TL-19 · read 已读文件行 `CSS` `P1`
- 钩子:`[data-component=tool-loaded-file]`
- 改动:每行「[read 图标] 路径(mono)」+ hover 面;多文件成列表。
- 验收:read 工具展开为整齐文件列表。
- 依赖:无。

### TL-20 · glob/grep 输出 `CSS` `P1`
- 钩子:`[data-component=tool-output][data-scrollable] [data-component=markdown]`(grep/glob,非 list)
- 改动:命中行 `文件:行` 着色 + 关键词高亮 + 计数;**严格区分 list(已有 a-dirgrid)**。
- 验收:grep 结果可扫读,文件名/行号着色。
- 依赖:无。⚠️ 不要碰 list 目录输出(TL-05 网格已有,inject 标了 `data-alpha-dirgrid`)。

### TL-21 · 结构化文件卡头(紧凑) `CSS` `P0`
- 钩子:`[data-slot=message-part-title-area/-title/-title-text/-title-filename/-path/-directory/-actions]`
- 改动:把 edit/write 触发头压成单行「[图标] 写入 filename 目录灰 +N/−N 在面板打开 ›」,消除截图里的嵌套文件框/空白。
- 验收:写/编辑卡头单行紧凑,无嵌套空框。
- 依赖:**TL-22**(改动徽标在卡头复用)。

### TL-22 · +N/−N 改动徽标 `CSS` `P0` `[共享原语]`
- 钩子:`[data-component=diff-changes][data-variant=default|bars]` `[data-slot=diff-changes-additions/-deletions]`
- 改动:绿 `+N` / 红 `−N` tabular-nums 徽;`bars` 变体小色块。**全局原语**,被 TL-21/32/38 复用。
- 验收:所有出现改动数的地方统一徽样式。
- 依赖:无。⚠️ **应最先做**(P0 内第一个),其它三处依赖它。

### TL-23 · apply_patch 多文件 diff `CSS` `P1`
- 钩子:`[data-component=apply-patch-tool/apply-patch-file-diff]` `[data-slot=apply-patch-file-info/-filename/-directory/-change][data-type=add|delete|modify]`
- 改动:每文件折叠项 + 增删改色标 + diff 卡(现仅顶边框)。
- 验收:apply_patch 多文件呈整齐折叠 diff。
- 依赖:无(可复用 TL-22 徽,但有独立的 change 标签)。

### TL-24 · todos 项状态 `CSS` `P2`
- 钩子:`[data-component=todos]` `[data-slot=message-part-todo-content][data-completed=completed]`
- 改动:勾选框 done(绿填)/now(accent 边)/pending(灰)三态 + 进度。
- 验收:todo 三态可视,完成态删除线。
- 依赖:无(卡壳已做)。

### TL-25 · 子任务卡 spinner/标题/箭头 `CSS` `P2`
- 钩子:`[data-component=task-tool-card/task-tool-spinner/task-tool-title/task-tool-action]`
- 改动:agent 着色标题 + 运行 spinner + 导航箭头 + 运行进度条动画。
- 验收:子任务卡运行态有 spinner,完成可点进。
- 依赖:无(卡 edge 已做)。

### TL-26 · 联网结果列表 `CSS` `P1`
- 钩子:`[data-component=exa-tool-output]` `[data-slot=exa-tool-links/-link]`
- 改动:每条 favicon + 标题省略 + 域名右对齐 + hover(现仅卡框)。
- 验收:websearch 结果呈可点列表。
- 依赖:无。

### TL-27 · webfetch 触发行 `CSS` `P2`
- 钩子:`webfetch` BasicTool(hideDetails,subtitle 为链接)
- 改动:链接 subtitle accent + 截断;触发行对齐其它工具。
- 验收:webfetch 行链接可读。
- 依赖:无。

### TL-28 · MCP/通用工具文案分层 `CSS` `P2`
- 钩子:`GenericTool` → `[data-component=tool-trigger]`(无独立 server 钩子)
- 改动:把 `mcp__server__tool` 拆显为「MCP · server · tool」(CSS 能做的:紫图标已有 + 标题样式;**完整 server/tool 拆分需 inject**,见 ⚠️)。
- 验收:MCP 工具卡可辨识 server。
- 依赖:无。⚠️ 若要拆 `mcp__server__tool` 命名需 inject 解析(可降级:仅 CSS 着色 + 原名)。

### TL-29 · 诊断列表 `CSS` `P1`
- 钩子:`[data-component=diagnostics]` `[data-slot=diagnostic/-label/-location/-message]`
- 改动:error 底卡 + 每行「ERR loc msg」mono。
- 验收:编辑后 LSP 报错呈紧凑红列表。
- 依赖:无。

---

## E. 上下文分组 / 回合 / 结构(5 条)

### TL-30 · 已探索分组标题/计数 `CSS` `P1`
- 钩子:`[data-slot=context-tool-group-title/-label/-summary]`
- 改动:「已探索 · N 次读取 · M 次搜索」标题层级 + 计数对齐(分组壳/项已做)。
- 验收:分组头文字有层级,非裸。
- 依赖:无。

### TL-31 · 计数动画换肤 `CSS` `P2` `[可保留原生]`
- 钩子:`[data-component=tool-count-summary/tool-count-label/animated-number]`
- 改动:动画数字配色对齐 alpha(或**保留原生**,仅确保配色不突兀)。
- 验收:计数动画不突兀。
- 依赖:无。✅ 已定(2026-06-28):**换肤**(配色对齐 alpha,保留原生动画时序)。

### TL-32 · 本回合改动汇总 `CSS` `P0`
- 钩子:`[data-component=session-turn-diffs-group]` `[data-slot=session-turn-diffs/-diffs-header/-diffs-label/-diffs-toggle/-diffs-more]` `[data-component=session-turn-diffs-content]` `[data-slot=session-turn-diff-trigger/-path/-directory/-filename/-meta/-changes/-chevron]`
- 改动:`.diffsum` 卡 —— 头(图标+「本回合改动 · N 文件」+ 总 +N/−N)、可折叠、每文件行(mono 名 + 目录灰 + 徽 + chevron + 在面板打开)。
- 验收:多文件回合显示改动汇总卡(替代截图「1 Changed 个文件」裸框)。
- 依赖:**TL-22**(复用徽)。**P0。**

### TL-33 · 上下文压缩分隔 `CSS` `P1`
- 钩子:`[data-component=compaction-part]` `[data-slot=compaction-part-divider/-line/-label]`
- 改动:居中胶囊「上下文已压缩 · 保留要点」+ 两侧细线。
- 验收:压缩点呈居中胶囊分隔。
- 依赖:无。

### TL-34 · 回合分隔 `INJECT` `P2` `[可选]`
- 钩子:**原生无专用钩子** → inject 按 `session-turn` 边界/时间插入
- 改动:「HH:MM · 新一轮」细线分隔。
- 验收:新回合间有分隔线。
- 依赖:无。✅ 已定(2026-06-28):**做**(inject 按 session-turn 边界插「HH:MM · 新一轮」)。

---

## F. 右侧审查面板(5 条)

### TL-35 · 面板头/标题/操作 `CSS` `P0`
- 钩子:`[data-component=session-review]` `[data-slot=session-review-header/-title/-actions/-scroll/-container]`
- 改动:面板头到 alpha 卡语言(标题、tab 行、操作按钮),与左侧一致的边框/圆角。
- 验收:审查面板头不再原生。
- 依赖:无。**P0。**

### TL-36 · 统一/拆分 切换(tabs + radio) `CSS` `P0`
- 钩子:`[data-component=tabs]` `[data-slot=tabs-list/-trigger/-trigger-wrapper/-content/-trigger-close-button]` + `[data-component=radio-group]` `[data-slot=radio-group-*]`
- 改动:分段控件 alpha 化(选中态 surface + 阴影);文件 tab 同。
- 验收:统一/拆分切换为 alpha 分段控件。
- 依赖:无。⚠️ Kobalte 组件,改前确认内部结构(见 dev-plan §5)。

### TL-37 · 视图模式 select `CSS` `P0`
- 钩子:`[data-component=select]` `[data-slot=select-select-trigger/-value/-icon]`
- 改动:select 触发器到 alpha 输入样式。
- 验收:视图 select 与 alpha 一致。
- 依赖:无。

### TL-38 · 审查文件行 `CSS` `P0`
- 钩子:`[data-slot=session-review-trigger-content/-file-info/-file-name-container/-filename/-directory/-view-button/-change-group/-change/-diff-chevron/-trigger-actions]` `[data-component=file-icon]`
- 改动:每文件行 mono 名 + 目录灰 + 徽 + chevron + hover;选中态 surface。
- 验收:审查文件列表呈 alpha 行(对齐截图右栏)。
- 依赖:**TL-22**(复用徽)。**P0。**

### TL-39 · 终端外框 `ENGINE` `P2`
- 钩子:`[data-component=terminal]`(ghostty)
- 改动:仅容器边框/圆角/头条,**不动终端内核**。
- 验收:终端 tab 外框对齐 alpha,内核不变。
- 依赖:无。⚠️ ENGINE —— 只换外框。

---

## G. 杂项(1 条)

### TL-40 · scroll-to-bottom 按钮 `CSS` `P2` `_verify`
- 钩子:**待核实**(设计稿 `.s2b`;原生回到底部按钮的钩子未确认)
- 改动:圆形毛玻璃按钮固定底部居中。
- 验收:滚动时显示回到底部按钮。
- 依赖:无。⚠️ 开发前核实是否有原生按钮(见 dev-plan §5)。

---

## 依赖/独立性总览

- **完全独立(36 条)**:除下列三条外,所有任务选择器互不重叠,可任意顺序/并行开发。
- **共享原语先行**:**TL-22**(改动徽标)是 TL-21 / TL-32 / TL-38 的视觉依赖 → **P0 内最先做**;之后三者仍各自独立(只引用同一徽样式)。
- **同文件物理冲突**:36 条 CSS 默认都改 `timeline-reskin.css` 同一文件 → **逻辑独立但物理串行**。若要真正并行(多 agent),按 dev-plan §3 拆 `timeline/<area>.css` 分文件,则物理也独立。
- **需先核实钩子(3 条)**:TL-06 连接器、TL-40 回到底部、TL-28 的 server 拆分 —— 见 dev-plan §5,**开发前真机复现,否则无选择器可写**。
- **用户已决策(2026-06-28)**:方案 P 并行拆文件(已建);TL-31 **换肤**;TL-34 **做**;TL-39 **做**(只换框)。
