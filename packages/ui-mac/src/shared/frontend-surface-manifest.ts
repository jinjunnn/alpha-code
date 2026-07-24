// Canonical frontend composition manifest.
//
// This is deliberately broader than a URL sitemap: Alpha mounts user-visible ownership
// boundaries as routes, overlays, inline takeovers, and boot-time recovery hosts. Keep
// mutable delivery state in GitHub; this file records only executable composition facts.

import type { SurfaceId } from "./alpha-surfaces"
import type { Route } from "./route-manifest"

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
  /**
   * Intended end-state lineage (设计意图,非当前态). `target !== lineage` marks a
   * surface still being replaced — the replacement backlog, queryable via
   * `frontendSurfacesPendingReplacement()`. `target === lineage` is stable (either
   * already alpha-owned, or a deliberately kept upstream compat surface). Method:
   * docs/design/system/replacing-opencode.md. Sequencing/priority live in Issues,
   * never here.
   */
  target: FrontendSurfaceLineage
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
    description: "Alpha 自有首页叶；发布默认启用，致命渲染错误进入 Alpha Recovery，不改变 composition。",
    owner: "alpha.home",
    lineage: "alpha",
    target: "alpha",
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
    target: "opencode",
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
    target: "opencode",
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
    target: "alpha",
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
    description: "Alpha 自有会话工作区叶（顶栏/时间线/右栏四面板），发布默认 alpha，零消费上游 session 叶；legacy 仅为启动期 env/pin 回退。",
    owner: "alpha.session-seam",
    lineage: "alpha",
    target: "alpha",
    mount: { kind: "route", path: "/:dir/session/:id", host: "app-router", role: "page" },
    availability: "default",
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
    target: "alpha",
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
    target: "alpha",
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
    target: "alpha",
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
    target: "alpha",
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
    target: "alpha",
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
    target: "alpha",
    mount: { kind: "inline", route: "session", slot: "composer" },
    availability: "default",
    source: "packages/ui-mac/src/renderer/alpha-ui/composer-takeover.tsx",
    entrypoints: ["会话工作区"],
    transitions: [{ label: "提交消息", target: "route.session" }],
  },
  {
    id: "overlay.model-picker",
    label: "模型选择器",
    description: "Alpha Composer 锚定的自有 picker；通过 typed model list/switch contract 读取并切换。",
    owner: "alpha.composer-model",
    lineage: "alpha",
    target: "alpha",
    mount: { kind: "overlay", host: "alpha-composer-model" },
    availability: "default",
    source: "packages/ui-mac/src/renderer/alpha-ui/alpha-composer-model.tsx",
    entrypoints: ["首页 Composer", "会话 Composer"],
    transitions: [{ label: "选择或关闭", target: "current-route" }],
  },
  {
    id: "inline.timeline",
    label: "会话时间线",
    description: "Alpha 自有 typed 时间线 leaf：SDK 数据源、行模型/虚拟化/卡片全集；旧的上游 DOM 注入与 reskin CSS 已退役删除。",
    owner: "alpha.session-timeline",
    lineage: "alpha",
    target: "alpha",
    mount: { kind: "inline", route: "session", slot: "timeline" },
    availability: "default",
    source: "packages/ui-mac/src/renderer/alpha-ui/session-timeline/session-timeline.tsx",
    entrypoints: ["会话工作区"],
    transitions: [{ label: "消息定位", target: "route.session" }],
  },
  {
    id: "overlay.settings",
    label: "设置",
    description: "Alpha 自有全页 Settings overlay；通用、快捷键与扩展存储只消费 typed adapters。",
    owner: "alpha.settings",
    lineage: "alpha",
    target: "alpha",
    mount: { kind: "overlay", host: "app-root" },
    availability: "default",
    source: "packages/ui-mac/src/renderer/alpha-ui/settings.tsx",
    entrypoints: ["侧栏账户菜单", "命令面板"],
    transitions: [{ label: "返回应用", target: "current-route" }],
  },
  {
    id: "inline.permission",
    label: "权限确认",
    description: "Alpha 自有确认面读取公开 PermissionV2 请求，并通过 Alpha Dialog 原子提交三态决定。",
    owner: "alpha.permission",
    lineage: "alpha",
    target: "alpha",
    mount: { kind: "overlay", host: "alpha-permission-dialog" },
    availability: "default",
    source: "packages/ui-mac/src/renderer/alpha-ui/permission-watcher.tsx",
    entrypoints: ["工具权限请求"],
    transitions: [{ label: "回复后继续", target: "route.session" }],
  },
  {
    id: "overlay.dialog",
    label: "通用 Dialog",
    description:
      "通用上游消费者显式进入唯一 Alpha Dialog host；Settings、Model、Provider 与 Permission 仍由各自迁移线负责。",
    owner: "alpha.dialog",
    lineage: "hybrid",
    target: "alpha",
    mount: { kind: "overlay", host: "alpha-dialog-root" },
    availability: "default",
    source: "packages/ui-mac/src/renderer/alpha-ui/Dialog.tsx",
    entrypoints: ["各 Alpha/上游确认流程"],
    transitions: [{ label: "确认或关闭", target: "current-route" }],
  },
  {
    id: "boot.recovery",
    label: "启动恢复",
    description: "产品窗口创建前由独立、最小 preload 的 Alpha renderer 呈现 DbSafety 恢复动作。",
    owner: "alpha.recovery",
    lineage: "alpha",
    target: "alpha",
    mount: { kind: "boot", host: "alpha-recovery-window", phase: "pre-window" },
    availability: "default",
    source: "packages/ui-mac/src/renderer/alpha-ui/RecoverySurface.tsx",
    entrypoints: ["数据库损坏", "数据库版本过新"],
    transitions: [
      { label: "恢复后启动", target: "route.home" },
      { label: "退出", target: "application-exit" },
    ],
  },
  {
    id: "inline.surface-recovery",
    label: "页面恢复",
    description:
      "唯一运行时 Alpha Recovery host；承接 sidecar 停手、surface 崩溃与失败记录保存重试，绝不 reload legacy。",
    owner: "alpha.recovery",
    lineage: "alpha",
    target: "alpha",
    mount: { kind: "overlay", host: "alpha-runtime-recovery-root" },
    availability: "default",
    source: "packages/ui-mac/src/renderer/alpha-ui/RuntimeRecoveryHost.tsx",
    entrypoints: ["Sidecar 自动恢复停手", "Alpha route 叶致命渲染错误", "错误记录保存失败"],
    transitions: [{ label: "执行安全恢复动作", target: "current-route" }],
  },
  {
    id: "dev.surface-map",
    label: "Frontend Surface Map",
    description: "由本 Manifest 生成的开发检查面板；不加入产品路由，不进入生产构建。",
    owner: "alpha.dev-surface-map",
    lineage: "alpha",
    target: "alpha",
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

/**
 * The replacement backlog: surfaces whose intended end-state differs from their
 * current lineage (`target !== lineage`). Sequencing/priority is NOT here — it
 * lives in GitHub Issues + the Alpha Delivery Project. See
 * docs/design/system/replacing-opencode.md.
 */
export function frontendSurfacesPendingReplacement() {
  return FRONTEND_SURFACE_MANIFEST.filter((surface) => surface.target !== surface.lineage)
}

export function frontendSurfaceIdForRoute(route: Route): FrontendSurfaceId | undefined {
  if (route.identity.routeId === "home") return "route.home"
  if (route.identity.routeId === "directory") return "route.directory"
  if (route.identity.routeId === "session-admission") return "route.session-admission"
  if (route.identity.routeId === "new-session") return "route.new-session"
  if (route.identity.routeId === "legacy-session" || route.identity.routeId === "session") return "route.session"
  if (route.identity.routeId === "settings") return "overlay.settings"
  if (route.identity.routeId === "dialog") return "overlay.dialog"
  if (route.identity.routeId === "recovery") return "inline.surface-recovery"
  return undefined
}
