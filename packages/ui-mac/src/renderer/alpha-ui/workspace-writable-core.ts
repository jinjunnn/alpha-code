// REQ-159 `#1322`(AC2)—— 「当前工作区写得进去吗」的纯状态机(零 Solid、零 window,bun 直接可测)。
//
// 四态与呈现(设计 §3.2):探针未答 / 可写 / 未知 ⇒ **无标记**;只有引擎明确回报 denied ⇒ 标记。
// 三条纪律:
//   · 只在沙箱真装上时才探(sandbox=false ⇒ 不探、不标 —— 非 darwin 上探针会答 writable 或 EACCES,
//     两者都不是「沙箱把它挡住了」,而披露文案把原因归给沙箱);
//   · 答案按「引擎代 + 目录」缓存:换代(respawn)之后可写集重新取并集,旧代的 denied 不许带到新代;
//   · 一个目录同一代只探一次;在途时再问就是 pending(无标记),不重复发。
// 探针的执行方是 preload 桥背后**被围栏的 sidecar**(main/workspace-write-probe.ts);这里不认识路径,
// 也不做任何字符串比较 —— `#1317` 实测那四种形状的错都来自字符串判据。

import type { WorkspaceWriteProbeResult } from "../../preload/types"

export type WorkspaceWritableAnswer = "pending" | "writable" | "denied" | "unknown"

export type WorkspaceWritableProbe = (directory: string) => Promise<WorkspaceWriteProbeResult>

export type WorkspaceWritableObservation = {
  /** 在线引擎的代号;undefined = 引擎不在 ⇒ 不探(unknown)。 */
  generation: number | undefined
  directory: string | undefined
  /** 引擎自报装上了围栏;false ⇒ 不探(unknown)。 */
  sandbox: boolean
}

export type WorkspaceWritableTracker = {
  /** 「这个目录成为当前工作区」那一拍调一次(幂等):该代该目录没问过就发一次探针。 */
  observe(input: WorkspaceWritableObservation): void
  /** 当前答案;不满足探测前提 = unknown。 */
  answer(input: WorkspaceWritableObservation): WorkspaceWritableAnswer
  /** 呈现层判据:只有 denied 才是只读。 */
  readonly(input: WorkspaceWritableObservation): boolean
  reset(): void
}

const keyOf = (generation: number, directory: string) => `${generation}\u0000${directory}`

function eligible(input: WorkspaceWritableObservation): input is WorkspaceWritableObservation & { generation: number; directory: string } {
  return input.sandbox && input.generation !== undefined && typeof input.directory === "string" && input.directory.length > 0
}

export function createWorkspaceWritableTracker(probe: WorkspaceWritableProbe, onChange: () => void = () => {}): WorkspaceWritableTracker {
  const answers = new Map<string, WorkspaceWritableAnswer>()
  const settle = (key: string, next: WorkspaceWritableAnswer) => {
    // 只有仍在 pending 的那一格才收答案 —— reset 之后迟到的应答不得复活旧格。
    if (answers.get(key) !== "pending") return
    answers.set(key, next)
    onChange()
  }
  return {
    observe(input) {
      if (!eligible(input)) return
      const key = keyOf(input.generation, input.directory)
      if (answers.has(key)) return
      answers.set(key, "pending")
      onChange()
      let outcome: Promise<WorkspaceWriteProbeResult>
      try {
        outcome = probe(input.directory)
      } catch {
        settle(key, "unknown")
        return
      }
      outcome.then(
        (result) => settle(key, result?.outcome === "writable" || result?.outcome === "denied" ? result.outcome : "unknown"),
        () => settle(key, "unknown"),
      )
    },
    answer(input) {
      if (!eligible(input)) return "unknown"
      return answers.get(keyOf(input.generation, input.directory)) ?? "unknown"
    },
    readonly(input) {
      return this.answer(input) === "denied"
    },
    reset() {
      answers.clear()
      onChange()
    },
  }
}
