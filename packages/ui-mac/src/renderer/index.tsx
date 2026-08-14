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
import "./alpha-ui/composer-reskin.css"
import { ToastViewport } from "./alpha-ui/Toast"
import { installHomeDraftDiscardNotice } from "./alpha-ui/home-draft-discard-notice"
import { ContractFailureBanner } from "./alpha-ui/Banner"
import { AlphaBoundary } from "./alpha-ui/alpha-boundary"
import { ContractHealthProvider } from "./alpha-ui/providers"
import { PermissionWatcher } from "./alpha-ui/permission-watcher"
import { CloudRunWatcher } from "./alpha-ui/cloud-run-watcher"
import { ExtTrustWatcher } from "./alpha-ui/ext-trust-watcher"
import { AlphaSidebar } from "./sidebar/alpha-sidebar"
import { type AlphaProjectsApi, useAlphaProjects } from "./sidebar/use-projects"
import { AlphaHome } from "./alpha-ui/AlphaHome"
import { AlphaNewSession } from "./alpha-ui/alpha-new-session"
import { AlphaSessionSearch } from "./alpha-ui/alpha-session-search"
import { SurfaceBoundary } from "./alpha-ui/surface-boundary"
import { RuntimeRecoveryHost } from "./alpha-ui/RuntimeRecoveryHost"
import { UpstreamDialogHost } from "./alpha-ui/UpstreamDialogHost"
import { type DeepLinkBatch, type DeepLinkDelivery } from "../shared/route-manifest"
import { createDeepLinkPublisher } from "./deep-link-bridge"
import { alphaSessionWorkspaceSurface } from "./alpha-ui/session-workspace/alpha-session-workspace" // REQ-088 T2
import { AlphaOnboarding } from "./alpha-ui/AlphaOnboarding"
import { AlphaSettings } from "./alpha-ui/settings"
import { settingsAuthorityCoordinator } from "./alpha-ui/settings-authority-client"
import { setSettingsOpen, settingsOpen } from "./alpha-ui/settings-state"
import { ExtensionHub } from "./extensions/extension-hub"
import { extHubOpen, setExtHubOpen } from "./extensions/ext-hub-state"
import { AutomationPanel } from "./automations/automation-panel"
import { Splash } from "./logo-alpha"
import { useTheme } from "@opencode-ai/ui/theme/context"
import { ALPHA_THEME, ALPHA_THEME_ID } from "./theme-alpha"
import { composeRoutes } from "./route-composition"
import { markStartupTimeline } from "./startup-timeline"

// Every route composes exactly one Alpha surface. There is no second release state and no
// runtime switch: a fatal render goes to Alpha Recovery (SurfaceBoundary), never to an
// upstream leaf.
const productionRoutes = composeRoutes({
  // #891:两个「新会话入口」叶都要 `serverKey` —— 它们经 `projects.startChat` 建会话,新会话的
  // canonical 身份因此落在**那个 store 连着的 server** 上,composer 拿它给开局档位/只读档登记。
  // 值由 App() 的 `projectsServerKey` 反查(见那里),不在叶里自己猜。
  home: (projects: AlphaProjectsApi, serverKey: () => string | undefined) => () => (
    <SurfaceBoundary surface="home">
      <AlphaHome projects={projects} serverKey={serverKey} />
    </SurfaceBoundary>
  ),
  newSession:
    (projects: AlphaProjectsApi, serverKey: () => string | undefined) => (props: DraftSurfaceProps) => (
      <SurfaceBoundary surface="newSession">
        <AlphaNewSession
          projects={projects}
          serverKey={serverKey}
          draftId={props.draftId}
          promoteDraft={props.promoteDraft}
        />
      </SurfaceBoundary>
    ),
  session: (projects: AlphaProjectsApi) => alphaSessionWorkspaceSurface(projects),
  settings: () => (
    <AlphaBoundary name="AlphaSettings">
      <AlphaSettings open={settingsOpen()} onClose={() => setSettingsOpen(false)} />
    </AlphaBoundary>
  ),
  dialog: UpstreamDialogHost,
  recovery: RuntimeRecoveryHost,
})

const SettingsSurface = productionRoutes.settings.mount
const RecoverySurface = productionRoutes.recovery.mount

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

// Deliveries arrive already decoded by the manifest (main). They go into the window buffer, which
// is the queue; the event only wakes the layout up. See deep-link-bridge.ts for why the event
// carries no payload — that is what makes double consumption impossible.
const deepLinkBuffer = window as Window & { __alphaDeepLinks?: DeepLinkDelivery[] }

const publishDeepLinks = createDeepLinkPublisher(deepLinkBuffer)

// Acknowledge only AFTER the buffer holds the deliveries: until this returns to main, main keeps
// its copy and re-queues it if this renderer reloads or crashes, so nothing is lost in transit.
//
// KNOWN GAP (#633, Major): the buffer holding them is not the layout having consumed them. On a
// cold start the layout may not have mounted yet, and a reload in that window drops the buffer
// after main has already been told the batch landed. Closing it means acknowledging from the
// layout's drain instead — a new cross-package line back through `packages/app`, which is why it
// is its own issue rather than part of this one.
const acceptDeepLinks = (batch: DeepLinkBatch) => {
  publishDeepLinks(batch)
  void window.api.acknowledgeDeepLinks(batch.id)
}

const listenForDeepLinks = () => {
  void window.api.consumeInitialDeepLinks().then((batches) => batches.forEach(acceptDeepLinks))
  return window.api.onDeepLink(acceptDeepLinks)
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
      const api: AsyncStorage = {
        getItem: (key: string) => window.api.storeGet(name, key),
        setItem: (key: string, value: string) => window.api.storeSet(name, key, value),
        removeItem: (key: string) => window.api.storeDelete(name, key),
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
    settings: settingsAuthorityCoordinator,

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
        <div class="mt-4 text-xs opacity-50">{t("alpha.engine.starting")}</div>
      </div>
    )

    const ready = createMemo(
      () => !defaultServer.loading && !sidecar.loading && !windowCount.loading && !locale.loading,
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

    // #927:上面这个 key 翻转(默认服务器 = WSL 且迟到就绪)时,下方按 key 重挂的 Show 会
    // 合法重建整棵树,首页 composer 正在打的草稿随之丢弃 —— owner 裁决保持丢弃语义,但不再
    // 静默。这里是唯一跨重挂看得见 key 翻转的位置;弹与不弹的判据在 home-draft-discard-notice.ts。
    installHomeDraftDiscardNotice(effectiveDefaultServer)

    // A3: one shared projects store for the whole alpha shell — sidebar + home consume the same
    // instance instead of each running its own (was ×2 project.list / ×2N session.list + an extra SSE).
    const alphaProjects = useAlphaProjects(sidebarServer)

    // `alphaProjects` 这份 store 连着的那个 server 的 `ServerConnection.key`。**唯一**的反查口:
    // 由 store 自己的 `baseUrl` 找回连接再算 key,而不是读"当前 active server"。
    //
    // REQ-126 CODE-F(#659,第一个消费者):会话搜索结果的 href。搜索只读这一份 store,当前
    // server 是 WSL/remote 时,拿 active server 拼 href 会把本地 sidecar 的结果导向错误的服务器
    // (legacy `sessionHref` 正是这么坏的)。
    //
    // #891(第二个消费者):首页 / 新对话页的 composer。这两个叶经 `alphaProjects.startChat` 建
    // 会话 —— 会话**就落在这个 baseUrl 上**,它的 canonical 身份三元组第一段因此是这个 key,不是
    // active server。composer 用它给新会话登记开局档位/只读档;记到 active server 下面,会话页
    // 按真实身份 adopt 时就永远认领不到那条登记(用户在首页开的只读档静默丢失)。
    const projectsServerKey = createMemo(() => {
      const baseUrl = sidebarServer()?.baseUrl
      if (!baseUrl) return undefined
      const connection = servers().find((candidate) => candidate.http.url === baseUrl)
      return connection ? ServerConnection.key(connection) : undefined
    })

    // 每个叶页面经 typed surface seam 注入(单一 page root,upstream 叶不挂载)。surface 组件
    // 经 SurfaceBoundary 兜致命 render 错误(main 建立稳定 incident + Alpha Recovery)。
    const surfaceComponents = createMemo<AppSurfaces>(() => ({
      permission: (props) => (
        <AlphaBoundary name="PermissionWatcher">
          <PermissionWatcher {...props} />
        </AlphaBoundary>
      ),
      [productionRoutes.home.surface]: productionRoutes.home.mount(alphaProjects, projectsServerKey),
      [productionRoutes["new-session"].surface]: productionRoutes["new-session"].mount(
        alphaProjects,
        projectsServerKey,
      ),
      [productionRoutes.session.surface]: productionRoutes.session.mount(alphaProjects),
    }))

    return (
      <Show when={ready()} fallback={splash}>
        <Show when={effectiveDefaultServer()} keyed>
          {(key) => (
            <AppInterface defaultServer={key} servers={servers()} router={MemoryRouter} surfaces={surfaceComponents()}>
              {/* C28(S17 T4)崩溃边界下沉:上游 ErrorBoundary 在 AppBaseProviders 内包住全部 children,
                  alpha 任一注入件 throw 会整屏坠成上游 ErrorPage —— 逐个紧裹 AlphaBoundary(更内层先命中)
                  = 崩溃只降级该区域。探针 window.__alphaCrashProbe */}
              <AlphaBoundary name="Inner">
                <Inner />
              </AlphaBoundary>
              <AlphaBoundary name="AlphaSidebar">
                {/* #925(第三个消费者):侧栏的会话 href / 新会话导航 / draft 的 server 段。
                    侧栏列的与建的会话全在这份 store 的 server 上,身份只能是这个 key。 */}
                <AlphaSidebar projects={alphaProjects} serverKey={projectsServerKey} />
              </AlphaBoundary>
              {/* REQ-085:AlphaHome 不再作为 children Portal 注入 —— 它是正式 `home` surface
                  (见上方 surfaceComponents);legacy 模式下 upstream Home 原样呈现。 */}
              <AlphaBoundary name="AlphaOnboarding">
                <AlphaOnboarding />
              </AlphaBoundary>
              {/* REQ-126 CODE-F(#659):`command.palette` 的**唯一**注册点。挂在壳上而不是叶上 ——
                  上游三处注册全在已被 alpha 顶替的叶里,注册随叶一起蒸发,侧栏「搜索」才成了静默
                  no-op。放在这里,它与路由无关地常驻,侧栏按钮与 mod+k 都落到它。 */}
              <AlphaBoundary name="AlphaSessionSearch">
                <AlphaSessionSearch projects={alphaProjects} serverKey={projectsServerKey} />
              </AlphaBoundary>
              <SettingsSurface />
              <AlphaBoundary name="ExtensionHub">
                <ExtensionHub server={sidebarServer} open={extHubOpen} onClose={() => setExtHubOpen(false)} />
              </AlphaBoundary>
              <AlphaBoundary name="AutomationPanel">
                {/* #925(第四个消费者):「回跳会话」。自动化 run 的会话由主进程建在内嵌
                    sidecar 上,renderer 侧那台机器的身份就是这个 key。 */}
                <AutomationPanel serverKey={projectsServerKey} />
              </AlphaBoundary>
              {/* REQ-126 AC3(#654):产物工作台不再全页挂载 —— 产物只经会话右栏 artifacts 面板到达。 */}
              {/* REQ-125 C7/C8:会话页 composer = AlphaComposer 经 seam 会话页直挂(session surface
                  内部,零 Portal/零选择器),时间线为 session surface 内自持 typed leaf —— 旧的
                  composer/时间线 DOM 接管注入件已全部删除。 */}
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
              <AlphaBoundary name="ContractFailureBanner">
                <ContractFailureBanner />
              </AlphaBoundary>
              <RecoverySurface />
              <DevSurfaceMapInspector />
            </AppInterface>
          )}
        </Show>
      </Show>
    )
  }

  onMount(() => {
    markStartupTimeline("renderer.root.mount")
    document.addEventListener("click", handleClick)
    onCleanup(() => {
      document.removeEventListener("click", handleClick)
    })
  })

  return (
    <PlatformProvider value={platform}>
      <ContractHealthProvider>
        <AppBaseProviders locale={locale.latest} dialogHost={productionRoutes.dialog.mount}>
          <Show when={true}>{(_) => <App />}</Show>
        </AppBaseProviders>
      </ContractHealthProvider>
    </PlatformProvider>
  )
}, root!)
