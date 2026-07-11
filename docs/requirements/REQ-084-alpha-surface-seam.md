---
id: REQ-084
title: Alpha 路由 ABI 与 AppInterface typed surface seam（含冻结同步存活契约）
type: feature
github_issue: https://github.com/jinjunnn/alpha-code/issues/199
repo: A
created: 2026-07-10
source: "Alpha 路由、页面与扩展生态所有权专项方案（2026-07-10）§5.1/§6 M0；用户拍板拆成可独立开发 REQ"
---

# REQ-084 — Alpha 路由 ABI 与 typed surface seam

> 本档只登记未来开发范围与验收契约；本次落档不修改 `AppInterface`、冻结同步流程、ADR 或任何产品代码。

## 背景

当前 [`AppInterface`](../../packages/app/src/app.tsx#L413) 的 `router` prop 只允许替换 Solid Router 实现；`/`、`/:dir/session/:id?`、`/new-session` 三条 route 仍由 [`app.tsx`](../../packages/app/src/app.tsx#L451) 写死。Session 与 Draft 的叶页面外还有 `SelectedServerLayout`、`DraftServerLayout`、`DirectoryDataProvider`、`SessionProviders`、`DraftProviders` 等私有包装（[`app.tsx`](../../packages/app/src/app.tsx#L58)、[`app.tsx`](../../packages/app/src/app.tsx#L85)、[`app.tsx`](../../packages/app/src/app.tsx#L239)），包入口目前也没有导出这些内部 context（[`packages/app/src/index.ts`](../../packages/app/src/index.ts#L1)）。

因此，Alpha 目前只能把自有页面作为 route-aware children、Portal 或 DOM takeover 挂到旧页面之上，无法在保留既有 Provider 生命周期的同时替换最内层页面。这与 [ADR-016](../../.claude/rules/adrs/ADR-016-frontend-takeover.md) 的“全部用户可见界面归 Alpha”目标存在缺口。

同时，[ADR-020](../../.claude/rules/adrs/ADR-020-frontend-freeze.md) 要求 `packages/{app,ui}` 保持冻结；[`sync-upstream.yml`](../../.github/workflows/sync-upstream.yml#L91) 会删除它们并从 `frontend-freeze-base` 恢复。若只编辑 `AppInterface` 而不改变冻结恢复契约，接缝会在下一次同步中消失。

路由编码也有重复真源：[`sidebar/route.ts`](../../packages/ui-mac/src/renderer/sidebar/route.ts#L1) 自行复制了 directory base64 codec 与 href 规则。接管页面前必须先把现有 URL 与生命周期冻结成版本化兼容 ABI。

## 目标与交付物

1. **`LegacyRouteAbiV1` 单一契约**：在 Alpha 自有边界定义当前 route path、`dir/id/draftId/prompt` 参数、directory codec、`parseRoute`、`hrefFor`、redirect、deep-link 与 remount 规则；现有 URL 在迁移期视为不可破坏 ABI。
2. **最小 typed surface seam**：`AppInterface` 接受可选的 `home`、`newSession`、`session` 叶页面；每项使用窄的 `MaybePreloadableComponent` 契约，允许可选 `preload(): void`。未提供 override 时严格使用 upstream 默认页面。
3. **保留 Provider 语义**：第一阶段只替换最内层叶页面，不导出或复制全部私有 context；`SelectedServerLayout`、`DraftServerLayout`、`DirectoryDataProvider`、`SessionProviders`、`DraftProviders` 与现有 `Layout` 保持默认生命周期。
4. **启动期 surface 选择**：每个 surface 支持 `alpha | legacy | auto-fallback` 发布状态；选择在可信 main 配置进入 renderer 后、route tree 首次挂载前完成，同一 renderer 生命周期内不得热换 Provider tree。致命 surface 错误只能提示并在 reload 后回退，不能吞掉发送、权限或数据一致性错误。
5. **冻结同步集成**：修订 [ADR-016](../../.claude/rules/adrs/ADR-016-frontend-takeover.md) / [ADR-020](../../.claude/rules/adrs/ADR-020-frontend-freeze.md) 的接缝例外，并二选一落地：建立包含该中性 seam 的新冻结基点，或让冻结恢复步骤在恢复后机械应用、校验一个单独且 loud-fail 的 typed seam patch。不得使用 build-time 字符串替换。
6. **契约测试与观测**：同时覆盖 Web `Router` 与桌面 `MemoryRouter`；记录 route id、surface 版本、加载失败与回退原因，但不得记录解码后的本地绝对路径、prompt 或凭据。

## 验收标准（逐条可验证）

1. `LegacyRouteAbiV1` golden tests 覆盖 `/`、`/:dir`、`/:dir/session`、`/:dir/session/:id`、`/new-session?draftId=...`、Unicode/Windows/POSIX directory、非法 base64、缺失参数以及 parse/href 往返；`sidebar/route.ts` 等消费者不再各自实现 route regex/codec。
2. 不传 surfaces 时，route tree、lazy preload 和现有三页面行为与变更前一致；characterization tests 对默认路径全部通过。
3. 分别只注入 home、newSession、session 测试 surface 时，仅对应叶页面替换；其他两个页面与全部既有 Provider wrapper 仍使用默认实现。
4. `session` surface 的 `preload` 只预载实际选中的组件；测试证明它没有被误当作 session 数据预取，也不会同时预载 legacy 与 Alpha 页面。
5. Characterization tests 固定以下不变量：selected server 改变触发 keyed remount；draft 只换 server 不重挂 composer；draft 换 directory 才重挂 directory scope；`/:dir/session` 无 id 保持既有 draft promotion；非法 directory 回首页；session id 驱动对应同步范围。
6. surface flag 在首屏挂载后变化不会热换当前 provider tree；切换需 reload。注入 surface 抛出致命错误时能记录 surface id/version，并在用户确认 reload 后切回同 URL 的 legacy 页面。
7. `@opencode-ai/app` 只公开窄 surface 类型/prop；没有新增对 `context/*` 的批量 public export，Alpha 页面也没有 deep import `packages/app/src/**`。
8. 从一次模拟 upstream sync 的临时树执行 [`restore_frozen_frontend`](../../.github/workflows/sync-upstream.yml#L93) 后，typed seam 及其测试仍存在且通过；若 patch/base 不匹配，工作流 loud-fail，不得 warning 后继续。
9. `packages/app` 与 `packages/ui-mac` 各自在包目录执行规定的 typecheck/test 通过；现有 Alpha 页面仍默认走 legacy surface，用户可见行为不因本项单独上线而变化。
10. ADR 修订、冻结策略、seam 代码、测试与发布 flag 的提交具备同一可追踪变更集；只完成其中任一项不得将本 REQ 标记 shipped。

## 非目标

- 不在本项把现有 `AlphaHome`、New Session 或 SessionWorkspace 切到新 surface；分别由 REQ-085、REQ-086、REQ-088 实施。
- 不让 Alpha 声明完整 route table；route composition 与语义所有权由 REQ-089 实施。
- 不替换 upstream `Layout`，不导出所有私有 Provider，不重写 timeline/diff/terminal。
- 不建立 AlphaRuntime，也不移除 `AppInterface`；见 REQ-091。
- 不改变现有 URL schema、历史 deep link 或持久化键。

## 依赖与激活条件

- **前置决策**：开工时必须先确认 ADR-020 采用“新冻结基点”还是“恢复后机械 seam patch”；两者都必须满足可复现、可测试、失败即阻断。
- **激活条件**：本项 verified 后，REQ-085、REQ-086、REQ-087、REQ-090 才可进入实现。
- **关联**：[ADR-016](../../.claude/rules/adrs/ADR-016-frontend-takeover.md)、[ADR-020](../../.claude/rules/adrs/ADR-020-frontend-freeze.md)、[ADR-004](../../.claude/rules/adrs/ADR-004-upgrade-isolation-ci.md)、[REQ-012](./REQ-012-frontend-sync-regression-guard.md)。
