// Main-owned ArtifactService(REQ-093 A 侧,alpha-code#185)—— run 产物的唯一权威服务层。
// Electron-free、root-parameterized(alpha-workdir.ts 风格),全表面可对临时目录单测。
//
// 职责:
//   · registerDownloadedArtifact —— #184 流式写入器(.part + 单遍 sha256 + 原子 rename)完成后调用,
//     把 descriptor + 本地状态登记进 artifacts.json(唯一集成点,见下方注释);
//   · listRunArtifacts —— manifest + 磁盘 reconcile(文件消失 ⇒ missing、尺寸漂移 ⇒ mismatch,降级持久化);
//   · resolveArtifact / verifyArtifact —— 按 id 取 descriptor;全量 sha256 复核(离线篡改检测,AC#4);
//   · removeArtifact —— 本地删除 + manifest 原子更新(ADR-019 守卫;保留策略/自动清理是平台侧
//     与 retention 专项的范围,这里只提供 GC 钩子,不做策略);
//   · run/project 字节与件数核算 + final rename 前的原子配额准入(REQ-093/#279);
//     基线常量与执行点集中在此,不让供数与执法漂移。
//
// 内容鉴别诚实原则:claimedMime / detectedMime 并列呈现;冲突产 warning;本服务不重新推导 trust,
// 也不基于扩展名"升级"任何结论(REQ-093 交付 4 的 A 侧表面;magic 检测本体在写入端/平台)。
//
// 并发模型:每次 finalizer 用 `wx` 创建仅归本次尝试所有的预约文件。盘面核算同时计入
// final 文件与全部预约;超限时按 (startedAt,uuid) 确定性让位,不修改任何活跃他方路径。

import * as crypto from "node:crypto"
import * as fs from "node:fs"
import * as path from "node:path"
import { foldedArtifactNameKey, isSafeRunId, safeResolveInAlpha } from "./alpha-workdir"
import {
  ARTIFACT_MANIFEST_VERSION,
  RUN_ARTIFACTS_SUBDIR,
  isSafeSavedPath,
  readArtifactManifest,
  writeArtifactManifest,
  type ArtifactDescriptor,
  type ArtifactManifestV1,
  type LocalArtifactState,
  type ManifestArtifactEntry,
} from "./artifact-manifest"

// ---- 配额基线(REQ-093 §5)。单件/单 run 件数上限来自契约镜像(与平台同值);单 run 字节与
// managed project 字节是 A 侧基线。单件上限由流式写入器执行,其余三项由本模块在 final rename 前执行。----
import { ARTIFACT_MAX_BYTES, MAX_ARTIFACTS_PER_RUN } from "../shared/cloud-artifact-descriptor"
export { ARTIFACT_MAX_BYTES, MAX_ARTIFACTS_PER_RUN }
export const MAX_RUN_ARTIFACT_BYTES = 512 * 1024 * 1024
export const MAX_PROJECT_ARTIFACT_BYTES = 5 * 1024 * 1024 * 1024

export const ARTIFACT_QUOTA_RESERVATIONS_DIR = "reservations"
export const ARTIFACT_QUOTA_MACHINE_ID_FILE = "artifact-quota-machine-id"
const ARTIFACT_QUOTA_YIELDED = "artifact quota admission yielded to an earlier reservation"
const ARTIFACT_QUOTA_WAIT_DEADLINE_MS = 5_000
const ARTIFACT_QUOTA_WAIT_MAX_ROUNDS = 250
const ARTIFACT_QUOTA_WAIT_INTERVAL_MS = 20
const ARTIFACT_QUOTA_INITIAL_SCAN_DEADLINE_MS = 30_000
const ARTIFACT_QUOTA_RESERVATION_CLEANUP_DEADLINE_MS = 100
const ARTIFACT_QUOTA_STAGED_CLOSE_DEADLINE_MS = 100
const ARTIFACT_QUOTA_SCAN_MAX_ENTRIES = 10_000
const ARTIFACT_QUOTA_SCAN_YIELD_EVERY = 32
const ARTIFACT_PART_SUFFIX_RE = /\.[0-9a-z]+-[0-9a-z]+-[0-9a-z]+-[0-9a-f]{8}\.part$/
const ARTIFACT_RESERVATION_STARTED_AT_RE = /^[0-9]{16}$/
const ARTIFACT_RESERVATION_UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/
const ARTIFACT_MACHINE_ID_RE = ARTIFACT_RESERVATION_UUID_RE

export type ArtifactQuotaLimits = {
  runMaxBytes: number
  runMaxCount: number
  projectMaxBytes: number
}

export type ArtifactQuotaFinalizeInput = {
  partPath: string
  targetPath: string
  bytes: number
}

export type ArtifactQuotaFinalizeResult =
  | { ok: true }
  | {
      ok: false
      error: "over-limit" | "disk" | "retryable" | "staging-changed"
      detail: string
    }

export type ArtifactQuotaEnvironmentResult =
  | { ok: true }
  | { ok: false; error: "disk"; detail: string }

export type ArtifactQuotaFinalizeOptions = {
  limits?: ArtifactQuotaLimits
  now?: () => Date
  pidAlive?: (pid: number) => boolean | undefined
  /** 仅供测试固定预约发布/判定/提交交错;生产调用不得注入。 */
  testHooks?: {
    reservationUuid?: () => string
    afterReservationCreated?: (reservationFile: string) => void | Promise<void>
    afterQuotaScan?: () => void | Promise<void>
    waitPolicy?: { deadlineMs: number; maxRounds: number; intervalMs: number }
    scanPolicy?: { maxEntries: number; yieldEvery: number }
    initialScanDeadlineMs?: number
    returnPolicy?: { reservationDeadlineMs: number; stagedCloseDeadlineMs: number }
    beforeScanEntry?: () => void | Promise<void>
    beforeOwnReservationRead?: () => void | Promise<void>
    beforeReservationCleanupRead?: () => void | Promise<void>
    beforeReservationCleanupDelete?: () => void | Promise<void>
    beforeStagedHandleClose?: () => void | Promise<void>
    afterScanYield?: () => void
  }
}

type ArtifactQuotaReservationRecord = {
  pid: number
  machineId: string
  declaredBytes: number
  startedAt: string
  uuid: string
}

type ArtifactQuotaReservation = ArtifactQuotaReservationRecord & {
  file: string
  runId: string
  dev: bigint
  ino: bigint
  content: string
  pathBound: boolean
}

type StagedArtifact = { handle: fs.promises.FileHandle; dev: bigint; ino: bigint; bytes: bigint }

type ArtifactQuotaEnvironment = { machineId: string }

type ArtifactQuotaReservationReleaseResult = "released" | "missing" | "changed" | "failed" | "timed-out"

let artifactQuotaEnvironment: ArtifactQuotaEnvironment | ArtifactQuotaEnvironmentResult | null = null

type CommittedArtifactUsage = {
  totalBytes: number
  runs: Map<string, { bytes: number; count: number }>
}

type ArtifactQuotaAdmissionDecision =
  | { ok: true; waitForGreater: boolean }
  | { ok: false; result: ArtifactQuotaFinalizeResult }

type ArtifactQuotaScanBudget = {
  deadline: number
  maxEntriesPerSlice: number
  yieldEvery: number
  entriesInSlice: number
  entriesSinceYield: number
  aborted: boolean
  beforeEntry?: () => void | Promise<void>
  afterYield?: () => void
}

type ArtifactQuotaScanResult =
  | { ok: true; reservations: ArtifactQuotaReservation[]; usage: CommittedArtifactUsage }
  | { ok: false; reason: "quota scan timed out" }

class ArtifactQuotaScanBoundError extends Error {}

/** 专用于崩溃预约诊断/测试;返回 null = project/run 身份不可确认。 */
export function artifactQuotaReservationsPath(projectDir: string, runId: string): string | null {
  if (!isSafeRunId(runId)) return null
  return safeResolveInAlpha(projectDir, "runs", runId, ARTIFACT_QUOTA_RESERVATIONS_DIR)
}

/**
 * 主进程启动后初始化一次安装级 machine id。artifact 根的部署前置条件见平台契约。
 */
export async function initializeArtifactQuotaEnvironment(
  userDataPath: string,
): Promise<ArtifactQuotaEnvironmentResult> {
  const root = path.resolve(userDataPath)
  let stat: fs.Stats
  try {
    stat = await fs.promises.stat(root)
  } catch {
    const result = quotaEnvironmentDiskError("machine identity root unavailable")
    artifactQuotaEnvironment = result
    return result
  }
  if (!stat.isDirectory()) {
    const result = quotaEnvironmentDiskError("machine identity root unavailable")
    artifactQuotaEnvironment = result
    return result
  }
  const machineId = await loadOrCreateArtifactQuotaMachineId(root)
  if (!machineId) {
    const result = quotaEnvironmentDiskError("machine identity unavailable")
    artifactQuotaEnvironment = result
    return result
  }
  artifactQuotaEnvironment = { machineId }
  return { ok: true }
}

/**
 * REQ-093/#279 唯一 final rename 准入点。每次尝试先发布唯一预约,再按“预约 → final”
 * 顺序扫描盘面真相,执行 run 件数/run 字节/project 字节判定后 rename。超限与核算
 * 不可信都 fail closed,且错误面不携带绝对路径、descriptor 或凭据。
 *
 * rename 前崩溃会遗留预约并保守多计 declaredBytes;rename 后、预约删除前崩溃会同时
 * 计入 final 与预约。只有同机且 PID 被证明 ESRCH 的预约才会被后续扫描惰性清理。
 */
export async function finalizeArtifactWithQuota(
  projectDir: string,
  runId: string,
  input: ArtifactQuotaFinalizeInput,
  opts: ArtifactQuotaFinalizeOptions = {},
): Promise<ArtifactQuotaFinalizeResult> {
  if (!isSafeRunId(runId)) return quotaDiskError("invalid run identity")
  const environment = artifactQuotaEnvironment
  if (!environment) return quotaDiskError("machine identity unavailable")
  if ("ok" in environment) return environment
  const artifactsDir = safeResolveInAlpha(projectDir, "runs", runId, RUN_ARTIFACTS_SUBDIR)
  if (!artifactsDir) return quotaDiskError("project identity unavailable")
  const runsDir = path.dirname(path.dirname(artifactsDir))
  const targetPath = path.resolve(input.targetPath)
  const partPath = path.resolve(input.partPath)
  const relativeTarget = path.relative(artifactsDir, targetPath)
  if (!relativeTarget || relativeTarget.startsWith(`..${path.sep}`) || path.isAbsolute(relativeTarget))
    return quotaDiskError("target outside the managed artifact directory")
  if (ARTIFACT_PART_SUFFIX_RE.test(path.basename(targetPath)))
    return quotaDiskError("final target conflicts with the staging namespace")
  if (
    safeResolveInAlpha(projectDir, "runs", runId, RUN_ARTIFACTS_SUBDIR, ...relativeTarget.split(path.sep)) !==
    targetPath
  )
    return quotaDiskError("target identity unavailable")
  if (
    path.dirname(partPath) !== path.dirname(targetPath) ||
    !partPath.startsWith(`${targetPath}.`) ||
    !ARTIFACT_PART_SUFFIX_RE.test(path.basename(partPath))
  )
    return quotaDiskError("staging file identity unavailable")
  const staged = await openStagedArtifact(partPath, input.bytes)
  if (!staged.ok) return quotaStagingChanged()
  try {
    const created = createArtifactQuotaReservation(projectDir, runId, input.bytes, environment.machineId, opts)
    if (!created.ok) return quotaDiskError(created.reason)
    const release = async (result: ArtifactQuotaFinalizeResult) => {
      const released = await releaseOwnArtifactQuotaReservationBeforeDeadline(created.reservation, opts.testHooks)
      if (released === "timed-out") return result
      if (released === "released" || released === "missing") return result
      if (released === "changed") return quotaRetryable("own reservation changed")
      return quotaDiskError("own reservation cleanup failed")
    }
    try {
      await opts.testHooks?.afterReservationCreated?.(created.reservation.file)
      // 先扫预约、后扫 final:所有者的提交顺序是 final rename → 删除预约,因此本地线性一致
      // namespace 的任意交错至少观察到二者之一。
      const scanned = await scanArtifactQuotaState(
        runsDir,
        created.reservation.file,
        environment.machineId,
        opts.pidAlive ?? defaultPidAlive,
        opts.testHooks,
        Date.now() +
          Math.min(
            ARTIFACT_QUOTA_INITIAL_SCAN_DEADLINE_MS,
            Math.max(1, opts.testHooks?.initialScanDeadlineMs ?? ARTIFACT_QUOTA_INITIAL_SCAN_DEADLINE_MS),
          ),
      )
      if (!scanned.ok) return await release(quotaRetryable(scanned.reason))
      if (!scanned.reservations.some((reservation) => artifactQuotaReservationsMatch(reservation, created.reservation)))
        return await release(quotaRetryable("own reservation changed"))
      const limits = opts.limits ?? {
        runMaxBytes: MAX_RUN_ARTIFACT_BYTES,
        runMaxCount: MAX_ARTIFACTS_PER_RUN,
        projectMaxBytes: MAX_PROJECT_ARTIFACT_BYTES,
      }
      const decision = decideArtifactQuotaAdmission(
        runId,
        scanned.reservations,
        scanned.usage,
        limits,
        created.reservation,
      )
      if (!decision.ok) return await release(decision.result)
      await opts.testHooks?.afterQuotaScan?.()
      if (decision.waitForGreater) {
        const converged = await waitForGreaterArtifactQuotaReservations(
          runsDir,
          runId,
          limits,
          created.reservation,
          environment.machineId,
          opts.pidAlive ?? defaultPidAlive,
          opts.testHooks?.waitPolicy,
          opts.testHooks,
        )
        if (converged) return await release(converged)
      }
      if (!(await stagedArtifactIsUnchanged(partPath, input.bytes, staged.value)))
        return await release(quotaStagingChanged())
      // 自有预约是 rename 前最后一次路径读取;缺失、换 inode 或内容改变都可重试地中止。
      if (!(await ownArtifactQuotaReservationIsUnchanged(created.reservation)))
        return await release(quotaRetryable("own reservation changed"))
      // #901:唯一 final 落名点前的最后一道折叠比较(NFC + toLowerCase)。调用方已按同一折叠键
      // 预约过名字(reserveArtifactSavedName),这里是不可绕过的兜底——真出现同键冲突(如两个
      // 并发下载各自预约时都还没写盘)一律拒绝,绝不静默改名或静默覆盖同名不同大小写的既有文件。
      if (await hasConflictingArtifactCasing(artifactsDir, targetPath))
        return await release(quotaDiskError("final name collides case-insensitively with an existing artifact"))
      try {
        await fs.promises.rename(partPath, targetPath)
      } catch {
        return await release(quotaDiskError("final rename failed"))
      }
      // rename 已提交后不再把“预约删除失败”伪装成下载失败;残留只会保守多计,由死 PID
      // 惰性清理或 runbook 处置。正常路径仍仅删除身份未变的本次预约。
      await releaseOwnArtifactQuotaReservationBeforeDeadline(created.reservation, opts.testHooks)
      return { ok: true }
    } catch {
      return await release(quotaDiskError("committed usage unavailable"))
    }
  } finally {
    await closeStagedArtifactBeforeDeadline(staged.value, opts.testHooks)
  }
}

// #901:唯一 final 落名点(fs.promises.rename)前的最后一道折叠比较守卫。跳过 `.part` 暂存文件
// 与目标自身的精确同名(同名覆盖是合法的重下/更新路径,AC#6 由调用方保 sha256 校验),只挡"存在
// 一个大小写不同、折叠键相同"的既有文件——那才是会被 POSIX rename 静默替换的真实冲突。
async function hasConflictingArtifactCasing(artifactsDir: string, targetPath: string): Promise<boolean> {
  const targetName = path.basename(targetPath)
  const targetKey = foldedArtifactNameKey(targetName)
  let entries: fs.Dirent[]
  try {
    entries = await fs.promises.readdir(artifactsDir, { withFileTypes: true })
  } catch {
    return false
  }
  for (const entry of entries) {
    if (!entry.isFile() || entry.name.endsWith(".part") || entry.name === targetName) continue
    if (foldedArtifactNameKey(entry.name) === targetKey) return true
  }
  return false
}

function quotaOverLimit(scope: string, next: number, limit: number): ArtifactQuotaFinalizeResult {
  return { ok: false, error: "over-limit", detail: `artifact quota exceeded (${scope}: next ${next}, limit ${limit})` }
}

function quotaDiskError(reason: string): ArtifactQuotaFinalizeResult {
  return { ok: false, error: "disk", detail: `artifact quota admission unavailable (${reason})` }
}

function quotaEnvironmentDiskError(reason: string): ArtifactQuotaEnvironmentResult {
  return { ok: false, error: "disk", detail: `artifact quota admission unavailable (${reason})` }
}

function quotaRetryable(reason: string): ArtifactQuotaFinalizeResult {
  return { ok: false, error: "retryable", detail: `artifact quota admission retry required (${reason})` }
}

function quotaStagingChanged(): ArtifactQuotaFinalizeResult {
  return { ok: false, error: "staging-changed", detail: "artifact staging identity or byte count changed" }
}

function quotaYielded(): ArtifactQuotaFinalizeResult {
  return { ok: false, error: "over-limit", detail: ARTIFACT_QUOTA_YIELDED }
}

function quotaExceeded(
  nextRunCount: number,
  nextRunBytes: number,
  nextProjectBytes: number,
  limits: ArtifactQuotaLimits,
): ArtifactQuotaFinalizeResult | null {
  if (nextRunCount > limits.runMaxCount) return quotaOverLimit("run artifact count", nextRunCount, limits.runMaxCount)
  if (nextRunBytes > limits.runMaxBytes) return quotaOverLimit("run bytes", nextRunBytes, limits.runMaxBytes)
  if (nextProjectBytes > limits.projectMaxBytes)
    return quotaOverLimit("project bytes", nextProjectBytes, limits.projectMaxBytes)
  return null
}

function decideArtifactQuotaAdmission(
  runId: string,
  reservations: ArtifactQuotaReservation[],
  usage: CommittedArtifactUsage,
  limits: ArtifactQuotaLimits,
  own: ArtifactQuotaReservation,
): ArtifactQuotaAdmissionDecision {
  const run = usage.runs.get(runId) ?? { bytes: 0, count: 0 }
  const runReservations = reservations.filter((reservation) => reservation.runId === runId)
  // committed 已含当前 target 的扫描时真实状态;任何扫描前 target 快照都可能陈旧,因此替换也不
  // 扣旧文件。预约声明作为本次提交增量全额计入,必要时保守双计旧 final + 新声明。
  const nextRunCount = run.count + runReservations.length
  const nextRunBytes = run.bytes + sumReservationBytes(runReservations)
  const nextProjectBytes = usage.totalBytes + sumReservationBytes(reservations)
  const exceeded = quotaExceeded(nextRunCount, nextRunBytes, nextProjectBytes, limits)
  if (!exceeded) return { ok: true, waitForGreater: false }

  const conflicts = reservations.filter(
    (reservation) =>
      reservation.file !== own.file &&
      (nextProjectBytes > limits.projectMaxBytes ||
        (reservation.runId === runId && (nextRunCount > limits.runMaxCount || nextRunBytes > limits.runMaxBytes))),
  )
  if (conflicts.some((reservation) => compareArtifactQuotaReservations(reservation, own) < 0))
    return { ok: false, result: quotaYielded() }

  const later = conflicts.filter((reservation) => compareArtifactQuotaReservations(reservation, own) > 0)
  const laterRun = later.filter((reservation) => reservation.runId === runId)
  const withoutLater = quotaExceeded(
    nextRunCount - laterRun.length,
    nextRunBytes - sumReservationBytes(laterRun),
    nextProjectBytes - sumReservationBytes(later),
    limits,
  )
  if (withoutLater) return { ok: false, result: withoutLater }
  return { ok: true, waitForGreater: later.length > 0 }
}

async function waitForGreaterArtifactQuotaReservations(
  runsDir: string,
  runId: string,
  limits: ArtifactQuotaLimits,
  own: ArtifactQuotaReservation,
  machineId: string,
  pidAlive: (pid: number) => boolean | undefined,
  waitPolicy = {
    deadlineMs: ARTIFACT_QUOTA_WAIT_DEADLINE_MS,
    maxRounds: ARTIFACT_QUOTA_WAIT_MAX_ROUNDS,
    intervalMs: ARTIFACT_QUOTA_WAIT_INTERVAL_MS,
  },
  testHooks?: ArtifactQuotaFinalizeOptions["testHooks"],
): Promise<ArtifactQuotaFinalizeResult | null> {
  const deadline = Date.now() + Math.min(ARTIFACT_QUOTA_WAIT_DEADLINE_MS, Math.max(1, waitPolicy.deadlineMs))
  const maxRounds = Math.min(ARTIFACT_QUOTA_WAIT_MAX_ROUNDS, Math.max(1, waitPolicy.maxRounds))
  const intervalMs = Math.min(ARTIFACT_QUOTA_WAIT_INTERVAL_MS, Math.max(1, waitPolicy.intervalMs))
  for (let round = 0; round < maxRounds; round++) {
    const remaining = deadline - Date.now()
    if (remaining <= 0) return quotaRetryable("reservation convergence timed out")
    await delay(Math.min(intervalMs, remaining))
    if (Date.now() >= deadline) return quotaRetryable("reservation convergence timed out")
    const unchanged = await ownArtifactQuotaReservationIsUnchangedBeforeDeadline(
      own,
      deadline,
      testHooks?.beforeOwnReservationRead,
    )
    if (unchanged === "timed-out") return quotaRetryable("reservation convergence timed out")
    if (!unchanged) return quotaRetryable("own reservation changed")
    // 总 deadline 在扫描前后都复核;单次扫描预算也会被剩余总预算裁剪。
    if (Date.now() >= deadline) return quotaRetryable("reservation convergence timed out")
    const scanned = await scanArtifactQuotaState(runsDir, own.file, machineId, pidAlive, testHooks, deadline)
    if (Date.now() >= deadline) return quotaRetryable("reservation convergence timed out")
    if (!scanned.ok) return quotaRetryable(scanned.reason)
    if (!scanned.reservations.some((reservation) => artifactQuotaReservationsMatch(reservation, own)))
      return quotaRetryable("own reservation changed")
    const decision = decideArtifactQuotaAdmission(runId, scanned.reservations, scanned.usage, limits, own)
    if (!decision.ok) return decision.result
    if (!decision.waitForGreater) return null
  }
  return quotaRetryable("reservation convergence round limit reached")
}

async function scanArtifactQuotaState(
  runsDir: string,
  ownFile: string,
  machineId: string,
  pidAlive: (pid: number) => boolean | undefined,
  testHooks?: ArtifactQuotaFinalizeOptions["testHooks"],
  outerDeadline = Number.POSITIVE_INFINITY,
): Promise<ArtifactQuotaScanResult> {
  const policy = testHooks?.scanPolicy ?? {
    maxEntries: ARTIFACT_QUOTA_SCAN_MAX_ENTRIES,
    yieldEvery: ARTIFACT_QUOTA_SCAN_YIELD_EVERY,
  }
  const budget: ArtifactQuotaScanBudget = {
    deadline: outerDeadline,
    maxEntriesPerSlice: Math.min(ARTIFACT_QUOTA_SCAN_MAX_ENTRIES, Math.max(1, policy.maxEntries)),
    yieldEvery: Math.min(ARTIFACT_QUOTA_SCAN_YIELD_EVERY, Math.max(1, policy.yieldEvery)),
    entriesInSlice: 0,
    entriesSinceYield: 0,
    aborted: false,
    beforeEntry: testHooks?.beforeScanEntry,
    afterYield: testHooks?.afterScanYield,
  }
  if (budget.deadline <= Date.now()) return { ok: false, reason: "quota scan timed out" }
  // 预约必须完整扫描在先,再扫 final;不可并行破坏 reservation → final 的观察顺序。
  const scan = requireArtifactQuotaRunsDirectory(runsDir, budget)
    .then(() => scanArtifactQuotaReservations(runsDir, ownFile, machineId, pidAlive, budget))
    .then(async (reservations) => ({ reservations, usage: await scanCommittedArtifactUsage(runsDir, budget) }))
  const result: Promise<ArtifactQuotaScanResult> = scan.then(
    (value) => ({ ok: true, reservations: value.reservations, usage: value.usage }),
    (error: unknown): ArtifactQuotaScanResult => {
      if (error instanceof ArtifactQuotaScanBoundError) return { ok: false, reason: "quota scan timed out" }
      throw error
    },
  )
  if (!Number.isFinite(budget.deadline)) return result
  return new Promise<ArtifactQuotaScanResult>((resolve, reject) => {
    const timer = setTimeout(
      () => {
        budget.aborted = true
        resolve({ ok: false, reason: "quota scan timed out" })
      },
      Math.max(1, budget.deadline - Date.now()),
    )
    result.then(
      (value) => {
        clearTimeout(timer)
        resolve(value)
      },
      (error: unknown) => {
        clearTimeout(timer)
        reject(error)
      },
    )
  })
}

async function scanCommittedArtifactUsage(
  runsDir: string,
  budget: ArtifactQuotaScanBudget,
): Promise<CommittedArtifactUsage> {
  const runs = new Map<string, { bytes: number; count: number }>()
  for (const entry of await readArtifactQuotaDirectory(runsDir, budget)) {
    if (!entry.isDirectory() || !isSafeRunId(entry.name)) continue
    runs.set(entry.name, await scanCommittedArtifacts(path.join(runsDir, entry.name, RUN_ARTIFACTS_SUBDIR), budget))
  }
  return { totalBytes: [...runs.values()].reduce((sum, run) => sum + run.bytes, 0), runs }
}

async function requireArtifactQuotaRunsDirectory(runsDir: string, budget: ArtifactQuotaScanBudget): Promise<void> {
  const stat = await fs.promises.lstat(runsDir)
  requireArtifactQuotaScanBudget(budget)
  if (stat.isSymbolicLink() || !stat.isDirectory() || (await fs.promises.realpath(runsDir)) !== runsDir)
    throw new Error("invalid runs directory")
  requireArtifactQuotaScanBudget(budget)
}

async function scanCommittedArtifacts(
  dir: string,
  budget: ArtifactQuotaScanBudget,
): Promise<{ bytes: number; count: number }> {
  const usage = { bytes: 0, count: 0 }
  for (const entry of await readArtifactQuotaDirectory(dir, budget)) {
    if (ARTIFACT_PART_SUFFIX_RE.test(entry.name)) continue
    const target = path.join(dir, entry.name)
    const stat = await fs.promises.lstat(target)
    requireArtifactQuotaScanBudget(budget)
    if (stat.isSymbolicLink()) continue
    if (stat.isDirectory()) {
      const nested = await scanCommittedArtifacts(target, budget)
      usage.bytes += nested.bytes
      usage.count += nested.count
      continue
    }
    if (!stat.isFile()) continue
    usage.bytes += stat.size
    usage.count += 1
  }
  return usage
}

async function readArtifactQuotaDirectory(dir: string, budget: ArtifactQuotaScanBudget): Promise<fs.Dirent[]> {
  let entries: fs.Dirent[]
  try {
    entries = await fs.promises.readdir(dir, { withFileTypes: true })
  } catch (error) {
    if (artifactQuotaErrorCode(error) === "ENOENT") return []
    throw error
  }
  for (const entry of entries) await recordArtifactQuotaScanEntry(budget)
  return entries
}

function artifactQuotaErrorCode(error: unknown): string | undefined {
  if (!error || typeof error !== "object" || !("code" in error)) return undefined
  return typeof error.code === "string" ? error.code : undefined
}

async function recordArtifactQuotaScanEntry(budget: ArtifactQuotaScanBudget): Promise<void> {
  requireArtifactQuotaScanBudget(budget)
  budget.entriesInSlice += 1
  budget.entriesSinceYield += 1
  await budget.beforeEntry?.()
  requireArtifactQuotaScanBudget(budget)
  const sliceComplete = budget.entriesInSlice >= budget.maxEntriesPerSlice
  const yieldDue = budget.entriesSinceYield >= budget.yieldEvery
  if (!sliceComplete && !yieldDue) return
  if (sliceComplete) budget.entriesInSlice = 0
  if (yieldDue) budget.entriesSinceYield = 0
  await delay(0)
  budget.afterYield?.()
  requireArtifactQuotaScanBudget(budget)
}

function requireArtifactQuotaScanBudget(budget: ArtifactQuotaScanBudget): void {
  if (budget.aborted || Date.now() >= budget.deadline) throw new ArtifactQuotaScanBoundError("quota scan timed out")
}

async function openStagedArtifact(
  partPath: string,
  declaredBytes: number,
): Promise<{ ok: true; value: StagedArtifact } | { ok: false }> {
  const noFollow = typeof fs.constants.O_NOFOLLOW === "number" ? fs.constants.O_NOFOLLOW : 0
  const nonBlock = typeof fs.constants.O_NONBLOCK === "number" ? fs.constants.O_NONBLOCK : 0
  let handle: fs.promises.FileHandle
  try {
    handle = await fs.promises.open(partPath, fs.constants.O_RDONLY | noFollow | nonBlock)
  } catch {
    return { ok: false }
  }
  try {
    const stat = await handle.stat({ bigint: true })
    const pathStat = await fs.promises.lstat(partPath, { bigint: true })
    if (
      !stat.isFile() ||
      !pathStat.isFile() ||
      stat.dev !== pathStat.dev ||
      stat.ino !== pathStat.ino ||
      stat.size !== BigInt(declaredBytes)
    ) {
      await handle.close()
      return { ok: false }
    }
    return { ok: true, value: { handle, dev: stat.dev, ino: stat.ino, bytes: stat.size } }
  } catch {
    try {
      await handle.close()
    } catch {
      // 只读 staged fd;失败路径仍保持拒绝。
    }
    return { ok: false }
  }
}

async function stagedArtifactIsUnchanged(
  partPath: string,
  declaredBytes: number,
  staged: StagedArtifact,
): Promise<boolean> {
  try {
    const stat = await staged.handle.stat({ bigint: true })
    const pathStat = await fs.promises.lstat(partPath, { bigint: true })
    return (
      stat.isFile() &&
      pathStat.isFile() &&
      stat.dev === staged.dev &&
      stat.ino === staged.ino &&
      stat.size === staged.bytes &&
      stat.size === BigInt(declaredBytes) &&
      pathStat.dev === stat.dev &&
      pathStat.ino === stat.ino &&
      pathStat.size === stat.size
    )
  } catch {
    return false
  }
}

async function loadOrCreateArtifactQuotaMachineId(userDataPath: string): Promise<string | null> {
  const file = path.join(userDataPath, ARTIFACT_QUOTA_MACHINE_ID_FILE)
  let fd: number | null = null
  let created = false
  try {
    fd = fs.openSync(file, "wx", 0o600)
    created = true
    fs.writeFileSync(fd, `${crypto.randomUUID()}\n`)
    fs.fsyncSync(fd)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") return null
  } finally {
    if (fd !== null) {
      try {
        fs.closeSync(fd)
      } catch {
        // machine id 文件已 fsync;关闭失败由随后绑定读取决定是否可用。
      }
    }
  }
  for (let attempt = 0; attempt < 10; attempt++) {
    const machineId = readArtifactQuotaMachineId(file)
    if (machineId) return machineId
    if (created) return null
    await delay(10)
  }
  return null
}

function readArtifactQuotaMachineId(file: string): string | null {
  const noFollow = typeof fs.constants.O_NOFOLLOW === "number" ? fs.constants.O_NOFOLLOW : 0
  const nonBlock = typeof fs.constants.O_NONBLOCK === "number" ? fs.constants.O_NONBLOCK : 0
  let fd: number
  try {
    fd = fs.openSync(file, fs.constants.O_RDONLY | noFollow | nonBlock)
  } catch {
    return null
  }
  try {
    const stat = fs.fstatSync(fd, { bigint: true })
    const pathStat = fs.lstatSync(file, { bigint: true })
    if (
      !stat.isFile() ||
      !pathStat.isFile() ||
      stat.size > 64n ||
      (stat.mode & 0o077n) !== 0n ||
      stat.dev !== pathStat.dev ||
      stat.ino !== pathStat.ino
    )
      return null
    const value = fs.readFileSync(fd, "utf8").trim()
    return ARTIFACT_MACHINE_ID_RE.test(value) ? value : null
  } catch {
    return null
  } finally {
    try {
      fs.closeSync(fd)
    } catch {
      // read-only fd;关闭失败不改变 machine id 是否已绑定验证。
    }
  }
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

function createArtifactQuotaReservation(
  projectDir: string,
  runId: string,
  declaredBytes: number,
  machineId: string,
  opts: ArtifactQuotaFinalizeOptions,
): { ok: true; reservation: ArtifactQuotaReservation } | { ok: false; reason: string } {
  const dir = artifactQuotaReservationsPath(projectDir, runId)
  if (!dir) return { ok: false, reason: "reservation identity unavailable" }
  const uuid = opts.testHooks?.reservationUuid?.() ?? crypto.randomUUID()
  const now = opts.now?.() ?? new Date()
  const startedAt = String(now.getTime() * 1_000).padStart(16, "0")
  if (
    !Number.isSafeInteger(declaredBytes) ||
    declaredBytes < 0 ||
    !Number.isFinite(now.getTime()) ||
    !ARTIFACT_RESERVATION_STARTED_AT_RE.test(startedAt) ||
    !ARTIFACT_RESERVATION_UUID_RE.test(uuid)
  )
    return { ok: false, reason: "reservation metadata unavailable" }
  const reservation = { pid: process.pid, machineId, declaredBytes, startedAt, uuid }
  const content = JSON.stringify(reservation) + "\n"
  const file = path.join(dir, `${startedAt}-${uuid}.json`)
  let fd: number
  try {
    fs.mkdirSync(dir, { recursive: true })
    fd = fs.openSync(file, "wx", 0o600)
  } catch {
    return { ok: false, reason: "reservation cannot be created" }
  }
  try {
    fs.writeFileSync(fd, content)
    fs.fsyncSync(fd)
    const stat = fs.fstatSync(fd, { bigint: true })
    const pathStat = fs.lstatSync(file, { bigint: true })
    if (!stat.isFile() || !pathStat.isFile() || stat.dev !== pathStat.dev || stat.ino !== pathStat.ino)
      throw new Error("reservation identity changed")
    return {
      ok: true,
      reservation: { ...reservation, file, runId, dev: stat.dev, ino: stat.ino, content, pathBound: true },
    }
  } catch {
    releaseArtifactQuotaReservation(file)
    return { ok: false, reason: "reservation cannot be persisted" }
  } finally {
    try {
      fs.closeSync(fd)
    } catch {
      // 该 fd 只指向本次唯一预约;关闭失败不扩大到其它路径。
    }
  }
}

function releaseArtifactQuotaReservation(file: string): boolean {
  try {
    fs.unlinkSync(file)
    return true
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "ENOENT"
  }
}

async function releaseOwnArtifactQuotaReservation(
  reservation: ArtifactQuotaReservation,
  deadline: number,
  beforeDelete?: () => void | Promise<void>,
): Promise<ArtifactQuotaReservationReleaseResult> {
  let current: ArtifactQuotaReservation | null
  try {
    current = await readArtifactQuotaReservationAsync(reservation.file, reservation.runId)
  } catch {
    return "changed"
  }
  if (Date.now() >= deadline) return "timed-out"
  if (!current) return "missing"
  if (!artifactQuotaReservationsMatch(current, reservation)) return "changed"
  try {
    await beforeDelete?.()
    if (Date.now() >= deadline) return "timed-out"
    await fs.promises.unlink(reservation.file)
    return "released"
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return "missing"
    return "failed"
  }
}

async function releaseOwnArtifactQuotaReservationBeforeDeadline(
  reservation: ArtifactQuotaReservation,
  testHooks?: ArtifactQuotaFinalizeOptions["testHooks"],
): Promise<ArtifactQuotaReservationReleaseResult> {
  const deadline =
    Date.now() +
    Math.min(
      ARTIFACT_QUOTA_RESERVATION_CLEANUP_DEADLINE_MS,
      Math.max(
        1,
        testHooks?.returnPolicy?.reservationDeadlineMs ?? ARTIFACT_QUOTA_RESERVATION_CLEANUP_DEADLINE_MS,
      ),
    )
  return resolveArtifactQuotaBeforeDeadline(
    async () => {
      try {
        await testHooks?.beforeReservationCleanupRead?.()
        if (Date.now() >= deadline) return "timed-out"
        return await releaseOwnArtifactQuotaReservation(
          reservation,
          deadline,
          testHooks?.beforeReservationCleanupDelete,
        )
      } catch {
        return "changed"
      }
    },
    deadline,
    "timed-out",
  )
}

async function scanArtifactQuotaReservations(
  runsDir: string,
  ownFile: string,
  machineId: string,
  pidAlive: (pid: number) => boolean | undefined,
  budget: ArtifactQuotaScanBudget,
): Promise<ArtifactQuotaReservation[]> {
  const reservations: ArtifactQuotaReservation[] = []
  for (const run of await readArtifactQuotaDirectory(runsDir, budget)) {
    if (!run.isDirectory() || !isSafeRunId(run.name)) continue
    const dir = path.join(runsDir, run.name, ARTIFACT_QUOTA_RESERVATIONS_DIR)
    for (const entry of await readArtifactQuotaDirectory(dir, budget)) {
      if (!entry.isFile()) throw new Error("invalid reservation entry")
      const file = path.join(dir, entry.name)
      const reservation = await readArtifactQuotaReservationAsync(file, run.name, true)
      requireArtifactQuotaScanBudget(budget)
      if (!reservation) continue
      if (
        file === ownFile ||
        !reservation.pathBound ||
        !artifactQuotaReservationOwnerIsDead(reservation, machineId, pidAlive)
      ) {
        reservations.push(reservation)
        continue
      }
      try {
        await fs.promises.unlink(file)
        // 本轮仍保守计费;删除只对下一次完整“预约 → committed”扫描生效。
      } catch {
        // 仅清理同机且 PID 已证死的唯一路径。失败或路径已消失时,本轮仍以刚绑定读取的
        // 声明保守计费;下一轮再从盘面重建真相。
      }
      requireArtifactQuotaScanBudget(budget)
      reservations.push(reservation)
    }
  }
  return reservations
}

async function readArtifactQuotaReservationAsync(
  file: string,
  runId: string,
  retainUnbound = false,
): Promise<ArtifactQuotaReservation | null> {
  const noFollow = typeof fs.constants.O_NOFOLLOW === "number" ? fs.constants.O_NOFOLLOW : 0
  const nonBlock = typeof fs.constants.O_NONBLOCK === "number" ? fs.constants.O_NONBLOCK : 0
  let handle: fs.promises.FileHandle
  try {
    handle = await fs.promises.open(file, fs.constants.O_RDONLY | noFollow | nonBlock)
  } catch (error) {
    if (artifactQuotaErrorCode(error) === "ENOENT") return null
    throw error
  }
  try {
    const stat = await handle.stat({ bigint: true })
    if (!stat.isFile() || stat.size > 4_096n) throw new Error("invalid reservation file")
    const content = await handle.readFile("utf8")
    let pathStat: fs.BigIntStats | null
    try {
      pathStat = await fs.promises.lstat(file, { bigint: true })
    } catch (error) {
      if (artifactQuotaErrorCode(error) !== "ENOENT") throw error
      pathStat = null
    }
    return bindArtifactQuotaReservation(file, runId, retainUnbound, stat, pathStat, content)
  } finally {
    await handle.close()
  }
}

function bindArtifactQuotaReservation(
  file: string,
  runId: string,
  retainUnbound: boolean,
  stat: fs.BigIntStats,
  pathStat: fs.BigIntStats | null,
  content: string,
): ArtifactQuotaReservation {
  if (!stat.isFile() || stat.size > 4_096n) throw new Error("invalid reservation file")
  const value = JSON.parse(content) as unknown
  if (!isArtifactQuotaReservationRecord(value)) throw new Error("invalid reservation record")
  if (path.basename(file) !== `${value.startedAt}-${value.uuid}.json`) throw new Error("reservation filename mismatch")
  if (!pathStat?.isFile() || stat.dev !== pathStat.dev || stat.ino !== pathStat.ino) {
    if (!retainUnbound) throw new Error("reservation identity changed")
    return { ...value, file, runId, dev: stat.dev, ino: stat.ino, content, pathBound: false }
  }
  return { ...value, file, runId, dev: stat.dev, ino: stat.ino, content, pathBound: true }
}

function isArtifactQuotaReservationRecord(value: unknown): value is ArtifactQuotaReservationRecord {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false
  const record = value as Record<string, unknown>
  return (
    Object.keys(record).length === 5 &&
    typeof record.pid === "number" &&
    Number.isInteger(record.pid) &&
    record.pid > 0 &&
    typeof record.machineId === "string" &&
    ARTIFACT_MACHINE_ID_RE.test(record.machineId) &&
    typeof record.declaredBytes === "number" &&
    Number.isSafeInteger(record.declaredBytes) &&
    record.declaredBytes >= 0 &&
    typeof record.startedAt === "string" &&
    ARTIFACT_RESERVATION_STARTED_AT_RE.test(record.startedAt) &&
    typeof record.uuid === "string" &&
    ARTIFACT_RESERVATION_UUID_RE.test(record.uuid)
  )
}

function artifactQuotaReservationOwnerIsDead(
  reservation: ArtifactQuotaReservation,
  machineId: string,
  pidAlive: (pid: number) => boolean | undefined,
): boolean {
  if (reservation.machineId !== machineId) return false
  try {
    return pidAlive(reservation.pid) === false
  } catch {
    return false
  }
}

function artifactQuotaReservationsMatch(a: ArtifactQuotaReservation, b: ArtifactQuotaReservation): boolean {
  return (
    a.file === b.file &&
    a.runId === b.runId &&
    a.dev === b.dev &&
    a.ino === b.ino &&
    a.content === b.content &&
    a.pathBound === b.pathBound &&
    a.pid === b.pid &&
    a.machineId === b.machineId &&
    a.declaredBytes === b.declaredBytes &&
    a.startedAt === b.startedAt &&
    a.uuid === b.uuid
  )
}

async function ownArtifactQuotaReservationIsUnchanged(reservation: ArtifactQuotaReservation): Promise<boolean> {
  try {
    const current = await readArtifactQuotaReservationAsync(reservation.file, reservation.runId)
    return current !== null && artifactQuotaReservationsMatch(current, reservation)
  } catch {
    return false
  }
}

async function ownArtifactQuotaReservationIsUnchangedBeforeDeadline(
  reservation: ArtifactQuotaReservation,
  deadline: number,
  beforeRead?: () => void | Promise<void>,
): Promise<boolean | "timed-out"> {
  const remaining = deadline - Date.now()
  if (remaining <= 0) return "timed-out"
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve("timed-out"), remaining)
    Promise.resolve()
      .then(() => beforeRead?.())
      .then(() => ownArtifactQuotaReservationIsUnchanged(reservation))
      .then(
        (unchanged) => {
          clearTimeout(timer)
          resolve(unchanged)
        },
        () => {
          clearTimeout(timer)
          resolve(false)
        },
      )
  })
}

async function closeStagedArtifactBeforeDeadline(
  staged: StagedArtifact,
  testHooks?: ArtifactQuotaFinalizeOptions["testHooks"],
): Promise<void> {
  const deadline =
    Date.now() +
    Math.min(
      ARTIFACT_QUOTA_STAGED_CLOSE_DEADLINE_MS,
      Math.max(1, testHooks?.returnPolicy?.stagedCloseDeadlineMs ?? ARTIFACT_QUOTA_STAGED_CLOSE_DEADLINE_MS),
    )
  await resolveArtifactQuotaBeforeDeadline(
    async () => {
      try {
        await testHooks?.beforeStagedHandleClose?.()
        await staged.handle.close()
      } catch {
        // 只读 staged fd;关闭失败或超时不改变已经得出的 fail-closed 结论。
      }
      return true
    },
    deadline,
    false,
  )
}

function resolveArtifactQuotaBeforeDeadline<T>(work: () => Promise<T>, deadline: number, timedOut: T): Promise<T> {
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve(timedOut), Math.max(1, deadline - Date.now()))
    work().then(
      (result) => {
        clearTimeout(timer)
        resolve(result)
      },
      () => {
        clearTimeout(timer)
        resolve(timedOut)
      },
    )
  })
}

function compareArtifactQuotaReservations(a: ArtifactQuotaReservation, b: ArtifactQuotaReservation): number {
  const startedAt = a.startedAt.localeCompare(b.startedAt)
  return startedAt || a.uuid.localeCompare(b.uuid)
}

function sumReservationBytes(reservations: ArtifactQuotaReservation[]): number {
  return reservations.reduce((sum, reservation) => sum + reservation.declaredBytes, 0)
}

function defaultPidAlive(pid: number): boolean | undefined {
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code
    if (code === "EPERM") return true
    if (code === "ESRCH") return false
    return undefined
  }
}

// ---------------------------------------------------------------------------
// 登记(#184 集成点)
// ---------------------------------------------------------------------------

/**
 * ⚠️ #184 集成点(唯一登记入口):流式下载器在 `.part` 写完、单遍 sha256 算得、
 * `finalizeArtifactWithQuota` 准入并原子 rename 到 `artifacts/<name>` 之后,以本函数登记。
 * 字节真相取自盘上 stat(不信调用方声明);descriptor 原样镜像存入。
 */
export type RegisterArtifactInput = {
  descriptor: ArtifactDescriptor
  /** run 目录内 POSIX 相对路径,必须位于 `artifacts/` 下(如 "artifacts/report.pdf")。 */
  savedPath: string
  /** 写入器单遍算得的 sha256(hex 小写)。缺省 = 写入器没算(状态只能是 unverified)。 */
  verifiedSha256?: string
  /** 写入器/平台侧 magic 检测结果与检测器标识(本服务只记录并列呈现,不自行推导)。 */
  detectedMime?: string
  detector?: string
  /** ISO-8601;缺省取当前时刻。 */
  downloadedAt?: string
}

export type RegisterArtifactResult = { ok: true; entry: ManifestArtifactEntry } | { ok: false; reason: string }

export function registerDownloadedArtifact(
  projectDir: string,
  runId: string,
  input: RegisterArtifactInput,
): RegisterArtifactResult {
  if (!isSafeRunId(runId)) return { ok: false, reason: "invalid run id" }
  if (!isSafeSavedPath(input.savedPath)) return { ok: false, reason: "savedPath violates the relative-path invariant" }
  // ADR-019 守卫:realpath 防逃逸(symlink 文件解析到 .code-puppy 外也在此被拒)。
  const target = safeResolveInAlpha(projectDir, "runs", runId, ...input.savedPath.split("/"))
  if (!target) return { ok: false, reason: "path escapes .code-puppy" }
  let st: fs.Stats
  try {
    st = fs.statSync(target)
  } catch {
    return { ok: false, reason: "file not found on disk (register after atomic rename)" }
  }
  if (!st.isFile()) return { ok: false, reason: "savedPath is not a regular file" }

  const read = readArtifactManifest(projectDir, runId)
  if (!read.ok)
    return {
      ok: false,
      reason:
        read.reason === "unsupported-version"
          ? `manifest is read-only: unsupported schemaVersion ${read.version}`
          : read.reason === "corrupt"
            ? `manifest is read-only: corrupt (${read.detail})`
            : "invalid run",
    }
  const manifest: ArtifactManifestV1 = read.manifest ?? {
    schemaVersion: ARTIFACT_MANIFEST_VERSION,
    runId,
    updatedAt: "",
    artifacts: [],
  }

  const d = input.descriptor
  const warnings: string[] = []
  let state: LocalArtifactState
  if (d.sha256 && input.verifiedSha256) {
    if (d.sha256 === input.verifiedSha256) state = "verified"
    else {
      state = "mismatch"
      warnings.push(`sha256 mismatch: descriptor ${d.sha256}, downloaded ${input.verifiedSha256}`)
    }
  } else if (typeof d.size === "number" && d.size !== st.size) {
    state = "mismatch"
    warnings.push(`size mismatch: descriptor claims ${d.size} bytes, on disk ${st.size}`)
  } else {
    // 无产出端 digest 可比:诚实 unverified;本地 digest 仅作后续漂移检测的 pin,不冒充 verified。
    state = "unverified"
  }
  const claimed = d.claimedMime
  const detected = input.detectedMime ?? d.detectedMime
  if (claimed && detected && claimed.toLowerCase() !== detected.toLowerCase())
    warnings.push(`mime conflict: claimed ${claimed}, detected ${detected}`)

  const entry: ManifestArtifactEntry = {
    descriptor: d,
    local: {
      savedPath: input.savedPath,
      downloadedAt: input.downloadedAt ?? new Date().toISOString(),
      bytesOnDisk: st.size,
      state,
      ...(input.verifiedSha256 ? { verifiedSha256: input.verifiedSha256 } : {}),
      ...(input.detectedMime ? { detectedMime: input.detectedMime } : {}),
      ...(input.detector ? { detector: input.detector } : {}),
      warnings,
    },
  }

  // upsert by id;同一 savedPath 不允许被两个不同 id 占用(同名不覆盖 —— 写入器负责去重命名,AC#6)。
  // #901:折叠比较(NFC + toLowerCase),不是精确字符串相等——大小写不敏感文件系统上
  // "artifacts/Report.pdf" 与 "artifacts/report.pdf" 是同一份磁盘字节,精确相等会放过它们,
  // 让 manifest 里出现两条记录共享一份文件而互不知情。
  const targetKey = foldedArtifactNameKey(input.savedPath)
  const pathOwner = manifest.artifacts.find(
    (e) => foldedArtifactNameKey(e.local.savedPath) === targetKey && e.descriptor.id !== d.id,
  )
  if (pathOwner) return { ok: false, reason: `savedPath already registered to artifact ${pathOwner.descriptor.id}` }
  const idx = manifest.artifacts.findIndex((e) => e.descriptor.id === d.id)
  if (idx >= 0) manifest.artifacts[idx] = entry
  else manifest.artifacts.push(entry)

  manifest.updatedAt = new Date().toISOString()
  const written = writeArtifactManifest(projectDir, runId, manifest)
  if (!written.ok) return { ok: false, reason: written.reason }
  return { ok: true, entry }
}

/**
 * #1112:账本视角的名字归属 —— `artifacts/<name>`(折叠键,与 registerDownloadedArtifact 的
 * pathOwner 检查同一比较)当前登记在哪个 artifactId 名下。预约(reserveArtifactSavedName)靠它
 * 区分「同一件重下(覆盖合法)」与「精确同名的另一件(必须消歧)」—— 后者缺了这一问会先覆盖
 * 字节、再被 register 拒绝,manifest 与盘面就地分叉(#402 格 5 C5.5 实测)。
 * manifest 不可读(corrupt / 未来版本)⇒ 一律 undefined:该状态下 register 本就整体拒写,
 * 预约退回纯磁盘判断,与今天一致。
 */
export function registeredArtifactNameOwner(projectDir: string, runId: string, name: string): string | undefined {
  const read = readArtifactManifest(projectDir, runId)
  if (!read.ok || !read.manifest) return undefined
  const key = foldedArtifactNameKey(`${RUN_ARTIFACTS_SUBDIR}/${name}`)
  return read.manifest.artifacts.find((e) => foldedArtifactNameKey(e.local.savedPath) === key)?.descriptor.id
}

// ---------------------------------------------------------------------------
// 列表 + reconcile
// ---------------------------------------------------------------------------

/** 未入 manifest 的盘上文件(legacy run 的只读发现,或写入器/登记之间的意外残留)。绝不持久化、绝不假报 verified。 */
export type LegacyRunFile = { name: string; savedPath: string; bytesOnDisk: number }

export type RunArtifactsListResult =
  | { ok: true; runId: string; entries: ManifestArtifactEntry[]; legacyFiles: LegacyRunFile[]; warnings: string[] }
  | { ok: false; reason: string }

/** artifacts/ 子目录递归清单(相对 run 目录的 POSIX savedPath)。 */
function walkArtifactFiles(runDir: string): LegacyRunFile[] {
  const artifactsDir = path.join(runDir, RUN_ARTIFACTS_SUBDIR)
  const out: LegacyRunFile[] = []
  const walk = (dir: string, rel: string) => {
    let items: fs.Dirent[]
    try {
      items = fs.readdirSync(dir, { withFileTypes: true })
    } catch {
      return
    }
    for (const item of items) {
      const childRel = `${rel}/${item.name}`
      // symlink 不跟随(防逃逸计量/发现);只统计常规文件。
      if (item.isDirectory()) walk(path.join(dir, item.name), childRel)
      else if (item.isFile()) {
        let size = 0
        try {
          size = fs.statSync(path.join(dir, item.name)).size
        } catch {
          continue
        }
        out.push({ name: item.name, savedPath: childRel, bytesOnDisk: size })
      }
    }
  }
  walk(artifactsDir, RUN_ARTIFACTS_SUBDIR)
  return out
}

/**
 * manifest + 磁盘 reconcile:
 *   · 文件消失 ⇒ state=missing;尺寸漂移 ⇒ state=mismatch(+warning)—— 降级持久化,重启后不回显旧 verified;
 *   · 恢复(verified/unverified 的文件回来了且尺寸吻合)不自动升级 —— digest 级复核走 verifyArtifact;
 *   · manifest 之外的盘上文件 → legacyFiles(只读发现,含无 manifest 的 legacy run;不生成假 descriptor)。
 * 未知未来版本 / corrupt ⇒ ok:false(只读报错,不静默重写,REQ-093 AC#8)。
 */
export function listRunArtifacts(projectDir: string, runId: string): RunArtifactsListResult {
  if (!isSafeRunId(runId)) return { ok: false, reason: "invalid run id" }
  const runDir = safeResolveInAlpha(projectDir, "runs", runId)
  if (!runDir) return { ok: false, reason: "path escapes .code-puppy" }
  const read = readArtifactManifest(projectDir, runId)
  if (!read.ok) {
    if (read.reason === "unsupported-version")
      return { ok: false, reason: `manifest is read-only: unsupported schemaVersion ${read.version}` }
    if (read.reason === "corrupt") return { ok: false, reason: `manifest is read-only: corrupt (${read.detail})` }
    return { ok: false, reason: "invalid run" }
  }

  const warnings: string[] = []
  const manifest = read.manifest
  const entries = manifest?.artifacts ?? []
  let dirty = false
  for (const entry of entries) {
    const target = safeResolveInAlpha(projectDir, "runs", runId, ...entry.local.savedPath.split("/"))
    let st: fs.Stats | null = null
    try {
      st = target ? fs.statSync(target) : null
    } catch {
      st = null
    }
    if (!st || !st.isFile()) {
      if (entry.local.state !== "missing") {
        entry.local.state = "missing"
        entry.local.warnings.push("file missing on disk (reconcile)")
        dirty = true
      }
      continue
    }
    if (st.size !== entry.local.bytesOnDisk) {
      if (entry.local.state !== "mismatch") {
        entry.local.state = "mismatch"
        entry.local.warnings.push(`size drift: recorded ${entry.local.bytesOnDisk} bytes, on disk ${st.size}`)
        dirty = true
      }
      continue
    }
    // 尺寸吻合的 missing 条目 = 文件回来了:恢复为 unverified(digest 级信心须经 verifyArtifact 重建)。
    if (entry.local.state === "missing") {
      entry.local.state = "unverified"
      entry.local.warnings.push("file reappeared on disk; digest not re-verified")
      dirty = true
    }
  }
  if (dirty && manifest) {
    manifest.updatedAt = new Date().toISOString()
    const written = writeArtifactManifest(projectDir, runId, manifest)
    if (!written.ok) warnings.push(`reconcile downgrade not persisted: ${written.reason}`)
  }

  const known = new Set(entries.map((e) => e.local.savedPath))
  const legacyFiles = walkArtifactFiles(runDir).filter((f) => !known.has(f.savedPath))
  if (!manifest && legacyFiles.length > 0)
    warnings.push("legacy run: artifacts/ discovered read-only without artifacts.json (unverified)")

  return { ok: true, runId, entries, legacyFiles, warnings }
}

// ---------------------------------------------------------------------------
// 解析 / 复核
// ---------------------------------------------------------------------------

export type ArtifactInspectResult = { ok: true; entry: ManifestArtifactEntry } | { ok: false; reason: string }

/** 按 artifact id 解析 descriptor + 本地状态(经 stat 级 reconcile)。 */
export function resolveArtifact(projectDir: string, runId: string, artifactId: string): ArtifactInspectResult {
  const list = listRunArtifacts(projectDir, runId)
  if (!list.ok) return list
  const entry = list.entries.find((e) => e.descriptor.id === artifactId)
  if (!entry) return { ok: false, reason: "artifact not found" }
  return { ok: true, entry }
}

function sha256File(file: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const hash = crypto.createHash("sha256")
    const stream = fs.createReadStream(file)
    stream.on("error", reject)
    stream.on("data", (chunk) => hash.update(chunk))
    stream.on("end", () => resolve(hash.digest("hex")))
  })
}

/**
 * 全量 digest 复核(REQ-093 AC#4 的"下次打开"钩子;打开/预览内容前调用):
 *   · 与 pin(verifiedSha256,否则 descriptor.sha256)比对;不符 ⇒ mismatch 降级并持久化,
 *     pin 保持期望值不被"治愈",算得的 digest 进 warning;
 *   · 之前无任何 digest:算得值记为 pin,状态保持 unverified(没有产出端结论可资升级);
 *   · descriptor.sha256 存在且吻合 ⇒ verified(含从 unverified 升级的情形)。
 */
export async function verifyArtifact(
  projectDir: string,
  runId: string,
  artifactId: string,
): Promise<ArtifactInspectResult> {
  if (!isSafeRunId(runId)) return { ok: false, reason: "invalid run id" }
  const read = readArtifactManifest(projectDir, runId)
  if (!read.ok || !read.manifest)
    return { ok: false, reason: read.ok ? "no manifest for run" : `manifest unreadable (${read.reason})` }
  const manifest = read.manifest
  const entry = manifest.artifacts.find((e) => e.descriptor.id === artifactId)
  if (!entry) return { ok: false, reason: "artifact not found" }
  const target = safeResolveInAlpha(projectDir, "runs", runId, ...entry.local.savedPath.split("/"))
  if (!target) return { ok: false, reason: "path escapes .code-puppy" }

  const persist = (): ArtifactInspectResult => {
    manifest.updatedAt = new Date().toISOString()
    const written = writeArtifactManifest(projectDir, runId, manifest)
    if (!written.ok) return { ok: false, reason: `verify result not persisted: ${written.reason}` }
    return { ok: true, entry }
  }

  let st: fs.Stats | null = null
  try {
    st = fs.statSync(target)
  } catch {
    st = null
  }
  if (!st || !st.isFile()) {
    if (entry.local.state !== "missing") {
      entry.local.state = "missing"
      entry.local.warnings.push("file missing on disk (verify)")
      return persist()
    }
    return { ok: true, entry }
  }

  let digest: string
  try {
    digest = await sha256File(target)
  } catch (error) {
    return { ok: false, reason: `digest failed: ${error instanceof Error ? error.message : "read error"}` }
  }
  entry.local.bytesOnDisk = st.size
  const claim = entry.descriptor.sha256 // 产出端结论(优先比对对象;远端结论保留来源,本地只降级)
  const pin = entry.local.verifiedSha256 // 本地下载时算得的 digest(无 claim 时的漂移检测基准)
  if (claim) {
    if (digest === claim) {
      entry.local.state = "verified"
      entry.local.verifiedSha256 = digest
    } else {
      entry.local.state = "mismatch"
      entry.local.warnings.push(`digest mismatch on verify: expected ${claim}, computed ${digest}`)
    }
  } else if (pin) {
    if (digest === pin) {
      entry.local.state = "unverified" // 与下载所得一致,但没有产出端结论可资升级
    } else {
      entry.local.state = "mismatch"
      entry.local.warnings.push(`digest drift on verify: downloaded ${pin}, computed ${digest}`)
    }
  } else {
    entry.local.verifiedSha256 = digest // 首次 pin:仅用于将来的漂移检测,状态诚实保持 unverified
    entry.local.state = "unverified"
  }
  return persist()
}

// ---------------------------------------------------------------------------
// 受控内容读取(REQ-094/095 Workbench 预览面;#186/#187)
// ---------------------------------------------------------------------------
//
// 字节访问模式(决策记录):renderer 侧 Workbench/renderer 不拿 file:// 自由寻径,也不开新
// protocol —— 全库唯一的本地文件到 renderer 先例是「有界字节过 IPC」(read-picked-file /
// read-clipboard-image),本表面沿用同款并收得更窄:
//   · 只可寻址 `.code-puppy/runs/<runId>/artifacts/` 内的文件(isSafeSavedPath + safeResolveInAlpha,
//     ADR-019 守卫复用;artifactId 经 manifest 解析,savedPath 直读仅限 legacy 只读发现);
//   · text 模式:上限 2 MiB,超限截断 + 诚实 truncated 标记(REQ-095 的 range/stream 全量虚拟化
//     属后续深化,此处先保证「大文件绝不整段进 IPC/store」的硬边界);
//   · bytes 模式(image 等二进制预览):上限 20 MiB,超限拒绝(fallback 卡片走系统外部打开),
//     绝不返回部分二进制冒充完整内容。

/** text 预览单次读取上限(2 MiB)。超出 → 截断 + truncated:true(诚实呈现,不静默)。 */
export const ARTIFACT_TEXT_PREVIEW_MAX_BYTES = 2 * 1024 * 1024
/** 二进制(image 等)内联预览上限(20 MiB)。超出 → 拒绝(不截断二进制 —— 部分字节没有意义)。 */
export const ARTIFACT_BINARY_PREVIEW_MAX_BYTES = 20 * 1024 * 1024

/** 读取目标:manifest 内 artifact(按 id)或 legacy 盘上文件(按 run 内相对 savedPath)。 */
export type ArtifactReadRef = { artifactId: string } | { savedPath: string }

export type ArtifactReadResult =
  | {
      ok: true
      kind: "text"
      /** UTF-8 lossy 解码(截断边缘可能出现替换符;二进制误判经 binary 标记诊断)。 */
      text: string
      totalBytes: number
      readBytes: number
      truncated: boolean
      /** 首 8 KiB 内出现 NUL ⇒ 疑似二进制(诊断标记,消费端据此提示,不静默当文本)。 */
      binary: boolean
    }
  | { ok: true; kind: "bytes"; bytes: Uint8Array; totalBytes: number }
  | { ok: false; reason: string }

/**
 * 受控读取 run artifact 内容(Workbench 预览唯一取字节入口)。
 * 不做 mime 判断、不解码格式 —— 只负责守卫 + 上限 + 诚实截断标记;路由与呈现在 renderer 注册表。
 */
export function readArtifactContent(
  projectDir: string,
  runId: string,
  ref: ArtifactReadRef,
  opts?: { mode?: "text" | "bytes"; maxBytes?: number },
): ArtifactReadResult {
  if (!isSafeRunId(runId)) return { ok: false, reason: "invalid run id" }

  let savedPath: string
  if ("artifactId" in ref) {
    const read = readArtifactManifest(projectDir, runId)
    if (!read.ok)
      return {
        ok: false,
        reason: read.reason === "invalid-run" ? "invalid run" : `manifest unreadable (${read.reason})`,
      }
    const entry = read.manifest?.artifacts.find((e) => e.descriptor.id === ref.artifactId)
    if (!entry) return { ok: false, reason: "artifact not found" }
    savedPath = entry.local.savedPath
  } else {
    // legacy 只读发现:savedPath 必须满足与 manifest 同一不变量(artifacts/ 内、相对、无穿越)。
    if (!isSafeSavedPath(ref.savedPath)) return { ok: false, reason: "savedPath violates the relative-path invariant" }
    savedPath = ref.savedPath
  }

  const target = safeResolveInAlpha(projectDir, "runs", runId, ...savedPath.split("/"))
  if (!target) return { ok: false, reason: "path escapes .code-puppy" }
  let st: fs.Stats
  try {
    st = fs.statSync(target)
  } catch {
    return { ok: false, reason: "file missing on disk" }
  }
  if (!st.isFile()) return { ok: false, reason: "not a regular file" }

  const mode = opts?.mode ?? "text"
  if (mode === "bytes") {
    // 调用方可再收窄上限,但永远不能放宽(min 收敛)。
    const cap = Math.min(
      Math.max(1, opts?.maxBytes ?? ARTIFACT_BINARY_PREVIEW_MAX_BYTES),
      ARTIFACT_BINARY_PREVIEW_MAX_BYTES,
    )
    if (st.size > cap)
      return { ok: false, reason: `file too large for inline preview (${st.size} bytes > ${cap} limit)` }
    try {
      const buf = fs.readFileSync(target)
      return {
        ok: true,
        kind: "bytes",
        bytes: new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength),
        totalBytes: st.size,
      }
    } catch (error) {
      return { ok: false, reason: error instanceof Error ? error.message : "read failed" }
    }
  }

  const cap = Math.min(Math.max(1, opts?.maxBytes ?? ARTIFACT_TEXT_PREVIEW_MAX_BYTES), ARTIFACT_TEXT_PREVIEW_MAX_BYTES)
  const readBytes = Math.min(st.size, cap)
  const buf = Buffer.alloc(readBytes)
  let fd: number | null = null
  try {
    fd = fs.openSync(target, "r")
    let off = 0
    while (off < readBytes) {
      const n = fs.readSync(fd, buf, off, readBytes - off, off)
      if (n <= 0) break
      off += n
    }
    const sniff = buf.subarray(0, Math.min(off, 8 * 1024))
    const binary = sniff.includes(0)
    return {
      ok: true,
      kind: "text",
      text: buf.subarray(0, off).toString("utf8"),
      totalBytes: st.size,
      readBytes: off,
      truncated: st.size > off,
      binary,
    }
  } catch (error) {
    return { ok: false, reason: error instanceof Error ? error.message : "read failed" }
  } finally {
    if (fd !== null) {
      try {
        fs.closeSync(fd)
      } catch {
        /* best-effort close */
      }
    }
  }
}

// ---------------------------------------------------------------------------
// 删除 / GC 钩子
// ---------------------------------------------------------------------------

export type RemoveArtifactResult = { ok: true; removedFile: boolean } | { ok: false; reason: string }

/**
 * 本地删除 + manifest 原子更新(GC 钩子)。保留/清理**策略**(30 天、pinned、dry-run 审计计划)
 * 不在这里 —— REQ-093 交付 6 的策略面归 retention 专项;本函数只保证:守卫内删除、无悬挂引用。
 * 文件已消失时仍移除条目(幂等);unlink 失败(权限等)则不动 manifest,不留"账没了文件还在"。
 */
export function removeArtifact(projectDir: string, runId: string, artifactId: string): RemoveArtifactResult {
  if (!isSafeRunId(runId)) return { ok: false, reason: "invalid run id" }
  const read = readArtifactManifest(projectDir, runId)
  if (!read.ok)
    return {
      ok: false,
      reason:
        read.reason === "unsupported-version"
          ? `manifest is read-only: unsupported schemaVersion ${read.version}`
          : read.reason === "corrupt"
            ? `manifest is read-only: corrupt (${read.detail})`
            : "invalid run",
    }
  if (!read.manifest) return { ok: false, reason: "no manifest for run" }
  const manifest = read.manifest
  const idx = manifest.artifacts.findIndex((e) => e.descriptor.id === artifactId)
  if (idx < 0) return { ok: false, reason: "artifact not found" }
  const entry = manifest.artifacts[idx]
  const target = safeResolveInAlpha(projectDir, "runs", runId, ...entry.local.savedPath.split("/"))
  if (!target) return { ok: false, reason: "path escapes .code-puppy" }
  let removedFile = false
  try {
    fs.unlinkSync(target)
    removedFile = true
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT")
      return { ok: false, reason: error instanceof Error ? error.message : "unlink failed" }
  }
  manifest.artifacts.splice(idx, 1)
  manifest.updatedAt = new Date().toISOString()
  const written = writeArtifactManifest(projectDir, runId, manifest)
  if (!written.ok) return { ok: false, reason: `file removed but manifest update failed: ${written.reason}` }
  return { ok: true, removedFile }
}

// ---------------------------------------------------------------------------
// 字节核算(quota/retention 供数;quota 执行点在本文件上方 finalizer)
// ---------------------------------------------------------------------------

export type RunArtifactUsage = {
  runId: string
  artifactCount: number
  /** manifest 记录的字节合计(账面)。 */
  recordedBytes: number
  /** 盘上 stat 真相合计(artifacts/ 全部常规文件,含未登记者)。 */
  diskBytes: number
  /** 未入 manifest 的盘上字节(legacy/残留)。 */
  legacyBytes: number
  missingCount: number
  /** manifest 未知版本/corrupt(数字只来自盘上 stat)。 */
  readOnly: boolean
  /**
   * manifest 原样记录的 `updatedAt`(#660 裁决 B1)。没有可读 manifest 时为 `null` ——
   * 刻意不回落目录 mtime:mtime 是「最后一次动盘」这另一个事实,冒充「这次任务的时刻」
   * 会造出永远不会被发现的错值。界面对 `null` 失败关闭,回落显示编号。
   */
  updatedAt: string | null
}

export type RunUsageResult = { ok: true; usage: RunArtifactUsage } | { ok: false; reason: string }

export function runArtifactUsage(projectDir: string, runId: string): RunUsageResult {
  if (!isSafeRunId(runId)) return { ok: false, reason: "invalid run id" }
  const runDir = safeResolveInAlpha(projectDir, "runs", runId)
  if (!runDir) return { ok: false, reason: "path escapes .code-puppy" }
  const files = walkArtifactFiles(runDir)
  const diskBytes = files.reduce((sum, f) => sum + f.bytesOnDisk, 0)
  const read = readArtifactManifest(projectDir, runId)
  if (!read.ok) {
    if (read.reason === "invalid-run") return { ok: false, reason: "invalid run" }
    return {
      ok: true,
      usage: {
        runId,
        artifactCount: 0,
        recordedBytes: 0,
        diskBytes,
        legacyBytes: diskBytes,
        missingCount: 0,
        readOnly: true,
        updatedAt: null,
      },
    }
  }
  const entries = read.manifest?.artifacts ?? []
  const known = new Set(entries.map((e) => e.local.savedPath))
  const legacyBytes = files.filter((f) => !known.has(f.savedPath)).reduce((sum, f) => sum + f.bytesOnDisk, 0)
  const onDisk = new Set(files.map((f) => f.savedPath))
  return {
    ok: true,
    usage: {
      runId,
      artifactCount: entries.length,
      recordedBytes: entries.reduce((sum, e) => sum + e.local.bytesOnDisk, 0),
      diskBytes,
      legacyBytes,
      missingCount: entries.filter((e) => !onDisk.has(e.local.savedPath)).length,
      readOnly: false,
      updatedAt: read.manifest?.updatedAt ?? null,
    },
  }
}

export type ProjectArtifactUsage = {
  totalRecordedBytes: number
  totalDiskBytes: number
  totalArtifacts: number
  runs: RunArtifactUsage[]
  /** 基线(REQ-093 §5;集中可见,UI/错误提示引用这里,不散落魔数)。 */
  limits: { artifactMaxBytes: number; runMaxBytes: number; runMaxCount: number; projectMaxBytes: number }
}

export type ProjectUsageResult = { ok: true; usage: ProjectArtifactUsage } | { ok: false; reason: string }

/** 项目级(managed project)核算:遍历 `.code-puppy/runs/*` 逐 run 汇总。 */
export function projectArtifactUsage(projectDir: string): ProjectUsageResult {
  const runsDir = safeResolveInAlpha(projectDir, "runs")
  if (!runsDir) return { ok: false, reason: "invalid project dir" }
  let ids: string[] = []
  try {
    ids = fs
      .readdirSync(runsDir, { withFileTypes: true })
      .filter((d) => d.isDirectory() && isSafeRunId(d.name))
      .map((d) => d.name)
  } catch {
    ids = [] // runs/ 尚不存在 = 零用量
  }
  const runs: RunArtifactUsage[] = []
  for (const id of ids) {
    const res = runArtifactUsage(projectDir, id)
    if (res.ok) runs.push(res.usage)
  }
  return {
    ok: true,
    usage: {
      totalRecordedBytes: runs.reduce((sum, r) => sum + r.recordedBytes, 0),
      totalDiskBytes: runs.reduce((sum, r) => sum + r.diskBytes, 0),
      totalArtifacts: runs.reduce((sum, r) => sum + r.artifactCount, 0),
      runs,
      limits: {
        artifactMaxBytes: ARTIFACT_MAX_BYTES,
        runMaxBytes: MAX_RUN_ARTIFACT_BYTES,
        runMaxCount: MAX_ARTIFACTS_PER_RUN,
        projectMaxBytes: MAX_PROJECT_ARTIFACT_BYTES,
      },
    },
  }
}
