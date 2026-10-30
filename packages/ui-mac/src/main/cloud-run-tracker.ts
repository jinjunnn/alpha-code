// REQ-236 alpha-code#1551(方案 docs/design/req236-results-and-attachments.md §2.3)—— 宿主自己跟住一个云任务,
// 直到产物落到本机并现盘核对无误;不再取决于模型有没有回头调用 cloud_await。
// MAIN-ONLY、electron-free:网络、下载、广播都由 cloud-ipc.ts 注入,整个模块可对临时目录单测。
//
// 不变量(方案 §三):
//   · I3「已保存」= 列表请求成功 + 列出的每个描述符都已登记 + 每个条目现盘 sha256 复核通过;
//     列表 / 下载 / 登记 / 复核任一失败都是交付失败,带失败范围与码;
//   · I4 归属只由已受理的第一方 dispatch 写入(track 的 origin);查询类命中不传 origin、不改归属;
//   · I6 只重试瞬态码(network / retryable / http-5xx),最多 DELIVERY_MAX_ATTEMPTS 次尝试;重试只重取与重下,
//     永不重新派发任务;
//   · I7 同一 (directory, runId) 同时只有一个交付在跑(单飞);
//   · I8 每个交付绑定启动时的登录身份代:状态回包、SSE 帧、下载开始、退避醒来都先比对,变了即丢弃;
//     onAuthChanged 在身份代变化时 abort 在途下载、退订 SSE。同一账户的普通续期身份代不变,交付照常。

import { terminalEventName } from "./alpha-cloud-events-core"
import { saveCloudRun, type CloudRunManifest, type SaveRunDeps } from "./alpha-workdir"
import { readArtifactManifest, type ArtifactRunOrigin } from "./artifact-manifest"
import { recordRunOrigin, verifyArtifact } from "./artifact-service"
import type { CloudArtifactList, CloudJobEvent, CloudJobPublicStatus, CloudJobStatus, CloudResult } from "../preload/types"

export type CloudRunOrigin = Omit<ArtifactRunOrigin, "recordedAt">

export type CloudRunDeliveryFailure = {
  scope: "status" | "list" | "download" | "register" | "verify"
  artifactId?: string
  code: string
}

/** 广播事件 `cloud-run-state` 的载荷(冻结面,供 alpha-code#1552 消费)。没有 URL、没有 token。 */
export type CloudRunState = {
  directory: string
  runId: string
  sessionID: string | null
  /** `unknown` = 宿主还没拿到过这个任务的状态回包。 */
  job: { status: CloudJobPublicStatus | "unknown"; code?: string }
  delivery: { status: "pending" | "downloading" | "saved" | "failed"; failure?: CloudRunDeliveryFailure }
}

export type CloudRunTrackerDeps = {
  /** 登录身份代(登入/登出推进的 epoch + 稳定账户标签);变了 = 换了身份,旧交付作废。 */
  identity: () => string
  status: (runId: string) => Promise<CloudResult<CloudJobStatus>>
  artifacts: (runId: string) => Promise<CloudResult<CloudArtifactList>>
  subscribe: (runId: string, sink: (ev: CloudJobEvent) => void) => () => void
  /** 下载 / 登记 / 名字归属(生产 = 与 cloud-save-run 同一套装配);signal 在身份代变化时 abort 在途下载。 */
  saveDeps: (
    directory: string,
    runId: string,
    signal: AbortSignal,
  ) => Pick<SaveRunDeps, "download" | "register" | "artifactNameOwner">
  /** saveCloudRun 落定之后(镜像 Outputs、通知产物面板重读)。 */
  afterSave: (directory: string, runId: string, saved: CloudRunManifest) => void
  broadcast: (state: CloudRunState) => void
  /** 第 attempt 次瞬态失败之后的退避。 */
  wait: (attempt: number) => Promise<void>
  log: (message: string) => void
}

export const DELIVERY_MAX_ATTEMPTS = 3
const TRANSIENT_CODES = new Set(["network", "retryable"])
const isTransient = (code: string) => TRANSIENT_CODES.has(code) || /^http-5\d\d$/.test(code)
const TERMINAL_STATUSES = new Set<string>(["completed", "failed", "cancelled"])
// 平台分类码文法(platform-error-code.ts 同一形):只有这一形的失败码进 job.code。
const CLASSIFICATION_CODE = /^[a-z][a-z0-9_]{2,63}$/

type Task = { key: string; directory: string; runId: string; identity: string; ctrl: AbortController }

export function createCloudRunTracker(deps: CloudRunTrackerDeps) {
  const inflight = new Map<string, Task>()
  const states = new Map<string, CloudRunState>()
  // 上一次成功的产物列表里的描述符 id —— 「完整集合」只认平台列过的,不认本地 manifest 里碰巧有的。
  const listed = new Map<string, string[]>()
  const keyOf = (directory: string, runId: string) => `${directory}\0${runId}`
  const alive = (task: Task) => !task.ctrl.signal.aborted && deps.identity() === task.identity

  function publish(directory: string, runId: string, patch: { job?: CloudRunState["job"]; delivery: CloudRunState["delivery"] }) {
    const key = keyOf(directory, runId)
    const read = readArtifactManifest(directory, runId)
    const state: CloudRunState = {
      directory,
      runId,
      sessionID: read.ok ? (read.manifest?.origin?.sessionID ?? null) : null,
      job: patch.job ?? states.get(key)?.job ?? { status: "unknown" },
      delivery: patch.delivery,
    }
    states.set(key, state)
    deps.broadcast(state)
  }

  function start(directory: string, runId: string) {
    const key = keyOf(directory, runId)
    if (inflight.has(key)) return
    const task: Task = { key, directory, runId, identity: deps.identity(), ctrl: new AbortController() }
    inflight.set(key, task)
    publish(directory, runId, { delivery: { status: "pending" } })
    void deliver(task)
      .catch((error) => deps.log(`cloud-run-tracker: delivery for ${runId} threw: ${String(error)}`))
      .finally(() => {
        if (inflight.get(key) === task) inflight.delete(key)
      })
  }

  async function deliver(task: Task) {
    for (let attempt = 1; ; attempt++) {
      const failure = await attemptOnce(task)
      if (!alive(task)) return
      if (!failure) {
        publish(task.directory, task.runId, { delivery: { status: "saved" } })
        return
      }
      if (attempt >= DELIVERY_MAX_ATTEMPTS || !isTransient(failure.code)) {
        deps.log(
          `cloud-run-tracker: delivery of ${task.runId} failed after ${attempt} attempt(s): ${failure.scope} ${failure.code}`,
        )
        publish(task.directory, task.runId, { delivery: { status: "failed", failure } })
        return
      }
      await deps.wait(attempt)
      if (!alive(task)) return
    }
  }

  /** 一次尝试:本地核验 → 状态(未终态则等 SSE)→ 列表 → 落盘 → 完整集合现盘复核。返回 undefined = 已保存(或已作废)。 */
  async function attemptOnce(task: Task): Promise<CloudRunDeliveryFailure | undefined> {
    const known = listed.get(task.key)
    if (known && known.length > 0 && !(await verifyLocal(task.directory, task.runId, known))) return undefined
    if (!alive(task)) return undefined

    // 传输错误信封 = 裸 {error};真 CloudJobStatus 恒带 job_id(它自己的 `error` 字段在失败任务上也有值)。
    let status = await deps.status(task.runId)
    if (!alive(task)) return undefined
    if (!("job_id" in status)) return { scope: "status", code: status.error }
    if (!TERMINAL_STATUSES.has(status.status)) {
      publish(task.directory, task.runId, { job: jobOf(status), delivery: { status: "pending" } })
      const ended = await untilTerminal(task)
      if (!alive(task)) return undefined
      if (ended) return { scope: "status", code: ended }
      status = await deps.status(task.runId)
      if (!alive(task)) return undefined
      if (!("job_id" in status)) return { scope: "status", code: status.error }
    }
    const settled = status
    publish(task.directory, task.runId, { job: jobOf(settled), delivery: { status: "downloading" } })

    const list = await deps.artifacts(task.runId)
    if (!alive(task)) return undefined
    if ("error" in list) return { scope: "list", code: list.error }
    const ids = list.artifacts.map((artifact) => artifact.id)
    listed.set(task.key, ids)
    // 已经全部在盘上且复核通过(重载后卡片再次 track 的常态):不重下。
    if (ids.length > 0 && !(await verifyLocal(task.directory, task.runId, ids))) return undefined
    if (!alive(task)) return undefined

    const own = deps.saveDeps(task.directory, task.runId, task.ctrl.signal)
    const saved = await saveCloudRun(task.directory, task.runId, {
      ...own,
      status: async () => settled,
      artifacts: async () => list,
      download: (artifact, targetPath, jobId) =>
        alive(task)
          ? own.download(artifact, targetPath, jobId)
          : Promise.resolve({ ok: false as const, error: "cancelled", cancelled: true as const }),
    })
    if (!alive(task)) return undefined
    deps.afterSave(task.directory, task.runId, saved)
    if (!saved.ok) return { scope: "register", code: "disk" }
    const first = saved.failures[0]
    if (first) return { scope: first.scope, ...(first.artifactId ? { artifactId: first.artifactId } : {}), code: first.code }
    return verifyLocal(task.directory, task.runId, ids)
  }

  /** 等 SSE 终态。返回 undefined = 到了终态;字符串 = 订阅被平台拒绝的码(或本地作废)。 */
  function untilTerminal(task: Task): Promise<string | undefined> {
    return new Promise((resolve) => {
      const done = (code?: string) => {
        unsubscribe()
        task.ctrl.signal.removeEventListener("abort", onAbort)
        resolve(code)
      }
      const onAbort = () => done("cancelled")
      task.ctrl.signal.addEventListener("abort", onAbort, { once: true })
      const unsubscribe = deps.subscribe(task.runId, (ev) => {
        if (!alive(task)) return
        if (ev.event === "error") return done(sseErrorCode(ev.data))
        if (terminalEventName(ev)) return done()
        if (ev.event === "job.started" || ev.event === "job.running")
          publish(task.directory, task.runId, { job: { status: "running" }, delivery: { status: "pending" } })
      })
    })
  }

  return {
    /** 开始(或加入在途的)交付。origin 只由已受理的第一方 dispatch 传入;先写者胜。 */
    track(input: { directory: string; runId: string; origin?: CloudRunOrigin }) {
      if (input.origin) {
        const recorded = recordRunOrigin(input.directory, input.runId, input.origin)
        if (!recorded.ok) deps.log(`cloud-run-tracker: origin of ${input.runId} not recorded: ${recorded.reason}`)
      }
      start(input.directory, input.runId)
    },
    /** 时间线「重新下载」:与自动交付共用同一单飞;在途时什么都不做。 */
    retry(directory: string, runId: string) {
      start(directory, runId)
    },
    /** 面板单件下载成功后:对上次列出的完整集合重跑现盘复核并广播。没列成功过 = 无从判定,不广播。 */
    async reverify(directory: string, runId: string) {
      const key = keyOf(directory, runId)
      const ids = listed.get(key)
      if (!ids || inflight.has(key)) return
      const identity = deps.identity()
      const failure = await verifyLocal(directory, runId, ids)
      if (inflight.has(key) || deps.identity() !== identity) return
      publish(directory, runId, { delivery: failure ? { status: "failed", failure } : { status: "saved" } })
    },
    isDelivering(directory: string, runId: string) {
      return inflight.has(keyOf(directory, runId))
    },
    get(directory: string, runId: string): CloudRunState | null {
      return states.get(keyOf(directory, runId)) ?? null
    },
    /** main/index.ts 的 onChanged(续期与换号都会触发)。身份代没变 = 续期,什么都不做。 */
    onAuthChanged() {
      const identity = deps.identity()
      for (const task of [...inflight.values()]) {
        if (task.identity === identity) continue
        task.ctrl.abort()
        inflight.delete(task.key)
        states.delete(task.key)
        listed.delete(task.key)
      }
    },
  }
}

/** 完整集合逐件现盘 sha256 复核(verifyArtifact);第一件不通过的即交付失败。 */
async function verifyLocal(directory: string, runId: string, ids: string[]): Promise<CloudRunDeliveryFailure | undefined> {
  for (const artifactId of ids) {
    const checked = await verifyArtifact(directory, runId, artifactId)
    if (!checked.ok)
      return {
        scope: "verify",
        artifactId,
        code: checked.reason === "artifact not found" || checked.reason === "no manifest for run" ? "not-registered" : "unreadable",
      }
    if (checked.entry.local.state === "mismatch") return { scope: "verify", artifactId, code: "sha256-mismatch" }
    if (checked.entry.local.state === "missing") return { scope: "verify", artifactId, code: "missing" }
  }
  return undefined
}

function jobOf(status: CloudJobStatus): CloudRunState["job"] {
  const result = status.result
  const failureCode = result && typeof result === "object" ? (result as { failure_code?: unknown }).failure_code : undefined
  const code = typeof failureCode === "string" && CLASSIFICATION_CODE.test(failureCode) ? failureCode : status.reason
  return { status: status.status, ...(code ? { code } : {}) }
}

// alpha-cloud-events 的 error 帧:{ status: 401 | 404 } 或 { reason }。
function sseErrorCode(data: unknown): string {
  const record = data && typeof data === "object" ? (data as { status?: unknown; reason?: unknown }) : {}
  if (record.status === 401) return "unauthorized"
  if (record.status === 404) return "not-found"
  return typeof record.reason === "string" ? record.reason : "network"
}
