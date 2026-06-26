// The Extension Hub (定制中心) — a full PAGE (not a modal) covering the content area, rendered as a
// sibling of <AlphaSidebar> inside AppInterface (renderer/index.tsx) via a dedicated Portal host on
// #root. Only mounted while open, so it can never intercept background clicks. Browsable items come
// from the bundled catalog; install status + actions go through useExtensions (SDK truth + thin
// persist IPC).
//
// Layout (approved 2026-06-26 redesign, docs/designs/2026-06-26-hub-settings-redesign):
//   sticky centered tab bar (推荐/连接器/技能/插件/套件/已安装/创建) → centered max-width column →
//   per-tab content. Browse tabs render a RESPONSIVE CARD GRID (icon tile + name/source-chip + desc +
//   meta pills + 添加), connectors grouped by category. 已安装 = a manage list (toggle + remove).
//   创建 = author skill/agent form + import. 添加 stages an install-confirm Dialog that fans bundles out.

import { createEffect, createMemo, createSignal, For, Show, onCleanup, type Accessor, type JSX } from "solid-js"
import { Portal } from "solid-js/web"
import { t } from "../i18n"
import { Dialog } from "../alpha-ui/Dialog"
import { Button } from "../alpha-ui/Button"
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

// Presentational only — the catalog carries no icon glyph/color. Keyed by id, falling back to the
// category tint + the displayName initial. (Kept here, not in the catalog, so the data file stays
// pure metadata.)
const CAT_COLOR: Record<string, string> = {
  dev: "#4f46e5",
  office: "#16a34a",
  research: "#2563eb",
  "china-office": "#00b4d8",
  design: "#7c3aed",
}
const ICON_COLOR: Record<string, string> = {
  "mcp:playwright": "#7c3aed",
  "mcp:github": "#24292f",
  "mcp:yuque": "#1f7a4d",
  "plugin:opencode-notify": "#d97706",
}
const ICON_GLYPH: Record<string, string> = {
  "mcp:markitdown": "文",
  "mcp:filesystem": "FS",
  "mcp:fetch": "网",
  "mcp:playwright": "▶",
  "mcp:git": "Git",
  "mcp:github": "GH",
  "mcp:feishu": "飞",
  "mcp:yuque": "语",
  "skill:skill-creator": "技",
  "skill:mcp-builder": "MCP",
  "skill:canvas-design": "设",
  "skill:brand-guidelines": "品",
  "skill:alpha-upstream-sync": "同",
  "skill:safe-refactor": "重",
  "plugin:opencode-notify": "通",
  "bundle:office": "办",
  "bundle:research": "研",
  "bundle:design": "设",
  "bundle:dev": "开",
  "bundle:china-office": "中",
}
function iconFor(e: CatalogEntry): { color: string; glyph: string } {
  return {
    color: ICON_COLOR[e.id] ?? CAT_COLOR[e.category] ?? "var(--a-accent-solid)",
    glyph: ICON_GLYPH[e.id] ?? e.displayName.slice(0, 1),
  }
}

// Connector grouping order (catalog `category`). "other" catches anything unmapped.
const CAT_ORDER = ["dev", "office", "research", "china-office", "design", "other"] as const
function catLabel(cat: string): string {
  switch (cat) {
    case "dev":
      return t("alpha.ext.cat.dev")
    case "office":
      return t("alpha.ext.cat.office")
    case "research":
      return t("alpha.ext.cat.research")
    case "china-office":
      return t("alpha.ext.cat.china-office")
    case "design":
      return t("alpha.ext.cat.design")
    default:
      return t("alpha.ext.cat.other")
  }
}

// Curated "popular" connectors for the Featured tab.
const FEATURED_CONNECTORS = ["mcp:markitdown", "mcp:playwright", "mcp:fetch", "mcp:github"]

function sourceLabel(source: CatalogSource): string {
  if (source === "official") return t("alpha.ext.sourceOfficial")
  if (source === "community") return t("alpha.ext.sourceCommunity")
  return t("alpha.ext.sourceAlpha")
}

// Human label for an entry's primitive type, reusing the tab labels (连接器/技能/插件/套件).
function typeLabel(type: CatalogEntry["type"]): string {
  if (type === "mcp") return t("alpha.ext.tabConnectors")
  if (type === "skill") return t("alpha.ext.tabSkills")
  if (type === "plugin") return t("alpha.ext.tabPlugins")
  return t("alpha.ext.tabBundles")
}

// Compact "what this needs" pills shown on a card foot (runtime deps, key requirement, pick-dir,
// license, restart, item count). lock=true renders a small padlock before the text.
function metaPills(e: CatalogEntry): { text: string; lock?: boolean }[] {
  const out: { text: string; lock?: boolean }[] = []
  const spec = e.installSpec
  if (e.type === "mcp" && spec?.kind === "mcp") {
    if (spec.runtimeDep?.length) out.push({ text: t("alpha.ext.metaRuntime", { dep: spec.runtimeDep.join(" · ") }) })
    if (spec.command?.some((a) => a.includes("{workspace}"))) out.push({ text: t("alpha.ext.metaPickDir") })
    if (spec.requiredEnvVars?.length) out.push({ text: t("alpha.ext.metaKey"), lock: true })
  } else if (e.type === "skill") {
    if (e.license) out.push({ text: e.license })
  } else if (e.type === "plugin") {
    if (e.license) out.push({ text: e.license })
    out.push({ text: t("alpha.ext.metaRestart") })
  } else if (e.type === "bundle") {
    out.push({ text: t("alpha.ext.metaItems", { count: (e.bundleItems ?? []).length }) })
  }
  return out
}

// Pre-install disclosure for the confirm dialog.
function runtimeDeps(e: CatalogEntry): string {
  const spec = e.installSpec && e.installSpec.kind === "mcp" ? e.installSpec : undefined
  return (spec?.runtimeDep ?? []).join(", ")
}
function requiredKeys(e: CatalogEntry): string {
  const spec = e.installSpec && e.installSpec.kind === "mcp" ? e.installSpec : undefined
  return (spec?.requiredEnvVars ?? []).join(", ")
}

// ── tiny inline icons (1.6 stroke, currentColor) ──────────────────────────────────────────────
const Svg = (p: { d: string; box?: string; class?: string }) => (
  <svg class={p.class ?? "alpha-ic"} viewBox={p.box ?? "0 0 24 24"} fill="none" aria-hidden="true">
    <path d={p.d} stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" />
  </svg>
)
const SearchIc = () => (
  <svg class="alpha-ic" viewBox="0 0 24 24" fill="none" aria-hidden="true">
    <circle cx="11" cy="11" r="7" stroke="currentColor" stroke-width="1.6" />
    <path d="M21 21l-4-4" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" />
  </svg>
)
const LockIc = () => (
  <svg class="alpha-ic alpha-ic-xs" viewBox="0 0 24 24" fill="none" aria-hidden="true">
    <rect x="5" y="11" width="14" height="9" rx="2" stroke="currentColor" stroke-width="1.7" />
    <path d="M8 11V7a4 4 0 0 1 8 0v4" stroke="currentColor" stroke-width="1.7" />
  </svg>
)

export function ExtensionHub(props: {
  server: Accessor<ServerInfo | undefined>
  open: Accessor<boolean>
  onClose: () => void
}) {
  const ext = useExtensions(props.server)
  const [tab, setTab] = createSignal<Tab>("featured")
  const [query, setQuery] = createSignal("")
  const [busy, setBusy] = createSignal<string | null>(null)
  // The entry awaiting install confirmation. 添加 stages it here (instead of installing directly), so
  // the user sees the fan-out / runtime deps / required keys and can back out.
  const [confirming, setConfirming] = createSignal<CatalogEntry | null>(null)
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

  // Reset the search when switching tabs (each tab's results are scoped to that tab).
  createEffect(() => {
    tab()
    setQuery("")
  })

  const matches = (e: CatalogEntry) => {
    const q = query().trim().toLowerCase()
    if (!q) return true
    return `${e.displayName} ${e.name} ${e.description}`.toLowerCase().includes(q)
  }
  const byType = (type: CatalogEntry["type"]) => CATALOG.entries.filter((e) => e.type === type)
  const byId = (id: string) => CATALOG.entries.find((e) => e.id === id)

  // Connectors grouped by category (fixed order) — drives the 连接器 tab subheaders.
  const groupedConnectors = createMemo(() => {
    const list = byType("mcp").filter(matches)
    const map = new Map<string, CatalogEntry[]>()
    for (const e of list) {
      const k = (CAT_ORDER as readonly string[]).includes(e.category) ? e.category : "other"
      const arr = map.get(k) ?? []
      arr.push(e)
      map.set(k, arr)
    }
    return CAT_ORDER.filter((c) => map.has(c)).map((c) => ({ cat: c as string, items: map.get(c)! }))
  })

  const featuredBundles = createMemo(() => byType("bundle").filter(matches).slice(0, 3))
  const featuredConnectors = createMemo(() =>
    FEATURED_CONNECTORS.map((id) => byId(id)).filter((e): e is CatalogEntry => !!e && matches(e)),
  )

  // 已安装 = MCP names the running server knows (SDK truth), joined with catalog metadata if known.
  const installed = createMemo(() => {
    const byName = new Map(byType("mcp").map((e) => [e.name, e] as const))
    return Object.values(ext.store.mcp).map((s) => ({ state: s, entry: byName.get(s.name) }))
  })

  const flash = (msg: string) => {
    setToast(msg)
    window.setTimeout(() => setToast(null), 2600)
  }
  const comingSoon = () => flash(t("alpha.ext.comingSoon"))

  const addMcpEntry = async (e: CatalogEntry): Promise<{ ok: boolean; reason?: string }> => {
    const spec = e.installSpec && e.installSpec.kind === "mcp" ? e.installSpec : undefined
    const rc = await ext.checkRuntime(spec?.runtimeDep)
    if (!rc.ok) return { ok: false, reason: t("alpha.ext.runtimeMissing", { tool: rc.missing }) }
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
    const items = (e.bundleItems ?? []).slice().sort((a, b) => a.installOrder - b.installOrder)
    let okCount = 0
    let failCount = 0
    for (const it of items) {
      const sub = byId(it.catalogEntryId)
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
    flash(failCount > 0 ? `${okCount} 成功 · ${failCount} 失败` : t("alpha.ext.metaItems", { count: okCount }) + " · " + t("alpha.ext.added"))
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

  // Items the confirm dialog lists: a bundle fans out to its referenced entries; everything else is
  // just itself.
  const confirmItems = (e: CatalogEntry): { entry: CatalogEntry; optional: boolean }[] => {
    if (e.type === "bundle") {
      return (e.bundleItems ?? [])
        .slice()
        .sort((a, b) => a.installOrder - b.installOrder)
        .map((it) => ({ entry: byId(it.catalogEntryId), optional: it.optional }))
        .filter((x): x is { entry: CatalogEntry; optional: boolean } => !!x.entry)
    }
    return [{ entry: e, optional: false }]
  }

  // ── reusable pieces ─────────────────────────────────────────────────────────────────────────
  const Hero = (cp: { title: string; sub: string }) => (
    <header class="alpha-ext-hero">
      <h1 class="alpha-ext-title">{cp.title}</h1>
      <p class="alpha-ext-sub">{cp.sub}</p>
    </header>
  )

  const SearchBox = (cp: { placeholder: string }) => (
    <div class="alpha-ext-search">
      <span class="alpha-ext-search-ic">
        <SearchIc />
      </span>
      <input
        type="search"
        placeholder={cp.placeholder}
        value={query()}
        onInput={(ev) => setQuery(ev.currentTarget.value)}
      />
    </div>
  )

  const SecRow = (cp: { label: string; count?: number; actionLabel?: string; onAction?: () => void }) => (
    <div class="alpha-ext-secrow">
      <span class="alpha-ext-overline">
        {cp.label}
        <Show when={cp.count !== undefined}>
          {" · "}
          <b>{cp.count}</b>
        </Show>
      </span>
      <Show when={cp.actionLabel && cp.onAction}>
        <button class="alpha-ext-link" onClick={() => cp.onAction!()}>
          {cp.actionLabel}
        </button>
      </Show>
    </div>
  )

  // One browsable entry as a card (icon · name/chip · desc · meta + action).
  const Card = (cp: { e: CatalogEntry }) => {
    const e = cp.e
    const ic = iconFor(e)
    const installedNow = createMemo(() => ext.isInstalled(e))
    const isBusy = () => busy() === e.id
    return (
      <div class="alpha-ext-card">
        <div class="alpha-ext-card-top">
          <span class="alpha-ext-card-ic" style={{ background: ic.color }}>
            {ic.glyph}
          </span>
          <div class="alpha-ext-card-hd">
            <div class="alpha-ext-card-name">
              <b title={e.name}>{e.displayName}</b>
              <span class="alpha-ext-chip" data-source={e.source}>
                {sourceLabel(e.source)}
              </span>
            </div>
          </div>
        </div>
        <p class="alpha-ext-card-desc">{e.description}</p>
        <div class="alpha-ext-card-foot">
          <For each={metaPills(e)}>
            {(m) => (
              <span class="alpha-ext-meta">
                <Show when={m.lock}>
                  <LockIc />
                </Show>
                {m.text}
              </span>
            )}
          </For>
          <Show
            when={!installedNow()}
            fallback={
              <button class="alpha-ext-add" data-variant="installed" disabled>
                ✓ {t("alpha.ext.added")}
              </button>
            }
          >
            <button class="alpha-ext-add" data-variant="primary" disabled={isBusy()} onClick={() => setConfirming(e)}>
              {isBusy() ? t("alpha.ext.adding") : t("alpha.ext.add")}
            </button>
          </Show>
        </div>
      </div>
    )
  }

  const Grid = (cp: { items: CatalogEntry[] }) => (
    <div class="alpha-ext-grid">
      <For each={cp.items}>{(e) => <Card e={e} />}</For>
    </div>
  )

  // Featured-tab bundle hero row (wider, richer than a grid card).
  const KitRow = (cp: { e: CatalogEntry }) => {
    const e = cp.e
    const ic = iconFor(e)
    const isBusy = () => busy() === e.id
    return (
      <div class="alpha-ext-kit">
        <span class="alpha-ext-kit-ic" style={{ background: ic.color }}>
          {ic.glyph}
        </span>
        <div class="alpha-ext-kit-body">
          <div class="alpha-ext-kit-ttl">
            <b>{e.displayName}</b>
            <span class="alpha-ext-chip" data-source={e.source}>
              {sourceLabel(e.source)}
            </span>
          </div>
          <div class="alpha-ext-kit-desc">
            {e.description}
            <span class="alpha-ext-kit-n"> · {t("alpha.ext.metaItems", { count: (e.bundleItems ?? []).length })}</span>
          </div>
        </div>
        <button class="alpha-ext-add" data-variant="primary" disabled={isBusy()} onClick={() => setConfirming(e)}>
          {isBusy() ? t("alpha.ext.adding") : t("alpha.ext.add")}
        </button>
      </div>
    )
  }

  const EmptyState = (cp: { title: string; sub?: string; action?: JSX.Element }) => (
    <div class="alpha-ext-empty-state">
      <span class="alpha-ext-empty-ic">
        <svg class="alpha-ic" viewBox="0 0 24 24" fill="none" aria-hidden="true" style={{ width: "24px", height: "24px" }}>
          <rect x="3" y="7" width="18" height="13" rx="2" stroke="currentColor" stroke-width="1.6" />
          <path d="M8 7V5a4 4 0 0 1 8 0v2" stroke="currentColor" stroke-width="1.6" />
        </svg>
      </span>
      <b>{cp.title}</b>
      <Show when={cp.sub}>
        <p>{cp.sub}</p>
      </Show>
      {cp.action}
    </div>
  )

  return (
    <Show when={props.open()}>
      <Portal mount={host}>
        <div class="a-ui alpha-ext-page" role="region" aria-label={t("alpha.ext.hub")}>
          {/* sticky, centered tab bar + close */}
          <nav class="alpha-ext-tabs">
            <div class="alpha-ext-tabs-inner">
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
            </div>
            <button
              class="alpha-ext-close"
              title={t("alpha.ext.close")}
              aria-label={t("alpha.ext.close")}
              onClick={() => props.onClose()}
            >
              <Svg d="M6 6l12 12M18 6L6 18" />
            </button>
          </nav>

          <div class="alpha-ext-scroll">
            <div class="alpha-ext-center">
              {/* ░░ FEATURED ░░ */}
              <Show when={tab() === "featured"}>
                <Hero title={t("alpha.ext.hub")} sub={t("alpha.ext.heroSub")} />
                <SearchBox placeholder={t("alpha.ext.search")} />
                <Show when={installed().length > 0}>
                  <SecRow
                    label={t("alpha.ext.tabInstalled")}
                    count={installed().length}
                    actionLabel={t("alpha.ext.manage")}
                    onAction={() => setTab("installed")}
                  />
                  <div class="alpha-ext-chips">
                    <For each={installed()}>
                      {(row) => {
                        const ic = row.entry ? iconFor(row.entry) : { color: "var(--a-bg-inset)", glyph: row.state.name.slice(0, 1) }
                        return (
                          <span class="alpha-ext-chip-pill" title={row.state.name}>
                            <span class="alpha-ext-chip-d" style={{ background: ic.color }}>
                              {ic.glyph}
                            </span>
                            {row.entry?.displayName ?? row.state.name}
                            <Show when={row.state.connected}>
                              <span class="alpha-ext-chip-dot" />
                            </Show>
                          </span>
                        )
                      }}
                    </For>
                  </div>
                </Show>

                <SecRow
                  label={t("alpha.ext.featuredBundles")}
                  actionLabel={t("alpha.ext.viewAll")}
                  onAction={() => setTab("bundles")}
                />
                <For each={featuredBundles()}>{(e) => <KitRow e={e} />}</For>

                <SecRow
                  label={t("alpha.ext.hotConnectors")}
                  actionLabel={t("alpha.ext.viewAll")}
                  onAction={() => setTab("connectors")}
                />
                <Grid items={featuredConnectors()} />
              </Show>

              {/* ░░ CONNECTORS (grouped by category) ░░ */}
              <Show when={tab() === "connectors"}>
                <Hero title={t("alpha.ext.tabConnectors")} sub={t("alpha.ext.connectorsSub")} />
                <SearchBox placeholder={t("alpha.ext.search")} />
                <Show
                  when={groupedConnectors().length > 0}
                  fallback={<EmptyState title={t("alpha.ext.noResults")} />}
                >
                  <For each={groupedConnectors()}>
                    {(g) => (
                      <>
                        <div class="alpha-ext-grp">
                          {catLabel(g.cat)}
                          <span class="alpha-ext-grp-ct">{g.items.length}</span>
                        </div>
                        <Grid items={g.items} />
                      </>
                    )}
                  </For>
                </Show>
              </Show>

              {/* ░░ SKILLS ░░ */}
              <Show when={tab() === "skills"}>
                <Hero title={t("alpha.ext.tabSkills")} sub={t("alpha.ext.skillsSub")} />
                <SearchBox placeholder={t("alpha.ext.search")} />
                <Show
                  when={byType("skill").filter(matches).length > 0}
                  fallback={<EmptyState title={t("alpha.ext.noResults")} />}
                >
                  <SecRow label={t("alpha.ext.allSkills")} count={byType("skill").filter(matches).length} />
                  <Grid items={byType("skill").filter(matches)} />
                </Show>
              </Show>

              {/* ░░ PLUGINS ░░ */}
              <Show when={tab() === "plugins"}>
                <Hero title={t("alpha.ext.tabPlugins")} sub={t("alpha.ext.pluginsSub")} />
                <SearchBox placeholder={t("alpha.ext.search")} />
                <div class="alpha-ext-callout">{t("alpha.ext.pluginNote")}</div>
                <Show
                  when={byType("plugin").filter(matches).length > 0}
                  fallback={<EmptyState title={t("alpha.ext.noResults")} />}
                >
                  <SecRow label={t("alpha.ext.allPlugins")} count={byType("plugin").filter(matches).length} />
                  <Grid items={byType("plugin").filter(matches)} />
                </Show>
              </Show>

              {/* ░░ BUNDLES ░░ */}
              <Show when={tab() === "bundles"}>
                <Hero title={t("alpha.ext.tabBundles")} sub={t("alpha.ext.bundlesSub")} />
                <SearchBox placeholder={t("alpha.ext.search")} />
                <Show
                  when={byType("bundle").filter(matches).length > 0}
                  fallback={<EmptyState title={t("alpha.ext.noResults")} />}
                >
                  <SecRow label={t("alpha.ext.allBundles")} count={byType("bundle").filter(matches).length} />
                  <Grid items={byType("bundle").filter(matches)} />
                </Show>
              </Show>

              {/* ░░ INSTALLED (manage) ░░ */}
              <Show when={tab() === "installed"}>
                <Hero title={t("alpha.ext.tabInstalled")} sub={t("alpha.ext.installedSub")} />
                <Show
                  when={installed().length > 0}
                  fallback={
                    <EmptyState
                      title={t("alpha.ext.empty")}
                      sub={t("alpha.ext.emptySub")}
                      action={
                        <button class="alpha-ext-add" data-variant="primary" onClick={() => setTab("featured")}>
                          {t("alpha.ext.browseRecommended")}
                        </button>
                      }
                    />
                  }
                >
                  <SecRow label={t("alpha.ext.installedSection")} count={installed().length} />
                  <div class="alpha-ext-manage">
                    <For each={installed()}>
                      {(row) => {
                        const ic = row.entry ? iconFor(row.entry) : { color: "var(--a-bg-inset)", glyph: row.state.name.slice(0, 1) }
                        return (
                          <div class="alpha-ext-man">
                            <span class="alpha-ext-man-ic" style={{ background: ic.color }}>
                              {ic.glyph}
                            </span>
                            <div class="alpha-ext-man-body">
                              <div class="alpha-ext-man-nm">
                                <b title={row.state.name}>{row.entry?.displayName ?? row.state.name}</b>
                                <span class="alpha-ext-chip" data-source={row.entry?.source ?? "user"}>
                                  {row.entry ? sourceLabel(row.entry.source) : t("alpha.ext.installedUnknown")}
                                </span>
                              </div>
                              <div class="alpha-ext-man-st">
                                <Show
                                  when={row.state.error}
                                  fallback={
                                    <>
                                      <span class="alpha-ext-man-dot" data-on={row.state.connected ? "" : undefined} />
                                      {row.state.connected ? t("alpha.ext.enabledLive") : t("alpha.ext.disabled")}
                                    </>
                                  }
                                >
                                  <span class="alpha-ext-man-dot" data-err="" />
                                  {row.state.error}
                                </Show>
                              </div>
                            </div>
                            <button
                              class="alpha-ext-sw"
                              data-on={row.state.connected ? "" : undefined}
                              aria-label={row.state.connected ? t("alpha.ext.enabled") : t("alpha.ext.disabled")}
                              onClick={() => void ext.setMcpConnected(row.state.name, !row.state.connected)}
                            />
                            <button
                              class="alpha-ext-iconbtn"
                              title={t("alpha.ext.remove")}
                              aria-label={t("alpha.ext.remove")}
                              onClick={() => void ext.removeMcp(row.state.name)}
                            >
                              <Svg class="alpha-ic alpha-ic-sm" d="M3 6h18M8 6V4h8v2M19 6l-1 14H6L5 6" />
                            </button>
                          </div>
                        )
                      }}
                    </For>
                  </div>
                </Show>
              </Show>

              {/* ░░ CREATE / IMPORT ░░ */}
              <Show when={tab() === "create"}>
                <Hero title={t("alpha.ext.tabCreate")} sub={t("alpha.ext.createSub")} />
                <div class="alpha-ext-form">
                  <div class="alpha-ext-seg">
                    <button data-on={createType() === "skill" ? "" : undefined} onClick={() => setCreateType("skill")}>
                      {t("alpha.ext.tabSkills")}
                    </button>
                    <button data-on={createType() === "agent" ? "" : undefined} onClick={() => setCreateType("agent")}>
                      Agent
                    </button>
                  </div>

                  <label class="alpha-ext-field">
                    <span class="alpha-ext-flabel">{t("alpha.ext.createName")}</span>
                    <input
                      class="alpha-ext-input"
                      placeholder={t("alpha.ext.createNamePh")}
                      value={fName()}
                      onInput={(e) => setFName(e.currentTarget.value)}
                    />
                  </label>
                  <label class="alpha-ext-field">
                    <span class="alpha-ext-flabel">{t("alpha.ext.createDesc")}</span>
                    <input
                      class="alpha-ext-input"
                      placeholder={t("alpha.ext.createDescPh")}
                      value={fDesc()}
                      onInput={(e) => setFDesc(e.currentTarget.value)}
                    />
                  </label>
                  <Show when={createType() === "agent"}>
                    <label class="alpha-ext-field">
                      <span class="alpha-ext-flabel">
                        {t("alpha.ext.createModel")} <span class="alpha-ext-opt">{t("alpha.ext.optional")}</span>
                      </span>
                      <input
                        class="alpha-ext-input alpha-mono"
                        placeholder={t("alpha.ext.createModelPh")}
                        value={fModel()}
                        onInput={(e) => setFModel(e.currentTarget.value)}
                      />
                    </label>
                  </Show>
                  <label class="alpha-ext-field">
                    <span class="alpha-ext-flabel">
                      {createType() === "skill" ? t("alpha.ext.createBodySkill") : t("alpha.ext.createBodyAgent")}
                    </span>
                    <textarea
                      class="alpha-ext-input alpha-ext-textarea alpha-mono"
                      placeholder={createType() === "skill" ? "# skill\n\n## When to use\n…" : "system prompt…"}
                      value={fBody()}
                      onInput={(e) => setFBody(e.currentTarget.value)}
                    />
                  </label>
                  <div>
                    <button
                      class="alpha-ext-add"
                      data-variant="primary"
                      disabled={busy() === "__create__" || !fName().trim()}
                      onClick={() => void submitCreate()}
                    >
                      {busy() === "__create__"
                        ? t("alpha.ext.adding")
                        : createType() === "skill"
                          ? t("alpha.ext.createSkillBtn")
                          : t("alpha.ext.createAgentBtn")}
                    </button>
                  </div>

                  <div class="alpha-ext-import">
                    <SecRow label={t("alpha.ext.importFrom")} />
                    <div class="alpha-ext-import-row">
                      <button class="alpha-ext-import-card" onClick={comingSoon}>
                        <Svg d="M3 7h6l2 2h10v9a2 2 0 0 1-2 2H3z" />
                        <span>
                          <b>{t("alpha.ext.importFolder")}</b>
                          <small>{t("alpha.ext.importFolderSub")}</small>
                        </span>
                      </button>
                      <button class="alpha-ext-import-card" onClick={comingSoon}>
                        <svg class="alpha-ic" viewBox="0 0 24 24" fill="none" aria-hidden="true">
                          <circle cx="6" cy="6" r="2.5" stroke="currentColor" stroke-width="1.6" />
                          <circle cx="6" cy="18" r="2.5" stroke="currentColor" stroke-width="1.6" />
                          <circle cx="18" cy="12" r="2.5" stroke="currentColor" stroke-width="1.6" />
                          <path d="M6 8.5v7M8.4 17l7.2-3.6M8.4 7l7.2 3.6" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" />
                        </svg>
                        <span>
                          <b>{t("alpha.ext.importGit")}</b>
                          <small>{t("alpha.ext.importGitSub")}</small>
                        </span>
                      </button>
                      <button class="alpha-ext-import-card" onClick={comingSoon}>
                        <Svg d="M3 9l9-5 9 5-9 5zM3 9v6l9 5 9-5V9" />
                        <span>
                          <b>{t("alpha.ext.importNpm")}</b>
                          <small>{t("alpha.ext.importNpmSub")}</small>
                        </span>
                      </button>
                    </div>
                  </div>
                </div>
              </Show>
            </div>
          </div>

          <Show when={toast()}>
            <div class="alpha-ext-toast">{toast()}</div>
          </Show>
        </div>

        {/* Install confirmation — staged by 添加, run on confirm. Backdrop/Escape cancel (alpha Dialog). */}
        <Dialog
          open={!!confirming()}
          onClose={() => setConfirming(null)}
          besideSidebar
          size="sm"
          title={confirming() ? t("alpha.ext.confirmTitle", { name: confirming()!.displayName }) : ""}
          footer={
            <>
              <Button variant="ghost" onClick={() => setConfirming(null)}>
                {t("alpha.ext.cancel")}
              </Button>
              <Button
                variant="primary"
                onClick={() => {
                  const e = confirming()
                  setConfirming(null)
                  if (e) void onAdd(e)
                }}
              >
                {t("alpha.ext.confirmInstall")}
              </Button>
            </>
          }
        >
          <Show when={confirming()}>
            {(entry) => (
              <div class="alpha-ext-confirm">
                <div class="alpha-ext-confirm-meta">
                  <span class="alpha-ext-chip" data-source={entry().source}>
                    {sourceLabel(entry().source)}
                  </span>
                  <span class="alpha-ext-confirm-type">{typeLabel(entry().type)}</span>
                </div>
                <p class="alpha-ext-confirm-desc">{entry().description}</p>
                <div class="alpha-ext-install-box">
                  <For each={confirmItems(entry())}>
                    {(it) => {
                      const ic = iconFor(it.entry)
                      return (
                        <div class="alpha-ext-install-row">
                          <span class="alpha-ext-install-ic" style={{ background: ic.color }}>
                            {ic.glyph}
                          </span>
                          <span class="alpha-ext-install-nm">{it.entry.displayName}</span>
                          <Show when={it.optional}>
                            <span class="alpha-ext-install-opt">{t("alpha.ext.optional")}</span>
                          </Show>
                          <span class="alpha-ext-install-k">{typeLabel(it.entry.type)}</span>
                        </div>
                      )
                    }}
                  </For>
                </div>
                <Show when={runtimeDeps(entry())}>
                  <div class="alpha-ext-confirm-line">
                    {t("alpha.ext.confirmRuntime")}: <code>{runtimeDeps(entry())}</code>
                  </div>
                </Show>
                <Show when={requiredKeys(entry())}>
                  <div class="alpha-ext-confirm-line">
                    {t("alpha.ext.confirmEnv")}: <code>{requiredKeys(entry())}</code>
                  </div>
                </Show>
                <p class="alpha-ext-confirm-note">{t("alpha.ext.confirmNote")}</p>
              </div>
            )}
          </Show>
        </Dialog>
      </Portal>
    </Show>
  )
}
