// Persisted UI state for the alpha sidebar: whether the whole sidebar is shown, and which
// projects are expanded to reveal their conversations. Stored in localStorage (synchronous,
// available before first paint) under the `alpha.sidebar.*` namespace. These are plain Solid
// atoms — there is a single sidebar, so module-level singletons are the simplest correct model.

import { createSignal } from "solid-js"

const COLLAPSED_KEY = "alpha.sidebar.collapsed"
const EXPANDED_KEY = "alpha.sidebar.expanded"
const HIDDEN_KEY = "alpha.sidebar.hidden"
const VIEWED_KEY = "alpha.sidebar.viewed"

function readBool(key: string, fallback: boolean): boolean {
  try {
    const raw = localStorage.getItem(key)
    if (raw === null) return fallback
    return raw === "1" || raw === "true"
  } catch {
    return fallback
  }
}

function readSet(key: string): Set<string> {
  try {
    const raw = localStorage.getItem(key)
    if (!raw) return new Set()
    const parsed = JSON.parse(raw)
    return Array.isArray(parsed) ? new Set(parsed.filter((x): x is string => typeof x === "string")) : new Set()
  } catch {
    return new Set()
  }
}

function readMap(key: string): Record<string, number> {
  try {
    const raw = localStorage.getItem(key)
    if (!raw) return {}
    const parsed = JSON.parse(raw)
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? (parsed as Record<string, number>) : {}
  } catch {
    return {}
  }
}

function write(key: string, value: string) {
  try {
    localStorage.setItem(key, value)
  } catch {}
}

// Sidebar visibility has two independent inputs:
//  - `userCollapsed` (persisted): the manual preference set by the toggle button.
//  - `autoCollapsed` (transient, NEVER persisted): a width-driven override from the responsive
//    auto-collapse. It must reverse when the window widens again — otherwise a narrow→wide resize
//    would strand the sidebar hidden (and with it ALPHA CODE + the project list). Keeping it out of
//    localStorage also means a relaunch always restores the user's real preference.
// Default: sidebar shown (the whole point of the redesign is a fixed left sidebar).
const [userCollapsed, setUserCollapsedSignal] = createSignal(readBool(COLLAPSED_KEY, false))
const [autoCollapsed, setAutoCollapsedSignal] = createSignal(false)
const [expanded, setExpandedSignal] = createSignal(readSet(EXPANDED_KEY))
// Projects the user has archived/removed from the sidebar. opencode has no server-side concept
// of deleting a project (only project.update for name/icon; a project row persists forever once
// its first session exists), so "归档/移除" is necessarily a sidebar-local hide: a persisted set
// of worktrees we filter out of the rendered list. Both menu actions land here.
const [hidden, setHiddenSignal] = createSignal(readSet(HIDDEN_KEY))
// Per-session "last viewed" watermark: the session's `updated` timestamp the last time the user had
// it open. A session shows an unread dot when its `updated` has advanced past this — i.e. an agent
// produced new activity while the user was looking elsewhere. Persisted so it survives relaunch.
const [viewed, setViewedSignal] = createSignal<Record<string, number>>(readMap(VIEWED_KEY))

// Effective visibility: hidden if the user collapsed it OR the responsive override is active.
export function sidebarCollapsed() {
  return userCollapsed() || autoCollapsed()
}

// Manual collapse/expand (persisted). Clears the transient override so a deliberate choice wins.
export function setSidebarCollapsed(value: boolean) {
  setAutoCollapsedSignal(false)
  setUserCollapsedSignal(value)
  write(COLLAPSED_KEY, value ? "1" : "0")
}

export function toggleSidebar() {
  setSidebarCollapsed(!sidebarCollapsed())
}

// Width-driven override (transient, never persisted): set true to fold on a narrow window, false to
// restore when it widens. The user's persisted preference underneath is left untouched, so manual
// collapse stays collapsed and manual-open returns when the override clears.
export function setSidebarAutoCollapsed(value: boolean) {
  setAutoCollapsedSignal(value)
}

export function isProjectExpanded(worktree: string) {
  return expanded().has(worktree)
}

export function toggleProjectExpanded(worktree: string) {
  setExpandedSignal((prev) => {
    const next = new Set(prev)
    if (next.has(worktree)) next.delete(worktree)
    else next.add(worktree)
    write(EXPANDED_KEY, JSON.stringify([...next]))
    return next
  })
}

export function setProjectExpanded(worktree: string, value: boolean) {
  setExpandedSignal((prev) => {
    if (prev.has(worktree) === value) return prev
    const next = new Set(prev)
    if (value) next.add(worktree)
    else next.delete(worktree)
    write(EXPANDED_KEY, JSON.stringify([...next]))
    return next
  })
}

export function isProjectHidden(worktree: string) {
  return hidden().has(worktree)
}

/** Reactive accessor for the set of hidden worktrees (so the UI can offer a way to restore them). */
export function hiddenProjects() {
  return hidden()
}

/** Restore every archived/removed project (un-hide all). Archiving must be reversible. */
export function clearHiddenProjects() {
  setHiddenSignal((prev) => {
    if (prev.size === 0) return prev
    write(HIDDEN_KEY, JSON.stringify([]))
    return new Set<string>()
  })
}

// A session is unread when its activity advanced past the last view. Only sessions seen at least
// once can be unread — otherwise the whole list would light up on first launch (we'd have no
// watermark to compare against). The active session is continuously re-marked viewed by the sidebar.
export function isSessionUnread(id: string, updated: number): boolean {
  const v = viewed()
  return id in v && updated > v[id]
}

export function markSessionViewed(id: string, updated: number) {
  setViewedSignal((prev) => {
    if (prev[id] === updated) return prev
    const next = { ...prev, [id]: updated }
    write(VIEWED_KEY, JSON.stringify(next))
    return next
  })
}

export function hideProject(worktree: string) {
  setHiddenSignal((prev) => {
    if (prev.has(worktree)) return prev
    const next = new Set(prev)
    next.add(worktree)
    write(HIDDEN_KEY, JSON.stringify([...next]))
    return next
  })
}

export function unhideProject(worktree: string) {
  setHiddenSignal((prev) => {
    if (!prev.has(worktree)) return prev
    const next = new Set(prev)
    next.delete(worktree)
    write(HIDDEN_KEY, JSON.stringify([...next]))
    return next
  })
}
