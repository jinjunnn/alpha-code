// Code-review cloud entry. Explicit file upload is main-owned and conditionally consented; the
// existing input.diff route remains available as a grandfathered secondary action.

import { onCleanup, Show } from "solid-js"
import { createStore } from "solid-js/store"
import { t } from "../i18n"
import { pushToast } from "../alpha-ui/Toast"
import type {
  CloudDispatchResult,
  CloudJobEnvelope,
  CloudUploadResult,
  UploadPreview,
} from "../../preload/types"
import type { CloudPipelineSpec } from "./catalog-types"
import { UploadConsentDialog } from "./upload-consent-dialog"

type Phase = "idle" | "dispatching" | "running" | "done" | "failed"
type ConsentState = { requestId: string; preview: UploadPreview }

// [#918] 云端拒收带分类码(main 的 alpha-cloud-jobs 只透传 `code` 槽)。两条会真实发生在
// 用户面前的,给出诚实说明而不是把一个裸码贴在错误行里 —— 前者告诉用户「要的限制强制不了」,
// 后者告诉用户「作业没送出去,因为送出去也是白跑」。其余码保持原样透出,不假装认识。
function dispatchError(code: string): string {
  if (code === "not-authenticated" || code === "unauthorized") return t("alpha.ext.cloudErrAuth")
  if (code === "no-cloud-endpoint") return t("alpha.ext.cloudErrEndpoint")
  if (code === "network") return t("alpha.ext.cloudErrNetwork")
  if (code === "denied_paths_unenforceable_for_execution_form") return t("alpha.ext.cloudErrDeniedPaths")
  if (code === "tools-not-declared") return t("alpha.ext.cloudErrToolsUndeclared")
  return code
}

function uploadError(code: Extract<CloudUploadResult, { status: "failed" }>["error"]) {
  if (code === "not-authenticated") return t("alpha.ext.cloudErrAuth")
  if (code === "upload-file-limit") return t("alpha.cloud.consent.errFileLimit")
  if (code === "upload-size-limit") return t("alpha.cloud.consent.errSizeLimit")
  if (code === "upload-control-limit") return t("alpha.cloud.consent.errControlLimit")
  if (code === "upload-not-text") return t("alpha.cloud.consent.errText")
  if (code === "upload-consent-issuance-failed" || code === "upload-consent-invalid") {
    return t("alpha.cloud.consent.errToken")
  }
  if (code === "upload-dispatch-failed") return t("alpha.cloud.consent.errDispatch")
  return t("alpha.cloud.consent.errScope")
}

export function CloudDispatchBox(props: { spec: CloudPipelineSpec; ready: boolean }) {
  const [state, setState] = createStore<{
    phase: Phase
    err: string
    jobId: string
    step: string
    diffSource: "worktree" | "last-commit" | null
    savedDir: string
    transparent: boolean
    consent: ConsentState | null
    consentBusy: boolean
  }>({
    phase: "idle",
    err: "",
    jobId: "",
    step: "",
    diffSource: null,
    savedDir: "",
    transparent: false,
    consent: null,
    consentBusy: false,
  })
  let triggerButton: HTMLButtonElement | undefined
  let unlisten: (() => void) | undefined

  onCleanup(() => {
    unlisten?.()
    if (state.jobId) void window.api.cloud.unsubscribe(state.jobId)
    if (state.consent) void window.api.cloud.cancelUpload(state.consent.requestId)
  })

  const finish = async (directory: string, id: string, terminal: string, contract: CloudJobEnvelope) => {
    const saved = await window.api.cloud.saveRun(directory, id, contract)
    if (saved.ok) {
      setState({ savedDir: saved.dir, phase: terminal === "job.completed" ? "done" : "failed" })
      if (terminal !== "job.completed") setState("err", t("alpha.ext.cloudRunFailed"))
      return
    }
    setState({ phase: "failed", err: `${t("alpha.ext.cloudSaveFailed")}: ${saved.reason}` })
  }

  const beginJob = async (
    directory: string,
    job: CloudDispatchResult,
    contract: CloudJobEnvelope,
    transparent: boolean,
  ) => {
    setState({
      phase: "running",
      jobId: job.job_id,
      step: "queued",
      transparent,
      err: "",
      savedDir: "",
      consent: null,
      consentBusy: false,
    })
    unlisten?.()
    unlisten = window.api.cloud.onEvent((payload) => {
      if (payload.jobId !== job.job_id) return
      const messageType =
        payload.data && typeof payload.data === "object" && "type" in payload.data
          ? payload.data.type
          : undefined
      const name = payload.event === "message" && typeof messageType === "string" ? messageType : payload.event
      if (name && name !== "job.snapshot") setState("step", name)
      if (["job.completed", "job.failed", "job.cancelled"].includes(name)) {
        void finish(directory, job.job_id, name, contract)
      }
    })
    await window.api.cloud.subscribe(job.job_id)
  }

  const consumeUpload = async (result: CloudUploadResult) => {
    if (result.status === "cancelled") {
      setState({ phase: "idle", consent: null, consentBusy: false })
      return
    }
    if (result.status === "failed") {
      setState({ phase: "failed", err: uploadError(result.error), consent: null, consentBusy: false })
      return
    }
    if (result.status === "consent-required") {
      setState({ phase: "idle", consent: result, consentBusy: false })
      return
    }
    pushToast({ kind: "success", title: t("alpha.cloud.consent.toastSent") })
    await beginJob(
      result.directory,
      result.job,
      { autonomy: "pipeline", kind: "code-review", input: {} },
      result.privacy === "clear",
    )
  }

  const runUpload = async () => {
    setState({ phase: "dispatching", err: "", savedDir: "", diffSource: null, transparent: false })
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
    setState({ err: "", savedDir: "", diffSource: null, transparent: false })
    const picked = await window.api.openDirectoryPicker({ title: t("alpha.ext.cloudPickProject") })
    const directory = Array.isArray(picked) ? picked[0] : picked
    if (!directory) return
    setState("phase", "dispatching")
    const diff = await window.api.cloud.gitDiff(directory)
    if (!diff.ok) {
      setState({ err: diff.reason === "no-diff" ? t("alpha.ext.cloudNoDiff") : diff.reason, phase: "failed" })
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
      setState({ err: dispatchError(result.error), phase: "failed" })
      return
    }
    await beginJob(directory, result, envelope, false)
  }

  const busy = () => state.phase === "dispatching" || state.phase === "running"

  return (
    <div class="alpha-ext-dsub">
      <div class="alpha-ext-dsub-t">{t("alpha.ext.cloudDispatchTitle")}</div>
      <p class="alpha-ext-dnote">{t("alpha.cloud.consent.uploadHint")}</p>
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
        </Show>
        <button class="alpha-ext-add" disabled={!props.ready || busy()} onClick={() => void runLegacyDiff()}>
          {t("alpha.cloud.consent.legacyDiff")}
        </button>
        <Show when={!props.ready}>
          <span class="alpha-ext-meta">{t("alpha.ext.cloudNeedPlatformNote")}</span>
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
          <span class="alpha-ext-meta" data-live="">{state.jobId} · {state.step}</span>
        </Show>
      </div>
      <Show when={state.phase === "done"}>
        <p class="alpha-ext-dnote" data-ok="">
          ✓ {t("alpha.ext.cloudDone")} · <code class="alpha-ext-dcode">{state.savedDir}</code>
        </p>
      </Show>
      <Show when={state.err}>
        <p class="alpha-ext-card-err">{state.err}</p>
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
