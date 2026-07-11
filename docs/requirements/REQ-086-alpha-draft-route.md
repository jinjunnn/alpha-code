---
id: REQ-086
title: Alpha New Session / Draft 正式 route surface（保留 draft 生命周期）
type: feature
github_issue: https://github.com/jinjunnn/alpha-code/issues/201
repo: A
created: 2026-07-10
source: "Alpha 路由、页面与扩展生态所有权专项方案（2026-07-10）§6 M2；用户拍板拆成可独立开发 REQ"
---

# REQ-086 — Alpha New Session / Draft route surface

> 本档只登记未来开发范围与验收契约；本次落档不修改 Draft route、AlphaComposer 或 Provider。

## 背景

当前 `/new-session?draftId=...` 由 [`DraftServerLayout`](../../packages/app/src/app.tsx#L100)、[`DraftRoute`](../../packages/app/src/app.tsx#L124)、`SDKProvider`、[`DirectoryDataProvider`](../../packages/app/src/app.tsx#L151) 与 [`DraftProviders`](../../packages/app/src/app.tsx#L251) 共同提供。它有两个容易在“换页面”时破坏的语义：只改变 draft server 时 SDK/sync 更新但 composer 不重挂；改变 directory 时 directory-scoped providers 才 keyed remount（[`app.tsx`](../../packages/app/src/app.tsx#L142)）。

此外，`/:dir/session` 无 id 的兼容入口由 [`SessionRoute`](../../packages/app/src/app.tsx#L58) 在 tabs/SDK 就绪后创建 draft。现有 [`AlphaHome`](../../packages/ui-mac/src/renderer/alpha-ui/AlphaHome.tsx#L32) 还把 `/new-session` 视为 Home overlay，页面所有权和 draft runtime 没有清楚分离。

本项要在不改变 URL、draft persistence 和首条消息行为的前提下，让 Alpha 自有 New Session 页面成为 REQ-084 的正式叶 surface。

## 目标与交付物

1. 建立 Alpha 自有 New Session/Draft 页面，通过 REQ-084 `newSession` surface 挂载，页面本体使用与 Home/Session 同源的 `AlphaComposer`。
2. 第一阶段完整保留 `DraftServerLayout`、`DirectoryDataProvider`、`DraftProviders`、tabs 与 server-scoped SDK/sync 的现有包装；只替换 `NewSession` 叶页面。
3. 统一使用 `LegacyRouteAbiV1` 处理 `/new-session?draftId=...`、`/:dir/session` 兼容入口、query 参数与 redirect，不在页面内复制 regex/codec。
4. Alpha 页面显式呈现 draft loading、无效/缺失 draft、工作区 retarget、server 选择、提交中、失败重试与刷新恢复状态。
5. 删除 AlphaHome 对 `/new-session` 的 Portal 覆盖；同一路径只挂一个可交互页面。

## 验收标准（逐条可验证）

1. `alpha.surface.newSession=alpha` 打开有效 `/new-session?draftId=<id>` 时，只挂载一个 Alpha Draft page；upstream `NewSession` 叶组件不挂载，现有 draft Provider wrapper 仍在。
2. 缺失 `draftId`、未知/已删除 draft、非法 query 均按 `LegacyRouteAbiV1` 的既有规则得到确定 redirect/错误态；不得空白页或无限 loading。
3. 同一个 draft 只改变 target server 时，测试证明 composer 实例与未发送草稿保持；SDK/sync 切到新 server。改变 directory 时，directory scope 精确 remount，旧目录 file/comment 状态不泄漏。
4. 从 `/:dir/session` 无 id 进入时仍只创建一个 draft，并按既有 tab/prompt 语义进入 Alpha New Session；有 `prompt` query 时只预填一次，reload 不重复消费。
5. 首条消息可用文本、slash command、agent/model/variant/permission 参数按 [REQ-055](./REQ-055-unified-alpha-composer.md) 的同源契约提交；成功后晋升为 session 并使用 ABI helper 导航，失败时 draft 与输入可恢复。
6. 切换项目、切换 server、发送中断网、引擎返回错误、刷新与应用重启后，draft 状态没有跨目录/跨 server 混淆；重复重试符合服务端幂等边界。
7. `AlphaHome` 不再将 `/new-session` 视为 Home，也没有叠加的 Portal、焦点区或隐藏交互层；页面 keyboard/focus/IME/autocomplete 通过组件与真机回归。
8. `alpha.surface.newSession=legacy` 对同一 draft URL 可在 reload 后回到旧页面；Alpha 与 legacy 读取同一兼容状态，不需要数据回滚脚本。
9. Web Router、MemoryRouter、deep-link、back/forward、reload、server/directory retarget 的 route contract tests 全部通过；没有新增对 `packages/app/src/context/**` 的 deep import。

## 非目标

- 不在本项重新实现或公开 Draft/Directory 私有 Provider。
- 不改变 draft URL、持久化 schema、session 创建 API 或 delivery 语义。
- 不接管 SessionWorkspace、timeline、diff、terminal；见 REQ-087/REQ-088。
- 不让 Alpha 声明完整 route tree；见 REQ-089。
- 不重新设计 `AlphaComposer` 或附件协议。

## 依赖与激活条件

- **硬依赖**：REQ-084 verified。
- **兼容基线**：[REQ-055](./REQ-055-unified-alpha-composer.md)、[`DraftRoute` 当前实现](../../packages/app/src/app.tsx#L124)、[ADR-016](../../.claude/rules/adrs/ADR-016-frontend-takeover.md)。
- **下游**：REQ-088 与 REQ-089 以本项 verified 为激活条件之一。
