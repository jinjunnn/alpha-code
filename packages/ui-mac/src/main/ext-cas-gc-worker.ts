// ext-cas-gc-worker — REQ-102 #367:CAS GC 单轮在 worker_threads 内执行(main 线程零阻塞)。
//
// 拓扑(2026-07-16 Codex 裁决,#367 评论):collectCasGarbage 纯 fs/crypto 零改直迁;同进程
// 共享 pid → ext-bundle-lock 的 pid 记录与 pidAlive 语义不变(残余差异:worker 致命终止而
// main 存活时,锁最长等 15 分钟心跳 stale 接管 —— 合同已留痕)。入参经 workerData(纯 JSON
// 线格,此处严格解码 fail-closed:形状不符直接抛 → parent 'error' 事件按 gc-exception 处理);
// 出参 = 紧凑摘要 postMessage(裁决 Q2 修订:不回传完整 CasGcReport —— extreme 档
// sweepable/swept/warnings 上万条 structured clone 过重,main 只记计数)。日志走 collector
// 缺省 console.error(worker_threads 与宿主共享 stderr)。应用退出致本轮中断 = 模块既有
// 崩溃安全合同(blob 独立无序删,下一轮从头 mark)。
import { isMainThread, parentPort, workerData } from "node:worker_threads"
import * as path from "node:path"
import { collectCasGarbage, summarizeCasGcReport, type CasGcRoundInput } from "./ext-cas-gc"

const isRec = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v)

const INPUT_KEYS = new Set(["casBaseRoot", "envRoots", "seedLockPaths", "graceMs", "dryRun"])

/** workerData 严格解码(fail-closed;未知键拒,全部路径字段(含 seedLockPaths 逐元素)必须
 *  绝对路径 —— 相对路径会按 worker cwd 解析,#385 review r1 F4)。 */
export function decodeCasGcRoundInput(v: unknown): { ok: true; input: CasGcRoundInput } | { ok: false; reason: string } {
  if (!isRec(v)) return { ok: false, reason: "workerData must be an object" }
  for (const key of Object.keys(v)) if (!INPUT_KEYS.has(key)) return { ok: false, reason: `workerData has unknown key "${key}" — refused` }
  if (typeof v.casBaseRoot !== "string" || !path.isAbsolute(v.casBaseRoot))
    return { ok: false, reason: "casBaseRoot must be an absolute path" }
  const strings = (x: unknown): string[] | undefined =>
    Array.isArray(x) && x.every((s): s is string => typeof s === "string") ? x : undefined
  const envRoots = strings(v.envRoots)
  if (!envRoots || envRoots.some((r) => !path.isAbsolute(r))) return { ok: false, reason: "envRoots must be absolute paths" }
  const seedLockPaths = strings(v.seedLockPaths)
  if (!seedLockPaths || seedLockPaths.some((p) => !path.isAbsolute(p)))
    return { ok: false, reason: "seedLockPaths must be absolute paths" }
  if (typeof v.graceMs !== "number" || !Number.isFinite(v.graceMs) || v.graceMs < 0)
    return { ok: false, reason: "graceMs must be a non-negative number" }
  if (typeof v.dryRun !== "boolean") return { ok: false, reason: "dryRun must be boolean" }
  return { ok: true, input: { casBaseRoot: v.casBaseRoot, envRoots, seedLockPaths, graceMs: v.graceMs, dryRun: v.dryRun } }
}

// 入口本体:仅在 worker 上下文执行(被 main/测试 import 取解码器时零副作用)。
if (!isMainThread && parentPort) {
  const decoded = decodeCasGcRoundInput(workerData)
  if (!decoded.ok) throw new Error(`ext-cas-gc-worker: invalid workerData (fail closed): ${decoded.reason}`)
  const { input } = decoded
  const report = collectCasGarbage(input.casBaseRoot, {
    envRoots: input.envRoots,
    seedLockPaths: input.seedLockPaths,
    graceMs: input.graceMs,
    dryRun: input.dryRun,
  })
  parentPort.postMessage(summarizeCasGcReport(report))
}
