// REQ-003(C23):cloud SSE 消费端的纯逻辑核心(electron-free,单测覆盖)。
// 流级消费者在 alpha-cloud-events.ts(main-only,依赖 logging/auth/endpoints)。

const TERMINAL = new Set(["job.completed", "job.failed", "job.cancelled"])

/** 终态名;非终态 → null。event: 字段缺失(默认 "message")时从 data.type 兜底判定(C23 漏判修)。 */
export function terminalEventName(ev: { event: string; data: unknown }): string | null {
  if (TERMINAL.has(ev.event)) return ev.event
  if (ev.event === "message" && ev.data && typeof ev.data === "object") {
    const t = (ev.data as { type?: unknown }).type
    if (typeof t === "string" && TERMINAL.has(t)) return t
  }
  return null
}

export const isTerminalCloudEvent = (ev: { event: string; data: unknown }): boolean => terminalEventName(ev) !== null

/** 指数退避 + ±50% 抖动;1s 起步,30s 封顶。attempt 从 1 计。(C23:空转关闭不再零间隔风暴。) */
export function backoffMs(attempt: number, rand: number = Math.random()): number {
  const base = Math.min(30_000, 1000 * 2 ** Math.min(Math.max(attempt, 1) - 1, 5))
  return Math.round(base / 2 + (rand * base) / 2)
}

// 解析一个 SSE 帧(id:/event:/data: 行)→ 事件。data 为空/无 → null。(B 侧 data 为单行 JSON;
// 多行 data 拼接按 SSE 规范未做——B 不产此形态,见 REQ-003 审计。)
export function parseFrame(frame: string): { id?: string; event: string; data: unknown } | null {
  let id: string | undefined
  let event = "message"
  let dataLine: string | undefined
  for (const line of frame.split("\n")) {
    if (line.startsWith("id:")) id = line.slice(3).trim()
    else if (line.startsWith("event:")) event = line.slice(6).trim()
    else if (line.startsWith("data:")) dataLine = line.slice(5).trim()
  }
  if (dataLine === undefined) return null
  let data: unknown
  try {
    data = JSON.parse(dataLine)
  } catch {
    data = dataLine
  }
  return { id, event, data }
}
