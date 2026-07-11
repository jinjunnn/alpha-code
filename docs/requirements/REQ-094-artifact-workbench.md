---
id: REQ-094
title: Alpha Artifact Workbench 基座 —— Artifacts/Preview/Files/Changes/Inspector 与 run 发现闭环
type: ux
github_issue: https://github.com/jinjunnn/alpha-code/issues/206
repo: A
created: 2026-07-10
source: alpha 三仓全面审计与产物能力专项(2026-07-10)+Alpha Product Kernel 所有权方案;用户确认拆为独立开发 REQ(2026-07-10)
---

## 背景

现有右侧 `packages/app/src/pages/session/session-side-panel.tsx` 主要承载 Review、Context、Files 与 Changes，不是产物工作台。云任务完成后，`cloud-run-watcher.tsx` 只 toast `.alpha/runs` 路径，Extension Hub 的 cloud dispatch 只显示目录，automation history 最多打开整个 run 目录；用户无法从会话发现、选择、预览或验证具体 artifact。

按照 [[ADR-016]]，Alpha 应持有用户可见页面与信息架构；[[ADR-020]] 又冻结 `packages/{app,ui}`，因此 Workbench 必须落在 Alpha 自有 renderer 层，通过 typed adapter 复用旧 Files/Changes/review 重型组件，不能继续向冻结页面叠加 DOM 注入。

## 目标与交付

1. 建立 Alpha-owned `Workbench` 容器和状态模型，能力面包含：
   - `Artifacts`：当前 session/turn/run 的产物列表、来源、大小、版本与验证状态；
   - `Preview`：承载 renderer，提供 Preview/Source/Metadata/Verification/fallback；
   - `Files`：项目文件树和已打开文件；
   - `Changes`：Git/branch/last-turn diff/review；
   - `Inspector`：run/tool/agent/model/permission/token/duration/error/action log。
2. 信息架构允许把 `Artifacts + Preview` 合为主工作流、`Files + Changes` 合为 Workspace，Inspector 放上下文抽屉；能力模型必须存在，但不强制把五个窄 tab 平铺。
3. 通过 [[REQ-093]] manifest/source 自动发现 `.alpha/runs/*/artifacts.json`；cloud/automation/tool 完成后在 timeline 出现 artifact card 并给 Workbench badge，不只显示路径 toast，也不自动抢焦点。
4. 支持 artifact deep link、选中/返回、专注预览、外部打开/保存副本，以及 renderer 失败时的 Source/Metadata/fallback。状态按 session 保存：活动模式、选中 artifact、宽度和各区滚动位置。
5. 复用旧 Files/Changes/review 时只允许通过 `LegacyFilesAdapter`/`LegacyChangesAdapter` 等粗粒度 typed seam；Alpha 持有容器、生命周期、错误边界、路由语义和可访问性。
6. 响应式布局：≥1440 px 时 Workbench 默认约 420 px、可在 320–720 px 调整；1024–1439 px 使用覆盖抽屉/可切换主视图；<1024 px 与 Conversation 二选一全高显示。
7. 建立独立 harness：以 fake `ArtifactSource`、manifest fixture 和 renderer stub 在 Storybook/fixture route/组件测试中开发，不依赖真实 cloud、Office converter 或完整 Session runtime；后续接入产品路由时不重写核心状态机。

## 可验证验收标准

1. 独立 harness 可载入至少两个 run、十个混合 descriptor，完成列表、筛选、选择、Preview/Source/Metadata 切换、错误 fallback 和 deep link 回放；测试不启动真实 sidecar/cloud。
2. 真实 cloud run 完成后，timeline 出现可聚焦 artifact card，Workbench badge 增加；点击直接选中对应 descriptor。用户正在查看其他内容时不会被强制切换。
3. 重启应用后，Workbench 从 [[REQ-093]] 恢复同一 run/artifact；legacy run 显示 `unverified`，不会伪造验证结果。
4. Files/Changes 与 artifact preview 可在同一 SessionWorkspace 切换，旧 terminal/timeline/diff 的 session、scroll、focus 和快捷键不被 remount 丢失。
5. 三档响应式宽度和面板 resize 有组件/视觉回归测试；窄屏可完整访问 Conversation 与 Workbench，不因旧 `<768px` 规则消失。
6. 键盘可完成打开/关闭、模式切换、artifact 选择和返回；使用正确 `tablist/tab` 或等价语义、可见 focus、焦点恢复、`aria-live` 非打断通知，满足 WCAG 2.2 AA 基线。
7. 单个 renderer 抛错/worker crash 时只影响对应 Preview，Session、Composer、timeline 与其他 Workbench 模式继续可用。
8. 代码边界测试证明 Alpha Workbench 不直接 import 冻结页面内部实现；旧组件引用只存在于集中 adapter 层，无新增结构性 `MutationObserver`、`querySelector` 注入或构建期字符串 patch。

## 非目标

- 不在本需求实现每种格式的完整 renderer；归 [[REQ-095]]、[[REQ-096]]、[[REQ-097]]。
- 不实现内置 Browser；仅预留按 capability 出现的模式，归 [[REQ-106]]。
- 不在本需求重写 timeline、terminal、diff 或文件树；它们先作为 typed adapter 消费。
- 不把 Workbench 变成六个永久可见的窄 tab，也不在没有 Browser session 时显示空 Browser 标签。
- 不在本需求完成全部顶级路由接管；它应能被后续 Alpha SessionWorkspace 直接组合。

## 依赖与激活条件

- 依赖 [[REQ-093]] 的 descriptor/manifest 契约；可先基于固定 schema fixture 独立开发 harness，产品接线在 REQ-093 contract test 通过后启用。实施排期只在 GitHub 管理。
- 遵守 [[ADR-016]] 的 Alpha UI 所有权与 [[ADR-020]] 冻结边界；与 [[REQ-055]] 统一 Composer、现有 SessionWorkspace/route 接管 REQ 协同。
- 为 [[REQ-095]]、[[REQ-096]]、[[REQ-106]] 提供稳定 renderer host/tab contribution 接缝。
