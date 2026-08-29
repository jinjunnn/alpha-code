// REQ-140 — right-rail width memory. Approved contract (docs/design/2026-08-28-req140-rail-width):
// floor 320px, default 400px, and NO fixed ceiling — the effective ceiling is
// `workspace width − 480px`, where 480px is the session column's minimum usable width and the
// workspace is `.a-swk-root`'s measured width (window minus the project sidebar).
// Mirrors workbench-state.ts storage discipline: localStorage is a convenience cache, every
// read is re-validated and clamped, and storage failures can never throw into the UI.
//
// Two clamps, deliberately different (design §3 「窗口变化」):
//   - storage (readRailWidths / rememberRailWidth) clamps the floor only, so a narrow window
//     never rewrites what the user chose; widening the window restores it;
//   - display (the shell) passes the measured workspace width, so the visible rail converges
//     onto the current ceiling in real time.

export const RAIL_MIN_WIDTH = 320
export const RAIL_DEFAULT_WIDTH = 400
/** Session column's minimum usable width — owner decision 2026-08-28. */
export const SESSION_MIN_WIDTH = 480

const WIDTHS_KEY = "alpha-session-rail-widths-v1"

type StorageLike = Pick<Storage, "getItem" | "setItem">

function defaultStorage(): StorageLike | null {
  try {
    return typeof localStorage === "undefined" ? null : localStorage
  } catch {
    return null
  }
}

/**
 * Effective rail ceiling for a measured workspace width, or `undefined` while the workspace is
 * unmeasured (no JS ceiling; the CSS twin `max-width: calc(100% - 480px)` still caps the paint).
 * Below a 800px workspace the floor wins, so this never reports less than RAIL_MIN_WIDTH —
 * that is the approved conflict rule, and it is also what `aria-valuemax` must announce.
 */
export function railMaxWidth(workspaceWidth: number | undefined): number | undefined {
  if (typeof workspaceWidth !== "number" || !Number.isFinite(workspaceWidth) || workspaceWidth <= 0) return undefined
  return Math.max(RAIL_MIN_WIDTH, Math.round(workspaceWidth) - SESSION_MIN_WIDTH)
}

export function clampRailWidth(value: number | undefined, workspaceWidth?: number): number {
  const width = typeof value !== "number" || !Number.isFinite(value) ? RAIL_DEFAULT_WIDTH : Math.round(value)
  const max = railMaxWidth(workspaceWidth)
  // Floor last, mirroring CSS (min-width beats max-width): a workspace narrower than 320+480
  // pins the rail at 320 and the session column takes whatever is left.
  return Math.max(RAIL_MIN_WIDTH, max === undefined ? width : Math.min(max, width))
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
