---
title: alpha-code page / surface map
kind: design
status: active
owners:
  - alpha-code product and design maintainers
last_reviewed: 2026-07-24
review_after: 2027-01-16
---

# Page / surface map

Every user-visible surface of the shipping desktop app (`packages/ui-mac`), its
**alpha-vs-opencode** status, and where its **current design** lives.

**This file does not own the surface inventory or its lineage — two committed
artifacts do:** the executable, test-covered manifest
[`packages/ui-mac/src/shared/frontend-surface-manifest.ts`](../../packages/ui-mac/src/shared/frontend-surface-manifest.ts)
(which also drives the in-app **Surface-Map inspector**, `DEV` build,
`Cmd/Ctrl+Shift+M`) and its architecture doc
[`../architecture/frontend-surfaces.md`](../architecture/frontend-surfaces.md).
**This is their design companion:** it maps each surface to its *design* (current
mock, history) and flags where design and implementation diverge. The status
column below mirrors the manifest's `lineage` for at-a-glance reading — when they
differ, **the manifest wins; fix this file.**

Each surface's **intended end-state** (`target`) also lives in the manifest.
`target !== lineage` = a surface still being replaced (the replacement backlog,
`frontendSurfacesPendingReplacement()`); `target === lineage` = stable. The
method for moving a surface up the ladder is
[`system/replacing-opencode.md`](system/replacing-opencode.md); its **sequencing
and priority live in GitHub Issues + the Alpha Delivery Project**, never here.

## Status legend

- **alpha-ized** — alpha replaced an upstream opencode surface with its own.
- **alpha-new** — net-new surface; no upstream equivalent.
- **partial** — alpha + opencode mix (reskin/injection/takeover, or gated off).
- **opencode** — still the inherited upstream surface, essentially untouched.

Note: `packages/ui-mac` does not exist upstream at all — the whole Electron shell
is alpha-authored. "opencode" below means the surface is rendered by an upstream
`packages/app/**` component that alpha mounts but has not replaced.

## Surfaces

| Surface | Status | Code entry (`packages/…`) | Current design | Design history / owning REQ |
| --- | --- | --- | --- | --- |
| Shell / 侧栏 | alpha-ized | `ui-mac/src/renderer/sidebar/alpha-sidebar.tsx` | [`current/shell-sidebar/`](current/shell-sidebar/design.html) | composer-model-redesign (`shell.html`) |
| Home / 首页 | alpha-ized | `ui-mac/src/renderer/alpha-ui/AlphaHome.tsx` | — (shares composer) | composer-model-redesign (`mockup.html`/`states.html`); release default = alpha(崩溃进 Alpha Recovery,不回上游叶) |
| New session / 新会话 | alpha-ized | `ui-mac/src/renderer/alpha-ui/alpha-new-session.tsx` | — (shares composer) | no dedicated mock |
| Composer / 输入框 | alpha-ized | `ui-mac/src/renderer/alpha-ui/session-workspace/session-composer-dock.tsx` + `alpha-composer.tsx` | [`current/composer/`](current/composer/design.html) | composer-model-redesign; 2026-07-24-session-seam-baseline (REQ-125 C7). seam 会话页直挂,零 Portal/零选择器;旧 composer-takeover 已删,manifest lineage = alpha |
| Slash menu / 斜杠菜单 | alpha-ized | `ui-mac/src/renderer/alpha-ui/composer-autocomplete.tsx` | [`current/slash-menu/`](current/slash-menu/design.html) | 2026-07-09-slash-menu (REQ-072) |
| Assemble popup / 装配弹窗 | alpha-new | `ui-mac/src/renderer/alpha-ui/composer-autocomplete.tsx` (`buildAssembleRows`) | [`current/assemble-popup/`](current/assemble-popup/design.html) | 2026-07-09-assemble-popup (REQ-073) |
| Model picker / 模型选择器 | alpha-ized | `ui-mac/src/renderer/alpha-ui/alpha-composer-model.tsx` + `model-picker-add.tsx` | [`current/model-picker/`](current/model-picker/design.html) | model-picker-redesign; ADR-016 |
| Conversation timeline / 时间线 | alpha-ized | `ui-mac/src/renderer/alpha-ui/session-timeline/session-timeline.tsx` (+ `cards/`) | [`current/conversation-timeline/`](current/conversation-timeline/design.html) | timeline-overhaul; artifact-rows 增量 = `2026-07-21-req124-timeline-artifact-rows/`(已批准;设计层已并入 current §⑥,2026-07-23;实现票 #449 open)。REQ-125 C5/C6 自持 typed leaf;旧 timeline-inject/reskin 注入已删(C8),manifest lineage = alpha |
| Extension Hub / 定制中心 | alpha-new | `ui-mac/src/renderer/extensions/extension-hub.tsx` (+ `extension-detail.tsx`, …) | [`current/customization-center/`](current/customization-center/design.html) | hub-settings → ext-hub-m2 → req103-hub-governance → req103-remaining → req104-pack-facts → **req104-four-shelf (v6)**; ADR-014/028/030. MCP mgmt folds in here (连接器) |
| Capability authorize / 能力授权 | alpha-new | `ui-mac/src/renderer/extensions/ext-authz.tsx` | [`current/capability-authorize/`](current/capability-authorize/design.html) | 2026-07-15-capability-authorize-dialog (REQ-100/#348) |
| Session artifacts rail / 会话产物右栏 | alpha-new | `ui-mac/src/renderer/alpha-ui/session-rail/artifacts/session-rail-artifacts.tsx` | [`current/artifact-workbench/`](current/artifact-workbench/design.html) | 外壳 REQ-094/#186 已合;Office 预览内容 REQ-097/#189 + REQ-123/#438 open;renderers csv/json/markdown/ooxml/html。**REQ-126 AC3(#654):全页产物工作台已下线**(侧栏「产物」入口 + 全页挂载都删了,`overlay.artifacts` 已退出 manifest)—— 产物只经会话右栏到达,卡片/状态/预览语言与 renderers 仍复用 `artifact-workbench/`。**跨 run 浏览、云端单件取回、落盘即刷新已交付**(#660,设计稿 `2026-07-28-req126-artifacts-cross-run/`:云任务条 + `cloud-run-saved` 最小推送 + `updatedAt` 真按时排序);**run 级管理动作(删除/清理)仍未交付** —— owner 裁决推迟,#660 的关闭不含它 |
| Automations / 自动化 | alpha-new | `ui-mac/src/renderer/automations/automation-panel.tsx` | — (**no mock — gap**) | — |
| Onboarding / 首次引导 | alpha-new | `ui-mac/src/renderer/alpha-ui/AlphaOnboarding.tsx` | — (**no UI mock — gap**) | loosely 2026-06-29-llm-auth-routing (routing doc) |
| Settings / 设置 | alpha-ized | `ui-mac/src/renderer/alpha-ui/settings.tsx` | [`current/settings/`](current/settings/design.html) | hub-settings-redesign; req090-alpha-surfaces。自渲染 Alpha overlay(不嵌上游 dialog-settings),只消费 typed adapters |
| Permission confirm / 权限确认 | alpha-ized | `ui-mac/src/renderer/alpha-ui/permission-watcher.tsx` + `PermissionDialog.tsx` | — (设计=req090-alpha-surfaces Permission) | req090-alpha-surfaces。读 PermissionV2、经 Alpha Dialog 原子提交;不再挂上游 dock |
| General Dialog / 通用弹窗 | partial | `ui-mac/src/renderer/alpha-ui/Dialog.tsx` | — | req090-alpha-surfaces (Dialog); alpha Dialog hosts only alpha consumers |
| Boot / Surface recovery / 恢复 | alpha-ized | `ui-mac/src/main/db-safety-boot.ts` + `renderer/alpha-ui/surface-boundary.tsx` | — | req090-alpha-surfaces (Recovery); #334。两面(boot.recovery / inline.surface-recovery)manifest lineage 均 = alpha;Alpha Recovery 单向门,不回落 legacy |
| Session workspace / 会话工作区 | alpha-ized | `ui-mac/src/renderer/alpha-ui/session-workspace/alpha-session-workspace.tsx` | [`current/session-workspace/`](current/session-workspace/design.html) | composer-model-redesign; req090; 2026-07-24-session-seam-baseline (REQ-125). release default = alpha,零消费上游 session 叶(时间线/右栏四面板已自持;composer 接线随 C7),manifest lineage = alpha |
| Toast | alpha-new | `ui-mac/src/renderer/alpha-ui/Toast.tsx` | — (primitive, no mock) | — |
| Command palette (Cmd-K) / 会话搜索 | alpha-new | `ui-mac/src/renderer/alpha-ui/alpha-session-search.tsx` | — (**no UI mock — gap**) | REQ-126 CODE-F(#659)。命令**总线**仍是上游 `app/src/context/command.tsx`;`command.palette` 的注册与面板本体归 alpha 壳(上游三处注册随被顶替的叶一起消失)。承诺面只有「按标题搜会话 + 按结果来源 server 跳转」,不含文件搜索/命令执行/跨服务器检索 |

## Gaps

**Replacement backlog** (`lineage !== target` in the manifest — hybrid surfaces
owner-targeted for full alpha, 2026-07-21):
- **General Dialog** (`overlay.dialog`) — hybrid host; bridges upstream + alpha consumers.

(Settings, Permission, Recovery — and, since REQ-125 C7/C8, Session workspace,
Conversation timeline, and Composer — are now `alpha` in the manifest; no longer
gaps.)

**Implementation without design** (alpha surface, no mock):
- **Automations panel** — alpha-new full page, no mock.
- **Onboarding** — alpha-new overlay, no UI mock.
- **Command palette / 会话搜索** — alpha-new overlay, no UI mock（最小实现:输入框 + 结果列表）。
- **New session** — alpha leaf, relies on composer mock only.

Active delivery state for these gaps belongs in GitHub Issues, not this file.
