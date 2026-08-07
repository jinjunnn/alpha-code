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

export type LocationPrewarmResult =
  | { outcome: "ready"; status: number }
  | { outcome: "unavailable"; status: number }
  | { outcome: "invalid-directory" }
  | { outcome: "failed"; error: string }

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
  const timeoutMs = options.timeoutMs ?? 10_000
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(new Error("initial location prewarm timed out")), timeoutMs)
  timer.unref?.()
  try {
    const request = initialLocationPrewarmRequest(directory, options.password, controller.signal)
    if (!request) return { outcome: "invalid-directory" }
    const marker = await app.request(request)
    if (!marker.ok) return { outcome: "unavailable", status: marker.status }
    const modelRequest = initialModelPrewarmRequest(directory, options.password, controller.signal)!
    const models = await app.request(modelRequest)
    if (!models.ok) return { outcome: "unavailable", status: models.status }
    await models.arrayBuffer()
    return { outcome: "ready", status: models.status }
  } catch (error) {
    return { outcome: "failed", error: error instanceof Error ? error.message : String(error) }
  } finally {
    clearTimeout(timer)
  }
}
