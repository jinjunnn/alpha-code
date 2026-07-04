// 一句话 → 调度的确定性规则解析(REQ-021 A1.2)。刻意不用 LLM(那是 A2):中英固定句式,
// 解析不出周期就返回 schedule:null,UI 降级为手动选周期、原文整句作任务指令。
// 纯函数零依赖;单测在 automation-nl.test.ts。
//
// 支持:每天/每日 · 工作日 · 周末 · 每周X/星期X · 每月N日/号 · 每N分钟/每N小时/每半小时 ·
//       HH:mm / H点(半) / 上午·下午·晚上 H 点 / at H(:mm) am|pm;
//       every day/daily · weekdays/weekends · every monday… · monthly on the Nth ·
//       every N minutes/hours · hourly。

import type { AutomationSchedule } from "./automation-types"

export interface NlParseResult {
  schedule: AutomationSchedule | null
  /** 去掉时间短语后的剩余文本(任务指令);全句都是时间短语时回落原文。 */
  prompt: string
  /** 命中的时间短语(预览卡回显)。 */
  matched?: string
}

const ZH_DOW: Record<string, number> = { 日: 0, 天: 0, 一: 1, 二: 2, 三: 3, 四: 4, 五: 5, 六: 6 }
const EN_DOW: Record<string, number> = { sun: 0, mon: 1, tue: 2, wed: 3, thu: 4, fri: 5, sat: 6 }

type TimeHit = { hour: number; minute: number; text: string }

// 中文时刻:上午/下午等前缀 + H 点/时/: + 分(半)。晚上 7 点 → 19:00;中午 12 → 12:00。
const ZH_TIME_RE = /(上午|早上|早晨|清晨|中午|下午|傍晚|晚上|夜里|凌晨)?\s*(\d{1,2})\s*(?:[点时]\s*(半|\d{1,2})?\s*分?|[::](\d{2}))/
// 英文时刻:at 8 / at 8:30 / at 8pm / 8:30 am
const EN_TIME_RE = /\bat\s+(\d{1,2})(?::(\d{2}))?\s*(am|pm)?\b|\b(\d{1,2}):(\d{2})\s*(am|pm)?\b/i

function zhTime(text: string): TimeHit | null {
  const m = ZH_TIME_RE.exec(text)
  if (!m) return null
  let hour = parseInt(m[2], 10)
  const prefix = m[1] ?? ""
  let minute = 0
  if (m[3] === "半") minute = 30
  else if (m[3]) minute = parseInt(m[3], 10)
  else if (m[4]) minute = parseInt(m[4], 10)
  if (/下午|傍晚|晚上|夜里/.test(prefix) && hour < 12) hour += 12
  if (prefix === "中午" && hour !== 12) hour = hour < 6 ? hour + 12 : hour // 中午 1 点 = 13
  if (prefix === "凌晨" && hour === 12) hour = 0
  if (hour > 23 || minute > 59) return null
  return { hour, minute, text: m[0] }
}

function enTime(text: string): TimeHit | null {
  const m = EN_TIME_RE.exec(text)
  if (!m) return null
  let hour = parseInt(m[1] ?? m[4], 10)
  const minute = parseInt(m[2] ?? m[5] ?? "0", 10)
  const ampm = (m[3] ?? m[6] ?? "").toLowerCase()
  if (ampm === "pm" && hour < 12) hour += 12
  if (ampm === "am" && hour === 12) hour = 0
  if (hour > 23 || minute > 59) return null
  return { hour, minute, text: m[0] }
}

/** 找到时刻;没写时刻的天级任务默认 09:00(预览卡可改)。 */
const DEFAULT_TIME: TimeHit = { hour: 9, minute: 0, text: "" }

function stripPrompt(input: string, ...phrases: (string | undefined)[]): string {
  let out = input
  for (const p of phrases) {
    if (p) out = out.replace(p, " ")
  }
  out = out.replace(/^[\s,,。.;;、::\-—]+|[\s,,。.;;、::\-—]+$/g, "").trim()
  return out.length > 0 ? out : input.trim()
}

export function parseAutomationText(input: string): NlParseResult {
  const text = input.trim()
  if (!text) return { schedule: null, prompt: "" }

  // ── interval(先于天级:「每30分钟」不含时刻)──
  let m = /每\s*(\d+)\s*分钟/.exec(text)
  if (m) return intervalResult(text, parseInt(m[1], 10), m[0])
  if (/每半小时/.test(text)) return intervalResult(text, 30, "每半小时")
  m = /每\s*(\d+)\s*(?:个)?\s*小时/.exec(text)
  if (m) return intervalResult(text, parseInt(m[1], 10) * 60, m[0])
  if (/每小时/.test(text)) return intervalResult(text, 60, "每小时")
  m = /\bevery\s+(\d+)\s*min(?:ute)?s?\b/i.exec(text)
  if (m) return intervalResult(text, parseInt(m[1], 10), m[0])
  m = /\bevery\s+(\d+)\s*hours?\b/i.exec(text)
  if (m) return intervalResult(text, parseInt(m[1], 10) * 60, m[0])
  if (/\bhourly\b/i.test(text)) return intervalResult(text, 60, "hourly")

  // ── 天级(dayspec + 可选时刻)──
  const time = zhTime(text) ?? enTime(text)

  // 每月 N 日/号 · monthly on the Nth
  m = /每月\s*(\d{1,2})\s*[日号]/.exec(text)
  if (!m) m = /\bmonthly\s+on\s+(?:the\s+)?(\d{1,2})(?:st|nd|rd|th)?\b/i.exec(text)
  if (m) {
    const dom = parseInt(m[1], 10)
    if (dom >= 1 && dom <= 31) return cronResult(text, `${(time ?? DEFAULT_TIME).minute} ${(time ?? DEFAULT_TIME).hour} ${dom} * *`, m[0], time)
  }

  // 每周X / 星期X / every monday…(支持「每周一和周四」的多日列举)
  const zhDows = new Set<number>()
  for (const dm of text.matchAll(/(?:每周|每星期|周|星期|礼拜)([一二三四五六日天])/g)) zhDows.add(ZH_DOW[dm[1]])
  const enDows = new Set<number>()
  for (const dm of text.matchAll(/\b(?:every\s+)?(sun|mon|tue|wed|thu|fri|sat)(?:urday|nesday|rsday|day|sday)?s?\b/gi)) {
    enDows.add(EN_DOW[dm[1].toLowerCase()])
  }
  const hasZhWeekly = /每周[一二三四五六日天]|每星期[一二三四五六日天]|(?:^|[^每])(?:周|星期|礼拜)[一二三四五六日天]/.test(text)
  const hasEnWeekly = /\bevery\s+(sun|mon|tue|wed|thu|fri|sat)/i.test(text)
  const dows = hasZhWeekly ? zhDows : hasEnWeekly ? enDows : new Set<number>()

  // 工作日 / 周末 / weekdays / weekends
  if (/工作日|每个工作日|\bweekdays?\b/i.test(text) && dows.size === 0) {
    const hit = /工作日|weekdays?/i.exec(text)!
    return cronResult(text, `${(time ?? DEFAULT_TIME).minute} ${(time ?? DEFAULT_TIME).hour} * * 1-5`, hit[0], time)
  }
  if (/周末|\bweekends?\b/i.test(text) && dows.size === 0) {
    const hit = /周末|weekends?/i.exec(text)!
    return cronResult(text, `${(time ?? DEFAULT_TIME).minute} ${(time ?? DEFAULT_TIME).hour} * * 0,6`, hit[0], time)
  }

  if (dows.size > 0) {
    const list = [...dows].sort().join(",")
    const phrase = hasZhWeekly
      ? [...text.matchAll(/(?:每周|每星期|周|星期|礼拜)[一二三四五六日天]/g)].map((x) => x[0])
      : [...text.matchAll(/\b(?:every\s+)?(sun|mon|tue|wed|thu|fri|sat)(?:urday|nesday|rsday|day|sday)?s?\b/gi)].map((x) => x[0])
    const t = time ?? DEFAULT_TIME
    const sched: AutomationSchedule = { kind: "cron", expr: `${t.minute} ${t.hour} * * ${list}` }
    return {
      schedule: sched,
      prompt: stripPrompt(text, ...phrase, time?.text),
      matched: [...phrase, time?.text].filter(Boolean).join(" "),
    }
  }

  // 每天 / 每日 / 每早 / 每晚 / every day / daily
  m = /每天|每日|每早|每晚|\bevery\s?day\b|\bdaily\b/i.exec(text)
  if (m) {
    let t = time ?? DEFAULT_TIME
    // 「每晚」自带晚间语义:无显式前缀时把 <12 的钟点挪到晚上
    if (m[0] === "每晚" && time && time.hour < 12 && !/下午|傍晚|晚上|夜里/.test(text)) t = { ...time, hour: time.hour + 12 }
    return cronResult(text, `${t.minute} ${t.hour} * * *`, m[0], time)
  }

  // 只有孤立时刻(「9 点跑 X」)不猜周期 —— 诚实降级,让用户手动选。
  return { schedule: null, prompt: text }
}

function intervalResult(text: string, everyMinutes: number, phrase: string): NlParseResult {
  if (everyMinutes < 1 || everyMinutes > 7 * 24 * 60) return { schedule: null, prompt: text }
  return {
    schedule: { kind: "interval", everyMinutes },
    prompt: stripPrompt(text, phrase),
    matched: phrase,
  }
}

function cronResult(text: string, expr: string, dayPhrase: string, time: TimeHit | null): NlParseResult {
  return {
    schedule: { kind: "cron", expr },
    prompt: stripPrompt(text, dayPhrase, time?.text),
    matched: [dayPhrase, time?.text].filter(Boolean).join(" "),
  }
}
