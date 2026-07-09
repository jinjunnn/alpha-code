// The Extension Hub (定制中心) — a full PAGE (not a modal) covering the content area, rendered as a
// sibling of <AlphaSidebar> inside AppInterface (renderer/index.tsx) via a dedicated Portal host on
// #root. Only mounted while open, so it can never intercept background clicks. Browsable items come
// from the bundled catalog; install status + actions go through useExtensions (receipts ⨝ SDK truth
// + thin persist IPC).
//
// IA (user-approved 2026-07-04, docs/designs/2026-07-04-ext-hub-m2/design.html — supersedes the
// left-rail sketch in the v3 design doc §5.1): a single HORIZONTAL tab bar (推荐/连接器/技能/Agent/
// 插件/套件/已安装[badge=updatable]/创建/云能力). 有更新 lives inside 已安装; 导入 lives inside 创建.
// The search box is GLOBAL and persistent (survives tab switches); a non-empty query shows
// cross-type results grouped by type. Clicking a card body opens the in-hub detail page
// (extension-detail.tsx) as a drill-down WITHIN the current tab (tab stays highlighted); Esc pops
// one level at a time (confirm dialog → detail → list → close).
//
// 「添加」三档分流 (Q1/Q2 approved): skill = direct install (no dialog); MCP/bundle = confirm
// dialog (key capture / fan-out list); plugin = detail-page-first (install from the page, with a
// risk line in its confirm dialog).

import { createEffect, createMemo, createSignal, For, Show, onCleanup, type Accessor, type JSX } from "solid-js"
import { Portal } from "solid-js/web"
import { t } from "../i18n"
import { GovernancePanel } from "./governance-panel"
import { catalog, catalogSource, entryVersion, refreshCatalog } from "./catalog-source"
import { Dialog } from "../alpha-ui/Dialog"
import { Button } from "../alpha-ui/Button"
import { pushToast } from "../alpha-ui/Toast"
import { Banner } from "../alpha-ui/Banner"
import type { ServerInfo } from "../sidebar/use-projects"
import { useExtensions, type HubAgent } from "./use-extensions"
import type { Catalog, CatalogEntry, InstalledState } from "./catalog-types"
import type { AuthState, InstallReceipt, InstallReceiptType, ProvenanceRequest } from "../../preload/types"
import { hubSection, setHubSection, type HubSection } from "./ext-hub-state"
import { iconFor, iconForRow, sourceLabel, typeLabel, Svg, SearchIc, LockIc } from "./ext-presentation"
import { ExtensionDetail, type DetailTarget } from "./extension-detail"
import "./extension-hub.css"


// A unified row in the 已安装 manage list (REQ-018 T6): any installed item, whatever its type.
type ManageRow = {
  key: string
  type: InstallReceiptType
  name: string
  displayName: string
  source?: CatalogEntry["source"]
  version?: string
  receipt: InstallReceipt
  entry?: CatalogEntry
  mcp?: InstalledState // MCP only — live connect/error status from the SDK
}

// Horizontal tab bar (REQ-019 T1, user-approved). 已安装 carries the updatable-count badge.
const TABS: { key: HubSection; labelKey: string }[] = [
  { key: "featured", labelKey: "alpha.ext.tabFeatured" },
  { key: "connectors", labelKey: "alpha.ext.tabConnectors" },
  { key: "skills", labelKey: "alpha.ext.tabSkills" },
  { key: "agents", labelKey: "alpha.ext.tabAgents" },
  { key: "plugins", labelKey: "alpha.ext.tabPlugins" },
  { key: "bundles", labelKey: "alpha.ext.tabBundles" },
  { key: "installed", labelKey: "alpha.ext.tabInstalled" },
  { key: "create", labelKey: "alpha.ext.tabCreate" },
  { key: "cloud", labelKey: "alpha.ext.tabCloud" },
]
const BROWSE_SECTIONS: readonly HubSection[] = ["featured", "connectors", "skills", "agents", "plugins", "bundles"]

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

// Numeric-aware version compare for catalog snapshot versions ("2026-07-03.1"): true if a < b.
function versionLess(a: string, b: string): boolean {
  const pa = a.split(/[^0-9]+/).filter(Boolean).map(Number)
  const pb = b.split(/[^0-9]+/).filter(Boolean).map(Number)
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const x = pa[i] ?? 0
    const y = pb[i] ?? 0
    if (x !== y) return x < y
  }
  return false
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
  } else if (e.type === "cloud") {
    out.push({ text: t("alpha.ext.metaCloudExec") })
    if (e.installSpec?.kind === "cloud") out.push({ text: e.installSpec.tier })
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

export function ExtensionHub(props: {
  server: Accessor<ServerInfo | undefined>
  open: Accessor<boolean>
  onClose: () => void
}) {
  const ext = useExtensions(props.server, props.open)
  const section = hubSection
  // REQ-020 T2:云门控。subscribe 会立即回放当前态(preload 内置 getState),再跟增量推送。
  // 云可用 ⟺ 已登录且 platform 模式(mcp.cloud 由 sidecar 在该态注入,ADR-013/ADR-016)。
  const [authState, setAuthState] = createSignal<AuthState>({ status: "logged-out", mode: "byok" })
  onCleanup(window.api.auth.subscribe(setAuthState))
  const cloudReady = () => authState().status === "logged-in" && authState().mode === "platform"
  const cloudLive = () => ext.store.mcp["cloud"]
  const [query, setQuery] = createSignal("")
  const [busy, setBusy] = createSignal<string | null>(null)
  // T7/T9:安装阶段(粗粒度状态机:checking→installing)与逐条行内错误(B11:失败不裸 toast)。
  const [stage, setStage] = createSignal<Record<string, "checking" | "installing">>({})
  const [cardErr, setCardErr] = createSignal<Record<string, string>>({})
  const setStageFor = (id: string, s: "checking" | "installing" | null) =>
    setStage((prev) => {
      const next = { ...prev }
      if (s) next[id] = s
      else delete next[id]
      return next
    })
  const setErrFor = (id: string, msg: string | null) =>
    setCardErr((prev) => {
      const next = { ...prev }
      if (msg) next[id] = msg
      else delete next[id]
      return next
    })
  // T7/E11:来源与许可证筛选(浏览区 + 全局搜索共用;清除筛选 = 空态推荐动作)。
  const [srcFilter, setSrcFilter] = createSignal<"all" | "official" | "community" | "alpha">("all")
  const [licFilter, setLicFilter] = createSignal<"all" | "MIT" | "Apache-2.0" | "mixed">("all")
  const filterMatch = (e: CatalogEntry) =>
    (srcFilter() === "all" || e.source === srcFilter()) && (licFilter() === "all" || e.license === licFilter())
  const filtersActive = () => srcFilter() !== "all" || licFilter() !== "all"
  const clearFilters = () => {
    setSrcFilter("all")
    setLicFilter("all")
  }
  // REQ-019 T2:详情页目标(catalog 条目或引擎 agent)。非空 = 当前 tab 内下钻显示详情页。
  const [detail, setDetail] = createSignal<DetailTarget | null>(null)
  // The entry awaiting install confirmation (MCP/bundle/plugin 档). Skill never lands here —
  // it installs directly (Q1). Plugin reaches here only from its detail page (Q2).
  const [confirming, setConfirming] = createSignal<CatalogEntry | null>(null)
  // T5:确认弹窗采集的 requiredEnvVars 密钥值(仅内存;安装后清空)。经 addMcp → 主进程 {file:}
  // 通道落盘,绝不明文进 opencode.jsonc。切换/关闭弹窗即重置。
  const [envValues, setEnvValues] = createSignal<Record<string, string>>({})
  // REQ-036:创建表单已移除(创建走技能:skill-creator/agent-creator 出厂注入),原表单 state 随之下线。
  // T3:存量迁移候选(旧 XDG 根里、名字匹配 catalog 的 alpha 安装物)。仅当主进程门控开启
  // (ALPHA_MIGRATE_ENABLE=1,A6 真机验证后)且有候选时显示迁移条。
  const [migrateCandidates, setMigrateCandidates] = createSignal<CatalogEntry[]>([])
  const [migrating, setMigrating] = createSignal(false)
  // T6:导入状态。importDialog = git/npm 输入弹窗;importBusy/importErr 行内反馈(B11)。
  const [importDialog, setImportDialog] = createSignal<"git" | "npm" | null>(null)
  // REQ-033:自定义连接器(catalog 外任意 MCP)+ agent 导入(两段式:预览映射 → 确认)
  const [customMcpOpen, setCustomMcpOpen] = createSignal(false)
  const [cmType, setCmType] = createSignal<"local" | "remote">("local")
  const [cmName, setCmName] = createSignal("")
  const [cmCommand, setCmCommand] = createSignal("")
  const [cmUrl, setCmUrl] = createSignal("")
  const [cmEnv, setCmEnv] = createSignal("")
  const [cmSecrets, setCmSecrets] = createSignal("")
  const [cmBusy, setCmBusy] = createSignal(false)
  const [cmErr, setCmErr] = createSignal("")
  const [agentPreview, setAgentPreview] = createSignal<{ previewId: string; name: string; format: string; mapping: Array<{ source: string; value: string; target: string | null; note: string }>; composed: string } | null>(null)
  const [agentBusy, setAgentBusy] = createSignal(false)
  const [agentErr, setAgentErr] = createSignal("")
  const [importInput, setImportInput] = createSignal("")
  const [importBusy, setImportBusy] = createSignal(false)
  const [importErr, setImportErr] = createSignal("")

  const runImportFolder = async () => {
    setImportErr("")
    const picked = await window.api.openDirectoryPicker({ title: t("alpha.ext.importFolderPick") })
    const dir = Array.isArray(picked) ? picked[0] : picked
    if (!dir) return
    setImportBusy(true)
    try {
      const r = await ext.importSkillFolder(dir)
      if (r.ok) flash(t("alpha.ext.imported", { name: r.name ?? "" }), "success")
      else setImportErr(r.reason ?? t("alpha.ext.installFailed"))
    } finally {
      setImportBusy(false)
    }
  }
  const runImportDialog = async () => {
    const kind = importDialog()
    const value = importInput().trim()
    if (!kind || !value) return
    setImportBusy(true)
    setImportErr("")
    try {
      const r = kind === "git" ? await ext.importSkillGit(value) : await ext.importNpmPlugin(value)
      if (r.ok) {
        flash(kind === "git" ? t("alpha.ext.imported", { name: (r as { name?: string }).name ?? "" }) : t("alpha.ext.pluginRestart"), "success")
        setImportDialog(null)
        setImportInput("")
      } else {
        setImportErr(r.reason ?? t("alpha.ext.installFailed"))
      }
    } finally {
      setImportBusy(false)
    }
  }

  // Tab navigation always leaves the detail page (a detail is a drill-down of its tab).
  const gotoSection = (key: HubSection) => {
    setDetail(null)
    setHubSection(key)
  }
  const openEntryDetail = (e: CatalogEntry) => setDetail({ kind: "entry", entry: e })
  const openAgentDetail = (a: HubAgent) => setDetail({ kind: "agent", agent: a })
  const sectionLabel = () => {
    const tab = TABS.find((x) => x.key === section())
    return tab ? t(tab.labelKey as never) : t("alpha.ext.hub")
  }

  // The component stays mounted across open/close (only the Portal content is gated), so
  // component-local signals survive a close. 分区记忆是故意的(session 内);详情页与搜索词不是 ——
  // 关闭时重置,重开回到当前分区的列表(review 发现:详情页上点 ✕ 关闭再开会残留 stale 详情)。
  createEffect(() => {
    if (!props.open()) {
      setDetail(null)
      setQuery("")
    } else {
      // REQ-032:进 hub 时刷新远端 catalog(main 侧 ETag 304 零成本;失败回退缓存/内置,B20 永不空白)
      void refreshCatalog()
    }
  })

  const parseEnvLines = (text: string): Record<string, string> => {
    const out: Record<string, string> = {}
    for (const line of text.split("\n")) {
      const i = line.indexOf("=")
      if (i > 0) out[line.slice(0, i).trim()] = line.slice(i + 1).trim()
    }
    return out
  }
  async function runAddCustomMcp() {
    if (cmBusy()) return
    setCmBusy(true)
    setCmErr("")
    try {
      const input =
        cmType() === "remote"
          ? { mcpType: "remote" as const, url: cmUrl().trim() }
          : { mcpType: "local" as const, command: cmCommand().trim().split(/\s+/).filter(Boolean) }
      const r = await ext.addCustomMcp(cmName().trim(), input, parseEnvLines(cmEnv()), parseEnvLines(cmSecrets()))
      if (!r.ok) {
        setCmErr(r.reason ?? "failed")
        return
      }
      setCustomMcpOpen(false)
      setCmName(""); setCmCommand(""); setCmUrl(""); setCmEnv(""); setCmSecrets("")
      flash(r.reason === "slow" ? t("alpha.ext.customMcpSlow") : t("alpha.ext.customMcpDone"), "success")
    } finally {
      setCmBusy(false)
    }
  }
  async function runPickAgentFile() {
    setAgentErr("")
    // openFilePicker 返回 { token, files }(授权注册表);preview 经 token 读(codex H1/M2)
    const picked = await window.api.openFilePicker({ title: t("alpha.ext.importAgentPick"), extensions: ["md"] })
    if (!picked || !picked.files?.length) return
    setAgentBusy(true)
    try {
      const r = await window.api.ext.importAgentPreview(picked.token, picked.files[0].path)
      if (!r.ok) {
        setAgentErr(r.reason)
        return
      }
      setAgentPreview(r)
    } finally {
      setAgentBusy(false)
    }
  }
  async function runConfirmAgentImport() {
    const pv = agentPreview()
    if (!pv || agentBusy()) return
    setAgentBusy(true)
    try {
      const r = await window.api.ext.importAgentConfirm(pv.previewId)
      if (!r.ok) {
        setAgentErr(r.reason)
        return
      }
      setAgentPreview(null)
      await ext.refreshEngine()
      void ext.reloadAgents()
      flash(t("alpha.ext.importAgentDone", { name: pv.name }), "success")
    } finally {
      setAgentBusy(false)
    }
  }

  // Dedicated Portal host inside #root (mirrors alpha-sidebar.tsx), kept out of <body> so it stays
  // inside opencode's drag-region system and keeps position:fixed working.
  const host = document.createElement("div")
  host.setAttribute("data-alpha-ext-hub", "")
  document.getElementById("root")?.appendChild(host)
  onCleanup(() => host.remove())

  // Esc pops ONE level per press (REQ-019 T2): confirm dialog (owned by alpha Dialog) → detail →
  // hub. While the confirm dialog is up, Dialog's own listener closes it — the hub must not also act.
  const onKey = (e: KeyboardEvent) => {
    if (e.key !== "Escape" || !props.open()) return
    if (confirming()) return
    if (detail()) {
      setDetail(null)
      return
    }
    props.onClose()
  }
  document.addEventListener("keydown", onKey)
  onCleanup(() => document.removeEventListener("keydown", onKey))

  // Agent search: match name/description against the shared query.
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
  const byType = (type: CatalogEntry["type"]) => catalog().entries.filter((e) => e.type === type)
  // 浏览区/搜索共用的筛选视图(T7/E11:来源+许可证)。
  const byTypeF = (type: CatalogEntry["type"]) => byType(type).filter(filterMatch)
  const byId = (id: string) => catalog().entries.find((e) => e.id === id)

  // Global search (REQ-019 T1): a non-empty query searches ALL types at once, grouped by type —
  // regardless of which browse tab is active. Clearing the query returns to the tab's list.
  const searching = () => query().trim().length > 0
  const searchGroups = createMemo(() => {
    if (!searching()) return []
    const groups: { label: string; items: CatalogEntry[] }[] = []
    for (const ty of ["mcp", "skill", "agent", "plugin", "bundle", "cloud"] as const) {
      const items = byTypeF(ty).filter(matches)
      if (items.length) groups.push({ label: typeLabel(ty), items })
    }
    return groups
  })
  // REQ-079 curation:浏览/搜索面只出现「自建」agent;引擎原生内置(build/plan/general/…)
  // 不再平铺 —— 其查看与管理唯一入口 = 已安装 → 内置 治理面板(governance-panel)。
  const ownAgents = createMemo(() => ext.store.agents.filter((a) => !a.native))
  const searchAgents = createMemo(() => (searching() ? ownAgents().filter(matchesAgent) : []))

  // Connectors grouped by category (fixed order) — drives the 连接器 tab subheaders.
  const groupedConnectors = createMemo(() => {
    const list = byTypeF("mcp")
    const map = new Map<string, CatalogEntry[]>()
    for (const e of list) {
      const k = (CAT_ORDER as readonly string[]).includes(e.category) ? e.category : "other"
      const arr = map.get(k) ?? []
      arr.push(e)
      map.set(k, arr)
    }
    return CAT_ORDER.filter((c) => map.has(c)).map((c) => ({ cat: c as string, items: map.get(c)! }))
  })

  const featuredBundles = createMemo(() => byType("bundle").slice(0, 3))
  const featuredConnectors = createMemo(() =>
    FEATURED_CONNECTORS.map((id) => byId(id)).filter((e): e is CatalogEntry => !!e),
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

  // 有更新(REQ-019 T1:已安装 tab 角标 + 列表顶部分组;T5 接更新动作):receipt 记录的 catalog
  // 快照版本落后于当前 catalog,且条目仍在目录中。created/imported 无版本概念,不参与。
  const updatable = createMemo(() =>
    ext.store.receipts.filter(
      // REQ-032:条目级更新判定(receipt.version vs entry.version;X7:非 catalog 来源不参与角标)
      (r) => r.origin !== "imported" && r.origin !== "created" && !!r.version && !!byId(r.id) && versionLess(r.version, entryVersion(byId(r.id))),
    ),
  )

  // B11:收编进全局 pushToast(一处定义,各处复用)—— toast 只报成功,失败走行内。
  const flash = (msg: string, kind: "info" | "success" | "error" = "info") => pushToast({ kind, title: msg })
  const comingSoon = () => flash(t("alpha.ext.comingSoon"))

  // REQ-019 T5:更新执行状态(busy = receipt id;失败行内呈现,不裸 toast)。
  const [updBusy, setUpdBusy] = createSignal<string | null>(null)
  const [updErr, setUpdErr] = createSignal<Record<string, string>>({})
  const runUpdate = async (r: InstallReceipt) => {
    const target = byId(r.id)
    if (!target) return
    setUpdErr((prev) => ({ ...prev, [r.id]: "" }))
    // MCP:persistMcp 为覆盖写,静默重装会丢 {file:} 密钥引用 → 走确认框重装(密钥可重填)。
    if (target.type === "mcp") return setConfirming(target)
    setUpdBusy(r.id)
    try {
      const res = await ext.updateEntry(target)
      if (res.ok) flash(t("alpha.ext.updated"), "success")
      else setUpdErr((prev) => ({ ...prev, [r.id]: res.reason ?? t("alpha.ext.installFailed") }))
    } finally {
      setUpdBusy(null)
    }
  }
  const runUpdateAll = async () => {
    for (const r of updatable()) await runUpdate(r)
  }

  const addMcpEntry = async (
    e: CatalogEntry,
    secrets?: Record<string, string>,
    skipCheck?: boolean, // onAdd 已做「检查中」阶段时跳过重复 which
  ): Promise<{ ok: boolean; reason?: string }> => {
    const spec = e.installSpec && e.installSpec.kind === "mcp" ? e.installSpec : undefined
    if (!skipCheck) {
      const rc = await ext.checkRuntime(spec?.runtimeDep)
      if (!rc.ok) return { ok: false, reason: t("alpha.ext.runtimeMissing", { tool: rc.missing }) }
    }
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
      else if (sub.type === "agent") r = await ext.installAgentEntry(sub)
      else r = { ok: false, reason: "unsupported in bundle" }
      if (r.ok) okCount++
      else {
        setErrFor(sub.id, r.reason ?? t("alpha.ext.installFailed")) // 子项行内(卡片/套件详情)
        if (!it.optional) failCount++
      }
    }
    // B11:toast 只报成功;部分失败 → 套件条目行内错误 + 详情页逐项重试。
    if (failCount > 0) setErrFor(e.id, t("alpha.ext.bundlePartialFail", { ok: okCount, fail: failCount }))
    else flash(t("alpha.ext.metaItems", { count: okCount }) + " · " + t("alpha.ext.added"), "success")
  }

  // T7(B11)+T9:失败一律行内(卡片错误行 / 详情页同款),toast 只报成功;安装阶段粗状态机
  // (MCP:检查中→安装中;其余:安装中)反映在按钮文案上。
  const onAdd = async (e: CatalogEntry, secrets?: Record<string, string>) => {
    setBusy(e.id)
    setErrFor(e.id, null)
    try {
      if (e.type === "mcp") {
        setStageFor(e.id, "checking")
        const spec = e.installSpec && e.installSpec.kind === "mcp" ? e.installSpec : undefined
        const rc = await ext.checkRuntime(spec?.runtimeDep)
        if (!rc.ok) return setErrFor(e.id, t("alpha.ext.runtimeMissing", { tool: rc.missing }))
        setStageFor(e.id, "installing")
        const res = await addMcpEntry(e, secrets, true)
        if (!res.ok) setErrFor(e.id, res.reason ?? t("alpha.ext.installFailed"))
        else if (res.reason === "slow") flash(t("alpha.ext.installSlow"))
        else flash(t("alpha.ext.added"), "success")
      } else if (e.type === "skill") {
        setStageFor(e.id, "installing")
        const res = await ext.installSkill(e)
        if (!res.ok) setErrFor(e.id, res.reason ?? t("alpha.ext.installFailed"))
        else if (res.reason === "reload-pending") flash(t("alpha.ext.addedPendingReload"))
        else flash(t("alpha.ext.addedLive"), "success")
      } else if (e.type === "agent") {
        setStageFor(e.id, "installing")
        const res = await ext.installAgentEntry(e)
        if (!res.ok) setErrFor(e.id, res.reason ?? t("alpha.ext.installFailed"))
        else if (res.reason === "reload-pending") flash(t("alpha.ext.addedPendingReload"))
        else flash(t("alpha.ext.addedLive"), "success")
      } else if (e.type === "plugin") {
        setStageFor(e.id, "installing")
        const res = await ext.installPlugin(e)
        if (!res.ok) setErrFor(e.id, res.reason ?? t("alpha.ext.installFailed"))
        else flash(t("alpha.ext.pluginRestart"), "success")
      } else if (e.type === "bundle") {
        setStageFor(e.id, "installing")
        await installBundle(e)
      } else if (e.type === "cloud") {
        // REQ-020 T4:「启用」= receipts-only(账本可用列表);门控在按钮层(!cloudReady 禁用)。
        setStageFor(e.id, "installing")
        const res = await ext.enableCloud(e)
        if (!res.ok) setErrFor(e.id, res.reason ?? t("alpha.ext.installFailed"))
        else flash(t("alpha.ext.cloudEnabled"), "success")
      }
    } finally {
      setBusy(null)
      setStageFor(e.id, null)
    }
  }

  // 「添加」三档分流(2026-07-04 拍板,Q1/Q2):
  //   skill  → 直装(零配置零密钥,免确认框);
  //   plugin → 详情页先行(风险最高:运行于引擎进程 + npm 下载),页内安装再过风险确认框;
  //   mcp / bundle → 确认框(密钥采集 / 选目录 / 组合清单)。
  const stageInstall = (e: CatalogEntry) => {
    if (e.type === "skill") return void onAdd(e)
    // plugin(引擎进程内运行)/ agent(带权限档)/ cloud(数据出境,上行明细在详情页)=
    // 详情页先行档:先看清楚再启用。
    if (e.type === "plugin" || e.type === "agent" || e.type === "cloud") return openEntryDetail(e)
    setConfirming(e)
  }
  // Install action coming FROM the detail page: plugin now goes to its risk confirm dialog
  // (the user has just seen the hooks/risk sections); skill stays direct; the rest confirm.
  const stageInstallFromDetail = (e: CatalogEntry) => {
    // 用户已在详情页看过内容/权限:skill/agent 直装;cloud 直启用(上行明细刚看过);
    // plugin 仍过风险确认框;MCP/套件过确认框。
    if (e.type === "skill" || e.type === "agent" || e.type === "cloud") return void onAdd(e)
    setConfirming(e)
  }

  const onUninstall = async (receipt: InstallReceipt) => {
    const res = await ext.uninstall(receipt)
    flash(
      res.ok ? t("alpha.ext.removed") : `${t("alpha.ext.removeFailed")}${res.reason ? `: ${res.reason}` : ""}`,
      res.ok ? "success" : "error",
    )
  }

  // T3:开 hub 时扫描旧 XDG 根,匹配 catalog(只迁 alpha 自己装的,不碰用户自建内容,ADR-019 §4)。
  // REQ-044:名字匹配只定位候选;main 侧 provenance 终审(skill=与打包资产逐字节比对,mcp/plugin=
  // catalog 形状比对)放行才列入 —— 同名用户自建被排除(fail-closed),排除原因见 main.log
  // [req044-provenance]。此前名字命中即候选,「迁移」会用 catalog 版覆盖并删除用户自建旧位。
  const provenanceRequest = (e: CatalogEntry): ProvenanceRequest | null => {
    if (e.type === "skill")
      return { type: "skill", name: e.name, builtinAssetKey: e.installSpec?.kind === "skill" ? e.installSpec.builtinAssetKey : undefined }
    if (e.type === "mcp" && e.installSpec?.kind === "mcp") {
      const s = e.installSpec
      return {
        type: "mcp",
        name: e.name,
        spec: {
          mcpType: s.mcpType,
          command: s.command,
          mirrorCommand: s.mirrorCommand,
          url: s.url,
          requiredEnvVars: s.requiredEnvVars,
          headerNames: Object.keys(s.headersTemplate ?? {}),
        },
      }
    }
    if (e.type === "plugin" && e.installSpec?.kind === "plugin") return { type: "plugin", name: e.name, package: e.installSpec.package }
    return null
  }
  const scanMigration = async () => {
    try {
      const { enabled, inventory } = await window.api.ext.migrateScan()
      if (!enabled) return setMigrateCandidates([])
      const skillNames = new Set(inventory.skills)
      const mcpNames = new Set(inventory.mcp.map((m) => m.name))
      const pluginBases = new Set(inventory.plugins.map((p) => p.split("@")[0]))
      const named = catalog().entries.filter((e) => {
        if (e.type === "skill") return skillNames.has(e.name)
        if (e.type === "mcp") return mcpNames.has(e.name)
        if (e.type === "plugin" && e.installSpec?.kind === "plugin") return pluginBases.has(e.installSpec.package.split("@")[0])
        return false
      })
      const requests = named.map(provenanceRequest).filter((r): r is ProvenanceRequest => r !== null)
      const verdicts = requests.length ? await window.api.ext.migrateVerify(requests) : []
      const passed = new Set(verdicts.filter((v) => v.verified).map((v) => `${v.type}:${v.name}`))
      setMigrateCandidates(named.filter((e) => passed.has(`${e.type}:${e.name}`)))
    } catch {
      setMigrateCandidates([])
    }
  }
  createEffect(() => {
    if (props.open()) void scanMigration()
  })

  // Migrate each candidate: reinstall to .alpha via the existing installer (pins MCP version from
  // catalog + moves inline secrets to the {file:} channel), then remove the legacy copy.
  const runMigration = async () => {
    setMigrating(true)
    let ok = 0
    let fail = 0
    try {
      for (const e of migrateCandidates()) {
        let installed: { ok: boolean } = { ok: false }
        if (e.type === "skill") installed = await ext.installSkill(e)
        else if (e.type === "mcp") installed = await addMcpEntry(e)
        else if (e.type === "plugin") installed = await ext.installPlugin(e)
        if (!installed.ok) {
          fail++
          continue
        }
        const legacyName = e.type === "plugin" && e.installSpec?.kind === "plugin" ? e.installSpec.package : e.name
        await window.api.ext.removeLegacy(e.type as "skill" | "mcp" | "plugin", legacyName)
        ok++
      }
      flash(fail ? `${t("alpha.ext.migrated", { count: ok })} · ${fail} 失败` : t("alpha.ext.migrated", { count: ok }), fail ? "error" : "success")
      await scanMigration()
    } finally {
      setMigrating(false)
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

  const SecRow = (cp: { label: string; count?: number; warn?: boolean; actionLabel?: string; onAction?: () => void }) => (
    <div class="alpha-ext-secrow">
      <span class="alpha-ext-overline" data-warn={cp.warn ? "" : undefined}>
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

  // T7/E11:来源 + 许可证筛选 chips(浏览区共用;全局搜索也吃同一组筛选)。
  const Filters = () => (
    <div class="alpha-ext-filters">
      <span class="alpha-ext-filters-l">{t("alpha.ext.filterSource")}</span>
      <For each={["all", "official", "community", "alpha"] as const}>
        {(v) => (
          <button class="alpha-ext-fchip" data-on={srcFilter() === v ? "" : undefined} onClick={() => setSrcFilter(v)}>
            {v === "all" ? t("alpha.ext.filterAll") : sourceLabel(v)}
          </button>
        )}
      </For>
      <span class="alpha-ext-filters-l" style={{ "margin-left": "10px" }}>
        {t("alpha.ext.filterLicense")}
      </span>
      <For each={["all", "MIT", "Apache-2.0", "mixed"] as const}>
        {(v) => (
          <button class="alpha-ext-fchip" data-on={licFilter() === v ? "" : undefined} onClick={() => setLicFilter(v)}>
            {v === "all" ? t("alpha.ext.filterAll") : v}
          </button>
        )}
      </For>
    </div>
  )
  // 筛选后空态:一句引导 + 清除筛选推荐动作(T7 空态纪律)。
  const FilteredEmpty = () => (
    <EmptyState
      title={t("alpha.ext.noResults")}
      sub={filtersActive() ? t("alpha.ext.filteredEmptySub") : undefined}
      action={
        filtersActive() ? (
          <button class="alpha-ext-add" data-variant="primary" onClick={clearFilters}>
            {t("alpha.ext.clearFilters")}
          </button>
        ) : undefined
      }
    />
  )

  // One browsable entry as a card (icon · name/chip · desc · meta + action). The card body opens the
  // detail page (drill-down); the foot action runs the per-type install path (stageInstall) — or
  // 打开详情 when already installed.
  const Card = (cp: { e: CatalogEntry }) => {
    const e = cp.e
    const ic = iconFor(e)
    const installedNow = createMemo(() => ext.isInstalled(e))
    // REQ-036 / S18 X1:出厂注入的技能(skills.paths)显示「出厂内置」而非「安装」——已经处处可用,
    // 再给安装按钮是双重身份混乱;关掉出厂注入(逃生开关)时名单为空,条目自动回到可安装态。
    const isFactory = createMemo(() => e.type === "skill" && ext.factorySkills().includes(e.name))
    const isBusy = () => busy() === e.id
    return (
      <div class="alpha-ext-card" data-clickable="" onClick={() => openEntryDetail(e)}>
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
              <Show when={e._verify ?? e.installSpec?._verify}>
                <span class="alpha-ext-verify-chip">{t("alpha.ext.verifyPending")}</span>
              </Show>
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
            when={!isFactory()}
            fallback={
              <button
                class="alpha-ext-add"
                data-variant="installed"
                onClick={(ev) => {
                  ev.stopPropagation()
                  openEntryDetail(e)
                }}
              >
                {t("alpha.ext.factoryBuiltin")}
              </button>
            }
          >
            <Show
              when={!installedNow()}
              fallback={
                <button
                  class="alpha-ext-add"
                  data-variant="installed"
                  onClick={(ev) => {
                    ev.stopPropagation()
                    openEntryDetail(e)
                  }}
                >
                  ✓ {t("alpha.ext.openDetail")}
                </button>
              }
            >
              <button
                class="alpha-ext-add"
                data-variant="primary"
                disabled={isBusy()}
                onClick={(ev) => {
                  ev.stopPropagation()
                  stageInstall(e)
                }}
              >
                {stage()[e.id] === "checking"
                  ? t("alpha.ext.stageChecking")
                  : stage()[e.id] === "installing" || isBusy()
                    ? t("alpha.ext.stageInstalling")
                    : e.type === "cloud"
                      ? t("alpha.ext.enableCloud")
                      : t("alpha.ext.add")}
              </button>
            </Show>
          </Show>
        </div>
        {/* B11:失败行内(错误 chip 行),不裸 toast */}
        <Show when={cardErr()[e.id]}>
          <p class="alpha-ext-card-err">{cardErr()[e.id]}</p>
        </Show>
      </div>
    )
  }

  const Grid = (cp: { items: CatalogEntry[] }) => (
    <div class="alpha-ext-grid">
      <For each={cp.items}>{(e) => <Card e={e} />}</For>
    </div>
  )

  // One engine agent as a card (Agent tab + global search). Card body opens the agent detail.
  const AgentCard = (cp: { a: HubAgent }) => {
    const a = cp.a
    const ic = iconForRow(undefined, "agent", a.name)
    const receipt = () => ext.store.receipts.find((r) => r.type === "agent" && r.name === a.name)
    return (
      <div class="alpha-ext-card" data-clickable="" onClick={() => openAgentDetail(a)}>
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
            fallback={
              <span class="alpha-ext-meta">{a.native ? t("alpha.ext.agentBuiltinNote") : t("alpha.ext.agentOwnNote")}</span>
            }
          >
            <button
              class="alpha-ext-add"
              onClick={(ev) => {
                ev.stopPropagation()
                void onUninstall(receipt()!)
              }}
            >
              {t("alpha.ext.remove")}
            </button>
          </Show>
        </div>
      </div>
    )
  }

  // Featured-tab bundle hero row (wider, richer than a grid card).
  const KitRow = (cp: { e: CatalogEntry }) => {
    const e = cp.e
    const ic = iconFor(e)
    const isBusy = () => busy() === e.id
    return (
      <div class="alpha-ext-kit" data-clickable="" onClick={() => openEntryDetail(e)}>
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
        <button
          class="alpha-ext-add"
          data-variant="primary"
          disabled={isBusy()}
          onClick={(ev) => {
            ev.stopPropagation()
            stageInstall(e)
          }}
        >
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
          {/* ░░ HORIZONTAL TAB BAR (user-approved IA) ░░ */}
          <nav class="alpha-ext-tabs">
            <div class="alpha-ext-tabs-inner">
              <For each={TABS}>
                {(item) => (
                  <button
                    class="alpha-ext-tab"
                    data-active={section() === item.key ? "" : undefined}
                    onClick={() => gotoSection(item.key)}
                  >
                    {t(item.labelKey as never)}
                    <Show when={item.key === "installed" && updatable().length > 0}>
                      <span class="alpha-ext-tab-badge">{updatable().length}</span>
                    </Show>
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

              <Show
                when={!detail()}
                fallback={
                  <ExtensionDetail
                    target={detail()!}
                    ext={ext}
                    catalogVersion={catalog().version}
                    byId={byId}
                    busy={busy}
                    crumb={sectionLabel()}
                    errorFor={(id) => cardErr()[id]}
                    onBack={() => setDetail(null)}
                    onInstall={(e) => stageInstallFromDetail(e)}
                    onUninstall={(r) => void onUninstall(r)}
                    onOpenEntry={(e) => openEntryDetail(e)}
                    cloudReady={cloudReady}
                    onLogin={authState().status !== "logged-in" ? () => void window.api.auth.start() : undefined}
                  />
                }
              >
                {/* Global persistent search — browse tabs only; a non-empty query shows
                    cross-type grouped results (REQ-019 T1). */}
                <Show when={BROWSE_SECTIONS.includes(section())}>
                  <div class="alpha-ext-search">
                    <span class="alpha-ext-search-ic">
                      <SearchIc />
                    </span>
                    <input
                      type="search"
                      placeholder={t("alpha.ext.search")}
                      value={query()}
                      onInput={(ev) => setQuery(ev.currentTarget.value)}
                    />
                  </div>
                </Show>

                {/* ░░ GLOBAL SEARCH RESULTS ░░ */}
                <Show when={searching() && BROWSE_SECTIONS.includes(section())}>
                  <Show
                    when={searchGroups().length > 0 || searchAgents().length > 0}
                    fallback={<EmptyState title={t("alpha.ext.noResults")} />}
                  >
                    <For each={searchGroups()}>
                      {(g) => (
                        <>
                          <SecRow label={g.label} count={g.items.length} />
                          <Grid items={g.items} />
                        </>
                      )}
                    </For>
                    <Show when={searchAgents().length > 0}>
                      <SecRow label={t("alpha.ext.typeAgent")} count={searchAgents().length} />
                      <div class="alpha-ext-grid">
                        <For each={searchAgents()}>{(a) => <AgentCard a={a} />}</For>
                      </div>
                    </Show>
                  </Show>
                </Show>

                <Show when={!searching() || !BROWSE_SECTIONS.includes(section())}>
                  {/* ░░ FEATURED ░░ */}
                  <Show when={section() === "featured"}>
                    <Hero title={t("alpha.ext.hub")} sub={t("alpha.ext.heroSub")} />
                    {/* T3:存量迁移条(仅门控开启且检测到旧安装时;不碰用户自建内容) */}
                    <Show when={migrateCandidates().length > 0}>
                      <div class="alpha-ext-migrate">
                        <div class="alpha-ext-migrate-t">
                          {t("alpha.ext.migrateTitle", { count: migrateCandidates().length })}
                        </div>
                        <div class="alpha-ext-migrate-sub">{t("alpha.ext.migrateSub")}</div>
                        <button class="alpha-ext-add" data-variant="primary" disabled={migrating()} onClick={() => void runMigration()}>
                          {migrating() ? t("alpha.ext.migrating") : t("alpha.ext.migrateAction")}
                        </button>
                      </div>
                    </Show>
                    <Show when={installedAll().length > 0}>
                      <SecRow
                        label={t("alpha.ext.tabInstalled")}
                        count={installedAll().length}
                        actionLabel={t("alpha.ext.manage")}
                        onAction={() => gotoSection("installed")}
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
                      onAction={() => gotoSection("bundles")}
                    />
                    <For each={featuredBundles()}>{(e) => <KitRow e={e} />}</For>

                    <SecRow
                      label={t("alpha.ext.hotConnectors")}
                      actionLabel={t("alpha.ext.viewAll")}
                      onAction={() => gotoSection("connectors")}
                    />
                    <Grid items={featuredConnectors()} />
                  </Show>

                  {/* ░░ CONNECTORS (grouped by category) ░░ */}
                  <Show when={section() === "connectors"}>
                    <Hero title={t("alpha.ext.tabConnectors")} sub={t("alpha.ext.connectorsSub")} />
                    <Filters />
                    <Show when={groupedConnectors().length > 0} fallback={<FilteredEmpty />}>
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
                  <Show when={section() === "skills"}>
                    <Hero title={t("alpha.ext.tabSkills")} sub={t("alpha.ext.skillsSub")} />
                    <Filters />
                    <Show
                      when={byTypeF("skill").length > 0}
                      fallback={<FilteredEmpty />}
                    >
                      <SecRow label={t("alpha.ext.allSkills")} count={byTypeF("skill").length} />
                      <Grid items={byTypeF("skill")} />
                    </Show>
                  </Show>

                  {/* ░░ AGENTS ░░ (REQ-018 T7 / ADR-014 O2:Agent 作一等原语) */}
                  <Show when={section() === "agents"}>
                    <Hero title={t("alpha.ext.tabAgents")} sub={t("alpha.ext.agentsSub")} />
                    <div class="alpha-ext-callout">
                      {t("alpha.ext.agentsNote")}
                      {/* REQ-036:创建表单已移除;创建 = 会话内经 agent-creator(出厂技能)对话式生成 */}
                      <span class="alpha-ext-dnote"> {t("alpha.ext.createAgentViaChat")}</span>
                    </div>
                    <Show when={byTypeF("agent").length > 0}>
                      <SecRow label={t("alpha.ext.installableAgents")} count={byTypeF("agent").length} />
                      <Grid items={byTypeF("agent")} />
                    </Show>
                    {/* REQ-079:引擎原生内置不再平铺(管理归治理面板);浏览面只剩精选 + 自建 */}
                    <Show when={ownAgents().length > 0}>
                      <SecRow label={t("alpha.ext.ownAgents")} count={ownAgents().length} />
                      <div class="alpha-ext-grid">
                        <For each={ownAgents()}>{(a) => <AgentCard a={a} />}</For>
                      </div>
                    </Show>
                    <Show when={byTypeF("agent").length === 0 && ownAgents().length === 0}>
                      <EmptyState title={t("alpha.ext.noResults")} />
                    </Show>
                  </Show>

                  {/* ░░ PLUGINS ░░ */}
                  <Show when={section() === "plugins"}>
                    <Hero title={t("alpha.ext.tabPlugins")} sub={t("alpha.ext.pluginsSub")} />
                    <div class="alpha-ext-callout">{t("alpha.ext.pluginNote")}</div>
                    <Filters />
                    <Show when={byTypeF("plugin").length > 0} fallback={<FilteredEmpty />}>
                      <SecRow label={t("alpha.ext.allPlugins")} count={byTypeF("plugin").length} />
                      <Grid items={byTypeF("plugin")} />
                    </Show>
                  </Show>

                  {/* ░░ BUNDLES ░░ */}
                  <Show when={section() === "bundles"}>
                    <Hero title={t("alpha.ext.tabBundles")} sub={t("alpha.ext.bundlesSub")} />
                    <Filters />
                    <Show when={byTypeF("bundle").length > 0} fallback={<FilteredEmpty />}>
                      <SecRow label={t("alpha.ext.allBundles")} count={byTypeF("bundle").length} />
                      <Grid items={byTypeF("bundle")} />
                    </Show>
                  </Show>

                  {/* ░░ INSTALLED (manage;顶部 = 有更新分组,T5 接动作) ░░ */}
                  <Show when={section() === "installed"}>
                    <Hero title={t("alpha.ext.tabInstalled")} sub={t("alpha.ext.installedSub")} />
                    {/* REQ-037:内置(上游)治理分组 —— REQ-019 递延的 V2 内置管理位落点 */}
                    <SecRow label={t("alpha.gov.builtinSection")} />
                    <GovernancePanel
                      agents={ext.store.agents}
                      refreshEngine={ext.refreshEngine}
                      reloadAgents={ext.reloadAgents}
                      flash={flash}
                    />
                    <Show when={updatable().length > 0}>
                      <SecRow
                        label={t("alpha.ext.tabUpdates")}
                        count={updatable().length}
                        warn
                        actionLabel={t("alpha.ext.updateAll")}
                        onAction={() => void runUpdateAll()}
                      />
                      <div class="alpha-ext-manage">
                        <For each={updatable()}>
                          {(r) => {
                            const target = byId(r.id)
                            const ic = iconForRow(target, r.type, r.name)
                            return (
                              <div
                                class="alpha-ext-man"
                                data-clickable={target ? "" : undefined}
                                onClick={() => target && openEntryDetail(target)}
                              >
                                <span class="alpha-ext-man-ic" style={{ background: ic.color }}>
                                  {ic.glyph}
                                </span>
                                <div class="alpha-ext-man-body">
                                  <div class="alpha-ext-man-nm">
                                    <b title={r.name}>{target?.displayName ?? r.name}</b>
                                    <span class="alpha-ext-type-pill">{typeLabel(r.type)}</span>
                                  </div>
                                  <div class="alpha-ext-man-st">
                                    {t("alpha.ext.updateAvailable", { from: r.version ?? "?", to: entryVersion(byId(r.id)) })}
                                  </div>
                                  <Show when={updErr()[r.id]}>
                                    <div class="alpha-ext-man-st" data-err="">
                                      {updErr()[r.id]}
                                    </div>
                                  </Show>
                                </div>
                                <button
                                  class="alpha-ext-updbtn"
                                  disabled={updBusy() === r.id}
                                  onClick={(ev) => {
                                    ev.stopPropagation()
                                    void runUpdate(r)
                                  }}
                                >
                                  {updBusy() === r.id ? t("alpha.ext.adding") : t("alpha.ext.update")}
                                </button>
                              </div>
                            )
                          }}
                        </For>
                      </div>
                    </Show>
                    <Show when={!ext.store.ready && installedAll().length === 0}>
                      <div class="alpha-ext-manage" aria-hidden="true">
                        <div class="alpha-ext-skel-row" />
                        <div class="alpha-ext-skel-row" />
                        <div class="alpha-ext-skel-row" />
                      </div>
                    </Show>
                    <Show
                      when={installedAll().length > 0}
                      fallback={
                        <Show when={ext.store.ready}>
                        <EmptyState
                          title={t("alpha.ext.empty")}
                          sub={t("alpha.ext.emptySub")}
                          action={
                            <button class="alpha-ext-add" data-variant="primary" onClick={() => gotoSection("featured")}>
                              {t("alpha.ext.browseRecommended")}
                            </button>
                          }
                        />
                        </Show>
                      }
                    >
                      <SecRow label={t("alpha.ext.installedSection")} count={installedAll().length} />
                      <div class="alpha-ext-manage">
                        <For each={installedAll()}>
                          {(row) => {
                            const ic = iconForRow(row.entry, row.type, row.name)
                            // Row click opens the detail page when we can resolve a target
                            // (catalog entry, or an engine agent by name).
                            const openRow = () => {
                              if (row.entry) return openEntryDetail(row.entry)
                              if (row.type === "agent") {
                                const a = ext.store.agents.find((x) => x.name === row.name)
                                if (a) return openAgentDetail(a)
                              }
                            }
                            const clickable = () => !!row.entry || (row.type === "agent" && ext.store.agents.some((x) => x.name === row.name))
                            return (
                              <div
                                class="alpha-ext-man"
                                data-clickable={clickable() ? "" : undefined}
                                onClick={() => clickable() && openRow()}
                              >
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
                                    onClick={(ev) => {
                                      ev.stopPropagation()
                                      void ext.setMcpConnected(row.name, !row.mcp?.connected)
                                    }}
                                  />
                                </Show>
                                <button
                                  class="alpha-ext-iconbtn"
                                  title={t("alpha.ext.remove")}
                                  aria-label={t("alpha.ext.remove")}
                                  onClick={(ev) => {
                                    ev.stopPropagation()
                                    void onUninstall(row.receipt)
                                  }}
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

                  {/* ░░ IMPORT(REQ-036:创建表单已移除 —— 创建走技能;本 tab 语义收敛为导入,
                      并给「对话式创建」指引卡。X8 挂点:REQ-033 的任意 MCP 添加/agent 导入落这里) ░░ */}
                  <Show when={section() === "create"}>
                    <Hero title={t("alpha.ext.tabCreate")} sub={t("alpha.ext.createSub")} />
                    <div class="alpha-ext-form">
                      {/* 对话式创建指引(skill-creator / agent-creator 出厂即有;C28:文案与出厂
                          注入状态一致 —— 逃生开关关闭时如实降级为「安装 skill-creator 后可用」) */}
                      <div class="alpha-ext-callout">
                        <b>{t("alpha.ext.createViaChatTitle")}</b>
                        <p class="alpha-ext-dnote" style={{ margin: "6px 0 0" }}>
                          {ext.factorySkills().length > 0
                            ? t("alpha.ext.createViaChatBody")
                            : t("alpha.ext.createViaChatBodyDisabled")}
                        </p>
                      </div>

                      <div class="alpha-ext-import">
                        <SecRow label={t("alpha.ext.importFrom")} />
                        <div class="alpha-ext-import-row">
                          <button class="alpha-ext-import-card" disabled={importBusy()} onClick={() => void runImportFolder()}>
                            <Svg d="M3 7h6l2 2h10v9a2 2 0 0 1-2 2H3z" />
                            <span>
                              <b>{t("alpha.ext.importFolder")}</b>
                              <small>{t("alpha.ext.importFolderSub")}</small>
                            </span>
                          </button>
                          <button
                            class="alpha-ext-import-card"
                            disabled={importBusy()}
                            onClick={() => {
                              setImportErr("")
                              setImportInput("")
                              setImportDialog("git")
                            }}
                          >
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
                          <button
                            class="alpha-ext-import-card"
                            disabled={importBusy()}
                            onClick={() => {
                              setImportErr("")
                              setImportInput("")
                              setImportDialog("npm")
                            }}
                          >
                            <Svg d="M3 9l9-5 9 5-9 5zM3 9v6l9 5 9-5V9" />
                            <span>
                              <b>{t("alpha.ext.importNpm")}</b>
                              <small>{t("alpha.ext.importNpmSub")}</small>
                            </span>
                          </button>
                          <button class="alpha-ext-import-card" disabled={cmBusy()} onClick={() => { setCmErr(""); setCustomMcpOpen(true) }}>
                            <Svg d="M8 12h8M12 8v8M4 12a8 8 0 1 0 16 0a8 8 0 1 0-16 0" />
                            <span>
                              <b>{t("alpha.ext.customMcp")}</b>
                              <small>{t("alpha.ext.customMcpSub")}</small>
                            </span>
                          </button>
                          <button class="alpha-ext-import-card" disabled={agentBusy()} onClick={() => void runPickAgentFile()}>
                            <Svg d="M12 3l8 4.5v9L12 21l-8-4.5v-9z" />
                            <span>
                              <b>{t("alpha.ext.importAgent")}</b>
                              <small>{t("alpha.ext.importAgentSub")}</small>
                            </span>
                          </button>
                        </div>
                        <Show when={agentErr()}>
                          <p class="alpha-ext-import-err">{agentErr()}</p>
                        </Show>
                        <p class="alpha-ext-dnote" style={{ margin: "10px 2px 0" }}>{t("alpha.ext.compatNote")}</p>
                        {/* B11:导入失败行内呈现(folder 路径失败落这里;git/npm 失败落弹窗内) */}
                        <Show when={importErr() && !importDialog()}>
                          <p class="alpha-ext-import-err">{importErr()}</p>
                        </Show>
                        <Show when={importBusy() && !importDialog()}>
                          <p class="alpha-ext-dnote">{t("alpha.ext.importing")}</p>
                        </Show>
                      </div>
                    </div>
                  </Show>

                  {/* ░░ CLOUD (REQ-020 T2/T4:登录门控 + 连接器卡 + pipeline 条目) ░░ */}
                  <Show when={section() === "cloud"}>
                    <Hero title={t("alpha.ext.tabCloud")} sub={t("alpha.ext.cloudSub")} />
                    {/* 门控条:未登录 → 登录 CTA;BYOK → 切平台模式说明(诚实:切换/登录后由
                        sidecar 注入 mcp.cloud,注入发生在启动装配,未点亮时重启完成注入)。 */}
                    <Show when={!cloudReady()}>
                      <div class="alpha-ext-cloudgate">
                        <div class="alpha-ext-cloudgate-t">
                          {authState().status !== "logged-in"
                            ? t("alpha.ext.cloudGateTitleLogin")
                            : t("alpha.ext.cloudGateTitleMode")}
                        </div>
                        <div class="alpha-ext-cloudgate-sub">{t("alpha.ext.cloudGateSub")}</div>
                        <Show
                          when={authState().status !== "logged-in"}
                          fallback={
                            <button
                              class="alpha-ext-add"
                              data-variant="primary"
                              onClick={() => void window.api.auth.setMode("platform")}
                            >
                              {t("alpha.ext.cloudSwitchMode")}
                            </button>
                          }
                        >
                          <button class="alpha-ext-add" data-variant="primary" onClick={() => void window.api.auth.start()}>
                            {t("alpha.ext.cloudLoginCta")}
                          </button>
                        </Show>
                      </div>
                    </Show>

                    {/* 平台连接器卡(固定展示;非 catalog 条目,点开专属详情) */}
                    <SecRow label={t("alpha.ext.cloudConnectorSection")} />
                    <div
                      class="alpha-ext-kit"
                      data-clickable=""
                      data-dim={cloudReady() ? undefined : ""}
                      onClick={() => setDetail({ kind: "cloud-connector" })}
                    >
                      <span class="alpha-ext-kit-ic" style={{ background: "#5c7cbf" }}>
                        云
                      </span>
                      <div class="alpha-ext-kit-body">
                        <div class="alpha-ext-kit-ttl">
                          <b>{t("alpha.ext.cloudConnectorTitle")}</b>
                          <span class="alpha-ext-chip" data-source="alpha">
                            {sourceLabel("alpha")}
                          </span>
                        </div>
                        <div class="alpha-ext-kit-desc">
                          <span class="alpha-ext-cloudst" data-st={cloudReady() ? (cloudLive()?.connected ? "on" : "idle") : "off"}>
                            {cloudReady()
                              ? cloudLive()?.connected
                                ? t("alpha.ext.cloudConnConnected")
                                : t("alpha.ext.cloudConnDisconnected")
                              : t("alpha.ext.cloudConnNeedLogin")}
                          </span>
                          {" · "}
                          {t("alpha.ext.cloudConnectorDesc")}
                        </div>
                      </div>
                      <button
                        class="alpha-ext-add"
                        onClick={(ev) => {
                          ev.stopPropagation()
                          setDetail({ kind: "cloud-connector" })
                        }}
                      >
                        {t("alpha.ext.openDetail")}
                      </button>
                    </div>

                    {/* 云 pipeline 条目(灰显 ≠ 隐藏:BYOK/未登录可浏览,启用/派发被门控) */}
                    <SecRow label={t("alpha.ext.cloudPipelines")} count={byType("cloud").length} />
                    <div data-dim={cloudReady() ? undefined : ""}>
                      <Grid items={byType("cloud")} />
                    </div>
                  </Show>
                </Show>
              </Show>
            </div>
          </div>
        </div>

        {/* Install confirmation — staged by MCP/bundle 添加 or the plugin detail page. Backdrop/
            Escape cancel (alpha Dialog). Plugin confirms carry an explicit risk line (Q2). */}
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
                <Show when={entry().type === "plugin"}>
                  <p class="alpha-ext-confirm-risk">⚠ {t("alpha.ext.pluginRisk")}</p>
                </Show>
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

        {/* T6:导入输入弹窗(Git URL / npm 包名)。失败行内呈现于弹窗内(B11),成功 toast。 */}
        <Dialog
          open={!!importDialog()}
          onClose={() => {
            setImportDialog(null)
            setImportErr("")
          }}
          besideSidebar
          size="sm"
          title={importDialog() === "git" ? t("alpha.ext.importGitTitle") : t("alpha.ext.importNpmTitle")}
          footer={
            <>
              <Button variant="ghost" onClick={() => setImportDialog(null)}>
                {t("alpha.ext.cancel")}
              </Button>
              <Button variant="primary" disabled={importBusy() || !importInput().trim()} onClick={() => void runImportDialog()}>
                {importBusy() ? t("alpha.ext.importing") : t("alpha.ext.importGo")}
              </Button>
            </>
          }
        >
          <div class="alpha-ext-confirm">
            <p class="alpha-ext-confirm-desc">
              {importDialog() === "git" ? t("alpha.ext.importGitHint") : t("alpha.ext.importNpmHint")}
            </p>
            <input
              class="alpha-ext-input alpha-mono"
              placeholder={importDialog() === "git" ? "https://github.com/user/skill-repo" : "opencode-notify@0.3.1"}
              value={importInput()}
              onInput={(ev) => setImportInput(ev.currentTarget.value)}
              onKeyDown={(ev) => {
                if (ev.key === "Enter" && importInput().trim() && !importBusy()) void runImportDialog()
              }}
            />
            <Show when={importDialog() === "npm"}>
              <p class="alpha-ext-confirm-risk">⚠ {t("alpha.ext.pluginRisk")}</p>
            </Show>
            <Show when={importErr()}>
              <p class="alpha-ext-import-err">{importErr()}</p>
            </Show>
          </div>
        </Dialog>

        {/* REQ-033:自定义连接器表单(校验主体在 main:命令/URL 白名单、env 值校验、密钥 file 化) */}
        <Dialog
          open={customMcpOpen()}
          onClose={() => setCustomMcpOpen(false)}
          besideSidebar
          size="sm"
          title={t("alpha.ext.customMcpTitle")}
          footer={
            <>
              <Button variant="ghost" onClick={() => setCustomMcpOpen(false)}>
                {t("alpha.ext.cancel")}
              </Button>
              <Button variant="primary" disabled={cmBusy() || !cmName().trim()} onClick={() => void runAddCustomMcp()}>
                {cmBusy() ? t("alpha.ext.importing") : t("alpha.ext.customMcpAdd")}
              </Button>
            </>
          }
        >
          <div class="alpha-ext-confirm">
            <p class="alpha-ext-confirm-desc">{t("alpha.ext.customMcpHint")}</p>
            <label class="alpha-ext-flabel">{t("alpha.ext.customMcpName")}
              <input class="alpha-ext-input alpha-mono" value={cmName()} onInput={(e) => setCmName(e.currentTarget.value)} placeholder="my-connector" />
            </label>
            <div class="alpha-gov-mode" style={{ margin: "8px 0" }}>
              <button data-on={cmType() === "local" ? "" : undefined} onClick={() => setCmType("local")}>{t("alpha.ext.customMcpTypeLocal")}</button>
              <button data-on={cmType() === "remote" ? "" : undefined} onClick={() => setCmType("remote")}>{t("alpha.ext.customMcpTypeRemote")}</button>
            </div>
            <Show when={cmType() === "local"} fallback={
              <label class="alpha-ext-flabel">{t("alpha.ext.customMcpUrl")}
                <input class="alpha-ext-input alpha-mono" value={cmUrl()} onInput={(e) => setCmUrl(e.currentTarget.value)} placeholder="https://mcp.example.com/sse" />
              </label>
            }>
              <label class="alpha-ext-flabel">{t("alpha.ext.customMcpCommand")}
                <input class="alpha-ext-input alpha-mono" value={cmCommand()} onInput={(e) => setCmCommand(e.currentTarget.value)} placeholder="npx -y @some/mcp-server@1.0.0" />
              </label>
            </Show>
            <label class="alpha-ext-flabel">{t("alpha.ext.customMcpEnv")}
              <textarea class="alpha-ext-input alpha-ext-textarea alpha-mono" rows="2" value={cmEnv()} onInput={(e) => setCmEnv(e.currentTarget.value)} />
            </label>
            <label class="alpha-ext-flabel">{t("alpha.ext.customMcpSecrets")}
              <textarea class="alpha-ext-input alpha-ext-textarea alpha-mono" rows="2" value={cmSecrets()} onInput={(e) => setCmSecrets(e.currentTarget.value)} />
            </label>
            <Show when={cmErr()}>
              <p class="alpha-ext-import-err">{cmErr()}</p>
            </Show>
          </div>
        </Dialog>

        {/* REQ-033:agent 导入映射预览(显式逐字段;不支持项 loud,确认才写入) */}
        <Dialog
          open={!!agentPreview()}
          onClose={() => setAgentPreview(null)}
          besideSidebar
          size="md"
          title={t("alpha.ext.importAgentTitle")}
          footer={
            <>
              <Button variant="ghost" onClick={() => setAgentPreview(null)}>
                {t("alpha.ext.cancel")}
              </Button>
              <Button variant="primary" disabled={agentBusy()} onClick={() => void runConfirmAgentImport()}>
                {agentBusy() ? t("alpha.ext.importing") : t("alpha.ext.importAgentConfirm")}
              </Button>
            </>
          }
        >
          <Show when={agentPreview()}>
            {(pv) => (
              <div class="alpha-ext-confirm">
                <p class="alpha-ext-confirm-desc">
                  <b>{pv().name}</b> · {t("alpha.ext.importAgentFormat")}:{pv().format}
                </p>
                <div class="alpha-ext-manage">
                  <For each={pv().mapping}>
                    {(m) => (
                      <div class="alpha-ext-man">
                        <span class="alpha-ext-man-name">
                          {m.source}
                          <span class="alpha-ext-chip">{m.target ?? "不映射"}</span>
                        </span>
                        <small style={{ "margin-left": "auto", opacity: 0.7, "max-width": "60%" }}>{m.note}</small>
                      </div>
                    )}
                  </For>
                </div>
                <p class="alpha-ext-key-hint">{t("alpha.ext.importAgentMapNote")}</p>
                <Show when={agentErr()}>
                  <p class="alpha-ext-import-err">{agentErr()}</p>
                </Show>
              </div>
            )}
          </Show>
        </Dialog>
      </Portal>
    </Show>
  )
}
