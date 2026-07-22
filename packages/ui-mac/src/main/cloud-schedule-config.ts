import type { AutomationTask } from "../shared/automation-types"

export function cloudScheduleEnvelopeFor(task: AutomationTask): Record<string, unknown> {
  return { autonomy: "pipeline", kind: "research", input: { question: task.prompt } }
}

export function cloudScheduleRegistrationFor(task: AutomationTask, cron: string) {
  return { name: task.name, cron, envelope: cloudScheduleEnvelopeFor(task), enabled: task.enabled }
}
