// AlphaHome — the alpha-owned home screen ("/" route), built to the approved mockup
// (docs/designs/2026-06-25-composer-model-redesign/mockup.html · §01 HOME): a greeting, a centered
// shared composer with the full toolbar (+ · 权限 · 模型 · effort · 发送) and a workspace chip.
// Mounted as a route-aware child of AppInterface (same pattern as
// AlphaSidebar) so it has the router + command context; data + send go through the SDK
// (useAlphaProjects). The model/permission chips wire through commands/SDK — opencode's model &
// permission contexts are not exported, so the home composer carries server defaults and switches
// models in-session.

import { createMemo, createSignal, For, Show, onCleanup } from "solid-js"
import { Portal } from "solid-js/web"
import { useLocation, useNavigate } from "@solidjs/router"
import { useCommand } from "./providers"
import { type AlphaProject, type AlphaProjectsApi } from "../sidebar/use-projects"
import { sessionHref, projectLabel } from "../sidebar/route"
import { AddButton, PermChip, EffortChip, ModelChip, composerModelLabel } from "./composer-controls"
import { createComposerAutocomplete } from "./composer-autocomplete"
import { buildMentionParts, type MentionPart } from "./composer-autocomplete-core"
import { COMPOSER_PLACEHOLDER } from "../../shared/composer-copy"
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

type Pop = null | "add" | "perm" | "effort" | "ws"

export function AlphaHome(props: { projects: AlphaProjectsApi }) {
  const loc = useLocation()
  const navigate = useNavigate()
  const command = useCommand()
  const { store, startChat } = props.projects
  const configHealth = useConfigHealth()

  // The landing path is "/index.html" in the packaged/dev renderer (not "/"), plus "/" and the
  // "new-session" pseudo-route. Match all of them so the alpha home actually covers opencode's
  // bare new-session composer (the bug that kept this screen from ever showing).
  const isHome = createMemo(() => {
    const p = loc.pathname
    return p === "/" || p === "/index.html" || p === "" || p.startsWith("/new-session")
  })
  const visibleProjects = createMemo(() => store.projects.filter((p) => p.worktree !== "/"))

  const [text, setText] = createSignal("")
  const [chosenWs, setChosenWs] = createSignal<string | undefined>(undefined)
  const [pop, setPop] = createSignal<Pop>(null)
  const [sending, setSending] = createSignal(false)
  let taRef: HTMLTextAreaElement | undefined

  const activeWs = createMemo(() => chosenWs() ?? visibleProjects()[0]?.worktree)
  const activeWsLabel = createMemo(() => {
    const w = activeWs()
    const p = visibleProjects().find((x) => x.worktree === w)
    return p?.name ?? (w ? projectLabel(w) : "选择工作区")
  })
  const canSend = createMemo(() => text().trim().length > 0 && !!activeWs() && !sending())
  // Visible cue instead of a silently dead send button (REQ-038 目标③ / 验收④): the user typed but
  // no workspace is selectable/selected — say so next to the workspace chip.
  const needsWs = createMemo(() => text().trim().length > 0 && !activeWs())

  // @ mentions picked from the autocomplete are remembered here and sent as REAL agent/file parts
  // (upstream build-request-parts.ts shapes) — text-only "@name" would be decoration the engine
  // ignores. At submit we only keep mentions whose token is still present in the text.
  // IME guard parity with upstream prompt-input.tsx isImeComposing(): isComposing + a composition
  // signal + the Safari/WebKit keyCode 229 path (REQ-038 目标③ / 验收③). `e.isComposing` alone
  // misses the Enter that COMMITS the composition in some IME/engine combos.
  const [composing, setComposing] = createSignal(false)
  const isImeComposing = (e: KeyboardEvent) => e.isComposing || composing() || e.keyCode === 229

  // Dedup by content is intentional: mentioning the same @agent/@file twice still needs only ONE
  // part (the engine consumes the part list, not per-occurrence text); offsets point at the first
  // occurrence, matching what a single part can express.
  const [mentions, setMentions] = createSignal<MentionPart[]>([])
  const auto = createComposerAutocomplete({
    text,
    setText,
    textarea: () => taRef,
    directory: activeWs,
    command,
    sdk: props.projects.sdk,
    onMention: (m) => setMentions((xs) => [...xs.filter((x) => x.content !== m.content), m]),
    isComposing: isImeComposing,
  })

  const submit = async () => {
    if (!text().trim() || sending()) return
    const ws = activeWs()
    if (!ws) {
      // honest feedback instead of a dead button: point at the workspace chip and open its picker
      setPop("ws")
      return
    }
    const body = text().trim()
    setSending(true)
    const id = await startChat(ws, body, buildMentionParts(body, ws, mentions()))
    setSending(false)
    if (!id) {
      // Was silent: the text got cleared and we navigated to an empty draft, losing the message.
      // Keep the text and tell the user so they can retry (B11).
      pushToast({ kind: "error", title: "发送失败,请重试" })
      return
    }
    setText("")
    setMentions([])
    navigate(sessionHref(ws, id))
  }

  const onKey = (e: KeyboardEvent) => {
    if (auto.onKeyDown(e)) return // menu consumed it (navigate/select/dismiss)
    if (e.key === "Enter" && !e.shiftKey && !isImeComposing(e)) {
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
              {/* B11:project.list 失败此前首页静默空白(店面只在侧栏报错);B23:全局配置被引擎
                  静默清零时给显式告警。 */}
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

              {/* ── shared composer ───────────────────────────────────────────── */}
              <div class="a-comp" data-empty={text().trim() ? undefined : ""} onClick={stop}>
                <auto.Menu />
                <textarea
                  ref={taRef}
                  class="a-comp-input"
                  rows="1"
                  placeholder={COMPOSER_PLACEHOLDER}
                  value={text()}
                  onInput={(e) => {
                    setText(e.currentTarget.value)
                    auto.onInput()
                  }}
                  onKeyDown={onKey}
                  onCompositionStart={() => setComposing(true)}
                  onCompositionEnd={() => setComposing(false)}
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

                  {/* send — disabled only for empty/sending; a missing workspace keeps the button
                      live so clicking it surfaces the workspace picker + hint instead of a dead
                      control (REQ-038 验收④, C28 honest controls) */}
                  <button
                    class="a-comp-send"
                    data-ready={canSend() ? "" : undefined}
                    disabled={!text().trim() || sending()}
                    onClick={() => void submit()}
                    title="发送"
                  >
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
                  <Show when={needsWs()}>
                    <span class="a-ws-hint">请先选择工作区再发送</span>
                  </Show>
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
            </div>
          </div>
        </div>
      </Portal>
    </Show>
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
