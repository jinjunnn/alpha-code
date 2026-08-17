// Shared presentational helpers for the Extension Hub (定制中心) — icon/glyph resolution, source/
// type labels, and tiny inline SVG icons. Extracted from extension-hub.tsx (REQ-019 T2) so the
// detail page (extension-detail.tsx) can reuse them without a hub ↔ detail import cycle.
// Pure presentation: no store access, no IPC.

import type { CatalogEntry, CatalogSource } from "./catalog-types"
import type { InstallReceiptType } from "../../preload/types"
import { t } from "../i18n"

// Presentational only — the catalog carries no icon glyph/color. Keyed by id, falling back to the
// category tint + the displayName initial. (Kept here, not in the catalog, so the data file stays
// pure metadata.)
export const CAT_COLOR: Record<string, string> = {
  dev: "#4f46e5",
  office: "#16a34a",
  research: "#2563eb",
  "china-office": "#00b4d8",
  design: "#7c3aed",
  cloud: "#5c7cbf",
}
const ICON_COLOR: Record<string, string> = {
  "mcp:playwright": "#7c3aed",
  "mcp:github": "#24292f",
  "mcp:yuque": "#1f7a4d",
}
const ICON_GLYPH: Record<string, string> = {
  "mcp:markitdown": "文",
  "mcp:filesystem": "FS",
  "mcp:fetch": "网",
  "mcp:playwright": "▶",
  "mcp:git": "Git",
  "mcp:github": "GH",
  "mcp:alpha-word": "W",
  "mcp:alpha-excel": "X",
  "mcp:alpha-powerpoint": "P",
  "mcp:alpha-pdf": "PDF",
  "mcp:feishu": "飞",
  "mcp:yuque": "语",
  "skill:skill-creator": "技",
  "skill:alpha-upstream-sync": "同",
  "skill:safe-refactor": "重",
  "bundle:office": "办",
  "bundle:research": "研",
  "bundle:dev": "开",
  "bundle:china-office": "中",
  "cloud:code-review": "审",
  "cloud:research": "研",
  "cloud:docs": "档",
}
export function iconFor(e: CatalogEntry): { color: string; glyph: string } {
  return {
    color: ICON_COLOR[e.id] ?? CAT_COLOR[e.category] ?? "var(--a-accent-solid)",
    glyph: ICON_GLYPH[e.id] ?? e.displayName.slice(0, 1),
  }
}

// Icon for a non-catalog row (agents, receipt-only installs): type-tinted glyph from the name.
export const TYPE_TINT: Record<string, string> = {
  mcp: "var(--a-accent)",
  skill: "#7c9c5a",
  agent: "#c08457",
  plugin: "#8a6ec0",
  bundle: "#5a8a9c",
  cloud: "#5c7cbf",
}
export function iconForRow(entry: CatalogEntry | undefined, type: string, name: string): { color: string; glyph: string } {
  if (entry) return iconFor(entry)
  return { color: TYPE_TINT[type] ?? "var(--a-bg-inset)", glyph: (name[0] ?? "?").toUpperCase() }
}

export function sourceLabel(source: CatalogSource): string {
  if (source === "official") return t("alpha.ext.sourceOfficial")
  if (source === "community") return t("alpha.ext.sourceCommunity")
  return t("alpha.ext.sourceAlpha")
}

export function catalogDescription(entry: CatalogEntry): string {
  if (entry.id === "skill:alpha-upstream-sync") return t("alpha.ext.upstreamSyncDescription")
  return entry.description
}

// Human label for an item's type, reusing the section labels (连接器/技能/Agent/插件/套件/云).
export function typeLabel(type: InstallReceiptType | CatalogEntry["type"]): string {
  if (type === "mcp") return t("alpha.ext.tabConnectors")
  if (type === "skill") return t("alpha.ext.tabSkills")
  if (type === "agent") return t("alpha.ext.typeAgent")
  if (type === "command") return t("alpha.ext.typeCommand")
  if (type === "plugin") return t("alpha.ext.tabPlugins")
  if (type === "cloud") return t("alpha.ext.typeCloud")
  return t("alpha.ext.tabBundles")
}

// ── tiny inline icons (1.6 stroke, currentColor) ──────────────────────────────────────────────
export const Svg = (p: { d: string; box?: string; class?: string }) => (
  <svg class={p.class ?? "alpha-ic"} viewBox={p.box ?? "0 0 24 24"} fill="none" aria-hidden="true">
    <path d={p.d} stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" />
  </svg>
)
export const SearchIc = () => (
  <svg class="alpha-ic" viewBox="0 0 24 24" fill="none" aria-hidden="true">
    <circle cx="11" cy="11" r="7" stroke="currentColor" stroke-width="1.6" />
    <path d="M21 21l-4-4" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" />
  </svg>
)
export const LockIc = () => (
  <svg class="alpha-ic alpha-ic-xs" viewBox="0 0 24 24" fill="none" aria-hidden="true">
    <rect x="5" y="11" width="14" height="9" rx="2" stroke="currentColor" stroke-width="1.7" />
    <path d="M8 11V7a4 4 0 0 1 8 0v4" stroke="currentColor" stroke-width="1.7" />
  </svg>
)
