// B11 统一错误/健康呈现的持久态基元(与 Toast 分工:Toast=瞬时/可恢复动作反馈,Banner=持久/
// 阻断状态)。一处定义,AlphaHome / ExtensionHub / model-picker 等各处复用;语义色走 tokens.css
// 的 --a-{kind}/--a-{kind}-subtle。

import { Show, type JSX } from "solid-js"
import { useContractHealth } from "./providers"
import "./banner.css"

export type BannerKind = "info" | "success" | "warning" | "error"

export function Banner(props: {
  kind: BannerKind
  title: string
  detail?: string
  action?: { label: string; onClick: () => void }
  children?: JSX.Element
}) {
  return (
    <div class={`a-banner ${props.kind}`} role={props.kind === "error" ? "alert" : "status"}>
      <span class="a-banner-dot" aria-hidden="true" />
      <span class="a-banner-body">
        <span class="a-banner-title">{props.title}</span>
        <Show when={props.detail}>
          <span class="a-banner-detail">{props.detail}</span>
        </Show>
        {props.children}
      </span>
      <Show when={props.action}>
        {(a) => (
          <button class="a-banner-action" onClick={() => a().onClick()}>
            {a().label}
          </button>
        )}
      </Show>
    </div>
  )
}

export function ContractFailureBanner() {
  const failure = useContractHealth()
  return (
    <Show when={failure()} keyed>
      {(value) => (
        <div class="a-contract-failure" data-alpha-contract-failure={value.surface}>
          <Banner
            kind="error"
            title="Alpha platform contract is incompatible"
            detail={`${value.surface}: ${value.reason} (expected v${value.expected_version}, received ${value.received_version})`}
          />
        </div>
      )}
    </Show>
  )
}
