import { randomUUID } from "node:crypto"
import type { AutomationTask } from "../shared/automation-types"

// #400 / platform#255:schedule 注册端(alpha-platform lib/schedules.ts)同样用
// CloudJobRequestV1Schema 全量校验 envelope,幂等键因此在这里也是必填 —— 缺了它,平台一部署,
// 保存云档自动化就地 400。一次注册 = 一个用户意图,键 mint 一次随注册信封冻结在 B 的 registry。
// (每次到点 fire 的 job 身份归平台侧调度器;desktop 不复制那半边逻辑。)
export function cloudScheduleEnvelopeFor(task: AutomationTask): Record<string, unknown> {
  return {
    schema_version: 1,
    idempotency_key: randomUUID(),
    autonomy: "pipeline",
    kind: "research",
    input: { question: task.prompt },
  }
}

export function cloudScheduleRegistrationFor(task: AutomationTask, cron: string) {
  return { name: task.name, cron, envelope: cloudScheduleEnvelopeFor(task), enabled: task.enabled }
}
