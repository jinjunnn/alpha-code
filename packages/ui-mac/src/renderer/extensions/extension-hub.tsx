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
import { pushToast } from "../alpha-ui/Toast"
import { Banner } from "../alpha-ui/Banner"
import type { ServerInfo } from "../sidebar/use-projects"
import { useExtensions } from "./use-extensions"
import type { Catalog, CatalogEntry, CatalogSource, InstalledState } from "./catalog-types"
import type { InstallReceipt, InstallReceiptType } from "../../preload/types"
import catalogJson from "./alpha-catalog.json"
import "./extension-hub.css"

const CATALOG = catalogJson as unknown as Catalog

// A unified row in the 已安装 manage list (REQ-018 T6): any installed item, whatever its type.
type ManageRow = {
  key: string
  type: InstallReceiptType
  name: string
  displayName: string
  source?: CatalogSource
  version?: string
  receipt: InstallReceipt
  entry?: CatalogEntry
  mcp?: InstalledState // MCP only — live connect/error status from the SDK
}

type Tab = "featured" | "connectors" | "skills" | "agents" | "plugins" | "bundles" | "installed" | "create"

const TABS: { key: Tab; labelKey: string }[] = [
  { key: "featured", labelKey: "alpha.ext.tabFeatured" },
  { key: "connectors", labelKey: "alpha.ext.tabConnectors" },
  { key: "skills", labelKey: "alpha.ext.tabSkills" },
  { key: "agents", labelKey: "alpha.ext.tabAgents" },
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

// Human label for an installed item's type, reusing the tab labels (连接器/技能/Agent/插件/套件/云).
function typeLabel(type: InstallReceiptType | CatalogEntry["type"]): string {
  if (type === "mcp") return t("alpha.ext.tabConnectors")
  if (type === "skill") return t("alpha.ext.tabSkills")
  if (type === "agent") return t("alpha.ext.typeAgent")
  if (type === "command") return t("alpha.ext.typeCommand")
  if (type === "plugin") return t("alpha.ext.tabPlugins")
  if (type === "cloud") return t("alpha.ext.typeCloud")
  return t("alpha.ext.tabBundles")
}

// Icon for a manage-list row: catalog metadata when known, else a type-tinted glyph from the name.
const TYPE_TINT: Record<string, string> = {
  mcp: "var(--a-accent)",
  skill: "#7c9c5a",
  agent: "#c08457",
  plugin: "#8a6ec0",
  bundle: "#5a8a9c",
  cloud: "#5c7cbf",
}
function iconForRow(entry: CatalogEntry | undefined, type: string, name: string): { color: string; glyph: string } {
  if (entry) return iconFor(entry)
  return { color: TYPE_TINT[type] ?? "var(--a-bg-inset)", glyph: (name[0] ?? "?").toUpperCase() }
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
function requiredEnvVarList(e: CatalogEntry): string[] {
  const spec = e.installSpec && e.installSpec.kind === "mcp" ? e.installSpec : undefined
  return spec?.requiredEnvVars ?? []
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
  const ext = useExtensions(props.server, props.open)
  const [tab, setTab] = createSignal<Tab>("featured")
  const [query, setQuery] = createSignal("")
  const [busy, setBusy] = createSignal<string | null>(null)
  // The entry awaiting install confirmation. 添加 stages it here (instead of installing directly), so
  // the user sees the fan-out / runtime deps / required keys and can back out.
  const [confirming, setConfirming] = createSignal<CatalogEntry | null>(null)
  // T5:确认弹窗采集的 requiredEnvVars 密钥值(仅内存;安装后清空)。经 addMcp → 主进程 {file:}
  // 通道落盘,绝不明文进 opencode.jsonc。切换/关闭弹窗即重置。
  const [envValues, setEnvValues] = createSignal<Record<string, string>>({})
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

  // Agent tab search: match name/description against the shared query.
  const matchesAgent = (a: { name: string; description?: string }) => {
    const q = query().trim().toLowerCase()
    if (!q) return true
    return a.name.toLowerCase().includes(q) || (a.description ?? "").toLowerCase().includes(q)
  }

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

  // 已安装 = 全类型统一视图(REQ-018 T6):receipts(skill/agent/plugin/mcp)⨝ SDK 的 MCP 实时
  // 状态(connected/error)。live-but-unrecorded 的 MCP(手动加/迁移前)也并入,合成最小 receipt
  // 以支持卸载。MCP 有开关(connected 真相取 SDK);fs/plugin 只有卸载。
  const installedAll = createMemo((): ManageRow[] => {
    const mcpByName = new Map(byType("mcp").map((e) => [e.name, e] as const))
    const rows: ManageRow[] = []
    const seenMcp = new Set<string>()
    for (const r of ext.store.receipts) {
      const entry = byId(r.id) ?? (r.type === "mcp" ? mcpByName.get(r.name) : undefined)
      if (r.type === "mcp") seenMcp.add(r.name)
      rows.push({
        key: `${r.type}:${r.name}`,
        type: r.type,
        name: r.name,
        displayName: entry?.displayName ?? r.name,
        source: entry?.source,
        version: r.version,
        receipt: r,
        entry,
        mcp: r.type === "mcp" ? ext.store.mcp[r.name] : undefined,
      })
    }
    // live MCP the SDK knows but we have no receipt for (manual / pre-migration) — allow uninstall.
    for (const s of Object.values(ext.store.mcp)) {
      if (seenMcp.has(s.name)) continue
      const entry = mcpByName.get(s.name)
      rows.push({
        key: `mcp:${s.name}`,
        type: "mcp",
        name: s.name,
        displayName: entry?.displayName ?? s.name,
        source: entry?.source,
        receipt: { id: entry?.id ?? `user:${s.name}`, name: s.name, type: "mcp", scope: "global", installedAt: "", origin: "created" },
        entry,
        mcp: s,
      })
    }
    return rows
  })

  // B11:收编进全局 pushToast(一处定义,各处复用)—— 原私有 .alpha-ext-toast 淘汰。
  const flash = (msg: string, kind: "info" | "success" | "error" = "info") => pushToast({ kind, title: msg })
  const comingSoon = () => flash(t("alpha.ext.comingSoon"))

  const addMcpEntry = async (
    e: CatalogEntry,
    secrets?: Record<string, string>,
  ): Promise<{ ok: boolean; reason?: string }> => {
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
    return ext.addMcp(e, undefined, workspace, secrets)
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
    flash(
      failCount > 0 ? `${okCount} 成功 · ${failCount} 失败` : t("alpha.ext.metaItems", { count: okCount }) + " · " + t("alpha.ext.added"),
      failCount > 0 ? "error" : "success",
    )
  }

  const onAdd = async (e: CatalogEntry, secrets?: Record<string, string>) => {
    setBusy(e.id)
    try {
      if (e.type === "mcp") {
        const res = await addMcpEntry(e, secrets)
        if (!res.ok) flash(`${t("alpha.ext.installFailed")}${res.reason ? `: ${res.reason}` : ""}`, "error")
        else if (res.reason === "slow") flash(t("alpha.ext.installSlow"))
        else flash(t("alpha.ext.added"), "success")
      } else if (e.type === "skill") {
        const res = await ext.installSkill(e)
        if (!res.ok) flash(`${t("alpha.ext.installFailed")}${res.reason ? `: ${res.reason}` : ""}`, "error")
        else if (res.reason === "reload-pending") flash(t("alpha.ext.addedPendingReload"))
        else flash(t("alpha.ext.added"), "success")
      } else if (e.type === "plugin") {
        const res = await ext.installPlugin(e)
        flash(res.ok ? t("alpha.ext.pluginRestart") : `${t("alpha.ext.installFailed")}${res.reason ? `: ${res.reason}` : ""}`, res.ok ? "success" : "error")
      } else if (e.type === "bundle") {
        await installBundle(e)
      }
    } finally {
      setBusy(null)
    }
  }

  const onUninstall = async (row: ManageRow) => {
    const res = await ext.uninstall(row.receipt)
    flash(
      res.ok ? t("alpha.ext.removed") : `${t("alpha.ext.removeFailed")}${res.reason ? `: ${res.reason}` : ""}`,
      res.ok ? "success" : "error",
    )
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
        flash(res.reason === "reload-pending" ? t("alpha.ext.addedPendingReload") : t("alpha.ext.added"), "success")
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
              {/* B11:mcp.status 整表读取失败此前静默空白(per-row error ≠ 整表失败) */}
              <Show when={ext.store.error}>
                <Banner
                  kind="error"
                  title={t("alpha.ext.loadFailed")}
                  detail={t("alpha.ext.loadFailedDetail")}
                  action={{ label: t("alpha.ext.retry"), onClick: () => void ext.refresh() }}
                />
              </Show>
              {/* ░░ FEATURED ░░ */}
              <Show when={tab() === "featured"}>
                <Hero title={t("alpha.ext.hub")} sub={t("alpha.ext.heroSub")} />
                <SearchBox placeholder={t("alpha.ext.search")} />
                <Show when={installedAll().length > 0}>
                  <SecRow
                    label={t("alpha.ext.tabInstalled")}
                    count={installedAll().length}
                    actionLabel={t("alpha.ext.manage")}
                    onAction={() => setTab("installed")}
                  />
                  <div class="alpha-ext-chips">
                    <For each={installedAll()}>
                      {(row) => {
                        const ic = iconForRow(row.entry, row.type, row.name)
                        return (
                          <span class="alpha-ext-chip-pill" title={row.name}>
                            <span class="alpha-ext-chip-d" style={{ background: ic.color }}>
                              {ic.glyph}
                            </span>
                            {row.displayName}
                            <Show when={row.mcp?.connected}>
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

              {/* ░░ AGENTS ░░ (REQ-018 T7 / ADR-014 O2:Agent 作一等原语) */}
              <Show when={tab() === "agents"}>
                <Hero title={t("alpha.ext.tabAgents")} sub={t("alpha.ext.agentsSub")} />
                <div class="alpha-ext-callout">
                  {t("alpha.ext.agentsNote")}
                  <button
                    class="alpha-ext-inline-cta"
                    onClick={() => {
                      setCreateType("agent")
                      setTab("create")
                    }}
                  >
                    {t("alpha.ext.createAgentCta")}
                  </button>
                </div>
                <Show
                  when={ext.store.agents.filter((a) => matchesAgent(a)).length > 0}
                  fallback={<EmptyState title={t("alpha.ext.noResults")} />}
                >
                  <SecRow label={t("alpha.ext.allAgents")} count={ext.store.agents.filter((a) => matchesAgent(a)).length} />
                  <div class="alpha-ext-grid">
                    <For each={ext.store.agents.filter((a) => matchesAgent(a))}>
                      {(a) => {
                        const ic = iconForRow(undefined, "agent", a.name)
                        const receipt = () => ext.store.receipts.find((r) => r.type === "agent" && r.name === a.name)
                        return (
                          <div class="alpha-ext-card">
                            <div class="alpha-ext-card-top">
                              <span class="alpha-ext-card-ic" style={{ background: ic.color }}>
                                {ic.glyph}
                              </span>
                              <div class="alpha-ext-card-hd">
                                <div class="alpha-ext-card-name">
                                  <b title={a.name}>{a.name}</b>
                                  <span class="alpha-ext-type-pill">
                                    {a.native ? t("alpha.ext.agentBuiltin") : t("alpha.ext.sourceAlpha")} · {a.mode}
                                  </span>
                                </div>
                              </div>
                            </div>
                            <p class="alpha-ext-card-desc">{a.description ?? t("alpha.ext.agentNoDesc")}</p>
                            <div class="alpha-ext-card-foot">
                              <Show
                                when={receipt()}
                                fallback={<span class="alpha-ext-meta">{t("alpha.ext.agentBuiltinNote")}</span>}
                              >
                                <button
                                  class="alpha-ext-add"
                                  onClick={() =>
                                    void onUninstall({
                                      key: `agent:${a.name}`,
                                      type: "agent",
                                      name: a.name,
                                      displayName: a.name,
                                      receipt: receipt()!,
                                    })
                                  }
                                >
                                  {t("alpha.ext.remove")}
                                </button>
                              </Show>
                            </div>
                          </div>
                        )
                      }}
                    </For>
                  </div>
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
                  when={installedAll().length > 0}
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
                  <SecRow label={t("alpha.ext.installedSection")} count={installedAll().length} />
                  <div class="alpha-ext-manage">
                    <For each={installedAll()}>
                      {(row) => {
                        const ic = iconForRow(row.entry, row.type, row.name)
                        return (
                          <div class="alpha-ext-man">
                            <span class="alpha-ext-man-ic" style={{ background: ic.color }}>
                              {ic.glyph}
                            </span>
                            <div class="alpha-ext-man-body">
                              <div class="alpha-ext-man-nm">
                                <b title={row.name}>{row.displayName}</b>
                                <span class="alpha-ext-type-pill">{typeLabel(row.type)}</span>
                                <Show when={row.version}>
                                  <span class="alpha-ext-ver">v{row.version}</span>
                                </Show>
                              </div>
                              <div class="alpha-ext-man-st">
                                {/* MCP: live SDK status (connected/error/disabled). fs/plugin: installed. */}
                                <Show
                                  when={row.type === "mcp"}
                                  fallback={
                                    <>
                                      <span class="alpha-ext-man-dot" data-on="" />
                                      {t("alpha.ext.installed")}
                                    </>
                                  }
                                >
                                  <Show
                                    when={row.mcp?.error}
                                    fallback={
                                      <>
                                        <span class="alpha-ext-man-dot" data-on={row.mcp?.connected ? "" : undefined} />
                                        {row.mcp?.connected ? t("alpha.ext.enabledLive") : t("alpha.ext.disabled")}
                                      </>
                                    }
                                  >
                                    <span class="alpha-ext-man-dot" data-err="" />
                                    {row.mcp?.error}
                                  </Show>
                                </Show>
                              </div>
                            </div>
                            {/* Toggle is MCP-only (connect/disconnect); fs/plugin have no live toggle. */}
                            <Show when={row.type === "mcp"}>
                              <button
                                class="alpha-ext-sw"
                                data-on={row.mcp?.connected ? "" : undefined}
                                aria-label={row.mcp?.connected ? t("alpha.ext.enabled") : t("alpha.ext.disabled")}
                                onClick={() => void ext.setMcpConnected(row.name, !row.mcp?.connected)}
                              />
                            </Show>
                            <button
                              class="alpha-ext-iconbtn"
                              title={t("alpha.ext.remove")}
                              aria-label={t("alpha.ext.remove")}
                              onClick={() => void onUninstall(row)}
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

        </div>

        {/* Install confirmation — staged by 添加, run on confirm. Backdrop/Escape cancel (alpha Dialog). */}
        <Dialog
          open={!!confirming()}
          onClose={() => {
            setConfirming(null)
            setEnvValues({})
          }}
          besideSidebar
          size="sm"
          title={confirming() ? t("alpha.ext.confirmTitle", { name: confirming()!.displayName }) : ""}
          footer={
            <>
              <Button
                variant="ghost"
                onClick={() => {
                  setConfirming(null)
                  setEnvValues({})
                }}
              >
                {t("alpha.ext.cancel")}
              </Button>
              <Button
                variant="primary"
                onClick={() => {
                  const e = confirming()
                  const secrets = envValues()
                  setConfirming(null)
                  setEnvValues({})
                  if (e) void onAdd(e, Object.keys(secrets).length ? secrets : undefined)
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
                <Show when={requiredEnvVarList(entry()).length}>
                  <div class="alpha-ext-confirm-keys">
                    <div class="alpha-ext-confirm-line">{t("alpha.ext.confirmEnv")}</div>
                    <For each={requiredEnvVarList(entry())}>
                      {(varName) => (
                        <label class="alpha-ext-key-field">
                          <span class="alpha-ext-key-name">{varName}</span>
                          <input
                            class="alpha-ext-key-input"
                            type="password"
                            autocomplete="off"
                            spellcheck={false}
                            placeholder={t("alpha.ext.keyPlaceholder")}
                            value={envValues()[varName] ?? ""}
                            onInput={(ev) => setEnvValues((prev) => ({ ...prev, [varName]: ev.currentTarget.value }))}
                          />
                        </label>
                      )}
                    </For>
                    <p class="alpha-ext-key-hint">{t("alpha.ext.keyHint")}</p>
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
