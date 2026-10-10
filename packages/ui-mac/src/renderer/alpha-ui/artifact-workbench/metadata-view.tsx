// 产物详情的共享零件:状态/页签文案 key + Metadata 模式视图。
// 原住 artifact-workbench.tsx;整页工作台已于 #662 下线、#990 删除,会话右栏
// (session-rail/artifacts)仍复用这几个零件与 artifact-workbench.css 的卡片/预览语言。
import { createMemo, For, Show } from "solid-js"
import { t } from "../../i18n"
import { formatBytes, shortSha } from "./workbench-core"
import type { PreviewContext } from "./renderers/renderer-views"
import "./artifact-workbench.css"

export const STATE_LABEL_KEYS = {
  verified: "alpha.wb.state.verified",
  unverified: "alpha.wb.state.unverified",
  mismatch: "alpha.wb.state.mismatch",
  missing: "alpha.wb.state.missing",
  legacy: "alpha.wb.state.legacy",
  "cloud-only": "alpha.wb.state.cloudOnly",
} as const

export const TAB_LABEL_KEYS = {
  preview: "alpha.wb.tab.preview",
  source: "alpha.wb.tab.source",
  metadata: "alpha.wb.tab.metadata",
} as const

/** Metadata 模式:descriptor 事实 + 本地状态 + 路由决策(选中 renderer 与原因,REQ-095 AC#1)。 */
export function MetadataView(props: { ctx: PreviewContext }) {
  const d = () => props.ctx.card.descriptor
  const rows = createMemo<Array<[string, string]>>(() => {
    const out: Array<[string, string]> = [
      [t("alpha.wb.factName"), props.ctx.name],
      [t("alpha.wb.factSize"), formatBytes(props.ctx.card.bytes)],
      [t("alpha.wb.factState"), props.ctx.card.state],
      [t("alpha.wb.decision"), `${props.ctx.decision.rendererId} — ${props.ctx.decision.reason}`],
      ["MIME", `claimed ${props.ctx.card.claimedMime ?? "—"} / detected ${props.ctx.card.detectedMime ?? "—"}`],
      ["external open", props.ctx.decision.externalOpen],
    ]
    if (props.ctx.decision.ooxmlSubtype)
      out.push(["OOXML", `${props.ctx.decision.ooxmlSubtype} / ${props.ctx.decision.effectiveMime}`])
    const desc = d()
    if (desc) {
      out.push(
        ["id", desc.id],
        ["sha256", shortSha(desc.sha256)],
        [t("alpha.wb.factTrust"), `${desc.trust} · ${desc.role}`],
        ["provenance", `${desc.provenance.producer} · ${desc.provenance.jobId}${desc.provenance.kind ? ` · ${desc.provenance.kind}` : ""}`],
        ["verification", desc.verification.status],
      )
    }
    if (props.ctx.card.savedPath) out.push([t("alpha.wb.factPath"), props.ctx.card.savedPath])
    return out
  })
  return (
    <div class="alpha-wb-meta">
      <For each={rows()}>
        {([k, v]) => (
          <div class="a-wb-fact">
            <span class="a-wb-fact-k">{k}</span>
            <span class="a-wb-fact-v" title={v}>{v}</span>
          </div>
        )}
      </For>
      <Show when={props.ctx.card.warnings.length > 0}>
        <div class="alpha-wb-meta-warnings">
          <div class="a-wb-fact-k">{t("alpha.wb.warnings")}</div>
          <For each={props.ctx.card.warnings}>{(w) => <div class="a-wb-notice" data-kind="warn">{w}</div>}</For>
        </div>
      </Show>
    </div>
  )
}
