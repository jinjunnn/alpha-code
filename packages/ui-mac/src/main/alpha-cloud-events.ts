// alpha cloud job progress (ADR-016 阶段二 SSE)—— MAIN-ONLY 流式消费者。
// main 进程 fetch-stream `GET {cloud}/v1/cloud/jobs/{id}/events`(SSE),解析事件帧 → 推给 renderer(IPC)。
// B 端 SSE 是**有界**的(~55s 关闭以避 Worker 时限);此处收到非终态关闭即带 Last-Event-ID **自动重连**续读,
// 直到终态事件(job.completed/failed/cancelled)或调用方取消。bearer 只在 main(不进 renderer)。
// ⚠️ 禁区:不碰 opencode 的 server-sdk.tsx —— 这是 alpha 自有的 sidecar-HTTP 进度通道。
import { resolveEndpoints } from "./alpha-endpoints"
import { getAccessToken } from "./alpha-auth"
import { getLogger } from "./logging"
import { ALPHA_PATHS } from "../shared/alpha-config"
import type { CloudJobEvent } from "../preload/types"

const TERMINAL = new Set(["job.completed", "job.failed", "job.cancelled"])
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

// 解析一个 SSE 帧(id:/event:/data: 行)→ CloudJobEvent。data 为空/无 → null。
function parseFrame(frame: string): { id?: string; event: string; data: unknown } | null {
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
  try { data = JSON.parse(dataLine) } catch { data = dataLine }
  return { id, event, data }
}

// 订阅一个 job 的进度事件。sink 收到每个事件;返回 unsubscribe。终态或取消后自动停。
export function subscribeCloudJobEvents(jobId: string, sink: (ev: CloudJobEvent) => void): () => void {
  let stopped = false
  let lastId = 0
  const base = resolveEndpoints().cloud

  async function loop() {
    while (!stopped) {
      const token = getAccessToken()
      if (!token || !base) { sink({ event: "error", data: { reason: "not-authenticated" } }); return }
      let reader: ReadableStreamDefaultReader<Uint8Array> | null = null
      try {
        const res = await fetch(`${base}${ALPHA_PATHS.cloudJobs}/${encodeURIComponent(jobId)}/events`, {
          headers: { authorization: `Bearer ${token}`, ...(lastId ? { "last-event-id": String(lastId) } : {}) },
        })
        if (res.status === 401 || res.status === 404) { sink({ event: "error", data: { status: res.status } }); return }
        if (!res.ok || !res.body) { await sleep(2000); continue }
        reader = res.body.getReader()
        const dec = new TextDecoder()
        let buf = ""
        let terminal = false
        for (;;) {
          const { done, value } = await reader.read()
          if (done) break
          buf += dec.decode(value, { stream: true })
          let idx: number
          while ((idx = buf.indexOf("\n\n")) >= 0) {
            const frame = buf.slice(0, idx)
            buf = buf.slice(idx + 2)
            const ev = parseFrame(frame)
            if (!ev) continue
            if (ev.id) lastId = Number(ev.id) || lastId
            sink({ event: ev.event, data: ev.data, id: ev.id })
            if (TERMINAL.has(ev.event)) terminal = true
          }
          if (stopped) break
        }
        if (terminal || stopped) return
        // 有界关闭且未终态 → 带 Last-Event-ID 重连续读。
      } catch (error) {
        if (stopped) return
        getLogger().warn("alpha-cloud-events: stream error, reconnecting", error)
        await sleep(2000)
      } finally {
        try { await reader?.cancel() } catch { /* ignore */ }
      }
    }
  }
  void loop()
  return () => { stopped = true }
}
