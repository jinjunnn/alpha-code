// AlphaHome — the first fully alpha-owned screen of the frontend takeover. Replaces opencode's
// home/empty-state on the "/" route with a designed landing: brand, projects + recent sessions,
// and clear primary actions. Mounted as a route-aware child of AppInterface (same pattern as
// AlphaSidebar), so it has the router + command context; data comes from the SDK via useAlphaProjects.

import { createMemo, For, Show, type Accessor } from "solid-js"
import { Portal } from "solid-js/web"
import { useLocation, useNavigate } from "@solidjs/router"
import { useCommand } from "@opencode-ai/app"
import { useAlphaProjects, type ServerInfo, type AlphaProject } from "../sidebar/use-projects"
import { sessionHref, newSessionHref } from "../sidebar/route"
import { Mark } from "../logo-alpha"
import { Button } from "./Button"
import "./home.css"

const RELATIVE = (ms: number): string => {
  if (!ms) return ""
  const diff = Date.now() - ms
  const m = Math.floor(diff / 60000)
  if (m < 1) return "刚刚"
  if (m < 60) return `${m} 分钟前`
  const h = Math.floor(m / 60)
  if (h < 24) return `${h} 小时前`
  const d = Math.floor(h / 24)
  return `${d} 天前`
}

export function AlphaHome(props: { server: Accessor<ServerInfo | undefined> }) {
  const loc = useLocation()
  const navigate = useNavigate()
  const command = useCommand()
  const { store, createSession } = useAlphaProjects(props.server)

  const isHome = createMemo(() => loc.pathname === "/")
  // Hide the global "/" pseudo-project (worktree "/" = opencode's cross-directory bucket),
  // matching the sidebar — it is not a real openable project.
  const visibleProjects = createMemo(() => store.projects.filter((p) => p.worktree !== "/"))
  const hasProjects = createMemo(() => visibleProjects().length > 0)

  const openProject = () => command.trigger("project.open")

  const newChat = async (worktree: string) => {
    const id = await createSession(worktree)
    navigate(id ? sessionHref(worktree, id) : newSessionHref(worktree))
  }

  return (
    <Show when={isHome()}>
      <Portal>
        <div class="a-ui a-home" data-alpha-home>
          <div class="a-home-scroll">
            <div class="a-home-inner">
              <header class="a-home-hero">
                <Mark class="a-home-mark" />
                <div class="a-home-hero-text">
                  <h1 class="a-home-title">ALPHA CODE</h1>
                  <p class="a-home-tagline">在本地用 AI 编码 agent 驱动你的每个项目。</p>
                </div>
              </header>

              <Show
                when={hasProjects()}
                fallback={
                  <div class="a-home-empty">
                    <div class="a-home-empty-art" aria-hidden="true">
                      <Mark class="a-home-empty-mark" />
                    </div>
                    <h2 class="a-home-empty-title">还没有项目</h2>
                    <p class="a-home-empty-sub">打开一个本地目录,开始你的第一个对话。</p>
                    <Button variant="primary" size="lg" onClick={openProject}>
                      打开项目
                    </Button>
                  </div>
                }
              >
                <section class="a-home-section">
                  <div class="a-home-section-head">
                    <span class="a-overline">项目</span>
                    <Button variant="ghost" size="sm" onClick={openProject}>
                      + 打开项目
                    </Button>
                  </div>
                  <div class="a-home-grid">
                    <For each={visibleProjects()}>{(p) => <ProjectCard project={p} onNewChat={newChat} navigate={navigate} />}</For>
                  </div>
                </section>
              </Show>
            </div>
          </div>
        </div>
      </Portal>
    </Show>
  )
}

function ProjectCard(props: {
  project: AlphaProject
  onNewChat: (worktree: string) => void
  navigate: (href: string) => void
}) {
  const recent = createMemo(() => props.project.sessions.slice(0, 4))
  return (
    <div class="a-home-card">
      <div class="a-home-card-head">
        <span class="a-home-card-avatar" style={{ "--_c": props.project.color || "var(--a-accent)" }}>
          {props.project.name.slice(0, 1).toUpperCase()}
        </span>
        <div class="a-home-card-meta">
          <div class="a-home-card-name" title={props.project.worktree}>
            {props.project.name}
          </div>
          <div class="a-home-card-path">{props.project.worktree}</div>
        </div>
      </div>

      <Show
        when={recent().length > 0}
        fallback={<div class="a-home-card-empty">还没有对话</div>}
      >
        <ul class="a-home-sessions">
          <For each={recent()}>
            {(s) => (
              <li>
                <button class="a-home-session" onClick={() => props.navigate(sessionHref(s.directory, s.id))}>
                  <span class="a-home-session-title">{s.title}</span>
                  <span class="a-home-session-time">{RELATIVE(s.updated)}</span>
                </button>
              </li>
            )}
          </For>
        </ul>
      </Show>

      <div class="a-home-card-foot">
        <Button variant="secondary" size="sm" block onClick={() => props.onNewChat(props.project.worktree)}>
          + 新对话
        </Button>
      </div>
    </div>
  )
}
