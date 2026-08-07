// #857 — start the real V2 location graph before the renderer's first model request.
//
// The embedded server exposes an in-process app backed by the same global
// LocationServiceMap as the socket listener. Hitting the governed catalog marker
// through that app starts the exact production location layer without opening a
// second server, inventing a catalog fast-path, or touching account/network state.
import path from "node:path"
import { ALPHA_V2_CATALOG_READY_PROVIDER_ID } from "../shared/alpha-config"

type ServerApp = {
  request(input: string | URL | Request, init?: RequestInit): Response | Promise<Response>
}

export type LocationPrewarmResult =
  | { outcome: "ready"; status: number }
  | { outcome: "unavailable"; status: number }
  | { outcome: "invalid-directory" }
  | { outcome: "failed"; error: string }

export function initialLocationPrewarmRequest(directory: string, signal?: AbortSignal): Request | undefined {
  if (!path.isAbsolute(directory)) return
  const url = new URL(
    `/api/provider/${encodeURIComponent(ALPHA_V2_CATALOG_READY_PROVIDER_ID)}`,
    "http://alpha-sidecar.invalid",
  )
  url.searchParams.set("location[directory]", directory)
  return new Request(url, { method: "GET", signal })
}

export async function prewarmInitialLocation(
  app: ServerApp,
  directory: string,
  options: { timeoutMs?: number } = {},
): Promise<LocationPrewarmResult> {
  const timeoutMs = options.timeoutMs ?? 10_000
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(new Error("initial location prewarm timed out")), timeoutMs)
  timer.unref?.()
  try {
    const request = initialLocationPrewarmRequest(directory, controller.signal)
    if (!request) return { outcome: "invalid-directory" }
    const response = await app.request(request)
    return response.ok
      ? { outcome: "ready", status: response.status }
      : { outcome: "unavailable", status: response.status }
  } catch (error) {
    return { outcome: "failed", error: error instanceof Error ? error.message : String(error) }
  } finally {
    clearTimeout(timer)
  }
}
