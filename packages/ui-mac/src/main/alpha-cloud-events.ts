// alpha cloud job progress (ADR-016 阶段二 SSE)—— MAIN-ONLY 流式消费者。
// main 进程 fetch-stream `GET {cloud}/v1/cloud/jobs/{id}/events`(SSE),解析事件帧 → 推给 renderer(IPC)。
// B 端 SSE 是**有界**的(~55s 关闭以避 Worker 时限);收到非终态关闭即带 Last-Event-ID 自动重连续读,
// 直到终态事件(job.completed/failed/cancelled)或调用方取消。bearer 只在 main(不进 renderer)。
// ⚠️ 禁区:不碰 opencode 的 server-sdk.tsx —— 这是 alpha 自有的 sidecar-HTTP 进度通道。
//
// REQ-003(收编 C23)加固:
//   - 重连退避:指数 + 抖动(backoffMs),**只对失败/空转关闭退避**——收到过事件的正常有界关闭立即
//     重连(B 的 55s 分页语义);修 C23「空转 200 关闭 → 无退避紧凑重连风暴」;
//   - Last-Event-ID:原样字符串透传(修 C23「非数字 id 被 Number() 丢失」);
//   - 终态判定:event: 名缺失时从 data.type 兜底(terminalEventName,修 C23「终态帧漏判」);
//   - 悬挂检测:90s 无字节 → abort 重连(B 有界 55s,90s 静默 = 连接僵死;验收④);
//   - subs 泄漏:cloud-ipc 经 isTerminalCloudEvent 在终态时清账(修 NEW-2/3)。

import { resolveEndpoints } from "./alpha-endpoints"
import { getAccessToken } from "./alpha-auth"
import { getLogger } from "./logging"
import { ALPHA_PATHS } from "../shared/alpha-config"
import type { CloudJobEvent } from "../preload/types"

export { backoffMs, isTerminalCloudEvent, parseFrame, terminalEventName } from "./alpha-cloud-events-core"
import { backoffMs, parseFrame, terminalEventName } from "./alpha-cloud-events-core"

const IDLE_TIMEOUT_MS = 90_000
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

// 订阅一个 job 的进度事件。sink 收到每个事件;返回 unsubscribe。终态或取消后自动停。
export function subscribeCloudJobEvents(jobId: string, sink: (ev: CloudJobEvent) => void): () => void {
  let stopped = false
  let lastId: string | null = null // C23 修:原样字符串(Number() 会丢非数字 id)
  let failures = 0 // 连续「失败或空转关闭」计数;收到任何事件即清零
  const base = resolveEndpoints().cloud

  async function loop() {
    while (!stopped) {
      let token: string | undefined
      try {
        token = getAccessToken("cloud.read")
      } catch {
        sink({ event: "error", data: { reason: "contract-incompatible" } })
        return
      }
      if (!token || !base) {
        sink({ event: "error", data: { reason: "not-authenticated" } })
        return
      }
      let reader: ReadableStreamDefaultReader<Uint8Array> | null = null
      const ctrl = new AbortController()
      let idleTimer: NodeJS.Timeout | undefined
      const bumpIdle = () => {
        clearTimeout(idleTimer)
        idleTimer = setTimeout(() => ctrl.abort(), IDLE_TIMEOUT_MS)
      }
      let gotEvent = false
      try {
        bumpIdle()
        const res = await fetch(`${base}${ALPHA_PATHS.cloudJobs}/${encodeURIComponent(jobId)}/events`, {
          headers: { authorization: `Bearer ${token}`, ...(lastId ? { "last-event-id": lastId } : {}) },
          signal: ctrl.signal,
        })
        if (res.status === 401 || res.status === 404) {
          sink({ event: "error", data: { status: res.status } })
          return
        }
        if (!res.ok || !res.body) {
          failures++
          await sleep(backoffMs(failures))
          continue
        }
        reader = res.body.getReader()
        const dec = new TextDecoder()
        let buf = ""
        let terminal = false
        for (;;) {
          const { done, value } = await reader.read()
          if (done) break
          bumpIdle()
          buf += dec.decode(value, { stream: true })
          let idx: number
          while ((idx = buf.indexOf("\n\n")) >= 0) {
            const frame = buf.slice(0, idx)
            buf = buf.slice(idx + 2)
            const ev = parseFrame(frame)
            if (!ev) continue
            gotEvent = true
            failures = 0
            if (ev.id) lastId = ev.id
            sink({ event: ev.event, data: ev.data, id: ev.id })
            if (terminalEventName(ev)) terminal = true
          }
          if (stopped) break
        }
        if (terminal || stopped) return
        // 有界关闭且未终态:收到过事件 = B 的 55s 分页,立即续读;空转关闭 = 异常,退避防风暴(C23)。
        if (!gotEvent) {
          failures++
          await sleep(backoffMs(failures))
        }
      } catch (error) {
        if (stopped) return
        failures++
        getLogger().warn(
          `alpha-cloud-events: stream ${ctrl.signal.aborted ? "idle-timeout(90s no bytes)" : "error"}, reconnect in backoff (attempt ${failures})`,
          error,
        )
        await sleep(backoffMs(failures))
      } finally {
        clearTimeout(idleTimer)
        try {
          await reader?.cancel()
        } catch {
          /* ignore */
        }
      }
    }
  }
  void loop()
  return () => {
    stopped = true
  }
}
