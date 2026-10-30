// Cloud job lifecycle shared by the legacy cloud entry box and the catalog-described form (REQ-235,
// baseline §2.4 / R1-7). Mechanically extracted from cloud-dispatch-box.tsx: subscription, terminal
// handling, run saving, the three-way cancel and the dispatch error mapping. Behaviour of the legacy
// branches is frozen by cloud-dispatch-box.test.ts, written before this extraction.

import { onCleanup } from "solid-js"
import { t } from "../i18n"
import type { CloudDispatchResult, CloudJobEnvelope } from "../../preload/types"
import { failureCodeFromEvent, failureCopy } from "./cloud-failure-copy"

export type CloudJobPhase = "idle" | "dispatching" | "running" | "done" | "failed"
// #400(REQ-109 AC4 桌面半场)取消子状态。"cancelling" 只在拿到服务端可判定结果
// (CloudJobCancelResultV1)之后进入;它是「已受理未终结」,**不是** cancelled —— 终态永远由
// SSE 的 job.cancelled/completed/failed 驱动 finish,本地绝不乐观改写。
export type CloudCancelState = "none" | "requesting" | "cancelling" | "rejected"

export type CloudJobState = {
  phase: CloudJobPhase
  err: string
  errAction: NonNullable<ReturnType<typeof failureCopy>>["action"]
  jobId: string
  step: string
  cancel: CloudCancelState
  savedDir: string
  transparent: boolean
  result: string
  files: string[]
}

// [#918] 云端拒收带分类码(main 的 alpha-cloud-jobs 只透传 `code` 槽)。两条会真实发生在
// 用户面前的,给出诚实说明而不是把一个裸码贴在错误行里 —— 前者告诉用户「要的限制强制不了」,
// 后者告诉用户「作业没送出去,因为送出去也是白跑」。其它码只影响显示，保留原始返回值供诊断。
// REQ-235:目录描述的能力与平台注册表不同步时(签名目录比注册表新或旧),平台拒收为
// `unknown_pipeline_kind` / `pipeline_input_invalid` —— 用户能做的只有刷新或更新,照实说。
export function dispatchError(code: string, fallback: Parameters<typeof t>[0] = "alpha.ext.cloudUnknownSend"): string {
  const failure = failureCopy(code)
  if (failure) return failure.text
  if (code === "no-cloud-endpoint") return t("alpha.ext.cloudErrEndpoint")
  if (code === "network") return t("alpha.ext.cloudErrNetwork")
  if (code === "denied_paths_unenforceable_for_execution_form") return t("alpha.ext.cloudErrDeniedPaths")
  if (code === "tools-not-declared") return t("alpha.ext.cloudErrToolsUndeclared")
  if (code === "pipeline_input_invalid" || code === "unknown_pipeline_kind") return t("alpha.ext.cloudErrRequirementsChanged")
  if (code.startsWith("envelope-too-large:")) return t("alpha.ext.cloudEnvelopeLarge")
  if (code.startsWith("secrets-detected:")) return t("alpha.ext.cloudSecretsDetected", { fields: code.slice("secrets-detected: ".length).split(" —— ")[0] })
  return t(fallback)
}

/** Must be created inside a component: it registers the subscription cleanup on the owner. */
export function createCloudJobLifecycle(input: {
  state: CloudJobState
  patch: (patch: Partial<CloudJobState>) => void
  pipelineKind: () => string
}) {
  const state = input.state
  const setState = input.patch
  let unlisten: (() => void) | undefined

  onCleanup(() => {
    unlisten?.()
    if (state.jobId) void window.api.cloud.unsubscribe(state.jobId)
  })

  const finish = async (directory: string, id: string, terminal: string, contract: CloudJobEnvelope, code?: string) => {
    if (input.pipelineKind() !== "code-review" && terminal === "job.completed") {
      const status = await window.api.cloud.status(id)
      if (!("job_id" in status)) {
        setState({ phase: "failed", err: dispatchError(status.error), errAction: failureCopy(status.error)?.action ?? null })
        return
      }
      const result = status.result
      const text = result && typeof result === "object"
        ? ("finalAnswer" in result ? result.finalAnswer : "docs" in result ? result.docs : undefined)
        : result
      setState({ result: typeof text === "string" ? text : "" })
    }
    const reason = terminal === "job.completed"
      ? undefined
      : code ?? failureCodeFromEvent({ data: await window.api.cloud.status(id) })
    const saved = await window.api.cloud.saveRun(directory, id, contract)
    if (saved.ok) {
      // #1551 AC2:列表 / 下载 / 登记任一失败,任务虽已完成也不报「完成」。
      const incomplete = saved.failures.length > 0
      setState({ savedDir: saved.dir, phase: terminal === "job.completed" && !incomplete ? "done" : "failed", errAction: null })
      if (input.pipelineKind() !== "code-review") {
        setState({ files: saved.files.filter((file) => file.startsWith("artifacts/")), err: saved.warnings.join("\n") })
      }
      if (terminal !== "job.completed") {
        const failure = failureCopy(reason ?? "")
        setState({ err: failure?.text ?? t("alpha.ext.cloudRunFailed"), errAction: failure?.action ?? null })
        return
      }
      if (incomplete) setState({ err: t("alpha.ext.cloudSaveFailed") })
      return
    }
    setState({ phase: "failed", err: t("alpha.ext.cloudSaveFailed"), errAction: null })
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
      cancel: "none",
      transparent,
      err: "",
      errAction: null,
      savedDir: "",
      result: "",
      files: [],
    })
    unlisten?.()
    unlisten = window.api.cloud.onEvent((payload) => {
      if (payload.jobId !== job.job_id) return
      const messageType =
        payload.data && typeof payload.data === "object" && "type" in payload.data
          ? payload.data.type
          : undefined
      const name = payload.event === "message" && typeof messageType === "string" ? messageType : payload.event
      if (name && name !== "job.snapshot") setState({ step: name })
      if (["job.completed", "job.failed", "job.cancelled"].includes(name)) {
        void finish(directory, job.job_id, name, contract, failureCodeFromEvent(payload))
      }
    })
    await window.api.cloud.subscribe(job.job_id)
  }

  // #400:取消请求。可判定结果三分:①受理/已在取消途中 → 显示「正在取消」,等 SSE 终态;
  // ②服务端明确拒绝(accepted=false 且不在取消途中,即已终态)→ 行内说明,不改运行显示;
  // ③传输/契约失败 → 行内错误,取消入口保持可用。任何分支都不把本地状态改成 cancelled。
  const cancelJob = async () => {
    if (!state.jobId || state.cancel === "requesting" || state.cancel === "cancelling") return
    setState({ cancel: "requesting", err: "", errAction: null })
    const result = await window.api.cloud.cancel(state.jobId)
    if ("error" in result) {
      setState({ cancel: "none", err: dispatchError(result.error, "alpha.ext.cloudUnknownCancel"), errAction: failureCopy(result.error)?.action ?? null })
      return
    }
    if (result.accepted || result.status === "cancelling" || result.status === "cancelled") {
      setState({ cancel: "cancelling" })
      return
    }
    setState({ cancel: "rejected", err: t("alpha.ext.cloudCancelRejected") })
  }

  return { beginJob, cancelJob }
}
