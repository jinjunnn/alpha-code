// REQ-135:derive the Hub's installable entry surface without mutating or rewriting signed catalog
// bytes. The full catalog remains authoritative for installed-item identity and retirement copy.

import {
  RETIRED_COMMUNITY_OFFICE_CONNECTORS,
  isRetiredOfficeMcp,
  retiredCommunityOfficeFor,
} from "../../shared/office-advisories"
import type { CatalogPackageViewV1 } from "../../shared/catalog-package-view"
import type { CatalogEntry } from "./catalog-types"

/** Exclude retired entries and any bundle that still references one of their catalog ids. */
export function installableCatalogEntries(entries: readonly CatalogEntry[]): CatalogEntry[] {
  const retiredIds = retiredCatalogIds(entries)

  return entries.filter(
    (entry) =>
      !isRetiredCatalogEntry(entry) &&
      !(entry.type === "bundle" && (entry.bundleItems ?? []).some((item) => retiredIds.has(item.catalogEntryId))),
  )
}

/** Exclude package cards whose signed component graph references a retired connector. */
export function installableCatalogPackages(
  packages: readonly CatalogPackageViewV1[],
  entries: readonly CatalogEntry[],
): CatalogPackageViewV1[] {
  const retiredIds = retiredCatalogIds(entries)
  return packages.filter(
    (view) =>
      !isRetiredComponentId(view.catalogId, retiredIds) &&
      view.components.every((component) => !isRetiredComponentId(component.componentId, retiredIds)),
  )
}

function isRetiredComponentId(componentId: string, retiredIds: ReadonlySet<string>): boolean {
  if (retiredIds.has(componentId)) return true
  return retiredCommunityOfficeFor({
    id: componentId,
    name: componentId.startsWith("mcp:") ? componentId.slice("mcp:".length) : componentId,
  }) !== undefined
}

function retiredCatalogIds(entries: readonly CatalogEntry[]): Set<string> {
  const retiredIds = new Set(RETIRED_COMMUNITY_OFFICE_CONNECTORS.map((connector) => connector.catalogId))
  for (const entry of entries)
    if (isRetiredCatalogEntry(entry)) retiredIds.add(entry.id)
  return retiredIds
}

function isRetiredCatalogEntry(entry: CatalogEntry): boolean {
  if (retiredCommunityOfficeFor({ id: entry.id, name: entry.name })) return true
  if (entry.type !== "mcp" || entry.installSpec?.kind !== "mcp") return false
  return isRetiredOfficeMcp(entry.name, {
    type: entry.installSpec.mcpType,
    command: [...(entry.installSpec.command ?? []), ...(entry.installSpec.mirrorCommand ?? [])],
    ...(entry.installSpec.url ? { url: entry.installSpec.url } : {}),
  })
}
