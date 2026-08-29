/**
 * REQ-125 C3-files — right-rail files panel wiring.
 *
 * Data comes exclusively from whitelisted public typed channels (baseline I1):
 * - workspace tree + name filter: directory-scoped SDK (`useServerSDK` → file.list / find.files)
 * - session change badges: the turn-level diff projection over the synced message store
 *   (REQ-142 `turnDiffsOf`: the engine persists each turn's changes into that turn's user
 *   message; `message.updated` events keep it fresh)
 * - opened files: the upstream layout session-tab store (`useLayout().tabs`), shared via the
 *   parity session state key so both surfaces see the same opened set
 * Rendering is fully alpha-held; no upstream session DOM/components are touched.
 *
 * Path security (baseline §③.3): the renderer only passes workspace-relative identifiers to
 * these channels; the server/main side stays the authoritative resolver. Nothing here builds
 * or forwards absolute paths.
 */

import { useLayout, useServerSDK, useServerSync } from "@opencode-ai/app"
import { createEffect, createMemo, onCleanup, Show } from "solid-js"
import type { AlphaSessionLiveContext, SessionRailApi } from "../../session-workspace/session-workspace-shell"
import { turnDiffsOf } from "../review/review-turn-diffs"
import { sessionStateKey, statusByFile } from "./files-core"
import { createFilesPanelState } from "./files-state"
import { SessionRailFilesView } from "./files-view"
import { createFileViewerIO, createFileViewerOverlayIO } from "./file-viewer-io"
import { createFileViewerState } from "./file-viewer-state"
import { FileViewerView } from "./file-viewer-view"
import "./session-rail-files.css"

const SEARCH_LIMIT = 100

export function SessionRailFiles(props: { live: AlphaSessionLiveContext; rail: SessionRailApi }) {
  // Key the whole panel on the session identity triple: switching session/workspace/server
  // remounts with fresh stores, so no state can leak across sessions (baseline I8).
  const identityKey = createMemo(() => {
    const identity = props.live.current()?.identity
    if (!identity) return undefined
    return `${identity.serverKey}\u0000${identity.directory}\u0000${identity.sessionID}`
  })
  return (
    <Show when={identityKey()} keyed>
      {(_key) => <FilesPanel live={props.live} rail={props.rail} />}
    </Show>
  )
}

function FilesPanel(props: { live: AlphaSessionLiveContext; rail: SessionRailApi }) {
  // Under the keyed <Show> above the identity is fixed for this component's lifetime; capture
  // it once and bind every async application to it via live.accepts (I8).
  const identity = props.live.current()!.identity
  const serverSDK = useServerSDK()
  const serverSync = useServerSync()
  const layout = useLayout()

  const dirContext = createMemo(() => serverSDK().ensureDirSdkContext(identity.directory))
  const tabs = layout.tabs(() => sessionStateKey(serverSDK().scope, identity.directory, identity.sessionID))
  const changeKinds = createMemo(() =>
    statusByFile(turnDiffsOf(serverSync().session.data.message[identity.sessionID]), identity.directory),
  )

  // Idempotent initial load of the session's messages; `message.updated` events
  // keep the badge projection fresh afterwards.
  createEffect(() => {
    if (serverSync().session.data.message[identity.sessionID] !== undefined) return
    void serverSync().session.sync(identity.sessionID)
  })

  const overlayIO = createFileViewerOverlayIO(identity.directory)
  const viewer = createFileViewerState(createFileViewerIO(identity.directory))
  onCleanup(() => viewer.dispose())

  let treeLayer: HTMLDivElement | undefined
  let origin: HTMLElement | undefined

  const openViewer = (path: string) => {
    if (!viewer.current()) {
      const active = document.activeElement
      origin = active instanceof HTMLElement ? active : undefined
    }
    viewer.open(path)
  }

  const exitViewer = () => {
    viewer.close()
    // 焦点回到来源行(交互契约);来源已不可达则不抢焦点。
    if (origin?.isConnected) origin.focus()
    origin = undefined
  }

  const state = createFilesPanelState({
    root: identity.directory,
    stillCurrent: () => props.live.accepts(identity),
    listDir: (path) =>
      dirContext()
        .client.file.list({ path })
        .then((result: { data?: readonly unknown[] }) => result.data ?? []),
    findFiles: (query, signal) =>
      dirContext()
        .client.find.files({ query, dirs: "false", limit: SEARCH_LIMIT }, { signal })
        .then((result: { data?: readonly unknown[] }) => result.data ?? []),
    changeKinds,
    openedTabs: {
      all: () => tabs.all(),
      active: () => tabs.active(),
      open: (tab) => void tabs.open(tab),
      close: (tab) => tabs.close(tab),
      setActive: (tab) => tabs.setActive(tab),
    },
    jumpToReview: (path) => props.rail.jumpToReview(path),
    openViewer,
    searchLimit: SEARCH_LIMIT,
  })

  // Keep loaded directories fresh while the assistant works (watcher events are typed SDK
  // events on the directory channel; paths are re-proven relative before use).
  createEffect(() => {
    const off = dirContext().event.on("file.watcher.updated", (event) => {
      if (!props.live.accepts(identity)) return
      state.applyWatcher(event.properties.file, event.properties.event)
    })
    onCleanup(off)
  })

  // REQ-108(#244):查看器 = 文件面板的下钻覆盖层。树保持挂载(滚动/展开/焦点原样保留),
  // 查看器打开期间对树加 inert(覆盖层下的内容不进 Tab 序列、不进 AT)。
  createEffect(() => {
    if (treeLayer) treeLayer.inert = viewer.current() !== undefined
  })

  // rail linkage:审查文件卡「查看整份文件」→ 查看器(seq 让同文件重复请求也触发)。
  createEffect(() => {
    const target = props.rail.fileViewerTarget?.()
    if (target) openViewer(target.file)
  })

  // AC5:面板被切走 → 读取立即终止(叠放销毁由查看器自身 effect 的 active 依赖兑现)。
  createEffect((previous: string | undefined) => {
    const active = props.rail.activePanel?.()
    if (previous === "files" && active !== "files") viewer.deactivate()
    return active
  })

  return (
    <div class="a-srf-stack">
      <div class="a-srf-tree-layer" ref={treeLayer} aria-hidden={viewer.current() ? "true" : undefined}>
        <SessionRailFilesView state={state} />
      </div>
      <Show when={viewer.current()}>
        <FileViewerView
          state={viewer}
          overlayIO={overlayIO}
          active={() => (props.rail.activePanel?.() ?? "files") === "files"}
          onExit={exitViewer}
        />
      </Show>
    </div>
  )
}
