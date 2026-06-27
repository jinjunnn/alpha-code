// AlphaHome — the alpha-owned home screen ("/" route), built to the approved mockup
// (docs/designs/2026-06-25-composer-model-redesign/mockup.html · §01 HOME): a greeting, a centered
// shared composer with the full toolbar (+ · 权限 · 模型 · effort · 发送), a workspace chip, and
// recent-project quick-launch pills. Mounted as a route-aware child of AppInterface (same pattern as
// AlphaSidebar) so it has the router + command context; data + send go through the SDK
// (useAlphaProjects). The model/permission chips wire through commands/SDK — opencode's model &
// permission contexts are not exported, so the home composer carries server defaults and switches
// models in-session.

import { createMemo, createSignal, For, Show, onCleanup, type Accessor } from "solid-js"
import { Portal } from "solid-js/web"
import { useLocation, useNavigate } from "@solidjs/router"
import { useCommand } from "@opencode-ai/app"
import { useAlphaProjects, type ServerInfo, type AlphaProject } from "../sidebar/use-projects"
import { sessionHref, newSessionHref, projectLabel } from "../sidebar/route"
import { AddButton, PermChip, EffortChip, ModelChip, composerModelLabel } from "./composer-controls"
import "./home.css"

function greeting(): string {
  const h = new Date().getHours()
  if (h < 5) return "夜深了"
  if (h < 11) return "早上好"
  if (h < 13) return "中午好"
  if (h < 18) return "下午好"
  return "晚上好"
}

type Pop = null | "add" | "perm" | "effort" | "ws"

export function AlphaHome(props: { server: Accessor<ServerInfo | undefined> }) {
  const loc = useLocation()
  const navigate = useNavigate()
  const command = useCommand()
  const { store, startChat } = useAlphaProjects(props.server)

  // The landing path is "/index.html" in the packaged/dev renderer (not "/"), plus "/" and the
  // "new-session" pseudo-route. Match all of them so the alpha home actually covers opencode's
  // bare new-session composer (the bug that kept this screen from ever showing).
  const isHome = createMemo(() => {
    const p = loc.pathname
    return p === "/" || p === "/index.html" || p === "" || p.startsWith("/new-session")
  })
  const visibleProjects = createMemo(() => store.projects.filter((p) => p.worktree !== "/"))
  const hasProjects = createMemo(() => visibleProjects().length > 0)

  const [text, setText] = createSignal("")
  const [chosenWs, setChosenWs] = createSignal<string | undefined>(undefined)
  const [pop, setPop] = createSignal<Pop>(null)
  const [sending, setSending] = createSignal(false)

  const activeWs = createMemo(() => chosenWs() ?? visibleProjects()[0]?.worktree)
  const activeWsLabel = createMemo(() => {
    const w = activeWs()
    const p = visibleProjects().find((x) => x.worktree === w)
    return p?.name ?? (w ? projectLabel(w) : "选择工作区")
  })
  const canSend = createMemo(() => text().trim().length > 0 && !!activeWs() && !sending())

  const submit = async () => {
    if (!canSend()) return
    const ws = activeWs()!
    const body = text().trim()
    setSending(true)
    const id = await startChat(ws, body)
    setSending(false)
    setText("")
    navigate(id ? sessionHref(ws, id) : newSessionHref(ws))
  }

  const onKey = (e: KeyboardEvent) => {
    if (e.key === "Enter" && !e.shiftKey && !e.isComposing) {
      e.preventDefault()
      void submit()
    }
  }

  // Close popovers on an OUTSIDE click. SolidJS delegates events on `document`, so a chip's
  // e.stopPropagation() does NOT stop this same-document listener — without the target guard the
  // chip's own click would re-close the popover it just opened (the "buttons don't work" bug).
  // So: ignore any click that lands inside a popover wrapper; close on everything else.
  const onDoc = (e: MouseEvent) => {
    const t = e.target as Element | null
    if (t && t.closest(".a-pop-wrap")) return
    setPop(null)
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
              <h1 class="a-home-greet">
                {greeting()},<span class="a-home-greet-dim"> 在 workspace 里做点什么?</span>
              </h1>

              {/* ── shared composer ───────────────────────────────────────────── */}
              <div class="a-comp" data-empty={text().trim() ? undefined : ""} onClick={stop}>
                <textarea
                  class="a-comp-input"
                  rows="1"
                  placeholder="问点什么,输入 / 调命令,@ 引用上下文…"
                  value={text()}
                  onInput={(e) => setText(e.currentTarget.value)}
                  onKeyDown={onKey}
                />
                <div class="a-comp-bar">
                  {/* + add — shared AddButton (same menu home + in-session, #31) */}
                  <AddButton />

                  {/* 权限 · 模型 · effort — shared composer-controls (single source + shared state, also used in-session) */}
                  <PermChip />

                  <div class="a-comp-grow" />

                  <ModelChip
                    label={composerModelLabel()}
                    onClick={() => {
                      // The home is an alpha overlay, but opencode's new-session composer IS mounted
                      // behind it (verified: 1 [data-action=prompt-model] present on "/"). The
                      // `model.choose` command is a no-op without a focused session composer, so the
                      // chip read as dead (#10). Forward the click to opencode's real model trigger,
                      // which opens the same 360px picker. Fallback to the command if the button moves.
                      const btn = document.querySelector('[data-action="prompt-model"]') as HTMLElement | null
                      if (btn) btn.click()
                      else command.trigger("model.choose")
                    }}
                  />
                  <EffortChip />

                  {/* send */}
                  <button class="a-comp-send" data-ready={canSend() ? "" : undefined} disabled={!canSend()} onClick={() => void submit()} title="发送">
                    <ArrowUp />
                  </button>
                </div>
              </div>

              {/* workspace chip */}
              <div class="a-home-ws">
                <div class="a-pop-wrap">
                  <button
                    class="a-ws-chip"
                    onClick={(e) => {
                      stop(e)
                      setPop(pop() === "ws" ? null : "ws")
                    }}
                  >
                    <FolderIcon /> {activeWsLabel()}
                    <Chevron />
                  </button>
                  <Show when={pop() === "ws"}>
                    <div class="a-pop a-pop-up" onClick={stop} style={{ "min-width": "240px" }}>
                      <div class="a-pop-label">工作区</div>
                      <For each={visibleProjects()}>
                        {(p) => (
                          <button
                            class="a-pop-item"
                            classList={{ "is-on": activeWs() === p.worktree }}
                            onClick={() => (setChosenWs(p.worktree), setPop(null))}
                          >
                            <span class="a-pico" style={{ background: p.color || "var(--a-accent)" }}>
                              {p.name.slice(0, 1).toUpperCase()}
                            </span>
                            {p.name}
                          </button>
                        )}
                      </For>
                      <div class="a-pop-sep" />
                      <button class="a-pop-item" onClick={() => (setPop(null), command.trigger("project.open"))}>
                        <Plus /> 打开项目…
                      </button>
                    </div>
                  </Show>
                </div>
              </div>

              {/* recent project pills */}
              <Show when={hasProjects()}>
                <div class="a-home-recents">
                  <For each={visibleProjects().slice(0, 6)}>
                    {(p) => <RecentPill project={p} navigate={navigate} setWs={setChosenWs} />}
                  </For>
                </div>
              </Show>
            </div>
          </div>
        </div>
      </Portal>
    </Show>
  )
}

function RecentPill(props: { project: AlphaProject; navigate: (href: string) => void; setWs: (w: string) => void }) {
  const latest = createMemo(() => props.project.sessions[0])
  const go = () => {
    const s = latest()
    props.setWs(props.project.worktree)
    props.navigate(s ? sessionHref(s.directory, s.id) : newSessionHref(props.project.worktree))
  }
  return (
    <button class="a-recent-pill" onClick={go} title={props.project.worktree}>
      <span class="a-pico" style={{ background: props.project.color || "var(--a-accent)" }}>
        {props.project.name.slice(0, 1).toUpperCase()}
      </span>
      <span class="a-recent-name">{props.project.name}</span>
      <Show when={latest()}>
        <span class="a-recent-sub"> · {latest()!.title}</span>
      </Show>
    </button>
  )
}

/* ── inline icons (1.6 stroke, matching the mockup) ──────────────────────────── */
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
const ArrowUp = () => (
  <svg class="a-ic" viewBox={ico}>
    <path d="M12 19V5M5 12l7-7 7 7" />
  </svg>
)
const FileIcon = () => (
  <svg class="a-ic" viewBox={ico}>
    <path d="M14.5 4h-9A1.5 1.5 0 0 0 4 5.5v13A1.5 1.5 0 0 0 5.5 20h13a1.5 1.5 0 0 0 1.5-1.5V9.5z" />
    <path d="M14 4v5h6" />
  </svg>
)
const FolderIcon = () => (
  <svg class="a-ic a-ic-sm" viewBox={ico}>
    <path d="M3 7l2-3h5l2 3h7a1 1 0 0 1 1 1v10a1 1 0 0 1-1 1H3a1 1 0 0 1-1-1V8a1 1 0 0 1 1-1z" />
  </svg>
)
