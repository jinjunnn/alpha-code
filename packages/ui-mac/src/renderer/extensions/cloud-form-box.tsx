// REQ-235 C1:按签名目录里的 `cloud@1` 描述画云能力表单,组 input,走既有 `cloud-dispatch` IPC。
// 表单形状只来自 main 解码过的安全视图(`CatalogPackageViewV1.cloud`);label / help / upstreamData
// 只作文本节点(I4);fixed 不渲染、不可改,派发时从签名载荷并入(I5)。任务生命周期(订阅、终态、
// 落盘、取消)与 legacy 云条目共用 cloud-job-lifecycle.ts。客户端门控只是体验,不是安全边界 ——
// 服务端按同一张注册表再判一次(I1)。

import { For, Show } from "solid-js"
import { createStore } from "solid-js/store"
import { t } from "../i18n"
import { CopyButton } from "../alpha-ui/CopyButton"
import type { CloudJobEnvelope } from "../../preload/types"
import type { CloudBehaviorV1, CloudFieldV1 } from "../../shared/host-extension-package-contract/decoder"
import { failureCopy } from "./cloud-failure-copy"
import { createCloudJobLifecycle, dispatchError, type CloudJobState } from "./cloud-job-lifecycle"

export function CloudFormBox(props: { cloud: CloudBehaviorV1; ready: boolean; recovering?: boolean }) {
  const [state, setState] = createStore<CloudJobState & { values: Record<string, string> }>({
    phase: "idle",
    err: "",
    errAction: null,
    jobId: "",
    step: "",
    cancel: "none",
    savedDir: "",
    transparent: false,
    result: "",
    files: [],
    values: Object.fromEntries(
      props.cloud.fields.map((field) => [field.name, field.control === "select" ? (field.default ?? "") : ""]),
    ),
  })
  const lifecycle = createCloudJobLifecycle({
    state,
    patch: (patch) => setState(patch),
    pipelineKind: () => props.cloud.pipelineKind,
  })
  const busy = () => state.phase === "dispatching" || state.phase === "running"
  // 文本按服务端口径 trim 后计(注册表 minChars 是 trim 后的长度);select 原样。
  const valueOf = (field: CloudFieldV1) =>
    field.control === "select" ? (state.values[field.name] ?? "") : (state.values[field.name] ?? "").trim()
  const satisfied = (field: CloudFieldV1) => {
    const value = valueOf(field)
    if (!value) return !field.required
    if (field.control === "select") return field.options.some((option) => option.value === value)
    return value.length >= (field.minChars ?? 0) && value.length <= field.maxChars
  }

  const run = async () => {
    // 键集恰是 fixed ∪ fields 的 name;没填的可选字段不发(空串会撞注册表的长度/枚举约束)。
    const input = {
      ...Object.fromEntries(props.cloud.fixed.map((entry) => [entry.name, entry.value])),
      ...Object.fromEntries(
        props.cloud.fields.flatMap((field) => {
          const value = valueOf(field)
          return value ? [[field.name, value]] : []
        }),
      ),
    }
    setState({ phase: "dispatching", err: "", errAction: null, savedDir: "", result: "", files: [] })
    const picked = await window.api.openDirectoryPicker({ title: t("alpha.ext.cloudPickResults") })
    const directory = Array.isArray(picked) ? picked[0] : picked
    if (!directory) {
      setState({ phase: "idle" })
      return
    }
    // 不带 budget:信封里可选,服务端缺省并按策略 clamp。
    const envelope: CloudJobEnvelope = {
      autonomy: "pipeline",
      kind: props.cloud.pipelineKind,
      input,
      constraints: { network: "restricted" },
    }
    const result = await window.api.cloud.dispatch(envelope)
    if ("error" in result) {
      setState({ phase: "failed", err: dispatchError(result.error, undefined, result.netLayer), errAction: failureCopy(result.error)?.action ?? null })
      return
    }
    await lifecycle.beginJob(directory, result, envelope, false)
  }

  return (
    <div class="alpha-ext-dsub" data-cloud-form={props.cloud.pipelineKind}>
      <div class="alpha-ext-dsub-t">{t("alpha.ext.cloudDispatchTitle")}</div>
      <p class="alpha-ext-dnote">{t("alpha.ext.cloudInputHint")}</p>
      <div class="alpha-ext-dsub">
        <div class="alpha-ext-dsub-t">{t("alpha.ext.cloudUpstream")}</div>
        <ul class="alpha-ext-dlist" data-cloud-upstream="">
          <For each={props.cloud.upstreamData}>{(line) => <li>{line}</li>}</For>
        </ul>
      </div>
      <p class="alpha-ext-dnote" data-cloud-hold="">
        {t("alpha.ext.cloudHold", { usd: props.cloud.holdUsd.toFixed(2) })}
      </p>
      <div class="alpha-ext-cloudrun">
        <For each={props.cloud.fields}>
          {(field) => (
            <label style={{ width: "100%" }} data-cloud-field={field.name}>
              <span data-cloud-field-label="">
                {field.label}
                {field.required ? " *" : ""}
              </span>
              <Show when={field.help}>{(help) => <span class="alpha-ext-meta" data-cloud-field-help="">{help()}</span>}</Show>
              {field.control === "select" ? (
                <select
                  aria-label={field.label}
                  disabled={!props.ready || busy()}
                  onChange={(event) => setState("values", field.name, event.currentTarget.value)}
                >
                  {/* 没有预选项时留一个空选项:必填 ⇒ 用户必须自己选;可选 ⇒ 空 = 不发这个键。 */}
                  <Show when={!field.default}>
                    <option value="" selected={!state.values[field.name]} />
                  </Show>
                  <For each={field.options}>
                    {(option) => (
                      <option value={option.value} selected={state.values[field.name] === option.value}>
                        {option.label}
                      </option>
                    )}
                  </For>
                </select>
              ) : field.control === "textarea" ? (
                <textarea
                  class="alpha-ext-ddoc"
                  style={{ width: "100%" }}
                  rows={6}
                  aria-label={field.label}
                  maxlength={field.maxChars}
                  value={state.values[field.name] ?? ""}
                  disabled={!props.ready || busy()}
                  onInput={(event) => setState("values", field.name, event.currentTarget.value)}
                />
              ) : (
                <input
                  type="text"
                  style={{ width: "100%" }}
                  aria-label={field.label}
                  maxlength={field.maxChars}
                  value={state.values[field.name] ?? ""}
                  disabled={!props.ready || busy()}
                  onInput={(event) => setState("values", field.name, event.currentTarget.value)}
                />
              )}
            </label>
          )}
        </For>
        <button
          class="alpha-ext-add"
          data-variant="primary"
          data-cloud-form-submit=""
          disabled={!props.ready || busy() || !props.cloud.fields.every(satisfied)}
          onClick={() => void run()}
        >
          {t(state.phase === "dispatching" ? "alpha.ext.cloudDispatching" : state.phase === "running" ? "alpha.ext.cloudRunning" : "alpha.ext.cloudStart")}
        </button>
        <Show when={!props.ready}>
          <span class="alpha-ext-meta">
            {props.recovering ? t("alpha.ext.cloudRecoveringNote") : t("alpha.ext.cloudNeedPlatformNote")}
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
            onClick={() => void lifecycle.cancelJob()}
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
    </div>
  )
}
