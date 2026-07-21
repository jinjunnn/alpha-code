// @refresh reload

import {
  ACCEPTED_FILE_EXTENSIONS,
  AppBaseProviders,
  AppInterface,
  type AppSurfaces,
  type DraftSurfaceProps,
  handleNotificationClick,
  loadLocaleDict,
  normalizeLocale,
  type Locale,
  type Platform,
  PlatformProvider,
  ServerConnection,
  useCommand,
  useWslServers,
} from "@opencode-ai/app"
import type { UpdaterState } from "@opencode-ai/app/updater"
import * as Sentry from "@sentry/solid"
import type { AsyncStorage } from "@solid-primitives/storage"
import { MemoryRouter } from "@solidjs/router"
import { createEffect, createMemo, createResource, createSignal, lazy, onCleanup, onMount, Show } from "solid-js"
import { render } from "solid-js/web"
import pkg from "../../package.json"
import { initI18n, t } from "./i18n"
import { initializationData, initializationReady } from "./initialization"
import { resetZoom, setPinchZoomEnabled, webviewZoom, zoomIn, zoomOut } from "./webview-zoom"
import { availableStartupServer, isEphemeralLocalServerUrl, readyWslConnections } from "./wsl/connections"
import "./styles.css"
import "./sidebar/sidebar.css"
import "./sidebar/account-popover.css"
import "./alpha-ui/timeline-reskin.css"
import "./alpha-ui/composer-reskin.css"
import { ToastViewport } from "./alpha-ui/Toast"
import { AlphaBoundary } from "./alpha-ui/alpha-boundary"
import { ComposerTakeover } from "./alpha-ui/composer-takeover"
import { TimelineInject } from "./alpha-ui/timeline-inject"
import { CloudRunWatcher } from "./alpha-ui/cloud-run-watcher"
import { ExtTrustWatcher } from "./alpha-ui/ext-trust-watcher"
import { AlphaSidebar } from "./sidebar/alpha-sidebar"
import { useAlphaProjects } from "./sidebar/use-projects"
import { AlphaHome } from "./alpha-ui/AlphaHome"
import { AlphaNewSession } from "./alpha-ui/alpha-new-session"
import { SurfaceBoundary } from "./alpha-ui/surface-boundary"
import { RuntimeRecoveryHost } from "./alpha-ui/RuntimeRecoveryHost"
import { UpstreamDialogHost } from "./alpha-ui/UpstreamDialogHost"
import type { ResolvedSurfaces } from "../shared/alpha-surfaces"
import { SessionSpikeHost } from "./alpha-ui/session-spike/session-spike-host" // REQ-087 spike 探针(默认恒 off,T7 清理)
import { alphaSessionWorkspaceSurface } from "./alpha-ui/session-workspace/alpha-session-workspace" // REQ-088 T2
import { AlphaOnboarding } from "./alpha-ui/AlphaOnboarding"
import { AlphaSettings } from "./alpha-ui/settings"
import { isSettingsAuthorityTarget, settingsAuthorityStorage } from "./alpha-ui/settings-authority-client"
import { setSettingsOpen, settingsOpen } from "./alpha-ui/settings-state"
import { ExtensionHub } from "./extensions/extension-hub"
import { extHubOpen, setExtHubOpen } from "./extensions/ext-hub-state"
import { AutomationPanel } from "./automations/automation-panel"
import { ArtifactWorkbench } from "./alpha-ui/artifact-workbench/artifact-workbench"
import { Splash } from "./logo-alpha"
import { useTheme } from "@opencode-ai/ui/theme/context"
import { ALPHA_THEME, ALPHA_THEME_ID } from "./theme-alpha"

const DevSurfaceMapInspector = import.meta.env.DEV ? lazy(() => import("./dev/surface-map-inspector")) : () => null

// First-run brand default: ship the orange Alpha theme. The theme context reads
// `opencode-theme-id` from localStorage before it mounts, so seeding it here (only
// when unset) makes Alpha the default without touching @opencode-ai/app. Once the
// user picks any theme, that key is owned by the picker and we never overwrite it.
try {
  if (!localStorage.getItem("opencode-theme-id")) {
    localStorage.setItem("opencode-theme-id", ALPHA_THEME_ID)
  }
} catch {}

const root = document.getElementById("root")
if (import.meta.env.DEV && !(root instanceof HTMLElement)) {
  throw new Error(t("error.dev.rootNotFound"))
}

if (import.meta.env.VITE_SENTRY_DSN) {
  Sentry.init({
    dsn: import.meta.env.VITE_SENTRY_DSN,
    environment: import.meta.env.VITE_SENTRY_ENVIRONMENT ?? import.meta.env.MODE,
    release: import.meta.env.VITE_SENTRY_RELEASE ?? `desktop@${pkg.version}`,
    initialScope: {
      tags: {
        platform: "desktop",
      },
    },
    integrations: (integrations) => {
      return integrations.filter(
        (i) =>
          i.name !== "Breadcrumbs" &&
          !(
            import.meta.env.OPENCODE_CHANNEL === "prod" &&
            (i.name === "GlobalHandlers" || i.name === "BrowserApiErrors")
          ),
      )
    },
  })
}

void initI18n()

const [updaterState, setUpdaterState] = createSignal<UpdaterState>({ status: "disabled" })
void window.api.updater.subscribe(setUpdaterState)

const deepLinkEvent = "opencode:deep-link"

const emitDeepLinks = (urls: string[]) => {
  if (urls.length === 0) return
  window.__OPENCODE__ ??= {}
  const pending = window.__OPENCODE__.deepLinks ?? []
  window.__OPENCODE__.deepLinks = [...pending, ...urls]
  window.dispatchEvent(new CustomEvent(deepLinkEvent, { detail: { urls } }))
}

const listenForDeepLinks = () => {
  void window.api.consumeInitialDeepLinks().then((urls) => emitDeepLinks(urls))
  return window.api.onDeepLink((urls) => emitDeepLinks(urls))
}

const createPlatform = (): Platform => {
  const os = (() => {
    const ua = navigator.userAgent
    if (ua.includes("Mac")) return "macos"
    if (ua.includes("Windows")) return "windows"
    if (ua.includes("Linux")) return "linux"
    return undefined
  })()

  const runDesktopMenuAction: Platform["runDesktopMenuAction"] = (action) => {
    switch (action) {
      case "view.resetZoom":
        resetZoom()
        return
      case "view.zoomIn":
        zoomIn()
        return
      case "view.zoomOut":
        zoomOut()
        return
    }

    return window.api.runDesktopMenuAction(action)
  }

  const storage = (() => {
    const cache = new Map<string, AsyncStorage>()

    const createStorage = (name: string) => {
      const settings = settingsAuthorityStorage()
      const api: AsyncStorage = {
        getItem: (key: string) =>
          isSettingsAuthorityTarget(name, key) ? settings.getItem(key) : window.api.storeGet(name, key),
        setItem: (key: string, value: string) =>
          isSettingsAuthorityTarget(name, key) ? settings.setItem(key, value) : window.api.storeSet(name, key, value),
        removeItem: (key: string) =>
          isSettingsAuthorityTarget(name, key) ? settings.removeItem(key) : window.api.storeDelete(name, key),
        clear: () => window.api.storeClear(name),
        key: async (index: number) => (await window.api.storeKeys(name))[index],
        getLength: () => window.api.storeLength(name),
        get length() {
          return api.getLength()
        },
      }
      return api
    }

    return (name = "default.dat") => {
      const cached = cache.get(name)
      if (cached) return cached
      const api = createStorage(name)
      cache.set(name, api)
      return api
    }
  })()

  const wslServersApi = os === "windows" ? window.api.wslServers : undefined

  return {
    platform: "desktop",
    os,
    version: pkg.version,

    async openDirectoryPickerDialog(opts) {
      return window.api.openDirectoryPicker({
        multiple: opts?.multiple ?? false,
        title: opts?.title ?? t("desktop.dialog.chooseFolder"),
      })
    },

    async openAttachmentPickerDialog(opts, onFile) {
      const result = await window.api.openFilePicker({
        multiple: opts?.multiple ?? false,
        title: opts?.title ?? t("desktop.dialog.chooseFile"),
        defaultPath: opts?.defaultPath,
        extensions: opts?.extensions ?? ACCEPTED_FILE_EXTENSIONS,
      })
      if (!result) return
      try {
        for (const file of result.files) {
          await onFile(new File([await window.api.readPickedFile(result.token, file.path)], file.name))
        }
      } finally {
        await window.api.releasePickedFiles(result.token)
      }
    },

    async saveFilePickerDialog(opts) {
      return window.api.saveFilePicker({
        title: opts?.title ?? t("desktop.dialog.saveFile"),
        defaultPath: opts?.defaultPath,
      })
    },

    openLink(url: string) {
      window.api.openLink(url)
    },
    async openPath(path: string, app?: string) {
      if (os === "windows") {
        const resolvedApp = app ? await window.api.resolveAppPath(app).catch(() => null) : null
        return window.api.openPath(path, resolvedApp ?? undefined)
      }
      return window.api.openPath(path, app)
    },

    back() {
      window.history.back()
    },

    openSettings() {
      setSettingsOpen(true)
    },

    forward() {
      window.history.forward()
    },

    storage,

    updater: {
      state: updaterState,
      check: () => window.api.updater.check(),
      install: () => window.api.updater.install(),
    },

    exportDebugLogs: () => window.api.exportDebugLogs(),

    recordFatalRendererError: (error) => window.api.recordFatalRendererError(error),

    restart: async () => {
      await window.api.killSidecar().catch(() => undefined)
      window.api.relaunch()
    },

    notify: async (title, description, href) => {
      const focused = await window.api.getWindowFocused().catch(() => document.hasFocus())
      if (focused) return

      const notification = new Notification(title, {
        body: description ?? "",
        icon: "https://opencode.ai/favicon-96x96-v3.png",
      })
      notification.onclick = () => {
        void window.api.showWindow()
        void window.api.setWindowFocus()
        handleNotificationClick(href)
        notification.close()
      }
    },

    fetch: (input, init) => {
      if (input instanceof Request) return fetch(input)
      return fetch(input, init)
    },

    getDefaultServer: async () => {
      const url = await window.api.getDefaultServerUrl().catch(() => null)
      if (!url) return null
      // REQ-040:持久化的默认若是「具体端口的本地 sidecar URL」(127.0.0.1/localhost/[::1]:PORT),
      // 它必然陈旧 —— 内嵌 sidecar 每次 listen(0) 随机新端口,存下的端口永远对不上,冷启动会连死端口卡
      // 「无法连接到 Local Server」。丢弃 → 回退符号性 "sidecar"(effectiveDefaultServer 取 null→"sidecar",
      // 始终指向当次 live sidecar)。REQ-042 后主治理在 main getDefaultServerUrl(留痕 main.log + 删键),
      // 此处为纵深兜底(理论不可达)—— 兜到仍留声,不静默。
      if (isEphemeralLocalServerUrl(url)) {
        console.warn(`[alpha] stale local default server url reached renderer (${url}); falling back to sidecar`)
        return null
      }
      return ServerConnection.Key.make(url)
    },

    setDefaultServer: async (url: string | null) => {
      await window.api.setDefaultServerUrl(url)
    },

    wslServers: wslServersApi,

    getDisplayBackend: async () => {
      return window.api.getDisplayBackend().catch(() => null)
    },

    setDisplayBackend: async (backend) => {
      await window.api.setDisplayBackend(backend)
    },

    parseMarkdown: (markdown: string) => window.api.parseMarkdownCommand(markdown),

    webviewZoom,

    getPinchZoomEnabled: () => window.api.getPinchZoomEnabled(),

    setPinchZoomEnabled,

    runDesktopMenuAction,

    checkAppExists: async (appName: string) => {
      return window.api.checkAppExists(appName)
    },

    async readClipboardImage() {
      const image = await window.api.readClipboardImage().catch(() => null)
      if (!image) return null
      const blob = new Blob([image.buffer], { type: "image/png" })
      return new File([blob], `pasted-image-${Date.now()}.png`, {
        type: "image/png",
      })
    },
  }
}

let menuTrigger = null as null | ((id: string) => void)
window.api.onMenuCommand((id) => {
  menuTrigger?.(id)
})
listenForDeepLinks()

render(() => {
  const platform = createPlatform()
  const loadLocale = async () => {
    const current = await platform.storage?.("opencode.global.dat").getItem("language")
    const legacy = current ? undefined : await platform.storage?.().getItem("language.v1")
    const raw = current ?? legacy
    if (!raw) return
    const locale = raw.match(/"locale"\s*:\s*"([^"]+)"/)?.[1]
    if (!locale) return
    const next = normalizeLocale(locale)
    if (next !== "en") await loadLocaleDict(next)
    return next satisfies Locale
  }

  const [windowCount] = createResource(() => window.api.getWindowCount())

  // Fetch sidecar credentials (available immediately, before health check)
  const [sidecar] = createResource(() => window.api.awaitInitialization())

  const [defaultServer] = createResource(() => platform.getDefaultServer?.())
  const [locale] = createResource(loadLocale)

  function handleClick(e: MouseEvent) {
    const link = (e.target as HTMLElement).closest("a.external-link") as HTMLAnchorElement | null
    if (link?.href) {
      e.preventDefault()
      platform.openLink(link.href)
    }
  }

  function Inner() {
    const cmd = useCommand()
    menuTrigger = (id) => cmd.trigger(id)

    const theme = useTheme()
    // Make the brand theme known to the store + theme picker (named "Alpha").
    // The context's load() checks store.themes first, so registering here is
    // enough for both first-run apply and later re-selection from the picker.
    theme.registerTheme(ALPHA_THEME)

    createEffect(() => {
      theme.themeId()
      theme.mode()
      const bg = getComputedStyle(document.documentElement).getPropertyValue("--background-base").trim()
      if (bg) {
        void window.api.setBackgroundColor(bg)
      }
    })

    return null
  }

  function App() {
    const wslServers = useWslServers()
    const splash = (
      <div class="h-dvh w-screen flex flex-col items-center justify-center bg-background-base">
        <Splash class="w-16 h-20 opacity-50 animate-pulse" />
        {/* B20:等待期原本零文案(最坏 ~60s 纯 logo);给一句状态,弱网/慢启动不再像死机 */}
        <div class="mt-4 text-xs opacity-50">正在启动引擎…</div>
      </div>
    )

    // ADR-027/REQ-084:surface 选择在可信 main 配置进入 renderer 后、route tree 首次挂载前
    // 一次性完成;解析失败 fail-safe 到全 legacy(升级面故障不能挡住产品)。
    const [resolvedSurfaces] = createResource<ResolvedSurfaces | null>(() =>
      window.api.surfaces.resolve().catch((err): null => {
        console.error("[alpha-surface] resolve failed — falling back to legacy surfaces", err)
        return null
      }),
    )

    const ready = createMemo(
      () =>
        !defaultServer.loading &&
        !sidecar.loading &&
        !windowCount.loading &&
        !locale.loading &&
        !resolvedSurfaces.loading,
    )
    const servers = createMemo(() => {
      const data = initializationData(sidecar)
      const list: ServerConnection.Any[] = []
      if (data) {
        list.push({
          displayName: "Local Server",
          type: "sidecar",
          variant: "base",
          http: {
            url: data.url,
            username: data.username ?? undefined,
            password: data.password ?? undefined,
          },
        })
      }
      list.push(...readyWslConnections(wslServers.data))
      return list
    })
    // Connection info for the alpha sidebar's own SDK client (local sidecar server).
    const sidebarServer = createMemo(() => {
      const data = initializationData(sidecar)
      if (!data) return undefined
      return { baseUrl: data.url, username: data.username ?? undefined, password: data.password ?? undefined }
    })
    const effectiveDefaultServer = createMemo(() =>
      ServerConnection.Key.make(availableStartupServer(defaultServer.latest, wslServers.data)),
    )

    // A3: one shared projects store for the whole alpha shell — sidebar + home consume the same
    // instance instead of each running its own (was ×2 project.list / ×2N session.list + an extra SSE).
    const alphaProjects = useAlphaProjects(sidebarServer)

    // REQ-085/086:alpha 模式的叶页面经 typed surface seam 注入(单一 page root,upstream 叶
    // 不挂载);legacy 模式不注入 = 严格 upstream 默认页面。surface 组件经 SurfaceBoundary 兜
    // 致命 render 错误(main 建立稳定 incident + Alpha Recovery；禁止回退 legacy)。
    const surfaceComponents = createMemo<AppSurfaces | undefined>(() => {
      const resolved = resolvedSurfaces.latest
      if (!resolved) return undefined
      const surfaces: AppSurfaces = {}
      if (resolved.home.mode === "alpha")
        surfaces.home = () => (
          <SurfaceBoundary surface="home">
            <AlphaHome projects={alphaProjects} />
          </SurfaceBoundary>
        )
      if (resolved.newSession.mode === "alpha")
        surfaces.newSession = (p: DraftSurfaceProps) => (
          <SurfaceBoundary surface="newSession">
            <AlphaNewSession projects={alphaProjects} draftId={p.draftId} promoteDraft={p.promoteDraft} />
          </SurfaceBoundary>
        )
      // REQ-088 T2:session 叶经 AlphaSessionWorkspace 正式外框注入(SurfaceBoundary + 窄导出叶)。
      // 发布态本期仍 legacy(T5 才升级);双闸(ALPHA_SURFACE_SESSION=alpha env-override +
      // localStorage ALPHA_SESSION_SPIKE)未全开时返回 undefined = 上游默认叶,零变化。
      if (resolved.session.mode === "alpha") surfaces.session = alphaSessionWorkspaceSurface()
      return surfaces
    })

    return (
      <Show when={ready()} fallback={splash}>
        <Show when={effectiveDefaultServer()} keyed>
          {(key) => (
            <AppInterface defaultServer={key} servers={servers()} router={MemoryRouter} surfaces={surfaceComponents()}>
              {/* C28(S17 T4)崩溃边界下沉:上游 ErrorBoundary 在 AppBaseProviders 内包住全部 children,
                  alpha 任一注入件 throw 会整屏坠成上游 ErrorPage —— 逐个紧裹 AlphaBoundary(更内层先命中)
                  = 崩溃只降级该区域;TimelineInject(B22 疑源)自此有降落伞。探针 window.__alphaCrashProbe */}
              <AlphaBoundary name="Inner">
                <Inner />
              </AlphaBoundary>
              <AlphaBoundary name="AlphaSidebar">
                <AlphaSidebar projects={alphaProjects} />
              </AlphaBoundary>
              {/* REQ-085:AlphaHome 不再作为 children Portal 注入 —— 它是正式 `home` surface
                  (见上方 surfaceComponents);legacy 模式下 upstream Home 原样呈现。 */}
              <AlphaBoundary name="AlphaOnboarding">
                <AlphaOnboarding />
              </AlphaBoundary>
              <AlphaBoundary name="AlphaSettings">
                <AlphaSettings open={settingsOpen()} onClose={() => setSettingsOpen(false)} />
              </AlphaBoundary>
              <AlphaBoundary name="ExtensionHub">
                <ExtensionHub server={sidebarServer} open={extHubOpen} onClose={() => setExtHubOpen(false)} />
              </AlphaBoundary>
              <AlphaBoundary name="AutomationPanel">
                <AutomationPanel />
              </AlphaBoundary>
              {/* REQ-094(#186):Artifact Workbench —— run 发现 + 产物卡片 + renderer registry 预览 */}
              <AlphaBoundary name="ArtifactWorkbench">
                <ArtifactWorkbench projects={alphaProjects} />
              </AlphaBoundary>
              {/* REQ-055:会话页 composer = AlphaComposer(与首页同一组件);上游 composer 隐藏。
                  旧 ComposerInject/SessionSlashInject(chips 移植 + slash 菜单接管)随之退役。 */}
              <AlphaBoundary name="ComposerTakeover">
                <ComposerTakeover projects={alphaProjects} />
              </AlphaBoundary>
              <AlphaBoundary name="TimelineInject">
                <TimelineInject />
              </AlphaBoundary>
              <AlphaBoundary name="CloudRunWatcher">
                <CloudRunWatcher server={sidebarServer} projects={alphaProjects} />
              </AlphaBoundary>
              {/* REQ-060 信任门:进入项目会话时检测项目自带可执行扩展 → per-project consent → dispose 生效 */}
              <AlphaBoundary name="ExtTrustWatcher">
                <ExtTrustWatcher server={sidebarServer} />
              </AlphaBoundary>
              <AlphaBoundary name="ToastViewport">
                <ToastViewport />
              </AlphaBoundary>
              <RuntimeRecoveryHost />
              <DevSurfaceMapInspector resolved={resolvedSurfaces.latest} />
              {/* REQ-087 spike 容器侧探针:flag off ⇒ 恒 null(session-spike/spike-flag.ts) */}
              <AlphaBoundary name="SessionSpikeHost">
                <SessionSpikeHost />
              </AlphaBoundary>
            </AppInterface>
          )}
        </Show>
      </Show>
    )
  }

  onMount(() => {
    document.addEventListener("click", handleClick)
    onCleanup(() => {
      document.removeEventListener("click", handleClick)
    })
  })

  return (
    <PlatformProvider value={platform}>
      <AppBaseProviders locale={locale.latest} dialogHost={UpstreamDialogHost}>
        <Show when={true}>{(_) => <App />}</Show>
      </AppBaseProviders>
    </PlatformProvider>
  )
}, root!)
