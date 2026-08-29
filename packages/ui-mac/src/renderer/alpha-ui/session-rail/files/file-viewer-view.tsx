/**
 * REQ-108(#244)—— 文件查看器的呈现层(已批帧:docs/design/2026-08-28-req108-rail-file-viewer)。
 *
 * 骨架 = 恒定头部(返回 · 文件名 · 模式 · 更多)+ 九态主体。文本族内容复用 workbench 的
 * 内容积木(content-views:同一份净化模型渲染);html/pdf 是 main 持有的 WebContentsView
 * 叠放 —— 主文档 DOM 里**没有**它的节点,本组件只画头部、状态行与容器边界,并把内容区
 * bounds 上报给 main(证据形态见设计 §4:判「显示了」走主进程状态/截图,不走 DOM 探针)。
 *
 * 叠放生命周期由一个 effect 独占:进入 html/pdf 态且面板可见 → open;cleanup(返回树、
 * 切文件、切面板、收起右栏、切会话、卸载)→ close(销毁,不是隐藏)。
 */

import { createEffect, createSignal, Match, onCleanup, onMount, Show, Switch } from "solid-js"
import { t } from "../../../i18n"
import { rovingKey, rovingTabIndex } from "../../roving-focus"
import { formatBytes } from "../../artifact-workbench/workbench-core"
import { JsonNodeView, LinesView, MdBlockView } from "../../artifact-workbench/renderers/content-views"
import { parseCsvModel } from "../../artifact-workbench/renderers/csv-model"
import { parseJsonModel } from "../../artifact-workbench/renderers/json-model"
import { parseMarkdownModel } from "../../artifact-workbench/renderers/markdown-model"
import { extensionOf } from "../../artifact-workbench/renderers/registry"
import { HTML_PREVIEW_MAX_BLOCKED_ENTRIES } from "../../../../shared/html-preview"
import type { RailPreviewBounds } from "../../../../shared/file-viewer"
import { modalPresent, subscribeModalPresence } from "../../modal-presence"
import type { FileViewerOverlayIO } from "./file-viewer-io"
import type { FileViewerState, ViewerFilePhase } from "./file-viewer-state"

function BackIcon() {
  return (
    <svg class="a-fv-icon" viewBox="0 0 24 24" aria-hidden="true">
      <path d="M15 18l-6-6 6-6" />
    </svg>
  )
}

function KebabIcon() {
  return (
    <svg class="a-fv-icon" viewBox="0 0 24 24" aria-hidden="true">
      <circle cx="12" cy="5" r="1.4" />
      <circle cx="12" cy="12" r="1.4" />
      <circle cx="12" cy="19" r="1.4" />
    </svg>
  )
}

/** 「更多」菜单:在系统中打开 / 打开所在目录 / 另存副本(与格式无关;不安全态整个头部动作隐藏)。 */
function KebabMenu(props: { state: FileViewerState }) {
  const [open, setOpen] = createSignal(false)
  const act = (fn: () => void) => {
    setOpen(false)
    fn()
  }
  return (
    <div class="a-fv-kebab-wrap">
      <button
        type="button"
        class="a-fv-iconbtn"
        aria-label={t("alpha.fileViewer.more")}
        aria-haspopup="menu"
        aria-expanded={open()}
        data-alpha-fv-kebab
        onClick={() => setOpen((value) => !value)}
      >
        <KebabIcon />
      </button>
      <Show when={open()}>
        <div class="a-fv-menu" role="menu" data-alpha-fv-menu>
          <button type="button" role="menuitem" onClick={() => act(() => props.state.openExternal())}>
            {t("alpha.fileViewer.openSystem")}
          </button>
          <button type="button" role="menuitem" onClick={() => act(() => props.state.reveal())}>
            {t("alpha.fileViewer.revealDir")}
          </button>
          <button type="button" role="menuitem" onClick={() => act(() => props.state.saveCopy())}>
            {t("alpha.fileViewer.saveCopy")}
          </button>
        </div>
      </Show>
    </div>
  )
}

/** 预览|源码 radiogroup:键盘契约走全 alpha-ui 唯一实现(rovingKey "radio" 表 + rovingTabIndex)。 */
function ModeSegment(props: { mode: "preview" | "source"; setMode: (mode: "preview" | "source") => void }) {
  const MODES = ["preview", "source"] as const
  const buttons = new Map<string, HTMLButtonElement>()
  const onKey = (event: KeyboardEvent) =>
    rovingKey(event, "radio", MODES, props.mode, (mode) => {
      props.setMode(mode)
      buttons.get(mode)?.focus()
    })
  return (
    <div class="a-fv-seg" role="radiogroup" aria-label={t("alpha.fileViewer.modeLabel")} data-alpha-fv-modes>
      <button
        type="button"
        role="radio"
        aria-checked={props.mode === "preview"}
        tabIndex={rovingTabIndex(props.mode === "preview")}
        ref={(el) => buttons.set("preview", el)}
        onKeyDown={onKey}
        onClick={() => props.setMode("preview")}
      >
        {t("alpha.fileViewer.modePreview")}
      </button>
      <button
        type="button"
        role="radio"
        aria-checked={props.mode === "source"}
        tabIndex={rovingTabIndex(props.mode === "source")}
        ref={(el) => buttons.set("source", el)}
        onKeyDown={onKey}
        onClick={() => props.setMode("source")}
      >
        {t("alpha.fileViewer.modeSource")}
      </button>
    </div>
  )
}

function CenterCard(props: {
  tone?: "warn" | "err"
  title: string
  detail: string
  fact?: string
  children?: import("solid-js").JSX.Element
}) {
  return (
    <div class="a-fv-center" data-alpha-fv-card>
      <div class="a-fv-card-title" data-tone={props.tone}>
        {props.title}
      </div>
      <p class="a-fv-card-detail">{props.detail}</p>
      <Show when={props.fact}>
        <div class="a-fv-card-fact">{props.fact}</div>
      </Show>
      <Show when={props.children}>
        <div class="a-fv-actions">{props.children}</div>
      </Show>
    </div>
  )
}

function TextContent(props: { state: FileViewerState; phase: Extract<ViewerFilePhase, { phase: "text" }> }) {
  const name = () => props.state.current()?.name ?? ""
  return (
    <div class="a-fv-content" data-alpha-fv-text>
      <Show when={props.phase.excerpt}>
        <div class="a-fv-notice" role="note">
          {t("alpha.fileViewer.excerptNotice", { total: formatBytes(props.phase.totalBytes) })}
        </div>
      </Show>
      <Switch>
        <Match when={props.phase.view === "markdown" && props.phase.mode === "preview"}>
          {(() => {
            const model = parseMarkdownModel(props.phase.text)
            return (
              <div class="a-wb-md" data-alpha-fv-markdown>
                <Show when={model.truncated}>
                  <div class="a-fv-notice" role="note">
                    {t("alpha.wb.mdTruncated", { count: model.blockCount })}
                  </div>
                </Show>
                <MdBlockView blocks={model.blocks} />
              </div>
            )
          })()}
        </Match>
        <Match when={props.phase.view === "markdown"}>
          <LinesView text={props.phase.text} lang="md" />
        </Match>
        <Match when={props.phase.view === "code"}>
          <LinesView text={props.phase.text} lang={extensionOf(name())} />
        </Match>
        <Match when={props.phase.view === "json"}>
          {(() => {
            const model = parseJsonModel(props.phase.text)
            if (!model.ok)
              return (
                <>
                  <div class="a-fv-notice" role="note">
                    {t("alpha.wb.jsonInvalid", { error: model.error })}
                  </div>
                  <LinesView text={props.phase.text} lang="json" />
                </>
              )
            return (
              <div class="a-wb-json">
                <JsonNodeView node={model.root} depth={0} />
              </div>
            )
          })()}
        </Match>
        <Match when={props.phase.view === "csv"}>
          {(() => {
            const forceTab = props.phase.effectiveMime === "text/tab-separated-values"
            const model = parseCsvModel(props.phase.text, { delimiter: forceTab ? "\t" : "auto" })
            return (
              <div class="a-wb-csv">
                <Show when={model.truncatedRows || props.phase.excerpt}>
                  <div class="a-fv-notice" role="note">
                    {t("alpha.wb.csvTruncated", { shown: model.rowCount })}
                  </div>
                </Show>
                <div class="a-wb-tablewrap" tabIndex={0}>
                  <table>
                    <thead>
                      <tr>{model.header.map((cell) => <th>{cell}</th>)}</tr>
                    </thead>
                    <tbody>{model.rows.map((row) => <tr>{row.map((cell) => <td>{cell}</td>)}</tr>)}</tbody>
                  </table>
                </div>
              </div>
            )
          })()}
        </Match>
        <Match when={true}>
          <LinesView text={props.phase.text} lang={null} />
        </Match>
      </Switch>
    </div>
  )
}

function ImageContent(props: { state: FileViewerState; phase: Extract<ViewerFilePhase, { phase: "image" }> }) {
  let url: string | null = null
  const revoke = () => {
    if (url) URL.revokeObjectURL(url)
    url = null
  }
  onCleanup(revoke)
  const [decodeError, setDecodeError] = createSignal(false)
  const src = () => {
    revoke()
    const blob = new Blob([props.phase.bytes as Uint8Array<ArrayBuffer>], { type: props.phase.mime })
    url = URL.createObjectURL(blob)
    return url
  }
  return (
    <Show
      when={!decodeError()}
      fallback={
        <CenterCard tone="err" title={t("alpha.wb.imgDecodeFailed")} detail={t("alpha.fileViewer.unsupportedDetail")}>
          <button type="button" class="a-fv-btn" onClick={() => props.state.openExternal()}>
            {t("alpha.fileViewer.openSystem")}
          </button>
        </CenterCard>
      }
    >
      <figure class="a-fv-image" data-alpha-fv-image>
        <img src={src()} alt={props.state.current()?.name ?? ""} onError={() => setDecodeError(true)} />
        <figcaption>
          {props.state.current()?.name} · {formatBytes(props.phase.totalBytes)}
        </figcaption>
      </figure>
    </Show>
  )
}

/**
 * 叠放内容区:effect 独占 open/close;bounds 由 ResizeObserver + window resize 跟随。
 * DOM 里只有这个占位容器 —— 真内容画在 main 的 WebContentsView 上。
 */
function OverlayRegion(props: {
  state: FileViewerState
  overlayIO: FileViewerOverlayIO
  phase: Extract<ViewerFilePhase, { phase: "overlay" }>
  active: () => boolean
}) {
  let region: HTMLDivElement | undefined
  const [blocked, setBlocked] = createSignal<number>(0)

  const boundsOf = (): RailPreviewBounds => {
    const rect = region!.getBoundingClientRect()
    return { x: rect.x, y: rect.y, width: rect.width, height: rect.height }
  }

  createEffect(() => {
    if (!props.active()) return
    const path = props.state.current()?.path
    if (!path || !region) return
    let previewId: string | undefined
    let disposed = false

    void props.overlayIO.open(path, props.phase.overlay, boundsOf()).then((result) => {
      if (disposed) {
        if (result.ok) props.overlayIO.close(result.previewId)
        return
      }
      if (!result.ok) {
        // 载体守卫拒绝 → 与读取路径同一套四态映射(main 已 fail-closed)。
        props.state.applyRefusal(result.code)
        return
      }
      previewId = result.previewId
      // 开的时候可能已经有强模态在场(例如审批弹窗挂着时用户切到了另一份 pdf)——
      // 只在那一刻才发,免得把「让位」这条通道稀释成每次打开都响一声。
      if (modalPresent()) props.overlayIO.setVisible(previewId, false)
    })

    // 强模态在场 ⇒ 藏起来;模态关闭 ⇒ 恢复。叠放层活在原生层级上,DOM 的 z-index/inert
    // 对它无效,这是唯一能让它给弹窗让位的接缝(main 侧执行面 = setRailPreviewVisible)。
    const offModal = subscribeModalPresence((present) => {
      if (previewId) props.overlayIO.setVisible(previewId, !present)
    })

    const push = () => {
      if (previewId) props.overlayIO.setBounds(previewId, boundsOf())
    }
    const observer = new ResizeObserver(push)
    observer.observe(region)
    window.addEventListener("resize", push)

    const poll = setInterval(() => {
      if (!previewId) return
      void props.overlayIO.status(previewId).then((status) => {
        if (!disposed && status.ok) setBlocked(status.blockedPaths.length)
      })
    }, 1500)

    const offClosed = props.overlayIO.onClosed((event) => {
      if (disposed || !previewId || event.previewId !== previewId) return
      if (event.reason === "crashed") props.state.applyRefusal("read-failed")
    })

    onCleanup(() => {
      disposed = true
      clearInterval(poll)
      offModal()
      offClosed()
      observer.disconnect()
      window.removeEventListener("resize", push)
      if (previewId) props.overlayIO.close(previewId)
      previewId = undefined
    })
  })

  const blockedLabel = () =>
    blocked() >= HTML_PREVIEW_MAX_BLOCKED_ENTRIES
      ? t("alpha.fileViewer.isolationBlockedAtLeast", { count: blocked() })
      : t("alpha.fileViewer.isolationBlocked", { count: blocked() })

  return (
    <div class="a-fv-overlay" data-alpha-fv-overlay={props.phase.overlay}>
      <Show when={props.phase.overlay === "html"}>
        <div class="a-fv-isobar" role="status">
          <span class="a-fv-isodot" aria-hidden="true" />
          {t("alpha.fileViewer.isolationHtml")}
          <Show when={blocked() > 0}> · {blockedLabel()}</Show>
        </div>
      </Show>
      <div class="a-fv-isoregion" ref={region} data-alpha-fv-overlay-region aria-label={t("alpha.fileViewer.overlayRegion")} />
    </div>
  )
}

export function FileViewerView(props: {
  state: FileViewerState
  overlayIO: FileViewerOverlayIO
  /** 面板可见性(切面板即 false;收起右栏/切会话直接卸载)。 */
  active: () => boolean
  onExit: () => void
}) {
  let backButton: HTMLButtonElement | undefined
  onMount(() => backButton?.focus())

  const phase = () => props.state.filePhase()
  const entry = () => props.state.current()

  const onKeyDown = (event: KeyboardEvent) => {
    if (event.key !== "Escape") return
    event.preventDefault()
    props.onExit()
  }

  return (
    <div class="a-fv-root" data-alpha-file-viewer={entry()?.path} onKeyDown={onKeyDown}>
      <header class="a-fv-head">
        <button
          type="button"
          class="a-fv-iconbtn"
          data-alpha-fv-back
          aria-label={t("alpha.fileViewer.back")}
          ref={backButton}
          onClick={() => props.onExit()}
        >
          <BackIcon />
        </button>
        <div class="a-fv-title">
          <span class="a-fv-name">{entry()?.name}</span>
          <Show when={entry()?.dir}>
            <span class="a-fv-dir">{entry()?.dir}</span>
          </Show>
        </div>
        <Show when={phase()?.phase === "text" && (phase() as Extract<ViewerFilePhase, { phase: "text" }>).hasModes}>
          <ModeSegment
            mode={(phase() as Extract<ViewerFilePhase, { phase: "text" }>).mode}
            setMode={(mode) => props.state.setMode(mode)}
          />
        </Show>
        <Show when={phase()?.phase !== "unsafe"}>
          <KebabMenu state={props.state} />
        </Show>
      </header>
      <div class="a-fv-body" aria-live="polite">
        <Switch>
          <Match when={phase()?.phase === "loading"}>
            <div class="a-fv-center" data-alpha-fv-loading role="status">
              <div class="a-fv-prog" aria-hidden="true">
                <i />
              </div>
              <div class="a-fv-progcap">
                {t("alpha.fileViewer.loadingBytes", {
                  read: formatBytes((phase() as Extract<ViewerFilePhase, { phase: "loading" }>).bytesRead),
                })}
              </div>
              <p class="a-fv-card-detail">{t("alpha.fileViewer.loading")}</p>
              <div class="a-fv-actions">
                <button type="button" class="a-fv-btn" data-alpha-fv-cancel onClick={() => props.onExit()}>
                  {t("alpha.fileViewer.cancel")}
                </button>
              </div>
            </div>
          </Match>
          <Match when={phase()?.phase === "text"}>
            <TextContent state={props.state} phase={phase() as Extract<ViewerFilePhase, { phase: "text" }>} />
          </Match>
          <Match when={phase()?.phase === "image"}>
            <ImageContent state={props.state} phase={phase() as Extract<ViewerFilePhase, { phase: "image" }>} />
          </Match>
          <Match when={phase()?.phase === "overlay"}>
            <OverlayRegion
              state={props.state}
              overlayIO={props.overlayIO}
              phase={phase() as Extract<ViewerFilePhase, { phase: "overlay" }>}
              active={props.active}
            />
          </Match>
          <Match when={phase()?.phase === "oversize"}>
            <CenterCard
              tone="warn"
              title={t("alpha.fileViewer.oversizeTitle")}
              detail={t("alpha.fileViewer.oversizeDetail")}
              fact={`${entry()?.name} · ${formatBytes((phase() as Extract<ViewerFilePhase, { phase: "oversize" }>).totalBytes)}`}
            >
              <Show when={(phase() as Extract<ViewerFilePhase, { phase: "oversize" }>).excerptAvailable}>
                <button type="button" class="a-fv-btn" data-variant="primary" data-alpha-fv-excerpt onClick={() => props.state.loadExcerpt()}>
                  {t("alpha.fileViewer.oversizeExcerpt")}
                </button>
              </Show>
              <button type="button" class="a-fv-btn" onClick={() => props.state.openExternal()}>
                {t("alpha.fileViewer.openSystem")}
              </button>
            </CenterCard>
          </Match>
          <Match when={phase()?.phase === "unsafe"}>
            {/* 零动作:不读取,也不给任何转交通道(AC4/AC6;帧 §不安全)。 */}
            <CenterCard
              tone="err"
              title={t("alpha.fileViewer.unsafeTitle")}
              detail={t("alpha.fileViewer.unsafeDetail")}
              fact={entry()?.path}
            />
          </Match>
          <Match when={phase()?.phase === "fail"}>
            <CenterCard
              tone="err"
              title={t("alpha.fileViewer.failTitle")}
              detail={t("alpha.fileViewer.failDetail")}
              fact={(phase() as Extract<ViewerFilePhase, { phase: "fail" }>).code}
            >
              <button type="button" class="a-fv-btn" data-variant="primary" data-alpha-fv-retry onClick={() => props.state.retry()}>
                {t("alpha.fileViewer.retry")}
              </button>
              <button type="button" class="a-fv-btn" onClick={() => props.state.openExternal()}>
                {t("alpha.fileViewer.openSystem")}
              </button>
            </CenterCard>
          </Match>
          <Match when={phase()?.phase === "unsupported"}>
            <CenterCard
              title={t("alpha.fileViewer.unsupportedTitle")}
              detail={
                (phase() as Extract<ViewerFilePhase, { phase: "unsupported" }>).binary
                  ? t("alpha.fileViewer.unsupportedBinary")
                  : t("alpha.fileViewer.unsupportedDetail")
              }
              fact={`${entry()?.name}${(phase() as Extract<ViewerFilePhase, { phase: "unsupported" }>).totalBytes !== null ? ` · ${formatBytes((phase() as Extract<ViewerFilePhase, { phase: "unsupported" }>).totalBytes!)}` : ""}`}
            >
              <button type="button" class="a-fv-btn" onClick={() => props.state.openExternal()}>
                {t("alpha.fileViewer.openSystem")}
              </button>
              <button type="button" class="a-fv-btn" onClick={() => props.state.reveal()}>
                {t("alpha.fileViewer.revealDir")}
              </button>
            </CenterCard>
          </Match>
        </Switch>
      </div>
    </div>
  )
}
