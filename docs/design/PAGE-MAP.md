---
title: alpha-code page / surface map
kind: design
status: active
owners:
  - alpha-code product and design maintainers
last_reviewed: 2026-07-21
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
| Home / 首页 | alpha-ized | `ui-mac/src/renderer/alpha-ui/AlphaHome.tsx` | — (shares composer) | composer-model-redesign (`mockup.html`/`states.html`); release `auto-fallback` |
| New session / 新会话 | alpha-ized | `ui-mac/src/renderer/alpha-ui/alpha-new-session.tsx` | — (shares composer) | no dedicated mock |
| Composer / 输入框 | partial | `ui-mac/src/renderer/alpha-ui/composer-takeover.tsx` + `alpha-composer.tsx` | [`current/composer/`](current/composer/design.html) | composer-model-redesign; `hybrid` (session takes over upstream anchors) |
| Slash menu / 斜杠菜单 | alpha-ized | `ui-mac/src/renderer/alpha-ui/composer-autocomplete.tsx` | [`current/slash-menu/`](current/slash-menu/design.html) | 2026-07-09-slash-menu (REQ-072) |
| Assemble popup / 装配弹窗 | alpha-new | `ui-mac/src/renderer/alpha-ui/composer-autocomplete.tsx` (`buildAssembleRows`) | [`current/assemble-popup/`](current/assemble-popup/design.html) | 2026-07-09-assemble-popup (REQ-073) |
| Model picker / 模型选择器 | alpha-ized | `ui-mac/src/renderer/alpha-ui/alpha-composer-model.tsx` + `model-picker-add.tsx` | [`current/model-picker/`](current/model-picker/design.html) | model-picker-redesign; ADR-016 |
| Conversation timeline / 时间线 | partial | `ui-mac/src/renderer/alpha-ui/timeline-inject.tsx` + `timeline/*.css` | [`current/conversation-timeline/`](current/conversation-timeline/design.html) | timeline-overhaul; **in-flight:** req124-timeline-artifact-rows (uncommitted) |
| Extension Hub / 定制中心 | alpha-new | `ui-mac/src/renderer/extensions/extension-hub.tsx` (+ `extension-detail.tsx`, …) | [`current/customization-center/`](current/customization-center/design.html) | hub-settings → ext-hub-m2 → req103-hub-governance → req103-remaining → req104-pack-facts → **req104-four-shelf (v6)**; ADR-014/028/030. MCP mgmt folds in here (连接器) |
| Capability authorize / 能力授权 | alpha-new | `ui-mac/src/renderer/extensions/ext-authz.tsx` | [`current/capability-authorize/`](current/capability-authorize/design.html) | 2026-07-15-capability-authorize-dialog (REQ-100/#348) |
| Artifact Workbench / 产物工作台 (Office 预览) | alpha-new | `ui-mac/src/renderer/alpha-ui/artifact-workbench/artifact-workbench.tsx` | — (**mock in-flight:** req097-office-preview, uncommitted) | REQ-094/#186; renderers csv/json/markdown/ooxml/html |
| Automations / 自动化 | alpha-new | `ui-mac/src/renderer/automations/automation-panel.tsx` | — (**no mock — gap**) | — |
| Onboarding / 首次引导 | alpha-new | `ui-mac/src/renderer/alpha-ui/AlphaOnboarding.tsx` | — (**no UI mock — gap**) | loosely 2026-06-29-llm-auth-routing (routing doc) |
| Settings / 设置 | partial | `ui-mac/src/renderer/alpha-ui/settings-reskin.css` + `settings-back-button.ts` over upstream `app/src/components/dialog-settings.tsx` | [`current/settings/`](current/settings/design.html) | hub-settings-redesign; req090-alpha-surfaces. Alpha side = reskin only |
| Permission confirm / 权限确认 | **opencode** | `app/src/pages/session/composer/session-permission-dock.tsx` (upstream) | — (mock exists, **no alpha impl — gap**) | req090-alpha-surfaces (Permission) |
| General Dialog / 通用弹窗 | partial | `ui-mac/src/renderer/alpha-ui/Dialog.tsx` | — | req090-alpha-surfaces (Dialog); alpha Dialog hosts only alpha consumers |
| Boot / Surface recovery / 恢复 | partial | `ui-mac/src/main/db-safety-boot.ts` + `renderer/alpha-ui/surface-boundary.tsx` | — | req090-alpha-surfaces (Recovery); #334 |
| Session workspace / 会话工作区 | partial | `ui-mac/src/renderer/alpha-ui/session-workspace/alpha-session-workspace.tsx` | — | composer-model-redesign; req090. **Gated OFF** (`SURFACE_RELEASE_STATES.session = "legacy"`) |
| Toast | alpha-new | `ui-mac/src/renderer/alpha-ui/Toast.tsx` | — (primitive, no mock) | — |
| Command palette (Cmd-K) | opencode | `app/src/context/command.tsx` (upstream) | — | not reskinned by alpha |

## Gaps

**Design without implementation** (mock exists, still upstream / gated / reskin-only):
- **Permission confirm** — cleanest gap: mock in req090, impl still upstream dock.
- **Session workspace** — alpha frame built but gated `legacy`; ships upstream leaf.
- **Settings** — mocks exist; alpha side is reskin CSS + back-button only.
- **General Dialog / Recovery** — req090 mocks exist; impl is `hybrid`.

**Implementation without design** (alpha surface, no mock):
- **Automations panel** — alpha-new full page, no mock.
- **Onboarding** — alpha-new overlay, no UI mock.
- **New session** — alpha leaf, relies on composer mock only.

Active delivery state for these gaps belongs in GitHub Issues, not this file.
