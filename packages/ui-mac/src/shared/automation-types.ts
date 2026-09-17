// 自动化(定时任务)实体 —— REQ-021 全期共用形状(A1 只消费其中本地只读子集)。
// 落盘:<current-environment-root>/automations/<id>.json(main/alpha-automations.ts);运行记录写目标项目
// .code-puppy/runs/auto-<id>-<ts>/(ADR-019 schema)。跨 bundle 纯类型,零运行时依赖。

/** 调度形状。tz 字段 A1 只存不算(计算用系统本地时区,ADR-022 §边界)。 */
export type AutomationSchedule =
  | { kind: "cron"; expr: string; tz?: string } // 5 字段 cron(分 时 日 月 周)
  | { kind: "interval"; everyMinutes: number; tz?: string }
  | { kind: "once"; at: string; tz?: string } // ISO 时间戳(A1 UI 不产,实体预留)

export type AutomationRunStatus = "ok" | "failed" | "timeout" | "skipped-overlap" | "skipped-cap"

export interface AutomationRunRecord {
  at: string // ISO,触发时刻
  status: AutomationRunStatus
  durationMs?: number
  sessionID?: string
  /** 目标项目内的 run 目录(绝对路径),ok/failed/timeout 时存在。 */
  runDir?: string
  /** 最终回复首行(列表/历史摘要用),或失败原因。 */
  summary?: string
}

export interface AutomationTask {
  id: string
  name: string
  /** 用户原始一句话(可追溯;编辑后与 schedule/prompt 可能分叉,仅存档)。 */
  nlText: string
  schedule: AutomationSchedule
  target: {
    projectDir: string
    /** 引擎 agent 名;A1 恒为 "alpha-automation"(readonly 档)。 */
    agent: string
    /** "providerID/modelID" 形式;缺省用引擎默认模型。 */
    model?: string
  }
  prompt: string
  execution: "local" | "cloud" // cloud = A3(REQ-025):B 侧 schedule,app 不在线也执行
  /** A3:B 侧 schedule id(execution:cloud 时存在;删除/启停随任务同步到 B)。 */
  cloudScheduleId?: string
  permissionProfile: "readonly" | "standard" // A1 恒 readonly;standard 归 A2
  budget: { maxDurationMin: number }
  overlapPolicy: "skip"
  catchUpPolicy: "skip"
  notify: { system: boolean }
  enabled: boolean
  /** A2:连败熔断自动停用的原因(重新启用时清除;UI 呈现)。 */
  disabledReason?: "consecutive_failures"
  createdAt: string
  lastRun?: AutomationRunRecord
  /** 运行历史(新在前,capped,默认留 30 条)。 */
  history?: AutomationRunRecord[]
}

/**
 * [#1001] 存储层拒绝一个任务时的**本地结构码**(main 铸,经 IPC 原样带到 renderer,由那里唯一有
 * i18n 的一层选文案;英文 reason 只进日志)。刻意用 kebab + `automation-` 前缀:平台分类码是 snake,
 * 桌面传输伪码不带这个前缀,三个域结构上不相交。renderer 的文案表以本类型为键,漏一个码 typecheck 即红。
 */
export type AutomationStoreErrorCode =
  | "automation-invalid" // 面板结构上发不出的形状(id / execution / permissionProfile / 非对象)
  | "automation-name-invalid"
  | "automation-prompt-invalid"
  | "automation-project-dir-invalid" // 非绝对路径 / 不存在 / 不是目录
  | "automation-schedule-invalid"
  | "automation-duration-invalid"
  | "automation-storage-failed" // 落盘抛错(磁盘满 / 无权限)

/** 调度器 → renderer 的推送事件(preload "automation-event" 通道)。 */
export type AutomationEvent =
  | { type: "run-started"; taskId: string; at: string }
  | { type: "run-finished"; taskId: string; record: AutomationRunRecord }
  | { type: "tasks-changed" }

/** 当前环境的全局调度状态(<current-environment-root>/automations/_state.json)。 */
export interface AutomationGlobalState {
  pausedAll: boolean
  /** 全局 dailyRunCap 记账:日期(YYYY-MM-DD,本地)+ 当日已运行次数。 */
  runCount: { date: string; count: number }
}

export const AUTOMATION_DEFAULTS = {
  maxDurationMin: 15,
  dailyRunCap: 24,
  historyKeep: 30,
  /** interval 下限(防打点风暴;cap 之外的第二道)。 */
  minIntervalMinutes: 5,
  agent: "alpha-automation",
  /** A2:standard(可写)档 agent。 */
  agentStandard: "alpha-automation-standard",
  /** A2:连败熔断阈值(连续 failed/timeout 次数)。 */
  failureBreaker: 3,
} as const
