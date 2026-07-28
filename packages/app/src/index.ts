export {
  AppBaseProviders,
  AppInterface,
  type AppSurfaces,
  type DraftSurfaceComponent,
  type DraftSurfaceProps,
  type MaybePreloadableComponent,
  type PermissionSurfaceClient,
  type PermissionSurfaceComponent,
  type PermissionSurfaceProps,
} from "./app"
// #668:v1+v2 双通道审批读面。alpha 的 composer 停靠区(ui-mac)与独立 Permission surface
// 共用同一份适配与同一份 fail-closed 语义 —— 两个消费面不得各写一份。
export {
  adaptPermissionV1Receipt,
  adaptPermissionV1Request,
  createPermissionChannelSource,
  isPermissionV1Fingerprint,
  permissionV1Fingerprint,
  resolvePermissionV1Agent,
  type PermissionAgentSource,
  type PermissionChannelListeners,
  type PermissionChannelSource,
} from "./context/permission-v1-adapter"
export { useLayout } from "./context/layout"
export { useServerSDK } from "./context/server-sdk"
export { useServerSync } from "./context/server-sync"
export { useServer } from "./context/server"
export { useSettings } from "./context/settings"
export { useTabs } from "./context/tabs"
export { useProviders } from "./hooks/use-providers"
export { ACCEPTED_FILE_EXTENSIONS, ACCEPTED_FILE_TYPES, filePickerFilters } from "./constants/file-picker"
export { useCommand } from "./context/command"
export {
  type Settings,
  type SettingsAuthorityCoordinator,
  type SettingsAuthoritySnapshot,
} from "./context/settings"
export { loadLocaleDict, normalizeLocale, type Locale } from "./context/language"
export { useWslServers } from "./wsl/context"
export { type DisplayBackend, type FatalRendererErrorLog, type Platform, PlatformProvider } from "./context/platform"
export { type UpdaterPlatform, type UpdaterState } from "./updater"
export {
  type WslDistroProbe,
  type WslInstalledDistro,
  type WslJob,
  type WslOnlineDistro,
  type WslOpencodeCheck,
  type WslRuntimeCheck,
  type WslServerConfig,
  type WslServerItem,
  type WslServerRuntime,
  type WslServersEvent,
  type WslServersPlatform,
  type WslServersState,
} from "./wsl/types"
export { ServerConnection } from "./context/server"
export { handleNotificationClick } from "./utils/notification-click"
