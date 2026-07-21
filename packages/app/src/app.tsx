import "@/index.css"
import * as Sentry from "@sentry/solid"
import { base64Encode } from "@opencode-ai/core/util/encode"
import { I18nProvider } from "@opencode-ai/ui/context"
import { DialogProvider, type DialogHost } from "@opencode-ai/ui/context/dialog"
import { FileComponentProvider } from "@opencode-ai/ui/context/file"
import { MarkedProvider } from "@opencode-ai/ui/context/marked"
import { File } from "@opencode-ai/ui/file"
import { Font } from "@opencode-ai/ui/font"
import { Splash } from "@opencode-ai/ui/logo"
import { ThemeProvider } from "@opencode-ai/ui/theme/context"
import { MetaProvider } from "@solidjs/meta"
import { type BaseRouterProps, Navigate, Route, Router, useParams, useSearchParams } from "@solidjs/router"
import { QueryClient, QueryClientProvider } from "@tanstack/solid-query"
import type {
  PermissionV2DecisionCommand,
  PermissionV2DecisionReceipt,
  PermissionV2Request,
} from "@opencode-ai/sdk/v2/client"
import { Effect } from "effect"
import {
  type Component,
  createEffect,
  createMemo,
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
import { CommandProvider } from "@/context/command"
import { CommentsProvider } from "@/context/comments"
import { FileProvider } from "@/context/file"
import { ServerSDKProvider } from "@/context/server-sdk"
import { ServerSyncProvider } from "@/context/server-sync"
import { GlobalProvider } from "@/context/global"
import { HighlightsProvider } from "@/context/highlights"
import { LanguageProvider, type Locale, useLanguage } from "@/context/language"
import { LayoutProvider } from "@/context/layout"
import { ModelsProvider } from "@/context/models"
import { NotificationProvider } from "@/context/notification"
import { PermissionProvider } from "@/context/permission"
import { PromptProvider } from "@/context/prompt"
import { ServerConnection, ServerProvider, serverName, useServer } from "@/context/server"
import { SettingsProvider, useSettings } from "@/context/settings"
import { TerminalProvider } from "@/context/terminal"
import { TabsProvider, useTabs, type DraftTab } from "@/context/tabs"
import { SDKProvider, useSDK } from "@/context/sdk"
import { useSync } from "@/context/sync"
import { WslServersProvider } from "@/wsl/context"
import DirectoryLayout, { DirectoryDataProvider } from "@/pages/directory-layout"
import Layout from "@/pages/layout"
import { ErrorPage } from "./pages/error"
import { useCheckServerHealth } from "./utils/server-health"

const HomeRoute = lazy(() => import("@/pages/home"))
const Session = lazy(() => import("@/pages/session"))
const NewSession = lazy(() => import("@/pages/new-session"))

// Alpha typed surface seam (ADR-027 / REQ-084). A surface is a narrow leaf-page
// override: the host may replace the innermost page component while every existing
// provider wrapper (SelectedServerLayout / DraftServerLayout / DirectoryDataProvider /
// SessionProviders / DraftProviders) keeps its default lifecycle. Surfaces are read
// once when AppInterface mounts; swapping them afterwards requires a reload — the
// provider tree must never hot-swap within one renderer lifetime.
export type MaybePreloadableComponent = Component & { preload?: () => void }

// The newSession leaf owns the draft page UI but not the draft lifecycle: the wrapper
// keeps tab/draft semantics (target server, tab swap, persisted-draft cleanup) and
// hands the leaf this narrow, context-free contract.
export interface DraftSurfaceProps {
  draftId: string
  promoteDraft: (session: { directory: string; sessionId: string }) => void
}

export type DraftSurfaceComponent = Component<DraftSurfaceProps> & { preload?: () => void }

export interface PermissionSurfaceClient {
  list: () => Promise<PermissionV2Request[]>
  reply: (requestID: string, command: PermissionV2DecisionCommand) => Promise<PermissionV2DecisionReceipt>
  subscribe: (listeners: {
    asked: (request: PermissionV2Request) => void
    replied: (receipt: PermissionV2DecisionReceipt) => void
  }) => () => void
}

export interface PermissionSurfaceProps {
  sessionID: string
  projectID?: string
  client: PermissionSurfaceClient
}

export type PermissionSurfaceComponent = Component<PermissionSurfaceProps>

export interface AppSurfaces {
  home?: MaybePreloadableComponent
  newSession?: DraftSurfaceComponent
  session?: MaybePreloadableComponent
  permission?: PermissionSurfaceComponent
}

function createSessionRoute(Leaf: MaybePreloadableComponent, PermissionSurface?: PermissionSurfaceComponent) {
  return Object.assign(
    () => {
      const settings = useSettings()
      const params = useParams()
      const [search] = useSearchParams<{ draftId?: string; prompt?: string }>()
      const sdk = useSDK()
      const sync = useSync()
      const server = useServer()
      const tabs = useTabs()
      const permissionClient: PermissionSurfaceClient = {
        list: () =>
          sdk()
            .client.v2.session.permission.list({ sessionID: params.id! })
            .then((result) => {
              if (!result.data) throw new Error("Permission list response is missing data")
              return result.data.data
            }),
        reply: (requestID, command) =>
          sdk()
            .client.v2.session.permission.reply({
              sessionID: params.id!,
              requestID,
              permissionV2DecisionCommand: command,
            })
            .then((result) => {
              if (!result.data) throw new Error("Permission reply response is missing DecisionReceipt")
              return result.data.data
            }),
        subscribe: (listeners) => {
          const stopAsked = sdk().event.on("permission.v2.asked", (event) => {
            if (event.properties.sessionID !== params.id) return
            listeners.asked(event.properties)
          })
          const stopReplied = sdk().event.on("permission.v2.replied", (event) => {
            if (event.properties.sessionID !== params.id) return
            listeners.replied(event.properties)
          })
          return () => {
            stopAsked()
            stopReplied()
          }
        },
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
        <SessionProviders>
          <Leaf />
          <Show when={PermissionSurface && params.id} keyed>
            {(sessionID) => (
              <Dynamic
                component={PermissionSurface}
                sessionID={sessionID}
                projectID={sync().project?.id}
                client={permissionClient}
              />
            )}
          </Show>
        </SessionProviders>
      )
    },
    // Preload only the effective leaf: the default and an injected surface must never
    // be preloaded together.
    { preload: () => Leaf.preload?.() },
  )
}

// Wraps the non-draft routes. They are gated on (and keyed to) the globally selected
// server via ServerKey, then provide the server-scoped shell (Permission/Layout/
// Notification/Models + the visual Layout) for that server.
function SelectedServerLayout(props: ParentProps) {
  return (
    <ServerKey>
      <ServerSDKProvider>
        <ServerSyncProvider>
          <ServerScopedShell>{props.children}</ServerScopedShell>
        </ServerSyncProvider>
      </ServerSDKProvider>
    </ServerKey>
  )
}

// Wraps /new-session. It resolves the draft's target server and provides the
// server-scoped shell for that server — without ServerKey, so the page never depends
// on the globally "selected" server.
function DraftServerLayout(props: ParentProps) {
  const server = useServer()
  const tabs = useTabs()
  const [search] = useSearchParams<{ draftId?: string }>()
  const conn = createMemo(() => {
    const id = search.draftId
    if (!id) return undefined
    const draft = tabs.store.find((tab): tab is DraftTab => tab.type === "draft" && tab.draftID === id)
    if (!draft) return undefined
    return server.list.find((c) => ServerConnection.key(c) === draft.server)
  })

  return (
    <ServerSDKProvider server={conn}>
      <ServerSyncProvider server={conn}>
        <ServerScopedShell>{props.children}</ServerScopedShell>
      </ServerSyncProvider>
    </ServerSDKProvider>
  )
}

function createDraftRoute(Leaf: DraftSurfaceComponent) {
  function ResolvedDraftRoute(props: { draftID: string }) {
    const tabs = useTabs()
    const draft = createMemo(() =>
      tabs.store.find((tab): tab is DraftTab => tab.type === "draft" && tab.draftID === props.draftID),
    )

    // Key on the directory so retargeting the draft's project re-instantiates the
    // directory-scoped providers while keeping the same draft id. The draft's target
    // server is provided by DraftServerLayout, so changing only the server updates the
    // SDK/sync hooks without remounting the composer.
    const directory = () => draft()?.directory

    const promoteDraft: DraftSurfaceProps["promoteDraft"] = (session) => {
      const current = draft()
      if (!current) return
      tabs.promoteDraft(props.draftID, {
        server: current.server,
        dirBase64: base64Encode(session.directory),
        sessionId: session.sessionId,
      })
    }

    return (
      <Show when={directory()} keyed>
        {(dir) => (
          <SDKProvider directory={dir}>
            <DirectoryDataProvider directory={dir} draftID={props.draftID}>
              <DraftProviders>
                <Leaf draftId={props.draftID} promoteDraft={promoteDraft} />
              </DraftProviders>
            </DirectoryDataProvider>
          </SDKProvider>
        )}
      </Show>
    )
  }

  return function DraftRoute() {
    const [search] = useSearchParams<{ draftId?: string }>()
    const tabs = useTabs()
    return (
      <Show when={tabs.ready()}>
        <Show when={search.draftId} keyed fallback={<Navigate href="/" />}>
          {(draftID) => <ResolvedDraftRoute draftID={draftID} />}
        </Show>
      </Show>
    )
  }
}

function UiI18nBridge(props: ParentProps) {
  const language = useLanguage()
  return <I18nProvider value={{ locale: language.intl, t: language.t }}>{props.children}</I18nProvider>
}

declare global {
  interface Window {
    __OPENCODE__?: {
      deepLinks?: string[]
    }
    api?: {
      setTitlebar?: (theme: { mode: "light" | "dark" }) => Promise<void>
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

  createEffect(() => {
    if (typeof document === "undefined") return

    const enabled = settings.general.newLayoutDesigns()
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
    <SettingsProvider>
      <BodyDesignClass />
      <CommandProvider>
        <HighlightsProvider>{props.children}</HighlightsProvider>
      </CommandProvider>
    </SettingsProvider>
  )
}

// Server-scoped providers plus the visual Layout (tabs/sidebar). These live inside
// each per-route server layout so they resolve to that route's server (selected vs
// draft). The Layout remounts when crossing between those groups.
function ServerScopedShell(props: ParentProps) {
  return (
    <PermissionProvider>
      <LayoutProvider>
        <NotificationProvider>
          <ModelsProvider>
            <Layout>{props.children}</Layout>
          </ModelsProvider>
        </NotificationProvider>
      </LayoutProvider>
    </PermissionProvider>
  )
}

function SessionProviders(props: ParentProps) {
  return (
    <TerminalProvider>
      <FileProvider>
        <PromptProvider>
          <CommentsProvider>{props.children}</CommentsProvider>
        </PromptProvider>
      </FileProvider>
    </TerminalProvider>
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
        onThemeApplied={(_, mode) => {
          void window.api?.setTitlebar?.({ mode })
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

function ConnectionGate(props: ParentProps<{ disableHealthCheck?: boolean }>) {
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

  return (
    <Show
      when={!checking()}
      fallback={
        <div class="h-dvh w-screen flex flex-col items-center justify-center bg-background-base">
          <Splash class="w-16 h-20 opacity-50 animate-pulse" />
        </div>
      }
    >
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
  surfaces?: AppSurfaces
}) {
  // Surfaces are resolved exactly once, before the route tree first mounts. Absent
  // overrides fall back to the upstream defaults with identical lazy/preload behavior.
  const HomeLeaf = props.surfaces?.home ?? HomeRoute
  const SessionRoute = createSessionRoute(props.surfaces?.session ?? Session, props.surfaces?.permission)
  // The upstream draft page reads its state from context and ignores the narrow
  // surface props, so it satisfies the contract without changes.
  const DraftRoute = createDraftRoute(props.surfaces?.newSession ?? (NewSession as unknown as DraftSurfaceComponent))
  // The shared shell holds only server-agnostic providers (QueryClient + Settings/
  // Command/Highlights) and stays mounted across every route. The server-scoped
  // providers and the visual Layout live in the per-route layouts below, so they
  // resolve to that route's server (selected for most routes, the draft's server for
  // /new-session). appChildren is server-agnostic, so it renders here once.
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
        <ConnectionGate disableHealthCheck={props.disableHealthCheck}>
          <Dynamic
            component={props.router ?? Router}
            root={(routerProps) => (
              <TabsProvider>
                <ServerShell>{routerProps.children}</ServerShell>
              </TabsProvider>
            )}
          >
            <Route component={SelectedServerLayout}>
              <Route path="/" component={HomeLeaf} />
              <Route path="/:dir" component={DirectoryLayout}>
                <Route path="/" component={() => <Navigate href="session" />} />
                <Route path="/session/:id?" component={SessionRoute} />
              </Route>
            </Route>
            <Route component={DraftServerLayout}>
              <Route path="/new-session" component={DraftRoute} />
            </Route>
          </Dynamic>
        </ConnectionGate>
      </GlobalProvider>
    </ServerProvider>
  )
}
