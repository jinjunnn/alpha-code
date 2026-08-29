/**
 * REQ-125 C3-files — context-free state for the files panel.
 *
 * All IO comes in through `FilesPanelIO` (typed SDK/layout channels wired by
 * session-rail-files.tsx, fakes in tests). Every async result is bound to the session
 * identity via `stillCurrent()` before it may touch the UI model (baseline I8); paths are
 * sanitized in files-core before they enter the model.
 */

import { createMemo, createSignal, onCleanup, onMount, type Accessor } from "solid-js"
import { createStore, produce } from "solid-js/store"
import {
  fileName,
  normalizeToRel,
  parentDir,
  relPathFromTab,
  relPathToTab,
  sanitizeSearchRows,
  toTreeEntries,
  watcherRefreshTarget,
  type FileChangeKind,
  type TreeEntry,
} from "./files-core"

export interface DirState {
  expanded: boolean
  loading?: boolean
  loaded?: boolean
  error?: boolean
  entries?: TreeEntry[]
  /** I7 bound: set when this level was truncated to the per-level/total node cap. */
  truncated?: { shown: number; total: number }
}

export interface OpenedRow {
  tab: string
  path: string
  name: string
  active: boolean
}

export interface SearchState {
  query: string
  loading: boolean
  failed?: boolean
  rows: string[]
}

export interface FilesPanelIO {
  /** Workspace root; used only to *strip* prefixes from inbound paths, never to join. */
  root: string
  /** Identity binding (I8): async results are dropped once the session context moved on. */
  stillCurrent: () => boolean
  listDir: (path: string) => Promise<readonly unknown[]>
  findFiles: (query: string, signal: AbortSignal) => Promise<readonly unknown[]>
  changeKinds: Accessor<ReadonlyMap<string, FileChangeKind>>
  openedTabs: {
    all: Accessor<string[]>
    active: Accessor<string | undefined>
    open: (tab: string) => void
    close: (tab: string) => void
    setActive: (tab: string) => void
  }
  jumpToReview: (path: string) => void
  /** REQ-108(#244):打开文件查看器(文件面板的下钻层)。缺席时保持旧行为(只记 tab)。 */
  openViewer?: (path: string) => void
  searchLimit?: number
  searchDebounceMs?: number
  /** I7 bounds for the lazily loaded tree (tests inject small values). */
  treeDirCap?: number
  treeTotalCap?: number
}

export function createFilesPanelState(io: FilesPanelIO) {
  const searchLimit = io.searchLimit ?? 100
  const searchDebounceMs = io.searchDebounceMs ?? 150
  const treeDirCap = io.treeDirCap ?? 500
  const treeTotalCap = io.treeTotalCap ?? 2500

  const [tree, setTree] = createStore<{ dir: Record<string, DirState | undefined> }>({
    dir: { "": { expanded: true } },
  })
  const [selected, setSelected] = createSignal<string>()
  const [filter, setFilterSignal] = createSignal("")
  const [searchState, setSearchState] = createSignal<SearchState | undefined>()

  const inflight = new Map<string, Promise<void>>()

  const ensureDir = (path: string) => {
    if (!tree.dir[path]) setTree("dir", path, { expanded: false })
  }

  // Nodes currently shown by every loaded level except `except` — the budget base for the
  // total cap. Untracked plain read; called only inside async apply.
  const shownCountExcept = (except: string) => {
    let count = 0
    for (const [key, state] of Object.entries(tree.dir)) {
      if (key === except || !state?.entries) continue
      count += state.entries.length
    }
    return count
  }

  const loadDir = (path: string, options?: { force?: boolean }) => {
    ensureDir(path)
    if (!options?.force && tree.dir[path]?.loaded) return Promise.resolve()
    const pending = inflight.get(path)
    if (pending) return pending
    setTree(
      "dir",
      path,
      produce((draft) => {
        if (!draft) return
        draft.loading = true
        draft.error = undefined
      }),
    )
    const promise = io
      .listDir(path)
      .then((nodes) => {
        if (!io.stillCurrent()) return
        const entries = toTreeEntries(path, nodes)
        // I7: bound what a single level (and the tree as a whole) may render.
        const budget = Math.max(0, treeTotalCap - shownCountExcept(path))
        const cap = Math.min(treeDirCap, budget)
        const shown = entries.length > cap ? entries.slice(0, cap) : entries
        setTree(
          "dir",
          path,
          produce((draft) => {
            if (!draft) return
            draft.loading = false
            draft.loaded = true
            draft.error = undefined
            draft.entries = shown
            draft.truncated = shown.length < entries.length ? { shown: shown.length, total: entries.length } : undefined
          }),
        )
      })
      .catch(() => {
        if (!io.stillCurrent()) return
        setTree(
          "dir",
          path,
          produce((draft) => {
            if (!draft) return
            draft.loading = false
            draft.error = true
          }),
        )
      })
      .finally(() => {
        inflight.delete(path)
      })
    inflight.set(path, promise)
    return promise
  }

  onMount(() => {
    void loadDir("")
  })

  const toggleDir = (path: string) => {
    if (tree.dir[path]?.expanded) {
      setTree("dir", path, "expanded", false)
      return
    }
    ensureDir(path)
    setTree("dir", path, "expanded", true)
    void loadDir(path)
  }

  const retryDir = (path: string) => {
    void loadDir(path, { force: true })
  }

  // ── filter / search ────────────────────────────────────────────────────────────────────
  let searchAbort: AbortController | undefined
  let searchTimer: ReturnType<typeof setTimeout> | undefined

  const runSearch = (query: string) => {
    const controller = new AbortController()
    searchAbort = controller
    setSearchState({ query, loading: true, rows: [] })
    io.findFiles(query, controller.signal)
      .then((paths) => {
        if (controller.signal.aborted || !io.stillCurrent()) return
        if (filter().trim() !== query) return
        setSearchState({ query, loading: false, rows: sanitizeSearchRows(paths, io.root, searchLimit) })
      })
      .catch(() => {
        if (controller.signal.aborted || !io.stillCurrent()) return
        if (filter().trim() !== query) return
        setSearchState({ query, loading: false, failed: true, rows: [] })
      })
  }

  const setFilter = (value: string) => {
    setFilterSignal(value)
    if (searchTimer) clearTimeout(searchTimer)
    searchTimer = undefined
    searchAbort?.abort()
    searchAbort = undefined
    const query = value.trim()
    if (!query) {
      setSearchState(undefined)
      return
    }
    searchTimer = setTimeout(() => runSearch(query), searchDebounceMs)
  }

  onCleanup(() => {
    if (searchTimer) clearTimeout(searchTimer)
    searchAbort?.abort()
  })

  // ── opened tabs (shared upstream layout store) ─────────────────────────────────────────
  const opened = createMemo<OpenedRow[]>(() => {
    const active = io.openedTabs.active()
    return io.openedTabs.all().flatMap((tab) => {
      const path = relPathFromTab(tab)
      return path ? [{ tab, path, name: fileName(path), active: tab === active }] : []
    })
  })

  const selectOpened = (tab: string) => {
    io.openedTabs.setActive(tab)
    const path = relPathFromTab(tab)
    if (path) {
      setSelected(path)
      io.openViewer?.(path)
    }
  }

  const closeOpened = (tab: string) => {
    io.openedTabs.close(tab)
  }

  // ── rows ───────────────────────────────────────────────────────────────────────────────
  const badge = (path: string) => io.changeKinds().get(path)

  // Approved linkage contract(REQ-108 修订):带改动标的行跳审查(改动优先看 diff);
  // 无改动标的行打开文件查看器(下钻层)。打开列表仍然登记(「已打开」组的数据源)。
  const activateFile = (path: string) => {
    setSelected(path)
    if (badge(path)) {
      io.jumpToReview(path)
      return
    }
    io.openedTabs.open(relPathToTab(path))
    io.openViewer?.(path)
  }

  const dirState = (path: string): DirState | undefined => tree.dir[path]

  const entryAt = (path: string): TreeEntry | undefined =>
    tree.dir[parentDir(path)]?.entries?.find((entry) => entry.path === path)

  const applyWatcher = (rawPath: string, kind: string) => {
    const rel = normalizeToRel(io.root, rawPath)
    if (!rel) return
    const target = watcherRefreshTarget({
      kind,
      path: rel,
      isDirLoaded: (dir) => tree.dir[dir]?.loaded === true,
      isDirEntry: (path) => entryAt(path)?.type === "directory",
    })
    if (target !== undefined) void loadDir(target, { force: true })
  }

  return {
    filter,
    setFilter,
    searchState,
    opened,
    selectOpened,
    closeOpened,
    dirState,
    toggleDir,
    retryDir,
    badge,
    selected,
    activateFile,
    applyWatcher,
  }
}

export type FilesPanelState = ReturnType<typeof createFilesPanelState>
