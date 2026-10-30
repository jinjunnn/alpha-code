import { ProviderIcon } from "@opencode-ai/ui/provider-icon"
import { brandIconId, NEUTRAL_BRAND_ICON } from "./model-picker-core"

/** alpha-code#1558 品牌图标格(批准稿 docs/design/2026-10-30-req236-model-picker/frame.html):中性底 + 单色品牌图形,
 *  回落图形用次级色。默认 20(选择器行)、`sm` 18(输入框模型按钮)、`lg` 32(添加供应商卡)。装饰性,读屏不读。 */
export function BrandIcon(props: { brand?: string; size?: "sm" | "lg" }) {
  const icon = () => brandIconId(props.brand)
  return (
    <span
      class="a-brand"
      classList={{
        sm: props.size === "sm",
        lg: props.size === "lg",
        neutral: icon() === NEUTRAL_BRAND_ICON,
      }}
      data-brand-icon={icon()}
      aria-hidden="true"
    >
      <ProviderIcon id={icon()} />
    </span>
  )
}
