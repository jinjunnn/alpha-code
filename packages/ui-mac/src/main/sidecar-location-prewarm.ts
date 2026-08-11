// #857 — start the real V2 location graph before the renderer's first model request.
//
// The embedded server exposes an in-process app. Alpha's generated-output patch
// pins the fixed Electron listener to that app's routes and memo map, so an
// authenticated marker request starts the exact production location layer, then an
// authenticated model request settles the renderer's exact first handler without
// opening a second server, inventing a catalog fast-path, or touching account state.
import path from "node:path"
import { ALPHA_V2_CATALOG_READY_PROVIDER_ID } from "../shared/alpha-config"

type ServerApp = {
  request(input: string | URL | Request, init?: RequestInit): Response | Promise<Response>
}

/**
 * #881:每个结局都带**实测耗时**,而 2s 硬顶到期从自由文本(`{outcome:"failed",
 * error:"…timed out"}`)升成自己的一格。
 *
 * 为什么这是 #881 的承重项:`sidecar.ts` 把 ready 上报压在本函数之后,而本函数**非 ready 也
 * 照发 ready**。于是 `phase=ready` 结构上不等于「目录已收敛」—— T7 样本 1 里 ready 在
 * 1912.9ms,同一个 marker 端点到 15699.7ms 仍不答。「ready 为什么早了十几秒」这个问题,
 * 在打包证据里此前没有**任何**字段可以回答:结局与耗时都只进了 console。
 */
export type LocationPrewarmResult = { durationMs: number } & (
  | { outcome: "ready"; status: number }
  | { outcome: "unavailable"; status: number }
  | { outcome: "invalid-directory" }
  | { outcome: "timed-out" }
  | { outcome: "failed"; error: string }
)

export const INITIAL_LOCATION_PREWARM_TIMEOUT_MS = 2_000

export function initialLocationPrewarmRequest(
  directory: string,
  password: string,
  signal?: AbortSignal,
): Request | undefined {
  if (!path.isAbsolute(directory)) return
  const url = new URL(
    `/api/provider/${encodeURIComponent(ALPHA_V2_CATALOG_READY_PROVIDER_ID)}`,
    "http://alpha-sidecar.invalid",
  )
  url.searchParams.set("location[directory]", directory)
  return new Request(url, {
    method: "GET",
    headers: { Authorization: `Basic ${Buffer.from(`opencode:${password}`).toString("base64")}` },
    signal,
  })
}

export function initialModelPrewarmRequest(
  directory: string,
  password: string,
  signal?: AbortSignal,
): Request | undefined {
  if (!path.isAbsolute(directory)) return
  const url = new URL("/api/model", "http://alpha-sidecar.invalid")
  url.searchParams.set("location[directory]", directory)
  return new Request(url, {
    method: "GET",
    headers: { Authorization: `Basic ${Buffer.from(`opencode:${password}`).toString("base64")}` },
    signal,
  })
}

export async function prewarmInitialLocation(
  app: ServerApp,
  directory: string,
  options: { password: string; timeoutMs?: number },
): Promise<LocationPrewarmResult> {
  const timeoutMs = options.timeoutMs ?? INITIAL_LOCATION_PREWARM_TIMEOUT_MS
  const startedAt = performance.now()
  const durationMs = () => performance.now() - startedAt
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(new Error("initial location prewarm timed out")), timeoutMs)
  timer.unref?.()
  try {
    const request = initialLocationPrewarmRequest(directory, options.password, controller.signal)
    if (!request) return { outcome: "invalid-directory", durationMs: durationMs() }
    const marker = await app.request(request)
    await marker.arrayBuffer()
    if (!marker.ok) return { outcome: "unavailable", status: marker.status, durationMs: durationMs() }
    const modelRequest = initialModelPrewarmRequest(directory, options.password, controller.signal)!
    const models = await app.request(modelRequest)
    if (!models.ok) return { outcome: "unavailable", status: models.status, durationMs: durationMs() }
    await models.arrayBuffer()
    return { outcome: "ready", status: models.status, durationMs: durationMs() }
  } catch (error) {
    // #881:是**我们自己的 2s 硬顶**把这次请求掐了,还是引擎/请求本身炸了?旧实现把两者折进
    // 同一个自由文本 `error`,于是「ready 是等满 2s 照发的」在打包证据里不可判 —— 而那正是
    // 归因要问的第一个问题。判据取自我们自己的取消,不靠错误文案。
    if (controller.signal.aborted) return { outcome: "timed-out", durationMs: durationMs() }
    return {
      outcome: "failed",
      error: error instanceof Error ? error.message : String(error),
      durationMs: durationMs(),
    }
  } finally {
    clearTimeout(timer)
  }
}
