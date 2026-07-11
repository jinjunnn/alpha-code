---
id: REQ-087
title: LayoutController / LegacySessionAdapter 可行性与边界 spike
type: spike
github_issue: https://github.com/jinjunnn/alpha-code/issues/202
repo: A
created: 2026-07-10
source: "Alpha 路由、页面与扩展生态所有权专项方案（2026-07-10）§5.1/§6 M3；用户拍板拆成可独立开发 REQ"
---

# REQ-087 — LegacySessionAdapter feasibility spike

> 本档只登记未来 spike 的问题、产物和退出条件；本次落档不重构 Layout、Session、timeline 或 terminal。

## 背景

不能把现有 Session 误判为一个可直接嵌入的纯 view。[`pages/session.tsx`](../../packages/app/src/pages/session.tsx#L79) 同时消费 server sync、local/file/sync、dialog、layout、prompt、comments、terminal、settings、SDK 等私有 context，并持有 timeline、composer、review/file panel、terminal、快捷键和滚动状态。`useSessionLayout()` 又把 route params 与 [`Layout`](../../packages/app/src/pages/layout.tsx#L95) 的 tabs/view 状态绑在一起（[`session-layout.ts`](../../packages/app/src/pages/session/session-layout.ts#L16)）。

[`MessageTimeline`](../../packages/app/src/pages/session/timeline/message-timeline.tsx#L262) 含虚拟列表、prepend anchor、bottom-follow 与 session cache；[`TerminalPanel`](../../packages/app/src/pages/session/terminal-panel.tsx#L24) 依赖 `useLayout`、`useTerminal`、`useSessionLayout`、focus/recovery/handoff；[`use-session-commands.tsx`](../../packages/app/src/pages/session/use-session-commands.tsx#L38) 又横跨 dialog、permission、terminal、layout 与 session view。当前 Alpha composer/timeline 仍通过 [`composer-takeover.tsx`](../../packages/ui-mac/src/renderer/alpha-ui/composer-takeover.tsx#L20) 和 [`timeline-inject.tsx`](../../packages/ui-mac/src/renderer/alpha-ui/timeline-inject.tsx#L1) 操作 DOM。

因此，在实现 Alpha SessionWorkspace 前必须先证明：能否把 `Layout` 的控制器职责与视觉 Shell 分开，能否形成一个粗粒度 `LegacySessionAdapter`，以及最小稳定边界到底在哪里。未经 spike 证明就拆 timeline/diff/terminal，会把私有 context、滚动和快捷键耦合扩散到 Alpha 页面。

## Spike 问题与交付物

1. **依赖拓扑清单**：列出 Layout 与 Session 的 context、route、persist key、command、focus、scroll、prefetch/cache、deep link、notification、permission、terminal cleanup 依赖；标注 owner、生命周期与迁移风险。
2. **控制器/视图边界方案**：评估 `LayoutController + ShellView`、粗粒度 `LegacySessionAdapter`、整页 iframe/Portal（仅作反例）及直接拆多个 view adapter，给出可证伪的比较结论。
3. **最小原型**：在实验 flag 下让 Alpha 外围容器承载一个 legacy session region，验证 route/provider 不被复制、session 切换不双挂、scroll/focus/command 能工作；原型不得默认启用或进入稳定发布。
4. **Characterization suite**：先锁住 legacy 行为，再决定 adapter API。测试至少覆盖 streaming、steer/queue/abort、permission、tool card、hash scroll、history prepend、session switch、file/review panel、terminal focus/persistence、快捷键与错误恢复。
5. **边界决策记录**：输出 recommended API、不得泄漏的 upstream 类型、需要保留的 scopes、拆分顺序、性能基线、风险与 rollback；明确 GO / CONDITIONAL GO / NO-GO。
6. **REQ-088 输入**：给出可直接用于实现的 adapter contract 和任务拆分；若不可行，列出阻断项与替代路线，而不是把不确定性带入 REQ-088。

## 验收标准（逐条可验证）

1. 依赖矩阵覆盖 `pages/layout.tsx`、`pages/session.tsx`、`session-layout.ts`、timeline、side panel、terminal panel、session commands 及其直接 private contexts；每项含 mount scope、持久化键、cleanup 与测试证据。
2. 至少比较三种边界方案，并以代码/运行时证据解释为何选择或淘汰；不得仅凭文件数量或主观复杂度下结论。
3. 原型能在 REQ-084 session surface 的实验模式中挂载 Alpha outer host + 单一 legacy session region；同一 session DOM 不双挂，legacy 模式仍可 reload 回退。
4. 快速切换两个 session、back/forward、reload、切换 directory/server 后，provider 数量、event subscription、terminal PTY 与 command registration 没有线性累积；使用计数/日志或测试取证。
5. 100+ 条长 timeline 的首屏、stream update、向上加载历史、自动跟底/暂停跟底、hash 定位在原型中通过；与 legacy 基线相比没有可感知跳动或丢 anchor。
6. terminal 新建/关闭/重排/切 session/重启恢复、diff/file panel 打开与焦点返回、permission once/always/reject、abort/重试均通过 characterization tests。
7. 记录 baseline 与原型的 mount time、事件订阅数、内存趋势和长 timeline 滚动表现；若超过约定预算，结论必须标记 conditional/no-go 并给出原因，不可用“后续优化”跳过。
8. 推荐 adapter 的 public props/events 为 Alpha 自有窄类型，不把 `useLayout()`、`useSessionLayout()` 或其他 upstream context 类型暴露给 `alpha-app`；所有深 import 只能收敛在拟议的 upstream-adapter 边界。
9. Spike 产物包含结论、测试、原型开关清理方案和 REQ-088 可执行分解；评审明确签署 GO/CONDITIONAL GO/NO-GO 后，本项才可 verified。
10. 若结论为 NO-GO，REQ-088 保持未激活并回到需求修订；不得为了“完成 spike”把实验代码默认启用。

## 非目标

- 不交付正式 Alpha SessionWorkspace，不承诺用户可见功能上线。
- 不重写 timeline、diff、file viewer、terminal 或 Session runtime。
- 不把 upstream 私有 contexts 全量 export 成长期 public API。
- 不移除 `ComposerTakeover`、`TimelineInject` 或 `AppInterface`；删除时点属于后续实现。
- 不修改 URL schema、session 数据协议或权限语义。

## 依赖与激活条件

- **硬依赖**：REQ-084 verified，且实验 session surface/legacy rollback 可用。
- **执行约束**：spike 在一个受限迭代内完成；超出时必须先交付已知/未知矩阵和继续成本，再决定是否延长。
- **下游**：只有本项给出 GO 或带明确前置项的 CONDITIONAL GO，REQ-088 才可进入实现。
- **关联**：[ADR-016](../../.claude/rules/adrs/ADR-016-frontend-takeover.md)、[ADR-020](../../.claude/rules/adrs/ADR-020-frontend-freeze.md)、[REQ-005](./REQ-005-frontend-takeover-closeout.md)。
