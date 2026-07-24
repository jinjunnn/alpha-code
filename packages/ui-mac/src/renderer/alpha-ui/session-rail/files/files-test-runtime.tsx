/**
 * REQ-125 C3-files — test-only harness. Feeds the real state factory + view with fake typed
 * IO so the component cases (test-component/session-rail-files.cases.ts) exercise genuine
 * behavior (lazy tree loads, debounce/abort, identity binding) without app contexts.
 */

import { createSignal } from "solid-js"
import {
  sameSessionIdentity,
  type AlphaSessionIdentity,
  type AlphaSessionLiveSnapshot,
} from "../../session-workspace/session-workspace-core"
import {
  SessionWorkspaceShell,
  type AlphaSessionLiveContext,
  type SessionRailApi,
  type SessionRailPanelRenderers,
} from "../../session-workspace/session-workspace-shell"
import type { FileChangeKind } from "./files-core"
import { createFilesPanelState, type FilesPanelIO, type FilesPanelState } from "./files-state"
import { SessionRailFilesView } from "./files-view"

export interface FilesHarnessCalls {
  listDir: string[]
  findFiles: string[]
  jumpToReview: string[]
  open: string[]
  close: string[]
  setActive: string[]
}

export function createFilesHarness(options?: {
  listDir?: (path: string) => Promise<readonly unknown[]>
  findFiles?: (query: string, signal: AbortSignal) => Promise<readonly unknown[]>
  searchDebounceMs?: number
  treeDirCap?: number
  treeTotalCap?: number
}) {
  const calls: FilesHarnessCalls = { listDir: [], findFiles: [], jumpToReview: [], open: [], close: [], setActive: [] }
  const [tabsAll, setTabsAll] = createSignal<string[]>([])
  const [tabActive, setTabActive] = createSignal<string | undefined>()
  const [changeKinds, setChangeKinds] = createSignal<ReadonlyMap<string, FileChangeKind>>(new Map())
  const [stillCurrent, setStillCurrent] = createSignal(true)

  const io: FilesPanelIO = {
    root: "/tmp/workspace",
    stillCurrent,
    treeDirCap: options?.treeDirCap,
    treeTotalCap: options?.treeTotalCap,
    listDir: (path) => {
      calls.listDir.push(path)
      return (options?.listDir ?? (() => Promise.resolve([])))(path)
    },
    findFiles: (query, signal) => {
      calls.findFiles.push(query)
      return (options?.findFiles ?? (() => Promise.resolve([])))(query, signal)
    },
    changeKinds,
    openedTabs: {
      all: tabsAll,
      active: tabActive,
      open: (tab) => {
        calls.open.push(tab)
        setTabsAll((all) => (all.includes(tab) ? all : [...all, tab]))
        setTabActive(tab)
      },
      close: (tab) => {
        calls.close.push(tab)
        setTabsAll((all) => all.filter((item) => item !== tab))
        setTabActive((active) => (active === tab ? undefined : active))
      },
      setActive: (tab) => {
        calls.setActive.push(tab)
        setTabActive(tab)
      },
    },
    jumpToReview: (path) => {
      calls.jumpToReview.push(path)
    },
    searchDebounceMs: options?.searchDebounceMs ?? 0,
  }

  let state: FilesPanelState | undefined
  const View = () => {
    state = createFilesPanelState(io)
    return <SessionRailFilesView state={state} />
  }

  return { View, calls, setTabsAll, setTabActive, setChangeKinds, setStillCurrent, state: () => state! }
}

export function createShellHarness(panels: SessionRailPanelRenderers) {
  const identity: AlphaSessionIdentity = { serverKey: "sidecar", directory: "/tmp/workspace", sessionID: "ses_rail" }
  const snapshot: AlphaSessionLiveSnapshot = { identity, project: "workspace", title: "整理架构说明", activity: "idle" }
  const [current, setCurrent] = createSignal<AlphaSessionLiveSnapshot | undefined>(snapshot)
  const live: AlphaSessionLiveContext = {
    current,
    accepts: (candidate) => sameSessionIdentity(candidate, current()?.identity),
  }
  const Shell = () => <SessionWorkspaceShell live={live} panels={panels} />
  return { Shell, setSnapshot: setCurrent, identity }
}

/** Shell + fake rail panels for the rail-integration cases (JSX lives here, in transformed code). */
export function createShellCaseHarness() {
  let railApi: SessionRailApi | undefined
  const harness = createShellHarness({
    files: (rail) => {
      railApi = rail
      return <div data-fake-files-panel />
    },
    review: (rail) => <div data-fake-review-panel>{rail.reviewTarget()?.file ?? ""}</div>,
  })
  return { Shell: harness.Shell, rail: () => railApi, setSnapshot: harness.setSnapshot, identity: harness.identity }
}
