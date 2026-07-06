// REQ-020 T4 —— code-review pipeline 详情页里的 dispatch 入口(diff-only,ADR-021 §1)。
// 流程:选项目目录 → main 侧 git diff(工作树优先,干净树回退最近一次 commit)→ dispatch(经
// ADR-021 §2 三校验,超限/含密钥 loud 拒发行内呈现)→ SSE 进度 → 终态 saveRun 落
// <项目>/.alpha/runs/<jobId>/。app-driven 派发不经会话,cloud-run-watcher(只认 firehose tool
// part)看不见 —— 回流由本组件自己做。离开详情页即取消订阅:任务在云端继续,但不再自动回流
// (可在会话内经 cloud_status/artifacts 取回)—— 如实受限,不装后台常驻。

import { createSignal, onCleanup, Show } from "solid-js"
import { t } from "../i18n"
import type { CloudDispatchResult, CloudJobEnvelope } from "../../preload/types"
import type { CloudPipelineSpec } from "./catalog-types"

type Phase = "idle" | "dispatching" | "running" | "done" | "failed"

// dispatch 错误码 → 人话(guard 的 envelope-too-large/secrets-detected 自带中文说明,原样展示)。
function dispatchError(code: string): string {
  if (code === "not-authenticated" || code === "unauthorized") return t("alpha.ext.cloudErrAuth")
  if (code === "no-cloud-endpoint") return t("alpha.ext.cloudErrEndpoint")
  if (code === "network") return t("alpha.ext.cloudErrNetwork")
  if (code === "consent-declined") return t("alpha.ext.cloudErrConsentDeclined")
  return code
}

export function CloudDispatchBox(props: { spec: CloudPipelineSpec; ready: boolean }) {
  const [phase, setPhase] = createSignal<Phase>("idle")
  const [err, setErr] = createSignal("")
  const [jobId, setJobId] = createSignal("")
  const [step, setStep] = createSignal("")
  const [diffSource, setDiffSource] = createSignal<"worktree" | "last-commit" | null>(null)
  const [savedDir, setSavedDir] = createSignal("")

  let unlisten: (() => void) | undefined
  onCleanup(() => {
    unlisten?.()
    const id = jobId()
    if (id) void window.api.cloud.unsubscribe(id)
  })

  const finish = async (directory: string, id: string, terminal: string, contract: CloudJobEnvelope) => {
    const saved = await window.api.cloud.saveRun(directory, id, contract)
    if (saved.ok) {
      setSavedDir(saved.dir)
      setPhase(terminal === "job.completed" ? "done" : "failed")
      if (terminal !== "job.completed") setErr(t("alpha.ext.cloudRunFailed"))
    } else {
      setPhase("failed")
      setErr(`${t("alpha.ext.cloudSaveFailed")}: ${saved.reason}`)
    }
  }

  const run = async () => {
    setErr("")
    setSavedDir("")
    setDiffSource(null)
    const picked = await window.api.openDirectoryPicker({ title: t("alpha.ext.cloudPickProject") })
    const directory = Array.isArray(picked) ? picked[0] : picked
    if (!directory) return
    setPhase("dispatching")
    const diffR = await window.api.cloud.gitDiff(directory)
    if (!diffR.ok) {
      setErr(diffR.reason === "no-diff" ? t("alpha.ext.cloudNoDiff") : diffR.reason)
      setPhase("failed")
      return
    }
    setDiffSource(diffR.source)
    const envelope: CloudJobEnvelope = {
      autonomy: "pipeline",
      kind: props.spec.pipelineKind,
      input: { diff: diffR.diff },
      budget: props.spec.budgetDefaults,
      // denied_paths 不在此声明 —— 交给 main 侧 guard 缺省注入(ADR-021 §2,单点)。
      constraints: { network: "restricted" },
    }
    const r = await window.api.cloud.dispatch(envelope, directory)
    if ((r as { error?: string }).error) {
      setErr(dispatchError((r as { error: string }).error))
      setPhase("failed")
      return
    }
    const id = (r as CloudDispatchResult).job_id
    setJobId(id)
    setPhase("running")
    setStep("queued")
    unlisten?.()
    unlisten = window.api.cloud.onEvent((p) => {
      if (p.jobId !== id) return
      const name = p.event === "message" ? String((p.data as { type?: string } | null)?.type ?? "") : p.event
      if (name && name !== "job.snapshot") setStep(name)
      if (name === "job.completed" || name === "job.failed" || name === "job.cancelled") {
        void finish(directory, id, name, envelope)
      }
    })
    await window.api.cloud.subscribe(id)
  }

  return (
    <div class="alpha-ext-dsub">
      <div class="alpha-ext-dsub-t">{t("alpha.ext.cloudDispatchTitle")}</div>
      <p class="alpha-ext-dnote">{t("alpha.ext.cloudDispatchHint")}</p>
      <div class="alpha-ext-cloudrun">
        <button
          class="alpha-ext-add"
          data-variant="primary"
          disabled={!props.ready || phase() === "dispatching" || phase() === "running"}
          onClick={() => void run()}
        >
          {phase() === "dispatching"
            ? t("alpha.ext.cloudDispatching")
            : phase() === "running"
              ? t("alpha.ext.cloudRunning")
              : t("alpha.ext.cloudDispatchPick")}
        </button>
        <Show when={!props.ready}>
          <span class="alpha-ext-meta">{t("alpha.ext.cloudNeedPlatformNote")}</span>
        </Show>
        <Show when={diffSource()}>
          <span class="alpha-ext-meta">
            {t("alpha.ext.cloudDiffSource")}:{diffSource() === "worktree" ? t("alpha.ext.cloudDiffWorktree") : t("alpha.ext.cloudDiffLastCommit")}
          </span>
        </Show>
        <Show when={phase() === "running"}>
          <span class="alpha-ext-meta" data-live="">
            {jobId()} · {step()}
          </span>
        </Show>
      </div>
      <Show when={phase() === "done"}>
        <p class="alpha-ext-dnote" data-ok="">
          ✓ {t("alpha.ext.cloudDone")} · <code class="alpha-ext-dcode">{savedDir()}</code>
        </p>
      </Show>
      {/* B11:失败一律行内 */}
      <Show when={err()}>
        <p class="alpha-ext-card-err">{err()}</p>
      </Show>
      <Show when={phase() === "failed" && savedDir()}>
        <p class="alpha-ext-dnote">
          {t("alpha.ext.cloudSaved")} <code class="alpha-ext-dcode">{savedDir()}</code>
        </p>
      </Show>
    </div>
  )
}
