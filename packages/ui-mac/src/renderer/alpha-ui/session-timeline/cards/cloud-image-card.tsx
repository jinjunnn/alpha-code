// REQ-236 `#1552` — 对话里的生图卡(批准稿 docs/design/2026-10-30-req236-image-card/frame.html;方案 §2.4)。
//
// 状态只由事实驱动(timeline-model.ts cloudImageViewOf):这次派发调用的 part、宿主 tracker 的
// `cloud-run-state`(#1551 冻结面,只消费)、本机核验(manifest + sha256 复核)。模型说的话不参与。
// 挂载即取快照并续订:先 `getRunState`;宿主没跟过(重载 / 重启后)就先看本机 —— 已核验的直接出图、
// 不再联网(不重弹系统通知、不碰产物顺序);本机没有才 `trackRun`(不带归属 —— 归属只在 watcher 看到受理帧时写)。
// 出图复用产物预览的图片渲染器(RENDERER_COMPONENTS.image:<img> + blob,卸载即 revoke,SVG 不内联)。
// 点图 / 「查看大图」= 既有 focusArtifact(右栏产物面板);「保存到…」先复核 sha256 再弹保存对话框(main 侧);
// 不新增路由、覆盖层或窗口。
import { createEffect, createMemo, createSignal, on, onCleanup, Show } from "solid-js"
import type { CloudRunState, ManifestArtifactEntry } from "../../../../preload/types"
import { t } from "../../../i18n"
import { routeArtifact } from "../../artifact-workbench/renderers/registry"
import { RENDERER_COMPONENTS } from "../../artifact-workbench/renderers/renderer-views"
import { formatTurnElapsed, cloudImageViewOf, type CloudImageView, type TimelineRow } from "../timeline-model"
import { useTimelineIntents } from "./timeline-intents"

type CloudImageRow = Extract<TimelineRow, { kind: "cloudImage" }>
type LocalImage = { entry: ManifestArtifactEntry }
type SaveReceipt = { kind: "ok"; folder: string; name: string } | { kind: "mismatch" } | { kind: "write" }

const ALT_MAX_CHARS = 80

/** 本机这次 run 的产物:全部条目都是 verified(verify = true 时先逐件全量复核)才算数;返回其中的图片条目。 */
async function localImageOf(directory: string, runId: string, verify: boolean): Promise<LocalImage | null> {
  const list = await window.api.runArtifacts.list(directory, runId)
  if (!list.ok || list.entries.length === 0) return null
  for (const entry of list.entries) {
    const state = verify
      ? await window.api.runArtifacts.verify(directory, runId, entry.descriptor.id).then((r) => (r.ok ? r.entry.local.state : undefined))
      : entry.local.state
    if (state !== "verified") return null
  }
  const image = list.entries.find(
    (entry) =>
      routeArtifact({
        name: entry.local.savedPath,
        claimedMime: entry.descriptor.claimedMime,
        detectedMime: entry.local.detectedMime ?? entry.descriptor.detectedMime,
      }).rendererId === "image",
  )
  return image ? { entry: image } : null
}

function stateTone(view: CloudImageView): "live" | "hollow" | "spin" | "warn" | "err" | "none" {
  switch (view.state) {
    case "submitting":
    case "saving":
      return "spin"
    case "queued":
      return "hollow"
    case "running":
      return "live"
    case "refused":
      return view.refusal === "network" || view.refusal === "other" ? "err" : "warn"
    case "failed":
      return view.reason === "safety" ? "warn" : "err"
    case "undelivered":
      return "err"
    default:
      return "none"
  }
}

function noticeOf(view: CloudImageView): { title: string; body?: string; tone: "warn" | "err" | "neutral" } | undefined {
  if (view.state === "refused")
    return {
      title: t(`alpha.timeline.image.refused.${view.refusal}.title`),
      body: t(`alpha.timeline.image.refused.${view.refusal}.body`),
      tone: view.refusal === "network" || view.refusal === "other" ? "err" : "warn",
    }
  if (view.state === "failed")
    return {
      title: t(`alpha.timeline.image.failed.${view.reason}.title`),
      body: t(`alpha.timeline.image.failed.${view.reason}.body`),
      tone: view.reason === "safety" ? "warn" : "err",
    }
  if (view.state === "cancelled") return { title: t("alpha.timeline.image.cancelled.title"), tone: "neutral" }
  if (view.state === "undelivered")
    return {
      title: t(`alpha.timeline.image.undelivered.${view.reason}.title`),
      body: t(`alpha.timeline.image.undelivered.${view.reason}.body`),
      tone: "err",
    }
  return undefined
}

export function CloudImageCard(props: { row: CloudImageRow }) {
  const intents = useTimelineIntents()
  const image = () => props.row.image
  const runId = () => {
    const call = image().call
    return call.phase === "accepted" ? call.runId : undefined
  }
  const [run, setRun] = createSignal<CloudRunState | null>(null)
  const [local, setLocal] = createSignal<LocalImage | null>(null)
  const [retrying, setRetrying] = createSignal(false)
  const [receipt, setReceipt] = createSignal<SaveReceipt | null>(null)
  const [detailsOpen, setDetailsOpen] = createSignal(false)
  const [promptOpen, setPromptOpen] = createSignal(false)
  const [promptClamped, setPromptClamped] = createSignal(false)
  const [pixels, setPixels] = createSignal<{ width: number; height: number } | null>(null)
  const [now, setNow] = createSignal(Date.now())

  // 挂载即取快照并续订(AC7);run 身份只在受理后出现,之后不变。
  createEffect(
    on(runId, (id) => {
      const directory = intents.cloudDirectory
      if (!id || !directory) return
      let alive = true
      const off = window.api.cloud.onRunState((state) => {
        if (state.directory !== directory || state.runId !== id) return
        setRun(state)
        setRetrying(false)
      })
      onCleanup(() => {
        alive = false
        off()
      })
      void (async () => {
        const snapshot = await window.api.cloud.getRunState(directory, id)
        if (!alive) return
        if (snapshot) {
          setRun((current) => current ?? snapshot)
          return
        }
        const found = await localImageOf(directory, id, true).catch(() => null)
        if (!alive) return
        if (found) {
          setLocal(found)
          return
        }
        void window.api.cloud.trackRun(directory, id)
      })()
    }),
  )
  // tracker 判 saved(含面板手动下载成功后的 reverify 广播,AC6)⇒ 读本机已核验的图片条目。
  createEffect(
    on(
      () => run()?.delivery.status === "saved" && run()?.job.status !== "failed",
      (saved) => {
        const directory = intents.cloudDirectory
        const id = runId()
        if (!saved || !directory || !id || local()) return
        void localImageOf(directory, id, false)
          .then((found) => found && setLocal(found))
          .catch(() => {})
      },
    ),
  )

  const view = createMemo(() => cloudImageViewOf(image().call, run(), local() !== null))
  const ticking = () => view().state === "queued" || view().state === "running"
  createEffect(() => {
    if (!ticking()) return
    setNow(Date.now())
    const timer = setInterval(() => setNow(Date.now()), 1000)
    onCleanup(() => clearInterval(timer))
  })
  const elapsed = () => {
    const current = view()
    const since = current.state === "queued" || current.state === "running" ? current.since : undefined
    return since === undefined ? undefined : formatTurnElapsed(now() - since)
  }
  const notice = () => noticeOf(view())
  const billing = () => {
    const current = view()
    return current.state === "refused" && current.billing
  }
  const retryable = () => {
    const current = view()
    return current.state === "undelivered" && current.retryable
  }
  const alt = () => image().prompt.slice(0, ALT_MAX_CHARS)
  const focus = () => {
    const found = local()
    const id = runId()
    if (!found || !id) return
    intents.focusArtifact?.({ name: found.entry.descriptor.name, id: found.entry.descriptor.id, runId: id })
  }
  const saveCopy = () => {
    const found = local()
    const id = runId()
    const directory = intents.cloudDirectory
    if (!found || !id || !directory) return
    void window.api.runArtifacts.saveCopy(directory, id, found.entry.descriptor.id).then((result) => {
      if (result.ok) {
        if (!result.canceled) setReceipt({ kind: "ok", folder: result.folder, name: result.name })
        else setReceipt(null)
        return
      }
      setReceipt({ kind: result.code === "verify-failed" ? "mismatch" : "write" })
    })
  }
  const openPreview = () => {
    const found = local()
    const id = runId()
    const directory = intents.cloudDirectory
    if (!found || !id || !directory) return
    void window.api.runArtifacts.openExternal(directory, id, found.entry.descriptor.id)
  }
  const retry = () => {
    const id = runId()
    const directory = intents.cloudDirectory
    if (!id || !directory || retrying()) return
    setRetrying(true)
    setReceipt(null)
    setLocal(null)
    void window.api.cloud.retry(directory, id)
  }
  const previewCtx = createMemo(() => {
    const found = local()
    const id = runId()
    const directory = intents.cloudDirectory
    if (!found || !id || !directory) return null
    const entry = found.entry
    const claim = {
      name: entry.local.savedPath,
      claimedMime: entry.descriptor.claimedMime,
      detectedMime: entry.local.detectedMime ?? entry.descriptor.detectedMime,
    }
    return {
      directory,
      runId: id,
      readRef: { artifactId: entry.descriptor.id },
      name: alt(),
      decision: routeArtifact(claim),
      card: {
        key: entry.descriptor.id,
        name: entry.descriptor.name,
        state: entry.local.state,
        bytes: entry.local.bytesOnDisk,
        savedPath: entry.local.savedPath,
        descriptor: entry.descriptor,
        claimedMime: claim.claimedMime,
        detectedMime: claim.detectedMime,
        warnings: [],
        downloadable: false,
      },
      officeStructure: null,
    }
  })
  const ImageRenderer = RENDERER_COMPONENTS.image
  const shown = () => view().state === "saved" && previewCtx() !== null
  const media = () => {
    const state = view().state
    return state !== "refused" && state !== "failed" && state !== "cancelled"
  }
  const devText = () => {
    const call = image().call
    const lines = [
      "tool    codepuppy:dispatch",
      "kind    image-generation",
      `input   ${JSON.stringify({ prompt: image().prompt })}`,
    ]
    if (call.phase === "accepted") lines.push(`job     ${call.runId}`)
    if (call.phase === "refused" && call.error) lines.push(`error   ${call.error}`)
    const found = local()
    if (found) lines.push(`artifact ${found.entry.descriptor.id}`)
    const failure = run()?.delivery.failure
    if (failure) lines.push(`delivery ${failure.scope} ${failure.code}`)
    const code = run()?.job.code
    if (code) lines.push(`code    ${code}`)
    return lines.join("\n")
  }
  const stateLabel = () => {
    const state = view().state
    return state === "saved" ? undefined : t(`alpha.timeline.image.state.${state}`)
  }

  return (
    <section class="a-ig-card" role="region" aria-label={t("alpha.timeline.image.title")} data-cloud-image={view().state}>
      <div class="a-ig-head">
        <svg viewBox="0 0 24 24" aria-hidden="true" class="a-ig-head-ic">
          <rect x="3" y="3" width="18" height="18" rx="2" />
          <circle cx="8.5" cy="8.5" r="1.5" />
          <path d="M21 15l-5-5L5 21" />
        </svg>
        <span class="a-ig-title">{t("alpha.timeline.image.title")}</span>
        <span class="a-ig-state" aria-live="polite" data-cloud-image-state>
          <Show when={stateLabel()} fallback={<span class="a-ig-sr">{t("alpha.timeline.image.done")}</span>}>
            {(label) => (
              <>
                <Show when={stateTone(view()) === "spin"} fallback={<span class="a-ig-dot" data-tone={stateTone(view())} />}>
                  <span class="a-ig-spin" aria-hidden="true" />
                </Show>
                {label()}
              </>
            )}
          </Show>
          <Show when={elapsed()}>
            {(text) => (
              <span class="a-ig-tm" aria-hidden="true" data-cloud-image-elapsed>
                {text()}
              </span>
            )}
          </Show>
        </span>
      </div>
      <Show when={media()}>
        <div
          class="a-ig-media"
          data-variant={
            view().state === "queued"
              ? "dashed"
              : view().state === "running" || view().state === "saving"
                ? "shimmer"
                : view().state === "undelivered"
                  ? "cloud"
                  : undefined
          }
        >
          <Show
            when={shown()}
            fallback={
              <div class="a-ig-tray">
                <Show when={view().state === "submitting"}>
                  <span>{t("alpha.timeline.image.tray.submitting")}</span>
                </Show>
                <Show when={view().state === "queued"}>
                  <span>{t("alpha.timeline.image.tray.queued")}</span>
                </Show>
                <Show when={view().state === "saving"}>
                  <span>{t("alpha.timeline.image.tray.saving")}</span>
                </Show>
                <Show when={view().state === "undelivered"}>
                  <span>{t("alpha.timeline.image.tray.undelivered")}</span>
                </Show>
              </div>
            }
          >
            {/* div[role=button]:渲染器失败时自带「用预览打开」按钮,不能嵌进 <button>。 */}
            <div
              class="a-ig-pic"
              role="button"
              tabIndex={0}
              aria-label={t("alpha.timeline.image.viewOf", { alt: alt() })}
              data-cloud-image-pic
              onClick={focus}
              onKeyDown={(event) => {
                if (event.target !== event.currentTarget || (event.key !== "Enter" && event.key !== " ")) return
                event.preventDefault()
                focus()
              }}
              ref={(el) => {
                // load 不冒泡:在捕获阶段拿渲染器里那张 <img> 的实际像素(owner 10-30:图片下方只写像素)。
                const onLoad = (event: Event) => {
                  const target = event.target as HTMLImageElement | null
                  if (target && target.naturalWidth > 0)
                    setPixels({ width: target.naturalWidth, height: target.naturalHeight })
                }
                el.addEventListener("load", onLoad, true)
                onCleanup(() => el.removeEventListener("load", onLoad, true))
              }}
            >
              <ImageRenderer ctx={previewCtx()!} />
            </div>
            <span class="a-ig-zoom" aria-hidden="true">
              {t("alpha.timeline.image.view")}
            </span>
          </Show>
        </div>
      </Show>
      <Show when={notice()}>
        {(box) => (
          <div class="a-ig-notice" data-tone={box().tone} data-cloud-image-notice>
            <b>{box().title}</b>
            <Show when={box().body}>
              <span>{box().body}</span>
            </Show>
          </div>
        )}
      </Show>
      <Show when={image().prompt}>
        <div
          class="a-ig-prompt"
          data-open={promptOpen() ? "" : undefined}
          ref={(el) =>
            queueMicrotask(() => {
              if (el.scrollHeight > el.clientHeight + 1) setPromptClamped(true)
            })
          }
        >
          {image().prompt}
        </div>
        <Show when={promptClamped()}>
          <button type="button" class="a-ig-prompt-more" aria-expanded={promptOpen()} onClick={() => setPromptOpen((open) => !open)}>
            {promptOpen() ? t("alpha.timeline.image.promptLess") : t("alpha.timeline.image.promptMore")}
          </button>
        </Show>
      </Show>
      {/* owner 10-30:图片下方一行只显示质量与像素;云端结果没有质量字段,只显示像素(取自本机已核验图片)。 */}
      <Show when={shown() && pixels()}>
        {(size) => (
          <div class="a-ig-facts" data-cloud-image-facts>
            {size().width} × {size().height}
          </div>
        )}
      </Show>
      <div class="a-ig-actions">
        <Show when={ticking()}>
          <span class="a-ig-hint">{t("alpha.timeline.image.hint")}</span>
        </Show>
        <Show when={shown()}>
          <button type="button" class="a-ig-btn" onClick={focus}>
            {t("alpha.timeline.image.view")}
          </button>
          <button type="button" class="a-ig-btn" data-cloud-image-save onClick={saveCopy}>
            {t("alpha.timeline.image.saveTo")}
          </button>
          <button type="button" class="a-ig-btn" data-cloud-image-open onClick={openPreview}>
            {t("alpha.timeline.image.openPreview")}
          </button>
        </Show>
        <Show when={billing()}>
          <button
            type="button"
            class="a-ig-btn"
            data-variant="primary"
            data-cloud-image-billing
            onClick={() => void window.api.cloud.openBillingPage("recharge")}
          >
            {t("alpha.timeline.image.billing")}
          </button>
        </Show>
        <Show when={retryable()}>
          <button
            type="button"
            class="a-ig-btn"
            data-variant="primary"
            data-cloud-image-retry
            disabled={retrying()}
            onClick={retry}
          >
            {t("alpha.timeline.image.retry")}
          </button>
        </Show>
        <Show when={!ticking() && view().state !== "submitting" && view().state !== "saving"}>
          <button type="button" class="a-ig-link" aria-expanded={detailsOpen()} onClick={() => setDetailsOpen((open) => !open)}>
            {detailsOpen() ? t("alpha.timeline.image.hideDetails") : t("alpha.timeline.image.details")}
            <svg viewBox="0 0 24 24" aria-hidden="true">
              <path d="M6 9l6 6 6-6" />
            </svg>
          </button>
        </Show>
      </div>
      <Show when={receipt()}>
        {(r) => (
          <Show
            when={r().kind === "ok" ? (r() as { folder: string; name: string }) : undefined}
            fallback={
              <div class="a-ig-result" data-tone="bad" role="alert" data-cloud-image-receipt="bad">
                <Show when={r().kind === "mismatch"} fallback={<span>{t("alpha.timeline.image.saveWriteFailed")}</span>}>
                  <span>
                    {t("alpha.timeline.image.saveMismatch")}
                    <button type="button" class="a-ig-inline" onClick={retry}>
                      {t("alpha.timeline.image.retry")}
                    </button>
                    {t("alpha.timeline.image.saveMismatchAfter")}
                  </span>
                </Show>
              </div>
            }
          >
            {(ok) => (
              <div class="a-ig-result" data-tone="ok" role="status" data-cloud-image-receipt="ok">
                <span>{t("alpha.timeline.image.saved", { folder: ok().folder, name: ok().name })}</span>
              </div>
            )}
          </Show>
        )}
      </Show>
      <Show when={detailsOpen()}>
        <div class="a-ig-details">
          <dl>
            <Show when={runId()}>
              {(id) => (
                <>
                  <dt>{t("alpha.timeline.image.fact.run")}</dt>
                  <dd class="a-ig-mono">{id()}</dd>
                </>
              )}
            </Show>
            <Show when={local()}>
              {(found) => (
                <>
                  <dt>{t("alpha.timeline.image.fact.file")}</dt>
                  <dd>{found().entry.descriptor.name}</dd>
                  <dt>{t("alpha.timeline.image.fact.check")}</dt>
                  <dd>
                    {t("alpha.timeline.image.fact.checkOk")}{" "}
                    <span class="a-ig-mono">sha256 {found().entry.descriptor.sha256?.slice(0, 4)}…{found().entry.descriptor.sha256?.slice(-4)}</span>
                  </dd>
                  <dt>{t("alpha.timeline.image.fact.where")}</dt>
                  <dd>{t("alpha.timeline.image.fact.whereValue")}</dd>
                </>
              )}
            </Show>
            <dt>{t("alpha.timeline.image.fact.source")}</dt>
            <dd>{t("alpha.timeline.image.fact.sourceValue")}</dd>
          </dl>
          <details class="a-ig-dev">
            <summary>{t("alpha.timeline.image.dev")}</summary>
            <pre>{devText()}</pre>
          </details>
        </div>
      </Show>
    </section>
  )
}
