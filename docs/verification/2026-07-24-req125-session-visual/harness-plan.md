---
title: "REQ-125 V1 采集方法 — 真机操作序列与组件 harness 方案"
kind: verification
status: draft
owners:
  - alpha-code maintainers
last_reviewed: 2026-07-24
---

# REQ-125 #547 V1 · 采集方法(harness plan)

行 ID 均指同目录 `matrix.md`。采集前置:全部 CODE 票合并
(#541 #542 #543 #544 #545 #546 #554 #558)后在主线 HEAD 采;记录基点 commit 进本目录
README。**硬约束:严禁在任何沙箱(codex 等)里启动浏览器/Playwright 截图** ——
截图一律由主 session 在本机执行(真机 CDP 或本机浏览器打开静态 harness);
沙箱只允许产静态 harness 文件本身(HTML/CSS/fixture),不允许跑它。

## 采集环境(真机部分)

- dev app 启动即开 CDP:`packages/ui-mac/src/main/index.ts:505`(非 packaged 恒开
  `remote-debugging-port=9222`;packaged 用 `ALPHA_CDP=1`)。裸 WebSocket 连接,
  形态同 `docs/verification/2026-07-19-cap-session-surface/`。
- 隔离根:`OPENCODE_TEST_ONBOARDING=1`(userData/XDG/ALPHA_GLOBAL_DIR 改道临时目录,
  不碰真实用户数据)。工作区用临时 git 仓(见「构造数据」)。
- 窗口 1440×900(设计稿页幅 1440;CDP `Emulation.setDeviceMetricsOverride` 或启动参数)。
- **明/暗切换**:主题键为 `document.documentElement.dataset.colorScheme`
  (`tokens.css:156`,dark = `[data-color-scheme="dark"]`,亦响应 prefers-color-scheme)。
  每帧两采:CDP `Runtime.evaluate` 置 `colorScheme='light'|'dark'` +
  `Emulation.setEmulatedMedia`(两通道同置,防上游主题系统回写);采集前先在真机确认
  现役主题写入通道(app 设置 or 系统跟随),以现役通道为准、CDP 强制为兜底。
- 截图:CDP `Page.captureScreenshot`;整页帧全窗,组件帧裁剪目标节点
  (`DOM.getBoxModel` → clip)。
- 动效:装饰性动画(呼吸点/扫线/流式光标)截图取任意相位即可;reduced-motion
  验证不在本矩阵(交互契约归 a11y 线)。

## 构造数据(seed 会话)

在隔离工作区(临时 git 仓,含 `alpha-ui/button.css`、`docs/` 等演示文件,git init +
一次 base commit)预制脚本化会话。需要构造的态与构造法:

| 需构造态 | 构造法 |
|---|---|
| 代表性回合(A1–A4 整页) | 一条 prompt 触发:读文件+bash+edit+write+助手 Markdown(表格/代码)+产物 md 输出;或直接用 fixture 会话(见组件 harness 的同一 fixture 源) |
| 审查面板有变更(D1/D2) | 会话内让 agent edit `button.css`(+8/−2)、write 新文件、删一文件 → 三类别标齐 |
| 审查空态×2(D3/D4) | D3:无 git 的临时目录开会话;D4:git 仓、干净工作树 |
| 超大 diff 截断/拒绝态(I7 配套,D1 备注) | 生成 >上限的超大 patch(脚本写 10MB 级单文件改动)→ 期望 review-core 有界拒绝路径可见(`oversized patches are refused`);截图拒绝/截断 UI 形态留档 |
| 终端运行态(A3/D6) | 面板内新建终端跑 `bun run dev` 类长驻命令 → 运行点三层指示;D7 空态 = 不建实例 |
| 产物联动(A4/I1–I3) | prompt 产出 md/html/png + 一个 parquet(不可预览);点击行采 office/other 两态 |
| bash 流式(G3) | agent 跑 `bun test src` 类多行慢命令,输出中途截图 |
| task 运行态(G16) | prompt 派子任务(task 工具);运行中截图(环形进度+色点) |
| 审批待批(C2/J1) | 权限模式设「请求审批」,让 agent 跑需审批命令(如 `git commit`),弹出即截 |
| question dock(J3) | 让 agent 用 question 工具提问(prompt 明确要求二选一提问) |
| todo dock(J2) | prompt 要求先列任务清单(todowrite)再执行,进行中截 2/3 态 |
| followup/revert/child-session/handoff(J4–J7) | 按 #558 落地的触发条件逐态构造(revert=回退一条消息;child-session=task 子会话入口;handoff/followup 以票面 AC 为准);无帧行,截图即成回归基线 |
| 中断态(F9) | 流式中点停止键 |
| 运行中整页(C3/B2) | 长任务期间截顶栏+尾部+停止键 |
| 压缩分隔(H4) | 触发上下文压缩(/compact 或塞长上下文) |
| 历史加载/滚动(H5) | 长 fixture 会话滚动到中部 → 回到底部按钮出现 |
| 会话内空态(H6) | 新建会话零消息即截 |
| 429 重试卡(F10)、回合级错误卡(F11)、诊断(G14)、网关错误卡(G4) | 真机构造昂贵/不稳定 → 归组件 harness(下节);若真机顺手可得(如改坏 model id 得 F11)则真机优先 |

## 组件 harness(时间线组件逐类 + 难构造态)

惯例同 `docs/verification/2026-07-21-req090-permission-l2/harness.html`:静态确定性
harness,**逐字加载现役生产 CSS**(`base.css` + session-timeline/session-workspace 各
partial),DOM 复刻(或经 Solid Vite 插件真组件挂载)+ fixture 数据,自有样式只做背景
与状态切换器,零改写生产选择器。URL 参数 `?theme=light|dark&state=<id>`;theme 参数写
`data-color-scheme`。

- 覆盖行:E1–E11、F1–F11、G1–G18、H1–H6、I1(即 timeline 全组件),其中真机已采到
  的行 harness 可作交叉对照,真机采不稳的行(F10/F11/G4/G14/G3 中间态、G12 六态并列、
  E1 展开体)harness 为主证据。
- fixture 与真机 seed 用同一套演示值(文件名/行号/计数对齐设计稿帧内演示数据),
  保证与整页帧可互检。
- harness 文件落本目录 `harness/`;截图由主 session 在本机浏览器/CDP 打开采集
  (再申:不进沙箱)。
- 未知工具 fail-closed 卡(基线 C6)设计稿无帧,不入视觉矩阵;其有界纯文本形态在
  harness 加一个 state 留回归档,判定走 `invariant-checks.md`。

## 每帧到达序列(真机;一帧一行)

约定:「进入会话」= 打开 dev app → 选隔离工作区项目 → 进入 seed 会话(v2 路由
`/server/:serverKey/session/:id`);每帧先采浅色再切暗色重采。

| 行 | 到达序列 |
|---|---|
| A1 | 进入会话(seed 回合已就绪)→ 右栏切「审查」→ 全窗截图 |
| A2 | 同上 → 右栏切「文件」→ 截图 |
| A3 | 同上 → 右栏切「终端」(先建一运行实例)→ 截图 |
| A4 | 同上 → 点时间线产物行(office 文档)→ 右栏自动切「产物」并聚焦 → 截图 |
| B1 | 进入会话,静止态 → 裁剪顶栏条 |
| B2 | 发送长任务 prompt,生成中 → 裁剪顶栏条 |
| C1 | 顶栏右栏开关收起 → 全窗截图 |
| C2 | 触发需审批命令(见构造表)→ 审批卡出现 → 截输入框区(或按 #545 实际挂载位截) |
| C3 | 长任务运行中 → 截「顶栏+时间线尾部+composer」区 |
| D1 | 右栏审查,展开首文件卡,hover 行显「+」并挂一条演示评论 → 裁剪右栏 |
| D2 | 同上切「拆分」→ 裁剪右栏 |
| D3 | 无 git 目录的会话 → 右栏审查 → 裁剪 |
| D4 | git 干净树的会话 → 右栏审查 → 裁剪 |
| D5 | 右栏文件(树展开、有类别标、一项选中)→ 裁剪 |
| D6 | 右栏终端(两实例,一运行)→ 裁剪 |
| D7 | 右栏终端(零实例)→ 裁剪 |
| D8 | 右栏产物(两产物卡,一激活+预览面)→ 裁剪 |
| D9 | 右栏任意面板 → 裁剪 tab 条;另拖宽热区 hover 态一帧 |
| E1–E4 | seed 会话内依次发 `/init`、`/review pr 12`、`/cloudflare`(技能)、MCP prompt → 逐 chip 裁剪(E1 另展开一次) |
| E5–E10 | 发一条带文件附件+图片附件+连接器+@file+@agent 的消息 → 逐元素裁剪 |
| E11 | 从审查面板行内评论发起引用回复(或 fixture)→ 裁剪用户消息 |
| F1/F8 | 生成中捕捉 thinking pill / 流式光标 → 裁剪 |
| F2–F6 | seed 助手回合(含表格/代码/富元素/脚注)→ 逐块裁剪(F6 需 hover 出操作钮一帧) |
| F7 | agent 产出截图文件的回合 → 裁剪媒体预览行 |
| F9 | 生成中按停止 → 裁剪中断行 |
| F10/F11 | harness 为主(真机 F11 可用坏 model id 构造) |
| G1 | 任一工具运行瞬间 → 裁剪(或 harness) |
| G2/G3 | agent 跑多行命令:完成态与流式中各截一次 |
| G4 | harness 为主(真机=坏网关配置) |
| G5–G13 | seed 回合内让 agent 依次 read(多文件)/list/grep/glob/write/edit/apply_patch/webfetch → 逐卡裁剪;G12 六态一览 harness 为主(真机凑不齐并列六态) |
| G14 | harness 为主(真机=让 agent 写入含类型错误的编辑) |
| G15 | `/技能` 执行回合 → 裁剪执行态技能卡 |
| G16 | task 派发运行中 → 裁剪 |
| G17 | agent websearch 回合 → 裁剪 |
| G18 | agent 调 MCP 工具回合 → 裁剪 |
| H1 | 多回合会话回合边界处 → 若实现为不可见间隔:记 N/A 并截实际间隔留档 |
| H2 | 探查回合(多 read+grep)→ 折叠组展开/收起各一帧 |
| H3 | 多文件改动回合 → 裁剪 diffsum(展开态) |
| H4 | 触发压缩后 → 裁剪分隔胶囊 |
| H5 | 长会话滚到中部 → 裁剪按钮(含 hover) |
| H6 | 新建空会话 → 截时间线区 |
| I1 | 多产物回合 → 裁剪链接行组 |
| I2 | 点 office 产物行 → 截「左行高亮+右栏预览」双栏 |
| I3 | 点 parquet 行 → 同上(文件信息+有界节选) |
| J1–J3 | 见构造表触发 → 截 dock/挂载区(含 composer 同框,证挂载位) |
| J4–J7 | 按 #558 触发条件逐态 → 截挂载区;成回归基线 |

## 产物归档

截图命名 `<行ID>-<light|dark>.png` 落本目录;采集完成后在本目录补 README
(判定汇总表:每行 PASS/FAIL/N/A + FAIL 的 bug 票号),矩阵回填采集状态列。
benchmark 采集(前后对比)见 `invariant-checks.md` 末节,与截图批同窗执行。
