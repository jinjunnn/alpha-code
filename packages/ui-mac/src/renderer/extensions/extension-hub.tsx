// The Extension Hub (定制中心) — a full PAGE (not a modal) covering the content area, rendered as a
// sibling of <AlphaSidebar> inside AppInterface (renderer/index.tsx) via a dedicated Portal host on
// #root. Layout matches the approved Codex-style design: sticky tabs → title/subtitle → search+filter
// → 已添加 row → category list-rows (icon + name/chip/desc + 添加). Only mounted while open, so it can
// never intercept background clicks. Browsable items come from the bundled catalog; install status +
// actions go through useExtensions (SDK truth + thin persist IPC).

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

  const sectionLabel = createMemo(() => {
    switch (tab()) {
      case "featured":
        return t("alpha.ext.tabBundles") + " · Featured"
      case "connectors":
        return t("alpha.ext.tabConnectors")
      case "skills":
        return t("alpha.ext.tabSkills")
      case "plugins":
        return t("alpha.ext.tabPlugins")
      default:
        return t("alpha.ext.tabBundles")
    }
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
    // Some MCP commands need a {workspace} directory (filesystem/git) — let the user pick one.
    let workspace: string | undefined
    if (spec?.command?.some((a) => a.includes("{workspace}"))) {
      const picked = await window.api.openDirectoryPicker({ title: t("alpha.ext.pickWorkspace") })
      const dir = Array.isArray(picked) ? picked[0] : picked
      if (!dir) return { ok: false, reason: t("alpha.ext.cancelled") }
      workspace = dir
    }
    return ext.addMcp(e, undefined, workspace)
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

  // A single browsable entry as a horizontal list-row (icon · name/chip/desc · action).
  const Row = (cp: { e: CatalogEntry }) => {
    const e = cp.e
    const installedNow = createMemo(() => ext.isInstalled(e))
    const isBusy = () => busy() === e.id
    return (
      <div class="alpha-ext-row">
        <span class="alpha-ext-ric">{e.displayName.slice(0, 1)}</span>
        <div class="alpha-ext-rtext">
          <div class="alpha-ext-rname">
            <span class="alpha-ext-rname-t" title={e.name}>
              {e.displayName}
            </span>
            <span class="alpha-ext-chip" data-source={e.source}>
              {sourceLabel(e.source)}
            </span>
          </div>
          <div class="alpha-ext-rdesc">
            {e.description}
            <Show when={e.type === "bundle" && e.bundleItems}>
              <span class="alpha-ext-rcount"> · {(e.bundleItems ?? []).length} 项</span>
            </Show>
          </div>
        </div>
        <Show
          when={!installedNow()}
          fallback={
            <button class="alpha-ext-add" data-variant="installed" disabled>
              ✓ {t("alpha.ext.added")}
            </button>
          }
        >
          <button class="alpha-ext-add" data-variant="primary" disabled={isBusy()} onClick={() => void onAdd(e)}>
            {isBusy() ? t("alpha.ext.adding") : t("alpha.ext.add")}
          </button>
        </Show>
      </div>
    )
  }

  return (
    <Show when={props.open()}>
      <Portal mount={host}>
        <div class="a-ui alpha-ext-page" role="region" aria-label={t("alpha.ext.hub")}>
          {/* sticky tab bar + close */}
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
            <span class="alpha-ext-tabs-spacer" />
            <button class="alpha-ext-close" title={t("alpha.ext.close")} aria-label={t("alpha.ext.close")} onClick={() => props.onClose()}>
              ✕
            </button>
          </nav>

          <div class="alpha-ext-body">
            <header class="alpha-ext-hero">
              <h1 class="alpha-ext-title">{t("alpha.ext.hub")}</h1>
              <p class="alpha-ext-sub">{t("alpha.ext.heroSub")}</p>
            </header>

            <div class="alpha-ext-search-row">
              <div class="alpha-ext-search">
                <svg class="alpha-ext-search-ic" viewBox="0 0 16 16" fill="none" aria-hidden="true">
                  <circle cx="7" cy="7" r="4.5" stroke="currentColor" stroke-width="1.4" />
                  <path d="M10.5 10.5L14 14" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" />
                </svg>
                <input
                  type="search"
                  placeholder={t("alpha.ext.search")}
                  value={query()}
                  onInput={(ev) => setQuery(ev.currentTarget.value)}
                />
              </div>
            </div>

            {/* 已添加 row (installed MCP) */}
            <Show when={installed().length > 0 && tab() !== "create" && tab() !== "installed"}>
              <div class="alpha-ext-sec-head">
                <span class="alpha-ext-sec-t">{t("alpha.ext.tabInstalled")}</span>
                <button class="alpha-ext-link" onClick={() => setTab("installed")}>
                  {t("alpha.ext.manage")}
                </button>
              </div>
              <div class="alpha-ext-installed">
                <For each={installed()}>
                  {(row) => (
                    <span class="alpha-ext-ic" data-connected={row.state.connected ? "" : undefined} title={row.state.name}>
                      {(row.entry?.displayName ?? row.state.name).slice(0, 2)}
                    </span>
                  )}
                </For>
              </div>
            </Show>

            {/* Create / import */}
            <Show when={tab() === "create"}>
              <div class="alpha-ext-form">
                <div class="alpha-ext-form-types">
                  <button class="alpha-ext-tab" data-active={createType() === "skill" ? "" : undefined} onClick={() => setCreateType("skill")}>
                    {t("alpha.ext.tabSkills")}
                  </button>
                  <button class="alpha-ext-tab" data-active={createType() === "agent" ? "" : undefined} onClick={() => setCreateType("agent")}>
                    Agent
                  </button>
                </div>
                <input class="alpha-ext-input" placeholder="name (a-z 0-9 - _)" value={fName()} onInput={(e) => setFName(e.currentTarget.value)} />
                <input class="alpha-ext-input" placeholder="description" value={fDesc()} onInput={(e) => setFDesc(e.currentTarget.value)} />
                <Show when={createType() === "agent"}>
                  <input class="alpha-ext-input" placeholder="model (optional, e.g. anthropic/claude-opus-4-8)" value={fModel()} onInput={(e) => setFModel(e.currentTarget.value)} />
                </Show>
                <textarea
                  class="alpha-ext-textarea"
                  placeholder={createType() === "skill" ? "SKILL.md body / 技能正文" : "system prompt / 系统提示"}
                  value={fBody()}
                  onInput={(e) => setFBody(e.currentTarget.value)}
                />
                <div>
                  <button class="alpha-ext-add" data-variant="primary" disabled={busy() === "__create__" || !fName().trim()} onClick={() => void submitCreate()}>
                    {busy() === "__create__" ? t("alpha.ext.adding") : t("alpha.ext.tabCreate")}
                  </button>
                </div>
              </div>
            </Show>

            {/* Installed tab (manage) */}
            <Show when={tab() === "installed"}>
              <Show when={installed().length > 0} fallback={<div class="alpha-ext-empty">{t("alpha.ext.empty")}</div>}>
                <div class="alpha-ext-rows">
                  <For each={installed()}>
                    {(row) => (
                      <div class="alpha-ext-row">
                        <span class="alpha-ext-ric">{(row.entry?.displayName ?? row.state.name).slice(0, 1)}</span>
                        <div class="alpha-ext-rtext">
                          <div class="alpha-ext-rname">
                            <span class="alpha-ext-rname-t" title={row.state.name}>
                              {row.entry?.displayName ?? row.state.name}
                            </span>
                            <span class="alpha-ext-chip" data-source={row.entry?.source ?? "user"}>
                              {row.entry ? sourceLabel(row.entry.source) : t("alpha.ext.installedUnknown")}
                            </span>
                          </div>
                          <Show when={row.state.error} fallback={<div class="alpha-ext-rdesc">{row.state.connected ? t("alpha.ext.enabled") : t("alpha.ext.disabled")}</div>}>
                            <div class="alpha-ext-rdesc">{row.state.error}</div>
                          </Show>
                        </div>
                        <button class="alpha-ext-add" data-variant={row.state.connected ? "installed" : undefined} onClick={() => void ext.setMcpConnected(row.state.name, !row.state.connected)}>
                          {row.state.connected ? t("alpha.ext.enabled") : t("alpha.ext.disabled")}
                        </button>
                        <button class="alpha-ext-add" onClick={() => void ext.removeMcp(row.state.name)}>
                          {t("alpha.ext.remove")}
                        </button>
                      </div>
                    )}
                  </For>
                </div>
              </Show>
            </Show>

            {/* Browse (list-rows) */}
            <Show when={tab() !== "create" && tab() !== "installed"}>
              <div class="alpha-ext-sec-head">
                <span class="alpha-ext-sec-t">{sectionLabel()}</span>
              </div>
              <Show when={visible().length > 0} fallback={<div class="alpha-ext-empty">{t("alpha.ext.noResults")}</div>}>
                <div class="alpha-ext-rows">
                  <For each={visible()}>{(e) => <Row e={e} />}</For>
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
