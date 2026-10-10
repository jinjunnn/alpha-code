import { createSignal, onCleanup, Show, splitProps, type JSX } from "solid-js"
import { Tooltip } from "./Tooltip"
import { t } from "../i18n"
import "./copy-button.css"

/**
 * alpha-ui CopyButton —— 时间线里所有「复制」按钮的唯一实现(REQ-230 AC2,#1476)。
 *
 * 此前三个复制按钮三种尺寸(22 / 24 / 另一档)、两种圆角,点了没有任何反馈。统一为:
 * 24px、--a-radius-sm;点击写入剪贴板**成功后**图标换成绿勾、提示签显示「已复制」1.5 秒,
 * 并经一个 polite 的 live region 读给读屏。写入失败(权限 / 环境)保持静默 —— 不谎报「已复制」。
 */
export const COPIED_FEEDBACK_MS = 1500

export function CopyButton(
  props: {
    label: string
    text: () => string
  } & Omit<JSX.ButtonHTMLAttributes<HTMLButtonElement>, "onClick" | "children" | "title">,
) {
  const [local, rest] = splitProps(props, ["label", "text", "class"])
  const [copied, setCopied] = createSignal(false)
  let timer: ReturnType<typeof setTimeout> | undefined
  onCleanup(() => clearTimeout(timer))
  const copy = () => {
    const done = () => {
      clearTimeout(timer)
      setCopied(true)
      timer = setTimeout(() => setCopied(false), COPIED_FEEDBACK_MS)
    }
    try {
      void navigator.clipboard.writeText(local.text()).then(done, () => {})
    } catch {
      // 剪贴板拒绝(权限/环境)→ 静默;不阻断时间线,也不显示「已复制」。
    }
  }
  return (
    <Tooltip label={copied() ? t("alpha.common.copied") : local.label} forceOpen={copied}>
      <button
        {...rest}
        type="button"
        class={`a-copy-btn${local.class ? ` ${local.class}` : ""}`}
        data-copied={copied() ? "true" : undefined}
        aria-label={local.label}
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
        <span class="a-copy-live" aria-live="polite">
          {copied() ? t("alpha.common.copied") : ""}
        </span>
      </button>
    </Tooltip>
  )
}
