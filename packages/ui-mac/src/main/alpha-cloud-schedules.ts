// REQ-025(自动化 A3)—— 云档位客户端:schedule 注册/更新/删除 + 开机拉回(REQ-022 契约,B=PA-28)。
//
// 语义:execution:"cloud" 的自动化不走本地调度器 —— 保存即注册到 B(D1 registry),app 不在线
// B 也按时执行;开 app 时按 `GET /v1/cloud/jobs?since=<ts>&origin=schedule` 枚举错过的 run,
// 经既有 status/artifacts 链取结果落目标项目 `.alpha/runs/`(saveCloudRun,ADR-019/回流守卫)。
//
// MVP 边界(与 B 侧 PA-28 对齐,诚实声明):
//  · 云端执行走 **research 管线**(任务描述 = 调研问题;bounded-agent 档随 B service-token 演进);
//  · schedule 只认 5 字段 cron:interval 每 N 分钟(N<60)转 `*/N * * * *`,once 不支持云档;
//  · B 端预算硬帽(15 iter/150k tok/300s)、每租户 ≤10 条、最小间隔 5 分钟 —— 超限 B 拒绝,错误原样呈现。
import { finalizeArtifactWithQuota, registerDownloadedArtifact } from "./artifact-service"
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
import { platformErrorParts } from "./platform-http-error"

type CloudResult<T> = T | { error: string }
const isErr = (r: unknown): r is { error: string } => !!r && typeof r === "object" && "error" in (r as object)

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
    if (!res.ok) {
      // [#940] 经分类码咽喉,但本面的槽优先级与 jobs 面相反(审计 R1 M3 改定):
      //   · 404 **无条件** `http-404` —— deleteCloudSchedule 的幂等容忍键在这个字符串上;
      //     code 若排在前面,平台哪天给 404 补个 code,「删已删的 = 成功」就静默变报错。
      //   · 其余散文优先:本面的 error 没有任何 code 消费者(消费点只有本文件三处拼给人看的
      //     reason),REQ-025 MVP 契约明写「超限 B 拒绝,错误原样呈现」;code 优先会把唯一
      //     带 code 的拒绝(rate limit,ap routes/cloud-schedules.ts 实读)从人话句子降级成
      //     裸 token,零收益纯损失。无散文才退 code,最后 `http-<status>`。
      const parts = await platformErrorParts(res)
      return { error: res.status === 404 ? parts.fallback : (parts.prose ?? parts.code ?? parts.fallback) }
    }
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


/** 保存云档任务时注册/更新 B schedule;返回 schedule id 或可读错误。 */
export async function upsertCloudSchedule(task: AutomationTask): Promise<{ ok: true; scheduleId: string } | { ok: false; reason: string }> {
  const cron = scheduleToCron(task.schedule)
  if (!cron) return { ok: false, reason: "云档只支持 cron / 60 分钟内的间隔(once 与超长间隔请用本地档)" }
  const body = cloudScheduleRegistrationFor(task, cron)
  const r = task.cloudScheduleId
    ? await authed<CloudScheduleView>(`/v1/cloud/schedules/${encodeURIComponent(task.cloudScheduleId)}`, { method: "PATCH", body })
    : await authed<CloudScheduleView>("/v1/cloud/schedules", { method: "POST", body })
  if (isErr(r)) return { ok: false, reason: `云端注册失败:${r.error}` }
  return { ok: true, scheduleId: r.id }
}

export async function deleteCloudSchedule(scheduleId: string): Promise<{ ok: true } | { ok: false; reason: string }> {
  const r = await authed<{ deleted: string }>(`/v1/cloud/schedules/${encodeURIComponent(scheduleId)}`, { method: "DELETE" })
  if (isErr(r) && r.error !== "http-404") return { ok: false, reason: `云端删除失败:${r.error}` }
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
