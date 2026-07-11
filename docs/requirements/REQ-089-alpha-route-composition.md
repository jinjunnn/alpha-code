---
id: REQ-089
title: Alpha route manifest 与完整 route composition 所有权（保留 LegacyRouteAbiV1 aliases）
type: feature
github_issue: https://github.com/jinjunnn/alpha-code/issues/204
repo: A
created: 2026-07-10
source: "Alpha 路由、页面与扩展生态所有权专项方案（2026-07-10）§5.2/§6 M5；用户拍板拆成可独立开发 REQ"
---

# REQ-089 — Alpha route composition ownership

> 本档只登记未来开发范围与验收契约；本次落档不新建 package、不修改 route table 或 AppInterface。

## 背景

REQ-084 的叶 surface seam 能让 Alpha 拥有页面，但 route table 仍由 [`AppInterface`](../../packages/app/src/app.tsx#L451) 声明，selected-server/draft scopes 与 redirect 语义仍由 upstream 决定。因此，“三个页面都换成 Alpha”只能证明 page ownership，不能宣称 route declaration ownership 或 route semantic ownership。

本项在 Home、Draft、SessionWorkspace 和 Settings/Recovery surfaces 稳定后反转依赖：由 Alpha 声明 route manifest/tree，upstream 只暂时提供中性的 runtime scope slots。现有 `LegacyRouteAbiV1` 是迁移兼容层；历史 deep link 必须继续可用，未来新 URL 只能先以 alias/版本迁移引入，不能与页面 runtime 切换同版本硬改。

## 目标与交付物

1. **Alpha route manifest 真源**：在 Alpha 自有 package（目标为 `packages/alpha-app`，若实现评审采用其他名称须保持同等边界）定义 route id、path/alias、参数 schema、surface、scope、loader/preload、redirect、recovery 与导航元数据。
2. **Alpha route composition**：扩展中性接缝为 `composeRoutes(runtime)`；Alpha 声明 Web Router 与桌面 MemoryRouter 共用的 route tree，upstream 默认 composition 仍可用于 legacy rollback。
3. **窄 runtime slots**：只暴露 `SelectedServerScope`、`DirectoryScope`、`SessionScope`、`DraftServerScope`、`DraftScope` 等能包 children 的临时 capability，以及 `LegacyRouteAbiV1`；不批量公开内部 context/store。
4. **声明/语义分帐**：维护 route ownership ledger，分别记录 declaration、page、semantic、runtime 四个维度。只有 path/redirect/deep link/param/lifecycle 都由 Alpha contract 测试覆盖时，semantic 才能标 owned；runtime 仍标 legacy/adapter，直到 REQ-091。
5. **Legacy ABI aliases**：当前 `/`、`/:dir/session/:id?`、`/new-session?draftId=...` 继续可达；任何新 canonical URL 都必须先登记 alias、迁移版本、冲突规则、回退期与脱敏 telemetry。
6. **导航单一来源**：sidebar、Home、composer、notification/deep link、settings/recovery 等全部使用 manifest/ABI 的 `parseRoute`、`matchRoute`、`hrefFor`，禁止手写路径 regex/string。

## 验收标准（逐条可验证）

1. `packages/alpha-app`（或经 ADR 批准的等价 Alpha package）成为 route manifest 与 route composition 唯一真源；[`packages/app/src/app.tsx`](../../packages/app/src/app.tsx#L451) 的 upstream route table 只作为默认 legacy composition，不再决定 Alpha 产品入口。
2. Alpha composition 覆盖 home、newSession、session、settings、extensions、automations、recovery 的 route/surface 身份；每项明确 path 或 modal/overlay 语义、所需 scope、error/loading、preload 与 ownership 状态。
3. 三条核心 route 的 declaration ownership 为 3/3；测试证明 Alpha 决定 path、nested layout、redirect 和选用的 surface，而 runtime slots 只提供 Provider 能力。
4. Semantic contract tests 覆盖 directory codec、非法路径、无 id draft promotion、draftId、selected server keyed remount、draft server/directory remount 差异、session sync、deep link、notification click、back/forward、reload 与启动恢复。
5. 当前所有 legacy URL 的 golden fixture 在 Alpha composition 下得到与迁移前相同页面/参数/状态；如引入新 URL，旧 URL 作为显式 `legacy-v1` alias 生效且不产生 redirect loop。
6. Web `Router` 与桌面 `MemoryRouter` 使用同一 manifest 并通过同一 fixture；只允许 host/history adapter 不同，route 语义不得分叉。
7. `composeRoutes` 在 app 启动时解析一次；运行期间 surface/profile 改动不热换 Provider tree。Alpha/legacy composition 回退必须 reload 且保持同一兼容 URL。
8. runtime slots 使用 Alpha 定义的窄 wrapper contract；`alpha-app` 对 `packages/app/src/**` 与 `packages/ui/src/**` deep import 为零，只有明确的 upstream-adapter 可依赖冻结内部实现。
9. 全仓 route regex/path literal 审计建立 allowlist；sidebar、Home、composer takeover 替代路径、notification/deep link 等产品导航消费者均改用 manifest/ABI helper，新增手写核心路径由 CI 阻断。
10. route telemetry 只记录 route id、ABI/version、alias 命中、load/error/rollback；测试证明不包含解码后的 directory、query prompt、session 内容或凭据。
11. ownership ledger 明确显示 route declaration/semantic 已归 Alpha、runtime 仍处于 adapter；文档、产品宣称和完成报告不得把它误写成 runtime independence。
12. Alpha/legacy composition 双路径端到端与 upstream sync/re-freeze 契约测试通过，旧 composition 至少保留一个稳定回退周期后才能另立删除任务。

## 非目标

- 不在本项移除 `AppInterface`、Global/Server/SDK/Sync/Tabs 等 runtime；见 REQ-091。
- 不改变 session、draft、permission、terminal 或 artifact 数据协议。
- 不让第三方 Skill/MCP/Plugin 注册或覆盖 Alpha 顶级 route/Shell；第三方只可进入受控 capability slots。
- 不强制在本项引入新的 URL 风格；保持 legacy URL 是可接受且优先的首版策略。
- 不重写 timeline/diff/terminal 等重型 viewer。

## 依赖与激活条件

- **硬依赖**：REQ-085、REQ-086、REQ-088、REQ-090 全部 verified；REQ-084 的 ABI/seam 与冻结同步保证持续有效。
- **激活门**：四个页面域必须已有同 URL legacy rollback 和 characterization tests；否则不得切 Alpha composition 为默认。
- **下游**：只有本项 owning Issue 完成验收且 semantic ownership ledger 无缺口，才可为 REQ-091 新建激活 Issue。
- **关联**：[ADR-016](../../.claude/rules/adrs/ADR-016-frontend-takeover.md)、[ADR-020](../../.claude/rules/adrs/ADR-020-frontend-freeze.md)、[ADR-017](../../.claude/rules/adrs/ADR-017-desktop-auth-deeplink.md)。
