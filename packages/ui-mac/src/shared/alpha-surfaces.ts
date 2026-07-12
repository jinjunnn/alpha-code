// REQ-084:启动期 surface 选择的共享契约。三个路由叶(home / newSession / session)各带一个发布
// 态(alpha / legacy / auto-fallback);main 在 renderer 挂载路由树之前解析出每个 surface 的生效
// 模式(alpha | legacy),renderer 经 IPC(window.api.surfaces.resolve)读一次。解析结果只在
// 加载时生效 —— 运行中绝不热切换,改动(env / pin / 崩溃记录)一律下次 reload 才体现。
// Pure constants only — NO electron/node imports — so both the main and renderer bundles can
// import this module(镜像 shared/alpha-config.ts 的跨 bundle 模式)。

export type SurfaceId = "home" | "newSession" | "session"
export type SurfaceMode = "alpha" | "legacy"
export type SurfaceReleaseState = "alpha" | "legacy" | "auto-fallback"

/** 单个 surface 的解析结果:生效模式 + 命中哪一层(env > pin > 发布默认;crash-fallback =
 *  auto-fallback 态命中了本版本的致命渲染错误记录)。 */
export interface ResolvedSurface {
  mode: SurfaceMode
  reason: "release-default" | "env-override" | "pin" | "crash-fallback"
}
export type ResolvedSurfaces = Record<SurfaceId, ResolvedSurface>

/** 发布默认态 —— 改一个 surface 的出厂状态改这里(env/pin 只做部署期覆盖)。 */
export const SURFACE_RELEASE_STATES: Record<SurfaceId, SurfaceReleaseState> = {
  home: "auto-fallback", // REQ-085 ships Alpha home with crash fallback
  newSession: "auto-fallback", // REQ-086
  session: "legacy", // REQ-088 not yet delivered
}

export const SURFACE_ABI_VERSION = 1
