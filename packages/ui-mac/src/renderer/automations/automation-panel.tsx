// 自动化(定时任务)面板 —— REQ-021 A1 的全部用户面:任务列表 / 一句话新建(确定性解析 →
// 预览卡逐字段可改)/ 详情(编辑 + 运行历史 + 回跳会话)。全页覆盖内容区(镜像 extension-hub
// 的 Portal 形制);数据全走 window.api.automations(调度与执行在 main),本组件零引擎耦合。
// 诚实边界(A1.3):应用未运行不执行 —— 页头常驻明示 +「登录时启动」开关。

import { createMemo, createSignal, For, onCleanup, Show } from "solid-js"
import { useNavigate } from "@solidjs/router"
import { Portal } from "solid-js/web"
import { t } from "../i18n"
import { pushToast } from "../alpha-ui/Toast"
import type { AuthState } from "../../preload/types"
import type { AutomationRunRecord, AutomationSchedule, AutomationTask } from "../../shared/automation-types"
import { AUTOMATION_DEFAULTS } from "../../shared/automation-types"
import { describeSchedule, isValidCron, parseCron } from "../../shared/automation-schedule"
import { parseAutomationText } from "../../shared/automation-nl"
import { sessionHref } from "../sidebar/route"
import { Svg } from "../extensions/ext-presentation"
import { automationOpen, setAutomationOpen } from "./automation-state"
import "./automation-panel.css"

type ListedTask = AutomationTask & { nextFireAt: number | null; running: boolean }

// ── 表单模型:schedule ⇄ 可编辑字段 ──────────────────────────────────────────────────────────

type FormKind = "daily" | "weekly" | "monthly" | "interval" | "cron"
interface ScheduleForm {
  kind: FormKind
  time: string // "HH:mm"(daily/weekly/monthly)
  dows: number[] // weekly
  dom: number // monthly
  everyMinutes: number // interval
  cronExpr: string // cron
}

const DEFAULT_FORM: ScheduleForm = { kind: "daily", time: "09:00", dows: [1], dom: 1, everyMinutes: 60, cronExpr: "0 9 * * *" }

function pad(n: number): string {
  return String(n).padStart(2, "0")
}

/** cron → 表单形状(识别不了的保持 raw cron 可编辑,不丢信息)。 */
function toForm(schedule: AutomationSchedule): ScheduleForm {
  if (schedule.kind === "interval") return { ...DEFAULT_FORM, kind: "interval", everyMinutes: schedule.everyMinutes }
  if (schedule.kind === "once") return { ...DEFAULT_FORM, kind: "cron", cronExpr: "0 9 * * *" } // A1 UI 不产 once
  try {
    const spec = parseCron(schedule.expr)
    if (spec.minute.size === 1 && spec.hour.size === 1 && spec.month.size === 12) {
      const time = `${pad([...spec.hour][0])}:${pad([...spec.minute][0])}`
      if (spec.dom === null && spec.dow === null) return { ...DEFAULT_FORM, kind: "daily", time }
      if (spec.dom === null && spec.dow) return { ...DEFAULT_FORM, kind: "weekly", time, dows: [...spec.dow].sort() }
      if (spec.dow === null && spec.dom?.size === 1) return { ...DEFAULT_FORM, kind: "monthly", time, dom: [...spec.dom][0] }
    }
  } catch {
    /* fall through to raw */
  }
  return { ...DEFAULT_FORM, kind: "cron", cronExpr: schedule.expr }
}

function fromForm(form: ScheduleForm): AutomationSchedule | { error: string } {
  const [h, m] = form.time.split(":").map((n) => parseInt(n, 10))
  const timeOk = Number.isFinite(h) && Number.isFinite(m) && h >= 0 && h <= 23 && m >= 0 && m <= 59
  switch (form.kind) {
    case "daily":
      if (!timeOk) return { error: t("alpha.auto.errTime") }
      return { kind: "cron", expr: `${m} ${h} * * *` }
    case "weekly":
      if (!timeOk) return { error: t("alpha.auto.errTime") }
      if (form.dows.length === 0) return { error: t("alpha.auto.errDow") }
      return { kind: "cron", expr: `${m} ${h} * * ${[...form.dows].sort().join(",")}` }
    case "monthly":
      if (!timeOk) return { error: t("alpha.auto.errTime") }
      if (form.dom < 1 || form.dom > 31) return { error: t("alpha.auto.errDom") }
      return { kind: "cron", expr: `${m} ${h} ${form.dom} * *` }
    case "interval":
      if (!Number.isFinite(form.everyMinutes) || form.everyMinutes < AUTOMATION_DEFAULTS.minIntervalMinutes)
        return { error: t("alpha.auto.errInterval", { min: AUTOMATION_DEFAULTS.minIntervalMinutes }) }
      return { kind: "interval", everyMinutes: Math.round(form.everyMinutes) }
    case "cron":
      if (!isValidCron(form.cronExpr)) return { error: t("alpha.auto.errCron") }
      return { kind: "cron", expr: form.cronExpr.trim() }
  }
}

const DOW_LABELS = ["日", "一", "二", "三", "四", "五", "六"]

function fmtNext(ts: number | null): string {
  if (!ts) return "—"
  const d = new Date(ts)
  const today = new Date()
  const sameDay = d.toDateString() === today.toDateString()
  const hm = `${pad(d.getHours())}:${pad(d.getMinutes())}`
  return sameDay ? `${t("alpha.auto.today")} ${hm}` : `${d.getMonth() + 1}/${d.getDate()} ${hm}`
}

function statusDot(r: AutomationRunRecord | undefined): { cls: string; label: string } {
  if (!r) return { cls: "idle", label: t("alpha.auto.neverRan") }
  if (r.status === "ok") return { cls: "ok", label: t("alpha.auto.lastOk") }
  if (r.status === "skipped-overlap" || r.status === "skipped-cap") return { cls: "skip", label: t("alpha.auto.lastSkipped") }
  return { cls: "err", label: r.status === "timeout" ? t("alpha.auto.lastTimeout") : t("alpha.auto.lastFailed") }
}

export function AutomationPanel() {
  const navigate = useNavigate()
  const [tasks, setTasks] = createSignal<ListedTask[]>([])
  const [pausedAll, setPausedAll] = createSignal(false)
  const [loginItem, setLoginItem] = createSignal(false)
  const [authState, setAuthState] = createSignal<AuthState>({ status: "logged-out", mode: "byok" })
  onCleanup(window.api.auth.subscribe(setAuthState))

  // 视图:list(默认)/ edit(新建或编辑,editing=null 为新建)
  const [view, setView] = createSignal<"list" | "edit">("list")
  const [editing, setEditing] = createSignal<ListedTask | null>(null)

  // 新建一句话输入
  const [nlInput, setNlInput] = createSignal("")
  const [parseNote, setParseNote] = createSignal("")

  // 编辑表单
  const [fName, setFName] = createSignal("")
  const [fPrompt, setFPrompt] = createSignal("")
  const [fDir, setFDir] = createSignal("")
  const [fForm, setFForm] = createSignal<ScheduleForm>({ ...DEFAULT_FORM })
  const [fMaxMin, setFMaxMin] = createSignal<number>(AUTOMATION_DEFAULTS.maxDurationMin)
  const [fProfile, setFProfile] = createSignal<"readonly" | "standard">("readonly")
  const [fExec, setFExec] = createSignal<"local" | "cloud">("local")
  const [cloudStates, setCloudStates] = createSignal<Map<string, { enabled: boolean; disabled_reason: string | null }>>(new Map())
  const [llmBusy, setLlmBusy] = createSignal(false)
  const [runNowBusy, setRunNowBusy] = createSignal<string | null>(null)
  const [fNotify, setFNotify] = createSignal(true)
  const [fErr, setFErr] = createSignal("")
  const [saving, setSaving] = createSignal(false)

  const refresh = async () => {
    try {
      const r = await window.api.automations.list()
      setTasks(r.tasks)
      setPausedAll(r.state.pausedAll)
      setLoginItem(r.loginItem)
      // A3:云档存在时回读 B 侧状态(熔断/停用原因)+ 拉回错过 run;离线保持本地态。
      if (r.tasks.some((t) => t.execution === "cloud")) {
        void window.api.automations.cloudSync().then((cs) => {
          if (cs.schedules) setCloudStates(new Map(cs.schedules.map((x) => [x.id, { enabled: x.enabled, disabled_reason: x.disabled_reason }])))
          if ("pulled" in cs.pulled && cs.pulled.pulled > 0) void window.api.automations.list().then((r2) => setTasks(r2.tasks))
        })
      }
    } catch {
      /* transient */
    }
  }
  void refresh()
  onCleanup(window.api.automations.onEvent(() => void refresh()))

  // 面板打开时刷新(nextFireAt 是快照)
  let wasOpen = false
  const openNow = createMemo(() => {
    const o = automationOpen()
    if (o && !wasOpen) void refresh()
    wasOpen = o
    return o
  })

  const host = document.createElement("div")
  host.setAttribute("data-alpha-automations", "")
  document.getElementById("root")?.appendChild(host)
  onCleanup(() => host.remove())

  const onKey = (e: KeyboardEvent) => {
    if (e.key !== "Escape" || !automationOpen()) return
    if (view() === "edit") return backToList()
    setAutomationOpen(false)
  }
  document.addEventListener("keydown", onKey)
  onCleanup(() => document.removeEventListener("keydown", onKey))

  const backToList = () => {
    setView("list")
    setEditing(null)
    setFErr("")
  }

  const startCreate = () => {
    const text = nlInput().trim()
    const parsed = parseAutomationText(text)
    setEditing(null)
    setFName(parsed.prompt.slice(0, 24) || t("alpha.auto.untitled"))
    setFPrompt(parsed.prompt)
    setFDir("")
    setFForm(parsed.schedule ? toForm(parsed.schedule) : { ...DEFAULT_FORM })
    setParseNote(
      text
        ? parsed.schedule
          ? t("alpha.auto.parsed", { desc: describeSchedule(parsed.schedule) })
          : t("alpha.auto.parseFallback")
        : "",
    )
    setFMaxMin(AUTOMATION_DEFAULTS.maxDurationMin)
    setFProfile("readonly")
    setFExec("local")
    setFNotify(true)
    setFErr("")
    setView("edit")
  }

  const startEdit = (task: ListedTask) => {
    setEditing(task)
    setFName(task.name)
    setFPrompt(task.prompt)
    setFDir(task.target.projectDir)
    setFForm(toForm(task.schedule))
    setFMaxMin(task.budget.maxDurationMin)
    setFProfile(task.permissionProfile === "standard" ? "standard" : "readonly")
    setFExec(task.execution === "cloud" ? "cloud" : "local")
    setFNotify(task.notify.system)
    setParseNote("")
    setFErr("")
    setView("edit")
  }

  const pickDir = async () => {
    const picked = await window.api.openDirectoryPicker({ title: t("alpha.auto.pickProject") })
    const dir = Array.isArray(picked) ? picked[0] : picked
    if (dir) setFDir(dir)
  }

  const save = async () => {
    setFErr("")
    const schedule = fromForm(fForm())
    if ("error" in schedule) return setFErr(schedule.error)
    if (!fName().trim()) return setFErr(t("alpha.auto.errName"))
    if (!fPrompt().trim()) return setFErr(t("alpha.auto.errPrompt"))
    if (!fDir()) return setFErr(t("alpha.auto.errDir"))
    const prev = editing()
    // A2:standard(可写)档启用确认 —— 无人值守可写可执行,风险显式(命令黑名单非穷尽)
    if (fProfile() === "standard" && prev?.permissionProfile !== "standard") {
      if (!window.confirm(t("alpha.auto.standardConfirm"))) return
    }
    const task: AutomationTask = {
      id: prev?.id ?? `auto-${crypto.randomUUID().slice(0, 8)}`,
      name: fName().trim(),
      nlText: prev?.nlText ?? nlInput().trim(),
      schedule,
      target: { projectDir: fDir(), agent: fProfile() === "standard" ? AUTOMATION_DEFAULTS.agentStandard : AUTOMATION_DEFAULTS.agent },
      prompt: fPrompt().trim(),
      execution: fExec(),
      cloudScheduleId: prev?.cloudScheduleId,
      permissionProfile: fProfile(),
      budget: { maxDurationMin: fMaxMin() },
      overlapPolicy: "skip",
      catchUpPolicy: "skip",
      notify: { system: fNotify() },
      enabled: prev?.enabled ?? true,
      createdAt: prev?.createdAt ?? new Date().toISOString(),
      lastRun: prev?.lastRun,
      history: prev?.history,
    }
    setSaving(true)
    try {
      const r = await window.api.automations.save(task)
      if (!r.ok) return setFErr(r.reason)
      pushToast({ kind: "success", title: t("alpha.auto.saved") })
      setNlInput("")
      await refresh()
      backToList()
    } finally {
      setSaving(false)
    }
  }

  const remove = async (id: string) => {
    await window.api.automations.remove(id)
    await refresh()
    backToList()
  }

  const openSession = (task: ListedTask, rec: AutomationRunRecord) => {
    if (!rec.sessionID) return
    setAutomationOpen(false)
    navigate(sessionHref(task.target.projectDir, rec.sessionID))
  }

  const projectName = (dir: string) => dir.split("/").filter(Boolean).pop() ?? dir

  return (
    <Show when={openNow()}>
      <Portal mount={host}>
        <div class="a-ui alpha-auto-page" role="region" aria-label={t("alpha.sidebar.automation")}>
          <header class="alpha-auto-head">
            <div class="alpha-auto-head-t">
              <Show when={view() === "edit"}>
                <button class="alpha-auto-crumb" onClick={backToList}>
                  <Svg class="alpha-ic alpha-ic-sm" d="M14 6l-6 6 6 6" />
                  {t("alpha.sidebar.automation")}
                </button>
                <span class="alpha-auto-crumb-sep">/</span>
              </Show>
              <h1>{view() === "edit" ? (editing() ? t("alpha.auto.editTitle") : t("alpha.auto.newTitle")) : t("alpha.sidebar.automation")}</h1>
            </div>
            <button class="alpha-auto-close" aria-label={t("alpha.ext.close")} onClick={() => setAutomationOpen(false)}>
              <Svg d="M6 6l12 12M18 6L6 18" />
            </button>
          </header>

          <div class="alpha-auto-scroll">
            <div class="alpha-auto-center">
              <Show when={view() === "list"}>
                {/* 诚实边界 + 全局开关行 */}
                <div class="alpha-auto-note">
                  <span>{t("alpha.auto.offlineNote")}</span>
                  <label class="alpha-auto-check">
                    <input
                      type="checkbox"
                      checked={loginItem()}
                      onChange={(e) => {
                        void window.api.automations.loginItem(e.currentTarget.checked).then((r) => setLoginItem(r.openAtLogin))
                      }}
                    />
                    {t("alpha.auto.loginItem")}
                  </label>
                  <label class="alpha-auto-check">
                    <input
                      type="checkbox"
                      checked={pausedAll()}
                      onChange={(e) => {
                        void window.api.automations.pauseAll(e.currentTarget.checked).then(() => void refresh())
                      }}
                    />
                    {t("alpha.auto.pauseAll")}
                  </label>
                </div>
                <Show when={authState().status === "logged-in" && authState().mode === "platform"}>
                  <p class="alpha-auto-hint">{t("alpha.auto.platformCost")}</p>
                </Show>

                {/* 一句话新建 */}
                <div class="alpha-auto-new">
                  <input
                    class="alpha-auto-nl"
                    placeholder={t("alpha.auto.nlPlaceholder")}
                    value={nlInput()}
                    onInput={(e) => setNlInput(e.currentTarget.value)}
                    onKeyDown={(e) => {
                      if (e.key === "Enter" && nlInput().trim()) startCreate()
                    }}
                  />
                  <button class="alpha-ext-add" data-variant="primary" onClick={startCreate}>
                    {t("alpha.auto.create")}
                  </button>
                </div>

                <Show
                  when={tasks().length > 0}
                  fallback={
                    <div class="alpha-auto-empty">
                      <b>{t("alpha.auto.emptyTitle")}</b>
                      <p>{t("alpha.auto.emptySub")}</p>
                      <button class="alpha-auto-example" onClick={() => setNlInput(t("alpha.auto.exampleText"))}>
                        {t("alpha.auto.exampleText")}
                      </button>
                    </div>
                  }
                >
                  <div class="alpha-auto-list" data-paused={pausedAll() ? "" : undefined}>
                    <For each={tasks()}>
                      {(task) => {
                        const dot = () => statusDot(task.lastRun)
                        return (
                          <div class="alpha-auto-row" data-clickable="" onClick={() => startEdit(task)}>
                            <span class="alpha-auto-dot" data-st={task.running ? "run" : dot().cls} title={dot().label} />
                            <div class="alpha-auto-row-body">
                              <div class="alpha-auto-row-nm">
                                <b>{task.name}</b>
                                <span class="alpha-auto-pill">{describeSchedule(task.schedule)}</span>
                                <span class="alpha-auto-pill" data-muted="">
                                  {projectName(task.target.projectDir)}
                                </span>
                                <Show when={task.execution === "cloud"}>
                                  <span class="alpha-auto-pill">☁ {t("alpha.auto.execCloud")}</span>
                                </Show>
                              </div>
                              <div class="alpha-auto-row-st">
                                {task.running
                                  ? t("alpha.auto.runningNow")
                                  : task.enabled && !pausedAll()
                                    ? `${t("alpha.auto.next")} ${fmtNext(task.nextFireAt)}`
                                    : task.disabledReason === "consecutive_failures"
                                      ? t("alpha.auto.disabledBreaker")
                                      : t("alpha.auto.disabled")}
                                <Show when={task.cloudScheduleId && cloudStates().get(task.cloudScheduleId!)?.disabled_reason}>
                                  {" · "}
                                  {cloudStates().get(task.cloudScheduleId!)!.disabled_reason === "consecutive_failures"
                                    ? t("alpha.auto.disabledBreaker")
                                    : t("alpha.auto.cloudStuck")}
                                </Show>
                                <Show when={task.lastRun}>
                                  {" · "}
                                  {dot().label}
                                  <Show when={task.lastRun!.summary}> · {task.lastRun!.summary}</Show>
                                </Show>
                              </div>
                            </div>
                            <button
                              class="alpha-ext-inline-cta"
                              disabled={task.running || runNowBusy() === task.id}
                              title={t("alpha.auto.runNowHint")}
                              onClick={(e) => {
                                e.stopPropagation()
                                setRunNowBusy(task.id)
                                void window.api.automations
                                  .runNow(task.id)
                                  .then((r) => {
                                    if (!r.ok) pushToast({ kind: "error", title: r.reason })
                                  })
                                  .finally(() => {
                                    setRunNowBusy(null)
                                    void refresh()
                                  })
                              }}
                            >
                              {runNowBusy() === task.id ? t("alpha.auto.runNowBusy") : t("alpha.auto.runNow")}
                            </button>
                            <button
                              class="alpha-ext-sw"
                              data-on={task.enabled ? "" : undefined}
                              aria-label={task.enabled ? t("alpha.ext.enabled") : t("alpha.ext.disabled")}
                              onClick={(e) => {
                                e.stopPropagation()
                                void window.api.automations.toggle(task.id, !task.enabled).then(() => void refresh())
                              }}
                            />
                          </div>
                        )
                      }}
                    </For>
                  </div>
                </Show>
              </Show>

              <Show when={view() === "edit"}>
                <Show when={parseNote()}>
                  <p class="alpha-auto-hint">
                    {parseNote()}
                    {/* A2:规则解析失败 → 用户显式点「用 AI 解析」(需先选项目;临时会话一次抽取即删) */}
                    <Show when={parseNote() === t("alpha.auto.parseFallback") && !editing()}>
                      {" "}
                      <button
                        class="alpha-ext-inline-cta"
                        disabled={llmBusy() || !fDir()}
                        title={fDir() ? undefined : t("alpha.auto.llmNeedsDir")}
                        onClick={() => {
                          if (llmBusy()) return
                          setLlmBusy(true)
                          void window.api.automations
                            .nlLlm(nlInput().trim(), fDir())
                            .then((r) => {
                              if (!r.ok) return setFErr(r.reason)
                              setFName(r.name)
                              setFPrompt(r.prompt)
                              setFForm(toForm(r.schedule))
                              setParseNote(t("alpha.auto.parsedLlm", { desc: describeSchedule(r.schedule) }))
                              setFErr("")
                            })
                            .finally(() => setLlmBusy(false))
                        }}
                      >
                        {llmBusy() ? t("alpha.auto.llmParsing") : t("alpha.auto.llmParse")}
                      </button>
                    </Show>
                  </p>
                </Show>
                <div class="alpha-auto-form">
                  <label class="alpha-auto-field">
                    <span>{t("alpha.auto.fName")}</span>
                    <input class="alpha-auto-input" value={fName()} onInput={(e) => setFName(e.currentTarget.value)} />
                  </label>

                  <div class="alpha-auto-field">
                    <span>{t("alpha.auto.fSchedule")}</span>
                    <div class="alpha-auto-seg">
                      <For each={["daily", "weekly", "monthly", "interval", "cron"] as FormKind[]}>
                        {(k) => (
                          <button data-on={fForm().kind === k ? "" : undefined} onClick={() => setFForm({ ...fForm(), kind: k })}>
                            {t(`alpha.auto.kind.${k}` as never)}
                          </button>
                        )}
                      </For>
                    </div>
                    <div class="alpha-auto-schedrow">
                      <Show when={fForm().kind === "weekly"}>
                        <div class="alpha-auto-dows">
                          <For each={[1, 2, 3, 4, 5, 6, 0]}>
                            {(d) => (
                              <button
                                data-on={fForm().dows.includes(d) ? "" : undefined}
                                onClick={() => {
                                  const cur = fForm().dows
                                  setFForm({ ...fForm(), dows: cur.includes(d) ? cur.filter((x) => x !== d) : [...cur, d] })
                                }}
                              >
                                {DOW_LABELS[d]}
                              </button>
                            )}
                          </For>
                        </div>
                      </Show>
                      <Show when={fForm().kind === "monthly"}>
                        <label class="alpha-auto-mini">
                          {t("alpha.auto.fDom")}
                          <input
                            class="alpha-auto-input"
                            type="number"
                            min="1"
                            max="31"
                            value={fForm().dom}
                            onInput={(e) => setFForm({ ...fForm(), dom: parseInt(e.currentTarget.value, 10) || 1 })}
                          />
                        </label>
                      </Show>
                      <Show when={["daily", "weekly", "monthly"].includes(fForm().kind)}>
                        <label class="alpha-auto-mini">
                          {t("alpha.auto.fTime")}
                          <input
                            class="alpha-auto-input"
                            type="time"
                            value={fForm().time}
                            onInput={(e) => setFForm({ ...fForm(), time: e.currentTarget.value })}
                          />
                        </label>
                      </Show>
                      <Show when={fForm().kind === "interval"}>
                        <label class="alpha-auto-mini">
                          {t("alpha.auto.fEvery")}
                          <input
                            class="alpha-auto-input"
                            type="number"
                            min={AUTOMATION_DEFAULTS.minIntervalMinutes}
                            value={fForm().everyMinutes}
                            onInput={(e) => setFForm({ ...fForm(), everyMinutes: parseInt(e.currentTarget.value, 10) || 0 })}
                          />
                          {t("alpha.auto.fMinutes")}
                        </label>
                      </Show>
                      <Show when={fForm().kind === "cron"}>
                        <input
                          class="alpha-auto-input alpha-mono"
                          placeholder="0 9 * * 1-5"
                          value={fForm().cronExpr}
                          onInput={(e) => setFForm({ ...fForm(), cronExpr: e.currentTarget.value })}
                        />
                      </Show>
                    </div>
                    <p class="alpha-auto-preview">
                      {(() => {
                        const s = fromForm(fForm())
                        return "error" in s ? s.error : t("alpha.auto.schedPreview", { desc: describeSchedule(s) })
                      })()}
                    </p>
                  </div>

                  <label class="alpha-auto-field">
                    <span>{t("alpha.auto.fProject")}</span>
                    <div class="alpha-auto-dirrow">
                      <code class="alpha-auto-dir">{fDir() || t("alpha.auto.noDir")}</code>
                      <button class="alpha-ext-add" onClick={() => void pickDir()}>
                        {t("alpha.auto.pickDir")}
                      </button>
                    </div>
                  </label>

                  <label class="alpha-auto-field">
                    <span>{t("alpha.auto.fPrompt")}</span>
                    <textarea
                      class="alpha-auto-input alpha-auto-textarea"
                      value={fPrompt()}
                      onInput={(e) => setFPrompt(e.currentTarget.value)}
                    />
                  </label>

                  <div class="alpha-auto-field">
                    <span>{t("alpha.auto.fExecution")}</span>
                    <div class="alpha-auto-seg">
                      <button data-on={fExec() === "local" ? "" : undefined} onClick={() => setFExec("local")}>
                        {t("alpha.auto.execLocal")}
                      </button>
                      <button data-on={fExec() === "cloud" ? "" : undefined} onClick={() => setFExec("cloud")}>
                        {t("alpha.auto.execCloud")}
                      </button>
                    </div>
                    <Show when={fExec() === "cloud"}>
                      {/* A3:数据边界(ADR-021)+ research 管线映射,强制展示不可折叠 */}
                      <p class="alpha-auto-preview">{t("alpha.auto.cloudBoundary")}</p>
                    </Show>
                  </div>

                  <div class="alpha-auto-inline">
                    <div class="alpha-auto-field">
                      <span>{t("alpha.auto.fPermission")}</span>
                      <div class="alpha-auto-seg">
                        <button data-on={fProfile() === "readonly" ? "" : undefined} onClick={() => setFProfile("readonly")}>
                          {t("alpha.auto.permReadonly")}
                        </button>
                        <button data-on={fProfile() === "standard" ? "" : undefined} onClick={() => setFProfile("standard")}>
                          {t("alpha.auto.permStandard")}
                        </button>
                      </div>
                      <p class="alpha-auto-preview">
                        {fProfile() === "standard" ? t("alpha.auto.permStandardNote") : t("alpha.auto.permNote")}
                      </p>
                    </div>
                    <label class="alpha-auto-mini">
                      {t("alpha.auto.fMaxMin")}
                      <input
                        class="alpha-auto-input"
                        type="number"
                        min="1"
                        max="120"
                        value={fMaxMin()}
                        onInput={(e) => setFMaxMin(parseInt(e.currentTarget.value, 10) || AUTOMATION_DEFAULTS.maxDurationMin)}
                      />
                      {t("alpha.auto.fMinutes")}
                    </label>
                    <label class="alpha-auto-check">
                      <input type="checkbox" checked={fNotify()} onChange={(e) => setFNotify(e.currentTarget.checked)} />
                      {t("alpha.auto.fNotify")}
                    </label>
                  </div>

                  <Show when={authState().status === "logged-in" && authState().mode === "platform"}>
                    <p class="alpha-auto-hint">{t("alpha.auto.platformCost")}</p>
                  </Show>
                  <Show when={fErr()}>
                    <p class="alpha-auto-err">{fErr()}</p>
                  </Show>
                  <div class="alpha-auto-actions">
                    <button class="alpha-ext-add" data-variant="primary" disabled={saving()} onClick={() => void save()}>
                      {saving() ? t("alpha.ext.adding") : t("alpha.auto.save")}
                    </button>
                    <button class="alpha-ext-add" onClick={backToList}>
                      {t("alpha.ext.cancel")}
                    </button>
                    <Show when={editing()}>
                      <button class="alpha-ext-add" data-variant="danger" onClick={() => void remove(editing()!.id)}>
                        {t("alpha.auto.delete")}
                      </button>
                    </Show>
                  </div>
                </div>

                {/* 运行历史(编辑既有任务时;A1.7:时间/结果/摘要 + 回跳会话 + run 产物) */}
                <Show when={editing() && (editing()!.history?.length ?? 0) > 0}>
                  <div class="alpha-auto-hist">
                    <h3>{t("alpha.auto.history")}</h3>
                    <For each={editing()!.history}>
                      {(rec) => {
                        const dot = statusDot(rec)
                        const d = new Date(rec.at)
                        return (
                          <div class="alpha-auto-hist-row">
                            <span class="alpha-auto-dot" data-st={dot.cls} />
                            <span class="alpha-auto-hist-t">
                              {d.getMonth() + 1}/{d.getDate()} {pad(d.getHours())}:{pad(d.getMinutes())}
                            </span>
                            <span class="alpha-auto-hist-s">{dot.label}</span>
                            <span class="alpha-auto-hist-sum" title={rec.summary}>
                              {rec.summary ?? ""}
                            </span>
                            <Show when={rec.sessionID}>
                              <button class="alpha-ext-link" onClick={() => openSession(editing()!, rec)}>
                                {t("alpha.auto.openSession")}
                              </button>
                            </Show>
                            <Show when={rec.runDir}>
                              <button class="alpha-ext-link" onClick={() => void window.api.openPath(rec.runDir!)}>
                                {t("alpha.auto.openRun")}
                              </button>
                            </Show>
                          </div>
                        )
                      }}
                    </For>
                  </div>
                </Show>
              </Show>
            </div>
          </div>
        </div>
      </Portal>
    </Show>
  )
}
