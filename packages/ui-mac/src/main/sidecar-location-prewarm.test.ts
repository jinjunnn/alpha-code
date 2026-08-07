import { readFileSync } from "node:fs"
import { describe, expect, test } from "bun:test"
import {
  INITIAL_LOCATION_PREWARM_TIMEOUT_MS,
  initialLocationPrewarmRequest,
  initialModelPrewarmRequest,
  prewarmInitialLocation,
} from "./sidecar-location-prewarm"

describe("sidecar initial location prewarm", () => {
  test("bounds the ready gate by the #857 startup budget", () => {
    expect(INITIAL_LOCATION_PREWARM_TIMEOUT_MS).toBe(2_000)
  })

  test("targets the real governed-provider and model V2 handlers for the exact directory", () => {
    const requests = [
      initialLocationPrewarmRequest("/Users/example/Alpha", "synthetic-password")!,
      initialModelPrewarmRequest("/Users/example/Alpha", "synthetic-password")!,
    ]
    expect(requests.map((request) => new URL(request.url).pathname)).toEqual([
      "/api/provider/alpha-internal-catalog-ready",
      "/api/model",
    ])
    for (const request of requests) {
      expect(request.method).toBe("GET")
      expect(request.headers.get("authorization")).toBe(
        `Basic ${Buffer.from("opencode:synthetic-password").toString("base64")}`,
      )
      expect(new URL(request.url).searchParams.get("location[directory]")).toBe("/Users/example/Alpha")
    }
  })

  test("rejects a relative directory before the server app is called", async () => {
    let calls = 0
    const result = await prewarmInitialLocation(
      {
        request() {
          calls++
          return new Response(null, { status: 200 })
        },
      },
      "relative/Alpha",
      { password: "synthetic-password" },
    )
    expect(result).toEqual({ outcome: "invalid-directory" })
    expect(calls).toBe(0)
  })

  test("starts the in-process request without waiting for socket listen", async () => {
    let resolve!: (response: Response) => void
    const pending = new Promise<Response>((done) => (resolve = done))
    const paths: string[] = []
    const warming = prewarmInitialLocation(
      {
        request(input) {
          paths.push(new URL(input instanceof Request ? input.url : input).pathname)
          return paths.length === 1 ? pending : new Response("[]", { status: 200 })
        },
      },
      "/Users/example/Alpha",
      { password: "synthetic-password" },
    )
    expect(paths).toEqual(["/api/provider/alpha-internal-catalog-ready"])
    resolve(new Response(null, { status: 200 }))
    expect(await warming).toEqual({ outcome: "ready", status: 200 })
    expect(paths).toEqual(["/api/provider/alpha-internal-catalog-ready", "/api/model"])
  })

  test("production starts prewarm before listen and withholds ready until it settles", () => {
    const source = readFileSync(import.meta.dir + "/sidecar.ts", "utf8")
    const start = source.indexOf("const prewarm = prewarmInitialLocation(")
    const listen = source.indexOf("listener = await Server.listen(")
    const settled = source.indexOf("const prewarmResult = await prewarm")
    const ready = source.indexOf("parentPort.postMessage(buildReadyMessage(injection))")

    expect(start).toBeGreaterThanOrEqual(0)
    expect(listen).toBeGreaterThan(start)
    expect(settled).toBeGreaterThan(listen)
    expect(ready).toBeGreaterThan(settled)
  })

  test("reports a non-ready marker response without retrying or failing open", async () => {
    let calls = 0
    let consumed = false
    const result = await prewarmInitialLocation(
      {
        request() {
          calls++
          const response = new Response("marker-not-ready", { status: 404 })
          const read = response.arrayBuffer.bind(response)
          response.arrayBuffer = async () => {
            consumed = true
            return read()
          }
          return response
        },
      },
      "/Users/example/Alpha",
      { password: "synthetic-password" },
    )
    expect(result).toEqual({ outcome: "unavailable", status: 404 })
    expect(calls).toBe(1)
    expect(consumed).toBe(true)
  })

  test("reports a non-ready model response only after the governed marker succeeds", async () => {
    let calls = 0
    const result = await prewarmInitialLocation(
      {
        request() {
          calls++
          return new Response(null, { status: calls === 1 ? 200 : 503 })
        },
      },
      "/Users/example/Alpha",
      { password: "synthetic-password" },
    )
    expect(result).toEqual({ outcome: "unavailable", status: 503 })
    expect(calls).toBe(2)
  })

  test("contains request failure as a diagnostic result", async () => {
    const result = await prewarmInitialLocation(
      {
        request() {
          throw new Error("injected prewarm failure")
        },
      },
      "/Users/example/Alpha",
      { password: "synthetic-password" },
    )
    expect(result).toEqual({ outcome: "failed", error: "injected prewarm failure" })
  })
})
