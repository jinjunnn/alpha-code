// AlphaHome — the alpha-owned home screen ("/" route): greeting + THE shared AlphaComposer
// (REQ-055:与会话页同一个组件、同一份 CSS —— composer 本体全部在 alpha-composer.tsx,这里只剩
// 页面骨架:问候语、错误横幅、工作区 chip)。Mounted as a route-aware child of AppInterface
// (same pattern as AlphaSidebar);data + send go through the SDK (useAlphaProjects)。

import { createMemo, createSignal, For, Show, onCleanup } from "solid-js"
import { Portal } from "solid-js/web"
import { useLocation, useNavigate } from "@solidjs/router"
import { useCommand } from "./providers"
import { type AlphaProjectsApi } from "../sidebar/use-projects"
import { sessionHref, projectLabel } from "../sidebar/route"
import { AlphaComposer } from "./alpha-composer"
import { pushToast } from "./Toast"
import { Banner } from "./Banner"
import { useConfigHealth } from "./use-config-health"
import "./home.css"

function greeting(): string {
  const h = new Date().getHours()
  if (h < 5) return "夜深了"
  if (h < 11) return "早上好"
  if (h < 13) return "中午好"
  if (h < 18) return "下午好"
  return "晚上好"
}

export function AlphaHome(props: { projects: AlphaProjectsApi }) {
  const loc = useLocation()
  const navigate = useNavigate()
  const command = useCommand()
  const { store } = props.projects
  const configHealth = useConfigHealth()

  const isHome = createMemo(() => {
    const p = loc.pathname
    return p === "/" || p === "/index.html" || p === "" || p.startsWith("/new-session")
  })
  const visibleProjects = createMemo(() => store.projects.filter((p) => p.worktree !== "/"))

  const [chosenWs, setChosenWs] = createSignal<string | undefined>(undefined)
  const [wsOpen, setWsOpen] = createSignal(false)

  const activeWs = createMemo(() => chosenWs() ?? visibleProjects()[0]?.worktree)
  const activeWsLabel = createMemo(() => {
    const w = activeWs()
    const p = visibleProjects().find((x) => x.worktree === w)
    return p?.name ?? (w ? projectLabel(w) : "选择工作区")
  })

  const onDoc = (e: MouseEvent) => {
    const t = e.target as Element | null
    if (t && t.closest(".a-pop-wrap")) return
    setWsOpen(false)
  }
  document.addEventListener("click", onDoc)
  onCleanup(() => document.removeEventListener("click", onDoc))
  const stop = (e: Event) => e.stopPropagation()

  return (
    <Show when={isHome()}>
      <Portal>
        <div class="a-ui a-home" data-alpha-home>
          <div class="a-home-stage">
            <div class="a-home-ghost" aria-hidden="true">ALPHA CODE</div>

            <div class="a-home-center">
              <Show when={store.error}>
                <Banner
                  kind="error"
                  title="项目列表加载失败"
                  detail="引擎连接异常或尚未就绪"
                  action={{ label: "重试", onClick: () => void props.projects.reload() }}
                />
              </Show>
              <Show when={configHealth().broken}>
                <Banner
                  kind="warning"
                  title="全局配置未生效"
                  detail={configHealth().reason}
                  action={{ label: "打开配置", onClick: () => void window.api.openPath(configHealth().path ?? "") }}
                />
              </Show>
              <h1 class="a-home-greet">
                {greeting()},<span class="a-home-greet-dim"> 在 workspace 里做点什么?</span>
              </h1>

              {/* ── THE shared composer(与会话页同一组件,REQ-055)────────────── */}
              <AlphaComposer
                mode="home"
                projects={props.projects}
                directory={activeWs}
                onNeedWorkspace={() => {
                  // 零工作区不留死点(REQ-054①):任何需要工作区的控件都引导到选择器
                  setWsOpen(true)
                  pushToast({ kind: "info", title: "请先选择工作区" })
                }}
                onSubmitted={(id) => {
                  const ws = activeWs()
                  if (ws) navigate(sessionHref(ws, id))
                }}
              />

              {/* workspace chip */}
              <div class="a-home-ws">
                <div class="a-pop-wrap">
                  <button
                    class="a-ws-chip"
                    onClick={(e) => {
                      stop(e)
                      setWsOpen(!wsOpen())
                    }}
                  >
                    <FolderIcon /> {activeWsLabel()}
                    <Chevron />
                  </button>
                  <Show when={wsOpen()}>
                    <div class="a-pop a-pop-up" onClick={stop} style={{ "min-width": "240px" }}>
                      <div class="a-pop-label">工作区</div>
                      <For each={visibleProjects()}>
                        {(p) => (
                          <button
                            class="a-pop-item"
                            classList={{ "is-on": activeWs() === p.worktree }}
                            onClick={() => (setChosenWs(p.worktree), setWsOpen(false))}
                          >
                            <span class="a-pico" style={{ background: p.color || "var(--a-accent)" }}>
                              {p.name.slice(0, 1).toUpperCase()}
                            </span>
                            {p.name}
                          </button>
                        )}
                      </For>
                      <div class="a-pop-sep" />
                      <button class="a-pop-item" onClick={() => (setWsOpen(false), command.trigger("project.open"))}>
                        <Plus /> 打开项目…
                      </button>
                    </div>
                  </Show>
                </div>
              </div>
            </div>
          </div>
        </div>
      </Portal>
    </Show>
  )
}

/* ── inline icons ─────────────────────────────────────────────────────────── */
const ico = "0 0 24 24"
const Plus = () => (
  <svg class="a-ic" viewBox={ico}>
    <path d="M12 5v14M5 12h14" />
  </svg>
)
const Chevron = () => (
  <svg class="a-ic a-chev" viewBox={ico}>
    <path d="M6 9l6 6 6-6" />
  </svg>
)
const FolderIcon = () => (
  <svg class="a-ic a-ic-sm" viewBox={ico}>
    <path d="M3 7l2-3h5l2 3h7a1 1 0 0 1 1 1v10a1 1 0 0 1-1 1H3a1 1 0 0 1-1-1V8a1 1 0 0 1 1-1z" />
  </svg>
)
