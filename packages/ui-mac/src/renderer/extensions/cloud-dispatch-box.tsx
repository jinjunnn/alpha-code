// Cloud pipeline entries. Explicit code-review file upload is main-owned and conditionally consented; the
// existing input.diff route remains available as a grandfathered secondary action.

import { For, onCleanup, Show } from "solid-js"
import { createStore } from "solid-js/store"
import { t } from "../i18n"
import { pushToast } from "../alpha-ui/Toast"
import { CopyButton } from "../alpha-ui/CopyButton"
import type {
  CloudJobEnvelope,
  CloudUploadResult,
  UploadPreview,
} from "../../preload/types"
import type { CloudPipelineSpec } from "./catalog-types"
import { UploadConsentDialog } from "./upload-consent-dialog"
import { failureCopy } from "./cloud-failure-copy"
import { createCloudJobLifecycle, dispatchError, type CloudJobState } from "./cloud-job-lifecycle"

type ConsentState = { requestId: string; preview: UploadPreview }

function uploadError(code: Extract<CloudUploadResult, { status: "failed" }>["error"]) {
  if (code === "not-authenticated") return t("alpha.ext.cloudErrAuth")
  if (code === "upload-file-limit") return t("alpha.cloud.consent.errFileLimit")
  if (code === "upload-size-limit") return t("alpha.cloud.consent.errSizeLimit")
  if (code === "upload-control-limit") return t("alpha.cloud.consent.errControlLimit")
  if (code === "upload-not-text") return t("alpha.cloud.consent.errText")
  if (code === "upload-consent-issuance-failed" || code === "upload-consent-invalid") {
    return t("alpha.cloud.consent.errToken")
  }
  // [#940] 本地准入面的其余码 = 范围问题。判据是**结构**的,不手抄名单:本地准入码全是
  // `upload-` 前缀 kebab(UploadErrorCode,alpha-upload-manifest.ts),而平台分类码的文法
  // /^[a-z][a-z0-9_]{2,63}$/(platform-error-code.ts)不含连字符 —— 两个域在这个前缀上
  // 不相交,新增本地准入码自动落回这里,不会静默漏出一份手抄清单。
  if (code.startsWith("upload-")) return t("alpha.cloud.consent.errScope")
  // 派发腿不再坍缩成 "upload-dispatch-failed":到这里的是平台分类码(upload_reserved_input …)
  // 或 unauthorized / network / http-<status> 回退,与 dispatch 面同一呈现纪律 ——
  // 已知码说明原因，未知结果提示先核对任务状态。
  return dispatchError(code, "alpha.ext.cloudUnknownUpload")
}

/** `#624`:`ready` 是**放行**判据(恢复中为 false);`recovering` 只改那句「为什么不能点」——
 *  恢复中说「需登录平台模式」是假话,用户已经登录了。 */
export function CloudDispatchBox(props: { entryId?: string; spec: CloudPipelineSpec; ready: boolean; recovering?: boolean }) {
  const [state, setState] = createStore<CloudJobState & {
    diffSource: "worktree" | "last-commit" | null
    consent: ConsentState | null
    consentBusy: boolean
    input: string
  }>({
    phase: "idle",
    err: "",
    errAction: null,
    jobId: "",
    step: "",
    cancel: "none",
    diffSource: null,
    savedDir: "",
    transparent: false,
    consent: null,
    consentBusy: false,
    input: "",
    result: "",
    files: [],
  })
  let triggerButton: HTMLButtonElement | undefined
  const lifecycle = createCloudJobLifecycle({
    state,
    patch: (patch) => setState(patch),
    pipelineKind: () => props.spec.pipelineKind,
  })
  const beginJob = lifecycle.beginJob
  const cancelJob = lifecycle.cancelJob

  onCleanup(() => {
    if (state.consent) void window.api.cloud.cancelUpload(state.consent.requestId)
  })

  const consumeUpload = async (result: CloudUploadResult) => {
    if (result.status === "cancelled") {
      setState({ phase: "idle", consent: null, consentBusy: false })
      return
    }
    if (result.status === "failed") {
      setState({ phase: "failed", err: uploadError(result.error), errAction: failureCopy(result.error)?.action ?? null, consent: null, consentBusy: false })
      return
    }
    if (result.status === "consent-required") {
      setState({ phase: "idle", consent: result, consentBusy: false })
      return
    }
    pushToast({ kind: "success", title: t("alpha.cloud.consent.toastSent") })
    // beginJob 曾在同一次 setState 里清掉 consent;它住进共享生命周期后,这两格归本组件自己清。
    setState({ consent: null, consentBusy: false })
    await beginJob(
      result.directory,
      result.job,
      { autonomy: "pipeline", kind: "code-review", input: {} },
      result.privacy === "clear",
    )
  }

  const runUpload = async () => {
    setState({ phase: "dispatching", err: "", errAction: null, savedDir: "", diffSource: null, transparent: false })
    await consumeUpload(await window.api.cloud.upload({ kind: "code-review" }))
  }

  const confirmUpload = async () => {
    if (!state.consent || state.consentBusy) return
    const requestId = state.consent.requestId
    setState("consentBusy", true)
    await consumeUpload(await window.api.cloud.confirmUpload(requestId))
  }

  const cancelUpload = () => {
    if (!state.consent || state.consentBusy) return
    const requestId = state.consent.requestId
    setState({ consent: null, consentBusy: false, phase: "idle" })
    void window.api.cloud.cancelUpload(requestId)
  }

  const runLegacyDiff = async () => {
    setState({ err: "", errAction: null, savedDir: "", diffSource: null, transparent: false })
    const picked = await window.api.openDirectoryPicker({ title: t("alpha.ext.cloudPickProject") })
    const directory = Array.isArray(picked) ? picked[0] : picked
    if (!directory) return
    setState("phase", "dispatching")
    const diff = await window.api.cloud.gitDiff(directory)
    if (!diff.ok) {
      setState({ err: diff.reason === "no-diff" ? t("alpha.ext.cloudNoDiff") : t("alpha.ext.cloudDiffReadFailed"), phase: "failed" })
      return
    }
    setState("diffSource", diff.source)
    const envelope: CloudJobEnvelope = {
      autonomy: "pipeline",
      kind: props.spec.pipelineKind,
      input: { diff: diff.diff },
      budget: props.spec.budgetDefaults,
      constraints: { network: "restricted" },
    }
    const result = await window.api.cloud.dispatch(envelope)
    if ("error" in result) {
      setState({ err: dispatchError(result.error), errAction: failureCopy(result.error)?.action ?? null, phase: "failed" })
      return
    }
    await beginJob(directory, result, envelope, false)
  }

  // Office uses three catalog identities, each with an explicit server format.
  const format = () => props.entryId === "cloud:word" ? "docx"
    : props.entryId === "cloud:excel" ? "xlsx"
    : props.entryId === "cloud:powerpoint" ? "pptx" : undefined
  const inputLabel = () => t(props.spec.pipelineKind === "research"
    ? "alpha.ext.cloudQuestion"
    : props.spec.pipelineKind === "docs" ? "alpha.ext.cloudCode" : "alpha.ext.cloudTopic")
  const runInput = async () => {
    const input = props.spec.pipelineKind === "research"
      ? { question: state.input.trim() }
      : props.spec.pipelineKind === "docs"
        ? { code: state.input.trim() }
        : { topic: state.input.trim(), format: format() }
    setState({ phase: "dispatching", err: "", errAction: null, savedDir: "", result: "", files: [] })
    const picked = await window.api.openDirectoryPicker({ title: t("alpha.ext.cloudPickResults") })
    const directory = Array.isArray(picked) ? picked[0] : picked
    if (!directory) {
      setState("phase", "idle")
      return
    }
    const envelope: CloudJobEnvelope = {
      autonomy: "pipeline",
      kind: props.spec.pipelineKind,
      input,
      budget: props.spec.budgetDefaults,
      constraints: { network: "restricted" },
    }
    const result = await window.api.cloud.dispatch(envelope)
    if ("error" in result) {
      setState({ phase: "failed", err: dispatchError(result.error), errAction: failureCopy(result.error)?.action ?? null })
      return
    }
    await beginJob(directory, result, envelope, false)
  }

  const busy = () => state.phase === "dispatching" || state.phase === "running"

  return (
    <div class="alpha-ext-dsub">
      <div class="alpha-ext-dsub-t">{t("alpha.ext.cloudDispatchTitle")}</div>
      <p class="alpha-ext-dnote">{t(props.spec.pipelineKind === "code-review" ? "alpha.cloud.consent.uploadHint" : "alpha.ext.cloudInputHint")}</p>
      <div class="alpha-ext-cloudrun">
        <Show when={props.spec.pipelineKind === "code-review"}>
          <button
            ref={(element) => (triggerButton = element)}
            class="alpha-ext-add"
            data-variant="primary"
            disabled={!props.ready || busy()}
            onClick={() => void runUpload()}
          >
            {state.phase === "dispatching"
              ? t("alpha.ext.cloudDispatching")
              : state.phase === "running"
                ? t("alpha.ext.cloudRunning")
                : t("alpha.cloud.consent.uploadPick")}
          </button>
          <button class="alpha-ext-add" disabled={!props.ready || busy()} onClick={() => void runLegacyDiff()}>
            {t("alpha.cloud.consent.legacyDiff")}
          </button>
        </Show>
        <Show when={props.spec.pipelineKind !== "code-review"}>
          <label style={{ width: "100%" }}>
            {inputLabel()}
            <textarea class="alpha-ext-ddoc" style={{ width: "100%" }} rows={6} aria-label={inputLabel()} value={state.input}
              disabled={!props.ready || busy()} onInput={(event) => setState("input", event.currentTarget.value)} />
          </label>
          <button class="alpha-ext-add" data-variant="primary" data-cloud-input=""
            disabled={!props.ready || busy() || !state.input.trim() || (props.spec.pipelineKind === "office-report" && !format())}
            onClick={() => void runInput()}>
            {t(state.phase === "dispatching" ? "alpha.ext.cloudDispatching" : state.phase === "running" ? "alpha.ext.cloudRunning" : "alpha.ext.cloudStart")}
          </button>
        </Show>
        <Show when={!props.ready}>
          <span class="alpha-ext-meta">
            {props.recovering ? t("alpha.ext.cloudRecoveringNote") : t("alpha.ext.cloudNeedPlatformNote")}
          </span>
        </Show>
        <Show when={state.transparent}>
          <span class="alpha-ext-meta" data-live="">{t("alpha.cloud.consent.silentPass")}</span>
        </Show>
        <Show when={state.diffSource}>
          <span class="alpha-ext-meta">
            {t("alpha.ext.cloudDiffSource")}:
            {state.diffSource === "worktree" ? t("alpha.ext.cloudDiffWorktree") : t("alpha.ext.cloudDiffLastCommit")}
          </span>
        </Show>
        <Show when={state.phase === "running"}>
          <span class="alpha-ext-meta" data-live="">{t(state.step === "queued" ? "alpha.ext.cloudQueued" : state.step === "job.completed" ? "alpha.ext.cloudCompleted" : state.step === "job.failed" ? "alpha.ext.cloudFailed" : state.step === "job.cancelled" ? "alpha.ext.cloudCancelled" : "alpha.ext.cloudProgress")}</span>
        </Show>
        <Show when={state.phase === "running" && state.cancel !== "cancelling"}>
          <button
            class="alpha-ext-add"
            data-cancel-job=""
            disabled={state.cancel === "requesting"}
            onClick={() => void cancelJob()}
          >
            {t("alpha.ext.cloudCancel")}
          </button>
        </Show>
        <Show when={state.phase === "running" && state.cancel === "cancelling"}>
          <span class="alpha-ext-meta" data-live="" data-cancelling="">{t("alpha.ext.cloudCancelling")}</span>
        </Show>
      </div>
      <Show when={state.phase === "done"}>
        <p class="alpha-ext-dnote" data-ok="">
          ✓ {t("alpha.ext.cloudDone")} · <code class="alpha-ext-dcode">{state.savedDir}</code>
        </p>
      </Show>
      <Show when={state.result}>
        <pre class="alpha-ext-ddoc" data-cloud-result="">{state.result}</pre>
        <CopyButton label={t("alpha.wb.copy")} text={() => state.result} dataAttr="data-copy-cloud-result" />
      </Show>
      <For each={state.files}>
        {(file) => <button class="alpha-ext-add" data-cloud-file="" onClick={() => void window.api.openPath(`${state.savedDir}/${file}`)}>{file}</button>}
      </For>
      <Show when={state.err}>
        <p class="alpha-ext-card-err">{state.err}</p>
        <Show when={state.errAction}>
          {(action) => (
            <button class="alpha-ext-add" data-cloud-error-action="" onClick={() => {
              const target = action()
              if (target === "login") {
                void window.api.auth.start()
                return
              }
              void window.api.cloud.openBillingPage(target)
            }}>
              {t(action() === "login" ? "alpha.ext.cloudGoLogin" : action() === "recharge" ? "alpha.ext.cloudGoRecharge" : "alpha.ext.cloudOpenOverflow")}
            </button>
          )}
        </Show>
      </Show>
      <Show when={state.phase === "failed" && state.savedDir}>
        <p class="alpha-ext-dnote">
          {t("alpha.ext.cloudSaved")} <code class="alpha-ext-dcode">{state.savedDir}</code>
        </p>
      </Show>

      <UploadConsentDialog
        state={state.consent}
        busy={state.consentBusy}
        onCancel={cancelUpload}
        onConfirm={() => void confirmUpload()}
        restoreFocus={() => triggerButton}
      />
    </div>
  )
}
