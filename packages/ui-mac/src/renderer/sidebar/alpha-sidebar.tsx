// The alpha Codex-style left sidebar. Rendered (via Portal) from inside AppInterface's child
// tree, so it has the router (useNavigate/useLocation) and opencode's command context, while
// its data comes from the SDK (see use-projects.ts). It replaces opencode's own chrome: the
// V2 titlebar tab-strip is hidden and the main content is shifted right by CSS in sidebar.css,
// keyed off body[data-alpha-sidebar]. Single flat column: brand → nav → projects(→sessions),
// the Codex information architecture.

import { createEffect, createMemo, createRoot, createSignal, For, onCleanup, Show } from "solid-js"
import { Portal } from "solid-js/web"
import { useLocation, useNavigate, type NavigateOptions } from "@solidjs/router"
import { ServerConnection, useCommand, useServer, useTabs } from "../alpha-ui/providers"
import { createDefaultWorkspaceDir } from "../alpha-ui/default-workspace"
import { ProjectAvatar, type ProjectAvatarVariant } from "@opencode-ai/ui/v2/project-avatar-v2"
import { Icon } from "@opencode-ai/ui/v2/icon"
import { useTheme } from "@opencode-ai/ui/theme/context"
import { t } from "../i18n"
import { pushToast } from "../alpha-ui/Toast"
import { Mark } from "../logo-alpha"
import { ALPHA_PATHS } from "../../shared/alpha-config"
import { useAlphaEndpoints } from "../use-alpha-endpoints"
import { subscribeAuthState } from "../auth-recovery"
import { homeHref, projectLabel, sessionHref } from "./route"
import { parseRoute } from "../../shared/route-manifest"
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
import { setExtHubOpen, toggleExtHub } from "../extensions/ext-hub-state"
import { setAutomationOpen, toggleAutomation } from "../automations/automation-state"
import { setSettingsOpen } from "../alpha-ui/settings-state"
import { dismissMenu, dismissMenuOnEscape, focusFirstMenuItem } from "./menu-a11y"

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
    const ok = await (
      window as unknown as { api?: { writeClipboard?: (t: string) => Promise<boolean> } }
    ).api?.writeClipboard?.(text)
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

// REQ-126 AC2(#655):当前**已登记**的全页覆盖层就这两个(产物工作台已随 #654 下线)。
// 刻意不建 overlay union 状态机(方案基线 S2:rev1 的设计已被审计判过度工程并撤销)——
// 新增覆盖层时把它加进这里,漏加由 overlay-close 闸门的参数化矩阵判红,不假装架构能挡。
/** 内嵌 sidecar 的稳定 server key,由上游自己的 `ServerConnection.key` 派生 —— 不硬编码
 *  "sidecar" 这个字面量,上游改 key 算法时这里跟着变(改没了则 typecheck 红)。 */
const EMBEDDED_SIDECAR_KEY = ServerConnection.key({ type: "sidecar", variant: "base", http: { url: "" } })

function closeAllOverlays(): void {
  setExtHubOpen(false)
  setAutomationOpen(false)
}

/** 等一个响应式条件成真(一次性 effect,不轮询、不猜时长),返回 `[promise, cancel]`。
 *
 *  两处都需要它,而且都**不能**用现成的 promise 顶替:
 *  · `tabs.ready` 虽然挂了 `.promise`,但同步水合时它是 `undefined`(utils/persist.ts)——
 *    `await undefined` 会在 ready 仍为 false 时放行;
 *  · `createResource` 的 promise 根本不外露,而「还没解析出来」与「解析完了但没有」必须分开
 *    (default-workspace.ts 抬头写明的要害:未解析时拿别的目录顶上去,会话就开在用户从没选过的
 *    项目里)。
 *
 *  `cancel` 存在的理由:条件永不成真、或组件先卸下时,这个 root 会一直挂着;更糟的是它日后一旦
 *  成真,一条早已作废的 startDraft 还会继续往下走并导航一个已经不存在的壳。调用方在卸载时
 *  cancel,`cancel` 同时拆掉 root 并让 promise 落定,由调用方据条件真假决定是否继续。 */
function until(condition: () => boolean): { promise: Promise<void>; cancel: () => void } {
  if (condition()) return { promise: Promise.resolve(), cancel: () => {} }
  let cancel = () => {}
  const promise = new Promise<void>((resolve) => {
    createRoot((dispose) => {
      cancel = () => {
        dispose()
        resolve()
      }
      createEffect(() => {
        if (!condition()) return
        resolve()
        dispose()
      })
    })
  })
  return { promise, cancel }
}

export function AlphaSidebar(props: { projects: AlphaProjectsApi }) {
  const { store, reload, createSession, renameSession, shareSession, deleteSession, copySession } = props.projects
  const routerNavigate = useNavigate()
  const location = useLocation()
  const command = useCommand()
  // REQ-126 CODE-C(#656):建 draft 的两个上游 authority,经 alpha-ui/providers 转口(ADR-016)。
  const tabs = useTabs()
  const server = useServer()
  // 默认对话目录 `~/Alpha` 的唯一解析点(ADR-025 / CODE-D 抽出);这里只**消费**,不另写一份。
  const defaultWorkspaceDir = createDefaultWorkspaceDir()

  // 侧栏卸下时把所有还在等的条件一起取消(见 until 抬头):否则条件晚到会让一条早已作废的
  // startDraft 继续往下走。`wait` 返回「等到了且还活着」——false 一律直接返回,不再往下。
  let sidebarAlive = true
  const pendingWaits = new Set<() => void>()
  onCleanup(() => {
    sidebarAlive = false
    for (const cancel of pendingWaits) cancel()
    pendingWaits.clear()
  })
  const wait = async (condition: () => boolean): Promise<boolean> => {
    const { promise, cancel } = until(condition)
    pendingWaits.add(cancel)
    try {
      await promise
    } finally {
      pendingWaits.delete(cancel)
    }
    return sidebarAlive && condition()
  }

  // REQ-126 AC2 主轨(#655):覆盖层的关闭挂在侧栏导航的**咽喉点**,而不是逐个按钮的 onClick。
  // 旧代码把互斥只写在两个 nav 按钮的内联 onClick 里 —— 逐点枚举对**新入口默认放行**,于是
  // 会话行 / 新对话 / 首页 / 项目行都绕过了它。侧栏一切「要去某处」都经这一个 navigate,所以
  // 在这里关一次即可,且**与目标是否等于当前路由无关**:点当前正在看的那个会话 URL 不变,
  // 下面那条 route effect 根本不触发 —— owner 报的正是这个动作。
  const navigate = (to: string | number, options?: Partial<NavigateOptions>): void => {
    closeAllOverlays()
    if (typeof to === "number") routerNavigate(to)
    else routerNavigate(to, options)
  }

  // Platform auth state, pushed from main (alpha-auth.ts). The footer button reflects it: signed
  // out → start the browser OAuth flow; signed in → show the account and sign out. web is the
  // session authority, so this is just a thin view of main's state (see platform-integration.md §C).
  const [authState, setAuthState] = createSignal<AuthState>({ status: "logged-out", mode: "byok" })
  onCleanup(subscribeAuthState(setAuthState))
  const accountLabel = () => authState().account?.email ?? t("alpha.auth.account")

  // B11 复扫行16:登录链失败(main 只 warn 日志 → 用户「点了没反应」)→ error toast,按 code 给原因。
  onCleanup(
    window.api.auth.onError((e) => {
      const detail = {
        provider_error: t("alpha.auth.errProvider"),
        invalid_callback: t("alpha.auth.errCallback"),
        state_mismatch: t("alpha.auth.errState"),
        exchange_failed: t("alpha.auth.errExchange"),
        contract_incompatible: t("alpha.auth.errContract"),
      }[e.code]
      pushToast({ kind: "error", title: t("alpha.auth.failed"), detail })
    }),
  )

  // 自动化 badge(REQ-021 A1.4):上次运行失败/超时的任务数。跟 automation-event 推送刷新。
  const [automationFailedCount, setAutomationFailedCount] = createSignal(0)
  const refreshAutomationBadge = () => {
    void window.api.automations
      .list()
      .then((r) =>
        setAutomationFailedCount(
          r.tasks.filter((x) => x.lastRun?.status === "failed" || x.lastRun?.status === "timeout").length,
        ),
      )
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
    { k: "light", l: "alpha.sidebar.themeLight" },
    { k: "dark", l: "alpha.sidebar.themeDark" },
    { k: "system", l: "alpha.sidebar.themeSystem" },
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
    const pts = p.data
      .map((v, i) => `${(i / Math.max(1, n - 1)) * w},${(h - 2 - (v / max) * (h - 4) + 2).toFixed(1)}`)
      .join(" ")
    return (
      <svg width={w} height={h} viewBox={`0 0 ${w} ${h}`} preserveAspectRatio="none" aria-hidden="true">
        <polyline
          points={pts}
          fill="none"
          stroke="currentColor"
          stroke-width="1.4"
          stroke-linejoin="round"
          stroke-linecap="round"
        />
      </svg>
    )
  }

  const MenuCommon = () => (
    <>
      <button
        type="button"
        class="alpha-acct-item"
        data-alpha-acct-item="settings"
        onClick={() => {
          setMenuOpen(false)
          // REQ-126 AC7(#658):这里以前发 `settings.open`。那个命令**按路由分裂** —— 上游只在
          // 已被 alpha 顶替的三叶、legacy layout 与 canonical session 路由的
          // `TargetSessionSettingsCommand` 里注册,于是同一个菜单项在会话页能开、首页/新对话页
          // 静默 no-op(上游 `run()` 对未注册 id 直接返回)。alpha 早就自己拥有设置面,直接开它:
          // 与路由无关,也不再经过一个可能没人接的命令总线。
          setSettingsOpen(true)
        }}
      >
        <span class="alpha-acct-ic">⚙</span>{t("alpha.sidebar.settings")}
      </button>
      <div class="alpha-acct-item alpha-acct-appearance">
        <span class="alpha-acct-ic">◐</span>{t("alpha.sidebar.appearance")}
        <span class="alpha-acct-spacer" />
        <span class="alpha-acct-seg">
          <For each={SCHEMES}>
            {(s) => (
              <button data-on={theme.colorScheme() === s.k ? "" : undefined} onClick={() => theme.setColorScheme(s.k)}>
                {t(s.l)}
              </button>
            )}
          </For>
        </span>
      </div>
      <button
        type="button"
        class="alpha-acct-item"
        onClick={() => {
          setMenuOpen(false)
          window.api.openLink("https://alphacodeone.com/feedback")
        }}
      >
        <span class="alpha-acct-ic">?</span>{t("alpha.sidebar.helpFeedback")}
      </button>
      <button
        type="button"
        class="alpha-acct-item"
        onClick={() => {
          setMenuOpen(false)
          void window.api.updater.check()
        }}
      >
        <span class="alpha-acct-ic">↑</span>{t("alpha.sidebar.checkUpdates")}
      </button>
    </>
  )

  // Which project's "⋯" menu is open (by worktree), if any, and where to anchor it. The menu is
  // rendered once at the Portal root with fixed positioning (computed from the trigger button)
  // rather than inside the project row, so the scroll container can't clip it.
  const [menuFor, setMenuFor] = createSignal<string | null>(null)
  // Per-session "⋯" actions (rename inline / share / delete) — the user asked these move off the
  // session header into the sidebar row. Position is computed from the trigger, Portal-rendered.
  const [sessionMenu, setSessionMenu] = createSignal<{
    id: string
    directory: string
    title: string
    top: number
    right: number
  } | null>(null)
  const [editingSession, setEditingSession] = createSignal<string | null>(null)
  let projectMenuTrigger: HTMLElement | undefined
  let sessionMenuTrigger: HTMLElement | undefined
  // Sidebar-native search: filters the project/session list in place (distinct from the "搜索"
  // nav item, which opens opencode's global command palette).
  const [searchQuery, setSearchQuery] = createSignal("")
  const openSessionMenu = (e: MouseEvent, session: { id: string; directory: string; title: string }) => {
    e.preventDefault()
    e.stopPropagation()
    sessionMenuTrigger = e.currentTarget as HTMLElement
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
      dismissMenu(() => setMenuFor(null), projectMenuTrigger)
      return
    }
    projectMenuTrigger = e.currentTarget
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
  // (route-manifest parseRoute,REQ-089). Drives the active-row highlight and "new chat" target.
  const route = createMemo<{ dir?: string; sessionId?: string }>(() => {
    const r = parseRoute(location.pathname)
    if (r.kind === "directory") return { dir: r.directory }
    if (r.kind === "session" && r.directory) return { dir: r.directory, sessionId: r.id }
    return {}
  })

  // REQ-126 AC2 兜底轨(#655):非点击的导航 —— 深链、程序化导航、自动化面板内「回跳会话」——
  // 不经上面那个 navigate 咽喉点,靠这条 effect 收口。两点订正:
  //   · 从「只关定制中心」扩到关**全部**已登记覆盖层(自动化以前根本没人关);
  //   · 监听键从 pathname 扩到 pathname + search —— 新对话是 `/new-session?draftId=…`,
  //     只看 pathname 会漏掉 draft 之间的切换。
  // 用 raw location(而不是收敛过的 route() memo,后者把 home 与 new-session 折成同一个值)。
  // 首帧那次运行不算导航(guard `!== undefined`),否则刚打开的覆盖层会被自己关掉。
  let lastNavKey: string | undefined
  createEffect(() => {
    const key = `${location.pathname}${location.search}`
    if (lastNavKey !== undefined && key !== lastNavKey) closeAllOverlays()
    lastNavKey = key
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

  // Reflect sidebar visibility onto <body> so sidebar.css can shift opencode's content.
  createEffect(() => {
    document.body.dataset.alphaSidebar = sidebarCollapsed() ? "collapsed" : "open"
  })
  onCleanup(() => {
    delete document.body.dataset.alphaSidebar
  })

  // Responsive auto-collapse of OUR OWN left sidebar. Reversible by construction — folding on the
  // downward crossing of the threshold and restoring on the upward crossing — so a narrow→wide
  // resize never strands it hidden. The override is transient (it leaves the user's persisted
  // preference alone, see setSidebarAutoCollapsed), so a manual collapse underneath is preserved.
  //
  // REQ-126 AC7(#658):这里以前还自动折叠上游的右侧 review 面板 —— 读
  // `[aria-controls="review-panel"][aria-expanded]` 这对 ARIA、经 `review.toggle` 开关。两端都已
  // 随上游 session 叶退役:alpha 会话工作区的右栏是自己的(`aria-controls="alpha-session-rail-host"`),
  // 命令没有任何注册处 → 那段代码永远读不到 true、永远 no-op。连同下面的浮动终端/审查按钮一起退休。
  const SIDEBAR_COLLAPSE_W = 768 // below this, collapse the left sidebar (opencode's own
  // desktop panels disappear under 768 too, so the two breakpoints stay coherent)

  let prevWidth = window.innerWidth
  let resizeScheduled = false
  const onResize = () => {
    if (resizeScheduled) return
    resizeScheduled = true
    requestAnimationFrame(() => {
      resizeScheduled = false
      const w = window.innerWidth

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
  // bucket). Since the ADR-025 2026-07-28 revision this is only the LAST-RESORT fallback for a new
  // chat (default conversation directory first); it still backs the home composer's own defaulting.
  // Reads displayProjects so the per-directory split of the global bucket (e.g. a loose "workspace"
  // folder) is eligible too.
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

  // REQ-126 不变量 4(#656):`{server, directory}` 必须**同源**,取不到就 fail-closed。
  //
  // 默认对话目录 `~/Alpha` 是主进程在**宿主机**上供给的(main/alpha-user-workspace.ts),侧栏那份
  // 项目列表也来自**本地 sidecar** 的 SDK client(renderer/index.tsx 的 sidebarServer)。当前 server
  // 却可能是 WSL / remote(wsl/connections.ts)——把宿主机路径配到远端 server 上,会开出一个那台
  // 机器上根本不存在的目录。所以别的 server 只认**该 server 自己**已知的项目;一个都没有就要求
  // 用户显式选择,而不是猜。
  //
  // 判据刻意**不用** `server.isLocal()`:上游把「loopback 的 http 连接」也算 local
  // (context/server.tsx 的 ServerConnection.local),而一条 127.0.0.1 的 http 连接完全可能是 SSH
  // 隧道或远端反代 —— 那台机器上没有宿主机的 `~/Alpha`。只认内嵌 sidecar 的稳定身份
  // (`ServerConnection.key`:base sidecar 恒为 "sidecar",WSL 是 `wsl:*`、SSH 是 `ssh:*`),
  // 它不随随机端口漂移,也不会把隧道误判成本机。
  type DraftTarget = { directory: string; isDefaultWorkspace: boolean }
  const resolveDraftTarget = async (): Promise<DraftTarget | undefined> => {
    if (server.key !== EMBEDDED_SIDECAR_KEY) {
      const known = server.projects.list()[0]?.worktree
      return known ? { directory: known, isDefaultWorkspace: false } : undefined
    }
    // ADR-025 修订(2026-07-28):未显式选择目录时一律落默认对话目录,不再「上次使用优先」——
    // owner 报的正是新对话开在 alpha-code 而不是 ~/Alpha。项目只做兜底。
    if (!(await wait(() => !defaultWorkspaceDir.loading))) return undefined
    const preferred = defaultWorkspaceDir()
    if (preferred) return { directory: preferred, isDefaultWorkspace: true }
    const fallback = mostRecentConcreteDir()
    return fallback ? { directory: fallback, isDefaultWorkspace: false } : undefined
  }

  // REQ-126 AC1/AC5(#656):alpha 新对话的**唯一**入口 —— 直接建 draft,不再借上游 legacy
  // admission 路由。
  //
  // 旧写法是 `navigate(newSessionHref(dir))` → `/<b64dir>/session`。那条路由在两种 layout 下都挂在
  // 上游 `LegacyServerLayout` 之下(packages/app/src/app.tsx),于是先整套挂起上游自己的左栏
  // (pages/layout.tsx 的 SidebarContent)与会话叶,叶再在 createEffect 里调 `tabs.newDraft` 跳到
  // `/new-session?draftId=…` —— 一次「新对话」挂两套壳再被替换,这就是 owner 报的闪烁与「最左侧
  // 闪出不该出现的内容」。这里直接调 newDraft(它自带跳转),admission 那一跳整个消失。
  //
  // `/:dir/session` 路由本身**保留**给深链兼容(pages/layout/deep-links.ts 仍导航到它),本票只保证
  // alpha 自己的入口不再进它。
  let draftInFlight = false
  const startDraft = async (): Promise<void> => {
    // 关闭覆盖层属于导航**意图**,不属于导航结果(REQ-126 AC2 / #655 审计 Major):这里之后全是
    // await,等结果就等于让覆盖层继续压在目标页面上。
    closeAllOverlays()
    // AC4 最小 in-flight 去重:建 draft 全程异步(等 tabs 水合 → 等默认目录落定 → ensure 供给 →
    // newDraft 自己的 startTransition),双击的第二下正落在这个窗口里。它只挡"上一次还没落地"的
    // 重入,不是"一个会话只准有一个 draft"的锁。
    if (draftInFlight) return
    draftInFlight = true
    try {
      // 上游 tabs 是 persisted store:水合完成前写进去的 tab 会被随后的读盘结果覆盖,
      // draft 连同它的目录一起消失。
      if (!(await wait(() => tabs.ready()))) return
      const target = await resolveDraftTarget()
      if (!sidebarAlive) return
      if (!target) {
        pushToast({ kind: "error", title: t("alpha.sidebar.newChatNoWorkspace") })
        return
      }
      // 不变量 5:目标是默认对话目录时,必须在**建 draft 之前**真的供给成功。这条 IPC 失败返回
      // `{ok:false}` 而不 throw,不看返回值 = 把会话开在一个不存在的目录上,而建 draft 又不碰引擎
      // (没有"引擎会如实报错"这层兜底),所以只能在这里拦。
      if (target.isDefaultWorkspace && !(await props.projects.ensureDefaultWorkspace(target.directory))) {
        pushToast({ kind: "error", title: t("alpha.sidebar.newChatWorkspaceFailed") })
        return
      }
      await tabs.newDraft({ server: server.key, directory: target.directory })
    } finally {
      draftInFlight = false
    }
  }

  // On app launch, land on a fresh draft (首页 composer 形态:ALPHA CODE wordmark + prompt box) —
  // not whatever opencode restores (it reopens the last session), and not the recent-sessions search
  // grid that bare "/" renders. Fires once, after the project list loads. Goes through the same
  // startDraft as the sidebar button (REQ-126 §4 序 3, one entry point), so cold start no longer mounts the
  // legacy shell either. No `replace` needed any more: the router already starts at "/", so Back
  // lands on home rather than bouncing through the admission route.
  let didLaunchNav = false
  createEffect(() => {
    if (didLaunchNav || !store.ready) return
    didLaunchNav = true
    void startDraft()
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
    // REQ-126 AC2(#655 审计 Major):这条路径的导航发生在 `await createSession(...)` **之后**,
    // 而真实创建是多个 await(use-projects.ts:294-307)。只靠下面 navigate 里的咽喉点,慢请求
    // 或未决请求期间覆盖层会一直压在目标页面上 —— owner 报的原始症状在这条路径上照样复现。
    // 关闭属于**导航意图**,不属于导航结果,所以提到第一个 await 之前。
    closeAllOverlays()
    setProjectExpanded(worktree, true)
    const id = await createSession(worktree)
    // REQ-126 不变量 1(#656):失败**不再**回退到 `newSessionHref(worktree)` —— 那个 href 就是
    // legacy admission 路由(sidebar/route.ts 的 directorySession),回退等于给 alpha 自己留了
    // 第二条进 admission 的入口。失败就如实说失败,不假装"已经给你开了个草稿"。
    if (id) navigate(sessionHref(worktree, id))
    else pushToast({ kind: "error", title: t("alpha.sidebar.newChatFailed") })
  }

  // "新对话" — 单一入口(见 startDraft)。此前它挑的目录是「当前项目 → 最近项目」,这既是
  // owner 报的"开在 alpha-code 而不是 ~/Alpha"(ADR-025 2026-07-28 修订推翻了该优先级),也是
  // 走 legacy admission 路由的那个入口本身。
  const newChat = () => void startDraft()

  // REQ-126 AC7(#658)「打开项目」。以前发上游 `project.open`,它只在 legacy layout
  // (`pages/layout.tsx`)注册 —— alpha 路由下只有 admission 那一跳短暂挂载过 → 空项目态那个按钮
  // 基本上永远点不动。而且就算接上,上游那条命令只把目录加进**上游 layout 自己的**项目列表,与
  // 侧栏读的引擎 project.list 是两套(REQ-068 已经为首页 chip 记过同一课)。所以改走 alpha 自己的
  // 路径:选目录 → 直接在该目录开一段对话(项目由引擎在首条消息时正式注册)。取消 = 静默。
  const openProject = async () => {
    let picked: string | string[] | null = null
    try {
      picked = await window.api.openDirectoryPicker({ title: t("alpha.sidebar.openProject") })
    } catch {
      pushToast({ kind: "error", title: t("alpha.home.openProjectFailed") })
      return
    }
    const directory = Array.isArray(picked) ? picked[0] : picked
    if (typeof directory !== "string" || !directory) return
    await startChat(directory)
  }

  // REQ-126 AC7(#658)壳级命令注册。桌面菜单(`main/menu.ts` → `sendMenuCommand` → 渲染进程
  // `cmd.trigger(id)`)发的这几个 id,上游的注册处全在已被 alpha 顶替的叶或 legacy layout 里 ——
  // 于是 Cmd+, / Cmd+O / Shift+Cmd+S / Cmd+B 在 alpha 的路由上按下去什么都不发生。
  // 侧栏本来就是这几件事的所有者(设置、新对话、打开项目、折叠),所以由它承接:挂载点与路由
  // 无关,注册也就与路由无关。键位沿用上游原值,免得抢注册反而把快捷键抹掉。
  // `hidden` = 不进命令面板列表(alpha 的「搜索」是会话搜索,不列命令)。
  //
  // **刻意不含 `common.goBack` / `common.goForward`**:上游 Titlebar 在首页/新对话页也注册同名
  // id,而重复 id 保留第一项 + Titlebar 先挂载 → 那两条路由永远是它赢,且它走的是只有 `["/"]`
  // 的私有 history(静默 no-op)。同一菜单项在不同路由两种行为,不是"语义相同"。这两条已在
  // `shared/desktop-menu-policy.ts` 显式退休;左上角那对按钮直连 `navigate(±1)`,始终有效。
  // 其余**退休**的菜单项同理,都从那份发布面直接删掉。
  command.register("alpha.shell", () => [
    { id: "settings.open", title: t("alpha.sidebar.settings"), keybind: "mod+comma", hidden: true, onSelect: () => setSettingsOpen(true) },
    { id: "session.new", title: t("alpha.sidebar.newChat"), keybind: "mod+shift+s", hidden: true, onSelect: () => newChat() },
    { id: "project.open", title: t("alpha.sidebar.openProject"), keybind: "mod+o", hidden: true, onSelect: () => void openProject() },
    { id: "sidebar.toggle", title: t("alpha.sidebar.hide"), keybind: "mod+b", hidden: true, onSelect: () => toggleSidebar() },
  ])

  const archiveProject = (worktree: string) => {
    dismissMenu(() => setMenuFor(null), projectMenuTrigger)
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
            <div class="alpha-menu-backdrop" onClick={() => dismissMenu(() => setMenuFor(null), projectMenuTrigger)} />
            <div
              ref={focusFirstMenuItem}
              class="alpha-project-menu"
              role="menu"
              style={{ top: `${menuPos()?.top ?? 0}px`, right: `${menuPos()?.right ?? 8}px` }}
              onKeyDown={(event) => dismissMenuOnEscape(event, () => setMenuFor(null), projectMenuTrigger)}
            >
              <button
                type="button"
                class="alpha-project-menu-item"
                role="menuitem"
                onClick={() => archiveProject(worktree())}
              >
                <svg class="alpha-project-menu-icon" viewBox="0 0 16 16" fill="none" aria-hidden="true">
                  <rect x="2.25" y="3" width="11.5" height="2.4" rx="0.6" stroke="currentColor" stroke-width="1.2" />
                  <path
                    d="M3.3 5.6h9.4V12a1 1 0 0 1-1 1H4.3a1 1 0 0 1-1-1V5.6Z"
                    stroke="currentColor"
                    stroke-width="1.2"
                  />
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
            <div class="alpha-menu-backdrop" onClick={() => dismissMenu(() => setSessionMenu(null), sessionMenuTrigger)} />
            <div
              ref={focusFirstMenuItem}
              class="alpha-project-menu"
              role="menu"
              style={{ top: `${m().top}px`, right: `${m().right}px` }}
              onKeyDown={(event) => dismissMenuOnEscape(event, () => setSessionMenu(null), sessionMenuTrigger)}
            >
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
                  <path
                    d="M11.5 2.5a1.4 1.4 0 0 1 2 2L6 12l-3 .8.8-3 7.7-7.3Z"
                    stroke="currentColor"
                    stroke-width="1.2"
                    stroke-linejoin="round"
                  />
                </svg>
                <span>{t("alpha.sidebar.rename")}</span>
              </button>
              <button
                type="button"
                class="alpha-project-menu-item"
                role="menuitem"
                onClick={() => {
                  const session = m()
                  dismissMenu(() => setSessionMenu(null), sessionMenuTrigger)
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
                  <path
                    d="M8 10V2.5M5.5 5 8 2.5 10.5 5M3 9v3.5a1 1 0 0 0 1 1h8a1 1 0 0 0 1-1V9"
                    stroke="currentColor"
                    stroke-width="1.2"
                    stroke-linecap="round"
                    stroke-linejoin="round"
                  />
                </svg>
                <span>{t("alpha.sidebar.share")}</span>
              </button>
              <button
                type="button"
                class="alpha-project-menu-item"
                role="menuitem"
                onClick={() => {
                  const id = m().id
                  dismissMenu(() => setSessionMenu(null), sessionMenuTrigger)
                  void (async () => {
                    const text = await copySession(id)
                    if (!text) {
                      pushToast({ kind: "error", title: t("alpha.sidebar.copyEmpty") })
                      return
                    }
                    const ok = await copyText(text)
                    pushToast(ok ? { kind: "success", title: t("alpha.sidebar.copyDone") } : { kind: "error", title: t("alpha.sidebar.copyFailed") })
                  })()
                }}
              >
                <svg class="alpha-project-menu-icon" viewBox="0 0 16 16" fill="none" aria-hidden="true">
                  <rect x="5" y="5" width="8" height="9" rx="1.3" stroke="currentColor" stroke-width="1.2" />
                  <path
                    d="M11 5V3.8a1 1 0 0 0-1-1H4a1 1 0 0 0-1 1V11a1 1 0 0 0 1 1h1"
                    stroke="currentColor"
                    stroke-width="1.2"
                    stroke-linecap="round"
                    stroke-linejoin="round"
                  />
                </svg>
                <span>{t("alpha.sidebar.copyConversation")}</span>
              </button>
              <button
                type="button"
                class="alpha-project-menu-item alpha-project-menu-item-danger"
                role="menuitem"
                onClick={() => {
                  const id = m().id
                  dismissMenu(() => setSessionMenu(null), sessionMenuTrigger)
                  void (async () => {
                    const ok = await deleteSession(id)
                    if (!ok) pushToast({ kind: "error", title: t("alpha.sidebar.deleteFailed") })
                  })()
                }}
              >
                <svg class="alpha-project-menu-icon" viewBox="0 0 16 16" fill="none" aria-hidden="true">
                  <path
                    d="M3 4.5h10M6.5 4.5V3.4a.9.9 0 0 1 .9-.9h1.2a.9.9 0 0 1 .9.9V4.5M11.7 4.5 11.2 12a1 1 0 0 1-1 .95H5.8a1 1 0 0 1-1-.95L4.3 4.5"
                    stroke="currentColor"
                    stroke-width="1.2"
                    stroke-linecap="round"
                    stroke-linejoin="round"
                  />
                </svg>
                <span>{t("alpha.sidebar.delete")}</span>
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
            <path
              d="M10 3.5 5.5 8l4.5 4.5"
              stroke="currentColor"
              stroke-width="1.5"
              stroke-linecap="round"
              stroke-linejoin="round"
            />
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
            <path
              d="M6 3.5 10.5 8 6 12.5"
              stroke="currentColor"
              stroke-width="1.5"
              stroke-linecap="round"
              stroke-linejoin="round"
            />
          </svg>
        </button>
      </div>

      {/* REQ-126 AC7(#658):右上角浮动的「终端 / 审查」两个按钮已退休。它们发的
          `terminal.toggle` / `review.toggle` 只在上游 session 叶注册,而那片叶已被 alpha 会话
          工作区顶替 → 命令无人接、点了静默无事。会话页 CSS 曾把这一对藏起来
          (`body:has([data-alpha-session-workspace])`),但 `inWorkspace()` 在**新对话页**也为真,
          于是新对话页上它们既可见又无效 —— 而那一页根本没有终端/审查能力。会话页要用的同类开关
          在工作区自己的 46px 顶栏上(session-workspace-shell.tsx),那两个是活的,不受影响。 */}

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
              <span class="alpha-sidebar-wordmark">{t("alpha.brand.wordmark")}</span>
            </button>
          </header>

          <nav class="alpha-sidebar-nav">
            <button
              type="button"
              class="alpha-sidebar-nav-item"
              data-alpha-sidebar-nav="new-chat"
              onClick={() => newChat()}
            >
              <Icon name="plus" class="alpha-sidebar-nav-icon" />
              <span>{t("alpha.sidebar.newChat")}</span>
            </button>
            <button
              type="button"
              class="alpha-sidebar-nav-item"
              data-alpha-sidebar-nav="search"
              onClick={() => command.show()}
            >
              <Icon name="magnifying-glass" class="alpha-sidebar-nav-icon" />
              <span>{t("alpha.sidebar.search")}</span>
            </button>
            <button
              type="button"
              class="alpha-sidebar-nav-item"
              onClick={() => {
                setAutomationOpen(false) // 全页面板互斥
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
            {/* REQ-126 AC3(#654):产物工作台的侧栏入口已下线 —— 产物只经会话右栏 artifacts 面板到达。 */}
          </nav>

          <Show when={visibleProjects().length > 0}>
            <div class="alpha-sidebar-search">
              <Icon name="magnifying-glass" class="alpha-sidebar-search-icon" />
              <input
                class="alpha-sidebar-search-input"
                type="text"
                placeholder={t("alpha.sidebar.searchProjects")}
                value={searchQuery()}
                onInput={(e) => setSearchQuery(e.currentTarget.value)}
              />
              <Show when={searchQuery() !== ""}>
                <button
                  type="button"
                  class="alpha-sidebar-search-clear"
                  aria-label={t("alpha.sidebar.clearSearch")}
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
                            <div
                              class="alpha-session-row"
                              data-active={route().sessionId === session.id ? "" : undefined}
                            >
                              <Show
                                when={isSessionUnread(session.id, session.updated) && route().sessionId !== session.id}
                              >
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
                                      aria-label={t("alpha.sidebar.sessionActions")}
                                      aria-haspopup="menu"
                                      aria-expanded={sessionMenu()?.id === session.id}
                                      onClick={(e) => openSessionMenu(e, session)}
                                    >
                                      <svg
                                        viewBox="0 0 16 16"
                                        width="14"
                                        height="14"
                                        fill="currentColor"
                                        aria-hidden="true"
                                      >
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
                                        (ok) =>
                                          ok || pushToast({ kind: "error", title: t("alpha.sidebar.renameFailed") }),
                                      )
                                    } else if (e.key === "Escape") {
                                      setEditingSession(null)
                                    }
                                  }}
                                  onBlur={(e) => {
                                    const v = e.currentTarget.value
                                    setEditingSession(null)
                                    void renameSession(session.id, v).then(
                                      (ok) =>
                                        ok || pushToast({ kind: "error", title: t("alpha.sidebar.renameFailed") }),
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
              <div class="alpha-sidebar-empty">{t("alpha.sidebar.noMatches")}</div>
            </Show>
            <Show when={store.ready && !store.error && visibleProjects().length === 0 && archivedCount() === 0}>
              <div class="alpha-sidebar-empty alpha-sidebar-empty-projects">
                <p>{t("alpha.sidebar.noProjects")}</p>
                <button
                  type="button"
                  class="alpha-sidebar-open-project"
                  data-alpha-sidebar-open-project
                  onClick={() => void openProject()}
                >
                  {t("alpha.sidebar.openProject")}
                </button>
              </div>
            </Show>
            {/* B11: project.list failure previously left the sidebar silently blank (store.error was
                never rendered anywhere). Surface it with a retry instead of a dead empty pane. */}
            <Show when={store.error}>
              <div class="alpha-sidebar-empty alpha-sidebar-empty-projects">
                <p>{t("alpha.sidebar.projectsFailed")}</p>
                <button type="button" class="alpha-sidebar-open-project" onClick={() => void reload()}>
                  {t("alpha.common.retry")}
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
                          <div class="alpha-acct-name">{t("alpha.sidebar.signedOut")}</div>
                          <div class="alpha-acct-email">{t("alpha.sidebar.loginCloud")}</div>
                        </div>
                      </div>
                      <button
                        class="alpha-acct-login"
                        onClick={() => {
                          setMenuOpen(false)
                          void window.api.auth.start()
                        }}
                      >
                        ⊕ {t("alpha.auth.signIn")}
                      </button>
                      <MenuCommon />
                    </>
                  }
                >
                  <div class="alpha-acct-head">
                    <span class="alpha-acct-av">{acctInitial()}</span>
                    <div class="alpha-acct-id">
                      <div class="alpha-acct-name">{t("alpha.sidebar.yourAccount")}</div>
                      <div class="alpha-acct-email">{accountLabel()}</div>
                    </div>
                    <span class="alpha-acct-plan" data-pro={acctIsPro() ? "" : undefined}>
                      {acctIsPro() ? acctPlanName().toUpperCase() : t("alpha.sidebar.freePlan")}
                    </span>
                  </div>
                  <div class="alpha-acct-card">
                    <div class="alpha-acct-row">
                      <span class="alpha-acct-k">{t("alpha.sidebar.subscription")}</span>
                      {/* B11:读取失败时不装「未订阅」(状态未知),与其余行一致显示 pending/错误占位 */}
                      <Show
                        when={summary() || summaryState() !== "error"}
                        fallback={<span class="alpha-acct-pending">{pendingText()}</span>}
                      >
                        <span class="alpha-acct-v">{activePlan()?.name ?? (isPro() ? plan() : t("alpha.sidebar.notSubscribed"))}</span>
                      </Show>
                    </div>
                    <div class="alpha-acct-row">
                      <span class="alpha-acct-k">{t("alpha.sidebar.balance")}</span>
                      <Show when={summary()} fallback={<span class="alpha-acct-pending">{pendingText()}</span>}>
                        <span class="alpha-acct-v">{fmtYuan(summary()!.balanceFen)}</span>
                      </Show>
                    </div>
                    <div class="alpha-acct-row">
                      <span class="alpha-acct-k">{t("alpha.sidebar.fiveHour")}</span>
                      <Show when={summary()} fallback={<span class="alpha-acct-pending">{pendingText()}</span>}>
                        <Show when={activePlan()} fallback={<span class="alpha-acct-pending">{t("alpha.sidebar.metered")}</span>}>
                          <span class="alpha-acct-v">
                            {activePlan()!.window5h.usedCredits.toLocaleString()} /{" "}
                            {activePlan()!.window5h.limitCredits.toLocaleString()}
                          </span>
                        </Show>
                      </Show>
                    </div>
                    <div class="alpha-acct-row">
                      <span class="alpha-acct-k">{t("alpha.sidebar.sevenDay")}</span>
                      <Show when={summary()} fallback={<span class="alpha-acct-pending">{pendingText()}</span>}>
                        <Show when={activePlan()} fallback={<span class="alpha-acct-pending">{t("alpha.sidebar.metered")}</span>}>
                          <span class="alpha-acct-v">
                            {activePlan()!.window7d.usedCredits.toLocaleString()} /{" "}
                            {activePlan()!.window7d.limitCredits.toLocaleString()}
                          </span>
                        </Show>
                      </Show>
                    </div>
                    <div class="alpha-acct-row">
                      <span class="alpha-acct-k">{t("alpha.sidebar.fourteenDay")}</span>
                      <Show
                        when={summary() && summary()!.usageSeries.length > 0}
                        fallback={<span class="alpha-acct-pending">{summary() ? t("alpha.sidebar.noData") : pendingText()}</span>}
                      >
                        <Sparkline data={summary()!.usageSeries.map((p) => p.tokens)} />
                      </Show>
                    </div>
                  </div>
                  <div class="alpha-acct-cta">
                    <Show when={!acctIsPro()}>
                      <button class="alpha-acct-btn primary" onClick={() => window.api.openLink(subscribeUrl())}>
                        {t("alpha.sidebar.upgrade")}
                      </button>
                    </Show>
                    <button class="alpha-acct-btn" onClick={() => window.api.openLink(rechargeUrl())}>
                      {t("alpha.sidebar.recharge")}
                    </button>
                    <Show when={acctIsPro()}>
                      <button class="alpha-acct-btn" onClick={() => window.api.openLink(subscribeUrl())}>
                        {t("alpha.sidebar.manageSubscription")}
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
                    <span class="alpha-acct-ic">⎋</span>{t("alpha.sidebar.signOut")}
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
                  {authState().status === "logged-in"
                    ? acctIsPro()
                      ? acctPlanName().toUpperCase()
                      : t("alpha.sidebar.freePlan")
                    : t("alpha.sidebar.clickLogin")}
                </span>
              </span>
              <svg class="alpha-acct-chev" viewBox="0 0 12 12" fill="none" aria-hidden="true">
                <path
                  d="M3 7.5L6 4.5L9 7.5"
                  stroke="currentColor"
                  stroke-width="1.4"
                  stroke-linecap="round"
                  stroke-linejoin="round"
                />
              </svg>
            </button>
          </footer>
        </aside>
      </Show>
    </Portal>
  )
}
