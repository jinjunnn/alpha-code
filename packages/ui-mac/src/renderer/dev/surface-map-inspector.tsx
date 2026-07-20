import { Icon } from "@opencode-ai/ui/icon"
import { useLocation } from "@solidjs/router"
import { createEffect, createMemo, createSignal, For, onCleanup, Show } from "solid-js"
import { Portal } from "solid-js/web"
import type { ResolvedSurfaces } from "../../shared/alpha-surfaces"
import {
  FRONTEND_SURFACE_MANIFEST,
  FRONTEND_SURFACE_MANIFEST_VERSION,
  frontendSurfaceById,
  frontendSurfaceIdForRoute,
  type FrontendSurfaceEntry,
  type FrontendSurfaceLineage,
  type FrontendSurfaceMount,
} from "../../shared/frontend-surface-manifest"
import { parseRoute } from "../../shared/legacy-route-abi"
import { workbenchOpen } from "../alpha-ui/artifact-workbench/workbench-state"
import { automationOpen } from "../automations/automation-state"
import { extHubOpen } from "../extensions/ext-hub-state"
import {
  activeSurfaceIds,
  filterSurfaceMap,
  surfaceRuntimeState,
  type SurfaceMapLineageFilter,
  type SurfaceMapMountFilter,
} from "./surface-map-model"
import "./surface-map-inspector.css"

const LINEAGE_LABELS: Record<FrontendSurfaceLineage, string> = {
  alpha: "Alpha",
  opencode: "OpenCode",
  hybrid: "Hybrid",
}

const MOUNT_LABELS: Record<FrontendSurfaceMount["kind"], string> = {
  route: "Route",
  overlay: "Overlay",
  inline: "Inline",
  boot: "Boot",
}

export default function SurfaceMapInspector(props: { resolved?: ResolvedSurfaces | null }) {
  const location = useLocation()
  const [open, setOpen] = createSignal(false)
  const [query, setQuery] = createSignal("")
  const [lineage, setLineage] = createSignal<SurfaceMapLineageFilter>("all")
  const [mount, setMount] = createSignal<SurfaceMapMountFilter>("all")
  const currentRoute = createMemo(() => frontendSurfaceIdForRoute(parseRoute(location.pathname, location.search)))
  const active = createMemo(() =>
    activeSurfaceIds(currentRoute(), {
      extensions: extHubOpen(),
      automations: automationOpen(),
      artifacts: workbenchOpen(),
      inspector: open(),
    }),
  )
  const filtered = createMemo(() => filterSurfaceMap(query(), lineage(), mount()))
  const routeSurfaces = FRONTEND_SURFACE_MANIFEST.filter(
    (surface: FrontendSurfaceEntry) => surface.mount.kind === "route",
  )
  const counts = (value: FrontendSurfaceLineage) =>
    FRONTEND_SURFACE_MANIFEST.filter((surface) => surface.lineage === value).length

  let trigger: HTMLButtonElement | undefined
  let panel: HTMLElement | undefined
  let search: HTMLInputElement | undefined
  let previousFocus: HTMLElement | undefined

  const show = () => {
    previousFocus = document.activeElement instanceof HTMLElement ? document.activeElement : undefined
    setOpen(true)
  }
  const close = () => {
    setOpen(false)
    queueMicrotask(() => previousFocus?.focus())
  }
  const toggle = () => (open() ? close() : show())

  createEffect(() => {
    if (!open()) return
    queueMicrotask(() => search?.focus())
  })

  const onShortcut = (event: KeyboardEvent) => {
    if (!(event.metaKey || event.ctrlKey) || !event.shiftKey || event.key.toLocaleLowerCase() !== "m") return
    event.preventDefault()
    toggle()
  }
  document.addEventListener("keydown", onShortcut)
  onCleanup(() => document.removeEventListener("keydown", onShortcut))

  const onPanelKeyDown = (event: KeyboardEvent) => {
    if (event.key === "Escape") {
      event.preventDefault()
      close()
      return
    }
    if (event.key !== "Tab" || !panel) return
    const focusable = Array.from(
      panel.querySelectorAll<HTMLElement>(
        'button:not([disabled]), input:not([disabled]), select:not([disabled]), [href], [tabindex]:not([tabindex="-1"])',
      ),
    ).filter((element) => element.offsetParent !== null)
    if (focusable.length === 0) return
    const first = focusable[0]
    const last = focusable[focusable.length - 1]
    if (event.shiftKey && document.activeElement === first) {
      event.preventDefault()
      last.focus()
      return
    }
    if (!event.shiftKey && document.activeElement === last) {
      event.preventDefault()
      first.focus()
    }
  }

  return (
    <>
      <button
        ref={trigger}
        type="button"
        class="a-ui a-smap-trigger"
        aria-label="打开 Frontend Surface Map 检查面板"
        aria-keyshortcuts="Meta+Shift+M Control+Shift+M"
        onClick={show}
      >
        <Icon name="code-lines" size="small" />
        <span>MAP</span>
        <kbd>{navigator.userAgent.includes("Mac") ? "⌘⇧M" : "Ctrl⇧M"}</kbd>
      </button>

      <Show when={open()}>
        <Portal>
          <main
            ref={panel}
            class="a-ui a-smap-root"
            role="dialog"
            aria-modal="true"
            aria-labelledby="a-smap-title"
            onKeyDown={onPanelKeyDown}
          >
            <header class="a-smap-header">
              <div>
                <div class="a-overline">Development inspector · manifest v{FRONTEND_SURFACE_MANIFEST_VERSION}</div>
                <h1 id="a-smap-title">Frontend Surface Map</h1>
                <p>检查 Alpha / OpenCode 所有权、挂载类型、运行时模式与跳转关系。</p>
              </div>
              <div class="a-smap-header-meta" aria-label="当前路由">
                <span>Router</span>
                <code>{location.pathname + location.search}</code>
                <span>Shell</span>
                <code>{window.location.pathname}</code>
              </div>
              <button type="button" class="a-smap-close" aria-label="关闭 Surface Map" onClick={close}>
                <Icon name="close" />
              </button>
            </header>

            <div class="a-smap-scroll">
              <section class="a-smap-summary" aria-label="Surface 血统摘要">
                <button
                  type="button"
                  class="a-smap-stat"
                  data-lineage="alpha"
                  aria-pressed={lineage() === "alpha"}
                  onClick={() => setLineage(lineage() === "alpha" ? "all" : "alpha")}
                >
                  <span>Alpha</span><strong>{counts("alpha")}</strong><small>自有实现</small>
                </button>
                <button
                  type="button"
                  class="a-smap-stat"
                  data-lineage="opencode"
                  aria-pressed={lineage() === "opencode"}
                  onClick={() => setLineage(lineage() === "opencode" ? "all" : "opencode")}
                >
                  <span>OpenCode</span><strong>{counts("opencode")}</strong><small>上游实现</small>
                </button>
                <button
                  type="button"
                  class="a-smap-stat"
                  data-lineage="hybrid"
                  aria-pressed={lineage() === "hybrid"}
                  onClick={() => setLineage(lineage() === "hybrid" ? "all" : "hybrid")}
                >
                  <span>Hybrid</span><strong>{counts("hybrid")}</strong><small>迁移接缝</small>
                </button>
                <div class="a-smap-stat a-smap-stat--current">
                  <span>当前 route</span>
                  <strong>{frontendSurfaceById(currentRoute() ?? "")?.label ?? "未知"}</strong>
                  <small>{currentRoute() ?? location.pathname}</small>
                </div>
              </section>

              <section class="a-smap-section" aria-labelledby="a-smap-flow-title">
                <div class="a-smap-section-head">
                  <div><span class="a-overline">Navigation ABI</span><h2 id="a-smap-flow-title">页面路由链</h2></div>
                  <p>由同一 Manifest 生成；虚线含义由文字说明，不依赖颜色判断。</p>
                </div>
                <div class="a-smap-route-flow">
                  <For each={routeSurfaces}>
                    {(surface) => (
                      <article class="a-smap-route-node" data-active={active().has(surface.id) ? "" : undefined}>
                        <div class="a-smap-route-top">
                          <span class="a-smap-lineage" data-lineage={surface.lineage}>{LINEAGE_LABELS[surface.lineage]}</span>
                          <Show when={active().has(surface.id)}><span class="a-smap-active">当前</span></Show>
                        </div>
                        <code>{surface.mount.kind === "route" ? surface.mount.path : ""}</code>
                        <strong>{surface.label}</strong>
                        <div class="a-smap-route-next">
                          <For each={surface.transitions.filter((transition) => transition.target.startsWith("route."))}>
                            {(transition) => <span>→ {transition.label}: {frontendSurfaceById(transition.target)?.label}</span>}
                          </For>
                        </div>
                      </article>
                    )}
                  </For>
                </div>
              </section>

              <section class="a-smap-section" aria-labelledby="a-smap-inventory-title">
                <div class="a-smap-section-head a-smap-section-head--inventory">
                  <div><span class="a-overline">Canonical inventory</span><h2 id="a-smap-inventory-title">Surface 清单</h2></div>
                  <div class="a-smap-filters">
                    <label class="a-smap-search">
                      <span>搜索</span>
                      <div><Icon name="magnifying-glass" size="small" /><input ref={search} value={query()} onInput={(event) => setQuery(event.currentTarget.value)} placeholder="名称、路径、owner、入口…" /></div>
                    </label>
                    <label>
                      <span>挂载类型</span>
                      <select value={mount()} onChange={(event) => setMount(event.currentTarget.value as SurfaceMapMountFilter)}>
                        <option value="all">全部</option>
                        <option value="route">Route</option>
                        <option value="overlay">Overlay</option>
                        <option value="inline">Inline</option>
                        <option value="boot">Boot</option>
                      </select>
                    </label>
                    <Show when={lineage() !== "all" || mount() !== "all" || query()}>
                      <button type="button" class="a-smap-reset" onClick={() => { setQuery(""); setLineage("all"); setMount("all") }}>清除筛选</button>
                    </Show>
                  </div>
                </div>

                <div class="a-smap-list" aria-live="polite">
                  <Show when={filtered().length > 0} fallback={<div class="a-smap-empty"><strong>没有匹配的 Surface</strong><span>清除筛选或换一个关键词。</span></div>}>
                    <For each={filtered()}>
                      {(surface) => {
                        const runtime = () => surfaceRuntimeState(surface, props.resolved)
                        return (
                          <article class="a-smap-card" data-active={active().has(surface.id) ? "" : undefined}>
                            <div class="a-smap-card-title">
                              <div>
                                <span class="a-smap-lineage" data-lineage={surface.lineage}>{LINEAGE_LABELS[surface.lineage]}</span>
                                <span class="a-smap-mount">{MOUNT_LABELS[surface.mount.kind]}</span>
                                <Show when={active().has(surface.id)}><span class="a-smap-active">已挂载</span></Show>
                              </div>
                              <h3>{surface.label}</h3>
                              <code>{surface.id}</code>
                            </div>
                            <p class="a-smap-description">{surface.description}</p>
                            <dl class="a-smap-facts">
                              <div><dt>Owner</dt><dd><code>{surface.owner}</code></dd></div>
                              <div><dt>Mount</dt><dd>{mountDescription(surface.mount)}</dd></div>
                              <div><dt>运行态</dt><dd><strong>{runtime().mode}</strong><span>{runtime().detail}</span></dd></div>
                              <div><dt>发布默认</dt><dd>{runtime().release ?? "—"}</dd></div>
                              <div><dt>Fallback</dt><dd><code>{surface.fallback ?? "none"}</code></dd></div>
                              <div><dt>Source</dt><dd><code title={surface.source}>{surface.source}</code></dd></div>
                            </dl>
                            <div class="a-smap-paths">
                              <div><span>入口</span><p>{surface.entrypoints.join(" · ")}</p></div>
                              <div><span>跳转</span><p>{surface.transitions.map((transition) => `${transition.label} → ${frontendSurfaceById(transition.target)?.label ?? transition.target}`).join(" · ")}</p></div>
                            </div>
                          </article>
                        )
                      }}
                    </For>
                  </Show>
                </div>
              </section>
            </div>
          </main>
        </Portal>
      </Show>
    </>
  )
}

function mountDescription(mount: FrontendSurfaceMount) {
  if (mount.kind === "route") return `${mount.path} · ${mount.role}`
  if (mount.kind === "inline") return `${mount.route} · ${mount.slot}`
  if (mount.kind === "boot") return `${mount.host} · ${mount.phase}`
  return mount.host
}
