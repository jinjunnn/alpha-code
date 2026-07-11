---
id: REQ-088
title: Alpha SessionWorkspace 外围布局、Workbench 与粗粒度 legacy adapter 集成
type: feature
github_issue: https://github.com/jinjunnn/alpha-code/issues/203
repo: A
created: 2026-07-10
source: "Alpha 路由、页面与扩展生态所有权专项方案（2026-07-10）§6 M3；用户拍板拆成可独立开发 REQ"
---

# REQ-088 — Alpha SessionWorkspace

> 本档只登记未来开发范围与验收契约；本次落档不实现 SessionWorkspace、Workbench 或 adapter。

## 背景

Session 是 Alpha 产品所有权的核心，却也是迁移风险最高的页面。当前 [`pages/session.tsx`](../../packages/app/src/pages/session.tsx#L79) 一体持有 conversation、composer、review/file panel、terminal、timeline model、快捷键与多组 private context；Alpha 的 composer 与 timeline 视觉增强仍依赖 [`ComposerTakeover`](../../packages/ui-mac/src/renderer/alpha-ui/composer-takeover.tsx#L32)、DOM 收养和 [`TimelineInject`](../../packages/ui-mac/src/renderer/alpha-ui/timeline-inject.tsx#L1)。

本项不等待所有重型组件重写，而是在 REQ-087 证明的边界上，先让 Alpha 拥有 SessionWorkspace 的外围布局、错误边界、Workbench 与能力选择，再以一个粗粒度 legacy adapter 保留仍未迁移的会话区域。Office/PDF/HTML 等 Artifact Workbench 与 renderer contract 由 REQ-094 提供，本项负责把它纳入真实 session 页面。

## 目标与交付物

1. 建立 Alpha 自有 `SessionWorkspace` 页面并作为 REQ-084 的 `session` surface；其信息架构至少包含 ConversationRegion、唯一 AlphaComposer、Workbench 与 Terminal 区域。
2. 严格实现 REQ-087 评审通过的 `LayoutController/LegacySessionAdapter` 边界；所有 upstream deep import 收敛到单一 adapter 包/模块，Alpha 页面只消费窄 props/events。
3. Alpha 拥有外围 grid/panel、Workbench tab 与 artifact 选择、页面级 loading/error/offline/recovery、响应式与可访问性；legacy adapter 暂时拥有尚未拆出的 timeline/diff/file/terminal 行为。
4. 集成 REQ-094 的 Workbench/Artifact renderer：Artifacts、Preview、Files、Changes、Inspector 的可用项按 capability 决定，未支持格式给出下载/外部打开/原因，不把二进制当 Markdown。
5. 同一页面只有一个 composer 与一套 session controller。对应能力正式进入页面后，删除 `ComposerTakeover`、usage-ring DOM 收养及已被替代的结构性 timeline decoration，不长期双轨。
6. 保留 `alpha | legacy | auto-fallback` session 发布状态；发生 surface 致命错误时保留 URL/持久化状态，在 reload 后回 legacy，不能自动重放 prompt 或 permission action。

## 验收标准（逐条可验证）

1. `alpha.surface.session=alpha` 打开 `/:dir/session/:id` 时，route 只挂一个 Alpha `SessionWorkspace` root 和一个经批准的 legacy region；upstream 整页与 Alpha 页面不并行运行。
2. DOM 中只有一个可编辑 composer；发送、steer、queue、slash command、agent/model/variant、附件、abort、retry 与 permission 交互保持既有功能，且不存在隐藏 upstream composer 接收键盘/焦点。
3. Streaming tool calls、reasoning、message/tool cards、历史加载、hash 定位、自动跟底/暂停跟底、session 切换均通过 REQ-087 characterization suite；长 timeline 没有新增跳动、重复消息或订阅泄漏。
4. Workbench 可从 timeline 产物、文件和变更入口打开；REQ-094 声明支持的 Markdown/PDF/DOCX/XLSX/PPTX/HTML/图片等类型走正确 renderer，失败态、超限态和恶意内容隔离按其契约呈现。
5. 文件树、diff/review、terminal 新建/关闭/重排/恢复、panel resize、快捷键和焦点返回保持；Alpha outer layout 的 panel 状态切 session/reload 后按既有持久化语义恢复。
6. Desktop 窄宽/宽屏、浅色/深色、reduce-motion 下，Conversation/Workbench/Terminal 无遮挡；tab、splitter、dialog、permission prompt 的键盘顺序与屏幕阅读器语义通过自动与人工测试。
7. session 不存在、加载失败、server 断开、SDK timeout、renderer crash、artifact render failure 各自有局部错误边界；artifact/Workbench 失败不得拖垮对话与 composer。
8. `ComposerTakeover` 及其 body flag、host Portal、usage-ring DOM 收养在 Alpha session 路径不再执行；任何保留的 `TimelineInject` 项必须列入有 owner/删除 REQ 的迁移清单，结构 observer 总数不得增加。
9. `alpha.surface.session=legacy` 对同一 URL、同一 session、同一 terminal/file/panel 持久化状态能 reload 回退；回退不会重复发送 prompt、重复 permission reply 或丢未发送草稿。
10. Alpha SessionWorkspace 不直接导入 `packages/app/src/**`；只有 upstream adapter 边界可接触 legacy 实现，CI import rule 与 adapter contract tests 通过。
11. route/load/error/rollback 与 renderer capability 有脱敏观测；不得上报绝对工作区路径、文件正文、prompt、tool output 或 token。
12. 真机端到端覆盖“Home 新建会话 → streaming/tool/permission → 打开 artifact Workbench → diff/file → terminal → 切换 session → reload → legacy rollback”，全部通过后方可 shipped。

## 非目标

- 不在本项重写所有 timeline/diff/file viewer/terminal；粗粒度 legacy adapter 是允许的明确阶段。
- 不建立完整 Alpha route manifest；见 REQ-089。
- 不完成 AlphaRuntime parity 或移除 `AppInterface`；见 REQ-091。
- 不自行定义 Office/PDF/HTML renderer 安全协议；由 REQ-094 负责，本项只集成。
- 不改变模型执行、session 协议、permission 或 delivery 语义。
- 不允许第三方扩展覆盖 SessionWorkspace 顶级 route/Shell；扩展只进入受控 Workbench/renderer slot。

## 依赖与激活条件

- **硬依赖**：REQ-085、REQ-086 verified；REQ-087 为 GO/CONDITIONAL GO 且条件清零；REQ-094 的 Workbench/renderer contract verified。
- **基础接缝**：REQ-084 必须持续 verified，session surface 与 legacy rollback 可用。
- **下游**：REQ-089 以本项 verified 为 route composition 前置。
- **关联**：[ADR-016](../../.claude/rules/adrs/ADR-016-frontend-takeover.md)、[REQ-055](./REQ-055-unified-alpha-composer.md)、[REQ-005](./REQ-005-frontend-takeover-closeout.md)。
