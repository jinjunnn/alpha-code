// #348(REQ-100):stage="authorize" 能力授权确认视图 —— 引擎锁内评估的 CapabilityDiff[] 的
// 唯一渲染面。按已批设计稿(docs/design/2026-07-15-capability-authorize-dialog):
//   · 整集确认、无逐能力开关(引擎 requested ⊆ confirmed 整集覆盖,防 TOCTOU);
//   · 差异三分层:新增(视觉焦点)/已授权(muted)/将收回(信息性);
//   · 风险克制:仅 engine:plugin / process:spawn 标高风险,出现时复用 ⚠ 风险行;
//   · bundle 只展开需确认项,其余按返回 diff 中非确认项计数折叠(不含 planner 已跳过的 optional);
//   · 未知 capability 原样展示(前向兼容),不隐藏。
// 宿主 Dialog / 状态机在 extension-hub.tsx(两阶段控制器);本组件纯展示 + confirmed 构造。
import { For, Show } from "solid-js"
import type { JSX } from "solid-js"
import { t } from "../i18n"
import { Button } from "../alpha-ui/Button"
import { Dialog } from "../alpha-ui/Dialog"
import type { DialogRestoreFocus } from "../alpha-ui/dialog-core"
import type { AuthorizationConfirmationWire, CapabilityDiffWire } from "../../shared/ext-capability-authorization"

type I18nKey = Parameters<typeof t>[0]
type CapVocab = { label: I18nKey; desc: I18nKey; tier: "low" | "mid" | "high"; icon: () => JSX.Element }

const ic = (d: string) => () => (
  <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
    <path d={d} />
  </svg>
)

/** 能力词汇表(设计稿 §6)。语义白名单在 main manifest 解码期;此处只管展示。 */
const CAP_VOCAB: Record<string, CapVocab> = {
  "prompt:context": { label: "alpha.ext.cap.promptContext", desc: "alpha.ext.cap.promptContextDesc", tier: "low", icon: ic("M2.5 3.5h11v7h-6l-3 2.5v-2.5h-2z") },
  "engine:config": { label: "alpha.ext.cap.engineConfig", desc: "alpha.ext.cap.engineConfigDesc", tier: "mid", icon: ic("M8 5.8a2.2 2.2 0 1 0 0 4.4 2.2 2.2 0 0 0 0-4.4M8 1.8v2M8 12.2v2M1.8 8h2M12.2 8h2M3.6 3.6 5 5M11 11l1.4 1.4M12.4 3.6 11 5M5 11l-1.4 1.4") },
  "engine:plugin": { label: "alpha.ext.cap.enginePlugin", desc: "alpha.ext.cap.enginePluginDesc", tier: "high", icon: ic("M5.5 4.5 2 8l3.5 3.5M10.5 4.5 14 8l-3.5 3.5") },
  "process:spawn": { label: "alpha.ext.cap.processSpawn", desc: "alpha.ext.cap.processSpawnDesc", tier: "high", icon: ic("M1.8 2.8h12.4v10.4H1.8zM4.5 6l2 2-2 2M8.5 10.5h3") },
  "network:remote": { label: "alpha.ext.cap.networkRemote", desc: "alpha.ext.cap.networkRemoteDesc", tier: "mid", icon: ic("M8 1.8a6.2 6.2 0 1 0 0 12.4A6.2 6.2 0 0 0 8 1.8M1.8 8h12.4M8 1.8c-3.6 3.4-3.6 9 0 12.4c3.6-3.4 3.6-9 0-12.4") },
  "cloud:dispatch": { label: "alpha.ext.cap.cloudDispatch", desc: "alpha.ext.cap.cloudDispatchDesc", tier: "mid", icon: ic("M4.5 12.5a3 3 0 0 1-.4-6A4 4 0 0 1 12 7.6a2.5 2.5 0 0 1-.5 4.9z") },
}
const HIGH_RISK = new Set(["engine:plugin", "process:spawn"])

/** 确认构造(设计稿 D5 / Codex 裁决 D3):只含需确认项,值 = 展示的完整 requested 集。 */
export function buildAuthzConfirmation(diffs: CapabilityDiffWire[]): AuthorizationConfirmationWire {
  return {
    confirmed: Object.fromEntries(diffs.filter((d) => d.requiresConfirmation).map((d) => [d.key, d.requested])),
  }
}

export function authzHasHighRisk(diffs: CapabilityDiffWire[]): boolean {
  // review minor:按需确认项的**完整 requested 集**判(不只 added)—— 已授权 process:spawn、
  // 本次只新增低风险,确认的完整集合仍含高风险,警示不可少。
  return diffs.some((d) => d.requiresConfirmation && d.requested.some((c) => HIGH_RISK.has(c)))
}

/** 是否扩权场景(任一需确认项已有授权基线)——决定标题/intro/主按钮文案(Q1 场景化)。 */
export function authzIsEscalation(diffs: CapabilityDiffWire[]): boolean {
  return diffs.some((d) => d.requiresConfirmation && d.previous !== null)
}

export type ExtAuthzDialogState = {
  name: string
  isBundle: boolean
  mode: "install" | "update"
  diffs: CapabilityDiffWire[]
}

/** Production standalone host for #348 direct-install/update authorization transitions. */
export function ExtStandaloneAuthzDialog(props: {
  state: ExtAuthzDialogState | null
  busy: boolean
  onCancel: () => void
  onConfirm: () => void
  restoreFocus?: DialogRestoreFocus
}) {
  const title = () => {
    const state = props.state
    if (!state) return t("alpha.ext.authz.titleFirst")
    return authzIsEscalation(state.diffs) ? t("alpha.ext.authz.titleEscalation") : t("alpha.ext.authz.titleFirst")
  }
  return (
    <Dialog
      open={!!props.state}
      onClose={props.onCancel}
      dismissible={!props.busy}
      busy={props.busy}
      besideSidebar
      size="sm"
      title={title()}
      restoreFocus={props.restoreFocus}
      footer={
        <>
          <Button variant="ghost" autofocus disabled={props.busy} onClick={props.onCancel}>
            {t("alpha.ext.cancel")}
          </Button>
          <Button variant="primary" loading={props.busy} onClick={props.onConfirm}>
            {props.state?.mode === "update" ? t("alpha.ext.authz.confirmUpdate") : t("alpha.ext.authz.confirmInstall")}
          </Button>
        </>
      }
    >
      <Show when={props.state}>
        {(state) => (
          <ExtAuthzView name={state().name} isBundle={state().isBundle} mode={state().mode} diffs={state().diffs} />
        )}
      </Show>
    </Dialog>
  )
}

type CapRowKind = "new" | "granted" | "removed"

function capRows(diff: CapabilityDiffWire): Array<{ cap: string; kind: CapRowKind }> {
  const added = new Set(diff.added)
  const rows: Array<{ cap: string; kind: CapRowKind }> = diff.requested.map((cap) => ({
    cap,
    kind: added.has(cap) ? "new" : "granted",
  }))
  for (const cap of diff.removed) rows.push({ cap, kind: "removed" })
  return rows
}

/** 事务 item key(`<kind>--<name>`)→ 展示名。识别失败原样展示(key 无查找语义,只为可读)。 */
function itemLabel(key: string): string {
  const idx = key.indexOf("--")
  return idx > 0 ? key.slice(idx + 2) : key
}

function CapRow(props: { cap: string; kind: CapRowKind }) {
  const vocab = () => CAP_VOCAB[props.cap]
  // 风险标识跟随能力本身(新增与已授权都标;将收回不标)—— review minor:高风险不因「已授权」而隐身。
  const tier = () => (props.kind === "removed" ? "low" : (vocab()?.tier ?? "mid"))
  const chipKey = () =>
    props.kind === "new" ? "alpha.ext.authz.chipNew" : props.kind === "granted" ? "alpha.ext.authz.chipGranted" : "alpha.ext.authz.chipRemoved"
  return (
    <div class="alpha-ext-authz-cap" data-muted={props.kind !== "new" ? "" : undefined}>
      <span class="alpha-ext-authz-ic" data-tier={tier()}>
        <Show when={vocab()} fallback={<span aria-hidden="true">?</span>}>
          {vocab()!.icon()}
        </Show>
      </span>
      <span class="alpha-ext-authz-nm">
        <b>
          <Show when={props.kind === "removed"} fallback={vocab() ? t(vocab()!.label) : props.cap}>
            <s>{vocab() ? t(vocab()!.label) : props.cap}</s>
          </Show>
        </b>
        <Show when={vocab()}>
          <small>{t(vocab()!.desc)}</small>
        </Show>
      </span>
      <span class="alpha-ext-authz-id">{props.cap}</span>
      <Show when={props.kind !== "removed" && HIGH_RISK.has(props.cap)}>
        <span class="alpha-ext-authz-chip" data-kind="risk">
          {t("alpha.ext.authz.riskHigh")}
        </span>
      </Show>
      <span class="alpha-ext-authz-chip" data-kind={props.kind}>
        {t(chipKey())}
      </span>
    </div>
  )
}

/** #392(REQ-103):详情页「已授权能力」被动行 —— 与确认框同一词汇/图标/风险分级(两处永远一致),
 *  但无 diff chip、无 muted:这是授权总账的查询面,变更仍只经上方确认框发生。
 *  #396(REQ-104):subtitle 可选覆盖说明行(Pack 整包事实用它标注「来自:<子项>」)。 */
export function ExtGrantedCapRow(props: { cap: string; subtitle?: string }) {
  const vocab = () => CAP_VOCAB[props.cap]
  return (
    <div class="alpha-ext-authz-cap">
      <span class="alpha-ext-authz-ic" data-tier={vocab()?.tier ?? "mid"}>
        <Show when={vocab()} fallback={<span aria-hidden="true">?</span>}>
          {vocab().icon()}
        </Show>
      </span>
      <span class="alpha-ext-authz-nm">
        <b>{vocab() ? t(vocab().label) : props.cap}</b>
        <Show when={props.subtitle} fallback={<Show when={vocab()}><small>{t(vocab().desc)}</small></Show>}>
          <small>{props.subtitle}</small>
        </Show>
      </span>
      <span class="alpha-ext-authz-id">{props.cap}</span>
      <Show when={HIGH_RISK.has(props.cap)}>
        <span class="alpha-ext-authz-chip" data-kind="risk">
          {t("alpha.ext.authz.riskHigh")}
        </span>
      </Show>
    </div>
  )
}

/** 授权视图 body(宿主 Dialog 由 hub 提供:独立弹出或既有确认框第二阶段)。 */
export function ExtAuthzView(props: { name: string; isBundle: boolean; mode: "install" | "update"; diffs: CapabilityDiffWire[] }) {
  const confirmDiffs = () => props.diffs.filter((d) => d.requiresConfirmation)
  // review minor:纯收缩项(无需确认但 removed 非空)也展开 —— 「将收回」是用户该看到的事实,
  // 不得计进「能力无变化」;折叠行只数真正无任何变化的项。
  const shownDiffs = () => props.diffs.filter((d) => d.requiresConfirmation || d.removed.length > 0)
  const restCount = () => props.diffs.length - shownDiffs().length
  const escalation = () => authzIsEscalation(props.diffs)
  // review minor:escalation 只由 diff 判(previous 非 null);更新但盘上无基线(旧安装普遍无
  // grants.json)不是「首次安装」—— 按 mode 给中性文案,避免与「授权并更新」按钮自相矛盾。
  const intro = () =>
    props.isBundle
      ? t("alpha.ext.authz.introBundle", { name: props.name, n: String(confirmDiffs().length) })
      : escalation()
        ? t("alpha.ext.authz.introEscalation", { name: props.name })
        : props.mode === "update"
          ? t("alpha.ext.authz.introUpdate", { name: props.name })
          : t("alpha.ext.authz.introFirst", { name: props.name })
  // 阶段切换用 aria-live 通告(内容非纯色分层:chip 均带文字,收回项另有删除线)。
  return (
    <div class="alpha-ext-authz" aria-live="polite">
      <p class="alpha-ext-authz-intro">{intro()}</p>
      <div class="alpha-ext-authz-box">
        <For each={shownDiffs()}>
          {(diff) => (
            <>
              <Show when={props.isBundle}>
                <div class="alpha-ext-authz-item">{itemLabel(diff.key)}</div>
              </Show>
              <For each={capRows(diff)}>{(row) => <CapRow cap={row.cap} kind={row.kind} />}</For>
            </>
          )}
        </For>
        <Show when={props.isBundle && restCount() > 0}>
          <div class="alpha-ext-authz-rest">{t("alpha.ext.authz.bundleRest", { n: String(restCount()) })}</div>
        </Show>
      </div>
      <Show when={authzHasHighRisk(props.diffs)}>
        <p class="alpha-ext-confirm-risk">{t("alpha.ext.authz.riskLine")}</p>
      </Show>
      <p class="alpha-ext-confirm-note">{t("alpha.ext.authz.note")}</p>
    </div>
  )
}
