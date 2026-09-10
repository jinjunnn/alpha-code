// REQ-159 (`#1322`) —— AC3 的判据本体(测试旁的纯函数,**不是**生产代码;两份测试共用:
// workspace-write-probe.test.ts 用它自证「测得出已知的坏」,workspace-write-probe-fence.test.ts 用它判真探针)。
//
// 一个探针只有**先在可写工作区上答过「可写」**、再在集合外答「不可写」,它的「不可写」才算数。两个替身各错一边:
//   · 恒答 denied —— 会把每个项目都标成只读;
//   · 恒答 writable —— 永远报不出只读工作区;不套围栏的进程(main)里跑探针就是这一种。
import type { WorkspaceWriteProbeOutcome } from "./workspace-write-probe"

export function judgeWriteProbeCalibration(arm: { inside: WorkspaceWriteProbeOutcome; outside: WorkspaceWriteProbeOutcome }) {
  if (arm.inside !== "writable")
    return { ok: false as const, reason: `rejected: answers "${arm.inside}" for a writable workspace — it would mark every project read-only` }
  if (arm.outside !== "denied")
    return { ok: false as const, reason: `rejected: answers "${arm.outside}" outside the writable set — it never reports a read-only workspace (that is what an unfenced / main-process probe says)` }
  return { ok: true as const }
}
