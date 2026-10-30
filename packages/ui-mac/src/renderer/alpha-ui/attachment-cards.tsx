// REQ-236 `#1553` —— 附件卡(owner 2026-10-30 批准稿 docs/design/2026-10-30-req236-attachments/frame.html)。
//
// 输入框里:图片是 56px 缩略图(角上是读取方式图标,可点开看大图),文件是文件卡(类型图形、名字、大小 · 读取路径);
// 发送前就没能附上的,是卡内说明 + 移除 / 重试。图片的读取方式对一组图只写一次,放在附件条下面(AC7)。
// 用户消息里:图片缩略图(一张 240×180,多张 104×104),文件卡第二行是读取结果(AC4),失败 / 没读时给「重新读取 /
// 请助手读取」—— 那是在输入框里以同一个附件再发一条请求读取的消息,不在后台悄悄重读。
// 「已读取」只陈述打开过,不转述读懂了什么(卡上不显示摘要 / 页数)。
import { createSignal, For, onCleanup, onMount, Show } from "solid-js"
import { t } from "../i18n"
import { MAX_ATTACHMENT_BYTES } from "../../shared/attachment-path"
import {
  fileRouteOf,
  IMAGE_MAX_BYTES,
  TEXT_MAX_BYTES,
  type AttachmentFailure,
  type ComposerAttachment,
  type ImageRoute,
} from "./composer-attachments-core"
import type { TimelineAttachment, TimelineAttachmentRead } from "./session-timeline/timeline-attachments"
import "./attachment-cards.css"

function sizeText(bytes: number | undefined): string {
  if (bytes === undefined) return ""
  if (bytes >= 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(1)} MB`
  return `${Math.max(1, Math.round(bytes / 1024))} KB`
}

function extOf(name: string): string {
  const dot = name.lastIndexOf(".")
  return dot > 0 ? name.slice(dot + 1).slice(0, 4).toUpperCase() : "FILE"
}

const FAILURE_KEY: Record<AttachmentFailure, Parameters<typeof t>[0]> = {
  type: "alpha.attach.failType",
  "image-size": "alpha.attach.failImageSize",
  "text-size": "alpha.attach.failTextSize",
  "document-size": "alpha.attach.failDocumentSize",
  "too-large": "alpha.attach.failDocumentSize",
  read: "alpha.attach.failRead",
  "not-project": "alpha.attach.failStage",
  "write-failed": "alpha.attach.failStage",
  invalid: "alpha.attach.failStage",
}

/** 超限说法里的上限读同一份常量(改上限,文案跟着变)。 */
const FAILURE_LIMIT: Partial<Record<AttachmentFailure, number>> = {
  "image-size": IMAGE_MAX_BYTES,
  "text-size": TEXT_MAX_BYTES,
  "document-size": MAX_ATTACHMENT_BYTES,
  "too-large": MAX_ATTACHMENT_BYTES,
}
const failureText = (reason: AttachmentFailure) => {
  const limit = FAILURE_LIMIT[reason]
  if (limit === undefined) return t(FAILURE_KEY[reason])
  return t(FAILURE_KEY[reason], { size: limit >= 1024 * 1024 ? `${limit / 1024 / 1024} MB` : `${limit / 1024} KB` })
}

const IMAGE_ROUTE_KEY: Record<ImageRoute, Parameters<typeof t>[0]> = {
  native: "alpha.attach.imageNative",
  cloud: "alpha.attach.imageCloud",
  none: "alpha.attach.imageNone",
  unknown: "alpha.attach.imageUnknown",
}

const READ_KEY = (read: TimelineAttachmentRead): Parameters<typeof t>[0] => {
  switch (read.kind) {
    case "sent":
      return "alpha.attach.readSent"
    case "saved":
      return "alpha.attach.readSaved"
    case "waiting":
      return "alpha.attach.readWaiting"
    case "read":
      return "alpha.attach.readDone"
    case "not-read":
      return "alpha.attach.readNotRead"
    case "empty":
      return "alpha.attach.readEmpty"
    case "failed":
      return read.reason === "not-running"
        ? "alpha.attach.readFailedNotRunning"
        : read.reason === "timeout"
          ? "alpha.attach.readFailedTimeout"
          : "alpha.attach.readFailedUnreadable"
  }
}

const READ_TONE: Record<TimelineAttachmentRead["kind"], "ok" | "warn" | "error" | undefined> = {
  sent: "ok",
  read: "ok",
  saved: undefined,
  waiting: undefined,
  "not-read": "warn",
  empty: "warn",
  failed: "error",
}

/** 读取方式图标:眼睛 = 直接看;云 = 云端识图;划掉的眼睛 = 看不了;问号 = 不确定(不靠颜色区分)。 */
function RouteIcon(props: { route: ImageRoute }) {
  return (
    <svg class="a-att-route-ic" viewBox="0 0 24 24" aria-hidden="true">
      <Show when={props.route === "native" || props.route === "none"}>
        <path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7S2 12 2 12z" />
        <circle cx="12" cy="12" r="3" />
      </Show>
      <Show when={props.route === "none"}>
        <path d="M4 4l16 16" />
      </Show>
      <Show when={props.route === "cloud"}>
        <path d="M7 18h10a4 4 0 0 0 .5-7.97A6 6 0 0 0 6.1 9.5 4.25 4.25 0 0 0 7 18z" />
      </Show>
      <Show when={props.route === "unknown"}>
        <path d="M9.2 9a3 3 0 1 1 4.3 2.7c-.9.4-1.5 1.2-1.5 2.2v.6M12 18h.01" />
      </Show>
    </svg>
  )
}

function TypeGlyph(props: { name: string }) {
  return (
    <span class="a-att-glyph" aria-hidden="true">
      <svg viewBox="0 0 40 40">
        <path d="M11 5h13l7 7v21a2 2 0 0 1-2 2H11a2 2 0 0 1-2-2V7a2 2 0 0 1 2-2z" />
        <path d="M24 5v7h7" />
      </svg>
      <span class="a-att-glyph-ext">{extOf(props.name)}</span>
    </span>
  )
}

function StatusIcon(props: { tone: "ok" | "warn" | "error" | undefined }) {
  return (
    <Show when={props.tone}>
      <svg class="a-att-status-ic" data-tone={props.tone} viewBox="0 0 24 24" aria-hidden="true">
        <Show when={props.tone === "ok"} fallback={<path d="M12 7v6M12 17h.01" />}>
          <path d="M5 12.5l4.5 4.5L19 7.5" />
        </Show>
      </svg>
    </Show>
  )
}

/** 看大图:贴缩略图上方的小浮层;Esc、点别处、再点缩略图关闭,焦点回到缩略图(时间线弹出层家族同一套关闭规则)。 */
function Lightbox(props: { url: string; name: string; size?: number; anchor: HTMLElement; onClose: () => void }) {
  let box: HTMLDivElement | undefined
  const [dims, setDims] = createSignal("")
  const close = () => {
    props.onClose()
    props.anchor.focus()
  }
  const onKey = (e: KeyboardEvent) => {
    if (e.key !== "Escape") return
    e.stopPropagation()
    close()
  }
  const onPointer = (e: PointerEvent) => {
    const target = e.target as Node | null
    if (target && (box?.contains(target) || props.anchor.contains(target))) return
    close()
  }
  onMount(() => {
    document.addEventListener("keydown", onKey, true)
    document.addEventListener("pointerdown", onPointer, true)
  })
  onCleanup(() => {
    document.removeEventListener("keydown", onKey, true)
    document.removeEventListener("pointerdown", onPointer, true)
  })
  return (
    <div ref={box} class="a-att-lightbox" role="dialog" aria-label={props.name}>
      <img
        src={props.url}
        alt=""
        onLoad={(e) => setDims(`${e.currentTarget.naturalWidth} × ${e.currentTarget.naturalHeight}`)}
      />
      <div class="a-att-lightbox-meta">
        <b>{props.name}</b>
        <span>{[dims(), sizeText(props.size)].filter(Boolean).join(" · ")}</span>
      </div>
    </div>
  )
}

function Thumb(props: { url: string; name: string; size?: number; route?: ImageRoute; large?: boolean }) {
  const [open, setOpen] = createSignal(false)
  let button: HTMLButtonElement | undefined
  return (
    <span class="a-att-thumb-wrap">
      <button
        ref={button}
        type="button"
        class="a-att-thumb"
        data-large={props.large ? "" : undefined}
        aria-label={t("alpha.attach.open", { name: props.name })}
        aria-expanded={open()}
        onClick={() => setOpen((v) => !v)}
      >
        <img src={props.url} alt="" />
        {/* 名字是按钮的可读名称(读屏);输入框条里它也是附件名的定位点。 */}
        <span class="a-att-sr a-comp-att-name">{props.name}</span>
        <Show when={props.route}>
          <span class="a-att-thumb-route">
            <RouteIcon route={props.route!} />
          </span>
        </Show>
      </button>
      <Show when={open()}>
        <Lightbox url={props.url} name={props.name} size={props.size} anchor={button!} onClose={() => setOpen(false)} />
      </Show>
    </span>
  )
}

function RemoveButton(props: { onClick: () => void }) {
  return (
    <button type="button" class="a-comp-att-x" aria-label={t("alpha.composer.removeAttachment")} onClick={props.onClick}>
      <svg viewBox="0 0 24 24" aria-hidden="true">
        <path d="M7 7l10 10M17 7L7 17" />
      </svg>
    </button>
  )
}

export function ComposerAttachmentStrip(props: {
  attachments: readonly ComposerAttachment[]
  reading: boolean
  imageRoute: ImageRoute
  onRemove: (id: string) => void
  onRetry: (id: string) => void
}) {
  const images = () => props.attachments.filter((a) => a.kind === "image").length
  return (
    <Show when={props.attachments.length > 0 || props.reading}>
      <div class="a-comp-atts" role="list" aria-label={t("alpha.attach.list", { count: props.attachments.length })}>
        <For each={props.attachments}>
          {(a) => (
            <span class="a-comp-att" data-kind={a.kind} role="listitem">
              <Show
                when={a.kind === "image" ? a : undefined}
                fallback={
                  <span class="a-att-card" data-failed={a.kind === "failed" ? "" : undefined} title={a.name}>
                    <TypeGlyph name={a.name} />
                    <span class="a-att-text">
                      <span class="a-comp-att-name">{a.name}</span>
                      <span class="a-att-sub">
                        <Show
                          when={a.kind === "failed" ? a : undefined}
                          fallback={
                            <>
                              <span class="a-att-size">{sizeText(a.size)}</span>
                              {" · "}
                              <span class="a-att-route" data-route={fileRouteOf(a.kind === "text" ? "text" : "document")}>
                                {t(a.kind === "text" ? "alpha.attach.routeInline" : "alpha.attach.routeLocal")}
                              </span>
                            </>
                          }
                        >
                          {(failed) => (
                            <>
                              <span class="a-att-fail">{failureText(failed().reason)}</span>
                              <Show when={failed().file}>
                                <button type="button" class="a-att-link" onClick={() => props.onRetry(a.id)}>
                                  {t("alpha.attach.retry")}
                                </button>
                              </Show>
                            </>
                          )}
                        </Show>
                      </span>
                    </span>
                  </span>
                }
              >
                {(image) => <Thumb url={image().url} name={a.name} size={a.size} route={props.imageRoute} />}
              </Show>
              <RemoveButton onClick={() => props.onRemove(a.id)} />
            </span>
          )}
        </For>
        <Show when={props.reading}>
          <span class="a-comp-att" data-kind="reading" role="listitem">
            <span class="a-att-card" data-pending="">
              <span class="a-att-text">
                <span class="a-att-sub">{t("alpha.attach.reading")}</span>
              </span>
            </span>
          </span>
        </Show>
      </div>
      <Show when={images() > 0}>
        <div class="a-att-image-route" data-route={props.imageRoute}>
          <RouteIcon route={props.imageRoute} />
          <span>{t(IMAGE_ROUTE_KEY[props.imageRoute], { count: images() })}</span>
        </div>
      </Show>
    </Show>
  )
}

export function TimelineAttachments(props: {
  attachments: readonly TimelineAttachment[]
  onReadAgain?: (attachment: TimelineAttachment) => void
}) {
  const thumbs = () => props.attachments.filter((a) => a.media === "image" && a.url)
  const cards = () => props.attachments.filter((a) => !(a.media === "image" && a.url))
  return (
    <div class="a-tl-attachments">
      <Show when={thumbs().length > 0}>
        <div class="a-tl-attach-thumbs">
          <For each={thumbs()}>
            {(a) => (
              <span class="a-tl-attach" data-media="image">
                <Thumb url={a.url!} name={a.name} size={a.size} large={thumbs().length === 1} />
              </span>
            )}
          </For>
        </div>
      </Show>
      <For each={cards()}>
        {(a) => {
          const action = () =>
            a.staged && props.onReadAgain && (a.read?.kind === "failed" || a.read?.kind === "not-read")
              ? a.read.kind === "failed"
                ? t("alpha.attach.readAgain")
                : t("alpha.attach.askToRead")
              : undefined
          return (
            <span class="a-tl-attach a-att-card" data-media={a.media} data-failed={a.read?.kind === "failed" ? "" : undefined} title={a.name}>
              <TypeGlyph name={a.name} />
              <span class="a-att-text">
                <span class="a-comp-att-name">{a.name}</span>
                <span class="a-att-sub" role="status">
                  <Show when={a.read} fallback={<span class="a-att-size">{a.label}</span>}>
                    {(read) => (
                      <>
                        <StatusIcon tone={READ_TONE[read().kind]} />
                        <span class="a-att-result">{t(READ_KEY(read()))}</span>
                        <Show when={(read().kind === "read" || read().kind === "sent") && a.size !== undefined}>
                          <span class="a-att-size">{` · ${sizeText(a.size)}`}</span>
                        </Show>
                      </>
                    )}
                  </Show>
                  <Show when={action()}>
                    <button type="button" class="a-att-link" onClick={() => props.onReadAgain?.(a)}>
                      {action()}
                    </button>
                  </Show>
                </span>
              </span>
            </span>
          )
        }}
      </For>
    </div>
  )
}
