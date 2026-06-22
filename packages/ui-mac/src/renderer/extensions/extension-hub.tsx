// The Extension Hub (定制中心) overlay panel. Rendered as a sibling of <AlphaSidebar> inside
// AppInterface (renderer/index.tsx), so it has the same Provider context; mounted via a dedicated
// Portal host appended to #root (the alpha-sidebar pattern). z-index sits below the sidebar so the
// sidebar stays visible (extension-hub.css). Browsable items come from the bundled catalog; install
// status + actions go through useExtensions (SDK truth + thin persist IPC). MCP install is wired
// now; skill/plugin/bundle install is gated ("coming soon") until their phase lands.

import { createMemo, createSignal, For, Show, onCleanup, type Accessor } from "solid-js"
import { Portal } from "solid-js/web"
import { t } from "../i18n"
import type { ServerInfo } from "../sidebar/use-projects"
import { useExtensions } from "./use-extensions"
import type { Catalog, CatalogEntry, CatalogSource } from "./catalog-types"
import catalogJson from "./alpha-catalog.json"
import "./extension-hub.css"

const CATALOG = catalogJson as unknown as Catalog

type Tab = "featured" | "connectors" | "skills" | "plugins" | "bundles" | "installed" | "create"

const TABS: { key: Tab; labelKey: string }[] = [
  { key: "featured", labelKey: "alpha.ext.tabFeatured" },
  { key: "connectors", labelKey: "alpha.ext.tabConnectors" },
  { key: "skills", labelKey: "alpha.ext.tabSkills" },
  { key: "plugins", labelKey: "alpha.ext.tabPlugins" },
  { key: "bundles", labelKey: "alpha.ext.tabBundles" },
  { key: "installed", labelKey: "alpha.ext.tabInstalled" },
  { key: "create", labelKey: "alpha.ext.tabCreate" },
]

function sourceLabel(source: CatalogSource): string {
  if (source === "official") return t("alpha.ext.sourceOfficial")
  if (source === "community") return t("alpha.ext.sourceCommunity")
  return t("alpha.ext.sourceAlpha")
}

export function ExtensionHub(props: {
  server: Accessor<ServerInfo | undefined>
  open: Accessor<boolean>
  onClose: () => void
}) {
  const ext = useExtensions(props.server)
  const [tab, setTab] = createSignal<Tab>("featured")
  const [query, setQuery] = createSignal("")
  const [busy, setBusy] = createSignal<string | null>(null)
  const [toast, setToast] = createSignal<string | null>(null)
  const [createType, setCreateType] = createSignal<"skill" | "agent">("skill")
  const [fName, setFName] = createSignal("")
  const [fDesc, setFDesc] = createSignal("")
  const [fModel, setFModel] = createSignal("")
  const [fBody, setFBody] = createSignal("")

  // Dedicated Portal host inside #root (mirrors alpha-sidebar.tsx), kept out of <body> so it stays
  // inside opencode's drag-region system and keeps position:fixed working.
  const host = document.createElement("div")
  host.setAttribute("data-alpha-ext-hub", "")
  document.getElementById("root")?.appendChild(host)
  onCleanup(() => host.remove())

  const onKey = (e: KeyboardEvent) => {
    if (e.key === "Escape" && props.open()) props.onClose()
  }
  document.addEventListener("keydown", onKey)
  onCleanup(() => document.removeEventListener("keydown", onKey))

  const matches = (e: CatalogEntry) => {
    const q = query().trim().toLowerCase()
    if (!q) return true
    return `${e.displayName} ${e.name} ${e.description}`.toLowerCase().includes(q)
  }
  const byType = (type: CatalogEntry["type"]) => CATALOG.entries.filter((e) => e.type === type)

  const visible = createMemo<CatalogEntry[]>(() => {
    const tb = tab()
    let list: CatalogEntry[] = []
    if (tb === "featured") list = byType("bundle")
    else if (tb === "connectors") list = byType("mcp")
    else if (tb === "skills") list = byType("skill")
    else if (tb === "plugins") list = byType("plugin")
    else if (tb === "bundles") list = byType("bundle")
    return list.filter(matches)
  })

  // 已安装 = MCP names the running server knows (SDK truth), joined with catalog metadata if known.
  const installed = createMemo(() => {
    const byName = new Map(byType("mcp").map((e) => [e.name, e] as const))
    return Object.values(ext.store.mcp).map((s) => ({ state: s, entry: byName.get(s.name) }))
  })

  const flash = (msg: string) => {
    setToast(msg)
    window.setTimeout(() => setToast(null), 2600)
  }

  const addMcpEntry = async (e: CatalogEntry): Promise<{ ok: boolean; reason?: string }> => {
    const spec = e.installSpec && e.installSpec.kind === "mcp" ? e.installSpec : undefined
    const rc = await ext.checkRuntime(spec?.runtimeDep)
    if (!rc.ok) return { ok: false, reason: t("alpha.ext.runtimeMissing", { tool: rc.missing }) }
    return ext.addMcp(e)
  }

  // Bundle = alpha-defined manifest: fan out to install each referenced entry by its own type
  // (ADR-014 §2). Required items count toward failure; optional ones don't.
  const installBundle = async (e: CatalogEntry) => {
    const byId = new Map(CATALOG.entries.map((x) => [x.id, x] as const))
    const items = (e.bundleItems ?? []).slice().sort((a, b) => a.installOrder - b.installOrder)
    let okCount = 0
    let failCount = 0
    for (const it of items) {
      const sub = byId.get(it.catalogEntryId)
      if (!sub) {
        if (!it.optional) failCount++
        continue
      }
      let r: { ok: boolean; reason?: string }
      if (sub.type === "mcp") r = await addMcpEntry(sub)
      else if (sub.type === "skill") r = await ext.installSkill(sub)
      else if (sub.type === "plugin") r = await ext.installPlugin(sub)
      else r = { ok: false, reason: "unsupported in bundle" }
      if (r.ok) okCount++
      else if (!it.optional) failCount++
    }
    flash(failCount > 0 ? `${okCount} 成功 · ${failCount} 失败` : `${okCount} 项已安装`)
  }

  const onAdd = async (e: CatalogEntry) => {
    setBusy(e.id)
    try {
      if (e.type === "mcp") {
        const res = await addMcpEntry(e)
        if (!res.ok) flash(`${t("alpha.ext.installFailed")}${res.reason ? `: ${res.reason}` : ""}`)
        else if (res.reason === "slow") flash(t("alpha.ext.installSlow"))
        else flash(t("alpha.ext.added"))
      } else if (e.type === "skill") {
        const res = await ext.installSkill(e)
        flash(res.ok ? t("alpha.ext.added") : `${t("alpha.ext.installFailed")}${res.reason ? `: ${res.reason}` : ""}`)
      } else if (e.type === "plugin") {
        const res = await ext.installPlugin(e)
        flash(res.ok ? t("alpha.ext.pluginRestart") : `${t("alpha.ext.installFailed")}${res.reason ? `: ${res.reason}` : ""}`)
      } else if (e.type === "bundle") {
        await installBundle(e)
      }
    } finally {
      setBusy(null)
    }
  }

  const submitCreate = async () => {
    const name = fName().trim()
    if (!name) return
    setBusy("__create__")
    try {
      const res =
        createType() === "skill"
          ? await ext.createSkill(name, fDesc(), fBody())
          : await ext.createAgent(name, { description: fDesc(), model: fModel() || undefined, system: fBody() })
      if (res.ok) {
        flash(t("alpha.ext.added"))
        setFName("")
        setFDesc("")
        setFModel("")
        setFBody("")
      } else {
        flash(`${t("alpha.ext.installFailed")}${res.reason ? `: ${res.reason}` : ""}`)
      }
    } finally {
      setBusy(null)
    }
  }

  const Card = (cp: { e: CatalogEntry }) => {
    const e = cp.e
    const installedNow = createMemo(() => ext.isInstalled(e))
    const isBusy = () => busy() === e.id
    const wired = true // all four types (mcp / skill / plugin / bundle) now have an install path
    return (
      <div class="alpha-ext-card">
        <div class="alpha-ext-card-top">
          <span class="alpha-ext-icon">{e.displayName.slice(0, 1)}</span>
          <span class="alpha-ext-name" title={e.name}>
            {e.displayName}
          </span>
          <span class="alpha-ext-chip" data-source={e.source}>
            {sourceLabel(e.source)}
          </span>
        </div>
        <div class="alpha-ext-desc">{e.description}</div>
        <Show when={e.type === "bundle" && e.bundleItems}>
          <div class="alpha-ext-meta">{(e.bundleItems ?? []).length} 项</div>
        </Show>
        <div class="alpha-ext-card-actions">
          <Show
            when={wired}
            fallback={
              <button class="alpha-ext-btn" disabled title={t("alpha.ext.comingSoon")}>
                {t("alpha.ext.comingSoon")}
              </button>
            }
          >
            <Show
              when={!installedNow()}
              fallback={
                <button class="alpha-ext-btn" data-variant="installed" disabled>
                  ✓ {t("alpha.ext.added")}
                </button>
              }
            >
              <button class="alpha-ext-btn" disabled={isBusy()} onClick={() => void onAdd(e)}>
                {isBusy() ? t("alpha.ext.adding") : t("alpha.ext.add")}
              </button>
            </Show>
          </Show>
        </div>
      </div>
    )
  }

  return (
    <Show when={props.open()}>
      <Portal mount={host}>
        <div class="alpha-ext-backdrop" onClick={() => props.onClose()} />
        <div
          class="alpha-ext-panel"
          role="dialog"
          aria-modal="true"
          aria-label={t("alpha.ext.hub")}
          onClick={(ev) => ev.stopPropagation()}
        >
          <header class="alpha-ext-header">
            <span class="alpha-ext-title">{t("alpha.ext.hub")}</span>
            <input
              class="alpha-ext-search"
              type="search"
              placeholder={t("alpha.ext.search")}
              value={query()}
              onInput={(ev) => setQuery(ev.currentTarget.value)}
            />
            <button
              class="alpha-ext-close"
              title={t("alpha.ext.close")}
              aria-label={t("alpha.ext.close")}
              onClick={() => props.onClose()}
            >
              ✕
            </button>
          </header>

          <nav class="alpha-ext-tabs">
            <For each={TABS}>
              {(item) => (
                <button
                  class="alpha-ext-tab"
                  data-active={tab() === item.key ? "" : undefined}
                  onClick={() => setTab(item.key)}
                >
                  {t(item.labelKey as never)}
                </button>
              )}
            </For>
          </nav>

          <div class="alpha-ext-body">
            {/* Create / import: write a user-authored skill or agent. */}
            <Show when={tab() === "create"}>
              <div class="alpha-ext-form">
                <div class="alpha-ext-form-types">
                  <button
                    class="alpha-ext-tab"
                    data-active={createType() === "skill" ? "" : undefined}
                    onClick={() => setCreateType("skill")}
                  >
                    {t("alpha.ext.tabSkills")}
                  </button>
                  <button
                    class="alpha-ext-tab"
                    data-active={createType() === "agent" ? "" : undefined}
                    onClick={() => setCreateType("agent")}
                  >
                    Agent
                  </button>
                </div>
                <input
                  class="alpha-ext-input"
                  placeholder="name (a-z 0-9 - _)"
                  value={fName()}
                  onInput={(e) => setFName(e.currentTarget.value)}
                />
                <input
                  class="alpha-ext-input"
                  placeholder="description"
                  value={fDesc()}
                  onInput={(e) => setFDesc(e.currentTarget.value)}
                />
                <Show when={createType() === "agent"}>
                  <input
                    class="alpha-ext-input"
                    placeholder="model (optional, e.g. anthropic/claude-opus-4-8)"
                    value={fModel()}
                    onInput={(e) => setFModel(e.currentTarget.value)}
                  />
                </Show>
                <textarea
                  class="alpha-ext-textarea"
                  placeholder={createType() === "skill" ? "SKILL.md body / 技能正文" : "system prompt / 系统提示"}
                  value={fBody()}
                  onInput={(e) => setFBody(e.currentTarget.value)}
                />
                <div>
                  <button
                    class="alpha-ext-btn"
                    disabled={busy() === "__create__" || !fName().trim()}
                    onClick={() => void submitCreate()}
                  >
                    {busy() === "__create__" ? t("alpha.ext.adding") : t("alpha.ext.tabCreate")}
                  </button>
                </div>
              </div>
            </Show>

            {/* Installed: SDK truth (MCP). */}
            <Show when={tab() === "installed"}>
              <Show
                when={installed().length > 0}
                fallback={<div class="alpha-ext-empty">{t("alpha.ext.empty")}</div>}
              >
                <div class="alpha-ext-grid">
                  <For each={installed()}>
                    {(row) => (
                      <div class="alpha-ext-card">
                        <div class="alpha-ext-card-top">
                          <span class="alpha-ext-icon">
                            {(row.entry?.displayName ?? row.state.name).slice(0, 1)}
                          </span>
                          <span class="alpha-ext-name" title={row.state.name}>
                            {row.entry?.displayName ?? row.state.name}
                          </span>
                          <span class="alpha-ext-chip" data-source={row.entry?.source ?? "user"}>
                            {row.entry ? sourceLabel(row.entry.source) : t("alpha.ext.installedUnknown")}
                          </span>
                        </div>
                        <Show when={row.state.error}>
                          <div class="alpha-ext-meta">{row.state.error}</div>
                        </Show>
                        <div class="alpha-ext-card-actions">
                          <button
                            class="alpha-ext-btn"
                            data-variant={row.state.connected ? "installed" : undefined}
                            onClick={() => void ext.setMcpConnected(row.state.name, !row.state.connected)}
                          >
                            {row.state.connected ? t("alpha.ext.enabled") : t("alpha.ext.disabled")}
                          </button>
                          <button class="alpha-ext-btn" onClick={() => void ext.removeMcp(row.state.name)}>
                            {t("alpha.ext.remove")}
                          </button>
                        </div>
                      </div>
                    )}
                  </For>
                </div>
              </Show>
            </Show>

            {/* Browse: catalog grid for the current type tab. */}
            <Show when={tab() !== "create" && tab() !== "installed"}>
              <Show
                when={visible().length > 0}
                fallback={<div class="alpha-ext-empty">{t("alpha.ext.noResults")}</div>}
              >
                <div class="alpha-ext-grid">
                  <For each={visible()}>{(e) => <Card e={e} />}</For>
                </div>
              </Show>
            </Show>
          </div>

          <Show when={toast()}>
            <div class="alpha-ext-toast">{toast()}</div>
          </Show>
        </div>
      </Portal>
    </Show>
  )
}
