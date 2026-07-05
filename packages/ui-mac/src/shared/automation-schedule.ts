// 调度纯逻辑(REQ-021 A1.3 / 验收⑥):下次触发计算 + cron 解析 + 人话描述。
// 零依赖、零 IO —— main 调度器与 renderer 预览卡共用;单测在 automation-schedule.test.ts。
//
// cron = 标准 5 字段(分 时 日 月 周),支持 * 、*/n 、a-b 、a-b/n 、逗号列表;周 0-7(0/7=周日)。
// dom 与 dow 同时受限时按标准 OR 语义(vixie cron)。计算用**系统本地时区**(tz 字段 A1 只存不算,
// ADR-022 §边界);错过的触发不补(catchUpPolicy:skip)—— 调用方直接以「现在」重算下一次。

import type { AutomationSchedule } from "./automation-types"

// ── cron 解析 ────────────────────────────────────────────────────────────────────────────────

export interface CronSpec {
  minute: Set<number>
  hour: Set<number>
  /** null = 该字段为 *(不受限)。dom/dow 需要区分 * 与全集,OR 语义依赖这一点。 */
  dom: Set<number> | null
  month: Set<number>
  dow: Set<number> | null
}

function parseField(field: string, min: number, max: number, normalize?: (n: number) => number): Set<number> | null {
  if (field === "*") return null
  const out = new Set<number>()
  for (const part of field.split(",")) {
    const m = /^(\*|\d+(?:-\d+)?)(?:\/(\d+))?$/.exec(part)
    if (!m) throw new Error(`invalid cron field: ${part}`)
    const step = m[2] ? parseInt(m[2], 10) : 1
    if (step < 1) throw new Error(`invalid cron step: ${part}`)
    let lo = min
    let hi = max
    if (m[1] !== "*") {
      const range = m[1].split("-").map((n) => parseInt(n, 10))
      lo = range[0]
      hi = range.length > 1 ? range[1] : range[0]
      if (range.length === 1 && m[2]) hi = max // "N/step" = 从 N 起步进(cron 惯例)
    }
    if (lo < min || hi > max || lo > hi) throw new Error(`cron field out of range: ${part}`)
    for (let n = lo; n <= hi; n += step) out.add(normalize ? normalize(n) : n)
  }
  return out
}

export function parseCron(expr: string): CronSpec {
  const fields = expr.trim().split(/\s+/)
  if (fields.length !== 5) throw new Error(`cron must have 5 fields, got ${fields.length}`)
  return {
    minute: parseField(fields[0], 0, 59) ?? allOf(0, 59),
    hour: parseField(fields[1], 0, 23) ?? allOf(0, 23),
    dom: parseField(fields[2], 1, 31),
    month: parseField(fields[3], 1, 12) ?? allOf(1, 12),
    dow: parseField(fields[4], 0, 7, (n) => (n === 7 ? 0 : n)),
  }
}

function allOf(min: number, max: number): Set<number> {
  const s = new Set<number>()
  for (let n = min; n <= max; n++) s.add(n)
  return s
}

/** cron 表达式是否可解析(UI 校验用)。 */
export function isValidCron(expr: string): boolean {
  try {
    parseCron(expr)
    return true
  } catch {
    return false
  }
}

function cronMatches(spec: CronSpec, d: Date): boolean {
  if (!spec.minute.has(d.getMinutes())) return false
  if (!spec.hour.has(d.getHours())) return false
  if (!spec.month.has(d.getMonth() + 1)) return false
  const domOk = spec.dom === null || spec.dom.has(d.getDate())
  const dowOk = spec.dow === null || spec.dow.has(d.getDay())
  // 标准语义:dom 与 dow 都受限 → OR;否则 AND(未受限侧恒真)。
  if (spec.dom !== null && spec.dow !== null) return domOk || dowOk
  return domOk && dowOk
}

// ── 下次触发 ─────────────────────────────────────────────────────────────────────────────────

/** 搜索上限:400 天内无匹配视为无下一次(如 2 月 30 日)。 */
const CRON_SEARCH_LIMIT_MIN = 400 * 24 * 60

/**
 * 下次触发时刻(严格 > after)。interval 以 anchor(任务 createdAt)为锚对齐整周期,
 * 保证重启/错过后节拍稳定而非漂移。返回 null = 不再触发(once 已过 / cron 无匹配)。
 */
export function nextFire(schedule: AutomationSchedule, after: Date, anchor?: Date): Date | null {
  if (schedule.kind === "once") {
    const at = new Date(schedule.at)
    if (Number.isNaN(at.getTime())) return null
    return at.getTime() > after.getTime() ? at : null
  }
  if (schedule.kind === "interval") {
    const stepMs = Math.max(1, Math.round(schedule.everyMinutes)) * 60_000
    const base = anchor ? anchor.getTime() : after.getTime()
    if (base > after.getTime()) return new Date(base)
    const periods = Math.floor((after.getTime() - base) / stepMs) + 1
    return new Date(base + periods * stepMs)
  }
  const spec = parseCron(schedule.expr)
  // 从下一个整分开始逐分钟扫(秒/毫秒清零)。
  const cursor = new Date(after.getTime())
  cursor.setSeconds(0, 0)
  for (let i = 0; i < CRON_SEARCH_LIMIT_MIN; i++) {
    cursor.setTime(cursor.getTime() + 60_000)
    if (cronMatches(spec, cursor)) return new Date(cursor.getTime())
  }
  return null
}

/**
 * 错过判定(验收⑥):planned 已到期而未执行 → 按 catchUpPolicy:skip 丢弃,
 * 返回以 now 重算的下一次。planned 未到期则原样保留。
 */
export function rescheduleAfterGap(
  schedule: AutomationSchedule,
  planned: Date | null,
  now: Date,
  anchor?: Date,
): { next: Date | null; missed: boolean } {
  if (planned && planned.getTime() > now.getTime()) return { next: planned, missed: false }
  return { next: nextFire(schedule, now, anchor), missed: planned !== null }
}

// ── 人话描述(列表「人话周期」列 + 预览卡)─────────────────────────────────────────────────────

const DOW_ZH = ["日", "一", "二", "三", "四", "五", "六"]

function pad(n: number): string {
  return String(n).padStart(2, "0")
}

function sameSet(s: Set<number>, values: number[]): boolean {
  return s.size === values.length && values.every((v) => s.has(v))
}

/** 人话周期。识别常见形状(每天/工作日/周末/每周X/每月N日),其余如实回落 cron 原文。 */
export function describeSchedule(schedule: AutomationSchedule): string {
  if (schedule.kind === "once") {
    const at = new Date(schedule.at)
    return Number.isNaN(at.getTime()) ? schedule.at : `一次性 · ${at.getMonth() + 1}/${at.getDate()} ${pad(at.getHours())}:${pad(at.getMinutes())}`
  }
  if (schedule.kind === "interval") {
    const m = schedule.everyMinutes
    if (m % 60 === 0) return `每 ${m / 60} 小时`
    return `每 ${m} 分钟`
  }
  try {
    const spec = parseCron(schedule.expr)
    if (spec.minute.size !== 1 || spec.hour.size !== 1 || spec.month.size !== 12) return `cron ${schedule.expr}`
    const time = `${pad([...spec.hour][0])}:${pad([...spec.minute][0])}`
    if (spec.dom === null && spec.dow === null) return `每天 ${time}`
    if (spec.dom === null && spec.dow) {
      if (sameSet(spec.dow, [1, 2, 3, 4, 5])) return `工作日 ${time}`
      if (sameSet(spec.dow, [0, 6])) return `周末 ${time}`
      if (spec.dow.size === 1) return `每周${DOW_ZH[[...spec.dow][0]]} ${time}`
      return `每周${[...spec.dow].sort().map((d) => DOW_ZH[d]).join("/")} ${time}`
    }
    if (spec.dow === null && spec.dom && spec.dom.size === 1) return `每月 ${[...spec.dom][0]} 日 ${time}`
    return `cron ${schedule.expr}`
  } catch {
    return `cron ${schedule.expr}`
  }
}

/** A2(REQ-024):连败熔断判定 —— 最近 N 次**真实尝试**(skip 类不算)全为 failed/timeout。 */
export function shouldTripBreaker(
  history: Array<{ status: string }> | undefined,
  threshold: number,
): boolean {
  const attempts = (history ?? []).filter((r) => r.status !== "skipped-overlap" && r.status !== "skipped-cap")
  const recent = attempts.slice(0, threshold)
  return recent.length >= threshold && recent.every((r) => r.status === "failed" || r.status === "timeout")
}

/** A3(REQ-025):本地 schedule → B 端 5 字段 cron;不可表达(once / 非整点超长间隔)→ null(诚实拒绝)。 */
export function scheduleToCron(schedule: import("./automation-types").AutomationSchedule): string | null {
  if (schedule.kind === "cron") return schedule.expr
  if (schedule.kind === "interval") {
    if (schedule.everyMinutes >= 5 && schedule.everyMinutes < 60) return `*/${schedule.everyMinutes} * * * *`
    if (schedule.everyMinutes % 60 === 0 && schedule.everyMinutes <= 24 * 60) return `0 */${schedule.everyMinutes / 60} * * *`
    return null
  }
  return null // once:云档不支持
}
