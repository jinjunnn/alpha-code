// REQ-096(alpha-code#188)—— HTML artifact 隔离预览的 renderer 薄组件。
//
// 刻意「薄」:本组件绝不接触 HTML 字节、绝不 iframe/webview/innerHTML —— 唯一动作是经窄 IPC
// (window.api.htmlPreview)请求 main 打开/关闭隔离预览窗口(独立 sandboxed 进程、零 preload、
// 一次性 partition;host 本体 src/main/html-preview-host.ts)。renderer 只见 opaque previewId。
// Workbench 注册表(REQ-094,#186)后续由 orchestrator 接线;本组件不依赖其内部实现。

import { createSignal, onCleanup, Show } from "solid-js"
import type { ArtifactDescriptor } from "../../../shared/cloud-artifact-descriptor"
import { canPreviewHtml } from "../../../shared/html-preview"
import "./artifact-html-preview.css"

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

  const supported = () => canPreviewHtml(props.descriptor)

  const open = async () => {
    if (busy() || previewId()) return
    setBusy(true)
    setError(null)
    setCrashed(false)
    try {
      const res = await window.api.htmlPreview.open(props.directory, props.runId, props.descriptor.id)
      if (res.ok) setPreviewId(res.previewId)
      else setError(res.reason)
    } catch {
      setError("预览请求失败")
    } finally {
      setBusy(false)
    }
  }

  const close = async () => {
    const id = previewId()
    if (!id) return
    await window.api.htmlPreview.close(id) // 状态复位走 onClosed 推送(单一真相)
  }

  return (
    <div class="a-html-preview">
      <div class="a-html-preview-head">
        <span class="a-html-preview-name" title={props.savedPath}>
          {props.descriptor.name}
        </span>
        <span class="a-html-preview-badge">隔离预览</span>
      </div>
      <p class="a-html-preview-hint">
        静态 HTML 在独立沙箱窗口中显示:无脚本、无网络、无表单,与主应用零共享。
      </p>
      <Show when={error()}>
        <p class="a-html-preview-error" role="alert">
          {error()}
        </p>
      </Show>
      <Show when={crashed()}>
        <p class="a-html-preview-error" role="alert">
          预览窗口异常退出(仅影响预览本身,可重新打开)。
        </p>
      </Show>
      <div class="a-html-preview-actions">
        <Show
          when={previewId()}
          fallback={
            <button class="a-html-preview-btn primary" onClick={() => void open()} disabled={busy() || !supported()}>
              {busy() ? "打开中…" : "在隔离窗口中预览"}
            </button>
          }
        >
          <span class="a-html-preview-open-note">已在隔离窗口中打开</span>
          <button class="a-html-preview-btn" onClick={() => void close()}>
            关闭预览
          </button>
        </Show>
      </div>
      <Show when={!supported()}>
        <p class="a-html-preview-unsupported">该产物未被鉴别为静态 HTML,不提供隔离预览。</p>
      </Show>
    </div>
  )
}
