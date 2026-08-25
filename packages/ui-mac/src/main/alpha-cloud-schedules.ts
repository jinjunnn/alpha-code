// REQ-025(自动化 A3)—— 云档位客户端:schedule 注册/更新/删除 + 开机拉回(REQ-022 契约,B=PA-28)。
//
// 语义:execution:"cloud" 的自动化不走本地调度器 —— 保存即注册到 B(D1 registry),app 不在线
// B 也按时执行;开 app 时按 `GET /v1/cloud/jobs?since=<ts>&origin=schedule` 枚举错过的 run,
// 经既有 status/artifacts 链取结果落目标项目 `.alpha/runs/`(saveCloudRun,ADR-019/回流守卫)。
//
// MVP 边界(与 B 侧 PA-28 对齐,诚实声明):
//  · 云端执行走 **research 管线**(任务描述 = 调研问题;bounded-agent 档随 B service-token 演进);
//  · schedule 只认 5 字段 cron:interval 每 N 分钟(N<60)转 `*/N * * * *`,once 不支持云档;
//  · B 端预算硬帽(15 iter/150k tok/300s)、每租户 ≤10 条、最小间隔 5 分钟 —— 超限 B 拒绝,
//    错误经 platform-error-code 咽喉呈现([#940]:B 给稳定分类码则呈现 code,无码保持
//    `http-<status>`;B 的 `error` 散文可能携带路径/租户且随时会变,不进 UI)。
import { finalizeArtifactWithQuota, registerDownloadedArtifact, registeredArtifactNameOwner } from "./artifact-service"
import type { AutomationTask } from "../shared/automation-types"
import { scheduleToCron } from "../shared/automation-schedule"
import { downloadCloudArtifactTo, getCloudJobStatus, listCloudArtifacts } from "./alpha-cloud-jobs"
import { getAutomation, listAutomations, saveAutomation } from "./alpha-automations"
import { saveCloudRun } from "./alpha-workdir"
import { mirrorRunArtifacts } from "./alpha-user-workspace"
import { getLogger } from "./logging"
import { getStore } from "./store"
import { cloudScheduleEnvelopeFor, cloudScheduleRegistrationFor } from "./cloud-schedule-config"

// 与 alpha-cloud-jobs 同一 authed 通道(bearer 不进 renderer)。为避免循环依赖,这里复制其极简
// fetch 形状(同 endpoints/token 源)。
import { resolveEndpoints } from "./alpha-endpoints"
import { getAccessToken } from "./alpha-auth"
import { httpErrorCode } from "./platform-error-code"

// [#963] HTTP 拒绝的错误形状:`error` 是呈现槽(经 platform-error-code 咽喉的分类码或
// http-<status>,进 UI),`status` 是结构槽(原始 HTTP status,给幂等一类的控制流判定用)。
// 非 HTTP 失败(network / not-authenticated / no-cloud-endpoint / unauthorized)不带 status。
type CloudErr = { error: string; status?: number }
type CloudResult<T> = T | CloudErr
const isErr = (r: unknown): r is CloudErr => !!r && typeof r === "object" && "error" in (r as object)

async function authed<T>(path: string, init?: { method?: string; body?: unknown }): Promise<CloudResult<T>> {
  try {
    const token = getAccessToken(init?.method && init.method !== "GET" ? "cloud.dispatch" : "cloud.read")
    if (!token) return { error: "not-authenticated" }
    const base = resolveEndpoints().cloud
    if (!base) return { error: "no-cloud-endpoint" }
    const res = await fetch(`${base}${path}`, {
      method: init?.method ?? "GET",
      headers: {
        authorization: `Bearer ${token}`,
        ...(init?.body !== undefined ? { "content-type": "application/json" } : {}),
      },
      body: init?.body !== undefined ? JSON.stringify(init.body) : undefined,
      signal: AbortSignal.timeout(15000),
    })
    if (res.status === 401) return { error: "unauthorized" }
    // [#940] 与 alpha-cloud-jobs 同一咽喉:分类码优先(如 429 的 `rate_limited`),无码保持
    // `http-<status>`。[#963] status 另走结构槽 —— 控制流判定(deleteCloudSchedule 的已删
    // 容忍)不再寄生在呈现字符串上,平台给 404 补不补分类码都无所谓。
    if (!res.ok) return { error: await httpErrorCode(res), status: res.status }
    return (await res.json().catch(() => null)) as T
  } catch (error) {
    getLogger().warn("alpha-cloud-schedules: fetch failed", error)
    return { error: "network" }
  }
}

export type CloudScheduleView = {
  id: string
  name: string
  cron: string
  enabled: boolean
  next_fire_at: number
  last_job_id: string | null
  consecutive_failures: number
  disabled_reason: string | null
}

// [#969] 拒绝结果的**结构槽**。`reason` 是 main 自己拼的日志串(带中文前缀,main 无 i18n);
// `code` 是呈现槽 —— 经 IPC 原样带到 renderer,由那里唯一有 i18n 的一层选文案。renderer
// **不许**去解析 `reason` 的前缀:那是手写别人文法的替身,前缀一改呈现就静默退化成裸码。
export type CloudScheduleRefusal = { ok: false; reason: string; code: string }

/**
 * [#969] 桌面自铸的本地拒绝码。刻意用 **kebab**:平台分类码的文法是
 * `/^[a-z][a-z0-9_]{2,63}$/`(platform-error-code.ts,不含连字符),两个域因此结构上不相交,
 * 本地码永远不会被误当成平台新增的码,反之亦然。`authed()` 铸的四个传输伪码同属这个域。
 */
export const SCHEDULE_FORM_UNSUPPORTED_CODE = "cloud-schedule-form-unsupported"

/** 保存云档任务时注册/更新 B schedule;返回 schedule id 或(分类码 + 日志用 reason)。 */
export async function upsertCloudSchedule(task: AutomationTask): Promise<{ ok: true; scheduleId: string } | CloudScheduleRefusal> {
  const cron = scheduleToCron(task.schedule)
  // 这一条**发不出请求**,所以平台侧刻意无码(ap lib/schedules.ts 的 `cron required (5-field)`
  // 注释点名了这件事)—— 码只能由桌面自己铸,否则英文界面会读到下面这句中文。
  if (!cron)
    return {
      ok: false,
      reason: "云档只支持 cron / 60 分钟内的间隔(once 与超长间隔请用本地档)",
      code: SCHEDULE_FORM_UNSUPPORTED_CODE,
    }
  const body = cloudScheduleRegistrationFor(task, cron)
  const r = task.cloudScheduleId
    ? await authed<CloudScheduleView>(`/v1/cloud/schedules/${encodeURIComponent(task.cloudScheduleId)}`, { method: "PATCH", body })
    : await authed<CloudScheduleView>("/v1/cloud/schedules", { method: "POST", body })
  if (isErr(r)) return { ok: false, reason: `云端注册失败:${r.error}`, code: r.error }
  return { ok: true, scheduleId: r.id }
}

// [#969] 删除也带 code:`automations-save` 在「云档改本地」那一跳调它(automation-ipc.ts),
// 失败原因会原样落到面板同一行 `.alpha-auto-err` 上 —— 与注册失败是同一个用户可观察面。
export async function deleteCloudSchedule(scheduleId: string): Promise<{ ok: true } | CloudScheduleRefusal> {
  const r = await authed<{ deleted: string }>(`/v1/cloud/schedules/${encodeURIComponent(scheduleId)}`, { method: "DELETE" })
  // [#963] 幂等容忍按结构化 status 判:404 = 云端那行本来就没了(另一台设备删过 / 清理过 /
  // 上次删除超时后重试)= 已删即成功。旧写法 `r.error !== "http-404"` 拿呈现字符串比字面量,
  // 靠「平台不给 404 补分类码」才成立 —— 补上码用户就永远删不掉那条自动化。
  // 非 HTTP 失败(network 等)无 status ⇒ 仍 fail-closed,不删本地。
  if (isErr(r) && r.status !== 404) return { ok: false, reason: `云端删除失败:${r.error}`, code: r.error }
  return { ok: true }
}

export async function setCloudScheduleEnabled(scheduleId: string, enabled: boolean): Promise<{ ok: true } | { ok: false; reason: string }> {
  const r = await authed<CloudScheduleView>(`/v1/cloud/schedules/${encodeURIComponent(scheduleId)}`, { method: "PATCH", body: { enabled } })
  if (isErr(r)) return { ok: false, reason: `云端状态更新失败:${r.error}` }
  return { ok: true }
}

/** 面板刷新用:B 侧 schedule 状态(熔断/停用原因回读,验收③)。失败返回 null(离线时 UI 保持本地态)。 */
export async function listCloudSchedules(): Promise<CloudScheduleView[] | null> {
  const r = await authed<{ schedules: CloudScheduleView[] }>("/v1/cloud/schedules")
  return isErr(r) ? null : r.schedules
}

const LAST_PULL_KEY = "alphaCloudScheduleLastPull"

// codex M1:拉取单飞(startup 与面板 cloudSync 可能并发)—— 复用在飞 promise,不重入。
let pullInflight: Promise<{ pulled: number } | { error: string }> | null = null

/** 开机拉回:枚举错过的 schedule 触发 job → 终态取结果 → saveCloudRun 落对应任务的项目 .alpha/runs/。 */
export function pullCloudScheduleRuns(): Promise<{ pulled: number } | { error: string }> {
  if (pullInflight) return pullInflight
  pullInflight = doPull().finally(() => {
    pullInflight = null
  })
  return pullInflight
}

async function doPull(): Promise<{ pulled: number } | { error: string }> {
  const store = getStore()
  const since = Number(store.get(LAST_PULL_KEY) ?? 0) || Date.now() - 7 * 24 * 3600_000
  const r = await authed<{ jobs: Array<{ schedule_id: string; job_id: string; fired_at: number; schedule_name?: string }> }>(
    `/v1/cloud/jobs?since=${since}&origin=schedule`,
  )
  if (isErr(r)) return { error: r.error }
  const byScheduleId = new Map(listAutomations().filter((t) => t.cloudScheduleId).map((t) => [t.cloudScheduleId!, t]))
  let pulled = 0
  let maxFired = since
  // codex H1:游标只越过「已终局处理」的 job —— 未终态/状态查询失败的 job 记 pendingMin,
  // 游标停在它上(since 含等,下次重拉);否则运行中 job 会被游标永久跳过、结果丢失。
  let pendingMin: number | null = null
  for (const job of r.jobs) {
    maxFired = Math.max(maxFired, job.fired_at)
    const task = byScheduleId.get(job.schedule_id)
    if (!task) {
      getLogger().log("cloud-schedules: run for unknown/deleted local task, skipped", job.schedule_id)
      continue // 本地无主(任务已删)= 终局跳过,游标可越过
    }
    if ((task.history ?? []).some((h) => h.sessionID === job.job_id)) continue // 已对账
    const status = await getCloudJobStatus(job.job_id)
    const st = isErr(status) ? null : (status as { status?: string }).status
    if (!st || !["completed", "failed", "cancelled"].includes(st)) {
      pendingMin = pendingMin === null ? job.fired_at : Math.min(pendingMin, job.fired_at)
      continue // 未终态/查询失败:留给下次
    }
    const saved = await saveCloudRun(
      task.target.projectDir,
      job.job_id,
      {
        status: getCloudJobStatus,
        artifacts: listCloudArtifacts,
        // REQ-092:流式落盘(bearer 仅 main;.part + 限额前置 + sha256 + 原子 rename)。
        download: (artifact, targetPath, jobId) =>
          downloadCloudArtifactTo(
            { artifact, targetPath, jobId },
            (input) => finalizeArtifactWithQuota(task.target.projectDir, job.job_id, input),
          ),
        // REQ-093:下载成功即入 manifest(依赖注入,见 SaveRunDeps.register)。
        register: (input) => registerDownloadedArtifact(task.target.projectDir, job.job_id, input),
        // #1112:预约名字前问账本占用(精确同名不同件让路,同件重下照旧覆盖)。
        artifactNameOwner: (name) => registeredArtifactNameOwner(task.target.projectDir, job.job_id, name),
      },
      cloudScheduleEnvelopeFor(task) as never,
    ).catch(() => ({ ok: false as const, reason: "save failed" }))
    // REQ-071/ADR-025:~/Alpha 目标任务的交付物镜像到可见区 Outputs(best-effort,真源不变)。
    if (saved.ok && "files" in saved) mirrorRunArtifacts(task.target.projectDir, job.job_id, saved)
    // codex M1:落账前重读最新任务(await 期间用户可能已编辑)—— 只叠加历史,不回写旧快照。
    const fresh = getAutomation(task.id)
    const target = fresh ?? task
    const record = {
      at: new Date(job.fired_at).toISOString(),
      status: st === "completed" ? ("ok" as const) : ("failed" as const),
      sessionID: job.job_id,
      runDir: (saved as { ok?: boolean; dir?: string }).ok ? (saved as { dir?: string }).dir : undefined,
      summary: st === "completed" ? "云端定时执行完成(结果已拉回)" : `云端执行 ${st}`,
    }
    target.lastRun = record
    target.history = [record, ...(target.history ?? [])].slice(0, 30)
    const w = saveAutomation(target)
    if (!w.ok) getLogger().warn("cloud-schedules: history write failed", w.reason)
    pulled++
  }
  store.set(LAST_PULL_KEY, pendingMin ?? maxFired + 1)
  return { pulled }
}
