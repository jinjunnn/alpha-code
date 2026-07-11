---
id: REQ-085
title: AlphaHome 成为正式 Home route surface（移除 Portal 覆盖）
type: feature
github_issue: https://github.com/jinjunnn/alpha-code/issues/200
repo: A
created: 2026-07-10
source: "Alpha 路由、页面与扩展生态所有权专项方案（2026-07-10）§6 M1；用户拍板拆成可独立开发 REQ"
---

# REQ-085 — AlphaHome 正式 route surface

> 本档只登记未来开发范围与验收契约；本次落档不改 `AlphaHome`、renderer 入口、路由或样式。

## 背景

现有 [`AlphaHome`](../../packages/ui-mac/src/renderer/alpha-ui/AlphaHome.tsx#L26) 通过 `useLocation()` 判断 pathname，再以 [`Portal`](../../packages/ui-mac/src/renderer/alpha-ui/AlphaHome.tsx#L67) 覆盖到页面；upstream Home 仍由 [`AppInterface`](../../packages/app/src/app.tsx#L451) 正常挂载。当前形态视觉上接管了首页，却仍是双页面生命周期，无法独立证明 upstream Home 没有隐藏副作用，也使 loading、focus、错误边界和页面测试依赖全局 DOM。

Home 是风险最低的叶页面，应作为 REQ-084 typed surface seam 的首个真实消费者，证明 Alpha 可以拥有页面而不复制 upstream Provider 栈。页面内现有 `AlphaComposer`、默认 `~/Alpha` 工作区、项目列表与错误提示必须保持；相关历史契约见 [REQ-055](./REQ-055-unified-alpha-composer.md)、[REQ-071](./REQ-071-default-user-workspace-dir.md) 与 [ADR-016](../../.claude/rules/adrs/ADR-016-frontend-takeover.md)。

## 目标与交付物

1. 将 `AlphaHome` 改造成普通、可直接路由挂载的 Alpha 页面组件，不再自行判断 `pathname`，不再通过 Portal 覆盖 upstream Home。
2. 通过 REQ-084 的 `home` typed surface 注入该页面；Alpha 模式下 upstream Home 不挂载，legacy 模式下保持旧页面可用且 URL 不变。
3. Home 的项目数据、默认工作区、composer、导航和错误状态通过显式 props/Alpha adapter 获取，不读取或点击隐藏 upstream Home DOM。
4. 所有首页导航只使用 `LegacyRouteAbiV1` 的 typed helper；删除首页域内重复 route 拼接/解析。
5. 页面具备 Alpha 自有 loading、empty、offline、server-not-ready、config-broken 和页面级 error boundary；保留 reload 后切回 legacy 的发布回退。

## 验收标准（逐条可验证）

1. `alpha.surface.home=alpha` 时，DOM 中只有一个 Home page root；upstream Home 的 lazy component 不挂载，`AlphaHome` 内不存在 `Portal`、`isHome` pathname 条件或对 upstream Home anchor 的查询。
2. `alpha.surface.home=legacy` 时，`/` 的行为、首次启动与导航与 REQ-084 默认实现一致；切换两种模式不改变 URL 或项目数据。
3. 首次启动、无项目、已有项目、默认 `~/Alpha`、用户选择其他工作区五种状态均能渲染正确；选择工作区后模型、effort、附件/命令能力继续复用同一个 [`AlphaComposer`](../../packages/ui-mac/src/renderer/alpha-ui/alpha-composer.tsx)。
4. 发送首条消息按既有契约创建 session、提交 prompt 并通过 ABI helper 导航到对应 session；失败时不丢输入，显示可重试错误，重复点击不会产生意外重复 session。
5. sidecar 未就绪、离线、项目列表失败、全局配置损坏与 surface render error 均有可见、可操作状态；错误中不展示 token、认证头或未脱敏绝对路径。
6. Home 的键盘顺序、可见焦点、workspace picker、composer autocomplete 和屏幕阅读器名称通过可访问性测试；窗口窄宽、浅色、深色均完成视觉回归。
7. 从 Home 导航到 session/new-session、浏览器 back/forward、reload 以及从 deep link 返回 `/` 全部通过契约测试；导航代码不再手写 `/:dir/session/:id` 字符串。
8. 首页对应的 Portal/隐藏 CSS/DOM anchor 与不再使用的 observer 被删除；CI ratchet 证明结构性 takeover 数量只下降不增加。
9. 单元、组件、route contract 与桌面真机 smoke test 全绿；`alpha.surface.home=legacy` 仍作为一个发布周期内的可验证回退路径。

## 非目标

- 不接管 New Session/Draft 或 SessionWorkspace；见 REQ-086、REQ-088。
- 不修改完整 route table、历史 URL 或 redirect；见 REQ-089。
- 不重写 `AlphaComposer`、项目 SDK store 或 sidecar。
- 不移除 `AppInterface`/upstream runtime。
- 不在本项重新设计 Home 视觉；功能与当前 AlphaHome 保持等价，视觉改版需另立需求。

## 依赖与激活条件

- **硬依赖**：REQ-084 必须 verified，typed home surface、LegacyRouteAbiV1 与冻结同步存活测试已可用。
- **兼容基线**：[REQ-055](./REQ-055-unified-alpha-composer.md)、[REQ-071](./REQ-071-default-user-workspace-dir.md)、[ADR-016](../../.claude/rules/adrs/ADR-016-frontend-takeover.md)。
- **下游**：REQ-088 与 REQ-089 以本项 verified 为激活条件之一。
