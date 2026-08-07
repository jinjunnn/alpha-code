import { describe, expect, test } from "bun:test"
import { initialLocationPrewarmRequest, prewarmInitialLocation } from "./sidecar-location-prewarm"

describe("sidecar initial location prewarm", () => {
  test("targets the real governed-provider V2 handler for the exact directory", () => {
    const request = initialLocationPrewarmRequest("/Users/example/Alpha")!
    const url = new URL(request.url)
    expect(request.method).toBe("GET")
    expect(url.pathname).toBe("/api/provider/alpha-internal-catalog-ready")
    expect(url.searchParams.get("location[directory]")).toBe("/Users/example/Alpha")
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
    )
    expect(result).toEqual({ outcome: "invalid-directory" })
    expect(calls).toBe(0)
  })

  test("starts the in-process request without waiting for socket listen", async () => {
    let resolve!: (response: Response) => void
    const pending = new Promise<Response>((done) => (resolve = done))
    let calls = 0
    const warming = prewarmInitialLocation(
      {
        request() {
          calls++
          return pending
        },
      },
      "/Users/example/Alpha",
    )
    expect(calls).toBe(1)
    resolve(new Response(null, { status: 200 }))
    expect(await warming).toEqual({ outcome: "ready", status: 200 })
  })

  test("reports a non-ready marker response without retrying or failing open", async () => {
    let calls = 0
    const result = await prewarmInitialLocation(
      {
        request() {
          calls++
          return new Response(null, { status: 404 })
        },
      },
      "/Users/example/Alpha",
    )
    expect(result).toEqual({ outcome: "unavailable", status: 404 })
    expect(calls).toBe(1)
  })

  test("contains request failure as a diagnostic result", async () => {
    const result = await prewarmInitialLocation(
      {
        request() {
          throw new Error("injected prewarm failure")
        },
      },
      "/Users/example/Alpha",
    )
    expect(result).toEqual({ outcome: "failed", error: "injected prewarm failure" })
  })
})
