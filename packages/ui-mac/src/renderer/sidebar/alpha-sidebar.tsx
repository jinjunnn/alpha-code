// The alpha Codex-style left sidebar. Rendered (via Portal) from inside AppInterface's child
// tree, so it has the router (useNavigate/useLocation) and opencode's command context, while
// its data comes from the SDK (see use-projects.ts). It replaces opencode's own chrome: the
// V2 titlebar tab-strip is hidden and the main content is shifted right by CSS in sidebar.css,
// keyed off body[data-alpha-sidebar]. Single flat column: brand → nav → projects(→sessions),
// the Codex information architecture.

import { createEffect, createMemo, createSignal, For, onCleanup, Show } from "solid-js"
import { Portal } from "solid-js/web"
import { useLocation, useNavigate } from "@solidjs/router"
import { useCommand } from "../alpha-ui/providers"
import { ProjectAvatar, type ProjectAvatarVariant } from "@opencode-ai/ui/v2/project-avatar-v2"
import { Icon } from "@opencode-ai/ui/v2/icon"
import { useTheme } from "@opencode-ai/ui/theme/context"
import { t } from "../i18n"
import { pushToast } from "../alpha-ui/Toast"
import { Banner } from "../alpha-ui/Banner"
import { Mark } from "../logo-alpha"
import { ALPHA_PATHS } from "../../shared/alpha-config"
import { useAlphaEndpoints } from "../use-alpha-endpoints"
import { homeHref, newSessionHref, projectLabel, sessionHref } from "./route"
import { parseRoute } from "../../shared/legacy-route-abi"
import {
  clearHiddenProjects,
  hiddenProjects,
  hideProject,
  isProjectExpanded,
  isProjectHidden,
  isSessionUnread,
  markSessionViewed,
  setProjectExpanded,
  setSidebarAutoCollapsed,
  sidebarCollapsed,
  toggleProjectExpanded,
  toggleSidebar,
} from "./sidebar-state"
import { type AlphaProject, type AlphaSession, type AlphaProjectsApi } from "./use-projects"
import type { AuthState, AccountSummary } from "../../preload/types"
import { extHubOpen, setExtHubOpen, toggleExtHub } from "../extensions/ext-hub-state"
import { setAutomationOpen, toggleAutomation } from "../automations/automation-state"
import { setWorkbenchOpen, toggleWorkbench, workbenchBadge } from "../alpha-ui/artifact-workbench/workbench-state"

// Replicate opencode's getProjectAvatarVariant (context/layout.tsx) for projects that already
// have a server-assigned color; otherwise pick a stable variant from the worktree so the
// avatars are colourful and consistent across launches (opencode assigns randomly + persists;
// we never render beside its avatars, so a deterministic fallback is fine).
const FALLBACK_VARIANTS: ProjectAvatarVariant[] = ["orange", "yellow", "cyan", "green", "red", "pink", "blue", "purple"]

function variantForColor(color: string): ProjectAvatarVariant {
  switch (color) {
    case "orange":
      return "orange"
    case "pink":
      return "pink"
    case "cyan":
      return "cyan"
    case "purple":
      return "purple"
    case "mint":
      return "cyan"
    case "lime":
      return "green"
    default:
      return "gray"
  }
}

function hashVariant(worktree: string): ProjectAvatarVariant {
  let h = 0
  for (let i = 0; i < worktree.length; i++) h = (Math.imul(h, 31) + worktree.charCodeAt(i)) >>> 0
  return FALLBACK_VARIANTS[h % FALLBACK_VARIANTS.length]
}

function projectVariant(project: AlphaProject): ProjectAvatarVariant {
  return project.color ? variantForColor(project.color) : hashVariant(project.worktree)
}

// opencode folds standalone (non-git) directories into a single sentinel "global" project whose
// worktree is "/" and whose name is empty — give it a readable label instead of a blank row.
function projectDisplayName(project: AlphaProject): string {
  if (project.name) return project.name
  if (project.worktree === "/") return t("alpha.sidebar.globalProject")
  return project.worktree
}

// Eagerly-created sessions carry a "New session - <ISO>" title until the first message retitles
// them; show a friendly placeholder. "Untitled" is our own empty-title fallback (see toSession).
// Robust clipboard write. The async Clipboard API needs transient user activation (and can be
// blocked); fall back to a hidden-textarea execCommand, which works in the Electron renderer even
// when the activation heuristic is unhappy. Returns whether the copy landed.
async function copyText(text: string): Promise<boolean> {
  // Prefer the Electron main-process clipboard — it needs no transient user activation, so it
  // succeeds reliably (including under automated clicks). Renderer APIs are the fallback.
  try {
    const ok = await (window as unknown as { api?: { writeClipboard?: (t: string) => Promise<boolean> } }).api?.writeClipboard?.(text)
    if (ok) return true
  } catch {
    /* fall through to the renderer clipboard paths */
  }
  try {
    await navigator.clipboard.writeText(text)
    return true
  } catch {
    try {
      const ta = document.createElement("textarea")
      ta.value = text
      ta.style.position = "fixed"
      ta.style.top = "-1000px"
      ta.style.opacity = "0"
      document.body.appendChild(ta)
      ta.focus()
      ta.select()
      const ok = document.execCommand("copy")
      ta.remove()
      return ok
    } catch {
      return false
    }
  }
}

function sessionDisplayTitle(title: string): string {
  if (title === "Untitled" || /^New session - /.test(title)) return t("alpha.sidebar.newChat")
  return title
}

export function AlphaSidebar(props: { projects: AlphaProjectsApi }) {
  const { store, reload, createSession, renameSession, shareSession, deleteSession, copySession } = props.projects
  const navigate = useNavigate()
  const location = useLocation()
  const command = useCommand()

  // Platform auth state, pushed from main (alpha-auth.ts). The footer button reflects it: signed
  // out → start the browser OAuth flow; signed in → show the account and sign out. web is the
  // session authority, so this is just a thin view of main's state (see platform-integration.md §C).
  const [authState, setAuthState] = createSignal<AuthState>({ status: "logged-out", mode: "byok" })
  onCleanup(window.api.auth.subscribe(setAuthState))
  const accountLabel = () => authState().account?.email ?? t("alpha.auth.account")

  // B11 复扫行16:登录链失败(main 只 warn 日志 → 用户「点了没反应」)→ error toast,按 code 给原因。
  onCleanup(
    window.api.auth.onError((e) => {
      const detail = {
        provider_error: t("alpha.auth.errProvider"),
        invalid_callback: t("alpha.auth.errCallback"),
        state_mismatch: t("alpha.auth.errState"),
        exchange_failed: t("alpha.auth.errExchange"),
      }[e.code]
      pushToast({ kind: "error", title: t("alpha.auth.failed"), detail })
    }),
  )

  // B11 复扫行11:sidecar 连崩自愈停手(main 只留日志 → 引擎死了 UI 却毫无表示)。持久 banner
  // (Banner=持久态,侧栏常驻位)+ 即时 toast(侧栏收起时也看得见);重试清 banner,再停手会再推。
  const [engineDown, setEngineDown] = createSignal(false)
  onCleanup(
    window.api.onSidecarFatal(() => {
      setEngineDown(true)
      pushToast({ kind: "error", title: t("alpha.engine.down"), detail: t("alpha.engine.downDetail") })
    }),
  )
  const retryEngine = () => {
    setEngineDown(false)
    void window.api.retrySidecar()
  }

  // 自动化 badge(REQ-021 A1.4):上次运行失败/超时的任务数。跟 automation-event 推送刷新。
  const [automationFailedCount, setAutomationFailedCount] = createSignal(0)
  const refreshAutomationBadge = () => {
    void window.api.automations
      .list()
      .then((r) => setAutomationFailedCount(r.tasks.filter((x) => x.lastRun?.status === "failed" || x.lastRun?.status === "timeout").length))
      .catch(() => {})
  }
  refreshAutomationBadge()
  onCleanup(window.api.automations.onEvent(() => refreshAutomationBadge()))

  // Account popover (single footer entry → upward popover). Theme toggle is native; the rest open
  // opencode's real settings / updater / browser-OAuth. Balance + quotas have no backend yet
  // (alpha-platform) — shown as "待接入" placeholders, see ADR-016 / cloud topology.
  const theme = useTheme()
  const [menuOpen, setMenuOpen] = createSignal(false)
  const plan = () => authState().account?.plan ?? ""
  const isPro = () => /pro|plus|team|max|paid/i.test(plan())
  const acctInitial = () => (authState().account?.email ?? "A").trim().charAt(0).toUpperCase() || "A"
  const SCHEMES = [
    { k: "light", l: "浅色" },
    { k: "dark", l: "深色" },
    { k: "system", l: "系统" },
  ] as const
  // 钱包购买页(/wallet)按页签深链:充值 → 钱包充值页签;升级会员/管理订阅 → 会员月卡页签。
  const endpoints = useAlphaEndpoints()
  const rechargeUrl = () => `${endpoints().web}${ALPHA_PATHS.wallet}?tab=recharge`
  const subscribeUrl = () => `${endpoints().web}${ALPHA_PATHS.wallet}?tab=subscription`

  // Account summary (balance / membership / token usage) from alpha-platform B, fetched on login.
  // Contract: alpha-platform docs/contracts/account-billing.md. usageSeries powers the 14-day
  // sparkline. 401 → main's auth is stale; the footer already reflects logged-out on the next push.
  const [summary, setSummary] = createSignal<AccountSummary | null>(null)
  const [summaryState, setSummaryState] = createSignal<"idle" | "loading" | "error">("idle")
  createEffect(() => {
    if (authState().status !== "logged-in") {
      setSummary(null)
      setSummaryState("idle")
      return
    }
    setSummaryState("loading")
    window.api.account
      .summary()
      .then((r) => {
        if (r && "error" in r) {
          setSummary(null)
          setSummaryState("error")
        } else {
          setSummary(r as AccountSummary)
          setSummaryState("idle")
        }
      })
      .catch(() => setSummaryState("error"))
  })
  const activePlan = () => {
    const s = summary()
    return s && s.plan.status === "active" ? s.plan : null
  }
  const fmtTokens = (n: number) =>
    n >= 1e6 ? `${(n / 1e6).toFixed(1)}M` : n >= 1e3 ? `${(n / 1e3).toFixed(1)}K` : `${n}`
  const fmtYuan = (fen: number) => `¥${(fen / 100).toFixed(2)}`
  const pendingText = () => (summaryState() === "error" ? "—" : "…")
  // Membership display prefers the fetched summary (authoritative); falls back to the JWT's coarse
  // plan claim before the summary lands, so the header chip / footer never contradict the card.
  const acctIsPro = () => !!activePlan() || isPro()
  const acctPlanName = () => activePlan()?.name ?? plan()

  // Tiny inline sparkline for the 14-day usage series (no chart lib). Empty series → caller shows
  // a placeholder instead of rendering this.
  const Sparkline = (p: { data: number[] }) => {
    const w = 116
    const h = 24
    const max = Math.max(1, ...p.data)
    const n = p.data.length
    const pts = p.data.map((v, i) => `${(i / Math.max(1, n - 1)) * w},${(h - 2 - (v / max) * (h - 4) + 2).toFixed(1)}`).join(" ")
    return (
      <svg width={w} height={h} viewBox={`0 0 ${w} ${h}`} preserveAspectRatio="none" aria-hidden="true">
        <polyline points={pts} fill="none" stroke="currentColor" stroke-width="1.4" stroke-linejoin="round" stroke-linecap="round" />
      </svg>
    )
  }

  const MenuCommon = () => (
    <>
      <button
        class="alpha-acct-item"
        onClick={() => {
          setMenuOpen(false)
          command.trigger("settings.open")
        }}
      >
        <span class="alpha-acct-ic">⚙</span>设置
      </button>
      <div class="alpha-acct-item alpha-acct-appearance">
        <span class="alpha-acct-ic">◐</span>外观
        <span class="alpha-acct-spacer" />
        <span class="alpha-acct-seg">
          <For each={SCHEMES}>
            {(s) => (
              <button data-on={theme.colorScheme() === s.k ? "" : undefined} onClick={() => theme.setColorScheme(s.k)}>
                {s.l}
              </button>
            )}
          </For>
        </span>
      </div>
      <button
        class="alpha-acct-item"
        onClick={() => {
          setMenuOpen(false)
          command.trigger("settings.open")
        }}
      >
        <span class="alpha-acct-ic">?</span>帮助与反馈
      </button>
      <button
        class="alpha-acct-item"
        onClick={() => {
          setMenuOpen(false)
          void window.api.updater.check()
        }}
      >
        <span class="alpha-acct-ic">↑</span>检查更新
      </button>
    </>
  )

  // Which project's "⋯" menu is open (by worktree), if any, and where to anchor it. The menu is
  // rendered once at the Portal root with fixed positioning (computed from the trigger button)
  // rather than inside the project row, so the scroll container can't clip it.
  const [menuFor, setMenuFor] = createSignal<string | null>(null)
  // Per-session "⋯" actions (rename inline / share / delete) — the user asked these move off the
  // session header into the sidebar row. Position is computed from the trigger, Portal-rendered.
  const [sessionMenu, setSessionMenu] = createSignal<{ id: string; directory: string; title: string; top: number; right: number } | null>(null)
  const [editingSession, setEditingSession] = createSignal<string | null>(null)
  // Sidebar-native search: filters the project/session list in place (distinct from the "搜索"
  // nav item, which opens opencode's global command palette).
  const [searchQuery, setSearchQuery] = createSignal("")
  const openSessionMenu = (e: MouseEvent, session: { id: string; directory: string; title: string }) => {
    e.preventDefault()
    e.stopPropagation()
    const rect = (e.currentTarget as HTMLElement).getBoundingClientRect()
    setSessionMenu({
      id: session.id,
      directory: session.directory,
      title: session.title,
      top: rect.bottom + 4,
      right: Math.max(8, window.innerWidth - rect.right),
    })
  }
  const [menuPos, setMenuPos] = createSignal<{ top: number; right: number } | null>(null)

  const openProjectMenu = (e: MouseEvent & { currentTarget: HTMLElement }, worktree: string) => {
    e.stopPropagation()
    if (menuFor() === worktree) {
      setMenuFor(null)
      return
    }
    const r = e.currentTarget.getBoundingClientRect()
    setMenuPos({ top: r.bottom + 3, right: Math.max(8, window.innerWidth - r.right) })
    setMenuFor(worktree)
  }

  // opencode folds EVERY non-git directory into a single "global" project (worktree "/"), so chats
  // started in different loose folders all collapse into one 全局 bucket — exactly the bug the user
  // hit ("发起对话全跑到全局，没生成新项目"). But each global session keeps its REAL path in
  // session.directory (verified live: a chat in /Users/tide/Documents/workspace has directory set to
  // that path while projectID is "global"). So we split the global bucket back apart by directory at
  // render time: every distinct real directory becomes its own project group (named by basename),
  // and only sessions with no real directory (directory "/") remain under 全局. This is purely a
  // display transform — the data layer still sees opencode's single global project, so nothing
  // upstream changes and the worktree we synthesize (= the real directory) is what new chats use.
  const displayProjects = createMemo<AlphaProject[]>(() => {
    const result: AlphaProject[] = []
    for (const p of store.projects) {
      if (p.worktree !== "/") {
        result.push(p)
        continue
      }
      const groups = new Map<string, AlphaSession[]>()
      for (const s of p.sessions) {
        const dir = s.directory && s.directory !== "/" ? s.directory : "/"
        const list = groups.get(dir)
        if (list) list.push(s)
        else groups.set(dir, [s])
      }
      // Real directories first (most-recently-active first), then the residual 全局 bucket last.
      const entries = [...groups.entries()].sort((a, b) => {
        if (a[0] === "/") return 1
        if (b[0] === "/") return -1
        return (b[1][0]?.updated ?? 0) - (a[1][0]?.updated ?? 0)
      })
      for (const [dir, sessions] of entries) {
        if (dir === "/") result.push({ ...p, sessions })
        else
          result.push({
            id: `global:${dir}`,
            worktree: dir,
            name: projectLabel(dir),
            color: undefined,
            directories: [dir],
            sessions,
            loaded: p.loaded,
          })
      }
    }
    return result
  })

  // Projects visible in the sidebar = all known projects minus the ones the user archived/removed.
  const visibleProjects = createMemo(() => displayProjects().filter((p) => !isProjectHidden(p.worktree)))
  // Filter visible projects + their sessions by the search query. A project shows if its name
  // matches (then all its sessions show) or if any of its sessions' titles match (then only those).
  const searchedProjects = createMemo(() => {
    const q = searchQuery().trim().toLowerCase()
    const base = visibleProjects()
    if (!q) return base
    const out: typeof base = []
    for (const p of base) {
      if (projectLabel(p.worktree).toLowerCase().includes(q)) {
        out.push(p)
        continue
      }
      const sessions = (p.sessions ?? []).filter((s) => sessionDisplayTitle(s.title).toLowerCase().includes(q))
      if (sessions.length) out.push({ ...p, sessions })
    }
    return out
  })
  // Known projects that are currently hidden — drives the "Archived (N)" restore affordance, so
  // archiving is always reversible (no project can be lost).
  const archivedCount = createMemo(() => {
    hiddenProjects() // track the hidden set
    return displayProjects().filter((p) => isProjectHidden(p.worktree)).length
  })

  // Decode the active project directory + session id from the current route
  // (legacy-route-abi parseRoute,REQ-084). Drives the active-row highlight and "new chat" target.
  const route = createMemo<{ dir?: string; sessionId?: string }>(() => {
    const r = parseRoute(location.pathname)
    if (r.kind === "directory") return { dir: r.directory }
    if (r.kind === "session") return { dir: r.directory, sessionId: r.id }
    return {}
  })

  // The customization hub (定制中心) is a full-content overlay. The user expects the sidebar to
  // "win": clicking any sidebar item that navigates (a project, a session, new chat, home) should
  // dismiss the hub and land on that target. We watch the raw pathname (not the reduced route()
  // memo, which collapses home and new-session to the same value) and close the hub whenever it
  // changes, guarded so the mount run and same-location re-renders never close a freshly-opened hub.
  let lastNavPath: string | undefined
  createEffect(() => {
    const path = location.pathname
    if (lastNavPath !== undefined && path !== lastNavPath && extHubOpen()) setExtHubOpen(false)
    lastNavPath = path
  })

  // Keep the open session marked "viewed" at its latest activity, so it never shows its own unread
  // dot and the watermark advances as messages stream in. Re-runs when the active id changes OR when
  // that session's `updated` bumps (Solid tracks the deep store read).
  createEffect(() => {
    const sid = route().sessionId
    if (!sid) return
    for (const p of store.projects) {
      const s = p.sessions.find((x) => x.id === sid)
      if (s) {
        markSessionViewed(sid, s.updated)
        break
      }
    }
  })

  // True whenever we're inside a project workspace (a session OR a new-chat draft), i.e. not the
  // bare home grid. Drives the top-right terminal/review toolbar's visibility.
  const inWorkspace = createMemo(() => parseRoute(location.pathname).kind !== "home")

  // Reflect sidebar visibility onto <body> so sidebar.css can shift opencode's content.
  createEffect(() => {
    document.body.dataset.alphaSidebar = sidebarCollapsed() ? "collapsed" : "open"
  })
  onCleanup(() => {
    delete document.body.dataset.alphaSidebar
  })

  // Responsive auto-collapse. As the window narrows, the two side panels would otherwise crush the
  // chat column, so fold them in priority order: the right review panel first, then (narrower still)
  // our own left sidebar. Crucially this is REVERSIBLE — folding on the downward crossing of a
  // threshold and restoring on the upward crossing — so a narrow→wide resize never strands a panel
  // hidden. We only ever undo OUR OWN auto-action: the sidebar override is transient (it leaves the
  // user's persisted preference alone, see setSidebarAutoCollapsed), and the review panel is only
  // re-opened if we were the one who closed it (`autoClosedReview`). A panel the user collapsed by
  // hand therefore stays as they left it.
  //
  // The review panel is opencode's; we can't read its store (the @opencode-ai/app export whitelist
  // blocks deep-importing useLayout — ADR-008), so we read its open state from the ARIA contract on
  // the header toggle (`[aria-controls="review-panel"][aria-expanded]`) and toggle it via the public
  // `review.toggle` command. Coupling = that ARIA pair; a rename only disables this nicety.
  const REVIEW_COLLAPSE_W = 1100 // below this, fold the right review panel
  const SIDEBAR_COLLAPSE_W = 768 // below this, also collapse the left sidebar (opencode's own
  // desktop panels disappear under 768 too, so the two breakpoints stay coherent)

  const reviewPanelOpen = () => {
    for (const el of document.querySelectorAll('[aria-controls="review-panel"][aria-expanded]')) {
      if (el.getAttribute("aria-expanded") === "true") return true
    }
    return false
  }

  let prevWidth = window.innerWidth
  let autoClosedReview = false
  let resizeScheduled = false
  const onResize = () => {
    if (resizeScheduled) return
    resizeScheduled = true
    requestAnimationFrame(() => {
      resizeScheduled = false
      const w = window.innerWidth

      // Right review panel: close on narrow, reopen (only if WE closed it) on wide.
      if (inWorkspace()) {
        if (prevWidth >= REVIEW_COLLAPSE_W && w < REVIEW_COLLAPSE_W && reviewPanelOpen()) {
          command.trigger("review.toggle")
          autoClosedReview = true
        } else if (prevWidth < REVIEW_COLLAPSE_W && w >= REVIEW_COLLAPSE_W && autoClosedReview) {
          if (!reviewPanelOpen()) command.trigger("review.toggle")
          autoClosedReview = false
        }
      }

      // Left sidebar: fold on narrow, restore on wide. The override is transient, so a manual
      // collapse underneath is preserved and a manual open returns when we clear it.
      if (prevWidth >= SIDEBAR_COLLAPSE_W && w < SIDEBAR_COLLAPSE_W && !sidebarCollapsed()) {
        setSidebarAutoCollapsed(true)
      } else if (prevWidth < SIDEBAR_COLLAPSE_W && w >= SIDEBAR_COLLAPSE_W) {
        setSidebarAutoCollapsed(false)
      }

      prevWidth = w
    })
  }
  window.addEventListener("resize", onResize)
  onCleanup(() => window.removeEventListener("resize", onResize))

  // The project that owns the current route's directory (the directory may be a sandbox, so match
  // against the full `directories` list, not just the worktree). Drives active-row highlight and
  // auto-expand — both keyed by worktree.
  const activeProject = createMemo(() => {
    const dir = route().dir
    if (!dir) return undefined
    return displayProjects().find((p) => p.directories.includes(dir))
  })

  // Auto-expand the active project (once each) so its highlighted conversation is visible. We track
  // store.projects so this still fires if navigation precedes the project list loading, but the
  // `autoExpanded` guard ensures we only force-expand a given project a single time — otherwise a
  // later session event (which mutates store.projects) would re-expand a project the user just
  // collapsed.
  const autoExpanded = new Set<string>()
  createEffect(() => {
    const worktree = activeProject()?.worktree
    if (!worktree || autoExpanded.has(worktree)) return
    autoExpanded.add(worktree)
    setProjectExpanded(worktree, true)
  })

  // The most-recently-active CONCRETE project directory (a real worktree, never the bare global "/"
  // bucket). This is what the home composer should default to — a draft for "/" renders the wrong
  // "New project" screen (see newChat). Reads displayProjects so the per-directory split of the
  // global bucket (e.g. a loose "workspace" folder) is eligible too.
  const mostRecentConcreteDir = (): string | undefined => {
    let best: string | undefined
    let bestTime = -1
    for (const p of displayProjects()) {
      if (p.worktree === "/") continue
      const top = p.sessions[0]?.updated ?? 0
      if (top > bestTime) {
        bestTime = top
        best = p.worktree
      }
    }
    return best
  }

  // On app launch, land on the home composer (首页, Image #11: ALPHA CODE wordmark + prompt box with
  // the project switcher BELOW it) — not whatever opencode restores (it reopens the last session),
  // and not the recent-sessions search grid that bare "/" renders. That composer is opencode's
  // new-session DRAFT for a concrete project: `newSessionHref(dir)` with `dir` = a real worktree
  // (verified: this is exactly what opencode's own "新建会话" button produces). Fires once, after the
  // project list loads (so we have a directory), with `replace` so Back doesn't bounce to the
  // restored session. Falls back to the home grid only if there is no concrete project at all.
  let didLaunchNav = false
  createEffect(() => {
    if (didLaunchNav || !store.ready) return
    didLaunchNav = true
    const dir = mostRecentConcreteDir()
    navigate(dir ? newSessionHref(dir) : homeHref(), { replace: true })
  })

  // Mount our chrome INSIDE #root (not <body>). opencode's draggable-region CSS is scoped to
  // `#root ... [data-tauri-drag-region]`, and its titlebar buttons are clickable only because they
  // sit inside that system (base.css auto-marks [data-tauri-drag-region] <button> as no-drag).
  // A <body>-level portal is excluded, so the OS treats our titlebar buttons as drag region and
  // eats their clicks. A host div appended to #root keeps position:fixed working (no contain there)
  // while putting us back inside opencode's region system.
  const portalHost = document.createElement("div")
  portalHost.setAttribute("data-alpha-chrome", "")
  document.getElementById("root")?.appendChild(portalHost)
  onCleanup(() => portalHost.remove())

  // Start a new chat in a project. We eagerly create a real session (not opencode's draft, which
  // is a tab — the alpha redesign hides the tab strip, so a draft would be invisible in the
  // sidebar) so the new conversation appears in the project immediately, then navigate into it.
  // If creation fails we fall back to opencode's draft route.
  const startChat = async (worktree: string) => {
    setProjectExpanded(worktree, true)
    const id = await createSession(worktree)
    if (id) navigate(sessionHref(worktree, id))
    else {
      // B11 复扫行14:创建失败不再静默 —— 草稿回退仍可用(composer 照常),但把失败说出来
      pushToast({ kind: "error", title: t("alpha.sidebar.newChatFailed") })
      navigate(newSessionHref(worktree))
    }
  }

  // "新对话" lands on the home composer (Image #11: ALPHA CODE wordmark + prompt box with the project
  // switcher BELOW it). That is opencode's new-session DRAFT for a CONCRETE project directory —
  // `newSessionHref(dir)` → SessionRoute → a draft tab → the NewSession composer (exactly what
  // opencode's own "新建会话" produces). The one hard rule: `dir` must be a real worktree, never the
  // bare global "/", because a draft for "/" renders the picker INSIDE the box reading "New project"
  // (Image #9, the screen the user flagged as wrong). Prefer the project the user is currently in,
  // else the most-recent real directory; with no project at all fall back to the home grid.
  const newChat = () => {
    const active = activeProject()?.worktree
    const dir = active && active !== "/" ? active : mostRecentConcreteDir()
    navigate(dir ? newSessionHref(dir) : homeHref())
  }

  const archiveProject = (worktree: string) => {
    setMenuFor(null)
    hideProject(worktree)
    // B4(S17 T5):归档即从数据层剔除(use-projects 按 hidden 过滤)——reload 使其立即生效,
    // 此后该项目零请求(session.list 不再发起,引擎不再为其建 Instance)。
    void props.projects.reload()
  }

  const openSession = (e: MouseEvent, directory: string, id: string) => {
    e.preventDefault()
    navigate(sessionHref(directory, id))
  }

  return (
    <Portal mount={portalHost}>
      {/* The open project "⋯" menu (archive / remove) + a transparent full-screen catcher that
          dismisses it on an outside click. Rendered once at the Portal root, fixed-positioned from
          the trigger button, so the project scroll container never clips it. */}
      <Show when={menuFor()}>
        {(worktree) => (
          <>
            <div class="alpha-menu-backdrop" onClick={() => setMenuFor(null)} />
            <div
              class="alpha-project-menu"
              role="menu"
              style={{ top: `${menuPos()?.top ?? 0}px`, right: `${menuPos()?.right ?? 8}px` }}
            >
              <button
                type="button"
                class="alpha-project-menu-item"
                role="menuitem"
                onClick={() => archiveProject(worktree())}
              >
                <svg class="alpha-project-menu-icon" viewBox="0 0 16 16" fill="none" aria-hidden="true">
                  <rect x="2.25" y="3" width="11.5" height="2.4" rx="0.6" stroke="currentColor" stroke-width="1.2" />
                  <path d="M3.3 5.6h9.4V12a1 1 0 0 1-1 1H4.3a1 1 0 0 1-1-1V5.6Z" stroke="currentColor" stroke-width="1.2" />
                  <path d="M6.4 8.4h3.2" stroke="currentColor" stroke-width="1.2" stroke-linecap="round" />
                </svg>
                <span>{t("alpha.sidebar.archive")}</span>
              </button>
              {/* opencode has no project-delete API (ADR-008): archive = client-side hide, restorable
                  via the "已归档(N)" row. The former duplicate "remove" button called the SAME
                  archiveProject() — dropped to avoid two identical actions. */}
            </div>
          </>
        )}
      </Show>

      <Show when={sessionMenu()}>
        {(m) => (
          <>
            <div class="alpha-menu-backdrop" onClick={() => setSessionMenu(null)} />
            <div class="alpha-project-menu" role="menu" style={{ top: `${m().top}px`, right: `${m().right}px` }}>
              <button
                type="button"
                class="alpha-project-menu-item"
                role="menuitem"
                onClick={() => {
                  setEditingSession(m().id)
                  setSessionMenu(null)
                }}
              >
                <svg class="alpha-project-menu-icon" viewBox="0 0 16 16" fill="none" aria-hidden="true">
                  <path d="M11.5 2.5a1.4 1.4 0 0 1 2 2L6 12l-3 .8.8-3 7.7-7.3Z" stroke="currentColor" stroke-width="1.2" stroke-linejoin="round" />
                </svg>
                <span>重命名</span>
              </button>
              <button
                type="button"
                class="alpha-project-menu-item"
                role="menuitem"
                onClick={() => {
                  const session = m()
                  setSessionMenu(null)
                  void (async () => {
                    const url = await shareSession(session.id, session.directory)
                    if (!url) {
                      pushToast({ kind: "error", title: t("alpha.sidebar.shareFailed") })
                      return
                    }
                    const ok = await copyText(url)
                    pushToast(
                      ok
                        ? { kind: "success", title: t("alpha.sidebar.shareCopied"), detail: url }
                        : { kind: "success", title: t("alpha.sidebar.shareCreated"), detail: url },
                    )
                  })()
                }}
              >
                <svg class="alpha-project-menu-icon" viewBox="0 0 16 16" fill="none" aria-hidden="true">
                  <path d="M8 10V2.5M5.5 5 8 2.5 10.5 5M3 9v3.5a1 1 0 0 0 1 1h8a1 1 0 0 0 1-1V9" stroke="currentColor" stroke-width="1.2" stroke-linecap="round" stroke-linejoin="round" />
                </svg>
                <span>分享</span>
              </button>
              <button
                type="button"
                class="alpha-project-menu-item"
                role="menuitem"
                onClick={() => {
                  const id = m().id
                  setSessionMenu(null)
                  void (async () => {
                    const text = await copySession(id)
                    if (!text) {
                      pushToast({ kind: "error", title: "没有可复制的内容" })
                      return
                    }
                    const ok = await copyText(text)
                    pushToast(
                      ok
                        ? { kind: "success", title: "已复制整段对话" }
                        : { kind: "error", title: "复制失败" },
                    )
                  })()
                }}
              >
                <svg class="alpha-project-menu-icon" viewBox="0 0 16 16" fill="none" aria-hidden="true">
                  <rect x="5" y="5" width="8" height="9" rx="1.3" stroke="currentColor" stroke-width="1.2" />
                  <path d="M11 5V3.8a1 1 0 0 0-1-1H4a1 1 0 0 0-1 1V11a1 1 0 0 0 1 1h1" stroke="currentColor" stroke-width="1.2" stroke-linecap="round" stroke-linejoin="round" />
                </svg>
                <span>复制对话</span>
              </button>
              <button
                type="button"
                class="alpha-project-menu-item alpha-project-menu-item-danger"
                role="menuitem"
                onClick={() => {
                  const id = m().id
                  setSessionMenu(null)
                  void (async () => {
                    const ok = await deleteSession(id)
                    if (!ok) pushToast({ kind: "error", title: t("alpha.sidebar.deleteFailed") })
                  })()
                }}
              >
                <svg class="alpha-project-menu-icon" viewBox="0 0 16 16" fill="none" aria-hidden="true">
                  <path d="M3 4.5h10M6.5 4.5V3.4a.9.9 0 0 1 .9-.9h1.2a.9.9 0 0 1 .9.9V4.5M11.7 4.5 11.2 12a1 1 0 0 1-1 .95H5.8a1 1 0 0 1-1-.95L4.3 4.5" stroke="currentColor" stroke-width="1.2" stroke-linecap="round" stroke-linejoin="round" />
                </svg>
                <span>删除</span>
              </button>
            </div>
          </>
        )}
      </Show>

      {/* Always-visible top-left toolbar: collapse toggle + back/forward. The whole toolbar is
          no-drag (sidebar.css) and sits over a no-drag area, so the OS never steals its clicks. */}
      <div class="alpha-topbar">
        <button
          type="button"
          class="alpha-topbar-btn"
          title={sidebarCollapsed() ? t("alpha.sidebar.show") : t("alpha.sidebar.hide")}
          aria-label={sidebarCollapsed() ? t("alpha.sidebar.show") : t("alpha.sidebar.hide")}
          onClick={() => toggleSidebar()}
        >
          <Icon name="sidebar-right" />
        </button>
        <span class="alpha-topbar-divider" aria-hidden="true" />
        <button
          type="button"
          class="alpha-topbar-btn"
          title={t("alpha.sidebar.back")}
          aria-label={t("alpha.sidebar.back")}
          onClick={() => navigate(-1)}
        >
          <svg viewBox="0 0 16 16" fill="none" aria-hidden="true">
            <path d="M10 3.5 5.5 8l4.5 4.5" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" />
          </svg>
        </button>
        <button
          type="button"
          class="alpha-topbar-btn"
          title={t("alpha.sidebar.forward")}
          aria-label={t("alpha.sidebar.forward")}
          onClick={() => navigate(1)}
        >
          <svg viewBox="0 0 16 16" fill="none" aria-hidden="true">
            <path d="M6 3.5 10.5 8 6 12.5" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" />
          </svg>
        </button>
      </div>

      {/* Top-right toolbar (only inside a session): terminal toggle + review/审查 toggle. We render
          our own pair (wired to opencode's commands) and hide opencode's faint titlebar review
          toggle below, so both are clearly visible and clickable. */}
      <Show when={inWorkspace()}>
        <div class="alpha-topbar-right">
          <button
            type="button"
            class="alpha-topbar-btn"
            title={t("alpha.sidebar.terminal")}
            aria-label={t("alpha.sidebar.terminal")}
            onClick={() => command.trigger("terminal.toggle")}
          >
            <svg viewBox="0 0 16 16" fill="none" aria-hidden="true">
              <rect x="2" y="3" width="12" height="10" rx="1.6" stroke="currentColor" stroke-width="1.3" />
              <path d="M4.8 6.4 6.8 8.4 4.8 10.4" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round" />
              <path d="M8.3 10.6h2.7" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" />
            </svg>
          </button>
          <button
            type="button"
            class="alpha-topbar-btn"
            title={t("alpha.sidebar.review")}
            aria-label={t("alpha.sidebar.review")}
            onClick={() => command.trigger("review.toggle")}
          >
            <svg viewBox="0 0 16 16" fill="none" aria-hidden="true">
              <rect x="2" y="3" width="12" height="10" rx="1.6" stroke="currentColor" stroke-width="1.3" />
              <path d="M10.4 3v10" stroke="currentColor" stroke-width="1.3" />
            </svg>
          </button>
        </div>
      </Show>

      <Show when={!sidebarCollapsed()}>
        <aside class="alpha-sidebar" aria-label={t("alpha.sidebar.projects")}>
          <div class="alpha-sidebar-titlebar" />

          <header class="alpha-sidebar-brand">
            <button
              type="button"
              class="alpha-sidebar-brand-mark"
              title={t("alpha.sidebar.home")}
              onClick={() => navigate(homeHref())}
            >
              <Mark class="alpha-sidebar-mark" />
              <span class="alpha-sidebar-wordmark">ALPHA CODE</span>
            </button>
          </header>

          <Show when={engineDown()}>
            <div class="alpha-sidebar-engine-down">
              <Banner
                kind="error"
                title={t("alpha.engine.down")}
                detail={t("alpha.engine.downDetail")}
                action={{ label: t("alpha.engine.retry"), onClick: retryEngine }}
              />
            </div>
          </Show>

          <nav class="alpha-sidebar-nav">
            <button type="button" class="alpha-sidebar-nav-item" onClick={() => newChat()}>
              <Icon name="plus" class="alpha-sidebar-nav-icon" />
              <span>{t("alpha.sidebar.newChat")}</span>
            </button>
            <button type="button" class="alpha-sidebar-nav-item" onClick={() => command.show()}>
              <Icon name="magnifying-glass" class="alpha-sidebar-nav-icon" />
              <span>{t("alpha.sidebar.search")}</span>
            </button>
            <button
              type="button"
              class="alpha-sidebar-nav-item"
              onClick={() => {
                setAutomationOpen(false) // 全页面板互斥
                setWorkbenchOpen(false)
                toggleExtHub()
              }}
            >
              <Icon name="grid-plus" class="alpha-sidebar-nav-icon" />
              <span>{t("alpha.sidebar.plugins")}</span>
            </button>
            {/* 自动化(REQ-021 A1.1):复活孤儿 key;badge = 上次运行失败/超时的任务数 */}
            <button
              type="button"
              class="alpha-sidebar-nav-item"
              onClick={() => {
                setExtHubOpen(false)
                setWorkbenchOpen(false)
                toggleAutomation()
              }}
            >
              <svg class="alpha-sidebar-nav-icon" viewBox="0 0 16 16" fill="none" aria-hidden="true">
                <circle cx="8" cy="8" r="6.2" stroke="currentColor" />
                <path d="M8 4.8V8l2.4 1.6" stroke="currentColor" stroke-linecap="square" />
              </svg>
              <span>{t("alpha.sidebar.automation")}</span>
              <Show when={automationFailedCount() > 0}>
                <span class="alpha-auto-badge">{automationFailedCount()}</span>
              </Show>
            </button>
            {/* 产物工作台(REQ-094 #186):badge = 打开前落盘的新 run 数(发现不抢焦点,AC#2) */}
            <button
              type="button"
              class="alpha-sidebar-nav-item"
              onClick={() => {
                setExtHubOpen(false)
                setAutomationOpen(false)
                toggleWorkbench()
              }}
            >
              <svg class="alpha-sidebar-nav-icon" viewBox="0 0 16 16" fill="none" aria-hidden="true">
                <rect x="2.2" y="2.8" width="11.6" height="10.4" rx="1.6" stroke="currentColor" />
                <path d="M2.2 6.4h11.6M6.4 6.4v6.8" stroke="currentColor" />
              </svg>
              <span>{t("alpha.sidebar.workbench")}</span>
              <Show when={workbenchBadge() > 0}>
                <span class="alpha-auto-badge">{workbenchBadge()}</span>
              </Show>
            </button>
          </nav>

          <Show when={visibleProjects().length > 0}>
            <div class="alpha-sidebar-search">
              <Icon name="magnifying-glass" class="alpha-sidebar-search-icon" />
              <input
                class="alpha-sidebar-search-input"
                type="text"
                placeholder="搜索项目 / 会话…"
                value={searchQuery()}
                onInput={(e) => setSearchQuery(e.currentTarget.value)}
              />
              <Show when={searchQuery() !== ""}>
                <button
                  type="button"
                  class="alpha-sidebar-search-clear"
                  aria-label="清除搜索"
                  onClick={() => setSearchQuery("")}
                >
                  ×
                </button>
              </Show>
            </div>
          </Show>

          <div class="alpha-sidebar-section">{t("alpha.sidebar.projects")}</div>

          <div class="alpha-sidebar-scroll">
            <For each={searchedProjects()}>
              {(project) => {
                const expanded = () => isProjectExpanded(project.worktree) || searchQuery().trim() !== ""
                const menuOpen = () => menuFor() === project.worktree
                return (
                  <div class="alpha-project" data-expanded={expanded() ? "" : undefined}>
                    <div
                      class="alpha-project-row"
                      data-active={activeProject()?.worktree === project.worktree ? "" : undefined}
                      data-menu={menuOpen() ? "" : undefined}
                      onClick={() => toggleProjectExpanded(project.worktree)}
                    >
                      <Icon
                        name="chevron-down"
                        class="alpha-project-chevron"
                        data-collapsed={expanded() ? undefined : ""}
                      />
                      <ProjectAvatar
                        class="alpha-project-avatar"
                        variant={projectVariant(project)}
                        fallback={projectDisplayName(project)}
                      />
                      <span class="alpha-project-name" title={project.worktree}>
                        {projectDisplayName(project)}
                      </span>
                      <button
                        type="button"
                        class="alpha-project-action"
                        title={t("alpha.sidebar.more")}
                        aria-label={t("alpha.sidebar.more")}
                        aria-haspopup="menu"
                        aria-expanded={menuOpen()}
                        onClick={(e) => openProjectMenu(e, project.worktree)}
                      >
                        <Icon name="outline-dots" />
                      </button>
                      <button
                        type="button"
                        class="alpha-project-action alpha-project-add"
                        title={t("alpha.sidebar.newChat")}
                        aria-label={t("alpha.sidebar.newChat")}
                        onClick={(e) => {
                          e.stopPropagation()
                          void startChat(project.worktree)
                        }}
                      >
                        <Icon name="plus" />
                      </button>
                    </div>

                    <Show when={expanded()}>
                      <div class="alpha-project-sessions">
                        <For
                          each={project.sessions}
                          fallback={
                            <div class="alpha-sidebar-empty">
                              {project.loaded ? t("alpha.sidebar.noConversations") : t("alpha.sidebar.loading")}
                            </div>
                          }
                        >
                          {(session) => (
                            <div class="alpha-session-row" data-active={route().sessionId === session.id ? "" : undefined}>
                              <Show when={isSessionUnread(session.id, session.updated) && route().sessionId !== session.id}>
                                <span class="alpha-session-unread" aria-hidden="true" />
                              </Show>
                              <Show
                                when={editingSession() === session.id}
                                fallback={
                                  <>
                                    <a
                                      class="alpha-session"
                                      href={sessionHref(session.directory, session.id)}
                                      data-active={route().sessionId === session.id ? "" : undefined}
                                      onClick={(e) => openSession(e, session.directory, session.id)}
                                    >
                                      <span class="alpha-session-title">{sessionDisplayTitle(session.title)}</span>
                                    </a>
                                    <button
                                      type="button"
                                      class="alpha-session-menu-btn"
                                      aria-label="会话操作"
                                      onClick={(e) => openSessionMenu(e, session)}
                                    >
                                      <svg viewBox="0 0 16 16" width="14" height="14" fill="currentColor" aria-hidden="true">
                                        <circle cx="3.4" cy="8" r="1.2" />
                                        <circle cx="8" cy="8" r="1.2" />
                                        <circle cx="12.6" cy="8" r="1.2" />
                                      </svg>
                                    </button>
                                  </>
                                }
                              >
                                <input
                                  class="alpha-session-rename"
                                  value={session.title}
                                  autofocus
                                  onClick={(e) => e.stopPropagation()}
                                  onKeyDown={(e) => {
                                    if (e.key === "Enter") {
                                      const v = e.currentTarget.value
                                      setEditingSession(null)
                                      void renameSession(session.id, v).then(
                                        (ok) => ok || pushToast({ kind: "error", title: t("alpha.sidebar.renameFailed") }),
                                      )
                                    } else if (e.key === "Escape") {
                                      setEditingSession(null)
                                    }
                                  }}
                                  onBlur={(e) => {
                                    const v = e.currentTarget.value
                                    setEditingSession(null)
                                    void renameSession(session.id, v).then(
                                      (ok) => ok || pushToast({ kind: "error", title: t("alpha.sidebar.renameFailed") }),
                                    )
                                  }}
                                />
                              </Show>
                            </div>
                          )}
                        </For>
                      </div>
                    </Show>
                  </div>
                )
              }}
            </For>

            <Show when={searchQuery().trim() !== "" && searchedProjects().length === 0}>
              <div class="alpha-sidebar-empty">无匹配的项目或会话</div>
            </Show>
            <Show when={store.ready && !store.error && visibleProjects().length === 0 && archivedCount() === 0}>
              <div class="alpha-sidebar-empty alpha-sidebar-empty-projects">
                <p>{t("alpha.sidebar.noProjects")}</p>
                <button type="button" class="alpha-sidebar-open-project" onClick={() => command.trigger("project.open")}>
                  {t("alpha.sidebar.openProject")}
                </button>
              </div>
            </Show>
            {/* B11: project.list failure previously left the sidebar silently blank (store.error was
                never rendered anywhere). Surface it with a retry instead of a dead empty pane. */}
            <Show when={store.error}>
              <div class="alpha-sidebar-empty alpha-sidebar-empty-projects">
                <p>项目加载失败</p>
                <button type="button" class="alpha-sidebar-open-project" onClick={() => void reload()}>
                  重试
                </button>
              </div>
            </Show>

            {/* Archived projects are only hidden (opencode has no server-side project deletion), so
                always offer a one-click restore — archiving must never strand a project. */}
            <Show when={archivedCount() > 0}>
              <button type="button" class="alpha-sidebar-archived" onClick={() => clearHiddenProjects()}>
                <span>{t("alpha.sidebar.archivedShow", { count: archivedCount() })}</span>
                <span class="alpha-sidebar-archived-action">{t("alpha.sidebar.unarchiveAll")}</span>
              </button>
            </Show>
          </div>

          {/* Footer = ONE account entry → upward popover. Settings / appearance / help / update /
              membership / sign-in/out all live in this single popover (user request). */}
          <footer class="alpha-sidebar-footer" data-menu-open={menuOpen() ? "" : undefined}>
            <Show when={menuOpen()}>
              <div class="alpha-acct-backdrop" onClick={() => setMenuOpen(false)} />
              <div class="alpha-acct-pop" role="menu">
                <Show
                  when={authState().status === "logged-in"}
                  fallback={
                    <>
                      <div class="alpha-acct-head">
                        <span class="alpha-acct-av guest">?</span>
                        <div class="alpha-acct-id">
                          <div class="alpha-acct-name">未登录</div>
                          <div class="alpha-acct-email">登录后解锁云端能力</div>
                        </div>
                      </div>
                      <button
                        class="alpha-acct-login"
                        onClick={() => {
                          setMenuOpen(false)
                          void window.api.auth.start()
                        }}
                      >
                        ⊕ 登录
                      </button>
                      <MenuCommon />
                    </>
                  }
                >
                  <div class="alpha-acct-head">
                    <span class="alpha-acct-av">{acctInitial()}</span>
                    <div class="alpha-acct-id">
                      <div class="alpha-acct-name">你的账户</div>
                      <div class="alpha-acct-email">{accountLabel()}</div>
                    </div>
                    <span class="alpha-acct-plan" data-pro={acctIsPro() ? "" : undefined}>
                      {acctIsPro() ? acctPlanName().toUpperCase() : "免费版"}
                    </span>
                  </div>
                  <div class="alpha-acct-card">
                    <div class="alpha-acct-row">
                      <span class="alpha-acct-k">会员订阅</span>
                      {/* B11:读取失败时不装「未订阅」(状态未知),与其余行一致显示 pending/错误占位 */}
                      <Show
                        when={summary() || summaryState() !== "error"}
                        fallback={<span class="alpha-acct-pending">{pendingText()}</span>}
                      >
                        <span class="alpha-acct-v">{activePlan()?.name ?? (isPro() ? plan() : "未订阅")}</span>
                      </Show>
                    </div>
                    <div class="alpha-acct-row">
                      <span class="alpha-acct-k">可用余额</span>
                      <Show when={summary()} fallback={<span class="alpha-acct-pending">{pendingText()}</span>}>
                        <span class="alpha-acct-v">{fmtYuan(summary()!.balanceFen)}</span>
                      </Show>
                    </div>
                    <div class="alpha-acct-row">
                      <span class="alpha-acct-k">5 小时额度</span>
                      <Show when={summary()} fallback={<span class="alpha-acct-pending">{pendingText()}</span>}>
                        <Show when={activePlan()} fallback={<span class="alpha-acct-pending">按量计费</span>}>
                          <span class="alpha-acct-v">
                            {activePlan()!.window5h.usedCredits.toLocaleString()} / {activePlan()!.window5h.limitCredits.toLocaleString()}
                          </span>
                        </Show>
                      </Show>
                    </div>
                    <div class="alpha-acct-row">
                      <span class="alpha-acct-k">7 日额度</span>
                      <Show when={summary()} fallback={<span class="alpha-acct-pending">{pendingText()}</span>}>
                        <Show when={activePlan()} fallback={<span class="alpha-acct-pending">按量计费</span>}>
                          <span class="alpha-acct-v">
                            {activePlan()!.window7d.usedCredits.toLocaleString()} / {activePlan()!.window7d.limitCredits.toLocaleString()}
                          </span>
                        </Show>
                      </Show>
                    </div>
                    <div class="alpha-acct-row">
                      <span class="alpha-acct-k">近 14 天</span>
                      <Show
                        when={summary() && summary()!.usageSeries.length > 0}
                        fallback={<span class="alpha-acct-pending">{summary() ? "暂无数据" : pendingText()}</span>}
                      >
                        <Sparkline data={summary()!.usageSeries.map((p) => p.tokens)} />
                      </Show>
                    </div>
                  </div>
                  <div class="alpha-acct-cta">
                    <Show when={!acctIsPro()}>
                      <button class="alpha-acct-btn primary" onClick={() => window.api.openLink(subscribeUrl())}>
                        升级会员
                      </button>
                    </Show>
                    <button class="alpha-acct-btn" onClick={() => window.api.openLink(rechargeUrl())}>
                      充值
                    </button>
                    <Show when={acctIsPro()}>
                      <button class="alpha-acct-btn" onClick={() => window.api.openLink(subscribeUrl())}>
                        管理订阅
                      </button>
                    </Show>
                  </div>
                  <MenuCommon />
                  <div class="alpha-acct-sep" />
                  <button
                    class="alpha-acct-item alpha-acct-danger"
                    onClick={() => {
                      setMenuOpen(false)
                      void window.api.auth.logout()
                    }}
                  >
                    <span class="alpha-acct-ic">⎋</span>退出登录
                  </button>
                </Show>
              </div>
            </Show>
            <button
              type="button"
              class="alpha-sidebar-account"
              data-auth={authState().status === "logged-in" ? "in" : "out"}
              onClick={() => setMenuOpen((o) => !o)}
            >
              <span class="alpha-acct-av" data-guest={authState().status === "logged-in" ? undefined : ""}>
                {authState().status === "logged-in" ? acctInitial() : "?"}
              </span>
              <span class="alpha-sidebar-account-id">
                <span class="alpha-sidebar-account-name">
                  {authState().status === "logged-in" ? accountLabel() : t("alpha.auth.signIn")}
                </span>
                <span class="alpha-sidebar-account-sub">
                  {authState().status === "logged-in" ? (acctIsPro() ? acctPlanName().toUpperCase() : "免费版") : "点此登录"}
                </span>
              </span>
              <svg class="alpha-acct-chev" viewBox="0 0 12 12" fill="none" aria-hidden="true">
                <path d="M3 7.5L6 4.5L9 7.5" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round" />
              </svg>
            </button>
          </footer>
        </aside>
      </Show>
    </Portal>
  )
}
