// REQ-135:derive the Hub's installable entry surface without mutating or rewriting signed catalog
// bytes. The full catalog remains authoritative for installed-item identity and retirement copy.

import {
  RETIRED_COMMUNITY_OFFICE_CONNECTORS,
  isRetiredOfficeMcp,
  retiredCommunityOfficeFor,
} from "../../shared/office-advisories"
import type { CatalogPackageViewV1 } from "../../shared/catalog-package-view"
import { decodeEntryCuration } from "../../shared/catalog-curation"
import type { CatalogEntry } from "./catalog-types"

/** New-content surfaces share this view; installed-item identity keeps the full catalog. */
export function installableCatalogEntries(
  entries: readonly CatalogEntry[],
  advisoryBlocked: ReadonlySet<string> = new Set(),
): CatalogEntry[] {
  const unavailableIds = unavailableCatalogIds(entries, advisoryBlocked)
  return entries.filter((entry) => !unavailableIds.has(entry.id))
}

/** Keep actionable compatible packages whose graph contains no unavailable catalog identities. */
export function installableCatalogPackages(
  packages: readonly CatalogPackageViewV1[],
  entries: readonly CatalogEntry[],
  advisoryBlocked: ReadonlySet<string> = new Set(),
): CatalogPackageViewV1[] {
  const unavailableIds = unavailableCatalogIds(entries, advisoryBlocked)
  return packages.filter(
    (view) =>
      view.verdict === "compatible" &&
      view.action.enabled &&
      !isUnavailableComponentId(view.catalogId, unavailableIds) &&
      view.components.every((component) => !isUnavailableComponentId(component.componentId, unavailableIds)),
  )
}

function isUnavailableComponentId(componentId: string, unavailableIds: ReadonlySet<string>): boolean {
  if (unavailableIds.has(componentId)) return true
  return (
    retiredCommunityOfficeFor({
      id: componentId,
      name: componentId.startsWith("mcp:") ? componentId.slice("mcp:".length) : componentId,
    }) !== undefined
  )
}

function unavailableCatalogIds(entries: readonly CatalogEntry[], advisoryBlocked: ReadonlySet<string>): Set<string> {
  const unavailableIds = new Set([
    ...RETIRED_COMMUNITY_OFFICE_CONNECTORS.map((connector) => connector.catalogId),
    ...advisoryBlocked,
  ])
  for (const entry of entries) if (isUnavailableCatalogEntry(entry)) unavailableIds.add(entry.id)
  const byId = new Map(entries.map((entry) => [entry.id, entry]))
  for (const entry of entries.filter((entry) => entry.type === "bundle"))
    if (
      !entry.bundleItems?.length ||
      entry.bundleItems.some(
        (item) =>
          unavailableIds.has(item.catalogEntryId) ||
          !byId.has(item.catalogEntryId) ||
          byId.get(item.catalogEntryId)?.type === "bundle",
      )
    )
      unavailableIds.add(entry.id)
  return unavailableIds
}

function isUnavailableCatalogEntry(entry: CatalogEntry): boolean {
  if (entry._verify?.trim() || entry.installSpec?._verify?.trim()) return true
  const status = decodeEntryCuration(entry)
  if (status.kind === "invalid") return true
  if (status.kind === "curated" && status.curation.review.upstreamStatus !== "active") return true
  if (retiredCommunityOfficeFor({ id: entry.id, name: entry.name })) return true
  if (entry.type !== "mcp" || entry.installSpec?.kind !== "mcp") return false
  return isRetiredOfficeMcp(entry.name, {
    type: entry.installSpec.mcpType,
    command: [...(entry.installSpec.command ?? []), ...(entry.installSpec.mirrorCommand ?? [])],
    ...(entry.installSpec.url ? { url: entry.installSpec.url } : {}),
  })
}
