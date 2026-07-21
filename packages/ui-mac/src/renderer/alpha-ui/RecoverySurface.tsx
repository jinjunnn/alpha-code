import { For, Show, createMemo, createSignal } from "solid-js"
import {
  RECOVERY_ACTIONS,
  type RecoveryAction,
  type RecoveryActionResult,
  type RecoveryIncidentWire,
  type RecoveryPlanView,
} from "../../shared/recovery"
import "./recovery-surface.css"

export function RecoverySurface(props: {
  incident?: RecoveryIncidentWire
  pending?: boolean
  unavailable?: boolean
  submit: (incident: string, action: RecoveryAction) => Promise<RecoveryActionResult>
  onApplied?: (result: RecoveryActionResult) => void
  presentation?: "boot" | "overlay"
}) {
  const [submitting, setSubmitting] = createSignal<RecoveryAction>()
  const [status, setStatus] = createSignal<string>()
  const content = createMemo(() => recoveryContent(props.incident?.plan))

  const submit = async (action: RecoveryAction) => {
    const incident = props.incident
    if (!incident || submitting()) return
    setSubmitting(action)
    setStatus("正在执行恢复操作…")
    const result = await props.submit(incident.incident, action).catch(
      (): RecoveryActionResult => ({
        ok: false,
        code: "RECOVERY_ACTION_FAILED",
        action,
        retryable: incident.plan.retryable,
      }),
    )
    setSubmitting(undefined)
    if (!result.ok) {
      setStatus(result.retryable ? "操作未完成，可以重试。" : "操作未完成，请选择其他安全选项。")
      return
    }
    setStatus(result.applied ? "恢复操作已完成。" : "该恢复操作已经完成。")
    props.onApplied?.(result)
  }

  return (
    <section
      class="a-ui a-recovery"
      data-presentation={props.presentation ?? "overlay"}
      data-recovery-code={props.incident?.plan.code ?? "pending"}
      data-recovery-category={props.incident?.plan.category ?? "pending"}
      aria-labelledby="alpha-recovery-title"
    >
      <div class="a-recovery-shell">
        <header class="a-recovery-brand" aria-label="alpha-code">
          <span class="a-recovery-mark" aria-hidden="true">
            α
          </span>
          <span>alpha-code</span>
        </header>
        <main class="a-recovery-main">
          <p class="a-recovery-kicker">RECOVERY</p>
          <h1 id="alpha-recovery-title">
            {props.pending ? "正在准备安全恢复…" : props.unavailable ? "恢复服务暂时不可用" : content().title}
          </h1>
          <p class="a-recovery-summary">
            {props.pending
              ? "正在确认错误记录状态。不会显示或传输路径、密钥和原始错误。"
              : props.unavailable
                ? "为保护当前状态，发生故障的界面会保持隔离。请重新打开应用后再试。"
                : content().summary}
          </p>
          <Show when={!props.pending && !props.unavailable}>
            <div class="a-recovery-card">
              <div class="a-recovery-card-heading">
                <span class="a-recovery-status-dot" aria-hidden="true" />
                <div>
                  <strong>{content().cardTitle}</strong>
                  <p>{content().detail}</p>
                </div>
              </div>
              <Show when={(props.incident?.plan.actions.length ?? 0) > 0}>
                <div class="a-recovery-actions">
                  <For each={props.incident?.plan.actions ?? []}>
                    {(action, index) => (
                      <button
                        type="button"
                        data-action={action}
                        data-emphasis={
                          index() === 0
                            ? "primary"
                            : action === RECOVERY_ACTIONS.continueStartup
                              ? "danger"
                              : "secondary"
                        }
                        disabled={!!submitting()}
                        autofocus={index() === 0}
                        onClick={() => void submit(action)}
                      >
                        {actionLabel(action)}
                      </button>
                    )}
                  </For>
                </div>
              </Show>
            </div>
          </Show>
          <p class="a-recovery-live" aria-live="polite" role="status">
            {status()}
          </p>
          <p class="a-recovery-privacy">诊断信息已脱敏。此页面不会展示文件路径、凭据或原始异常。</p>
        </main>
      </div>
    </section>
  )
}

type RecoveryContent = {
  title: string
  summary: string
  cardTitle: string
  detail: string
}

function recoveryContent(plan?: RecoveryPlanView): RecoveryContent {
  if (plan?.category === "database-corrupt") {
    return {
      title: "会话数据需要恢复",
      summary: "启动检查发现本地会话数据库无法安全读取。DbSafety 已暂停引擎启动。",
      cardTitle: "数据库损坏",
      detail: plan.actions.includes(RECOVERY_ACTIONS.restoreLatestBackup)
        ? "可以从最近一次可用备份恢复；损坏的数据会保留，不会被静默删除。"
        : "没有可确认的备份。建议退出应用并处理数据；仍可明确选择继续启动。",
    }
  }
  if (plan?.category === "database-too-new") {
    return {
      title: "数据版本高于当前应用",
      summary: "此数据由更新版本的 alpha-code 创建。继续运行可能造成不兼容写入。",
      cardTitle: "版本不兼容",
      detail: "建议退出并升级应用。若必须继续，可以先创建已验证备份。",
    }
  }
  if (plan?.category === "engine-stopped") {
    return {
      title: "本地引擎已停止",
      summary: "自动恢复多次未能建立稳定连接。当前会话已暂停，但应用数据没有被删除。",
      cardTitle: "Sidecar / 网络故障",
      detail: "检查网络或本机运行环境后重试。重试会沿用现有受控重启流程。",
    }
  }
  if (plan?.actions.includes(RECOVERY_ACTIONS.retryFailureSave)) {
    return {
      title: "错误记录保存失败",
      summary: "页面已停止运行，且安全错误记录尚未成功保存。当前状态保持关闭。",
      cardTitle: "保存失败",
      detail: "可以重试保存脱敏记录。不会重新加载旧版页面，也不会发送原始错误。",
    }
  }
  return {
    title: "页面暂时不可用",
    summary: "Alpha 页面遇到无法继续的渲染错误。其他区域不会自动切换到旧版实现。",
    cardTitle: "Surface 崩溃",
    detail: "脱敏错误记录已保存。请关闭并重新打开当前调用面；当前版本不提供 legacy reload。",
  }
}

function actionLabel(action: RecoveryAction) {
  if (action === RECOVERY_ACTIONS.restoreLatestBackup) return "从最近备份恢复"
  if (action === RECOVERY_ACTIONS.exitApp) return "退出应用（推荐）"
  if (action === RECOVERY_ACTIONS.continueStartup) return "仍要继续启动"
  if (action === RECOVERY_ACTIONS.backupAndContinue) return "备份后继续"
  if (action === RECOVERY_ACTIONS.retryEngine) return "重试本地引擎"
  return "重试保存错误记录"
}
