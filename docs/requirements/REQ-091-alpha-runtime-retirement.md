---
id: REQ-091
title: AlphaRuntime parity 清零与 AppInterface 产品入口退役
type: feature
migration_note: "Not migrated: parked without a review date; activation requires a new GitHub Issue."
repo: A
created: 2026-07-10
source: "Alpha 路由、页面与扩展生态所有权专项方案（2026-07-10）§5.3/§6 M6；用户拍板拆成可独立开发 REQ"
---

# REQ-091 — AlphaRuntime 与 AppInterface 退役

> 本档是未迁移的终局设计记录，只登记激活条件、开发范围与验收门；本次落档不建立 AlphaRuntime、不移除 `AppInterface` 或任何 Provider。

## 背景

即使 REQ-089 让 Alpha 拥有 route declaration/semantic，产品仍可能依赖 [`AppInterface`](../../packages/app/src/app.tsx#L413) 提供的 Server、Global、ConnectionGate、Tabs、Settings、Command、Permission、Layout、Notification、Models、SDK/Sync、Prompt、Comments、File 与 Terminal 生命周期。当前包入口只公开有限 API（[`packages/app/src/index.ts`](../../packages/app/src/index.ts#L1)），多数页面能力仍来自 private context。

直接移除 `AppInterface` 会产生最危险的“看起来完成”：路由与页面已归 Alpha，但 deep link、draft/session persistence、event replay、permission、terminal cleanup、notification 或错误恢复悄然退化。因此终局必须以 runtime parity ledger 为门，而不是以文件迁移百分比或 route 数量为门。

本项只有在 REQ-089 owning Issue 完成验收且所有 runtime 域有公开 SDK/Alpha adapter 的可验证替代后，才允许新建激活 Issue。重型 timeline/diff/terminal 可以继续作为普通 adapter 组件；退役产品骨架不等于重写每个 renderer。

## 目标与交付物

1. **AlphaRuntime public boundary**：建立由公开 SDK、event stream 与 desktop IPC 驱动的 Alpha store/services；页面不直接消费 upstream private context。
2. **Runtime parity ledger**：逐项记录 legacy owner、Alpha replacement、API/事件来源、persist migration、characterization test、性能/安全证据与 rollback；未清零项目阻断退役。
3. **必须覆盖的域**：server/health；global sync/event replay；tabs/drafts；settings/commands；notification/models；directory/local/file；prompt/comments/permission；session timeline execution state；terminal；deep link/navigation；error/recovery；platform/updater/dialog/i18n/theme。
4. **公开能力缺口处理**：若 SDK 缺少必要读取/订阅/命令，单独立协议/SDK REQ 并先完成；禁止从 AlphaRuntime deep import upstream context 伪装成独立。
5. **产品入口切换**：Alpha desktop renderer 直接挂 Alpha Router/Shell/Runtime；`AppInterface` 从 [`ui-mac renderer entry`](../../packages/ui-mac/src/renderer/index.tsx#L422) 移除，但可继续保留给 upstream 自身产品或 legacy test harness。
6. **结构债退役**：产品入口不再依赖结构性 MutationObserver、隐藏 upstream 控件、DOM 点击代理或 build-time UI string patch；upstream adapter 只保留明确的重型 capability。

## 验收标准（逐条可验证）

1. Runtime parity ledger 的所有 mandatory 域均为 `verified`，每项链接到自动/真机证据；任何 `unknown`、`manual-only`、`temporary private context` 都会机械阻断默认入口切换。
2. [`packages/ui-mac/src/renderer/index.tsx`](../../packages/ui-mac/src/renderer/index.tsx#L422) 的 Alpha 产品路径不再导入/挂载 `AppInterface`；route/provider tree 由 Alpha package 组装，legacy harness 与 upstream 应用仍可单独构建。
3. `alpha-app` 与 `alpha-runtime` 对 `packages/app/src/**`、`packages/ui/src/**` deep import 为零；只有 `alpha-upstream-adapter` 可导入被批准的重型 viewer，并通过窄 capability contract 暴露。
4. 首次启动、sidecar health、多 server/WSL、登录/登出、项目/session/draft、streaming/steer/queue/abort、permission、model/provider、file/diff/artifact、terminal、settings/command、notification/deep link、update/error recovery 的端到端基线全部与 legacy 等价。
5. 持久化兼容测试覆盖 settings、tabs/drafts、last session、panel/file/terminal、followup 与 route restore；升级读取 legacy 数据无需用户重置，rollback 到上一稳定版也不因新 schema 崩溃。
6. Event stream 重连、重复事件、乱序/缺页、renderer reload 与 sidecar 重启下，不重复消息/permission、不丢已确认状态、不累积 subscription；必要的 replay/dedupe 有确定测试。
7. 性能预算在开工设计时以 legacy 实测冻结；AlphaRuntime 的 cold start、首个可交互、长 timeline 内存/滚动、stream update 与多 session 切换不超过批准预算，超限会阻断默认切换。
8. 安全测试证明 renderer 不获得新增 secret/文件系统/进程权限；SDK/IPC 校验、CSP、路径与错误脱敏不因去掉旧 Provider 退化。
9. Alpha 产品路径的结构性 DOM takeover、隐藏 upstream input、点击代理与 UI string patch 为零；任何 MutationObserver 均必须是业务数据观察而非页面结构接管，并有 allowlist。
10. route declaration、semantic、runtime 三类 ownership 分别在完成报告中取证；只有本项 verified 后才可宣称核心页面 runtime ownership 归 Alpha。
11. Stable 前至少完成一轮 beta soak 与 legacy/A-B 对照；回退方案为版本级 rollback，不在已挂载 session 中热切 runtime，也不自动重放 prompt/permission。
12. 删除/排除冻结 `packages/app/ui` 出 Alpha release build 只能在构建依赖图证明无消费者后另行执行；本项不以物理删除 upstream 代码作为完成捷径。

## 非目标

- 不要求重写 Markdown、diff、code viewer、Ghostty terminal 等成熟重型组件；它们可以留在受控 adapter。
- 不删除 upstream `AppInterface` 源码或妨碍 upstream app 自身构建。
- 不改变用户 URL、session 数据协议、模型执行或 permission/delivery 语义。
- 不为第三方扩展开放顶级路由/Shell/runtime 覆盖权。
- 不在 parity 未清零时以 feature flag 将半成品设为 stable 默认。

## 依赖与激活条件

- **冻结结论**：本记录未迁移为 GitHub Issue；只有在下面的条件成立并新建 owning Issue 后才可激活。
- **激活硬条件**：REQ-089 的 owning Issue 完成验收；route semantic ownership ledger 无缺口；每个 mandatory runtime 域已有可用公开 SDK/IPC 或独立补缺 Issue；legacy characterization suite 稳定。
- **完成条件**：完整 parity 清零、性能/安全门通过、beta soak 完成后才可 shipped；只把 `AppInterface` 从入口删掉不构成完成。
- **关联**：[ADR-002](../../.claude/rules/adrs/ADR-002-backend-seams.md)、[ADR-016](../../.claude/rules/adrs/ADR-016-frontend-takeover.md)、[ADR-020](../../.claude/rules/adrs/ADR-020-frontend-freeze.md)、[REQ-089](./REQ-089-alpha-route-composition.md)。
