// B11 统一错误/健康呈现的持久态基元(与 Toast 分工:Toast=瞬时/可恢复动作反馈,Banner=持久/
// 阻断状态)。一处定义,AlphaHome / ExtensionHub / model-picker 等各处复用;语义色走 tokens.css
// 的 --a-{kind}/--a-{kind}-subtle。

import { createSignal, onCleanup, onMount, Show, type JSX } from "solid-js"
import { useContractHealth } from "./providers"
import { t } from "../i18n"
import type { CatalogRefreshFailure } from "../../shared/alpha-model-types"
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

/** #1084(#987 CHOICE=A):平台模型目录**刷新失败**的用户可观察出口。
 *
 *  在此之前 `fetchPlatformModels()` 算出来的分类码只到 main 的函数返回值为止 —— 三个刷新入口
 *  一个都不消费它,picker 就静静停在旧缓存/内置 snapshot 上,用户既看不见也无从下手。
 *
 *  形态刻意复用既有 Banner 基元,不引入新视觉体系。kind = warning 而不是 error:BYOK 段与
 *  上次成功的缓存目录照常可用,这是**降级**不是阻断(失败域隔离,#595)。
 *
 *  契约横幅在场时自抑制:contract-incompatible 两个通道都会记(main 侧保持「最后一次刷新结局」
 *  单一真源),而两条横幅是同一个 fixed 位,不抑制就会精确重叠。 */
export function CatalogFailureBanner() {
  const contract = useContractHealth()
  const [failure, setFailure] = createSignal<CatalogRefreshFailure | null>(null)
  onMount(() => {
    void window.api.models.refreshHealth().then(setFailure)
    onCleanup(window.api.models.subscribeRefreshHealth(setFailure))
  })
  return (
    <Show when={!contract() && failure()} keyed>
      {(value) => (
        <div class="a-catalog-failure" data-alpha-catalog-failure={value.code}>
          <Banner
            kind="warning"
            title={t("alpha.model.refreshFailedTitle")}
            detail={t("alpha.model.refreshFailedDetail", { code: value.code })}
          />
        </div>
      )}
    </Show>
  )
}
