// REQ-125 C4 — right-rail width memory (approved contract: 320–560px, remembered per panel).
// Mirrors workbench-state.ts storage discipline: localStorage is a convenience cache, every
// read is re-validated and clamped, and storage failures can never throw into the UI.

export const RAIL_MIN_WIDTH = 320
export const RAIL_MAX_WIDTH = 560
export const RAIL_DEFAULT_WIDTH = 400

const WIDTHS_KEY = "alpha-session-rail-widths-v1"

type StorageLike = Pick<Storage, "getItem" | "setItem">

function defaultStorage(): StorageLike | null {
  try {
    return typeof localStorage === "undefined" ? null : localStorage
  } catch {
    return null
  }
}

export function clampRailWidth(value: number | undefined): number {
  if (typeof value !== "number" || !Number.isFinite(value)) return RAIL_DEFAULT_WIDTH
  return Math.min(RAIL_MAX_WIDTH, Math.max(RAIL_MIN_WIDTH, Math.round(value)))
}

export function readRailWidths(storage: StorageLike | null = defaultStorage()): Record<string, number> {
  if (!storage) return {}
  try {
    const raw = storage.getItem(WIDTHS_KEY)
    if (!raw) return {}
    const parsed = JSON.parse(raw) as unknown
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {}
    const out: Record<string, number> = {}
    for (const [panel, width] of Object.entries(parsed as Record<string, unknown>)) {
      if (typeof width === "number" && Number.isFinite(width)) out[panel] = clampRailWidth(width)
    }
    return out
  } catch {
    return {}
  }
}

export function rememberRailWidth(
  panel: string,
  width: number,
  storage: StorageLike | null = defaultStorage(),
): void {
  if (!storage || !panel) return
  try {
    const map = readRailWidths(storage)
    map[panel] = clampRailWidth(width)
    storage.setItem(WIDTHS_KEY, JSON.stringify(map))
  } catch {
    /* quota/serialization — width memory is a convenience, never a failure source */
  }
}
