---
id: REQ-090
title: Alpha Settings、Dialog、Model、Permission 与 Recovery 自有 surfaces
type: feature
github_issue: https://github.com/jinjunnn/alpha-code/issues/205
repo: A
created: 2026-07-10
source: "Alpha 路由、页面与扩展生态所有权专项方案（2026-07-10）§6 M4；用户拍板拆成可独立开发 REQ"
---

# REQ-090 — Alpha settings and recovery surfaces

> 本档只登记未来开发范围与验收契约；本次落档不修改设置、弹窗、模型、权限或恢复 UI。

## 背景

当前设置仍是 upstream `.settings-v2-dialog`，Alpha 主要通过 [`settings-reskin.css`](../../packages/ui-mac/src/renderer/alpha-ui/settings-reskin.css#L1) 改布局/隐藏组，并由 [`settings-back-button.ts`](../../packages/ui-mac/src/renderer/alpha-ui/settings-back-button.ts#L1) 用 MutationObserver 注入返回按钮。模型选择通过 [`model-picker-inject.tsx`](../../packages/ui-mac/src/renderer/alpha-ui/model-picker-inject.tsx#L106) 识别 upstream dialog 后 Portal 覆盖；provider 选择仍可能落回原生弹窗。权限 dock 目前主要由 [`composer-reskin.css`](../../packages/ui-mac/src/renderer/alpha-ui/composer-reskin.css#L187) 换肤。

启动连接失败由 [`ConnectionError`](../../packages/app/src/app.tsx#L357) 渲染，renderer 崩溃由 upstream [`ErrorPage`](../../packages/app/src/pages/error.tsx#L222) 承担；这些关键恢复面尚不属于 Alpha。虽然已有自有 [`Dialog`](../../packages/ui-mac/src/renderer/alpha-ui/Dialog.tsx#L11)，仍需补齐 dialog manager、focus trap/return focus、stacking 与各业务 surface 的 typed runtime。

本项在 REQ-084 surface seam 上逐域接管设置与关键系统交互，使 REQ-089 能把完整产品 route/surface manifest 归 Alpha。

## 目标与交付物

1. **Alpha Settings surface**：自有页面/全窗 surface 渲染 General、Appearance、Providers/Models、Permissions、Keybindings、Updates/Diagnostics 等实际支持项；通过 typed settings adapter 读写既有 engine/desktop 配置。
2. **Alpha Dialog foundation**：统一 modal/sheet/popover 的打开、栈、Escape、backdrop、focus trap、return focus、aria labeling 与异步确认；业务页面不再通过点击隐藏 upstream 控件来打开对话框。
3. **Model/Provider surface**：Home 与 Session 使用同一模型/provider 数据与选择语义；登录代付、BYOK、locked、无可用模型、添加 provider 与失败重试状态一致，不再依赖 `model-picker-inject` 的 DOM 识别/隐藏原生内容。
4. **Permission surface**：自有展示 permission 类型、patterns、风险与 once/always/reject 操作；保持请求顺序、session 归属、快捷键、防重复提交和引擎 permission API 语义。
5. **Recovery surfaces**：自有 startup health/connection、renderer error、session/page error、server 选择、重试、打开日志/诊断与安全返回；敏感数据默认脱敏。
6. **迁移矩阵**：盘点全部 upstream dialog/settings/model/permission/recovery surface，标记 `alpha-owned | legacy-long-tail | retired`；每个 legacy 项必须有保留原因与 owner，不得无声混用。

## 验收标准（逐条可验证）

1. Settings 在 Alpha 模式下为普通 Alpha surface，不依赖 `.settings-v2-dialog`、`:has()` 隐藏组或 MutationObserver 注入返回键；legacy 模式仍可 reload 回退。
2. 设置项读写 golden tests 证明既有配置 key、默认值、持久化位置与 dispose/热生效语义保持；未知用户字段不会被覆盖，“重置”只清理 Alpha 所拥有的键。
3. Model/Provider picker 在 Home、Draft、Session、Settings 四个入口使用同一数据模型；选择后显示值、提交参数、登录/BYOK 锁定和错误提示一致，DOM 中没有隐藏 native row 被程序点击。
4. Permission 请求按 session/到达顺序显示；once/always/reject 每次最多提交一个响应，重复点击/route 切换/断网重试不会重复授权；高风险操作不被 auto-fallback 或 surface crash 吞掉。
5. Dialog 自动测试覆盖首次焦点、Tab/Shift+Tab 循环、Escape、backdrop policy、嵌套/排队、关闭后焦点返回、异步 pending 与屏幕阅读器 title/description；鼠标关闭不会留下透明遮罩。
6. Startup server 未就绪、health timeout、多个 server、renderer throw、route throw、session 加载失败与日志导出失败均有明确恢复路径；“重试”“切换 server”“返回 Home”“打开日志”只在真实可用时出现。
7. 错误与 telemetry 中不展示或上报 token、Authorization、BYOK key、完整 prompt/tool output；绝对路径按既有隐私规则脱敏，复制诊断需用户明确动作。
8. 设置/模型/权限/恢复在浅色、深色、窄宽、键盘-only、reduce-motion 下完成视觉与可访问性回归；关键 dialog 有组件测试与桌面真机截图证据。
9. `settings-back-button.ts`、`model-picker-inject.tsx` 及已被替代的结构 CSS/DOM anchors 从 Alpha 路径退役；结构性 observer/隐藏 upstream 控件计数只下降不增加。
10. 迁移矩阵覆盖代码扫描发现的全部相关入口；尚未自建的 long-tail dialog 明确保持 legacy，不得在完成报告中宣称“全部 dialog 已接管”。
11. REQ-084 的 `alpha | legacy | auto-fallback` 规则对 settings/recovery 生效；permission 与配置写入失败只能显式报错，不允许通过回退掩盖或自动重放。

## 非目标

- 不新增 engine 配置字段、provider 类型、模型目录或 permission 语义。
- 不在本项完成完整 Alpha route composition；见 REQ-089。
- 不接管 ExtensionHub/AutomationPanel 的内部业务逻辑，它们只作为 manifest 中已有 Alpha surface 登记。
- 不移除 `AppInterface` 或重写 server/global runtime。
- 不要求一次重写所有低频 upstream dialog；允许带清单、owner 与删除计划的 long-tail legacy。

## 依赖与激活条件

- **硬依赖**：REQ-084 verified，typed surface/rollback 和 LegacyRouteAbiV1 可用。
- **兼容基线**：[REQ-030](./REQ-030-model-registry-config.md)、[REQ-069](./REQ-069-logged-out-model-default-flow.md)、[ADR-016](../../.claude/rules/adrs/ADR-016-frontend-takeover.md)。
- **下游**：REQ-089 依赖本项 verified，以免完整 Alpha manifest 留下核心系统 surface 空洞。
