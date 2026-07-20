// Canonical frontend composition manifest.
//
// This is deliberately broader than a URL sitemap: Alpha mounts user-visible ownership
// boundaries as routes, overlays, inline takeovers, and boot-time recovery hosts. Keep
// mutable delivery state in GitHub; this file records only executable composition facts.

import type { LegacyRoute } from "./legacy-route-abi"
import type { SurfaceId } from "./alpha-surfaces"

export const FRONTEND_SURFACE_MANIFEST_VERSION = 1

export type FrontendSurfaceLineage = "alpha" | "opencode" | "hybrid"
export type FrontendSurfaceAvailability = "default" | "gated" | "development"

export type FrontendSurfaceMount =
  | { kind: "route"; path: string; host: "app-router"; role: "page" | "redirect" }
  | { kind: "overlay"; host: string }
  | { kind: "inline"; route: "*" | "session"; slot: string }
  | { kind: "boot"; host: string; phase: "pre-window" | "renderer" }

export interface FrontendSurfaceEntry {
  id: string
  label: string
  description: string
  owner: string
  lineage: FrontendSurfaceLineage
  mount: FrontendSurfaceMount
  availability: FrontendSurfaceAvailability
  source: string
  releaseSurface?: SurfaceId
  fallback?: string
  entrypoints: readonly string[]
  transitions: readonly { label: string; target: string }[]
}

/**
 * Top-level composition boundaries only. Small popovers, tabs, and leaf controls belong to
 * their enclosing surface and must not become independent entries merely because they render.
 */
export const FRONTEND_SURFACE_MANIFEST = [
  {
    id: "route.home",
    label: "首页",
    description: "Alpha 自有首页叶；发布默认启用，同版本致命渲染错误后可回退上游首页。",
    owner: "alpha.home",
    lineage: "alpha",
    mount: { kind: "route", path: "/", host: "app-router", role: "page" },
    availability: "default",
    source: "packages/ui-mac/src/renderer/alpha-ui/AlphaHome.tsx",
    releaseSurface: "home",
    fallback: "opencode.home",
    entrypoints: ["应用启动", "侧栏品牌按钮", "返回首页"],
    transitions: [
      { label: "首页提交", target: "route.session" },
      { label: "选择项目新会话", target: "route.session-admission" },
      { label: "打开已有会话", target: "route.session" },
    ],
  },
  {
    id: "route.directory",
    label: "项目入口重定向",
    description: "冻结的上游兼容入口；将 /:dir 重定向到同一项目的 session admission。",
    owner: "opencode.router",
    lineage: "opencode",
    mount: { kind: "route", path: "/:dir", host: "app-router", role: "redirect" },
    availability: "default",
    source: "packages/app/src/app.tsx",
    entrypoints: ["兼容深链", "项目导航"],
    transitions: [{ label: "Navigate session", target: "route.session-admission" }],
  },
  {
    id: "route.session-admission",
    label: "新会话准入",
    description: "无 session id 的上游兼容路由；创建 draft/tab 后转入 Alpha 新会话页。",
    owner: "opencode.session-route",
    lineage: "opencode",
    mount: { kind: "route", path: "/:dir/session", host: "app-router", role: "redirect" },
    availability: "default",
    source: "packages/app/src/app.tsx",
    entrypoints: ["侧栏新会话", "项目入口重定向"],
    transitions: [{ label: "创建 draft", target: "route.new-session" }],
  },
  {
    id: "route.new-session",
    label: "新会话",
    description: "Alpha 自有 draft 叶；保留上游 DraftProviders 与 tab 晋升生命周期。",
    owner: "alpha.new-session",
    lineage: "alpha",
    mount: { kind: "route", path: "/new-session?draftId=…", host: "app-router", role: "page" },
    availability: "default",
    source: "packages/ui-mac/src/renderer/alpha-ui/alpha-new-session.tsx",
    releaseSurface: "newSession",
    fallback: "opencode.new-session",
    entrypoints: ["新会话准入", "draft 深链"],
    transitions: [{ label: "首次提交并晋升", target: "route.session" }],
  },
  {
    id: "route.session",
    label: "会话工作区",
    description: "发布默认仍是上游会话叶；Alpha 侧栏与 takeover 共存，双闸可启用 Alpha workspace 外框。",
    owner: "alpha.session-seam",
    lineage: "hybrid",
    mount: { kind: "route", path: "/:dir/session/:id", host: "app-router", role: "page" },
    availability: "gated",
    source: "packages/ui-mac/src/renderer/alpha-ui/session-workspace/alpha-session-workspace.tsx",
    releaseSurface: "session",
    fallback: "opencode.session",
    entrypoints: ["首页提交", "新会话晋升", "侧栏会话", "通知深链"],
    transitions: [
      { label: "新建会话", target: "route.session-admission" },
      { label: "返回首页", target: "route.home" },
    ],
  },
  {
    id: "shell.sidebar",
    label: "Alpha 侧栏",
    description: "全路由常驻的 Alpha 导航壳，拥有项目、会话和非 URL 工作面的入口。",
    owner: "alpha.sidebar",
    lineage: "alpha",
    mount: { kind: "inline", route: "*", slot: "app-shell" },
    availability: "default",
    source: "packages/ui-mac/src/renderer/sidebar/alpha-sidebar.tsx",
    entrypoints: ["AppInterface children"],
    transitions: [
      { label: "首页", target: "route.home" },
      { label: "新会话", target: "route.session-admission" },
      { label: "定制中心", target: "overlay.extensions" },
      { label: "自动化", target: "overlay.automations" },
      { label: "产物", target: "overlay.artifacts" },
    ],
  },
  {
    id: "overlay.onboarding",
    label: "首次使用引导",
    description: "Alpha 自有全局 onboarding overlay，不改变当前内存路由。",
    owner: "alpha.onboarding",
    lineage: "alpha",
    mount: { kind: "overlay", host: "app-root" },
    availability: "default",
    source: "packages/ui-mac/src/renderer/alpha-ui/AlphaOnboarding.tsx",
    entrypoints: ["首次启动门控"],
    transitions: [{ label: "完成或关闭", target: "current-route" }],
  },
  {
    id: "overlay.extensions",
    label: "定制中心",
    description: "Alpha 自有全页 overlay；由模块级瞬态状态开合，URL 保持不变。",
    owner: "alpha.extension-hub",
    lineage: "alpha",
    mount: { kind: "overlay", host: "app-root" },
    availability: "default",
    source: "packages/ui-mac/src/renderer/extensions/extension-hub.tsx",
    entrypoints: ["侧栏定制中心", "Composer 扩展入口"],
    transitions: [{ label: "关闭", target: "current-route" }],
  },
  {
    id: "overlay.automations",
    label: "自动化",
    description: "Alpha 自有全页 Portal；关闭回到原路由，打开运行记录可跳入会话。",
    owner: "alpha.automations",
    lineage: "alpha",
    mount: { kind: "overlay", host: "alpha-automations-root" },
    availability: "default",
    source: "packages/ui-mac/src/renderer/automations/automation-panel.tsx",
    entrypoints: ["侧栏自动化"],
    transitions: [
      { label: "关闭", target: "current-route" },
      { label: "打开运行会话", target: "route.session" },
    ],
  },
  {
    id: "overlay.artifacts",
    label: "产物工作台",
    description: "Alpha 自有全页 Portal；在当前路由之上浏览 run 与 artifact。",
    owner: "alpha.artifact-workbench",
    lineage: "alpha",
    mount: { kind: "overlay", host: "alpha-artifact-workbench-root" },
    availability: "default",
    source: "packages/ui-mac/src/renderer/alpha-ui/artifact-workbench/artifact-workbench.tsx",
    entrypoints: ["侧栏产物", "产物通知"],
    transitions: [{ label: "关闭", target: "current-route" }],
  },
  {
    id: "inline.composer",
    label: "会话 Composer",
    description: "Alpha Composer 通过 takeover 依赖上游会话锚点并隐藏旧 Composer，仍属混合组合。",
    owner: "alpha.composer-takeover",
    lineage: "hybrid",
    mount: { kind: "inline", route: "session", slot: "composer" },
    availability: "default",
    source: "packages/ui-mac/src/renderer/alpha-ui/composer-takeover.tsx",
    entrypoints: ["会话工作区"],
    transitions: [{ label: "提交消息", target: "route.session" }],
  },
  {
    id: "overlay.model-picker",
    label: "模型选择器",
    description: "Alpha picker 注入上游模型入口；目录与宿主生命周期仍来自上游。",
    owner: "alpha.model-picker-inject",
    lineage: "hybrid",
    mount: { kind: "overlay", host: "opencode-model-anchor" },
    availability: "default",
    source: "packages/ui-mac/src/renderer/alpha-ui/model-picker-inject.tsx",
    entrypoints: ["首页 Composer", "会话 Composer"],
    transitions: [{ label: "选择或关闭", target: "current-route" }],
  },
  {
    id: "inline.timeline",
    label: "会话时间线",
    description: "Alpha 渲染与样式注入上游 timeline DOM；尚未成为独立 typed leaf。",
    owner: "alpha.timeline-inject",
    lineage: "hybrid",
    mount: { kind: "inline", route: "session", slot: "timeline" },
    availability: "default",
    source: "packages/ui-mac/src/renderer/alpha-ui/timeline-inject.tsx",
    entrypoints: ["会话工作区"],
    transitions: [{ label: "消息定位", target: "route.session" }],
  },
  {
    id: "overlay.settings",
    label: "设置",
    description: "上游设置宿主叠加 Alpha reskin 与返回按钮 observer，当前是混合面。",
    owner: "alpha.settings-adapter",
    lineage: "hybrid",
    mount: { kind: "overlay", host: "opencode-settings-dialog" },
    availability: "default",
    source: "packages/ui-mac/src/renderer/alpha-ui/settings-back-button.ts",
    entrypoints: ["侧栏账户菜单", "命令面板"],
    transitions: [{ label: "关闭或返回", target: "current-route" }],
  },
  {
    id: "inline.permission",
    label: "权限确认",
    description: "当前由上游 SessionProviders/Composer dock 提供；Alpha 自有契约与宿主尚未替换。",
    owner: "opencode.permission",
    lineage: "opencode",
    mount: { kind: "inline", route: "session", slot: "before-composer" },
    availability: "default",
    source: "packages/app/src/pages/session/composer/session-permission-dock.tsx",
    entrypoints: ["工具权限请求"],
    transitions: [{ label: "回复后继续", target: "route.session" }],
  },
  {
    id: "overlay.dialog",
    label: "通用 Dialog",
    description: "Alpha 与上游 Dialog 并存；Alpha primitive 只拥有 Alpha 消费者，尚非全局唯一宿主。",
    owner: "alpha.dialog",
    lineage: "hybrid",
    mount: { kind: "overlay", host: "mixed-dialog-roots" },
    availability: "default",
    source: "packages/ui-mac/src/renderer/alpha-ui/Dialog.tsx",
    entrypoints: ["各 Alpha/上游确认流程"],
    transitions: [{ label: "确认或关闭", target: "current-route" }],
  },
  {
    id: "boot.recovery",
    label: "启动恢复",
    description: "数据库安全与 sidecar fatal 仍横跨 Electron 原生框和 Alpha banner，当前是混合恢复宿主。",
    owner: "alpha.boot-recovery",
    lineage: "hybrid",
    mount: { kind: "boot", host: "electron-main", phase: "pre-window" },
    availability: "default",
    source: "packages/ui-mac/src/main/db-safety-boot.ts",
    entrypoints: ["数据库损坏", "数据库版本过新", "sidecar 停止"],
    transitions: [
      { label: "恢复后启动", target: "route.home" },
      { label: "退出", target: "application-exit" },
    ],
  },
  {
    id: "inline.surface-recovery",
    label: "页面恢复",
    description: "Alpha route surface 致命错误边界；记录失败后 reload，并按 resolver 回退上游叶。",
    owner: "alpha.surface-boundary",
    lineage: "hybrid",
    mount: { kind: "inline", route: "*", slot: "surface-error-boundary" },
    availability: "default",
    source: "packages/ui-mac/src/renderer/alpha-ui/surface-boundary.tsx",
    entrypoints: ["Alpha route 叶致命渲染错误"],
    transitions: [{ label: "记录并重新加载", target: "current-route" }],
  },
  {
    id: "dev.surface-map",
    label: "Frontend Surface Map",
    description: "由本 Manifest 生成的开发检查面板；不加入产品路由，不进入生产构建。",
    owner: "alpha.dev-surface-map",
    lineage: "alpha",
    mount: { kind: "overlay", host: "dev-inspector-root" },
    availability: "development",
    source: "packages/ui-mac/src/renderer/dev/surface-map-inspector.tsx",
    entrypoints: ["右上角 MAP 按钮", "Cmd/Ctrl + Shift + M"],
    transitions: [{ label: "关闭", target: "current-route" }],
  },
] as const satisfies readonly FrontendSurfaceEntry[]

export type FrontendSurfaceId = (typeof FRONTEND_SURFACE_MANIFEST)[number]["id"]

export function frontendSurfaceById(id: string) {
  return FRONTEND_SURFACE_MANIFEST.find((surface) => surface.id === id)
}

export function frontendSurfaceIdForRoute(route: LegacyRoute): FrontendSurfaceId | undefined {
  if (route.kind === "home") return "route.home"
  if (route.kind === "directory") return "route.directory"
  if (route.kind === "newSession") return "route.new-session"
  if (route.kind === "session" && route.id) return "route.session"
  if (route.kind === "session") return "route.session-admission"
  return undefined
}
