import "@/index.css"
import * as Sentry from "@sentry/solid"
import { base64Encode } from "@opencode-ai/core/util/encode"
import { I18nProvider } from "@opencode-ai/ui/context"
import { DialogProvider, type DialogHost } from "@opencode-ai/ui/context/dialog"
import { FileComponentProvider } from "@opencode-ai/ui/context/file"
import { MarkedProvider } from "@opencode-ai/ui/context/marked"
import { File } from "@opencode-ai/session-ui/file"
import { Font } from "@opencode-ai/ui/font"
import { Splash } from "@opencode-ai/ui/logo"
import { ThemeProvider } from "@opencode-ai/ui/theme/context"
import { MetaProvider } from "@solidjs/meta"
import {
  type BaseRouterProps,
  Navigate,
  Route,
  Router,
  useLocation,
  useNavigate,
  useParams,
  useSearchParams,
} from "@solidjs/router"
import { QueryClient, QueryClientProvider } from "@tanstack/solid-query"
import { Effect } from "effect"
import {
  type Component,
  createEffect,
  createMemo,
  createRenderEffect,
  createResource,
  createSignal,
  ErrorBoundary,
  For,
  type JSX,
  lazy,
  onCleanup,
  type ParentProps,
  Show,
} from "solid-js"
import { Dynamic } from "solid-js/web"
import { makeEventListener } from "@solid-primitives/event-listener"
import { CommandProvider, useCommand, type CommandOption } from "@/context/command"
import { CommentsProvider } from "@/context/comments"
import { FileProvider } from "@/context/file"
import { ServerSDKProvider } from "@/context/server-sdk"
import { ServerSyncProvider, useServerSync } from "@/context/server-sync"
import { GlobalProvider, useGlobal } from "@/context/global"
import { HighlightsProvider } from "@/context/highlights"
import { LanguageProvider, type Locale, useLanguage } from "@/context/language"
import { LayoutProvider } from "@/context/layout"
import { ModelsProvider } from "@/context/models"
import { NotificationProvider } from "@/context/notification"
import { PermissionProvider } from "@/context/permission"
import { usePlatform } from "@/context/platform"
import { PromptProvider } from "@/context/prompt"
import { ServerConnection, ServerProvider, serverName, useServer } from "@/context/server"
import { SettingsProvider, useSettings } from "@/context/settings"
import { TabsProvider, useTabs, type DraftTab } from "@/context/tabs"
import { SDKProvider, useSDK } from "@/context/sdk"
import { DraftRouteGate } from "@/pages/draft-route-gate"
import {
  createPermissionSurfaceMount,
  type PermissionSurfaceComponent,
} from "@/context/permission-surface"
import { WslServersProvider } from "@/wsl/context"
import DirectoryLayout, { DirectoryDataProvider } from "@/pages/directory-layout"
import LegacyLayout from "@/pages/layout"
import NewLayout from "@/pages/layout-new"
import { ErrorPage } from "./pages/error"
import { useCheckServerHealth } from "./utils/server-health"
import { legacySessionHref, legacySessionServer, requireServerKey, sessionHref } from "./utils/session-route"
import { createSessionLineage } from "@/pages/session/session-lineage"

import { SessionProviders, SessionRouteErrorBoundary, TargetSessionRouteContent } from "@/pages/session"
import { NewHome, LegacyHome } from "@/pages/home"

const Session = lazy(() => import("@/pages/session"))
const NewSession = lazy(() => import("@/pages/new-session"))

// Alpha typed surface seam (ADR-027 / REQ-084). A surface is a narrow leaf-page
// override: the host may replace the innermost page component while every existing
// provider wrapper (LegacyServerLayout / target-server providers / DirectoryDataProvider /
// SessionProviders / DraftProviders) keeps its default lifecycle. Surfaces are read
// once when AppInterface mounts; swapping them afterwards requires a reload — the
// provider tree must never hot-swap within one renderer lifetime.
export type MaybePreloadableComponent = Component & {
  preload?: () => void
  // REQ-125 (#574): a session surface may statically declare that it renders the session
  // page's only top bar (including the window drag region). NewLayout then skips the
  // upstream Titlebar on session routes. Absent marker = upstream Titlebar unchanged.
  ownsTitlebar?: boolean
}

// The newSession leaf owns the draft page UI but not the draft lifecycle: the wrapper
// keeps tab/draft semantics (target server, tab swap, persisted-draft cleanup) and
// hands the leaf this narrow, context-free contract.
export interface DraftSurfaceProps {
  draftId: string
  promoteDraft: (session: { directory: string; sessionId: string }) => void
}

export type DraftSurfaceComponent = Component<DraftSurfaceProps> & { preload?: () => void }

// #668:审批呈现面的接线(list/subscribe 两条通道合并、reply 按指纹路由)已抽到
// `@/context/permission-surface` —— 那份才是闸门真正挂载的生产代码。此处只做再导出与装配。
export type {
  PermissionSurfaceClient,
  PermissionSurfaceProps,
  PermissionSurfaceComponent,
} from "@/context/permission-surface"

export interface AppSurfaces {
  home?: MaybePreloadableComponent
  newSession?: DraftSurfaceComponent
  session?: MaybePreloadableComponent
  permission?: PermissionSurfaceComponent
}

function createSessionRoute(Leaf: MaybePreloadableComponent, PermissionSurface?: PermissionSurfaceComponent) {
  const PermissionSurfaceMount = createPermissionSurfaceMount(PermissionSurface)
  return Object.assign(
    () => {
      const settings = useSettings()
      const params = useParams()
      const [search] = useSearchParams<{ draftId?: string; prompt?: string }>()
      const sdk = useSDK()
      const server = useServer()
      const tabs = useTabs()

      if (params.id && settings.general.newLayoutDesigns()) {
        const sessionID = params.id
        return (
          <Show when={tabs.ready()}>
            {(_) => {
              const persisted = tabs.store.filter((item) => item.type === "session")
              // #933:反推必然正确才放行(唯一 tab 线索 / 全世界只有一台 server),其余回家,
              // 不再按 active server 猜(猜错 = 打开别人机器上的同 id 无关会话并污染它,#894)。
              const owner = legacySessionServer(persisted, sessionID, server.key, server.list.map(ServerConnection.key))
              return <Navigate href={owner ? sessionHref(owner, sessionID) : "/"} />
            }}
          </Show>
        )
      }

      // When the new layout is enabled, the legacy new-session route (/:dir/session with no id)
      // is replaced by a draft at /new-session?draftId=…
      createEffect(() => {
        if (!settings.general.newLayoutDesigns()) return
        if (params.id || search.draftId) return
        if (!tabs.ready() || !sdk().directory) return
        tabs.newDraft({ server: server.key, directory: sdk().directory }, search.prompt)
      })

      return (
        <SessionRouteErrorBoundary sessionID={params.id}>
          <SessionProviders>
            <Leaf />
            <PermissionSurfaceMount />
          </SessionProviders>
        </SessionRouteErrorBoundary>
      )
    },
    // Preload only the effective leaf: the default and an injected surface must never
    // be preloaded together.
    {
      preload: () => Leaf.preload?.(),
      leaf: Leaf,
      permissionSurface: PermissionSurface,
    },
  )
}

function HomeRoute() {
  const settings = useSettings()
  return (
    <Show when={settings.general.newLayoutDesigns()} fallback={<LegacyHome />}>
      <NewHome />
    </Show>
  )
}

function TargetServerRoute(props: ParentProps) {
  const params = useParams<{ serverKey: string; id: string }>()
  const global = useGlobal()
  const conn = createMemo(() => {
    const key = requireServerKey(params.serverKey)
    return global.servers.list().find((item) => ServerConnection.key(item) === key)
  })

  return (
    // Owns the server-identity remount. Session changes must NOT remount this
    // subtree (SessionRouteErrorBoundary resets and createSessionLineage
    // re-resolves reactively instead); both rely on this key for server changes.
    <Show when={requireServerKey(params.serverKey)} keyed>
      <ServerSDKProvider server={conn}>
        <ServerSyncProvider server={conn}>{props.children}</ServerSyncProvider>
      </ServerSDKProvider>
    </Show>
  )
}

function createTargetSessionRoute(Leaf: MaybePreloadableComponent, PermissionSurface?: PermissionSurfaceComponent) {
  const PermissionSurfaceMount = createPermissionSurfaceMount(PermissionSurface)
  const Content = () => (
    <>
      <Leaf />
      <PermissionSurfaceMount />
    </>
  )
  return () => (
    <TargetServerRoute>
      <TargetSessionRouteContent content={Content} />
    </TargetServerRoute>
  )
}

function LegacyTargetSessionRoute() {
  const params = useParams<{ serverKey: string; id: string }>()
  return (
    <TargetServerRoute>
      <SessionRouteErrorBoundary sessionID={params.id} serverKey={requireServerKey(params.serverKey)}>
        <LegacyTargetSessionRedirect />
      </SessionRouteErrorBoundary>
    </TargetServerRoute>
  )
}

function LegacyTargetSessionRedirect() {
  const params = useParams<{ id: string }>()
  const navigate = useNavigate()
  const sync = useServerSync()
  const current = createSessionLineage(
    () => params.id,
    () => sync().session.lineage,
  )

  createEffect(() => {
    const directory = current()?.session.directory
    if (!directory) return
    navigate(legacySessionHref(directory, params.id), { replace: true })
  })

  return null
}

// Wraps the non-draft routes. They are gated on (and keyed to) the globally selected
// server via ServerKey, then provide the server-scoped shell for that server.
function SelectedServerProviders(props: ParentProps) {
  return (
    <ServerKey>
      <ServerSDKProvider>
        <ServerSyncProvider>{props.children}</ServerSyncProvider>
      </ServerSDKProvider>
    </ServerKey>
  )
}

function LegacyServerLayout(props: ParentProps<{ serverScoped?: JSX.Element }>) {
  return (
    <SelectedServerProviders>
      <LegacyServerScopedShell serverScoped={props.serverScoped}>{props.children}</LegacyServerScopedShell>
    </SelectedServerProviders>
  )
}

function createDraftRoute(Leaf: DraftSurfaceComponent) {
  function ResolvedDraftRoute(props: { draftID: string; draft: DraftTab }) {
    const tabs = useTabs()
    const global = useGlobal()
    const conn = createMemo(() =>
      global.servers.list().find((item) => ServerConnection.key(item) === props.draft.server),
    )
    const directory = () => props.draft.directory
    const serverKey = () => props.draft.server

    const promoteDraft: DraftSurfaceProps["promoteDraft"] = (session) => {
      tabs.promoteDraft(props.draftID, {
        server: props.draft.server,
        sessionId: session.sessionId,
      })
    }

    return (
      <Show when={`${props.draft.server}\0${props.draft.directory}`} keyed>
        <ServerSDKProvider server={conn}>
          <ServerSyncProvider server={conn}>
            <ModelsProvider directory={directory}>
              <SDKProvider directory={directory}>
                <DirectoryDataProvider directory={directory} server={serverKey}>
                  <DraftProviders>
                    <Leaf draftId={props.draftID} promoteDraft={promoteDraft} />
                  </DraftProviders>
                </DirectoryDataProvider>
              </SDKProvider>
            </ModelsProvider>
          </ServerSyncProvider>
        </ServerSDKProvider>
      </Show>
    )
  }

  return function DraftRoute() {
    const [search] = useSearchParams<{ draftId?: string }>()
    const settings = useSettings()
    const tabs = useTabs()
    const language = useLanguage()
    const navigate = useNavigate()
    // alpha-code #903:两个非 happy-path 不再是「空白页」与「静默弹回首页」。守卫本体在
    // `@/pages/draft-route-gate`(零上下文依赖,故可被真组件闸门挂载);这里只注入文案与
    // 恢复动作。摘掉那两个 fallback ⇒ ui-mac 的 draft-route-gate.cases.ts 当场红。
    return (
      <DraftRouteGate
        ready={tabs.ready()}
        draft={tabs.store.find((tab): tab is DraftTab => tab.type === "draft" && tab.draftID === search.draftId)}
        t={language.t}
        onRecover={() => navigate("/")}
      >
        {(draft) => (
          <Show
            when={settings.general.newLayoutDesigns()}
            fallback={<Navigate href={`/${base64Encode(draft.directory)}/session`} />}
          >
            <ResolvedDraftRoute draftID={draft.draftID} draft={draft} />
          </Show>
        )}
      </DraftRouteGate>
    )
  }
}

function UiI18nBridge(props: ParentProps) {
  const language = useLanguage()
  return <I18nProvider value={{ locale: language.intl, t: language.t }}>{props.children}</I18nProvider>
}

declare global {
  interface Window {
    api?: {
      setTitlebar?: (theme: { mode: "light" | "dark"; scheme?: "system" | "light" | "dark" }) => Promise<void>
      exportDebugLogs?: () => Promise<string>
    }
  }
}

function QueryProvider(props: ParentProps) {
  const client = new QueryClient({
    defaultOptions: {
      queries: {
        refetchOnReconnect: false,
        refetchOnMount: false,
        refetchOnWindowFocus: false,
      },
    },
  })
  return <QueryClientProvider client={client}>{props.children}</QueryClientProvider>
}

function BodyDesignClass() {
  const settings = useSettings()

  createRenderEffect(() => {
    if (typeof document === "undefined") return

    const enabled = settings.general.newLayoutDesigns()
    document.body.toggleAttribute("data-new-layout", enabled)
    document.body.classList.toggle("text-12-regular", !enabled)
    document.body.classList.toggle("font-(family-name:--font-family-text)", enabled)
    document.body.classList.toggle("text-[13px]", enabled)
    document.body.classList.toggle("font-[440]", enabled)
  })

  return null
}

// Server-agnostic providers shared across every route. These live in the shared
// shell (router root) so they stay mounted regardless of the active server/route.
function SharedProviders(props: ParentProps) {
  return (
    <>
      <BodyDesignClass />
      <CommandProvider>
        <DesktopCommands />
        <HighlightsProvider>{props.children}</HighlightsProvider>
      </CommandProvider>
    </>
  )
}

function DesktopCommands() {
  const command = useCommand()
  const language = useLanguage()
  const platform = usePlatform()

  command.register("desktop", () => {
    const commands: CommandOption[] = []
    if (platform.platform === "desktop" && platform.exportDebugLogs) {
      commands.push({
        id: "logs.export",
        title: "Export logs",
        category: language.t("command.category.settings"),
        onSelect: () => {
          void platform.exportDebugLogs?.()
        },
      })
    }
    return commands
  })

  return null
}

// Server-scoped providers shared by the legacy shell and the top-level new shell.
type ServerScopedShellProps = ParentProps<{
  directory?: () => string | undefined
  serverScoped?: JSX.Element
}>

function ServerScopedProviders(props: ServerScopedShellProps) {
  return (
    <LayoutProvider>
      {props.serverScoped}
      <ModelsProvider directory={props.directory}>{props.children}</ModelsProvider>
    </LayoutProvider>
  )
}

function LegacyServerScopedShell(props: ServerScopedShellProps) {
  return (
    <ServerScopedProviders directory={props.directory} serverScoped={props.serverScoped}>
      <LegacyLayout>{props.children}</LegacyLayout>
    </ServerScopedProviders>
  )
}

function NewAppLayout(props: ParentProps<{ serverScoped?: JSX.Element; sessionOwnsTitlebar?: boolean }>) {
  return (
    <SelectedServerProviders>
      <ServerScopedProviders serverScoped={props.serverScoped}>
        <NewLayout sessionOwnsTitlebar={props.sessionOwnsTitlebar}>{props.children}</NewLayout>
      </ServerScopedProviders>
    </SelectedServerProviders>
  )
}

// The draft page only renders the prompt composer, so it drops TerminalProvider.
// FileProvider and CommentsProvider stay because PromptInput uses file search and comment context.
function DraftProviders(props: ParentProps) {
  return (
    <FileProvider>
      <PromptProvider>
        <CommentsProvider>{props.children}</CommentsProvider>
      </PromptProvider>
    </FileProvider>
  )
}

export function AppBaseProviders(props: ParentProps<{ locale?: Locale; dialogHost?: DialogHost }>) {
  return (
    <MetaProvider>
      <Font />
      <ThemeProvider
        onThemeApplied={(_, mode, scheme) => {
          void window.api?.setTitlebar?.({ mode, scheme })
        }}
      >
        <LanguageProvider locale={props.locale}>
          <UiI18nBridge>
            <ErrorBoundary
              fallback={(error) => {
                Sentry.captureException(error)
                return <ErrorPage error={error} />
              }}
            >
              <QueryProvider>
                <WslServersProvider>
                  <DialogProvider host={props.dialogHost}>
                    <MarkedProvider>
                      <FileComponentProvider component={File}>{props.children}</FileComponentProvider>
                    </MarkedProvider>
                  </DialogProvider>
                </WslServersProvider>
              </QueryProvider>
            </ErrorBoundary>
          </UiI18nBridge>
        </LanguageProvider>
      </ThemeProvider>
    </MetaProvider>
  )
}

function ConnectionGate(props: ParentProps<{ disableHealthCheck?: boolean; startup?: Promise<void> }>) {
  const server = useServer()
  const checkServerHealth = useCheckServerHealth()

  const [checkMode, setCheckMode] = createSignal<"blocking" | "background">("blocking")

  // performs repeated health check with a grace period for
  // non-http connections, otherwise fails instantly
  const [startupHealthCheck, healthCheckActions] = createResource(() =>
    props.disableHealthCheck
      ? true
      : Effect.gen(function* () {
          if (!server.current) return true
          const { http, type } = server.current

          while (true) {
            const res = yield* Effect.promise(() => checkServerHealth(http))
            if (res.healthy) return true
            if (checkMode() === "background" || type === "http") return false
          }
        }).pipe(
          Effect.timeoutOrElse({ duration: "10 seconds", orElse: () => Effect.succeed(false) }),
          Effect.ensuring(Effect.sync(() => setCheckMode("background"))),
          Effect.runPromise,
        ),
  )
  const checking = createMemo(
    () => checkMode() === "blocking" && ["unresolved", "pending"].includes(startupHealthCheck.state),
  )
  const [startup] = createResource(async () => {
    if (!props.startup) return true
    await props.startup.catch((error) => {
      console.error("[startup] startup gate failed", error)
    })
    return true
  })
  const startupChecking = createMemo(
    () => startupHealthCheck.latest === true && ["unresolved", "pending"].includes(startup.state),
  )
  const loading = createMemo(() => checking() || startupChecking())

  return (
    <>
      <Show when={!checking()}>
        <Show
          when={startupHealthCheck.latest}
          fallback={
            <ConnectionError
              onRetry={() => {
                if (checkMode() === "background") void healthCheckActions.refetch()
              }}
              onServerSelected={(key) => {
                setCheckMode("blocking")
                server.setActive(key)
                void healthCheckActions.refetch()
              }}
            />
          }
        >
          {props.children}
        </Show>
      </Show>
      <Show when={loading()}>
        <div class="fixed inset-0 z-[9999] flex flex-col items-center justify-center bg-background-base">
          <Splash class="w-16 h-20 opacity-50 animate-pulse" />
        </div>
      </Show>
    </>
  )
}

function ConnectionError(props: { onRetry?: () => void; onServerSelected?: (key: ServerConnection.Key) => void }) {
  const language = useLanguage()
  const server = useServer()
  const others = () => server.list.filter((s) => ServerConnection.key(s) !== server.key)
  const name = createMemo(() => server.name || server.key)
  const serverToken = "\u0000server\u0000"
  const unreachable = createMemo(() => language.t("app.server.unreachable", { server: serverToken }).split(serverToken))

  const timer = setInterval(() => props.onRetry?.(), 1000)
  onCleanup(() => clearInterval(timer))

  return (
    <div class="h-dvh w-screen flex flex-col items-center justify-center bg-background-base gap-6 p-6">
      <div class="flex flex-col items-center max-w-md text-center">
        <Splash class="w-12 h-15 mb-4" />
        <p class="text-14-regular text-text-base">
          {unreachable()[0]}
          <span class="text-text-strong font-medium">{name()}</span>
          {unreachable()[1]}
        </p>
        <p class="mt-1 text-12-regular text-text-weak">{language.t("app.server.retrying")}</p>
      </div>
      <Show when={others().length > 0}>
        <div class="flex flex-col gap-2 w-full max-w-sm">
          <span class="text-12-regular text-text-base text-center">{language.t("app.server.otherServers")}</span>
          <div class="flex flex-col gap-1 bg-surface-base rounded-lg p-2">
            <For each={others()}>
              {(conn) => {
                const key = ServerConnection.key(conn)
                return (
                  <button
                    type="button"
                    class="flex items-center gap-3 w-full px-3 py-2 rounded-md hover:bg-surface-raised-base-hover transition-colors text-left"
                    onClick={() => props.onServerSelected?.(key)}
                  >
                    <span class="text-14-regular text-text-strong truncate">{serverName(conn)}</span>
                  </button>
                )
              }}
            </For>
          </div>
        </div>
      </Show>
    </div>
  )
}

function ServerKey(props: ParentProps) {
  const server = useServer()
  return (
    <Show when={server.key} keyed>
      {props.children}
    </Show>
  )
}

export function AppInterface(props: {
  children?: JSX.Element
  defaultServer: ServerConnection.Key
  canonicalLocalServer?: ServerConnection.Key
  servers?: Array<ServerConnection.Any>
  router?: Component<BaseRouterProps>
  disableHealthCheck?: boolean
  startup?: Promise<void>
  serverScoped?: JSX.Element
  surfaces?: AppSurfaces
}) {
  // Surfaces are resolved exactly once, before the route tree first mounts. Absent
  // overrides fall back to the upstream defaults with identical lazy/preload behavior.
  const HomeLeaf = props.surfaces?.home ?? HomeRoute
  const SessionRoute = createSessionRoute(props.surfaces?.session ?? Session, props.surfaces?.permission)
  const TargetSessionRoute = createTargetSessionRoute(SessionRoute.leaf, SessionRoute.permissionSurface)
  // The upstream draft page reads its state from context and ignores the narrow
  // surface props, so it satisfies the contract without changes.
  const DraftRoute = createDraftRoute(props.surfaces?.newSession ?? (NewSession as unknown as DraftSurfaceComponent))
  // REQ-125 (#574): resolved once with the surfaces — when the injected session leaf owns its
  // top bar, the shared NewLayout drops the upstream Titlebar on session routes (single header).
  const sessionOwnsTitlebar = props.surfaces?.session?.ownsTitlebar === true
  // The visual new layout lives in the router root so it remains mounted across
  // route changes. Draft and session routes override only their server-bound data
  // providers beneath it.
  const ServerShell = (shellProps: ParentProps) => (
    <QueryProvider>
      <SharedProviders>
        {props.children}
        {shellProps.children}
      </SharedProviders>
    </QueryProvider>
  )

  return (
    <ServerProvider
      defaultServer={props.defaultServer}
      canonicalLocalServer={props.canonicalLocalServer}
      servers={props.servers}
    >
      <GlobalProvider>
        <SettingsProvider>
          <ConnectionGate disableHealthCheck={props.disableHealthCheck} startup={props.startup}>
            <Show when={useSettings().general.newLayoutDesigns().toString()} keyed>
              <Dynamic
                component={props.router ?? Router}
                root={(routerProps) => (
                  <TabsProvider>
                    <PermissionProvider>
                      <NotificationProvider>
                        <ServerShell>
                          <Show when={useSettings().general.newLayoutDesigns()} fallback={routerProps.children}>
                            <NewAppLayout serverScoped={props.serverScoped} sessionOwnsTitlebar={sessionOwnsTitlebar}>
                              {routerProps.children}
                            </NewAppLayout>
                          </Show>
                        </ServerShell>
                      </NotificationProvider>
                    </PermissionProvider>
                  </TabsProvider>
                )}
              >
                <Routes
                  serverScoped={props.serverScoped}
                  home={HomeLeaf}
                  session={SessionRoute}
                  targetSession={TargetSessionRoute}
                  draft={DraftRoute}
                />
              </Dynamic>
            </Show>
          </ConnectionGate>
        </SettingsProvider>
      </GlobalProvider>
    </ServerProvider>
  )
}

function Routes(props: {
  serverScoped?: JSX.Element
  home: MaybePreloadableComponent
  session: MaybePreloadableComponent
  targetSession: Component
  draft: Component
}) {
  const settings = useSettings()
  const HomeLeaf = props.home
  const SessionRoute = props.session
  const TargetSessionRoute = props.targetSession
  const DraftRoute = props.draft

  return (
    <>
      <Route
        component={(routeProps) => (
          <LegacyServerLayout serverScoped={props.serverScoped}>{routeProps.children}</LegacyServerLayout>
        )}
      >
        <Show when={!settings.general.newLayoutDesigns()}>
          {
            <>
              <Route path="/" component={HomeLeaf} />
              <Route path="/server/:serverKey/session/:id" component={LegacyTargetSessionRoute} />
            </>
          }
        </Show>
        <Route path="/:dir" component={DirectoryLayout}>
          <Route path="/" component={() => <Navigate href="session" />} />
          <Route path="/session/:id?" component={SessionRoute} />
        </Route>
      </Route>
      <Show when={settings.general.newLayoutDesigns()}>
        <Route path="/" component={HomeLeaf} />
        <Route path="/:dir/session/:id" component={NewLayoutLegacySessionRedirect} />
        <Route path="/server/:serverKey/session/:id" component={TargetSessionRoute} />
      </Show>
      <Route path="/new-session" component={DraftRoute} />
    </>
  )
}

function NewLayoutLegacySessionRedirect() {
  const server = useServer()
  const tabs = useTabs()
  const params = useParams<{ id: string }>()

  return (
    <Show when={tabs.ready()}>
      {(_) => {
        // #933:与 SessionRoute 里那条同一语义 —— 反推必然正确才放行(唯一 tab / 单机),
        // 其余回家,不猜 active。
        const owner = legacySessionServer(
          tabs.store.filter((item) => item.type === "session"),
          params.id,
          server.key,
          server.list.map(ServerConnection.key),
        )
        return <Navigate href={owner ? sessionHref(owner, params.id) : "/"} />
      }}
    </Show>
  )
}
