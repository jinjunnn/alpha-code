import { createSignal, onCleanup, Show } from "solid-js"
import { Tooltip } from "./Tooltip"
import { t } from "../i18n"
import "./copy-button.css"

/** 「已复制」确认停留时长(`#1476`:点后绿勾 1.5 秒)。 */
export const COPIED_FEEDBACK_MS = 1500

/**
 * alpha-ui CopyButton —— 时间线一带唯一的复制按钮(`#1476`,REQ-230 AC2):用户消息、回合脚注、
 * 工具错误三处此前三种尺寸、两种圆角、点了没反馈;现在统一 24px、`--a-radius-sm`,
 * 点击后图标变绿勾并在提示里写「已复制」,1.5 秒后复原。
 *
 * 剪贴板拒绝(权限 / 环境)时不显示「已复制」—— 没复制成功就不说成功。
 * 渲染与否仍由调用方决定(剪贴板通道缺席 fail-closed 不渲染,与此前一致)。
 */
export function CopyButton(props: {
  label: string
  text: () => string
  class?: string
  /** 透传到 `<button>` 的 data 标记(既有选择器 / 测试锚点)。 */
  dataAttr?: string
}) {
  const [copied, setCopied] = createSignal(false)
  let timer: ReturnType<typeof setTimeout> | undefined
  onCleanup(() => clearTimeout(timer))
  const confirm = () => {
    setCopied(true)
    clearTimeout(timer)
    timer = setTimeout(() => setCopied(false), COPIED_FEEDBACK_MS)
  }
  const copy = () => {
    try {
      void navigator.clipboard
        .writeText(props.text())
        .then(confirm)
        .catch(() => {})
    } catch {
      // 剪贴板拒绝(权限/环境)→ 静默;不阻断时间线。
    }
  }
  return (
    <Tooltip label={copied() ? t("alpha.common.copied") : props.label} open={copied()}>
      <button
        type="button"
        class={`a-copy-btn${props.class ? ` ${props.class}` : ""}`}
        data-copied={copied() ? "true" : undefined}
        {...(props.dataAttr ? { [props.dataAttr]: "" } : {})}
        aria-label={props.label}
        onClick={copy}
      >
        <Show
          when={copied()}
          fallback={
            <svg viewBox="0 0 24 24" aria-hidden="true">
              <rect x="9" y="9" width="11" height="11" rx="2" />
              <path d="M5 15V5a2 2 0 0 1 2-2h10" />
            </svg>
          }
        >
          <svg viewBox="0 0 24 24" aria-hidden="true">
            <path d="M5 12.5l4.5 4.5L19 7.5" />
          </svg>
        </Show>
      </button>
      <span class="a-tip-desc" role="status" aria-live="polite">
        {copied() ? t("alpha.common.copied") : ""}
      </span>
    </Tooltip>
  )
}
