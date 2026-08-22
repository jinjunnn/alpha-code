// REQ-096(alpha-code#188)—— HTML artifact 隔离预览的 renderer 薄组件。
//
// 刻意「薄」:本组件绝不接触 HTML 字节、绝不 iframe/webview/innerHTML —— 唯一动作是经窄 IPC
// (window.api.htmlPreview)请求 main 打开/关闭隔离预览窗口(独立 sandboxed 进程、零 preload、
// 一次性 partition;host 本体 src/main/html-preview-host.ts)。renderer 只见 opaque previewId。
// Workbench 注册表(REQ-094,#186)后续由 orchestrator 接线;本组件不依赖其内部实现。
//
// #907 —— 拦截结果的诚实呈现:host 一直在记 `blockedPaths`(html-preview-host.ts:120),但本组件
// 从不调 `.status`,于是被挡掉的图片/样式/外链在界面上一个字都没有,用户只会以为报告本身是坏的。
// 本组件因此在预览存活期间轮询 `.status`,把被阻止的清单如实显示出来,并给一个**显式用户动作**的
// 出口(复制清单)让用户自己拿去系统浏览器打开。
//
// ⚠️ 本组件不放宽任何拦截:隔离窗口里通往系统浏览器的路径依旧不存在(setWindowOpenHandler deny、
// 导航/重定向/子 frame 全拒、非本协议请求全 cancel、will-download 拦截、权限全 false)。这里加的
// 是「把信息带出来的合规出口」,不是「把链接放出去的通道」——复制永远由用户按下按钮触发。
//
// 诚实边界(不假装能给出完整 URL):host 对外部请求只记 origin(`safeOrigin`,刻意不留 path/query
// —— 不给不可信文档经状态面外带数据的机会),被拒的**导航**则根本不入记录。所以清单里是「哪些来源
// 被挡了」,不是「你点的那个链接是什么」。界面照此措辞,不得反过来宣称。

import { createEffect, createSignal, onCleanup, Show } from "solid-js"
import type { ArtifactDescriptor } from "../../../shared/cloud-artifact-descriptor"
import { canPreviewHtml, HTML_PREVIEW_MAX_BLOCKED_ENTRIES } from "../../../shared/html-preview"
import { t } from "../../i18n"
import "./artifact-html-preview.css"

/** 被阻止清单的轮询间隔。host 侧是纯内存读,没有推送通道,故 renderer 拉;关窗即停(见 createEffect)。 */
const BLOCKED_POLL_MS = 1200

export type ArtifactHtmlPreviewProps = {
  /** 项目目录(run 发现同款上下文;main 侧仍全量过 ADR-019 守卫,不信任此输入)。 */
  directory: string
  runId: string
  descriptor: ArtifactDescriptor
  /** run 目录内相对路径 —— 仅展示用;打开预览只上送 artifactId,main 按 manifest 自行解析路径。 */
  savedPath: string
  /** 预览关闭(用户关窗/崩溃/主动关闭)后的回调。 */
  onClose?: () => void
}

export function ArtifactHtmlPreview(props: ArtifactHtmlPreviewProps) {
  const [previewId, setPreviewId] = createSignal<string | null>(null)
  const [busy, setBusy] = createSignal(false)
  const [error, setError] = createSignal<string | null>(null)
  const [crashed, setCrashed] = createSignal(false)
  const [blocked, setBlocked] = createSignal<string[]>([])
  const [copyState, setCopyState] = createSignal<"idle" | "copied" | "failed">("idle")

  const unsubscribe = window.api.htmlPreview.onClosed((e) => {
    if (e.previewId !== previewId()) return
    setPreviewId(null)
    if (e.reason === "crashed") setCrashed(true)
    props.onClose?.()
  })
  onCleanup(() => {
    unsubscribe()
    const id = previewId()
    if (id) void window.api.htmlPreview.close(id) // 组件卸载 = 预览生命周期终点(一次性语义)
  })

  // 预览存活期间轮询被阻止清单。关闭/卸载 → onCleanup 清 timer 并作废在途响应(late-arriving
  // 的旧响应不许把已清空的清单又写回去)。状态查询失败静默 —— 它是诊断面,不该干扰预览本体。
  createEffect(() => {
    const id = previewId()
    if (!id) return
    let cancelled = false
    const tick = async () => {
      try {
        const status = await window.api.htmlPreview.status(id)
        if (!cancelled && status.ok) setBlocked(status.blockedPaths)
      } catch {
        /* 状态查询失败不影响预览本体 */
      }
    }
    void tick()
    const timer = setInterval(() => void tick(), BLOCKED_POLL_MS)
    onCleanup(() => {
      cancelled = true
      clearInterval(timer)
    })
  })

  const supported = () => canPreviewHtml(props.descriptor)
  /** 到达记录上限 = 清单被截断,计数只能说「至少」。谎报一个精确数比不报更坏。 */
  const blockedCapped = () => blocked().length >= HTML_PREVIEW_MAX_BLOCKED_ENTRIES

  const open = async () => {
    if (busy() || previewId()) return
    setBusy(true)
    setError(null)
    setCrashed(false)
    setBlocked([])
    setCopyState("idle")
    try {
      const res = await window.api.htmlPreview.open(props.directory, props.runId, props.descriptor.id)
      if (res.ok) setPreviewId(res.previewId)
      else setError(res.reason)
    } catch {
      setError(t("alpha.htmlPreview.requestFailed"))
    } finally {
      setBusy(false)
    }
  }

  const close = async () => {
    const id = previewId()
    if (!id) return
    await window.api.htmlPreview.close(id) // 状态复位走 onClosed 推送(单一真相)
  }

  // 唯一的「带出」出口 —— 只由用户按下按钮触发,绝不自动执行、绝不代替用户打开任何东西。
  const copyBlocked = async () => {
    const list = blocked()
    if (!list.length) return
    const text = list.join("\n")
    setCopyState("idle")
    try {
      if (await window.api.writeClipboard(text)) {
        setCopyState("copied")
        return
      }
    } catch {
      /* 落到 renderer 剪贴板 */
    }
    try {
      await navigator.clipboard.writeText(text)
      setCopyState("copied")
    } catch {
      setCopyState("failed")
    }
  }

  return (
    <div class="a-html-preview">
      <div class="a-html-preview-head">
        <span class="a-html-preview-name" title={props.savedPath}>
          {props.descriptor.name}
        </span>
        <span class="a-html-preview-badge">{t("alpha.htmlPreview.badge")}</span>
      </div>
      <p class="a-html-preview-hint">
        {t("alpha.htmlPreview.hint")}
      </p>
      <Show when={error()}>
        <p class="a-html-preview-error" role="alert">
          {error()}
        </p>
      </Show>
      <Show when={crashed()}>
        <p class="a-html-preview-error" role="alert">
          {t("alpha.htmlPreview.crashed")}
        </p>
      </Show>
      <Show when={blocked().length > 0}>
        <section class="a-html-preview-blocked" data-blocked-count={blocked().length}>
          <p class="a-html-preview-blocked-title">
            {blockedCapped()
              ? t("alpha.htmlPreview.blockedCountCapped", { count: String(blocked().length) })
              : t("alpha.htmlPreview.blockedCount", { count: String(blocked().length) })}
          </p>
          <ul class="a-html-preview-blocked-list">
            {blocked().map((entry) => (
              <li class="a-html-preview-blocked-item" title={entry}>
                {entry}
              </li>
            ))}
          </ul>
          <p class="a-html-preview-blocked-note">{t("alpha.htmlPreview.blockedNote")}</p>
          <div class="a-html-preview-actions">
            <button class="a-html-preview-btn" onClick={() => void copyBlocked()}>
              {t("alpha.htmlPreview.copyBlocked")}
            </button>
            <Show when={copyState() === "copied"}>
              <span class="a-html-preview-copy-note" role="status">
                {t("alpha.htmlPreview.copied")}
              </span>
            </Show>
            <Show when={copyState() === "failed"}>
              <span class="a-html-preview-error" role="alert">
                {t("alpha.htmlPreview.copyFailed")}
              </span>
            </Show>
          </div>
        </section>
      </Show>
      <div class="a-html-preview-actions">
        <Show
          when={previewId()}
          fallback={
            <button class="a-html-preview-btn primary" onClick={() => void open()} disabled={busy() || !supported()}>
              {busy() ? t("alpha.htmlPreview.opening") : t("alpha.htmlPreview.open")}
            </button>
          }
        >
          <span class="a-html-preview-open-note">{t("alpha.htmlPreview.opened")}</span>
          <button class="a-html-preview-btn" onClick={() => void close()}>
            {t("alpha.htmlPreview.close")}
          </button>
        </Show>
      </div>
      <Show when={!supported()}>
        <p class="a-html-preview-unsupported">{t("alpha.htmlPreview.unsupported")}</p>
      </Show>
    </div>
  )
}
