// Renderer 视图层 — REQ-095(#187)。把 registry 的路由结果映射为 Solid 组件。
// 铁律:
//   · 所有文本内容只经 Solid 文本节点呈现(无 innerHTML、无 <iframe>、无动态 <script>);
//   · 字节唯一入口 = window.api.runArtifacts.read(main 侧守卫 + 上限,见 artifact-service);
//   · image 只经 <img> + blob URL(被动解码;切换/卸载即 revoke);
//   · pdf/未知格式 = 诚实卡片(descriptor 事实 + 外部打开),不伪造预览;
//   · html = REQ-096 隔离预览(独立进程 host,零 preload bridge),不满足前置时回落诚实卡片。

import {
  createEffect,
  createResource,
  createSignal,
  For,
  onCleanup,
  onMount,
  Show,
  type Component,
  type JSX,
} from "solid-js"
import type { ArtifactReadRef } from "../../../../preload/types"
import { t } from "../../../i18n"
import type { ArtifactCard } from "../workbench-core"
import { formatBytes, shortSha } from "../workbench-core"
import { JsonNodeView, LinesView, MdBlockView } from "./content-views"
import { parseCsvModel } from "./csv-model"
import { parseJsonModel } from "./json-model"
import { parseMarkdownModel } from "./markdown-model"
import { extensionOf, type RendererId, type RouteDecision } from "./registry"
import {
  type OfficeRejectionCategory,
  type OfficeStructurePresentation,
} from "./office-structure"
import type { OfficeTextExtraction, OfficeTextModel } from "./office-text"
import { ArtifactHtmlPreview, canPreviewHtml } from "../../artifact-html-preview"

export type PreviewContext = {
  directory: string
  runId: string
  readRef: ArtifactReadRef
  name: string
  decision: RouteDecision
  card: ArtifactCard
  officeStructure: OfficeStructurePresentation | null
  // REQ-123(#1175)接线缝:pass 分支的默认内容视图。undefined = 提取通路尚未接线
  // (#1174 的取字节咽喉 + 共享安全解析落地后由调用方装配),呈现为诚实占位。
  officeText?: OfficeTextExtraction
}

export type PreviewProps = { ctx: PreviewContext }

function openExternally(ctx: PreviewContext): void {
  if (!ctx.card.descriptor) return
  void window.api.runArtifacts.openExternal(ctx.directory, ctx.runId, ctx.card.descriptor.id)
}

function revealRunDir(ctx: PreviewContext): void {
  void window.api.openPath(`${ctx.directory}/.code-puppy/runs/${ctx.runId}`)
}

// ---------------------------------------------------------------------------
// 文本装载壳(loading / error / truncated / binary 的统一诚实呈现)
// ---------------------------------------------------------------------------

type TextLoad = { text: string; truncated: boolean; totalBytes: number; readBytes: number; binary: boolean }

function TextShell(props: { ctx: PreviewContext; children: (load: TextLoad) => JSX.Element }) {
  // source 读取 props.ctx(getter)→ 选中 artifact 变化即重取;同 renderer 复用挂载也不串内容。
  const [res] = createResource(
    () => ({ dir: props.ctx.directory, run: props.ctx.runId, ref: props.ctx.readRef }),
    async (k) => {
      const r = await window.api.runArtifacts.read(k.dir, k.run, k.ref, { mode: "text" })
      if (!r.ok) throw new Error(r.reason)
      if (r.kind !== "text") throw new Error("unexpected read kind")
      return { text: r.text, truncated: r.truncated, totalBytes: r.totalBytes, readBytes: r.readBytes, binary: r.binary }
    },
  )
  return (
    <Show
      when={!res.error}
      fallback={
        <div class="a-wb-notice" data-kind="error" role="alert">
          {t("alpha.wb.readFailed")}:{String((res.error as Error)?.message ?? res.error)}
        </div>
      }
    >
      <Show when={res()} fallback={<div class="a-wb-notice">{t("alpha.wb.loading")}</div>}>
        {(load) => (
          <>
            <Show when={load().binary}>
              <div class="a-wb-notice" data-kind="warn">{t("alpha.wb.binaryHint")}</div>
            </Show>
            <Show when={load().truncated}>
              <div class="a-wb-notice" data-kind="warn">
                {t("alpha.wb.truncated", { shown: formatBytes(load().readBytes), total: formatBytes(load().totalBytes) })}
              </div>
            </Show>
            {props.children(load())}
          </>
        )}
      </Show>
    </Show>
  )
}

// ---------------------------------------------------------------------------
// text / code
// ---------------------------------------------------------------------------

const TextView: Component<PreviewProps> = (props) => (
  <TextShell ctx={props.ctx}>{(load) => <LinesView text={load.text} lang={null} />}</TextShell>
)

const CodeView: Component<PreviewProps> = (props) => (
  <TextShell ctx={props.ctx}>{(load) => <LinesView text={load.text} lang={extensionOf(props.ctx.name)} />}</TextShell>
)

// ---------------------------------------------------------------------------
// markdown(净化模型 → Solid 节点;无 HTML 注入路径)
// ---------------------------------------------------------------------------

const MarkdownView: Component<PreviewProps> = (props) => (
  <TextShell ctx={props.ctx}>
    {(load) => {
      const model = parseMarkdownModel(load.text)
      return (
        <div class="a-wb-md">
          <Show when={model.truncated}>
            <div class="a-wb-notice" data-kind="warn">{t("alpha.wb.mdTruncated", { count: model.blockCount })}</div>
          </Show>
          <MdBlockView blocks={model.blocks} />
        </div>
      )
    }}
  </TextShell>
)

// ---------------------------------------------------------------------------
// json
// ---------------------------------------------------------------------------

const JsonView: Component<PreviewProps> = (props) => (
  <TextShell ctx={props.ctx}>
    {(load) => {
      const model = parseJsonModel(load.text)
      if (!model.ok)
        return (
          <>
            <div class="a-wb-notice" data-kind="error">{t("alpha.wb.jsonInvalid", { error: model.error })}</div>
            <LinesView text={load.text} lang="json" />
          </>
        )
      return (
        <div class="a-wb-json">
          <div class="a-wb-toolbar">
            <button
              type="button"
              class="a-wb-btn"
              onClick={() => void window.api.writeClipboard(load.text)}
            >
              {t("alpha.wb.copy")}
            </button>
            <Show when={model.truncated}>
              <span class="a-wb-chip" data-kind="warn">{t("alpha.wb.jsonNodesCut")}</span>
            </Show>
          </div>
          <JsonNodeView node={model.root} depth={0} />
        </div>
      )
    }}
  </TextShell>
)

// ---------------------------------------------------------------------------
// csv / tsv
// ---------------------------------------------------------------------------

const CsvView: Component<PreviewProps> = (props) => (
  <TextShell ctx={props.ctx}>
    {(load) => {
      const forceTab = props.ctx.decision.effectiveMime === "text/tab-separated-values"
      const model = parseCsvModel(load.text, { delimiter: forceTab ? "\t" : "auto" })
      return (
        <div class="a-wb-csv">
          <Show when={model.truncatedRows || load.truncated}>
            <div class="a-wb-notice" data-kind="warn">
              {t("alpha.wb.csvTruncated", { shown: model.rowCount })}
            </div>
          </Show>
          <div class="a-wb-tablewrap" tabIndex={0}>
            <table>
              <thead>
                <tr><For each={model.header}>{(cell) => <th>{cell}</th>}</For></tr>
              </thead>
              <tbody>
                {/* 单元格 = 纯文本节点:公式字符串(=CMD 等)只展示、不执行、不成为链接(REQ-095 AC#4) */}
                <For each={model.rows}>{(row) => <tr><For each={row}>{(cell) => <td>{cell}</td>}</For></tr>}</For>
              </tbody>
            </table>
          </div>
        </div>
      )
    }}
  </TextShell>
)

// ---------------------------------------------------------------------------
// image(bytes → blob URL,被动解码;卸载即 revoke)
// ---------------------------------------------------------------------------

const ImageView: Component<PreviewProps> = (props) => {
  let url: string | null = null
  const revoke = () => {
    if (url) URL.revokeObjectURL(url)
    url = null
  }
  onCleanup(revoke) // 切换 artifact / 卸载即释放(REQ-095 资源释放协议)
  const [res] = createResource(
    () => ({ dir: props.ctx.directory, run: props.ctx.runId, ref: props.ctx.readRef, mime: props.ctx.decision.effectiveMime }),
    async (k) => {
      const r = await window.api.runArtifacts.read(k.dir, k.run, k.ref, { mode: "bytes" })
      if (!r.ok) throw new Error(r.reason)
      if (r.kind !== "bytes") throw new Error("unexpected read kind")
      revoke()
      const blob = new Blob([r.bytes as Uint8Array<ArrayBuffer>], { type: k.mime ?? "application/octet-stream" })
      url = URL.createObjectURL(blob)
      return { url, bytes: r.totalBytes }
    },
  )
  const [decodeError, setDecodeError] = createSignal(false)
  return (
    <Show
      when={!res.error}
      fallback={
        <div class="a-wb-notice" data-kind="error" role="alert">
          {t("alpha.wb.readFailed")}:{String((res.error as Error)?.message ?? res.error)}
          <Show when={props.ctx.card.descriptor && props.ctx.decision.externalOpen === "allowed"}>
            <button type="button" class="a-wb-btn" onClick={() => openExternally(props.ctx)}>{t("alpha.wb.openExternal")}</button>
          </Show>
        </div>
      }
    >
      <Show when={res()} fallback={<div class="a-wb-notice">{t("alpha.wb.loading")}</div>}>
        {(img) => (
          <Show
            when={!decodeError()}
            fallback={
              <div class="a-wb-notice" data-kind="error" role="alert">
                {t("alpha.wb.imgDecodeFailed")}
                <Show when={props.ctx.card.descriptor && props.ctx.decision.externalOpen === "allowed"}>
                  <button type="button" class="a-wb-btn" onClick={() => openExternally(props.ctx)}>{t("alpha.wb.openExternal")}</button>
                </Show>
              </div>
            }
          >
            <figure class="a-wb-image">
              <img src={img().url} alt={props.ctx.name} onError={() => setDecodeError(true)} />
              <figcaption>{props.ctx.name} · {formatBytes(img().bytes)}</figcaption>
            </figure>
          </Show>
        )}
      </Show>
    </Show>
  )
}

// ---------------------------------------------------------------------------
// 诚实卡片:pdf / html(REQ-096 接线点)/ fallback
// ---------------------------------------------------------------------------

function FactRow(props: { label: string; value: string }) {
  return (
    <div class="a-wb-fact">
      <span class="a-wb-fact-k">{props.label}</span>
      <span class="a-wb-fact-v" title={props.value}>{props.value}</span>
    </div>
  )
}

function HonestCard(props: PreviewProps & { title: string; note: string }) {
  const d = props.ctx.card.descriptor
  return (
    <div class="a-wb-fallback" role="group" aria-label={props.title}>
      <b>{props.title}</b>
      <p>{props.note}</p>
      <FactRow label={t("alpha.wb.factName")} value={props.ctx.name} />
      <FactRow label={t("alpha.wb.factSize")} value={formatBytes(props.ctx.card.bytes)} />
      <FactRow label={t("alpha.wb.factState")} value={props.ctx.card.state} />
      <Show when={d}>
        <FactRow label="MIME" value={`${d!.claimedMime ?? "—"} / ${d!.detectedMime ?? "—"}`} />
        <FactRow label="sha256" value={shortSha(d!.sha256)} />
        <FactRow label={t("alpha.wb.factTrust")} value={`${d!.trust} · ${d!.role}`} />
      </Show>
      <Show when={props.ctx.decision.ooxmlSubtype}>
        <FactRow label="OOXML" value={`${props.ctx.decision.ooxmlSubtype} · ${props.ctx.decision.effectiveMime}`} />
      </Show>
      <div class="a-wb-toolbar">
        <Show when={props.ctx.card.savedPath && props.ctx.card.descriptor && props.ctx.decision.externalOpen === "allowed"}>
          <button type="button" class="a-wb-btn" data-variant="primary" onClick={() => openExternally(props.ctx)}>
            {t("alpha.wb.openExternal")}
          </button>
        </Show>
        <button type="button" class="a-wb-btn" onClick={() => revealRunDir(props.ctx)}>{t("alpha.wb.revealDir")}</button>
        <Show when={d?.sha256}>
          <button type="button" class="a-wb-btn" onClick={() => void window.api.writeClipboard(d!.sha256!)}>
            {t("alpha.wb.copySha")}
          </button>
        </Show>
      </div>
    </div>
  )
}

const OFFICE_REJECTION_KEYS = {
  "invalid-document": "alpha.wb.office.rejection.invalid",
  encrypted: "alpha.wb.office.rejection.encrypted",
  "safety-limit": "alpha.wb.office.rejection.limit",
  "unsafe-path": "alpha.wb.office.rejection.path",
  "incomplete-structure": "alpha.wb.office.rejection.incomplete",
  "type-mismatch": "alpha.wb.office.rejection.type",
} as const satisfies Record<OfficeRejectionCategory, Parameters<typeof t>[0]>

// REQ-123(#1175)AC1/AC3/AC6:提取文本内容视图 —— pass 分支的默认呈现。
// 一切文本只经 Solid 文本节点(基线 ③ 类 3/5:纯数据文本,无 innerHTML 注入路径);
// 保真声明明写排版不保真(AC6);pptx 按权威页序分页呈现,备注独立成块。
const OfficeTextContent: Component<{ model: OfficeTextModel }> = (props) => {
  const nonEmpty = (lines: string[]) => lines.filter((line) => line.trim().length > 0)
  return (
    <div class="a-wb-office-content" data-office-content aria-label={t("alpha.wb.office.contentTitle")}>
      <p class="a-wb-office-fidelity" data-office-fidelity>{t("alpha.wb.office.fidelityNote")}</p>
      <Show when={props.model.kind === "docx" ? props.model : undefined} keyed>
        {(docx) => (
          <For each={nonEmpty(docx.paragraphs)}>
            {(paragraph) => <p class="a-wb-office-para">{paragraph}</p>}
          </For>
        )}
      </Show>
      <Show when={props.model.kind === "pptx" ? props.model : undefined} keyed>
        {(pptx) => (
          <For each={pptx.slides}>
            {(slide, index) => (
              <section class="a-wb-office-slide" data-office-slide={index() + 1}>
                <h4 class="a-wb-office-slide-h">{t("alpha.wb.office.slideLabel", { n: index() + 1 })}</h4>
                <For each={nonEmpty(slide.paragraphs)}>
                  {(paragraph) => <p class="a-wb-office-para">{paragraph}</p>}
                </For>
                <Show when={nonEmpty(slide.notes).length > 0}>
                  <div class="a-wb-office-notes" data-office-notes>
                    <b>{t("alpha.wb.office.notesLabel")}</b>
                    <For each={nonEmpty(slide.notes)}>
                      {(note) => <p class="a-wb-office-para">{note}</p>}
                    </For>
                  </div>
                </Show>
              </section>
            )}
          </For>
        )}
      </Show>
    </div>
  )
}

export const OfficeArtifactView: Component<PreviewProps> = (props) => {
  const [quickLookFailure, setQuickLookFailure] = createSignal<string | null>(null)
  const [quickLookBusy, setQuickLookBusy] = createSignal(false)
  const [externalOpenRefused, setExternalOpenRefused] = createSignal(false)
  let quickLookButton: HTMLButtonElement | undefined
  const rejection = () =>
    props.ctx.officeStructure?.status === "rejected" ? props.ctx.officeStructure : undefined
  // REQ-123 IA(基线 ②-5):提取内容视图是 pass 分支的默认呈现,Quick Look 降为次级动作。
  const extractedModel = () => {
    const extraction = props.ctx.officeText
    return extraction?.status === "extracted" ? extraction.model : undefined
  }
  const extractionFailure = () => {
    const extraction = props.ctx.officeText
    return extraction?.status === "failed" ? extraction : undefined
  }

  createEffect(() => {
    props.ctx.card.key
    setQuickLookFailure(null)
    setQuickLookBusy(false)
    setExternalOpenRefused(false)
  })

  const quickLook = () => {
    if (
      props.ctx.officeStructure?.status !== "pass" ||
      !props.ctx.card.descriptor ||
      quickLookBusy()
    )
      return
    quickLookButton?.focus()
    setQuickLookBusy(true)
    void window.api.runArtifacts
      .quickLook({
        directory: props.ctx.directory,
        runId: props.ctx.runId,
        artifactId: props.ctx.card.descriptor.id,
      })
      .then((result) => setQuickLookFailure(result.ok ? null : result.code))
      .catch(() => setQuickLookFailure("PREVIEW_UNAVAILABLE"))
      .finally(() => setQuickLookBusy(false))
  }

  const externalOpen = () => {
    if (!props.ctx.card.descriptor) return
    void window.api.runArtifacts
      .openExternal(props.ctx.directory, props.ctx.runId, props.ctx.card.descriptor.id)
      .then((result) => setExternalOpenRefused(!result.ok))
      .catch(() => setExternalOpenRefused(true))
  }

  onMount(() => {
    const onSpace = (event: KeyboardEvent) => {
      if (
        event.key !== " " ||
        event.defaultPrevented ||
        event.repeat ||
        event.metaKey ||
        event.ctrlKey ||
        event.altKey ||
        event.shiftKey ||
        props.ctx.officeStructure?.status !== "pass" ||
        !props.ctx.card.descriptor ||
        quickLookBusy()
      )
        return
      const target = event.target
      if (
        target instanceof HTMLInputElement ||
        target instanceof HTMLTextAreaElement ||
        target instanceof HTMLSelectElement ||
        (target instanceof HTMLElement && target.isContentEditable)
      )
        return
      if (
        target instanceof HTMLButtonElement &&
        target !== quickLookButton &&
        !target.classList.contains("alpha-wb-card-main")
      )
        return
      if (target === quickLookButton) return
      event.preventDefault()
      quickLook()
    }
    document.addEventListener("keydown", onSpace)
    onCleanup(() => document.removeEventListener("keydown", onSpace))
  })

  return (
    <div class="a-wb-office" data-office-status={props.ctx.officeStructure?.status}>
      <Show when={props.ctx.officeStructure?.status === "checking"}>
        <div class="a-wb-office-status" role="status">
          <span class="a-wb-chip">
            <span class="a-wb-spinner" aria-hidden="true" />
            {t("alpha.wb.office.status.checking")}
          </span>
          <div>
            <b>{t("alpha.wb.office.checkingTitle")}</b>
            <p>{t("alpha.wb.office.checkingDetail")}</p>
          </div>
        </div>
        <div class="a-wb-fallback">
          <b>{t("alpha.wb.office.documentTitle")}</b>
          <p>{t("alpha.wb.office.checkingNote")}</p>
          <FactRow label={t("alpha.wb.factName")} value={props.ctx.name} />
          <FactRow label={t("alpha.wb.factSize")} value={formatBytes(props.ctx.card.bytes)} />
          <div class="a-wb-toolbar a-wb-office-actions">
            <button
              type="button"
              class="a-wb-btn"
              disabled
              title={t("alpha.wb.office.openPending")}
            >
              {t("alpha.wb.openExternal")}
            </button>
            <button type="button" class="a-wb-btn" onClick={() => revealRunDir(props.ctx)}>
              {t("alpha.wb.revealDir")}
            </button>
          </div>
        </div>
      </Show>

      <Show when={props.ctx.officeStructure?.status === "rejected"}>
        <div class="a-wb-office-status" data-kind="error" role="alert">
          <span class="a-wb-chip" data-kind="error">{t("alpha.wb.office.status.rejected")}</span>
          <div>
            <b>{t("alpha.wb.office.rejectedTitle")}</b>
            <p>
              {t("alpha.wb.office.rejectedDetail", {
                reason: t(OFFICE_REJECTION_KEYS[rejection()!.category]),
              })}
            </p>
          </div>
        </div>
        <div class="a-wb-fallback" data-rejection-category={rejection()!.category}>
          <b>{t("alpha.wb.office.structureFailed")}</b>
          <FactRow label={t("alpha.wb.factName")} value={props.ctx.name} />
          <FactRow
            label={t("alpha.wb.office.reason")}
            value={t(OFFICE_REJECTION_KEYS[rejection()!.category])}
          />
          <div class="a-wb-office-diagnostic">
            <span>{t("alpha.wb.office.diagnostic")}</span>
            <code>
              {rejection()!.code}
            </code>
          </div>
          <p>{t("alpha.wb.office.nextStep")}</p>
          <div class="a-wb-toolbar a-wb-office-actions">
            <Show when={props.ctx.card.descriptor}>
              <button type="button" class="a-wb-btn" data-office-action="external-open" onClick={externalOpen}>
                {t("alpha.wb.openExternal")}
              </button>
            </Show>
            <button type="button" class="a-wb-btn" data-office-action="reveal-run" onClick={() => revealRunDir(props.ctx)}>
              {t("alpha.wb.revealDir")}
            </button>
            <button
              type="button"
              class="a-wb-btn"
              onClick={() => void window.api.writeClipboard(rejection()!.code)}
            >
              {t("alpha.wb.office.copyDiagnostic")}
            </button>
          </div>
        </div>
      </Show>

      <Show when={props.ctx.officeStructure?.status === "pass"}>
        <div class="a-wb-office-status" data-kind="success" role="status">
          <span class="a-wb-chip" data-kind="success">{t("alpha.wb.office.status.pass")}</span>
          <div>
            <b>{t("alpha.wb.office.passTitle")}</b>
            <p>{t("alpha.wb.office.passDetail")}</p>
          </div>
        </div>
        <Show when={quickLookFailure()}>
          {(code) => (
            <div class="a-wb-notice a-wb-office-channel-notice" data-kind="warn" role="status">
              <b>{t("alpha.wb.office.quickLookUnavailable")}</b>
              <span>{t("alpha.wb.office.quickLookUnavailableDetail")}</span>
              <code>{code()}</code>
            </div>
          )}
        </Show>
        <Show
          when={extractedModel()}
          keyed
          fallback={
            <Show
              when={extractionFailure()}
              keyed
              fallback={
                <div
                  class="a-wb-office-placeholder"
                  role="img"
                  aria-label={t("alpha.wb.office.contentAria")}
                >
                  <b>{t("alpha.wb.office.contentTitle")}</b>
                  <span>{t("alpha.wb.office.contentNote")}</span>
                </div>
              }
            >
              {(failure) => (
                // 提取失败 = 诚实降级卡(基线 ③ 类 6):不空白、不伪造;原件与其余动作不受影响。
                <div class="a-wb-notice a-wb-office-extract-failed" data-kind="warn" role="status" data-office-extract-failed>
                  <b>{t("alpha.wb.office.extractFailed")}</b>
                  <span>{t("alpha.wb.office.extractFailedDetail")}</span>
                  <code>{failure.code}</code>
                </div>
              )}
            </Show>
          }
        >
          {(model) => <OfficeTextContent model={model} />}
        </Show>
        <div class="a-wb-toolbar a-wb-office-actions">
          <Show when={props.ctx.card.descriptor}>
            <button
              ref={quickLookButton}
              type="button"
              class="a-wb-btn"
              data-office-action="quick-look"
              disabled={quickLookBusy()}
              onClick={quickLook}
            >
              {quickLookBusy()
                ? quickLookFailure()
                  ? t("alpha.wb.office.quickLookRetrying")
                  : t("alpha.wb.office.quickLookOpening")
                : quickLookFailure()
                  ? t("alpha.wb.office.quickLookRetry")
                  : t("alpha.wb.office.quickLook")}
              <span class="a-wb-kbd" aria-hidden="true">{t("alpha.wb.office.space")}</span>
            </button>
          </Show>
          <Show when={props.ctx.card.descriptor}>
            <button type="button" class="a-wb-btn" data-office-action="external-open" onClick={externalOpen}>
              {t("alpha.wb.openExternal")}
            </button>
          </Show>
          <button type="button" class="a-wb-btn" data-office-action="reveal-run" onClick={() => revealRunDir(props.ctx)}>
            {t("alpha.wb.revealDir")}
          </button>
        </div>
        <Show when={props.ctx.card.descriptor}>
          <div class="a-wb-office-origin">
            <span>{t("alpha.wb.office.source")}</span>
            <FactRow
              label={t("alpha.wb.office.producedBy")}
              value={props.ctx.card.descriptor!.provenance.jobId}
            />
            <FactRow
              label={t("alpha.wb.office.structureCheck")}
              value={t("alpha.wb.office.structurePassLocal")}
            />
          </div>
        </Show>
      </Show>

      <Show when={externalOpenRefused()}>
        <div class="a-wb-notice" data-kind="warn" role="status">
          {t("alpha.wb.office.externalOpenRefused")}
        </div>
      </Show>
    </div>
  )
}

const PdfCard: Component<PreviewProps> = (props) => (
  // 诚实降级:未 ship PDF.js 隔离 worker 前不伪造内置查看器(REQ-095 非目标纪律)。
  <HonestCard ctx={props.ctx} title={t("alpha.wb.pdfTitle")} note={t("alpha.wb.pdfNote")} />
)

const HtmlCard: Component<PreviewProps> = (props) => (
  // REQ-096 已接线:隔离 HTML 预览(独立进程 host,main 按 manifest 解析路径,零 preload bridge)。
  // 仅盘上有完整 manifest 登记且非 mismatch/missing 时可预览;其余状态保持诚实卡片。
  <Show
    when={
      props.ctx.card.descriptor &&
      props.ctx.card.savedPath &&
      canPreviewHtml(props.ctx.card.descriptor) &&
      (props.ctx.card.state === "verified" || props.ctx.card.state === "unverified")
    }
    fallback={<HonestCard ctx={props.ctx} title={t("alpha.wb.htmlTitle")} note={t("alpha.wb.htmlNote")} />}
  >
    <ArtifactHtmlPreview
      directory={props.ctx.directory}
      runId={props.ctx.runId}
      descriptor={props.ctx.card.descriptor!}
      savedPath={props.ctx.card.savedPath!}
    />
  </Show>
)

const FallbackCard: Component<PreviewProps> = (props) => (
  <Show
    when={props.ctx.officeStructure}
    fallback={<HonestCard ctx={props.ctx} title={t("alpha.wb.fallbackTitle")} note={t("alpha.wb.fallbackNote")} />}
  >
    <OfficeArtifactView ctx={props.ctx} />
  </Show>
)

// ---------------------------------------------------------------------------
// 组件表(registry 的 id → 视图;REQ-096 只需替换 "html" 一格)
// ---------------------------------------------------------------------------

export const RENDERER_COMPONENTS: Record<RendererId, Component<PreviewProps>> = {
  markdown: MarkdownView,
  code: CodeView,
  text: TextView,
  json: JsonView,
  csv: CsvView,
  image: ImageView,
  pdf: PdfCard,
  html: HtmlCard,
  fallback: FallbackCard,
}

/** Source 视图(Preview/Source/Metadata 三模式之一):任何 artifact 都可看原文(有界)。 */
export const SourceView: Component<PreviewProps> = (props) => (
  <TextShell ctx={props.ctx}>{(load) => <LinesView text={load.text} lang={extensionOf(props.ctx.name)} />}</TextShell>
)

export { openExternally, revealRunDir }
