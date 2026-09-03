/**
 * REQ-125 C3-files — test-only harness. Feeds the real state factory + view with fake typed
 * IO so the component cases (test-component/session-rail-files.cases.ts) exercise genuine
 * behavior (lazy tree loads, debounce/abort, identity binding) without app contexts.
 */

import { createSignal, Show } from "solid-js"
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
import { Dialog } from "../../Dialog"
import type { FileChangeKind } from "./files-core"
import { createFilesPanelState, type FilesPanelIO, type FilesPanelState } from "./files-state"
import { SessionRailFilesView } from "./files-view"
import type {
  FileViewerRefusal,
  RailPreviewBounds,
  RailPreviewClosedEvent,
  RailPreviewOfficeOutcome,
  RailPreviewOpenResult,
  WorkspaceFileChunkResult,
} from "../../../../shared/file-viewer"
import { FILE_VIEWER_CHUNK_BYTES } from "../../../../shared/file-viewer"
import type { FileViewerOverlayIO } from "./file-viewer-io"
import { createFileViewerState, type FileViewerState } from "./file-viewer-state"
import { FileViewerView } from "./file-viewer-view"

export interface FilesHarnessCalls {
  listDir: string[]
  findFiles: string[]
  jumpToReview: string[]
  open: string[]
  close: string[]
  setActive: string[]
  openViewer: string[]
}

export function createFilesHarness(options?: {
  listDir?: (path: string) => Promise<readonly unknown[]>
  findFiles?: (query: string, signal: AbortSignal) => Promise<readonly unknown[]>
  searchDebounceMs?: number
  treeDirCap?: number
  treeTotalCap?: number
}) {
  const calls: FilesHarnessCalls = {
    listDir: [],
    findFiles: [],
    jumpToReview: [],
    open: [],
    close: [],
    setActive: [],
    openViewer: [],
  }
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
    openViewer: (path) => {
      calls.openViewer.push(path)
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


// ── REQ-108 file viewer harness ──────────────────────────────────────────────────────────

export interface ViewerFakeFile {
  content?: string | Uint8Array
  /** openRead 报告的总大小(缺省 = content 长度;override 用来演过大文件)。 */
  totalBytes?: number
  refusal?: FileViewerRefusal
}

export interface ViewerHarnessCalls {
  openRead: string[]
  readChunk: Array<{ readId: string; offset: number; length: number }>
  closeRead: string[]
  openExternal: string[]
  reveal: string[]
  saveCopy: string[]
  overlayOpen: Array<{ path: string; kind: string; bounds: RailPreviewBounds }>
  overlayClose: string[]
  overlaySetBounds: string[]
  overlaySetVisible: Array<{ previewId: string; visible: boolean }>
}

export function createViewerHarness(options: {
  files: Record<string, ViewerFakeFile>
  /** true = readChunk 挂起,由 releaseChunk() 手动放行(测取消/迟到内容)。 */
  gated?: boolean
  overlayOpenResult?: RailPreviewOpenResult
  /** #1229:让用例驱动「版式宿主页报了什么」——降级路只能从这里进。 */
  overlayOfficeOutcome?: RailPreviewOfficeOutcome
}) {
  const calls: ViewerHarnessCalls = {
    openRead: [],
    readChunk: [],
    closeRead: [],
    openExternal: [],
    reveal: [],
    saveCopy: [],
    overlayOpen: [],
    overlayClose: [],
    overlaySetBounds: [],
    overlaySetVisible: [],
  }
  let nextRead = 0
  const contents = new Map<string, Uint8Array>()
  const totals = new Map<string, number>()
  const pending: Array<() => void> = []
  const overlayClosedCbs = new Set<(e: RailPreviewClosedEvent) => void>()

  const bytesOf = (file: ViewerFakeFile): Uint8Array => {
    if (file.content === undefined) return new Uint8Array(0)
    return typeof file.content === "string" ? new TextEncoder().encode(file.content) : file.content
  }

  const io = {
    openRead: (path: string) => {
      calls.openRead.push(path)
      const file = options.files[path]
      if (!file) return Promise.resolve({ ok: false as const, code: "not-found" as const })
      if (file.refusal) return Promise.resolve({ ok: false as const, code: file.refusal })
      const readId = `read_${++nextRead}`
      const bytes = bytesOf(file)
      contents.set(readId, bytes)
      totals.set(readId, file.totalBytes ?? bytes.length)
      return Promise.resolve({ ok: true as const, readId, totalBytes: file.totalBytes ?? bytes.length })
    },
    readChunk: (readId: string, offset: number, length: number) => {
      calls.readChunk.push({ readId, offset, length })
      const compute = (): WorkspaceFileChunkResult => {
        const bytes = contents.get(readId)
        if (!bytes) return { ok: false, code: "read-failed" }
        const want = Math.min(length, FILE_VIEWER_CHUNK_BYTES)
        const slice = bytes.subarray(offset, Math.min(offset + want, bytes.length))
        return { ok: true, bytes: slice, eof: offset + slice.length >= bytes.length }
      }
      if (!options.gated) return Promise.resolve(compute())
      return new Promise<WorkspaceFileChunkResult>((resolve) => {
        pending.push(() => resolve(compute()))
      })
    },
    closeRead: (readId: string) => {
      calls.closeRead.push(readId)
      contents.delete(readId)
    },
    openExternal: (path: string) => calls.openExternal.push(path),
    reveal: (path: string) => calls.reveal.push(path),
    saveCopy: (path: string) => calls.saveCopy.push(path),
  }

  const overlayIO: FileViewerOverlayIO = {
    open: (path, kind, bounds) => {
      calls.overlayOpen.push({ path, kind, bounds })
      return Promise.resolve(options.overlayOpenResult ?? { ok: true, previewId: `rp_${calls.overlayOpen.length}` })
    },
    setBounds: (previewId) => void calls.overlaySetBounds.push(previewId),
    setVisible: (previewId, visible) => void calls.overlaySetVisible.push({ previewId, visible }),
    close: (previewId) => void calls.overlayClose.push(previewId),
    status: (previewId) =>
      Promise.resolve({
        ok: true,
        previewId,
        open: true,
        blockedPaths: [],
        ...(options.overlayOfficeOutcome ? { office: options.overlayOfficeOutcome } : {}),
      }),
    onClosed: (cb) => {
      overlayClosedCbs.add(cb)
      return () => overlayClosedCbs.delete(cb)
    },
  }

  const [active, setActive] = createSignal(true)
  // #1173:强模态驱动 —— 挂的是**生产的** alpha-ui/Dialog(权限审批/能力授权同一个组件),
  // 所以用例驱动的是真实模态源(Dialog → dialog-core.registerDialog → modal-presence),
  // 不是一个替身信号。
  const [modalOpen, setModalOpen] = createSignal(false)
  let viewer: FileViewerState | undefined
  const exits: number[] = []

  // 组合形态与生产 wiring 同构:树层常驻 + 查看器覆盖层(inert 效果由 wiring 持有,这里不复制)。
  const View = () => {
    viewer = createFileViewerState(io)
    return (
      <div data-viewer-harness>
        <button type="button" data-fake-tree-row>
          tree
        </button>
        <Show when={viewer!.current()}>
          <FileViewerView
            state={viewer!}
            overlayIO={overlayIO}
            active={active}
            onExit={() => {
              exits.push(Date.now())
              viewer!.close()
            }}
          />
        </Show>
        <Dialog open={modalOpen()} onClose={() => setModalOpen(false)} title="Approve tool run">
          <button type="button" data-fake-modal-approve>
            approve
          </button>
        </Dialog>
      </div>
    )
  }

  return {
    View,
    calls,
    viewer: () => viewer!,
    setActive,
    setModalOpen,
    releaseChunk: () => pending.shift()?.(),
    pendingChunks: () => pending.length,
    emitOverlayClosed: (e: RailPreviewClosedEvent) => overlayClosedCbs.forEach((cb) => cb(e)),
    exits,
  }
}
